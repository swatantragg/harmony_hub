// ReconcileService — the authoritative answer to "does the catalogue still match the
// Drive?" (§10.11). Four phases: inventory Drive, inventory the database, compare, act.
//
// One listing returns the checksum, the size, the trashed flag and the parent folder
// together, so almost every question is answered without a second call.
//
// The hard part is that a Drive is a place people can open and rearrange by hand — a file
// can be renamed, dragged to another folder, or thrown in the trash without Harmony Hub
// ever hearing about it. Those are not errors; they are the normal life of a shared Drive.
// So the drift report treats them as findings with obvious remedies rather than as
// corruption.
import { db, persist, allAssets } from '../db.js';
import { HEAD_CONCURRENCY, ROOTS, TRASH_DAYS } from '../config.js';
import { uuid } from '../util/crypto.js';
import * as storage from './storage.js';
import { mapLimit, FOLDER_MIME } from '../storage/drive.js';
import { notify, record } from './audit.js';

// A run is a full-Drive walk, so two of them at once is only ever waste.
let running = null;

// `applyAvailability: false` produces the drift report without rewriting every asset's
// availability block — an inventory-only pass, used to give a freshly seeded library a
// prior run to show while leaving never-checked assets honestly marked UNVERIFIED.
export async function runReconciliation(req, { trigger = 'manual', applyAvailability = true } = {}) {
  if (running) return running;
  running = reconcile(req, { trigger, applyAvailability });
  try {
    return await running;
  } finally {
    running = null;
  }
}

