// Admin surface: storage health and drift remediation (§10.11), audit, users.
import express from 'express';
import { db, persist, allAssets } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { runReconciliation, latestRun, healthSummary } from '../services/reconcile.js';
import { record } from '../services/audit.js';
import { context, shape } from '../services/assets.js';
import * as storage from '../services/storage.js';
import { s3 } from '../services/storage.js';
import { BUCKETS } from '../config.js';
import { uuid, hashPassword } from '../util/crypto.js';
import { ROLES, PERMISSIONS, familyOf } from '../catalogue.js';

export const adminRouter = express.Router();
adminRouter.use(authenticate);

// ── Storage health ──────────────────────────────────────────────────────────
adminRouter.get('/storage/health', requires('admin:storage'), (_req, res) => {
  const summary = healthSummary();
  const rows = allAssets();
  const attention = rows
    .filter(({ asset }) => ['MISSING', 'MISMATCH', 'UNVERIFIED'].includes(asset.availability?.status))
    .map(shape)
    .sort((a, b) => {
      const rank = { MISSING: 0, MISMATCH: 1, UNVERIFIED: 2 };
      return rank[a.availability.status] - rank[b.availability.status];
    })
    .slice(0, 50);

  const byClass = {};
  for (const { asset } of rows) {
    const c = asset.s3.storageClass || 'STANDARD';
    byClass[c] = byClass[c] || { count: 0, bytes: 0 };
    byClass[c].count += 1;
    byClass[c].bytes += asset.s3.sizeBytes || 0;
  }
  const byFamily = {};
  for (const { asset } of rows) {
    byFamily[asset.family] = byFamily[asset.family] || { count: 0, bytes: 0 };
    byFamily[asset.family].count += 1;
    byFamily[asset.family].bytes += asset.s3.sizeBytes || 0;
  }

  res.json({ ...summary, attention, byClass, byFamily, buckets: BUCKETS, lastRunFull: latestRun() });
});

adminRouter.post('/storage/reconcile', requires('admin:storage'), (req, res) => {
  const run = runReconciliation(req, { trigger: 'manual' });
  res.json(run);
});

adminRouter.get('/storage/runs', requires('admin:storage'), (_req, res) => {
  res.json({ data: db.reconciliationRuns, total: db.reconciliationRuns.length });
});

