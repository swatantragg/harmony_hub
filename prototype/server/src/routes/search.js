// Universal search (§10.6). The $unwind + $match aggregation, expressed in plain JS:
// results are asset-granular and every result carries its parent song and artist.
import express from 'express';
import { db, allAssets } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { shape } from '../services/assets.js';
import * as storage from '../services/storage.js';

export const searchRouter = express.Router();
searchRouter.use(authenticate);

const asArray = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',').filter(Boolean));

// Naive relevance scoring, standing in for a MongoDB $text score.
//
// Tags are weighted alongside the filename deliberately. Tagging is the one piece of
// curation this library asks people to do, so a term that matches a tag exactly should
// rank as highly as one that matches a name — otherwise the effort never pays off.
function score(row, terms) {
  if (!terms.length) return 0;
  const fields = [
    [row.asset.displayName, 6],
    [row.asset.tags.join(' '), 6],
    [row.song?.title, 5],
    [row.artist?.name, 5],
    [row.folder?.name, 4],
    [row.folder?.tags?.join(' '), 3],
    [row.asset.type, 3],
    [row.asset.description, 1],
    [row.song?.language, 1],
    [row.song?.mood, 1],
    [row.asset.originalName, 1],
  ];
  let total = 0;
  for (const term of terms) {
    // An exact tag hit is the strongest signal in the index.
    if (row.asset.tags.some((t) => t.toLowerCase() === term)) total += 24;
    for (const [value, weight] of fields) {
      const hay = String(value || '').toLowerCase();
      if (!hay) continue;
      if (hay === term) total += weight * 3;
      else if (hay.startsWith(term)) total += weight * 2;
      else if (hay.includes(term)) total += weight;
    }
  }
  return total;
}

