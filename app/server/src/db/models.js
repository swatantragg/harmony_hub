import mongoose from 'mongoose';

const loose = (extra = {}) => ({
  strict: false,
  versionKey: false,
  minimize: false,
  ...extra,
});

const schema = (definition = {}, options = {}) =>
  new mongoose.Schema({ _id: String, ...definition }, loose(options));

export const models = {
  users: mongoose.model('User', schema(), 'users'),
  artists: mongoose.model('Artist', schema(), 'artists'),
  songs: mongoose.model('Song', schema(), 'songs'),
  unfiled: mongoose.model('UnfiledAsset', schema(), 'unfiled'),
  folders: mongoose.model('Folder', schema(), 'folders'),
  customTypes: mongoose.model('CustomType', schema(), 'customTypes'),
  tags: mongoose.model('Tag', schema(), 'tags'),
  shares: mongoose.model('Share', schema(), 'shares'),
  restoreRequests: mongoose.model('RestoreRequest', schema(), 'restoreRequests'),
  reconciliationRuns: mongoose.model('ReconciliationRun', schema(), 'reconciliationRuns'),
  dedupeIgnores: mongoose.model('DedupeIgnore', schema(), 'dedupeIgnores'),
  activityLog: mongoose.model('ActivityEntry', schema(), 'activityLog'),
  notifications: mongoose.model('Notification', schema(), 'notifications'),
  meta: mongoose.model('Meta', schema(), 'meta'),
  sessions: mongoose.model('Session', schema(), 'sessions'),

  // ── Server-owned state, never mirrored into the in-memory working set ──────
  // These are read and written directly. Putting them in db/store.js would load
  // every row at boot and flush the whole set on every change, which is exactly
  // wrong for counters and single-use secrets.
  otpChallenges: mongoose.model('OtpChallenge', schema(), 'otpChallenges'),
  uploadSessions: mongoose.model('UploadSession', schema(), 'uploadSessions'),
  rateLimits: mongoose.model('RateLimit', schema(), 'rateLimits'),
};

export async function ensureIndexes() {
  const created = [];
  const build = async (model, spec, options = {}) => {
    await model.collection.createIndex(spec, { background: true, ...options });
    created.push(`${model.collection.collectionName} ${JSON.stringify(spec)}`);
  };

  await build(models.users, { email: 1 }, { unique: true });

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

  await build(models.sessions, { userId: 1, lastUsedAt: -1 });
  await build(models.sessions, { familyId: 1 });
  await build(models.sessions, { tokenHash: 1 });
  await build(models.sessions, { expiresAt: 1 }, { expireAfterSeconds: 0 });

  // Mongo's TTL monitor reaps these, so nothing has to remember to sweep them.
  await build(models.otpChallenges, { userId: 1, purpose: 1, createdAt: -1 });
  await build(models.otpChallenges, { expiresAt: 1 }, { expireAfterSeconds: 0 });

  await build(models.uploadSessions, { userId: 1 });
  await build(models.uploadSessions, { expiresAt: 1 }, { expireAfterSeconds: 0 });

  await build(models.rateLimits, { expiresAt: 1 }, { expireAfterSeconds: 0 });

  return created;
}

export { mongoose };
