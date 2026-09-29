// Files and folders that arrived straight in Google Drive, the New badge they
// carry until somebody reviews them, and the cleanup of the folders earlier
// test runs left in the live Drive.
//
// Everything is seeded into the scratch database: the harness server cannot
// reach Drive, and the first case below proves it.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, start, stop } from './harness.mjs';

let admin;
let base;

const now = new Date().toISOString();

const folder = (id, name, extra = {}) => ({
  _id: id, name, description: '', tags: [], parentId: null, driveFolderId: null,
  driveWebViewLink: null, songId: null, artistId: null, createdBy: 'harness',
  createdAt: now, updatedAt: now, deletedAt: null, ...extra,
});

const asset = (id, name, extra = {}) => ({
  assetId: id, displayName: name, originalName: name, description: '',
  type: 'Master Audio', family: 'Audio', format: '', folderId: null,
  drive: {
    fileId: `drive-${id}`, name, parentId: null, driveId: null, path: name, revisionId: null,
    sizeBytes: 1024, md5: null, sha256: null, sha1: null, mimeType: 'audio/mpeg',
    webViewLink: null, thumbnailLink: null, trashed: false, googleNative: false,
    createdAt: now, modifiedAt: now, uploadedAt: now, durationSec: null, dimensions: null,
  },
  availability: { status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now, checkMethod: 'DRIVE_SYNC', detail: null },
  lastHead: null, versionGroupId: `vg_${id}`, version: 'V1', isCurrent: true, supersedes: null,
  mimeType: 'audio/mpeg', durationSec: null, dimensions: null, tags: ['Imported'],
  uploadedBy: 'system', createdAt: now, updatedAt: now, renamedAt: null, deletedAt: null,
  ...extra,
});

const FROM_DRIVE = { origin: 'DRIVE', reviewedAt: null, reviewedBy: null };

// What the suite used to leave in Drive, as the live sync adopted it: the name
// carries Date.now() from the moment the test created it.
const STAMP = 1790573744235;
const at = (ms) => new Date(ms).toISOString();

before(async () => {
  ({ base } = await start({
    seed: {
      folders: [
        folder('folder_drop', 'Dropped into Drive', { ...FROM_DRIVE, tags: ['Imported'] }),
        folder('folder_made_here', 'Made in the app'),
        folder('folder_legacy', 'Adopted before badges existed', { tags: ['Imported'] }),
        folder('folder_left_1', `Harness folder ${STAMP}`, { createdAt: at(STAMP + 900) }),
        folder('folder_left_2', `Harness tags one ${STAMP + 5000}`, {
          createdAt: at(STAMP + 5900), driveFolderId: 'drive-left-2',
        }),
        folder('folder_left_old', `Harness folder ${STAMP}`, { createdAt: at(STAMP - 10 * 86_400_000) }),
        folder('folder_left_full', `Harness tags two ${STAMP}`, { createdAt: at(STAMP) }),
        // One Drive folder adopted twice — two instances sharing the database.
        folder('folder_dup_a', `Harness tags three ${STAMP}`, { createdAt: at(STAMP + 7000), driveFolderId: 'drive-dup' }),
        folder('folder_dup_b', `Harness tags three ${STAMP}`, { createdAt: at(STAMP + 7000), driveFolderId: 'drive-dup' }),
        folder('folder_not_harness', `Harness folder for the ${STAMP} shoot`, { createdAt: at(STAMP) }),
      ],
      unfiled: [
        asset('a_drop_1', 'drop-one.mp3', { ...FROM_DRIVE, folderId: 'folder_drop' }),
        asset('a_drop_2', 'drop-two.mp3', { ...FROM_DRIVE, folderId: 'folder_drop' }),
        asset('a_drop_3', 'drop-three.mp3', { ...FROM_DRIVE }),
        asset('a_uploaded', 'uploaded.mp3', { tags: ['Promo'] }),
        asset('a_legacy', 'legacy-import.mp3'),
        asset('a_in_leftover', 'kept.mp3', { tags: ['Promo'], folderId: 'folder_left_full' }),
      ],
    },
  }));
  admin = client();
  assert.equal((await admin.signIn()).status, 200);
});

after(async () => { await stop(); });

describe('the test server is cut off from Google Drive', () => {
  test('it reports itself degraded rather than connected', async () => {
    const health = await fetch(`${base}/healthz`).then((r) => r.json());
    assert.equal(health.ok, false, 'a harness server must never have a working Drive');
    assert.equal(health.degraded, true);
  });

  test('creating a folder is refused instead of reaching Drive', async () => {
    const res = await admin.send('/api/folders', { method: 'POST', body: { name: `Harness folder ${Date.now()}` } });
    assert.equal(res.status, 503, 'POST /api/folders creates a real Drive folder when Drive is configured');
  });
});

