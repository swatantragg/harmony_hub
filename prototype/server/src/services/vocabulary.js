// Tag hygiene. A library is only as searchable as its vocabulary is consistent, and the
// fastest way to wreck that is three people typing "Raju Singh", "RajuSingh" and
// "raju-singh" over three weeks. Before a custom tag is created, the same normalisation
// and edit-distance check that would catch those runs here and offers the existing tag.
import { db } from '../db.js';
import { ASSET_TYPES, TYPE_INDEX, FAMILIES } from '../catalogue.js';

// Case, spacing, punctuation and common separators all collapse away.
export const normalise = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

// Returns existing tags a candidate might be a duplicate of, strongest first.
// `exact` means the two are the same tag once case and punctuation are ignored — the
// caller should refuse to create a second one.
export function similarTags(candidate, { limit = 5 } = {}) {
  const target = normalise(candidate);
  if (!target) return { exact: null, suggestions: [] };

  let exact = null;
  const scored = [];

  for (const tag of db.tags) {
    const other = normalise(tag.name);
    if (!other) continue;
    if (other === target) {
      if (tag.name !== String(candidate).trim()) exact = tag;
      else exact = tag;
      continue;
    }
    const distance = levenshtein(target, other);
    const longest = Math.max(target.length, other.length);
    const contains = other.includes(target) || target.includes(other);
    // Tolerance scales with length: one typo in a short tag, three in a long one.
    const tolerance = Math.max(1, Math.round(longest * 0.28));
    if (distance <= tolerance || contains) {
      scored.push({
        _id: tag._id,
        name: tag.name,
        type: tag.type,
        usageCount: tag.usageCount,
        distance,
        reason: contains && distance > tolerance ? 'contains' : distance <= 1 ? 'near-identical' : 'similar',
        confidence: Math.max(0, 1 - distance / (longest || 1)),
      });
    }
  }

  scored.sort((a, b) => b.confidence - a.confidence || b.usageCount - a.usageCount);
  return { exact, suggestions: scored.slice(0, limit) };
}

// ── Asset types ────────────────────────────────────────────────────────────
// The 21-type catalogue is the shared vocabulary; custom types extend it without
// touching it, so a team can file "Press Kit" or "Sync Licence" without waiting on a
// release. Same duplicate check as tags — a second "Presskit" helps nobody.
export function allTypes() {
  return [
    ...ASSET_TYPES.map((t) => ({ ...t, custom: false })),
    ...db.customTypes
      .filter((t) => !t.deletedAt)
      .map((t) => ({ type: t.type, family: t.family, tier: t.tier ?? 'HOT', formats: [], custom: true, _id: t._id })),
  ];
}

export const typeExists = (type) => allTypes().some((t) => t.type === type);

export function resolveFamily(type) {
  if (TYPE_INDEX[type]) return TYPE_INDEX[type].family;
  const custom = db.customTypes.find((t) => t.type === type && !t.deletedAt);
  return custom?.family ?? 'Document';
}

export function resolveTier(type) {
  if (TYPE_INDEX[type]) return TYPE_INDEX[type].tier;
  return db.customTypes.find((t) => t.type === type && !t.deletedAt)?.tier ?? 'HOT';
}

export function similarTypes(candidate, { limit = 4 } = {}) {
  const target = normalise(candidate);
  if (!target) return { exact: null, suggestions: [] };
  let exact = null;
  const scored = [];
  for (const t of allTypes()) {
    const other = normalise(t.type);
    if (other === target) { exact = t; continue; }
    const distance = levenshtein(target, other);
    const longest = Math.max(target.length, other.length);
    const tolerance = Math.max(1, Math.round(longest * 0.28));
    if (distance <= tolerance || other.includes(target) || target.includes(other)) {
      scored.push({ ...t, distance, confidence: Math.max(0, 1 - distance / (longest || 1)) });
    }
  }
  scored.sort((a, b) => b.confidence - a.confidence);
  return { exact, suggestions: scored.slice(0, limit) };
}

export { FAMILIES };
