import { DEDUPE } from '../config.js';
import { db, allAssets } from '../db.js';
import { ASSET_TYPES } from '../catalogue.js';
import { fingerprintOf } from './storage.js';


const EDIT_NOISE = [
  'copy', 'final', 'finalfinal', 'new', 'old', 'edit', 'edited', 'export', 'exported',
  'render', 'rendered', 'draft', 'version', 'ver', 'rev', 'revised', 'updated', 'update',
  'master', 'mastered', 'fix', 'fixed', 'temp', 'tmp', 'untitled', 'video', 'clip',
  'download', 'downloaded', 'whatsapp', 'compressed', 'converted', 'output', 'test',
  'hd', 'fhd', 'uhd', '4k', '1080p', '720p', '2160p', '480p', 'x264', 'x265', 'h264', 'h265',
];

const TYPE_NOISE = ASSET_TYPES.flatMap((t) => t.type.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean);

const NOISE = new Set([...EDIT_NOISE, ...TYPE_NOISE, 'bts', 'mv', 'portrait', 'logo', 'reel']);

export function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/[[({][^\])}]*[\])}]/g, ' ')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(19|20)\d{2}[-\s]?\d{2}[-\s]?\d{2}\b/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/\bv\d+\b/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Set for the length of one scan(), which asks for the same few thousand names'
// tokens millions of times — six regex passes each, every time, was most of the
// cost of a scan. The sets handed out are shared, so callers only read them.
let tokenMemo = null;

export const nameTokens = (name) => {
  const memo = tokenMemo?.get(name);
  if (memo) return memo;
  const tokens = new Set(normaliseName(name).split(' ').filter((t) => t.length > 1 && !NOISE.has(t)));
  tokenMemo?.set(name, tokens);
  return tokens;
};

function identitiesConflict(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (A.size === 0 || B.size === 0) return false;
  for (const t of A) if (B.has(t)) return false;
  return true;
}

export function nameSimilarity(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  const jaccard = shared / (A.size + B.size - shared);
  const smaller = Math.min(A.size, B.size);
  if (smaller < 2 || shared < 2) return jaccard;
  return Math.max(jaccard, (shared / smaller) * 0.92);
}


const sizeClose = (a, b) => {
  if (!a || !b) return false;
  return Math.abs(a - b) / Math.max(a, b) <= DEDUPE.sizeTolerance;
};

const durationClose = (a, b) => {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= DEDUPE.durationToleranceSec;
};

const rowOf = (row) => ({
  assetId: row.asset.assetId,
  displayName: row.asset.displayName,
  type: row.asset.type,
  family: row.asset.family,
  sizeBytes: row.asset.drive?.sizeBytes ?? 0,
  durationSec: row.asset.durationSec ?? row.asset.drive?.durationSec ?? null,
  dimensions: row.asset.dimensions ?? row.asset.drive?.dimensions ?? null,
  mimeType: row.asset.mimeType,
  fileId: row.asset.drive?.fileId ?? null,
  sha256: row.asset.drive?.sha256 ?? null,
  md5: row.asset.drive?.md5 ?? null,
  webViewLink: row.asset.drive?.webViewLink ?? null,
  folderId: row.folder?._id ?? null,
  folderName: row.folder?.name ?? null,
  songId: row.song?._id ?? null,
  songTitle: row.song?.title ?? null,
  artistName: row.artist?.name ?? null,
  tags: row.asset.tags ?? [],
  createdAt: row.asset.createdAt,
  uploadedByName: db.users.find((u) => u._id === row.asset.uploadedBy)?.name ?? 'Unknown',
  version: row.asset.version,
  isLinkedCopy: Boolean(row.asset.linkedTo),
});

