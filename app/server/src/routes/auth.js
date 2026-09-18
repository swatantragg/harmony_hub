import crypto from 'node:crypto';
import express from 'express';
import { db, adoptOne, persist, flushNow } from '../db.js';
import { signJwt, token, verifyPassword, hashPassword } from '../util/crypto.js';
import {
  ACCESS_TTL_SEC, APP_ORIGIN, GOOGLE_SIGNIN, GOOGLE_SIGNIN_CONFIGURED,
  LOGIN_ANOMALY_NOTIFY, LOGIN_LOCKOUT_SEC, LOGIN_MAX_FAILURES, MAIL_CONFIGURED,
  MIN_PASSWORD_LENGTH, NODE_ENV, ORIGIN, PASSWORD_BREACH_CHECK,
  PASSWORD_HISTORY_DEPTH, PASSWORD_MAX_AGE_DAYS, REFRESH_TTL_SEC, isWeakPassword,
} from '../config.js';
import { PERMISSIONS, normaliseRole } from '../catalogue.js';
import { authenticate, authenticatePending, mintStepUpTicket, problem } from '../middleware/auth.js';
import { record, notify } from '../services/audit.js';
import * as sessions from '../services/sessions.js';
import {
  clearRefreshCookie, clearSignInStateCookie, issueCsrfCookie, readRefreshCookie,
  readSignInStateCookie, setRefreshCookie, setSignInStateCookie,
} from '../util/cookies.js';
import * as google from '../services/google-signin.js';
import * as otp from '../services/otp.js';
import * as mailer from '../services/mailer.js';

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

const signAccess = (user, day = otp.dayKey()) => signJwt({
  sub: user._id,
  role: normaliseRole(user.role),
  name: user.name,
  tv: Number(user.tokenVersion ?? 0),
  // The day this token was passcode-verified for. `authenticate` refuses it
  // once that day is over, which is what makes midnight a hard boundary rather
  // than "some time in the next fifteen minutes".
  ...(otp.enabled() ? { dk: day } : {}),
}, ACCESS_TTL_SEC);

/** The one shape a completed sign-in returns, whichever door it came through. */
function signedIn(res, user, { refreshToken, day }) {
  setRefreshCookie(res, refreshToken, { maxAgeSec: REFRESH_TTL_SEC, secure: SECURE_COOKIES });
  issueCsrfCookie(res, { secure: SECURE_COOKIES });
  return {
    accessToken: signAccess(user, day),
    expiresIn: ACCESS_TTL_SEC,
    user: publicUser(user),
    ...(otp.enabled() ? { session: { dayKey: day, validUntil: otp.endOfDay() } } : {}),
  };
}

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

export async function passwordProblem(value, { email = '', name = '', history = [] } = {}) {
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
  // Reuse check before the network call: no reason to ask the breach service
  // about a password that is already refused.
  for (const previous of history.slice(0, PASSWORD_HISTORY_DEPTH)) {
    if (await verifyPassword(password, previous)) {
      return `That is one of the last ${PASSWORD_HISTORY_DEPTH} passwords used on this account. Choose one that has not been used here before.`;
    }
  }
  if (await breached(password)) {
    return 'That password appears in a public breach corpus. Choose one that does not.';
  }
  return null;
}

/**
 * Records the outgoing hash so it cannot be chosen again, newest first.
 * Called with the hash being replaced, before the new one is written.
 */
function rememberPassword(user, retiringHash) {
  if (!PASSWORD_HISTORY_DEPTH || !retiringHash) return;
  user.passwordHistory = [retiringHash, ...(user.passwordHistory ?? [])].slice(0, PASSWORD_HISTORY_DEPTH);
}

const passwordExpired = (user) => {
  if (!PASSWORD_MAX_AGE_DAYS || !user.passwordChangedAt) return false;
  return Date.now() - Date.parse(user.passwordChangedAt) > PASSWORD_MAX_AGE_DAYS * 86_400_000;
};

// ── Daily passcode delivery ─────────────────────────────────────────────────

/**
 * Opens a challenge and mails the code. Returns the ticket the client presents
 * with the code, or a problem to hand back.
 *
 * The *presence* of an account is never revealed by this function's shape —
 * callers that could leak it (the reset path) call it only after deciding to
 * answer 202 regardless.
 */
