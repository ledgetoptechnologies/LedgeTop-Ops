import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// In dev, the backend (server/index.js) runs separately (see README) and
// serves /api and /assets; Vite proxies those paths to it so `npm run dev`
// exercises the same code paths as production.
const BACKEND_PORT = process.env.VIEWER_BACKEND_PORT || 8090;

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 8080,
    proxy: {
      '/api': `http://127.0.0.1:${BACKEND_PORT}`,
      '/assets': `http://127.0.0.1:${BACKEND_PORT}`,
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        viewer: resolve(import.meta.dirname, 'index.html'),
        workspace: resolve(import.meta.dirname, 'workspace.html'),
        reviewLaunch: resolve(import.meta.dirname, 'review-launch.html'),
      },
    },
  },
});
