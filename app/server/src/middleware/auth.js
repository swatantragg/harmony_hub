// Authentication + authorisation middleware chain (§9.3, §12.2).
import crypto from 'node:crypto';
import { db } from '../db.js';
import { verifyJwt, verifyPassword } from '../util/crypto.js';
import { can, normaliseRole } from '../catalogue.js';
import { JWT_SECRET, STEP_UP_MAX_AGE_SEC } from '../config.js';

export function problem(res, status, title, detail, extra = {}) {
  return res.status(status).type('application/problem+json').json({
    type: `https://gcloud.internal/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    ...extra,
  });
}

// The address the socket actually came from, kept separately from req.ip.
//
// req.ip is derived from X-Forwarded-For according to the trust-proxy setting, which is
// right for rate limiting behind a known proxy and wrong for an audit trail: a header is
// something the client writes. Both are recorded, and the socket address is the one that
// cannot be forged.
export function clientAddress(req, _res, next) {
  req.socketIp = req.socket?.remoteAddress ?? null;
  req.forwardedFor = String(req.get('x-forwarded-for') || '').slice(0, 200) || null;
  next();
}

// A token is only as good as the account behind it *now*. Every field checked here is
// re-read from the catalogue on every request, so suspending an account, changing its
// role or changing its password takes effect on the next call rather than at the end of
// the token's lifetime.
function resolve(req) {
  const header = req.get('authorization') || '';
  const claims = verifyJwt(header.replace(/^Bearer\s+/i, ''));
  if (!claims) return null;
  const user = db.users.find((u) => u._id === claims.sub && u.status === 'active');
  if (!user) return null;
  // The session generation. Bumped by a password change, a suspension, a role change and
  // "sign out everywhere" — every token minted before the bump stops verifying here.
  if (Number(claims.tv ?? 0) !== Number(user.tokenVersion ?? 0)) return null;
  return user;
}

const identify = (user) => ({
  sub: user._id, name: user.name, role: normaliseRole(user.role), email: user.email,
  tokenVersion: Number(user.tokenVersion ?? 0),
});

// The normal gate. An account that still holds the password an administrator handed over
// gets no further than here: the token is valid, but every route except the two below is
// closed until a password of the person's own is set.
export function authenticate(req, res, next) {
  const user = resolve(req);
  if (!user) return problem(res, 401, 'Unauthorized', 'A valid access token is required.');
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

// The same check without the password gate, for the two routes a person with a starting
// password must still be able to reach: reading their own account, and replacing it.
export function authenticatePending(req, res, next) {
  const user = resolve(req);
  if (!user) return problem(res, 401, 'Unauthorized', 'A valid access token is required.');
  req.user = identify(user);
  next();
}

// Identifies the caller when a token is present, and lets them through when it is not.
// Used by the public share surface, where one URL serves an anonymous partner, a signed-in
// editor and a named recipient — and the share record decides which of the three is allowed.
export function optionalAuthenticate(req, _res, next) {
  const user = resolve(req);
  req.user = user && !user.mustChangePassword ? identify(user) : null;
  next();
}

// Permissions are resolved server-side on every request — never carried in the token.
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

// ── Step-up authentication (§12.2) ──────────────────────────────────────────
//
// For the handful of operations that destroy data no backup can return: purging an asset,
// emptying the Drive trash, changing somebody's role. A valid session is not enough,
// because the threat being defended against is a session that was not opened by its
// owner — a borrowed laptop, a stolen token, a hijacked tab.
//
// Two ways to satisfy it, and both end at the same place — the account's own password:
//
//   · POST /api/auth/step-up with the password, then send the returned ticket in
//     `x-step-up` for a few minutes. This is what the UI does, so a person confirming
//     three deletions types their password once.
//   · Put `confirmPassword` in the request body. Simpler for a script or a curl.

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
