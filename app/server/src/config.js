import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

for (const file of [path.join(ROOT, '.env'), path.resolve(ROOT, '../.env')]) {
  if (fs.existsSync(file)) dotenv.config({ path: file });
}

const bool = (fallback) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v)));

const int = (fallback, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().min(min));

const blankIsUnset = (schema) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v.trim() === '' ? undefined : v.trim()))
    .pipe(schema);

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.string().default('dev'),
  PORT: int(8100, 1),

  PUBLIC_ORIGIN: blankIsUnset(z.string().url().optional()),
  APP_ORIGIN: blankIsUnset(z.string().url().optional()),
  CORS_ORIGINS: blankIsUnset(z.string().optional()),

  TRUST_PROXY: z.string().default('loopback'),

  JWT_SECRET: blankIsUnset(z.string().min(16, 'JWT_SECRET must be at least 16 characters')),
  ACCESS_TTL_SEC: int(15 * 60, 60),
  REFRESH_TTL_SEC: int(60 * 60 * 24 * 14, 300),
  SESSION_MAX_SEC: int(60 * 60 * 24 * 30, 3600),
  SESSION_IDLE_SEC: int(60 * 60 * 12, 300),
  BCRYPT_ROUNDS: int(12, 4),
  FILE_TOKEN_SECRET: blankIsUnset(z.string().min(16).optional()),

  MONGODB_URI: blankIsUnset(z.string().min(1, 'MONGODB_URI is required')),
  MONGODB_DB: z.string().default('gcloud'),

  GOOGLE_AUTH_MODE: z.enum(['oauth', 'service_account']).default('oauth'),

  GOOGLE_CLIENT_ID: blankIsUnset(z.string().optional()),
  GOOGLE_CLIENT_SECRET: blankIsUnset(z.string().optional()),
  GOOGLE_REFRESH_TOKEN: blankIsUnset(z.string().optional()),

  GOOGLE_SIGNIN_ENABLED: bool(true),
  GOOGLE_SIGNIN_CLIENT_ID: blankIsUnset(z.string().optional()),
  GOOGLE_SIGNIN_CLIENT_SECRET: blankIsUnset(z.string().optional()),
  GOOGLE_SIGNIN_REDIRECT_URI: blankIsUnset(z.string().url().optional()),
  GOOGLE_SIGNIN_HOSTED_DOMAIN: blankIsUnset(z.string().optional()),

  GOOGLE_SERVICE_ACCOUNT_EMAIL: blankIsUnset(z.string().optional()),
  GOOGLE_PRIVATE_KEY: blankIsUnset(z.string().optional()),
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: blankIsUnset(z.string().optional()),
  GOOGLE_IMPERSONATE_SUBJECT: blankIsUnset(z.string().optional()),

  DRIVE_ID: blankIsUnset(z.string().optional()),
  DRIVE_ROOT_FOLDER_ID: blankIsUnset(z.string().optional()),
  DRIVE_ROOT_FOLDER_NAME: z.string().default('GCloud'),

  DRIVE_CHUNK_MB: int(8, 1),
  DRIVE_LIST_PAGE_SIZE: int(1000, 100),
  HEAD_CONCURRENCY: int(12, 1),
  VERIFY_BATCH_MAX: int(500, 1),
  DRIVE_TRASH_DAYS: int(30, 1),

  TTL_DOWNLOAD: int(5 * 60, 30),
  TTL_PREVIEW: int(60 * 60, 30),
  TTL_UPLOAD_PART: int(60 * 60, 60),
  TTL_SHARE: int(60 * 60, 60),

  DEDUPE_SIZE_TOLERANCE: z.string().optional().transform((v) => (v == null || v === '' ? 0.02 : Number(v))).pipe(z.number().min(0).max(0.5)),
  DEDUPE_DURATION_TOLERANCE_SEC: int(2, 0),
  DEDUPE_NAME_SIMILARITY: z.string().optional().transform((v) => (v == null || v === '' ? 0.7 : Number(v))).pipe(z.number().min(0).max(1)),
  DEDUPE_PERCEPTUAL: bool(false),
  DEDUPE_PERCEPTUAL_FRAMES: int(8, 2),
  DEDUPE_PERCEPTUAL_MAX_DISTANCE: int(10, 0),

  RECONCILE_CRON: z.string().default('0 2 * * *'),
  RECONCILE_ENABLED: bool(true),

  SEED_ON_BOOT: bool(true),
  SEED_PASSWORD: z.string().min(8).default('changeme123'),

  ADMIN_EMAIL: z.string().default('swatantra.goongoonalo@gmail.com'),
  ADMIN_NAME: z.string().default('Swatantra Goongoonalo'),
  ADMIN_PASSWORD: z.string().min(8).default('12345678'),

  MIN_PASSWORD_LENGTH: int(12, 8),
  PASSWORD_BREACH_CHECK: bool(false),
  PASSWORD_HISTORY_DEPTH: int(3, 0),
  PASSWORD_MAX_AGE_DAYS: int(0, 0),

  // ── Daily one-time passcode ───────────────────────────────────────────────
  // One OTP per calendar day, in OTP_TIMEZONE. Sessions carry the day they were
  // stamped with; at local midnight every one of them stops answering and the
  // holder re-verifies once. See services/otp.js.
  OTP_ENABLED: bool(true),
  OTP_TIMEZONE: z.string().default('Asia/Kolkata'),
  OTP_LENGTH: int(6, 4),
  OTP_TTL_SEC: int(10 * 60, 60),
  OTP_MAX_ATTEMPTS: int(5, 1),
  OTP_RESEND_COOLDOWN_SEC: int(45, 0),
  OTP_TICKET_TTL_SEC: int(15 * 60, 120),

  BREVO_API_KEY: blankIsUnset(z.string().optional()),
  BREVO_SENDER_EMAIL: blankIsUnset(z.string().email().optional()),
  BREVO_SENDER_NAME: z.string().default('GCloud'),
  BREVO_REPLY_TO: blankIsUnset(z.string().email().optional()),
  MAIL_TIMEOUT_MS: int(10_000, 1000),

  RATE_LIMIT_WINDOW_SEC: int(60, 1),
  RATE_LIMIT_MAX: int(600, 1),
  RATE_LIMIT_HEAVY_MAX: int(60, 1),
  RATE_LIMIT_AUTH_WINDOW_SEC: int(900, 30),
  RATE_LIMIT_AUTH_MAX: int(10, 1),
  RATE_LIMIT_AUTH_IP_MAX: int(40, 1),
  LOGIN_MAX_FAILURES: int(8, 3),
  LOGIN_LOCKOUT_SEC: int(900, 60),
  RATE_LIMIT_FILES_MAX: int(600, 10),
  // Shared counters. Off means per-process counters, which silently stop
  // limiting anything the moment a second task is started.
  RATE_LIMIT_STORE: z.enum(['memory', 'mongo']).default('mongo'),

  SHARE_PASSCODE_MIN_LENGTH: int(8, 4),
  SHARE_PASSCODE_WINDOW_SEC: int(900, 60),
  SHARE_PASSCODE_MAX_ATTEMPTS: int(10, 1),
  SHARE_PASSCODE_FREEZE_AT: int(20, 2),

  RESET_MAX_PER_HOUR: int(3, 1),

  CSRF_ENABLED: bool(true),
  LOGIN_ANOMALY_NOTIFY: bool(true),

  ALERT_WEBHOOK_URL: blankIsUnset(z.string().url().optional()),
  LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),

  // ── Keeping a free-tier host awake ────────────────────────────────────────
  // Blank means "on when running on Render, off everywhere else" — Render sets
  // RENDER=true and RENDER_EXTERNAL_URL for us, so the common case needs no
  // configuration at all. See services/keepalive.js for what this can and
  // cannot do.
  KEEPALIVE_ENABLED: z.string().optional(),
  KEEPALIVE_URL: blankIsUnset(z.string().url().optional()),
  KEEPALIVE_INTERVAL_MIN: int(10, 1),
  KEEPALIVE_TIMEOUT_MS: int(20_000, 1000),
  KEEPALIVE_ALLOW_LOCAL: bool(false),

  // Set by Render itself. Read, never written by hand.
  RENDER: z.string().optional(),
  RENDER_EXTERNAL_URL: blankIsUnset(z.string().url().optional()),

  UPLOAD_MAX_BYTES: int(25 * 1024 ** 3, 1024),
  UPLOAD_DAILY_BYTES: int(50 * 1024 ** 3, 1024),

  CLAMAV_ENABLED: bool(false),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: int(3310, 1),
  CLAMAV_TIMEOUT_MS: int(120_000, 1000),
  CLAMAV_MAX_BYTES: int(200 * 1024 ** 2, 1024),
  CLAMAV_FAIL_CLOSED: bool(true),

  ALLOW_DESTRUCTIVE_DEMO: bool(false),
  ALLOW_EMPTY_DRIVE_TRASH: bool(false),
  STEP_UP_MAX_AGE_SEC: int(300, 60),

  AUDIT_RETENTION_DAYS: int(400, 30),

  CLIENT_DIST: blankIsUnset(z.string().optional()),

  // Bumped when JWT_SECRET / FILE_TOKEN_SECRET are rotated. Tickets carry the
  // version they were minted under, and the previous one keeps verifying for
  // FILE_TOKEN_GRACE_SEC so a rotation does not kill every live download.
  FILE_TOKEN_KEY_VERSION: int(1, 1),
  FILE_TOKEN_SECRET_PREVIOUS: blankIsUnset(z.string().min(16).optional()),
  FILE_TOKEN_GRACE_SEC: int(24 * 60 * 60, 0),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  · ${i.path.join('.')}: ${i.message}`);
  console.error(`\nGCloud cannot start — the environment is incomplete:\n${lines.join('\n')}\n`);
  console.error('Copy app/.env.example to app/.env and fill it in.\n');
  process.exit(1);
}

export const env = parsed.data;

export const NODE_ENV = env.NODE_ENV;
export const ENV = env.APP_ENV;
export const PORT = env.PORT;

export const ORIGIN = env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
export const APP_ORIGIN = env.APP_ORIGIN || ORIGIN;

export const CORS_ORIGINS = (env.CORS_ORIGINS || `${ORIGIN},${APP_ORIGIN}`)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const TRUST_PROXY = (() => {
  const raw = env.TRUST_PROXY.trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  return raw.includes(',') ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
})();

export const JWT_SECRET = env.JWT_SECRET;
export const FILE_TOKEN_SECRET = env.FILE_TOKEN_SECRET || env.JWT_SECRET;
export const ACCESS_TTL_SEC = env.ACCESS_TTL_SEC;
export const REFRESH_TTL_SEC = env.REFRESH_TTL_SEC;
export const SESSION_MAX_SEC = env.SESSION_MAX_SEC;
export const SESSION_IDLE_SEC = env.SESSION_IDLE_SEC;
export const BCRYPT_ROUNDS = env.BCRYPT_ROUNDS;

const PLACEHOLDER_SECRETS = [
  'local-dev-only-change-me-0123456789abcdef',
  'changeme', 'change-me', 'secret', 'password', 'please-change-me',
  'dev-secret', 'test-secret', 'your-secret-here', 'supersecret',
];

const WEAK_PASSWORDS = ['12345678', 'changeme123', 'password', 'admin123', 'harmonyhub', 'password123'];

const looksPlaceholder = (value) => {
  const v = String(value || '').toLowerCase();
  return PLACEHOLDER_SECRETS.some((p) => v === p || v.includes(p));
};

function assertSecrets() {
  const fatal = [];
  const warn = [];
  const production = env.NODE_ENV === 'production';

  if (looksPlaceholder(JWT_SECRET)) {
    fatal.push('JWT_SECRET is a placeholder value. Anyone who has seen this repository can forge an administrator session. Generate one: openssl rand -base64 48');
  }
  if (production && JWT_SECRET.length < 32) {
    fatal.push('JWT_SECRET must be at least 32 characters in production.');
  }
  if (env.FILE_TOKEN_SECRET && looksPlaceholder(env.FILE_TOKEN_SECRET)) {
    fatal.push('FILE_TOKEN_SECRET is a placeholder value.');
  }
  if (!env.FILE_TOKEN_SECRET) {
    warn.push('FILE_TOKEN_SECRET is unset, so file tickets are signed with JWT_SECRET. Rotating either one will then revoke both.');
  }
  if (production && WEAK_PASSWORDS.includes(String(env.ADMIN_PASSWORD))) {
    fatal.push('ADMIN_PASSWORD is a well-known default. Set a real one before running in production.');
  }
  if (production && WEAK_PASSWORDS.includes(String(env.SEED_PASSWORD))) {
    fatal.push('SEED_PASSWORD is a well-known default. Set a real one before running in production.');
  }
  if (production && env.ALLOW_DESTRUCTIVE_DEMO) {
    fatal.push('ALLOW_DESTRUCTIVE_DEMO cannot be enabled in production — it exposes a route that permanently deletes the whole library.');
  }
  if (TRUST_PROXY === true) {
    warn.push('TRUST_PROXY=true trusts the X-Forwarded-For header from any client, which lets anybody spoof the address the rate limiter and the audit trail record. Use a hop count or a proxy CIDR.');
  }
  if (production && !String(env.PUBLIC_ORIGIN || '').startsWith('https://')) {
    warn.push('PUBLIC_ORIGIN is not https. Sessions, refresh cookies and file tickets all travel in the clear unless something in front terminates TLS.');
  }
  if (production && env.MIN_PASSWORD_LENGTH < 12) {
    fatal.push(`MIN_PASSWORD_LENGTH is ${env.MIN_PASSWORD_LENGTH}. Production requires at least 12 — an 8-character password is inside brute-force reach for anyone who takes a copy of the hashes.`);
  }
  if (env.OTP_ENABLED && !env.BREVO_API_KEY) {
    (production ? fatal : warn).push(
      'OTP_ENABLED is on but BREVO_API_KEY is unset, so the daily passcode cannot be delivered.'
      + (production ? '' : ' In development the code is printed to this console instead.'),
    );
  }
  if (env.OTP_ENABLED && env.BREVO_API_KEY && !env.BREVO_SENDER_EMAIL) {
    fatal.push('BREVO_SENDER_EMAIL is required when BREVO_API_KEY is set — Brevo refuses a send with no verified sender.');
  }
  if (production && env.RATE_LIMIT_STORE === 'memory') {
    warn.push('RATE_LIMIT_STORE=memory keeps rate-limit counters inside one process. A second task, or a restart, resets every counter. Use mongo.');
  }
  if (env.FILE_TOKEN_KEY_VERSION > 1 && !env.FILE_TOKEN_SECRET_PREVIOUS) {
    warn.push('FILE_TOKEN_KEY_VERSION was bumped without FILE_TOKEN_SECRET_PREVIOUS, so every download, preview and share URL already in circulation is dead rather than draining.');
  }

  if (warn.length) {
    console.warn('\n  Security warnings:');
    for (const line of warn) console.warn(`    · ${line}`);
    console.warn('');
  }
  if (fatal.length) {
    console.error(`\nGCloud refuses to start — insecure configuration:\n${fatal.map((l) => `  · ${l}`).join('\n')}\n`);
    process.exit(1);
  }
}
assertSecrets();

export const isWeakPassword = (value) => WEAK_PASSWORDS.includes(String(value ?? ''));

export const MONGODB_URI = env.MONGODB_URI;
export const MONGODB_DB = env.MONGODB_DB;

function serviceAccountFromFile(file) {
  const resolved = path.isAbsolute(file) ? file : path.resolve(ROOT, '..', file);
  if (!fs.existsSync(resolved)) {
    console.error(`\nGOOGLE_SERVICE_ACCOUNT_KEY_FILE points at ${resolved}, which does not exist.\n`);
    process.exit(1);
  }
  try {
    const json = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return { email: json.client_email, privateKey: json.private_key };
  } catch (err) {
    console.error(`\n${resolved} is not a readable service-account key file: ${err.message}\n`);
    process.exit(1);
  }
  return null;
}

const fromFile = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
  ? serviceAccountFromFile(env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE)
  : null;

export const GOOGLE = {
  mode: env.GOOGLE_AUTH_MODE,
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  refreshToken: env.GOOGLE_REFRESH_TOKEN,
  serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL || fromFile?.email,
  privateKey: (env.GOOGLE_PRIVATE_KEY || fromFile?.privateKey || '').replace(/\\n/g, '\n') || undefined,
  subject: env.GOOGLE_IMPERSONATE_SUBJECT,
};

export const GOOGLE_CONFIGURED =
  GOOGLE.mode === 'oauth'
    ? Boolean(GOOGLE.clientId && GOOGLE.clientSecret && GOOGLE.refreshToken)
    : Boolean(GOOGLE.serviceAccountEmail && GOOGLE.privateKey);

export const GOOGLE_SIGNIN = {
  enabled: env.GOOGLE_SIGNIN_ENABLED,
  clientId: env.GOOGLE_SIGNIN_CLIENT_ID || env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_SIGNIN_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET,
  redirectUri: env.GOOGLE_SIGNIN_REDIRECT_URI || `${ORIGIN}/api/auth/google/callback`,
  hostedDomain: env.GOOGLE_SIGNIN_HOSTED_DOMAIN ?? null,
};

export const GOOGLE_SIGNIN_CONFIGURED =
  GOOGLE_SIGNIN.enabled && Boolean(GOOGLE_SIGNIN.clientId && GOOGLE_SIGNIN.clientSecret);

export const DRIVE_ID = env.DRIVE_ID ?? null;
export const DRIVE_ROOT_FOLDER_ID = env.DRIVE_ROOT_FOLDER_ID ?? null;
export const DRIVE_ROOT_FOLDER_NAME = env.DRIVE_ROOT_FOLDER_NAME;

export const FOLDER_ROLES = {
  assets: 'Assets',
  quarantine: 'Quarantine',
  backups: 'Backups',
  logs: 'Logs',
};

export const ROOTS = { root: DRIVE_ROOT_FOLDER_ID, assets: null, quarantine: null, backups: null, logs: null };

export const TTL = {
  download: env.TTL_DOWNLOAD,
  preview: env.TTL_PREVIEW,
  upload: env.TTL_UPLOAD_PART,
  share: env.TTL_SHARE,
};

const QUANTUM = 256 * 1024;
export const CHUNK_SIZE = Math.max(QUANTUM, Math.floor((env.DRIVE_CHUNK_MB * 1024 * 1024) / QUANTUM) * QUANTUM);

export const LIST_PAGE_SIZE = env.DRIVE_LIST_PAGE_SIZE;
export const HEAD_CONCURRENCY = env.HEAD_CONCURRENCY;
export const VERIFY_BATCH_MAX = env.VERIFY_BATCH_MAX;
export const TRASH_DAYS = env.DRIVE_TRASH_DAYS;

export const DEDUPE = {
  sizeTolerance: env.DEDUPE_SIZE_TOLERANCE,
  durationToleranceSec: env.DEDUPE_DURATION_TOLERANCE_SEC,
  nameSimilarity: env.DEDUPE_NAME_SIMILARITY,
  perceptual: env.DEDUPE_PERCEPTUAL,
  frames: env.DEDUPE_PERCEPTUAL_FRAMES,
  maxDistance: env.DEDUPE_PERCEPTUAL_MAX_DISTANCE,
};

export const SEED_ON_BOOT = env.SEED_ON_BOOT;
export const SEED_PASSWORD = env.SEED_PASSWORD;
export const MIN_PASSWORD_LENGTH = env.MIN_PASSWORD_LENGTH;
export const PASSWORD_BREACH_CHECK = env.PASSWORD_BREACH_CHECK;

export const LOGIN_MAX_FAILURES = env.LOGIN_MAX_FAILURES;
export const LOGIN_LOCKOUT_SEC = env.LOGIN_LOCKOUT_SEC;
export const STEP_UP_MAX_AGE_SEC = env.STEP_UP_MAX_AGE_SEC;
export const AUDIT_RETENTION_DAYS = env.AUDIT_RETENTION_DAYS;

export const PASSWORD_HISTORY_DEPTH = env.PASSWORD_HISTORY_DEPTH;
export const PASSWORD_MAX_AGE_DAYS = env.PASSWORD_MAX_AGE_DAYS;

export const OTP = {
  enabled: env.OTP_ENABLED,
  timezone: env.OTP_TIMEZONE,
  length: env.OTP_LENGTH,
  ttlSec: env.OTP_TTL_SEC,
  maxAttempts: env.OTP_MAX_ATTEMPTS,
  resendCooldownSec: env.OTP_RESEND_COOLDOWN_SEC,
  ticketTtlSec: env.OTP_TICKET_TTL_SEC,
};

export const BREVO = {
  apiKey: env.BREVO_API_KEY,
  senderEmail: env.BREVO_SENDER_EMAIL,
  senderName: env.BREVO_SENDER_NAME,
  replyTo: env.BREVO_REPLY_TO,
  timeoutMs: env.MAIL_TIMEOUT_MS,
};
export const MAIL_CONFIGURED = Boolean(BREVO.apiKey && BREVO.senderEmail);

export const RATE_LIMIT_STORE = env.RATE_LIMIT_STORE;

export const SHARE_PASSCODE = {
  minLength: env.SHARE_PASSCODE_MIN_LENGTH,
  windowSec: env.SHARE_PASSCODE_WINDOW_SEC,
  maxAttempts: env.SHARE_PASSCODE_MAX_ATTEMPTS,
  freezeAt: env.SHARE_PASSCODE_FREEZE_AT,
};

export const RESET_MAX_PER_HOUR = env.RESET_MAX_PER_HOUR;
export const CSRF_ENABLED = env.CSRF_ENABLED;
export const LOGIN_ANOMALY_NOTIFY = env.LOGIN_ANOMALY_NOTIFY;
export const ALERT_WEBHOOK_URL = env.ALERT_WEBHOOK_URL ?? null;
export const LOG_FORMAT = env.LOG_FORMAT;

export const ON_RENDER = /^(1|true|yes)$/i.test(String(env.RENDER ?? ''));

export const KEEPALIVE = {
  // Explicit setting wins; otherwise it follows whether we are on Render.
  enabled: env.KEEPALIVE_ENABLED == null || env.KEEPALIVE_ENABLED === ''
    ? ON_RENDER
    : /^(1|true|yes|on)$/i.test(env.KEEPALIVE_ENABLED),
  // Render hands us the public URL; falling back to PUBLIC_ORIGIN covers every
  // other host. /healthz is the cheapest public route and touches nothing
  // external — no Drive call, no Google token refresh, no database write.
  url: (() => {
    if (env.KEEPALIVE_URL) return env.KEEPALIVE_URL;
    const base = env.RENDER_EXTERNAL_URL || env.PUBLIC_ORIGIN;
    return base ? `${base.replace(/\/$/, '')}/healthz` : null;
  })(),
  intervalMin: env.KEEPALIVE_INTERVAL_MIN,
  timeoutMs: env.KEEPALIVE_TIMEOUT_MS,
  allowLocal: env.KEEPALIVE_ALLOW_LOCAL,
};

export const FILE_TOKEN_KEY_VERSION = env.FILE_TOKEN_KEY_VERSION;
export const FILE_TOKEN_SECRET_PREVIOUS = env.FILE_TOKEN_SECRET_PREVIOUS ?? null;
export const FILE_TOKEN_GRACE_SEC = env.FILE_TOKEN_GRACE_SEC;

export const ALLOW_DESTRUCTIVE_DEMO = env.ALLOW_DESTRUCTIVE_DEMO;
export const ALLOW_EMPTY_DRIVE_TRASH = env.ALLOW_EMPTY_DRIVE_TRASH;

export const UPLOAD_MAX_BYTES = env.UPLOAD_MAX_BYTES;
export const UPLOAD_DAILY_BYTES = env.UPLOAD_DAILY_BYTES;

export const CLAMAV_ENABLED = env.CLAMAV_ENABLED;
export const CLAMAV_HOST = env.CLAMAV_HOST;
export const CLAMAV_PORT = env.CLAMAV_PORT;
export const CLAMAV_TIMEOUT_MS = env.CLAMAV_TIMEOUT_MS;
export const CLAMAV_MAX_BYTES = env.CLAMAV_MAX_BYTES;
export const CLAMAV_FAIL_CLOSED = env.CLAMAV_FAIL_CLOSED;

export const INLINE_MIME = [
  /^audio\//, /^video\//,
  /^image\/(png|jpeg|jpg|gif|webp|avif|bmp|tiff|heic|heif)$/,
  /^image\/svg\+xml$/,
  /^application\/pdf$/,
  /^text\/plain$/,
];

export const BLOCKED_MIME = [
  /^text\/html$/, /^application\/xhtml\+xml$/, /^application\/xslt\+xml$/,
  /^text\/javascript$/, /^application\/javascript$/, /^application\/ecmascript$/,
  /^application\/x-msdownload$/, /^application\/x-msdos-program$/,
  /^application\/x-sh$/, /^application\/x-shellscript$/, /^application\/wasm$/,
  /^application\/java-archive$/, /^application\/x-httpd-php$/,
];

export const BLOCKED_EXTENSIONS = [
  '.html', '.htm', '.xhtml', '.shtml', '.xsl', '.xslt',
  '.js', '.mjs', '.cjs', '.wasm', '.jar', '.class',
  '.exe', '.dll', '.msi', '.scr', '.com', '.bat', '.cmd', '.ps1', '.vbs', '.hta',
  '.sh', '.bash', '.zsh', '.php', '.phtml', '.asp', '.aspx', '.jsp', '.cgi', '.pl',
  '.app', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.lnk', '.reg', '.chm',
];

export const FOUNDING_ADMIN = {
  email: env.ADMIN_EMAIL.trim().toLowerCase(),
  name: env.ADMIN_NAME,
  password: env.ADMIN_PASSWORD,
};

export const RECONCILE_CRON = env.RECONCILE_CRON;
export const RECONCILE_ENABLED = env.RECONCILE_ENABLED;
