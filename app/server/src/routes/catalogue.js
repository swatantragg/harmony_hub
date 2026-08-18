// Artists, songs and tags — the "meaning" half of the responsibility split (§4.1).
// Note that every rename here touches MongoDB only and never moves a Google Drive file.
import express from 'express';
import { db, persist, live } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { shape } from '../services/assets.js';
import { record } from '../services/audit.js';
import { uuid } from '../util/crypto.js';
import { CONTROLLED_TAGS, LANGUAGES, MOODS, FAMILIES } from '../catalogue.js';
import { similarTags, similarTypes, allTypes } from '../services/vocabulary.js';
import { LIMITS, fields, list, oneOf, str } from '../util/validate.js';

export const artistsRouter = express.Router();
export const songsRouter = express.Router();
export const tagsRouter = express.Router();
export const typesRouter = express.Router();
[artistsRouter, songsRouter, tagsRouter, typesRouter].forEach((r) => r.use(authenticate));

// ── Asset types ─────────────────────────────────────────────────────────────
// The built-in catalogue covers the 21 types a release actually produces. Anything else
// a team files — a press kit, a sync licence, a contract — can be added here rather than
// mislabelled as "Lyrics" because the dropdown had nothing better.
typesRouter.get('/', (_req, res) => {
  const types = allTypes();
  res.json({
    data: types,
    families: FAMILIES,
    builtinCount: types.filter((t) => !t.custom).length,
    customCount: types.filter((t) => t.custom).length,
  });
});

typesRouter.get('/similar', (req, res) => {
  const { exact, suggestions } = similarTypes(req.query.type);
  res.json({ exact, suggestions });
});

