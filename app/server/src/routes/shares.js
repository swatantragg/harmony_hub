import express from 'express';
import { db, persist, assetsUnderFolder } from '../db.js';
import { authenticate, optionalAuthenticate, requires, problem } from '../middleware/auth.js';
import { context } from '../services/assets.js';
import { alert, record, notify } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { can } from '../catalogue.js';
import { TTL, APP_ORIGIN, SHARE_PASSCODE, TRASH_DAYS } from '../config.js';
import { uuid, token, hashPassword, verifyPassword } from '../util/crypto.js';
import { LIMITS, str } from '../util/validate.js';

export const sharesRouter = express.Router();
export const publicShareRouter = express.Router();

const DURATIONS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
const AUDIENCES = ['PUBLIC', 'EDITOR', 'RESTRICTED'];

const AUDIENCE_LABEL = {
  PUBLIC: 'Open to all',
  EDITOR: 'Editor',
  RESTRICTED: 'Specific allocation',
};

function shareKind(s) {
  if (s.target === 'FOLDER') return { family: null, assetType: null, kind: 'FOLDER' };
  if (s.family) return { family: s.family, assetType: s.assetType ?? null, kind: s.family };
  const ctx = s.assetId ? context(s.assetId) : null;
  const family = ctx?.asset?.family ?? null;
  return { family, assetType: ctx?.asset?.type ?? null, kind: family ?? 'ASSET' };
}

const recipientFor = (email) => ({
  _id: uuid(),
  email,
  token: token(24),
  createdAt: new Date().toISOString(),
  revokedAt: null,
  firstAccessedAt: null,
  lastAccessedAt: null,
  accessCount: 0,
  downloadCount: 0,
});

const publicRecipient = (r, shareUrl) => ({
  _id: r._id,
  email: r.email,
  url: shareUrl(r.token),
  createdAt: r.createdAt,
  revokedAt: r.revokedAt,
  firstAccessedAt: r.firstAccessedAt,
  lastAccessedAt: r.lastAccessedAt,
  accessCount: r.accessCount ?? 0,
  downloadCount: r.downloadCount ?? 0,
});

const decorate = (s) => ({
  ...s,
  passcodeHash: undefined,
  hasPasscode: Boolean(s.passcodeHash),
  recipients: (s.recipients || []).map((r) => publicRecipient(r, (t) => `${APP_ORIGIN}/#/s/${t}`)),
  ...shareKind(s),
  url: `${APP_ORIGIN}/#/s/${s.token}`,
  audienceLabel: AUDIENCE_LABEL[s.audience] ?? AUDIENCE_LABEL.PUBLIC,
  frozen: Boolean(s.frozenAt),
  failedAttempts: Number(s.failedAttempts ?? 0),
  expired: Date.parse(s.expiresAt) < Date.now(),
  exhausted: s.maxDownloads != null && s.downloadCount >= s.maxDownloads,
  remainingMs: Date.parse(s.expiresAt) - Date.now(),
});

