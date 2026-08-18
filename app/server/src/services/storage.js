// StorageService — the entire Google Drive surface of the application (§9.2).
//
// Stat, availability interpretation, resumable uploads, folder plumbing, metadata
// refresh, inventory, quota. Nothing else in the codebase talks to Drive; everything else
// talks to this module, which is what keeps the storage tier swappable and the rest of
// the server testable.
//
// ── Four properties of Drive that shape everything above this file ───────────
//
//  1. Folders are real. A GCloud folder is backed by an actual Drive folder: open
//     drive.google.com and the library is laid out the way the app shows it. Moving a file
//     between folders is a parent swap, so no bytes move however large the file is.
//
//  2. A file is addressed by an immutable id, and its name is ordinary mutable metadata.
//     So rename is honest and cheap: the catalogue and the Drive file are renamed together,
//     in one PATCH, and the id never moves — which is why no share link ever breaks.
//
//  3. There is no self-authorising expiring link for a server-held credential. Downloads
//     and previews are therefore streamed through /api/files/:token — nothing buffered,
//     Range forwarded, token short-lived and revocable — so bytes do pass through this
//     process on the way out. Uploads do not: a resumable session URI is handed to the
//     browser and the bytes go straight to Google (§10.1).
//
//  4. There are no storage tiers, but there is a trash that empties itself after 30 days.
//     That is what TRASHED and RESTORING describe, and it is a far more urgent state than
//     a cold tier — the clock runs out and the file is gone.
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

export { DriveError, isNotFound, isAccessDenied, isQuotaExceeded, mapLimit, isGoogleNative, EXPORT_FORMATS };

// Where new assets go when they belong to no folder. Set by ensureRoots() at boot.
export const rootFolders = ROOTS;
export const assetsFolder = () => ROOTS.assets;

// ── Helpers ─────────────────────────────────────────────────────────────────

// Drive accepts almost anything in a name — full UTF-8, spaces, punctuation. The two it
// genuinely cannot take are a path separator and a control character, because both break
// the display path the app builds from folder names.
export function safeName(name, fallback = 'untitled') {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(name ?? '').replace(/[/\\\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 255) || fallback;
}

// RFC 6266 / RFC 5987. The ASCII fallback keeps old clients happy; filename* is what
// makes a non-Latin display name download under its real name.
export function contentDisposition(filename, { inline = false } = {}) {
  const kind = inline ? 'inline' : 'attachment';
  if (!filename) return kind;
  // eslint-disable-next-line no-control-regex
  const fallback = String(filename).normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '_').trim() || 'download';
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Everything the catalogue stores about where a file physically is: the id that addresses
// it, the checksums Google computed, the revision, and the media metadata Drive extracted
// for free.
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
    // A Google Docs/Sheets/Slides file reports no size at all; it has no bytes of its own.
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

// The one place that decides what "the same bytes" means. Drive computes sha256 and md5
// itself for anything with real bytes, so this is free and authoritative — no download,
// no client cooperation, no trust. It is the whole foundation of exact de-duplication.
export const fingerprintOf = (drive) => drive?.sha256 || (drive?.md5 ? `md5:${drive.md5}` : null);

// The metadata written onto the Drive file itself, so the folder stays self-describing to
// anyone who opens it in a browser and never heard of GCloud.
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

// ── Signed links (§12.3) ────────────────────────────────────────────────────

// Mints the URL a browser uses to fetch one file. It points at *this* server rather than
// at Google — the reasons are set out at the top of services/signing.js. The contract for
// callers: short-lived, purpose-bound, unguessable and unforgeable, and they neither know
// nor care how the bytes eventually arrive.
export function signedUrl({
  fileId, filename, inline = false, expiresIn = TTL.download, purpose = 'download',
  assetId = null, mimeType = null, user = null, shareId = null,
}) {
  // A Google Docs/Sheets/Slides file has no bytes to serve, so a download has to name an
  // export format. The ticket carries it, and the browser gets a .docx as it expects.
  const exportMime = isGoogleNative(mimeType) ? (EXPORT_FORMATS[mimeType]?.mimeType ?? 'application/pdf') : null;
  // Inline is a request, not a decision. What the byte path actually serves is settled by
  // the type policy below, on the way out, against the type Drive really reports.
  const token = mintFileToken({
    fileId, filename, inline, expiresIn, purpose, assetId, exportMime,
    userId: user?.sub ?? null,
    tokenVersion: user ? Number(user.tokenVersion ?? 0) : null,
    shareId,
  });
  return `${ORIGIN}/api/files/${token}`;
}

// ── Content type policy (§12.5) ─────────────────────────────────────────────
//
// The byte path answers on the application's own origin, so anything served inline runs
// with the application's privileges if the browser decides to execute it. HTML executes.
// SVG executes — it carries <script>. So the question "may this be shown inline?" is
// answered here, from an allowlist, against the type Google actually reports, and never
// from the type the uploader claimed or the disposition the ticket asked for.

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
  // Double extensions are the classic evasion — report.pdf.html is an HTML file. Every
  // suffix is checked, not only the last one.
  return BLOCKED_EXTENSIONS.some((ext) => name.endsWith(ext) || name.includes(`${ext}.`));
};

