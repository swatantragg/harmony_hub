// Cookie plumbing for exactly one cookie: the refresh token (§12.2).
//
// Hand-rolled rather than pulled from a package, because the whole requirement is one
// parse and one serialise, and a dependency that touches the session path is a
// dependency whose supply chain has to be watched forever.
//
// The attributes are the point of the file, so they are set in one place and explained:
//
//   HttpOnly    script cannot read it. This is what makes the refresh token survive an
//               XSS that would have walked off with a token kept in localStorage.
//   Secure      never sent over plaintext HTTP. Relaxed for localhost only, because
//               there is no TLS there and the alternative is that nobody can sign in.
//   SameSite    Strict. The refresh endpoint is the one state-changing route that is not
//               authorised by a bearer header, so it is the one route with any CSRF
//               surface at all — and Strict closes it.
//   Path        /api/auth. The cookie is not attached to any other request, so the byte
//               path and every catalogue call carry no session credential at all.

const NAME = 'gcloud.rt';
const PATH = '/api/auth';

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

// Several Set-Cookie headers can be in flight on one response (sign-in clears then sets),
// so they are accumulated rather than overwriting one another.
function append(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', value);
  else res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, value] : [existing, value]);
}

export const COOKIE_NAME = NAME;
