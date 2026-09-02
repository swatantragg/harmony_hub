// Exercises services/sync.js against a fake Drive, with no Mongo and no network.
//
// The scenario is the one that was reported: files and folders put into the
// Drive folder from outside the app, which the library could not see because
// nothing ever wrote them a catalogue row. Unlike the rest of test/, this does
// not boot the server — the mirror is pure logic over an inventory, and the
// bugs worth catching here are in that logic, not in the wiring.
//
// namedExports is deprecated in favour of exports; kept until the Node the
// project pins settles on one.
import { test, before, mock } from 'node:test';
import assert from 'node:assert/strict';

// config.js validates the environment on import and exits the process when
// something required is missing. On a developer machine app/.env supplies those
// and nobody notices; CI has no .env, so without this the file died at import
// and took the whole test job with it. Nothing here connects anywhere — the
// values only have to satisfy the schema.
process.env.JWT_SECRET ??= 'sync-test-only-key-material-long-enough';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/sync-test-never-connected';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ASSETS_ROOT = 'root-assets';

let drive = { files: [], folders: [] };
const db = { songs: [], unfiled: [], folders: [], activityLog: [], notifications: [] };
let persisted = 0;

mock.module('../src/db.js', {
  namedExports: {
    db,
    persist: () => { persisted += 1; },
    readMeta: async () => ({}),
    writeMeta: async () => {},
    allAssets: () => [],
  },
});

mock.module('../src/storage/drive.js', {
  namedExports: {
    FOLDER_MIME,
    isNotFound: (e) => e?.status === 404,
    listChanges: async () => { throw new Error('incremental not used in these tests'); },
    startPageToken: async () => 'token-1',
    mapLimit: async (items, _n, fn) => Promise.all(items.map(fn)),
  },
});

mock.module('../src/services/storage.js', {
  namedExports: {
    driveReady: () => true,
    inventory: async () => ({ files: drive.files, folders: drive.folders, pages: 1 }),
    isBlockedType: (m) => /x-msdownload/.test(m || ''),
    isBlockedExtension: (n) => /\.exe$/.test(n || ''),
    verifyAsset: async (a) => { a.availability = { ...a.availability, status: 'MISSING' }; },
    binding: (f, { path = null } = {}) => ({
      fileId: f.id, name: f.name, parentId: f.parents?.[0] ?? null, path,
      sizeBytes: f.size == null ? 0 : Number(f.size),
      md5: f.md5Checksum ?? null, sha256: f.sha256Checksum ?? null,
      mimeType: f.mimeType || 'application/octet-stream',
      webViewLink: f.webViewLink ?? null, trashed: Boolean(f.trashed),
      googleNative: false, createdAt: f.createdTime ?? null, modifiedAt: null,
      durationSec: null, dimensions: null, appProperties: f.appProperties || {},
    }),
  },
});

mock.module('../src/services/audit.js', { namedExports: { record: () => ({}), notify: () => ({}) } });

mock.module('../src/services/vocabulary.js', {
  namedExports: {
    allTypes: () => [
      { type: 'Master Audio', family: 'Audio' },
      { type: 'Banner Image', family: 'Image' },
      { type: 'Credits / Metadata Sheet', family: 'Document' },
    ],
    resolveFamily: (t) => (t === 'Master Audio' ? 'Audio' : 'Document'),
  },
});

let syncDrive;

before(async () => {
  const cfg = await import('../src/config.js');
  cfg.ROOTS.assets = ASSETS_ROOT;
  ({ syncDrive } = await import('../src/services/sync.js'));
});

const file = (id, name, parent, extra = {}) => ({
  id, name, mimeType: 'audio/mpeg', parents: [parent], size: '1024',
  md5Checksum: `md5-${id}`, trashed: false, createdTime: '2026-09-01T00:00:00.000Z', ...extra,
});
const folder = (id, name, parent) => ({
  id, name, mimeType: FOLDER_MIME, parents: [parent], trashed: false,
  webViewLink: `https://drive/${id}`,
});

