// TRASHED is a file somebody moved to the Google Drive bin. Recoverable — but Drive empties
// itself after 30 days, so it is the one state with a deadline attached.
export type Availability = 'AVAILABLE' | 'UNVERIFIED' | 'TRASHED' | 'RESTORING' | 'MISSING' | 'MISMATCH';
export type Family = 'Audio' | 'Video' | 'Image' | 'Document';
// Two roles. The line is drawn at what cannot be undone: a User does the day's work and
// everything it does is recoverable; an Admin additionally holds permanent deletion, the
// account roster and the activity log.
export type Role = 'Admin' | 'User';

export interface User {
  _id: string;
  name: string;
  email: string;
  role: Role;
  status: string;
  lastLoginAt: string | null;
  /** Still holding the password an administrator handed over. Gates the whole app. */
  mustChangePassword: boolean;
  permissions: string[];
  createdAt?: string | null;
  passwordChangedAt?: string | null;
  /** Null on the founding administrator, and on any account seeded before this was kept. */
  createdBy?: string | null;
  createdByName?: string | null;
  /** The minimum the server will actually enforce. Read it; do not repeat it. */
  minPasswordLength?: number;
  /** Set once this account has signed in with Google at least once. */
  google?: { linkedAt: string; email: string; lastSignInAt: string | null } | null;
  /** Whether this deployment has Google sign-in configured at all. */
  googleSignInAvailable?: boolean;
  /** A live Google sign-in stands in for the handover password on the first change. */
  canSetPasswordWithoutCurrent?: boolean;
}

/** GET /api/auth/providers — which sign-in routes the server will actually complete. */
export interface AuthProviders {
  password: boolean;
  google: { enabled: boolean; hostedDomain: string | null };
}

// Where a file physically is: the id that addresses it, the checksums Google computed on
// arrival, the current revision, and the media metadata Drive extracted for free.
export interface DriveBinding {
  fileId: string;
  name: string;
  parentId: string | null;
  driveId: string | null;
  /** Human-readable "Folder/File.ext", for display only — Drive addresses by id. */
  path: string | null;
  revisionId: string | null;
  sizeBytes: number;
  /** Computed by Google on arrival, which is what makes exact de-duplication free. */
  md5: string | null;
  sha256: string | null;
  sha1: string | null;
  mimeType: string;
  webViewLink: string | null;
  thumbnailLink: string | null;
  trashed: boolean;
  /** Google Docs/Sheets/Slides: no bytes of their own, must be exported to download. */
  googleNative: boolean;
  createdAt: string | null;
  modifiedAt: string | null;
  uploadedAt: string;
  durationSec: number | null;
  dimensions: string | null;
  appProperties?: Record<string, string>;
}

export interface AvailabilityBlock {
  status: Availability;
  lastCheckedAt: string | null;
  lastVerifiedAt: string | null;
  checkMethod: string | null;
  detail: string | null;
}

export interface Asset {
  assetId: string;
  displayName: string;
  originalName: string;
  description: string;
  type: string;
  family: Family;
  format: string;
  drive: DriveBinding;
  availability: AvailabilityBlock;
  versionGroupId: string;
  version: string;
  isCurrent: boolean;
  supersedes: string | null;
  mimeType: string;
  durationSec: number | null;
  dimensions: string | null;
  tags: string[];
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
  updatedAt: string;
  renamedAt: string | null;
  deletedAt: string | null;
  permanentlyLost?: boolean;
  /** Set when this entry shares a Drive file with another after de-duplication linking. */
  isLinkedCopy?: boolean;
  linkedTo?: string | null;
  driveWebViewLink?: string | null;
  perceptual?: { frames: string[]; sampledFrames: number; computedAt: string } | null;
  songId: string | null;
  songTitle: string | null;
  folderId: string | null;
  folderName: string | null;
  folderTags: string[];
  artistId: string | null;
  artistName: string | null;
  /**
   * This file's own language when it has one, otherwise its release's. Null means nobody
   * has stated one — never a guess.
   */
  language: string | null;
  /** Which of the two answered: the file itself, or the release behind it. */
  languageSource: 'file' | 'release' | null;
  mood: string | null;
  releaseDate: string | null;
  releaseYear: number | null;
  verificationStale: boolean;
  verificationAgeHours: number | null;
  versions?: VersionRow[];
  activity?: ActivityEntry[];
  shares?: Share[];
}

