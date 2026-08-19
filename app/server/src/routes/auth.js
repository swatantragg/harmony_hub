import crypto from 'node:crypto';
import express from 'express';
import { db, persist, flushNow } from '../db.js';
import { signJwt, token, verifyPassword, hashPassword } from '../util/crypto.js';
import {
  ACCESS_TTL_SEC, APP_ORIGIN, GOOGLE_SIGNIN, GOOGLE_SIGNIN_CONFIGURED,
  LOGIN_LOCKOUT_SEC, LOGIN_MAX_FAILURES, MIN_PASSWORD_LENGTH,
  NODE_ENV, ORIGIN, PASSWORD_BREACH_CHECK, REFRESH_TTL_SEC, isWeakPassword,
} from '../config.js';
import { PERMISSIONS, normaliseRole } from '../catalogue.js';
import { authenticate, authenticatePending, mintStepUpTicket, problem } from '../middleware/auth.js';
import { record, notify } from '../services/audit.js';
import * as sessions from '../services/sessions.js';
import {
  clearRefreshCookie, clearSignInStateCookie, readRefreshCookie,
  readSignInStateCookie, setRefreshCookie, setSignInStateCookie,
} from '../util/cookies.js';
import * as google from '../services/google-signin.js';

export const authRouter = express.Router();

// A valid-looking bcrypt digest of a value nobody holds, used to equalise the cost of a
// failed sign-in against an unknown email.
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO3Zm/9dOtaGZkVpq7Zt.Fx9pHkoJn0Mm';

// Secure cookies cannot be set over plaintext, and local development has no TLS. Anything
// that is not a loopback origin gets the flag.
const SECURE_COOKIES = NODE_ENV === 'production' || !/^http:\/\/(localhost|127\.0\.0\.1)/.test(ORIGIN);

const publicUser = (u) => ({
  _id: u._id, name: u.name, email: u.email, role: normaliseRole(u.role),
  status: u.status, lastLoginAt: u.lastLoginAt,
  // The client routes to the set-a-password screen on this flag alone, and every other
  // route stays closed until it clears.
  mustChangePassword: Boolean(u.mustChangePassword),
  permissions: PERMISSIONS[normaliseRole(u.role)],
  // For the profile screen. `createdBy` is absent on the founding administrator and on
  // every account seeded before it was recorded, so the name resolves to null rather than
  // to a guess — "who let this person in" is exactly the question not to answer wrongly.
  createdAt: u.createdAt ?? null,
  passwordChangedAt: u.passwordChangedAt ?? null,
  createdBy: u.createdBy ?? null,
  createdByName: u.createdBy ? db.users.find((x) => x._id === u.createdBy)?.name ?? null : null,
  // The policy the server will actually enforce, sent so the password screens can state it
  // rather than repeat it. Three copies of this number had already drifted apart once —
  // the server said 12 while one screen said 12 and another said 8 — and a form that
  // accepts what the API then refuses is worse than no hint at all.
  minPasswordLength: MIN_PASSWORD_LENGTH,
  // How this account can get in. Both ways are always open — a password is never
  // withdrawn because somebody used Google, and Google never has to be set up before a
  // password works — so this describes what has happened, not what is permitted.
  google: u.google
    ? { linkedAt: u.google.linkedAt, email: u.google.email, lastSignInAt: u.google.lastSignInAt ?? null }
    : null,
  googleSignInAvailable: GOOGLE_SIGNIN_CONFIGURED,
  // Set only in the few minutes after a Google sign-in, and only while the handover
  // password is still in place. The set-a-password screen reads it to decide whether to
  // ask for a password the person may never have been sent — the server makes the same
  // decision again on the write, which is the one that counts.
  canSetPasswordWithoutCurrent: googleVerifiedRecently(u),
});

const signAccess = (user) => signJwt({
  sub: user._id,
  role: normaliseRole(user.role),
  name: user.name,
  // Session generation — see resolve() in middleware/auth.js. Without this claim a token
  // outlives the password change that was supposed to end it.
  tv: Number(user.tokenVersion ?? 0),
}, ACCESS_TTL_SEC);