async function reconcile(req, { trigger, applyAvailability }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // PHASE 1 — walk the Drive. Trashed files are included deliberately: a file somebody
  // dropped in the bin is the single most common drift in a shared Drive, and a listing
  // that hides it would report the file as missing and send an admin hunting for nothing.
  const { files, folders, pages } = await storage.inventory({ includeTrashed: true });
  const inDrive = new Map(files.map((f) => [f.id, f]));
  const driveFolders = new Map(folders.map((f) => [f.id, f]));

  // PHASE 2 — build the database inventory.
  const rows = allAssets();
  const inDb = new Map(rows.filter(({ asset }) => asset.drive?.fileId).map(({ asset, song }) => [asset.drive.fileId, { asset, song }]));

  // Folder ids the catalogue believes in, so an untracked *folder* is reported separately
  // from an untracked file — they need different remedies.
  const knownFolderIds = new Set(db.folders.filter((f) => !f.deletedAt && f.driveFolderId).map((f) => f.driveFolderId));
  const folderNameById = new Map(db.folders.map((f) => [f.driveFolderId, f.name]));

  // PHASE 3 — compare.
  const findings = [];
  const finding = (kind, severity, fileId, asset, song, extra = {}) => ({
    _id: uuid(),
    kind,
    severity,
    fileId,
    // Kept under the old name too so the activity log and any saved run stay readable.
    key: fileId,
    assetId: asset?.assetId ?? null,
    displayName: asset?.displayName ?? extra.driveName ?? fileId,
    songId: song?._id ?? null,
    songTitle: song?.title ?? null,
    webViewLink: extra.webViewLink ?? null,
    resolvedAt: null,
    ...extra,
  });

  for (const [fileId, { asset, song }] of inDb) {
    const file = inDrive.get(fileId);
    if (!file) {
      findings.push(finding('MISSING_IN_DRIVE', 'critical', fileId, asset, song, {
        detail: 'Catalogued in the library, but Google Drive has no file with this id — permanently deleted, or moved out of the Harmony Hub folder.',
      }));
      continue;
    }

    if (file.trashed) {
      findings.push(finding('TRASHED_IN_DRIVE', 'critical', fileId, asset, song, {
        detail: `Somebody moved this file to the Drive trash. Google empties the trash after ${TRASH_DAYS} days, after which it is unrecoverable.`,
        webViewLink: file.webViewLink,
      }));
    }

    const liveSize = file.size == null ? 0 : Number(file.size);
    const recordedSize = asset.drive?.sizeBytes;
    const recordedSum = asset.drive?.sha256 || asset.drive?.md5;
    const liveSum = asset.drive?.sha256 ? file.sha256Checksum : file.md5Checksum;

    if (!asset.drive?.googleNative && recordedSize != null && liveSize !== recordedSize) {
      findings.push(finding('SIZE_MISMATCH', 'integrity', fileId, asset, song, {
        detail: `Catalogue records ${recordedSize} bytes, Drive holds ${liveSize}. The file was replaced outside Harmony Hub.`,
        expected: recordedSize,
        actual: liveSize,
        webViewLink: file.webViewLink,
      }));
    } else if (recordedSum && liveSum && liveSum !== recordedSum) {
      findings.push(finding('CHECKSUM_MISMATCH', 'integrity', fileId, asset, song, {
        detail: `Same size, different contents — catalogue ${String(recordedSum).slice(0, 16)}…, Drive ${String(liveSum).slice(0, 16)}…`,
        expected: recordedSum,
        actual: liveSum,
        webViewLink: file.webViewLink,
      }));
    }

    // Drive-specific, and the drift people actually cause: a file dragged into another
    // folder in the Drive UI. Nothing is damaged — the catalogue simply now describes the
    // wrong shelf, and the remedy is to believe Drive.
    const liveParent = file.parents?.[0] ?? null;
    const recordedParent = asset.drive?.parentId ?? null;
    if (liveParent && recordedParent && liveParent !== recordedParent) {
      findings.push(finding('PARENT_DRIFT', 'orphan', fileId, asset, song, {
        detail: `Moved in Drive from “${folderNameById.get(recordedParent) ?? 'the library root'}” to “${driveFolders.get(liveParent)?.name ?? folderNameById.get(liveParent) ?? 'an unknown folder'}”.`,
        expected: recordedParent,
        actual: liveParent,
        actualFolderName: driveFolders.get(liveParent)?.name ?? null,
        webViewLink: file.webViewLink,
      }));
    }

    // Renamed by hand in Drive. Harmless, and worth surfacing because the two names
    // disagreeing is confusing for everybody.
    if (file.name && asset.displayName && file.name !== asset.displayName) {
      findings.push(finding('NAME_DRIFT', 'informational', fileId, asset, song, {
        detail: `Renamed in Drive to “${file.name}”, while the catalogue still says “${asset.displayName}”.`,
        expected: asset.displayName,
        actual: file.name,
        webViewLink: file.webViewLink,
      }));
    }
  }

  for (const [fileId, file] of inDrive) {
    if (inDb.has(fileId)) continue;
    if (file.trashed) continue; // Somebody's discarded file is not the library's problem.
    findings.push(finding('UNTRACKED_IN_DRIVE', 'orphan', fileId, null, null, {
      detail: `Dropped into the Harmony Hub folder without going through the app (${file.size ? `${file.size} bytes` : 'no stored bytes'}). Invisible to search until it is adopted.`,
      driveName: file.name,
      sizeBytes: file.size == null ? 0 : Number(file.size),
      mimeType: file.mimeType,
      parentFolderName: driveFolders.get(file.parents?.[0])?.name ?? null,
      webViewLink: file.webViewLink,
    }));
  }

  for (const [folderId, folder] of driveFolders) {
    if (knownFolderIds.has(folderId) || folder.trashed) continue;
    findings.push(finding('UNTRACKED_FOLDER', 'informational', folderId, null, null, {
      detail: `A folder called “${folder.name}” exists in Drive with no Harmony Hub folder behind it. Adopt it to make its files browsable here.`,
      driveName: folder.name,
      mimeType: FOLDER_MIME,
      webViewLink: folder.webViewLink,
    }));
  }

  // PHASE 4 — act: refresh every availability block, store the run, alert on criticals.
  //
  // The listing already answers "is it there, is it the same size, is it in the bin" for
  // every file in one pass, so availability is derived from it rather than from N
  // files.get calls — that is what checkMethod: LIST_RECONCILE means. Only the handful
  // the listing could not settle get an individual read.
  let readsIssued = 0;
  if (applyAvailability) {
    const now = new Date().toISOString();
    const needRead = [];

    for (const { asset } of rows) {
      if (!asset.drive?.fileId) continue;
      const file = inDrive.get(asset.drive.fileId);
      const keep = asset.availability?.lastVerifiedAt ?? null;
      const base = { lastCheckedAt: now, checkMethod: 'LIST_RECONCILE' };

      if (!file) {
        // A file the walk did not see might genuinely be gone, or might have been moved
        // outside the Harmony Hub root — which the walk cannot see but files.get can.
        needRead.push(asset);
        continue;
      }
      if (file.trashed) {
        asset.availability = {
          ...base,
          status: 'TRASHED',
          lastVerifiedAt: now,
          detail: `In Google Drive's trash. Restore it to make it downloadable again — Drive empties the trash after ${TRASH_DAYS} days.`,
        };
      } else if (asset.drive.googleNative) {
        asset.availability = { ...base, status: 'AVAILABLE', lastVerifiedAt: now, detail: null };
      } else {
        const liveSize = file.size == null ? 0 : Number(file.size);
        const recordedSum = asset.drive?.sha256 || asset.drive?.md5;
        const liveSum = asset.drive?.sha256 ? file.sha256Checksum : file.md5Checksum;
        const drifted = (asset.drive.sizeBytes != null && liveSize !== asset.drive.sizeBytes)
          || (recordedSum && liveSum && liveSum !== recordedSum);
        asset.availability = drifted
          ? {
            ...base,
            status: 'MISMATCH',
            lastVerifiedAt: now,
            detail: `The file was changed in Google Drive outside Harmony Hub (size ${asset.drive.sizeBytes} → ${liveSize})`,
          }
          : { ...base, status: 'AVAILABLE', lastVerifiedAt: now, detail: null };
      }

      asset.lastHead = {
        sizeBytes: file.size == null ? 0 : Number(file.size),
        md5: file.md5Checksum ?? null,
        sha256: file.sha256Checksum ?? null,
        revisionId: file.headRevisionId ?? null,
        mimeType: file.mimeType,
        modifiedAt: file.modifiedTime ?? null,
        parentId: file.parents?.[0] ?? null,
        trashed: Boolean(file.trashed),
      };
      void keep;
    }

    await mapLimit(needRead, HEAD_CONCURRENCY, async (asset) => {
      readsIssued += 1;
      return storage.verifyAsset(asset);
    });
  }

  const counts = {
    MISSING_IN_DRIVE: 0, TRASHED_IN_DRIVE: 0, UNTRACKED_IN_DRIVE: 0, UNTRACKED_FOLDER: 0,
    SIZE_MISMATCH: 0, CHECKSUM_MISMATCH: 0, PARENT_DRIFT: 0, NAME_DRIFT: 0,
  };
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;

  // Quota is cheap to read and belongs with the run: "everything matched, and by the way
  // you are at 94% of your Drive" is the pair of facts an admin needs together.
  const space = await storage.quota().catch(() => null);

  const run = {
    _id: uuid(),
    trigger,
    startedBy: req.user?.name ?? 'scheduler',
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    objectsScanned: inDrive.size,
    foldersScanned: driveFolders.size,
    assetsScanned: inDb.size,
    listPages: pages,
    readsIssued,
    counts,
    findings,
    quota: space,
    rootFolderId: ROOTS.assets,
    ok: findings.filter((f) => f.severity === 'critical').length === 0,
  };
  db.reconciliationRuns.unshift(run);
  if (db.reconciliationRuns.length > 40) db.reconciliationRuns.length = 40;

  record(req, {
    action: 'RECONCILE_RUN',
    entity: 'storage',
    entityId: run._id,
    label: `Reconciliation — ${inDrive.size} Drive files scanned`,
    after: { counts, objectsScanned: inDrive.size },
  });

  if (counts.MISSING_IN_DRIVE > 0) {
    notify({
      level: 'danger',
      title: `${counts.MISSING_IN_DRIVE} file${counts.MISSING_IN_DRIVE > 1 ? 's' : ''} missing from Google Drive`,
      body: 'Reconciliation found catalogued assets with no Drive file behind them. Review and remediate.',
      link: '/admin/storage',
    });
  }
  if (counts.TRASHED_IN_DRIVE > 0) {
    notify({
      level: 'danger',
      title: `${counts.TRASHED_IN_DRIVE} catalogued file${counts.TRASHED_IN_DRIVE > 1 ? 's are' : ' is'} in the Drive trash`,
      body: `Restore them before Google empties the trash — that happens ${TRASH_DAYS} days after they were binned.`,
      link: '/admin/storage',
    });
  }
  if (space && !space.unlimited && space.percentUsed >= 90) {
    notify({
      level: 'warn',
      title: `Google Drive is ${space.percentUsed}% full`,
      body: 'New uploads will start failing when it fills. Free space, or move the library to a Shared Drive.',
      link: '/admin/storage',
    });
  }

  persist();
  return run;
}

export function latestRun() {
  return db.reconciliationRuns[0] ?? null;
}

// Health summary used by the dashboard tile and the Storage Health screen.
export function healthSummary() {
  const rows = allAssets();
  const byStatus = { AVAILABLE: 0, UNVERIFIED: 0, TRASHED: 0, RESTORING: 0, MISSING: 0, MISMATCH: 0 };
  let bytes = 0;
  for (const { asset } of rows) {
    const status = asset.availability?.status ?? 'UNVERIFIED';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    bytes += asset.drive?.sizeBytes ?? 0;
  }
  const run = latestRun();
  return {
    totalAssets: rows.length,
    totalBytes: bytes,
    byStatus,
    healthPct: rows.length ? Math.round((byStatus.AVAILABLE / rows.length) * 100) : 100,
    lastRun: run
      ? { _id: run._id, finishedAt: run.finishedAt, counts: run.counts, objectsScanned: run.objectsScanned, ok: run.ok }
      : null,
    openFindings: run ? run.findings.filter((f) => !f.resolvedAt).length : 0,
  };
}
