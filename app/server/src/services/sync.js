import { db, persist, writeMeta, readMeta } from '../db.js';
import * as storage from './storage.js';
import { DRIVE_SYNC, HEAD_CONCURRENCY, ROOTS } from '../config.js';
import { uuid } from '../util/crypto.js';
import { allTypes, resolveFamily } from './vocabulary.js';
import { FOLDER_MIME, isNotFound, listChanges, mapLimit, startPageToken } from '../storage/drive.js';
import { notify, record } from './audit.js';

// ── Why this exists ─────────────────────────────────────────────────────────
// Every screen in the app reads MongoDB, never Drive. That is deliberate — a
// Drive round trip per row would be unusable — but it means the catalogue is a
// cache, and a cache nobody refills goes stale. Anything dropped into the Drive
// folder from the Drive UI, the desktop client or a phone had no catalogue row,
// so it was invisible here no matter how often the page was reloaded.
//
// This module is the missing refill: a single idempotent Drive → catalogue
// mirror that adopts what is new and follows renames and moves. It runs on a
// short timer, on demand from the UI, and lazily whenever a library screen is
// about to serve a stale answer.
//
// It never deletes. A file that vanished from Drive is marked MISSING and left
// for reconciliation to raise with an administrator — silently dropping rows
// would take tags, versions and share links down with them.

const PREFERRED = {
  Audio: 'Master Audio',
  Video: 'Horizontal Video',
  Image: 'Banner Image',
  Document: 'Credits / Metadata Sheet',
};

const EMPTY_COUNTS = () => ({
  foldersAdopted: 0,
  filesAdopted: 0,
  renamed: 0,
  refiled: 0,
  foldersRenamed: 0,
  foldersRefiled: 0,
  trashed: 0,
  missing: 0,
  restored: 0,
  contentChanged: 0,
  skippedBlocked: 0,
  skippedQuarantined: 0,
});

function familyFromMime(mimeType = '') {
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('image/')) return 'Image';
  return 'Document';
}

// Custom types are editable, so the landing type is resolved against the live
// vocabulary rather than hardcoded — a renamed type must not break the import.
function typeForFamily(family, types) {
  const preferred = types.find((t) => t.type === PREFERRED[family]);
  return (preferred || types.find((t) => t.family === family) || types[0]).type;
}

// ── Run state ───────────────────────────────────────────────────────────────
// One sync at a time, process-wide. Concurrent callers (the timer, three browser
// tabs and a lazy refresh) all join the run already in flight rather than each
// issuing their own recursive walk of the drive.

const state = {
  lastStartedAt: null,
  lastFinishedAt: null,
  lastDurationMs: null,
  lastTrigger: null,
  lastMode: null,
  lastError: null,
  lastCounts: EMPTY_COUNTS(),
  lastChanged: 0,
  runs: 0,
};

let inFlight = null;
let changeToken = null;
let tokenLoaded = false;

export const lastSyncAt = () => state.lastFinishedAt;

export const isSyncing = () => Boolean(inFlight);

export function syncState() {
  return {
    ...state,
    running: Boolean(inFlight),
    intervalSec: Math.round(DRIVE_SYNC.intervalMs / 1000),
    staleAfterSec: Math.round(DRIVE_SYNC.staleMs / 1000),
    enabled: DRIVE_SYNC.enabled,
    incremental: DRIVE_SYNC.incremental && Boolean(changeToken),
    driveReady: storage.driveReady(),
    ageSec: state.lastFinishedAt
      ? Math.round((Date.now() - Date.parse(state.lastFinishedAt)) / 1000)
      : null,
  };
}

const isStale = () =>
  !state.lastFinishedAt || Date.now() - Date.parse(state.lastFinishedAt) > DRIVE_SYNC.staleMs;

/**
 * Runs a Drive → catalogue sync, or joins the one already running.
 * `mode` is 'auto' (incremental when a change token is held, full otherwise),
 * 'full' (always walk the whole tree) or 'incremental'.
 */
