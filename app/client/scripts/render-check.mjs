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
globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });

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
  const { Help } = await server.ssrLoadModule('/src/features/help/Help.tsx');
  const { ToastHost } = await server.ssrLoadModule('/src/components/ui.tsx');

  const h = React.createElement;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  for (const [name, Page] of [['Login', Login], ['Help', Help]]) {
    const host = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(host);
    const root = createRoot(host);
    root.render(
      h(QueryClientProvider, { client: qc },
        h(MemoryRouter, { initialEntries: ['/'] },
          h(ToastHost, null, h(Routes, null, h(Route, { path: '/', element: h(Page, null) }))))),
    );
    await new Promise((r) => setTimeout(r, 400));
    const text = host.textContent || '';
    if (text.length < 30) throw new Error(`${name} rendered almost nothing (${text.length} chars)`);
    console.log(`  ✓ ${name} mounted — ${host.querySelectorAll('*').length} DOM nodes, ${text.length} chars of text`);
    root.unmount();
  }

  const real = errors.filter((e) => !/not wrapped in act|Warning: ReactDOM/.test(e));
  if (real.length) { console.log(`\n  ✗ ${real.length} console error(s):`); real.slice(0,5).forEach((e)=>console.log('   ',e.slice(0,200))); process.exitCode = 1; }
  else console.log('  ✓ no React errors or warnings');
} finally {
  await server.close();
}