function pickKeeper(rows) {
  const scored = rows.map((r) => ({
    r,
    score:
      (r.songId ? 4 : 0)
      + (r.folderId ? 3 : 0)
      + (r.tags.length ? 2 : 0)
      + (r.version && r.version !== 'V1' ? 1 : 0)
      + (r.isLinkedCopy ? -6 : 0),
  }));
  scored.sort((a, b) => b.score - a.score || Date.parse(a.r.createdAt) - Date.parse(b.r.createdAt));
  return scored[0].r;
}

const groupOf = (kind, confidence, reason, rows, extra = {}) => {
  const members = rows.map(rowOf);
  const keeper = pickKeeper(members);

  const counted = new Set([keeper.fileId]);
  let wasted = 0;
  for (const m of members) {
    if (!m.fileId || counted.has(m.fileId)) continue;
    counted.add(m.fileId);
    wasted += m.sizeBytes || 0;
  }
  return {
    _id: `dg_${kind.toLowerCase()}_${members.map((m) => m.assetId).sort().join('').slice(0, 40)}`,
    kind,
    confidence,
    reason,
    count: members.length,
    reclaimableBytes: wasted,
    spansFolders: new Set(members.map((m) => m.folderName ?? '—')).size > 1,
    folders: [...new Set(members.map((m) => m.folderName ?? 'Library root'))],
    suggestedKeepId: keeper.assetId,
    members,
    ...extra,
  };
};


export function scan(options = {}) {
  tokenMemo = new Map();
  try {
    return scanLibrary(options);
  } finally {
    tokenMemo = null;
  }
}

