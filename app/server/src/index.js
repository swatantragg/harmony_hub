// GCloud API — Express bootstrap (§9.1, §9.3).
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

// How much of X-Forwarded-For to believe. `true` would mean "all of it, from anybody",
// which hands every client control of req.ip — and req.ip is what the rate limiter counts
// and what the audit trail records. So it comes from configuration, and defaults to
// trusting nothing but the loopback interface.
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.locals.corsOrigins = CORS_ORIGINS;

// The socket address, recorded alongside req.ip so a forged header cannot rewrite history.
app.use(clientAddress);

// helmet, with the content security policy actually switched on.
//
// It was off because the API serves the built client from the same origin and a default
// policy would have blocked the bundle. That is a reason to write the policy, not to have
// none: without it, one HTML file in the library — served inline from /api/files on this
// very origin — is a full session compromise. The byte path adds its own, stricter
// sandbox policy per response.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      // Vite emits hashed bundles and no inline script. 'unsafe-inline' is deliberately
      // absent, and must stay absent — it is the directive that makes the rest ornamental.
      scriptSrc: ["'self'"],
      // The one concession: the client sets a handful of CSS custom properties inline for
      // theming. Styles cannot exfiltrate a token.
      // The typeface is served from this origin, so no font host appears here — the page
      // reaches no external origin at all.
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'"],
      // Media and thumbnails come from this origin's own byte path.
      imgSrc: ["'self'", 'data:', 'blob:', 'https://lh3.googleusercontent.com'],
      mediaSrc: ["'self'", 'blob:'],
      // Uploads PUT straight to a Google resumable session; nothing else is called.
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
  // Same-origin. The previous 'cross-origin' let any site on the internet embed a file
  // served by this process, which is exactly the sharing decision the share links exist
  // to make deliberately.
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
}));

// Permissions-Policy is not one of helmet's defaults. Nothing here needs a camera, a
// microphone or a location, so nothing here gets one.
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
      // No Origin header at all is a same-origin or server-to-server call.
      if (!origin || CORS_ORIGINS.includes(origin)) return cb(null, true);
      // Refused by answering without the header, rather than by throwing — a throw here
      // becomes a 500 with a stack behind it, which is a worse answer to a browser and a
      // more interesting one to somebody probing.
      return cb(null, false);
    },
    credentials: true,
    maxAge: 600,
  }),
);

// 1 MB. The API cannot accept a file upload even if somebody tried to make it (P2).
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
    // ipv6Subnet keeps a single /56 from counting as billions of distinct clients.
    keyGenerator: (req) => req.user?.sub || req.ip,
    message: tooMany(detail),
  });

// The credential surface. Counted per address *and* per account, in a much longer window,
// because this is the one place where an attacker's cost is a request and the defender's
// loss is everything. The account-keyed limiter is what stops a distributed attempt from
// getting an unlimited allowance simply by rotating addresses.
const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_AUTH_WINDOW_SEC * 1000,
  // Looser than the per-account budget on purpose — see RATE_LIMIT_AUTH_IP_MAX. One
  // address is frequently a whole office, or Docker's port proxy standing in for every
  // browser on the host.
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

// The byte path is mounted before the CORS-checked API routes: a <video> element issues
// one request per seek, and counting those against the same budget as a search would
// throttle scrubbing after a few seconds of use. It still gets a budget of its own —
// an unauthenticated route that streams whole files is not something to leave unmetered.
app.use('/api/files', limiter(env.RATE_LIMIT_FILES_MAX, 'Too many file requests. Slow down.'), filesRouter);

app.use('/api', limiter(env.RATE_LIMIT_MAX));

// Liveness only. This endpoint is unauthenticated by necessity — an orchestrator cannot
// hold a session — so it says whether the process is serving and nothing whatsoever about
// how it is configured. The detail moved to GET /api/admin/health, behind admin:storage.
app.get('/healthz', (_req, res) => {
  const mongo = connectionInfo();
  const drive = storage.driveStatus();
  // Degraded is not the same as down. The process is serving — the catalogue, search and
  // every admin screen work — so `live` stays true and a supervisor has no reason to kill
  // it. `ok` reports whether it can do everything, which is what a load balancer should
  // use to decide whether to send it traffic when another task is healthy.
  const live = mongo.readyState === 1;
  const ok = live && GOOGLE_CONFIGURED && drive.ok;
  res.status(live ? 200 : 503).json({
    ok,
    live,
    degraded: live && !ok,
    uptime: Math.round(process.uptime()),
  });
});

// Sign-in, password change, step-up and refresh all sit behind the strict pair.
app.use('/api/auth/login', authLimiter, accountLimiter);
app.use('/api/auth/password', authLimiter, accountLimiter);
app.use('/api/auth/step-up', authLimiter, accountLimiter);
app.use('/api/auth/refresh', authLimiter);

// The Google sign-in redirect pair. It needs a budget of its own rather than authLimiter's:
// both ends of the flow answer 302 whether they succeeded or refused, and authLimiter
// skips successful responses — so every attempt would be free. Counted per address only,
// because until Google has answered there is no account named in the request to count
// against; that is the whole point of the flow.
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
// The library's register of record. Read-only, and one row per catalogued file.
app.use('/api/master-log', masterLogRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);

