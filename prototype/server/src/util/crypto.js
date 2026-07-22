// Signing + password primitives. Stand-ins for jsonwebtoken/bcrypt with zero dependencies.
import crypto from 'node:crypto';
import { JWT_SECRET } from '../config.js';

export const uuid = () => crypto.randomUUID();
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

// ── JWT (HS256) ────────────────────────────────────────────────────────────
export function signJwt(payload, ttlSec) {
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ ...payload, iat: now, exp: now + ttlSec });
  const sig = hmac(JWT_SECRET, `${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(jwt) {
  if (!jwt) return null;
  const [header, body, sig] = String(jwt).split('.');
  if (!header || !body || !sig) return null;
  if (hmac(JWT_SECRET, `${header}.${body}`) !== sig) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── Password hashing (scrypt, the stdlib analogue of bcrypt cost 12) ────────
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(plain, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}
