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

const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO3Zm/9dOtaGZkVpq7Zt.Fx9pHkoJn0Mm';

const SECURE_COOKIES = NODE_ENV === 'production' || !/^http:\/\/(localhost|127\.0\.0\.1)/.test(ORIGIN);

const publicUser = (u) => ({
  _id: u._id, name: u.name, email: u.email, role: normaliseRole(u.role),
  status: u.status, lastLoginAt: u.lastLoginAt,
  mustChangePassword: Boolean(u.mustChangePassword),
  permissions: PERMISSIONS[normaliseRole(u.role)],
  createdAt: u.createdAt ?? null,
  passwordChangedAt: u.passwordChangedAt ?? null,
  createdBy: u.createdBy ?? null,
  createdByName: u.createdBy ? db.users.find((x) => x._id === u.createdBy)?.name ?? null : null,
  minPasswordLength: MIN_PASSWORD_LENGTH,
  google: u.google
    ? { linkedAt: u.google.linkedAt, email: u.google.email, lastSignInAt: u.google.lastSignInAt ?? null }
    : null,
  googleSignInAvailable: GOOGLE_SIGNIN_CONFIGURED,
  canSetPasswordWithoutCurrent: googleVerifiedRecently(u),
});

const signAccess = (user) => signJwt({
  sub: user._id,
  role: normaliseRole(user.role),
  name: user.name,
  tv: Number(user.tokenVersion ?? 0),
}, ACCESS_TTL_SEC);

export async function invalidateSessions(user, reason) {
  user.tokenVersion = Number(user.tokenVersion ?? 0) + 1;
  persist();
  await sessions.revokeAllForUser(user._id, reason).catch(() => null);
}


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

  const ok = await verifyPassword(String(password || ''), user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    registerFailure(user, req);
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


const signInLanding = (params) => `${APP_ORIGIN}/#/login?${new URLSearchParams(params)}`;

authRouter.get('/providers', (_req, res) => {
  res.json({
    password: true,
    google: {
      enabled: GOOGLE_SIGNIN_CONFIGURED,
      hostedDomain: GOOGLE_SIGNIN.hostedDomain,
    },
  });
});

authRouter.get('/google', (req, res) => {
  if (!GOOGLE_SIGNIN_CONFIGURED) return res.redirect(302, signInLanding({ google: 'error', reason: 'disabled' }));

  const nonce = token(18);
  const state = google.mintState({ nonce, returnTo: String(req.query.returnTo || '/') });
  setSignInStateCookie(res, nonce, { maxAgeSec: google.STATE_TTL_SEC, secure: SECURE_COOKIES });
  res.redirect(302, google.authorizeUrl({
    state,
    loginHint: String(req.query.email || '').trim().toLowerCase() || null,
  }));
});

authRouter.get('/google/callback', async (req, res) => {
  const fail = (reason, detail) => {
    clearSignInStateCookie(res, { secure: SECURE_COOKIES });
    return res.redirect(302, signInLanding({ google: 'error', reason, ...(detail ? { detail } : {}) }));
  };

  if (!GOOGLE_SIGNIN_CONFIGURED) return fail('disabled');
  if (req.query.error) return fail(req.query.error === 'access_denied' ? 'cancelled' : 'refused');

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
  if (lockedUntil(user) > Date.now()) {
    record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
      action: 'AUTH_GOOGLE_BLOCKED', entity: 'user', entityId: user._id,
      label: `Google sign-in refused — ${user.name}'s account is locked`,
    });
    return fail('locked');
  }
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

  res.redirect(302, signInLanding({ google: 'ok', returnTo: state.returnTo }));
});

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
  user.googleVerifiedAt = null;
  user.passwordChangedAt = new Date().toISOString();
  user.failedLogins = 0;
  user.lockedUntil = null;

  await invalidateSessions(user, 'password-changed');
  await flushNow().catch(() => null);

  record(req, {
    action: 'AUTH_PASSWORD_CHANGE', entity: 'user', entityId: user._id,
    label: `${user.name} set a new password`,
    meta: { sessionsRevoked: true, authorisedBy: viaGoogle ? 'google' : 'current-password' },
  });

  const { refreshToken } = await sessions.open(user, req);
  setRefreshCookie(res, refreshToken, { maxAgeSec: REFRESH_TTL_SEC, secure: SECURE_COOKIES });
  res.json({ accessToken: signAccess(user), expiresIn: ACCESS_TTL_SEC, user: publicUser(user) });
});

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

meRouter.get('/sessions', authenticate, async (req, res) => {
  res.json({ data: await sessions.listForUser(req.user.sub) });
});
