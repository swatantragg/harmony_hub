// Upload — storing data in Google Drive (§10.1). Two calls: initiate, (browser PUTs the
// bytes straight to Google), complete. No file byte passes through this process.
//
// Drive's resumable protocol is sequential: one session URI, chunks sent in order, each
// answered with a 308 saying how much Google now holds. Sending in order costs a little
// throughput and buys the thing that matters — a dropped connection is recovered by asking
// Google how many bytes it has and continuing from exactly there, with no client-side
// bookkeeping to get out of step.
import express from 'express';
import { db, persist, allAssets } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { record } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { CHUNK_SIZE, ROOTS, TRASH_DAYS } from '../config.js';
import { uuid } from '../util/crypto.js';
import { resolveFamily, resolveTier, typeExists } from '../services/vocabulary.js';
import { shape } from '../services/assets.js';
import { properties } from '../storage/drive.js';

export const uploadsRouter = express.Router();
uploadsRouter.use(authenticate);

// Drive's own ceiling for a single file. Worth stating rather than discovering.
const MAX_FILE_BYTES = 5 * 1024 ** 4; // 5 TB

// Where a file lands, given what it was uploaded against. A folder is a real Drive folder
// now, so this returns an actual parent id rather than a catalogue label.
function destinationFor(folder) {
  return folder?.driveFolderId || ROOTS.assets;
}

uploadsRouter.post('/initiate', requires('asset:upload'), async (req, res) => {
  const { filename, sizeBytes, contentType, assetType, songId, folderId, checksumSHA256 } = req.body || {};

  if (!filename) return problem(res, 422, 'Unprocessable Entity', 'A filename is required.');
  if (!typeExists(assetType)) {
    return problem(res, 422, 'Unprocessable Entity', 'Pick an asset type, or add a custom one first.');
  }
  if (Number(sizeBytes || 0) > MAX_FILE_BYTES) {
    return problem(res, 413, 'Payload Too Large', 'Google Drive will not take a single file larger than 5 TB.');
  }

  // A song is optional. Plenty of files — press kits, contracts, brand assets — belong to
  // the library without belonging to a release, and forcing a song on them would only
  // teach people to file things under the wrong one.
  const song = songId ? db.songs.find((s) => s._id === songId && !s.deletedAt) : null;
  if (songId && !song) return problem(res, 422, 'Unprocessable Entity', 'That song no longer exists.');

  const folder = folderId ? db.folders.find((f) => f._id === folderId && !f.deletedAt) : null;
  if (folderId && !folder) return problem(res, 422, 'Unprocessable Entity', 'That folder no longer exists.');

  // Dedup check — an identical checksum already in the library is worth flagging, not
  // blocking. Loose files count too: the same contract uploaded twice is still a duplicate.
  // Google computes sha256 itself on arrival, so this browser-supplied hash is only the
  // early warning; services/dedupe.js does the authoritative pass against Google's own.
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
      // The Drive file's name is the display name from the first byte, which is what
      // makes the library legible when somebody opens the folder in Drive.
      name: filename,
      parentId,
      mimeType: contentType || 'application/octet-stream',
      sizeBytes: Number(sizeBytes || 0),
      appProperties: properties({
        app: 'harmonyhub',
        assetId,
        assetType,
        family: resolveFamily(assetType),
        songId: song?._id ?? '',
        song: song?.title ?? '',
        folder: folder?.name ?? '',
        uploadedBy: req.user.sub,
        sha256: checksumSHA256 || '',
      }),
      // Google mirrors this into the session's CORS policy. Without it the browser's PUT
      // is refused before it starts.
      origin: req.get('origin') || undefined,
    });
  } catch (err) {
    if (storage.isQuotaExceeded(err)) {
      return problem(res, 507, 'Insufficient Storage', err.message);
    }
    if (storage.isAccessDenied(err)) {
      return problem(res, 502, 'Bad Gateway',
        'Google refused to open an upload. Check that the connected account can write to the Harmony Hub folder.');
    }
    return problem(res, 502, 'Bad Gateway', `Google Drive would not start the upload: ${err.message}`);
  }

  res.json({
    assetId,
    uploadUrl: session.sessionUri,
    sessionExpiresAt: session.expiresAt,
    parentId,
    // Google requires every chunk but the last to be a multiple of 256 KiB. The server
    // sends the number rather than trusting the client to know the rule.
    chunkSize: CHUNK_SIZE,
    storageTier: resolveTier(assetType),
    duplicate,
  });
});

