import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

import {
  ALLOW_DESTRUCTIVE_DEMO, APP_ORIGIN, AUDIT_RETENTION_DAYS, CORS_ORIGINS, DRIVE_ID, ENV,
  FOUNDING_ADMIN, GOOGLE, GOOGLE_CONFIGURED, NODE_ENV, ORIGIN, PORT, RECONCILE_CRON,
  RECONCILE_ENABLED, ROOT as SERVER_ROOT, ROOTS, SEED_ON_BOOT, SEED_PASSWORD, TRUST_PROXY, env,
} from './config.js';
import { connect, connectionInfo, disconnect } from './db/mongo.js';
import { ensureIndexes } from './db/models.js';
import { db, flushNow, isEmpty, load, readMeta } from './db.js';
import { seed } from './seed.js';
import { ensureAccounts } from './services/accounts.js';
import * as storage from './services/storage.js';
import { runReconciliation } from './services/reconcile.js';

import { authenticate, clientAddress, problem, requires } from './middleware/auth.js';
import { notify, sweepAudit } from './services/audit.js';
import { sweep as sweepSessions } from './services/sessions.js';

import { authRouter, meRouter } from './routes/auth.js';
import { assetsRouter } from './routes/assets.js';
import { searchRouter } from './routes/search.js';
import { artistsRouter, songsRouter, tagsRouter, typesRouter } from './routes/catalogue.js';
import { foldersRouter } from './routes/folders.js';
import { uploadsRouter } from './routes/uploads.js';
import { sharesRouter, publicShareRouter } from './routes/shares.js';
import { adminRouter, notificationsRouter } from './routes/admin.js';
import { dashboardRouter } from './routes/dashboard.js';
import { dedupeRouter } from './routes/dedupe.js';
import { masterLogRouter } from './routes/masterlog.js';
import { filesRouter } from './routes/files.js';

const app = express();

app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.locals.corsOrigins = CORS_ORIGINS;

app.use(clientAddress);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://lh3.googleusercontent.com'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'https://www.googleapis.com', 'https://storage.googleapis.com'],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      frameSrc: ["'none'"],
      upgradeInsecureRequests: NODE_ENV === 'production' ? [] : null,
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
}));

app.use((_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
  );
  next();
});

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    maxAge: 600,
  }),
);

app.use(express.json({ limit: '1mb' }));

const tooMany = (detail) => ({
  type: 'https://gcloud.internal/problems/rate-limited',
  title: 'Too Many Requests',
  status: 429,
  detail,
});

const limiter = (max, detail = 'Slow down — this endpoint is rate limited.') =>
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_SEC * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.sub || req.ip,
    message: tooMany(detail),
  });

const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_AUTH_WINDOW_SEC * 1000,
  max: env.RATE_LIMIT_AUTH_IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `ip:${req.ip}`,
  message: tooMany('Too many failed sign-in attempts from this address. Wait a few minutes and try again.'),
});

const accountLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_AUTH_WINDOW_SEC * 1000,
  max: env.RATE_LIMIT_AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `account:${String(req.body?.email || req.user?.sub || 'unknown').toLowerCase()}`,
  message: tooMany('Too many attempts against this account. Wait a few minutes and try again.'),
});

app.use('/api/files', limiter(env.RATE_LIMIT_FILES_MAX, 'Too many file requests. Slow down.'), filesRouter);

app.use('/api', limiter(env.RATE_LIMIT_MAX));

app.get('/healthz', (_req, res) => {
  const mongo = connectionInfo();
  const drive = storage.driveStatus();
  const live = mongo.readyState === 1;
  const ok = live && GOOGLE_CONFIGURED && drive.ok;
  res.status(live ? 200 : 503).json({
    ok,
    live,
    degraded: live && !ok,
    uptime: Math.round(process.uptime()),
  });
});

app.use('/api/auth/login', authLimiter, accountLimiter);
app.use('/api/auth/password', authLimiter, accountLimiter);
app.use('/api/auth/step-up', authLimiter, accountLimiter);
app.use('/api/auth/refresh', authLimiter);

app.use('/api/auth/google', rateLimit({
  windowMs: env.RATE_LIMIT_AUTH_WINDOW_SEC * 1000,
  max: env.RATE_LIMIT_AUTH_IP_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `google:${req.ip}`,
  message: tooMany('Too many sign-in attempts from this address. Wait a few minutes and try again.'),
}));

