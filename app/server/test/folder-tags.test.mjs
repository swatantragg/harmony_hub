// Tagging a folder, and choosing whether its files get the same tags.
//
// Folder tags used to stay on the folder. A folder dropped into Drive arrives
// full of files, and tagging it left every one of them untagged — so editing a
// folder now asks where the tags go: the folder alone, its files too, or every
// file down through its subfolders. Seeded, because the harness has no Drive.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, start, stop } from './harness.mjs';

let admin;
const now = new Date().toISOString();

const folder = (id, name, extra = {}) => ({
  _id: id, name, description: '', tags: ['Imported'], parentId: null, driveFolderId: null,
  driveWebViewLink: null, songId: null, artistId: null, createdBy: 'harness',
  createdAt: now, updatedAt: now, deletedAt: null, ...extra,
});

const asset = (id, folderId, tags, extra = {}) => ({
  assetId: id, displayName: `${id}.mp3`, originalName: `${id}.mp3`, description: '',
  type: 'Master Audio', family: 'Audio', format: '', folderId,
  drive: {
    fileId: `drive-${id}`, name: `${id}.mp3`, parentId: null, driveId: null, path: null, revisionId: null,
    sizeBytes: 1024, md5: null, sha256: null, sha1: null, mimeType: 'audio/mpeg', webViewLink: null,
    thumbnailLink: null, trashed: false, googleNative: false, createdAt: now, modifiedAt: now,
    uploadedAt: now, durationSec: null, dimensions: null,
  },
  availability: { status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now, checkMethod: 'DRIVE_SYNC', detail: null },
  lastHead: null, versionGroupId: `vg_${id}`, version: 'V1', isCurrent: true, supersedes: null,
  mimeType: 'audio/mpeg', durationSec: null, dimensions: null, tags,
  uploadedBy: 'system', createdAt: now, updatedAt: now, renamedAt: null, deletedAt: null, ...extra,
});

const tagsOf = async (id) => (await admin.send(`/api/assets/${id}`)).body.tags;
const edit = (body) => admin.send('/api/folders/folder_top', { method: 'PATCH', body });

before(async () => {
  await start({
    seed: {
      folders: [
        folder('folder_top', 'Dropped in Drive', { origin: 'DRIVE', reviewedAt: null }),
        folder('folder_inner', 'Stems', { parentId: 'folder_top' }),
      ],
      unfiled: [
        asset('top_1', 'folder_top', ['Imported'], { origin: 'DRIVE', reviewedAt: null }),
        asset('top_2', 'folder_top', ['Imported', 'Sad']),
        asset('inner_1', 'folder_inner', ['Imported']),
      ],
    },
  });
  admin = client();
  assert.equal((await admin.signIn()).status, 200);
});

after(async () => { await stop(); });

describe('editing a folder’s tags', () => {
  test('by default only the folder changes', async () => {
    const res = await edit({ tags: ['Imported', 'Promo'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.tagScope, 'folder');
    assert.equal(res.body.filesTagged, 0);
    assert.deepEqual(await tagsOf('top_1'), ['Imported']);
  });

  test('can carry the change onto the files directly inside', async () => {
    const res = await edit({ tags: ['Promo', 'Romantic'], tagScope: 'files' });
    assert.equal(res.status, 200);
    assert.equal(res.body.filesTagged, 2);
    assert.deepEqual(await tagsOf('top_1'), ['Promo', 'Romantic'], 'the tag taken off the folder comes off the file');
    assert.deepEqual(await tagsOf('top_2'), ['Sad', 'Promo', 'Romantic'], 'a tag only the file had stays');
    assert.deepEqual(await tagsOf('inner_1'), ['Imported'], 'a subfolder is not reached');
  });

  test('a file from Drive tagged this way is reviewed', async () => {
    assert.equal((await admin.send('/api/assets/top_1')).body.awaitingReview, false);
  });

  test('can reach every file in its subfolders as well', async () => {
    const res = await edit({ tags: ['Promo', 'Romantic'], tagScope: 'tree' });
    assert.equal(res.status, 200);
    assert.equal(res.body.filesTagged, 1, 'only the file that was missing them changes');
    assert.deepEqual(await tagsOf('inner_1'), ['Imported', 'Promo', 'Romantic']);
  });

  test('never repeats a tag under another spelling', async () => {
    await edit({ tags: ['promo', 'Romantic'], tagScope: 'files' });
    const tags = await tagsOf('top_2');
    assert.equal(tags.filter((t) => t.toLowerCase() === 'promo').length, 1, tags.join(', '));
  });

  test('refuses a scope it does not know', async () => {
    const res = await edit({ tags: ['Promo'], tagScope: 'everything' });
    assert.equal(res.status, 422);
  });

  test('counts the folder’s files that are still new from Drive', async () => {
    const res = await admin.send('/api/folders?parentId=root');
    const top = res.body.data.find((f) => f._id === 'folder_top');
    assert.equal(top.newFileCount, 0, 'the one new file was reviewed when it was tagged');
    assert.equal(top.awaitingReview, false, 'so was the folder');
  });
});
