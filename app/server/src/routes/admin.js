// Admin surface: storage health and drift remediation (§10.11), quota, audit, users.
import express from 'express';
import { db, persist, allAssets } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { runReconciliation, latestRun, healthSummary } from '../services/reconcile.js';
import { record } from '../services/audit.js';
import { context, shape } from '../services/assets.js';
import * as storage from '../services/storage.js';
import { DRIVE_ID, GOOGLE, GOOGLE_CONFIGURED, MIN_PASSWORD_LENGTH, ROOTS, SEED_PASSWORD, TRASH_DAYS } from '../config.js';
import { uuid, hashPassword } from '../util/crypto.js';
import { ROLES, PERMISSIONS, familyOf, normaliseRole } from '../catalogue.js';
import { passwordProblem } from './auth.js';

export const adminRouter = express.Router();
adminRouter.use(authenticate);

// ── Quota (§6.4) ────────────────────────────────────────────────────────────
// The single most operationally useful number in the product: everything stops working
// when this reaches zero. Drive answers it in one request.
adminRouter.get('/storage/quota', requires('admin:storage'), async (_req, res) => {
  try {
    const quota = await storage.quota();
    const rows = allAssets();
    const libraryBytes = rows.reduce((n, { asset }) => n + (asset.drive?.sizeBytes ?? 0), 0);
    res.json({
      ...quota,
      // What GCloud itself is responsible for, versus what else is in the Drive.
      libraryBytes,
      libraryFileCount: rows.length,
      otherDriveBytes: Math.max(0, quota.usageInDrive - libraryBytes),
      trashRecoverableForDays: TRASH_DAYS,
      mode: GOOGLE.mode,
      sharedDrive: Boolean(DRIVE_ID),
      rootFolderId: ROOTS.root,
    });
  } catch (err) {
    return problem(res, 502, 'Bad Gateway', `Google Drive would not report its quota: ${err.message}`);
  }
});

// ── Storage health ──────────────────────────────────────────────────────────
adminRouter.get('/storage/health', requires('admin:storage'), async (_req, res) => {
  const summary = healthSummary();
  const rows = allAssets();
  const attention = rows
    .filter(({ asset }) => ['MISSING', 'MISMATCH', 'TRASHED', 'UNVERIFIED'].includes(asset.availability?.status))
    .map(shape)
    .sort((a, b) => {
      const rank = { MISSING: 0, TRASHED: 1, MISMATCH: 2, UNVERIFIED: 3 };
      return rank[a.availability.status] - rank[b.availability.status];
    })
    .slice(0, 50);

  const byFamily = {};
  const byFolder = {};
  for (const row of rows) {
    const { asset, folder } = row;
    byFamily[asset.family] = byFamily[asset.family] || { count: 0, bytes: 0 };
    byFamily[asset.family].count += 1;
    byFamily[asset.family].bytes += asset.drive?.sizeBytes || 0;

    const name = folder?.name ?? 'Library root';
    byFolder[name] = byFolder[name] || { count: 0, bytes: 0 };
    byFolder[name].count += 1;
    byFolder[name].bytes += asset.drive?.sizeBytes || 0;
  }

  // Never fail the whole page because Google is briefly unreachable — the catalogue half
  // of this screen is still worth seeing.
  const quota = await storage.quota().catch(() => null);

  res.json({
    ...summary,
    attention,
    byFamily,
    byFolder,
    quota,
    storage: {
      provider: 'Google Drive',
      mode: GOOGLE.mode,
      configured: GOOGLE_CONFIGURED,
      account: quota?.account ?? null,
      sharedDriveId: DRIVE_ID,
      rootFolderId: ROOTS.root,
      folders: ROOTS,
      trashRecoverableForDays: TRASH_DAYS,
    },
    lastRunFull: latestRun(),
  });
});