// What the byte path should send, given what Drive says the file is. A type that is not
// on the inline allowlist is still served — it just downloads instead of rendering, which
// costs a click and removes the whole class of stored-XSS-on-our-own-origin.
export function dispositionFor(mimeType, { requested = false } = {}) {
  if (!requested) return { inline: false, type: safeContentType(mimeType) };
  return isInlineSafe(mimeType)
    ? { inline: true, type: safeContentType(mimeType) }
    : { inline: false, type: safeContentType(mimeType) };
}

// The Content-Type actually written on the response. Executable types are neutralised
// rather than relayed, so even a forced download cannot be re-interpreted by a browser
// that follows a link into it.
export function safeContentType(mimeType) {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!type) return 'application/octet-stream';
  if (isBlockedType(type)) return 'application/octet-stream';
  return type;
}

// ── Upload session registry (§12.4) ─────────────────────────────────────────
//
// A resumable session URI is itself a credential, and the resume/abort routes used to
// accept whichever URI the browser sent back — which made this server a willing agent for
// any PUT or DELETE the caller wanted issued, to any address it liked. Only URIs this
// process handed out are honoured now, and only to the account they were handed to.
//
// In memory on purpose: a session is worthless after a restart anyway (Google's own
// staging expires in a week, and the client re-initiates on a rejection), and putting a
// live upload credential in the durable store buys nothing.
const uploadSessions = new Map();

const SESSION_TTL_MS = 7 * 86_400_000;

export function registerUploadSession(sessionUri, { userId, assetId, fileId = null, sizeBytes = 0 }) {
  uploadSessions.set(sessionUri, {
    userId, assetId, fileId, sizeBytes, createdAt: Date.now(),
  });
  // Opportunistic sweep — cheaper than a timer, and this map is small by construction.
  if (uploadSessions.size > 500) {
    for (const [uri, row] of uploadSessions) {
      if (Date.now() - row.createdAt > SESSION_TTL_MS) uploadSessions.delete(uri);
    }
  }
  return sessionUri;
}

// Google's own upload host, and nothing else. Belt and braces behind the registry: even a
// bug that admitted an unregistered URI cannot turn into a request to an internal address.
const GOOGLE_UPLOAD = /^https:\/\/(www\.googleapis\.com|storage\.googleapis\.com)\/upload\//;

export function resolveUploadSession(sessionUri, userId) {
  const uri = String(sessionUri || '');
  if (!GOOGLE_UPLOAD.test(uri)) return { ok: false, reason: 'foreign' };
  const row = uploadSessions.get(uri);
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.userId !== userId) return { ok: false, reason: 'not-yours' };
  if (Date.now() - row.createdAt > SESSION_TTL_MS) {
    uploadSessions.delete(uri);
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, session: row };
}

export function forgetUploadSession(sessionUri) {
  uploadSessions.delete(String(sessionUri || ''));
}

// ── Magic-byte verification (§12.5) ─────────────────────────────────────────
//
// A declared MIME type is whatever the uploader's browser felt like saying. This reads the
// first bytes of the stored object back from Drive — one ranged request, 512 bytes — and
// asks whether they begin the way the declared family begins. It is not a virus scanner;
// it is the check that stops "cover.jpg" being an HTML document.

