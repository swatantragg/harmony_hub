import express from 'express';
import { db, persist } from '../db.js';
import { authenticate, requires, requireStepUp, problem } from '../middleware/auth.js';
import { context, shape, validateName } from '../services/assets.js';
import { alert, record, notify } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { APP_ORIGIN, CHUNK_SIZE, ROOTS, TRASH_DAYS, TTL, VERIFY_BATCH_MAX } from '../config.js';
import { VERSION_LABELS, carriesLanguage } from '../catalogue.js';
import { allTypes, resolveFamily } from '../services/vocabulary.js';
import { properties } from '../storage/drive.js';
import { uuid } from '../util/crypto.js';
import { LIMITS, fields, list, str } from '../util/validate.js';
import { isLiveShare, neverExpires } from '../util/shares.js';

export const assetsRouter = express.Router();
assetsRouter.use(authenticate);

const notFound = (res) => problem(res, 404, 'Not Found', 'No asset with that id exists in the catalogue.');

const INTERACTIVE_VERIFY_MAX = Math.min(50, VERIFY_BATCH_MAX);

assetsRouter.post('/verify-batch', async (req, res) => {
  const ids = Array.isArray(req.body?.assetIds) ? req.body.assetIds.slice(0, INTERACTIVE_VERIFY_MAX) : [];
  const summary = { available: 0, missing: 0, trashed: 0, restoring: 0, mismatch: 0, unverified: 0 };
  const results = [];

  const found = ids.map((id) => ({ id, ctx: context(id) }));
  await storage.verifyAssets(found.filter((f) => f.ctx).map((f) => f.ctx.asset));

  for (const { id, ctx } of found) {
    if (!ctx) {
      results.push({ assetId: id, status: 'MISSING', detail: 'No catalogue record' });
      summary.missing += 1;
      continue;
    }
    const availability = ctx.asset.availability;
    summary[availability.status.toLowerCase()] += 1;
    results.push({
      assetId: id,
      displayName: ctx.asset.displayName,
      status: availability.status,
      detail: availability.detail,
      sizeBytes: ctx.asset.lastHead?.sizeBytes ?? null,
    });
  }
  persist();
  record(req, {
    action: 'ASSET_VERIFY_BATCH', entity: 'asset', entityId: 'batch',
    label: `Verified ${ids.length} assets against Google Drive`, after: summary,
  });
  res.json({ checkedAt: new Date().toISOString(), summary, results });
});

assetsRouter.get('/catalogue', (_req, res) => {
  res.json({ types: allTypes(), versions: VERSION_LABELS });
});