export function syncDrive({ userId = 'system', trigger = 'manual', mode = 'auto' } = {}) {
  if (inFlight) return inFlight;
  inFlight = run({ userId, trigger, mode }).finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Used by the read path. Returns without touching Drive when the catalogue was
 * refreshed recently; otherwise waits for a sync, but only for `waitMs` — a slow
 * Drive must never hold a page load open, so a run that overruns keeps going in
 * the background and lands in the next response.
 */
export async function ensureFresh({ waitMs = DRIVE_SYNC.waitMs, trigger = 'lazy' } = {}) {
  if (!DRIVE_SYNC.enabled || !storage.driveReady()) return { synced: false, reason: 'unavailable' };
  if (!inFlight && !isStale()) return { synced: false, reason: 'fresh' };

  const job = syncDrive({ trigger, mode: 'auto' }).catch(() => null);
  if (waitMs <= 0) return { synced: false, reason: 'background' };

  let timer;
  const raced = await Promise.race([
    job.then((summary) => ({ done: true, summary })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ done: false }), waitMs); }),
  ]);
  clearTimeout(timer);
  return raced.done
    ? { synced: true, summary: raced.summary }
    : { synced: false, reason: 'timeout' };
}

/** Express middleware: freshen the catalogue before serving a library read. */
export function freshen(req, _res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  ensureFresh({ trigger: 'page-load' }).catch(() => null).then(() => next());
}

// ── The mirror ──────────────────────────────────────────────────────────────

async function loadToken() {
  if (tokenLoaded) return;
  tokenLoaded = true;
  const meta = await readMeta().catch(() => null);
  changeToken = meta?.driveChangeToken ?? null;
}

async function rememberToken(token) {
  if (!token || token === changeToken) return;
  changeToken = token;
  await writeMeta({ driveChangeToken: token, driveChangeTokenAt: new Date().toISOString() }).catch(() => null);
}

/**
 * Collects the Drive-side picture the mirror works from.
 *
 * A full walk returns every folder and file under the assets root. An
 * incremental pass returns only what Drive says changed, which is two orders of
 * magnitude cheaper but tells us nothing about untouched files — so `partial`
 * marks the difference and the caller skips the passes that need a whole tree.
 */
async function survey(mode) {
  await loadToken();
  const wantIncremental = mode === 'incremental'
    || (mode === 'auto' && DRIVE_SYNC.incremental && Boolean(changeToken) && Boolean(state.lastFinishedAt));

  if (wantIncremental) {
    try {
      const { changes, startPageToken: next, pages } = await listChanges({ pageToken: changeToken });
      await rememberToken(next);
      const files = [];
      const folders = [];
      const removed = new Set();
      for (const change of changes) {
        if (change.removed || !change.file) { removed.add(change.fileId); continue; }
        if (change.file.mimeType === FOLDER_MIME) folders.push(change.file);
        else files.push(change.file);
      }
      return { files, folders, removed, pages, partial: true };
    } catch (err) {
      // An expired or rejected token is not an error worth failing the run over.
      if (!isNotFound(err) && err?.status !== 400) throw err;
      changeToken = null;
    }
  }

  const { files, folders, pages } = await storage.inventory({ includeTrashed: true });
  const token = await startPageToken().catch(() => null);
  await rememberToken(token);
  return { files, folders, removed: new Set(), pages, partial: false };
}

/**
 * True when a Drive item sits inside the assets root. The Changes feed is
 * account-wide, so an incremental pass sees files from unrelated folders too and
 * has to reject them; a full walk only ever produces items already in scope.
 */
function scopedTo(item, { driveFolders, knownFolderDriveIds }) {
  const parent = item.parents?.[0] ?? null;
  if (!parent) return false;
  if (!ROOTS.assets) return false;
  const guard = new Set();
  let cursor = parent;
  while (cursor && !guard.has(cursor)) {
    if (cursor === ROOTS.assets) return true;
    if (knownFolderDriveIds.has(cursor)) return true;
    guard.add(cursor);
    cursor = driveFolders.get(cursor)?.parents?.[0] ?? null;
  }
  return false;
}

