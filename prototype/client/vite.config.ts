import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API and the storage endpoint are proxied so the browser sees one origin in
    // development. In production these are the ALB and Amazon S3 respectively.
    proxy: {
      '/api': 'http://localhost:4000',
      '/s3': 'http://localhost:4000',
      '/healthz': 'http://localhost:4000',
    },
  },
});