// Ends every session the account has, everywhere, and makes every access token already in
// circulation stop verifying. Called on a password change, a suspension and a role change.
export async function invalidateSessions(user, reason) {
  user.tokenVersion = Number(user.tokenVersion ?? 0) + 1;
  persist();
  await sessions.revokeAllForUser(user._id, reason).catch(() => null);
}

// ── Password policy ─────────────────────────────────────────────────────────
//
// Length first, because it is the only rule that reliably buys entropy and every
// character-class matrix pushes people towards Password1!. What is added on top of length
// is only ever a check for passwords that are known to be worthless: the shared handover
// values, the account's own email, and — when it is switched on — the public breach
// corpus, checked by k-anonymity so the password itself never leaves this process.

async function breached(password) {
  if (!PASSWORD_BREACH_CHECK) return false;
  const digest = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`, {
      headers: { 'add-padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => line.split(':')[0]?.trim() === digest.slice(5));
  } catch {
    // A breach service that is down must not stop somebody setting a password.
    return false;
  }
}

export async function passwordProblem(value, { email = '', name = '' } = {}) {
  const password = String(value ?? '');
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'That password is too long.';
  if (isWeakPassword(password)) return 'That password is one of the shared starting values. Choose something else.';
  const lower = password.toLowerCase();
  if (email && lower.includes(String(email).split('@')[0].toLowerCase())) {
    return 'A password cannot contain the account name.';
  }
  if (name && name.trim().length > 3 && lower.includes(name.trim().toLowerCase())) {
    return 'A password cannot contain the account holder’s name.';
  }
  if (await breached(password)) {
    return 'That password appears in a public breach corpus. Choose one that does not.';
  }
  return null;
}

// ── Lockout ─────────────────────────────────────────────────────────────────
// Counted per account rather than per address, because the account is what is being
// attacked and an address is trivially rotated. The rate limiter in index.js covers the
// other axis.

const lockedUntil = (user) => (user?.lockedUntil ? Date.parse(user.lockedUntil) : 0);

function registerFailure(user, req) {
  if (!user) return;
  user.failedLogins = Number(user.failedLogins ?? 0) + 1;
  if (user.failedLogins >= LOGIN_MAX_FAILURES) {
    user.lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_SEC * 1000).toISOString();
    user.failedLogins = 0;
    notify({
      level: 'warn',
      title: `${user.name}'s account was locked`,
      body: `${LOGIN_MAX_FAILURES} failed sign-in attempts in a row. It unlocks itself in ${Math.round(LOGIN_LOCKOUT_SEC / 60)} minutes.`,
      link: '/admin/people',
    });
    record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
      action: 'AUTH_LOCKOUT', entity: 'user', entityId: user._id,
      label: `${user.name}'s account locked after repeated failures`,
      after: { until: user.lockedUntil },
    });
  }
  persist();
}

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const address = String(email || '').trim().toLowerCase();
  const user = db.users.find((u) => u.email.toLowerCase() === address);

  // A locked account is refused before the hash comparison, so a lockout also stops the
  // CPU cost of the attempt.
  if (user && lockedUntil(user) > Date.now()) {
    record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
      action: 'AUTH_LOGIN_BLOCKED', entity: 'user', entityId: user._id,
      label: `Sign-in refused — ${user.name}'s account is locked`,
    });
    return problem(
      res, 429, 'Too Many Requests',
      'This account is temporarily locked after repeated failed sign-ins. Try again shortly.',
      { retryAfterSec: Math.ceil((lockedUntil(user) - Date.now()) / 1000) },
    );
  }

  // The bcrypt comparison runs even when no such account exists, so a wrong email and a
  // wrong password take the same time to be refused.
  const ok = await verifyPassword(String(password || ''), user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    registerFailure(user, req);
    // Recorded whether or not the account exists — a burst of these against unknown
    // addresses is exactly what credential stuffing looks like from the inside.
    record({ ...req, user: { sub: user?._id ?? null, name: address || 'unknown', role: 'anonymous' } }, {
      action: 'AUTH_LOGIN_FAILED', entity: 'user', entityId: user?._id ?? 'unknown',
      label: `Failed sign-in for ${address || '(no address given)'}`,
      after: { accountExists: Boolean(user), failures: user?.failedLogins ?? null },
    });
    return problem(res, 401, 'Unauthorized', 'That email and password combination is not recognised.');
  }
  if (user.status !== 'active') return problem(res, 403, 'Forbidden', 'This account has been suspended.');

  user.failedLogins = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date().toISOString();
  persist();

  const { refreshToken } = await sessions.open(user, req);
  setRefreshCookie(res, refreshToken, { maxAgeSec: REFRESH_TTL_SEC, secure: SECURE_COOKIES });

  record({ ...req, user: { sub: user._id, name: user.name, role: normaliseRole(user.role) } }, {
    action: 'AUTH_LOGIN', entity: 'user', entityId: user._id, label: `${user.name} signed in`,
  });
  res.json({ accessToken: signAccess(user), expiresIn: ACCESS_TTL_SEC, user: publicUser(user) });
});

