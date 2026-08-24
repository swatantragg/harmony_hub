import express from 'express';
import { db, persist, assetContext } from '../db.js';
import { authenticate, requires, requireStepUp, problem } from '../middleware/auth.js';
import { alert, record, notify } from '../services/audit.js';
import { scan, nameSimilarity, normaliseName } from '../services/dedupe.js';
import * as storage from '../services/storage.js';
import { shape } from '../services/assets.js';
import { ALLOW_EMPTY_DRIVE_TRASH, TRASH_DAYS } from '../config.js';
import { LIMITS, fields, list, oneOf, str } from '../util/validate.js';
import { uuid } from '../util/crypto.js';

export const dedupeRouter = express.Router();
dedupeRouter.use(authenticate);

dedupeRouter.get('/scan', requires('asset:read'), (req, res) => {
  const level = ['exact', 'near', 'all'].includes(req.query.level) ? req.query.level : 'all';
  const family = ['Audio', 'Video', 'Image', 'Document'].includes(req.query.family) ? req.query.family : null;
  const minSizeBytes = Math.max(0, Number(req.query.minSizeBytes) || 0);
  res.json(scan({ level, family, minSizeBytes }));
});

dedupeRouter.get('/groups/:groupId', requires('asset:read'), (req, res) => {
  const report = scan({ level: 'all' });
  const group = report.groups.find((g) => g._id === req.params.groupId);
  if (!group) return problem(res, 404, 'Not Found', 'That duplicate group is no longer in the latest scan.');
  res.json(group);
});

dedupeRouter.get('/compare', requires('asset:read'), async (req, res) => {
  const a = assetContext(String(req.query.a || ''));
  const b = assetContext(String(req.query.b || ''));
  if (!a || !b) return problem(res, 404, 'Not Found', 'Both asset ids must exist.');

  await storage.verifyAssets([a.asset, b.asset]).catch(() => null);
  persist();

  const printA = a.asset.drive?.sha256 || a.asset.drive?.md5;
  const printB = b.asset.drive?.sha256 || b.asset.drive?.md5;
  const identical = Boolean(printA && printA === printB);
  const sameFile = a.asset.drive?.fileId === b.asset.drive?.fileId;

  res.json({
    a: shape(a),
    b: shape(b),
    verdict: sameFile ? 'SAME_DRIVE_FILE' : identical ? 'IDENTICAL' : 'DIFFERENT',
    signals: {
      sameDriveFile: sameFile,
      checksumMatch: identical,
      sizeDelta: (a.asset.drive?.sizeBytes ?? 0) - (b.asset.drive?.sizeBytes ?? 0),
      durationDelta: a.asset.durationSec != null && b.asset.durationSec != null
        ? a.asset.durationSec - b.asset.durationSec : null,
      sameDimensions: Boolean(a.asset.dimensions && a.asset.dimensions === b.asset.dimensions),
      nameSimilarity: Math.round(nameSimilarity(a.asset.displayName, b.asset.displayName) * 100) / 100,
      normalisedNames: [normaliseName(a.asset.displayName), normaliseName(b.asset.displayName)],
    },
    explanation: sameFile
      ? 'These are two catalogue entries for one Google Drive file. Nothing is duplicated in storage.'
      : identical
        ? 'Google Drive reports the same checksum for both, so they are byte-for-byte the same file stored twice. Removing one frees its full size.'
        : 'The files differ. Any similarity below is circumstantial — compare them before deciding.',
  });
});


const ACTIONS = ['link', 'trash', 'version', 'ignore'];

