// Authentication + authorisation middleware chain (§9.3, §12.2).
import { db } from '../db.js';
import { verifyJwt } from '../util/crypto.js';
import { can } from '../catalogue.js';

export function problem(res, status, title, detail) {
  return res.status(status).type('application/problem+json').json({
    type: `https://gcloud.internal/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
  });
}

export function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const claims = verifyJwt(header.replace(/^Bearer\s+/i, ''));
  if (!claims) return problem(res, 401, 'Unauthorized', 'A valid access token is required.');
  const user = db.users.find((u) => u._id === claims.sub && u.status === 'active');
  if (!user) return problem(res, 401, 'Unauthorized', 'This account is no longer active.');
  req.user = { sub: user._id, name: user.name, role: user.role, email: user.email };
  next();
}

// Identifies the caller when a token is present, and lets them through when it is not.
// Used by the public share surface, where one URL serves an anonymous partner, a signed-in
// editor and a named recipient — and the share record decides which of the three is allowed.
export function optionalAuthenticate(req, _res, next) {
  const header = req.get('authorization') || '';
  const claims = verifyJwt(header.replace(/^Bearer\s+/i, ''));
  const user = claims && db.users.find((u) => u._id === claims.sub && u.status === 'active');
  req.user = user ? { sub: user._id, name: user.name, role: user.role, email: user.email } : null;
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
