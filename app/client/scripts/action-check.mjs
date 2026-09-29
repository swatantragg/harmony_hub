import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:8101/', pretendToBeVisual: true,
});
for (const k of [
  'window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent', 'Event',
  'localStorage', 'sessionStorage', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'CSS', 'navigator', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
]) {
  if (dom.window[k] !== undefined) {
    try { globalThis[k] = dom.window[k]; }
    catch { Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true }); }
  }
}
globalThis.window.matchMedia = () => ({ matches: false, media: '', addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;


const folder = (id, name, parentId = null) => ({
  _id: id, name, description: '', tags: [], driveFolderId: `d_${id}`, driveWebViewLink: null,
  parentId, parentName: null, subfolderCount: 0, songId: null, artistId: null, songTitle: null,
  artistName: null, createdByName: 'Tester', createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  assetCount: 0, totalBytes: 0, totalAssetCount: 9, totalBytesDeep: 5e7,
  byFamily: { Audio: 9 }, byStatus: { AVAILABLE: 9 }, needsAttention: 0,
});

const asset = {
  assetId: 'a1', displayName: 'track_1.wav', originalName: 'track_1.wav', description: '',
  type: 'Master Audio', family: 'Audio', format: 'WAV',
  drive: {
    fileId: 'f1', name: 'track_1.wav', parentId: null, driveId: null, path: 'Masters/track_1.wav',
    revisionId: null, sizeBytes: 5e6, md5: null, sha256: null, sha1: null, mimeType: 'audio/wav',
    webViewLink: null, thumbnailLink: null, trashed: false, googleNative: false,
    createdAt: null, modifiedAt: null, uploadedAt: new Date().toISOString(), durationSec: 120, dimensions: null,
  },
  availability: { status: 'AVAILABLE', lastCheckedAt: null, lastVerifiedAt: null, checkMethod: null, detail: null },
  versionGroupId: 'vg1', version: 'V1', isCurrent: true, supersedes: null, mimeType: 'audio/wav',
  durationSec: 120, dimensions: null, tags: [], uploadedBy: 'u1', uploadedByName: 'Tester',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), renamedAt: null, deletedAt: null,
  songId: null, songTitle: null, folderId: 'fo1', folderName: 'Masters', folderTags: [],
  artistId: null, artistName: null, language: 'Hindi', mood: '', releaseDate: null, releaseYear: 2026,
  verificationStale: false, verificationAgeHours: 1,
};

const folderDetail = {
  ...folder('fo1', 'Masters'),
  breadcrumb: [{ _id: 'fo1', name: 'Masters' }],
  subfolders: [folder('fo3', '2024', 'fo1')],
  assetCount: 1, assets: [], assetsByFamily: {},
};

const foldersOnly = {
  ...folder('fo9', 'Releases'),
  breadcrumb: [{ _id: 'fo9', name: 'Releases' }],
  subfolders: [folder('fo3', '2024', 'fo9'), folder('fo4', '2025', 'fo9')],
  assetCount: 0, assets: [], assetsByFamily: {},
};

const FIXTURES = {
  '/assets/a1': null,
  '/folders/fo1': folderDetail,
  '/folders/fo9': foldersOnly,
  '/folders/lookup/options': [
    { _id: 'fo1', name: 'Masters', path: 'Masters', depth: 0, assetCount: 9 },
    { _id: 'fo2', name: 'Artwork', path: 'Artwork', depth: 0, assetCount: 3 },
    { _id: 'fo3', name: '2024', path: 'Masters / 2024', depth: 1, assetCount: 4 },
  ],
  '/folders': { data: [folder('fo1', 'Masters'), { ...folder('fo2', 'Artwork'), origin: 'DRIVE', awaitingReview: true }] },
  '/tags': { languages: ['Hindi'], moods: [], data: [] },
  '/admin/activity': {
    data: [{
      _id: 'e1', userId: 'u1', userName: 'Tester', userRole: 'Admin', action: 'ASSET_UPLOAD',
      entity: 'asset', entityId: 'a1', label: 'track_1.wav', before: null, after: null, meta: null,
      ip: '10.0.0.1', timestamp: new Date().toISOString(),
    }],
    total: 1, page: 1, limit: 50, sort: 'newest', actions: ['ASSET_UPLOAD'],
    earliest: new Date().toISOString(),
  },
  '/admin/users': {
    data: [
      { _id: 'u1', name: 'Test Admin', email: 'a@x.co', role: 'Admin', status: 'active', lastLoginAt: null,
        createdAt: new Date().toISOString(), permissions: [], mustChangePassword: false, google: null,
        uploadCount: 12, activeShareCount: 2 },
      { _id: 'u2', name: 'Priya Nair', email: 'p@x.co', role: 'User', status: 'active', lastLoginAt: null,
        createdAt: new Date().toISOString(), permissions: [], mustChangePassword: true, google: null,
        uploadCount: 4, activeShareCount: 0 },
      { _id: 'u3', name: 'Old Account', email: 'o@x.co', role: 'User', status: 'suspended', lastLoginAt: null,
        createdAt: new Date().toISOString(), permissions: [], mustChangePassword: false, google: null,
        uploadCount: 0, activeShareCount: 0 },
    ],
    roles: ['Admin', 'User'],
    permissionMatrix: { Admin: ['admin:users'], User: [] },
    minPasswordLength: 8,
  },
  '/asset-types': { data: [], families: ['Audio'], builtinCount: 0, customCount: 0 },
};

FIXTURES['/assets/a1'] = asset;
const fromDrive = {
  ...asset, assetId: 'a2', displayName: 'dropped-in-drive.mp3', tags: ['Imported'],
  origin: 'DRIVE', reviewedAt: null, awaitingReview: true,
};
FIXTURES['/assets/a2'] = fromDrive;
folderDetail.assets = [asset];
folderDetail.assetsByFamily = { Audio: [asset] };

const calls = [];
// What GET /folders?review=pending answers — changed by the "New" button checks.
let pendingFolders = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^.*\/api/, '').split('?')[0];
  calls.push({ method: init.method || 'GET', path, raw: String(url), body: init.body ? JSON.parse(init.body) : null });
  if (path === '/shares' && init.method === 'POST') {
    return new Response(JSON.stringify({
      _id: 'sh1', url: 'http://x/#/s/tok', audience: 'PUBLIC', audienceLabel: 'Open to all',
      expiresAt: new Date(Date.now() + 6e5).toISOString(), maxDownloads: 10, canDownload: true,
      target: 'FOLDER', fileCount: 9, recipients: [],
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  if (path === '/folders' && /review=pending/.test(String(url))) {
    return new Response(JSON.stringify({ data: pendingFolders, total: pendingFolders.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (path.endsWith('/assets') && init.method === 'POST') {
    return new Response(JSON.stringify({ ok: true, moved: 1, failed: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const key = Object.keys(FIXTURES).sort((a, b) => b.length - a.length)
    .find((k) => path === k || path.startsWith(`${k}/`));
  return new Response(JSON.stringify(key ? FIXTURES[key] : { data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
};


const server = await createServer({
  root: new URL('..', import.meta.url).pathname,
  plugins: [react()],
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});

const failures = [];
const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { MemoryRouter, Routes, Route, useLocation } = await import('react-router');
/** Writes the router's location onto <body>, so a check can see where a click went. */
function Where() {
  const at = useLocation();
  document.body.dataset.where = `${at.pathname}${at.search}`;
  return null;
}
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { FolderList, FolderDetail } = await server.ssrLoadModule('/src/features/folders/Folders.tsx');
const { AssetDrawer } = await server.ssrLoadModule('/src/features/assets/AssetDrawer.tsx');
const { Users } = await server.ssrLoadModule('/src/features/admin/Users.tsx');
const { ActivityLog } = await server.ssrLoadModule('/src/features/admin/ActivityLog.tsx');
const { AssetList } = await server.ssrLoadModule('/src/features/assets/AssetCard.tsx');
const { UploadCenter } = await server.ssrLoadModule('/src/features/upload/UploadCenter.tsx');
const { useQueue } = await server.ssrLoadModule('/src/features/upload/useUploadQueue.ts');
const { ToastHost } = await server.ssrLoadModule('/src/components/ui.tsx');
const { useSession } = await server.ssrLoadModule('/src/app/session.ts');

useSession.setState({
  loading: false,
  user: {
    _id: 'u1', name: 'Test Admin', email: 't@x.co', role: 'Admin', status: 'active',
    lastLoginAt: null, mustChangePassword: false,
    permissions: ['asset:read', 'asset:upload', 'asset:edit', 'asset:rename', 'asset:delete', 'share:create'],
  },
});

const el = React.createElement;
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

let root = null;
const mount = async (element, path = '/') => {
  if (root) { await act(async () => { root.unmount(); }); }
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  await act(async () => {
    root.render(el(QueryClientProvider, { client: qc }, el(ToastHost, null,
      el(MemoryRouter, { initialEntries: [path] }, el(Where), el(Routes, null, el(Route, { path: '/folders/:id', element }), el(Route, { path: '/', element }))))));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
};

const press = async (node, what) => {
  if (!node) { failures.push(`nothing to press: ${what}`); throw new Error(`missing element: ${what}`); }
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
};

const menuItem = (label) => [...document.querySelectorAll('.row-menu-item')].find((b) => b.textContent.trim() === label);
const footBtn = (re) => [...document.querySelectorAll('.modal-foot .btn')].find((b) => re.test(b.textContent));
const rowNamed = (name) => [...document.querySelectorAll('.row-item')].find((r) => r.querySelector('.row-title')?.textContent === name);
const modalTitle = () => document.querySelector('.modal .t-h2')?.textContent ?? '';

const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : `  (${detail})`}`);
};


console.log('\nFolder list');
await mount(el(FolderList));
check('two folder rows render', document.querySelectorAll('.row-item').length === 2);

await press(rowNamed('Masters').querySelector('.row-menu-trigger'), 'folder menu trigger');
const entries = [...document.querySelectorAll('.row-menu-item')].map((b) => b.textContent.trim());
check('the menu opens with all five verbs', entries.length === 5, entries.join(', '));

const shareEntry = menuItem('Share folder');
check('Share is offered on a folder whose files are all in subfolders', shareEntry && !shareEntry.disabled);

await press(shareEntry, 'Share folder');
check('pressing Share opens the share dialog', /Share this folder/.test(modalTitle()), modalTitle());

await press(footBtn(/Create link/), 'Create link');
const posted = calls.find((c) => c.path === '/shares' && c.method === 'POST');
check('a link is requested for this folder',
  posted?.body?.target === 'FOLDER' && posted?.body?.targetId === 'fo1', JSON.stringify(posted?.body));
check('the created link is shown back', !!document.querySelector('.modal .input.mono'));
await press(footBtn(/Done/), 'Done');
check('the dialog closes', !document.querySelector('.scrim'));
check('the page scrolls again once the last overlay closes', document.body.style.overflow === '');

console.log('\nMoving a folder');
await press(rowNamed('Masters').querySelector('.row-menu-trigger'), 'folder menu trigger');
await press(menuItem('Move folder'), 'Move folder');
check('pressing Move opens the move dialog', /Move “Masters”/.test(modalTitle()), modalTitle());

const destinations = [...document.querySelectorAll('.move-option .row-title')].map((s) => s.textContent);
check('the folder itself and its subtree are not offered as destinations',
  !destinations.includes('Masters') && !destinations.includes('2024'), destinations.join(', '));
check('a sibling is offered', destinations.includes('Artwork'), destinations.join(', '));
const moveSearch = document.querySelector('.modal input[aria-label="Search folders"]');
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(moveSearch, 'art');
  moveSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
const found = [...document.querySelectorAll('.move-option .row-title')].map((t) => t.textContent);
check('the destinations can be searched', found.join() === 'Library root,Artwork', found.join(', '));

await press([...document.querySelectorAll('.move-option')].find((b) => /Artwork/.test(b.textContent)), 'Artwork');
const moveBtn = footBtn(/Move here/);
check('Move here is enabled once a different destination is picked', moveBtn && !moveBtn.disabled);
await press(moveBtn, 'Move here');
const patched = calls.find((c) => c.method === 'PATCH' && c.path === '/folders/fo1');
check('the move is sent as a re-parent', patched?.body?.parentId === 'fo2', JSON.stringify(patched?.body));
check('the dialog closes on success', !document.querySelector('.scrim'));


console.log('\nFile list');
await mount(el(AssetList, { assets: [asset], onOpen: () => { failures.push('the row opened its drawer instead of running the menu entry'); } }));
await press(document.querySelector('.tbl .row-menu-trigger'), 'file menu trigger');
const fileEntries = [...document.querySelectorAll('.row-menu-item')].map((b) => b.textContent.trim());
check('the file menu opens with all five verbs', fileEntries.length === 5, fileEntries.join(', '));

await press(menuItem('Move to folder'), 'Move to folder');
check('pressing Move opens the move dialog', /Move “track_1.wav”/.test(modalTitle()), modalTitle());
await press([...document.querySelectorAll('.move-option')].find((b) => /Library root/.test(b.textContent)), 'Library root');
await press(footBtn(/Move here/), 'Move here');
const assetMove = calls.find((c) => c.method === 'POST' && c.path === '/folders/none/assets');
check('the file is moved back to the root', assetMove?.body?.assetIds?.[0] === 'a1', JSON.stringify(assetMove?.body));

await press(document.querySelector('.tbl .row-menu-trigger'), 'file menu trigger');
await press(menuItem('Share file'), 'Share file');
check('pressing Share opens the share dialog', /Share outside/.test(modalTitle()), modalTitle());
await press(document.querySelector('.modal-head .btn-icon'), 'close');
check('the dialog closes', !document.querySelector('.scrim'));

console.log('\nFile drawer');
await mount(el(AssetDrawer, { assetId: 'a1', onClose: () => {} }));
check('the drawer opens', !!document.querySelector('.drawer'));
const drawerShare = [...document.querySelectorAll('.drawer-foot .btn')].find((b) => /Share/.test(b.textContent));
check('the drawer offers Share', !!drawerShare && !drawerShare.disabled);
await press(drawerShare, 'drawer Share');
check('the share dialog opens over the drawer', /Share outside/.test(modalTitle()), modalTitle());
check('the drawer is still behind it', !!document.querySelector('.drawer'));
await press(document.querySelector('.modal-head .btn-icon'), 'close the dialog');
check('closing the dialog leaves the drawer open', !document.querySelector('.scrim') && !!document.querySelector('.drawer'));
check('the page stays locked while the drawer is up', document.body.style.overflow === 'hidden');
const drawerMove = [...document.querySelectorAll('.drawer-foot .btn')].find((b) => /Move/.test(b.textContent));
check('the drawer offers Move, as the folder screens promise it does', !!drawerMove);
await press(drawerMove, 'drawer Move');
check('the move dialog opens over the drawer', /Move “track_1.wav”/.test(modalTitle()), modalTitle());
await press(footBtn(/Cancel/), 'Cancel');

console.log('\nFolder detail');
await mount(el(FolderDetail), '/folders/fo1');
check('the folder page renders', /Masters/.test(document.querySelector('.t-h1')?.textContent ?? ''));
const headerTrigger = document.querySelector('.page-head, .spread')?.querySelector('.row-menu-trigger')
  ?? document.querySelector('.row-menu-trigger');
await press(headerTrigger, 'folder page menu trigger');
await press(menuItem('Share folder'), 'Share folder');
check('Share works from the folder page too', /Share this folder/.test(modalTitle()), modalTitle());
await press(document.querySelector('.modal-head .btn-icon'), 'close');
const tabLabels = () => [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim());
const tabNamed = (name) => [...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith(name));
check('the tabs read All, Folders, then the file kinds',
  tabLabels().join('|') === 'All1|Folders1|Audio1', tabLabels().join(' | '));
check('the page lands on All, not on the folders', !rowNamed('2024'));
check('All shows the files', !!document.querySelector('.tbl tbody tr'));
await press(tabNamed('Folders'), 'Folders tab');
check('the Folders tab lists the folders inside this one', !!rowNamed('2024'));
check('exactly the one subfolder is listed', document.querySelectorAll('.rows .row-item').length === 1);
check('the file table gives way to the folder list', !document.querySelector('.tbl tbody tr'));
const subRow = rowNamed('2024');
check('the subfolder row carries its own menu', !!subRow?.querySelector('.row-menu-trigger'));
await press(subRow.querySelector('.row-menu-trigger'), 'subfolder menu trigger');
await press(menuItem('Move folder'), 'Move folder');
check('a subfolder can be moved from inside its parent', /Move “2024”/.test(modalTitle()), modalTitle());
await press(footBtn(/Cancel/), 'Cancel');
console.log('\nA folder holding only folders');
await mount(el(FolderDetail), '/folders/fo9');
check('it is not called empty', !document.querySelector('.empty'));
check('the only tab offered is Folders',
  [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()).join('|') === 'Folders2',
  [...document.querySelectorAll('.tab')].map((t) => t.textContent.trim()).join(' | '));
check('it lands on that tab rather than on a selection it does not offer',
  !!rowNamed('2024') && !!rowNamed('2025'));

console.log('\nNew from Drive');
await mount(el(AssetList, { assets: [asset, fromDrive], onOpen: () => {} }));
const badgeRows = [...document.querySelectorAll('.tbl tbody tr')].map((r) => Boolean(r.querySelector('.new-badge')));
check('only the file added straight to Drive carries the New badge', badgeRows.join() === 'false,true', badgeRows.join());
await mount(el(AssetDrawer, { assetId: 'a2', onClose: () => {} }));
check('its drawer says it was added straight to Drive', /added straight to Google Drive/.test(document.querySelector('.drawer')?.textContent ?? ''));
await press([...document.querySelectorAll('.drawer .btn')].find((b) => /mark reviewed/i.test(b.textContent)), 'mark reviewed');
const reviewed = calls.find((c) => c.method === 'POST' && c.path === '/assets/review');
check('Looks right sends it to be marked reviewed', reviewed?.body?.assetIds?.join() === 'a2', JSON.stringify(reviewed?.body));
await mount(el(FolderList));
check('a folder added straight to Drive is badged in the list',
  !!rowNamed('Artwork')?.querySelector('.new-badge') && !rowNamed('Masters')?.querySelector('.new-badge'));
const pill = () => document.querySelector('.new-pill');
const pillTip = () => document.querySelector('.tip-bubble')?.textContent ?? '';
check('with nothing new from Drive, New is grey', !!pill() && !pill().classList.contains('on') && pill().getAttribute('aria-disabled') === 'true');
check('and says what it would mean', /Nothing new from Google Drive/.test(pillTip()), pillTip());
await press(pill(), 'grey New');
check('a tap on the grey New shows that explanation', !!document.querySelector('.tip.open'));
check('and goes nowhere', document.body.dataset.where === '/', document.body.dataset.where);

pendingFolders = [{ ...folder('fo2', 'Artwork'), origin: 'DRIVE', awaitingReview: true }];
qc.removeQueries({ queryKey: ['folders'] });
await mount(el(FolderList));
check('one folder new from Drive lights New up, with its count',
  pill()?.classList.contains('on') && pill()?.querySelector('.new-pill-count')?.textContent === '1');
check('the lit New says it opens that folder', /Click to open it/.test(pillTip()), pillTip());
await press(pill(), 'lit New');
check('pressing it opens the new folder', document.body.dataset.where === '/folders/fo2', document.body.dataset.where);

pendingFolders = [
  { ...folder('fo2', 'Artwork'), origin: 'DRIVE', awaitingReview: true },
  { ...folder('fo5', 'Stems'), origin: 'DRIVE', awaitingReview: true },
];
qc.removeQueries({ queryKey: ['folders'] });
await mount(el(FolderList));
await press(pill(), 'lit New');
check('with several, it lists them instead', document.body.dataset.where === '/?review=pending', document.body.dataset.where);
check('the list is the pending folders only', calls.some((c) => c.path === '/folders' && /review=pending/.test(c.raw)));
check('and the page says so', /Only folders added straight to Google Drive/.test(document.querySelector('.page')?.textContent ?? ''));
await press(pill(), 'New again');
check('pressing New again shows every folder', document.body.dataset.where === '/', document.body.dataset.where);
pendingFolders = [];
qc.removeQueries({ queryKey: ['folders'] });

console.log('\nTagging a folder, and where the tags go');
await mount(el(FolderDetail), '/folders/fo1');
await press(document.querySelector('.page-head, .spread')?.querySelector('.row-menu-trigger')
  ?? document.querySelector('.row-menu-trigger'), 'folder page menu trigger');
await press(menuItem('Edit folder'), 'Edit folder');
const scopeChoices = () => [...document.querySelectorAll('.modal [role="radio"]')];
check('the edit dialog asks where the tags go',
  scopeChoices().map((c) => c.querySelector('.label')?.textContent).join(' | ') === 'Only this folder | This folder and the 1 file in it',
  scopeChoices().map((c) => c.querySelector('.label')?.textContent).join(' | '));
check('only the folder, unless told otherwise', scopeChoices()[0]?.getAttribute('aria-checked') === 'true');
await press(scopeChoices()[1], 'folder and its file');
await press([...document.querySelectorAll('.modal button.chip')].find((b) => b.textContent.trim() === 'Romantic'), 'Romantic');
check('choosing the files says what each one gets',
  /Each of the 1 file gets\s*Romantic/.test(document.querySelector('.modal .bulk-verdict')?.textContent ?? ''),
  document.querySelector('.modal .bulk-verdict')?.textContent);
await press(footBtn(/Save changes/), 'Save changes');
const folderPatch = [...calls].reverse().find((c) => c.method === 'PATCH' && c.path === '/folders/fo1');
check('the save carries the choice', folderPatch?.body?.tagScope === 'files', JSON.stringify(folderPatch?.body));

console.log('\nUpload queue — apply to every file');
const queued = (id, name) => ({
  id, file: new dom.window.File(['x'], name, { type: 'audio/mpeg' }), displayName: name, state: 'READY',
  progress: 0, error: null, checksum: 'abc', songId: '', folderId: '', assetType: 'Master Audio',
  version: 'V1', tags: [], description: '', language: '', uploadedBytes: 0, bytesSent: 0,
});
useQueue.setState({ items: [queued('q1', 'one.mp3'), queued('q2', 'two.mp3'), queued('q3', 'three.mp3')] });
useQueue.getState().update('q1', { tags: ['Sad'] });
await mount(el(UploadCenter));
const bulk = () => [...document.querySelectorAll('.panel')]
  .find((p) => /Apply to every file in the queue/.test(p.querySelector('.t-h3')?.textContent ?? ''));
const bulkChip = (label) => [...(bulk()?.querySelectorAll('button.chip') ?? [])]
  .find((b) => b.textContent.trim() === label || b.querySelector('.chip-label')?.textContent === label);
const verdicts = () => [...(bulk()?.querySelectorAll('.bulk-verdict') ?? [])].map((v) => v.textContent);
const queue = () => useQueue.getState().items;
check('the bulk panel renders for a queue of three', !!bulk());
check('with no folder chosen it says so', /No folder — the files go to the top of the library/.test(verdicts()[0] ?? ''), verdicts()[0]);
check('No folder is lit', bulkChip('No folder')?.classList.contains('on'));

await press(bulkChip('Masters'), 'Masters');
check('choosing a folder files every file in it', queue().every((i) => i.folderId === 'fo1'), queue().map((i) => i.folderId).join());
check('the section says where all of them are going', /All 3 files go into “Masters”/.test(verdicts()[0] ?? ''), verdicts()[0]);
check('the chosen folder is lit, and No folder is not',
  bulkChip('Masters')?.classList.contains('on') && !bulkChip('No folder')?.classList.contains('on'));

const folderSearch = bulk().querySelector('input[aria-label="Search folders"]');
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(folderSearch, '2024');
  folderSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
check('searching narrows the folders, and the chosen one stays in view',
  !!bulkChip('2024') && !bulkChip('Artwork') && bulkChip('Masters')?.classList.contains('on'));
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(folderSearch, '');
  folderSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});

await press(bulkChip('Romantic'), 'Romantic');
await press(bulkChip('Promo'), 'Promo');
check('a second tag is added to every file instead of replacing the first',
  queue().every((i) => i.tags.includes('Romantic') && i.tags.includes('Promo')), queue().map((i) => i.tags.join('+')).join(' | '));
check('a tag only one file had is left on that file', queue()[0].tags.includes('Sad'), queue()[0].tags.join('+'));
check('the shared tags are lit in the bulk section',
  bulkChip('Romantic')?.classList.contains('on') && bulkChip('Promo')?.classList.contains('on') && !bulkChip('Sad')?.classList.contains('on'));
check('and listed as what every file carries', /On all 3 files:\s*RomanticPromo/.test(verdicts()[1] ?? ''), verdicts()[1]);
await press(bulkChip('Romantic'), 'Romantic again');
check('pressing a lit tag takes it off every file and nothing else',
  queue().every((i) => !i.tags.includes('Romantic') && i.tags.includes('Promo')) && queue()[0].tags.includes('Sad'),
  queue().map((i) => i.tags.join('+')).join(' | '));

await act(async () => { useQueue.getState().update('q3', { folderId: 'fo2' }); });
check('files split across folders are called mixed, with nothing lit',
  /in different folders/.test(verdicts()[0] ?? '') && !bulkChip('Masters')?.classList.contains('on'), verdicts()[0]);
const queueBar = () => document.querySelector('.queue-bar');
check('the queue bar sits below the queue, with Upload in it',
  !!queueBar() && /Upload 3 files/.test(queueBar().textContent) && !queueBar().querySelector('.btn-spark').disabled,
  queueBar()?.textContent);
check('it says what is ready', /3 ready to upload/.test(queueBar()?.textContent ?? ''), queueBar()?.textContent);
check('a bulk New folder sits at the top, beside the search',
  [...bulk().querySelectorAll('.btn')].some((b) => /New folder/.test(b.textContent)) && !bulkChip('New folder'));

await press([...queueBar().querySelectorAll('.btn')].find((b) => /Clear queue/.test(b.textContent)), 'Clear queue');
check('clearing the queue asks first', /Clear 3 files from the queue/.test(modalTitle()), modalTitle());
await press(footBtn(/Clear queue/), 'confirm clear');
check('and then empties it', queue().length === 0, String(queue().length));
check('with the queue empty, the bar goes too', !queueBar());

console.log('\nOne file’s folder');
useQueue.setState({ items: [queued('q9', 'solo.mp3')] });
await mount(el(UploadCenter));
const folderTrigger = () => document.querySelector('[aria-label="Folder"].select-trigger');
await press(folderTrigger(), 'folder dropdown');
const searchInput = () => document.querySelector('.select-search-input');
const optionTexts = () => [...document.querySelectorAll('.select-menu .select-option-label')].map((o) => o.textContent);
check('the folder dropdown opens with a search box', !!searchInput());
check('the search box has the focus', document.activeElement === searchInput());
check('New folder is the first thing in it', optionTexts()[0] === '＋ New folder…', optionTexts().join(' | '));
const typeInto = async (input, text) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
};
const keyIn = async (node, k) => {
  await act(async () => { node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
await typeInto(searchInput(), '2024');
check('typing narrows the folders, New folder staying on top',
  optionTexts().join(' | ') === '＋ New folder “2024”… | 2024', optionTexts().join(' | '));
await keyIn(searchInput(), 'Enter');
check('Enter picks the folder that matched, not New folder', queue()[0].folderId === 'fo3', queue()[0].folderId);
await press(folderTrigger(), 'folder dropdown');
await typeInto(searchInput(), 'Zeta Masters');
check('a name nothing matches offers to make it', optionTexts().join(' | ') === '＋ New folder “Zeta Masters”…', optionTexts().join(' | '));
await keyIn(searchInput(), 'Enter');
check('and Enter opens New folder with that name',
  modalTitle() === 'New folder' && document.querySelector('.modal input.input')?.value === 'Zeta Masters',
  `${modalTitle()} / ${document.querySelector('.modal input.input')?.value}`);
await press(footBtn(/Cancel/), 'Cancel');
check('cancelling leaves the file where it was', queue()[0].folderId === 'fo3', queue()[0].folderId);
await act(async () => { useQueue.setState({ items: [] }); });

console.log('\nPeople');
await mount(el(Users));
const personRow = (name) => [...document.querySelectorAll('.person-row')]
  .find((r) => r.querySelector('.row-title')?.textContent.startsWith(name));
check('every account renders', document.querySelectorAll('.person-row').length === 3);
check('a suspended account says so', /suspended/.test(personRow('Old Account')?.textContent ?? ''));
check('the signed-in account is marked', /you/.test(personRow('Test Admin')?.querySelector('.row-title')?.textContent ?? ''));
await press(personRow('Priya Nair').querySelector('.row-menu-trigger'), 'Priya menu');
let items = [...document.querySelectorAll('.row-menu-item')].map((b) => b.textContent.trim());
check('an active account offers Suspend and Delete, not Restore',
  items.join('|') === 'Suspend access|Delete account', items.join(' | '));
await press(menuItem('Suspend access'), 'Suspend access');
check('the suspend confirmation names the person', /Suspend Priya Nair/.test(modalTitle()), modalTitle());
check('it says what is not affected', /4 files/.test(document.querySelector('.modal-body')?.textContent ?? ''));
await press(footBtn(/Suspend access/), 'confirm suspend');
const suspended = calls.find((c) => c.method === 'PATCH' && c.path === '/admin/users/u2');
check('suspending sends the status', suspended?.body?.status === 'suspended', JSON.stringify(suspended?.body));
await press(personRow('Old Account').querySelector('.row-menu-trigger'), 'Old Account menu');
items = [...document.querySelectorAll('.row-menu-item')].map((b) => b.textContent.trim());
check('a suspended account offers Restore instead of Suspend',
  items.join('|') === 'Restore access|Delete account', items.join(' | '));
await press(menuItem('Restore access'), 'Restore access');
await press(footBtn(/Restore access/), 'confirm restore');
const restored = calls.find((c) => c.method === 'PATCH' && c.path === '/admin/users/u3');
check('restoring sends the status', restored?.body?.status === 'active', JSON.stringify(restored?.body));
await press(personRow('Priya Nair').querySelector('.row-menu-trigger'), 'Priya menu');
await press(menuItem('Delete account'), 'Delete account');
check('the delete dialog is the irreversible one', /Delete this account permanently/.test(modalTitle()), modalTitle());
const deleteBody = document.querySelector('.modal-body')?.textContent ?? '';
check('it says the uploads survive but lose the name', /4 files/.test(deleteBody) && /Unknown/.test(deleteBody));
check('it says they have no live links', /no live share links/.test(deleteBody), deleteBody.slice(0, 200));
const deleteBtn = footBtn(/Delete the account/);
check('it will not fire until the name is typed', !!deleteBtn && deleteBtn.disabled);
const typed = document.querySelector('.modal-body .input.mono');
check('it asks for the name to be typed', !!typed);
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(typed, 'Priya Nair');
  typed.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
const pw = [...document.querySelectorAll('.modal-body input')].find((i) => i.type === 'password');
check('it asks for the administrator’s own password', !!pw);
await act(async () => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  setter.call(pw, 'hunter2hunter2');
  pw.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
});
check('it fires once both are given', !footBtn(/Delete the account/).disabled);
await press(footBtn(/Delete the account/), 'confirm delete');
const deleted = calls.find((c) => c.method === 'DELETE' && c.path === '/admin/users/u2');
check('deleting hits DELETE on the account', !!deleted);
await press(personRow('Test Admin').querySelector('.row-menu-trigger'), 'own menu');
const own = [...document.querySelectorAll('.row-menu-item')];
check('your own account cannot be suspended or deleted from here',
  own.length === 2 && own.every((b) => b.disabled), own.map((b) => `${b.textContent.trim()}:${b.disabled}`).join(' | '));
await act(async () => {
  document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
});

console.log('\nDropdowns');
await mount(el(FolderList));
const trigger = () => document.querySelector('.select-trigger');
const listbox = () => document.querySelector('.select-menu');
const optionLabels = () => [...document.querySelectorAll('.select-option-label')].map((o) => o.textContent);
check('the sort control renders as a trigger, not a native select',
  !!trigger() && !document.querySelector('select'));
check('it shows the current value', trigger()?.textContent.trim() === 'Name — A to Z', trigger()?.textContent);
check('the list is closed to begin with', !listbox());
await press(trigger(), 'sort trigger');
check('pressing it opens the list', !!listbox());
check('every option is offered', optionLabels().length === 7, optionLabels().join(' | '));
check('the current one is ticked',
  document.querySelector('.select-option.on .select-option-label')?.textContent === 'Name — A to Z');
check('the list is portalled out of the page', listbox()?.parentElement === document.body);
await press([...document.querySelectorAll('.select-option')].find((o) => /Name — Z to A/.test(o.textContent)), 'Z to A');
check('choosing closes the list', !listbox());
check('the trigger shows the new value', trigger()?.textContent.trim() === 'Name — Z to A', trigger()?.textContent);
check('the choice actually applied',
  [...document.querySelectorAll('.row-item .row-title')].map((s) => s.textContent).join() === 'Masters,Artwork',
  [...document.querySelectorAll('.row-item .row-title')].map((s) => s.textContent).join());
const key = async (k) => {
  await act(async () => {
    trigger().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
await key('ArrowDown');
check('ArrowDown opens the list from the trigger', !!listbox());
const cursor = () => document.querySelector('.select-option.active .select-option-label')?.textContent;
check('the cursor starts on what is selected', cursor() === 'Name — Z to A', cursor());
await key('ArrowDown');
check('ArrowDown moves the cursor without choosing anything',
  cursor() === 'Most files first' && trigger().textContent.trim() === 'Name — Z to A', cursor());
await key('Home');
check('Home jumps to the first', cursor() === 'Name — A to Z', cursor());
await key('l');
check('typing jumps to a match', cursor() === 'Largest first', cursor());
await key('Enter');
check('Enter takes the cursor', !listbox() && trigger().textContent.trim() === 'Largest first', trigger()?.textContent);
await key('ArrowDown');
await key('Escape');
check('Escape closes without changing anything',
  !listbox() && trigger().textContent.trim() === 'Largest first', trigger()?.textContent);
await press(trigger(), 'sort trigger');
await act(async () => {
  document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
});
check('a press outside closes the list', !listbox());
console.log('\nCalendar');
await mount(el(ActivityLog));
const dateTriggers = () => [...document.querySelectorAll('.date-trigger')];
const calendar = () => document.querySelector('.calendar');
const dayNamed = (n) => [...document.querySelectorAll('.calendar-day:not(.outside)')]
  .find((b) => b.textContent.trim() === String(n));
check('both range ends render as date triggers, not native date inputs',
  dateTriggers().length === 2 && !document.querySelector('input[type="date"]'));
check('an unset date reads as a placeholder', dateTriggers()[0].textContent.includes('Any date'),
  dateTriggers()[0].textContent);
check('the calendar is closed to begin with', !calendar());
await press(dateTriggers()[0], 'From');
check('pressing it opens the calendar', !!calendar());
check('the calendar is portalled out of the page', calendar()?.parentElement === document.body);
check('it shows six weeks, so the panel never changes height',
  document.querySelectorAll('.calendar-day').length === 42,
  String(document.querySelectorAll('.calendar-day').length));
check('the weekday header is a full week', document.querySelectorAll('.calendar-weekday').length === 7);

const now = new Date();
const monthName = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
check('it opens on the current month',
  document.querySelector('.calendar-title')?.textContent === monthName,
  document.querySelector('.calendar-title')?.textContent);
check('today is marked', !!document.querySelector('.calendar-day.today'));

await press(dayNamed(15), 'the 15th');
const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-15`;
const fromCall = [...calls].reverse().find((c) => c.path === '/admin/activity');
check('choosing a day closes the calendar', !calendar());
check('the chosen day survives the round trip to YYYY-MM-DD, with no timezone drift',
  (fromCall?.path ?? '') && decodeURIComponent(String(fromCall?.raw ?? '')).includes(expected),
  `expected ${expected} in ${fromCall?.raw}`);
check('the trigger now reads the date, not the placeholder',
  !dateTriggers()[0].textContent.includes('Any date'), dateTriggers()[0].textContent);
await press(dateTriggers()[1], 'To');
const blocked = [...document.querySelectorAll('.calendar-day:not(.outside)')]
  .filter((b) => b.disabled).map((b) => b.textContent.trim());
check('the To end refuses every day before the From end',
  blocked.length === 14 && blocked[0] === '1' && blocked.at(-1) === '14', blocked.join(','));

await act(async () => {
  document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
});
const dkey = async (k, shift = false) => {
  await act(async () => {
    dateTriggers()[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
await dkey('ArrowDown');
check('ArrowDown opens the calendar', !!calendar());
const at = () => document.querySelector('.calendar-day.cursor')?.textContent.trim();
check('the cursor lands on the chosen day', at() === '15', at());
await dkey('ArrowRight');
check('ArrowRight moves a day', at() === '16', at());
await dkey('ArrowDown');
check('ArrowDown moves a week', at() === '23', at());
await dkey('PageDown');
check('PageDown moves a month',
  document.querySelector('.calendar-title')?.textContent
    === new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  document.querySelector('.calendar-title')?.textContent);
await dkey('PageUp', true);
check('Shift+PageUp moves a year back',
  document.querySelector('.calendar-title')?.textContent
    === new Date(now.getFullYear() - 1, now.getMonth() + 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  document.querySelector('.calendar-title')?.textContent);
await dkey('Escape');
check('Escape closes it', !calendar());
const clearBtn = dateTriggers()[0].querySelector('.date-clear');
check('a set date offers an inline clear', !!clearBtn);
await press(clearBtn, 'clear');
check('clearing empties the field', dateTriggers()[0].textContent.includes('Any date'),
  dateTriggers()[0].textContent);

console.log('\nDismissal');
await mount(el(AssetList, { assets: [asset], onOpen: () => {} }));
await press(document.querySelector('.tbl .row-menu-trigger'), 'file menu trigger');
check('the menu is open', !!document.querySelector('.row-menu'));
await act(async () => {
  document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
});
check('a press outside closes it', !document.querySelector('.row-menu'));
await press(document.querySelector('.tbl .row-menu-trigger'), 'file menu trigger');
await act(async () => {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
check('Escape closes it', !document.querySelector('.row-menu'));
await press(document.querySelector('.tbl .row-menu-trigger'), 'file menu trigger');
await press(document.querySelector('.tbl .row-menu-trigger'), 'file menu trigger');
check('pressing the trigger again closes it', !document.querySelector('.row-menu'));
await act(async () => { root.unmount(); });
console.error = origError;
const real = errors.filter((e) => !/not wrapped in act|ReactDOMTestUtils/.test(e));
if (real.length) {
  console.log('\nReact errors:');
  real.forEach((e) => console.log('  ', e.slice(0, 400)));
}
await server.close();
if (failures.length || real.length) {
  console.log(`\n${failures.length} failure${failures.length === 1 ? '' : 's'}:`);
  failures.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
console.log('\nEvery row-menu verb reaches the API it should.');
process.exit(0);