function quarantineSubtree(folders) {
  const quarantined = new Set();
  if (!ROOTS.quarantine) return quarantined;
  quarantined.add(ROOTS.quarantine);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (!quarantined.has(f.id) && quarantined.has(f.parents?.[0])) {
        quarantined.add(f.id);
        grew = true;
      }
    }
  }
  return quarantined;
}

async function run({ userId, trigger, mode }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  state.lastStartedAt = startedAt;
  state.lastTrigger = trigger;

  const counts = EMPTY_COUNTS();

  if (!storage.driveReady()) {
    state.lastError = 'Google Drive is not reachable.';
    state.lastFinishedAt = new Date().toISOString();
    return summarise({ startedAt, t0, trigger, mode: 'skipped', counts, scanned: { files: 0, folders: 0 }, pages: 0 });
  }

  let survey_;
  try {
    survey_ = await survey(mode);
  } catch (err) {
    state.lastError = err.message;
    state.lastFinishedAt = new Date().toISOString();
    throw err;
  }

  const { files, folders, removed, pages, partial } = survey_;

  const driveFolders = new Map(folders.map((f) => [f.id, f]));
  // A full walk only reports folders under the root, so anything it did not see
  // is out of scope; an incremental pass needs the catalogue's own set to decide.
  const knownFolderDriveIds = new Set(
    db.folders.filter((f) => !f.deletedAt && f.driveFolderId).map((f) => f.driveFolderId),
  );

  const inScope = partial
    ? (item) => scopedTo(item, { driveFolders, knownFolderDriveIds })
    : () => true;

  const quarantined = quarantineSubtree([...driveFolders.values()]);
  const now = new Date().toISOString();
  const types = allTypes();

  // ── Folders ───────────────────────────────────────────────────────────────
  // Adopted first and in two passes, because a child can be walked before its
  // parent and its parentId cannot be resolved until every id exists.

  const folderByDriveId = new Map(
    db.folders.filter((f) => !f.deletedAt && f.driveFolderId).map((f) => [f.driveFolderId, f]),
  );
  // Deleting a folder here trashes it in Drive. If that call failed the Drive
  // folder is still standing, and adopting it would put back something somebody
  // deliberately removed — so a drive id any row has ever claimed is off limits.
  const claimed = new Set(db.folders.filter((f) => f.driveFolderId).map((f) => f.driveFolderId));
  const adoptedFolders = [];

  for (const drive of driveFolders.values()) {
    if (quarantined.has(drive.id)) continue;
    const existing = folderByDriveId.get(drive.id);

    if (existing) {
      if (drive.trashed) {
        if (existing.driveState !== 'TRASHED') {
          existing.driveState = 'TRASHED';
          existing.updatedAt = now;
        }
        continue;
      }
      if (existing.driveState) { existing.driveState = null; existing.updatedAt = now; }
      // Drive is the source of truth for a folder's name and place: renaming or
      // moving a folder in the app writes through to Drive, so any difference
      // found here was made on the Drive side and should be followed.
      if (drive.name && drive.name !== existing.name) {
        existing.name = drive.name;
        existing.updatedAt = now;
        counts.foldersRenamed += 1;
      }
      const driveParent = drive.parents?.[0] ?? null;
      const mappedParent = driveParent && driveParent !== ROOTS.assets
        ? folderByDriveId.get(driveParent)?._id ?? null
        : null;
      if ((existing.parentId ?? null) !== mappedParent && (mappedParent || driveParent === ROOTS.assets)) {
        existing.parentId = mappedParent;
        existing.updatedAt = now;
        counts.foldersRefiled += 1;
      }
      if (drive.webViewLink && drive.webViewLink !== existing.driveWebViewLink) {
        existing.driveWebViewLink = drive.webViewLink;
      }
      continue;
    }

    if (drive.trashed) continue;
    if (claimed.has(drive.id)) continue;
    if (!inScope(drive)) continue;

    const folder = {
      _id: `folder_${uuid().slice(0, 8)}`,
      name: drive.name,
      description: 'Found in Google Drive and added automatically.',
      tags: ['Imported'],
      parentId: null, // resolved below, once every id exists
      driveFolderId: drive.id,
      driveWebViewLink: drive.webViewLink ?? null,
      driveState: null,
      songId: null,
      artistId: null,
      createdBy: userId,
      createdAt: drive.createdTime ?? now,
      updatedAt: now,
      deletedAt: null,
    };
    folderByDriveId.set(drive.id, folder);
    knownFolderDriveIds.add(drive.id);
    adoptedFolders.push({ folder, driveParentId: drive.parents?.[0] ?? null });
    counts.foldersAdopted += 1;
  }

  for (const { folder, driveParentId } of adoptedFolders) {
    folder.parentId = driveParentId && driveParentId !== ROOTS.assets
      ? folderByDriveId.get(driveParentId)?._id ?? null
      : null;
  }
  for (const { folder } of adoptedFolders) db.folders.unshift(folder);

  // ── Files ─────────────────────────────────────────────────────────────────

  const tracked = new Map();
  for (const song of db.songs) {
    for (const asset of song.assets || []) {
      if (asset.drive?.fileId) tracked.set(asset.drive.fileId, { asset, song });
    }
  }
  for (const asset of db.unfiled) {
    if (asset.drive?.fileId) tracked.set(asset.drive.fileId, { asset, song: null });
  }

  const folderNameOf = (folderId) =>
    (folderId ? db.folders.find((f) => f._id === folderId)?.name : null) ?? null;
  const folderIdForParent = (parentDriveId) =>
    parentDriveId && parentDriveId !== ROOTS.assets
      ? folderByDriveId.get(parentDriveId)?._id ?? null
      : null;

  const adoptedAssets = [];

  for (const file of files) {
    if (file.mimeType === FOLDER_MIME) continue;
    const known = tracked.get(file.id);

    if (known) {
      mirrorAsset(known.asset, file, { now, counts, folderIdForParent, folderNameOf });
      continue;
    }

    if (file.trashed) continue;
    if (quarantined.has(file.parents?.[0])) { counts.skippedQuarantined += 1; continue; }
    if (!inScope(file)) continue;
    if (storage.isBlockedType(file.mimeType) || storage.isBlockedExtension(file.name)) {
      counts.skippedBlocked += 1;
      continue;
    }

    const folderId = folderIdForParent(file.parents?.[0] ?? null);
    const folderName = folderNameOf(folderId);
    const type = typeForFamily(familyFromMime(file.mimeType), types);
    const assetId = file.appProperties?.assetId || uuid();
    const bound = storage.binding(file, { path: `${folderName ? `${folderName}/` : ''}${file.name}` });

    const asset = {
      assetId,
      displayName: file.name,
      originalName: file.name,
      description: 'Found in Google Drive and added automatically.',
      type,
      family: resolveFamily(type),
      format: '',
      folderId,
      drive: bound,
      availability: {
        status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now,
        checkMethod: 'DRIVE_SYNC', detail: null,
      },
      lastHead: null,
      versionGroupId: `vg_${assetId.slice(0, 8)}`,
      version: 'V1',
      isCurrent: true,
      supersedes: null,
      mimeType: bound.mimeType,
      durationSec: bound.durationSec,
      dimensions: bound.dimensions,
      tags: ['Imported'],
      checksumSHA256: bound.sha256,
      uploadedBy: userId,
      createdAt: bound.createdAt ?? now,
      updatedAt: now,
      renamedAt: null,
      deletedAt: null,
      relocateStatus: null,
    };
    adoptedAssets.push(asset);
    tracked.set(file.id, { asset, song: null });
    counts.filesAdopted += 1;
  }

  for (const asset of adoptedAssets) db.unfiled.push(asset);

  // A file the Changes feed reported as removed, or one a full walk no longer
  // finds, is flagged — never deleted. Reconciliation raises it for a human.
  if (partial) {
    for (const fileId of removed) {
      const known = tracked.get(fileId);
      if (known && !known.asset.permanentlyLost) markMissing(known.asset, now, counts);
    }
  } else {
    // A full walk covers the assets tree only, so "not seen" also describes a
    // file somebody dragged out of the library folder — still perfectly present
    // in Drive. One files.get settles which it is; the catalogue must not call a
    // file lost on the strength of an absence from a listing.
    const seen = new Set(files.map((f) => f.id));
    const vanished = [];
    for (const [fileId, { asset }] of tracked) {
      if (seen.has(fileId) || asset.permanentlyLost || asset.deletedAt) continue;
      if (asset.availability?.status === 'MISSING') continue;
      vanished.push(asset);
    }
    const probed = vanished.slice(0, DRIVE_SYNC.maxProbes);
    if (probed.length) {
      await mapLimit(probed, HEAD_CONCURRENCY, (asset) => storage.verifyAsset(asset).catch(() => null));
      counts.missing += probed.filter((a) => a.availability?.status === 'MISSING').length;
    }
  }

  const changed = countChanges(counts);
  if (changed > 0) persist();

  state.lastError = null;
  state.lastCounts = counts;
  state.lastChanged = changed;
  state.lastFinishedAt = new Date().toISOString();
  state.lastMode = partial ? 'incremental' : 'full';
  state.runs += 1;

  const summary = summarise({
    startedAt, t0, trigger,
    mode: partial ? 'incremental' : 'full',
    counts,
    scanned: { files: files.length, folders: driveFolders.size },
    pages,
  });

  announce(summary, { userId, trigger });
  return summary;
}

