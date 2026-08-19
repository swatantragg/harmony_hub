// Universal search (§10.6). The $unwind + $match aggregation, expressed in plain JS:
// results are asset-granular and every result carries its parent song and artist.
//
// The index lives here rather than in Google Drive on purpose. Drive's own `q` can match a
// name, a full-text body and an appProperties key, but it knows nothing about artists,
// songs, asset types, release years or facet counts — and it cannot rank a tag hit above a
// filename hit. So the catalogue stays the search index, and Drive-side search is offered
// separately, below, for the one thing the catalogue cannot see: files nobody uploaded
// through this app.
import express from 'express';
import { db, allAssets, persist } from '../db.js';
import { authenticate, problem } from '../middleware/auth.js';
import { shape, resolveLanguage } from '../services/assets.js';
import * as storage from '../services/storage.js';
import { escapeQuery, listFiles, FOLDER_MIME } from '../storage/drive.js';
import { ROOTS } from '../config.js';

export const searchRouter = express.Router();
searchRouter.use(authenticate);

const asArray = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',').filter(Boolean));

// A file's own language when it has one, otherwise its release's. Resolved through the
// shared helper so this screen, the master log and the asset drawer can never disagree
// about what language a file is in — which they did, when each computed it itself.
const languageOf = (row) => resolveLanguage(row.asset, row.song).language;

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
    [languageOf(row), 1],
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
      language: () => languageOf(row),
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
    language: tally(narrowed('language'), languageOf),
    mood: tally(narrowed('mood'), (r) => r.song?.mood),
    folder: tally(narrowed('folderId'), (r) => r.folder?.name),
    tags: tally(narrowed('tags'), (r) => r.asset.tags),
    availability: tally(narrowed('availability'), (r) => r.asset.availability?.status ?? 'UNVERIFIED'),
    version: tally(narrowed('version'), (r) => r.asset.version),
    artist: tally(narrowed('artistId'), (r) => r.artist?.name),
    year: tally(narrowed('year'), (r) => (r.song ? String(new Date(r.song.releaseDate).getFullYear()) : null)),
  };

  const sort = query.sort || (terms.length ? 'relevance' : 'newest');
  // Every order is offered in both directions. A one-way sort forces the reader to page to
  // the end to answer "which is the oldest?", which is the same question asked backwards.
  const updatedAt = (row) => Date.parse(row.asset.updatedAt || row.asset.createdAt);
  const sorters = {
    relevance: (a, b) => (b._score ?? 0) - (a._score ?? 0) || Date.parse(b.asset.createdAt) - Date.parse(a.asset.createdAt),
    newest: (a, b) => Date.parse(b.asset.createdAt) - Date.parse(a.asset.createdAt),
    oldest: (a, b) => Date.parse(a.asset.createdAt) - Date.parse(b.asset.createdAt),
    updated: (a, b) => updatedAt(b) - updatedAt(a),
    updatedOldest: (a, b) => updatedAt(a) - updatedAt(b),
    name: (a, b) => a.asset.displayName.localeCompare(b.asset.displayName),
    nameDesc: (a, b) => b.asset.displayName.localeCompare(a.asset.displayName),
    largest: (a, b) => (b.asset.drive?.sizeBytes || 0) - (a.asset.drive?.sizeBytes || 0),
    smallest: (a, b) => (a.asset.drive?.sizeBytes || 0) - (b.asset.drive?.sizeBytes || 0),
  };
  results.sort(sorters[sort] || sorters.newest);

  return { results, facets, sort };
}

// The ceiling on a page. It used to be 5,000, which is a whole library serialised into
// one JSON body on demand — a cheap request to make and an expensive one to answer, which
// is the shape of every denial-of-service. 500 is still far more than any screen renders.
const MAX_PAGE = 500;
// A live verification is one Drive call per row, against a per-application quota shared by
// everybody. It is capped much lower than the page it verifies.
const MAX_LIVE_VERIFY = 25;

searchRouter.get('/', async (req, res) => {
  const page = Math.max(1, Math.min(10_000, Number(req.query.page) || 1));
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || 24));
  const q = String(req.query.q ?? '');
  if (q.length > 200) {
    return problem(res, 422, 'Unprocessable Entity', 'That search term is too long.');
  }
  const { results, facets, sort } = runSearch(req.query);

  const slice = results.slice((page - 1) * limit, page * limit);

  // &verify=live forces a real files.get for the visible rows — slower, but definitive.
  if (req.query.verify === 'live') {
    await storage.verifyAssets(slice.slice(0, MAX_LIVE_VERIFY).map((row) => row.asset));
    persist();
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


// Search Google Drive itself, not the catalogue.
//
// This exists for exactly one question: "I know the file is in the Drive — why can't I
// find it here?" The answer is almost always that somebody dropped it into the folder
// without uploading it through GCloud, so it has no catalogue record and the normal
// search cannot see it. Anything this turns up that is not already catalogued can be
// adopted from Storage Health.
searchRouter.get('/drive', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ data: [], total: 0, query: null });
  if (q.length > 200) return problem(res, 422, 'Unprocessable Entity', 'That search term is too long.');

  const escaped = escapeQuery(q);
  const clauses = [
    `name contains '${escaped}'`,
    // Drive indexes the contents of documents, PDFs and even OCRs images, which is a
    // capability the catalogue simply does not have.
    `fullText contains '${escaped}'`,
  ];
  // appProperties are how GCloud writes tags, artist and song onto the file itself,
  // so a Drive-side search can match them too.
  for (const key of ['tags', 'artist', 'song', 'assetType']) {
    clauses.push(`appProperties has { key='${key}' and value='${escaped}' }`);
  }

  try {
    const out = await listFiles({
      q: `(${clauses.join(' or ')}) and trashed = false`,
      pageSize: 50,
      orderBy: 'modifiedTime desc',
    });
    const known = new Set();
    for (const { asset } of allAssets()) if (asset.drive?.fileId) known.add(asset.drive.fileId);

    // Every folder id that belongs to the library: the four role folders, plus the Drive
    // folder behind each catalogue folder. Comparing a file's parent against ROOTS.assets
    // alone is wrong — the library nests, so anything filed inside a folder would be
    // reported as sitting outside it, which is exactly the opposite of the truth.
    const libraryFolders = new Set([
      ...Object.values(ROOTS).filter(Boolean),
      ...db.folders.filter((f) => !f.deletedAt && f.driveFolderId).map((f) => f.driveFolderId),
    ]);

    res.json({
      query: q,
      total: (out.files || []).length,
      data: (out.files || []).map((f) => ({
        fileId: f.id,
        name: f.name,
        mimeType: f.mimeType,
        isFolder: f.mimeType === FOLDER_MIME,
        sizeBytes: f.size == null ? null : Number(f.size),
        modifiedAt: f.modifiedTime,
        webViewLink: f.webViewLink,
        appProperties: f.appProperties || {},
        // The whole point of the endpoint.
        catalogued: known.has(f.id),
        inLibraryFolder: (f.parents || []).some((id) => libraryFolders.has(id)) || libraryFolders.has(f.id),
      })),
      note: 'Searched the whole connected Drive, not just the library. Results outside the library folder are shown so a file that was put in the wrong place can be found; anything marked uncatalogued is invisible to normal search until it is adopted from Storage health.',
    });
  } catch (err) {
    return problem(res, 502, 'Bad Gateway', `Google Drive would not run the search: ${err.message}`);
  }
});
