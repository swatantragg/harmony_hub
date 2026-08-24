import crypto from 'node:crypto';
import { FILE_TOKEN_SECRET } from '../config.js';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

const sign = (payload) =>
  crypto.createHmac('sha256', FILE_TOKEN_SECRET).update(payload).digest('base64url');

export function mintFileToken({
  fileId, filename, inline = false, expiresIn = 300, purpose = 'download',
  assetId = null, exportMime = null, userId = null, tokenVersion = null, shareId = null,
}) {
  const claims = {
    f: fileId,
    n: filename || null,
    i: inline ? 1 : 0,
    p: purpose,
    a: assetId,
    x: exportMime,
    u: userId,
    tv: tokenVersion,
    s: shareId,
    e: Math.floor(Date.now() / 1000) + Math.max(10, Math.floor(expiresIn)),
    j: crypto.randomBytes(6).toString('base64url'),
  };
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${sign(payload)}`;
}
export function verifyFileToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return { ok: false, reason: 'malformed' };
  const expected = sign(payload);
  if (
    signature.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return { ok: false, reason: 'signature' };
  }
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!claims.f) return { ok: false, reason: 'malformed' };
  if (Math.floor(Date.now() / 1000) > Number(claims.e)) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    fileId: claims.f,
    filename: claims.n,
    inline: claims.i === 1,
    purpose: claims.p,
    assetId: claims.a ?? null,
    exportMime: claims.x ?? null,
    userId: claims.u ?? null,
    tokenVersion: claims.tv ?? null,
    shareId: claims.s ?? null,
    ticketId: claims.j ?? null,
    expiresAt: new Date(Number(claims.e) * 1000).toISOString(),
  };
}