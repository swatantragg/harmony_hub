import express from 'express';
import { db, allAssets, persist } from '../db.js';
import { authenticate, problem } from '../middleware/auth.js';
import { shape, resolveLanguage } from '../services/assets.js';
import { awaitingReview } from '../services/review.js';
import * as storage from '../services/storage.js';
import { escapeQuery, listFiles, FOLDER_MIME } from '../storage/drive.js';
import { ROOTS } from '../config.js';

export const searchRouter = express.Router();
searchRouter.use(authenticate);

const asArray = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',').filter(Boolean));

const languageOf = (row) => resolveLanguage(row.asset, row.song).language;

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
    review: asArray(query.review),
  };

  let rows = allAssets();

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
      review: () => (awaitingReview(row.asset) ? 'pending' : 'done'),
    }[key];
    const value = [].concat(get() ?? []);
    return filters[key].some((f) => value.includes(f));
  };

  const facetKeys = Object.keys(filters);

  // Facets are counted "as if this one filter were off", which is eleven
  // filtered passes over the catalogue plus one for the results themselves.
  // At 18k assets that was ~2M predicate calls per search, on the one thread
  // that also has to answer everything else.
  //
  // Almost all of it is redundant. A pass that skips a filter nobody set is the
  // unfiltered pass, so it is computed once and shared; with no filters set at
  // all — the common case, a bare page load — there is nothing to filter and
  // `rows` is the answer to every one of them. Only a key somebody actually
  // filtered on earns its own pass.
  const active = facetKeys.filter((k) => filters[k].length > 0);
  const applyAll = (skip) =>
    rows.filter((row) => active.every((k) => k === skip || matches(row, k)));

  const base = active.length === 0 ? rows : applyAll(null);
  const byKey = new Map();
  const narrowed = (skip) => {
    if (skip === null || !active.includes(skip)) return base;
    if (!byKey.has(skip)) byKey.set(skip, applyAll(skip));
    return byKey.get(skip);
  };

  const results = [...base];

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
    // Only the files still waiting are worth a chip; "done" is everything else.
    review: tally(narrowed('review'), (r) => (awaitingReview(r.asset) ? 'pending' : null)),
  };

  const sort = query.sort || (terms.length ? 'relevance' : 'newest');
  results.sort(SORTERS[sort] || SORTERS.newest);

  return { results, facets, sort };
}

const updatedAt = (row) => Date.parse(row.asset.updatedAt || row.asset.createdAt);

const SORTERS = {
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

// ── Cursor pagination ───────────────────────────────────────────────────────
// `page` is still honoured and still what the UI sends. A cursor is offered
// alongside it because offsets and a live catalogue disagree: adopt forty files
// from Drive while somebody is on page 3 and every later page shifts under
// them, silently repeating rows and skipping others.
//
// The cursor is a keyset — the sort value of the last row served, plus its
// assetId as the tie-break — which is the same shape a `find()` with a range
// filter would need. That is deliberate: when assets move into a collection of
// their own, this becomes a Mongo query and the wire format does not change.

const SORT_KEY = {
  relevance: (row) => row._score ?? 0,
  newest: (row) => Date.parse(row.asset.createdAt),
  oldest: (row) => Date.parse(row.asset.createdAt),
  updated: updatedAt,
  updatedOldest: updatedAt,
  name: (row) => row.asset.displayName,
  nameDesc: (row) => row.asset.displayName,
  largest: (row) => row.asset.drive?.sizeBytes || 0,
  smallest: (row) => row.asset.drive?.sizeBytes || 0,
};

const DESCENDING = new Set(['relevance', 'newest', 'updated', 'largest', 'nameDesc']);

const compareKeys = (a, b) => (typeof a === 'string' || typeof b === 'string'
  ? String(a ?? '').localeCompare(String(b ?? ''))
  : (Number(a) || 0) - (Number(b) || 0));

const sortsAfter = (sort, value, key) =>
  (DESCENDING.has(sort) ? compareKeys(value, key) < 0 : compareKeys(value, key) > 0);

const encodeCursor = (payload) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

function decodeCursor(raw) {
  const text = String(raw ?? '');
  if (!text || text.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.s !== 'string' || typeof parsed.id !== 'string') return null;
    return { s: parsed.s, k: parsed.k ?? null, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Where the next page starts.
 *
 * Normally that is one past the row the cursor names. When that row has been
 * deleted or renamed out of the result set since, it falls forward to the first
 * row that sorts strictly after the recorded key — so a mutation mid-scroll
 * costs at most the rows that genuinely left, and never repeats one.
 */
function resolveCursor(results, cursor) {
  const at = results.findIndex((row) => row.asset.assetId === cursor.id);
  if (at >= 0) return at + 1;
  const after = results.findIndex((row) => sortsAfter(cursor.s, SORT_KEY[cursor.s]?.(row), cursor.k));
  return after < 0 ? results.length : after;
}

const MAX_PAGE = 500;
const MAX_LIVE_VERIFY = 25;

/**
 * The sections a search is broken into, in the order somebody looking for a
 * song wants them: the recording first, then what was cut from it, then the
 * artwork, then the paperwork. Anything with a family outside this list falls
 * into a final "Other" section rather than disappearing.
 */
const SECTIONS = [
  { key: 'Audio', label: 'Songs & audio' },
  { key: 'Video', label: 'Videos' },
  { key: 'Image', label: 'Images & artwork' },
  { key: 'Document', label: 'Documents' },
];
const OTHER = { key: 'Other', label: 'Everything else' };

const SECTION_KEYS = new Set(SECTIONS.map((s) => s.key));

const PER_SECTION_MAX = 96;

searchRouter.get('/', async (req, res) => {
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || 24));
  const q = String(req.query.q ?? '');
  if (q.length > 200) {
    return problem(res, 422, 'Unprocessable Entity', 'That search term is too long.');
  }
  if (req.query.cursor && !decodeCursor(req.query.cursor)) {
    return problem(res, 422, 'Unprocessable Entity', 'That cursor is not one this API issued.');
  }

  const cursor = decodeCursor(req.query.cursor);
  const { results, facets, sort } = runSearch(req.query);

  // A cursor is only meaningful under the ordering it was issued for. Changing
  // the sort restarts from the top rather than landing somewhere arbitrary.
  const usable = cursor && cursor.s === sort ? cursor : null;
  const from = usable
    ? resolveCursor(results, usable)
    : (Math.max(1, Math.min(10_000, Number(req.query.page) || 1)) - 1) * limit;

  const slice = results.slice(from, from + limit);
  const page = Math.floor(from / limit) + 1;
  const last = slice[slice.length - 1];

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
    hasMore: from + slice.length < results.length,
    nextCursor: last && from + slice.length < results.length
      ? encodeCursor({ s: sort, k: SORT_KEY[sort]?.(last) ?? null, id: last.asset.assetId })
      : null,
    verifiedLive: req.query.verify === 'live',
  });
});