// ── Sign in with Google (§12.1) ─────────────────────────────────────────────
//
// A second way through the same door, not a second door. Everything past this point is
// identical to a password sign-in: the same session, the same refresh cookie, the same
// token generation, the same audit row. What differs is only how the account was proved.
//
// Three rules, and they are what make this safe to switch on for a library whose accounts
// are created by an administrator:
//
//   1. It never creates an account. Google says "this is really user01@gmail.com"; the
//      account for user01@gmail.com has to already exist here. An address Google
//      verifies but nobody has been given access to is refused, and told so plainly.
//   2. It never withdraws the password. Once an account exists, both routes work — the
//      person picks whichever is in front of them, and the same account answers.
//   3. It is matched on the verified email address and nothing else, because that is the
//      identifier an administrator typed when they created the account. The Google
//      subject id is recorded the first time as a second, stronger key: an address can
//      in principle be reassigned, and if the id ever stops matching, something has
//      changed underneath the account and the sign-in stops rather than guessing.

// Where the browser is sent when the flow finishes, either way. The client reads the
// query it lands with, exchanges the refresh cookie for an access token, and carries on —
// or shows the reason it could not.
const signInLanding = (params) => `${APP_ORIGIN}/#/login?${new URLSearchParams(params)}`;

authRouter.get('/providers', (_req, res) => {
  res.json({
    password: true,
    google: {
      enabled: GOOGLE_SIGNIN_CONFIGURED,
      // Shown under the button when a deployment restricts sign-in to one Workspace.
      hostedDomain: GOOGLE_SIGNIN.hostedDomain,
    },
  });
});

// Step one. Nothing is decided here — the browser is handed to Google with a state value
// this server signed and a nonce it also set as a cookie.
authRouter.get('/google', (req, res) => {
  if (!GOOGLE_SIGNIN_CONFIGURED) return res.redirect(302, signInLanding({ google: 'error', reason: 'disabled' }));

  const nonce = token(18);
  const state = google.mintState({ nonce, returnTo: String(req.query.returnTo || '/') });
  setSignInStateCookie(res, nonce, { maxAgeSec: google.STATE_TTL_SEC, secure: SECURE_COOKIES });
  res.redirect(302, google.authorizeUrl({
    state,
    // Prefills the chooser when somebody typed their address before giving up on the
    // password. Only a hint — Google still decides, and the callback still checks.
    loginHint: String(req.query.email || '').trim().toLowerCase() || null,
  }));
});