function markMissing(asset, now, counts) {
  if (asset.availability?.status === 'MISSING') return;
  asset.availability = {
    status: 'MISSING',
    lastCheckedAt: now,
    lastVerifiedAt: asset.availability?.lastVerifiedAt ?? null,
    checkMethod: 'DRIVE_SYNC',
    detail: 'Google Drive no longer holds this file. Nothing was removed from the catalogue — an administrator can review it under Storage health.',
  };
  counts.missing += 1;
}

/**
 * Brings one catalogue row back in line with its Drive file. Every field written
 * here is one Drive owns: the app writes its own changes through to Drive first,
 * so a difference at this point was made on the Drive side.
 */
function mirrorAsset(asset, file, { now, counts, folderIdForParent, folderNameOf }) {
  if (asset.deletedAt) return;

  if (file.trashed) {
    if (asset.availability?.status !== 'TRASHED') {
      asset.availability = {
        status: 'TRASHED',
        lastCheckedAt: now,
        lastVerifiedAt: now,
        checkMethod: 'DRIVE_SYNC',
        detail: "In Google Drive's trash. Restore it there to make it downloadable again.",
      };
      counts.trashed += 1;
    }
    asset.drive = { ...asset.drive, trashed: true };
    return;
  }

  const was = asset.availability?.status;
  if (was === 'TRASHED' || was === 'MISSING') counts.restored += 1;

  if (file.name && file.name !== asset.displayName) {
    asset.displayName = file.name;
    asset.renamedAt = now;
    asset.updatedAt = now;
    counts.renamed += 1;
  }

  const liveParent = file.parents?.[0] ?? null;
  if (liveParent && liveParent !== (asset.drive?.parentId ?? null)) {
    // An incremental pass can see a file whose new parent folder it has not
    // walked. Guessing "library root" there would move the file for real, so a
    // parent we cannot map is left alone for the next full walk to settle.
    const mapped = folderIdForParent(liveParent);
    if (mapped || liveParent === ROOTS.assets) {
      asset.folderId = mapped;
      asset.updatedAt = now;
      counts.refiled += 1;
    }
  }

  const recordedSum = asset.drive?.sha256 || asset.drive?.md5;
  const liveSum = file.sha256Checksum || file.md5Checksum;
  const liveSize = file.size == null ? 0 : Number(file.size);
  if ((recordedSum && liveSum && recordedSum !== liveSum)
    || (asset.drive?.sizeBytes != null && !asset.drive?.googleNative && liveSize !== asset.drive.sizeBytes)) {
    counts.contentChanged += 1;
    asset.updatedAt = now;
  }

  const path = `${folderNameOf(asset.folderId) ? `${folderNameOf(asset.folderId)}/` : ''}${asset.displayName}`;
  asset.drive = { ...asset.drive, ...storage.binding(file, { path }) };
  asset.mimeType = asset.drive.mimeType;
  if (asset.drive.durationSec != null) asset.durationSec = asset.drive.durationSec;
  if (asset.drive.dimensions) asset.dimensions = asset.drive.dimensions;
  asset.availability = {
    status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now,
    checkMethod: 'DRIVE_SYNC', detail: null,
  };
}

