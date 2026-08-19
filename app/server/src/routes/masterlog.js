// The Master Log — the library's register of record (§10.6, §10.11).
//
// This is not the activity log. The activity log answers "what happened, and who did it";
// it is a stream of events and it grows forever. The master log answers the other half of
// the question an auditor, a label or an investor actually asks: "what do you *have*, and
// what is the state of each one of them, right now." One row per catalogued file, every
// field the catalogue holds about it, laid out as a spreadsheet rather than as cards.
//
// Why it is a screen and not only an export. The columns a person needs are never the same
// two weeks running — a delivery to a distributor wants ISRC, title, artist and checksum; a
// storage audit wants Drive ids, sizes and verification dates; a rights conversation wants
// uploader, folder and share history. So the column set is chosen on the screen, the same
// set is what leaves in the file, and the file records which columns were left out.
//
// Three properties this deliberately holds to:
//
//   · What is exported is what was on screen. The scope is stated in words on the button
//     ("these 412", "everything"), the filters travel on the query string, and the
//     provenance sheet in the workbook repeats them back.
//   · Every value is rendered once, here. A row leaves this file display-ready — a size is
//     already "1.4 GB", a boolean is already "Yes" — so the table and the spreadsheet can
//     never disagree about what a field says. The few genuinely numeric columns stay
//     numbers so a spreadsheet can sum and sort them.
//   · No spreadsheet dependency. util/xlsx.js writes the .xlsx; CSV is twenty lines.
import express from 'express';
import { db, allAssets } from '../db.js';
import { authenticate, problem } from '../middleware/auth.js';
import { shape } from '../services/assets.js';
import { record } from '../services/audit.js';
import { tierOf } from '../catalogue.js';
import { safeFilename, workbook } from '../util/xlsx.js';

export const masterLogRouter = express.Router();
masterLogRouter.use(authenticate);

/* ── Formatting ──────────────────────────────────────────────────────────── */
//
// The same rules as the client's lib/format.ts, restated here rather than reached for
// across the wire boundary, so a row is complete when it leaves the server and the export
// never has to re-derive anything the screen already decided.

const bytesText = (n) => {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};

