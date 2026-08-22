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
// jsdom implements no layout, so it ships neither of these. Both are universally available
// in browsers; stubbing them here is closing a gap in the harness, not working around the
// product.
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
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
folderDetail.assets = [asset];
folderDetail.assetsByFamily = { Audio: [asset] };

const calls = [];
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
const { Users } = await server.ssrLoadModule('/src/features/admin/Users.tsx');
const { ActivityLog } = await server.ssrLoadModule('/src/features/admin/ActivityLog.tsx');
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

/* ── People: suspend, restore, delete ─────────────────────────────────────── */

console.log('\nPeople');
await mount(el(Users));
const personRow = (name) => [...document.querySelectorAll('.person-row')]
  .find((r) => r.querySelector('.row-title')?.textContent.startsWith(name));
check('every account renders', document.querySelectorAll('.person-row').length === 3);
check('a suspended account says so', /suspended/.test(personRow('Old Account')?.textContent ?? ''));
check('the signed-in account is marked', /you/.test(personRow('Test Admin')?.querySelector('.row-title')?.textContent ?? ''));

// An active person: suspend is offered, delete is offered.
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

// A suspended person: restore instead of suspend.
await press(personRow('Old Account').querySelector('.row-menu-trigger'), 'Old Account menu');
items = [...document.querySelectorAll('.row-menu-item')].map((b) => b.textContent.trim());
check('a suspended account offers Restore instead of Suspend',
  items.join('|') === 'Restore access|Delete account', items.join(' | '));
await press(menuItem('Restore access'), 'Restore access');
await press(footBtn(/Restore access/), 'confirm restore');
const restored = calls.find((c) => c.method === 'PATCH' && c.path === '/admin/users/u3');
check('restoring sends the status', restored?.body?.status === 'active', JSON.stringify(restored?.body));

// Deleting: typed name plus the administrator's own password, and it says what it detaches.
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

// The one account it must refuse.
await press(personRow('Test Admin').querySelector('.row-menu-trigger'), 'own menu');
const own = [...document.querySelectorAll('.row-menu-item')];
check('your own account cannot be suspended or deleted from here',
  own.length === 2 && own.every((b) => b.disabled), own.map((b) => `${b.textContent.trim()}:${b.disabled}`).join(' | '));
await act(async () => {
  document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
});

/* ── Dropdowns ────────────────────────────────────────────────────────────
   Every native <select> was replaced with a portalled listbox, so the things a native one
   gave away for free have to be proven rather than assumed. */

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

// Choosing re-sorts the list behind it.
await press([...document.querySelectorAll('.select-option')].find((o) => /Name — Z to A/.test(o.textContent)), 'Z to A');
check('choosing closes the list', !listbox());
check('the trigger shows the new value', trigger()?.textContent.trim() === 'Name — Z to A', trigger()?.textContent);
check('the choice actually applied',
  [...document.querySelectorAll('.row-item .row-title')].map((s) => s.textContent).join() === 'Masters,Artwork',
  [...document.querySelectorAll('.row-item .row-title')].map((s) => s.textContent).join());

// Keyboard: the affordances a native select gave away for free.
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

// Dismissal, the bug class the row menu already taught us about.
await press(trigger(), 'sort trigger');
await act(async () => {
  document.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
});
check('a press outside closes the list', !listbox());

/* ── The calendar ─────────────────────────────────────────────────────────
   `<input type="date">` had its picker drawn by the browser. This one is ours, so the day
   it lands on has to be proven — a date filter that quietly moves a day either side of
   midnight is worse than no filter, and that is exactly what parsing an ISO string as UTC
   would do west of Greenwich. */

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

// The timezone trap: pick the 15th and the value must be the 15th.
await press(dayNamed(15), 'the 15th');
const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-15`;
const fromCall = [...calls].reverse().find((c) => c.path === '/admin/activity');
check('choosing a day closes the calendar', !calendar());
check('the chosen day survives the round trip to YYYY-MM-DD, with no timezone drift',
  (fromCall?.path ?? '') && decodeURIComponent(String(fromCall?.raw ?? '')).includes(expected),
  `expected ${expected} in ${fromCall?.raw}`);
check('the trigger now reads the date, not the placeholder',
  !dateTriggers()[0].textContent.includes('Any date'), dateTriggers()[0].textContent);

// The other end is bounded by the first, so a range cannot be put out of order.
await press(dateTriggers()[1], 'To');
const blocked = [...document.querySelectorAll('.calendar-day:not(.outside)')]
  .filter((b) => b.disabled).map((b) => b.textContent.trim());
check('the To end refuses every day before the From end',
  blocked.length === 14 && blocked[0] === '1' && blocked.at(-1) === '14', blocked.join(','));

// Keyboard.
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

// Clearing, without opening the panel to undo opening the panel.
const clearBtn = dateTriggers()[0].querySelector('.date-clear');
check('a set date offers an inline clear', !!clearBtn);
await press(clearBtn, 'clear');
check('clearing empties the field', dateTriggers()[0].textContent.includes('Any date'),
  dateTriggers()[0].textContent);

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
