// The counts every folder listing carries: files directly inside, files all the
// way down, bytes, subfolders, and the path shown in the folder pickers.
//
// These used to be worked out by rebuilding the whole catalogue once or twice
// per folder, which at 2k folders took seconds a request and ran the server out
// of memory. They are now read off one index per request, and this pins them to
// the answers the slow version gave. Seeded, because the harness has no Drive.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, start, stop } from './harness.mjs';

let admin;
const now = new Date().toISOString();

const folder = (id, name, extra = {}) => ({
  _id: id, name, description: '', tags: [], parentId: null, driveFolderId: null,
  driveWebViewLink: null, songId: null, artistId: null, createdBy: 'harness',
  createdAt: now, updatedAt: now, deletedAt: null, ...extra,
});

const asset = (id, folderId, sizeBytes, extra = {}) => ({
  assetId: id, displayName: `${id}.mp3`, originalName: `${id}.mp3`, description: '',
  type: 'Master Audio', family: 'Audio', format: '', folderId,
  drive: {
    fileId: `drive-${id}`, name: `${id}.mp3`, parentId: null, driveId: null, path: null, revisionId: null,
    sizeBytes, md5: null, sha256: null, sha1: null, mimeType: 'audio/mpeg', webViewLink: null,
    thumbnailLink: null, trashed: false, googleNative: false, createdAt: now, modifiedAt: now,
    uploadedAt: now, durationSec: null, dimensions: null,
  },
  availability: { status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now, checkMethod: 'DRIVE_SYNC', detail: null },
  lastHead: null, versionGroupId: `vg_${id}`, version: 'V1', isCurrent: true, supersedes: null,
  mimeType: 'audio/mpeg', durationSec: null, dimensions: null, tags: [],
  uploadedBy: 'system', createdAt: now, updatedAt: now, renamedAt: null, deletedAt: null, ...extra,
});

before(async () => {
  await start({
    seed: {
      folders: [
        folder('folder_top', 'Launch'),
        folder('folder_mid', 'Video', { parentId: 'folder_top' }),
        folder('folder_leaf', 'Cuts', { parentId: 'folder_mid' }),
        folder('folder_gone', 'Deleted', { parentId: 'folder_top', deletedAt: now }),
        folder('folder_other', 'Other'),
      ],
      unfiled: [
        asset('top_1', 'folder_top', 100),
        asset('top_2', 'folder_top', 200, { availability: { status: 'MISSING' } }),
        asset('top_deleted', 'folder_top', 5000, { deletedAt: now }),
        asset('mid_1', 'folder_mid', 10),
        asset('leaf_1', 'folder_leaf', 1),
        asset('leaf_2', 'folder_leaf', 2),
        asset('in_gone', 'folder_gone', 7000),
        asset('loose', null, 9),
      ],
    },
  });
  admin = client();
  assert.equal((await admin.signIn()).status, 200);
});

after(async () => { await stop(); });

describe('folder counts', () => {
  test('a listing counts files inside, and all the way down', async () => {
    const res = await admin.send('/api/folders?parentId=root');
    assert.equal(res.status, 200);
    const top = res.body.data.find((f) => f._id === 'folder_top');
    assert.equal(top.assetCount, 2, 'the deleted file is not counted');
    assert.equal(top.totalBytes, 300);
    assert.deepEqual(top.byStatus, { AVAILABLE: 1, MISSING: 1 });
    assert.equal(top.needsAttention, 1);
    assert.equal(top.subfolderCount, 1, 'the deleted subfolder is not counted');
    assert.equal(top.totalAssetCount, 5, 'two here, one in Video, two in Cuts — nothing from the deleted folder');
    assert.equal(top.totalBytesDeep, 313);
    assert.equal(res.body.data.find((f) => f._id === 'folder_other').totalAssetCount, 0);
  });

  test('one folder, with its subfolders decorated the same way', async () => {
    const res = await admin.send('/api/folders/folder_mid');
    assert.equal(res.status, 200);
    assert.equal(res.body.parentName, 'Launch');
    assert.equal(res.body.assetCount, 1);
    assert.equal(res.body.totalAssetCount, 3);
    assert.deepEqual(res.body.assets.map((a) => a.assetId), ['mid_1']);
    assert.deepEqual(res.body.breadcrumb.map((b) => b._id), ['folder_top', 'folder_mid']);
    assert.deepEqual(res.body.subfolders.map((f) => [f._id, f.assetCount, f.totalAssetCount]), [['folder_leaf', 2, 2]]);
  });

  test('the picker options carry path, depth and a direct count', async () => {
    const res = await admin.send('/api/folders/lookup/options');
    assert.equal(res.status, 200);
    const leaf = res.body.find((f) => f._id === 'folder_leaf');
    assert.equal(leaf.path, 'Launch / Video / Cuts');
    assert.equal(leaf.depth, 2);
    assert.equal(leaf.assetCount, 2);
    assert.equal(res.body.some((f) => f._id === 'folder_gone'), false);
  });

  test('the tree nests live folders by name, each with its direct count', async () => {
    const res = await admin.send('/api/folders/lookup/tree');
    assert.equal(res.status, 200);
    const names = (nodes) => nodes.map((n) => n.name);
    assert.deepEqual(names(res.body.root.children), ['Launch', 'Other']);
    const [launch] = res.body.root.children;
    assert.equal(launch.assetCount, 2);
    assert.deepEqual(names(launch.children), ['Video']);
    assert.equal(launch.children[0].children[0].assetCount, 2);
  });
});