const durationText = (sec) => {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

// Yes/No rather than TRUE/FALSE: a spreadsheet coerces the latter into a boolean and then
// a locale decides how to print it, which is how an export ends up saying VERDADERO.
const yesNo = (v) => (v ? 'Yes' : 'No');

const list = (values) => (Array.isArray(values) ? values.filter(Boolean).join(', ') : '');

// Plain-language status, mirroring the client's STATUS_COPY labels so the exported file
// reads the same as the screen it came from.
const STATUS_LABEL = {
  AVAILABLE: 'Available',
  UNVERIFIED: 'Not checked',
  TRASHED: 'In the bin',
  RESTORING: 'Restoring',
  MISSING: 'Missing',
  MISMATCH: 'Mismatch',
};

/* ── Columns ─────────────────────────────────────────────────────────────── */
//
// One registry, and it is the only place a column is described. The client asks for it at
// load rather than carrying its own copy — two lists of sixty columns drift within a
// release, and the failure mode is a spreadsheet whose header names the wrong data.
//
// `num` marks a column that must stay a real number: it sorts numerically here and sums in
// Excel there. Everything else is text on purpose, including ids that look numeric.

export const COLUMNS = [
  // Identity — who and what this file is.
  { key: 'rowNo', header: '#', group: 'Identity', width: 6, num: true, always: true },
  { key: 'title', header: 'Title', group: 'Identity', width: 42, always: true },
  { key: 'artist', header: 'Artist', group: 'Identity', width: 24 },
  { key: 'song', header: 'Song', group: 'Identity', width: 28 },
  { key: 'assetId', header: 'Asset ID', group: 'Identity', width: 38 },
  { key: 'originalName', header: 'Original filename', group: 'Identity', width: 38 },

  // Classification — the catalogue's own vocabulary (§10.2).
  { key: 'type', header: 'Asset type', group: 'Classification', width: 22 },
  { key: 'family', header: 'Family', group: 'Classification', width: 11 },
  { key: 'format', header: 'Format', group: 'Classification', width: 11 },
  { key: 'tier', header: 'Storage tier', group: 'Classification', width: 13 },
  { key: 'version', header: 'Version', group: 'Classification', width: 12 },
  { key: 'isCurrent', header: 'Current version', group: 'Classification', width: 15 },
  { key: 'versionGroupId', header: 'Version group', group: 'Classification', width: 38 },
  { key: 'supersedes', header: 'Supersedes', group: 'Classification', width: 38 },

  // State — is the file actually there, and when was that last proven.
  { key: 'status', header: 'Status', group: 'State', width: 15, always: true },
  { key: 'statusCode', header: 'Status code', group: 'State', width: 14 },
  { key: 'lifecycle', header: 'Lifecycle', group: 'State', width: 18 },
  { key: 'statusDetail', header: 'Status detail', group: 'State', width: 44 },
  { key: 'checkOverdue', header: 'Check overdue', group: 'State', width: 14 },
  { key: 'lastCheckedAt', header: 'Last checked', group: 'State', width: 22 },
  { key: 'lastVerifiedAt', header: 'Last verified', group: 'State', width: 22 },
  { key: 'checkMethod', header: 'Check method', group: 'State', width: 16 },
  { key: 'hoursSinceCheck', header: 'Hours since check', group: 'State', width: 16, num: true },

  // Placement — where it sits, in the catalogue and in Drive.
  { key: 'placement', header: 'Filed as', group: 'Placement', width: 16 },
  { key: 'folder', header: 'Folder', group: 'Placement', width: 26 },
  { key: 'folderPath', header: 'Folder path', group: 'Placement', width: 40 },
  { key: 'folderTags', header: 'Folder tags', group: 'Placement', width: 26 },
  { key: 'folderId', header: 'Folder ID', group: 'Placement', width: 38 },

  // Storage — the bytes themselves.
  { key: 'size', header: 'Size', group: 'Storage', width: 12 },
  { key: 'sizeBytes', header: 'Size (bytes)', group: 'Storage', width: 15, num: true },
  { key: 'mimeType', header: 'MIME type', group: 'Storage', width: 26 },
  { key: 'duration', header: 'Duration', group: 'Storage', width: 11 },
  { key: 'durationSec', header: 'Duration (s)', group: 'Storage', width: 13, num: true },
  { key: 'dimensions', header: 'Dimensions', group: 'Storage', width: 14 },
  { key: 'driveFileId', header: 'Drive file ID', group: 'Storage', width: 38 },
  { key: 'driveName', header: 'Name in Drive', group: 'Storage', width: 38 },
  { key: 'drivePath', header: 'Path in Drive', group: 'Storage', width: 44 },
  { key: 'driveParentId', header: 'Drive parent ID', group: 'Storage', width: 38 },
  { key: 'revisionId', header: 'Revision ID', group: 'Storage', width: 30 },
  { key: 'driveLink', header: 'Drive link', group: 'Storage', width: 46 },
  { key: 'trashedInDrive', header: 'Trashed in Drive', group: 'Storage', width: 15 },
  { key: 'googleNative', header: 'Google-native', group: 'Storage', width: 14 },

  // Integrity — what makes a claim about this file provable.
  { key: 'sha256', header: 'SHA-256', group: 'Integrity', width: 66 },
  { key: 'md5', header: 'MD5', group: 'Integrity', width: 34 },
  { key: 'sha1', header: 'SHA-1', group: 'Integrity', width: 42 },
  { key: 'linkedCopy', header: 'Linked copy', group: 'Integrity', width: 12 },
  { key: 'linkedTo', header: 'Linked to', group: 'Integrity', width: 38 },

  // Release — what the song this file belongs to is.
  { key: 'tags', header: 'Tags', group: 'Release', width: 32 },
  { key: 'description', header: 'Description', group: 'Release', width: 46 },
  { key: 'language', header: 'Language', group: 'Release', width: 13 },
  { key: 'languageSource', header: 'Language stated on', group: 'Release', width: 18 },
  { key: 'mood', header: 'Mood', group: 'Release', width: 13 },
  { key: 'isrc', header: 'ISRC', group: 'Release', width: 16 },
  { key: 'releaseDate', header: 'Release date', group: 'Release', width: 14 },
  { key: 'releaseYear', header: 'Release year', group: 'Release', width: 13, num: true },
  { key: 'artistId', header: 'Artist ID', group: 'Release', width: 38 },
  { key: 'songId', header: 'Song ID', group: 'Release', width: 38 },

  // Custody — who put it here, and when anything last moved.
  { key: 'uploadedBy', header: 'Uploaded by', group: 'Custody', width: 22 },
  { key: 'uploadedById', header: 'Uploader account ID', group: 'Custody', width: 38 },
  { key: 'createdAt', header: 'Added to library', group: 'Custody', width: 22 },
  { key: 'updatedAt', header: 'Last edited', group: 'Custody', width: 22 },
  { key: 'renamedAt', header: 'Last renamed', group: 'Custody', width: 22 },
  { key: 'deletedAt', header: 'Deleted at', group: 'Custody', width: 22 },
  { key: 'driveCreatedAt', header: 'Created in Drive', group: 'Custody', width: 22 },
  { key: 'driveModifiedAt', header: 'Modified in Drive', group: 'Custody', width: 22 },

  // Distribution — where this file has been sent.
  { key: 'shareLinks', header: 'Share links', group: 'Distribution', width: 12, num: true },
  { key: 'activeShares', header: 'Active links', group: 'Distribution', width: 12, num: true },
  { key: 'externalDownloads', header: 'External downloads', group: 'Distribution', width: 17, num: true },
  { key: 'lastSharedAt', header: 'Last shared', group: 'Distribution', width: 22 },
];

const COLUMN_INDEX = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
const GROUPS = [...new Set(COLUMNS.map((c) => c.group))];

// What the table opens on. Wide enough to read as a register rather than a list, narrow
// enough that the first screenful is legible on a laptop without scrolling sideways.
// Everything else is one click away in the column picker.
const DEFAULT_COLUMNS = [
  'rowNo', 'title', 'artist', 'song', 'type', 'family', 'status', 'version',
  'folder', 'size', 'duration', 'tags', 'language', 'uploadedBy', 'createdAt', 'sha256', 'driveLink',
];

// A preset is a question somebody actually arrives with. Naming them is what stops the
// column picker from being sixty checkboxes nobody reads.
const PRESETS = [
  { id: 'default', label: 'Standard register', hint: 'The columns most people need first', columns: DEFAULT_COLUMNS },
  {
    id: 'delivery',
    label: 'Delivery sheet',
    hint: 'What a distributor or a label asks for',
    columns: ['rowNo', 'title', 'artist', 'song', 'isrc', 'type', 'format', 'version', 'language', 'languageSource', 'releaseDate', 'size', 'duration', 'sha256'],
  },
  {
    id: 'storage',
    label: 'Storage audit',
    hint: 'Drive ids, sizes, checksums and verification dates',
    columns: ['rowNo', 'title', 'assetId', 'status', 'lifecycle', 'size', 'sizeBytes', 'mimeType', 'driveFileId', 'drivePath', 'revisionId', 'sha256', 'md5', 'lastCheckedAt', 'lastVerifiedAt', 'checkOverdue'],
  },
  {
    id: 'custody',
    label: 'Chain of custody',
    hint: 'Who added what, when, and where it has been sent',
    columns: ['rowNo', 'title', 'artist', 'song', 'uploadedBy', 'createdAt', 'updatedAt', 'renamedAt', 'deletedAt', 'folder', 'shareLinks', 'activeShares', 'externalDownloads', 'lastSharedAt'],
  },
  { id: 'everything', label: 'Every column', hint: `All ${COLUMNS.length} fields the catalogue holds`, columns: COLUMNS.map((c) => c.key) },
];

/* ── Row construction ────────────────────────────────────────────────────── */

// "Launch kits / Dil Se / Stills" — the path a person recognises, built from the parent
// pointers. Hop-capped, because a cycle in hand-edited data must not hang a request.
function folderPath(folderId) {
  const names = [];
  let id = folderId;
  for (let hops = 0; id && hops < 32; hops += 1) {
    const folder = db.folders.find((f) => f._id === id);
    if (!folder) break;
    names.unshift(folder.name);
    id = folder.parentId;
  }
  return names.join(' / ');
}

// Share history, indexed once per request rather than scanned per row: a library of 40,000
// files and 300 links would otherwise be twelve million comparisons per page.
function shareIndex() {
  const now = Date.now();
  const byAsset = new Map();
  const byFolder = new Map();
  const bump = (map, key, share) => {
    if (!key) return;
    const entry = map.get(key) ?? { links: 0, active: 0, downloads: 0, lastSharedAt: null };
    entry.links += 1;
    if (!share.revokedAt && Date.parse(share.expiresAt ?? 0) > now) entry.active += 1;
    entry.downloads += Number(share.downloadCount ?? 0);
    if (!entry.lastSharedAt || String(share.createdAt) > entry.lastSharedAt) entry.lastSharedAt = share.createdAt ?? null;
    map.set(key, entry);
  };
  for (const share of db.shares) {
    if (share.target === 'FOLDER') bump(byFolder, share.targetId, share);
    else bump(byAsset, share.assetId ?? share.targetId, share);
  }
  return { byAsset, byFolder };
}

const EMPTY_SHARE = { links: 0, active: 0, downloads: 0, lastSharedAt: null };

// A folder link puts every file under that folder in front of an outsider, so a register
// that counted only asset-level links would understate exposure — which is the one number
// on this row somebody is likely to act on.
const mergeShares = (a, b) => ({
  links: a.links + b.links,
  active: a.active + b.active,
  downloads: a.downloads + b.downloads,
  lastSharedAt: [a.lastSharedAt, b.lastSharedAt].filter(Boolean).sort().pop() ?? null,
});

function buildRow(item, shares) {
  const a = shape(item);
  const drive = a.drive ?? {};
  const availability = a.availability ?? {};
  const share = mergeShares(
    shares.byAsset.get(a.assetId) ?? EMPTY_SHARE,
    (a.folderId && shares.byFolder.get(a.folderId)) || EMPTY_SHARE,
  );
  const status = availability.status ?? 'UNVERIFIED';

  return {
    // Sidecars, underscore-prefixed so they can never collide with a column key. The table
    // needs the raw status for its badge and the ids for its links; none is a column.
    _id: a.assetId,
    _status: status,
    _family: a.family,
    _songId: a.songId,
    _artistId: a.artistId,
    _folderId: a.folderId,
    _driveLink: a.driveWebViewLink ?? '',
    _tags: a.tags ?? [],
    _deleted: Boolean(a.deletedAt),

    rowNo: 0, // assigned after ordering — a position in this view, not an identity
    title: a.displayName ?? '',
    artist: a.artistName ?? '',
    song: a.songTitle ?? '',
    assetId: a.assetId ?? '',
    originalName: a.originalName ?? '',

    type: a.type ?? '',
    family: a.family ?? '',
    format: a.format ?? '',
    tier: tierOf(a.type),
    version: a.version ?? '',
    isCurrent: yesNo(a.isCurrent),
    versionGroupId: a.versionGroupId ?? '',
    supersedes: a.supersedes ?? '',

    status: STATUS_LABEL[status] ?? status,
    statusCode: status,
    lifecycle: a.permanentlyLost ? 'Permanently lost' : a.deletedAt ? 'In the recycle bin' : 'Active',
    statusDetail: availability.detail ?? '',
    checkOverdue: yesNo(a.verificationStale),
    lastCheckedAt: availability.lastCheckedAt ?? '',
    lastVerifiedAt: availability.lastVerifiedAt ?? '',
    checkMethod: availability.checkMethod ?? '',
    hoursSinceCheck: a.verificationAgeHours == null ? null : Math.round(a.verificationAgeHours),

    placement: a.songId ? 'Song asset' : 'Unfiled',
    folder: a.folderName ?? '',
    folderPath: a.folderId ? folderPath(a.folderId) : '',
    folderTags: list(a.folderTags),
    folderId: a.folderId ?? '',

    size: bytesText(drive.sizeBytes),
    sizeBytes: drive.sizeBytes ?? null,
    mimeType: a.mimeType ?? drive.mimeType ?? '',
    duration: durationText(a.durationSec ?? drive.durationSec),
    durationSec: a.durationSec ?? drive.durationSec ?? null,
    dimensions: a.dimensions ?? drive.dimensions ?? '',
    driveFileId: drive.fileId ?? '',
    driveName: drive.name ?? '',
    drivePath: drive.path ?? '',
    driveParentId: drive.parentId ?? '',
    revisionId: drive.revisionId ?? '',
    driveLink: drive.webViewLink ?? '',
    trashedInDrive: yesNo(drive.trashed),
    googleNative: yesNo(drive.googleNative),

    sha256: drive.sha256 ?? '',
    md5: drive.md5 ?? '',
    sha1: drive.sha1 ?? '',
    linkedCopy: yesNo(a.isLinkedCopy),
    linkedTo: a.linkedTo ?? '',

    tags: list(a.tags),
    description: a.description ?? '',
    // Resolved in services/assets.js: this file's own language if it has one, otherwise
    // the release's. Blank means nobody has stated one — which the register says plainly
    // rather than filling in a plausible guess.
    language: a.language ?? '',
    languageSource: a.languageSource === 'file' ? 'This file' : a.languageSource === 'release' ? 'The release' : '',
    mood: a.mood ?? '',
    isrc: item.song?.isrc ?? '',
    releaseDate: a.releaseDate ? String(a.releaseDate).slice(0, 10) : '',
    releaseYear: a.releaseYear ?? null,
    artistId: a.artistId ?? '',
    songId: a.songId ?? '',

    uploadedBy: a.uploadedByName ?? '',
    uploadedById: a.uploadedBy ?? '',
    createdAt: a.createdAt ?? '',
    updatedAt: a.updatedAt ?? '',
    renamedAt: a.renamedAt ?? '',
    deletedAt: a.deletedAt ?? '',
    driveCreatedAt: drive.createdAt ?? '',
    driveModifiedAt: drive.modifiedAt ?? '',

    shareLinks: share.links,
    activeShares: share.active,
    externalDownloads: share.downloads,
    lastSharedAt: share.lastSharedAt ?? '',
  };
}

/* ── Filtering ───────────────────────────────────────────────────────────── */

// The facet value standing for "nothing recorded here". Artist and folder already used a
// bare em dash inline; naming it keeps the three in step and makes "which files have no
// language?" an answerable question rather than a gap in a dropdown.
const NONE = '—';

const asArray = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',').filter(Boolean));
const one = (v) => (Array.isArray(v) ? v[0] : v);