// Step two. Everything is decided here.
authRouter.get('/google/callback', async (req, res) => {
  const fail = (reason, detail) => {
    clearSignInStateCookie(res, { secure: SECURE_COOKIES });
    return res.redirect(302, signInLanding({ google: 'error', reason, ...(detail ? { detail } : {}) }));
  };

  if (!GOOGLE_SIGNIN_CONFIGURED) return fail('disabled');
  // The visitor pressed "cancel" on Google's own screen, or Google refused before it ever
  // reached us. Not an error worth a red banner.
  if (req.query.error) return fail(req.query.error === 'access_denied' ? 'cancelled' : 'refused');

  // The state has to be one this server signed *and* have come back in the browser it was
  // issued to. Either half missing is a sign-in somebody else started.
  const state = google.readState(req.query.state);
  const nonce = readSignInStateCookie(req);
  if (!state || !nonce || state.nonce !== nonce) return fail('state');
  clearSignInStateCookie(res, { secure: SECURE_COOKIES });

  let identity;
  try {
    identity = await google.identityFromCode(String(req.query.code || ''));
  } catch (err) {
    record({ ...req, user: { sub: null, name: 'unknown', role: 'anonymous' } }, {
      action: 'AUTH_GOOGLE_FAILED', entity: 'user', entityId: 'unknown',
      label: `Google sign-in failed (${err.reason ?? 'error'})`,
      after: { reason: err.reason ?? null },
    });
    return fail(err.reason ?? 'refused', err.message);
  }

  const user = db.users.find((u) => u.email.toLowerCase() === identity.email);

  // No account. Recorded like any other failed sign-in — a run of these against addresses
  // nobody has been given is the same signal a run of failed passwords is.
  if (!user) {
    record({ ...req, user: { sub: null, name: identity.email, role: 'anonymous' } }, {
      action: 'AUTH_GOOGLE_NO_ACCOUNT', entity: 'user', entityId: 'unknown',
      label: `Google sign-in for ${identity.email} — no account in this library`,
    });
    return fail('no-account');
  }
  if (user.status !== 'active') {
    record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
      action: 'AUTH_GOOGLE_BLOCKED', entity: 'user', entityId: user._id,
      label: `Google sign-in refused — ${user.name}'s account is suspended`,
    });
    return fail('suspended');
  }
  // A locked account is locked whichever door is tried. Otherwise the lockout is a
  // speed bump that Google walks straight past.
  if (lockedUntil(user) > Date.now()) {
    record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
      action: 'AUTH_GOOGLE_BLOCKED', entity: 'user', entityId: user._id,
      label: `Google sign-in refused — ${user.name}'s account is locked`,
    });
    return fail('locked');
  }
  // The address matches but the Google account behind it does not. Either the address was
  // reassigned or somebody is standing in front of an account that is not theirs; neither
  // is a thing to resolve by guessing.
  if (user.google?.sub && user.google.sub !== identity.sub) {
    record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
      action: 'AUTH_GOOGLE_MISMATCH', entity: 'user', entityId: user._id,
      label: `Google sign-in refused — ${user.email} is linked to a different Google account`,
    });
    return fail('mismatch');
  }

  const at = new Date().toISOString();
  const firstLink = !user.google;
  user.google = {
    sub: identity.sub,
    email: identity.email,
    name: identity.name,
    picture: identity.picture,
    linkedAt: user.google?.linkedAt ?? at,
    lastSignInAt: at,
  };
  user.failedLogins = 0;
  user.lockedUntil = null;
  user.lastLoginAt = at;
  // Proof of identity, good for a few minutes and for exactly one thing: replacing a
  // handover password without knowing it. See POST /password.
  if (user.mustChangePassword) user.googleVerifiedAt = at;
  persist();

  const { refreshToken } = await sessions.open(user, req);
  setRefreshCookie(res, refreshToken, { maxAgeSec: REFRESH_TTL_SEC, secure: SECURE_COOKIES });

  record({ ...req, user: { sub: user._id, name: user.name, role: normaliseRole(user.role) } }, {
    action: 'AUTH_LOGIN_GOOGLE', entity: 'user', entityId: user._id,
    label: `${user.name} signed in with Google`,
    after: { email: identity.email, firstLink },
  });
  if (firstLink) {
    notify({
      userId: user._id,
      level: 'info',
      title: 'Your Google account is now linked',
      body: `${identity.email} can sign in to GCloud from now on. Your password still works exactly as before.`,
      link: '/profile',
    });
  }

  // No token in the URL. The refresh cookie is already set, so the client exchanges it for
  // an access token the moment it loads — a token in a query string ends up in history,
  // in logs, and in the referrer of the next request.
  res.redirect(302, signInLanding({ google: 'ok', returnTo: state.returnTo }));
});

