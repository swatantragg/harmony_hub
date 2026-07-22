// Document store. Stands in for MongoDB 7 — same collection names and same document
// shapes as §7, so swapping in Mongoose is a repository-layer change only.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';

const EMPTY = {
  // Bumped by every seed; see save().
  _generation: null,
  users: [],
  artists: [],
  songs: [],
  // Assets uploaded without a song. Amazon S3 has no notion of either a song or a
  // folder — this is purely an application-layer home for files that are not part of a
  // release, so "which song?" can stay an optional question at upload.
  unfiled: [],
  // Folders are a catalogue construct only. Every asset still lands in storage as an
  // individual object under its own UUID key; membership lives here as folderId.
  folders: [],
  // Asset types the team added beyond the built-in catalogue.
  customTypes: [],
  tags: [],
  shares: [],
  restoreRequests: [],
  reconciliationRuns: [],
  activityLog: [],
  notifications: [],
};

export const db = { ...EMPTY };

let flushTimer = null;

// Every seed stamps the store. A process only ever writes back over the generation it
// loaded — otherwise a server left running from an earlier session would silently
// overwrite a freshly seeded library with its stale in-memory copy, and the catalogue
// would end up describing objects that no longer exist in storage.
function diskGeneration() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.db, 'utf8'))._generation ?? null;
  } catch {
    return null;
  }
}

export function load() {
  fs.mkdirSync(PATHS.data, { recursive: true });
  if (fs.existsSync(PATHS.db)) {
    Object.assign(db, EMPTY, JSON.parse(fs.readFileSync(PATHS.db, 'utf8')));
    return true;
  }
  return false;
}

export function save({ force = false } = {}) {
  fs.mkdirSync(PATHS.data, { recursive: true });
  const onDisk = diskGeneration();

  if (!force && onDisk && db._generation && onDisk !== db._generation) {
    console.warn(
      `[db] refusing to write: the data directory was re-seeded by another process ` +
      `(${db._generation} → ${onDisk}). Restart this server to pick up the new library.`,
    );
    return false;
  }
  fs.writeFileSync(PATHS.db, JSON.stringify(db, null, 2));
  return true;
}

// Write-through with a short debounce; every mutating route calls this.
export function persist() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(save, 150);
}

export function reset() {
  Object.assign(db, structuredClone(EMPTY));
  fs.rmSync(PATHS.db, { force: true });
  fs.rmSync(PATHS.s3, { recursive: true, force: true });
}

// ── Query helpers ───────────────────────────────────────────────────────────

export const live = (rows) => rows.filter((r) => !r.deletedAt);

export const folderOf = (asset) =>
  (asset.folderId ? db.folders.find((f) => f._id === asset.folderId && !f.deletedAt) : null) ?? null;

// Locates an asset and, crucially, the array it lives in — a song's embedded assets[] or
// the unfiled list. Every mutation path goes through this so neither container is a
// special case downstream.
export function assetContext(assetId) {
  for (const song of db.songs) {
    const asset = song.assets.find((a) => a.assetId === assetId);
    if (asset) {
      return {
        asset,
        list: song.assets,
        song,
        artist: db.artists.find((a) => a._id === song.artistId) ?? null,
        folder: folderOf(asset),
      };
    }
  }
  const asset = db.unfiled.find((a) => a.assetId === assetId);
  if (asset) return { asset, list: db.unfiled, song: null, artist: null, folder: folderOf(asset) };
  return null;
}

// Every asset in the library, each carrying whatever context it has — song and artist
// when it belongs to a release, folder when it belongs to one, neither when it is a
// loose file. This is the $unwind stage of the search aggregation (§10.6).
export function allAssets({ includeDeleted = false } = {}) {
  const out = [];
  for (const song of db.songs) {
    if (song.deletedAt && !includeDeleted) continue;
    const artist = db.artists.find((a) => a._id === song.artistId) ?? null;
    for (const asset of song.assets) {
      if (asset.deletedAt && !includeDeleted) continue;
      out.push({ asset, song, artist, folder: folderOf(asset) });
    }
  }
  for (const asset of db.unfiled) {
    if (asset.deletedAt && !includeDeleted) continue;
    out.push({ asset, song: null, artist: null, folder: folderOf(asset) });
  }
  return out;
}

export const assetsInFolder = (folderId) =>
  allAssets().filter(({ asset }) => asset.folderId === folderId);

export const dataPath = () => path.relative(process.cwd(), PATHS.db);
