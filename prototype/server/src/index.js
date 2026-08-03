// GCloud API — Express bootstrap.
//
// Two surfaces run in this process, and the separation is deliberate:
//   /api/*  the control plane. JSON only. Never carries a file byte.
//   /s3/*   the storage endpoint. Presigned-signature auth only, exactly like Amazon S3.
//
// In the deployed architecture the second surface IS Amazon S3, reached directly by the
// browser. Here it is emulated on disk so the prototype runs with no AWS account, while
// every upload and download still travels the browser↔storage path rather than through
// the API (P2).
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';

import { PORT, BUCKETS, PATHS, ROOT } from './config.js';
import { db } from './db.js';
import { ensureSeeded } from './seed.js';
import { s3Router } from './s3/routes.js';
import { authRouter, meRouter } from './routes/auth.js';
import { assetsRouter } from './routes/assets.js';
import { searchRouter } from './routes/search.js';
import { artistsRouter, songsRouter, tagsRouter, typesRouter } from './routes/catalogue.js';
import { foldersRouter } from './routes/folders.js';
import { uploadsRouter } from './routes/uploads.js';
import { sharesRouter, publicShareRouter } from './routes/shares.js';
import { adminRouter, notificationsRouter } from './routes/admin.js';
import { dashboardRouter } from './routes/dashboard.js';
import { runReconciliation } from './services/reconcile.js';

const { seeded, stats } = ensureSeeded({ force: process.argv.includes('--reseed') });

const app = express();
app.set('trust proxy', true);
app.use(cors({ exposedHeaders: ['ETag'] }));

// The storage endpoint is mounted BEFORE the JSON body parser — it deals in raw bytes.
app.use('/s3', s3Router);

app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api/auth', authRouter);
app.use('/api/me', meRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/artists', artistsRouter);
app.use('/api/songs', songsRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/search', searchRouter);
app.use('/api/tags', tagsRouter);
app.use('/api/asset-types', typesRouter);
app.use('/api/folders', foldersRouter);
app.use('/api/shares', sharesRouter);
app.use('/api/s', publicShareRouter);
app.use('/api/admin', adminRouter);
app.use('/api/notifications', notificationsRouter);

// Reset the demo library to its seeded state — handy when showing the prototype.
app.post('/api/demo/reset', (_req, res) => {
  const out = ensureSeeded({ force: true });
  res.json({ ok: true, ...out });
});

app.use('/api', (_req, res) =>
  res.status(404).type('application/problem+json').json({
    type: 'https://gcloud.internal/problems/not-found',
    title: 'Not Found', status: 404, detail: 'No such endpoint.',
  }),
);

// Serve the built client if one exists, so `npm start` alone runs the whole product.
const clientDist = path.resolve(ROOT, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).type('application/problem+json').json({
    type: 'https://gcloud.internal/problems/internal',
    title: 'Internal Server Error', status: 500, detail: err.message,
  });
});

app.listen(PORT, () => {
  const assetCount = db.songs.reduce((n, s) => n + s.assets.length, 0) + db.unfiled.length;
  console.log('');
  console.log('  ▁▃▅▂▄  G C L O U D   ·   API');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  API          http://localhost:${PORT}/api`);
  console.log(`  Storage      http://localhost:${PORT}/s3   (presigned access only)`);
  console.log(`  Buckets      ${Object.values(BUCKETS).join(', ')}`);
  console.log(`  Library      ${db.artists.length} artists · ${db.songs.length} songs · ${db.folders.length} folders · ${assetCount} assets`);
  console.log(`  Data         ${path.relative(process.cwd(), PATHS.data)}`);
  if (seeded) console.log(`  Seeded       ${JSON.stringify(stats)}`);
  console.log('  ─────────────────────────────────────────────');
  console.log('  Sign in with any of: admin@ / editor@ / marketing@ / viewer@gcloud.app');
  console.log('  Password: gcloud');
  console.log('');

  // Nightly reconciliation at 02:00 (§10.11), stood in for here by a long interval.
  // The seed writes an inventory-only run so Storage Health is populated on first open;
  // this scheduled pass is the one that also refreshes every availability block.
  const req0 = { ip: '127.0.0.1', get: () => 'scheduler', user: null };
  setInterval(() => runReconciliation(req0, { trigger: 'scheduled' }), 6 * 60 * 60 * 1000);
});
