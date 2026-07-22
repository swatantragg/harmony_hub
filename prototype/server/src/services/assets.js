// Shared asset shaping. One function decides what an asset looks like on the wire, so
// the card, the drawer and the search grid never disagree.
import { db, assetContext, folderOf } from '../db.js';
import { staleness } from './storage.js';

export function shape({ asset, song, artist, folder }) {
  const { stale, ageHours } = staleness(asset);
  const f = folder ?? folderOf(asset);
  return {
    ...asset,
    songId: song?._id ?? null,
    songTitle: song?.title ?? null,
    artistId: artist?._id ?? null,
    artistName: artist?.name ?? null,
    folderId: f?._id ?? null,
    folderName: f?.name ?? null,
    folderTags: f?.tags ?? [],
    language: song?.language ?? null,
    mood: song?.mood ?? null,
    releaseDate: song?.releaseDate ?? null,
    releaseYear: song?.releaseDate ? new Date(song.releaseDate).getFullYear() : null,
    uploadedByName: db.users.find((u) => u._id === asset.uploadedBy)?.name ?? 'Unknown',
    verificationStale: stale,
    verificationAgeHours: ageHours,
  };
}

export const context = assetContext;

// Rename validation (§10.4.1 step 4). Returns a list of human-readable problems —
// the same list the dialog renders live as the user types.
const ILLEGAL = /[/\\:*?"<>|]/;

export function validateName(next, { current, siblings = [], allowExtensionChange = false }) {
  const problems = [];
  const value = String(next ?? '').trim();

  if (value.length === 0) problems.push('A name is required.');
  if (value.length > 255) problems.push('Names are limited to 255 characters.');
  if (ILLEGAL.test(value)) problems.push('These characters are not allowed: / \\ : * ? " < > |');
  if (value.startsWith('.')) problems.push('A name cannot start with a dot.');

  const currentExt = (current.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  const nextExt = (value.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (currentExt && nextExt !== currentExt && !allowExtensionChange) {
    problems.push(`The extension must stay ${currentExt} — the file itself is unchanged.`);
  }

  const clash = siblings.some(
    (a) => !a.deletedAt && a.displayName.toLowerCase() === value.toLowerCase() && a.displayName !== current,
  );
  if (clash) problems.push('Another file in the same place already uses that name.');

  return { ok: problems.length === 0, problems, value };
}
