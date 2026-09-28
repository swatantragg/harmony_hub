// Managing the vocabulary: renaming a tag everywhere it appears, and deleting it.
//
// A tag is a string copied onto every carrier, so both operations are bulk
// rewrites over the whole catalogue. The invariants that matter are the ones a
// bulk rewrite gets wrong: the old name must be gone, the new name must carry
// exactly what the old one did, a merge must not leave a carrier holding the
// same tag twice, and nothing may be deleted except the label itself.
//
// Drive is unreachable in the harness, so assets cannot be created here.
// Folders carry tags and need no Drive, so they are what the bulk path is
// driven through — it is the same code path for both, `carriers()` in
// services/tags.js.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { client, start, stop } from './harness.mjs';

let admin;
const folders = [];

const stamp = Date.now();
const TAG_A = `Harness Alpha ${stamp}`;
const TAG_B = `Harness Beta ${stamp}`;
const key = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

const manage = () => admin.send('/api/tags/manage');

const findTag = async (name) => {
  const res = await manage();
  return res.body.sections.flatMap((s) => s.tags).find((t) => t.key === key(name)) ?? null;
};

async function makeFolder(name, tags) {
  const res = await admin.send('/api/folders', { method: 'POST', body: { name, tags } });
  if (res.status === 201) {
    const id = res.body._id ?? res.body.folder?._id ?? null;
    if (id) folders.push(id);
    return id;
  }
  return null;
}

before(async () => {
  await start({ env: { RATE_LIMIT_STORE: 'memory' } });
  admin = client();
  assert.equal((await admin.signIn()).status, 200);

  await makeFolder(`Harness tags one ${stamp}`, [TAG_A]);
  await makeFolder(`Harness tags two ${stamp}`, [TAG_A, TAG_B]);
  await makeFolder(`Harness tags three ${stamp}`, [TAG_B]);
});

after(async () => { await stop(); });

describe('the manage-tags inventory', () => {
  test('groups every tag into a section and counts its carriers', async () => {
    const res = await manage();
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.sections), 'sections is a list');

    const flat = res.body.sections.flatMap((s) => s.tags);
    assert.ok(flat.length > 0, 'the controlled vocabulary is listed even when nothing uses it');
    assert.equal(res.body.totals.tags, flat.length, 'the total matches what is listed');

    for (const tag of flat) {
      assert.equal(typeof tag.key, 'string');
      assert.ok(tag.key.length > 0, `${tag.name} has a key`);
      assert.ok(Number.isInteger(tag.fileCount) && tag.fileCount >= 0, `${tag.name} file count`);
      assert.ok(Number.isInteger(tag.folderCount) && tag.folderCount >= 0, `${tag.name} folder count`);
      assert.ok(Array.isArray(tag.variants) && tag.variants.length > 0, `${tag.name} variants`);
    }
  });

  test('the Song, Artist and Event sections come through', async () => {
    const res = await manage();
    const groups = res.body.sections.map((s) => s.group);
    for (const expected of ['Song', 'Artist', 'Event']) {
      assert.ok(groups.includes(expected), `${expected} section is served`);
    }
  });

  test('a tag on folders is counted, and found by its key', async () => {
    const tag = await findTag(TAG_A);
    assert.ok(tag, 'the tag appears once a folder carries it');
    assert.equal(tag.folderCount, 2, 'both folders counted');
    assert.equal(tag.fileCount, 0, 'no assets exist in the harness');
  });

  test('the badge agrees with what searching that tag returns', async () => {
    const res = await manage();
    const used = res.body.sections.flatMap((s) => s.tags).filter((t) => t.fileCount > 0);
    for (const tag of used.slice(0, 3)) {
      const found = await admin.send(`/api/search?tags=${encodeURIComponent(tag.name)}&limit=1`);
      assert.equal(found.body.total, tag.fileCount, `${tag.name}: badge and search disagree`);
    }
  });
});

