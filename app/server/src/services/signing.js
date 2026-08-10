// Short-lived file tokens — how a browser is authorised to fetch one file (§12.3).
//
// Google Drive offers no way to hand an anonymous browser a self-authorising, expiring
// link to a file held under a server credential. `webContentLink` only works for a browser
// already signed in as someone with access, and the only way to make a link work for a
// visitor with no Google account is to grant `anyone: reader` on the file — which is
// permanent public exposure, not a five-minute grant, and stays granted until somebody
// remembers to take it away.
//
// So a token here is a *ticket*: an HMAC-signed, expiring, single-purpose grant to one
// file, redeemed at GET /api/files/:token, which streams the bytes from Drive. What that
// buys:
//
//   · The link is short-lived, with a lifetime set per purpose — five minutes to
//     download, an hour to preview.
//   · It names no credential, no folder and no Drive file id — the id is inside the
//     signed payload, not in the URL a person can read off their screen.
//   · It cannot be edited: any change to the payload invalidates the signature.
//   · It is bound to a purpose, so a preview ticket cannot be replayed as a download.
//   · Rotating FILE_TOKEN_SECRET invalidates every outstanding link at once.
//   · The file's Drive sharing settings are never touched, so revocation is real.
//
// The cost: bytes pass through this process on the way out. They are streamed, never
// buffered, and Range is forwarded — but principle P2 ("the API cannot carry a file byte")
// holds for uploads only. That is stated plainly rather than quietly dropped.
import crypto from 'node:crypto';
import { FILE_TOKEN_SECRET } from '../config.js';

const b64 = (buf) => Buffer.from(buf).toString('base64url');

const sign = (payload) =>
  crypto.createHmac('sha256', FILE_TOKEN_SECRET).update(payload).digest('base64url');

/**
 * Mint a ticket for exactly one file, one purpose, one window.
 *
 * @param {object}  grant
 * @param {string}  grant.fileId       the Drive file id
 * @param {string}  grant.filename     what the browser should call the download
 * @param {boolean} grant.inline       inline (preview) or attachment (download)
 * @param {number}  grant.expiresIn    seconds
 * @param {string}  grant.purpose      'download' | 'preview' | 'share' | 'thumbnail'
 * @param {string}  [grant.assetId]    for the audit trail
 * @param {string}  [grant.exportMime] set for Google Docs/Sheets/Slides, which must be
 *                                     converted on the way out because they have no bytes
 */
export function mintFileToken({ fileId, filename, inline = false, expiresIn = 300, purpose = 'download', assetId = null, exportMime = null }) {
  const claims = {
    f: fileId,
    n: filename || null,
    i: inline ? 1 : 0,
    p: purpose,
    a: assetId,
    x: exportMime,
    e: Math.floor(Date.now() / 1000) + Math.max(10, Math.floor(expiresIn)),
    // Makes two tickets for the same file in the same second distinguishable in the log.
    j: crypto.randomBytes(6).toString('base64url'),
  };
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${sign(payload)}`;
}

export function verifyFileToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return { ok: false, reason: 'malformed' };

  const expected = sign(payload);
  // Constant-time, and length-checked first because timingSafeEqual throws on a mismatch.
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
    expiresAt: new Date(Number(claims.e) * 1000).toISOString(),
  };
}
