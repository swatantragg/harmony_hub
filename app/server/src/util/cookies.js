import crypto from 'node:crypto';
const NAME = 'gcloud.rt';
const PATH = '/api/auth';

const STATE_NAME = 'gcloud.gsi';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export const readRefreshCookie = (req) => parseCookies(req.headers?.cookie)[NAME] ?? null;

export function setRefreshCookie(res, value, { maxAgeSec, secure }) {
  const attrs = [
    `${NAME}=${encodeURIComponent(value)}`,
    `Path=${PATH}`,
    `Max-Age=${Math.floor(maxAgeSec)}`,
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : null,
  ].filter(Boolean);
  append(res, attrs.join('; '));
}

export function clearRefreshCookie(res, { secure }) {
  append(res, [
    `${NAME}=`,
    `Path=${PATH}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; '));
}

export function setSignInStateCookie(res, value, { maxAgeSec, secure }) {
  append(res, [
    `${STATE_NAME}=${encodeURIComponent(value)}`,
    `Path=${PATH}`,
    `Max-Age=${Math.floor(maxAgeSec)}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; '));
}

export const readSignInStateCookie = (req) => parseCookies(req.headers?.cookie)[STATE_NAME] ?? null;

export function clearSignInStateCookie(res, { secure }) {
  append(res, [
    `${STATE_NAME}=`,
    `Path=${PATH}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; '));
}

// ── CSRF ────────────────────────────────────────────────────────────────────
// Deliberately *not* HttpOnly: the point of a double-submit token is that the
// page's own script can read it and echo it in a header, which a cross-site
// request cannot do. It carries no authority on its own — it is only ever
// compared against the copy the browser sends back.
const CSRF_NAME = 'gcloud.csrf';

export function issueCsrfCookie(res, { secure, maxAgeSec = 60 * 60 * 24 * 14 } = {}) {
  const value = crypto.randomBytes(24).toString('base64url');
  append(res, [
    `${CSRF_NAME}=${value}`,
    'Path=/',
    `Max-Age=${Math.floor(maxAgeSec)}`,
    'SameSite=Strict',
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; '));
  return value;
}

export const readCsrfCookie = (req) => parseCookies(req.headers?.cookie)[CSRF_NAME] ?? null;

export function clearCsrfCookie(res, { secure }) {
  append(res, [
    `${CSRF_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'SameSite=Strict',
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; '));
}

export const CSRF_COOKIE_NAME = CSRF_NAME;

function append(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', value);
  else res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, value] : [existing, value]);
}

export const COOKIE_NAME = NAME;