function tally(rows, get) {
  const counts = new Map();
  for (const row of rows) {
    for (const value of [].concat(get(row) ?? [])) {
      if (value == null || value === '') continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

export function runSearch(query) {
  const q = String(query.q || '').trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const filters = {
    family: asArray(query.family),
    type: asArray(query.type),
    language: asArray(query.language),
    mood: asArray(query.mood),
    tags: asArray(query.tags),
    availability: asArray(query.availability),
    version: asArray(query.version),
    artistId: asArray(query.artistId),
    year: asArray(query.year),
    folderId: asArray(query.folderId),
    placement: asArray(query.placement),
  };

  let rows = allAssets();

  // Free-text stage.
  if (terms.length) {
    rows = rows
      .map((row) => ({ row, s: score(row, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => ({ ...x.row, _score: x.s }));
  }

  const matches = (row, key) => {
    const get = {
      family: () => row.asset.family,
      type: () => row.asset.type,
      language: () => row.song?.language,
      mood: () => row.song?.mood,
      tags: () => row.asset.tags,
      availability: () => row.asset.availability?.status ?? 'UNVERIFIED',
      version: () => row.asset.version,
      artistId: () => row.artist?._id,
      year: () => (row.song ? String(new Date(row.song.releaseDate).getFullYear()) : null),
      folderId: () => row.folder?._id ?? 'none',
      placement: () => [row.song ? 'song' : 'unfiled', row.folder ? 'foldered' : 'loose'],
    }[key];
    const value = [].concat(get() ?? []);
    return filters[key].some((f) => value.includes(f));
  };

  // Facet counts are computed against everything EXCEPT the facet being counted, so a
  // selected filter never zeroes out its own sibling options.
  const facetKeys = Object.keys(filters);
  const narrowed = (skip) =>
    rows.filter((row) => facetKeys.every((k) => k === skip || filters[k].length === 0 || matches(row, k)));

  const results = narrowed(null);

  const facets = {
    family: tally(narrowed('family'), (r) => r.asset.family),
    type: tally(narrowed('type'), (r) => r.asset.type),
    language: tally(narrowed('language'), (r) => r.song?.language),
    mood: tally(narrowed('mood'), (r) => r.song?.mood),
    folder: tally(narrowed('folderId'), (r) => r.folder?.name),
    tags: tally(narrowed('tags'), (r) => r.asset.tags),
    availability: tally(narrowed('availability'), (r) => r.asset.availability?.status ?? 'UNVERIFIED'),
    version: tally(narrowed('version'), (r) => r.asset.version),
    artist: tally(narrowed('artistId'), (r) => r.artist?.name),
    year: tally(narrowed('year'), (r) => (r.song ? String(new Date(r.song.releaseDate).getFullYear()) : null)),
  };

  const sort = query.sort || (terms.length ? 'relevance' : 'newest');
  const sorters = {
    relevance: (a, b) => (b._score ?? 0) - (a._score ?? 0) || Date.parse(b.asset.createdAt) - Date.parse(a.asset.createdAt),
    newest: (a, b) => Date.parse(b.asset.createdAt) - Date.parse(a.asset.createdAt),
    oldest: (a, b) => Date.parse(a.asset.createdAt) - Date.parse(b.asset.createdAt),
    name: (a, b) => a.asset.displayName.localeCompare(b.asset.displayName),
    largest: (a, b) => (b.asset.s3.sizeBytes || 0) - (a.asset.s3.sizeBytes || 0),
  };
  results.sort(sorters[sort] || sorters.newest);

  return { results, facets, sort };
}

searchRouter.get('/', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(96, Math.max(1, Number(req.query.limit) || 24));
  const { results, facets, sort } = runSearch(req.query);

  const slice = results.slice((page - 1) * limit, page * limit);

  // &verify=live forces a real probe for the current page — slower, but definitive.
  if (req.query.verify === 'live') {
    for (const row of slice) storage.verifyAsset(row.asset);
  }

  res.json({
    data: slice.map(shape),
    facets,
    sort,
    page,
    limit,
    total: results.length,
    hasMore: page * limit < results.length,
    verifiedLive: req.query.verify === 'live',
  });
});

searchRouter.get('/facets', (req, res) => {
  const { facets } = runSearch(req.query);
  res.json(facets);
});

// Command-palette source: a small mixed set of files, tags, folders, songs and artists.
searchRouter.get('/quick', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ assets: [], tags: [], folders: [], songs: [], artists: [] });
  const hit = (s) => String(s || '').toLowerCase().includes(q);
  const { results } = runSearch({ q });

  const rows = allAssets();
  const tagCounts = new Map();
  for (const { asset } of rows) {
    for (const t of asset.tags) if (hit(t)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }

  res.json({
    assets: results.slice(0, 6).map((r) => ({
      assetId: r.asset.assetId, displayName: r.asset.displayName, type: r.asset.type,
      family: r.asset.family,
      songTitle: r.song?.title ?? r.folder?.name ?? 'Unfiled',
      status: r.asset.availability?.status,
    })),
    // Tags are offered as their own jump target so "search by tag" is one keystroke,
    // not a filter someone has to discover in the sidebar.
    tags: [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count })),
    folders: db.folders.filter((f) => !f.deletedAt && (hit(f.name) || f.tags.some(hit))).slice(0, 4)
      .map((f) => ({
        _id: f._id, name: f.name, tags: f.tags,
        assetCount: rows.filter(({ asset }) => asset.folderId === f._id).length,
      })),
    songs: db.songs.filter((s) => !s.deletedAt && hit(s.title)).slice(0, 4)
      .map((s) => ({ _id: s._id, title: s.title, artistName: db.artists.find((a) => a._id === s.artistId)?.name, assetCount: s.assets.filter((a) => !a.deletedAt).length })),
    artists: db.artists.filter((a) => !a.deletedAt && hit(a.name)).slice(0, 4)
      .map((a) => ({ _id: a._id, name: a.name, genre: a.genre })),
  });
});
