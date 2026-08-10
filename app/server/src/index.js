// Harmony Hub API — Express bootstrap (§9.1, §9.3).
//
// Two surfaces run in this process, and the split is worth stating plainly.
//
//   /api        The control plane. JSON only, body parser capped at 1 MB, structurally
//               incapable of accepting a file byte. Uploads never touch it: the browser is
//               handed a Google Drive resumable session URI and sends the bytes straight
//               to Google.
//
//   /api/files  The byte path. Google Drive offers no way to hand a browser a
//               self-authorising, expiring link to a file held under a server credential,
//               so downloads and previews are streamed through this process against a
//               short-lived signed ticket. Nothing is buffered and Range is forwarded, but
//               bytes do pass through on the way out. See services/signing.js.
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cron from 'node-cron';
import path from 'node:path';
import fs from 'node:fs';

import {
  APP_ORIGIN, CORS_ORIGINS, DRIVE_ID, ENV, GOOGLE, GOOGLE_CONFIGURED, NODE_ENV, ORIGIN,
  PORT, RECONCILE_CRON, RECONCILE_ENABLED, ROOT as SERVER_ROOT, ROOTS, SEED_ON_BOOT,
  SEED_PASSWORD, env,
} from './config.js';
import { connect, connectionInfo, disconnect } from './db/mongo.js';
import { ensureIndexes } from './db/models.js';
import { db, flushNow, isEmpty, load, readMeta } from './db.js';
import { seed } from './seed.js';
import * as storage from './services/storage.js';
import { runReconciliation } from './services/reconcile.js';

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
import { filesRouter } from './routes/files.js';

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

// helmet's default CSP assumes the API also serves HTML from the same origin. It does
// when a built client is present, and the bundle plus same-origin /api/files media are the
// only things it ever loads.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));

