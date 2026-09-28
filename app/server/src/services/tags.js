import { db, allAssets, live } from '../db.js';
import { CONTROLLED_TAGS, TAG_SECTIONS } from '../catalogue.js';
import { normalise } from './vocabulary.js';
import * as storage from './storage.js';
import { HEAD_CONCURRENCY } from '../config.js';

// ── Why this exists ─────────────────────────────────────────────────────────
// A tag is a string repeated across every file that carries it. There is no
// join, so renaming one meant editing every file by hand and deleting one was
// not possible at all — the name simply stayed on the files forever, turning up
// in facets and search long after it stopped meaning anything.
//
// This module owns the two operations that have to touch every carrier at once:
// rename and remove. Both run over the whole catalogue, folders included, and
// both are written to be safe to run twice.
//
// Matching is case-insensitive and punctuation-insensitive, using the same
// `normalise` that decides two tags are the same everywhere else in the app.
// That means renaming "Demo" also rewrites "demo" and "DEMO" — which is the
// point. Those three are one tag that search already treats as three, and
// unifying them is usually the reason somebody opened this screen.

export const SECTIONS = [...TAG_SECTIONS, 'Custom'];

/** Every tag array in the library: the assets', and the folders'. */
function carriers({ includeDeleted = true } = {}) {
  const out = [];
  for (const row of allAssets({ includeDeleted })) {
    if (Array.isArray(row.asset.tags)) out.push({ kind: 'asset', row, holder: row.asset });
  }
  for (const folder of db.folders) {
    if (Array.isArray(folder.tags)) out.push({ kind: 'folder', row: null, holder: folder });
  }
  return out;
}

const groupOf = (name) => {
  const key = normalise(name);
  for (const section of TAG_SECTIONS) {
    if (CONTROLLED_TAGS[section].some((n) => normalise(n) === key)) return section;
  }
  return db.tags.find((t) => normalise(t.name) === key)?.group ?? 'Custom';
};

/**
 * Every tag that exists anywhere, with how many files actually carry it.
 *
 * The count is recomputed from the files rather than read from `usageCount`,
 * which is incremented on upload and has no way of noticing an edit that took a
 * tag off a file. A number on this screen that disagrees with what clicking it
 * shows is worse than no number.
 */
export function inventory() {
  const byKey = new Map();

  const touch = (name, group) => {
    const key = normalise(name);
    if (!key) return null;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name,
        group: group ?? groupOf(name),
        variants: new Set([name]),
        fileCount: 0,
        folderCount: 0,
      });
    }
    const entry = byKey.get(key);
    entry.variants.add(name);
    return entry;
  };

  // The controlled lists first, so a name nobody has used yet still appears —
  // with a zero beside it, which is itself worth knowing.
  for (const section of TAG_SECTIONS) {
    for (const name of CONTROLLED_TAGS[section]) touch(name, section);
  }
  for (const tag of db.tags) touch(tag.name, tag.group ?? 'Custom');

  for (const { asset } of allAssets()) {
    for (const name of asset.tags ?? []) {
      const entry = touch(name);
      if (entry) entry.fileCount += 1;
    }
  }
  for (const folder of live(db.folders)) {
    for (const name of folder.tags ?? []) {
      const entry = touch(name);
      if (entry) entry.folderCount += 1;
    }
  }

  return [...byKey.values()].map((entry) => {
    const registered = db.tags.find((t) => normalise(t.name) === entry.key) ?? null;
    return {
      _id: registered?._id ?? null,
      key: entry.key,
      name: registered?.name ?? entry.name,
      group: entry.group,
      controlled: TAG_SECTIONS.some(
        (s) => CONTROLLED_TAGS[s].some((n) => normalise(n) === entry.key),
      ),
      // More than one spelling in circulation. Renaming collapses them.
      variants: [...entry.variants].sort(),
      fileCount: entry.fileCount,
      folderCount: entry.folderCount,
    };
  });
}