// Remediation. Each action maps to a row in the §10.11 remediation table.
adminRouter.post('/storage/findings/:findingId/resolve', requires('admin:storage'), (req, res) => {
  const run = latestRun();
  const finding = run?.findings.find((f) => f._id === req.params.findingId);
  if (!finding) return problem(res, 404, 'Not Found', 'That finding is not part of the latest run.');
  const action = req.body?.action;

  const complete = (note) => {
    finding.resolvedAt = new Date().toISOString();
    finding.resolution = { action, note, by: req.user.name };
    persist();
    record(req, {
      action: 'DRIFT_REMEDIATE', entity: 'storage', entityId: finding._id,
      label: `${action} — ${finding.displayName}`, before: { kind: finding.kind }, after: { note },
    });
    return res.json({ ok: true, finding, note });
  };

  switch (action) {
    case 'accept-storage-truth': {
      // S3 wins (P1) — the catalogue is corrected to match the bucket.
      const ctx = context(finding.assetId);
      if (!ctx) return problem(res, 404, 'Not Found', 'The asset no longer exists.');
      const head = s3.headObject({ bucket: ctx.asset.s3.bucket, key: ctx.asset.s3.key });
      ctx.asset.s3.sizeBytes = head.size;
      ctx.asset.s3.etag = head.etag;
      ctx.asset.s3.storageClass = head.storageClass;
      storage.verifyAsset(ctx.asset);
      return complete('Catalogue record updated to match storage.');
    }
    case 'mark-lost': {
      const ctx = context(finding.assetId);
      if (!ctx) return problem(res, 404, 'Not Found', 'The asset no longer exists.');
      ctx.asset.availability = {
        status: 'MISSING', lastCheckedAt: new Date().toISOString(),
        lastVerifiedAt: ctx.asset.availability?.lastVerifiedAt ?? null,
        checkMethod: 'HEAD_OBJECT', detail: 'Marked permanently lost by an administrator. Re-upload required.',
      };
      ctx.asset.permanentlyLost = true;
      return complete('Asset flagged as permanently lost.');
    }
    case 'adopt': {
      // Bring an untracked object into the catalogue as a real asset.
      const songId = req.body?.songId;
      const song = db.songs.find((s) => s._id === songId);
      if (!song) return problem(res, 422, 'Unprocessable Entity', 'Choose a song to adopt this object into.');
      const head = s3.headObject({ bucket: BUCKETS.assets, key: finding.key });
      const assetType = req.body?.assetType || 'Master Audio';
      const now = new Date().toISOString();
      const assetId = finding.key.split('/')[1] || uuid();
      song.assets.push({
        assetId,
        displayName: head.metadata?.['display-name'] || finding.displayName,
        originalName: finding.displayName,
        description: 'Adopted from an untracked storage object during reconciliation.',
        type: assetType, family: familyOf(assetType), format: '',
        s3: {
          bucket: BUCKETS.assets, key: finding.key, versionId: head.versionId, region: head.region,
          storageClass: head.storageClass, sizeBytes: head.size, etag: head.etag,
          checksumSHA256: null, contentType: head.contentType, uploadedAt: head.lastModified,
        },
        availability: { status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now, checkMethod: 'HEAD_OBJECT', detail: null },
        lastHead: null, versionGroupId: `vg_${assetId.slice(0, 8)}`, version: 'V1', isCurrent: true, supersedes: null,
        mimeType: head.contentType, durationSec: null, dimensions: null, tags: ['Adopted'],
        uploadedBy: req.user.sub, createdAt: now, updatedAt: now, renamedAt: null, deletedAt: null, rekeyStatus: null,
      });
      return complete(`Adopted into "${song.title}".`);
    }
    case 'quarantine': {
      s3.copyObject({ bucket: BUCKETS.assets, sourceKey: finding.key, destKey: finding.key.replace(/^assets\//, 'quarantine/') });
      s3.deleteObject({ bucket: BUCKETS.assets, key: finding.key });
      return complete('Moved to the quarantine prefix.');
    }
    case 'delete-orphan': {
      s3.deleteObject({ bucket: BUCKETS.assets, key: finding.key });
      return complete('Orphan object deleted from storage.');
    }
    case 'accept':
      return complete('Accepted — no action needed.');
    default:
      return problem(res, 422, 'Unprocessable Entity', 'Unknown remediation action.');
  }
});

// ── Activity log ────────────────────────────────────────────────────────────
adminRouter.get('/activity', requires('admin:activity'), (req, res) => {
  const { action, userId, entity, q } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const rows = db.activityLog.filter((e) => {
    if (action && e.action !== action) return false;
    if (userId && e.userId !== userId) return false;
    if (entity && e.entity !== entity) return false;
    if (q && !`${e.label} ${e.userName} ${e.action}`.toLowerCase().includes(String(q).toLowerCase())) return false;
    return true;
  });
  res.json({
    data: rows.slice((page - 1) * limit, page * limit),
    total: rows.length,
    page,
    limit,
    actions: [...new Set(db.activityLog.map((e) => e.action))].sort(),
  });
});

// ── Users ───────────────────────────────────────────────────────────────────
adminRouter.get('/users', requires('admin:users'), (_req, res) => {
  res.json({
    data: db.users.map((u) => ({
      _id: u._id, name: u.name, email: u.email, role: u.role, jobTitle: u.jobTitle,
      status: u.status, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
      permissions: PERMISSIONS[u.role],
    })),
    roles: ROLES,
    permissionMatrix: PERMISSIONS,
  });
});

adminRouter.post('/users', requires('admin:users'), (req, res) => {
  const { name, email, role, jobTitle } = req.body || {};
  if (!name || !email) return problem(res, 422, 'Unprocessable Entity', 'A name and an email are required.');
  if (db.users.some((u) => u.email.toLowerCase() === String(email).toLowerCase())) {
    return problem(res, 409, 'Conflict', 'That email address already has an account.');
  }
  const user = {
    _id: `user_${uuid().slice(0, 8)}`, name, email, jobTitle: jobTitle || '',
    passwordHash: hashPassword('maestro'), role: ROLES.includes(role) ? role : 'Viewer',
    status: 'active', createdAt: new Date().toISOString(), lastLoginAt: null,
  };
  db.users.push(user);
  persist();
  record(req, { action: 'USER_CREATE', entity: 'user', entityId: user._id, label: `Created ${user.name} (${user.role})` });
  res.status(201).json({ ...user, passwordHash: undefined, permissions: PERMISSIONS[user.role] });
});

adminRouter.patch('/users/:id', requires('admin:users'), (req, res) => {
  const user = db.users.find((u) => u._id === req.params.id);
  if (!user) return problem(res, 404, 'Not Found', 'No user with that id.');
  const before = { role: user.role, status: user.status };
  if (req.body?.role && ROLES.includes(req.body.role)) user.role = req.body.role;
  if (req.body?.status) user.status = req.body.status;
  if (req.body?.jobTitle != null) user.jobTitle = req.body.jobTitle;
  persist();
  record(req, {
    action: 'USER_UPDATE', entity: 'user', entityId: user._id,
    label: `Updated ${user.name}`, before, after: { role: user.role, status: user.status },
  });
  res.json({ ...user, passwordHash: undefined, permissions: PERMISSIONS[user.role] });
});

// ── Notifications (shared by every role) ────────────────────────────────────
export const notificationsRouter = express.Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', (req, res) => {
  const rows = db.notifications.filter((n) => !n.userId || n.userId === req.user.sub).slice(0, 40);
  res.json({ data: rows, unread: rows.filter((n) => !n.readAt).length });
});

notificationsRouter.post('/read', (req, res) => {
  for (const n of db.notifications) if (!n.readAt) n.readAt = new Date().toISOString();
  persist();
  res.json({ ok: true });
});
