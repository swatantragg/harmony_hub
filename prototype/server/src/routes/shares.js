// External sharing (§10.10). Hard expiry, download caps, instant revocation, and a
// HeadObject gate so a partner never receives a URL to a file that has gone missing.
//
// A link never carries a storage address. It carries a random token that resolves, on
// every open, into a freshly signed short-lived URL — which is why revoking works and
// why a leaked link cannot outlive its window.
//
// Three audiences, chosen when the link is made:
//   PUBLIC      "Open to all"        — no account. Anyone holding the link opens it.
//   EDITOR      "Editor"             — must sign in to GCloud AND hold asset:edit.
//                                      Preview, download, and edit the file in the app.
//   RESTRICTED  "Specific allocation"— must sign in, and the account's email must be on
//                                      the recipient list attached to this link.
//
// A link points at either one asset or a whole folder. A folder link resolves to a
// manifest of its files — every one of them still a separate object in storage, each
// signed individually at the moment it is opened.
import express from 'express';
import { db, persist, assetsInFolder } from '../db.js';
import { authenticate, optionalAuthenticate, requires, problem } from '../middleware/auth.js';
import { context } from '../services/assets.js';
import { record } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { can } from '../catalogue.js';
import { TTL, APP_ORIGIN } from '../config.js';
import { uuid, token } from '../util/crypto.js';

export const sharesRouter = express.Router();
export const publicShareRouter = express.Router();

const DURATIONS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };
const AUDIENCES = ['PUBLIC', 'EDITOR', 'RESTRICTED'];

const AUDIENCE_LABEL = {
  PUBLIC: 'Open to all',
  EDITOR: 'Editor',
  RESTRICTED: 'Specific allocation',
};

const decorate = (s) => ({
  ...s,
  url: `${APP_ORIGIN}/#/s/${s.token}`,
  audienceLabel: AUDIENCE_LABEL[s.audience] ?? AUDIENCE_LABEL.PUBLIC,
  expired: Date.parse(s.expiresAt) < Date.now(),
  exhausted: s.maxDownloads != null && s.downloadCount >= s.maxDownloads,
  remainingMs: Date.parse(s.expiresAt) - Date.now(),
});

