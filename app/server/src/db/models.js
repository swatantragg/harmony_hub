// MongoDB collections and indexes (§7).
//
// The document shapes are the ones the architecture specifies, and they are the shapes
// the application already works in, so the schemas are deliberately non-strict: Mongoose
// is here for the connection, the collection registry and the index definitions, not to
// re-describe a model that §7.2 already describes exactly.
import mongoose from 'mongoose';

const loose = (extra = {}) => ({
  strict: false,
  versionKey: false,
  minimize: false,
  ...extra,
});

const schema = (definition = {}, options = {}) =>
  new mongoose.Schema({ _id: String, ...definition }, loose(options));

// Collection order matters only for readability here; load order is set in store.js.
export const models = {
  users: mongoose.model('User', schema(), 'users'),
  artists: mongoose.model('Artist', schema(), 'artists'),
  songs: mongoose.model('Song', schema(), 'songs'),
  // Assets uploaded without a song. Google Drive has no notion of a song, so this is
  // purely an application-layer home for files that are not part of a release.
  unfiled: mongoose.model('UnfiledAsset', schema(), 'unfiled'),
  // A folder row mirrors a real Google Drive folder: `driveFolderId` is the link, and the
  // catalogue row carries the description, tags and song/artist association that Drive has
  // nowhere to put.
  folders: mongoose.model('Folder', schema(), 'folders'),
  customTypes: mongoose.model('CustomType', schema(), 'customTypes'),
  tags: mongoose.model('Tag', schema(), 'tags'),
  shares: mongoose.model('Share', schema(), 'shares'),
  restoreRequests: mongoose.model('RestoreRequest', schema(), 'restoreRequests'),
  reconciliationRuns: mongoose.model('ReconciliationRun', schema(), 'reconciliationRuns'),
  // Duplicate groups an admin has looked at and decided are fine. Keyed on the group's
  // stable id so the decision survives a re-scan (§10.12).
  dedupeIgnores: mongoose.model('DedupeIgnore', schema(), 'dedupeIgnores'),
  activityLog: mongoose.model('ActivityEntry', schema(), 'activityLog'),
  notifications: mongoose.model('Notification', schema(), 'notifications'),
  meta: mongoose.model('Meta', schema(), 'meta'),
  // Refresh-token families (§12.2). Deliberately NOT part of the in-memory working set:
  // a session record has to be durable and has to be queried by token hash, and holding
  // it in a process-local array would make "sign out everywhere" a per-task lie.
  sessions: mongoose.model('Session', schema(), 'sessions'),
};

// §7.3. Built once at boot, in the background, so a cold start is never blocked on an
// index build. The unique constraints named in §7.3 for `assets.assetId` and
// `assets.drive.fileId` are enforced in the application layer instead: they are multikey
// paths inside an embedded array, and a unique index there would reject two legal states —
// the moment a file is being moved between songs, and the deliberate one where two
// catalogue entries share a single Drive file after de-duplication linking (§10.12).
export async function ensureIndexes() {
  const created = [];
  const build = async (model, spec, options = {}) => {
    await model.collection.createIndex(spec, { background: true, ...options });
    created.push(`${model.collection.collectionName} ${JSON.stringify(spec)}`);
  };

  await build(models.users, { email: 1 }, { unique: true });

  // A $text index treats a document's `language` field as a per-document language
  // override, and a song's `language` is "Hindi" or "Punjabi" — neither of which is a
  // MongoDB text-search language, so every write to the collection would be rejected with
  // "language override unsupported". Pointing the override at a field no document has
  // keeps the index and leaves the catalogue's own `language` alone.
  await build(
    models.songs,
    { title: 'text', tags: 'text', 'assets.displayName': 'text' },
    { name: 'song_text', default_language: 'english', language_override: '_textLanguage' },
  );
  await build(models.songs, { artistId: 1, releaseDate: -1 });
  await build(models.songs, { language: 1 });
  await build(models.songs, { mood: 1 });
  await build(models.songs, { 'assets.type': 1 });
  await build(models.songs, { 'assets.assetId': 1 });
  await build(models.songs, { 'assets.drive.fileId': 1 });
  await build(models.songs, { 'assets.drive.parentId': 1 });
  // The two checksum indexes are what make exact de-duplication a lookup rather than a
  // scan (§10.12). Drive computes both itself, so they are populated on every upload.
  await build(models.songs, { 'assets.drive.sha256': 1 });
  await build(models.songs, { 'assets.drive.md5': 1 });
  await build(models.songs, { 'assets.availability.status': 1 });
  await build(models.songs, { 'assets.availability.lastCheckedAt': 1 });
  await build(models.songs, { 'assets.versionGroupId': 1, 'assets.isCurrent': 1 });

  await build(models.unfiled, { assetId: 1 }, { unique: true });
  await build(models.unfiled, { 'drive.fileId': 1 });
  await build(models.unfiled, { 'drive.sha256': 1 });
  await build(models.unfiled, { 'drive.md5': 1 });
  await build(models.unfiled, { 'availability.status': 1 });
  await build(models.unfiled, { folderId: 1 });

  await build(models.artists, { slug: 1 });
  await build(models.folders, { name: 1 });
  await build(models.folders, { driveFolderId: 1 });
  await build(models.folders, { parentId: 1 });
  await build(models.tags, { name: 1 });

  await build(models.shares, { token: 1 }, { unique: true });
  await build(models.shares, { targetId: 1 });
  await build(models.shares, { expiresAt: 1 });

  await build(models.activityLog, { timestamp: -1 });
  await build(models.activityLog, { entityId: 1, timestamp: -1 });
  await build(models.activityLog, { userId: 1, timestamp: -1 });

  await build(models.reconciliationRuns, { startedAt: -1 });
  await build(models.notifications, { createdAt: -1 });
  await build(models.restoreRequests, { requestedAt: -1 });

  // Sessions. The TTL index is the one that matters: expired refresh tokens are removed
  // by MongoDB itself, so a leaked backup of this collection ages out rather than
  // staying useful forever.
  await build(models.sessions, { userId: 1, lastUsedAt: -1 });
  await build(models.sessions, { familyId: 1 });
  await build(models.sessions, { expiresAt: 1 }, { expireAfterSeconds: 0 });

  return created;
}

export { mongoose };
