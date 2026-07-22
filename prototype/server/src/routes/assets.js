import express from 'express';
import { db, persist } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { context, shape, validateName } from '../services/assets.js';
import { record, notify } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { s3 } from '../services/storage.js';
import { TTL } from '../config.js';
import { VERSION_LABELS } from '../catalogue.js';
import { allTypes, resolveFamily } from '../services/vocabulary.js';
import { uuid } from '../util/crypto.js';

export const assetsRouter = express.Router();
assetsRouter.use(authenticate);

const notFound = (res) => problem(res, 404, 'Not Found', 'No asset with that id exists in the catalogue.');

// ── Bulk existence probe (§10.5.3) — declared before /:id so it is not shadowed ──
assetsRouter.post('/verify-batch', (req, res) => {
  const ids = Array.isArray(req.body?.assetIds) ? req.body.assetIds.slice(0, 500) : [];
  const summary = { available: 0, missing: 0, archived: 0, restoring: 0, mismatch: 0, unverified: 0 };
  const results = [];
  for (const id of ids) {
    const ctx = context(id);
    if (!ctx) {
      results.push({ assetId: id, status: 'MISSING', detail: 'No catalogue record' });
      summary.missing += 1;
      continue;
    }
    const { availability, s3Head } = storage.verifyAsset(ctx.asset);
    summary[availability.status.toLowerCase()] += 1;
    results.push({
      assetId: id,
      displayName: ctx.asset.displayName,
      status: availability.status,
      detail: availability.detail,
      sizeBytes: s3Head?.sizeBytes ?? null,
    });
  }
  persist();
  record(req, {
    action: 'ASSET_VERIFY_BATCH', entity: 'asset', entityId: 'batch',
    label: `Verified ${ids.length} assets against storage`, after: summary,
  });
  res.json({ checkedAt: new Date().toISOString(), summary, results });
});

assetsRouter.get('/catalogue', (_req, res) => {
  res.json({ types: allTypes(), versions: VERSION_LABELS });
});