export function sections() {
  const all = inventory();
  return SECTIONS
    .map((group) => ({
      group,
      tags: all
        .filter((t) => t.group === group)
        .sort((a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name)),
    }))
    .filter((s) => s.tags.length > 0);
}

export const findByKey = (key) => inventory().find((t) => t.key === normalise(key)) ?? null;

/**
 * Replace one tag with another everywhere it appears.
 *
 * `to` may be a name already in use, in which case this is a merge: a file
 * carrying both ends up with one. Order is preserved, so a rename does not
 * quietly reshuffle every file's tag list.
 */
export function rename(from, to) {
  const fromKey = normalise(from);
  const toKey = normalise(to);
  const name = String(to).trim();
  if (!fromKey || !toKey) return null;

  let files = 0;
  let folders = 0;
  let merged = 0;
  const touched = [];

  for (const { kind, row, holder } of carriers()) {
    const tags = holder.tags;
    if (!tags.some((t) => normalise(t) === fromKey)) continue;

    const out = [];
    const seen = new Set();
    let mergedHere = false;
    for (const tag of tags) {
      const key = normalise(tag);
      const next = key === fromKey ? name : tag;
      const nextKey = normalise(next);
      if (seen.has(nextKey)) { mergedHere = true; continue; }
      seen.add(nextKey);
      out.push(next);
    }

    holder.tags = out;
    if (mergedHere) merged += 1;
    if (kind === 'folder') folders += 1;
    else { files += 1; if (row && !row.asset.deletedAt) touched.push(row); }
  }

  // Fold the vocabulary rows together too, keeping the busier of the two so a
  // merge does not reset a usage count that took a year to accumulate.
  const rows = db.tags.filter((t) => [fromKey, toKey].includes(normalise(t.name)));
  const keep = rows.sort((a, b) => (b.usageCount ?? 0) - (a.usageCount ?? 0))[0];
  if (keep) {
    keep.name = name;
    if (normalise(keep.group) === '' || !keep.group) keep.group = groupOf(name);
    for (const other of rows) {
      if (other === keep) continue;
      keep.usageCount = (keep.usageCount ?? 0) + (other.usageCount ?? 0);
      db.tags.splice(db.tags.indexOf(other), 1);
    }
  }

  return { from, to: name, files, folders, merged, touched };
}

/** Take a tag off everything that carries it. The files themselves are untouched. */
export function remove(target) {
  const key = normalise(target);
  if (!key) return null;

  let files = 0;
  let folders = 0;
  const touched = [];

  for (const { kind, row, holder } of carriers()) {
    if (!holder.tags.some((t) => normalise(t) === key)) continue;
    holder.tags = holder.tags.filter((t) => normalise(t) !== key);
    if (kind === 'folder') folders += 1;
    else { files += 1; if (row && !row.asset.deletedAt) touched.push(row); }
  }

  for (let i = db.tags.length - 1; i >= 0; i -= 1) {
    if (normalise(db.tags[i].name) === key) db.tags.splice(i, 1);
  }

  return { name: String(target), files, folders, touched };
}

/**
 * Push the new tag list out to Drive's appProperties, in the background.
 *
 * Deliberately not awaited by the request. The catalogue is the thing being
 * edited and it is already correct by the time this starts; Drive carries a
 * copy of the tags for people browsing at drive.google.com, and it catching up
 * a few seconds later costs nothing. Bounded, because a rename can touch
 * thousands of files and Drive will start returning 429 long before that.
 */
export function syncToDrive(touched) {
  if (!touched?.length || !storage.driveReady()) return;
  void storage.mapLimit(touched, HEAD_CONCURRENCY, (row) =>
    storage.syncMetadata(row.asset, {
      song: row.song,
      artist: row.artist,
      folder: row.folder,
      renameFile: false,
    }).catch(() => null));
}
