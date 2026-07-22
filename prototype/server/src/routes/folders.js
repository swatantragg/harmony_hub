// Folders — a catalogue-layer grouping over a flat object store.
//
// Amazon S3 has no folders. Every asset here still lands as its own object under
// assets/{uuid}/original.ext, exactly as before; a folder is a document in MongoDB and
// membership is a single `folderId` field on the asset. That means moving a file between
// folders touches no bytes, renaming a folder touches no keys, and deleting a folder can
// never orphan storage — the same reasoning that makes rename safe (§6.2).
import express from 'express';
import { db, persist, allAssets, assetsInFolder, assetContext } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { shape } from '../services/assets.js';
import { record } from '../services/audit.js';
import { uuid } from '../util/crypto.js';

export const foldersRouter = express.Router();
foldersRouter.use(authenticate);

const stats = (folder) => {
  const rows = assetsInFolder(folder._id);
  const byFamily = {};
  let bytes = 0;
  const statuses = {};
  for (const { asset } of rows) {
    byFamily[asset.family] = (byFamily[asset.family] || 0) + 1;
    bytes += asset.s3?.sizeBytes ?? 0;
    const s = asset.availability?.status ?? 'UNVERIFIED';
    statuses[s] = (statuses[s] || 0) + 1;
  }
  return {
    assetCount: rows.length,
    totalBytes: bytes,
    byFamily,
    byStatus: statuses,
    needsAttention: (statuses.MISSING ?? 0) + (statuses.MISMATCH ?? 0),
  };
};

const decorate = (folder) => {
  const song = folder.songId ? db.songs.find((s) => s._id === folder.songId) : null;
  const artist = folder.artistId
    ? db.artists.find((a) => a._id === folder.artistId)
    : song
      ? db.artists.find((a) => a._id === song.artistId)
      : null;
  return {
    ...folder,
    songTitle: song?.title ?? null,
    artistName: artist?.name ?? null,
    createdByName: db.users.find((u) => u._id === folder.createdBy)?.name ?? 'Unknown',
    ...stats(folder),
  };
};

foldersRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const tags = String(req.query.tags || '').split(',').filter(Boolean);
  const rows = db.folders
    .filter((f) => !f.deletedAt)
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
  res.json({ ...decorate(folder), assets, assetsByFamily: byFamily });
});

foldersRouter.post('/', requires('asset:upload'), (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return problem(res, 422, 'Unprocessable Entity', 'A folder needs a name.');
  if (/[/\\]/.test(name)) return problem(res, 422, 'Unprocessable Entity', 'Folder names cannot contain / or \\.');

  const clash = db.folders.find((f) => !f.deletedAt && f.name.toLowerCase() === name.toLowerCase());
  if (clash && !req.body?.allowDuplicateName) {
    return problem(res, 409, 'Conflict', `A folder called “${clash.name}” already exists. Open it, or pick a different name.`);
  }

  const folder = {
    _id: `folder_${uuid().slice(0, 8)}`,
    name,
    description: String(req.body?.description || ''),
    tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
    songId: req.body?.songId || null,
    artistId: req.body?.artistId || null,
    createdBy: req.user.sub,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };
  db.folders.unshift(folder);
  persist();
  record(req, {
    action: 'FOLDER_CREATE', entity: 'folder', entityId: folder._id,
    label: `Created folder “${folder.name}”`,
    after: { name: folder.name, tags: folder.tags },
    meta: { s3ObjectsTouched: 0 },
  });
  res.status(201).json(decorate(folder));
});

// Renaming or re-tagging a folder is a single document update — no object is copied,
// no key changes, and every file inside keeps working throughout.
foldersRouter.patch('/:id', requires('asset:edit'), (req, res) => {
  const folder = db.folders.find((f) => f._id === req.params.id && !f.deletedAt);
  if (!folder) return problem(res, 404, 'Not Found', 'No folder with that id.');
  const before = { name: folder.name, tags: [...folder.tags], description: folder.description };
  for (const field of ['name', 'description', 'tags', 'songId', 'artistId']) {
    if (field in (req.body || {})) folder[field] = req.body[field];
  }
  folder.updatedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'FOLDER_UPDATE', entity: 'folder', entityId: folder._id,
    label: `Updated folder “${folder.name}”`, before, after: req.body,
    meta: { s3ObjectsTouched: 0 },
  });
  res.json(decorate(folder));
});

// Deleting a folder never deletes files. Membership is cleared and the files return to
// the library, because losing a grouping should never risk losing a master.
foldersRouter.delete('/:id', requires('asset:delete'), (req, res) => {
  const folder = db.folders.find((f) => f._id === req.params.id && !f.deletedAt);
  if (!folder) return problem(res, 404, 'Not Found', 'No folder with that id.');
  const released = assetsInFolder(folder._id);
  for (const { asset } of released) asset.folderId = null;
  folder.deletedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'FOLDER_DELETE', entity: 'folder', entityId: folder._id,
    label: `Deleted folder “${folder.name}”`,
    meta: { filesReleased: released.length, filesDeleted: 0, s3ObjectsTouched: 0 },
  });
  res.json({ ok: true, filesReleased: released.length });
});

// Move files in or out. `folderId: null` takes them out without touching storage.
foldersRouter.post('/:id/assets', requires('asset:edit'), (req, res) => {
  const target = req.params.id === 'none' ? null : db.folders.find((f) => f._id === req.params.id && !f.deletedAt);
  if (req.params.id !== 'none' && !target) return problem(res, 404, 'Not Found', 'No folder with that id.');

  const ids = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
  let moved = 0;
  for (const id of ids) {
    const ctx = assetContext(id);
    if (!ctx) continue;
    ctx.asset.folderId = target ? target._id : null;
    ctx.asset.updatedAt = new Date().toISOString();
    moved += 1;
  }
  if (target) target.updatedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'FOLDER_MOVE', entity: 'folder', entityId: target?._id ?? 'none',
    label: target ? `Moved ${moved} file${moved === 1 ? '' : 's'} into “${target.name}”` : `Removed ${moved} file${moved === 1 ? '' : 's'} from their folder`,
    after: { assetIds: ids },
    meta: { s3ObjectsTouched: 0 },
  });
  res.json({ ok: true, moved });
});

// Used by the picker on the upload screen and the asset drawer.
foldersRouter.get('/lookup/options', (_req, res) => {
  res.json(
    db.folders
      .filter((f) => !f.deletedAt)
      .map((f) => ({ _id: f._id, name: f.name, assetCount: assetsInFolder(f._id).length }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
});
