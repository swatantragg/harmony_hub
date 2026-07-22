// ReconcileService — the authoritative answer to "does the catalogue still match the
// bucket?" (§10.11). Four phases: inventory S3, inventory the database, compare, act.
import { db, persist, allAssets } from '../db.js';
import { BUCKETS } from '../config.js';
import { uuid } from '../util/crypto.js';
import * as s3 from '../s3/localS3.js';
import { verifyAsset } from './storage.js';
import { notify, record } from './audit.js';

// `applyAvailability: false` produces the drift report without rewriting every asset's
// availability block — an inventory-only pass, used to give a freshly seeded library a
// prior run to show while leaving never-checked assets honestly marked UNVERIFIED.
export function runReconciliation(req, { trigger = 'manual', applyAvailability = true } = {}) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  // PHASE 1 — build the S3 inventory.
  const { contents } = s3.listObjectsV2({ bucket: BUCKETS.assets, prefix: 'assets/' });
  const inS3 = new Map(contents.map((o) => [o.key, o]));

  // PHASE 2 — build the database inventory.
  const rows = allAssets();
  const inDb = new Map(rows.map(({ asset, song }) => [asset.s3.key, { asset, song }]));

  // PHASE 3 — compare.
  const findings = [];
  for (const [key, { asset, song }] of inDb) {
    const obj = inS3.get(key);
    if (!obj) {
      findings.push({
        _id: uuid(),
        kind: 'MISSING_IN_S3',
        severity: 'critical',
        key,
        assetId: asset.assetId,
        displayName: asset.displayName,
        songId: song._id,
        songTitle: song.title,
        detail: `Catalogued in the library but absent from ${BUCKETS.assets}`,
        resolvedAt: null,
      });
      continue;
    }
    if (obj.size !== asset.s3.sizeBytes) {
      findings.push({
        _id: uuid(),
        kind: 'SIZE_MISMATCH',
        severity: 'integrity',
        key,
        assetId: asset.assetId,
        displayName: asset.displayName,
        songId: song._id,
        songTitle: song.title,
        detail: `Catalogue records ${asset.s3.sizeBytes} bytes, storage holds ${obj.size}`,
        expected: asset.s3.sizeBytes,
        actual: obj.size,
        resolvedAt: null,
      });
    } else if (asset.s3.etag && obj.etag !== asset.s3.etag) {
      findings.push({
        _id: uuid(),
        kind: 'ETAG_MISMATCH',
        severity: 'integrity',
        key,
        assetId: asset.assetId,
        displayName: asset.displayName,
        songId: song._id,
        songTitle: song.title,
        detail: `Checksum drift — catalogue ${asset.s3.etag}, storage ${obj.etag}`,
        expected: asset.s3.etag,
        actual: obj.etag,
        resolvedAt: null,
      });
    }
    if (obj.storageClass !== asset.s3.storageClass) {
      findings.push({
        _id: uuid(),
        kind: 'CLASS_DRIFT',
        severity: 'informational',
        key,
        assetId: asset.assetId,
        displayName: asset.displayName,
        songId: song._id,
        songTitle: song.title,
        detail: `Storage class moved ${asset.s3.storageClass} → ${obj.storageClass} (expected after a lifecycle transition)`,
        expected: asset.s3.storageClass,
        actual: obj.storageClass,
        resolvedAt: null,
      });
    }
  }
  for (const [key, obj] of inS3) {
    if (inDb.has(key)) continue;
    findings.push({
      _id: uuid(),
      kind: 'UNTRACKED_IN_S3',
      severity: 'orphan',
      key,
      assetId: null,
      displayName: key.split('/').pop(),
      detail: `Object present in storage with no catalogue record (${obj.size} bytes)`,
      sizeBytes: obj.size,
      resolvedAt: null,
    });
  }

  // PHASE 4 — act: refresh every availability block, store the run, alert on criticals.
  if (applyAvailability) for (const { asset } of rows) verifyAsset(asset);

  const counts = {
    MISSING_IN_S3: 0, UNTRACKED_IN_S3: 0, SIZE_MISMATCH: 0, ETAG_MISMATCH: 0, CLASS_DRIFT: 0,
  };
  for (const f of findings) counts[f.kind] += 1;

  const run = {
    _id: uuid(),
    trigger,
    startedBy: req.user?.name ?? 'scheduler',
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    objectsScanned: inS3.size,
    assetsScanned: inDb.size,
    counts,
    findings,
    ok: findings.filter((f) => f.severity === 'critical').length === 0,
  };
  db.reconciliationRuns.unshift(run);
  if (db.reconciliationRuns.length > 40) db.reconciliationRuns.length = 40;

  record(req, {
    action: 'RECONCILE_RUN',
    entity: 'storage',
    entityId: run._id,
    label: `Reconciliation — ${inS3.size} objects scanned`,
    after: { counts, objectsScanned: inS3.size },
  });

  if (counts.MISSING_IN_S3 > 0) {
    notify({
      level: 'danger',
      title: `${counts.MISSING_IN_S3} file${counts.MISSING_IN_S3 > 1 ? 's' : ''} missing from storage`,
      body: 'Reconciliation found catalogued assets with no object behind them. Review and remediate.',
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
  const byStatus = { AVAILABLE: 0, UNVERIFIED: 0, ARCHIVED: 0, RESTORING: 0, MISSING: 0, MISMATCH: 0 };
  let bytes = 0;
  for (const { asset } of rows) {
    byStatus[asset.availability?.status ?? 'UNVERIFIED'] += 1;
    bytes += asset.s3?.sizeBytes ?? 0;
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
