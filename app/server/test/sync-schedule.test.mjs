// When the Drive mirror walks the whole tree, and when it only reads the
// changes feed. A separate file from sync.test.mjs because what matters here is
// what happens on the first pass after a boot, and a process only boots once.
//
// The rule: a restart is not a reason to walk. The last full walk is remembered
// in MongoDB beside the change token, and the tree is walked again only once
// that is older than DRIVE_SYNC_FULL_EVERY_HOURS — or when reconciliation hands
// over a listing it has just made, which counts as one.
import { test, before, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'sync-test-only-key-material-long-enough';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/sync-test-never-connected';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ASSETS_ROOT = 'root-assets';
const DAY = 86_400_000;

const db = { songs: [], unfiled: [], folders: [], activityLog: [], notifications: [] };
const meta = {
  driveChangeToken: 'token-stored',
  driveFullSyncAt: new Date(Date.now() - 2 * DAY).toISOString(),
};
const calls = { inventory: 0, changes: 0 };

mock.module('../src/db.js', {
  namedExports: {
    db,
    persist: () => {},
    flushNow: async () => ({ written: 0 }),
    readMeta: async () => ({ ...meta }),
    writeMeta: async (patch) => { Object.assign(meta, patch); },
    allAssets: () => [],
  },
});

mock.module('../src/storage/drive.js', {
  namedExports: {
    FOLDER_MIME,
    LISTING_FIELDS: 'id,name',
    isNotFound: () => false,
    listChanges: async () => { calls.changes += 1; return { changes: [], startPageToken: 'token-feed', pages: 1 }; },
    startPageToken: async () => 'token-walk',
    mapLimit: async (items, _n, fn) => Promise.all(items.map(fn)),
  },
});

mock.module('../src/services/storage.js', {
  namedExports: {
    driveReady: () => true,
    inventory: async () => { calls.inventory += 1; return { files: [], folders: [], pages: 1 }; },
    isBlockedType: () => false,
    isBlockedExtension: () => false,
    verifyAsset: async () => {},
    binding: (f) => ({ fileId: f.id, name: f.name, parentId: f.parents?.[0] ?? null, mimeType: f.mimeType }),
  },
});

mock.module('../src/services/audit.js', { namedExports: { record: () => ({}), notify: () => ({}) } });
mock.module('../src/services/vocabulary.js', {
  namedExports: {
    allTypes: () => [{ type: 'Master Audio', family: 'Audio' }],
    resolveFamily: () => 'Audio',
  },
});

let syncDrive;

before(async () => {
  const cfg = await import('../src/config.js');
  cfg.ROOTS.assets = ASSETS_ROOT;
  ({ syncDrive } = await import('../src/services/sync.js'));
});

test('walks the tree after a boot only when the last walk is overdue', async () => {
  const out = await syncDrive({ trigger: 'test', mode: 'auto' });
  assert.equal(out.mode, 'full', 'the stored walk is two days old');
  assert.equal(calls.inventory, 1);
  assert.ok(Date.now() - Date.parse(meta.driveFullSyncAt) < 60_000, 'the walk is remembered');
});

test('reads only the changes feed while the last walk is recent', async () => {
  const out = await syncDrive({ trigger: 'test', mode: 'auto' });
  assert.equal(out.mode, 'incremental');
  assert.equal(calls.inventory, 1, 'no second walk');
  assert.equal(calls.changes, 1);
});

test('uses a listing handed over by reconciliation instead of walking again', async () => {
  const listing = {
    files: [{ id: 'f-1', name: 'from-reconcile.wav', mimeType: 'audio/mpeg', parents: [ASSETS_ROOT], trashed: false }],
    folders: [],
    pages: 3,
    token: 'token-before-reconcile',
  };
  const out = await syncDrive({ trigger: 'reconcile', mode: 'full', inventory: listing });
  assert.equal(out.mode, 'full');
  assert.equal(out.listPages, 3);
  assert.equal(out.counts.filesAdopted, 1);
  assert.equal(calls.inventory, 1, 'Drive was not listed a second time');
  assert.equal(meta.driveChangeToken, 'token-before-reconcile', 'the feed resumes from before that listing');
});