function scanLibrary({ level = 'all', family = null, minSizeBytes = 0 }) {
  const t0 = Date.now();
  const rows = allAssets().filter(({ asset }) => {
    if (asset.deletedAt) return false;
    if (family && asset.family !== family) return false;
    if ((asset.drive?.sizeBytes ?? 0) < minSizeBytes) return false;
    return true;
  });

  const ignored = new Set((db.dedupeIgnores || []).map((i) => i._id));
  const groups = [];
  const claimed = new Set();

  const byFingerprint = new Map();
  for (const row of rows) {
    const print = fingerprintOf(row.asset.drive);
    if (!print) continue;
    if (!byFingerprint.has(print)) byFingerprint.set(print, []);
    byFingerprint.get(print).push(row);
  }

  for (const [print, members] of byFingerprint) {
    if (members.length < 2) continue;

    const distinctFiles = new Set(members.map((m) => m.asset.drive?.fileId).filter(Boolean));
    if (distinctFiles.size <= 1) {
      for (const m of members) claimed.add(m.asset.assetId);
      continue;
    }

    for (const m of members) claimed.add(m.asset.assetId);
    groups.push(groupOf(
      'IDENTICAL',
      1,
      `Byte-for-byte identical — Google Drive reports the same ${print.startsWith('md5:') ? 'MD5' : 'SHA-256'} checksum for all ${members.length}. These are not similar files; they are the same file stored more than once.`,
      members,
      { fingerprint: print },
    ));
  }

  if (level === 'exact') {
    return summarise(groups.filter((g) => !ignored.has(g._id)), rows.length, t0, level);
  }

  const candidates = rows.filter((r) => !claimed.has(r.asset.assetId));
  const byFamily = new Map();
  for (const row of candidates) {
    if (!byFamily.has(row.asset.family)) byFamily.set(row.asset.family, []);
    byFamily.get(row.asset.family).push(row);
  }

  for (const family of byFamily.values()) {
    const ordered = [...family].sort((a, b) => (durationOf(a.asset) ?? 0) - (durationOf(b.asset) ?? 0));
    const used = new Set();
    const partnersOf = partnerFinder(ordered);

    for (let i = 0; i < ordered.length; i += 1) {
      if (used.has(i)) continue;
      const cluster = [ordered[i]];

      for (const j of partnersOf(i)) {
        if (used.has(j)) continue;
        if (sameMedia(ordered[i], ordered[j])) { cluster.push(ordered[j]); used.add(j); }
      }

      if (cluster.length < 2) continue;
      used.add(i);
      for (const m of cluster) claimed.add(m.asset.assetId);

      const a = cluster[0].asset;
      const corroborated = cluster
        .slice(1)
        .every((other) => nameSimilarity(a.displayName, other.asset.displayName) >= 0.4);
      const confidence = corroborated ? 0.85 : 0.6;

      const sizesClose = cluster
        .slice(1)
        .every((other) => sizeClose(a.drive?.sizeBytes, other.asset.drive?.sizeBytes));
      const shape = durationOf(a) != null
        ? `Same running time (${fmtDuration(durationOf(a))}) and the same dimensions${sizesClose ? ', with near-identical size' : ', though the file sizes differ — consistent with a re-encode at another bitrate'}`
        : 'Near-identical size and dimensions';

      groups.push(groupOf(
        'SAME_MEDIA',
        confidence,
        corroborated
          ? `${shape}, across ${cluster.length} files with different checksums — and the names agree once copy and export tags are stripped. Almost certainly one file re-encoded or re-exported.`
          : `${shape}, across ${cluster.length} files with different checksums. The names have nothing in common, so this could equally be two different pieces filmed to the same spec. Nothing but the contents can settle it — compare them, or turn on perceptual matching, which can.`,
        cluster,
      ));
    }
  }

  if (level === 'near') {
    return summarise(groups.filter((g) => !ignored.has(g._id)), rows.length, t0, level);
  }

  const remaining = rows.filter((r) => !claimed.has(r.asset.assetId));
  const nameGroups = new Map();
  for (const row of remaining) {
    const tokens = [...nameTokens(row.asset.displayName)].sort((a, b) => b.length - a.length);
    const key = `${row.asset.family}:${tokens[0] ?? ''}`;
    if (!key.endsWith(':')) {
      if (!nameGroups.has(key)) nameGroups.set(key, []);
      nameGroups.get(key).push(row);
    }
  }

  for (const candidateSet of nameGroups.values()) {
    if (candidateSet.length < 2) continue;
    const used = new Set();
    for (let i = 0; i < candidateSet.length; i += 1) {
      if (used.has(i)) continue;
      const cluster = [candidateSet[i]];
      for (let j = i + 1; j < candidateSet.length; j += 1) {
        if (used.has(j)) continue;
        const a = candidateSet[i].asset;
        const b = candidateSet[j].asset;
        if (a.type && b.type && a.type !== b.type) continue;
        if (nameSimilarity(a.displayName, b.displayName) >= DEDUPE.nameSimilarity) {
          cluster.push(candidateSet[j]);
          used.add(j);
        }
      }
      if (cluster.length < 2) continue;
      used.add(i);
      groups.push(groupOf(
        'SAME_NAME',
        0.45,
        `The names describe the same thing once copy suffixes, version numbers and export tags are stripped — but the files genuinely differ. Check before removing anything; these may be legitimate cuts.`,
        cluster,
      ));
    }
  }

  const withHashes = rows.filter((r) => Array.isArray(r.asset.perceptual?.frames) && r.asset.perceptual.frames.length);
  if (withHashes.length >= 2) {
    const used = new Set();
    for (let i = 0; i < withHashes.length; i += 1) {
      if (used.has(withHashes[i].asset.assetId)) continue;
      const cluster = [withHashes[i]];
      for (let j = i + 1; j < withHashes.length; j += 1) {
        if (used.has(withHashes[j].asset.assetId)) continue;
        const d = perceptualDistance(withHashes[i].asset.perceptual, withHashes[j].asset.perceptual);
        if (d != null && d <= DEDUPE.maxDistance) {
          cluster.push(withHashes[j]);
          used.add(withHashes[j].asset.assetId);
        }
      }
      if (cluster.length < 2) continue;
      used.add(withHashes[i].asset.assetId);
      groups.push(groupOf(
        'PERCEPTUAL',
        0.9,
        `The frames look the same. Perceptual hashing compared ${DEDUPE.frames} evenly-spaced frames from each file and found them within ${DEDUPE.maxDistance} bits — this catches the same footage at different resolutions, bitrates or crops, which no checksum can.`,
        cluster,
      ));
    }
  }

  return summarise(groups.filter((g) => !ignored.has(g._id)), rows.length, t0, level);
}

