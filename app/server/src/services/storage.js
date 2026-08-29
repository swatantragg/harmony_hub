import {
  DriveError, FILE_FIELDS, FOLDER_MIME, EXPORT_FORMATS, isGoogleNative,
  about, cancelResumableSession, copyFile, createResumableSession, deleteFile, downloadResponse, driveErrorCode,
  emptyTrash, ensureFolder, escapeQuery, getFile, isAccessDenied, isNotFound, isQuotaExceeded, keepRevisionForever,
  listAll, listRevisions, mapLimit, probeResumableSession, properties, trashFile, untrashFile,
  updateFile, uploadSimple,
} from '../storage/drive.js';
import {
  BLOCKED_EXTENSIONS, BLOCKED_MIME, DRIVE_ID, DRIVE_ROOT_FOLDER_ID, DRIVE_ROOT_FOLDER_NAME,
  FOLDER_ROLES, HEAD_CONCURRENCY, INLINE_MIME, ORIGIN, ROOTS, TRASH_DAYS, TTL,
} from '../config.js';
import { mintFileToken } from './signing.js';
import crypto from 'node:crypto';
import { models } from '../db/models.js';

export { DriveError, isNotFound, isAccessDenied, isQuotaExceeded, mapLimit, isGoogleNative, EXPORT_FORMATS };

export const rootFolders = ROOTS;
export const assetsFolder = () => ROOTS.assets;


export function safeName(name, fallback = 'untitled') {
  const cleaned = String(name ?? '').replace(/[/\\\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 255) || fallback;
}

export function contentDisposition(filename, { inline = false } = {}) {
  const kind = inline ? 'inline' : 'attachment';
  if (!filename) return kind;
  const fallback = String(filename).normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '_').trim() || 'download';
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function binding(file, { path = null } = {}) {
  const video = file.videoMediaMetadata;
  const image = file.imageMediaMetadata;
  return {
    fileId: file.id,
    name: file.name,
    parentId: file.parents?.[0] ?? null,
    driveId: file.driveId ?? DRIVE_ID ?? null,
    path,
    revisionId: file.headRevisionId ?? null,
    sizeBytes: file.size == null ? 0 : Number(file.size),
    md5: file.md5Checksum ?? null,
    sha256: file.sha256Checksum ?? null,
    sha1: file.sha1Checksum ?? null,
    mimeType: file.mimeType || 'application/octet-stream',
    webViewLink: file.webViewLink ?? null,
    thumbnailLink: file.thumbnailLink ?? null,
    trashed: Boolean(file.trashed),
    googleNative: isGoogleNative(file.mimeType),
    createdAt: file.createdTime ?? null,
    modifiedAt: file.modifiedTime ?? null,
    uploadedAt: file.createdTime ?? new Date().toISOString(),
    durationSec: video?.durationMillis ? Math.round(Number(video.durationMillis) / 1000) : null,
    dimensions: video?.width && video?.height
      ? `${video.width}×${video.height}`
      : image?.width && image?.height
        ? `${image.width}×${image.height}`
        : null,
    appProperties: file.appProperties || {},
  };
}

export const fingerprintOf = (drive) => drive?.sha256 || (drive?.md5 ? `md5:${drive.md5}` : null);

export const assetProperties = (asset, { song, artist, folder } = {}) =>
  properties({
    app: 'gcloud',
    assetId: asset.assetId,
    assetType: asset.type,
    family: asset.family,
    version: asset.version,
    songId: song?._id ?? '',
    song: song?.title ?? '',
    artist: artist?.name ?? '',
    folder: folder?.name ?? '',
    tags: (asset.tags || []).join(', '),
    sha256: asset.drive?.sha256 || asset.checksumSHA256 || '',
    uploadedBy: asset.uploadedBy ?? '',
  });


export function signedUrl({
  fileId, filename, inline = false, expiresIn = TTL.download, purpose = 'download',
  assetId = null, mimeType = null, user = null, shareId = null,
}) {
  const exportMime = isGoogleNative(mimeType) ? (EXPORT_FORMATS[mimeType]?.mimeType ?? 'application/pdf') : null;
  const token = mintFileToken({
    fileId, filename, inline, expiresIn, purpose, assetId, exportMime,
    userId: user?.sub ?? null,
    tokenVersion: user ? Number(user.tokenVersion ?? 0) : null,
    shareId,
  });
  return `${ORIGIN}/api/files/${token}`;
}


export const isInlineSafe = (mimeType) => {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return INLINE_MIME.some((re) => re.test(type));
};

export const isBlockedType = (mimeType) => {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return BLOCKED_MIME.some((re) => re.test(type));
};

export const isBlockedExtension = (filename) => {
  const name = String(filename || '').toLowerCase();
  return BLOCKED_EXTENSIONS.some((ext) => name.endsWith(ext) || name.includes(`${ext}.`));
};

export function dispositionFor(mimeType, { requested = false } = {}) {
  if (!requested) return { inline: false, type: safeContentType(mimeType) };
  return isInlineSafe(mimeType)
    ? { inline: true, type: safeContentType(mimeType) }
    : { inline: false, type: safeContentType(mimeType) };
}

export function safeContentType(mimeType) {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!type) return 'application/octet-stream';
  if (isBlockedType(type)) return 'application/octet-stream';
  return type;
}

