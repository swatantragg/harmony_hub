import crypto from 'node:crypto';
import { db } from '../db.js';
import { verifyJwt, verifyPassword } from '../util/crypto.js';
import { can, normaliseRole } from '../catalogue.js';
import { JWT_SECRET, OTP, STEP_UP_MAX_AGE_SEC } from '../config.js';
import { isToday } from '../services/otp.js';

export function problem(res, status, title, detail, extra = {}) {
  return res.status(status).type('application/problem+json').json({
    type: `https://gcloud.internal/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    ...extra,
  });
}

export function clientAddress(req, _res, next) {
  req.socketIp = req.socket?.remoteAddress ?? null;
  req.forwardedFor = String(req.get('x-forwarded-for') || '').slice(0, 200) || null;
  next();
}

function resolve(req) {
  const header = req.get('authorization') || '';
  const claims = verifyJwt(header.replace(/^Bearer\s+/i, ''));
  if (!claims) return null;
  const user = db.users.find((u) => u._id === claims.sub && u.status === 'active');
  if (!user) return null;
  if (Number(claims.tv ?? 0) !== Number(user.tokenVersion ?? 0)) return null;

  // The daily passcode boundary. A 15-minute token minted at 23:58 must not keep
  // answering at 00:05, so the day it was stamped with is checked on every
  // request rather than being left to expiry.
  if (OTP.enabled && claims.dk && !isToday(claims.dk)) {
    req.dayExpired = true;
    return null;
  }
  return user;
}

const identify = (user) => ({
  sub: user._id, name: user.name, role: normaliseRole(user.role), email: user.email,
  tokenVersion: Number(user.tokenVersion ?? 0),
});

/** The 401 body that tells the client to ask for a passcode rather than a password. */
const unauthorized = (req, res) =>
  (req.dayExpired
    ? problem(
      res, 401, 'Unauthorized',
      'A new day has started, so this session needs a passcode. Check your email for today’s code.',
      { otpRequired: true, reason: 'day-expired' },
    )
    : problem(res, 401, 'Unauthorized', 'A valid access token is required.'));

export function authenticate(req, res, next) {
  const user = resolve(req);
  if (!user) return unauthorized(req, res);
  if (user.mustChangePassword) {
    return problem(
      res, 403, 'Password Change Required',
      'Set a password of your own before using the rest of the application.',
      { mustChangePassword: true },
    );
  }
  req.user = identify(user);
  next();
}

export function authenticatePending(req, res, next) {
  const user = resolve(req);
  if (!user) return unauthorized(req, res);
  req.user = identify(user);
  next();
}

/**
 * Resolves the caller if a token is present, and sets `req.rateKey` either way.
 *
 * Mounted ahead of the global limiters. Without it, their key generator reads
 * `req.user` before any authentication has run, always finds it undefined, and
 * silently degrades to per-address counting — which means one office behind one
 * NAT shares a single budget between everybody in it.
 */
export function identifyForRateLimit(req, _res, next) {
  const user = resolve(req);
  if (user) req.rateUser = identify(user);
  req.rateKey = user ? `u:${user._id}` : `ip:${req.ip}`;
  next();
}

export function optionalAuthenticate(req, _res, next) {
  const user = resolve(req);
  req.user = user && !user.mustChangePassword ? identify(user) : null;
  next();
}

export function requires(permission) {
  return (req, res, next) => {
    if (!can(req.user.role, permission)) {
      return problem(
        res,
        403,
        'Forbidden',
        `The ${req.user.role} role cannot perform this action (${permission}).`,
      );
    }
    next();
  };
}


const stepUpKey = () => crypto.createHmac('sha256', JWT_SECRET).update('step-up-v1').digest();

export function mintStepUpTicket(userId) {
  const payload = Buffer.from(JSON.stringify({
    u: userId,
    e: Math.floor(Date.now() / 1000) + STEP_UP_MAX_AGE_SEC,
    n: crypto.randomBytes(6).toString('base64url'),
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', stepUpKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function stepUpTicketValid(ticket, userId) {
  const [payload, signature] = String(ticket || '').split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', stepUpKey()).update(payload).digest('base64url');
  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.u === userId && Math.floor(Date.now() / 1000) <= Number(claims.e);
  } catch {
    return false;
  }
}

export function requireStepUp(action) {
  return async (req, res, next) => {
    const user = db.users.find((u) => u._id === req.user.sub);
    if (!user) return problem(res, 401, 'Unauthorized', 'This account no longer exists.');

    if (stepUpTicketValid(req.get('x-step-up'), user._id)) return next();

    const supplied = req.body?.confirmPassword;
    if (supplied && await verifyPassword(String(supplied), user.passwordHash)) return next();

    return problem(
      res, 401, 'Reauthentication Required',
      `${action} permanently destroys data. Confirm it with the password for this account.`,
      { stepUp: true, action },
    );
  };
}
