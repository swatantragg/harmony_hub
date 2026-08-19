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

// Which families a language can be *stated on*, as opposed to inherited.
//
// A language is a property of something spoken or sung, so it is asked for on audio and
// video and on nothing else. A cover, a banner or a credits sheet has no language of its
// own — pressing somebody to answer for one produces a guess, and a guess in a register is
// worse than a blank.
//
// This governs the field, not the value. An image or a document attached to a Hindi
// release still reports Hindi in the master log, because that is inherited from the
// release rather than claimed about the file, and it is what makes "every asset for the
// Hindi catalogue" a filter that returns the artwork too.
export const LANGUAGE_FAMILIES = ['Audio', 'Video'];
export const carriesLanguage = (family) => LANGUAGE_FAMILIES.includes(family);

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

// Two roles, and the line between them is drawn at what cannot be undone.
//
// Everything used to be shared but account creation. That was a reasonable trade for a
// small team right up to the point where it meant one phished account could permanently
// destroy the library: `asset:purge` deletes a file and every revision of it, and emptying
// the Drive trash reaches files this application never touched. Neither has a backup
// behind it, so neither belongs to the role that exists so people can get on with their
// work. The split is therefore not "who is trusted" — it is "what is recoverable".
//
//   User   the working role: uploads, edits, renames, moves, soft-deletes, shares, fixes
//          storage drift. Every one of those has a way back — a soft delete goes to the
//          Drive trash and can be undone from either side.
//   Admin  everything a User can do, plus the three that cannot be taken back or that
//          nobody else should hold: permanent deletion, the account roster, and the audit
//          trail — which is a privacy surface as much as an operational one, because it
//          carries every user's addresses and movements.
export const ROLES = ['Admin', 'User'];

// The working set. Everything here has a way back: a soft delete is the Drive trash, a
// rename is a metadata patch, a move is a re-parent.
const SHARED = [
  'asset:read', 'asset:download',
  'asset:upload', 'asset:edit', 'asset:rename', 'asset:delete', 'asset:restore',
  'share:create', 'share:revoke', 'catalogue:edit', 'admin:storage',
];

// Role → capability matrix. The authorize() middleware reads this; the client reads the
// same shape from GET /api/me so a button is never shown that the server would reject.
// Moving a file between folders lives under `asset:edit` rather than a permission of its
// own: Drive moves a file by re-parenting it, so it copies nothing, risks nothing, and
// needs no special ceremony.
export const PERMISSIONS = {
  // These three are Admin-only. `asset:purge` and the Drive-trash route are additionally
  // gated on re-authentication and a typed confirmation where they are used.
  Admin: [...SHARED, 'asset:purge', 'admin:users', 'admin:activity'],
  User: [...SHARED],
};

// Accounts created before the roster settled still carry Editor, Marketing or Viewer.
// Rather than migrate the database and hope nothing was missed, every read of a role goes
// through here: an unrecognised role is a User, which is what all three of those were in
// practice — none of them could purge, manage accounts or read the activity log.
export const normaliseRole = (role) => (ROLES.includes(role) ? role : 'User');

export const can = (role, permission) => PERMISSIONS[normaliseRole(role)].includes(permission);
