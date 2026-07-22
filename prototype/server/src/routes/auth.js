import express from 'express';
import { db, persist } from '../db.js';
import { signJwt, verifyPassword } from '../util/crypto.js';
import { ACCESS_TTL_SEC } from '../config.js';
import { PERMISSIONS } from '../catalogue.js';
import { authenticate, problem } from '../middleware/auth.js';
import { record } from '../services/audit.js';

export const authRouter = express.Router();

const publicUser = (u) => ({
  _id: u._id, name: u.name, email: u.email, role: u.role, jobTitle: u.jobTitle,
  status: u.status, lastLoginAt: u.lastLoginAt,
  permissions: PERMISSIONS[u.role] || [],
});

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !verifyPassword(String(password || ''), user.passwordHash)) {
    return problem(res, 401, 'Unauthorized', 'That email and password combination is not recognised.');
  }
  if (user.status !== 'active') return problem(res, 403, 'Forbidden', 'This account has been suspended.');

  user.lastLoginAt = new Date().toISOString();
  persist();
  const accessToken = signJwt({ sub: user._id, role: user.role, name: user.name }, ACCESS_TTL_SEC);
  record({ ...req, user: { sub: user._id, name: user.name, role: user.role } }, {
    action: 'AUTH_LOGIN', entity: 'user', entityId: user._id, label: `${user.name} signed in`,
  });
  res.json({ accessToken, expiresIn: ACCESS_TTL_SEC, user: publicUser(user) });
});

// Demo accounts, surfaced on the sign-in screen so a first-time user is one click away
// from seeing each role's view of the product.
authRouter.get('/demo-accounts', (_req, res) => {
  res.json(
    db.users.map((u) => ({
      email: u.email, password: 'maestro', name: u.name, role: u.role, jobTitle: u.jobTitle,
      permissions: (PERMISSIONS[u.role] || []).length,
    })),
  );
});

authRouter.post('/logout', authenticate, (req, res) => {
  record(req, { action: 'AUTH_LOGOUT', entity: 'user', entityId: req.user.sub, label: `${req.user.name} signed out` });
  res.json({ ok: true });
});

export const meRouter = express.Router();
meRouter.get('/', authenticate, (req, res) => {
  const user = db.users.find((u) => u._id === req.user.sub);
  res.json(publicUser(user));
});
