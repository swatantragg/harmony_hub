import crypto from 'node:crypto';
import { GOOGLE_SIGNIN, JWT_SECRET } from '../config.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const SCOPES = ['openid', 'email', 'profile'];

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

export const STATE_TTL_SEC = 600;

export const configured = () => Boolean(GOOGLE_SIGNIN.clientId && GOOGLE_SIGNIN.clientSecret);

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
export function authorizeUrl({ state, loginHint = null }) {
  const params = new URLSearchParams({
    client_id: GOOGLE_SIGNIN.clientId,
    redirect_uri: GOOGLE_SIGNIN.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    access_type: 'online',
    prompt: 'select_account',
    include_granted_scopes: 'false',
  });
  if (GOOGLE_SIGNIN.hostedDomain) params.set('hd', GOOGLE_SIGNIN.hostedDomain);
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${params}`;
}
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
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    throw new GoogleSignInError('unreachable', `Google could not be reached: ${err.message}`);
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body.error === 'redirect_uri_mismatch'
      ? `Google rejected the callback address. Add ${GOOGLE_SIGNIN.redirectUri} to the OAuth client's authorised redirect URIs.`
      : `Google refused the sign-in (${body.error || res.status}).`;
    throw new GoogleSignInError(body.error === 'redirect_uri_mismatch' ? 'misconfigured' : 'refused', detail);
  }
  if (!body.id_token) throw new GoogleSignInError('refused', 'Google returned no identity token.');
  return body.id_token;
}
function claimsOf(idToken) {
  const payload = String(idToken).split('.')[1];
  if (!payload) throw new GoogleSignInError('refused', 'Google returned a malformed identity token.');
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleSignInError('refused', 'Google returned an unreadable identity token.');
  }
}
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