// Runtime configuration (§9.1 config/). Every value comes from the environment and is
// validated once, at boot, by a Zod schema — the process refuses to start on a bad or
// missing setting rather than failing later inside a request.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// server/.env first, then app/.env — the second never overrides the first.
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

// An env var that is present but empty is not a value — it is the absence of one. This
// matters more than it looks: docker-compose sets a variable to the empty string rather
// than leaving it out, and `DRIVE_ID=` means "My Drive", not "a Shared Drive called ''".
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

  // Where the API answers, and where a person opens the app. They differ only while the
  // Vite dev server is running; in the deployed architecture both are the same hostname.
  PUBLIC_ORIGIN: blankIsUnset(z.string().url().optional()),
  APP_ORIGIN: blankIsUnset(z.string().url().optional()),
  // Comma-separated list of browser origins allowed to call the API.
  CORS_ORIGINS: blankIsUnset(z.string().optional()),

  // ── Secrets ───────────────────────────────────────────────────────────────
  JWT_SECRET: blankIsUnset(z.string().min(16, 'JWT_SECRET must be at least 16 characters')),
  ACCESS_TTL_SEC: int(60 * 60 * 8, 60),
  BCRYPT_ROUNDS: int(12, 4),
  // Signs the short-lived tokens that authorise a single file stream. Defaults to
  // JWT_SECRET so there is one fewer thing to generate, but it can be rotated alone.
  FILE_TOKEN_SECRET: blankIsUnset(z.string().min(16).optional()),

  // ── MongoDB (§3.3) ────────────────────────────────────────────────────────
  MONGODB_URI: blankIsUnset(z.string().min(1, 'MONGODB_URI is required')),
  MONGODB_DB: z.string().default('gcloud'),

  // ── Google Drive (§6) ─────────────────────────────────────────────────────
  // Two ways to reach a Drive, and they are genuinely different accounts:
  //
  //   oauth            A person's own Google account. You consent once, keep the refresh
  //                    token, and every file lands in *your* Drive against *your* 15 GB.
  //                    This is the one to test with.
  //   service_account  A robot account with its own key. It cannot own storage on a
  //                    consumer account, so it must write into a Shared Drive (DRIVE_ID)
  //                    whose quota belongs to a Google Workspace — or impersonate a real
  //                    user through domain-wide delegation.
  GOOGLE_AUTH_MODE: z.enum(['oauth', 'service_account']).default('oauth'),

  GOOGLE_CLIENT_ID: blankIsUnset(z.string().optional()),
  GOOGLE_CLIENT_SECRET: blankIsUnset(z.string().optional()),
  GOOGLE_REFRESH_TOKEN: blankIsUnset(z.string().optional()),

  // Either paste the two fields, or point at the downloaded JSON key file.
  GOOGLE_SERVICE_ACCOUNT_EMAIL: blankIsUnset(z.string().optional()),
  GOOGLE_PRIVATE_KEY: blankIsUnset(z.string().optional()),
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: blankIsUnset(z.string().optional()),
  // Domain-wide delegation only: the Workspace user the robot acts as.
  GOOGLE_IMPERSONATE_SUBJECT: blankIsUnset(z.string().optional()),

  // Shared Drive id. Blank means My Drive, which is the normal case for oauth mode.
  DRIVE_ID: blankIsUnset(z.string().optional()),
  // The folder everything lives under. Blank means "find or create DRIVE_ROOT_FOLDER_NAME
  // at the top of the Drive" — `npm run bootstrap:drive` prints the id it settled on.
  DRIVE_ROOT_FOLDER_ID: blankIsUnset(z.string().optional()),
  DRIVE_ROOT_FOLDER_NAME: z.string().default('GCloud'),

  // Resumable uploads are sent in chunks. Google requires every chunk except the last to
  // be a multiple of 256 KiB; the value here is rounded down to one at load.
  DRIVE_CHUNK_MB: int(8, 1),
  DRIVE_LIST_PAGE_SIZE: int(1000, 100),
  // files.get fan-out ceiling for batch verification and reconciliation (§10.5.3).
  HEAD_CONCURRENCY: int(12, 1),
  VERIFY_BATCH_MAX: int(500, 1),
  // Trash is Drive's recycle bin, and it empties itself. Surfaced in the UI so nobody
  // treats "deleted" as "recoverable forever".
  DRIVE_TRASH_DAYS: int(30, 1),

  // Lifetimes, in seconds, of the signed tickets that authorise one file stream (§12.3).
  TTL_DOWNLOAD: int(5 * 60, 30),
  TTL_PREVIEW: int(60 * 60, 30),
  TTL_UPLOAD_PART: int(60 * 60, 60),
  TTL_SHARE: int(60 * 60, 60),

  // ── De-duplication (§10.12) ───────────────────────────────────────────────
  // Thresholds for the near-duplicate pass. Exact duplicates need no thresholds — they
  // are decided by checksum — so these only ever affect the "probably the same thing"
  // tier, which always asks a human before it does anything.
  DEDUPE_SIZE_TOLERANCE: z.string().optional().transform((v) => (v == null || v === '' ? 0.02 : Number(v))).pipe(z.number().min(0).max(0.5)),
  DEDUPE_DURATION_TOLERANCE_SEC: int(2, 0),
  DEDUPE_NAME_SIMILARITY: z.string().optional().transform((v) => (v == null || v === '' ? 0.7 : Number(v))).pipe(z.number().min(0).max(1)),
  // Perceptual video/audio matching needs ffmpeg on PATH. Off by default because it reads
  // whole files back out of Drive, which costs both time and quota.
  DEDUPE_PERCEPTUAL: bool(false),
  DEDUPE_PERCEPTUAL_FRAMES: int(8, 2),
  DEDUPE_PERCEPTUAL_MAX_DISTANCE: int(10, 0),

  // Nightly reconciliation (§10.11). Cron in the server's local timezone.
  RECONCILE_CRON: z.string().default('0 2 * * *'),
  RECONCILE_ENABLED: bool(true),

  // Seeding. SEED_ON_BOOT fills an empty database on first start; it never overwrites a
  // library that already has documents unless `npm run seed -- --force` is used.
  SEED_ON_BOOT: bool(true),
  // The password the seeded accounts are created with. Every seeded account except the
  // founding administrator is created holding it and required to replace it at first
  // sign-in, so it is a handover value rather than a credential.
  SEED_PASSWORD: z.string().min(8).default('changeme123'),

  // The founding administrator, created on an empty database. This is the only account in
  // the product that is born with a password of its own and no forced change.
  ADMIN_EMAIL: z.string().default('swatantra.goongoonalo@gmail.com'),
  ADMIN_NAME: z.string().default('Swatantra Goongoonalo'),
  ADMIN_PASSWORD: z.string().min(8).default('12345678'),

  // The one password rule. Length is the only requirement that reliably buys entropy;
  // character-class matrices push people towards predictable patterns instead.
  MIN_PASSWORD_LENGTH: int(8, 6),

  RATE_LIMIT_WINDOW_SEC: int(60, 1),
  RATE_LIMIT_MAX: int(600, 1),
  RATE_LIMIT_HEAVY_MAX: int(60, 1),

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

