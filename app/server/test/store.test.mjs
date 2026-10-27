// db/store.js against a scratch MongoDB: what a flush writes, deletes and
// remembers, and that a reload gives back exactly the working set it saved.
//
// The snapshot a flush compares against holds a hash per row rather than the
// row's JSON, and writes go out in batches. Neither may change what lands in
// Mongo — and an edit made while a write is in flight must still be written,
// which the old snapshot, rebuilt after the await, quietly got wrong.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

const TEST_MONGO = process.env.TEST_MONGODB_URI
  || 'mongodb://gcloud:gcloud@127.0.0.1:27017/?authSource=admin';

// config.js validates the environment on import; nothing here reads app/.env.
process.env.GCLOUD_SKIP_DOTENV = '1';
process.env.JWT_SECRET ??= 'store-test-only-key-material-long-enough';
process.env.MONGODB_URI = TEST_MONGO;
process.env.MONGODB_DB = `gcloudtest_store_${Date.now()}`;

const { connect, disconnect } = await import('../src/db/mongo.js');
const { models } = await import('../src/db/models.js');
const store = await import('../src/db/store.js');

let conn;
const raw = (name) => conn.db.collection(name);
const { db } = store;

before(async () => {
  conn = await connect({ attempts: 1 });
  await raw('unfiled').insertMany(Array.from({ length: 1200 }, (_, i) => ({
    _id: `a${i}`, assetId: `a${i}`, displayName: `File ${i}`, tags: ['x'], _seq: i,
  })));
  await raw('folders').insertMany(Array.from({ length: 50 }, (_, i) => ({ _id: `f${i}`, name: `Folder ${i}`, _seq: i })));
  await raw('activityLog').insertMany(Array.from({ length: 10 }, (_, i) => ({
    _id: `e${i}`, action: 'X', timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  })));
  await store.load();
});

after(async () => {
  await conn.dropDatabase().catch(() => null);
  await disconnect();
});

test('loads rows without the storage-only fields', async () => {
  assert.equal(db.unfiled.length, 1200);
  assert.equal(db.unfiled[0]._id, undefined, 'unfiled is keyed by assetId');
  assert.equal(db.unfiled[0]._seq, undefined);
  assert.equal(db.folders[0]._id, 'f0');
  assert.equal(db.folders[0]._seq, undefined);
  assert.equal((await store.flushNow()).written, 0, 'nothing has changed yet');
});

test('writes edits, additions, removals and reordering — then nothing twice', async () => {
  for (const a of db.unfiled) a.displayName += ' (edited)'; // more than one write batch
  db.unfiled.splice(10, 3);
  db.unfiled.push({ assetId: 'new1', displayName: 'New 1', tags: [] });
  db.folders.unshift({ _id: 'fnew', name: 'Brand new' }); // every folder's _seq moves
  db.activityLog.unshift({ _id: 'e-new', action: 'Y', timestamp: '2027-01-01T00:00:00.000Z' });

  assert.ok((await store.flushNow()).written > 1200);
  assert.equal((await store.flushNow()).written, 0);

  const docs = await raw('unfiled').find().sort({ _seq: 1 }).toArray();
  assert.equal(docs.length, 1198);
  docs.forEach(({ _id, _seq, ...rest }, i) => {
    assert.equal(_seq, i);
    assert.equal(_id, db.unfiled[i].assetId);
    assert.deepEqual(rest, db.unfiled[i]);
  });
  const folders = await raw('folders').find().sort({ _seq: 1 }).toArray();
  assert.deepEqual(folders.map((f) => f._id), db.folders.map((f) => f._id));
  assert.equal(await raw('activityLog').countDocuments(), 11);
});

test('a reload gives back the working set it saved', async () => {
  const saved = structuredClone({ unfiled: db.unfiled, folders: db.folders });
  await store.load();
  assert.deepEqual({ unfiled: db.unfiled, folders: db.folders }, saved);
});

test('an edit made while a write is in flight is still written', async () => {
  const real = models.unfiled.bulkWrite;
  let raced = false;
  models.unfiled.bulkWrite = async function bulkWrite(...args) {
    const out = await real.apply(this, args);
    if (!raced) { raced = true; db.unfiled[0].displayName = 'changed mid-write'; }
    return out;
  };
  try {
    db.unfiled[5].displayName = 'trigger';
    await store.flushNow();
  } finally {
    models.unfiled.bulkWrite = real;
  }
  assert.equal((await store.flushNow()).written, 1);
  assert.equal((await raw('unfiled').findOne({ _seq: 0 })).displayName, 'changed mid-write');
});
