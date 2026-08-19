// The catalogue, mirrored from the server. Kept as a const union so the compiler
// enforces the 21 types end to end.
import type { Availability, Family } from './types';

export const FAMILIES: Family[] = ['Audio', 'Video', 'Image', 'Document'];

export const ASSET_TYPES = [
  { type: 'Master Audio', family: 'Audio', tier: 'WARM' },
  { type: 'Demo / Scratch', family: 'Audio', tier: 'HOT' },
  { type: 'Instrumental', family: 'Audio', tier: 'WARM' },
  { type: 'Audio Snippet', family: 'Audio', tier: 'HOT' },
  { type: 'Song Snippet', family: 'Audio', tier: 'HOT' },
  { type: 'Horizontal Video', family: 'Video', tier: 'WARM' },
  { type: 'Lyrics Video Reel', family: 'Video', tier: 'WARM' },
  { type: 'Reel - BTS/MV', family: 'Video', tier: 'WARM' },
  { type: 'Artist / Investor Reel', family: 'Video', tier: 'WARM' },
  { type: 'BTS - Unedited Footage', family: 'Video', tier: 'COLD' },
  { type: 'BTS of Song', family: 'Video', tier: 'COLD' },
  { type: 'Event Video', family: 'Video', tier: 'COLD' },
  { type: 'Review Video', family: 'Video', tier: 'COLD' },
  { type: 'Song Cover', family: 'Image', tier: 'HOT' },
  { type: 'Square Cover', family: 'Image', tier: 'WARM' },
  { type: 'Banner Image', family: 'Image', tier: 'HOT' },
  { type: 'Banner + Video', family: 'Image', tier: 'WARM' },
  { type: 'Post on Artist Page', family: 'Image', tier: 'HOT' },
  { type: 'Artist Photo', family: 'Image', tier: 'HOT' },
  { type: 'Lyrics', family: 'Document', tier: 'HOT' },
  { type: 'Credits / Metadata Sheet', family: 'Document', tier: 'HOT' },
] as const;

export const familyOf = (type: string): Family =>
  (ASSET_TYPES.find((t) => t.type === type)?.family as Family) ?? 'Document';

export const CONTROLLED_TAGS: Record<string, string[]> = {
  'Mood / theme': ['Romantic', 'Sad', 'Party', 'Acoustic', 'Viral', 'Festive', 'Devotional'],
  'Format / use': ['Promo', 'Reel', 'Teaser', 'BTS', 'Master', 'Demo', 'Lyric Video'],
};

export const VERSION_LABELS = ['V1', 'V2', 'V3', 'Final', 'Final Master'];

// Plain-language copy for each availability state. Written so a new user understands
// the state and what to do about it without reading documentation — this table is the
// backbone of the sub-two-day learning curve.
export const STATUS_COPY: Record<Availability, { label: string; short: string; meaning: string; next: string }> = {
  AVAILABLE: {
    label: 'Available',
    short: 'In storage, verified',
    meaning: 'The file is in storage and matches what the catalogue says it should be.',
    next: 'Preview, download and share all work normally.',
  },
  UNVERIFIED: {
    label: 'Not checked',
    short: 'Not checked recently',
    meaning: 'Nobody has confirmed this file against storage in the last 24 hours. It is probably fine — it just has not been proven.',
    next: 'Use “Verify now” for a definitive answer in under a second.',
  },
  TRASHED: {
    label: 'In the bin',
    short: 'Trashed in Google Drive',
    meaning: 'Somebody moved this file to the Google Drive trash. It still exists and nothing is lost yet — but Google deletes trashed files permanently after 30 days, and after that no backup here can bring it back.',
    next: 'Restore it now. One click, instant, free — and the clock is running.',
  },
  RESTORING: {
    label: 'Restoring',
    short: 'Coming back from the bin',
    meaning: 'A restore from the Google Drive trash is in flight. Unlike an archive retrieval this takes about a second.',
    next: 'Wait for the badge to turn green — it will not be long.',
  },
  MISSING: {
    label: 'Missing',
    short: 'Not in Google Drive',
    meaning: 'The catalogue has a record but Google Drive has no file behind it — permanently deleted, or moved somewhere the connected account cannot see. This is the one state that always needs a human.',
    next: 'Recover a previous version, re-upload the file, or mark it permanently lost.',
  },
  MISMATCH: {
    label: 'Mismatch',
    short: 'Differs from the record',
    meaning: 'The file is in Drive but its size or checksum differs from what was catalogued — somebody replaced it in Google Drive rather than through GCloud.',
    next: 'Preview it, then accept Drive as the truth or restore an earlier revision.',
  },
};