// ── Refresh ─────────────────────────────────────────────────────────────────
// The only route in the product authorised by a cookie rather than a bearer header, and
// therefore the only one with any CSRF surface. Three things close it: SameSite=Strict on
// the cookie, an Origin check here, and the fact that the response is useless to an
// attacker who cannot read it cross-origin.
authRouter.post('/refresh', async (req, res) => {
  const origin = req.get('origin');
  if (origin && origin !== ORIGIN && !req.app.locals.corsOrigins?.includes(origin)) {
    return problem(res, 403, 'Forbidden', 'Cross-origin refresh is not allowed.');
  }

  const presented = readRefreshCookie(req);
  const out = await sessions.rotate(presented, req);

  if (!out.ok) {
    clearRefreshCookie(res, { secure: SECURE_COOKIES });
    if (out.reason === 'reuse') {
      // Somebody replayed a token that had already been spent. Both holders are now
      // signed out; the account owner is told, because this is the one signal that a
      // session was actually stolen.
      const user = db.users.find((u) => u._id === out.userId);
      notify({
        userId: out.userId,
        level: 'danger',
        title: 'A sign-in token was used twice',
        body: 'Every session on this account has been ended as a precaution. Sign in again, and change the password if this was not you.',
        link: '/profile',
      });
      record({ ...req, user: { sub: out.userId, name: user?.name ?? 'unknown', role: 'system' } }, {
        action: 'AUTH_TOKEN_REUSE', entity: 'user', entityId: out.userId,
        label: 'Refresh-token reuse detected — all sessions revoked',
      });
    }
    return problem(res, 401, 'Unauthorized', 'This session has ended. Sign in again.');
  }

  const user = db.users.find((u) => u._id === out.userId && u.status === 'active');
  if (!user) {
    await sessions.revokeFamily(out.familyId, 'account-gone');
    clearRefreshCookie(res, { secure: SECURE_COOKIES });
    return problem(res, 401, 'Unauthorized', 'This account is no longer active.');
  }

  setRefreshCookie(res, out.refreshToken, { maxAgeSec: REFRESH_TTL_SEC, secure: SECURE_COOKIES });
  res.json({ accessToken: signAccess(user), expiresIn: ACCESS_TTL_SEC, user: publicUser(user) });
});

// Set a password on an account that still holds the one an administrator handed over.
//
// This is the only write in the product that a half-authenticated caller may make: the
// token is real and the account is real, but `mustChangePassword` is still set, so the
// first change is let through on the starting password alone. Every later change asks for
// the current one just the same.
// A Google sign-in is proof of identity, and for a few minutes after one it stands in for
// the handover password on this one route. Without this, somebody added by an
// administrator and told "just use Google" would still be stopped at the set-a-password
// screen and asked for a value nobody sent them.
//
// Deliberately narrow. It only ever applies while `mustChangePassword` is set — that is,
// to a password the administrator chose and at least two people know, which is the one
// password there is nothing to protect. Every later change asks for the current one, and
// a Google sign-in does not help.
const GOOGLE_GRANT_SEC = 15 * 60;

const googleVerifiedRecently = (user) =>
  Boolean(user.mustChangePassword)
  && Boolean(user.googleVerifiedAt)
  && Date.now() - Date.parse(user.googleVerifiedAt) < GOOGLE_GRANT_SEC * 1000;