const normaliseEmails = (list) =>
  [...new Set((Array.isArray(list) ? list : [])
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];

const shareableRows = (folderId) =>
  assetsUnderFolder(folderId).filter(({ asset }) => !asset.deletedAt);

async function folderManifest(folder, { expiresIn, shareId }) {
  const rows = shareableRows(folder._id);
  await storage.verifyAssets(rows.map((r) => r.asset));

  return Promise.all(
    rows.map(async ({ asset, song, artist, folder: parent }) => {
      const status = asset.availability.status;
      const shareable = status !== 'MISSING' && status !== 'TRASHED';
      return {
        assetId: asset.assetId,
        displayName: asset.displayName,
        subfolder: parent && parent._id !== folder._id ? parent.name : null,
        type: asset.type,
        family: asset.family,
        mimeType: asset.mimeType,
        sizeBytes: asset.drive?.sizeBytes ?? 0,
        version: asset.version,
        durationSec: asset.durationSec ?? null,
        dimensions: asset.dimensions ?? null,
        songTitle: song?.title ?? null,
        artistName: artist?.name ?? null,
        availability: status,
        previewUrl: shareable
          ? storage.signedUrl({
            fileId: asset.drive.fileId, filename: asset.displayName, mimeType: asset.mimeType,
            expiresIn, inline: true, purpose: 'share', assetId: asset.assetId,
            shareId,
          })
          : null,
      };
    }),
  );
}

sharesRouter.use(authenticate);

sharesRouter.get('/', requires('share:create'), (req, res) => {
  const rows = db.shares
    .map(decorate)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  res.json({ data: rows, total: rows.length });
});

sharesRouter.post('/', requires('share:create'), async (req, res) => {
  const {
    assetId, folderId, target: rawTarget, targetId: rawTargetId,
    audience: rawAudience = 'PUBLIC', allowedEmails,
    expiresIn = '7d', canDownload = true, maxDownloads = null, note = '', passcode,
  } = req.body || {};

  const target = rawTarget === 'FOLDER' || (!assetId && folderId) ? 'FOLDER' : 'ASSET';
  const targetId = rawTargetId || (target === 'FOLDER' ? folderId : assetId);
  if (!targetId) return problem(res, 422, 'Unprocessable Entity', 'Nothing was selected to share.');

  const noteCheck = str(note, { max: LIMITS.note, field: 'note', allowEmpty: true });
  if (noteCheck.problem) return problem(res, 422, 'Unprocessable Entity', noteCheck.problem);

  const audience = AUDIENCES.includes(rawAudience) ? rawAudience : 'PUBLIC';
  const emails = audience === 'RESTRICTED' ? normaliseEmails(allowedEmails) : [];
  if (audience === 'RESTRICTED' && emails.length === 0) {
    return problem(res, 422, 'Unprocessable Entity', 'A specific-allocation link needs at least one valid email address.');
  }
  if (emails.length > 200) {
    return problem(res, 422, 'Unprocessable Entity', 'A link can be allocated to at most 200 addresses.');
  }

  const secret = passcode == null || passcode === '' ? null : String(passcode);
  if (secret && (secret.length < SHARE_PASSCODE.minLength || secret.length > 100)) {
    return problem(
      res, 422, 'Unprocessable Entity',
      `A link passcode must be between ${SHARE_PASSCODE.minLength} and 100 characters.`,
    );
  }

  const base = {
    _id: uuid(),
    target,
    targetId,
    audience,
    allowedEmails: emails,
    canEdit: audience === 'EDITOR',
    token: token(24),
    recipients: emails.map(recipientFor),
    createdBy: req.user.sub,
    createdByName: req.user.name,
    note: noteCheck.value,
    passcodeHash: secret ? await hashPassword(secret) : null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (DURATIONS[expiresIn] ?? DURATIONS['7d'])).toISOString(),
    canDownload: Boolean(canDownload),
    maxDownloads: maxDownloads == null ? null : Number(maxDownloads),
    downloadCount: 0,
    revokedAt: null,
  };

  let share;
  if (target === 'FOLDER') {
    const folder = db.folders.find((f) => f._id === targetId && !f.deletedAt);
    if (!folder) return problem(res, 404, 'Not Found', 'No folder with that id.');
    const files = shareableRows(folder._id);
    if (files.length === 0) {
      return problem(res, 409, 'Conflict', 'This folder is empty — nothing is filed in it or in any folder inside it — so there is nothing to share yet.');
    }
    share = {
      ...base,
      assetId: null,
      assetName: folder.name,
      targetName: folder.name,
      fileCount: files.length,
      songTitle: null,
      artistName: null,
    };
  } else {
    const ctx = context(targetId);
    if (!ctx) return problem(res, 404, 'Not Found', 'No asset with that id.');
    const { availability } = await storage.verifyAsset(ctx.asset);
    if (availability.status === 'MISSING') {
      return problem(res, 409, 'Conflict', 'This file is not in storage, so it cannot be shared.');
    }
    share = {
      ...base,
      assetId: targetId,
      assetName: ctx.asset.displayName,
      targetName: ctx.asset.displayName,
      fileCount: 1,
      family: ctx.asset.family,
      assetType: ctx.asset.type,
      songTitle: ctx.song?.title ?? null,
      artistName: ctx.artist?.name ?? null,
    };
  }

  db.shares.unshift(share);
  persist();
  record(req, {
    action: 'SHARE_CREATE', entity: 'share', entityId: share._id,
    label: `Shared ${share.targetName} for ${expiresIn} (${AUDIENCE_LABEL[audience]})`,
    after: {
      target, audience, expiresAt: share.expiresAt,
      maxDownloads: share.maxDownloads, canDownload: share.canDownload,
      recipients: emails.length || null,
    },
  });
  res.status(201).json(decorate(share));
});

