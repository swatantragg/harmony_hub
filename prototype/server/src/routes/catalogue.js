// Artists, songs and tags — the "meaning" half of the responsibility split (§4.1).
// Note that every rename here touches MongoDB only and never moves an S3 object.
import express from 'express';
import { db, persist, live } from '../db.js';
import { authenticate, requires, problem } from '../middleware/auth.js';
import { shape } from '../services/assets.js';
import { record } from '../services/audit.js';
import { uuid } from '../util/crypto.js';
import { CONTROLLED_TAGS, LANGUAGES, MOODS, FAMILIES } from '../catalogue.js';
import { similarTags, similarTypes, allTypes } from '../services/vocabulary.js';

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
  const type = String(req.body?.type || '').trim();
  const family = FAMILIES.includes(req.body?.family) ? req.body.family : 'Document';
  if (!type) return problem(res, 422, 'Unprocessable Entity', 'Give the new type a name.');
  if (type.length > 60) return problem(res, 422, 'Unprocessable Entity', 'Keep type names under 60 characters.');

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
    bytes += a.s3.sizeBytes || 0;
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
  const songs = live(db.songs)
    .filter((s) => s.artistId === artist._id)
    .sort((a, b) => Date.parse(b.releaseDate) - Date.parse(a.releaseDate))
    .map((s) => ({
      _id: s._id, title: s.title, language: s.language, mood: s.mood, releaseDate: s.releaseDate,
      assetCount: s.assets.filter((a) => !a.deletedAt).length,
      coverAssetId: s.assets.find((a) => a.type === 'Song Cover' && !a.deletedAt)?.assetId ?? null,
    }));
  const gallery = live(db.songs)
    .filter((s) => s.artistId === artist._id)
    .flatMap((s) => s.assets.filter((a) => !a.deletedAt && a.family === 'Image').map((a) => shape({ asset: a, song: s, artist })))
    .slice(0, 12);
  res.json({ ...artist, ...artistStats(artist), songs, gallery });
});

artistsRouter.post('/', requires('catalogue:edit'), (req, res) => {
  const { name, genre, label, city, bio } = req.body || {};
  if (!name?.trim()) return problem(res, 422, 'Unprocessable Entity', 'An artist name is required.');
  const artist = {
    _id: `artist_${uuid().slice(0, 8)}`,
    name: name.trim(),
    slug: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    genre: genre || 'Unclassified', label: label || '', city: city || '', bio: bio || '',
    contact: '', socials: [], imageAssetId: null,
    createdAt: new Date().toISOString(), deletedAt: null,
  };
  db.artists.push(artist);
  persist();
  record(req, { action: 'ARTIST_CREATE', entity: 'artist', entityId: artist._id, label: `Created artist ${artist.name}`, after: { name: artist.name } });
  res.status(201).json({ ...artist, ...artistStats(artist) });
});

// Renaming an artist is a single field update — zero S3 objects touched (§10.4.3).
artistsRouter.patch('/:id', requires('catalogue:edit'), (req, res) => {
  const artist = db.artists.find((a) => a._id === req.params.id);
  if (!artist) return problem(res, 404, 'Not Found', 'No artist with that id.');
  const before = { name: artist.name, genre: artist.genre, label: artist.label, city: artist.city, bio: artist.bio };
  for (const field of ['name', 'genre', 'label', 'city', 'bio', 'contact']) {
    if (field in (req.body || {})) artist[field] = req.body[field];
  }
  persist();
  record(req, {
    action: 'ARTIST_UPDATE', entity: 'artist', entityId: artist._id,
    label: `Updated ${artist.name}`, before, after: req.body, meta: { s3ObjectsTouched: 0 },
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
    totalBytes: assets.reduce((n, a) => n + (a.s3.sizeBytes || 0), 0),
    recycleBin: song.assets.filter((a) => a.deletedAt).map((asset) => shape({ asset, song, artist })),
  });
});

songsRouter.post('/', requires('catalogue:edit'), (req, res) => {
  const { title, artistId, language, mood, isrc, releaseDate, tags } = req.body || {};
  if (!title?.trim()) return problem(res, 422, 'Unprocessable Entity', 'A song title is required.');
  if (!db.artists.some((a) => a._id === artistId)) return problem(res, 422, 'Unprocessable Entity', 'Pick an existing artist.');
  const song = {
    _id: `song_${uuid().slice(0, 8)}`,
    title: title.trim(), artistId, featuring: [],
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
  const before = { title: song.title, language: song.language, mood: song.mood, artistId: song.artistId };
  for (const field of ['title', 'language', 'mood', 'isrc', 'releaseDate', 'tags', 'description', 'artistId']) {
    if (field in (req.body || {})) song[field] = req.body[field];
  }
  song.updatedAt = new Date().toISOString();
  persist();
  record(req, {
    action: 'SONG_UPDATE', entity: 'song', entityId: song._id,
    label: `Updated ${song.title}`, before, after: req.body, meta: { s3ObjectsTouched: 0 },
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
  const name = String(req.body?.name || '').trim();
  if (!name) return problem(res, 422, 'Unprocessable Entity', 'A tag name is required.');

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
  tag.type = 'controlled';
  tag.group = req.body?.group || 'Format / use';
  persist();
  record(req, { action: 'TAG_PROMOTE', entity: 'tag', entityId: tag._id, label: `Promoted "${tag.name}" to the controlled vocabulary` });
  res.json(tag);
});
