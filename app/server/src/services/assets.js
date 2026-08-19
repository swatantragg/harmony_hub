// Shared asset shaping. One function decides what an asset looks like on the wire, so
// the card, the drawer and the search grid never disagree.
import { db, assetContext, folderOf } from '../db.js';
import { staleness } from './storage.js';

/**
 * Where a file's language comes from, and why there are two places to look.
 *
 * Language started as a property of the *song*, which is right for the common case: the
 * six files that make up one release are all in the same language, and recording it once
 * on the release is the only way they stay in step. But most of the library is not
 * attached to a song — a loose reel, a BTS clip, an artist photo, a lyrics PDF filed in a
 * folder — and for those there was nowhere to put a language at all. They came out blank
 * everywhere, and a language filter silently excluded them.
 *
 * So a file may now carry a language of its own, asked for at upload and editable
 * afterwards, and it wins when it is set. That order is deliberate: the file-level value
 * only exists because somebody typed it about *this file*, which is a stronger statement
 * than the release's default — an English-subtitled cut of a Hindi single is exactly the
 * case that needs it. The release remains the fallback, so nothing that worked before
 * changes.
 *
 * Nothing is guessed. A file with no language on it and no song behind it reports no
 * language, rather than inheriting a plausible-looking default that no one chose.
 */
export const resolveLanguage = (asset, song) => ({
  language: asset?.language || song?.language || null,
  // A register that shows a value without saying where it came from invites the reader to
  // assume somebody chose it. This says which of the two answered.
  languageSource: asset?.language ? 'file' : song?.language ? 'release' : null,
});

export function shape({ asset, song, artist, folder }) {
  const { stale, ageHours } = staleness(asset);
  const f = folder ?? folderOf(asset);
  const { language, languageSource } = resolveLanguage(asset, song);
  return {
    ...asset,
    // Two catalogue entries can legitimately share one Drive file after de-duplication
    // linking (§10.12), so the UI needs to know it is looking at one of those rather than
    // silently showing the same size twice and confusing a storage audit.
    isLinkedCopy: Boolean(asset.linkedTo),
    linkedTo: asset.linkedTo ?? null,
    driveWebViewLink: asset.drive?.webViewLink ?? null,
    songId: song?._id ?? null,
    songTitle: song?.title ?? null,
    artistId: artist?._id ?? null,
    artistName: artist?.name ?? null,
    folderId: f?._id ?? null,
    folderName: f?.name ?? null,
    folderTags: f?.tags ?? [],
    language,
    languageSource,
    mood: song?.mood ?? null,
    releaseDate: song?.releaseDate ?? null,
    releaseYear: song?.releaseDate ? new Date(song.releaseDate).getFullYear() : null,
    uploadedByName: db.users.find((u) => u._id === asset.uploadedBy)?.name ?? 'Unknown',
    verificationStale: stale,
    verificationAgeHours: ageHours,
  };
}

export const context = assetContext;

// Rename validation (§10.4). Returns a list of human-readable problems — the same list
// the dialog renders live as the user types.
//
// Google Drive itself accepts almost anything in a name, including the characters below.
// They are still refused here, because the name is what the file downloads as, and a
// colon or a backslash in a filename is a problem on Windows and macOS long after Drive
// has happily stored it.
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
