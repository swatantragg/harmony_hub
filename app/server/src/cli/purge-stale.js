import { connect, disconnect } from '../db/mongo.js';
import { load, flushNow, persist, db } from '../db.js';
import * as storage from '../services/storage.js';

// A drive switch leaves the catalogue describing an account that is no longer
// connected: assets whose file ids resolve nowhere, folders whose Drive folder is
// gone, and songs that are left holding nothing. Marking them lost keeps them
// visible on purpose; this removes them once that is no longer wanted.
//
// Destructive, so it plans by default and only writes with --apply. The plan is
// computed first and in full, so what it prints is exactly what --apply does.

const has = (flag) => process.argv.includes(flag);

async function main() {
  const apply = has('--apply');
  const keepSongs = has('--keep-empty-songs');
  const keepRuns = has('--keep-runs');

  await connect();
  await load();
  await storage.ensureRoots();

  const inv = await storage.inventory({ includeTrashed: true });
  const liveFiles = new Set(inv.files.map((f) => f.id));
  const liveFolders = new Set(inv.folders.map((f) => f.id));

  const dead = (asset) => asset.drive?.fileId && !liveFiles.has(asset.drive.fileId);

  // ── plan ────────────────────────────────────────────────────────────────────
  const deadAssets = [];
  const songKeeps = new Map();

  for (const song of db.songs) {
    const keep = (song.assets || []).filter((a) => !dead(a));
    songKeeps.set(song._id, keep);
    for (const a of song.assets || []) if (dead(a)) deadAssets.push(a.displayName);
  }

  const unfiledKeep = db.unfiled.filter((a) => !dead(a));
  for (const a of db.unfiled) if (dead(a)) deadAssets.push(a.displayName);

  // A song stripped of every asset is a title with nothing behind it. Kept only
  // when asked, because the metadata may still be worth re-uploading against.
  const emptiedSongs = keepSongs
    ? []
    : db.songs.filter((s) => !songKeeps.get(s._id).length);
  const droppedSongIds = new Set(emptiedSongs.map((s) => s._id));
  const survivingSongs = db.songs.filter((s) => !droppedSongIds.has(s._id));

  // Only folders that were bound to Drive and lost their binding. A catalogue-only
  // folder has no driveFolderId and is left alone.
  const orphanFolders = db.folders.filter(
    (f) => !f.deletedAt && f.driveFolderId && !liveFolders.has(f.driveFolderId),
  );
  const droppedFolderIds = new Set(orphanFolders.map((f) => f._id));

  const artistsInUse = new Set(survivingSongs.map((s) => s.artistId).filter(Boolean));
  const strayArtists = db.artists.filter((a) => !artistsInUse.has(a._id));

  const report = {
    apply,
    drive: { files: inv.files.length, folders: inv.folders.length },
    removed: {
      assets: deadAssets.length,
      songs: emptiedSongs.map((s) => s.title),
      artists: strayArtists.map((a) => a.name),
      folders: orphanFolders.map((f) => f.name),
      // Past runs carry the findings the dashboard counts. Leaving them keeps the
      // health page reporting problems that no longer have anything to point at.
      reconciliationRuns: keepRuns ? 0 : db.reconciliationRuns.length,
    },
    remaining: {
      songs: survivingSongs.length,
      unfiled: unfiledKeep.length,
      folders: db.folders.length - droppedFolderIds.size,
      artists: db.artists.length - strayArtists.length,
      users: db.users.length,
    },
  };

  // ── apply ───────────────────────────────────────────────────────────────────
  if (apply) {
    for (const song of db.songs) song.assets = songKeeps.get(song._id);
    db.unfiled = unfiledKeep;
    db.songs = survivingSongs;
    db.folders = db.folders.filter((f) => !droppedFolderIds.has(f._id));
    for (const f of db.folders) if (droppedFolderIds.has(f.parentId)) f.parentId = null;
    const strayIds = new Set(strayArtists.map((a) => a._id));
    db.artists = db.artists.filter((a) => !strayIds.has(a._id));
    if (!keepRuns) db.reconciliationRuns = [];
    persist();
    await flushNow();
  }

  console.log(JSON.stringify(report, null, 2));

  await disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Purge failed:', err);
  process.exit(1);
});