export const durationOf = (asset) => asset.durationSec ?? asset.drive?.durationSec ?? null;

// First index in an ascending array whose value is >= target.
function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * For one family's rows, sorted by duration: given a row, the later rows that
 * sameMedia could accept for it, in order.
 *
 * This used to be every later row. A file with no duration — every audio file
 * Drive adopted, and every image and document — never reached the loop's early
 * exit, so a family of n such files cost n²/2 comparisons: about twenty seconds
 * on one thread for a library this size, long enough for the container's health
 * check to give up on the server. Left out now are only rows sameMedia refuses
 * on sight: audio and video without a running time, images whose dimensions
 * differ, anything else whose size is out of tolerance — and, as before, rows
 * past the end of the anchor's duration window.
 */
function partnerFinder(ordered) {
  const n = ordered.length;
  const durations = ordered.map((row) => durationOf(row.asset));
  // The old loop stopped at the first later row with `other - anchor > tolerance`.
  // Rows are sorted on duration, so that is a binary search.
  const windowEnd = (i) => {
    const anchor = durations[i];
    if (anchor == null) return n;
    let lo = i + 1;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((durations[mid] ?? 0) - anchor > DEDUPE.durationToleranceSec) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const family = ordered[0]?.asset.family;

  if (family === 'Video' || family === 'Audio') {
    return (i) => {
      if (durations[i] == null) return [];
      const out = [];
      for (let j = i + 1, end = windowEnd(i); j < end; j += 1) if (durations[j] != null) out.push(j);
      return out;
    };
  }

  if (family === 'Image') {
    const byDimensions = new Map();
    ordered.forEach((row, j) => {
      const dims = row.asset.dimensions;
      if (!dims) return;
      if (!byDimensions.has(dims)) byDimensions.set(dims, []);
      byDimensions.get(dims).push(j);
    });
    return (i) => {
      const dims = ordered[i].asset.dimensions;
      if (!dims) return [];
      const end = windowEnd(i);
      return byDimensions.get(dims).filter((j) => j > i && j < end);
    };
  }

  // Everything else matches on size first: |a - b| / max(a, b) <= tolerance, so
  // b lies between a(1 - t) and a / (1 - t). A byte either side absorbs rounding;
  // sameMedia makes the exact test.
  const bySize = [];
  ordered.forEach((row, j) => { const size = row.asset.drive?.sizeBytes; if (size) bySize.push([size, j]); });
  bySize.sort((a, b) => a[0] - b[0]);
  const sizes = bySize.map(([size]) => size);
  const t = DEDUPE.sizeTolerance;
  return (i) => {
    const size = ordered[i].asset.drive?.sizeBytes;
    if (!size) return [];
    const end = windowEnd(i);
    const out = [];
    for (let k = lowerBound(sizes, size * (1 - t) - 1); k < sizes.length && sizes[k] <= size / (1 - t) + 1; k += 1) {
      const j = bySize[k][1];
      if (j > i && j < end) out.push(j);
    }
    return out.sort((a, b) => a - b);
  };
}

function sameMedia(a, b) {
  const A = a.asset;
  const B = b.asset;
  if (A.family !== B.family) return false;
  if (fingerprintOf(A.drive) && fingerprintOf(A.drive) === fingerprintOf(B.drive)) return false;

  if (A.dimensions && B.dimensions && A.dimensions !== B.dimensions) return false;

  if (A.type && B.type && A.type !== B.type) return false;

  if (identitiesConflict(A.displayName, B.displayName)) return false;

  const durA = durationOf(A);
  const durB = durationOf(B);

  if (A.family === 'Video' || A.family === 'Audio') {
    if (durA == null || durB == null) return false;
    if (!durationClose(durA, durB)) return false;

    if (!(A.dimensions && A.dimensions === B.dimensions)) {
      return nameSimilarity(A.displayName, B.displayName) >= 0.7;
    }
    return sizeClose(A.drive?.sizeBytes, B.drive?.sizeBytes)
      || nameSimilarity(A.displayName, B.displayName) >= 0.4;
  }

  if (A.family === 'Image') {
    if (!A.dimensions || A.dimensions !== B.dimensions) return false;
    return sizeClose(A.drive?.sizeBytes, B.drive?.sizeBytes)
      || nameSimilarity(A.displayName, B.displayName) >= 0.6;
  }

  return sizeClose(A.drive?.sizeBytes, B.drive?.sizeBytes)
    && nameSimilarity(A.displayName, B.displayName) >= 0.6;
}

// Each stored 64-bit frame hash as two 32-bit halves, parsed once per hash set
// rather than once per comparison — the perceptual tier compares every hashed
// file with every other.
const parsedFrames = new WeakMap();
const halvesOf = (perceptual) => {
  let halves = parsedFrames.get(perceptual);
  if (!halves) {
    halves = perceptual.frames.map((hex) => {
      const s = String(hex).padStart(16, '0');
      return [parseInt(s.slice(0, 8), 16), parseInt(s.slice(8), 16)];
    });
    parsedFrames.set(perceptual, halves);
  }
  return halves;
};

const popcount32 = (x) => {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

export function perceptualDistance(a, b) {
  if (!a?.frames?.length || !b?.frames?.length) return null;
  const B = halvesOf(b);
  const distances = halvesOf(a).map(([hiA, loA]) => {
    let best = Infinity;
    for (const [hiB, loB] of B) best = Math.min(best, popcount32(hiA ^ hiB) + popcount32(loA ^ loB));
    return best;
  });
  distances.sort((x, y) => x - y);
  return distances[Math.floor(distances.length / 2)];
}

export function hamming(a, b) {
  const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  let v = x;
  while (v) { bits += Number(v & 1n); v >>= 1n; }
  return bits;
}

const fmtDuration = (sec) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

const RANK = { IDENTICAL: 0, PERCEPTUAL: 1, SAME_MEDIA: 2, SAME_NAME: 3 };

function summarise(groups, scanned, t0, level) {
  groups.sort((a, b) =>
    (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9)
    || b.reclaimableBytes - a.reclaimableBytes
    || b.count - a.count);

  const byKind = {};
  for (const g of groups) {
    byKind[g.kind] = byKind[g.kind] || { groups: 0, files: 0, reclaimableBytes: 0 };
    byKind[g.kind].groups += 1;
    byKind[g.kind].files += g.count;
    byKind[g.kind].reclaimableBytes += g.reclaimableBytes;
  }

  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    level,
    assetsScanned: scanned,
    groups,
    byKind,
    totals: {
      groups: groups.length,
      files: groups.reduce((n, g) => n + g.count, 0),
      certainReclaimableBytes: groups.filter((g) => g.kind === 'IDENTICAL').reduce((n, g) => n + g.reclaimableBytes, 0),
      potentialReclaimableBytes: groups.reduce((n, g) => n + g.reclaimableBytes, 0),
      crossFolderGroups: groups.filter((g) => g.spansFolders).length,
    },
    perceptualEnabled: DEDUPE.perceptual,
    thresholds: {
      sizeTolerance: DEDUPE.sizeTolerance,
      durationToleranceSec: DEDUPE.durationToleranceSec,
      nameSimilarity: DEDUPE.nameSimilarity,
      perceptualMaxDistance: DEDUPE.maxDistance,
    },
  };
}