// Half of these describe somebody rearranging files by hand in drive.google.com rather
// than anything being broken — the ordinary consequence of the storage being a place
// people can open and rearrange themselves.
export const FINDING_COPY: Record<string, { label: string; meaning: string }> = {
  MISSING_IN_DRIVE: {
    label: 'Missing in Google Drive',
    meaning: 'Catalogued here, but Google Drive has no file with this id. Either it was deleted permanently, or it was moved outside the GCloud folder where this account can no longer see it.',
  },
  TRASHED_IN_DRIVE: {
    label: 'In the Drive bin',
    meaning: 'Somebody moved a catalogued file to the Google Drive trash. Google deletes trashed files permanently after 30 days — restore it before that happens.',
  },
  UNTRACKED_IN_DRIVE: {
    label: 'Untracked file',
    meaning: 'A file sits in the GCloud Drive folder with no catalogue record — dropped in through Google Drive rather than uploaded here. It is invisible to search until it is adopted.',
  },
  UNTRACKED_FOLDER: {
    label: 'Untracked folder',
    meaning: 'A folder exists in Drive with no GCloud folder behind it. Adopt it to make its contents browsable and searchable here.',
  },
  SIZE_MISMATCH: {
    label: 'Size mismatch',
    meaning: 'The file is a different size from the one that was catalogued — it was replaced in Google Drive rather than through GCloud.',
  },
  CHECKSUM_MISMATCH: {
    label: 'Checksum mismatch',
    meaning: 'Same size, different contents. Google’s own checksum no longer matches the catalogue record.',
  },
  PARENT_DRIFT: {
    label: 'Moved in Google Drive',
    meaning: 'Somebody dragged this file into a different folder in Drive. Nothing is damaged — the catalogue simply now points at the wrong shelf.',
  },
  NAME_DRIFT: {
    label: 'Renamed in Google Drive',
    meaning: 'The file was renamed in Drive and the catalogue still shows the old name. Harmless, but the two disagreeing is confusing for everybody.',
  },
};

export const ACTION_COPY: Record<string, string> = {
  ASSET_UPLOAD: 'uploaded',
  ASSET_RENAME: 'renamed',
  ASSET_UPDATE: 'edited',
  ASSET_VERIFY: 'verified',
  ASSET_VERIFY_BATCH: 'bulk-verified',
  ASSET_DOWNLOAD: 'downloaded',
  ASSET_SOFT_DELETE: 'deleted',
  ASSET_RESTORE_DELETED: 'restored',
  ASSET_PURGE: 'purged',
  ASSET_MOVE: 'moved',
  ASSET_REPLACE: 'replaced the contents of',
  ASSET_RESTORE: 'restored from the bin',
  DEDUPE_TRASH: 'removed duplicates of',
  DEDUPE_LINK: 'linked duplicates of',
  DEDUPE_VERSION: 'grouped as versions',
  DEDUPE_IGNORE: 'dismissed a duplicate group',
  DEDUPE_PERCEPTUAL_BUILD: 'built perceptual hashes',
  DRIVE_TRASH_EMPTY: 'emptied the Drive trash',
  FOLDER_CREATE: 'created folder',
  FOLDER_UPDATE: 'updated folder',
  FOLDER_DELETE: 'deleted folder',
  FOLDER_MOVE: 'moved files between folders',
  SHARE_CREATE: 'shared',
  SHARE_REVOKE: 'revoked a link for',
  SHARE_ACCESS: 'externally downloaded',
  RECONCILE_RUN: 'ran reconciliation',
  DRIFT_REMEDIATE: 'remediated',
  ARTIST_CREATE: 'created artist',
  ARTIST_UPDATE: 'updated artist',
  SONG_CREATE: 'created song',
  SONG_UPDATE: 'updated song',
  TAG_CREATE: 'created tag',
  TAG_PROMOTE: 'promoted tag',
  USER_CREATE: 'created user',
  USER_UPDATE: 'updated user',
  MASTER_LOG_EXPORT: 'exported the master log',
  AUTH_LOGIN: 'signed in',
  AUTH_LOGOUT: 'signed out',
};

// Which families a language can be *stated on*, as opposed to inherited. Mirrored from
// the server's catalogue.js, and enforced there too.
//
// A language is a property of something spoken or sung, so the field is offered on audio
// and video and on nothing else. A cover, a banner or a credits sheet has no language of
// its own, and pressing somebody to answer for one produces a guess.
//
// This governs the field, not the value: an image attached to a Hindi release still
// reports Hindi in the master log, because that is inherited from the release rather than
// claimed about the file — which is what makes "every asset for the Hindi catalogue" a
// filter that returns the artwork too.
export const LANGUAGE_FAMILIES: Family[] = ['Audio', 'Video'];
export const carriesLanguage = (family: string | null | undefined) =>
  LANGUAGE_FAMILIES.includes(family as Family);