typesRouter.post('/', requires('asset:upload'), (req, res) => {
  const check = fields(req.body || {}, {
    type: (v) => str(v, { max: 60, field: 'type', required: true }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const type = check.value.type;
  const family = FAMILIES.includes(req.body?.family) ? req.body.family : 'Document';

  const { exact, suggestions } = similarTypes(type);
  if (exact) {
    return problem(res, 409, 'Conflict', `“${exact.type}” already exists — pick it from the list instead.`);
  }
  if (suggestions.length > 0 && !req.body?.force) {
    return res.status(409).type('application/problem+json').json({
      type: 'https://gcloud.internal/problems/similar-type-exists',
      title: 'Similar type exists',
      status: 409,
      detail: `“${type}” is very close to ${suggestions.map((s) => `“${s.type}”`).join(', ')}. Use one of those, or confirm to add a separate type.`,
      suggestions,
    });
  }

  const record_ = {
    _id: `type_${uuid().slice(0, 8)}`,
    type,
    family,
    tier: 'HOT',
    createdBy: req.user.sub,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  };
  db.customTypes.push(record_);
  persist();
  record(req, {
    action: 'TYPE_CREATE', entity: 'type', entityId: record_._id,
    label: `Added asset type “${type}” under ${family}`, after: { type, family },
  });
  res.status(201).json({ ...record_, custom: true });
});

const artistStats = (artist) => {
  const songs = live(db.songs).filter((s) => s.artistId === artist._id);
  const assets = songs.flatMap((s) => s.assets.filter((a) => !a.deletedAt));
  const byFamily = { Audio: 0, Video: 0, Image: 0, Document: 0 };
  let bytes = 0;
  for (const a of assets) {
    byFamily[a.family] = (byFamily[a.family] || 0) + 1;
    bytes += a.drive?.sizeBytes || 0;
  }
  return { songCount: songs.length, assetCount: assets.length, byFamily, totalBytes: bytes };
};

// ── Artists ─────────────────────────────────────────────────────────────────
artistsRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const rows = live(db.artists)
    .filter((a) => !q || a.name.toLowerCase().includes(q) || a.genre.toLowerCase().includes(q))
    .map((a) => ({ ...a, ...artistStats(a) }));
  res.json({ data: rows, total: rows.length });
});

artistsRouter.get('/:id', (req, res) => {
  const artist = db.artists.find((a) => a._id === req.params.id && !a.deletedAt);
  if (!artist) return problem(res, 404, 'Not Found', 'No artist with that id.');

  const artistSongs = live(db.songs).filter((s) => s.artistId === artist._id);

  const songs = [...artistSongs]
    .sort((a, b) => Date.parse(b.releaseDate) - Date.parse(a.releaseDate))
    .map((s) => ({
      _id: s._id, title: s.title, language: s.language, mood: s.mood, releaseDate: s.releaseDate,
      assetCount: s.assets.filter((a) => !a.deletedAt).length,
      coverAssetId: s.assets.find((a) => a.type === 'Song Cover' && !a.deletedAt)?.assetId ?? null,
    }));

  const assets = artistSongs.flatMap((s) => s.assets.filter((a) => !a.deletedAt));

  // What the artist's page can offer as a tab. These are counts of what genuinely exists,
  // so a tab is never shown leading to an empty list — and the reader can see, before
  // clicking, how much is behind each one.
  const byType = {};
  for (const a of assets) byType[a.type] = (byType[a.type] || 0) + 1;

  // The folders this artist's files are actually stored in. A folder here is a real Google
  // Drive folder, so this answers "where does their work live?" rather than just "what do
  // they have?" — the two are different questions and people ask both.
  const folderCounts = new Map();
  let looseCount = 0;
  for (const a of assets) {
    if (!a.folderId) { looseCount += 1; continue; }
    folderCounts.set(a.folderId, (folderCounts.get(a.folderId) || 0) + 1);
  }
  const folders = [...folderCounts.entries()]
    .map(([folderId, count]) => {
      const folder = db.folders.find((f) => f._id === folderId && !f.deletedAt);
      if (!folder) return null;
      return {
        _id: folder._id,
        name: folder.name,
        description: folder.description,
        tags: folder.tags,
        parentName: folder.parentId
          ? db.folders.find((f) => f._id === folder.parentId)?.name ?? null
          : null,
        driveWebViewLink: folder.driveWebViewLink,
        // Files by this artist in that folder — not the folder's whole contents, which is
        // a different and here misleading number.
        assetCount: count,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.assetCount - a.assetCount || a.name.localeCompare(b.name));

  const gallery = artistSongs
    .flatMap((s) => s.assets.filter((a) => !a.deletedAt && a.family === 'Image').map((a) => shape({ asset: a, song: s, artist })))
    .slice(0, 12);

  res.json({
    ...artist,
    ...artistStats(artist),
    songs,
    gallery,
    folders,
    byType,
    looseCount,
  });
});

const ARTIST_FIELDS = {
  name: (v) => str(v, { max: LIMITS.name, field: 'name' }),
  genre: (v) => str(v, { max: 60, field: 'genre' }),
  label: (v) => str(v, { max: 120, field: 'label', allowEmpty: true }),
  city: (v) => str(v, { max: 80, field: 'city', allowEmpty: true }),
  bio: (v) => str(v, { max: LIMITS.description, field: 'bio', allowEmpty: true }),
  contact: (v) => str(v, { max: 200, field: 'contact', allowEmpty: true }),
};

artistsRouter.post('/', requires('catalogue:edit'), (req, res) => {
  const check = fields(req.body || {}, { ...ARTIST_FIELDS, name: (v) => str(v, { max: LIMITS.name, field: 'name', required: true }) });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const { name, genre, label, city, bio } = check.value;
  const artist = {
    _id: `artist_${uuid().slice(0, 8)}`,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    genre: genre || 'Unclassified', label: label || '', city: city || '', bio: bio || '',
    contact: '', socials: [], imageAssetId: null,
    createdAt: new Date().toISOString(), deletedAt: null,
  };
  db.artists.push(artist);
  persist();
  record(req, { action: 'ARTIST_CREATE', entity: 'artist', entityId: artist._id, label: `Created artist ${artist.name}`, after: { name: artist.name } });
  res.status(201).json({ ...artist, ...artistStats(artist) });
});

// Renaming an artist is a single field update — no Drive file is touched at all (§10.4.3).
artistsRouter.patch('/:id', requires('catalogue:edit'), (req, res) => {
  const artist = db.artists.find((a) => a._id === req.params.id);
  if (!artist) return problem(res, 404, 'Not Found', 'No artist with that id.');
  const check = fields(req.body || {}, ARTIST_FIELDS);
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  if ('name' in check.value && !check.value.name) {
    return problem(res, 422, 'Unprocessable Entity', 'An artist name is required.');
  }

  const before = { name: artist.name, genre: artist.genre, label: artist.label, city: artist.city, bio: artist.bio };
  for (const field of ['name', 'genre', 'label', 'city', 'bio', 'contact']) {
    if (field in (req.body || {})) artist[field] = check.value[field] ?? '';
  }
  persist();
  record(req, {
    action: 'ARTIST_UPDATE', entity: 'artist', entityId: artist._id,
    label: `Updated ${artist.name}`, before, after: check.value, meta: { bytesMoved: 0, driveFilesTouched: 0 },
  });
  res.json({ ...artist, ...artistStats(artist) });
});

// ── Songs ───────────────────────────────────────────────────────────────────
songsRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const artistId = req.query.artistId;
  const rows = live(db.songs)
    .filter((s) => (!artistId || s.artistId === artistId) && (!q || s.title.toLowerCase().includes(q)))
    .sort((a, b) => Date.parse(b.releaseDate) - Date.parse(a.releaseDate))
    .map((s) => ({
      _id: s._id, title: s.title, artistId: s.artistId,
      artistName: db.artists.find((a) => a._id === s.artistId)?.name,
      language: s.language, mood: s.mood, isrc: s.isrc, releaseDate: s.releaseDate, tags: s.tags,
      assetCount: s.assets.filter((a) => !a.deletedAt).length,
      coverAssetId: s.assets.find((a) => a.type === 'Song Cover' && !a.deletedAt)?.assetId ?? null,
      needsAttention: s.assets.filter((a) => !a.deletedAt && ['MISSING', 'MISMATCH'].includes(a.availability?.status)).length,
    }));
  res.json({ data: rows, total: rows.length });
});

songsRouter.get('/:id', (req, res) => {
  const song = db.songs.find((s) => s._id === req.params.id && !s.deletedAt);
  if (!song) return problem(res, 404, 'Not Found', 'No song with that id.');
  const artist = db.artists.find((a) => a._id === song.artistId);
  const assets = song.assets.filter((a) => !a.deletedAt).map((asset) => shape({ asset, song, artist }));
  const byFamily = {};
  for (const a of assets) (byFamily[a.family] ??= []).push(a);
  res.json({
    ...song,
    artistName: artist?.name ?? null,
    artistGenre: artist?.genre ?? null,
    assets,
    assetsByFamily: byFamily,
    totalBytes: assets.reduce((n, a) => n + (a.drive?.sizeBytes || 0), 0),
    recycleBin: song.assets.filter((a) => a.deletedAt).map((asset) => shape({ asset, song, artist })),
  });
});

const SONG_FIELDS = {
  title: (v) => str(v, { max: LIMITS.name, field: 'title' }),
  artistId: (v) => str(v, { max: 80, field: 'artistId' }),
  // Free text rather than an enum: the vocabulary lists are suggestions, and a library
  // that refuses an unlisted language is a library somebody works around.
  language: (v) => str(v, { max: 60, field: 'language' }),
  mood: (v) => str(v, { max: 60, field: 'mood' }),
  isrc: (v) => str(v, { max: 40, field: 'isrc', allowEmpty: true }),
  releaseDate: (v) => str(v, { max: 40, field: 'releaseDate' }),
  description: (v) => str(v, { max: LIMITS.description, field: 'description', allowEmpty: true }),
  tags: (v) => list(v, { max: LIMITS.tags, itemMax: LIMITS.tag, field: 'tags' }),
};

songsRouter.post('/', requires('catalogue:edit'), (req, res) => {
  const check = fields(req.body || {}, { ...SONG_FIELDS, title: (v) => str(v, { max: LIMITS.name, field: 'title', required: true }) });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const { title, artistId, language, mood, isrc, releaseDate, tags } = check.value;
  if (!db.artists.some((a) => a._id === artistId)) return problem(res, 422, 'Unprocessable Entity', 'Pick an existing artist.');
  if (releaseDate && Number.isNaN(Date.parse(releaseDate))) {
    return problem(res, 422, 'Unprocessable Entity', 'That release date is not a date.');
  }
  const song = {
    _id: `song_${uuid().slice(0, 8)}`,
    title, artistId, featuring: [],
    language: language || 'Hindi', mood: mood || 'Romantic', isrc: isrc || '',
    releaseDate: releaseDate || new Date().toISOString(), tags: tags || [], description: '',
    assets: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
  };
  db.songs.unshift(song);
  persist();
  record(req, { action: 'SONG_CREATE', entity: 'song', entityId: song._id, label: `Created song ${song.title}`, after: { title: song.title } });
  res.status(201).json(song);
});

songsRouter.patch('/:id', requires('catalogue:edit'), (req, res) => {
  const song = db.songs.find((s) => s._id === req.params.id);
  if (!song) return problem(res, 404, 'Not Found', 'No song with that id.');
  const check = fields(req.body || {}, SONG_FIELDS);
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  if ('title' in check.value && !check.value.title) {
    return problem(res, 422, 'Unprocessable Entity', 'A song title is required.');
  }
  if (check.value.artistId && !db.artists.some((a) => a._id === check.value.artistId)) {
    return problem(res, 422, 'Unprocessable Entity', 'Pick an existing artist.');
  }
  if (check.value.releaseDate && Number.isNaN(Date.parse(check.value.releaseDate))) {
    return problem(res, 422, 'Unprocessable Entity', 'That release date is not a date.');
  }

  const before = { title: song.title, language: song.language, mood: song.mood, artistId: song.artistId };
  for (const field of ['title', 'language', 'mood', 'isrc', 'releaseDate', 'tags', 'description', 'artistId']) {
    if (field in (req.body || {})) song[field] = check.value[field] ?? '';
  }
  song.updatedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'SONG_UPDATE', entity: 'song', entityId: song._id,
    label: `Updated ${song.title}`, before, after: check.value, meta: { bytesMoved: 0, driveFilesTouched: 0 },
  });
  res.json(song);
});

