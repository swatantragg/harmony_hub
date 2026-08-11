// Front-end mount check:  npm run smoke:ui
//
// Renders real pages through Vite's own transform pipeline into jsdom and fails on any
// React error. Cheap insurance against the class of breakage that a type check cannot see —
// a hook rule violated, a router version that no longer exports what a page imports, a
// provider missing from the tree. It renders; it does not assert on behaviour.
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:8101/', pretendToBeVisual: true,
});
for (const k of ['window','document','HTMLElement','Element','Node','localStorage','sessionStorage','MutationObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame','CSS']) {
  if (dom.window[k] !== undefined) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }
  }
}
globalThis.window.matchMedia = () => ({ matches: false, media: '', addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
globalThis.matchMedia = globalThis.window.matchMedia;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures shaped like the real payloads. A page that reads `data.counts.needsReview` is
// only genuinely exercised if something with that shape comes back — an empty array would
// have it bail out early and the check would pass without rendering anything real.
const asset = (i) => ({
  assetId: `a${i}`, displayName: `track_${i}.wav`, originalName: `track_${i}.wav`, description: '',
  type: 'Master Audio', family: 'Audio', format: 'WAV',
  drive: {
    fileId: `f${i}`, name: `track_${i}.wav`, parentId: null, driveId: null, path: `Masters/track_${i}.wav`,
    revisionId: null, sizeBytes: 5_000_000, md5: null, sha256: null, sha1: null, mimeType: 'audio/wav',
    webViewLink: null, thumbnailLink: null, trashed: false, googleNative: false,
    createdAt: null, modifiedAt: null, uploadedAt: new Date().toISOString(), durationSec: 120, dimensions: null,
  },
  availability: { status: 'AVAILABLE', lastCheckedAt: null, lastVerifiedAt: null, checkMethod: null, detail: null },
  versionGroupId: `vg${i}`, version: 'V1', isCurrent: true, supersedes: null, mimeType: 'audio/wav',
  durationSec: 120, dimensions: null, tags: ['Master'], uploadedBy: 'u1', uploadedByName: 'Tester',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), renamedAt: null, deletedAt: null,
  songId: 's1', songTitle: 'Dil Se', folderId: 'fo1', folderName: 'Masters', folderTags: [],
  artistId: 'artist_1', artistName: 'Raju Singh', language: 'Hindi', mood: 'Romantic',
  releaseDate: null, releaseYear: 2026, verificationStale: false, verificationAgeHours: 1,
});

const byStatus = { AVAILABLE: 40, UNVERIFIED: 3, TRASHED: 0, RESTORING: 0, MISSING: 1, MISMATCH: 1 };
const health = {
  totalAssets: 45, totalBytes: 900_000_000, byStatus, healthPct: 96,
  lastRun: null, openFindings: 2,
};

const FIXTURES = {
  '/me': { _id: 'u1', name: 'Test Admin', email: 't@x.co', role: 'Admin', status: 'active', lastLoginAt: null, mustChangePassword: false, permissions: ['asset:read', 'admin:storage', 'admin:users', 'asset:upload', 'share:create'] },
  '/dashboard': {
    greetingName: 'Test', role: 'Admin', health, quota: null,
    duplicates: { groups: 0, files: 0, reclaimableBytes: 0, crossFolderGroups: 0 },
    counts: {
      artists: 5, songs: 12, assets: 45, staleVerification: 3, activeShares: 2,
      openFindings: 2, folders: 6, unfiled: 4, duplicateGroups: 0, needsReview: 2,
    },
    recent: [1, 2, 3, 4, 5].map(asset),
    trendingTags: [],
    artists: [
      { _id: 'artist_1', name: 'Ananya Bose', genre: 'Fusion', imageAssetId: null, songCount: 2, assetCount: 21, totalBytes: 1e8 },
      { _id: 'artist_2', name: 'Raju Singh', genre: 'Punjabi', imageAssetId: null, songCount: 3, assetCount: 30, totalBytes: 2e8 },
    ],
    canUpload: true, canSeeStorage: true,
    activity: [{ _id: 'e1', userId: 'u1', userName: 'Tester', userRole: 'Admin', action: 'ASSET_UPLOAD', entity: 'asset', entityId: 'a1', label: 'track_1.wav', before: null, after: null, meta: null, ip: '', timestamp: new Date().toISOString() }],
  },
  '/search': {
    data: [1, 2, 3].map(asset),
    facets: { family: [{ value: 'Audio', count: 3 }], type: [], tags: [{ value: 'Master', count: 3 }], availability: [{ value: 'AVAILABLE', count: 3 }], folder: [], artist: [], language: [], mood: [], version: [], year: [] },
    sort: 'newest', page: 1, limit: 48, total: 3, hasMore: false, verifiedLive: false,
  },
  '/artists/artist_1': {
    _id: 'artist_1', name: 'Raju Singh', slug: 'raju', genre: 'Punjabi', label: 'Northlight',
    city: 'Chandigarh', bio: 'Bio.', contact: '', socials: [{ platform: 'Instagram', handle: '@raju' }],
    imageAssetId: null, songCount: 3, assetCount: 21, totalBytes: 2e8,
    byFamily: { Audio: 6, Video: 6, Image: 5, Document: 4 },
    byType: { 'Master Audio': 3, 'Reel - BTS/MV': 2, 'BTS of Song': 1, 'Song Cover': 5 },
    looseCount: 2,
    songs: [{ _id: 's1', title: 'Dil Se', language: 'Hindi', mood: 'Romantic', releaseDate: new Date().toISOString(), assetCount: 9, coverAssetId: null }],
    gallery: [],
    folders: [{ _id: 'fo1', name: 'Masters', description: 'Final masters.', tags: ['Master'], parentName: null, driveWebViewLink: null, assetCount: 9 }],
  },
  '/admin/storage/health': {
    ...health, attention: [1, 2].map(asset), byFamily: { Audio: { count: 40, bytes: 8e8 } },
    byFolder: { Masters: { count: 40, bytes: 8e8 } }, quota: null,
    storage: { provider: 'Google Drive', mode: 'oauth', configured: true, account: null, sharedDriveId: null, rootFolderId: 'root', folders: {}, trashRecoverableForDays: 30 },
    lastRunFull: null,
  },
  '/admin/users': {
    data: [
      { _id: 'u1', name: 'Test Admin', email: 'a@x.co', role: 'Admin', status: 'active', lastLoginAt: null, createdAt: new Date().toISOString(), permissions: [], mustChangePassword: false },
      { _id: 'u2', name: 'Test User', email: 'u@x.co', role: 'User', status: 'active', lastLoginAt: null, createdAt: new Date().toISOString(), permissions: [], mustChangePassword: true },
    ],
    roles: ['Admin', 'User'],
    permissionMatrix: { Admin: ['asset:read', 'admin:users'], User: ['asset:read'] },
    minPasswordLength: 8,
  },
  '/notifications': { data: [], unread: 0 },
  '/admin/activity': {
    data: [{ _id: 'e1', userId: 'u1', userName: 'Tester', userRole: 'Admin', action: 'ASSET_UPLOAD', entity: 'asset', entityId: 'a1', label: 'track_1.wav', before: null, after: null, meta: null, ip: '10.0.0.1', timestamp: new Date().toISOString() }],
    total: 1, page: 1, limit: 50, sort: 'newest', actions: ['ASSET_UPLOAD'], earliest: new Date().toISOString(),
  },
  '/shares': {
    data: [{
      _id: 's1', target: 'ASSET', targetId: 'a1', targetName: 'track_1.wav', assetId: 'a1', assetName: 'track_1.wav',
      fileCount: 1, family: 'Audio', assetType: 'Master Audio', audience: 'PUBLIC', audienceLabel: 'Open to all',
      allowedEmails: [], canEdit: false, token: 'tok', url: 'http://x/#/s/tok', createdByName: 'Tester', note: '',
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(),
      canDownload: true, maxDownloads: null, downloadCount: 3, revokedAt: null, expired: false, exhausted: false,
      remainingMs: 86400000, songTitle: 'Dil Se', artistName: 'Raju Singh',
    }],
  },
  '/folders': {
    data: [{
      _id: 'fo1', name: 'Masters', description: 'Final masters.', tags: ['Master'], driveFolderId: 'd1',
      driveWebViewLink: null, parentId: null, parentName: null, subfolderCount: 0, songId: null, artistId: null,
      songTitle: null, artistName: null, createdByName: 'Tester', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), assetCount: 9, totalBytes: 5e7,
      byFamily: { Audio: 9 }, byStatus: { AVAILABLE: 9 }, needsAttention: 0,
    }],
  },
  '/dedupe/scan': {
    scannedAt: new Date().toISOString(), durationMs: 6, level: 'all', assetsScanned: 116, groups: [],
    byKind: {}, totals: { groups: 0, files: 0, certainReclaimableBytes: 0, potentialReclaimableBytes: 0, crossFolderGroups: 0 },
    perceptualEnabled: false, thresholds: {},
  },
  '/artists': {
    data: [{
      _id: 'artist_1', name: 'Raju Singh', slug: 'raju', genre: 'Punjabi', label: 'Northlight', city: 'Chandigarh',
      bio: '', contact: '', socials: [], imageAssetId: null, songCount: 3, assetCount: 21, totalBytes: 2e8,
      byFamily: { Audio: 6, Video: 6, Image: 5, Document: 4 },
    }],
  },
};

