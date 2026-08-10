// Signing and password primitives (§12.1).
//
// bcrypt at cost 12 for passwords, HS256 JWTs signed with a secret that comes from the
// environment — and, in a deployed architecture, from a secrets manager.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ACCESS_TTL_SEC, BCRYPT_ROUNDS, JWT_SECRET } from '../config.js';

export const uuid = () => crypto.randomUUID();
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

export function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

// ── JWT (HS256) ─────────────────────────────────────────────────────────────
// The token carries `sub`, `role` and a display name only. Permissions are never carried
// in a token — they are resolved server-side from the role on every request (§12.1).

export function signJwt(payload, ttlSec = ACCESS_TTL_SEC) {
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ttlSec,
    issuer: 'harmony-hub',
  });
}

export function verifyJwt(value) {
  if (!value) return null;
  try {
    return jwt.verify(String(value), JWT_SECRET, { algorithms: ['HS256'], issuer: 'harmony-hub' });
  } catch {
    return null;
  }
}

// ── Passwords (bcrypt, cost 12) ─────────────────────────────────────────────
// Async on purpose: a cost-12 hash is ~250 ms of CPU, and doing that synchronously would
// stall every other request in the process for the duration of one sign-in.

export function hashPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, stored) {
  if (!stored) return false;
  try {
    return await bcrypt.compare(String(plain), String(stored));
  } catch {
    return false;
  }
}
