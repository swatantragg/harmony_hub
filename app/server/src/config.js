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

  RATE_LIMIT_WINDOW_SEC: int(60, 1),
  RATE_LIMIT_MAX: int(600, 1),
  RATE_LIMIT_HEAVY_MAX: int(60, 1),
  RATE_LIMIT_AUTH_WINDOW_SEC: int(900, 30),
  RATE_LIMIT_AUTH_MAX: int(10, 1),
  RATE_LIMIT_AUTH_IP_MAX: int(40, 1),
  LOGIN_MAX_FAILURES: int(8, 3),
  LOGIN_LOCKOUT_SEC: int(900, 60),
  RATE_LIMIT_FILES_MAX: int(600, 10),

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