assetsRouter.get('/:id', (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const versions = ctx.list
    .filter((a) => a.versionGroupId === ctx.asset.versionGroupId && !a.deletedAt)
    .map((a) => ({ assetId: a.assetId, version: a.version, displayName: a.displayName, isCurrent: a.isCurrent, createdAt: a.createdAt, sizeBytes: a.drive?.sizeBytes ?? 0 }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const activity = db.activityLog.filter((e) => e.entityId === ctx.asset.assetId).slice(0, 25);
  // Only what the drawer shows, and nothing that would let this panel become a
  // way of reading a link's secrets: the passcode hash and every recipient
  // token stay on the server.
  const shares = db.shares
    .filter((s) => s.assetId === ctx.asset.assetId && isLiveShare(s))
    .map((s) => ({
      _id: s._id,
      url: `${APP_ORIGIN}/#/s/${s.token}`,
      audience: s.audience ?? 'PUBLIC',
      canDownload: s.canDownload,
      downloadCount: s.downloadCount ?? 0,
      maxDownloads: s.maxDownloads ?? null,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt ?? null,
      neverExpires: neverExpires(s),
      note: s.note ?? '',
      createdByName: s.createdByName ?? '',
    }));
  res.json({ ...shape(ctx), versions, activity, shares });
});

assetsRouter.post('/:id/verify', async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const before = ctx.asset.availability?.status;
  const { availability, head } = await storage.verifyAsset(ctx.asset);
  persist();

  if (availability.status === 'MISSING' && before !== 'MISSING') {
    notify({
      audience: 'admin',
      category: 'storage',
      level: 'danger',
      title: `${ctx.asset.displayName} is missing from Google Drive`,
      body: 'A live check found no file behind this catalogue record.',
      link: '/admin/storage',
    });
  }
  if (availability.status === 'TRASHED' && before !== 'TRASHED') {
    notify({
      audience: 'admin',
      category: 'storage',
      level: 'warn',
      title: `${ctx.asset.displayName} is in the Drive trash`,
      body: `Restore it from the file's page. Google empties the trash after ${TRASH_DAYS} days.`,
      link: '/admin/storage',
    });
  }
  record(req, {
    action: 'ASSET_VERIFY', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Verified ${ctx.asset.displayName}`, before: { status: before }, after: { status: availability.status },
  });
  res.json({ assetId: ctx.asset.assetId, ...availability, drive: head });
});

assetsRouter.patch('/:id/rename', requires('asset:rename'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);

  const { displayName, allowExtensionChange } = req.body || {};
  const check = validateName(displayName, {
    current: ctx.asset.displayName,
    siblings: ctx.list,
    allowExtensionChange: Boolean(allowExtensionChange),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problems.join(' '));

  const before = { displayName: ctx.asset.displayName };

  let renamedInDrive = true;
  try {
    const drive = await storage.rename(ctx.asset.drive.fileId, check.value);
    ctx.asset.drive = { ...ctx.asset.drive, ...drive };
  } catch (err) {
    renamedInDrive = false;
    if (storage.isNotFound(err)) {
      return problem(res, 410, 'Gone', 'Google Drive no longer has this file, so it cannot be renamed.');
    }
  }

  ctx.asset.displayName = check.value;
  ctx.asset.renamedAt = new Date().toISOString();
  ctx.asset.updatedAt = ctx.asset.renamedAt;
  ctx.asset.drive.path = `${ctx.folder?.name ? `${ctx.folder.name}/` : ''}${check.value}`;
  persist();

  void storage.syncMetadata(ctx.asset, { song: ctx.song, artist: ctx.artist, folder: ctx.folder, renameFile: false });

  record(req, {
    action: 'ASSET_RENAME', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Renamed to ${check.value}`, before, after: { displayName: check.value },
    meta: { fileIdUnchanged: ctx.asset.drive.fileId, renamedInDrive, bytesMoved: 0 },
  });
  res.json({ ...shape(ctx), renamedInDrive });
});

assetsRouter.post('/:id/rename/check', (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const check = validateName(req.body?.displayName, {
    current: ctx.asset.displayName,
    siblings: ctx.list,
    allowExtensionChange: Boolean(req.body?.allowExtensionChange),
  });
  res.json({ ...check, downloadAs: check.value, fileId: ctx.asset.drive?.fileId ?? null });
});

assetsRouter.post('/:id/move', requires('asset:edit'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);

  const targetId = req.body?.folderId ?? null;
  const folder = targetId ? db.folders.find((f) => f._id === targetId && !f.deletedAt) : null;
  if (targetId && !folder) return problem(res, 404, 'Not Found', 'No folder with that id.');

  const destination = folder?.driveFolderId || ROOTS.assets;
  const source = ctx.asset.drive?.parentId ?? null;
  if (destination === source) {
    return res.json({ ...shape(ctx), moved: false, reason: 'already-there' });
  }

  const before = { folderId: ctx.asset.folderId, folderName: ctx.folder?.name ?? null };

  try {
    const drive = await storage.move(ctx.asset.drive.fileId, { toParentId: destination, fromParentId: source });
    ctx.asset.drive = { ...ctx.asset.drive, ...drive };
  } catch (err) {
    if (storage.isNotFound(err)) {
      return problem(res, 410, 'Gone', 'Google Drive no longer has this file, so it cannot be moved.');
    }
    return problem(res, 502, 'Bad Gateway', `Google Drive refused the move: ${err.message}`);
  }

  ctx.asset.folderId = folder?._id ?? null;
  ctx.asset.drive.path = `${folder?.name ? `${folder.name}/` : ''}${ctx.asset.displayName}`;
  ctx.asset.updatedAt = new Date().toISOString();
  if (folder) folder.updatedAt = ctx.asset.updatedAt;
  persist();

  record(req, {
    action: 'ASSET_MOVE', entity: 'asset', entityId: ctx.asset.assetId,
    label: folder ? `Moved ${ctx.asset.displayName} into “${folder.name}”` : `Moved ${ctx.asset.displayName} out of its folder`,
    before, after: { folderId: ctx.asset.folderId, folderName: folder?.name ?? null },
    meta: { bytesMoved: 0, driveParent: destination },
  });
  res.json({ ...shape({ ...ctx, folder }), moved: true });
});

