// The search-first home screen's data, in one round trip.
import express from 'express';
import { db, allAssets, live } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { shape } from '../services/assets.js';
import { healthSummary } from '../services/reconcile.js';
import { scan } from '../services/dedupe.js';
import * as storage from '../services/storage.js';
import { can } from '../catalogue.js';

export const dashboardRouter = express.Router();
dashboardRouter.use(authenticate);

// How many of the most recently added files Home shows before "See all" takes over.
const RECENT_ON_HOME = 5;

dashboardRouter.get('/', async (req, res) => {
  const rows = allAssets();
  const health = healthSummary();

  // Quota is the number that decides whether anybody can upload tomorrow, so it belongs on
  // the home screen rather than buried in an admin page. Never allowed to fail the request:
  // a dashboard that 502s because Google hiccuped is worse than one missing a tile.
  const quota = await storage.quota().catch(() => null);

  // The exact-duplicate tier is pure computation over checksums the catalogue already
  // holds, so surfacing "you are storing 14 GB twice" costs nothing.
  const duplicates = scan({ level: 'exact' });

  // Home shows five and a way to see the rest, so five is what it is sent.
  const recent = [...rows]
    .sort((a, b) => Date.parse(b.asset.createdAt) - Date.parse(a.asset.createdAt))
    .slice(0, RECENT_ON_HOME)
    .map(shape);

  // Home no longer lists these — it states how many there are and sends the reader to
  // Storage health, where each one can actually be resolved. So the count is the whole
  // payload, and it is the true count rather than the length of a truncated page.
  const needsReview = rows.filter(
    ({ asset }) => ['MISSING', 'MISMATCH'].includes(asset.availability?.status),
  ).length;

  const stale = rows.filter(({ asset }) => (asset.availability?.status ?? 'UNVERIFIED') === 'UNVERIFIED').length;

  const activeShares = db.shares.filter((s) => !s.revokedAt && Date.parse(s.expiresAt) > Date.now()).length;

  const trendingTags = [...db.tags]
    .filter((t) => t.usageCount > 0)
    .sort((a, b) => b.usageCount - a.usageCount)
    .slice(0, 10);

  // A roster, not a leaderboard: a name and how many files sit behind it. Ordered by name
  // so a given artist is always in the same place on the list rather than moving every
  // time somebody uploads.
  const artists = live(db.artists)
    .map((artist) => {
      const songs = live(db.songs).filter((s) => s.artistId === artist._id);
      const assets = songs.flatMap((s) => s.assets.filter((a) => !a.deletedAt));
      return {
        _id: artist._id, name: artist.name, genre: artist.genre,
        imageAssetId: artist.imageAssetId,
        songCount: songs.length, assetCount: assets.length,
        totalBytes: assets.reduce((n, a) => n + (a.drive?.sizeBytes || 0), 0),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    greetingName: req.user.name.split(' ')[0],
    role: req.user.role,
    health,
    quota,
    duplicates: {
      groups: duplicates.totals.groups,
      files: duplicates.totals.files,
      reclaimableBytes: duplicates.totals.certainReclaimableBytes,
      crossFolderGroups: duplicates.totals.crossFolderGroups,
    },
    counts: {
      artists: live(db.artists).length,
      songs: live(db.songs).length,
      assets: rows.length,
      staleVerification: stale,
      activeShares,
      folders: db.folders.filter((f) => !f.deletedAt).length,
      unfiled: db.unfiled.filter((a) => !a.deletedAt).length,
      openFindings: health.openFindings,
      duplicateGroups: duplicates.totals.groups,
      needsReview,
    },
    recent,
    trendingTags,
    artists,
    canUpload: can(req.user.role, 'asset:upload'),
    canSeeStorage: can(req.user.role, 'admin:storage'),
    activity: db.activityLog.slice(0, 6),
  });
});