adminRouter.post('/storage/reconcile', requires('admin:storage'), async (req, res) => {
  const run = await runReconciliation(req, { trigger: 'manual' });
  res.json(run);
});

adminRouter.get('/storage/runs', requires('admin:storage'), (_req, res) => {
  res.json({ data: db.reconciliationRuns, total: db.reconciliationRuns.length });
});

// Remediation. Each action maps to a row in the §10.11 remediation table. Most of the
// drift a Drive produces is somebody rearranging files by hand rather than anything being
// broken, so most of these settle a disagreement rather than repair damage.
adminRouter.post('/storage/findings/:findingId/resolve', requires('admin:storage'), async (req, res) => {
  const run = latestRun();
  const finding = run?.findings.find((f) => f._id === req.params.findingId);
  if (!finding) return problem(res, 404, 'Not Found', 'That finding is not part of the latest run.');
  const action = req.body?.action;
  const fileId = finding.fileId ?? finding.key;

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

  try {
    switch (action) {
      // Drive wins (P1) — the catalogue is corrected to match what is actually there.
      case 'accept-storage-truth': {
        const ctx = context(finding.assetId);
        if (!ctx) return problem(res, 404, 'Not Found', 'The asset no longer exists.');
        const drive = await storage.stat(ctx.asset.drive.fileId);
        ctx.asset.drive = { ...ctx.asset.drive, ...drive };
        ctx.asset.mimeType = drive.mimeType;
        if (drive.durationSec != null) ctx.asset.durationSec = drive.durationSec;
        if (drive.dimensions) ctx.asset.dimensions = drive.dimensions;
        await storage.verifyAsset(ctx.asset);
        return complete('Catalogue record updated to match Google Drive.');
      }

      // Somebody renamed the file in Drive. Believe them.
      case 'accept-drive-name': {
        const ctx = context(finding.assetId);
        if (!ctx) return problem(res, 404, 'Not Found', 'The asset no longer exists.');
        const drive = await storage.stat(ctx.asset.drive.fileId);
        const before = ctx.asset.displayName;
        ctx.asset.displayName = drive.name;
        ctx.asset.drive = { ...ctx.asset.drive, ...drive };
        ctx.asset.renamedAt = new Date().toISOString();
        return complete(`Catalogue renamed “${before}” → “${drive.name}” to match Drive.`);
      }

      // Or push the catalogue's name back onto the file instead.
      case 'restore-catalogue-name': {
        const ctx = context(finding.assetId);
        if (!ctx) return problem(res, 404, 'Not Found', 'The asset no longer exists.');
        const drive = await storage.rename(ctx.asset.drive.fileId, ctx.asset.displayName);
        ctx.asset.drive = { ...ctx.asset.drive, ...drive };
        return complete(`Google Drive file renamed back to “${ctx.asset.displayName}”.`);
      }

      // A file dragged into a different Drive folder. Move the catalogue to follow it,
      // creating the GCloud folder if that Drive folder is new to us.
      case 'follow-drive-folder': {
        const ctx = context(finding.assetId);
        if (!ctx) return problem(res, 404, 'Not Found', 'The asset no longer exists.');
        const parentId = finding.actual;
        let folder = db.folders.find((f) => f.driveFolderId === parentId && !f.deletedAt);
        if (!folder && parentId && parentId !== ROOTS.assets) {
          const now = new Date().toISOString();
          folder = {
            _id: `folder_${uuid().slice(0, 8)}`,
            name: finding.actualFolderName || 'Adopted folder',
            description: 'Adopted from Google Drive during reconciliation.',
            tags: ['Adopted'], parentId: null,
            driveFolderId: parentId, driveWebViewLink: null,
            songId: null, artistId: null,
            createdBy: req.user.sub, createdAt: now, updatedAt: now, deletedAt: null,
          };
          db.folders.unshift(folder);
        }
        ctx.asset.folderId = folder?._id ?? null;
        ctx.asset.drive.parentId = parentId;
        ctx.asset.drive.path = `${folder?.name ? `${folder.name}/` : ''}${ctx.asset.displayName}`;
        return complete(folder ? `Filed under “${folder.name}” to match Drive.` : 'Returned to the library root to match Drive.');
      }

      // Or put it back where the catalogue says it belongs.
      case 'move-back': {
        const ctx = context(finding.assetId);
        if (!ctx) return problem(res, 404, 'Not Found', 'The asset no longer exists.');
        const folder = ctx.asset.folderId ? db.folders.find((f) => f._id === ctx.asset.folderId) : null;
        const drive = await storage.move(ctx.asset.drive.fileId, {
          toParentId: folder?.driveFolderId || ROOTS.assets,
          fromParentId: finding.actual,
        });
        ctx.asset.drive = { ...ctx.asset.drive, ...drive };
        return complete(`Moved back into “${folder?.name ?? 'the library root'}” in Drive.`);
      }

      // Pulled out of the Drive bin before Google sweeps it.
      case 'untrash': {
        const ctx = context(finding.assetId);
        if (!ctx) return problem(res, 404, 'Not Found', 'The asset no longer exists.');
        const drive = await storage.untrash(ctx.asset.drive.fileId);
        ctx.asset.drive = { ...ctx.asset.drive, ...drive };
        await storage.verifyAsset(ctx.asset);
        return complete('Restored from the Google Drive trash.');
      }

      case 'mark-lost': {
        const ctx = context(finding.assetId);
        if (!ctx) return problem(res, 404, 'Not Found', 'The asset no longer exists.');
        ctx.asset.availability = {
          status: 'MISSING', lastCheckedAt: new Date().toISOString(),
          lastVerifiedAt: ctx.asset.availability?.lastVerifiedAt ?? null,
          checkMethod: 'FILES_GET', detail: 'Marked permanently lost by an administrator. Re-upload required.',
        };
        ctx.asset.permanentlyLost = true;
        return complete('Asset flagged as permanently lost.');
      }

      // Bring a file somebody dropped into the Drive folder into the catalogue, so it
      // becomes searchable. A song is optional — a loose file is still a library member.
      case 'adopt': {
        const songId = req.body?.songId;
        const song = songId ? db.songs.find((s) => s._id === songId) : null;
        if (songId && !song) return problem(res, 422, 'Unprocessable Entity', 'That song no longer exists.');
        const drive = await storage.stat(fileId);
        const assetType = req.body?.assetType || 'Master Audio';
        const now = new Date().toISOString();
        const assetId = drive.appProperties?.assetId || uuid();
        const folder = db.folders.find((f) => f.driveFolderId === drive.parentId && !f.deletedAt) ?? null;

        const asset = {
          assetId,
          displayName: drive.name,
          originalName: drive.name,
          description: 'Adopted from Google Drive during reconciliation.',
          type: assetType, family: familyOf(assetType), format: '',
          folderId: folder?._id ?? null,
          drive: { ...drive, path: `${folder?.name ? `${folder.name}/` : ''}${drive.name}` },
          availability: { status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now, checkMethod: 'FILES_GET', detail: null },
          lastHead: null, versionGroupId: `vg_${assetId.slice(0, 8)}`, version: 'V1', isCurrent: true, supersedes: null,
          mimeType: drive.mimeType, durationSec: drive.durationSec, dimensions: drive.dimensions,
          tags: ['Adopted'], checksumSHA256: drive.sha256,
          uploadedBy: req.user.sub, createdAt: now, updatedAt: now, renamedAt: null, deletedAt: null, relocateStatus: null,
        };
        (song ? song.assets : db.unfiled).push(asset);
        void storage.syncMetadata(asset, { song, folder, renameFile: false });
        return complete(song ? `Adopted into “${song.title}”.` : 'Adopted as a loose library file.');
      }

      // Adopt a whole Drive folder, and everything sitting in it.
      case 'adopt-folder': {
        const drive = await storage.stat(fileId);
        if (db.folders.some((f) => f.driveFolderId === fileId && !f.deletedAt)) {
          return complete('That folder is already in the catalogue.');
        }
        const now = new Date().toISOString();
        const folder = {
          _id: `folder_${uuid().slice(0, 8)}`,
          name: drive.name,
          description: 'Adopted from Google Drive during reconciliation.',
          tags: ['Adopted'],
          parentId: db.folders.find((f) => f.driveFolderId === drive.parentId && !f.deletedAt)?._id ?? null,
          driveFolderId: fileId, driveWebViewLink: drive.webViewLink,
          songId: null, artistId: null,
          createdBy: req.user.sub, createdAt: now, updatedAt: now, deletedAt: null,
        };
        db.folders.unshift(folder);
        return complete(`Adopted “${drive.name}”. Run the check again to adopt the files inside it.`);
      }

      // Set aside without deleting anything, pending a decision.
      case 'quarantine': {
        const drive = await storage.move(fileId, { toParentId: ROOTS.quarantine, fromParentId: null });
        return complete(`Moved to the Quarantine folder in Drive (${drive.name}).`);
      }

      case 'delete-orphan': {
        await storage.trash(fileId);
        return complete(`Moved to the Google Drive trash. Recoverable for ${TRASH_DAYS} days.`);
      }

      case 'accept':
        return complete('Accepted — no action needed.');

      default:
        return problem(res, 422, 'Unprocessable Entity', 'Unknown remediation action.');
    }
  } catch (err) {
    return problem(res, 502, 'Bad Gateway', `Google Drive refused the remediation: ${err.message}`);
  } finally {
    persist();
  }
});