// The register defaults to what is live. A deleted row is still in the catalogue and still
// matters to an audit — so it is one dropdown away rather than gone — but "how many files
// do we hold" must not silently count the recycle bin.
const LIFECYCLES = ['live', 'deleted', 'all'];

function parseFilters(query) {
  const from = String(one(query.from) ?? '').trim();
  const to = String(one(query.to) ?? '').trim();
  const fromMs = from ? Date.parse(`${from}T00:00:00.000Z`) : null;
  // Inclusive of the whole of the `to` day, which is what a person choosing a date means.
  const toMs = to ? Date.parse(`${to}T23:59:59.999Z`) : null;
  const lifecycle = String(one(query.lifecycle) ?? '');
  return {
    q: String(one(query.q) ?? '').trim().toLowerCase(),
    family: asArray(query.family),
    type: asArray(query.type),
    status: asArray(query.status),
    artist: asArray(query.artist),
    folder: asArray(query.folder),
    uploadedBy: asArray(query.uploadedBy),
    tags: asArray(query.tags),
    language: asArray(query.language),
    version: asArray(query.version),
    placement: asArray(query.placement),
    year: asArray(query.year),
    shared: ['yes', 'no', 'active'].includes(String(one(query.shared))) ? String(one(query.shared)) : '',
    lifecycle: LIFECYCLES.includes(lifecycle) ? lifecycle : 'live',
    from: from || '',
    to: to || '',
    fromMs: Number.isNaN(fromMs) ? null : fromMs,
    toMs: Number.isNaN(toMs) ? null : toMs,
    ids: asArray(query.ids),
  };
}

