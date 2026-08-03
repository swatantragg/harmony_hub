export type Availability = 'AVAILABLE' | 'UNVERIFIED' | 'ARCHIVED' | 'RESTORING' | 'MISSING' | 'MISMATCH';
export type Family = 'Audio' | 'Video' | 'Image' | 'Document';
export type Role = 'Admin' | 'Editor' | 'Marketing' | 'Viewer';

export interface User {
  _id: string;
  name: string;
  email: string;
  role: Role;
  jobTitle: string;
  status: string;
  lastLoginAt: string | null;
  permissions: string[];
}

export interface S3Binding {
  bucket: string;
  key: string;
  versionId: string;
  region: string;
  storageClass: string;
  sizeBytes: number;
  etag: string;
  checksumSHA256: string | null;
  contentType: string;
  uploadedAt: string;
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
  s3: S3Binding;
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
  rekeyStatus: string | null;
  permanentlyLost?: boolean;
  songId: string | null;
  songTitle: string | null;
  folderId: string | null;
  folderName: string | null;
  folderTags: string[];
  artistId: string | null;
  artistName: string | null;
  language: string | null;
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

export interface Share {
  _id: string;
  target: ShareTarget;
  targetId: string;
  targetName: string;
  assetId: string | null;
  assetName: string;
  fileCount: number;
  audience: ShareAudience;
  audienceLabel: string;
  allowedEmails: string[];
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
  songId: string | null;
  artistId: string | null;
  songTitle: string | null;
  artistName: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  assetCount: number;
  totalBytes: number;
  byFamily: Record<string, number>;
  byStatus: Record<string, number>;
  needsAttention: number;
  assets?: Asset[];
  assetsByFamily?: Record<string, Asset[]>;
}

export interface FolderOption { _id: string; name: string; assetCount: number }

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

export interface Finding {
  _id: string;
  kind: 'MISSING_IN_S3' | 'UNTRACKED_IN_S3' | 'SIZE_MISMATCH' | 'ETAG_MISMATCH' | 'CLASS_DRIFT';
  severity: string;
  key: string;
  assetId: string | null;
  displayName: string;
  songId?: string;
  songTitle?: string;
  detail: string;
  expected?: unknown;
  actual?: unknown;
  sizeBytes?: number;
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
  assetsScanned: number;
  counts: Record<string, number>;
  findings: Finding[];
  ok: boolean;
}

export interface StorageHealth {
  totalAssets: number;
  totalBytes: number;
  byStatus: Record<Availability, number>;
  healthPct: number;
  lastRun: { _id: string; finishedAt: string; counts: Record<string, number>; objectsScanned: number; ok: boolean } | null;
  openFindings: number;
  attention: Asset[];
  byClass: Record<string, { count: number; bytes: number }>;
  byFamily: Record<string, { count: number; bytes: number }>;
  buckets: Record<string, string>;
  lastRunFull: ReconRun | null;
}

export interface Dashboard {
  greetingName: string;
  role: Role;
  health: StorageHealth;
  counts: {
    artists: number; songs: number; assets: number;
    staleVerification: number; activeShares: number; openFindings: number;
    folders: number; unfiled: number;
  };
  recent: Asset[];
  attention: Asset[];
  trendingTags: { _id: string; name: string; type: string; usageCount: number }[];
  topArtists: { _id: string; name: string; genre: string; imageAssetId: string | null; songCount: number; assetCount: number; totalBytes: number }[];
  canUpload: boolean;
  canSeeStorage: boolean;
  activity: ActivityEntry[];
}