export const JWT_SECRET = env.JWT_SECRET;
export const FILE_TOKEN_SECRET = env.FILE_TOKEN_SECRET || env.JWT_SECRET;
export const ACCESS_TTL_SEC = env.ACCESS_TTL_SEC;
export const BCRYPT_ROUNDS = env.BCRYPT_ROUNDS;

export const MONGODB_URI = env.MONGODB_URI;
export const MONGODB_DB = env.MONGODB_DB;

// ── Google credentials, resolved ─────────────────────────────────────────────
// A downloaded key file is read here rather than in the client, so a bad path fails at
// boot with a sentence instead of at the first upload with a stack trace.
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
  // A .env file cannot hold a real newline, so the key arrives with literal \n in it.
  privateKey: (env.GOOGLE_PRIVATE_KEY || fromFile?.privateKey || '').replace(/\\n/g, '\n') || undefined,
  subject: env.GOOGLE_IMPERSONATE_SUBJECT,
};

// Reported on /healthz and in the boot banner. Checked before the first request rather
// than discovered on the first upload.
export const GOOGLE_CONFIGURED =
  GOOGLE.mode === 'oauth'
    ? Boolean(GOOGLE.clientId && GOOGLE.clientSecret && GOOGLE.refreshToken)
    : Boolean(GOOGLE.serviceAccountEmail && GOOGLE.privateKey);

export const DRIVE_ID = env.DRIVE_ID ?? null;
export const DRIVE_ROOT_FOLDER_ID = env.DRIVE_ROOT_FOLDER_ID ?? null;
export const DRIVE_ROOT_FOLDER_NAME = env.DRIVE_ROOT_FOLDER_NAME;

// The four storage roles, each a folder under one root — legible to a human who opens
// drive.google.com and has never heard of this application.
export const FOLDER_ROLES = {
  assets: 'Assets',
  quarantine: 'Quarantine',
  backups: 'Backups',
  logs: 'Logs',
};

// Filled in at boot by storage.ensureRoots(). Everything downstream reads ROOTS.assets
// rather than resolving a folder id of its own.
export const ROOTS = { root: DRIVE_ROOT_FOLDER_ID, assets: null, quarantine: null, backups: null, logs: null };

export const TTL = {
  download: env.TTL_DOWNLOAD,
  preview: env.TTL_PREVIEW,
  upload: env.TTL_UPLOAD_PART,
  share: env.TTL_SHARE,
};

// Google rejects any resumable chunk that is not a multiple of 256 KiB, so the configured
// size is rounded down to one rather than trusted.
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

export const FOUNDING_ADMIN = {
  email: env.ADMIN_EMAIL.trim().toLowerCase(),
  name: env.ADMIN_NAME,
  password: env.ADMIN_PASSWORD,
};

export const RECONCILE_CRON = env.RECONCILE_CRON;
export const RECONCILE_ENABLED = env.RECONCILE_ENABLED;