// The resume handshake. The browser calls this after a failure to learn how many bytes
// Google already holds, and picks up from exactly there.
uploadsRouter.post('/resume', requires('asset:upload'), async (req, res) => {
  const { uploadUrl, sizeBytes } = req.body || {};
  if (!uploadUrl || !sizeBytes) {
    return problem(res, 422, 'Unprocessable Entity', 'uploadUrl and sizeBytes are both required.');
  }
  try {
    const state = await storage.probeUploadSession(uploadUrl, Number(sizeBytes));
    res.json(state);
  } catch (err) {
    return problem(res, 410, 'Gone', err.message);
  }
});

uploadsRouter.post('/complete', requires('asset:upload'), async (req, res) => {
  const { assetId, fileId, songId, folderId, metadata } = req.body || {};
  if (!assetId || !fileId) {
    return problem(res, 422, 'Unprocessable Entity', 'assetId and fileId are both required.');
  }

  const song = songId ? db.songs.find((s) => s._id === songId) : null;
  if (songId && !song) return problem(res, 422, 'Unprocessable Entity', 'The target song no longer exists.');
  const folder = folderId ? db.folders.find((f) => f._id === folderId && !f.deletedAt) : null;

  // Reading the file back from Drive — rather than trusting what the browser reported —
  // is what confirms the object is really there, with the size Google says it has, before
  // a catalogue record is written. The library never gains a phantom entry.
  let drive;
  try {
    drive = await storage.finishUpload(fileId);
  } catch (err) {
    return problem(res, 409, 'Conflict', `Could not confirm the upload with Google Drive: ${err.message}`);
  }

  // The upload was opened with an assetId in appProperties. If the two disagree, this
  // request is trying to adopt a file it did not upload.
  const claimed = drive.appProperties?.assetId;
  if (claimed && claimed !== assetId) {
    return problem(res, 422, 'Unprocessable Entity', 'That Drive file belongs to a different upload.');
  }

  const assetType = metadata?.assetType || 'Song Cover';
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
    // Drive reads these off the file itself for video and images, so they arrive for free
    // rather than needing a probe of our own.
    durationSec: drive.durationSec ?? metadata?.durationSec ?? null,
    dimensions: drive.dimensions ?? metadata?.dimensions ?? null,
    tags: metadata?.tags || [],
    // Kept alongside Drive's own sha256 because the browser computed it before the upload
    // and it is what the pre-upload duplicate warning matched on.
    checksumSHA256: metadata?.checksumSHA256 ?? null,
    uploadedBy: req.user.sub,
    createdAt: now, updatedAt: now, renamedAt: null, deletedAt: null, relocateStatus: null,
  };

  // Files attached to a song live in that song's document; everything else lives in the
  // unfiled list. Drive does not distinguish between the two — both are plain files.
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

  // Now that the catalogue knows the song, artist, folder and tags, write them onto the
  // Drive file too. Deliberately after the response-shaping data is settled and never
  // allowed to fail the upload.
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

  res.status(201).json(shape({ asset, song, artist, folder }));
});

uploadsRouter.post('/abort', requires('asset:upload'), async (req, res) => {
  const { uploadUrl, fileId } = req.body || {};
  // Cancelling the session throws away whatever Google has staged. If the upload actually
  // finished before the user changed their mind, there is a real file to trash instead.
  await storage.abortUpload(uploadUrl);
  if (fileId) await storage.trash(fileId).catch(() => null);
  res.json({ ok: true, aborted: true, recoverableForDays: fileId ? TRASH_DAYS : null });
});