// Everything except the two "we deliberately left this alone" tallies.
const countChanges = (counts) =>
  Object.entries(counts)
    .filter(([key]) => !key.startsWith('skipped'))
    .reduce((n, [, v]) => n + v, 0);

function summarise({ startedAt, t0, trigger, mode, counts, scanned, pages }) {
  const adopted = counts.foldersAdopted + counts.filesAdopted;
  const changed = countChanges(counts);
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    trigger,
    mode,
    scanned,
    listPages: pages,
    counts,
    adopted,
    changed,
    // Kept for the callers that predate this module.
    dryRun: false,
    imported: { folders: counts.foldersAdopted, assets: counts.filesAdopted },
    skipped: { blocked: counts.skippedBlocked, quarantined: counts.skippedQuarantined },
  };
}

const worker = (userId) => ({
  ip: '127.0.0.1',
  get: () => 'drive-sync',
  user: { sub: userId, name: 'Drive sync', role: 'system' },
});

function announce(summary, { userId, trigger }) {
  if (summary.changed === 0) return;

  const parts = [];
  if (summary.counts.filesAdopted) parts.push(`${summary.counts.filesAdopted} file${summary.counts.filesAdopted === 1 ? '' : 's'}`);
  if (summary.counts.foldersAdopted) parts.push(`${summary.counts.foldersAdopted} folder${summary.counts.foldersAdopted === 1 ? '' : 's'}`);
  const renames = summary.counts.renamed + summary.counts.foldersRenamed;
  const moves = summary.counts.refiled + summary.counts.foldersRefiled;

  record(worker(userId), {
    action: 'DRIVE_SYNC',
    entity: 'storage',
    entityId: ROOTS.assets ?? 'drive',
    label: parts.length
      ? `Picked up ${parts.join(' and ')} added straight to Google Drive`
      : `Followed ${renames + moves} change${renames + moves === 1 ? '' : 's'} made in Google Drive`,
    after: summary.counts,
    meta: { trigger, mode: summary.mode, durationMs: summary.durationMs },
  });

  if (summary.adopted > 0 && trigger !== 'manual') {
    notify({
      audience: 'admin',
      category: 'storage',
      level: 'ok',
      title: `${parts.join(' and ')} added from Google Drive`,
      body: 'Somebody put these into the Drive folder directly. They are in the library now and ready to tag.',
      link: '/folders',
    });
  }
}

/** Boot-time timer. Returns a stop function. */
export function startAutoSync() {
  if (!DRIVE_SYNC.enabled) return () => {};
  const tick = () => {
    syncDrive({ trigger: 'scheduled', mode: 'auto' })
      .catch((err) => console.error('[drive-sync]', err.message));
  };
  const timer = setInterval(tick, DRIVE_SYNC.intervalMs);
  if (timer.unref) timer.unref();
  setTimeout(tick, DRIVE_SYNC.firstRunDelayMs).unref?.();
  return () => clearInterval(timer);
}