assetsRouter.post('/:id/replace', requires('asset:edit'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const { sizeBytes, contentType } = req.body || {};

  try {
    const session = await storage.beginUpload({
      fileId: ctx.asset.drive.fileId,
      name: ctx.asset.displayName,
      mimeType: contentType || ctx.asset.mimeType,
      sizeBytes: Number(sizeBytes || 0),
      appProperties: properties({ replacedBy: req.user.sub, replacedAt: new Date().toISOString() }),
      origin: APP_ORIGIN,
    });
    await storage.registerUploadSession(session.sessionUri, {
      userId: req.user.sub, assetId: ctx.asset.assetId, fileId: ctx.asset.drive.fileId,
      sizeBytes: Number(sizeBytes || 0),
    });
    res.json({
      uploadUrl: session.sessionUri,
      fileId: ctx.asset.drive.fileId,
      chunkSize: CHUNK_SIZE,
      previousRevisionId: ctx.asset.drive.revisionId,
    });
  } catch (err) {
    if (storage.isQuotaExceeded(err)) return problem(res, 507, 'Insufficient Storage', err.message);
    return problem(res, 502, 'Bad Gateway', `Google Drive would not open a replacement upload: ${err.message}`);
  }
});

assetsRouter.post('/:id/replace/complete', requires('asset:edit'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const previous = ctx.asset.drive.revisionId;

  const drive = await storage.finishUpload(ctx.asset.drive.fileId).catch(() => null);
  if (!drive) return problem(res, 409, 'Conflict', 'Google Drive could not confirm the replacement.');

  ctx.asset.drive = { ...ctx.asset.drive, ...drive };
  ctx.asset.mimeType = drive.mimeType;
  ctx.asset.durationSec = drive.durationSec ?? ctx.asset.durationSec;
  ctx.asset.dimensions = drive.dimensions ?? ctx.asset.dimensions;
  ctx.asset.updatedAt = new Date().toISOString();
  const now = ctx.asset.updatedAt;
  ctx.asset.availability = {
    status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now, checkMethod: 'FILES_GET', detail: null,
  };
  persist();

  if (previous) await storage.pinRevision(ctx.asset.drive.fileId, previous).catch(() => null);

  record(req, {
    action: 'ASSET_REPLACE', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Replaced the contents of ${ctx.asset.displayName}`,
    before: { revisionId: previous, sizeBytes: ctx.asset.lastHead?.sizeBytes ?? null },
    after: { revisionId: drive.revisionId, sizeBytes: drive.sizeBytes },
    meta: { previousRevisionPinned: Boolean(previous) },
  });
  res.json(shape(ctx));
});

assetsRouter.get('/:id/revisions', async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  try {
    const rows = await storage.revisions(ctx.asset.drive.fileId);
    res.json({
      data: rows.map((r) => ({
        revisionId: r.id,
        modifiedAt: r.modifiedTime,
        sizeBytes: r.size == null ? null : Number(r.size),
        md5: r.md5Checksum ?? null,
        keepForever: Boolean(r.keepForever),
        originalFilename: r.originalFilename ?? null,
        modifiedBy: r.lastModifyingUser?.displayName ?? null,
        isCurrent: r.id === ctx.asset.drive.revisionId,
      })),
      note: 'Google Drive keeps 100 revisions or 30 days of them, whichever runs out first. Pinned revisions are kept indefinitely.',
    });
  } catch (err) {
    return problem(res, 502, 'Bad Gateway', `Google Drive would not list revisions: ${err.message}`);
  }
});

assetsRouter.post('/:id/download', requires('asset:download'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const { availability } = await storage.verifyAsset(ctx.asset);
  if (availability.status === 'MISSING') {
    return problem(res, 410, 'Gone', 'Google Drive has no file behind this record. Download is blocked.');
  }
  if (availability.status === 'TRASHED') {
    return problem(res, 409, 'Conflict', 'This file is in the Drive trash. Restore it before downloading.');
  }
  const downloadAs = storage.downloadName(ctx.asset.displayName, ctx.asset.mimeType);
  const url = storage.signedUrl({
    fileId: ctx.asset.drive.fileId,
    filename: downloadAs,
    mimeType: ctx.asset.mimeType,
    expiresIn: TTL.download,
    purpose: 'download',
    assetId: ctx.asset.assetId,
    user: req.user,
  });
  persist();
  record(req, {
    action: 'ASSET_DOWNLOAD', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Downloaded ${ctx.asset.displayName}`, meta: { ttlSeconds: TTL.download },
  });
  res.json({ url, expiresIn: TTL.download, downloadAs, webViewLink: ctx.asset.drive.webViewLink ?? null });
});

