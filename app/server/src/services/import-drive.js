import { syncDrive } from './sync.js';
import * as storage from './storage.js';
import { ROOTS } from '../config.js';
import { FOLDER_MIME } from '../storage/drive.js';
import { db } from '../db.js';

// The one-shot "import what is already in Drive" pass used to live here. It is
// now a special case of the continuous mirror in services/sync.js — running the
// same walk twice would only race it — so this stays as the admin/CLI entry
// point and the dry run, and delegates the real work.

export async function importDrive({ dryRun = false, userId = 'system' } = {}) {
  if (!dryRun) return syncDrive({ userId, trigger: 'import', mode: 'full' });

  const { files, folders } = await storage.inventory({ includeTrashed: false });

  const quarantined = new Set();
  if (ROOTS.quarantine) {
    quarantined.add(ROOTS.quarantine);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (!quarantined.has(f.id) && quarantined.has(f.parents?.[0])) {
          quarantined.add(f.id);
          grew = true;
        }
      }
    }
  }

  const knownFolders = new Set(
    db.folders.filter((f) => !f.deletedAt && f.driveFolderId).map((f) => f.driveFolderId),
  );
  const tracked = new Set();
  for (const song of db.songs) for (const a of song.assets || []) if (a.drive?.fileId) tracked.add(a.drive.fileId);
  for (const a of db.unfiled) if (a.drive?.fileId) tracked.add(a.drive.fileId);

  const skipped = { tracked: 0, quarantined: 0, blocked: 0 };
  let newFolders = 0;
  let newAssets = 0;

  for (const folder of folders) {
    if (quarantined.has(folder.id) || knownFolders.has(folder.id)) continue;
    newFolders += 1;
  }

  for (const file of files) {
    if (file.mimeType === FOLDER_MIME) continue;
    if (tracked.has(file.id)) { skipped.tracked += 1; continue; }
    if (quarantined.has(file.parents?.[0])) { skipped.quarantined += 1; continue; }
    if (storage.isBlockedType(file.mimeType) || storage.isBlockedExtension(file.name)) {
      skipped.blocked += 1;
      continue;
    }
    newAssets += 1;
  }

  return {
    dryRun: true,
    scanned: { folders: folders.length, files: files.length },
    imported: { folders: newFolders, assets: newAssets },
    skipped,
  };
}