app.use(
  cors({
    origin(origin, cb) {
      // No Origin header at all is a same-origin or server-to-server call.
      if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} is not allowed. Add it to CORS_ORIGINS.`));
    },
    credentials: true,
  }),
);

// 1 MB. The API cannot accept a file upload even if somebody tried to make it (P2).
app.use(express.json({ limit: '1mb' }));

const limiter = (max) =>
  rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_SEC * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.sub || req.ip,
    message: {
      type: 'https://harmonyhub.internal/problems/rate-limited',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Slow down — this endpoint is rate limited.',
    },
  });

// The byte path is mounted before the JSON rate limiter and before the CORS-checked API
// routes: a <video> element issues one request per seek, and counting those against the
// same budget as a search would throttle scrubbing after a few seconds of use. The ticket
// in the URL is the authorisation, so there is no session to check either.
app.use('/api/files', filesRouter);

app.use('/api', limiter(env.RATE_LIMIT_MAX));

app.get('/healthz', (_req, res) => {
  const mongo = connectionInfo();
  res.json({
    ok: mongo.readyState === 1 && GOOGLE_CONFIGURED,
    env: ENV,
    uptime: process.uptime(),
    mongo: { db: mongo.db, connected: mongo.readyState === 1 },
    storage: {
      provider: 'google-drive',
      authMode: GOOGLE.mode,
      configured: GOOGLE_CONFIGURED,
      sharedDrive: Boolean(DRIVE_ID),
      rootFolderId: ROOTS.root,
      assetsFolderId: ROOTS.assets,
    },
  });
});

app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/artists', artistsRouter);
app.use('/api/songs', songsRouter);
// The expensive or irreversible asset operations get their own tighter rate-limit budget.
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
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);

// Reset the demo library to its seeded state. Never available in production, because it
// destroys every file under the Harmony Hub folder in the connected Drive.
if (NODE_ENV !== 'production') {
  app.post('/api/demo/reset', async (_req, res, next) => {
    try {
      const stats = await seed();
      res.json({ ok: true, seeded: true, stats });
    } catch (err) {
      next(err);
    }
  });
}

app.use('/api', (_req, res) =>
  res.status(404).type('application/problem+json').json({
    type: 'https://harmonyhub.internal/problems/not-found',
    title: 'Not Found', status: 404, detail: 'No such endpoint.',
  }),
);

// Serve the built client if one exists, so `npm start` alone runs the whole product —
// the same arrangement as the deployed container (§4).
const clientDist = env.CLIENT_DIST || path.resolve(SERVER_ROOT, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// RFC 7807 for everything that escapes a handler.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).type('application/problem+json').json({
    type: 'https://harmonyhub.internal/problems/internal',
    title: status >= 500 ? 'Internal Server Error' : 'Request Failed',
    status,
    detail: err.message,
  });
});

// ── Boot ────────────────────────────────────────────────────────────────────

async function main() {
  await connect();
  await ensureIndexes();
  const loaded = await load();

  // Google Drive is reached once, before the first request, so a bad credential is a
  // sentence at boot rather than a stack trace inside somebody's upload.
  let folders;
  let space = null;
  try {
    folders = await storage.ensureRoots();
    space = await storage.quota().catch(() => null);
  } catch (err) {
    console.error('\n  Google Drive is not reachable.\n');
    console.error(`    ${err.message}\n`);
    console.error('  Run `npm run drive:check` from app/ for a step-by-step diagnosis,');
    console.error('  or `npm run drive:auth` to mint a fresh refresh token.\n');
    process.exit(1);
  }

  let seeded = false;
  if (isEmpty() && (SEED_ON_BOOT || process.argv.includes('--seed'))) {
    await seed();
    seeded = true;
  }

  const meta = await readMeta();
  const assetCount = db.songs.reduce((n, s) => n + s.assets.length, 0) + db.unfiled.length;

  const server = app.listen(PORT, () => {
    console.log('');
    console.log('  ▁▃▅▂▄  H A R M O N Y   H U B   ·   API');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  API          ${ORIGIN}/api`);
    console.log(`  App          ${APP_ORIGIN}`);
    // APP_ORIGIN is what every share link is built from, and a share link is the one URL
    // in the product that leaves the building. When it points somewhere this process is
    // not serving — the classic case being a Vite dev-server port left in .env after the
    // dev server was stopped — every link created is dead on arrival, and nothing fails
    // here to say so. The partner discovers it instead. So it is called out at boot.
    if (APP_ORIGIN !== ORIGIN) {
      console.log('');
      console.log(`  ⚠  Share links will be built as ${APP_ORIGIN}/#/s/<token>`);
      console.log(`     but this process serves the app on ${ORIGIN}.`);
      console.log('     That is correct only while a separate front end is running there.');
      console.log(`     Otherwise set APP_ORIGIN=${ORIGIN} in app/.env — links made now will not work.`);
    }
    console.log(`  Storage      Google Drive  ·  ${GOOGLE.mode === 'oauth' ? 'OAuth user account' : 'service account'}${DRIVE_ID ? `  ·  Shared Drive ${DRIVE_ID}` : '  ·  My Drive'}`);
    if (space?.account) console.log(`  Account      ${space.account.email}`);
    console.log(`  Folder       ${folders.root.name} (${folders.root.id})`);
    if (folders.root.webViewLink) console.log(`               ${folders.root.webViewLink}`);
    if (space) {
      console.log(`  Space        ${space.unlimited ? 'unlimited (pooled Shared Drive)' : `${gb(space.usage)} of ${gb(space.limit)} used — ${gb(space.available)} free (${space.percentUsed}%)`}`);
      if (space.usageInTrash > 0) console.log(`               ${gb(space.usageInTrash)} of that is in the trash and still counts`);
    }
    console.log(`  MongoDB      ${connectionInfo().db} @ ${connectionInfo().host}`);
    console.log(`  Library      ${db.artists.length} artists · ${db.songs.length} songs · ${db.folders.length} folders · ${assetCount} assets`);
    console.log(`  Loaded       ${loaded.total} documents${seeded ? ' (freshly seeded)' : ''}`);
    if (meta?.seededAt) console.log(`  Seeded at    ${meta.seededAt}`);
    console.log('  ─────────────────────────────────────────────');
    if (NODE_ENV !== 'production') {
      console.log(`  Sign in: admin@ / editor@ / marketing@ / viewer@harmonyhub.app  ·  ${SEED_PASSWORD}`);
    }
    console.log('');
  });

  // Nightly reconciliation (§10.11), 02:00 by default.
  const job = RECONCILE_ENABLED && cron.validate(RECONCILE_CRON)
    ? cron.schedule(RECONCILE_CRON, () => {
      runReconciliation({ ip: '127.0.0.1', get: () => 'scheduler', user: null }, { trigger: 'scheduled' })
        .catch((err) => console.error('[reconcile]', err.message));
    })
    : null;
  if (job) console.log(`  Reconciliation scheduled: ${RECONCILE_CRON}\n`);

  const shutdown = async (signal) => {
    console.log(`\n${signal} — draining…`);
    job?.stop();
    server.close();
    // Anything still sitting in the write-through debounce goes to MongoDB before exit.
    await flushNow().catch(() => null);
    await disconnect().catch(() => null);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Bytes, in the unit a person reading a boot banner actually wants.
function gb(bytes) {
  if (bytes == null) return '—';
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${gib.toFixed(gib >= 10 ? 0 : 1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

main().catch((err) => {
  console.error(`\nHarmony Hub failed to start.\n\n  ${err.message}`);
  // The full driver error is still there when it is actually wanted.
  if (process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace') console.error(err.cause ?? err);
  else console.error('  Set LOG_LEVEL=debug for the full error.\n');
  process.exit(1);
});