assetsRouter.post('/:id/preview', requires('asset:download'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const url = storage.signedUrl({
    fileId: ctx.asset.drive.fileId,
    filename: ctx.asset.displayName,
    mimeType: ctx.asset.mimeType,
    inline: true,
    expiresIn: TTL.preview,
    purpose: 'preview',
    assetId: ctx.asset.assetId,
    user: req.user,
  });
  res.json({
    url,
    expiresIn: TTL.preview,
    contentType: ctx.asset.mimeType,
    inlineSupported: storage.isInlineSafe(ctx.asset.mimeType),
    webViewLink: ctx.asset.drive?.webViewLink ?? null,
    googleNative: Boolean(ctx.asset.drive?.googleNative),
  });
});

const EDITABLE = ['displayName', 'description', 'type', 'tags', 'version', 'language'];

assetsRouter.patch('/:id', requires('asset:edit'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);

  const check = fields(req.body || {}, {
    displayName: (v) => str(v, { max: LIMITS.name, field: 'displayName' }),
    description: (v) => str(v, { max: LIMITS.description, field: 'description', allowEmpty: true }),
    type: (v) => str(v, { max: 80, field: 'type' }),
    version: (v) => str(v, { max: 40, field: 'version' }),
    tags: (v) => list(v, { max: LIMITS.tags, itemMax: LIMITS.tag, field: 'tags' }),
    language: (v) => str(v, { max: 60, field: 'language', allowEmpty: true }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);

  if (check.value.type != null && !allTypes().some((t) => t.type === check.value.type)) {
    return problem(res, 422, 'Unprocessable Entity', 'That is not an asset type in this library.');
  }

  const before = {};
  const after = {};
  for (const field of EDITABLE) {
    if (!(field in (req.body || {}))) continue;
    if (field === 'displayName') {
      const nameCheck = validateName(check.value.displayName, { current: ctx.asset.displayName, siblings: ctx.list });
      if (!nameCheck.ok) return problem(res, 422, 'Unprocessable Entity', nameCheck.problems.join(' '));
    }
    before[field] = ctx.asset[field];
    ctx.asset[field] = check.value[field];
    after[field] = check.value[field];
  }
  if (after.type) ctx.asset.family = resolveFamily(after.type);
  if (!carriesLanguage(ctx.asset.family) && ctx.asset.language) {
    before.language = ctx.asset.language;
    ctx.asset.language = '';
    after.language = '';
  }
  ctx.asset.updatedAt = new Date().toISOString();
  persist();

  const synced = await storage.syncMetadata(ctx.asset, {
    song: ctx.song, artist: ctx.artist, folder: ctx.folder,
    renameFile: Boolean(after.displayName),
  });
  persist();

  record(req, {
    action: 'ASSET_UPDATE', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Updated ${ctx.asset.displayName}`, before, after, meta: { drivePropertiesSynced: synced },
  });
  res.json(shape(ctx));
});

assetsRouter.post('/:id/restore', requires('asset:restore'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  try {
    const drive = await storage.untrash(ctx.asset.drive.fileId);
    ctx.asset.drive = { ...ctx.asset.drive, ...drive };
    const now = new Date().toISOString();
    ctx.asset.availability = {
      status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now, checkMethod: 'FILES_GET', detail: null,
    };
    db.restoreRequests.unshift({
      _id: uuid(), assetId: ctx.asset.assetId, assetName: ctx.asset.displayName,
      requestedBy: req.user.sub, requestedByName: req.user.name,
      status: 'COMPLETE', requestedAt: now, completedAt: now, source: 'DRIVE_TRASH',
    });
    persist();
    record(req, {
      action: 'ASSET_RESTORE', entity: 'asset', entityId: ctx.asset.assetId,
      label: `Restored ${ctx.asset.displayName} from the Drive trash`,
    });
    res.json({ ok: true, restored: true, ...shape(ctx) });
  } catch (err) {
    if (storage.isNotFound(err)) {
      return problem(res, 410, 'Gone', 'Google Drive has already emptied this file from the trash. It cannot be recovered.');
    }
    return problem(res, 409, 'Conflict', err.message);
  }
});

assetsRouter.delete('/:id', requires('asset:delete'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  ctx.asset.deletedAt = new Date().toISOString();

  let trashed = false;
  try {
    await storage.trash(ctx.asset.drive.fileId);
    ctx.asset.drive.trashed = true;
    trashed = true;
  } catch {
  }
  persist();
  record(req, {
    action: 'ASSET_SOFT_DELETE', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Moved ${ctx.asset.displayName} to the recycle bin`,
    meta: { trashedInDrive: trashed, recoverableUntil: new Date(Date.now() + TRASH_DAYS * 86_400_000).toISOString() },
  });
  res.json({ ok: true, deletedAt: ctx.asset.deletedAt, recoverableForDays: TRASH_DAYS, trashedInDrive: trashed });
});

assetsRouter.post('/:id/undelete', requires('asset:delete'), async (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  ctx.asset.deletedAt = null;
  const restored = await storage.untrash(ctx.asset.drive.fileId).then(() => true).catch(() => false);
  if (restored) ctx.asset.drive.trashed = false;
  persist();
  record(req, {
    action: 'ASSET_RESTORE_DELETED', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Restored ${ctx.asset.displayName}`, meta: { untrashedInDrive: restored },
  });
  return res.json({ ok: true, untrashedInDrive: restored });
});

assetsRouter.delete('/:id/purge', requires('asset:purge'), requireStepUp('Purging a file'), async (req, res) => {
  const found = context(req.params.id);
  if (!found) return notFound(res);
  if (req.body?.confirm !== found.asset.displayName) {
    return problem(res, 428, 'Precondition Required', 'Type the asset name exactly to confirm a permanent purge.');
  }
  let revisionsDestroyed = 0;
  try {
    ({ revisionsDestroyed } = await storage.destroy(found.asset.drive.fileId));
  } catch (err) {
    if (!storage.isNotFound(err)) {
      return problem(res, 502, 'Bad Gateway', `Google Drive refused the delete: ${err.message}`);
    }
  }

  const at = found.list.indexOf(found.asset);
  if (at >= 0) found.list.splice(at, 1);
  db.shares = db.shares.filter((s) => s.assetId !== req.params.id && s.targetId !== req.params.id);
  persist();
  alert(req, {
    action: 'ASSET_PURGE', entity: 'asset', entityId: req.params.id,
    level: 'danger',
    label: `Permanently purged ${found.asset.displayName}`,
    before: { fileId: found.asset.drive?.fileId, sizeBytes: found.asset.drive?.sizeBytes },
    meta: { revisionsDestroyed },
  });
  res.json({ ok: true, purged: true, revisionsDestroyed });
});

assetsRouter.get('/:id/versions', (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const versions = ctx.list
    .filter((a) => a.versionGroupId === ctx.asset.versionGroupId && !a.deletedAt)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  res.json(versions.map((a) => shape({ asset: a, song: ctx.song, artist: ctx.artist })));
});
