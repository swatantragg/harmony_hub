import crypto from 'node:crypto';
import {
  FILE_TOKEN_GRACE_SEC, FILE_TOKEN_KEY_VERSION, FILE_TOKEN_SECRET,
  FILE_TOKEN_SECRET_PREVIOUS,
} from '../config.js';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

// ── Key versioning ──────────────────────────────────────────────────────────
//
// Rotating FILE_TOKEN_SECRET is the emergency stop for a leaked link: every URL
// in circulation dies at once. That is the right behaviour in an emergency and
// the wrong one for routine quarterly rotation, where it means every open
// preview and every in-flight download breaks the moment the task restarts.
//
// So a ticket carries the version of the key it was signed with. New tickets
// use the current key; tickets signed with the previous one keep verifying for
// FILE_TOKEN_GRACE_SEC after the rotation, then stop. Leave
// FILE_TOKEN_SECRET_PREVIOUS unset and the behaviour is the old one — immediate,
// total invalidation — which is what an emergency wants.

const KEYS = new Map([[FILE_TOKEN_KEY_VERSION, FILE_TOKEN_SECRET]]);
if (FILE_TOKEN_SECRET_PREVIOUS && FILE_TOKEN_KEY_VERSION > 1) {
  KEYS.set(FILE_TOKEN_KEY_VERSION - 1, FILE_TOKEN_SECRET_PREVIOUS);
}

const sign = (payload, secret = FILE_TOKEN_SECRET) =>
  crypto.createHmac('sha256', secret).update(payload).digest('base64url');

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
    k: FILE_TOKEN_KEY_VERSION,
    e: Math.floor(Date.now() / 1000) + Math.max(10, Math.floor(expiresIn)),
    j: crypto.randomBytes(6).toString('base64url'),
  };
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${sign(payload)}`;
}

export function verifyFileToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return { ok: false, reason: 'malformed' };

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // A token with no `k` predates versioning; it was signed with whatever
  // FILE_TOKEN_SECRET is now, which is the same assumption as before.
  const version = Number(claims.k ?? FILE_TOKEN_KEY_VERSION);
  const secret = KEYS.get(version);
  if (!secret) return { ok: false, reason: 'signature' };

  const expected = sign(payload, secret);
  if (
    signature.length !== expected.length
    || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return { ok: false, reason: 'signature' };
  }

  if (!claims.f) return { ok: false, reason: 'malformed' };

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > Number(claims.e)) return { ok: false, reason: 'expired' };

  // A previous-generation key stops being honoured once the grace window since
  // its own tokens' issue time has passed.
  if (version !== FILE_TOKEN_KEY_VERSION) {
    const issuedAt = Number(claims.e) - Math.max(10, Number(claims.e) - nowSec);
    if (nowSec - issuedAt > FILE_TOKEN_GRACE_SEC) return { ok: false, reason: 'rotated' };
  }

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
    keyVersion: version,
    expiresAt: new Date(Number(claims.e) * 1000).toISOString(),
  };
}
