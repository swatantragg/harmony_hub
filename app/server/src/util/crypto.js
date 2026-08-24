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

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  const ha = crypto.createHash('sha256').update(left).digest();
  const hb = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(ha, hb);
}


export function signJwt(payload, ttlSec = ACCESS_TTL_SEC) {
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ttlSec,
    issuer: 'gcloud',
    audience: 'gcloud-api',
    jwtid: crypto.randomBytes(9).toString('base64url'),
  });
}

export function verifyJwt(value) {
  if (!value) return null;
  try {
    return jwt.verify(String(value), JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'gcloud',
      audience: 'gcloud-api',
    });
  } catch {
    return null;
  }
}


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
