// Presigned URLs — short-lived, HMAC-signed, and the ONLY way bytes move (§12.3, P5).
// Mirrors @aws-sdk/s3-request-presigner: the API signs, the browser talks to storage directly.
import { ORIGIN, SIGNING_KEY } from '../config.js';
import { hmac } from '../util/crypto.js';

function canonical({ op, bucket, key, expires, extra }) {
  const parts = Object.entries(extra || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${op}\n${bucket}\n${key}\n${expires}\n${parts}`;
}

export function presign({ op, bucket, key, expiresIn, extra = {} }) {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const signature = hmac(SIGNING_KEY, canonical({ op, bucket, key, expires, extra }));
  const qs = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-Date': new Date().toISOString(),
    'X-Amz-Op': op,
    'X-Amz-SignedExpires': String(expires),
    'X-Amz-Signature': signature,
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  return `${ORIGIN}/s3/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}?${qs}`;
}

export function verifySignature(req, bucket, key) {
  const q = req.query;
  const op = q['X-Amz-Op'];
  const expires = Number(q['X-Amz-SignedExpires'] || 0);
  const signature = q['X-Amz-Signature'];
  if (!op || !signature || !expires) return { ok: false, reason: 'AccessDenied: request is not signed' };
  if (expires * 1000 < Date.now()) return { ok: false, reason: 'AccessDenied: signature has expired' };

  const extra = {};
  for (const [k, v] of Object.entries(q)) {
    if (!k.startsWith('X-Amz-')) extra[k] = v;
  }
  const expected = hmac(SIGNING_KEY, canonical({ op, bucket, key, expires, extra }));
  if (expected !== signature) return { ok: false, reason: 'SignatureDoesNotMatch' };
  return { ok: true, op, extra };
}