// ── Upload session registry ─────────────────────────────────────────────────
// A resumable session URI is a bearer credential: whoever holds it can write
// bytes into this library's Drive folder without presenting anything else. So
// the server keeps its own record of which URIs it opened and for whom, and
// refuses to resume or abort one it does not recognise.
//
// That record lives in MongoDB rather than in a Map, because a Map is per
// process: with two tasks running, every resume has a 50% chance of hitting the
// task that never opened the session and being rejected as foreign. The TTL
// index on `expiresAt` does the expiry, so nothing has to sweep.

const SESSION_TTL_MS = 7 * 86_400_000;

const sessionId = (sessionUri) =>
  crypto.createHash('sha256').update(String(sessionUri || '')).digest('hex');

export async function registerUploadSession(sessionUri, { userId, assetId, fileId = null, sizeBytes = 0 }) {
  const now = new Date();
  await models.uploadSessions.updateOne(
    { _id: sessionId(sessionUri) },
    {
      $set: {
        userId,
        assetId,
        fileId,
        sizeBytes,
        createdAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      },
    },
    { upsert: true },
  );
  return sessionUri;
}

const GOOGLE_UPLOAD = /^https:\/\/(www\.googleapis\.com|storage\.googleapis\.com)\/upload\//;

export async function resolveUploadSession(sessionUri, userId) {
  const uri = String(sessionUri || '');
  if (!GOOGLE_UPLOAD.test(uri)) return { ok: false, reason: 'foreign' };
  const row = await models.uploadSessions.findOne({ _id: sessionId(uri) }).lean();
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.userId !== userId) return { ok: false, reason: 'not-yours' };
  if (Date.parse(row.expiresAt) < Date.now()) {
    await models.uploadSessions.deleteOne({ _id: sessionId(uri) }).catch(() => null);
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, session: row };
}

export async function forgetUploadSession(sessionUri) {
  if (!sessionUri) return;
  await models.uploadSessions.deleteOne({ _id: sessionId(sessionUri) }).catch(() => null);
}


const SIGNATURES = [
  { magic: [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45], verdict: 'html' },
  { magic: [0x3c, 0x68, 0x74, 0x6d, 0x6c], verdict: 'html' },
  { magic: [0x3c, 0x48, 0x54, 0x4d, 0x4c], verdict: 'html' },
  { magic: [0x3c, 0x3f, 0x78, 0x6d, 0x6c], verdict: 'xml' },
  { magic: [0x3c, 0x73, 0x76, 0x67], verdict: 'svg' },
  { magic: [0x4d, 0x5a], verdict: 'executable' },
  { magic: [0x7f, 0x45, 0x4c, 0x46], verdict: 'executable' },
  { magic: [0x23, 0x21], verdict: 'script' },
];