// Free text searches the fields somebody actually pastes into a box — a filename, a title,
// an artist, a tag, an id, a checksum. Checksums are in there because "is this file already
// in the library?" is asked by pasting a hash, and nothing else answers it in one step.
const haystack = (row) => [
  row.title, row.artist, row.song, row.originalName, row.type, row.family, row.format,
  row.tags, row.folder, row.folderPath, row.uploadedBy, row.assetId, row.driveFileId,
  row.sha256, row.md5, row.isrc, row.description, row.version, row.status,
].join('  ').toLowerCase();

function matches(row, f) {
  if (f.lifecycle === 'live' && row._deleted) return false;
  if (f.lifecycle === 'deleted' && !row._deleted) return false;
  if (f.ids.length && !f.ids.includes(row._id)) return false;
  if (f.family.length && !f.family.includes(row.family)) return false;
  if (f.type.length && !f.type.includes(row.type)) return false;
  if (f.status.length && !f.status.includes(row._status)) return false;
  if (f.artist.length && !f.artist.includes(row.artist || NONE)) return false;
  if (f.folder.length && !f.folder.includes(row.folder || NONE)) return false;
  if (f.uploadedBy.length && !f.uploadedBy.includes(row.uploadedBy)) return false;
  if (f.language.length && !f.language.includes(row.language || NONE)) return false;
  if (f.version.length && !f.version.includes(row.version)) return false;
  if (f.placement.length && !f.placement.includes(row.placement)) return false;
  if (f.year.length && !f.year.includes(String(row.releaseYear ?? ''))) return false;
  // Every chosen tag, not any of them: tags narrow, and two of them chosen together mean
  // "both", which is the only reading that lets a tag filter converge on anything.
  if (f.tags.length && !f.tags.every((t) => row._tags.includes(t))) return false;
  if (f.shared === 'yes' && row.shareLinks === 0) return false;
  if (f.shared === 'active' && row.activeShares === 0) return false;
  if (f.shared === 'no' && row.shareLinks > 0) return false;
  if (f.fromMs != null || f.toMs != null) {
    const at = Date.parse(row.createdAt);
    if (Number.isNaN(at)) return false;
    if (f.fromMs != null && at < f.fromMs) return false;
    if (f.toMs != null && at > f.toMs) return false;
  }
  if (f.q && !haystack(row).includes(f.q)) return false;
  return true;
}