// ── Tags ────────────────────────────────────────────────────────────────────
tagsRouter.get('/', (_req, res) => {
  res.json({
    controlled: CONTROLLED_TAGS,
    all: [...db.tags].sort((a, b) => b.usageCount - a.usageCount),
    languages: LANGUAGES,
    moods: MOODS,
  });
});

// Preflight for the tag field. Returns near-duplicates so the person typing can reuse an
// existing tag instead of quietly forking the vocabulary.
tagsRouter.get('/similar', (req, res) => {
  const { exact, suggestions } = similarTags(req.query.name);
  res.json({ exact, suggestions });
});

tagsRouter.post('/', requires('asset:upload'), (req, res) => {
  const check = fields(req.body || {}, {
    name: (v) => str(v, { max: LIMITS.tag, field: 'name', required: true }),
  });
  if (!check.ok) return problem(res, 422, 'Unprocessable Entity', check.problem);
  const name = check.value.name;

  const { exact, suggestions } = similarTags(name);

  // An exact match once case and punctuation are ignored is never a new tag — hand back
  // the one that already exists so both spellings resolve to a single searchable value.
  if (exact) return res.json({ ...exact, reused: true });

  // Close matches are surfaced, not enforced: the caller confirms with `force`.
  if (suggestions.length > 0 && !req.body?.force) {
    return res.status(409).type('application/problem+json').json({
      type: 'https://gcloud.internal/problems/similar-tag-exists',
      title: 'Similar tag exists',
      status: 409,
      detail: `“${name}” looks very close to ${suggestions.map((s) => `“${s.name}”`).join(', ')}. Reuse one of those, or confirm to create a separate tag.`,
      suggestions,
    });
  }

  const tag = { _id: uuid(), name, group: 'Custom', type: 'custom', usageCount: 0, createdAt: new Date().toISOString() };
  db.tags.push(tag);
  persist();
  record(req, { action: 'TAG_CREATE', entity: 'tag', entityId: tag._id, label: `Created custom tag "${name}"` });
  res.status(201).json(tag);
});

tagsRouter.patch('/:id/promote', requires('admin:users'), (req, res) => {
  const tag = db.tags.find((t) => t._id === req.params.id);
  if (!tag) return problem(res, 404, 'Not Found', 'No tag with that id.');
  const group = oneOf(req.body?.group, Object.keys(CONTROLLED_TAGS), { field: 'group', fallback: 'Format / use' });
  if (group.problem) return problem(res, 422, 'Unprocessable Entity', group.problem);
  tag.type = 'controlled';
  tag.group = group.value;
  persist();
  record(req, { action: 'TAG_PROMOTE', entity: 'tag', entityId: tag._id, label: `Promoted "${tag.name}" to the controlled vocabulary` });
  res.json(tag);
});