sharesRouter.delete('/:id/recipients/:recipientId', requires('share:revoke'), (req, res) => {
  const share = db.shares.find((s) => s._id === req.params.id);
  if (!share) return problem(res, 404, 'Not Found', 'No share with that id.');
  const recipient = (share.recipients || []).find((r) => r._id === req.params.recipientId);
  if (!recipient) return problem(res, 404, 'Not Found', 'No recipient with that id on this link.');
  if (recipient.revokedAt) return res.json(decorate(share));

  recipient.revokedAt = new Date().toISOString();
  share.allowedEmails = (share.allowedEmails || []).filter((e) => e !== recipient.email);
  persist();
  record(req, {
    action: 'SHARE_RECIPIENT_REVOKE', entity: 'share', entityId: share._id,
    label: `Withdrew ${recipient.email}'s link to ${share.targetName ?? share.assetName}`,
    after: { email: recipient.email, revokedAt: recipient.revokedAt, downloadCount: recipient.downloadCount ?? 0 },
  });
  res.json(decorate(share));
});

sharesRouter.post('/:id/recipients', requires('share:create'), (req, res) => {
  const share = db.shares.find((s) => s._id === req.params.id);
  if (!share) return problem(res, 404, 'Not Found', 'No share with that id.');
  if (share.revokedAt) return problem(res, 410, 'Gone', 'This link has been revoked.');
  if ((share.audience ?? 'PUBLIC') !== 'RESTRICTED') {
    return problem(
      res, 409, 'Conflict',
      'Only a specific-allocation link has per-recipient links. This one is open to everybody who holds it.',
    );
  }

  const emails = normaliseEmails(req.body?.emails ?? [req.body?.email]);
  if (emails.length === 0) return problem(res, 422, 'Unprocessable Entity', 'Give at least one valid email address.');

  share.recipients ??= [];
  if (share.recipients.length + emails.length > 200) {
    return problem(res, 422, 'Unprocessable Entity', 'A link can be allocated to at most 200 addresses.');
  }

  const added = [];
  for (const email of emails) {
    const existing = share.recipients.find((r) => r.email === email);
    if (existing && !existing.revokedAt) continue;
    if (existing) share.recipients = share.recipients.filter((r) => r !== existing);
    const recipient = recipientFor(email);
    share.recipients.push(recipient);
    added.push(email);
  }
  share.allowedEmails = [...new Set([...(share.allowedEmails || []), ...emails])];
  persist();

  if (added.length) {
    record(req, {
      action: 'SHARE_RECIPIENT_ADD', entity: 'share', entityId: share._id,
      label: `Issued ${added.length} link${added.length === 1 ? '' : 's'} for ${share.targetName ?? share.assetName}`,
      after: { emails: added },
    });
  }
  res.status(added.length ? 201 : 200).json(decorate(share));
});

sharesRouter.delete('/:id', requires('share:revoke'), (req, res) => {
  const share = db.shares.find((s) => s._id === req.params.id);
  if (!share) return problem(res, 404, 'Not Found', 'No share with that id.');
  share.revokedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'SHARE_REVOKE', entity: 'share', entityId: share._id,
    label: `Revoked the link to ${share.targetName ?? share.assetName}`, after: { revokedAt: share.revokedAt },
  });
  res.json(decorate(share));
});

