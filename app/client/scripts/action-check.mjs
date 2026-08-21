// Front-end behaviour check:  npm run smoke:actions
//
// The companion to render-check.mjs, which proves the screens mount but asserts nothing
// about what they do. This one drives the verbs — share a folder, move a folder, move a
// file — the way a person does: open the "…" menu, press an entry, fill the dialog, press
// the button, and check what reached the API.
//
// It exists because every one of those verbs was dead at once and nothing caught it. The
// row menu closed itself on `mousedown`, in the capture phase, before the `click` that
// would have run the entry's handler was ever dispatched — so the menu opened, the entries
// looked right, and pressing one did nothing at all. A mount check cannot see that; only
// dispatching a real mousedown/mouseup/click can.
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
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ── Fixtures, shaped like the real payloads ──────────────────────────────── */

const folder = (id, name, parentId = null) => ({
  _id: id, name, description: '', tags: [], driveFolderId: `d_${id}`, driveWebViewLink: null,
  parentId, parentName: null, subfolderCount: 0, songId: null, artistId: null, songTitle: null,
  artistName: null, createdByName: 'Tester', createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  // Nothing filed directly, everything one level down — the shape that used to grey the
  // Share entry out on a folder with a hundred files in it.
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

// Filled in below, once `asset` exists.
const folderDetail = {
  ...folder('fo1', 'Masters'),
  breadcrumb: [{ _id: 'fo1', name: 'Masters' }],
  subfolders: [folder('fo3', '2024', 'fo1')],
  assetCount: 1, assets: [], assetsByFamily: {},
};

// A folder that holds nothing but folders — no "All" tab to land on.
const foldersOnly = {
  ...folder('fo9', 'Releases'),
  breadcrumb: [{ _id: 'fo9', name: 'Releases' }],
  subfolders: [folder('fo3', '2024', 'fo9'), folder('fo4', '2025', 'fo9')],
  assetCount: 0, assets: [], assetsByFamily: {},
};

const FIXTURES = {
  '/assets/a1': null,        // filled in below, once `asset` exists
  '/folders/fo1': folderDetail,
  '/folders/fo9': foldersOnly,
  '/folders/lookup/options': [
    { _id: 'fo1', name: 'Masters', path: 'Masters', depth: 0, assetCount: 9 },
    { _id: 'fo2', name: 'Artwork', path: 'Artwork', depth: 0, assetCount: 3 },
    { _id: 'fo3', name: '2024', path: 'Masters / 2024', depth: 1, assetCount: 4 },
  ],
  '/folders': { data: [folder('fo1', 'Masters'), folder('fo2', 'Artwork')] },
  '/tags': { languages: ['Hindi'], moods: [], data: [] },
  '/asset-types': { data: [], families: ['Audio'], builtinCount: 0, customCount: 0 },
};

FIXTURES['/assets/a1'] = asset;
folderDetail.assets = [asset];
folderDetail.assetsByFamily = { Audio: [asset] };

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^.*\/api/, '').split('?')[0];
  calls.push({ method: init.method || 'GET', path, body: init.body ? JSON.parse(init.body) : null });
  if (path === '/shares' && init.method === 'POST') {
    return new Response(JSON.stringify({
      _id: 'sh1', url: 'http://x/#/s/tok', audience: 'PUBLIC', audienceLabel: 'Open to all',
      expiresAt: new Date(Date.now() + 6e5).toISOString(), maxDownloads: 10, canDownload: true,
      target: 'FOLDER', fileCount: 9, recipients: [],
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }
  if (path.endsWith('/assets') && init.method === 'POST') {
    return new Response(JSON.stringify({ ok: true, moved: 1, failed: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const key = Object.keys(FIXTURES).sort((a, b) => b.length - a.length)
    .find((k) => path === k || path.startsWith(`${k}/`));
  return new Response(JSON.stringify(key ? FIXTURES[key] : { data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
};

/* ── Harness ──────────────────────────────────────────────────────────────── */

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
const { MemoryRouter, Routes, Route } = await import('react-router');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { FolderList, FolderDetail } = await server.ssrLoadModule('/src/features/folders/Folders.tsx');
const { AssetDrawer } = await server.ssrLoadModule('/src/features/assets/AssetDrawer.tsx');
const { AssetList } = await server.ssrLoadModule('/src/features/assets/AssetCard.tsx');
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
      el(MemoryRouter, { initialEntries: [path] }, el(Routes, null, el(Route, { path: '/folders/:id', element }), el(Route, { path: '/', element }))))));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
};

// A real press: mousedown, then mouseup and click. Splitting them is the whole point —
// the bug this file guards against lived entirely in the gap between the two.
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

/* ── Folder list: the "…" menu and the verbs behind it ────────────────────── */

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

await press([...document.querySelectorAll('.move-option')].find((b) => /Artwork/.test(b.textContent)), 'Artwork');
const moveBtn = footBtn(/Move here/);
check('Move here is enabled once a different destination is picked', moveBtn && !moveBtn.disabled);
await press(moveBtn, 'Move here');
const patched = calls.find((c) => c.method === 'PATCH' && c.path === '/folders/fo1');
check('the move is sent as a re-parent', patched?.body?.parentId === 'fo2', JSON.stringify(patched?.body));
check('the dialog closes on success', !document.querySelector('.scrim'));

/* ── File list: the same menu on a row in a table ─────────────────────────── */

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

/* ── Sharing without the menu ─────────────────────────────────────────────
   "Directly", from the button in the file's own details panel — a different render path
   from the row menu, and one that stacks a modal on top of a drawer. */

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

/* ── Folder detail: the same verbs from the page header ──────────────────── */

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

/* ── Dismissal still works ───────────────────────────────────────────────── */

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

/* ── Report ──────────────────────────────────────────────────────────────── */

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
