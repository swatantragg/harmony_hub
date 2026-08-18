// Folders — real Google Drive folders, mirrored by a catalogue row.
//
// A GCloud folder *is* a Drive folder: open drive.google.com and the library is laid
// out exactly as the app shows it, which is what makes the storage legible to someone who
// never signs in here. The catalogue row carries what Drive has nowhere to put — the
// description, the tags, the song and artist association.
//
// Drive reparents and renames by updating an index entry, never by copying bytes, and two
// properties follow from that:
//
//   · Moving a file between folders touches no bytes, however large the file is.
//   · Renaming a folder breaks nothing — every file keeps its id, and every share link
//     keeps resolving.
//
// Folders nest. A folder may carry a parentId, and the tree in the catalogue is the tree
// in Drive.
import express from 'express';
import { db, persist, assetsInFolder, assetContext } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { shape } from '../services/assets.js';
import { record } from '../services/audit.js';
import * as storage from '../services/storage.js';
import { ROOTS } from '../config.js';
import { uuid } from '../util/crypto.js';
import { LIMITS, fields, list, str } from '../util/validate.js';

export const foldersRouter = express.Router();
foldersRouter.use(authenticate);

const stats = (folder) => {
  const rows = assetsInFolder(folder._id);
  const byFamily = {};
  let bytes = 0;
  const statuses = {};
  for (const { asset } of rows) {
    byFamily[asset.family] = (byFamily[asset.family] || 0) + 1;
    bytes += asset.drive?.sizeBytes ?? 0;
    const s = asset.availability?.status ?? 'UNVERIFIED';
    statuses[s] = (statuses[s] || 0) + 1;
  }
  return {
    assetCount: rows.length,
    totalBytes: bytes,
    byFamily,
    byStatus: statuses,
    needsAttention: (statuses.MISSING ?? 0) + (statuses.MISMATCH ?? 0) + (statuses.TRASHED ?? 0),
  };
};

const childrenOf = (folderId) => db.folders.filter((f) => !f.deletedAt && f.parentId === folderId);

const decorate = (folder) => {
  const song = folder.songId ? db.songs.find((s) => s._id === folder.songId) : null;
  const artist = folder.artistId
    ? db.artists.find((a) => a._id === folder.artistId)
    : song
      ? db.artists.find((a) => a._id === song.artistId)
      : null;
  const parent = folder.parentId ? db.folders.find((f) => f._id === folder.parentId) : null;
  return {
    ...folder,
    songTitle: song?.title ?? null,
    artistName: artist?.name ?? null,
    parentName: parent?.name ?? null,
    subfolderCount: childrenOf(folder._id).length,
    createdByName: db.users.find((u) => u._id === folder.createdBy)?.name ?? 'Unknown',
    ...stats(folder),
  };
};

// Walks up the catalogue tree. Used both for the breadcrumb and to stop a folder being
// dragged inside one of its own descendants, which Drive would reject as a cycle.
function ancestry(folderId) {
  const chain = [];
  let cursor = folderId;
  const guard = new Set();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    const folder = db.folders.find((f) => f._id === cursor);
    if (!folder) break;
    chain.unshift({ _id: folder._id, name: folder.name });
    cursor = folder.parentId;
  }
  return chain;
}

const isDescendant = (candidateId, ofFolderId) => {
  let cursor = candidateId;
  const guard = new Set();
  while (cursor && !guard.has(cursor)) {
    if (cursor === ofFolderId) return true;
    guard.add(cursor);
    cursor = db.folders.find((f) => f._id === cursor)?.parentId ?? null;
  }
  return false;
};

foldersRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const tags = String(req.query.tags || '').split(',').filter(Boolean);
  const parentId = req.query.parentId === 'root' ? null : req.query.parentId;

  const rows = db.folders
    .filter((f) => !f.deletedAt)
    .filter((f) => (parentId === undefined ? true : (f.parentId ?? null) === (parentId ?? null)))
    .filter((f) => !q || `${f.name} ${f.description} ${f.tags.join(' ')}`.toLowerCase().includes(q))
    .filter((f) => tags.length === 0 || tags.every((t) => f.tags.includes(t)))
    .map(decorate)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  res.json({ data: rows, total: rows.length });
});

