// "Sign in with Google" — the authorization-code flow, hand-rolled (§12.1).
//
// Why the server-side code flow rather than the Google Identity Services button. That
// button is a third-party script on the sign-in page, and the sign-in page is the one
// screen where a script injection is a complete compromise. The content security policy
// in index.js allows scripts from this origin and nothing else, deliberately, and this
// flow keeps it that way: the browser is redirected to Google and comes back with a code,
// no external JavaScript is ever loaded, and the code is exchanged for an identity from
// this process over TLS.
//
// It is also the same shape as everything else here — the JWT layer, the Drive client and
// the share tokens are all written directly against the protocol rather than pulled from
// a package, for the same reason: this is the credential path, and a dependency on it is
// a supply chain to watch forever.
//
// ── What is trusted, and what is checked ─────────────────────────────────────
//
// The id_token arrives in the response body of a direct, server-to-server, TLS-pinned
// POST to accounts.google.com using a client secret only this process holds. That is what
// makes its signature redundant here: nobody else can put a token into that response.
// What still has to be checked is the *content* of it, because a token minted for a
// different application would otherwise be accepted:
//
//   iss             accounts.google.com — it really is Google's issuer
//   aud             this client id — it was minted for this application, not another
//   exp             not expired
//   email_verified  Google has actually verified the address, so it identifies a person
//   hd              the Workspace domain, when the deployment restricts sign-in to one
//
// An address that fails any of those is not an identity, and the caller is refused.
import crypto from 'node:crypto';
import { GOOGLE_SIGNIN, JWT_SECRET } from '../config.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// Only the two claims about who somebody is. No Drive scope is requested and none is
// wanted: this flow never touches the visitor's own Drive, and asking for access the
// application will not use is how a consent screen learns to be ignored.
const SCOPES = ['openid', 'email', 'profile'];

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// How long a half-finished sign-in stays valid. Long enough to pick an account and type a
// password, short enough that a state value found in a log is worthless.
export const STATE_TTL_SEC = 600;

export const configured = () => Boolean(GOOGLE_SIGNIN.clientId && GOOGLE_SIGNIN.clientSecret);

/* ── State ──────────────────────────────────────────────────────────────────
   The `state` parameter is what stops a third party completing a sign-in in somebody
   else's browser: it goes out with the redirect and has to come back unchanged. It is
   signed rather than stored, so a restart mid-flow does not strand anybody, and it is
   bound to a nonce that is also set as a cookie — the signature proves this server issued
   it, and the cookie proves it came back in the same browser it was issued to. */

const stateKey = () => crypto.createHmac('sha256', JWT_SECRET).update('google-signin-state-v1').digest();

export function mintState({ nonce, returnTo = '/' }) {
  const payload = Buffer.from(JSON.stringify({
    n: nonce,
    r: String(returnTo).slice(0, 200),
    e: Math.floor(Date.now() / 1000) + STATE_TTL_SEC,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', stateKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function readState(value) {
  const [payload, signature] = String(value || '').split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', stateKey()).update(payload).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (Math.floor(Date.now() / 1000) > Number(claims.e)) return null;
    return { nonce: String(claims.n || ''), returnTo: String(claims.r || '/') };
  } catch {
    return null;
  }
}

/* ── Step one: send the browser to Google ─────────────────────────────────── */

export function authorizeUrl({ state, loginHint = null }) {
  const params = new URLSearchParams({
    client_id: GOOGLE_SIGNIN.clientId,
    redirect_uri: GOOGLE_SIGNIN.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    // No refresh token is wanted. This flow establishes who somebody is once; the session
    // that follows is GCloud's own, and holding a long-lived Google grant for every
    // person who signs in would be keeping a credential with no use for it.
    access_type: 'online',
    // Always show the chooser. Without it, somebody signed into two Google accounts is
    // silently taken through as whichever one the browser happens to prefer — which is
    // exactly the confusion this screen exists to avoid when an address does not match
    // any account in the library.
    prompt: 'select_account',
    include_granted_scopes: 'false',
  });
  if (GOOGLE_SIGNIN.hostedDomain) params.set('hd', GOOGLE_SIGNIN.hostedDomain);
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${params}`;
}

/* ── Step two: turn the code into an identity ─────────────────────────────── */

export class GoogleSignInError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

async function exchange(code) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_SIGNIN.clientId,
      client_secret: GOOGLE_SIGNIN.clientSecret,
      redirect_uri: GOOGLE_SIGNIN.redirectUri,
      grant_type: 'authorization_code',
    }),
    // A sign-in that hangs is a sign-in screen that hangs. Google answers this in
    // milliseconds or not at all.
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    throw new GoogleSignInError('unreachable', `Google could not be reached: ${err.message}`);
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // `redirect_uri_mismatch` is the one that will actually happen, and it is a
    // configuration mistake rather than anything the visitor did — so it is named.
    const detail = body.error === 'redirect_uri_mismatch'
      ? `Google rejected the callback address. Add ${GOOGLE_SIGNIN.redirectUri} to the OAuth client's authorised redirect URIs.`
      : `Google refused the sign-in (${body.error || res.status}).`;
    throw new GoogleSignInError(body.error === 'redirect_uri_mismatch' ? 'misconfigured' : 'refused', detail);
  }
  if (!body.id_token) throw new GoogleSignInError('refused', 'Google returned no identity token.');
  return body.id_token;
}

// The payload of a JWS, read without verifying the signature — see the note at the top of
// the file for why that is the right call here and nowhere else in this codebase.
function claimsOf(idToken) {
  const payload = String(idToken).split('.')[1];
  if (!payload) throw new GoogleSignInError('refused', 'Google returned a malformed identity token.');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleSignInError('refused', 'Google returned an unreadable identity token.');
  }
}

/**
 * Completes the flow.
 *
 * @returns {Promise<{sub: string, email: string, name: string|null, picture: string|null, hostedDomain: string|null}>}
 * @throws  {GoogleSignInError} with a `reason` the callback turns into a message
 */
export async function identityFromCode(code) {
  const claims = claimsOf(await exchange(code));

  if (!ISSUERS.has(String(claims.iss))) {
    throw new GoogleSignInError('refused', 'That identity did not come from Google.');
  }
  if (claims.aud !== GOOGLE_SIGNIN.clientId) {
    throw new GoogleSignInError('refused', 'That identity was issued for a different application.');
  }
  if (Number(claims.exp || 0) * 1000 < Date.now()) {
    throw new GoogleSignInError('expired', 'That sign-in took too long. Try again.');
  }
  // An unverified address is a claim, not an identity: anybody can put one on a Google
  // account. Matching it against a GCloud account would be handing over somebody else's
  // library on the strength of a form field.
  if (claims.email_verified !== true && claims.email_verified !== 'true') {
    throw new GoogleSignInError('unverified', 'Google has not verified that address, so it cannot be used to sign in.');
  }
  if (GOOGLE_SIGNIN.hostedDomain && claims.hd !== GOOGLE_SIGNIN.hostedDomain) {
    throw new GoogleSignInError('domain', `Only ${GOOGLE_SIGNIN.hostedDomain} accounts can sign in here.`);
  }

  const email = String(claims.email || '').trim().toLowerCase();
  if (!email) throw new GoogleSignInError('refused', 'Google returned no address.');

  return {
    sub: String(claims.sub),
    email,
    name: claims.name ? String(claims.name).slice(0, 120) : null,
    picture: claims.picture ? String(claims.picture).slice(0, 400) : null,
    hostedDomain: claims.hd ? String(claims.hd) : null,
  };
}