const MULTI = ['family', 'type', 'status', 'artist', 'folder', 'uploadedBy', 'tags', 'language', 'version', 'placement', 'year'];

const active = (f) =>
  Boolean(f.q || f.ids.length || f.shared || f.from || f.to || f.lifecycle !== 'live' || MULTI.some((k) => f[k].length));

/* ── Ordering ────────────────────────────────────────────────────────────── */
//
// Every column sorts, in both directions, because a register whose order is fixed is a
// register somebody re-sorts in Excel — and then the file and the screen disagree about
// which rows are the first fifty.

function sortRows(rows, key, dir) {
  const column = COLUMN_INDEX[key];
  if (!column || key === 'rowNo') {
    // The default: newest first, which is how a register of arrivals is read.
    return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  const sign = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const x = a[key];
    const y = b[key];
    // Blanks sort last in both directions: an empty cell is not "smallest", it is absent,
    // and burying the answer under 300 empty rows is the commonest complaint about an
    // exported register.
    const xEmpty = x == null || x === '';
    const yEmpty = y == null || y === '';
    if (xEmpty && yEmpty) return 0;
    if (xEmpty) return 1;
    if (yEmpty) return -1;
    if (column.num) return (Number(x) - Number(y)) * sign;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * sign;
  });
}

/* ── Facets and roll-ups ─────────────────────────────────────────────────── */

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