const normaliseEmails = (list) =>
  [...new Set((Array.isArray(list) ? list : [])
    .map((e) => String(e).trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];

// A folder link is only worth as much as the files inside it, so the manifest is built
// the same way the folder page is: catalogue membership, one signed URL per object.
function folderManifest(folder, { expiresIn }) {
  return assetsInFolder(folder._id)
    .filter(({ asset }) => !asset.deletedAt)
    .map(({ asset, song, artist }) => {
      const { availability } = storage.verifyAsset(asset);
      const shareable = availability.status !== 'MISSING' && availability.status !== 'ARCHIVED';
      return {
        assetId: asset.assetId,
        displayName: asset.displayName,
        type: asset.type,
        family: asset.family,
        mimeType: asset.mimeType,
        sizeBytes: asset.s3.sizeBytes,
        version: asset.version,
        durationSec: asset.durationSec ?? null,
        dimensions: asset.dimensions ?? null,
        songTitle: song?.title ?? null,
        artistName: artist?.name ?? null,
        availability: availability.status,
        previewUrl: shareable
          ? storage.presignGet({
            bucket: asset.s3.bucket, key: asset.s3.key,
            expiresIn, filename: asset.displayName, inline: true,
          })
          : null,
      };
    });
}

sharesRouter.use(authenticate);

sharesRouter.get('/', requires('share:create'), (req, res) => {
  const rows = db.shares
    .map(decorate)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  res.json({ data: rows, total: rows.length });
});

sharesRouter.post('/', requires('share:create'), (req, res) => {
  const {
    assetId, folderId, target: rawTarget, targetId: rawTargetId,
    audience: rawAudience = 'PUBLIC', allowedEmails,
    expiresIn = '7d', canDownload = true, maxDownloads = null, note = '',
  } = req.body || {};

  const target = rawTarget === 'FOLDER' || (!assetId && folderId) ? 'FOLDER' : 'ASSET';
  const targetId = rawTargetId || (target === 'FOLDER' ? folderId : assetId);
  if (!targetId) return problem(res, 422, 'Unprocessable Entity', 'Nothing was selected to share.');

  const audience = AUDIENCES.includes(rawAudience) ? rawAudience : 'PUBLIC';
  const emails = audience === 'RESTRICTED' ? normaliseEmails(allowedEmails) : [];
  if (audience === 'RESTRICTED' && emails.length === 0) {
    return problem(res, 422, 'Unprocessable Entity', 'A specific-allocation link needs at least one valid email address.');
  }

  const base = {
    _id: uuid(),
    target,
    targetId,
    audience,
    allowedEmails: emails,
    // Editor links carry write rights into the app; the other two are read paths only.
    canEdit: audience === 'EDITOR',
    token: token(24),
    createdBy: req.user.sub,
    createdByName: req.user.name,
    note,
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
    const files = assetsInFolder(folder._id).filter(({ asset }) => !asset.deletedAt);
    if (files.length === 0) {
      return problem(res, 409, 'Conflict', 'This folder is empty, so there is nothing to share yet.');
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
    const { availability } = storage.verifyAsset(ctx.asset);
    if (availability.status === 'MISSING') {
      return problem(res, 409, 'Conflict', 'This file is not in storage, so it cannot be shared.');
    }
    share = {
      ...base,
      assetId: targetId,
      assetName: ctx.asset.displayName,
      targetName: ctx.asset.displayName,
      fileCount: 1,
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

// ── Public resolution — all gates enforced (§10.10) ─────────────────────────
// Every gate is checked here, on the server, on every single open. The client is never
// trusted with any of it.
function openGate(share, req, res) {
  if (!share) { problem(res, 404, 'Not Found', 'This link does not exist.'); return false; }
  if (share.revokedAt) { problem(res, 410, 'Gone', 'This link has been revoked by its owner.'); return false; }
  if (Date.parse(share.expiresAt) < Date.now()) { problem(res, 410, 'Gone', 'This link has expired.'); return false; }

  const audience = share.audience ?? 'PUBLIC';
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
  if (audience === 'RESTRICTED' && !(share.allowedEmails || []).includes(String(req.user.email || '').toLowerCase())) {
    problem(res, 403, 'Forbidden', 'This link was not shared with your account.');
    return false;
  }
  return true;
}

const capReached = (share) => share.maxDownloads != null && share.downloadCount >= share.maxDownloads;

publicShareRouter.get('/:token', optionalAuthenticate, (req, res) => {
  const share = db.shares.find((s) => s.token === req.params.token);
  if (!openGate(share, req, res)) return;

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
    },
    viewer: req.user ? { name: req.user.name, email: req.user.email, role: req.user.role } : null,
  };

  if ((share.target ?? 'ASSET') === 'FOLDER') {
    const folder = db.folders.find((f) => f._id === share.targetId && !f.deletedAt);
    if (!folder) return problem(res, 404, 'Not Found', 'The shared folder is no longer in the catalogue.');
    const files = folderManifest(folder, { expiresIn: ttl });
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

  const { availability } = storage.verifyAsset(ctx.asset);
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
      sizeBytes: ctx.asset.s3.sizeBytes, mimeType: ctx.asset.mimeType, version: ctx.asset.version,
      durationSec: ctx.asset.durationSec ?? null, dimensions: ctx.asset.dimensions ?? null,
      description: ctx.asset.description ?? '',
      songTitle: ctx.song?.title ?? null, artistName: ctx.artist?.name ?? null,
    },
    previewUrl: storage.presignGet({
      bucket: ctx.asset.s3.bucket, key: ctx.asset.s3.key,
      expiresIn: ttl, filename: ctx.asset.displayName, inline: true,
    }),
    availability: availability.status,
  });
});

// One signed download. For a folder link the caller names which file it wants; the
// download cap counts files, not clicks, so an unlimited folder is an explicit choice.
publicShareRouter.post('/:token/download', optionalAuthenticate, (req, res) => {
  const share = db.shares.find((s) => s.token === req.params.token);
  if (!openGate(share, req, res)) return;
  if (!share.canDownload) return problem(res, 403, 'Forbidden', 'This link is preview-only.');
  if (capReached(share)) return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');

  const wanted = req.body?.assetId;
  let assetId = share.targetId ?? share.assetId;

  if ((share.target ?? 'ASSET') === 'FOLDER') {
    if (!wanted) return problem(res, 422, 'Unprocessable Entity', 'Name the file to download.');
    const inFolder = assetsInFolder(share.targetId).some(({ asset }) => asset.assetId === wanted && !asset.deletedAt);
    if (!inFolder) return problem(res, 403, 'Forbidden', 'That file is not in the shared folder.');
    assetId = wanted;
  }

  const ctx = context(assetId);
  if (!ctx) return problem(res, 404, 'Not Found', 'The shared file is no longer catalogued.');
  const { availability } = storage.verifyAsset(ctx.asset);
  if (availability.status === 'MISSING') {
    return problem(res, 503, 'Service Unavailable', 'That file is not in storage right now.');
  }
  if (availability.status === 'ARCHIVED') {
    return problem(res, 409, 'Conflict', 'That file is in archival storage. Ask the owner to restore it first.');
  }

  share.downloadCount += 1;
  persist();
  record(
    { ip: req.ip, get: (h) => req.get(h), user: req.user ?? { sub: null, name: 'external partner', role: 'public' } },
    {
      action: 'SHARE_ACCESS', entity: 'share', entityId: share._id,
      label: `External download of ${ctx.asset.displayName}`,
      after: { downloadCount: share.downloadCount, audience: share.audience ?? 'PUBLIC' },
    },
  );

  const url = storage.presignGet({
    bucket: ctx.asset.s3.bucket, key: ctx.asset.s3.key,
    expiresIn: TTL.download, filename: ctx.asset.displayName,
  });
  res.json({
    url,
    downloadAs: ctx.asset.displayName,
    downloadsRemaining: share.maxDownloads == null ? null : share.maxDownloads - share.downloadCount,
  });
});

// "Download everything" on a folder link. Amazon S3 cannot zip on the server side, and
// this prototype does not pretend it can: the API returns one signed URL per file and
// the browser pulls each one straight from storage. A production build would hand this
// to a zipper Lambda for anything large.
publicShareRouter.post('/:token/download-all', optionalAuthenticate, (req, res) => {
  const share = db.shares.find((s) => s.token === req.params.token);
  if (!openGate(share, req, res)) return;
  if ((share.target ?? 'ASSET') !== 'FOLDER') return problem(res, 422, 'Unprocessable Entity', 'This link is a single file.');
  if (!share.canDownload) return problem(res, 403, 'Forbidden', 'This link is preview-only.');

  const rows = assetsInFolder(share.targetId).filter(({ asset }) => !asset.deletedAt);
  const remaining = share.maxDownloads == null ? Infinity : share.maxDownloads - share.downloadCount;
  if (remaining <= 0) return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');

  const files = [];
  for (const { asset } of rows) {
    if (files.length >= remaining) break;
    const { availability } = storage.verifyAsset(asset);
    if (availability.status === 'MISSING' || availability.status === 'ARCHIVED') continue;
    files.push({
      assetId: asset.assetId,
      name: asset.displayName,
      sizeBytes: asset.s3.sizeBytes,
      url: storage.presignGet({
        bucket: asset.s3.bucket, key: asset.s3.key,
        expiresIn: TTL.download, filename: asset.displayName,
      }),
    });
  }

  share.downloadCount += files.length;
  persist();
  record(
    { ip: req.ip, get: (h) => req.get(h), user: req.user ?? { sub: null, name: 'external partner', role: 'public' } },
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
