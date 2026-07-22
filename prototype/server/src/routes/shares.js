// External sharing (§10.10). Hard expiry, download caps, instant revocation, and a
// HeadObject gate so a partner never receives a URL to a file that has gone missing.
import express from 'express';
import { db, persist } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { context } from '../services/assets.js';
import { record } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { TTL, APP_ORIGIN } from '../config.js';
import { uuid, token } from '../util/crypto.js';

export const sharesRouter = express.Router();
export const publicShareRouter = express.Router();

const DURATIONS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 };

const decorate = (s) => ({
  ...s,
  url: `${APP_ORIGIN}/#/s/${s.token}`,
  expired: Date.parse(s.expiresAt) < Date.now(),
  exhausted: s.maxDownloads != null && s.downloadCount >= s.maxDownloads,
  remainingMs: Date.parse(s.expiresAt) - Date.now(),
});

sharesRouter.use(authenticate);

sharesRouter.get('/', requires('share:create'), (req, res) => {
  const rows = db.shares
    .map(decorate)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  res.json({ data: rows, total: rows.length });
});

sharesRouter.post('/', requires('share:create'), (req, res) => {
  const { assetId, expiresIn = '7d', canDownload = true, maxDownloads = null, note = '' } = req.body || {};
  const ctx = context(assetId);
  if (!ctx) return problem(res, 404, 'Not Found', 'No asset with that id.');

  const { availability } = storage.verifyAsset(ctx.asset);
  if (availability.status === 'MISSING') {
    return problem(res, 409, 'Conflict', 'This file is not in storage, so it cannot be shared.');
  }

  const share = {
    _id: uuid(),
    assetId,
    assetName: ctx.asset.displayName,
    songTitle: ctx.song.title,
    artistName: ctx.artist?.name ?? null,
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
  db.shares.unshift(share);
  persist();
  record(req, {
    action: 'SHARE_CREATE', entity: 'share', entityId: share._id,
    label: `Shared ${ctx.asset.displayName} for ${expiresIn}`,
    after: { expiresAt: share.expiresAt, maxDownloads: share.maxDownloads, canDownload: share.canDownload },
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
    label: `Revoked the link to ${share.assetName}`, after: { revokedAt: share.revokedAt },
  });
  res.json(decorate(share));
});

// ── Public resolution — no authentication, all gates enforced (§10.10) ──────
publicShareRouter.get('/:token', (req, res) => {
  const share = db.shares.find((s) => s.token === req.params.token);
  if (!share) return problem(res, 404, 'Not Found', 'This link does not exist.');
  if (share.revokedAt) return problem(res, 410, 'Gone', 'This link has been revoked by its owner.');
  if (Date.parse(share.expiresAt) < Date.now()) return problem(res, 410, 'Gone', 'This link has expired.');
  if (share.maxDownloads != null && share.downloadCount >= share.maxDownloads) {
    return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');
  }

  const ctx = context(share.assetId);
  if (!ctx) return problem(res, 404, 'Not Found', 'The shared file is no longer catalogued.');

  const { availability } = storage.verifyAsset(ctx.asset);
  if (availability.status === 'MISSING') {
    return problem(res, 503, 'Service Unavailable', 'The shared file is temporarily unavailable. The owner has been notified.');
  }

  const ttl = Math.min(TTL.share, Math.max(60, Math.floor((Date.parse(share.expiresAt) - Date.now()) / 1000)));
  const previewUrl = storage.presignGet({
    bucket: ctx.asset.s3.bucket, key: ctx.asset.s3.key,
    expiresIn: ttl, filename: ctx.asset.displayName, inline: true,
  });

  res.json({
    asset: {
      displayName: ctx.asset.displayName, type: ctx.asset.type, family: ctx.asset.family,
      sizeBytes: ctx.asset.s3.sizeBytes, mimeType: ctx.asset.mimeType, version: ctx.asset.version,
      songTitle: ctx.song.title, artistName: ctx.artist?.name ?? null,
    },
    share: {
      canDownload: share.canDownload, expiresAt: share.expiresAt, note: share.note,
      sharedBy: share.createdByName,
      downloadsRemaining: share.maxDownloads == null ? null : share.maxDownloads - share.downloadCount,
    },
    previewUrl,
    availability: availability.status,
  });
});

publicShareRouter.post('/:token/download', (req, res) => {
  const share = db.shares.find((s) => s.token === req.params.token);
  if (!share || share.revokedAt) return problem(res, 410, 'Gone', 'This link is no longer active.');
  if (!share.canDownload) return problem(res, 403, 'Forbidden', 'This link is preview-only.');
  if (Date.parse(share.expiresAt) < Date.now()) return problem(res, 410, 'Gone', 'This link has expired.');
  if (share.maxDownloads != null && share.downloadCount >= share.maxDownloads) {
    return problem(res, 429, 'Too Many Requests', 'This link has reached its download limit.');
  }
  const ctx = context(share.assetId);
  if (!ctx) return problem(res, 404, 'Not Found', 'The shared file is no longer catalogued.');

  share.downloadCount += 1;
  persist();
  record({ ip: req.ip, get: (h) => req.get(h), user: { sub: null, name: 'external partner', role: 'public' } }, {
    action: 'SHARE_ACCESS', entity: 'share', entityId: share._id,
    label: `External download of ${share.assetName}`,
    after: { downloadCount: share.downloadCount },
  });

  const url = storage.presignGet({
    bucket: ctx.asset.s3.bucket, key: ctx.asset.s3.key,
    expiresIn: TTL.download, filename: ctx.asset.displayName,
  });
  res.json({ url, downloadsRemaining: share.maxDownloads == null ? null : share.maxDownloads - share.downloadCount });
});
