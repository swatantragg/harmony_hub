// The asset type catalogue — four families, 21 types. Shared verbatim with the client
// (client/src/lib/assetTypes.ts). Every asset carries exactly one type, and the type
// drives the card icon, the facet, and the storage tier at upload.

export const FAMILIES = ['Audio', 'Video', 'Image', 'Document'];

export const ASSET_TYPES = [
  // Audio — 5
  { type: 'Master Audio', family: 'Audio', tier: 'WARM', formats: ['WAV', 'FLAC'] },
  { type: 'Demo / Scratch', family: 'Audio', tier: 'HOT', formats: ['WAV', 'MP3'] },
  { type: 'Instrumental', family: 'Audio', tier: 'WARM', formats: ['WAV'] },
  { type: 'Audio Snippet', family: 'Audio', tier: 'HOT', formats: ['MP3'] },
  { type: 'Song Snippet', family: 'Audio', tier: 'HOT', formats: ['MP3'] },
  // Video — 8
  { type: 'Horizontal Video', family: 'Video', tier: 'WARM', formats: ['16:9'] },
  { type: 'Lyrics Video Reel', family: 'Video', tier: 'WARM', formats: ['9:16'] },
  { type: 'Reel - BTS/MV', family: 'Video', tier: 'WARM', formats: ['9:16'] },
  { type: 'Artist / Investor Reel', family: 'Video', tier: 'WARM', formats: ['9:16'] },
  { type: 'BTS - Unedited Footage', family: 'Video', tier: 'COLD', formats: ['16:9'] },
  { type: 'BTS of Song', family: 'Video', tier: 'COLD', formats: ['16:9'] },
  { type: 'Event Video', family: 'Video', tier: 'COLD', formats: ['16:9'] },
  { type: 'Review Video', family: 'Video', tier: 'COLD', formats: ['16:9'] },
  // Image — 6
  { type: 'Song Cover', family: 'Image', tier: 'HOT', formats: ['1:1'] },
  { type: 'Square Cover', family: 'Image', tier: 'WARM', formats: ['1:1'] },
  { type: 'Banner Image', family: 'Image', tier: 'HOT', formats: ['16:9'] },
  { type: 'Banner + Video', family: 'Image', tier: 'WARM', formats: ['16:9'] },
  { type: 'Post on Artist Page', family: 'Image', tier: 'HOT', formats: ['4:5'] },
  { type: 'Artist Photo', family: 'Image', tier: 'HOT', formats: ['1:1'] },
  // Document — 2
  { type: 'Lyrics', family: 'Document', tier: 'HOT', formats: ['TXT', 'PDF'] },
  { type: 'Credits / Metadata Sheet', family: 'Document', tier: 'HOT', formats: ['PDF'] },
];

export const TYPE_INDEX = Object.fromEntries(ASSET_TYPES.map((t) => [t.type, t]));

export const familyOf = (type) => TYPE_INDEX[type]?.family || 'Document';
export const tierOf = (type) => TYPE_INDEX[type]?.tier || 'HOT';

// Controlled tag vocabulary (§11.2 of v2). Editors pick from these; custom tags are
// free-form and surface in the Admin review queue for promotion.
export const CONTROLLED_TAGS = {
  'Mood / theme': ['Romantic', 'Sad', 'Party', 'Acoustic', 'Viral', 'Festive', 'Devotional'],
  'Format / use': ['Promo', 'Reel', 'Teaser', 'BTS', 'Master', 'Demo', 'Lyric Video'],
};

export const LANGUAGES = ['Hindi', 'Punjabi', 'English', 'Tamil', 'Telugu', 'Marathi', 'Bengali'];
export const MOODS = ['Romantic', 'Sad', 'Party', 'Acoustic', 'Festive', 'Devotional', 'Motivational'];
export const VERSION_LABELS = ['V1', 'V2', 'V3', 'Final', 'Final Master'];

// The states a file can be in, as Google Drive defines them. TRASHED is a file somebody
// binned — recoverable, but on a 30-day clock. RESTORING covers the brief window while one
// is being pulled back out.
export const AVAILABILITY = ['AVAILABLE', 'UNVERIFIED', 'TRASHED', 'RESTORING', 'MISSING', 'MISMATCH'];

// What reconciliation can report. Half of these describe somebody rearranging files by
// hand in Drive rather than anything being broken.
export const FINDING_KINDS = [
  'MISSING_IN_DRIVE', 'TRASHED_IN_DRIVE', 'UNTRACKED_IN_DRIVE', 'UNTRACKED_FOLDER',
  'SIZE_MISMATCH', 'CHECKSUM_MISMATCH', 'PARENT_DRIFT', 'NAME_DRIFT',
];

// Two roles, and only one thing separates them. A User does everything an Admin does —
// uploads, edits, deletes, shares, reads the activity log, fixes storage drift — because
// splitting a small team's library into tiers of read-only spectators cost more in
// "who can do this for me?" than it ever saved. What a User cannot do is create another
// account, so the roster stays a deliberate decision by one person.
export const ROLES = ['Admin', 'User'];

// The permission every capability is checked against. `admin:users` is the single entry
// that appears under Admin and not under User — everything above it is shared.
const SHARED = [
  'asset:read', 'asset:upload', 'asset:edit', 'asset:rename', 'asset:delete', 'asset:purge',
  'asset:download', 'asset:restore', 'share:create', 'share:revoke',
  'catalogue:edit', 'admin:storage', 'admin:activity',
];

// Role → capability matrix. The authorize() middleware reads this; the client reads the
// same shape from GET /api/me so a button is never shown that the server would reject.
// Moving a file between folders lives under `asset:edit` rather than a permission of its
// own: Drive moves a file by re-parenting it, so it copies nothing, risks nothing, and
// needs no special ceremony.
export const PERMISSIONS = {
  Admin: [...SHARED, 'admin:users'],
  User: [...SHARED],
};

// Accounts created before the roster collapsed to two roles still carry Editor, Marketing
// or Viewer. Rather than migrate the database and hope nothing was missed, every read of a
// role goes through here: an unrecognised role is a User, which is exactly the intent.
export const normaliseRole = (role) => (ROLES.includes(role) ? role : 'User');

export const can = (role, permission) => PERMISSIONS[normaliseRole(role)].includes(permission);
