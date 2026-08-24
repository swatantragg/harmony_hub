import { db, persist, allAssets } from '../db.js';
import { HEAD_CONCURRENCY, ROOTS, TRASH_DAYS } from '../config.js';
import { uuid } from '../util/crypto.js';
import * as storage from './storage.js';
import { mapLimit, FOLDER_MIME } from '../storage/drive.js';
import { notify, record } from './audit.js';

let running = null;

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

  const { files, folders, pages } = await storage.inventory({ includeTrashed: true });
  const inDrive = new Map(files.map((f) => [f.id, f]));
  const driveFolders = new Map(folders.map((f) => [f.id, f]));

  const rows = allAssets();
  const inDb = new Map(rows.filter(({ asset }) => asset.drive?.fileId).map(({ asset, song }) => [asset.drive.fileId, { asset, song }]));

  const knownFolderIds = new Set(db.folders.filter((f) => !f.deletedAt && f.driveFolderId).map((f) => f.driveFolderId));
  const folderNameById = new Map(db.folders.map((f) => [f.driveFolderId, f.name]));

  const findings = [];
  const finding = (kind, severity, fileId, asset, song, extra = {}) => ({
    _id: uuid(),
    kind,
    severity,
    fileId,
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
        detail: 'Catalogued in the library, but Google Drive has no file with this id — permanently deleted, or moved out of the GCloud folder.',
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
        detail: `Catalogue records ${recordedSize} bytes, Drive holds ${liveSize}. The file was replaced outside GCloud.`,
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
    if (file.trashed) continue;
    findings.push(finding('UNTRACKED_IN_DRIVE', 'orphan', fileId, null, null, {
      detail: `Dropped into the GCloud folder without going through the app (${file.size ? `${file.size} bytes` : 'no stored bytes'}). Invisible to search until it is adopted.`,
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
      detail: `A folder called “${folder.name}” exists in Drive with no GCloud folder behind it. Adopt it to make its files browsable here.`,
      driveName: folder.name,
      mimeType: FOLDER_MIME,
      webViewLink: folder.webViewLink,
    }));
  }

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
            detail: `The file was changed in Google Drive outside GCloud (size ${asset.drive.sizeBytes} → ${liveSize})`,
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