export interface VersionRow {
  assetId: string;
  version: string;
  displayName: string;
  isCurrent: boolean;
  createdAt: string;
  sizeBytes: number;
}

export interface ActivityEntry {
  _id: string;
  userId: string | null;
  userName: string;
  userRole: string;
  action: string;
  entity: string;
  entityId: string;
  label: string;
  before: unknown;
  after: unknown;
  meta: Record<string, unknown> | null;
  ip: string;
  timestamp: string;
}

// Who a link is for. PUBLIC needs no account; the other two resolve only for a signed-in
// GCloud user, and RESTRICTED additionally checks the account's email against the list.
export type ShareAudience = 'PUBLIC' | 'EDITOR' | 'RESTRICTED';
export type ShareTarget = 'ASSET' | 'FOLDER';

export interface ShareRecipient {
  _id: string;
  email: string;
  /** This recipient's own link. Not the same URL anybody else was sent. */
  url: string;
  createdAt: string;
  revokedAt: string | null;
  firstAccessedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  downloadCount: number;
}

export interface Share {
  _id: string;
  target: ShareTarget;
  targetId: string;
  targetName: string;
  assetId: string | null;
  assetName: string;
  fileCount: number;
  /** The family of the shared file — null for a folder link. Drives the category tabs. */
  family: Family | null;
  assetType: string | null;
  audience: ShareAudience;
  audienceLabel: string;
  allowedEmails: string[];
  /**
   * One row per addressee on a specific-allocation link, each with a URL of its own.
   * Revoking one leaves the others working — which is the point: a link that has to be
   * withdrawn from everybody because one person forwarded their mail punishes the wrong
   * four people.
   */
  recipients?: ShareRecipient[];
  hasPasscode?: boolean;
  canEdit: boolean;
  songTitle?: string | null;
  artistName?: string | null;
  token: string;
  url: string;
  createdByName: string;
  note: string;
  createdAt: string;
  expiresAt: string;
  canDownload: boolean;
  maxDownloads: number | null;
  downloadCount: number;
  revokedAt: string | null;
  expired: boolean;
  exhausted: boolean;
  remainingMs: number;
}

export interface FacetValue { value: string; count: number }

export interface AssetTypeDef {
  type: string;
  family: Family;
  tier: string;
  custom: boolean;
  _id?: string;
}

export interface TagSuggestion {
  _id: string;
  name: string;
  type: string;
  usageCount: number;
  distance: number;
  reason: 'near-identical' | 'similar' | 'contains';
  confidence: number;
}

export interface Folder {
  _id: string;
  name: string;
  description: string;
  tags: string[];
  /** The real Google Drive folder behind this one. */
  driveFolderId: string | null;
  driveWebViewLink: string | null;
  parentId: string | null;
  parentName: string | null;
  subfolderCount: number;
  songId: string | null;
  artistId: string | null;
  songTitle: string | null;
  artistName: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  assetCount: number;
  totalBytes: number;
  /** This folder and everything filed below it — what a share link on it covers. */
  totalAssetCount: number;
  totalBytesDeep: number;
  byFamily: Record<string, number>;
  byStatus: Record<string, number>;
  needsAttention: number;
  assets?: Asset[];
  assetsByFamily?: Record<string, Asset[]>;
  breadcrumb?: { _id: string; name: string }[];
  subfolders?: Folder[];
}

export interface FolderOption { _id: string; name: string; path: string; depth: number; assetCount: number }

export interface FolderTreeNode {
  _id: string;
  name: string;
  assetCount: number;
  driveWebViewLink: string | null;
  children: FolderTreeNode[];
}

export interface SearchResponse {
  data: Asset[];
  facets: Record<string, FacetValue[]>;
  sort: string;
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
  verifiedLive: boolean;
}

export interface Artist {
  _id: string;
  name: string;
  slug: string;
  genre: string;
  label: string;
  city: string;
  bio: string;
  contact: string;
  socials: { platform: string; handle: string }[];
  imageAssetId: string | null;
  songCount: number;
  assetCount: number;
  totalBytes: number;
  byFamily: Record<string, number>;
  songs?: SongRow[];
  gallery?: Asset[];
  /** Real Drive folders this artist's files sit in, with their share of the contents. */
  folders?: ArtistFolder[];
  /** Asset type → how many this artist has. Drives which sub-tabs the page offers. */
  byType?: Record<string, number>;
  /** Files of theirs not filed in any folder. */
  looseCount?: number;
}