// ── Activity log ────────────────────────────────────────────────────────────
adminRouter.get('/activity', requires('admin:activity'), (req, res) => {
  const { action, userId, entity, q, from, to } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 50));

  // A date filter on an audit trail is almost always "what happened on the day X went
  // wrong?", so `to` is inclusive of the whole day rather than of midnight on it.
  const fromMs = from ? Date.parse(`${from}T00:00:00`) : null;
  const toMs = to ? Date.parse(`${to}T23:59:59.999`) : null;

  const rows = db.activityLog.filter((e) => {
    if (action && e.action !== action) return false;
    if (userId && e.userId !== userId) return false;
    if (entity && e.entity !== entity) return false;
    if (q && !`${e.label} ${e.userName} ${e.action}`.toLowerCase().includes(String(q).toLowerCase())) return false;
    const at = Date.parse(e.timestamp);
    if (fromMs != null && !Number.isNaN(fromMs) && at < fromMs) return false;
    if (toMs != null && !Number.isNaN(toMs) && at > toMs) return false;
    return true;
  });

  const sorters = {
    newest: (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
    oldest: (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    // Alphabetical by the person, then by time, so one person's entries stay together and
    // read in order rather than being shuffled within their own block.
    person: (a, b) => a.userName.localeCompare(b.userName) || Date.parse(b.timestamp) - Date.parse(a.timestamp),
    personDesc: (a, b) => b.userName.localeCompare(a.userName) || Date.parse(b.timestamp) - Date.parse(a.timestamp),
    label: (a, b) => String(a.label).localeCompare(String(b.label)),
    labelDesc: (a, b) => String(b.label).localeCompare(String(a.label)),
  };
  const sort = sorters[req.query.sort] ? req.query.sort : 'newest';
  const sorted = [...rows].sort(sorters[sort]);

  res.json({
    data: sorted.slice((page - 1) * limit, page * limit),
    total: sorted.length,
    page,
    limit,
    sort,
    hasMore: page * limit < sorted.length,
    actions: [...new Set(db.activityLog.map((e) => e.action))].sort(),
    // The window the log actually covers, so a date picker can be bounded to it rather
    // than letting somebody choose a range that cannot contain anything.
    earliest: db.activityLog.length
      ? db.activityLog.reduce((min, e) => (e.timestamp < min ? e.timestamp : min), db.activityLog[0].timestamp)
      : null,
  });
});