/**
 * The same search, cut into sections by family.
 *
 * One title usually has an audio master, a video, artwork and a lyric sheet all
 * sharing its name, and a flat relevance list interleaves them. This answers
 * "what audio is there for X, and what video" in one request: each section
 * carries its own total, so "see all 40 images" is a filter the client applies
 * rather than another guess at a page size.
 */
searchRouter.get('/grouped', (req, res) => {
  const q = String(req.query.q ?? '');
  if (q.length > 200) {
    return problem(res, 422, 'Unprocessable Entity', 'That search term is too long.');
  }
  const perSection = Math.min(PER_SECTION_MAX, Math.max(1, Number(req.query.perSection) || 12));

  const { results, facets, sort } = runSearch(req.query);

  const buckets = new Map();
  for (const row of results) {
    const key = SECTION_KEYS.has(row.asset.family) ? row.asset.family : OTHER.key;
    const bucket = buckets.get(key) ?? [];
    bucket.push(row);
    buckets.set(key, bucket);
  }

  const groups = [...SECTIONS, OTHER]
    .map(({ key, label }) => {
      const rows = buckets.get(key) ?? [];
      return {
        key,
        label,
        total: rows.length,
        hasMore: rows.length > perSection,
        // Only the four real families can be turned into a family filter; the
        // catch-all section is not a filter anybody can express.
        filterable: key !== OTHER.key,
        data: rows.slice(0, perSection).map(shape),
      };
    })
    .filter((g) => g.total > 0);

  res.json({ groups, facets, sort, total: results.length, perSection, q });
});

searchRouter.get('/facets', (req, res) => {
  const { facets } = runSearch(req.query);
  res.json(facets);
});

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


searchRouter.get('/drive', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ data: [], total: 0, query: null });
  if (q.length > 200) return problem(res, 422, 'Unprocessable Entity', 'That search term is too long.');

  const escaped = escapeQuery(q);
  const clauses = [
    `name contains '${escaped}'`,
    `fullText contains '${escaped}'`,
  ];
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
        catalogued: known.has(f.id),
        inLibraryFolder: (f.parents || []).some((id) => libraryFolders.has(id)) || libraryFolders.has(f.id),
      })),
      note: 'Searched the whole connected Drive, not just the library. Results outside the library folder are shown so a file that was put in the wrong place can be found; anything marked uncatalogued is invisible to normal search until it is adopted from Storage health.',
    });
  } catch (err) {
    return problem(res, 502, 'Bad Gateway', `Google Drive would not run the search: ${err.message}`);
  }
});