export interface ArtistFolder {
  _id: string;
  name: string;
  description: string;
  tags: string[];
  parentName: string | null;
  driveWebViewLink: string | null;
  assetCount: number;
}

export interface SongRow {
  _id: string;
  title: string;
  artistId?: string;
  artistName?: string;
  language: string;
  mood: string;
  isrc?: string;
  releaseDate: string;
  tags?: string[];
  assetCount: number;
  coverAssetId: string | null;
  needsAttention?: number;
}

export interface SongDetail extends SongRow {
  description: string;
  featuring: string[];
  assets: Asset[];
  assetsByFamily: Record<string, Asset[]>;
  totalBytes: number;
  recycleBin: Asset[];
  artistGenre: string | null;
}

export type FindingKind =
  | 'MISSING_IN_DRIVE'
  | 'TRASHED_IN_DRIVE'
  | 'UNTRACKED_IN_DRIVE'
  | 'UNTRACKED_FOLDER'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'PARENT_DRIFT'
  | 'NAME_DRIFT';

export interface Finding {
  _id: string;
  kind: FindingKind;
  severity: string;
  fileId: string;
  /** Alias of fileId, kept so saved runs from earlier versions still render. */
  key: string;
  assetId: string | null;
  displayName: string;
  driveName?: string;
  songId?: string;
  songTitle?: string;
  detail: string;
  expected?: unknown;
  actual?: unknown;
  actualFolderName?: string | null;
  parentFolderName?: string | null;
  mimeType?: string;
  sizeBytes?: number;
  webViewLink?: string | null;
  resolvedAt: string | null;
  resolution?: { action: string; note: string; by: string };
}

export interface ReconRun {
  _id: string;
  trigger: string;
  startedBy: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  objectsScanned: number;
  foldersScanned: number;
  assetsScanned: number;
  readsIssued: number;
  counts: Record<string, number>;
  findings: Finding[];
  quota: Quota | null;
  ok: boolean;
}

/** What Google Drive says about space. The number that decides whether uploads work. */
export interface Quota {
  limit: number | null;
  unlimited: boolean;
  usage: number;
  usageInDrive: number;
  /** Trashed files still count until Drive sweeps them, which surprises everyone. */
  usageInTrash: number;
  /** Gmail and Photos share the same allowance on a consumer account. */
  usageElsewhere: number;
  available: number | null;
  percentUsed: number;
  maxUploadSize: number | null;
  account: { name: string; email: string; photo: string | null } | null;
  sharedDriveId: string | null;
  checkedAt: string;
  libraryBytes?: number;
  libraryFileCount?: number;
  otherDriveBytes?: number;
  trashRecoverableForDays?: number;
  mode?: string;
  sharedDrive?: boolean;
  rootFolderId?: string | null;
}

export interface StorageHealth {
  totalAssets: number;
  totalBytes: number;
  byStatus: Record<Availability, number>;
  healthPct: number;
  lastRun: { _id: string; finishedAt: string; counts: Record<string, number>; objectsScanned: number; ok: boolean } | null;
  openFindings: number;
  attention: Asset[];
  byFamily: Record<string, { count: number; bytes: number }>;
  byFolder: Record<string, { count: number; bytes: number }>;
  quota: Quota | null;
  storage: {
    provider: string;
    mode: string;
    configured: boolean;
    account: { name: string; email: string; photo: string | null } | null;
    sharedDriveId: string | null;
    rootFolderId: string | null;
    folders: Record<string, string | null>;
    trashRecoverableForDays: number;
  };
  lastRunFull: ReconRun | null;
}

// ── De-duplication (§10.12) ────────────────────────────────────────────────

export type DuplicateKind = 'IDENTICAL' | 'PERCEPTUAL' | 'SAME_MEDIA' | 'SAME_NAME';

export interface DuplicateMember {
  assetId: string;
  displayName: string;
  type: string;
  family: Family;
  sizeBytes: number;
  durationSec: number | null;
  dimensions: string | null;
  mimeType: string;
  fileId: string | null;
  sha256: string | null;
  md5: string | null;
  webViewLink: string | null;
  folderId: string | null;
  folderName: string | null;
  songId: string | null;
  songTitle: string | null;
  artistName: string | null;
  tags: string[];
  createdAt: string;
  uploadedByName: string;
  version: string;
  isLinkedCopy: boolean;
}

