// Admin surface: storage health and drift remediation (§10.11), quota, audit, users.
import express from 'express';
import { db, persist, flushNow, allAssets } from '../db.js';
import { authenticate, requires, requireStepUp, problem } from '../middleware/auth.js';
import { runReconciliation, latestRun, healthSummary } from '../services/reconcile.js';
import { alert, record, notify } from '../services/audit.js';
import { context, shape } from '../services/assets.js';
import * as storage from '../services/storage.js';
import { connectionInfo } from '../db/mongo.js';
import {
  DRIVE_ID, ENV, GOOGLE, GOOGLE_CONFIGURED, MIN_PASSWORD_LENGTH, ROOTS, SEED_PASSWORD, TRASH_DAYS,
} from '../config.js';
import { uuid, hashPassword } from '../util/crypto.js';
import { ROLES, PERMISSIONS, familyOf, normaliseRole } from '../catalogue.js';
import { invalidateSessions, passwordProblem } from './auth.js';
import { allTypes } from '../services/vocabulary.js';
import * as antivirus from '../services/antivirus.js';
import { LIMITS, email, fields, oneOf, str } from '../util/validate.js';

export const adminRouter = express.Router();
adminRouter.use(authenticate);

// The detailed health picture that used to sit on the unauthenticated /healthz: which
// Drive, which folder ids, which account, which database. Every one of those is a useful
// thing to know before attacking the deployment, and none of them is something a load
// balancer needs — so the liveness probe answers {ok} and this answers the rest.
adminRouter.get('/health', requires('admin:storage'), async (_req, res) => {
  const mongo = connectionInfo();
  const space = await storage.quota().catch(() => null);
  // Whether the scanner is actually answering, not only whether it is switched on. A
  // configured-but-unreachable scanner is the state worth surfacing: with the fail-closed
  // default it stops every upload, and with fail-open it silently stops protecting.
  const scanner = antivirus.enabled()
    ? { enabled: true, ...(await antivirus.ping()), version: await antivirus.version() }
    : { enabled: false };
  const drive = storage.driveStatus();
  res.json({
    ok: mongo.readyState === 1 && GOOGLE_CONFIGURED && drive.ok,
    // Why file operations are failing, in the one place somebody looks when they are.
    drive,
    scanner,
    env: ENV,
    uptime: process.uptime(),
    node: process.version,
    mongo: { db: mongo.db, host: mongo.host, connected: mongo.readyState === 1 },
    storage: {
      provider: 'google-drive',
      authMode: GOOGLE.mode,
      configured: GOOGLE_CONFIGURED,
      sharedDrive: Boolean(DRIVE_ID),
      rootFolderId: ROOTS.root,
      assetsFolderId: ROOTS.assets,
      account: space?.account ?? null,
    },
  });
});

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
const REMEDIATIONS = [
  'accept-storage-truth', 'accept-drive-name', 'restore-catalogue-name', 'follow-drive-folder',
  'move-back', 'untrash', 'mark-lost', 'adopt', 'adopt-folder', 'quarantine', 'delete-orphan', 'accept',
];

