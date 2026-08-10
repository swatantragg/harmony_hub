// De-duplication (§10.12).
//
// The problem this solves, stated the way it actually turns up: the same music video sits
// in "Reels", in "Client delivery", and in "Final exports", under three different names,
// and nobody can tell whether they are the same file or three different edits — so nobody
// deletes any of them, and the Drive fills up.
//
// There is no single test for "the same video", so this runs a ladder of them, cheapest
// and most certain first. Every tier says how confident it is, and *nothing is ever
// deleted automatically* — the engine proposes groups, a human decides.
//
//   TIER 1  IDENTICAL      Byte-for-byte the same file. Decided by checksum, so it is not
//                          a guess: Google computes sha256 and md5 on every upload, which
//                          means this tier costs nothing to run and cannot be wrong.
//                          This is the tier that catches "same video in three folders".
//
//   TIER 2  SAME_MEDIA     Different bytes, same content. A 1080p export and a re-encode
//                          of it have different checksums but the same duration to the
//                          second, the same dimensions, and near-identical size. Certain
//                          enough to group, not certain enough to act on unattended.
//
//   TIER 3  SAME_NAME      Different content, same intent — "Teaser.mp4", "Teaser (1).mp4",
//                          "Teaser_final_v2.mp4". Decided on a normalised-name similarity
//                          that strips the noise humans add when they copy a file. The
//                          weakest signal, and always shown as "worth a look" rather than
//                          "these are duplicates".
//
//   TIER 4  PERCEPTUAL     Visually the same footage regardless of encoding, resolution or
//                          container. Requires ffmpeg and reading the files back out of
//                          Drive, so it is opt-in (DEDUPE_PERCEPTUAL) and runs as a batch
//                          job rather than inside a request. See services/perceptual.js.
//
// The whole first tier is free because Google computes the checksums itself, on arrival,
// for every file. Nothing here has to read a byte or trust a client to have hashed
// honestly — which is what makes tier 1 a fact rather than a claim.
import { DEDUPE } from '../config.js';
import { db, allAssets } from '../db.js';
import { ASSET_TYPES } from '../catalogue.js';
import { fingerprintOf } from './storage.js';

// ── Name normalisation ──────────────────────────────────────────────────────
// Everything people add to a filename when they duplicate it, removed. The goal is that
// "Sanam Teri Qasam - Teaser (2) FINAL_v3 copy.mp4" and "sanam teri qasam teaser.mov"
// reduce to the same token set.

const EDIT_NOISE = [
  'copy', 'final', 'finalfinal', 'new', 'old', 'edit', 'edited', 'export', 'exported',
  'render', 'rendered', 'draft', 'version', 'ver', 'rev', 'revised', 'updated', 'update',
  'master', 'mastered', 'fix', 'fixed', 'temp', 'tmp', 'untitled', 'video', 'clip',
  'download', 'downloaded', 'whatsapp', 'compressed', 'converted', 'output', 'test',
  'hd', 'fhd', 'uhd', '4k', '1080p', '720p', '2160p', '480p', 'x264', 'x265', 'h264', 'h265',
];

// Every word that appears in an asset *type* — "song cover", "master audio", "reel bts mv",
// "credits metadata sheet". These describe what kind of file it is, and the catalogue
// already records that structurally in `asset.type`.
//
// They must not count as identity, and getting this wrong is not a subtle failure. In a
// library where every one of twelve songs has a file called `<song>_song_cover.svg`, a
// comparison that treats "song cover" as part of the name finds that all twelve match each
// other, and the duplicates screen opens on twelve unrelated covers presented as copies.
// Strip them and `dil_se_song_cover` reduces to "dil se" — the song, which is the actual
// identity — while `dil_se_reel_bts_mv_v1` and `dil_se_reel_bts_mv_v2_FINAL` both reduce to
// "dil se" too and still match each other, which is the case that matters.
const TYPE_NOISE = ASSET_TYPES.flatMap((t) => t.type.toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean);

const NOISE = new Set([...EDIT_NOISE, ...TYPE_NOISE, 'bts', 'mv', 'portrait', 'logo', 'reel']);

export function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')                    // extension
    .replace(/[[({][^\])}]*[\])}]/g, ' ')               // bracketed anything, incl. "(1)"
    // Separators are flattened to spaces *before* the pattern strips below, not after.
    // The order matters more than it looks: `_` is a word character to a JS regex, so in
    // `dil_se_reel_mv_v1` there is no word boundary in front of `v1` and `\bv\d+\b` does
    // not match it. Underscore-separated names are what video exports are actually called,
    // so with the strips running first, every version suffix in the library survived — and
    // two cuts of one reel scored 0.61 against each other instead of 1.0.
    .replace(/[_\-.]+/g, ' ')
    .replace(/\b(19|20)\d{2}[-\s]?\d{2}[-\s]?\d{2}\b/g, ' ')  // embedded dates
    .replace(/\b\d{6,}\b/g, ' ')                        // camera / export timestamps
    .replace(/\bv\d+\b/g, ' ')                          // v2, v10
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')                  // keeps Devanagari, Gurmukhi, etc.
    .replace(/\s+/g, ' ')
    .trim();
}

