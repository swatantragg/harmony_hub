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

// What one person may put into the library in a rolling day. Measured from the catalogue
// rather than from a counter, so it survives a restart and cannot be reset by retrying.
function uploadedTodaySoFar(userId) {
  const since = Date.now() - 86_400_000;
  return allAssets({ includeDeleted: true })
    .filter(({ asset }) => asset.uploadedBy === userId && Date.parse(asset.createdAt) >= since)
    .reduce((n, { asset }) => n + (asset.drive?.sizeBytes ?? 0), 0);
}

// Where a file lands, given what it was uploaded against. A folder is a real Drive folder
// now, so this returns an actual parent id rather than a catalogue label.
function destinationFor(folder) {
  return folder?.driveFolderId || ROOTS.assets;
}

// Refused early, and legibly, while Google is not answering. Without this the upload
// opens a session against `parents: [null]` and fails somewhere inside Drive's API with a
// message about a malformed request, which tells the person nothing they can act on.
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
  // Every field is coerced and bounded before it is used. A filename reaches a Drive API
  // call and a Content-Disposition header; a checksum is matched against the catalogue;
  // an id is looked up. None of them should arrive as an object or a megabyte of text.
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

  // ── Content policy (§12.5) ────────────────────────────────────────────────
  //
  // The library is served from the application's own origin. A stored HTML document is a
  // script that runs there, with whatever the signed-in reader can reach, the moment
  // somebody opens it — and a public share link turns that into a drive-by against an
  // external partner on our hostname. So web pages and programs do not go in. (An SVG
  // does: the byte path serves everything under a sandbox policy that makes it inert, and
  // half the covers in the library are SVGs.)
  //
  // The check is on the extension *and* the declared type, and it is repeated against the
  // real bytes once Google has them, because both of these are the uploader's word for it.
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
      // Google mirrors this into the session's CORS policy. It is the *configured* app
      // origin rather than the request's Origin header: the header is attacker-supplied,
      // and echoing it would let a caller widen Google's CORS policy for that session.
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

  // Remembered here, so /resume and /abort can be sure the URI they are handed is one
  // this process actually issued, to this account. See resolveUploadSession().
  storage.registerUploadSession(session.sessionUri, {
    userId: req.user.sub, assetId, sizeBytes: size,
  });

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
//
// The URI is checked against the registry before anything is sent to it. This route used
// to fetch whatever address the request body named — which made this server a willing
// agent for any PUT the caller wanted issued anywhere it could reach, including the cloud
// metadata endpoint and anything else on the internal network, with the response status
// handed back. A session the caller was not given is not a session.
uploadsRouter.post('/resume', requires('asset:upload'), async (req, res) => {
  const check = fields(req.body || {}, {
    uploadUrl: (v) => str(v, { max: 2000, field: 'uploadUrl', required: true }),
    sizeBytes: (v) => int(v, { min: 1, field: 'sizeBytes' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const { uploadUrl, sizeBytes } = check.value;
  if (!sizeBytes) return problem(res, 422, 'Unprocessable Entity', 'sizeBytes is required.');

  const known = storage.resolveUploadSession(uploadUrl, req.user.sub);
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
    storage.forgetUploadSession(uploadUrl);
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

  // The metadata object is the catalogue record's free text, so it is bounded field by
  // field rather than stored as whatever arrived.
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
    // Optional. A file attached to a song inherits the release's language, so this is
    // what gives the rest of the library — loose reels, stills, paperwork — a language
    // at all, and what lets one file disagree with its release when it genuinely does.
    language: (v) => str(v, { max: 60, field: 'language', allowEmpty: true }),
  });
  if (!meta.ok) return problem(res, 422, 'Unprocessable Entity', meta.problem);
  const metadata = meta.value;

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
  // Nor may it adopt a file somebody else uploaded, even with the right assetId.
  const uploader = drive.appProperties?.uploadedBy;
  if (uploader && uploader !== req.user.sub) {
    return problem(res, 403, 'Forbidden', 'That Drive file was uploaded by a different account.');
  }

  // ── The real bytes, not the claim ─────────────────────────────────────────
  //
  // Everything checked at /initiate was the uploader's word: a filename, a MIME type sent
  // by their browser. This is the first moment the actual content exists somewhere this
  // process can read it, so it is the moment to look. One ranged request, 512 bytes.
  //
  // A file whose bytes begin like a web page, a script or an executable is moved to the
  // Quarantine folder rather than catalogued, whatever it was called. Nothing is deleted —
  // a false positive must be recoverable, and an administrator can look at it.
  if (storage.isBlockedType(drive.mimeType)) {
    await storage.move(fileId, { toParentId: ROOTS.quarantine, fromParentId: drive.parentId }).catch(() => null);
    return problem(
      res, 422, 'Unprocessable Entity',
      `Google reports this file as ${drive.mimeType}, which the library does not accept. It has been moved to Quarantine.`,
    );
  }

  // Moves the file out of the library and says so, in one place, so the two content gates
  // below behave identically.
  const quarantine = async ({ label, detail, meta }) => {
    await storage.move(fileId, { toParentId: ROOTS.quarantine, fromParentId: drive.parentId }).catch(() => null);
    notify({
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

  // ── Signatures (§12.5) ────────────────────────────────────────────────────
  //
  // The check above knows what kind of file this is. It cannot know whether it is
  // malicious, because an infected PDF is a valid PDF. That needs a signature database,
  // so when one is configured the bytes go past it before anything is catalogued.
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
    // The clean verdict is worth keeping on the record: it is what says *when* this file
    // was last known good, and against which engine.
    drive.scan = {
      scannedAt: new Date().toISOString(),
      clean: true,
      skipped: verdict.scanned ? null : verdict.reason,
    };
  }

  storage.forgetUploadSession(req.body?.uploadUrl);

  // Falls back rather than trusting: an unknown type would put the file in a family
  // nothing lists, and the type is what drives the icon, the facet and the storage tier.
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
    // Drive reads these off the file itself for video and images, so they arrive for free
    // rather than needing a probe of our own.
    durationSec: drive.durationSec ?? metadata?.durationSec ?? null,
    dimensions: drive.dimensions ?? metadata?.dimensions ?? null,
    tags: metadata?.tags || [],
    // Empty means "not stated here" — the release's language answers for it, and if there
    // is no release the file honestly has no language recorded. Only audio and video may
    // state one at all, so anything a client sends for a cover or a contract is dropped
    // rather than stored somewhere no screen will ever show it.
    language: carriesLanguage(resolveFamily(assetType)) ? metadata?.language || '' : '',
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
  const check = fields(req.body || {}, {
    uploadUrl: (v) => str(v, { max: 2000, field: 'uploadUrl' }),
    fileId: (v) => str(v, { max: 200, field: 'fileId' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const { uploadUrl, fileId } = check.value;

  // Same rule as /resume: only a session this process issued to this account is cancelled,
  // because "cancel" here means "send a DELETE to this address".
  if (uploadUrl) {
    const known = storage.resolveUploadSession(uploadUrl, req.user.sub);
    if (!known.ok) {
      return problem(res, 410, 'Gone', 'That upload session is not one this server opened for you.');
    }
    await storage.abortUpload(uploadUrl);
    storage.forgetUploadSession(uploadUrl);
  }

  // If the upload actually finished before the user changed their mind, there is a real
  // file to trash. Only a file that no catalogue record points at, though: this route
  // accepted any file id and binned it, which made "abort my upload" a way to bin somebody
  // else's master. An abandoned upload has no catalogue record by definition — that is
  // what makes it abandoned.
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