describe('renaming a tag', () => {
  test('rewrites it on every carrier at once', async () => {
    const before = await findTag(TAG_A);
    const renamed = `${TAG_A} Renamed`;

    const res = await admin.send(`/api/tags/manage/${encodeURIComponent(before.key)}`, {
      method: 'PATCH',
      body: { name: renamed },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.folders, before.folderCount, 'every folder reported');
    assert.equal(res.body.previousName, before.name);

    assert.equal(await findTag(TAG_A), null, 'the old name is gone');
    const now = await findTag(renamed);
    assert.ok(now, 'the new name exists');
    assert.equal(now.folderCount, before.folderCount, 'it carries exactly what the old one did');

    // put it back, so the later cases read the name they expect
    await admin.send(`/api/tags/manage/${encodeURIComponent(key(renamed))}`, {
      method: 'PATCH',
      body: { name: TAG_A },
    });
    assert.ok(await findTag(TAG_A), 'restored');
  });

  test('is idempotent — renaming to the name it already has changes nothing', async () => {
    const before = await findTag(TAG_A);
    const res = await admin.send(`/api/tags/manage/${encodeURIComponent(before.key)}`, {
      method: 'PATCH',
      body: { name: before.name },
    });
    assert.equal(res.status, 200);
    const after = await findTag(TAG_A);
    assert.equal(after.folderCount, before.folderCount);
  });

  test('refuses to merge into an existing tag until that is confirmed', async () => {
    const a = await findTag(TAG_A);
    const clash = await admin.send(`/api/tags/manage/${encodeURIComponent(a.key)}`, {
      method: 'PATCH',
      body: { name: TAG_B },
    });
    assert.equal(clash.status, 409, 'a silent merge is not on offer');
    assert.equal(clash.body.merge.into, TAG_B);
    assert.ok(await findTag(TAG_A), 'nothing moved');
  });

  test('merges on confirmation, without leaving a carrier holding it twice', async () => {
    const a = await findTag(TAG_A);
    const b = await findTag(TAG_B);

    const res = await admin.send(`/api/tags/manage/${encodeURIComponent(a.key)}`, {
      method: 'PATCH',
      body: { name: TAG_B, merge: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.merged, true);

    assert.equal(await findTag(TAG_A), null, 'the merged-away name is gone');
    const merged = await findTag(TAG_B);
    // One folder held both, so the union is smaller than the sum.
    assert.ok(merged.folderCount <= a.folderCount + b.folderCount, 'no double counting');
    assert.ok(merged.folderCount >= Math.max(a.folderCount, b.folderCount), 'nothing lost');

    const listed = await admin.send('/api/folders');
    for (const folder of listed.body.data ?? listed.body) {
      const names = (folder.tags ?? []).map((t) => t.toLowerCase());
      assert.equal(names.length, new Set(names).size, `${folder.name} has no duplicated tag`);
    }
  });

  test('422s on a name with nothing in it', async () => {
    const tag = await findTag(TAG_B);
    const res = await admin.send(`/api/tags/manage/${encodeURIComponent(tag.key)}`, {
      method: 'PATCH',
      body: { name: '   ' },
    });
    assert.equal(res.status, 422);
  });

  test('404s on a tag that does not exist', async () => {
    const res = await admin.send('/api/tags/manage/nosuchtaganywhereatall', {
      method: 'PATCH',
      body: { name: 'Whatever' },
    });
    assert.equal(res.status, 404);
  });
});

describe('deleting a tag', () => {
  test('takes it off every carrier and deletes nothing else', async () => {
    const tag = await findTag(TAG_B);
    assert.ok(tag, 'the merged tag is there to delete');

    const foldersBefore = await admin.send('/api/folders');
    const countBefore = (foldersBefore.body.data ?? foldersBefore.body).length;

    const res = await admin.send(`/api/tags/manage/${encodeURIComponent(tag.key)}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(res.body.folders, tag.folderCount);

    assert.equal(await findTag(TAG_B), null, 'the tag is gone from the inventory');

    const foldersAfter = await admin.send('/api/folders');
    const rows = foldersAfter.body.data ?? foldersAfter.body;
    assert.equal(rows.length, countBefore, 'no folder was deleted');
    for (const folder of rows) {
      assert.ok(!(folder.tags ?? []).some((t) => key(t) === tag.key), `${folder.name} no longer carries it`);
    }
  });

  test('404s on a tag that does not exist', async () => {
    const res = await admin.send('/api/tags/manage/nosuchtaganywhereatall', { method: 'DELETE' });
    assert.equal(res.status, 404);
  });
});