assetsRouter.get('/:id', (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const versions = ctx.list
    .filter((a) => a.versionGroupId === ctx.asset.versionGroupId && !a.deletedAt)
    .map((a) => ({ assetId: a.assetId, version: a.version, displayName: a.displayName, isCurrent: a.isCurrent, createdAt: a.createdAt, sizeBytes: a.s3.sizeBytes }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const activity = db.activityLog.filter((e) => e.entityId === ctx.asset.assetId).slice(0, 25);
  const shares = db.shares.filter((s) => s.assetId === ctx.asset.assetId && !s.revokedAt);
  res.json({ ...shape(ctx), versions, activity, shares });
});

// ── Live availability check (§10.5.1) ───────────────────────────────────────
assetsRouter.post('/:id/verify', (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const before = ctx.asset.availability?.status;
  const { availability, s3Head } = storage.verifyAsset(ctx.asset);
  persist();

  if (availability.status === 'MISSING' && before !== 'MISSING') {
    notify({
      level: 'danger',
      title: `${ctx.asset.displayName} is missing from storage`,
      body: 'A live check found no object behind this catalogue record.',
      link: '/admin/storage',
    });
  }
  record(req, {
    action: 'ASSET_VERIFY', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Verified ${ctx.asset.displayName}`, before: { status: before }, after: { status: availability.status },
  });
  res.json({ assetId: ctx.asset.assetId, ...availability, s3: s3Head });
});

// ── Logical rename — the default, instant path (§10.4.1) ────────────────────
assetsRouter.patch('/:id/rename', requires('asset:rename'), (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  if (ctx.asset.rekeyStatus === 'IN_PROGRESS') {
    return problem(res, 409, 'Conflict', 'This asset is locked while a physical re-key is running.');
  }

  const { displayName, allowExtensionChange } = req.body || {};
  const check = validateName(displayName, {
    current: ctx.asset.displayName,
    siblings: ctx.list,
    allowExtensionChange: Boolean(allowExtensionChange),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problems.join(' '));

  const before = { displayName: ctx.asset.displayName };
  ctx.asset.displayName = check.value;
  ctx.asset.renamedAt = new Date().toISOString();
  ctx.asset.updatedAt = ctx.asset.renamedAt;

  // Step 7 — refresh the stored object metadata so the bucket stays self-describing.
  const metadataRefreshed = storage.refreshObjectMetadata(ctx.asset, ctx.song, ctx.artist);
  persist();

  record(req, {
    action: 'ASSET_RENAME', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Renamed to ${check.value}`, before, after: { displayName: check.value },
    meta: { objectKeyUnchanged: ctx.asset.s3.key, metadataRefreshed },
  });
  res.json({ ...shape(ctx), metadataRefreshed });
});

// Rename preflight — powers the live validation in the dialog.
assetsRouter.post('/:id/rename/check', (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const check = validateName(req.body?.displayName, {
    current: ctx.asset.displayName,
    siblings: ctx.list,
    allowExtensionChange: Boolean(req.body?.allowExtensionChange),
  });
  res.json({ ...check, downloadAs: check.value, objectKey: ctx.asset.s3.key });
});

// ── Physical re-key — explicit, Admin-only, asynchronous (§10.4.2) ──────────
assetsRouter.post('/:id/rekey', requires('asset:rekey'), (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const newKey = String(req.body?.newKey || '').trim();
  if (!/^assets\/[A-Za-z0-9._/-]+$/.test(newKey)) {
    return problem(res, 422, 'Unprocessable Entity', 'A new key must begin with "assets/" and use safe characters only.');
  }
  if (newKey === ctx.asset.s3.key) {
    return problem(res, 422, 'Unprocessable Entity', 'The new key is identical to the current one.');
  }

  ctx.asset.rekeyStatus = 'IN_PROGRESS';
  persist();
  const before = { key: ctx.asset.s3.key };

  // The worker path, run inline here. Every safety invariant from §10.4.2 is preserved:
  // copy, verify the destination independently, update the catalogue, and only then
  // delete the source. Any failure leaves the source authoritative.
  setTimeout(() => {
    try {
      const source = s3.headObject({ bucket: ctx.asset.s3.bucket, key: ctx.asset.s3.key });
      s3.copyObject({ bucket: ctx.asset.s3.bucket, sourceKey: ctx.asset.s3.key, destKey: newKey });
      const dest = s3.headObject({ bucket: ctx.asset.s3.bucket, key: newKey });

      if (dest.size !== source.size) {
        s3.deleteObject({ bucket: ctx.asset.s3.bucket, key: newKey });
        ctx.asset.rekeyStatus = 'FAILED';
        notify({ level: 'danger', title: 'Re-key failed', body: `${ctx.asset.displayName}: destination did not verify. The original is untouched.` });
      } else {
        const oldKey = ctx.asset.s3.key;
        ctx.asset.s3.key = newKey;
        ctx.asset.s3.versionId = dest.versionId;
        ctx.asset.s3.etag = dest.etag;
        s3.deleteObject({ bucket: ctx.asset.s3.bucket, key: oldKey });
        ctx.asset.rekeyStatus = 'COMPLETE';
        record({ ip: '10.0.0.1', get: () => 'worker', user: req.user }, {
          action: 'ASSET_REKEY', entity: 'asset', entityId: ctx.asset.assetId,
          label: `Re-keyed ${ctx.asset.displayName}`, before, after: { key: newKey },
        });
        notify({ level: 'ok', title: 'Re-key complete', body: `${ctx.asset.displayName} now lives at ${newKey}.` });
      }
    } catch (err) {
      ctx.asset.rekeyStatus = 'FAILED';
      notify({ level: 'danger', title: 'Re-key failed', body: String(err.message) });
    }
    persist();
  }, 2500);

  res.status(202).json({ accepted: true, assetId: ctx.asset.assetId, rekeyStatus: 'IN_PROGRESS', newKey });
});

// ── Retrieval (§10.2, §10.3) ────────────────────────────────────────────────
assetsRouter.post('/:id/download', requires('asset:download'), (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const { availability } = storage.verifyAsset(ctx.asset);
  if (availability.status === 'MISSING') {
    return problem(res, 409, 'Conflict', 'The object behind this record is not in storage. Download is blocked.');
  }
  if (availability.status === 'ARCHIVED') {
    return problem(res, 409, 'Conflict', 'This asset is archived. Request a restore before downloading.');
  }
  const url = storage.presignGet({
    bucket: ctx.asset.s3.bucket, key: ctx.asset.s3.key,
    expiresIn: TTL.download, filename: ctx.asset.displayName,
  });
  persist();
  record(req, {
    action: 'ASSET_DOWNLOAD', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Downloaded ${ctx.asset.displayName}`, meta: { ttlSeconds: TTL.download },
  });
  res.json({ url, expiresIn: TTL.download, downloadAs: ctx.asset.displayName });
});

assetsRouter.post('/:id/preview', (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const url = storage.presignGet({
    bucket: ctx.asset.s3.bucket, key: ctx.asset.s3.key,
    expiresIn: TTL.preview, filename: ctx.asset.displayName, inline: true,
  });
  res.json({ url, expiresIn: TTL.preview, contentType: ctx.asset.mimeType });
});

// ── Metadata update (§10.7) ─────────────────────────────────────────────────
const EDITABLE = ['displayName', 'description', 'type', 'tags', 'version'];

assetsRouter.patch('/:id', requires('asset:edit'), (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const before = {};
  const after = {};
  for (const field of EDITABLE) {
    if (!(field in (req.body || {}))) continue;
    if (field === 'displayName') {
      const check = validateName(req.body.displayName, { current: ctx.asset.displayName, siblings: ctx.list });
      if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problems.join(' '));
    }
    before[field] = ctx.asset[field];
    ctx.asset[field] = req.body[field];
    after[field] = req.body[field];
  }
  if (after.type) ctx.asset.family = resolveFamily(after.type);
  ctx.asset.updatedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'ASSET_UPDATE', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Updated ${ctx.asset.displayName}`, before, after,
  });
  res.json(shape(ctx));
});

// ── Archive restore (§10.9) ─────────────────────────────────────────────────
assetsRouter.post('/:id/restore', requires('asset:restore'), (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const tier = ['Expedited', 'Standard', 'Bulk'].includes(req.body?.tier) ? req.body.tier : 'Standard';
  try {
    const meta = s3.restoreObject({ bucket: ctx.asset.s3.bucket, key: ctx.asset.s3.key, tier });
    ctx.asset.availability = {
      status: 'RESTORING', lastCheckedAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(),
      checkMethod: 'HEAD_OBJECT', detail: `${tier} retrieval requested — expected ready ${meta.restore.readyAt}`,
    };
    db.restoreRequests.unshift({
      _id: uuid(), assetId: ctx.asset.assetId, assetName: ctx.asset.displayName,
      requestedBy: req.user.sub, requestedByName: req.user.name, tier,
      status: 'IN_PROGRESS', requestedAt: new Date().toISOString(),
      readyAt: meta.restore.readyAt, availableUntil: meta.restore.expiryDate,
    });
    persist();
    record(req, {
      action: 'ASSET_RESTORE', entity: 'asset', entityId: ctx.asset.assetId,
      label: `Requested ${tier} restore for ${ctx.asset.displayName}`, after: { tier, readyAt: meta.restore.readyAt },
    });
    res.status(202).json({ accepted: true, tier, readyAt: meta.restore.readyAt, availableUntil: meta.restore.expiryDate });
  } catch (err) {
    return problem(res, 409, 'Conflict', err.message);
  }
});

// ── Delete ladder (§10.8) ───────────────────────────────────────────────────
assetsRouter.delete('/:id', requires('asset:delete'), (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  ctx.asset.deletedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'ASSET_SOFT_DELETE', entity: 'asset', entityId: ctx.asset.assetId,
    label: `Moved ${ctx.asset.displayName} to the recycle bin`,
    meta: { recoverableUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() },
  });
  res.json({ ok: true, deletedAt: ctx.asset.deletedAt, recoverableForDays: 30 });
});

