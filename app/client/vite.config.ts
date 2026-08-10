import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The API is proxied in development so the browser sees one origin and no CORS preflight
// sits between the app and its own control plane.
//
// Upload bytes are NOT proxied: they go straight from the browser to a Google Drive
// resumable session URI, which is the whole point of the design (P2). Google mirrors the
// request's Origin into that session's CORS policy, so the origin the browser is served
// from has to be in CORS_ORIGINS or the upload is refused before it starts.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const api = env.VITE_API_PROXY || 'http://localhost:8100';

  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORT || 8101),
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