export async function sniffBytes(fileId) {
  try {
    const res = await downloadResponse(fileId, { range: 'bytes=0-511', signal: AbortSignal.timeout(10_000) });
    const buffer = Buffer.from(await res.arrayBuffer());
    let start = 0;
    while (start < buffer.length && [0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(buffer[start])) start += 1;
    const head = buffer.subarray(start);
    for (const { magic, verdict } of SIGNATURES) {
      if (magic.every((byte, i) => head[i] === byte)) return { ok: true, verdict, bytes: head.length };
    }
    return { ok: true, verdict: 'opaque', bytes: head.length };
  } catch (err) {
    return { ok: false, verdict: 'unknown', error: err.message };
  }
}

export const DANGEROUS_VERDICTS = new Set(['html', 'executable', 'script']);

export function downloadName(displayName, mimeType) {
  if (!isGoogleNative(mimeType)) return displayName;
  const ext = EXPORT_FORMATS[mimeType]?.ext ?? '.pdf';
  return displayName.toLowerCase().endsWith(ext) ? displayName : `${displayName}${ext}`;
}


export async function stat(fileId) {
  const file = await getFile(fileId, FILE_FIELDS);
  return binding(file);
}

export const statRaw = (fileId) => getFile(fileId, FILE_FIELDS);


export async function putFile({ name, parentId, mimeType, body, appProperties, fileId }) {
  const file = await uploadSimple({
    name: safeName(name),
    parentId: parentId || ROOTS.assets,
    mimeType,
    body,
    appProperties,
    fileId,
  });
  return binding(file);
}

export async function rename(fileId, displayName) {
  const file = await updateFile(fileId, { name: safeName(displayName) });
  return binding(file);
}

export async function move(fileId, { toParentId, fromParentId }) {
  const file = await updateFile(fileId, {
    addParents: toParentId ? [toParentId] : undefined,
    removeParents: fromParentId ? [fromParentId] : undefined,
  });
  return binding(file);
}

export async function setProperties(fileId, appProperties) {
  const file = await updateFile(fileId, { appProperties });
  return binding(file);
}

export async function copy(fileId, { name, parentId, appProperties } = {}) {
  const file = await copyFile(fileId, { name: name ? safeName(name) : undefined, parentId, appProperties });
  return binding(file);
}

export async function trash(fileId) {
  await trashFile(fileId);
  return { trashed: true, recoverableForDays: TRASH_DAYS };
}

export async function untrash(fileId) {
  const file = await untrashFile(fileId);
  return binding(file);
}

export async function destroy(fileId) {
  const revisions = await listRevisions(fileId).catch(() => ({ revisions: [] }));
  await deleteFile(fileId);
  return { destroyed: true, revisionsDestroyed: (revisions.revisions || []).length || 1 };
}

export const revisions = (fileId) => listRevisions(fileId).then((r) => r.revisions || []);
export const pinRevision = keepRevisionForever;

export const emptyDriveTrash = () => emptyTrash();


export async function beginUpload({ name, parentId, mimeType, sizeBytes, appProperties, fileId, origin }) {
  try {
    return await createResumableSession({
      name: safeName(name),
      parentId: parentId || ROOTS.assets,
      mimeType,
      sizeBytes,
      appProperties,
      fileId,
      origin,
    });
  } catch (err) {
    if (isQuotaExceeded(err)) {
      throw new DriveError(507, 'storageQuotaExceeded',
        'Google Drive is out of space. Free some up, or point DRIVE_ID at a Shared Drive with room.');
    }
    throw err;
  }
}

export async function finishUpload(fileId) {
  const file = await getFile(fileId, FILE_FIELDS);
  if (file.trashed) {
    throw new DriveError(409, 'trashed', 'The uploaded file was moved to the trash before it could be catalogued.');
  }
  return binding(file);
}

export const probeUploadSession = (sessionUri, totalBytes) => probeResumableSession(sessionUri, totalBytes);

export const abortUpload = async (sessionUri) => {
  if (!sessionUri) return { aborted: false };
  await cancelResumableSession(sessionUri).catch(() => null);
  return { aborted: true };
};


export async function makeFolder({ name, parentId }) {
  const file = await ensureFolder({ name: safeName(name, 'Untitled folder'), parentId: parentId || ROOTS.assets });
  return binding(file);
}

export async function renameFolder(folderId, name) {
  const file = await updateFile(folderId, { name: safeName(name, 'Untitled folder') });
  return binding(file);
}

export async function trashFolder(folderId) {
  await trashFile(folderId);
  return { trashed: true };
}

export async function listFolder(parentId, { includeTrashed = false } = {}) {
  const q = [
    `'${escapeQuery(parentId)}' in parents`,
    includeTrashed ? null : 'trashed = false',
  ].filter(Boolean).join(' and ');
  const { files } = await listAll({ q });
  return files;
}

export async function inventory({ includeTrashed = true, onPage } = {}) {
  const seen = new Map();
  const folders = new Map();
  let pages = 0;
  let frontier = [ROOTS.assets];
  const visited = new Set();

  while (frontier.length) {
    const batch = frontier.filter((id) => id && !visited.has(id));
    frontier = [];
    for (const id of batch) visited.add(id);

    for (let i = 0; i < batch.length; i += 40) {
      const slice = batch.slice(i, i + 40);
      const parentClause = slice.map((id) => `'${escapeQuery(id)}' in parents`).join(' or ');
      const { files, pages: p } = await listAll({
        q: includeTrashed ? `(${parentClause})` : `(${parentClause}) and trashed = false`,
        onPage,
      });
      pages += p;
      for (const file of files) {
        if (file.mimeType === FOLDER_MIME) {
          folders.set(file.id, file);
          frontier.push(file.id);
        } else {
          seen.set(file.id, file);
        }
      }
    }
  }

  return { files: [...seen.values()], folders: [...folders.values()], pages };
}


export async function probe(asset) {
  const now = new Date().toISOString();
  const base = { lastCheckedAt: now, checkMethod: 'FILES_GET' };
  const keep = asset.availability?.lastVerifiedAt ?? null;
  const fileId = asset.drive?.fileId;

  if (!fileId) {
    return {
      availability: { ...base, status: 'MISSING', lastVerifiedAt: keep, detail: 'No Drive file id on this record.' },
      head: null,
    };
  }

  let file;
  try {
    file = await getFile(fileId, FILE_FIELDS);
  } catch (err) {
    if (isNotFound(err)) {
      return {
        availability: {
          ...base,
          status: 'MISSING',
          lastVerifiedAt: keep,
          detail: 'Google Drive has no file with this id — it was permanently deleted, or the account lost access to it.',
        },
        head: null,
      };
    }
    return {
      availability: {
        ...base,
        status: 'UNVERIFIED',
        lastVerifiedAt: keep,
        detail: isAccessDenied(err)
          ? 'Google refused the check — the connected account can no longer read this file. Review sharing.'
          : `${driveErrorCode(err)} — could not verify against Google Drive`,
      },
      head: null,
    };
  }

  const head = {
    sizeBytes: file.size == null ? 0 : Number(file.size),
    md5: file.md5Checksum ?? null,
    sha256: file.sha256Checksum ?? null,
    revisionId: file.headRevisionId ?? null,
    mimeType: file.mimeType,
    modifiedAt: file.modifiedTime ?? null,
    parentId: file.parents?.[0] ?? null,
    trashed: Boolean(file.trashed),
  };

  if (file.trashed) {
    return {
      availability: {
        ...base,
        status: 'TRASHED',
        lastVerifiedAt: now,
        detail: `In Google Drive's trash. Restore it to make it downloadable again — Drive empties the trash after ${TRASH_DAYS} days.`,
      },
      head,
    };
  }

  if (isGoogleNative(file.mimeType)) {
    return { availability: { ...base, status: 'AVAILABLE', lastVerifiedAt: now, detail: null }, head };
  }

  const recordedSize = asset.drive?.sizeBytes;
  const recordedSum = asset.drive?.sha256 || asset.drive?.md5;
  const liveSum = asset.drive?.sha256 ? file.sha256Checksum : file.md5Checksum;

  const sizeDrift = recordedSize != null && head.sizeBytes !== recordedSize;
  const sumDrift = Boolean(recordedSum) && Boolean(liveSum) && liveSum !== recordedSum;

  if (sizeDrift || sumDrift) {
    const reasons = [];
    if (sizeDrift) reasons.push(`size ${recordedSize} → ${head.sizeBytes}`);
    if (sumDrift) reasons.push(`checksum ${String(recordedSum).slice(0, 12)}… → ${String(liveSum).slice(0, 12)}…`);
    return {
      availability: {
        ...base,
        status: 'MISMATCH',
        lastVerifiedAt: now,
        detail: `The file was changed in Google Drive outside GCloud (${reasons.join('; ')})`,
      },
      head,
    };
  }

  return { availability: { ...base, status: 'AVAILABLE', lastVerifiedAt: now, detail: null }, head };
}

export async function verifyAsset(asset) {
  const { availability, head } = await probe(asset);
  asset.availability = availability;
  asset.lastHead = head;
  return { availability, head };
}

export function verifyAssets(assets, { concurrency = HEAD_CONCURRENCY } = {}) {
  return mapLimit(assets, concurrency, (asset) => verifyAsset(asset));
}

export function staleness(asset) {
  const at = asset.availability?.lastCheckedAt;
  if (!at) return { stale: true, ageHours: null };
  const ageHours = (Date.now() - Date.parse(at)) / 3_600_000;
  return { stale: ageHours > 24, ageHours };
}

export async function syncMetadata(asset, { song, artist, folder, renameFile = true } = {}) {
  try {
    const file = await updateFile(asset.drive.fileId, {
      ...(renameFile ? { name: safeName(asset.displayName) } : {}),
      appProperties: assetProperties(asset, { song, artist, folder }),
    });
    asset.drive = { ...asset.drive, ...binding(file, { path: asset.drive.path }) };
    return true;
  } catch {
    return false;
  }
}


export async function quota() {
  const info = await about();
  const q = info.storageQuota || {};
  const limit = q.limit == null ? null : Number(q.limit);
  const usage = Number(q.usage ?? 0);
  const inDrive = Number(q.usageInDrive ?? 0);
  const inTrash = Number(q.usageInDriveTrash ?? 0);
  return {
    limit,
    unlimited: limit == null,
    usage,
    usageInDrive: inDrive,
    usageInTrash: inTrash,
    usageElsewhere: Math.max(0, usage - inDrive),
    available: limit == null ? null : Math.max(0, limit - usage),
    percentUsed: limit == null ? 0 : Math.min(100, Math.round((usage / limit) * 1000) / 10),
    maxUploadSize: info.maxUploadSize == null ? null : Number(info.maxUploadSize),
    account: info.user
      ? { name: info.user.displayName, email: info.user.emailAddress, photo: info.user.photoLink ?? null }
      : null,
    sharedDriveId: DRIVE_ID,
    checkedAt: new Date().toISOString(),
  };
}


const driveState = {
  ok: false,
  checkedAt: null,
  error: null,
  reason: null,
  since: null,
};

export const driveStatus = () => ({ ...driveState, rootsResolved: Boolean(ROOTS.assets) });

export const driveReady = () => driveState.ok && Boolean(ROOTS.assets);

function markDrive(ok, err = null) {
  const changed = driveState.ok !== ok;
  driveState.ok = ok;
  driveState.checkedAt = new Date().toISOString();
  driveState.error = ok ? null : err?.message ?? String(err ?? 'unknown');
  driveState.reason = ok ? null : driveErrorCode(err);
  if (changed) driveState.since = driveState.checkedAt;
  return changed;
}

export async function ensureRoots() {
  const report = {};
  let root;

  if (DRIVE_ROOT_FOLDER_ID) {
    root = await getFile(DRIVE_ROOT_FOLDER_ID, 'id,name,mimeType,trashed,webViewLink');
    if (root.mimeType !== FOLDER_MIME) {
      throw new DriveError(412, 'notAFolder', `DRIVE_ROOT_FOLDER_ID points at "${root.name}", which is a file, not a folder.`);
    }
    if (root.trashed) {
      throw new DriveError(412, 'rootTrashed', `The configured root folder "${root.name}" is in the Drive trash. Restore it, or clear DRIVE_ROOT_FOLDER_ID.`);
    }
  } else {
    root = await ensureFolder({ name: DRIVE_ROOT_FOLDER_NAME, parentId: DRIVE_ID || null });
  }

  ROOTS.root = root.id;
  report.root = { id: root.id, name: root.name, webViewLink: root.webViewLink ?? null };

  for (const [role, name] of Object.entries(FOLDER_ROLES)) {
    const folder = await ensureFolder({ name, parentId: root.id });
    ROOTS[role] = folder.id;
    report[role] = { id: folder.id, name: folder.name, webViewLink: folder.webViewLink ?? null };
  }

  markDrive(true);
  return report;
}

export async function tryEnsureRoots() {
  try {
    const report = await ensureRoots();
    return { ok: true, report };
  } catch (err) {
    markDrive(false, err);
    return { ok: false, error: err };
  }
}
export function watchDrive({ intervalMs = 60_000, onRecover } = {}) {
  const timer = setInterval(async () => {
    if (driveState.ok) return;
    const out = await tryEnsureRoots();
    if (out.ok) {
      console.log('[drive] reachable again — storage operations have resumed');
      onRecover?.(out.report);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
export const drive = {
  stat, putFile, rename, move, copy, trash, untrash, destroy,
  beginUpload, finishUpload, abortUpload,
  makeFolder, renameFolder, trashFolder, listFolder, inventory,
  quota, ensureRoots,
};