async function challenge(user, purpose, req, { familyId = null } = {}) {
  const opened = await otp.open({
    userId: user._id,
    purpose,
    familyId,
    meta: { ip: req.socketIp, userAgent: req.get('user-agent') },
  });
  if (!opened.ok) return opened;

  const mail = purpose === otp.PURPOSES.RESET
    ? mailer.passwordResetMail({
      name: user.name, code: opened.code, ttlMinutes: Math.round(opened.ttlSec / 60),
    })
    : mailer.dailyPasscodeMail({
      name: user.name,
      code: opened.code,
      ttlMinutes: Math.round(opened.ttlSec / 60),
      expiresOn: new Date(otp.endOfDay()).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
    });

  const sent = await mailer.send({ to: user.email, toName: user.name, ...mail, tags: ['otp', purpose] });

  record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
    action: 'AUTH_OTP_SENT', entity: 'user', entityId: user._id,
    label: `Passcode sent to ${user.name} (${purpose})`,
    after: { purpose, delivered: sent.ok, reason: sent.ok ? null : sent.reason },
  });

  return {
    ok: true,
    ticket: otp.mintTicket({ challengeId: opened.challengeId, userId: user._id, purpose }),
    ttlSec: opened.ttlSec,
    delivered: sent.ok,
    // A development machine with no Brevo key still has to be usable. The code
    // is echoed only there, and only when mail is genuinely unconfigured.
    ...(sent.simulated && NODE_ENV !== 'production' ? { devCode: opened.code } : {}),
  };
}

const maskEmail = (address) => {
  const [name, domain] = String(address).split('@');
  if (!domain) return '•••';
  const head = name.slice(0, Math.min(2, name.length));
  return `${head}${'•'.repeat(Math.max(3, name.length - head.length))}@${domain}`;
};


const lockedUntil = (user) => (user?.lockedUntil ? Date.parse(user.lockedUntil) : 0);

