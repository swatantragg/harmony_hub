import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The API is proxied in development so the browser sees one origin and no CORS preflight
// sits between the app and its own control plane.
//
// Upload bytes are NOT proxied: they go straight from the browser to a Google Drive
// resumable session URI, which is the whole point of the design (P2). Google mirrors the
// request's Origin into that session's CORS policy, so the origin the browser is served
// from has to be in CORS_ORIGINS or the upload is refused before it starts.

/**
 * Emits dist/sw.js from service-worker.js, with the precache list and a build revision
 * substituted in.
 *
 * This is deliberately not workbox: the caching policy here is four rules long and most of
 * it is a list of things NOT to cache (see service-worker.js). What a generator would buy
 * is the precache manifest, which is the twenty lines below.
 *
 * The revision is a hash of the precache list itself. That matters more than it looks: the
 * browser decides a worker is "new" by byte-comparing sw.js, so the revision has to change
 * when — and only when — the assets do. A timestamp would prompt every reader to reload
 * after a rebuild that changed nothing.
 */
function pwa(): Plugin {
  let root = '';
  let outDir = '';

  return {
    name: 'gcloud-pwa',
    apply: 'build',

    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },

    // writeBundle, not generateBundle: index.html is emitted by Vite's own HTML plugin and
    // public/ is copied by Vite's asset step, and neither has necessarily happened while
    // generateBundle is running. Reading the finished directory is the only listing that
    // is guaranteed to be complete — and it is what the browser will actually be served.
    writeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) walk(full);
          else files.push(full);
        }
      };
      walk(outDir);

      const url = (full: string) => `/${relative(outDir, full).split(sep).join('/')}`;
      const precache = files
        .map(url)
        // Sourcemaps are for a debugger, not for an offline launch. sw.js cannot precache
        // itself — the browser fetches it outside the cache, by design.
        .filter((f) => !f.endsWith('.map') && f !== '/sw.js')
        .sort();

      // Hashed over the bytes, not the names. The names alone would miss an index.html
      // that changed while every asset hash stayed the same — a new meta tag, say — and
      // the worker would never update, because the browser decides "new worker" by
      // byte-comparing sw.js and nothing in it would have moved.
      const digest = createHash('sha256');
      for (const full of files.filter((f) => precache.includes(url(f))).sort()) {
        digest.update(url(full)).update(readFileSync(full));
      }
      const revision = digest.digest('hex').slice(0, 12);

      const template = readFileSync(resolve(root, 'service-worker.js'), 'utf8');
      for (const token of ['__BUILD__', '__PRECACHE__']) {
        if (!template.includes(token)) this.error(`service-worker.js is missing ${token}`);
      }
      // replaceAll, not replace: the tokens must not be mentioned anywhere else in the
      // template, and if one ever is, substituting every copy is the safe reading.
      const source = template
        .replaceAll('__BUILD__', revision)
        .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2));

      // At the root of the origin, so its scope covers the whole app. A worker served from
      // /assets/ could only ever control /assets/.
      writeFileSync(join(outDir, 'sw.js'), source);
      this.info?.(`sw.js — ${precache.length} files precached, revision ${revision}`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const api = env.VITE_API_PROXY || 'http://localhost:8100';

  return {
    plugins: [react(), pwa()],
    server: {
      port: Number(env.VITE_PORT || 8101),
      // Checking a layout on a real phone means the phone has to reach this server, which
      // means binding past the loopback interface. Opt-in rather than default, because
      // that also puts it in front of everything else on the network:
      //   VITE_HOST=0.0.0.0 npm run dev:web
      host: env.VITE_HOST || false,
      proxy: {
        '/api': api,
        '/healthz': api,
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production',
    },
  };
});