// What is left of a name once the edit noise and the type words are gone: the identity.
// For `chandni_raat_reel_bts_mv_FINAL_v2.mp4` that is {chandni, raat} — the song.
export const nameTokens = (name) =>
  new Set(normaliseName(name).split(' ').filter((t) => t.length > 1 && !NOISE.has(t)));

// Two names that each say what they are about, and disagree, are evidence *against* being
// the same file — not merely an absence of evidence for it. Six artist portraits share a
// size and a shape and nothing else; "raju singh" and "meera nair" is the catalogue telling
// us so, and it should be believed.
function identitiesConflict(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (A.size === 0 || B.size === 0) return false; // Nothing to go on either way.
  for (const t of A) if (B.has(t)) return false;
  return true;
}

// Jaccard over token sets, nudged upward when one name is wholly contained in the other —
// "dil se reel" vs "dil se reel final cut" should score high, and raw Jaccard gives it 0.6.
//
// The containment bonus is deliberately withheld when the shorter name has fewer than two
// meaningful tokens. Otherwise "teaser.mp4" is 100% contained in "longway_teaser.mp4" and
// every file in the library sharing one generic word — teaser, promo, master, reel —
// collapses into one enormous false group. Containment is only evidence when there is
// enough of it to be evidence.
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

// ── Grouping ────────────────────────────────────────────────────────────────

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

// Which copy to suggest keeping. Deliberately conservative and explainable, because an
// admin has to be able to disagree with it in one glance: prefer the one somebody filed
// (a folder and a song beat a loose file), then the oldest, because that is the one other
// records and share links are most likely to point at.
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

  // Space is counted once per distinct Drive file, never per catalogue entry. Two entries
  // pointing at one file waste nothing, and a number that claimed otherwise would be
  // discovered as a lie the moment somebody acted on it and checked their quota.
  const counted = new Set([keeper.fileId]);
  let wasted = 0;
  for (const m of members) {
    if (!m.fileId || counted.has(m.fileId)) continue;
    counted.add(m.fileId);
    wasted += m.sizeBytes || 0;
  }
  return {
    // Stable across scans, so "ignored" survives a re-run.
    _id: `dg_${kind.toLowerCase()}_${members.map((m) => m.assetId).sort().join('').slice(0, 40)}`,
    kind,
    confidence,
    reason,
    count: members.length,
    // Only counts bytes that are genuinely a second copy in Drive. Two catalogue records
    // pointing at one Drive file waste nothing, and claiming otherwise would be a lie the
    // admin discovers the moment they check their quota.
    reclaimableBytes: wasted,
    spansFolders: new Set(members.map((m) => m.folderName ?? '—')).size > 1,
    folders: [...new Set(members.map((m) => m.folderName ?? 'Library root'))],
    suggestedKeepId: keeper.assetId,
    members,
    ...extra,
  };
};

// ── The scan ────────────────────────────────────────────────────────────────

