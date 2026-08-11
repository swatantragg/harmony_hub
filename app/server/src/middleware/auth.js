// Authentication + authorisation middleware chain (§9.3, §12.2).
import { db } from '../db.js';
import { verifyJwt } from '../util/crypto.js';
import { can, normaliseRole } from '../catalogue.js';

export function problem(res, status, title, detail, extra = {}) {
  return res.status(status).type('application/problem+json').json({
    type: `https://gcloud.internal/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    ...extra,
  });
}

function resolve(req) {
  const header = req.get('authorization') || '';
  const claims = verifyJwt(header.replace(/^Bearer\s+/i, ''));
  if (!claims) return null;
  return db.users.find((u) => u._id === claims.sub && u.status === 'active') ?? null;
}

const identify = (user) => ({
  sub: user._id, name: user.name, role: normaliseRole(user.role), email: user.email,
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
