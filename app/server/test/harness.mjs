// Boots the real server against a scratch database and drives it over HTTP.
//
// Deliberately not an in-process app import with mocked middleware. Every
// finding these tests exist to catch was a *wiring* bug — a limiter mounted
// before the thing that populates its key, a CSRF guard on a route that cannot
// have a token yet, a notification filter applied in one handler and not the
// next. Mounting the app by hand reproduces the wiring you meant, not the
// wiring you shipped. So: real process, real middleware order, real fetch.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../src/index.js');

const TEST_MONGO = process.env.TEST_MONGODB_URI
  || 'mongodb://gcloud:gcloud@127.0.0.1:27017/?authSource=admin';

export const ADMIN = {
  email: 'harness-admin@example.test',
  password: 'harness-Admin-Passw0rd!',
  name: 'Harness Admin',
};

// Exported so a test that needs to mint a token the server will accept can use
// the real key instead of repeating a literal — which is how the old hardcoded
// secret ended up in two files, and how a scanner found it in both.
export const SIGNING_KEY = randomBytes(32).toString('hex');
export const FILE_KEY = randomBytes(32).toString('hex');

let child = null;
let base = null;

export async function start({ env = {}, port = 8300 + Math.floor(Math.random() * 400) } = {}) {
  const dbName = `gcloudtest_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;

  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      APP_ORIGIN: `http://localhost:${port}`,
      CORS_ORIGINS: `http://localhost:${port}`,
      MONGODB_URI: TEST_MONGO,
      MONGODB_DB: dbName,
      // Minted per run rather than written down. A literal here is a
      // high-entropy string in a tracked file, which is indistinguishable from
      // a real leaked key to every scanner that looks — and it made the
      // credential-scanning job fail on every push. Generating them also means
      // no two runs share signing material.
      JWT_SECRET: SIGNING_KEY,
      FILE_TOKEN_SECRET: FILE_KEY,
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_NAME: ADMIN.name,
      ADMIN_PASSWORD: ADMIN.password,
      SEED_PASSWORD: 'harness-Seed-Passw0rd!',
      MIN_PASSWORD_LENGTH: '8',
      SEED_ON_BOOT: 'false',
      RECONCILE_ENABLED: 'false',
      // The Drive mirror runs on a timer and behind library reads. Drive is
      // unreachable here so every pass is a no-op, but a background timer doing
      // nothing useful during a test run is a flake waiting to happen.
      DRIVE_SYNC_ENABLED: 'false',
      PASSWORD_BREACH_CHECK: 'false',
      RATE_LIMIT_STORE: 'memory',
      // A suite deliberately fails sign-ins dozens of times. With production
      // thresholds it locks the account out halfway through and every later
      // case fails for the wrong reason. The limiters and the lockout get their
      // own file, which starts a server with real thresholds and tests them
      // directly — see limits.test.mjs.
      RATE_LIMIT_AUTH_MAX: '100000',
      RATE_LIMIT_AUTH_IP_MAX: '100000',
      RATE_LIMIT_MAX: '100000',
      LOGIN_MAX_FAILURES: '100000',
      RESET_MAX_PER_HOUR: '100000',
      OTP_RESEND_COOLDOWN_SEC: '0',
      OTP_ENABLED: 'true',
      // No Brevo key: the code comes back in the response body, which is the
      // documented development behaviour and the only way to test the flow
      // without a mail account.
      BREVO_API_KEY: '',
      LOG_LEVEL: 'error',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  base = `http://127.0.0.1:${port}`;
  const dbNameUsed = dbName;

  const ready = new Promise((resolve, reject) => {
    let out = '';
    const onData = (chunk) => {
      out += chunk.toString();
      if (/G C L O U D/.test(out)) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited early (${code})\n${out.slice(-4000)}`)));
    setTimeout(() => reject(new Error(`server did not start in time\n${out.slice(-4000)}`)), 60_000);
  });

  await ready;
  return { base, dbName: dbNameUsed };
}

export async function stop() {
  if (!child) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((r) => { setTimeout(r, 5000); })]);
  child.kill('SIGKILL');
  child = null;
}

// ── A tiny client that keeps cookies, like a browser does ────────────────────

export function client() {
  const jar = new Map();
  let accessToken = null;

  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  const absorb = (res) => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /Max-Age=0/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
    }
  };

  async function send(pathname, { method = 'GET', body, headers = {}, token = accessToken } = {}) {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(jar.has('gcloud.csrf') ? { 'x-csrf-token': jar.get('gcloud.csrf') } : {}),
        ...(jar.size ? { cookie: cookieHeader() } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    absorb(res);
    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    return { status: res.status, body: payload, headers: res.headers };
  }

  return {
    send,
    jar,
    get token() { return accessToken; },
    set token(t) { accessToken = t; },
    /** Password, then today's passcode — the whole front door in one call. */
    async signIn({ email = ADMIN.email, password = ADMIN.password } = {}) {
      await send('/api/auth/providers');
      const first = await send('/api/auth/login', { method: 'POST', body: { email, password } });
      if (first.status !== 202) return first;

      const second = await send('/api/auth/otp', {
        method: 'POST',
        body: { otpToken: first.body.otpToken, code: first.body.devCode },
      });
      if (second.status === 200) accessToken = second.body.accessToken;
      return second;
    },
  };
}
