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

export const AVAILABILITY = ['AVAILABLE', 'UNVERIFIED', 'ARCHIVED', 'RESTORING', 'MISSING', 'MISMATCH'];

export const ROLES = ['Admin', 'Editor', 'Marketing', 'Viewer'];

// Role → capability matrix. The authorize() middleware reads this; the client reads the
// same shape from GET /api/me so a button is never shown that the server would reject.
export const PERMISSIONS = {
  Admin: [
    'asset:read', 'asset:upload', 'asset:edit', 'asset:rename', 'asset:delete', 'asset:purge',
    'asset:rekey', 'asset:download', 'asset:restore', 'share:create', 'share:revoke',
    'catalogue:edit', 'admin:storage', 'admin:activity', 'admin:users',
  ],
  Editor: [
    'asset:read', 'asset:upload', 'asset:edit', 'asset:rename', 'asset:delete',
    'asset:download', 'asset:restore', 'catalogue:edit', 'share:create',
  ],
  Marketing: ['asset:read', 'asset:download', 'share:create', 'share:revoke'],
  Viewer: ['asset:read', 'asset:download'],
};

export const can = (role, permission) => (PERMISSIONS[role] || []).includes(permission);
