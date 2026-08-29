import express from 'express';
import { db, persist, allAssets } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { record, notify } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { APP_ORIGIN, CHUNK_SIZE, ROOTS, TRASH_DAYS, UPLOAD_DAILY_BYTES, UPLOAD_MAX_BYTES } from '../config.js';
import { uuid } from '../util/crypto.js';
import { resolveFamily, resolveTier, typeExists } from '../services/vocabulary.js';
import { carriesLanguage } from '../catalogue.js';
import { shape } from '../services/assets.js';
import * as antivirus from '../services/antivirus.js';
import { properties } from '../storage/drive.js';
import { LIMITS, fields, int, list, str } from '../util/validate.js';

export const uploadsRouter = express.Router();
uploadsRouter.use(authenticate);

function uploadedTodaySoFar(userId) {
  const since = Date.now() - 86_400_000;
  return allAssets({ includeDeleted: true })
    .filter(({ asset }) => asset.uploadedBy === userId && Date.parse(asset.createdAt) >= since)
    .reduce((n, { asset }) => n + (asset.drive?.sizeBytes ?? 0), 0);
}

function destinationFor(folder) {
  return folder?.driveFolderId || ROOTS.assets;
}

const requireDrive = (req, res, next) => {
  if (storage.driveReady()) return next();
  const status = storage.driveStatus();
  return problem(
    res, 503, 'Service Unavailable',
    `Google Drive is not reachable, so files cannot be uploaded or downloaded right now. The catalogue is unaffected. (${status.error ?? 'no detail'})`,
    { degraded: true, since: status.since },
  );
};

