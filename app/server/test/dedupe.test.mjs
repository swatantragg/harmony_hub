// services/dedupe.js against a library held in memory, with no Mongo and no Drive.
//
// The "same media" tier compared every file with every later one in its family.
// Files without a running time — every audio file Drive adopted, every image and
// document — never reached the loop's early exit, so a library of a few thousand
// of them held the only thread for twenty seconds: long enough for the container
// health check to give up, and the proxy in front to answer "no available
// server". It now only compares files that could match. These pin both halves:
// it still finds what it found, and it no longer takes forever doing it.
import { test, before, mock } from 'node:test';
import assert from 'node:assert/strict';

// The thresholds are the defaults, whatever a local app/.env says.
process.env.GCLOUD_SKIP_DOTENV = '1';
process.env.JWT_SECRET ??= 'dedupe-test-only-key-material-long-enough';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/dedupe-test-never-connected';

let rows = [];

mock.module('../src/db.js', {
  namedExports: {
    db: { users: [], dedupeIgnores: [] },
    allAssets: () => rows,
  },
});

mock.module('../src/services/storage.js', {
  namedExports: { fingerprintOf: (drive) => drive?.sha256 || (drive?.md5 ? `md5:${drive.md5}` : null) },
});

let scan;
let perceptualDistance;
let hamming;

before(async () => {
  ({ scan, perceptualDistance, hamming } = await import('../src/services/dedupe.js'));
});

let n = 0;
const row = (family, { name, size = 1_000_000, duration = null, dimensions = null, type = family } = {}) => {
  n += 1;
  return {
    asset: {
      assetId: `a${n}`, displayName: name ?? `file ${n}`, family, type, durationSec: duration, dimensions,
      drive: { fileId: `f${n}`, sha256: `sum${n}`, sizeBytes: size }, tags: [], createdAt: '2026-01-01T00:00:00.000Z',
    },
    song: null, artist: null, folder: null,
  };
};

const sameMediaGroups = () =>
  scan({ level: 'near' }).groups.filter((g) => g.kind === 'SAME_MEDIA').map((g) => g.members.map((m) => m.displayName).sort());

test('documents of near-identical size and name are grouped; one out of tolerance is not', () => {
  rows = [
    row('Document', { name: 'Tum Hi Ho credits.pdf', size: 1_000_000 }),
    row('Document', { name: 'Tum Hi Ho credits copy.pdf', size: 1_010_000 }),
    row('Document', { name: 'Tum Hi Ho credits.pdf', size: 2_000_000 }),
  ];
  assert.deepEqual(sameMediaGroups(), [['Tum Hi Ho credits copy.pdf', 'Tum Hi Ho credits.pdf']]);
});

test('images are only grouped with images of the same dimensions', () => {
  rows = [
    row('Image', { name: 'Raat banner.jpg', dimensions: '1920×1080' }),
    row('Image', { name: 'Raat banner final.jpg', dimensions: '1920×1080' }),
    row('Image', { name: 'Raat banner.jpg', dimensions: '1080×1080' }),
    row('Image', { name: 'Raat banner.jpg' }),
  ];
  assert.deepEqual(sameMediaGroups(), [['Raat banner final.jpg', 'Raat banner.jpg']]);
});

test('audio and video are grouped on running time, and never without one', () => {
  rows = [
    row('Video', { name: 'Chand teaser.mp4', duration: 30, dimensions: '1920×1080' }),
    row('Video', { name: 'Chand teaser export.mp4', duration: 31, dimensions: '1920×1080' }),
    row('Video', { name: 'Chand teaser.mp4', duration: 90, dimensions: '1920×1080' }),
    row('Audio', { name: 'Chand master.wav' }),
    row('Audio', { name: 'Chand master.wav' }),
  ];
  assert.deepEqual(sameMediaGroups(), [['Chand teaser export.mp4', 'Chand teaser.mp4']]);
});

test('eight thousand files without a running time scan in seconds, not half a minute', () => {
  rows = [];
  for (let i = 0; i < 4000; i += 1) rows.push(row('Audio', { name: `Yaad song ${i % 50} take ${i}.wav`, size: 1_000_000 + i }));
  for (let i = 0; i < 4000; i += 1) rows.push(row('Document', { name: `Sheet ${i % 50} part ${i}.pdf`, size: 1_000_000 + i * 997 }));
  const started = performance.now();
  scan({ level: 'near' });
  const ms = performance.now() - started;
  // Was ~20 s for this shape. The bound is generous so a slow CI box does not flake.
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
});

test('the perceptual distance counts the same bits as the BigInt comparison it replaced', () => {
  const pairs = [
    ['0000000000000000', 'ffffffffffffffff'],
    ['8000000000000001', '0000000000000000'],
    ['0123456789abcdef', 'fedcba9876543210'],
    ['ffffffff00000000', '00000000ffffffff'],
  ];
  for (const [a, b] of pairs) assert.equal(perceptualDistance({ frames: [a] }, { frames: [b] }), hamming(a, b), `${a} ^ ${b}`);
});