export function scan({ level = 'all', family = null, minSizeBytes = 0 } = {}) {
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

  // ── Tier 1: identical bytes ───────────────────────────────────────────────
  const byFingerprint = new Map();
  for (const row of rows) {
    const print = fingerprintOf(row.asset.drive);
    if (!print) continue;
    if (!byFingerprint.has(print)) byFingerprint.set(print, []);
    byFingerprint.get(print).push(row);
  }

  for (const [print, members] of byFingerprint) {
    if (members.length < 2) continue;

    // Two catalogue records pointing at the *same* Drive file are not duplicated storage —
    // that is the "link instead of delete" resolution having already been applied, and it
    // is the desired end state. They are claimed rather than merely skipped, so the later
    // and vaguer tiers do not rediscover them and report a solved problem as a new one.
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

  // ── Tier 2: same media, different encoding ────────────────────────────────
  // Compares within one family only, and for video and audio requires the running time to
  // agree — a re-encode changes every byte but not the duration.
  const candidates = rows.filter((r) => !claimed.has(r.asset.assetId));
  const byFamily = new Map();
  for (const row of candidates) {
    if (!byFamily.has(row.asset.family)) byFamily.set(row.asset.family, []);
    byFamily.get(row.asset.family).push(row);
  }

  for (const family of byFamily.values()) {
    // Sorted by duration and swept with a moving window, rather than binned by rounded
    // duration. Binning looks equivalent and is not: a 30 s and a 31 s cut of the same
    // video land either side of a bin edge and are never compared — which is exactly the
    // pair this tier exists to catch.
    const ordered = [...family].sort((a, b) => (durationOf(a.asset) ?? 0) - (durationOf(b.asset) ?? 0));
    const used = new Set();

    for (let i = 0; i < ordered.length; i += 1) {
      if (used.has(i)) continue;
      const cluster = [ordered[i]];
      const anchor = durationOf(ordered[i].asset);

      for (let j = i + 1; j < ordered.length; j += 1) {
        if (used.has(j)) continue;
        // Once the window is past the tolerance, nothing further along can match either,
        // so the sweep stops rather than scanning the whole family.
        const other = durationOf(ordered[j].asset);
        if (anchor != null && other != null && other - anchor > DEDUPE.durationToleranceSec) break;
        if (sameMedia(ordered[i], ordered[j])) { cluster.push(ordered[j]); used.add(j); }
      }

      if (cluster.length < 2) continue;
      used.add(i);
      for (const m of cluster) claimed.add(m.asset.assetId);

      const a = cluster[0].asset;
      // Whether the names corroborate the metadata decides how loudly this group speaks.
      // Same duration, same dimensions and near-identical size is a real signal — but two
      // unrelated 30-second vertical reels look exactly like that too, and saying "almost
      // certainly the same video" about them would be false. So the confidence and the
      // wording both follow the evidence rather than the tier.
      const corroborated = cluster
        .slice(1)
        .every((other) => nameSimilarity(a.displayName, other.asset.displayName) >= 0.4);
      // Grouped on size alone, with the names in disagreement. Worth showing, not worth
      // asserting — and the wording below says which of the two it is.
      const confidence = corroborated ? 0.85 : 0.6;

      // The reason has to describe what was actually compared. A pair grouped on matching
      // names despite very different sizes must not be told it has "near-identical size" —
      // an admin who checks and finds a 50 MB file next to a 12 MB one stops believing the
      // rest of the sentence too.
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

  // ── Tier 3: same name, different everything ───────────────────────────────
  const remaining = rows.filter((r) => !claimed.has(r.asset.assetId));
  const nameGroups = new Map();
  for (const row of remaining) {
    // Group on the longest token so the O(n²) comparison stays inside small sets.
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
        // Same guard as tier 2, for the same reason. Every song in the library has a
        // master and a snippet that share a name stem; they are named alike because they
        // are about the same song, not because one is a copy of the other, and the
        // operator said so by giving them different types.
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

  // ── Tier 4: perceptual, when the hashes have been computed ────────────────
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

function sameMedia(a, b) {
  const A = a.asset;
  const B = b.asset;
  if (A.family !== B.family) return false;
  if (fingerprintOf(A.drive) && fingerprintOf(A.drive) === fingerprintOf(B.drive)) return false; // Tier 1's job.

  // Two files whose dimensions are both known and disagree are not the same export.
  // Checked before anything else and never overridden: a 1920×1080 master and a 1080×1920
  // vertical cut can share a running time, a size and half a filename, and they are still
  // two different deliverables. Letting a name score outvote this is how a de-duplication
  // tool starts proposing that somebody delete their vertical edit.
  if (A.dimensions && B.dimensions && A.dimensions !== B.dimensions) return false;

  // A declared type disagreement is the catalogue saying these are different things, and
  // somebody typed it deliberately. A Master Audio and an Audio Snippet of the same song
  // will always share a name stem and often a duration; they are not duplicates of each
  // other. Byte-identical files are still caught, whatever their types — that is tier 1's
  // job, and it does not consult this.
  if (A.type && B.type && A.type !== B.type) return false;

  // Names that each identify something, and identify different things.
  if (identitiesConflict(A.displayName, B.displayName)) return false;

  const durA = durationOf(A);
  const durB = durationOf(B);

  if (A.family === 'Video' || A.family === 'Audio') {
    if (durA == null || durB == null) return false;
    if (!durationClose(durA, durB)) return false;

    // Duration and dimensions agreeing is necessary but nowhere near sufficient. Every
    // 30-second vertical reel in a music library has the same duration and the same
    // dimensions as every other one; grouping on that alone would put the entire promo
    // catalogue in one pile. So a third, independent signal is required.
    //
    // Size deliberately is not that signal on its own for this family: a re-encode at a
    // lower bitrate is the exact case this tier exists to catch, and it changes the size
    // enormously. Either the sizes are close (a re-export at the same settings) or the
    // names corroborate (a re-encode somebody named sensibly). With neither, the metadata
    // genuinely cannot tell these apart, and the honest answer is to leave them to the
    // perceptual tier rather than to assert something unprovable.
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

// Best-alignment Hamming distance between two frame-hash sequences. Comparing frame i to
// frame i only would fail on two cuts of the same video with different lead-ins, so each
// frame is matched to its nearest counterpart and the median of those is the score.
export function perceptualDistance(a, b) {
  if (!a?.frames?.length || !b?.frames?.length) return null;
  const distances = a.frames.map((fa) => Math.min(...b.frames.map((fb) => hamming(fa, fb))));
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
      // Only the certain tier is counted as guaranteed savings. Adding the speculative
      // tiers to the headline number would overstate it, and an admin who acts on an
      // overstated number and gets less back stops trusting the tool.
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
