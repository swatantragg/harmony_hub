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
  ARCHIVED: {
    label: 'Archived',
    short: 'In cold storage',
    meaning: 'The file has moved to archival storage to keep long-term costs down. It still exists, but is not instantly readable.',
    next: 'Request a restore, then download once it is ready.',
  },
  RESTORING: {
    label: 'Restoring',
    short: 'Coming back from archive',
    meaning: 'A restore is in progress. Expedited takes minutes, Standard takes hours.',
    next: 'Wait for the badge to turn green — you will be notified.',
  },
  MISSING: {
    label: 'Missing',
    short: 'Not in storage',
    meaning: 'The catalogue has a record but storage has no object behind it. This is the one state that always needs a human.',
    next: 'Recover a previous version, re-upload the file, or mark it permanently lost.',
  },
  MISMATCH: {
    label: 'Mismatch',
    short: 'Differs from the record',
    meaning: 'The file is in storage but its size or checksum differs from what was catalogued — usually an out-of-band overwrite.',
    next: 'Download and inspect it, then accept storage as the truth or restore an earlier version.',
  },
};

export const FINDING_COPY: Record<string, { label: string; meaning: string }> = {
  MISSING_IN_S3: {
    label: 'Missing in storage',
    meaning: 'Catalogued here, but the object is not in the bucket. Nothing can be downloaded until this is resolved.',
  },
  UNTRACKED_IN_S3: {
    label: 'Untracked object',
    meaning: 'An object sits in the bucket with no catalogue record. It is invisible to search until it is adopted.',
  },
  SIZE_MISMATCH: {
    label: 'Size mismatch',
    meaning: 'The object is a different size from the one that was catalogued.',
  },
  ETAG_MISMATCH: {
    label: 'Checksum mismatch',
    meaning: 'The object’s checksum no longer matches the catalogue record.',
  },
  CLASS_DRIFT: {
    label: 'Storage class drift',
    meaning: 'The object moved between storage tiers. Expected after a lifecycle transition.',
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
  ASSET_REKEY: 're-keyed',
  ASSET_RESTORE: 'requested a restore for',
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
  AUTH_LOGIN: 'signed in',
  AUTH_LOGOUT: 'signed out',
};
