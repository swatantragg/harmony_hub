import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { BUILD_TAG } from './src/lib/version';
import { CURRENT_RELEASE } from './src/lib/releaseNotes';

// Fetched by a running tab to find out whether what is on the server is still
// what it is running. Deliberately kept out of the precache and served
// network-only by the service worker — a cached copy of it says nothing.
const VERSION_FILE = '/version.json';


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
        .filter((f) => !f.endsWith('.map') && f !== '/sw.js' && f !== VERSION_FILE)
        .filter((f) => !f.startsWith('/fonts/'))
        .sort();
      const digest = createHash('sha256');
      for (const full of files.filter((f) => precache.includes(url(f))).sort()) {
        digest.update(url(full)).update(readFileSync(full));
      }
      const revision = digest.digest('hex').slice(0, 12);
      const template = readFileSync(resolve(root, 'service-worker.js'), 'utf8');
      for (const token of ['__BUILD__', '__PRECACHE__']) {
        if (!template.includes(token)) this.error(`service-worker.js is missing ${token}`);
      }
      const source = template
        .replaceAll('__BUILD__', revision)
        .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2));

      writeFileSync(join(outDir, 'sw.js'), source);

      // The revision, not the build tag, is what says "this is a different
      // deploy": two builds of the same tagged release still differ here.
      writeFileSync(
        join(outDir, VERSION_FILE.slice(1)),
        `${JSON.stringify({
          version: BUILD_TAG,
          revision,
          builtAt: new Date().toISOString(),
          release: CURRENT_RELEASE,
        }, null, 2)}\n`,
      );

      this.info?.(`sw.js — ${precache.length} files precached, revision ${revision}`);
      this.info?.(`version.json — ${BUILD_TAG} (${revision})`);
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