// Grouped totals — the sheets that make the workbook a report rather than a data dump.
function rollUp(rows, get, label) {
  const groups = new Map();
  for (const row of rows) {
    const key = get(row) || '— none —';
    const entry = groups.get(key) ?? { [label]: key, files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += Number(row.sizeBytes ?? 0);
    groups.set(key, entry);
  }
  return [...groups.values()]
    .sort((a, b) => b.bytes - a.bytes || b.files - a.files)
    .map((g) => ({ ...g, size: bytesText(g.bytes) }));
}

function summarise(rows) {
  const bytes = rows.reduce((n, r) => n + Number(r.sizeBytes ?? 0), 0);
  const byStatus = {};
  for (const row of rows) byStatus[row._status] = (byStatus[row._status] ?? 0) + 1;
  return {
    files: rows.length,
    bytes,
    bytesText: bytesText(bytes),
    artists: new Set(rows.map((r) => r.artist).filter(Boolean)).size,
    songs: new Set(rows.map((r) => r.songId).filter(Boolean)).size,
    folders: new Set(rows.map((r) => r.folderId).filter(Boolean)).size,
    available: byStatus.AVAILABLE ?? 0,
    // The one figure here that means somebody has to do something today.
    needsAttention: (byStatus.MISSING ?? 0) + (byStatus.MISMATCH ?? 0) + (byStatus.TRASHED ?? 0),
    unchecked: byStatus.UNVERIFIED ?? 0,
    shared: rows.filter((r) => r.activeShares > 0).length,
    inBin: rows.filter((r) => r._deleted).length,
    byStatus,
  };
}

/* ── The register itself ─────────────────────────────────────────────────── */

// Deleted rows are built into the source set and filtered by lifecycle afterwards, so the
// recycle-bin view is a filter rather than a second code path.
const buildAll = () => {
  const shares = shareIndex();
  return allAssets({ includeDeleted: true }).map((item) => buildRow(item, shares));
};

function view(query) {
  const filters = parseFilters(query);
  const all = buildAll();
  const rows = all.filter((row) => matches(row, filters));
  const dir = String(one(query.dir)) === 'asc' ? 'asc' : 'desc';
  const sort = COLUMN_INDEX[String(one(query.sort))] ? String(one(query.sort)) : 'createdAt';
  sortRows(rows, sort, dir);
  rows.forEach((row, i) => { row.rowNo = i + 1; });
  return { all, rows, filters, sort, dir };
}

// A page ceiling, for the same reason search has one: a request that costs nothing to make
// and everything to answer is the shape of every denial of service. "All rows" on the
// client asks for 5,000, which is what this allows and no more.
const MAX_PAGE = 5_000;
// An export is one response held whole in memory. A 50,000-row register with every column
// is roughly 90 MB of XML, which is not a download, it is an outage.
const MAX_EXPORT_ROWS = 25_000;

masterLogRouter.get('/', (req, res) => {
  const page = Math.max(1, Math.min(10_000, Number(req.query.page) || 1));
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || 50));
  if (String(req.query.q ?? '').length > 200) {
    return problem(res, 422, 'Unprocessable Entity', 'That search term is too long.');
  }

  const { all, rows, filters, sort, dir } = view(req.query);

  // Facet counts are taken over every row the register could show under the current
  // lifecycle, not over the filtered set: a dropdown whose options vanish the moment one
  // is chosen cannot be used to change your mind, which is most of what a filter is for.
  const universe = all.filter((row) => (
    filters.lifecycle === 'all' ? true : filters.lifecycle === 'deleted' ? row._deleted : !row._deleted
  ));

  res.json({
    data: rows.slice((page - 1) * limit, page * limit),
    total: rows.length,
    libraryTotal: universe.length,
    page,
    limit,
    sort,
    dir,
    filtered: active(filters),
    columns: COLUMNS,
    groups: GROUPS,
    defaultColumns: DEFAULT_COLUMNS,
    presets: PRESETS,
    // The summary describes the filtered set — the tiles have to agree with the table
    // under them, or one of the two is lying.
    summary: summarise(rows),
    facets: {
      status: tally(universe, (r) => r._status),
      family: tally(universe, (r) => r.family),
      type: tally(universe, (r) => r.type),
      artist: tally(universe, (r) => r.artist || NONE),
      folder: tally(universe, (r) => r.folder || NONE),
      uploadedBy: tally(universe, (r) => r.uploadedBy),
      tags: tally(universe, (r) => r._tags),
      language: tally(universe, (r) => r.language || NONE),
      version: tally(universe, (r) => r.version),
      placement: tally(universe, (r) => r.placement),
      year: tally(universe, (r) => (r.releaseYear == null ? null : String(r.releaseYear))),
    },
    // What the date pickers can usefully be bounded to.
    earliest: universe.reduce((min, r) => (r.createdAt && (!min || r.createdAt < min) ? r.createdAt : min), null),
  });
});