// ── Users ───────────────────────────────────────────────────────────────────
// Creating an account is the one capability an Admin holds and a User does not, so every
// route below sits behind `admin:users` and nothing else in the product does.
const publicUser = (u) => ({
  _id: u._id, name: u.name, email: u.email, role: normaliseRole(u.role),
  status: u.status, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
  // Surfaced so the People table can say "has not set their own password yet" rather
  // than leaving an administrator to guess whether a handover landed.
  mustChangePassword: Boolean(u.mustChangePassword),
  permissions: PERMISSIONS[normaliseRole(u.role)],
});

const admins = () => db.users.filter((u) => normaliseRole(u.role) === 'Admin' && u.status === 'active');

adminRouter.get('/users', requires('admin:users'), (_req, res) => {
  res.json({
    data: db.users.map(publicUser),
    roles: ROLES,
    permissionMatrix: PERMISSIONS,
    minPasswordLength: MIN_PASSWORD_LENGTH,
  });
});

adminRouter.post('/users', requires('admin:users'), async (req, res) => {
  const { name, email, role, password } = req.body || {};
  if (!name?.trim() || !email?.trim()) {
    return problem(res, 422, 'Unprocessable Entity', 'A name and an email are required.');
  }
  const address = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return problem(res, 422, 'Unprocessable Entity', 'That does not look like an email address.');
  }
  if (db.users.some((u) => u.email.toLowerCase() === address)) {
    return problem(res, 409, 'Conflict', 'That email address already has an account.');
  }

  const initial = String(password || SEED_PASSWORD);
  const invalid = passwordProblem(initial);
  if (invalid) return problem(res, 422, 'Unprocessable Entity', invalid);

  const user = {
    _id: `user_${uuid().slice(0, 8)}`,
    name: name.trim(),
    email: address,
    passwordHash: await hashPassword(initial),
    role: ROLES.includes(role) ? role : 'User',
    status: 'active',
    // The starting password is a handover, not a credential: it is good for exactly one
    // sign-in, and every route stays closed until the person replaces it.
    mustChangePassword: true,
    passwordChangedAt: null,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  db.users.push(user);
  persist();
  record(req, { action: 'USER_CREATE', entity: 'user', entityId: user._id, label: `Created ${user.name} (${user.role})` });
  res.status(201).json(publicUser(user));
});

