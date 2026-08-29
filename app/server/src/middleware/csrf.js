// Double-submit CSRF protection for the cookie-authenticated routes.
//
// Almost nothing here needs it. The API is a Bearer-token API: an access token
// lives in a JavaScript variable, and a cross-site form post cannot attach one.
// The exception is the handful of routes under /api/auth that are authorised by
// the refresh *cookie* — `/refresh`, `/otp/resume` — because a cookie is
// attached by the browser whether or not the request came from this
// application.
//
// SameSite=Strict already blocks those, and is the primary defence. This is the
// second layer: it survives a browser that does not enforce SameSite, a future
// relaxation of the cookie's attributes, and the class of bug where a redirect
// launders a request into looking same-site. The token carries no authority —
// it is a value the page can read and a cross-origin attacker cannot.

import { CSRF_ENABLED, NODE_ENV, ORIGIN } from '../config.js';
import { issueCsrfCookie, readCsrfCookie } from '../util/cookies.js';
import { safeEqual } from '../util/crypto.js';
import { problem } from './auth.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

const SECURE_COOKIES = NODE_ENV === 'production' || !/^http:\/\/(localhost|127\.0\.0\.1)/.test(ORIGIN);

/**
 * Hands the page a token on any safe request that does not already carry one.
 *
 * Without this the scheme cannot start: a browser arriving at the sign-in page
 * has no cookie to double-submit, so the very first POST would be refused and
 * nobody could ever sign in. Seeding on a GET is safe — the value is not a
 * credential and grants nothing on its own.
 */
export function seedCsrf(req, res, next) {
  if (CSRF_ENABLED && SAFE.has(req.method) && !readCsrfCookie(req)) {
    issueCsrfCookie(res, { secure: SECURE_COOKIES });
  }
  next();
}

export function requireCsrf(req, res, next) {
  if (!CSRF_ENABLED) return next();
  if (SAFE.has(req.method)) return next();

  // No exemption for requests carrying a Bearer token. It is tempting — script
  // had to run on this origin to attach one — but this guard is mounted only on
  // routes whose authority comes from the refresh *cookie*, where an access
  // token is beside the point. An exemption there would mean the guard is off
  // in exactly the case it is mounted for.
  const cookie = readCsrfCookie(req);
  const header = req.get('x-csrf-token');

  if (!cookie || !header) {
    return problem(
      res, 403, 'Forbidden',
      'This request is missing its cross-site request token. Reload the page and try again.',
      { csrf: true },
    );
  }
  if (!safeEqual(cookie, header)) {
    return problem(
      res, 403, 'Forbidden',
      'The cross-site request token does not match. Reload the page and try again.',
      { csrf: true },
    );
  }
  return next();
}