/* ── Export ──────────────────────────────────────────────────────────────── */

// Which columns leave in the file. The screen sends what it is showing; anything the
// caller does not name falls back to the default set, and `all` is spelled out so a
// scripted caller can ask for the whole register without listing sixty keys.
function chosenColumns(raw) {
  const asked = asArray(raw);
  if (asked.length === 1 && asked[0] === 'all') return COLUMNS;
  const picked = asked.map((k) => COLUMN_INDEX[k]).filter(Boolean);
  return picked.length ? picked : DEFAULT_COLUMNS.map((k) => COLUMN_INDEX[k]);
}

// RFC 4180. Every field is quoted rather than only the ones that need it — a conditional
// quote is one regex away from mangling the single row that contained a comma, and the
// size difference is nothing next to being able to trust the file.
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvRow = (values) => values.map(csvCell).join(',');

// An export takes its parameters from the query string or from a JSON body, and the two
// are read identically. The body exists for one case: exporting a hand-picked selection.
// Six hundred chosen rows is twenty-two kilobytes of asset ids, and a URL that long is
// refused by proxies long before it reaches this process — so the screen POSTs the ids
// instead, and everything else about the request is unchanged.
const params = (req) => ({ ...req.query, ...(req.body ?? {}) });

function exportContext(req) {
  const query = params(req);
  const { rows, filters, sort, dir } = view(query);
  const columns = chosenColumns(query.columns);
  const truncated = rows.length > MAX_EXPORT_ROWS;
  return { rows: truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows, columns, filters, sort, dir, truncated };
}

const stampedName = (filters, ext) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const range = filters.from || filters.to ? `-${filters.from || 'start'}-to-${filters.to || 'now'}` : '';
  return safeFilename(`gcloud-master-log${range}-${stamp}.${ext}`);
};

// The provenance rows. A register with no note of what was filtered out of it is a
// register nobody should quote from — "we hold no masters for that artist" reads very
// differently once you can see the export was narrowed to one folder.
const provenance = (req, ctx, scope) => {
  const f = ctx.filters;
  const named = (label, values) => [label, values.length ? values.join(', ') : '— any —'];
  const details = [
    ['Exported at', new Date().toISOString()],
    ['Exported by', `${req.user.name} (${req.user.role})`],
    ['Scope', scope],
    ['Rows in this file', ctx.rows.length],
    ['Columns in this file', `${ctx.columns.length} of ${COLUMNS.length}`],
    ['Columns omitted', COLUMNS.filter((c) => !ctx.columns.includes(c)).map((c) => c.header).join(', ') || '— none —'],
    ['Order', `${COLUMN_INDEX[ctx.sort]?.header ?? ctx.sort} — ${ctx.dir === 'asc' ? 'ascending' : 'descending'}`],
    ['Search text', f.q || '— none —'],
    named('Status', f.status),
    named('Family', f.family),
    named('Asset type', f.type),
    named('Artist', f.artist),
    named('Folder', f.folder),
    named('Uploaded by', f.uploadedBy),
    named('Tags (all of)', f.tags),
    named('Language', f.language),
    named('Version', f.version),
    named('Filed as', f.placement),
    named('Release year', f.year),
    ['Sharing', f.shared || '— any —'],
    ['Deleted files', f.lifecycle === 'live' ? 'Excluded' : f.lifecycle === 'deleted' ? 'Only deleted files' : 'Included'],
    ['Added from', f.from || '— no lower bound —'],
    ['Added to', f.to ? `${f.to} (inclusive of the whole day)` : '— no upper bound —'],
    ['Chosen rows only', f.ids.length ? `Yes — ${f.ids.length} chosen on screen` : 'No'],
  ];
  if (ctx.truncated) {
    details.push(['Truncated', `This export hit the ${MAX_EXPORT_ROWS.toLocaleString('en-GB')}-row ceiling. Narrow the filters and export again.`]);
  }
  return details;
};