adminRouter.patch('/users/:id', requires('admin:users'), (req, res) => {
  const user = db.users.find((u) => u._id === req.params.id);
  if (!user) return problem(res, 404, 'Not Found', 'No user with that id.');

  const nextRole = req.body?.role && ROLES.includes(req.body.role) ? req.body.role : null;
  const nextStatus = req.body?.status ?? null;

  // A library with no administrator has no way back: nobody left can create an account or
  // restore the role. So the last active Admin cannot be demoted or suspended, including
  // by themselves.
  const losingAdmin =
    normaliseRole(user.role) === 'Admin'
    && ((nextRole && nextRole !== 'Admin') || (nextStatus && nextStatus !== 'active'));
  if (losingAdmin && admins().length <= 1) {
    return problem(
      res, 409, 'Conflict',
      'This is the only administrator. Give somebody else the Admin role first — otherwise no account could add one back.',
    );
  }

  const before = { role: normaliseRole(user.role), status: user.status };
  if (nextRole) user.role = nextRole;
  if (nextStatus) user.status = nextStatus;
  persist();
  record(req, {
    action: 'USER_UPDATE', entity: 'user', entityId: user._id,
    label: `Updated ${user.name}`, before, after: { role: normaliseRole(user.role), status: user.status },
  });
  res.json(publicUser(user));
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