adminRouter.post('/storage/findings/:findingId/resolve', requires('admin:storage'), async (req, res) => {
  const run = latestRun();
  const finding = run?.findings.find((f) => f._id === req.params.findingId);
  if (!finding) return problem(res, 404, 'Not Found', 'That finding is not part of the latest run.');

  const check = fields(req.body || {}, {
    action: (v) => oneOf(v, REMEDIATIONS, { field: 'action', required: true }),
    songId: (v) => str(v, { max: 80, field: 'songId' }),
    assetType: (v) => str(v, { max: 80, field: 'assetType' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const action = check.value.action;
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
        // A file that would never have been allowed in through the front door is not
        // allowed in through reconciliation either. Adoption is a normal upload as far as
        // content policy is concerned.
        if (storage.isBlockedType(drive.mimeType) || storage.isBlockedExtension(drive.name)) {
          return problem(
            res, 422, 'Unprocessable Entity',
            `“${drive.name}” is a type the library does not accept (${drive.mimeType}). Quarantine it instead.`,
          );
        }
        const requestedType = req.body?.assetType || 'Master Audio';
        // The type decides the family, the icon and the facet. An arbitrary string from a
        // request body would put a file in a family nothing lists.
        const assetType = allTypes().some((t) => t.type === requestedType) ? requestedType : 'Master Audio';
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
  // So the People table can show an account the lockout counter has closed, rather than
  // leaving an administrator to wonder why somebody cannot sign in.
  locked: u.lockedUntil ? Date.parse(u.lockedUntil) > Date.now() : false,
  lockedUntil: u.lockedUntil ?? null,
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
  const check = fields(req.body || {}, {
    name: (v) => str(v, { max: LIMITS.name, field: 'name', required: true }),
    email: (v) => email(v, { field: 'email', required: true }),
    role: (v) => oneOf(v, ROLES, { field: 'role', fallback: 'User' }),
    password: (v) => str(v, { max: 200, field: 'password' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const { name, role, password } = check.value;
  const address = check.value.email;
  if (db.users.some((u) => u.email.toLowerCase() === address)) {
    return problem(res, 409, 'Conflict', 'That email address already has an account.');
  }

  const initial = password || SEED_PASSWORD;
  const invalid = await passwordProblem(initial, { email: address, name });
  if (invalid) return problem(res, 422, 'Unprocessable Entity', invalid);

  const user = {
    _id: `user_${uuid().slice(0, 8)}`,
    name,
    email: address,
    passwordHash: await hashPassword(initial),
    role,
    status: 'active',
    // The starting password is a handover, not a credential: it is good for exactly one
    // sign-in, and every route stays closed until the person replaces it.
    mustChangePassword: true,
    passwordChangedAt: null,
    // Session generation, lockout counters. Present from the start so nothing downstream
    // has to reason about an absent field.
    tokenVersion: 0,
    failedLogins: 0,
    lockedUntil: null,
    createdAt: new Date().toISOString(),
    // Who let this person in. Shown on their profile, and the only record of it outside
    // the activity log — which is trimmed, and which a User cannot read.
    createdBy: req.user.sub,
    lastLoginAt: null,
  };
  db.users.push(user);
  persist();
  alert(req, { action: 'USER_CREATE', entity: 'user', entityId: user._id, label: `Created ${user.name} (${user.role})` });
  res.status(201).json(publicUser(user));
});

const STATUSES = ['active', 'suspended'];

adminRouter.patch('/users/:id', requires('admin:users'), async (req, res) => {
  const user = db.users.find((u) => u._id === req.params.id);
  if (!user) return problem(res, 404, 'Not Found', 'No user with that id.');

  const nextRole = req.body?.role && ROLES.includes(req.body.role) ? req.body.role : null;
  if (req.body?.role && !nextRole) {
    return problem(res, 422, 'Unprocessable Entity', `Role must be one of: ${ROLES.join(', ')}.`);
  }
  // An unconstrained status field is how an account ends up in a state nothing checks for.
  const nextStatus = req.body?.status ?? null;
  if (nextStatus && !STATUSES.includes(nextStatus)) {
    return problem(res, 422, 'Unprocessable Entity', `Status must be one of: ${STATUSES.join(', ')}.`);
  }

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

  // A demotion or a suspension has to reach the sessions already open, or it is only a
  // change to what the screen offers: the access token in that browser still carries the
  // old role until it expires, and the middleware would keep honouring it.
  const changed = before.role !== normaliseRole(user.role) || before.status !== user.status;
  if (changed) {
    await invalidateSessions(user, nextStatus === 'suspended' ? 'account-suspended' : 'role-changed');
    await flushNow().catch(() => null);
  }

  persist();
  alert(req, {
    action: 'USER_UPDATE', entity: 'user', entityId: user._id,
    label: `Updated ${user.name}`, before, after: { role: normaliseRole(user.role), status: user.status },
    meta: { sessionsRevoked: changed },
  });
  res.json(publicUser(user));
});

// Hand somebody a new starting password. The account is put back into the handover state,
// so the value set here is good for exactly one sign-in — an administrator never ends up
// knowing a password somebody else is still using.
adminRouter.post('/users/:id/reset-password', requires('admin:users'), requireStepUp('Resetting a password'), async (req, res) => {
  const user = db.users.find((u) => u._id === req.params.id);
  if (!user) return problem(res, 404, 'Not Found', 'No user with that id.');

  const supplied = str(req.body?.password, { max: 200, field: 'password', required: true });
  if (supplied.problem) return problem(res, 422, 'Unprocessable Entity', supplied.problem);
  const initial = supplied.value;
  const invalid = await passwordProblem(initial, { email: user.email, name: user.name });
  if (invalid) return problem(res, 422, 'Unprocessable Entity', invalid);

  user.passwordHash = await hashPassword(initial);
  user.mustChangePassword = true;
  user.passwordChangedAt = null;
  user.failedLogins = 0;
  user.lockedUntil = null;
  await invalidateSessions(user, 'password-reset-by-admin');
  await flushNow().catch(() => null);

  alert(req, {
    action: 'USER_PASSWORD_RESET', entity: 'user', entityId: user._id,
    label: `Reset the password for ${user.name}`,
    meta: { sessionsRevoked: true, mustChangeAtNextSignIn: true },
  });
  notify({
    userId: user._id, level: 'warn',
    title: 'An administrator reset your password',
    body: 'Every session on your account was ended. Sign in with the new password and set one of your own.',
  });
  res.json(publicUser(user));
});

// Unlock an account the lockout counter closed, without waiting the window out.
adminRouter.post('/users/:id/unlock', requires('admin:users'), (req, res) => {
  const user = db.users.find((u) => u._id === req.params.id);
  if (!user) return problem(res, 404, 'Not Found', 'No user with that id.');
  user.failedLogins = 0;
  user.lockedUntil = null;
  persist();
  record(req, { action: 'USER_UNLOCK', entity: 'user', entityId: user._id, label: `Unlocked ${user.name}` });
  res.json(publicUser(user));
});

// ── Notifications (shared by every role) ────────────────────────────────────
export const notificationsRouter = express.Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', (req, res) => {
  const seen = (n) => Boolean(n.readAt) || (n.readBy || []).includes(req.user.sub);
  const rows = db.notifications
    .filter((n) => !n.userId || n.userId === req.user.sub)
    .slice(0, 40)
    .map((n) => ({ ...n, readBy: undefined, read: seen(n) }));
  res.json({ data: rows, unread: rows.filter((n) => !n.read).length });
});

// Marks the caller's own notifications read — the ones addressed to them, and the
// broadcast ones they can see. It used to mark every row in the collection, so one person
// clearing their bell cleared everybody's.
notificationsRouter.post('/read', (req, res) => {
  const at = new Date().toISOString();
  let marked = 0;
  for (const n of db.notifications) {
    if (n.readAt) continue;
    if (n.userId && n.userId !== req.user.sub) continue;
    // A broadcast row is read per person, so it is recorded per person rather than being
    // destroyed for everyone by whoever saw it first.
    if (!n.userId) {
      n.readBy = [...new Set([...(n.readBy || []), req.user.sub])];
      marked += 1;
      continue;
    }
    n.readAt = at;
    marked += 1;
  }
  persist();
  res.json({ ok: true, marked });
});