test('adopts a nested folder tree dropped straight into Drive', async () => {
  drive = {
    folders: [folder('d-album', 'Album Masters', ASSETS_ROOT), folder('d-stems', 'Stems', 'd-album')],
    files: [file('f-1', 'title-track.wav', 'd-album'), file('f-2', 'vocal.wav', 'd-stems')],
  };

  const out = await syncDrive({ trigger: 'test', mode: 'full' });

  assert.equal(out.counts.foldersAdopted, 2);
  assert.equal(out.counts.filesAdopted, 2);

  const album = db.folders.find((f) => f.driveFolderId === 'd-album');
  const stems = db.folders.find((f) => f.driveFolderId === 'd-stems');
  assert.equal(album.parentId, null, 'a folder at the assets root has no catalogue parent');
  assert.equal(stems.parentId, album._id, 'nesting survives the two-pass link');

  const vocal = db.unfiled.find((a) => a.drive.fileId === 'f-2');
  assert.equal(vocal.folderId, stems._id, 'the file lands in its own folder, not the root');
  assert.equal(vocal.availability.status, 'AVAILABLE');
  assert.equal(vocal.drive.path, 'Stems/vocal.wav');
  assert.ok(persisted > 0, 'the new rows were written');
});

test('a second run over the same drive changes nothing', async () => {
  const out = await syncDrive({ trigger: 'test', mode: 'full' });
  assert.equal(out.changed, 0, 'sync is idempotent — no duplicate rows on every poll');
  assert.equal(db.unfiled.length, 2);
  assert.equal(db.folders.length, 2);
});

test('follows a rename and a move made in Drive', async () => {
  drive.files[1] = file('f-2', 'lead-vocal.wav', 'd-album');

  const out = await syncDrive({ trigger: 'test', mode: 'full' });

  const album = db.folders.find((f) => f.driveFolderId === 'd-album');
  const vocal = db.unfiled.find((a) => a.drive.fileId === 'f-2');
  assert.equal(out.counts.renamed, 1);
  assert.equal(out.counts.refiled, 1);
  assert.equal(vocal.displayName, 'lead-vocal.wav');
  assert.equal(vocal.folderId, album._id);
});

test('follows a folder renamed in Drive', async () => {
  drive.folders[1] = folder('d-stems', 'Raw Stems', 'd-album');
  const out = await syncDrive({ trigger: 'test', mode: 'full' });
  assert.equal(out.counts.foldersRenamed, 1);
  assert.equal(db.folders.find((f) => f.driveFolderId === 'd-stems').name, 'Raw Stems');
});

test('a trashed file is flagged, never dropped', async () => {
  drive.files[0] = file('f-1', 'title-track.wav', 'd-album', { trashed: true });

  await syncDrive({ trigger: 'test', mode: 'full' });

  const track = db.unfiled.find((a) => a.drive.fileId === 'f-1');
  assert.equal(track.availability.status, 'TRASHED');
  assert.equal(db.unfiled.length, 2, 'the catalogue row and its tags survive');
});

test('restores a file taken back out of the trash', async () => {
  drive.files[0] = file('f-1', 'title-track.wav', 'd-album');
  const out = await syncDrive({ trigger: 'test', mode: 'full' });
  assert.equal(out.counts.restored, 1);
  assert.equal(db.unfiled.find((a) => a.drive.fileId === 'f-1').availability.status, 'AVAILABLE');
});

test('refuses to adopt a blocked file type', async () => {
  drive.files.push(file('f-bad', 'installer.exe', 'd-album', { mimeType: 'application/x-msdownload' }));
  const out = await syncDrive({ trigger: 'test', mode: 'full' });
  assert.equal(out.counts.filesAdopted, 0);
  assert.equal(out.skipped.blocked, 1);
});

test('confirms a vanished file with a live probe before calling it missing', async () => {
  drive.files = drive.files.filter((f) => f.id !== 'f-2');
  const out = await syncDrive({ trigger: 'test', mode: 'full' });
  assert.equal(out.counts.missing, 1);
  assert.equal(db.unfiled.find((a) => a.drive.fileId === 'f-2').availability.status, 'MISSING');
  assert.equal(db.unfiled.length, 2, 'nothing is ever deleted from the catalogue');
});