foldersRouter.get('/:id', (req, res) => {
  const folder = db.folders.find((f) => f._id === req.params.id && !f.deletedAt);
  if (!folder) return problem(res, 404, 'Not Found', 'No folder with that id.');
  const assets = assetsInFolder(folder._id).map(shape);
  const byFamily = {};
  for (const a of assets) (byFamily[a.family] ??= []).push(a);
  res.json({
    ...decorate(folder),
    breadcrumb: ancestry(folder._id),
    subfolders: childrenOf(folder._id).map(decorate),
    assets,
    assetsByFamily: byFamily,
  });
});

foldersRouter.post('/', requires('asset:upload'), async (req, res) => {
  // A catalogue folder is backed by a real Drive folder, so it cannot be created while
  // Google is unreachable — and a catalogue row with no folder behind it is exactly the
  // drift reconciliation exists to clean up.
  if (!storage.driveReady()) {
    const status = storage.driveStatus();
    return problem(
      res, 503, 'Service Unavailable',
      `Google Drive is not reachable, so a folder cannot be created right now. (${status.error ?? 'no detail'})`,
      { degraded: true },
    );
  }

  const check = fields(req.body || {}, {
    name: (v) => str(v, { max: LIMITS.name, field: 'name', required: true }),
    description: (v) => str(v, { max: LIMITS.description, field: 'description', allowEmpty: true }),
    tags: (v) => list(v, { max: LIMITS.tags, itemMax: LIMITS.tag, field: 'tags' }),
    parentId: (v) => str(v, { max: 80, field: 'parentId' }),
    songId: (v) => str(v, { max: 80, field: 'songId' }),
    artistId: (v) => str(v, { max: 80, field: 'artistId' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);

  const name = check.value.name;
  if (/[/\\]/.test(name)) return problem(res, 422, 'Unprocessable Entity', 'Folder names cannot contain / or \\.');

  const parentId = check.value.parentId || null;
  const parent = parentId ? db.folders.find((f) => f._id === parentId && !f.deletedAt) : null;
  if (parentId && !parent) return problem(res, 404, 'Not Found', 'The parent folder no longer exists.');

  // Drive is perfectly happy with two folders of the same name in the same place, which is
  // a well-known way to lose files. GCloud is not.
  const clash = db.folders.find((f) =>
    !f.deletedAt && (f.parentId ?? null) === parentId && f.name.toLowerCase() === name.toLowerCase());
  if (clash && !req.body?.allowDuplicateName) {
    return problem(res, 409, 'Conflict', `A folder called “${clash.name}” already exists here. Open it, or pick a different name.`);
  }

  let driveFolder;
  try {
    driveFolder = await storage.makeFolder({ name, parentId: parent?.driveFolderId || ROOTS.assets });
  } catch (err) {
    return problem(res, 502, 'Bad Gateway', `Google Drive would not create the folder: ${err.message}`);
  }

  const now = new Date().toISOString();
  const folder = {
    _id: `folder_${uuid().slice(0, 8)}`,
    name,
    description: check.value.description || '',
    tags: check.value.tags || [],
    parentId,
    // The link between the two worlds. Everything else about a folder is presentation.
    driveFolderId: driveFolder.fileId,
    driveWebViewLink: driveFolder.webViewLink ?? null,
    songId: check.value.songId || null,
    artistId: check.value.artistId || null,
    createdBy: req.user.sub,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  db.folders.unshift(folder);
  persist();
  record(req, {
    action: 'FOLDER_CREATE', entity: 'folder', entityId: folder._id,
    label: `Created folder “${folder.name}”`,
    after: { name: folder.name, tags: folder.tags, driveFolderId: folder.driveFolderId },
    meta: { parent: parent?.name ?? 'Assets root' },
  });
  res.status(201).json(decorate(folder));
});

// Renaming or re-tagging a folder renames the Drive folder too — one PATCH, no bytes
// copied, and every file inside keeps its id and every share link keeps working.
foldersRouter.patch('/:id', requires('asset:edit'), async (req, res) => {
  const folder = db.folders.find((f) => f._id === req.params.id && !f.deletedAt);
  if (!folder) return problem(res, 404, 'Not Found', 'No folder with that id.');

  const check = fields(req.body || {}, {
    name: (v) => str(v, { max: LIMITS.name, field: 'name' }),
    description: (v) => str(v, { max: LIMITS.description, field: 'description', allowEmpty: true }),
    tags: (v) => list(v, { max: LIMITS.tags, itemMax: LIMITS.tag, field: 'tags' }),
    parentId: (v) => str(v, { max: 80, field: 'parentId' }),
    songId: (v) => str(v, { max: 80, field: 'songId' }),
    artistId: (v) => str(v, { max: 80, field: 'artistId' }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  if ('name' in check.value && !check.value.name) {
    return problem(res, 422, 'Unprocessable Entity', 'A folder needs a name.');
  }
  if (check.value.name && /[/\\]/.test(check.value.name)) {
    return problem(res, 422, 'Unprocessable Entity', 'Folder names cannot contain / or \\.');
  }

  const before = { name: folder.name, tags: [...folder.tags], description: folder.description, parentId: folder.parentId };

  let renamedInDrive = null;
  let movedInDrive = null;

  if (check.value.name && check.value.name !== folder.name && folder.driveFolderId) {
    renamedInDrive = await storage.renameFolder(folder.driveFolderId, check.value.name).then(() => true).catch(() => false);
  }

  // Re-parenting a folder. Refused when the destination sits inside the folder being
  // moved, because that is a cycle and Drive would reject it with a much worse message.
  if ('parentId' in (req.body || {}) && (check.value.parentId ?? null) !== (folder.parentId ?? null)) {
    const nextParentId = check.value.parentId || null;
    if (nextParentId && isDescendant(nextParentId, folder._id)) {
      return problem(res, 422, 'Unprocessable Entity', 'A folder cannot be moved inside itself.');
    }
    const nextParent = nextParentId ? db.folders.find((f) => f._id === nextParentId && !f.deletedAt) : null;
    if (nextParentId && !nextParent) return problem(res, 404, 'Not Found', 'The destination folder no longer exists.');
    const currentParent = folder.parentId ? db.folders.find((f) => f._id === folder.parentId) : null;
    if (folder.driveFolderId) {
      movedInDrive = await storage
        .move(folder.driveFolderId, {
          toParentId: nextParent?.driveFolderId || ROOTS.assets,
          fromParentId: currentParent?.driveFolderId || ROOTS.assets,
        })
        .then(() => true)
        .catch(() => false);
    }
  }

  for (const field of ['name', 'description', 'tags', 'songId', 'artistId', 'parentId']) {
    if (field in (req.body || {})) folder[field] = check.value[field] ?? null;
  }
  folder.updatedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'FOLDER_UPDATE', entity: 'folder', entityId: folder._id,
    label: `Updated folder “${folder.name}”`, before, after: check.value,
    meta: { bytesMoved: 0, renamedInDrive, movedInDrive },
  });
  res.json(decorate(folder));
});

// Deleting a folder never deletes files. Every file is moved back to the Assets root in
// Drive first, and only the emptied folder is trashed — because losing a grouping should
// never risk losing a master.
foldersRouter.delete('/:id', requires('asset:delete'), async (req, res) => {
  const folder = db.folders.find((f) => f._id === req.params.id && !f.deletedAt);
  if (!folder) return problem(res, 404, 'Not Found', 'No folder with that id.');

  const subfolders = childrenOf(folder._id);
  if (subfolders.length && !req.body?.cascade) {
    return problem(res, 409, 'Conflict',
      `“${folder.name}” still holds ${subfolders.length} subfolder${subfolders.length === 1 ? '' : 's'}. Move or delete those first.`);
  }

  const released = assetsInFolder(folder._id);
  let relocated = 0;
  for (const { asset } of released) {
    if (asset.drive?.fileId && folder.driveFolderId) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await storage
        .move(asset.drive.fileId, { toParentId: ROOTS.assets, fromParentId: folder.driveFolderId })
        .then((d) => { asset.drive = { ...asset.drive, ...d }; return true; })
        .catch(() => false);
      if (ok) relocated += 1;
    }
    asset.folderId = null;
    asset.drive.path = asset.displayName;
    asset.updatedAt = new Date().toISOString();
  }

  const trashedInDrive = folder.driveFolderId
    ? await storage.trashFolder(folder.driveFolderId).then(() => true).catch(() => false)
    : false;

  folder.deletedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'FOLDER_DELETE', entity: 'folder', entityId: folder._id,
    label: `Deleted folder “${folder.name}”`,
    meta: { filesReleased: released.length, filesRelocatedInDrive: relocated, filesDeleted: 0, trashedInDrive },
  });
  res.json({ ok: true, filesReleased: released.length, filesRelocatedInDrive: relocated });
});

// Move files in or out. `folderId: 'none'` returns them to the Assets root. Every move is
// a Drive reparent, so this is the endpoint behind drag-and-drop in the UI.
foldersRouter.post('/:id/assets', requires('asset:edit'), async (req, res) => {
  const target = req.params.id === 'none' ? null : db.folders.find((f) => f._id === req.params.id && !f.deletedAt);
  if (req.params.id !== 'none' && !target) return problem(res, 404, 'Not Found', 'No folder with that id.');

  const destination = target?.driveFolderId || ROOTS.assets;
  // Bounded: this loop issues one Drive call per id, so an unbounded list is both a
  // request that never ends and a way to exhaust the shared Drive quota.
  const idCheck = list(req.body?.assetIds, { max: LIMITS.ids, itemMax: 80, field: 'assetIds' });
  if (idCheck.problem) return problem(res, 422, 'Unprocessable Entity', idCheck.problem);
  const ids = idCheck.value ?? [];

  let moved = 0;
  const failed = [];
  for (const id of ids) {
    const ctx = assetContext(id);
    if (!ctx) continue;
    const source = ctx.asset.drive?.parentId ?? null;
    if (ctx.asset.drive?.fileId && source !== destination) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await storage
        .move(ctx.asset.drive.fileId, { toParentId: destination, fromParentId: source })
        .then((d) => { ctx.asset.drive = { ...ctx.asset.drive, ...d }; return true; })
        .catch(() => false);
      if (!ok) { failed.push({ assetId: id, displayName: ctx.asset.displayName }); continue; }
    }
    ctx.asset.folderId = target ? target._id : null;
    ctx.asset.drive.path = `${target?.name ? `${target.name}/` : ''}${ctx.asset.displayName}`;
    ctx.asset.updatedAt = new Date().toISOString();
    moved += 1;
  }
  if (target) target.updatedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'FOLDER_MOVE', entity: 'folder', entityId: target?._id ?? 'none',
    label: target
      ? `Moved ${moved} file${moved === 1 ? '' : 's'} into “${target.name}”`
      : `Moved ${moved} file${moved === 1 ? '' : 's'} back to the library root`,
    after: { assetIds: ids },
    meta: { bytesMoved: 0, driveParent: destination, failed: failed.length },
  });
  res.json({ ok: failed.length === 0, moved, failed });
});

// Used by the picker on the upload screen and the asset drawer. Indented by depth so a
// nested tree reads correctly in a flat <select>.
foldersRouter.get('/lookup/options', (_req, res) => {
  const depthOf = (folder) => ancestry(folder._id).length - 1;
  res.json(
    db.folders
      .filter((f) => !f.deletedAt)
      .map((f) => ({
        _id: f._id,
        name: f.name,
        path: ancestry(f._id).map((a) => a.name).join(' / '),
        depth: depthOf(f),
        assetCount: assetsInFolder(f._id).length,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
});

// The whole tree in one call, for the folder sidebar.
foldersRouter.get('/lookup/tree', (_req, res) => {
  const build = (parentId) =>
    db.folders
      .filter((f) => !f.deletedAt && (f.parentId ?? null) === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((f) => ({
        _id: f._id,
        name: f.name,
        assetCount: assetsInFolder(f._id).length,
        driveWebViewLink: f.driveWebViewLink ?? null,
        children: build(f._id),
      }));
  res.json({ root: { name: 'Library', children: build(null) } });
});