assetsRouter.post('/:id/undelete', requires('asset:delete'), (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  ctx.asset.deletedAt = null;
  persist();
  record(req, { action: 'ASSET_RESTORE_DELETED', entity: 'asset', entityId: ctx.asset.assetId, label: `Restored ${ctx.asset.displayName}` });
  return res.json({ ok: true });
});

// Permanent purge — destroys every stored version. Requires the display name typed back.
assetsRouter.delete('/:id/purge', requires('asset:purge'), (req, res) => {
  const found = context(req.params.id);
  if (!found) return notFound(res);
  if (req.body?.confirm !== found.asset.displayName) {
    return problem(res, 428, 'Precondition Required', 'Type the asset name exactly to confirm a permanent purge.');
  }
  s3.deleteObject({ bucket: found.asset.s3.bucket, key: found.asset.s3.key });
  const at = found.list.indexOf(found.asset);
  if (at >= 0) found.list.splice(at, 1);
  db.shares = db.shares.filter((s) => s.assetId !== req.params.id);
  persist();
  record(req, {
    action: 'ASSET_PURGE', entity: 'asset', entityId: req.params.id,
    label: `Permanently purged ${found.asset.displayName}`,
    before: { key: found.asset.s3.key, sizeBytes: found.asset.s3.sizeBytes },
  });
  res.json({ ok: true, purged: true });
});

assetsRouter.get('/:id/versions', (req, res) => {
  const ctx = context(req.params.id);
  if (!ctx) return notFound(res);
  const versions = ctx.list
    .filter((a) => a.versionGroupId === ctx.asset.versionGroupId && !a.deletedAt)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  res.json(versions.map((a) => shape({ asset: a, song: ctx.song, artist: ctx.artist })));
});
