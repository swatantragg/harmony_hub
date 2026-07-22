// Upload — storing data in AWS (§10.1). Three calls: initiate, (browser PUTs parts
// straight to storage), complete. No file byte ever passes through this process.
import express from 'express';
import { db, persist } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { s3 } from '../services/storage.js';
import { BUCKETS, PART_SIZE } from '../config.js';
import { uuid } from '../util/crypto.js';
import { resolveFamily, resolveTier, typeExists } from '../services/vocabulary.js';
import { shape } from '../services/assets.js';

export const uploadsRouter = express.Router();
uploadsRouter.use(authenticate);

uploadsRouter.post('/initiate', requires('asset:upload'), (req, res) => {
  const { filename, sizeBytes, contentType, assetType, songId, folderId, checksumSHA256 } = req.body || {};

  if (!filename) return problem(res, 422, 'Unprocessable Entity', 'A filename is required.');
  if (!typeExists(assetType)) {
    return problem(res, 422, 'Unprocessable Entity', 'Pick an asset type, or add a custom one first.');
  }

  // A song is optional. Plenty of files — press kits, contracts, brand assets — belong to
  // the library without belonging to a release, and forcing a song on them would only
  // teach people to file things under the wrong one.
  const song = songId ? db.songs.find((s) => s._id === songId && !s.deletedAt) : null;
  if (songId && !song) return problem(res, 422, 'Unprocessable Entity', 'That song no longer exists.');

  const folder = folderId ? db.folders.find((f) => f._id === folderId && !f.deletedAt) : null;
  if (folderId && !folder) return problem(res, 422, 'Unprocessable Entity', 'That folder no longer exists.');

  // Dedup check — an identical checksum already in the library is worth flagging, not blocking.
  let duplicate = null;
  if (checksumSHA256) {
    for (const s of db.songs) {
      const hit = s.assets.find((a) => !a.deletedAt && a.s3.checksumSHA256 === checksumSHA256);
      if (hit) { duplicate = { assetId: hit.assetId, displayName: hit.displayName, songTitle: s.title }; break; }
    }
  }

  const assetId = uuid();
  const ext = (String(filename).match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const key = `assets/${assetId}/original${ext}`;

  const { uploadId } = s3.createMultipartUpload({
    bucket: BUCKETS.assets,
    key,
    contentType: contentType || 'application/octet-stream',
    metadata: {
      'asset-id': assetId, 'display-name': filename,
      'song-id': song?._id ?? '', 'song-title': song?.title ?? '',
      'folder-id': folder?._id ?? '', 'folder-name': folder?.name ?? '',
      'asset-type': assetType, family: resolveFamily(assetType), 'uploaded-by': req.user.sub,
    },
  });

  const partCount = Math.max(1, Math.ceil(Number(sizeBytes || 0) / PART_SIZE));
  const parts = Array.from({ length: partCount }, (_, i) => ({
    partNumber: i + 1,
    url: storage.presignPart({ bucket: BUCKETS.assets, key, uploadId, partNumber: i + 1 }),
  }));

  res.json({
    assetId, uploadId, key, bucket: BUCKETS.assets,
    partSize: PART_SIZE, parts, storageTier: resolveTier(assetType), duplicate,
  });
});

// Re-issue presigned URLs for the parts that are still outstanding (pause → resume).
uploadsRouter.post('/refresh-parts', requires('asset:upload'), (req, res) => {
  const { uploadId, key, partNumbers } = req.body || {};
  if (!uploadId || !key) return problem(res, 422, 'Unprocessable Entity', 'uploadId and key are required.');
  const parts = (partNumbers || []).map((partNumber) => ({
    partNumber,
    url: storage.presignPart({ bucket: BUCKETS.assets, key, uploadId, partNumber }),
  }));
  res.json({ parts });
});

uploadsRouter.post('/complete', requires('asset:upload'), (req, res) => {
  const { assetId, uploadId, key, parts, songId, folderId, metadata } = req.body || {};
  const song = songId ? db.songs.find((s) => s._id === songId) : null;
  if (songId && !song) return problem(res, 422, 'Unprocessable Entity', 'The target song no longer exists.');
  const folder = folderId ? db.folders.find((f) => f._id === folderId && !f.deletedAt) : null;

  let meta;
  try {
    meta = s3.completeMultipartUpload({ uploadId, parts: parts || [] });
  } catch (err) {
    return problem(res, 409, 'Conflict', `Could not assemble the upload: ${err.message}`);
  }

  // HeadObject immediately after assembly — the object is confirmed present before a
  // catalogue record is written, so the library never gains a phantom entry.
  const head = s3.headObject({ bucket: BUCKETS.assets, key });
  const assetType = metadata?.assetType || 'Song Cover';
  const now = new Date().toISOString();

  const asset = {
    assetId,
    displayName: metadata?.displayName || 'untitled',
    originalName: metadata?.originalName || metadata?.displayName || 'untitled',
    description: metadata?.description || '',
    type: assetType,
    family: resolveFamily(assetType),
    format: '',
    folderId: folder?._id ?? null,
    s3: {
      bucket: BUCKETS.assets, key, versionId: head.versionId, region: head.region,
      storageClass: head.storageClass, sizeBytes: head.size, etag: head.etag,
      checksumSHA256: metadata?.checksumSHA256 ?? null,
      contentType: head.contentType, uploadedAt: now,
    },
    availability: { status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now, checkMethod: 'HEAD_OBJECT', detail: null },
    lastHead: null,
    versionGroupId: metadata?.versionGroupId || `vg_${assetId.slice(0, 8)}`,
    version: metadata?.version || 'V1',
    isCurrent: true,
    supersedes: metadata?.supersedes ?? null,
    mimeType: head.contentType,
    durationSec: metadata?.durationSec ?? null,
    dimensions: metadata?.dimensions ?? null,
    tags: metadata?.tags || [],
    uploadedBy: req.user.sub,
    createdAt: now, updatedAt: now, renamedAt: null, deletedAt: null, rekeyStatus: null,
  };

  // Files attached to a song live in that song's document; everything else lives in the
  // unfiled list. Storage does not distinguish between the two — both are plain objects.
  const target = song ? song.assets : db.unfiled;

  // A new version supersedes its predecessor inside the same version group.
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

  record(req, {
    action: 'ASSET_UPLOAD', entity: 'asset', entityId: assetId,
    label: `Uploaded ${asset.displayName}`,
    after: {
      key, sizeBytes: head.size, type: assetType,
      songTitle: song?.title ?? null, folder: folder?.name ?? null,
    },
  });

  const artist = song ? db.artists.find((a) => a._id === song.artistId) ?? null : null;
  res.status(201).json(shape({ asset, song, artist, folder }));
});

uploadsRouter.post('/abort', requires('asset:upload'), (req, res) => {
  const { uploadId } = req.body || {};
  if (uploadId) s3.abortMultipartUpload({ uploadId });
  res.json({ ok: true, aborted: true });
});