// Taking a copy of the whole register out of the building is worth a row of its own — the
// same reasoning as the activity export, and for the same reader.
const recordExport = (req, ctx, format, scope) => record(req, {
  action: 'MASTER_LOG_EXPORT',
  entity: 'masterLog',
  entityId: 'export',
  label: `Exported ${ctx.rows.length} master log ${ctx.rows.length === 1 ? 'row' : 'rows'} as ${format.toUpperCase()}`,
  after: {
    format,
    scope,
    rows: ctx.rows.length,
    columns: ctx.columns.map((c) => c.key),
    truncated: ctx.truncated,
    sort: `${ctx.sort} ${ctx.dir}`,
    filters: {
      q: ctx.filters.q, status: ctx.filters.status, family: ctx.filters.family,
      type: ctx.filters.type, artist: ctx.filters.artist, folder: ctx.filters.folder,
      uploadedBy: ctx.filters.uploadedBy, tags: ctx.filters.tags, lifecycle: ctx.filters.lifecycle,
      from: ctx.filters.from, to: ctx.filters.to, chosen: ctx.filters.ids.length,
    },
  },
});

const scopeOf = (filters) => (
  filters.ids.length ? `${filters.ids.length} rows chosen on screen`
    : active(filters) ? 'The rows matching the filters on screen'
      : 'The whole library'
);

const exportXlsx = (req, res) => {
  const ctx = exportContext(req);
  const scope = scopeOf(ctx.filters);
  const at = new Date();
  const totals = summarise(ctx.rows);

  const groupSheet = (name, label, get) => ({
    name,
    columns: [
      { key: label, header: label, width: 32 },
      { key: 'files', header: 'Files', width: 10 },
      { key: 'size', header: 'Size', width: 14 },
      { key: 'bytes', header: 'Size (bytes)', width: 16 },
    ],
    rows: rollUp(ctx.rows, get, label),
  });

  const file = workbook([
    {
      name: 'Master log',
      columns: ctx.columns.map((c) => ({ key: c.key, header: c.header, width: c.width })),
      rows: ctx.rows,
    },
    {
      name: 'Summary',
      columns: [{ key: 'measure', header: 'Measure', width: 32 }, { key: 'value', header: 'Value', width: 30 }],
      rows: [
        { measure: 'Files in this export', value: totals.files },
        { measure: 'Total size', value: totals.bytesText },
        { measure: 'Total size (bytes)', value: totals.bytes },
        { measure: 'Distinct artists', value: totals.artists },
        { measure: 'Distinct songs', value: totals.songs },
        { measure: 'Distinct folders', value: totals.folders },
        { measure: 'Available', value: totals.available },
        { measure: 'Needs attention', value: totals.needsAttention },
        { measure: 'Not checked recently', value: totals.unchecked },
        { measure: 'Shared externally right now', value: totals.shared },
        { measure: 'In the recycle bin', value: totals.inBin },
      ],
      filter: false,
    },
    groupSheet('By artist', 'Artist', (r) => r.artist),
    groupSheet('By asset type', 'Asset type', (r) => r.type),
    groupSheet('By folder', 'Folder', (r) => r.folderPath || r.folder),
    {
      name: 'Export details',
      columns: [{ key: 'setting', header: 'Setting', width: 26 }, { key: 'value', header: 'Value', width: 86 }],
      rows: provenance(req, ctx, scope).map(([setting, value]) => ({ setting, value })),
      filter: false,
    },
  ], { createdAt: at });

  const filename = stampedName(ctx.filters, 'xlsx');
  recordExport(req, ctx, 'xlsx', scope);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Length', String(file.length));
  // A generated report is never a cached one: the next request is a different moment.
  res.setHeader('Cache-Control', 'no-store');
  res.send(file);
};

const exportCsv = (req, res) => {
  const ctx = exportContext(req);
  const scope = scopeOf(ctx.filters);

  const lines = [
    csvRow(ctx.columns.map((c) => c.header)),
    ...ctx.rows.map((row) => csvRow(ctx.columns.map((c) => row[c.key]))),
  ];
  // The byte-order mark is what makes Excel on Windows read this as UTF-8 rather than as
  // the system code page — the difference between "Ranjha" and mojibake for every export
  // this library will ever produce.
  const body = Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
  const filename = stampedName(ctx.filters, 'csv');
  recordExport(req, ctx, 'csv', scope);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
};

masterLogRouter.get('/export.xlsx', exportXlsx);
masterLogRouter.post('/export.xlsx', exportXlsx);
masterLogRouter.get('/export.csv', exportCsv);
masterLogRouter.post('/export.csv', exportCsv);