app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/artists', artistsRouter);
app.use('/api/songs', songsRouter);
app.use('/api/assets/:id/download', limiter(env.RATE_LIMIT_HEAVY_MAX));
app.use('/api/assets/:id/replace', limiter(env.RATE_LIMIT_HEAVY_MAX));
app.use('/api/assets/:id/purge', limiter(env.RATE_LIMIT_HEAVY_MAX));
app.use('/api/assets/:id/restore', limiter(env.RATE_LIMIT_HEAVY_MAX));
app.use('/api/assets', assetsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/search', searchRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/asset-types', typesRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/shares', sharesRouter);
app.use('/api/s', publicShareRouter);
app.use('/api/dedupe', dedupeRouter);
app.use('/api/master-log', masterLogRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);

if (ALLOW_DESTRUCTIVE_DEMO && NODE_ENV !== 'production') {
  app.post(
    '/api/demo/reset',
    authenticate,
    requires('admin:users'),
    async (req, res, next) => {
      if (req.body?.confirm !== 'RESET THE LIBRARY') {
        return problem(
          res, 428, 'Precondition Required',
          'Type RESET THE LIBRARY to confirm. This permanently deletes every file under the GCloud folder in Drive and empties the catalogue.',
        );
      }
      try {
        console.warn(`[demo] library reset requested by ${req.user.email}`);
        const stats = await seed();
        res.json({ ok: true, seeded: true, stats });
      } catch (err) {
        next(err);
      }
    },
  );
  console.warn('  ⚠  ALLOW_DESTRUCTIVE_DEMO is on: POST /api/demo/reset can wipe the library.');
}

app.use('/api', (_req, res) =>
  res.status(404).type('application/problem+json').json({
    type: 'https://gcloud.internal/problems/not-found',
    title: 'Not Found', status: 404, detail: 'No such endpoint.',
  }),
);

const clientDist = env.CLIENT_DIST || path.resolve(SERVER_ROOT, '../client/dist');
if (fs.existsSync(clientDist)) {
  const IMMUTABLE = /^\/assets\//;
  app.use(
    express.static(clientDist, {
      etag: true,
      lastModified: true,
      dotfiles: 'ignore',
      index: false,
      setHeaders(res, filePath) {
        const rel = `/${path.relative(clientDist, filePath).split(path.sep).join('/')}`;
        if (IMMUTABLE.test(rel)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return;
        }
        if (rel === '/sw.js') {
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Service-Worker-Allowed', '/');
          return;
        }
        res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`[error ${ref}] ${req.method} ${req.originalUrl}`, err);
    return res.status(status).type('application/problem+json').json({
      type: 'https://gcloud.internal/problems/internal',
      title: 'Internal Server Error',
      status,
      detail: `Something went wrong at our end. Quote reference ${ref} if you report this.`,
      reference: ref,
    });
  }
  res.status(status).type('application/problem+json').json({
    type: 'https://gcloud.internal/problems/request-failed',
    title: 'Request Failed',
    status,
    detail: err.message,
  });
});


async function main() {
  await connect();
  await ensureIndexes();
  const loaded = await load();

  const boot = await storage.tryEnsureRoots();
  const folders = boot.report ?? null;
  const space = boot.ok ? await storage.quota().catch(() => null) : null;

  if (!boot.ok) {
    console.error('\n  ⚠  Google Drive is not reachable — starting in a degraded state.\n');
    console.error(`    ${boot.error.message}\n`);
    console.error('  The catalogue, search, sharing records and admin screens all work.');
    console.error('  Uploads, downloads and previews will not, until Drive answers again.\n');
    console.error('  Run `npm run drive:check` from app/ for a step-by-step diagnosis,');
    console.error('  or `npm run drive:auth` to mint a fresh refresh token.\n');
  }

  let seeded = false;
  if (isEmpty() && (SEED_ON_BOOT || process.argv.includes('--seed'))) {
    // The seed uploads its sample assets to Drive, so it cannot run while Drive is
    // unreachable. Degraded means serving, not dying: skip the seed and boot empty
    // rather than throwing past the warning printed just above.
    if (boot.ok) {
      await seed();
      seeded = true;
    } else {
      console.error('  Skipping the boot seed — it uploads to Drive, which is unreachable.');
      console.error('  Fix the credential, then restart or POST /api/demo/reset.\n');
    }
  }

  const accountChanges = await ensureAccounts({ log: () => {} });

  const meta = await readMeta();
  const assetCount = db.songs.reduce((n, s) => n + s.assets.length, 0) + db.unfiled.length;

  const server = app.listen(PORT, () => {
    console.log('');
    console.log('  ▁▃▅▂▄  G C L O U D   ·   API');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  API          ${ORIGIN}/api`);
    console.log(`  App          ${APP_ORIGIN}`);
    if (APP_ORIGIN !== ORIGIN) {
      console.log('');
      console.log(`  ⚠  Share links will be built as ${APP_ORIGIN}/#/s/<token>`);
      console.log(`     but this process serves the app on ${ORIGIN}.`);
      console.log('     That is correct only while a separate front end is running there.');
      console.log(`     Otherwise set APP_ORIGIN=${ORIGIN} in app/.env — links made now will not work.`);
    }
    console.log(`  Storage      Google Drive  ·  ${GOOGLE.mode === 'oauth' ? 'OAuth user account' : 'service account'}${DRIVE_ID ? `  ·  Shared Drive ${DRIVE_ID}` : '  ·  My Drive'}`);
    if (space?.account) console.log(`  Account      ${space.account.email}`);
    if (folders?.root) {
      console.log(`  Folder       ${folders.root.name} (${folders.root.id})`);
      if (folders.root.webViewLink) console.log(`               ${folders.root.webViewLink}`);
    } else {
      console.log('  Folder       — unavailable, Google Drive is not answering');
    }
    if (space) {
      console.log(`  Space        ${space.unlimited ? 'unlimited (pooled Shared Drive)' : `${gb(space.usage)} of ${gb(space.limit)} used — ${gb(space.available)} free (${space.percentUsed}%)`}`);
      if (space.usageInTrash > 0) console.log(`               ${gb(space.usageInTrash)} of that is in the trash and still counts`);
    }
    console.log(`  MongoDB      ${connectionInfo().db} @ ${connectionInfo().host}`);
    console.log(`  Library      ${db.artists.length} artists · ${db.songs.length} songs · ${db.folders.length} folders · ${assetCount} assets`);
    console.log(`  Loaded       ${loaded.total} documents${seeded ? ' (freshly seeded)' : ''}`);
    if (meta?.seededAt) console.log(`  Seeded at    ${meta.seededAt}`);
    for (const line of accountChanges) console.log(`  Accounts     ${line}`);
    console.log('  ─────────────────────────────────────────────');
    if (NODE_ENV !== 'production') {
      console.log(`  Sign in      ${FOUNDING_ADMIN.email}`);
      const pending = db.users.filter((u) => u.mustChangePassword).length;
      if (pending > 0) {
        console.log(`               ${pending} other account${pending === 1 ? '' : 's'} still hold the handover password (${SEED_PASSWORD})`);
        console.log('               and must set their own at first sign-in.');
      }
    }
    console.log('');
  });

  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 61_000;

  const job = RECONCILE_ENABLED && cron.validate(RECONCILE_CRON)
    ? cron.schedule(RECONCILE_CRON, () => {
      runReconciliation({ ip: '127.0.0.1', get: () => 'scheduler', user: null }, { trigger: 'scheduled' })
        .catch((err) => console.error('[reconcile]', err.message));
    })
    : null;
  if (job) console.log(`  Reconciliation scheduled: ${RECONCILE_CRON}\n`);

  const stopDriveWatch = storage.watchDrive({
    onRecover: () => notify({
      level: 'ok',
      title: 'Google Drive is reachable again',
      body: 'Uploads, downloads and previews have resumed.',
      link: '/admin/storage',
    }),
  });

  const sweeper = cron.schedule('0 3 * * *', () => {
    Promise.all([sweepAudit(AUDIT_RETENTION_DAYS), sweepSessions()])
      .then(([audit, stale]) => {
        if (audit || stale) console.log(`[sweep] ${audit} audit rows, ${stale} spent sessions removed`);
      })
      .catch((err) => console.error('[sweep]', err.message));
  });

  const shutdown = async (signal) => {
    console.log(`\n${signal} — draining…`);
    job?.stop();
    sweeper.stop();
    stopDriveWatch();
    server.close();
    await flushNow().catch(() => null);
    await disconnect().catch(() => null);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function gb(bytes) {
  if (bytes == null) return '—';
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${gib.toFixed(gib >= 10 ? 0 : 1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

main().catch((err) => {
  console.error(`\nGCloud failed to start.\n\n  ${err.message}`);
  if (process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace') console.error(err.cause ?? err);
  else console.error('  Set LOG_LEVEL=debug for the full error.\n');
  process.exit(1);
});
