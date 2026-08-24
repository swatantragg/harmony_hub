
export const FAMILIES = ['Audio', 'Video', 'Image', 'Document'];

export const ASSET_TYPES = [
  { type: 'Master Audio', family: 'Audio', tier: 'WARM', formats: ['WAV', 'FLAC'] },
  { type: 'Demo / Scratch', family: 'Audio', tier: 'HOT', formats: ['WAV', 'MP3'] },
  { type: 'Instrumental', family: 'Audio', tier: 'WARM', formats: ['WAV'] },
  { type: 'Audio Snippet', family: 'Audio', tier: 'HOT', formats: ['MP3'] },
  { type: 'Song Snippet', family: 'Audio', tier: 'HOT', formats: ['MP3'] },
  { type: 'Horizontal Video', family: 'Video', tier: 'WARM', formats: ['16:9'] },
  { type: 'Lyrics Video Reel', family: 'Video', tier: 'WARM', formats: ['9:16'] },
  { type: 'Reel - BTS/MV', family: 'Video', tier: 'WARM', formats: ['9:16'] },
  { type: 'Artist / Investor Reel', family: 'Video', tier: 'WARM', formats: ['9:16'] },
  { type: 'BTS - Unedited Footage', family: 'Video', tier: 'COLD', formats: ['16:9'] },
  { type: 'BTS of Song', family: 'Video', tier: 'COLD', formats: ['16:9'] },
  { type: 'Event Video', family: 'Video', tier: 'COLD', formats: ['16:9'] },
  { type: 'Review Video', family: 'Video', tier: 'COLD', formats: ['16:9'] },
  { type: 'Song Cover', family: 'Image', tier: 'HOT', formats: ['1:1'] },
  { type: 'Square Cover', family: 'Image', tier: 'WARM', formats: ['1:1'] },
  { type: 'Banner Image', family: 'Image', tier: 'HOT', formats: ['16:9'] },
  { type: 'Banner + Video', family: 'Image', tier: 'WARM', formats: ['16:9'] },
  { type: 'Post on Artist Page', family: 'Image', tier: 'HOT', formats: ['4:5'] },
  { type: 'Artist Photo', family: 'Image', tier: 'HOT', formats: ['1:1'] },
  { type: 'Lyrics', family: 'Document', tier: 'HOT', formats: ['TXT', 'PDF'] },
  { type: 'Credits / Metadata Sheet', family: 'Document', tier: 'HOT', formats: ['PDF'] },
];

export const TYPE_INDEX = Object.fromEntries(ASSET_TYPES.map((t) => [t.type, t]));

export const familyOf = (type) => TYPE_INDEX[type]?.family || 'Document';
export const tierOf = (type) => TYPE_INDEX[type]?.tier || 'HOT';

export const LANGUAGE_FAMILIES = ['Audio', 'Video'];
export const carriesLanguage = (family) => LANGUAGE_FAMILIES.includes(family);

export const CONTROLLED_TAGS = {
  'Mood / theme': ['Romantic', 'Sad', 'Party', 'Acoustic', 'Viral', 'Festive', 'Devotional'],
  'Format / use': ['Promo', 'Reel', 'Teaser', 'BTS', 'Master', 'Demo', 'Lyric Video'],
};

export const LANGUAGES = ['Hindi', 'Punjabi', 'English', 'Tamil', 'Telugu', 'Marathi', 'Bengali'];
export const MOODS = ['Romantic', 'Sad', 'Party', 'Acoustic', 'Festive', 'Devotional', 'Motivational'];
export const VERSION_LABELS = ['V1', 'V2', 'V3', 'Final', 'Final Master'];

export const AVAILABILITY = ['AVAILABLE', 'UNVERIFIED', 'TRASHED', 'RESTORING', 'MISSING', 'MISMATCH'];

export const FINDING_KINDS = [
  'MISSING_IN_DRIVE', 'TRASHED_IN_DRIVE', 'UNTRACKED_IN_DRIVE', 'UNTRACKED_FOLDER',
  'SIZE_MISMATCH', 'CHECKSUM_MISMATCH', 'PARENT_DRIFT', 'NAME_DRIFT',
];

export const ROLES = ['Admin', 'User'];

const SHARED = [
  'asset:read', 'asset:download',
  'asset:upload', 'asset:edit', 'asset:rename', 'asset:delete', 'asset:restore',
  'share:create', 'share:revoke', 'catalogue:edit', 'admin:storage',
];

export const PERMISSIONS = {
  Admin: [...SHARED, 'asset:purge', 'admin:users', 'admin:activity'],
  User: [...SHARED],
};

export const normaliseRole = (role) => (ROLES.includes(role) ? role : 'User');

export const can = (role, permission) => PERMISSIONS[normaliseRole(role)].includes(permission);