function resolveToken(value) {
  const token = String(value || '');
  const direct = db.shares.find((s) => s.token === token);
  if (direct) return { share: direct, recipient: null };
  for (const share of db.shares) {
    const recipient = (share.recipients || []).find((r) => r.token === token);
    if (recipient) return { share, recipient };
  }
  return { share: null, recipient: null };
}
async function openGate(share, req, res, recipient = null) {
  if (!share) { problem(res, 404, 'Not Found', 'This link does not exist.'); return false; }
  if (share.revokedAt) { problem(res, 410, 'Gone', 'This link has been revoked by its owner.'); return false; }
  if (Date.parse(share.expiresAt) < Date.now()) { problem(res, 410, 'Gone', 'This link has expired.'); return false; }
  if (share.frozenAt) {
    problem(
      res, 423, 'Locked',
      'This link was frozen after repeated wrong passcodes. Ask the person who sent it for a new one.',
    );
    return false;
  }
  if (share.passcodeHash) {
    const supplied = req.get('x-share-passcode') || req.body?.passcode || req.query?.passcode;
    if (!supplied) {
      problem(res, 401, 'Passcode Required', 'This link is protected by a passcode.', { passcodeRequired: true });
      return false;
    }
    if (!(await verifyPassword(String(supplied), share.passcodeHash))) {
      // A per-share counter, on top of the per-address limiter. The limiter
      // stops one machine guessing quickly; this stops a botnet guessing slowly,
      // because it counts the link's failures wherever they come from.
      share.failedAttempts = Number(share.failedAttempts ?? 0) + 1;
      share.lastFailedAt = new Date().toISOString();

      const auditReq = { ip: req.ip, socketIp: req.socketIp, get: (h) => req.get(h), user: req.user ?? null };
      record(auditReq, {
        action: 'SHARE_PASSCODE_FAILED', entity: 'share', entityId: share._id,
        label: `Wrong passcode on the link to ${share.targetName ?? share.assetName}`,
        after: { failedAttempts: share.failedAttempts },
      });

      if (share.failedAttempts >= SHARE_PASSCODE.freezeAt) {
        share.frozenAt = share.lastFailedAt;
        persist();
        alert(auditReq, {
          action: 'SHARE_PASSCODE_FROZEN', entity: 'share', entityId: share._id,
          level: 'danger',
          label: `Froze the link to ${share.targetName ?? share.assetName} after ${share.failedAttempts} wrong passcodes`,
          after: { failedAttempts: share.failedAttempts },
        });
        notify({
          userId: share.createdBy,
          audience: 'admin',
          category: 'security',
          level: 'danger',
          title: `Your link to ${share.targetName ?? share.assetName} was frozen`,
          body: `${share.failedAttempts} wrong passcodes were tried against it. Nobody can open it now. Revoke it and send a new one.`,
          link: '/shares',
        });
        problem(res, 423, 'Locked', 'This link has been frozen after too many wrong passcodes. Ask the sender for a new one.');
        return false;
      }

      // Warn the owner once, halfway to the freeze, while the link still works.
      if (share.failedAttempts === Math.ceil(SHARE_PASSCODE.freezeAt / 2)) {
        notify({
          userId: share.createdBy,
          audience: 'admin',
          category: 'security',
          level: 'warn',
          title: `Wrong passcodes are being tried on your link to ${share.targetName ?? share.assetName}`,
          body: `${share.failedAttempts} so far. It freezes itself at ${SHARE_PASSCODE.freezeAt}.`,
          link: '/shares',
        });
      }
      persist();
      problem(res, 401, 'Passcode Required', 'That passcode is not correct.', { passcodeRequired: true });
      return false;
    }
    // A success clears the count: an owner who mistyped twice this morning
    // should not find the link frozen a fortnight later.
    if (share.failedAttempts) {
      share.failedAttempts = 0;
      persist();
    }
  }
  const audience = share.audience ?? 'PUBLIC';
  if (recipient?.revokedAt) {
    problem(res, 410, 'Gone', 'This link was issued to you and has since been withdrawn. Ask the sender for a new one.');
    return false;
  }

  if (audience === 'RESTRICTED' && !recipient && (share.recipients || []).length > 0) {
    problem(
      res, 404, 'Not Found',
      'This link was issued per recipient. Use the link that was sent to your address.',
    );
    return false;
  }
  if (audience === 'PUBLIC') return true;
  if (!req.user) {
    problem(res, 401, 'Sign In Required', audience === 'EDITOR'
      ? 'This link is for GCloud editors. Sign in to open it.'
      : 'This link was sent to named people. Sign in with the address it was sent to.');
    return false;
  }
  if (audience === 'EDITOR' && !can(req.user.role, 'asset:edit')) {
    problem(res, 403, 'Forbidden', `This is an editor link, and the ${req.user.role} role cannot edit files.`);
    return false;
  }
  if (audience === 'RESTRICTED') {
    const signedInAs = String(req.user.email || '').toLowerCase();
    if (recipient && recipient.email !== signedInAs) {
      record(
        { ip: req.ip, socketIp: req.socketIp, get: (h) => req.get(h), user: req.user },
        {
          action: 'SHARE_RECIPIENT_MISMATCH', entity: 'share', entityId: share._id,
          label: `${req.user.name} opened a link issued to ${recipient.email}`,
          meta: { issuedTo: recipient.email, openedBy: signedInAs },
        },
      );
      problem(
        res, 403, 'Forbidden',
        `This link was sent to ${recipient.email}. Sign in with that address, or ask the sender for one of your own.`,
      );
      return false;
    }
    if (!recipient && !(share.allowedEmails || []).includes(signedInAs)) {
      problem(res, 403, 'Forbidden', 'This link was not shared with your account.');
      return false;
    }
  }
  return true;
}
const capReached = (share) => share.maxDownloads != null && share.downloadCount >= share.maxDownloads;