const SIGNATURES = [
  { magic: [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45], verdict: 'html' }, // <!DOCTYPE
  { magic: [0x3c, 0x68, 0x74, 0x6d, 0x6c], verdict: 'html' },                          // <html
  { magic: [0x3c, 0x48, 0x54, 0x4d, 0x4c], verdict: 'html' },
  { magic: [0x3c, 0x3f, 0x78, 0x6d, 0x6c], verdict: 'xml' },                           // <?xml
  { magic: [0x3c, 0x73, 0x76, 0x67], verdict: 'svg' },                                 // <svg
  { magic: [0x4d, 0x5a], verdict: 'executable' },                                      // MZ — PE
  { magic: [0x7f, 0x45, 0x4c, 0x46], verdict: 'executable' },                          // ELF
  { magic: [0x23, 0x21], verdict: 'script' },                                          // #!
];

export async function sniffBytes(fileId) {
  try {
    const res = await downloadResponse(fileId, { range: 'bytes=0-511', signal: AbortSignal.timeout(10_000) });
    const buffer = Buffer.from(await res.arrayBuffer());
    // Leading whitespace is skipped, because "   <script>" is still a script.
    let start = 0;
    while (start < buffer.length && [0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(buffer[start])) start += 1;
    const head = buffer.subarray(start);
    for (const { magic, verdict } of SIGNATURES) {
      if (magic.every((byte, i) => head[i] === byte)) return { ok: true, verdict, bytes: head.length };
    }
    return { ok: true, verdict: 'opaque', bytes: head.length };
  } catch (err) {
    // A file that cannot be read back is not thereby proved dangerous; the caller decides.
    return { ok: false, verdict: 'unknown', error: err.message };
  }
}

// The verdicts that must never end up in the library, whatever the file was called.
//
// `svg` and `xml` are absent deliberately: an SVG is a legitimate library member here
// (covers, banners) and the sandbox policy on the byte path is what makes it safe. What
// is caught is the evasion — a file *named* cover.svg whose bytes are an HTML document,
// which sniffs as `html` and lands in Quarantine.
export const DANGEROUS_VERDICTS = new Set(['html', 'executable', 'script']);

// What a download is actually called once Google has converted it. A Docs file catalogued
// as "Album credits" downloads as "Album credits.docx", not as a file the OS cannot open.
export function downloadName(displayName, mimeType) {
  if (!isGoogleNative(mimeType)) return displayName;
  const ext = EXPORT_FORMATS[mimeType]?.ext ?? '.pdf';
  return displayName.toLowerCase().endsWith(ext) ? displayName : `${displayName}${ext}`;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function stat(fileId) {
  const file = await getFile(fileId, FILE_FIELDS);
  return binding(file);
}

export const statRaw = (fileId) => getFile(fileId, FILE_FIELDS);

// ── Writing ─────────────────────────────────────────────────────────────────

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

// Rename. On Drive this is what rename always should have been: one metadata PATCH, no
// copy, no new id, every existing share still resolving.
export async function rename(fileId, displayName) {
  const file = await updateFile(fileId, { name: safeName(displayName) });
  return binding(file);
}

// Move between folders. `addParents`/`removeParents` is a pointer swap inside Drive's
// index — the bytes are not read, let alone rewritten, however large the file is.
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

// The recycle bin. Recoverable, and Drive empties it on its own schedule — which is why
// the API tells the caller how long that is instead of implying "forever".
export async function trash(fileId) {
  await trashFile(fileId);
  return { trashed: true, recoverableForDays: TRASH_DAYS };
}

export async function untrash(fileId) {
  const file = await untrashFile(fileId);
  return binding(file);
}

// Permanent. Drive deletes every revision along with the file, so one call is the whole
// job — there is no version history left behind to sweep separately.
export async function destroy(fileId) {
  const revisions = await listRevisions(fileId).catch(() => ({ revisions: [] }));
  await deleteFile(fileId);
  return { destroyed: true, revisionsDestroyed: (revisions.revisions || []).length || 1 };
}

export const revisions = (fileId) => listRevisions(fileId).then((r) => r.revisions || []);
export const pinRevision = keepRevisionForever;

// Trashed files keep occupying Drive quota until Google's own sweep, so this is the only
// way to actually get the space back today. It empties the *whole* account trash, not only
// what GCloud put there, which is why the route that calls it demands a typed
// confirmation (§10.12).
export const emptyDriveTrash = () => emptyTrash();

// ── Uploads (§10.1) ─────────────────────────────────────────────────────────

// Opens a resumable session. The returned URI goes to the browser, which PUTs the bytes
// straight to Google — this process never sees them.
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

// After the browser reports the last chunk accepted, this is what proves it. Reading the
// file back from Drive — rather than trusting the upload response the browser relayed —
// is what stops the catalogue ever gaining a record with no file behind it.
export async function finishUpload(fileId) {
  const file = await getFile(fileId, FILE_FIELDS);
  if (file.trashed) {
    throw new DriveError(409, 'trashed', 'The uploaded file was moved to the trash before it could be catalogued.');
  }
  return binding(file);
}

// How many bytes Google already holds for a session. One round trip turns a dropped
// connection on a 3 GB video into "carry on from 2.1 GB" instead of "start again".
export const probeUploadSession = (sessionUri, totalBytes) => probeResumableSession(sessionUri, totalBytes);

export const abortUpload = async (sessionUri) => {
  if (!sessionUri) return { aborted: false };
  await cancelResumableSession(sessionUri).catch(() => null);
  return { aborted: true };
};

// ── Folders ─────────────────────────────────────────────────────────────────

export async function makeFolder({ name, parentId }) {
  const file = await ensureFolder({ name: safeName(name, 'Untitled folder'), parentId: parentId || ROOTS.assets });
  return binding(file);
}

export async function renameFolder(folderId, name) {
  const file = await updateFile(folderId, { name: safeName(name, 'Untitled folder') });
  return binding(file);
}

// Deleting a GCloud folder never deletes files (§10.8) — they are moved back to the
// Assets root first, and only the now-empty Drive folder is trashed.
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

// Everything under the assets root, folders included, fully paginated. This is the
// ListObjectsV2 of the Drive build and the first phase of reconciliation (§10.11).
export async function inventory({ includeTrashed = true, onPage } = {}) {
  // Drive's `q` has no recursive operator, so the tree is walked a level at a time. Each
  // level is one paginated listing, not one call per file.
  const seen = new Map();
  const folders = new Map();
  let pages = 0;
  let frontier = [ROOTS.assets];
  const visited = new Set();

  while (frontier.length) {
    const batch = frontier.filter((id) => id && !visited.has(id));
    frontier = [];
    for (const id of batch) visited.add(id);

    // Up to 40 parent ids per query keeps the `q` string well inside Drive's limit while
    // still collapsing a wide tree into very few round trips.
    for (let i = 0; i < batch.length; i += 40) {
      const slice = batch.slice(i, i + 40);
      const parentClause = slice.map((id) => `'${escapeQuery(id)}' in parents`).join(' or ');
      // eslint-disable-next-line no-await-in-loop
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

// ── Availability verification (§10.5.1) ─────────────────────────────────────
// The whole decision table lives here, in one place, and returns the same shape whether
// it was reached by a live probe or by nightly reconciliation.

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
    // 403 means a sharing or credential problem, not a missing file. Never report the file
    // as gone on the strength of a permissions error.
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

  // A Google Docs file has no bytes and no checksum, so the drift comparison below would
  // flag every one of them forever. Presence is the whole check it can support.
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

// Runs the probe and writes the result back onto the asset document.
export async function verifyAsset(asset) {
  const { availability, head } = await probe(asset);
  asset.availability = availability;
  asset.lastHead = head;
  return { availability, head };
}

// Bounded fan-out for a list of assets — the batch probe and the search page both use
// this rather than awaiting files.get one asset at a time (§10.5.3).
export function verifyAssets(assets, { concurrency = HEAD_CONCURRENCY } = {}) {
  return mapLimit(assets, concurrency, (asset) => verifyAsset(asset));
}

// Marks anything unverified for more than 24 h, so the UI can prompt a re-check (§8.4).
export function staleness(asset) {
  const at = asset.availability?.lastCheckedAt;
  if (!at) return { stale: true, ageHours: null };
  const ageHours = (Date.now() - Date.parse(at)) / 3_600_000;
  return { stale: ageHours > 24, ageHours };
}

// Pushes the catalogue's view of an asset back onto the Drive file — name and
// appProperties together — so the Drive folder reads correctly to a human. A failure here
// must never fail the operation that triggered it: the catalogue is already correct.
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

// ── Quota (§6.4) ────────────────────────────────────────────────────────────
// How much room is left — one request, and the number everything else depends on.

export async function quota() {
  const info = await about();
  const q = info.storageQuota || {};
  const limit = q.limit == null ? null : Number(q.limit);
  const usage = Number(q.usage ?? 0);
  const inDrive = Number(q.usageInDrive ?? 0);
  const inTrash = Number(q.usageInDriveTrash ?? 0);
  return {
    // A Shared Drive on a Workspace plan with pooled storage reports no limit at all.
    // "Unlimited" is a real answer, not a missing one.
    limit,
    unlimited: limit == null,
    usage,
    usageInDrive: inDrive,
    // Trashed files still occupy quota until Drive empties the trash. People find this
    // genuinely surprising, so it is broken out rather than folded into the total.
    usageInTrash: inTrash,
    // Gmail and Google Photos share the same 15 GB on a consumer account, so this is what
    // the library itself is not responsible for.
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

// ── Bootstrap ───────────────────────────────────────────────────────────────
// Confirms the folders the application needs exist before the first request, and creates
// them if they do not. Idempotent — a second boot finds what the first one made.

// ── Reachability (§9.2) ─────────────────────────────────────────────────────
//
// Whether Google is answering right now, and why not when it is not.
//
// This exists because the boot sequence used to treat "Drive is unreachable" as fatal and
// call process.exit(1). The intent was sound — a bad credential should be a sentence at
// boot rather than a stack trace inside somebody's upload — but the consequence was that
// an expired refresh token took the entire application down, including the catalogue,
// the search index, the audit trail and the admin screens, none of which need Google at
// all. Under a restart policy it then crash-looped, which is the worst of both: no
// service, and no clear message either.
//
// So the failure is recorded instead. The process serves what it can, says plainly what
// it cannot, and keeps trying — because the fix for the common case (mint a new token) is
// something an administrator does *while the application is running*.
const driveState = {
  ok: false,
  checkedAt: null,
  error: null,
  reason: null,
  since: null,
};

export const driveStatus = () => ({ ...driveState, rootsResolved: Boolean(ROOTS.assets) });

// True when byte operations can be attempted at all. Everything that needs a folder id —
// an upload, a new folder — should refuse early with a readable message rather than
// sending `parents: [null]` to Google.
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
    // eslint-disable-next-line no-await-in-loop
    const folder = await ensureFolder({ name, parentId: root.id });
    ROOTS[role] = folder.id;
    report[role] = { id: folder.id, name: folder.name, webViewLink: folder.webViewLink ?? null };
  }

  markDrive(true);
  return report;
}

/**
 * ensureRoots(), but a failure is recorded rather than thrown.
 *
 * Used at boot and by the retry below, so neither has to decide what an unreachable
 * Google means — the answer is the same in both cases: note it, carry on, try again.
 *
 * @returns {Promise<{ok: boolean, report?: object, error?: Error}>}
 */
export async function tryEnsureRoots() {
  try {
    const report = await ensureRoots();
    return { ok: true, report };
  } catch (err) {
    markDrive(false, err);
    return { ok: false, error: err };
  }
}

/**
 * Keeps retrying in the background until Drive answers.
 *
 * The common failure is an expired refresh token, and the fix is to put a new one in the
 * environment — which, for a container, means a restart anyway. But the other failures
 * (a network blip, Google being briefly unavailable, a quota pause) heal on their own,
 * and this is what notices when they do without anybody watching.
 *
 * @returns a stop function for the shutdown path.
 */
export function watchDrive({ intervalMs = 60_000, onRecover } = {}) {
  const timer = setInterval(async () => {
    if (driveState.ok) return;
    const out = await tryEnsureRoots();
    if (out.ok) {
      console.log('[drive] reachable again — storage operations have resumed');
      onRecover?.(out.report);
    }
  }, intervalMs);
  // Never hold the process open for this alone.
  timer.unref?.();
  return () => clearInterval(timer);
}

// A namespace object, so a call site can read `drive.stat(...)` where that is clearer:
//   import { drive } from '../services/storage.js'
export const drive = {
  stat, putFile, rename, move, copy, trash, untrash, destroy,
  beginUpload, finishUpload, abortUpload,
  makeFolder, renameFolder, trashFolder, listFolder, inventory,
  quota, ensureRoots,
};