function registerFailure(user, req) {
  if (!user) return;
  user.failedLogins = Number(user.failedLogins ?? 0) + 1;
  if (user.failedLogins >= LOGIN_MAX_FAILURES) {
    user.lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_SEC * 1000).toISOString();
    user.failedLogins = 0;
    notify({
      audience: 'admin',
      category: 'security',
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

/**
 * Accounts are looked up by address on three paths — password sign-in, Google
 * sign-in and a reset request — and all three have to see an account created a
 * moment ago on another instance. A miss in the working set is therefore a
 * question for the database, not an answer.
 */
const userByEmail = async (address) => {
  const known = db.users.find((u) => u.email.toLowerCase() === address);
  if (known || !address) return known ?? null;
  // The indexed exact match first. The case-insensitive pass is only for rows
  // that predate addresses being lowered on the way in, and matches what the
  // comparison above would have accepted.
  const exact = await adoptOne('users', { email: address });
  if (exact) return exact;
  const anchored = new RegExp(`^${address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  return adoptOne('users', { email: anchored });
};

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const address = String(email || '').trim().toLowerCase();
  const user = await userByEmail(address);

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
  persist();

  // The password was right, but no session exists yet. One passcode per day
  // stands between the two.
  if (otp.enabled()) {
    const out = await challenge(user, otp.PURPOSES.LOGIN, req);
    if (!out.ok && out.reason === 'cooldown') {
      return problem(
        res, 429, 'Too Many Requests',
        `A passcode was sent moments ago. Wait ${out.retryAfterSec} seconds, or use the one already in your inbox.`,
        { otpRequired: true, retryAfterSec: out.retryAfterSec },
      );
    }
    if (!out.ok) return problem(res, 502, 'Bad Gateway', 'A passcode could not be issued. Try again shortly.');
    if (!out.delivered && !out.devCode) {
      return problem(
        res, 502, 'Bad Gateway',
        'Your password was accepted, but the passcode email could not be sent. Tell an administrator — mail delivery is not working.',
      );
    }
    record({ ...req, user: { sub: user._id, name: user.name, role: normaliseRole(user.role) } }, {
      action: 'AUTH_LOGIN_PENDING_OTP', entity: 'user', entityId: user._id,
      label: `${user.name} passed the password step and was sent a passcode`,
    });
    return res.status(202).json({
      otpRequired: true,
      otpToken: out.ticket,
      expiresIn: out.ttlSec,
      sentTo: maskEmail(user.email),
      validUntil: otp.endOfDay(),
      ...(out.devCode ? { devCode: out.devCode } : {}),
    });
  }

  user.lastLoginAt = new Date().toISOString();
  persist();

  await flagUnknownDevice(user, req);
  const opened = await sessions.open(user, req);

  record({ ...req, user: { sub: user._id, name: user.name, role: normaliseRole(user.role) } }, {
    action: 'AUTH_LOGIN', entity: 'user', entityId: user._id, label: `${user.name} signed in`,
  });
  res.json(signedIn(res, user, opened));
});

// ── The daily passcode ──────────────────────────────────────────────────────

/**
 * Completes a sign-in, or a next-morning resume, with the code from the email.
 *
 * Two paths land here and they differ in one way only: `resume` re-stamps a
 * session family that already existed, so the person types a passcode and
 * nothing else. `login` opens a new family, and got here by presenting a
 * password first. Both end with a family stamped for today.
 */
authRouter.post('/otp', async (req, res) => {
  const ticket = otp.readTicket(req.body?.otpToken);
  if (!ticket) {
    return problem(res, 401, 'Unauthorized', 'That passcode request has expired. Start again.', { otpExpired: true });
  }

  const user = db.users.find((u) => u._id === ticket.userId);
  if (!user) return problem(res, 401, 'Unauthorized', 'This account no longer exists.');
  if (user.status !== 'active') return problem(res, 403, 'Forbidden', 'This account has been suspended.');
  if (lockedUntil(user) > Date.now()) {
    return problem(res, 429, 'Too Many Requests', 'This account is temporarily locked. Try again shortly.');
  }

  const out = await otp.verify({
    challengeId: ticket.challengeId,
    userId: ticket.userId,
    purpose: ticket.purpose,
    code: req.body?.code,
  });

  if (!out.ok) {
    registerFailure(user, req);
    record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
      action: 'AUTH_OTP_FAILED', entity: 'user', entityId: user._id,
      label: `Wrong passcode for ${user.name}`,
      after: { reason: out.reason, attemptsLeft: out.attemptsLeft ?? 0 },
    });
    const terminal = out.reason === 'exhausted' || out.reason === 'expired' || out.reason === 'spent';
    return problem(
      res, 401, 'Unauthorized',
      terminal
        ? 'That passcode is no longer usable. Request a new one.'
        : `That passcode is not correct. ${out.attemptsLeft} attempt${out.attemptsLeft === 1 ? '' : 's'} left.`,
      { otpRequired: !terminal, otpExpired: terminal, attemptsLeft: out.attemptsLeft ?? 0 },
    );
  }

  const day = otp.dayKey();
  user.failedLogins = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date().toISOString();
  persist();

  let opened;
  if (ticket.purpose === otp.PURPOSES.RESUME && out.familyId) {
    opened = await sessions.restamp(out.familyId, req, { day });
    // The family aged out while the passcode was in flight. Falling back to a
    // fresh one is correct: the password step already happened yesterday and
    // the passcode has just been proved.
    if (!opened.ok) opened = await sessions.open(user, req, { day });
  } else {
    await flagUnknownDevice(user, req);
    opened = await sessions.open(user, req, { day });
  }

  record({ ...req, user: { sub: user._id, name: user.name, role: normaliseRole(user.role) } }, {
    action: 'AUTH_LOGIN', entity: 'user', entityId: user._id,
    label: `${user.name} signed in with today's passcode`,
    after: { via: ticket.purpose, dayKey: day },
  });

  res.json(signedIn(res, user, { refreshToken: opened.refreshToken, day }));
});

/**
 * The next morning. A refresh cookie that is valid in every way except its day
 * stamp is worth one thing: a passcode prompt instead of a full sign-in.
 */
authRouter.post('/otp/resume', async (req, res) => {
  if (!otp.enabled()) return problem(res, 409, 'Conflict', 'Daily passcodes are not enabled here.');

  const presented = readRefreshCookie(req);
  const familyId = await sessions.familyOfToken(presented);
  if (!familyId) {
    clearRefreshCookie(res, { secure: SECURE_COOKIES });
    return problem(res, 401, 'Unauthorized', 'There is no session to resume. Sign in with your password.');
  }

  const userId = await sessions.familyOwner(familyId);
  const user = db.users.find((u) => u._id === userId && u.status === 'active');
  if (!user) {
    clearRefreshCookie(res, { secure: SECURE_COOKIES });
    return problem(res, 401, 'Unauthorized', 'This account is no longer active.');
  }
  if (lockedUntil(user) > Date.now()) {
    return problem(res, 429, 'Too Many Requests', 'This account is temporarily locked. Try again shortly.');
  }

  const out = await challenge(user, otp.PURPOSES.RESUME, req, { familyId });
  if (!out.ok && out.reason === 'cooldown') {
    return problem(
      res, 429, 'Too Many Requests',
      `A passcode was sent moments ago. Wait ${out.retryAfterSec} seconds.`,
      { otpRequired: true, retryAfterSec: out.retryAfterSec },
    );
  }
  if (!out.ok) return problem(res, 502, 'Bad Gateway', 'A passcode could not be issued. Try again shortly.');

  res.status(202).json({
    otpRequired: true,
    otpToken: out.ticket,
    expiresIn: out.ttlSec,
    sentTo: maskEmail(user.email),
    name: user.name,
    validUntil: otp.endOfDay(),
    ...(out.devCode ? { devCode: out.devCode } : {}),
  });
});

/** Re-sends the code for a request already in flight. Cooldown-limited in otp.open. */
authRouter.post('/otp/resend', async (req, res) => {
  const ticket = otp.readTicket(req.body?.otpToken);
  if (!ticket) return problem(res, 401, 'Unauthorized', 'That passcode request has expired. Start again.');

  const user = db.users.find((u) => u._id === ticket.userId && u.status === 'active');
  if (!user) return problem(res, 401, 'Unauthorized', 'This account is no longer active.');

  const familyId = ticket.purpose === otp.PURPOSES.RESUME
    ? await sessions.familyOfToken(readRefreshCookie(req))
    : null;

  const out = await challenge(user, ticket.purpose, req, { familyId });
  if (!out.ok && out.reason === 'cooldown') {
    return problem(
      res, 429, 'Too Many Requests',
      `Wait ${out.retryAfterSec} seconds before asking for another.`,
      { retryAfterSec: out.retryAfterSec },
    );
  }
  if (!out.ok) return problem(res, 502, 'Bad Gateway', 'A passcode could not be issued.');

  res.json({
    otpToken: out.ticket,
    expiresIn: out.ttlSec,
    sentTo: maskEmail(user.email),
    ...(out.devCode ? { devCode: out.devCode } : {}),
  });
});

// ── Unknown devices ─────────────────────────────────────────────────────────

/**
 * Warns the account holder the first time a given address-and-browser pair is
 * used. Notifies rather than blocks: a false positive that locks somebody out
 * of their own library on a new laptop is worse than one they can read and
 * dismiss. Never throws — a sign-in must not fail because mail did.
 */
async function flagUnknownDevice(user, req) {
  if (!LOGIN_ANOMALY_NOTIFY) return;
  try {
    const fingerprint = sessions.deviceFingerprint(req);
    if (await sessions.isKnownDevice(user._id, fingerprint)) return;

    const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const ip = req.socketIp ?? 'an unknown address';
    const userAgent = String(req.get('user-agent') || 'an unidentified browser').slice(0, 160);

    notify({
      userId: user._id,
      audience: 'admin',
      category: 'security',
      level: 'warn',
      title: 'A new device signed in to your account',
      body: `${when} · ${ip} · ${userAgent}`,
      link: '/profile',
    });
    record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
      action: 'AUTH_NEW_DEVICE', entity: 'user', entityId: user._id,
      label: `${user.name} signed in from a device not seen before`,
      after: { ip, userAgent },
    });

    if (MAIL_CONFIGURED) {
      void mailer.send({
        to: user.email,
        toName: user.name,
        ...mailer.newDeviceMail({ name: user.name, when, ip, userAgent }),
        tags: ['security', 'new-device'],
      });
    }
  } catch (err) {
    console.error('[auth] new-device check failed:', err.message);
  }
}


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

  const user = await userByEmail(identity.email);

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

  // Google sign-in satisfies the day's verification on its own. The person has
  // just completed a live, interactive authentication with Google — asking for
  // an emailed code on top of that adds friction without adding a factor, and
  // the redirect flow has nowhere sensible to put the prompt. The session is
  // stamped with today exactly as a passcode sign-in would be, so it expires at
  // the same midnight.
  const day = otp.dayKey();
  await flagUnknownDevice(user, req);
  const { refreshToken } = await sessions.open(user, req, { day });
  setRefreshCookie(res, refreshToken, { maxAgeSec: REFRESH_TTL_SEC, secure: SECURE_COOKIES });
  issueCsrfCookie(res, { secure: SECURE_COOKIES });

  record({ ...req, user: { sub: user._id, name: user.name, role: normaliseRole(user.role) } }, {
    action: 'AUTH_LOGIN_GOOGLE', entity: 'user', entityId: user._id,
    label: `${user.name} signed in with Google`,
    after: { email: identity.email, firstLink, dayKey: day },
  });
  if (firstLink) {
    notify({
      userId: user._id,
      audience: 'private',
      category: 'security',
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

  // The day rolled over. The cookie is deliberately left in place — it is what
  // the resume path reads to decide this browser has earned a passcode prompt
  // rather than a full sign-in.
  if (!out.ok && out.reason === 'day-expired') {
    const owner = db.users.find((u) => u._id === out.userId);
    return problem(
      res, 401, 'Unauthorized',
      'A new day has started. Enter today’s passcode to carry on — your password is not needed.',
      { otpRequired: true, canResume: true, reason: 'day-expired', name: owner?.name ?? null },
    );
  }

  if (!out.ok) {
    clearRefreshCookie(res, { secure: SECURE_COOKIES });
    if (out.reason === 'reuse') {
      const user = db.users.find((u) => u._id === out.userId);
      notify({
        userId: out.userId,
        audience: 'admin',
        category: 'security',
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

  res.json(signedIn(res, user, { refreshToken: out.refreshToken, day: out.dayKey }));
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

  const invalid = await passwordProblem(newPassword, {
    email: user.email, name: user.name, history: user.passwordHistory ?? [],
  });
  if (invalid) return problem(res, 422, 'Unprocessable Entity', invalid);

  if (await verifyPassword(String(newPassword), user.passwordHash)) {
    return problem(res, 422, 'Unprocessable Entity', 'The new password has to differ from the current one.');
  }

  rememberPassword(user, user.passwordHash);
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

  // Setting a password is itself an authenticated act, so the replacement
  // session inherits today's stamp rather than sending the person round the
  // passcode loop they just came through.
  const opened = await sessions.open(user, req, { day: otp.dayKey() });
  res.json(signedIn(res, user, opened));
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

// ── Forgotten password ──────────────────────────────────────────────────────
//
// Two steps, both answering the same way whether or not the address is known.
// The reply to `/forgot` is 202 with an identical body every time: if it said
// "no such account", the endpoint would become a free membership oracle for
// anybody with a list of company email addresses.

authRouter.post('/forgot', async (req, res) => {
  const address = String(req.body?.email || '').trim().toLowerCase();
  const accepted = {
    ok: true,
    message: 'If that address has an account here, a reset code is on its way to it.',
    expiresIn: 10 * 60,
  };

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return res.status(202).json(accepted);

  const user = await userByEmail(address);
  if (!user || user.status !== 'active') {
    record({ ...req, user: { sub: null, name: address, role: 'anonymous' } }, {
      action: 'AUTH_RESET_REQUESTED', entity: 'user', entityId: 'unknown',
      label: `Password reset requested for ${address} — no active account`,
    });
    return res.status(202).json(accepted);
  }

  const out = await challenge(user, otp.PURPOSES.RESET, req);
  // A cooldown is not reported either, for the same reason: a different answer
  // for a second request would confirm the first one found something.
  return res.status(202).json({
    ...accepted,
    ...(out.ok ? { resetToken: out.ticket } : {}),
    ...(out.devCode ? { devCode: out.devCode } : {}),
  });
});

authRouter.post('/reset', async (req, res) => {
  const ticket = otp.readTicket(req.body?.resetToken);
  if (!ticket || ticket.purpose !== otp.PURPOSES.RESET) {
    return problem(res, 401, 'Unauthorized', 'That reset request has expired. Ask for a new code.');
  }

  const user = db.users.find((u) => u._id === ticket.userId);
  if (!user || user.status !== 'active') {
    return problem(res, 401, 'Unauthorized', 'That reset request is no longer valid.');
  }

  const verified = await otp.verify({
    challengeId: ticket.challengeId, userId: ticket.userId,
    purpose: otp.PURPOSES.RESET, code: req.body?.code,
  });
  if (!verified.ok) {
    record({ ...req, user: { sub: user._id, name: user.name, role: 'system' } }, {
      action: 'AUTH_RESET_CODE_FAILED', entity: 'user', entityId: user._id,
      label: `Wrong reset code for ${user.name}`,
      after: { reason: verified.reason },
    });
    const terminal = verified.reason !== 'mismatch';
    return problem(
      res, 401, 'Unauthorized',
      terminal
        ? 'That code is no longer usable. Ask for a new one.'
        : `That code is not correct. ${verified.attemptsLeft} attempt${verified.attemptsLeft === 1 ? '' : 's'} left.`,
      { attemptsLeft: verified.attemptsLeft ?? 0, expired: terminal },
    );
  }

  const invalid = await passwordProblem(req.body?.newPassword, {
    email: user.email, name: user.name, history: user.passwordHistory ?? [],
  });
  // The code is spent by now, which is correct — it authorised this one attempt
  // at setting a password. A rejected password means asking for a fresh code.
  if (invalid) return problem(res, 422, 'Unprocessable Entity', invalid, { codeSpent: true });

  rememberPassword(user, user.passwordHash);
  user.passwordHash = await hashPassword(String(req.body.newPassword));
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date().toISOString();
  user.failedLogins = 0;
  user.lockedUntil = null;

  // Everything that was signed in before the reset stops being signed in. A
  // reset is what somebody does when they think the account is compromised.
  await invalidateSessions(user, 'password-reset');
  await flushNow().catch(() => null);
  clearRefreshCookie(res, { secure: SECURE_COOKIES });

  record({ ...req, user: { sub: user._id, name: user.name, role: normaliseRole(user.role) } }, {
    action: 'AUTH_PASSWORD_RESET_SELF', entity: 'user', entityId: user._id,
    label: `${user.name} reset their own password with an emailed code`,
    meta: { sessionsRevoked: true },
  });
  notify({
    userId: user._id, audience: 'admin', category: 'security', level: 'warn',
    title: 'Your password was reset',
    body: 'It was reset with a code sent to your email address, and every session was ended. If this was not you, tell an administrator now.',
    link: '/profile',
  });

  res.json({
    ok: true,
    message: 'Password set. Sign in with it — you will be asked for today’s passcode as usual.',
  });
});

export const meRouter = express.Router();
meRouter.get('/', authenticatePending, (req, res) => {
  const user = db.users.find((u) => u._id === req.user.sub);
  res.json({ ...publicUser(user), passwordExpired: passwordExpired(user) });
});

meRouter.get('/sessions', authenticate, async (req, res) => {
  const current = await sessions.familyOfToken(readRefreshCookie(req));
  const rows = await sessions.listForUser(req.user.sub);
  res.json({ data: rows.map((r) => ({ ...r, current: r.familyId === current })) });
});

/**
 * Ends one session without touching the others.
 *
 * "Sign out everywhere" was the only tool here, which is the wrong instrument
 * for the common case: a laptop left at the office, a phone that was sold. The
 * ownership test lives in the service so no route can forget it.
 */
meRouter.delete('/sessions/:familyId', authenticate, async (req, res) => {
  const out = await sessions.revokeOwnFamily(req.user.sub, req.params.familyId, 'revoked-by-user');
  if (!out.ok) return problem(res, 404, 'Not Found', 'No session of yours with that id.');

  const current = await sessions.familyOfToken(readRefreshCookie(req));
  if (current === req.params.familyId) clearRefreshCookie(res, { secure: SECURE_COOKIES });

  record(req, {
    action: 'AUTH_SESSION_REVOKE', entity: 'user', entityId: req.user.sub,
    label: `${req.user.name} ended one of their sessions`,
    after: { familyId: req.params.familyId, wasCurrent: current === req.params.familyId },
  });
  res.json({ ok: true, revoked: out.revoked, wasCurrent: current === req.params.familyId });
});