authRouter.post('/password', authenticatePending, async (req, res) => {
  const user = db.users.find((u) => u._id === req.user.sub);
  if (!user) return problem(res, 401, 'Unauthorized', 'This account no longer exists.');

  const { currentPassword, newPassword } = req.body || {};

  const viaGoogle = googleVerifiedRecently(user);
  const ok = viaGoogle || await verifyPassword(String(currentPassword || ''), user.passwordHash);
  if (!ok) {
    registerFailure(user, req);
    record(req, {
      action: 'AUTH_PASSWORD_CHANGE_FAILED', entity: 'user', entityId: user._id,
      label: `Failed password change for ${user.name}`,
    });
    return problem(res, 401, 'Unauthorized', 'That is not the current password for this account.');
  }

  const invalid = await passwordProblem(newPassword, { email: user.email, name: user.name });
  if (invalid) return problem(res, 422, 'Unprocessable Entity', invalid);

  if (await verifyPassword(String(newPassword), user.passwordHash)) {
    return problem(res, 422, 'Unprocessable Entity', 'The new password has to differ from the current one.');
  }

  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  // Spent. The grant covers exactly one password, not fifteen minutes of them.
  user.googleVerifiedAt = null;
  user.passwordChangedAt = new Date().toISOString();
  user.failedLogins = 0;
  user.lockedUntil = null;

  // Every session and every access token minted before this moment stops working — which
  // is the entire point of changing a password after a suspected compromise.
  await invalidateSessions(user, 'password-changed');
  // Security state is flushed synchronously rather than on the 200 ms debounce: a crash
  // in that window would otherwise leave a revoked session working.
  await flushNow().catch(() => null);

  record(req, {
    action: 'AUTH_PASSWORD_CHANGE', entity: 'user', entityId: user._id,
    label: `${user.name} set a new password`,
    meta: { sessionsRevoked: true, authorisedBy: viaGoogle ? 'google' : 'current-password' },
  });

  // The caller keeps working: a fresh session replaces the one just invalidated.
  const { refreshToken } = await sessions.open(user, req);
  setRefreshCookie(res, refreshToken, { maxAgeSec: REFRESH_TTL_SEC, secure: SECURE_COOKIES });
  res.json({ accessToken: signAccess(user), expiresIn: ACCESS_TTL_SEC, user: publicUser(user) });
});

// Re-authentication for a destructive operation. Returns a ticket the client sends back in
// `x-step-up`, so one password entry covers a few minutes of confirmations.
authRouter.post('/step-up', authenticate, async (req, res) => {
  const user = db.users.find((u) => u._id === req.user.sub);
  if (!user) return problem(res, 401, 'Unauthorized', 'This account no longer exists.');
  const ok = await verifyPassword(String(req.body?.password || ''), user.passwordHash);
  if (!ok) {
    registerFailure(user, req);
    record(req, {
      action: 'AUTH_STEP_UP_FAILED', entity: 'user', entityId: user._id,
      label: `Failed re-authentication for ${user.name}`,
    });
    return problem(res, 401, 'Unauthorized', 'That is not the password for this account.');
  }
  record(req, { action: 'AUTH_STEP_UP', entity: 'user', entityId: user._id, label: `${user.name} re-authenticated` });
  res.json({ ticket: mintStepUpTicket(user._id), expiresIn: 300 });
});

authRouter.post('/logout', authenticate, async (req, res) => {
  await sessions.revokeByToken(readRefreshCookie(req), 'signed-out').catch(() => null);
  clearRefreshCookie(res, { secure: SECURE_COOKIES });
  record(req, { action: 'AUTH_LOGOUT', entity: 'user', entityId: req.user.sub, label: `${req.user.name} signed out` });
  res.json({ ok: true });
});

// Every device, everywhere — the thing to reach for when a laptop goes missing.
authRouter.post('/logout-all', authenticate, async (req, res) => {
  const user = db.users.find((u) => u._id === req.user.sub);
  if (!user) return problem(res, 401, 'Unauthorized', 'This account no longer exists.');
  await invalidateSessions(user, 'signed-out-everywhere');
  await flushNow().catch(() => null);
  clearRefreshCookie(res, { secure: SECURE_COOKIES });
  record(req, {
    action: 'AUTH_LOGOUT_ALL', entity: 'user', entityId: user._id,
    label: `${user.name} signed out of every device`,
  });
  res.json({ ok: true });
});

export const meRouter = express.Router();
meRouter.get('/', authenticatePending, (req, res) => {
  const user = db.users.find((u) => u._id === req.user.sub);
  res.json(publicUser(user));
});

// The account's live sessions, so somebody can see a device they do not recognise.
meRouter.get('/sessions', authenticate, async (req, res) => {
  res.json({ data: await sessions.listForUser(req.user.sub) });
});