const STAMP = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * Tells the person who created a link that somebody downloaded from it.
 *
 * Addressed to `share.createdBy` and to administrators — and to nobody else.
 * Whoever shared a folder needs to know it was taken; the rest of the library
 * has no business knowing which external partner opened whose link.
 */
function notifyDownload(share, what, recipient, req) {
  notify({
    userId: share.createdBy,
    audience: 'admin',
    category: 'shares',
    level: 'info',
    title: `Download : ${what} (downloaded on ${STAMP.format(new Date())})`,
    body: [
      recipient ? `On the link issued to ${recipient.email}` : `On the ${AUDIENCE_LABEL[share.audience ?? 'PUBLIC'].toLowerCase()} link`,
      req.user ? `by ${req.user.name}` : `from ${req.socketIp ?? 'an unknown address'}`,
    ].join(' · '),
    link: '/shares',
    meta: { shareId: share._id, recipient: recipient?.email ?? null },
  });
}
publicShareRouter.get('/:token', optionalAuthenticate, async (req, res) => {
  const { share, recipient } = resolveToken(req.params.token);
  if (!await openGate(share, req, res, recipient)) return;

  const ttl = Math.min(TTL.share, Math.max(60, Math.floor((Date.parse(share.expiresAt) - Date.now()) / 1000)));
  const common = {
    share: {
      target: share.target ?? 'ASSET',
      audience: share.audience ?? 'PUBLIC',
      audienceLabel: AUDIENCE_LABEL[share.audience ?? 'PUBLIC'],
      canDownload: share.canDownload,
      canEdit: Boolean(share.canEdit),
      expiresAt: share.expiresAt,
      note: share.note,
      sharedBy: share.createdByName,
      downloadsRemaining: share.maxDownloads == null ? null : share.maxDownloads - share.downloadCount,
      recipientCount: (share.allowedEmails || []).length || null,
      hasPasscode: Boolean(share.passcodeHash),
    },
    viewer: req.user ? { name: req.user.name, email: req.user.email, role: req.user.role } : null,
  };
  const at = new Date().toISOString();
  if (!share.firstAccessedAt) {
    share.firstAccessedAt = at;
    notify({
      userId: share.createdBy,
      audience: 'admin',
      category: 'shares',
      level: 'info',
      title: `Your link to ${share.targetName ?? share.assetName} was opened`,
      body: `First opened just now from ${req.socketIp ?? 'an unknown address'}${recipient ? ` on the link issued to ${recipient.email}` : ''}${req.user ? ` by ${req.user.name}` : ''}.`,
      link: '/shares',
    });
  }
  share.lastAccessedAt = at;
  share.accessCount = Number(share.accessCount ?? 0) + 1;
  if (recipient) {
    recipient.firstAccessedAt ??= at;
    recipient.lastAccessedAt = at;
    recipient.accessCount = Number(recipient.accessCount ?? 0) + 1;
  }
  if ((share.target ?? 'ASSET') === 'FOLDER') {
    const folder = db.folders.find((f) => f._id === share.targetId && !f.deletedAt);
    if (!folder) return problem(res, 404, 'Not Found', 'The shared folder is no longer in the catalogue.');
    const files = await folderManifest(folder, { expiresIn: ttl, shareId: share._id });
    persist();
    return res.json({
      ...common,
      kind: 'FOLDER',
      folder: {
        name: folder.name,
        description: folder.description,
        tags: folder.tags,
        fileCount: files.length,
        totalBytes: files.reduce((n, f) => n + (f.sizeBytes || 0), 0),
      },
      files,
    });
  }
  const ctx = context(share.targetId ?? share.assetId);
  if (!ctx) return problem(res, 404, 'Not Found', 'The shared file is no longer catalogued.');
  const { availability } = await storage.verifyAsset(ctx.asset);
  if (availability.status === 'MISSING') {
    return problem(res, 503, 'Service Unavailable', 'The shared file is temporarily unavailable. The owner has been notified.');
  }
  persist();
  res.json({
    ...common,
    kind: 'ASSET',
    asset: {
      assetId: ctx.asset.assetId,
      displayName: ctx.asset.displayName, type: ctx.asset.type, family: ctx.asset.family,
      sizeBytes: ctx.asset.drive?.sizeBytes ?? 0, mimeType: ctx.asset.mimeType, version: ctx.asset.version,
      durationSec: ctx.asset.durationSec ?? null, dimensions: ctx.asset.dimensions ?? null,
      description: ctx.asset.description ?? '',
      songTitle: ctx.song?.title ?? null, artistName: ctx.artist?.name ?? null,
    },
    previewUrl: storage.signedUrl({
      fileId: ctx.asset.drive.fileId, filename: ctx.asset.displayName, mimeType: ctx.asset.mimeType,
      expiresIn: ttl, inline: true, purpose: 'share', assetId: ctx.asset.assetId,
      shareId: share._id,
    }),
    availability: availability.status,
  });
});
publicShareRouter.post('/:token/download', optionalAuthenticate, async (req, res) => {
  const { share, recipient } = resolveToken(req.params.token);
  if (!await openGate(share, req, res, recipient)) return;
  if (!share.canDownload) return problem(res, 403, 'Forbidden', 'This link is preview-only.');
  if (capReached(share)) return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');
  const wanted = req.body?.assetId;
  let assetId = share.targetId ?? share.assetId;
  if ((share.target ?? 'ASSET') === 'FOLDER') {
    if (!wanted) return problem(res, 422, 'Unprocessable Entity', 'Name the file to download.');
    const inFolder = shareableRows(share.targetId).some(({ asset }) => asset.assetId === wanted);
    if (!inFolder) return problem(res, 403, 'Forbidden', 'That file is not in the shared folder.');
    assetId = wanted;
  }
  const ctx = context(assetId);
  if (!ctx) return problem(res, 404, 'Not Found', 'The shared file is no longer catalogued.');
  const { availability } = await storage.verifyAsset(ctx.asset);
  if (availability.status === 'MISSING') {
    return problem(res, 503, 'Service Unavailable', 'That file is not in storage right now.');
  }
  if (availability.status === 'TRASHED') {
    return problem(res, 409, 'Conflict', `That file is in the owner's Google Drive trash. Ask them to restore it — Drive deletes trashed files permanently after ${TRASH_DAYS} days.`);
  }

  share.downloadCount += 1;
  if (recipient) recipient.downloadCount = Number(recipient.downloadCount ?? 0) + 1;
  if (share.maxDownloads != null && share.downloadCount > share.maxDownloads) {
    share.downloadCount = share.maxDownloads;
    persist();
    return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');
  }
  persist();
  record(
    { ip: req.ip, socketIp: req.socketIp, get: (h) => req.get(h), user: req.user ?? { sub: null, name: 'external partner', role: 'public' } },
    {
      action: 'SHARE_ACCESS', entity: 'share', entityId: share._id,
      label: `External download of ${ctx.asset.displayName}`,
      after: { downloadCount: share.downloadCount, audience: share.audience ?? 'PUBLIC' },
    },
  );
  notifyDownload(share, ctx.asset.displayName, recipient, req);

  const downloadAs = storage.downloadName(ctx.asset.displayName, ctx.asset.mimeType);
  const url = storage.signedUrl({
    fileId: ctx.asset.drive.fileId, filename: downloadAs, mimeType: ctx.asset.mimeType,
    expiresIn: TTL.download, purpose: 'share', assetId: ctx.asset.assetId, shareId: share._id,
  });
  res.json({
    url,
    downloadAs,
    downloadsRemaining: share.maxDownloads == null ? null : share.maxDownloads - share.downloadCount,
  });
});

