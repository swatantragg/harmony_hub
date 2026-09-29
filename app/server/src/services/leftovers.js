import { db, allAssets, persist, flushNow } from '../db.js';
import * as storage from './storage.js';
// Namespace import: the sync imports this module, and its tests mock Drive with
// only the handful of functions the sync itself calls.
import * as drive from '../storage/drive.js';

// ── Why this exists ─────────────────────────────────────────────────────────
// Until SK-V5.1.0 the test harness booted its server with the live app/.env,
// so every `npm test` created real folders in the real Google Drive: "Harness
// folder <Date.now()>" from test/shares.test.mjs, and "Harness tags
// one|two|three <Date.now()>" from test/tags.test.mjs. The scratch database was
// dropped after each run; the Drive folders never were. The live Drive sync
// then adopted every one of them into the library as an ordinary folder — more
// than once where two instances share the database and both sync.
//
// The harness can no longer reach Drive (test/harness.mjs). This finds what it
// left behind and removes it — to the Drive bin, recoverable for the usual
// thirty days, and out of the folder lists here.
//
// It is deliberately narrow. A folder qualifies only when its name is exactly
// what the suite generated, the millisecond stamp in that name falls within a
// day of when the folder was created, and it holds nothing — no file and no
// subfolder, here or in Drive. Anything else is listed and left alone.

const PATTERN = /^Harness (?:folder|tags (?:one|two|three)) (\d{13})$/;
const STAMP_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** The creation stamp the test suite put in a folder name, or null. */
export function harnessStamp(name) {
  const match = PATTERN.exec(String(name ?? '').trim());
  return match ? Number(match[1]) : null;
}

const stampFits = (stamp, createdAt) => {
  const at = Date.parse(createdAt ?? '');
  return Number.isFinite(at) && Math.abs(at - stamp) <= STAMP_TOLERANCE_MS;
};

const holdsFiles = (folder, everyAsset) => everyAsset.some(({ asset }) => asset.folderId === folder._id);
const holdsFolders = (folder) => db.folders.some((f) => !f.deletedAt && f.parentId === folder._id);

/**
 * Whether a library folder is one the test suite left: its exact name, created
 * when that name says, holding nothing here. The Drive side is not checked —
 * callers that act on Drive check it themselves.
 */
export function isTestLeftover(folder, everyAsset = null) {
  if (!folder || folder.deletedAt) return false;
  const stamp = harnessStamp(folder.name);
  if (stamp == null || !stampFits(stamp, folder.createdAt)) return false;
  return !holdsFiles(folder, everyAsset ?? allAssets({ includeDeleted: true })) && !holdsFolders(folder);
}

/**
 * Every folder the test suite left behind, one entry per Drive folder (with
 * every library row that points at it), each carrying the reason it would be
 * skipped — or null when it is safe to remove.
 */
export async function findTestLeftovers() {
  const byKey = new Map();
  const entryFor = (key, stamp) => {
    if (!byKey.has(key)) byKey.set(key, { stamp, folders: [], drive: null });
    return byKey.get(key);
  };

  for (const folder of db.folders) {
    if (folder.deletedAt) continue;
    const stamp = harnessStamp(folder.name);
    if (stamp == null) continue;
    entryFor(folder.driveFolderId || `library:${folder._id}`, stamp).folders.push(folder);
  }

  // Drive is asked directly as well: a folder the sync has not adopted yet is
  // just as much litter, and would be adopted on the next pass.
  const driveChecked = storage.driveReady();
  const driveGone = new Set();
  if (driveChecked) {
    const { files } = await drive.listAll({
      q: `mimeType = '${drive.FOLDER_MIME}' and trashed = false and name contains 'Harness'`,
      fields: 'id,name,createdTime,webViewLink,parents',
    });
    for (const file of files) {
      const stamp = harnessStamp(file.name);
      if (stamp != null) entryFor(file.id, stamp).drive = file;
    }
    // A library row whose Drive folder is already in the bin, or gone, only
    // needs taking out of the lists here.
    for (const [key, entry] of byKey) {
      if (entry.drive || key.startsWith('library:')) continue;
      const file = await storage.statRaw(key).catch((err) => (storage.isNotFound(err) ? null : undefined));
      if (file === null || file?.trashed) driveGone.add(key);
    }
  }

  const everyAsset = allAssets({ includeDeleted: true });
  const data = [];

  for (const [key, { stamp, folders, drive: file }] of byKey) {
    const driveFolderId = key.startsWith('library:') ? null : key;
    const createdAt = file?.createdTime ?? folders[0]?.createdAt ?? null;

    let blocked = null;
    if (!stampFits(stamp, createdAt) || folders.some((f) => !stampFits(stamp, f.createdAt))) {
      blocked = 'Its name matches, but it was not created when that name says — so it was not made by the test suite.';
    } else if (folders.some((f) => holdsFiles(f, everyAsset))) {
      blocked = 'Files are filed in it.';
    } else if (folders.some(holdsFolders)) {
      blocked = 'It has folders inside it.';
    } else if (!driveChecked && driveFolderId) {
      blocked = 'Google Drive is not reachable, so it cannot be checked or moved to the bin.';
    } else if (file) {
      const children = await storage.listFolder(file.id).catch(() => null);
      if (children === null) blocked = 'Google Drive would not list what is inside it.';
      else if (children.length) blocked = `It holds ${children.length} item${children.length === 1 ? '' : 's'} in Google Drive.`;
    } else if (driveFolderId && !driveGone.has(driveFolderId)) {
      blocked = 'Google Drive could not confirm where it is.';
    }

    data.push({
      name: file?.name ?? folders[0].name,
      stamp,
      createdAt,
      driveFolderId,
      folderIds: folders.map((f) => f._id),
      webViewLink: file?.webViewLink ?? folders[0]?.driveWebViewLink ?? null,
      inDrive: Boolean(file),
      inLibrary: folders.length > 0,
      blocked,
    });
  }

  data.sort((a, b) => a.stamp - b.stamp || a.name.localeCompare(b.name));
  return { driveChecked, total: data.length, removable: data.filter((d) => !d.blocked).length, data };
}

/**
 * Removes every leftover `findTestLeftovers` clears. The list is worked out
 * again here rather than taken from the caller, so nothing is removed on the
 * strength of a stale screen.
 */
export async function removeTestLeftovers() {
  const { data } = await findTestLeftovers();
  const now = new Date().toISOString();
  const removed = [];
  const failed = [];

  for (const item of data) {
    if (item.blocked) continue;
    if (item.inDrive) {
      const trashed = await storage.trashFolder(item.driveFolderId)
        .then(() => true)
        .catch((err) => storage.isNotFound(err));
      if (!trashed) { failed.push(item.name); continue; }
    }
    for (const id of item.folderIds) {
      const folder = db.folders.find((f) => f._id === id);
      if (folder && !folder.deletedAt) {
        folder.deletedAt = now;
        folder.updatedAt = now;
      }
    }
    removed.push(item);
  }

  if (removed.length) {
    persist();
    await flushNow();
  }
  return { removed, failed, skipped: data.filter((d) => d.blocked) };
}