globalThis.fetch = async (url) => {
  const path = String(url).replace(/^.*\/api/, '').split('?')[0];
  const body = FIXTURES[path] ?? FIXTURES[Object.keys(FIXTURES).find((k) => path.startsWith(k)) ?? ''] ?? [];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

const server = await createServer({
  root: new URL('..', import.meta.url).pathname,
  plugins: [react()],
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };

try {
  // node_modules load natively; only the app's own source goes through Vite's transform.
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter, Routes, Route } = await import('react-router');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { Login } = await server.ssrLoadModule('/src/features/auth/Login.tsx');
  const { SetPassword } = await server.ssrLoadModule('/src/features/auth/SetPassword.tsx');
  const { Help } = await server.ssrLoadModule('/src/features/help/Help.tsx');
  const { Dashboard } = await server.ssrLoadModule('/src/features/home/Dashboard.tsx');
  const { ArtistDetail } = await server.ssrLoadModule('/src/features/artists/Artists.tsx');
  const { StorageHealth } = await server.ssrLoadModule('/src/features/admin/StorageHealth.tsx');
  const { Users } = await server.ssrLoadModule('/src/features/admin/Users.tsx');
  const { ActivityLog } = await server.ssrLoadModule('/src/features/admin/ActivityLog.tsx');
  const { ShareManager } = await server.ssrLoadModule('/src/features/shares/ShareManager.tsx');
  const { FolderList } = await server.ssrLoadModule('/src/features/folders/Folders.tsx');
  const { Dedupe } = await server.ssrLoadModule('/src/features/dedupe/Dedupe.tsx');
  const { ArtistList } = await server.ssrLoadModule('/src/features/artists/Artists.tsx');
  const { ToastHost } = await server.ssrLoadModule('/src/components/ui.tsx');
  const { useSession } = await server.ssrLoadModule('/src/app/session.ts');

  // A signed-in Admin, so the permission-gated halves of these screens actually render.
  useSession.setState({
    loading: false,
    user: {
      _id: 'u1', name: 'Test Admin', email: 't@x.co', role: 'Admin', status: 'active',
      lastLoginAt: null, mustChangePassword: false,
      permissions: ['asset:read', 'asset:upload', 'share:create', 'admin:storage', 'admin:activity', 'admin:users'],
    },
  });

  const h = React.createElement;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // path is the route pattern; at is the URL rendered against it, for pages that read params.
  const PAGES = [
    { name: 'Login', Page: Login, path: '/', at: '/' },
    { name: 'Help', Page: Help, path: '/', at: '/' },
    { name: 'Home (browse)', Page: Dashboard, path: '/', at: '/' },
    // The same component with a query on the URL: this is the merged search surface, and
    // it renders an entirely different half of the page.
    { name: 'Home (searching)', Page: Dashboard, path: '/', at: '/?q=dil+se', expect: /file/i },
    { name: 'Artist · everything', Page: ArtistDetail, path: '/artists/:id', at: '/artists/artist_1', expect: /Releases|Folders/ },
    { name: 'Artist · folders tab', Page: ArtistDetail, path: '/artists/:id', at: '/artists/artist_1?tab=folders', expect: /Masters/ },
    { name: 'Artist · BTS tab', Page: ArtistDetail, path: '/artists/:id', at: '/artists/artist_1?tab=bts', expect: /BTS/ },
    { name: 'Storage health', Page: StorageHealth, path: '/', at: '/?focus=review', expect: /Where every file stands/ },
    { name: 'People', Page: Users, path: '/', at: '/', expect: /Admin/ },
    { name: 'Set password', Page: SetPassword, path: '/', at: '/', expect: /Choose your password/ },
    { name: 'Activity log', Page: ActivityLog, path: '/', at: '/', expect: /Activity log/ },
    { name: 'Share links', Page: ShareManager, path: '/', at: '/', expect: /Share links/ },
    { name: 'Folders', Page: FolderList, path: '/', at: '/', expect: /Folders/ },
    { name: 'Duplicates', Page: Dedupe, path: '/', at: '/', expect: /Duplicates/ },
    { name: 'Artists', Page: ArtistList, path: '/', at: '/', expect: /Artists/ },
  ];

  for (const { name, Page, path, at, expect } of PAGES) {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    root.render(
      h(QueryClientProvider, { client: qc },
        h(MemoryRouter, { initialEntries: [at] },
          h(ToastHost, null, h(Routes, null, h(Route, { path, element: h(Page, null) }))))),
    );
    await new Promise((r) => setTimeout(r, 500));
    const text = host.textContent || '';
    if (text.length < 30) throw new Error(`${name} rendered almost nothing (${text.length} chars)`);
    if (expect && !expect.test(text)) throw new Error(`${name} rendered but ${expect} was not on the page`);
    console.log(`  ✓ ${name} mounted — ${host.querySelectorAll('*').length} DOM nodes, ${text.length} chars of text`);
    root.unmount();
  }

  const real = errors.filter((e) => !/not wrapped in act|Warning: ReactDOM/.test(e));
  if (real.length) { console.log(`\n  ✗ ${real.length} console error(s):`); real.slice(0,5).forEach((e)=>console.log('   ',e.slice(0,200))); process.exitCode = 1; }
  else console.log('  ✓ no React errors or warnings');
} finally {
  await server.close();
}