uploadsRouter.post('/initiate', requires('asset:upload'), requireDrive, async (req, res) => {
  const check = fields(req.body || {}, {
    filename: (v) => str(v, { max: LIMITS.name, field: 'filename', required: true }),
    contentType: (v) => str(v, { max: 200, field: 'contentType' }),
    assetType: (v) => str(v, { max: 80, field: 'assetType', required: true }),
    songId: (v) => str(v, { max: 80, field: 'songId' }),
    folderId: (v) => str(v, { max: 80, field: 'folderId' }),
    checksumSHA256: (v) => str(v, { max: 128, field: 'checksumSHA256' }),
    sizeBytes: (v) => int(v, { min: 0, max: Number.MAX_SAFE_INTEGER, field: 'sizeBytes', fallback: 0 }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);

  const { filename, sizeBytes, contentType, assetType, songId, folderId, checksumSHA256 } = check.value;

  if (!typeExists(assetType)) {
    return problem(res, 422, 'Unprocessable Entity', 'Pick an asset type, or add a custom one first.');
  }

  if (storage.isBlockedExtension(filename)) {
    return problem(
      res, 422, 'Unprocessable Entity',
      'That file type cannot be stored here. Web pages, scripts and programs are refused, because the library serves files from the same address as the application. Convert it — a PDF, an image or a plain-text file is fine — and upload that.',
    );
  }
  if (storage.isBlockedType(contentType)) {
    return problem(
      res, 422, 'Unprocessable Entity',
      `Files of type ${contentType} cannot be stored here. Convert it to a document or an image format first.`,
    );
  }

  const size = Number(sizeBytes || 0);
  if (size > UPLOAD_MAX_BYTES) {
    return problem(
      res, 413, 'Payload Too Large',
      `A single file is limited to ${Math.round(UPLOAD_MAX_BYTES / 1024 ** 3)} GB here.`,
    );
  }
  const already = uploadedTodaySoFar(req.user.sub);
  if (already + size > UPLOAD_DAILY_BYTES) {
    return problem(
      res, 429, 'Too Many Requests',
      `That would take this account past its ${Math.round(UPLOAD_DAILY_BYTES / 1024 ** 3)} GB daily upload allowance. The allowance is a rolling 24 hours — try again later, or ask an administrator to raise it.`,
    );
  }

  const song = songId ? db.songs.find((s) => s._id === songId && !s.deletedAt) : null;
  if (songId && !song) return problem(res, 422, 'Unprocessable Entity', 'That song no longer exists.');

  const folder = folderId ? db.folders.find((f) => f._id === folderId && !f.deletedAt) : null;
  if (folderId && !folder) return problem(res, 422, 'Unprocessable Entity', 'That folder no longer exists.');

  let duplicate = null;
  if (checksumSHA256) {
    const hit = allAssets().find(({ asset }) =>
      asset.drive?.sha256 === checksumSHA256 || asset.checksumSHA256 === checksumSHA256);
    if (hit) {
      duplicate = {
        assetId: hit.asset.assetId,
        displayName: hit.asset.displayName,
        songTitle: hit.song?.title ?? hit.folder?.name ?? 'Unfiled',
        folderName: hit.folder?.name ?? null,
      };
    }
  }

  const assetId = uuid();
  const parentId = destinationFor(folder);

  let session;
  try {
    session = await storage.beginUpload({
      name: filename,
      parentId,
      mimeType: contentType || 'application/octet-stream',
      sizeBytes: Number(sizeBytes || 0),
      appProperties: properties({
        app: 'gcloud',
        assetId,
        assetType,
        family: resolveFamily(assetType),
        songId: song?._id ?? '',
        song: song?.title ?? '',
        folder: folder?.name ?? '',
        uploadedBy: req.user.sub,
        sha256: checksumSHA256 || '',
      }),
      origin: APP_ORIGIN,
    });
  } catch (err) {
    if (storage.isQuotaExceeded(err)) {
      return problem(res, 507, 'Insufficient Storage', err.message);
    }
    if (storage.isAccessDenied(err)) {
      return problem(res, 502, 'Bad Gateway',
        'Google refused to open an upload. Check that the connected account can write to the GCloud folder.');
    }
    return problem(res, 502, 'Bad Gateway', `Google Drive would not start the upload: ${err.message}`);
  }

  await storage.registerUploadSession(session.sessionUri, {
    userId: req.user.sub, assetId, sizeBytes: size,
  });

  res.json({
    assetId,
    uploadUrl: session.sessionUri,
    sessionExpiresAt: session.expiresAt,
    parentId,
    chunkSize: CHUNK_SIZE,
    storageTier: resolveTier(assetType),
    duplicate,
  });
});

uploadsRouter.post('/resume', requires('asset:upload'), async (req, res) => {
  const check = fields(req.body || {}, {
    uploadUrl: (v) => str(v, { max: 2000, field: 'uploadUrl', required: true }),
    sizeBytes: (v) => int(v, { min: 1, field: 'sizeBytes' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const { uploadUrl, sizeBytes } = check.value;
  if (!sizeBytes) return problem(res, 422, 'Unprocessable Entity', 'sizeBytes is required.');

  const known = await storage.resolveUploadSession(uploadUrl, req.user.sub);
  if (!known.ok) {
    if (known.reason === 'foreign' || known.reason === 'not-yours') {
      record(req, {
        action: 'UPLOAD_SESSION_REJECTED', entity: 'asset', entityId: 'unknown',
        label: 'Rejected a resume against an unrecognised upload address',
        meta: { reason: known.reason },
      });
    }
    return problem(
      res, 410, 'Gone',
      'That upload session is not one this server opened for you. Start the upload again.',
    );
  }

  try {
    const state = await storage.probeUploadSession(uploadUrl, Number(sizeBytes));
    res.json(state);
  } catch (err) {
    await storage.forgetUploadSession(uploadUrl);
    return problem(res, 410, 'Gone', err.message);
  }
});

uploadsRouter.post('/complete', requires('asset:upload'), async (req, res) => {
  const check = fields(req.body || {}, {
    assetId: (v) => str(v, { max: 80, field: 'assetId', required: true }),
    fileId: (v) => str(v, { max: 200, field: 'fileId', required: true }),
    songId: (v) => str(v, { max: 80, field: 'songId' }),
    folderId: (v) => str(v, { max: 80, field: 'folderId' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const { assetId, fileId, songId, folderId } = check.value;

  const meta = fields(req.body?.metadata || {}, {
    displayName: (v) => str(v, { max: LIMITS.name, field: 'displayName' }),
    originalName: (v) => str(v, { max: LIMITS.name, field: 'originalName' }),
    description: (v) => str(v, { max: LIMITS.description, field: 'description', allowEmpty: true }),
    assetType: (v) => str(v, { max: 80, field: 'assetType' }),
    version: (v) => str(v, { max: 40, field: 'version' }),
    versionGroupId: (v) => str(v, { max: 80, field: 'versionGroupId' }),
    supersedes: (v) => str(v, { max: 80, field: 'supersedes' }),
    checksumSHA256: (v) => str(v, { max: 128, field: 'checksumSHA256' }),
    dimensions: (v) => str(v, { max: 40, field: 'dimensions' }),
    tags: (v) => list(v, { max: LIMITS.tags, itemMax: LIMITS.tag, field: 'tags' }),
    durationSec: (v) => int(v, { min: 0, max: 60 * 60 * 24 * 7, field: 'durationSec' }),
    language: (v) => str(v, { max: 60, field: 'language', allowEmpty: true }),
  });
  if (!meta.ok) return problem(res, 422, 'Unprocessable Entity', meta.problem);
  const metadata = meta.value;

  const song = songId ? db.songs.find((s) => s._id === songId) : null;
  if (songId && !song) return problem(res, 422, 'Unprocessable Entity', 'The target song no longer exists.');
  const folder = folderId ? db.folders.find((f) => f._id === folderId && !f.deletedAt) : null;

  let drive;
  try {
    drive = await storage.finishUpload(fileId);
  } catch (err) {
    return problem(res, 409, 'Conflict', `Could not confirm the upload with Google Drive: ${err.message}`);
  }

  const claimed = drive.appProperties?.assetId;
  if (claimed && claimed !== assetId) {
    return problem(res, 422, 'Unprocessable Entity', 'That Drive file belongs to a different upload.');
  }
  const uploader = drive.appProperties?.uploadedBy;
  if (uploader && uploader !== req.user.sub) {
    return problem(res, 403, 'Forbidden', 'That Drive file was uploaded by a different account.');
  }

  if (storage.isBlockedType(drive.mimeType)) {
    await storage.move(fileId, { toParentId: ROOTS.quarantine, fromParentId: drive.parentId }).catch(() => null);
    return problem(
      res, 422, 'Unprocessable Entity',
      `Google reports this file as ${drive.mimeType}, which the library does not accept. It has been moved to Quarantine.`,
    );
  }

  const quarantine = async ({ label, detail, meta }) => {
    await storage.move(fileId, { toParentId: ROOTS.quarantine, fromParentId: drive.parentId }).catch(() => null);
    notify({
      audience: 'admin',
      category: 'security',
      level: 'danger',
      title: `A file was quarantined on upload: ${drive.name}`,
      body: detail,
      link: '/admin/storage',
    });
    record(req, {
      action: 'UPLOAD_QUARANTINED', entity: 'asset', entityId: assetId,
      label, after: { declaredMime: drive.mimeType, sizeBytes: drive.sizeBytes, ...meta },
    });
    return problem(res, 422, 'Unprocessable Entity', detail);
  };

  const sniff = await storage.sniffBytes(fileId);
  if (sniff.ok && storage.DANGEROUS_VERDICTS.has(sniff.verdict)) {
    return quarantine({
      label: `Quarantined ${drive.name} — contents look like ${sniff.verdict}`,
      detail: `This file's contents are ${sniff.verdict}, whatever its name says. It has been moved to Quarantine rather than added to the library.`,
      meta: { verdict: sniff.verdict },
    });
  }

  if (antivirus.enabled()) {
    const verdict = await antivirus.gate(fileId, { sizeBytes: drive.sizeBytes });
    if (!verdict.allow) {
      return quarantine({
        label: verdict.failedClosed
          ? `Quarantined ${drive.name} — the malware scanner could not be reached`
          : `Quarantined ${drive.name} — ${verdict.signature}`,
        detail: verdict.failedClosed
          ? 'The malware scanner could not be reached, and this deployment refuses uploads it cannot scan. The file is in Quarantine; try again once the scanner is back.'
          : `The malware scanner identified this file as ${verdict.signature}. It has been moved to Quarantine and not added to the library.`,
        meta: { signature: verdict.signature, scanned: verdict.scanned, reason: verdict.reason ?? null },
      });
    }
    drive.scan = {
      scannedAt: new Date().toISOString(),
      clean: true,
      skipped: verdict.scanned ? null : verdict.reason,
    };
  }

  await storage.forgetUploadSession(req.body?.uploadUrl);

  const assetType = metadata?.assetType && typeExists(metadata.assetType) ? metadata.assetType : 'Song Cover';
  const now = new Date().toISOString();

  const asset = {
    assetId,
    displayName: metadata?.displayName || drive.name || 'untitled',
    originalName: metadata?.originalName || metadata?.displayName || drive.name || 'untitled',
    description: metadata?.description || '',
    type: assetType,
    family: resolveFamily(assetType),
    format: '',
    folderId: folder?._id ?? null,
    drive: {
      ...drive,
      path: `${folder?.name ? `${folder.name}/` : ''}${drive.name}`,
      uploadedAt: now,
    },
    availability: { status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now, checkMethod: 'FILES_GET', detail: null },
    lastHead: null,
    versionGroupId: metadata?.versionGroupId || `vg_${assetId.slice(0, 8)}`,
    version: metadata?.version || 'V1',
    isCurrent: true,
    supersedes: metadata?.supersedes ?? null,
    mimeType: drive.mimeType,
    durationSec: drive.durationSec ?? metadata?.durationSec ?? null,
    dimensions: drive.dimensions ?? metadata?.dimensions ?? null,
    tags: metadata?.tags || [],
    language: carriesLanguage(resolveFamily(assetType)) ? metadata?.language || '' : '',
    checksumSHA256: metadata?.checksumSHA256 ?? null,
    uploadedBy: req.user.sub,
    createdAt: now, updatedAt: now, renamedAt: null, deletedAt: null, relocateStatus: null,
  };

  const target = song ? song.assets : db.unfiled;

  if (asset.supersedes) {
    const prior = target.find((a) => a.assetId === asset.supersedes);
    if (prior) { prior.isCurrent = false; asset.versionGroupId = prior.versionGroupId; }
  }

  target.push(asset);
  if (song) song.updatedAt = now;
  if (folder) folder.updatedAt = now;

  for (const name of asset.tags) {
    const tag = db.tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (tag) tag.usageCount += 1;
    else db.tags.push({ _id: uuid(), name, group: 'Custom', type: 'custom', usageCount: 1, createdAt: now });
  }
  persist();

  const artist = song ? db.artists.find((a) => a._id === song.artistId) ?? null : null;
  void storage.syncMetadata(asset, { song, artist, folder, renameFile: asset.displayName !== drive.name })
    .then((ok) => { if (ok) persist(); });

  record(req, {
    action: 'ASSET_UPLOAD', entity: 'asset', entityId: assetId,
    label: `Uploaded ${asset.displayName}`,
    after: {
      fileId: drive.fileId, sizeBytes: drive.sizeBytes, type: assetType,
      songTitle: song?.title ?? null, folder: folder?.name ?? null,
    },
  });

  // Library activity, not a security event: everybody signed in sees what
  // arrived and who put it there, which is the whole point of a shared library.
  notify({
    audience: 'all',
    category: 'activity',
    level: 'info',
    title: `Upload : ${asset.displayName} (${req.user.name})`,
    body: `${folder?.name ? `Filed under ${folder.name}` : song?.title ? `Added to ${song.title}` : 'Added to the library'} · ${assetType}`,
    link: `/assets/${assetId}`,
    meta: { assetId, uploadedBy: req.user.sub, uploadedByName: req.user.name },
  });

  res.status(201).json(shape({ asset, song, artist, folder }));
});

uploadsRouter.post('/abort', requires('asset:upload'), async (req, res) => {
  const check = fields(req.body || {}, {
    uploadUrl: (v) => str(v, { max: 2000, field: 'uploadUrl' }),
    fileId: (v) => str(v, { max: 200, field: 'fileId' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const { uploadUrl, fileId } = check.value;

  if (uploadUrl) {
    const known = await storage.resolveUploadSession(uploadUrl, req.user.sub);
    if (!known.ok) {
      return problem(res, 410, 'Gone', 'That upload session is not one this server opened for you.');
    }
    await storage.abortUpload(uploadUrl);
    await storage.forgetUploadSession(uploadUrl);
  }

  let trashed = false;
  if (fileId) {
    const catalogued = allAssets({ includeDeleted: true }).some(({ asset }) => asset.drive?.fileId === fileId);
    if (catalogued) {
      return problem(
        res, 409, 'Conflict',
        'That file is already in the catalogue, so it is not an abandoned upload. Delete it from its own page if that is what you meant.',
      );
    }
    trashed = await storage.trash(fileId).then(() => true).catch(() => false);
  }

  res.json({ ok: true, aborted: true, recoverableForDays: trashed ? TRASH_DAYS : null });
});