export interface DuplicateGroup {
  _id: string;
  kind: DuplicateKind;
  /** 1 for byte-identical, lower for the speculative tiers. Drives the UI's language. */
  confidence: number;
  reason: string;
  count: number;
  reclaimableBytes: number;
  spansFolders: boolean;
  folders: string[];
  suggestedKeepId: string;
  members: DuplicateMember[];
  fingerprint?: string;
}

export interface DuplicateReport {
  scannedAt: string;
  durationMs: number;
  level: string;
  assetsScanned: number;
  groups: DuplicateGroup[];
  byKind: Record<string, { groups: number; files: number; reclaimableBytes: number }>;
  totals: {
    groups: number;
    files: number;
    certainReclaimableBytes: number;
    potentialReclaimableBytes: number;
    crossFolderGroups: number;
  };
  perceptualEnabled: boolean;
  thresholds: Record<string, number>;
}

export interface DuplicateComparison {
  a: Asset;
  b: Asset;
  verdict: 'SAME_DRIVE_FILE' | 'IDENTICAL' | 'DIFFERENT';
  signals: {
    sameDriveFile: boolean;
    checksumMatch: boolean;
    sizeDelta: number;
    durationDelta: number | null;
    sameDimensions: boolean;
    nameSimilarity: number;
    normalisedNames: [string, string];
  };
  explanation: string;
}

export interface Dashboard {
  greetingName: string;
  role: Role;
  health: StorageHealth;
  quota: Quota | null;
  duplicates: { groups: number; files: number; reclaimableBytes: number; crossFolderGroups: number };
  counts: {
    artists: number; songs: number; assets: number;
    staleVerification: number; activeShares: number; openFindings: number;
    folders: number; unfiled: number; duplicateGroups: number;
    /** Files catalogued but missing from or mismatched against storage. The true total. */
    needsReview: number;
  };
  recent: Asset[];
  trendingTags: { _id: string; name: string; type: string; usageCount: number }[];
  artists: { _id: string; name: string; genre: string; imageAssetId: string | null; songCount: number; assetCount: number; totalBytes: number }[];
  canUpload: boolean;
  canSeeStorage: boolean;
  activity: ActivityEntry[];
}

// ── Master log (§10.6) ──────────────────────────────────────────────────────
//
// The library's register of record: one row per catalogued file, every field the
// catalogue holds. The column registry lives on the server and travels with the response
// — two lists of sixty columns drift within a release, and the failure mode is a
// spreadsheet whose header names the wrong data.

export interface MasterLogColumn {
  key: string;
  header: string;
  group: string;
  width?: number;
  /** Stays a real number, so it sorts numerically here and sums in Excel. */
  num?: boolean;
  /** Cannot be switched off — a register with no title column is not a register. */
  always?: boolean;
}

/** A named answer to a question people actually arrive with. */
export interface MasterLogPreset { id: string; label: string; hint: string; columns: string[] }

/**
 * A row arrives display-ready: a size is already "1.4 GB", a boolean already "Yes". The
 * underscore-prefixed fields are what the table needs and the spreadsheet does not — the
 * raw status for its badge, the ids for its links.
 */
export interface MasterLogRow {
  _id: string;
  _status: Availability;
  _family: Family;
  _songId: string | null;
  _artistId: string | null;
  _folderId: string | null;
  _driveLink: string;
  _tags: string[];
  _deleted: boolean;
  [column: string]: string | number | boolean | string[] | null;
}

export interface MasterLogSummary {
  files: number;
  bytes: number;
  bytesText: string;
  artists: number;
  songs: number;
  folders: number;
  available: number;
  needsAttention: number;
  unchecked: number;
  shared: number;
  inBin: number;
  byStatus: Record<string, number>;
}

export interface MasterLogResponse {
  data: MasterLogRow[];
  total: number;
  /** Everything the register could show under the current lifecycle, before filters. */
  libraryTotal: number;
  page: number;
  limit: number;
  sort: string;
  dir: 'asc' | 'desc';
  filtered: boolean;
  columns: MasterLogColumn[];
  groups: string[];
  defaultColumns: string[];
  presets: MasterLogPreset[];
  summary: MasterLogSummary;
  facets: Record<string, FacetValue[]>;
  earliest: string | null;
}
