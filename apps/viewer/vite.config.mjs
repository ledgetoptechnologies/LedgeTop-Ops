import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// In dev, the backend (server/index.js) runs separately (see README) and
// serves /api and /assets; Vite proxies those paths to it so `npm run dev`
// exercises the same code paths as production.
const BACKEND_PORT = process.env.VIEWER_BACKEND_PORT || 8090;

// Loads the workspace motion module (workspace-motion.mjs) on the workspace page. It is injected
// here so the page markup stays untouched; it can move into workspace.html as a plain module script.
export const WORKSPACE_MOTION_SCRIPT = '<script type="module" src="/workspace-motion.mjs"></script>';
export function workspaceMotionPlugin() {
  return {
    name: 'ltds-workspace-motion',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (!/(^|[\\/])workspace\.html$/.test(context?.filename || context?.path || '') || html.includes('/workspace-motion.mjs')) return html;
        return html.replace('</body>', `  ${WORKSPACE_MOTION_SCRIPT}\n</body>`);
      },
    },
  };
}

export default defineConfig({
  plugins: [workspaceMotionPlugin()],
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