describe('the New badge on things added straight to Drive', () => {
  test('marks what the sync adopted, and nothing else', async () => {
    const drop = await admin.send('/api/assets/a_drop_1');
    assert.equal(drop.body.awaitingReview, true);
    assert.equal(drop.body.origin, 'DRIVE');

    const uploaded = await admin.send('/api/assets/a_uploaded');
    assert.equal(uploaded.body.awaitingReview, false, 'a file uploaded through the app is not new from Drive');

    const legacy = await admin.send('/api/assets/a_legacy');
    assert.equal(legacy.body.awaitingReview, false, 'rows adopted before the badge existed are left alone');

    const folders = (await admin.send('/api/folders')).body.data;
    const flagged = folders.filter((f) => f.awaitingReview).map((f) => f._id);
    assert.deepEqual(flagged, ['folder_drop']);
  });

  test('search can narrow to them, and counts them', async () => {
    const res = await admin.send('/api/search?review=pending&limit=50');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((a) => a.assetId).sort(), ['a_drop_1', 'a_drop_2', 'a_drop_3']);
    assert.deepEqual(res.body.facets.review, [{ value: 'pending', count: 3 }]);
  });

  test('the folder list can narrow to them', async () => {
    const res = await admin.send('/api/folders?review=pending');
    assert.deepEqual(res.body.data.map((f) => f._id), ['folder_drop']);
  });

  test('the dashboard counts files and folders separately from missing bytes', async () => {
    const res = await admin.send('/api/dashboard');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.counts.fromDrive, { files: 3, folders: 1 });
  });

  test('saying a file is fine as it is takes the badge off', async () => {
    const res = await admin.send('/api/assets/review', { method: 'POST', body: { assetIds: ['a_drop_3', 'a_uploaded'] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.reviewed, 1, 'only the file that was waiting counts');
    assert.equal((await admin.send('/api/assets/a_drop_3')).body.awaitingReview, false);
  });

  test('an empty list is refused', async () => {
    const res = await admin.send('/api/assets/review', { method: 'POST', body: { assetIds: [] } });
    assert.equal(res.status, 422);
  });

  test('editing a file’s details counts as reviewing it', async () => {
    const res = await admin.send('/api/assets/a_drop_2', { method: 'PATCH', body: { tags: ['Promo'] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.awaitingReview, false);
    assert.ok(res.body.reviewedAt, 'when it was reviewed is kept');
  });

  test('moving a folder is filing it, not reviewing it', async () => {
    const res = await admin.send('/api/folders/folder_drop', { method: 'PATCH', body: { parentId: 'folder_made_here' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.parentId, 'folder_made_here');
    assert.equal(res.body.awaitingReview, true, 'the badge stays until its details are looked at');
  });

  test('a folder can be reviewed together with the files inside it', async () => {
    const res = await admin.send('/api/folders/folder_drop/review', { method: 'POST', body: { files: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.folderReviewed, true);
    assert.equal(res.body.filesReviewed, 1, 'a_drop_1 was the only file in it still waiting');
    assert.equal(res.body.awaitingReview, false);

    const left = await admin.send('/api/search?review=pending');
    assert.equal(left.body.total, 0);
    assert.deepEqual((await admin.send('/api/dashboard')).body.counts.fromDrive, { files: 0, folders: 0 });
  });
});

describe('folders the test suite left in the live Drive', () => {
  test('are recognised by exact name and creation time, and only when empty', async () => {
    const res = await admin.send('/api/admin/storage/test-leftovers');
    assert.equal(res.status, 200);
    assert.equal(res.body.driveChecked, false);

    const byId = Object.fromEntries(res.body.data.map((d) => [d.folderIds[0], d]));
    assert.ok(!byId.folder_not_harness, 'a name that merely starts the same way is not a leftover');
    assert.equal(byId.folder_left_1.blocked, null, 'empty, and created when its name says');
    assert.match(byId.folder_left_old.blocked, /not created when that name says/);
    assert.match(byId.folder_left_full.blocked, /Files are filed in it/);
    assert.match(byId.folder_left_2.blocked, /not reachable/, 'a Drive folder that cannot be checked is left alone');
    assert.deepEqual(byId.folder_dup_a.folderIds, ['folder_dup_a', 'folder_dup_b'], 'every row for one Drive folder is one entry');
    assert.equal(res.body.removable, 1);
  });

  test('nothing is removed while Drive cannot be reached', async () => {
    const res = await admin.send('/api/admin/storage/test-leftovers/remove', { method: 'POST' });
    assert.equal(res.status, 503);
    const still = await admin.send('/api/folders');
    assert.ok(still.body.data.some((f) => f._id === 'folder_left_1'), 'the library is untouched');
  });
});