dedupeRouter.post('/resolve', requires('asset:delete'), async (req, res) => {
  const check = fields(req.body || {}, {
    groupId: (v) => str(v, { max: 120, field: 'groupId', required: true }),
    action: (v) => oneOf(v, ACTIONS, { field: 'action', required: true }),
    keepId: (v) => str(v, { max: 80, field: 'keepId' }),
    note: (v) => str(v, { max: LIMITS.note, field: 'note', allowEmpty: true }),
    assetIds: (v) => list(v, { max: LIMITS.ids, itemMax: 80, field: 'assetIds' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const { groupId, action, keepId, assetIds } = check.value;

  const report = scan({ level: 'all' });
  const group = report.groups.find((g) => g._id === groupId);
  if (!group) return problem(res, 404, 'Not Found', 'That duplicate group is no longer in the latest scan. Re-scan and try again.');

  if (action === 'ignore') {
    db.dedupeIgnores ??= [];
    db.dedupeIgnores.unshift({
      _id: group._id, kind: group.kind, count: group.count,
      names: group.members.map((m) => m.displayName),
      ignoredBy: req.user.name, ignoredAt: new Date().toISOString(),
      note: check.value.note || '',
    });
    persist();
    record(req, {
      action: 'DEDUPE_IGNORE', entity: 'storage', entityId: group._id,
      label: `Dismissed a ${group.kind} duplicate group of ${group.count}`,
    });
    return res.json({ ok: true, ignored: true, group: group._id });
  }

  const keeper = group.members.find((m) => m.assetId === (keepId || group.suggestedKeepId));
  if (!keeper) return problem(res, 422, 'Unprocessable Entity', 'The file you chose to keep is not in this group.');

  const selected = Array.isArray(assetIds) && assetIds.length
    ? group.members.filter((m) => assetIds.includes(m.assetId) && m.assetId !== keeper.assetId)
    : group.members.filter((m) => m.assetId !== keeper.assetId);

  if (!selected.length) return problem(res, 422, 'Unprocessable Entity', 'Nothing was selected to resolve.');

  const keeperCtx = assetContext(keeper.assetId);
  if (!keeperCtx) return problem(res, 404, 'Not Found', 'The file to keep no longer exists.');

  if (action === 'link') {
    if (group.kind !== 'IDENTICAL') {
      return problem(res, 409, 'Conflict',
        'Linking is only offered for byte-identical files. These differ, so linking them would silently replace one with the other — trash the ones you do not want instead.');
    }
    const linked = [];
    const failed = [];
    for (const member of selected) {
      const ctx = assetContext(member.assetId);
      if (!ctx) continue;
      const ownFileId = ctx.asset.drive?.fileId;
      ctx.asset.linkedTo = keeper.assetId;
      ctx.asset.drive = {
        ...ctx.asset.drive,
        fileId: keeper.fileId,
        path: `${ctx.folder?.name ? `${ctx.folder.name}/` : ''}${ctx.asset.displayName}`,
      };
      ctx.asset.updatedAt = new Date().toISOString();
      if (ownFileId && ownFileId !== keeper.fileId) {
        const ok = await storage.trash(ownFileId).then(() => true).catch(() => false);
        (ok ? linked : failed).push(member.displayName);
      } else {
        linked.push(member.displayName);
      }
    }
    persist();
    record(req, {
      action: 'DEDUPE_LINK', entity: 'storage', entityId: group._id,
      label: `Linked ${linked.length} duplicate${linked.length === 1 ? '' : 's'} to ${keeper.displayName}`,
      after: { keptFileId: keeper.fileId, linked, failed },
      meta: { bytesReclaimed: group.reclaimableBytes },
    });
    return res.json({
      ok: failed.length === 0,
      action: 'link',
      linked: linked.length,
      failed,
      bytesReclaimed: group.reclaimableBytes,
      recoverableForDays: TRASH_DAYS,
      note: 'Every entry still appears in its own folder and every share link still works. Only the redundant copies were moved to the Drive trash.',
    });
  }

  if (action === 'version') {
    const groupIdForVersions = keeperCtx.asset.versionGroupId;
    const ordered = [...selected].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    ordered.forEach((member, i) => {
      const ctx = assetContext(member.assetId);
      if (!ctx) return;
      ctx.asset.versionGroupId = groupIdForVersions;
      ctx.asset.isCurrent = false;
      if (!ctx.asset.version || ctx.asset.version === 'V1') ctx.asset.version = `V${i + 2}`;
      ctx.asset.updatedAt = new Date().toISOString();
    });
    keeperCtx.asset.isCurrent = true;
    persist();
    record(req, {
      action: 'DEDUPE_VERSION', entity: 'storage', entityId: group._id,
      label: `Grouped ${selected.length + 1} files as versions of ${keeper.displayName}`,
      after: { versionGroupId: groupIdForVersions },
    });
    return res.json({
      ok: true, action: 'version', grouped: selected.length + 1,
      versionGroupId: groupIdForVersions, bytesReclaimed: 0,
      note: 'Nothing was deleted. The files now read as one history instead of several unrelated entries.',
    });
  }

  const trashed = [];
  const failed = [];
  for (const member of selected) {
    const ctx = assetContext(member.assetId);
    if (!ctx) continue;
    const sharedWithKeeper = ctx.asset.drive?.fileId === keeper.fileId;
    ctx.asset.deletedAt = new Date().toISOString();
    ctx.asset.updatedAt = ctx.asset.deletedAt;
    if (!sharedWithKeeper && ctx.asset.drive?.fileId) {
      const ok = await storage.trash(ctx.asset.drive.fileId).then(() => true).catch(() => false);
      if (ok) ctx.asset.drive.trashed = true;
      (ok ? trashed : failed).push(member.displayName);
    } else {
      trashed.push(member.displayName);
    }
  }
  persist();

  record(req, {
    action: 'DEDUPE_TRASH', entity: 'storage', entityId: group._id,
    label: `Removed ${trashed.length} duplicate${trashed.length === 1 ? '' : 's'} of ${keeper.displayName}`,
    before: { members: group.members.map((m) => m.displayName) },
    after: { kept: keeper.displayName, trashed, failed },
    meta: { bytesReclaimed: group.reclaimableBytes, kind: group.kind },
  });
  if (group.reclaimableBytes > 0) {
    notify({
      level: 'ok',
      title: `${trashed.length} duplicate${trashed.length === 1 ? '' : 's'} removed`,
      body: `Google Drive will free the space when the trash empties, ${TRASH_DAYS} days from now — or immediately if you empty it yourself.`,
      link: '/dedupe',
    });
  }

  res.json({
    ok: failed.length === 0,
    action: 'trash',
    trashed: trashed.length,
    failed,
    bytesReclaimed: group.reclaimableBytes,
    recoverableForDays: TRASH_DAYS,
    note: `The files are in the Drive trash, not gone. Quota is only released once the trash empties — Drive does that after ${TRASH_DAYS} days.`,
  });
});

dedupeRouter.get('/ignored', requires('asset:read'), (_req, res) => {
  res.json({ data: db.dedupeIgnores || [], total: (db.dedupeIgnores || []).length });
});

dedupeRouter.delete('/ignored/:id', requires('asset:delete'), (req, res) => {
  const before = (db.dedupeIgnores || []).length;
  db.dedupeIgnores = (db.dedupeIgnores || []).filter((i) => i._id !== req.params.id);
  persist();
  res.json({ ok: true, restored: before - db.dedupeIgnores.length });
});

dedupeRouter.post(
  '/empty-trash',
  requires('asset:purge'),
  requireStepUp('Emptying the Google Drive trash'),
  async (req, res) => {
  if (!ALLOW_EMPTY_DRIVE_TRASH) {
    return problem(
      res, 409, 'Conflict',
      'Emptying the Drive trash is disabled on this deployment, because it destroys everything in the connected account’s bin — including files this library never touched. Set ALLOW_EMPTY_DRIVE_TRASH=true to enable it, or empty the trash from drive.google.com where the contents are visible first.',
    );
  }
  if (req.body?.confirm !== 'EMPTY TRASH') {
    return problem(res, 428, 'Precondition Required',
      'Type EMPTY TRASH to confirm. This permanently destroys everything in the connected account\'s Drive trash, including files GCloud never touched.');
  }
  const before = await storage.quota().catch(() => null);
  try {
    await storage.emptyDriveTrash();
  } catch (err) {
    return problem(res, 502, 'Bad Gateway', `Google Drive refused: ${err.message}`);
  }
  const after = await storage.quota().catch(() => null);
  const freed = before && after ? Math.max(0, before.usage - after.usage) : null;

  db.dedupeIgnores ??= [];
  persist();
  alert(req, {
    action: 'DRIVE_TRASH_EMPTIED', entity: 'storage', entityId: 'trash',
    label: 'Emptied the Google Drive trash',
    level: 'danger',
    before: { usage: before?.usage ?? null, usageInTrash: before?.usageInTrash ?? null },
    after: { usage: after?.usage ?? null },
    meta: { bytesFreed: freed },
  });
  res.json({ ok: true, bytesFreed: freed, quota: after });
  },
);

let hashing = null;

dedupeRouter.post('/perceptual/build', requires('admin:storage'), async (req, res) => {
  if (hashing) return res.status(202).json({ accepted: true, alreadyRunning: true, ...hashing.state });
  const { buildPerceptualHashes } = await import('../services/perceptual.js');
  const state = { startedAt: new Date().toISOString(), done: 0, total: 0, failed: 0, finished: false };
  hashing = { state };
  void buildPerceptualHashes({ state, onProgress: () => persist() })
    .catch((err) => { state.error = err.message; })
    .finally(() => {
      state.finished = true;
      state.finishedAt = new Date().toISOString();
      persist();
      record(req, {
        action: 'DEDUPE_PERCEPTUAL_BUILD', entity: 'storage', entityId: uuid(),
        label: `Computed perceptual hashes for ${state.done} files`, after: state,
      });
      setTimeout(() => { hashing = null; }, 60_000);
    });
  res.status(202).json({ accepted: true, ...state });
});

dedupeRouter.get('/perceptual/status', requires('admin:storage'), (_req, res) => {
  res.json(hashing?.state ?? { finished: true, done: 0, total: 0, idle: true });
});