publicShareRouter.post('/:token/download-all', optionalAuthenticate, async (req, res) => {
  const { share, recipient } = resolveToken(req.params.token);
  if (!await openGate(share, req, res, recipient)) return;
  if ((share.target ?? 'ASSET') !== 'FOLDER') return problem(res, 422, 'Unprocessable Entity', 'This link is a single file.');
  if (!share.canDownload) return problem(res, 403, 'Forbidden', 'This link is preview-only.');
  const rows = shareableRows(share.targetId);
  const remaining = share.maxDownloads == null ? Infinity : share.maxDownloads - share.downloadCount;
  if (remaining <= 0) return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');

  await storage.verifyAssets(rows.map((r) => r.asset));
  const files = [];
  for (const { asset } of rows) {
    if (files.length >= remaining) break;
    const status = asset.availability.status;
    if (status === 'MISSING' || status === 'TRASHED') continue;
    files.push({
      assetId: asset.assetId,
      name: storage.downloadName(asset.displayName, asset.mimeType),
      sizeBytes: asset.drive?.sizeBytes ?? 0,
      url: storage.signedUrl({
        fileId: asset.drive.fileId, filename: storage.downloadName(asset.displayName, asset.mimeType),
        mimeType: asset.mimeType, expiresIn: TTL.download, purpose: 'share', assetId: asset.assetId,
        shareId: share._id,
      }),
    });
  }
  share.downloadCount += files.length;
  if (recipient) recipient.downloadCount = Number(recipient.downloadCount ?? 0) + files.length;
  persist();
  if (files.length) {
    notifyDownload(share, `${share.targetName ?? share.assetName} (${files.length} files)`, recipient, req);
  }
  record(
    { ip: req.ip, socketIp: req.socketIp, get: (h) => req.get(h), user: req.user ?? { sub: null, name: 'external partner', role: 'public' } },
    {
      action: 'SHARE_ACCESS', entity: 'share', entityId: share._id,
      label: `External download of ${files.length} files from ${share.targetName ?? share.assetName}`,
      after: { downloadCount: share.downloadCount },
    },
  );
  res.json({
    files,
    skipped: rows.length - files.length,
    downloadsRemaining: share.maxDownloads == null ? null : share.maxDownloads - share.downloadCount,
  });
});