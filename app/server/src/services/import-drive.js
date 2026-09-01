import { db, persist } from '../db.js';
import * as storage from './storage.js';
import { ROOTS } from '../config.js';
import { uuid } from '../util/crypto.js';
import { allTypes, resolveFamily } from './vocabulary.js';
import { FOLDER_MIME } from '../storage/drive.js';

// Whole-drive mode makes the account reachable; it does not make it visible. The
// UI lists what Mongo knows, so anything already sitting in Drive stays invisible
// until it has a catalogue row. This walks the drive and writes those rows.

const PREFERRED = {
  Audio: 'Master Audio',
  Video: 'Horizontal Video',
  Image: 'Banner Image',
  Document: 'Credits / Metadata Sheet',
};

function familyFromMime(mimeType = '') {
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('image/')) return 'Image';
  return 'Document';
}

// Custom types are editable, so the landing type is resolved against the live
// vocabulary rather than hardcoded — a renamed type must not break the import.
function typeForFamily(family, types) {
  const preferred = types.find((t) => t.type === PREFERRED[family]);
  return (preferred || types.find((t) => t.family === family) || types[0]).type;
}

export async function importDrive({ dryRun = false, userId = 'system' } = {}) {
  const { files, folders } = await storage.inventory({ includeTrashed: false });

  // Quarantine holds files the scanner refused. Importing them would undo that.
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

  const now = new Date().toISOString();
  const types = allTypes();
  const byDriveId = new Map(
    db.folders.filter((f) => !f.deletedAt && f.driveFolderId).map((f) => [f.driveFolderId, f._id]),
  );
  const created = { folders: [], assets: [] };

  for (const drive of folders) {
    if (quarantined.has(drive.id) || byDriveId.has(drive.id)) continue;
    const folder = {
      _id: `folder_${uuid().slice(0, 8)}`,
      name: drive.name,
      description: 'Imported from Google Drive.',
      tags: ['Imported'],
      parentId: null, // resolved below, once every id exists
      driveFolderId: drive.id,
      driveWebViewLink: drive.webViewLink ?? null,
      songId: null,
      artistId: null,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    byDriveId.set(drive.id, folder._id);
    created.folders.push({ folder, driveParentId: drive.parents?.[0] ?? null });
  }

  // A child can be walked before its parent, so parents are linked in a second pass.
  for (const { folder, driveParentId } of created.folders) {
    folder.parentId = driveParentId && driveParentId !== ROOTS.assets
      ? byDriveId.get(driveParentId) ?? null
      : null;
  }

  const tracked = new Set();
  for (const song of db.songs) for (const a of song.assets || []) if (a.drive?.fileId) tracked.add(a.drive.fileId);
  for (const a of db.unfiled) if (a.drive?.fileId) tracked.add(a.drive.fileId);

  const skipped = { tracked: 0, quarantined: 0, blocked: 0 };

  for (const file of files) {
    if (file.mimeType === FOLDER_MIME) continue;
    if (tracked.has(file.id)) { skipped.tracked += 1; continue; }
    if (quarantined.has(file.parents?.[0])) { skipped.quarantined += 1; continue; }
    if (storage.isBlockedType(file.mimeType) || storage.isBlockedExtension(file.name)) {
      skipped.blocked += 1;
      continue;
    }

    const parentDriveId = file.parents?.[0] ?? null;
    const folderId = parentDriveId && parentDriveId !== ROOTS.assets
      ? byDriveId.get(parentDriveId) ?? null
      : null;
    const folderName = created.folders.find((c) => c.folder._id === folderId)?.folder.name
      ?? db.folders.find((f) => f._id === folderId)?.name
      ?? null;

    const type = typeForFamily(familyFromMime(file.mimeType), types);
    const assetId = file.appProperties?.assetId || uuid();
    const bound = storage.binding(file, { path: `${folderName ? `${folderName}/` : ''}${file.name}` });

    created.assets.push({
      assetId,
      displayName: file.name,
      originalName: file.name,
      description: 'Imported from Google Drive.',
      type,
      family: resolveFamily(type),
      format: '',
      folderId,
      drive: bound,
      availability: {
        status: 'AVAILABLE', lastCheckedAt: now, lastVerifiedAt: now,
        checkMethod: 'FILES_GET', detail: null,
      },
      lastHead: null,
      versionGroupId: `vg_${assetId.slice(0, 8)}`,
      version: 'V1',
      isCurrent: true,
      supersedes: null,
      mimeType: bound.mimeType,
      durationSec: bound.durationSec,
      dimensions: bound.dimensions,
      tags: ['Imported'],
      checksumSHA256: bound.sha256,
      uploadedBy: userId,
      createdAt: now,
      updatedAt: now,
      renamedAt: null,
      deletedAt: null,
      relocateStatus: null,
    });
  }

  const summary = {
    dryRun,
    scanned: { folders: folders.length, files: files.length },
    imported: { folders: created.folders.length, assets: created.assets.length },
    skipped,
  };

  if (dryRun) return summary;

  for (const { folder } of created.folders) db.folders.unshift(folder);
  for (const asset of created.assets) db.unfiled.push(asset);
  persist();
  return summary;
}
