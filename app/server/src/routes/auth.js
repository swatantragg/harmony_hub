import express from 'express';
import { db, persist } from '../db.js';
import { signJwt, verifyPassword, hashPassword } from '../util/crypto.js';
import { ACCESS_TTL_SEC, MIN_PASSWORD_LENGTH } from '../config.js';
import { PERMISSIONS, normaliseRole } from '../catalogue.js';
import { authenticate, authenticatePending, problem } from '../middleware/auth.js';
import { record } from '../services/audit.js';

export const authRouter = express.Router();

// A valid-looking bcrypt digest of a value nobody holds, used to equalise the cost of a
// failed sign-in against an unknown email.
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO3Zm/9dOtaGZkVpq7Zt.Fx9pHkoJn0Mm';

const publicUser = (u) => ({
  _id: u._id, name: u.name, email: u.email, role: normaliseRole(u.role),
  status: u.status, lastLoginAt: u.lastLoginAt,
  // The client routes to the set-a-password screen on this flag alone, and every other
  // route stays closed until it clears.
  mustChangePassword: Boolean(u.mustChangePassword),
  permissions: PERMISSIONS[normaliseRole(u.role)],
});

// What a password has to be before it is accepted. Deliberately one rule rather than a
// character-class matrix: length is the only requirement that reliably buys entropy, and
// every extra rule pushes people towards a predictable pattern.
export function passwordProblem(value) {
  const password = String(value ?? '');
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return 'That password is too long.';
  return null;
}

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find((u) => u.email.toLowerCase() === String(email || '').trim().toLowerCase());
  // The bcrypt comparison runs even when no such account exists, so a wrong email and a
  // wrong password take the same time to be refused.
  const ok = await verifyPassword(String(password || ''), user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    return problem(res, 401, 'Unauthorized', 'That email and password combination is not recognised.');
  }
  if (user.status !== 'active') return problem(res, 403, 'Forbidden', 'This account has been suspended.');

  user.lastLoginAt = new Date().toISOString();
  persist();
  const accessToken = signJwt({ sub: user._id, role: normaliseRole(user.role), name: user.name }, ACCESS_TTL_SEC);
  record({ ...req, user: { sub: user._id, name: user.name, role: normaliseRole(user.role) } }, {
    action: 'AUTH_LOGIN', entity: 'user', entityId: user._id, label: `${user.name} signed in`,
  });
  res.json({ accessToken, expiresIn: ACCESS_TTL_SEC, user: publicUser(user) });
});

// Set a password on an account that still holds the one an administrator handed over.
//
// This is the only write in the product that a half-authenticated caller may make: the
// token is real and the account is real, but `mustChangePassword` is still set, so
// requireCurrentPassword() below lets the first change through on the starting password
// alone. Every later change asks for the current one.
authRouter.post('/password', authenticatePending, async (req, res) => {
  const user = db.users.find((u) => u._id === req.user.sub);
  if (!user) return problem(res, 401, 'Unauthorized', 'This account no longer exists.');

  const { currentPassword, newPassword } = req.body || {};

  const ok = await verifyPassword(String(currentPassword || ''), user.passwordHash);
  if (!ok) {
    return problem(res, 401, 'Unauthorized', 'That is not the current password for this account.');
  }

  const invalid = passwordProblem(newPassword);
  if (invalid) return problem(res, 422, 'Unprocessable Entity', invalid);

  if (await verifyPassword(String(newPassword), user.passwordHash)) {
    return problem(res, 422, 'Unprocessable Entity', 'The new password has to differ from the current one.');
  }

  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date().toISOString();
  persist();

  record(req, {
    action: 'AUTH_PASSWORD_CHANGE', entity: 'user', entityId: user._id,
    label: `${user.name} set a new password`,
  });

  // A fresh token, so a session that was issued before the change keeps working without a
  // second sign-in round trip.
  const accessToken = signJwt({ sub: user._id, role: normaliseRole(user.role), name: user.name }, ACCESS_TTL_SEC);
  res.json({ accessToken, expiresIn: ACCESS_TTL_SEC, user: publicUser(user) });
});

authRouter.post('/logout', authenticate, (req, res) => {
  record(req, { action: 'AUTH_LOGOUT', entity: 'user', entityId: req.user.sub, label: `${req.user.name} signed out` });
  res.json({ ok: true });
});

export const meRouter = express.Router();
meRouter.get('/', authenticatePending, (req, res) => {
  const user = db.users.find((u) => u._id === req.user.sub);
  res.json(publicUser(user));
});