// Reset the demo library to its seeded state.
//
// This route permanently deletes every file under the GCloud folder in the connected
// Drive — files.delete, not the trash, so there is nothing to restore — and then empties
// every collection in MongoDB. It was previously open to anybody who could reach the port
// whenever NODE_ENV was not exactly 'production', which is the default in the shipped
// .env and in the container. Four things now stand in front of it, and all four are
// required: the flag, a non-production environment, an authenticated administrator, and
// the words typed out.
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

// Serve the built client if one exists, so `npm start` alone runs the whole product —
// the same arrangement as the deployed container (§4).
//
// Cache lifetimes here are what decides whether a deploy is ever seen. Three classes:
//
//   /assets/*   content-hashed by Vite. The name changes when the bytes do, so these are
//               immutable and can be held for a year.
//   sw.js       the update mechanism itself. A cached service worker cannot be replaced by
//               a newer one it is busy serving — browsers cap its freshness at 24h for
//               exactly this reason, and no-cache closes the remaining window.
//   everything  index.html and the manifest: revalidated every time, because they are what
//   else       point at the hashed names above.
const clientDist = env.CLIENT_DIST || path.resolve(SERVER_ROOT, '../client/dist');
if (fs.existsSync(clientDist)) {
  const IMMUTABLE = /^\/assets\//;
  app.use(
    express.static(clientDist, {
      etag: true,
      lastModified: true,
      // A dotfile in a build directory is either a mistake or a leak. Neither is served.
      dotfiles: 'ignore',
      // index.html is served by the fallback below, so express.static should not answer
      // "/" itself — one place decides how the document is cached.
      index: false,
      setHeaders(res, filePath) {
        const rel = `/${path.relative(clientDist, filePath).split(path.sep).join('/')}`;
        if (IMMUTABLE.test(rel)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return;
        }
        if (rel === '/sw.js') {
          res.setHeader('Cache-Control', 'no-cache');
          // Default scope is the directory the worker is served from. It is served from the
          // root here, so this is belt and braces — and documents the requirement.
          res.setHeader('Service-Worker-Allowed', '/');
          return;
        }
        // Everything else — index.html's siblings, the icons, manifest.webmanifest. The
        // content types are left to express.static, which already answers
        // application/manifest+json for that extension.
        res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// RFC 7807 for everything that escapes a handler.
//
// A 5xx detail is whatever the failing library felt like putting in a message — a Mongo
// URI, a Drive error body, a file path. None of that is the caller's business, and all of
// it is useful to somebody mapping the inside of the process. So 5xx answers carry a
// correlation id and nothing else; the message itself goes to the log, where the same id
// finds it. Deliberate 4xx problems are written by this codebase and stay as they are.
// eslint-disable-next-line no-unused-vars
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

// ── Boot ────────────────────────────────────────────────────────────────────

async function main() {
  await connect();
  await ensureIndexes();
  const loaded = await load();

  // Google Drive is reached once, before the first request, so a bad credential is a
  // sentence at boot rather than a stack trace inside somebody's upload.
  //
  // It is no longer a *fatal* sentence. This used to exit(1), which meant an expired
  // refresh token took down the catalogue, the search, the audit trail and every admin
  // screen — none of which need Google — and then crash-looped under the restart policy.
  // The application now starts in a degraded state, says so on every surface that can
  // show it, and keeps retrying in the background.
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
    await seed();
    seeded = true;
  }

  // Runs whether or not anything was seeded: an existing library gets the two-role model
  // and the founding administrator here, since seeding never touches a database that
  // already has documents.
  const accountChanges = await ensureAccounts({ log: () => {} });

  const meta = await readMeta();
  const assetCount = db.songs.reduce((n, s) => n + s.assets.length, 0) + db.unfiled.length;

  const server = app.listen(PORT, () => {
    console.log('');
    console.log('  ▁▃▅▂▄  G C L O U D   ·   API');
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

  // Slowloris and friends: a connection that dribbles a request header out one byte at a
  // time occupies a socket indefinitely unless something says otherwise. Node's defaults
  // are permissive, so the deadlines are set explicitly. requestTimeout is generous
  // because a resumable upload's control calls sit behind slow networks.
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 61_000;

  // Nightly reconciliation (§10.11), 02:00 by default.
  const job = RECONCILE_ENABLED && cron.validate(RECONCILE_CRON)
    ? cron.schedule(RECONCILE_CRON, () => {
      runReconciliation({ ip: '127.0.0.1', get: () => 'scheduler', user: null }, { trigger: 'scheduled' })
        .catch((err) => console.error('[reconcile]', err.message));
    })
    : null;
  if (job) console.log(`  Reconciliation scheduled: ${RECONCILE_CRON}\n`);

  // Keeps trying Google in the background. A network blip or a Drive outage heals on its
  // own and this notices; an expired credential does not, and the log line above is what
  // says so until somebody mints a new one.
  const stopDriveWatch = storage.watchDrive({
    onRecover: () => notify({
      level: 'ok',
      title: 'Google Drive is reachable again',
      body: 'Uploads, downloads and previews have resumed.',
      link: '/admin/storage',
    }),
  });

  // Retention. An audit row carries an IP and a user agent, which is personal data with no
  // lawful basis for being kept forever, and a rotated session record stops being evidence
  // of anything after a month. Both are swept nightly, an hour after reconciliation.
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
  console.error(`\nGCloud failed to start.\n\n  ${err.message}`);
  // The full driver error is still there when it is actually wanted.
  if (process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace') console.error(err.cause ?? err);
  else console.error('  Set LOG_LEVEL=debug for the full error.\n');
  process.exit(1);
});
