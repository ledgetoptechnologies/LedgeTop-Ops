import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const localDependency = (name: string) => path.resolve(import.meta.dirname, "node_modules", ...name.split("/"));

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    // Operations intentionally reuses a small set of Client portal authority
    // modules. Cloudflare installs each Worker from its app root, so package
    // imports inside those sibling sources must resolve from this app's
    // declared dependencies rather than an incidental monorepo node_modules.
    alias: {
      "@ltds/shared": localDependency("@ltds/shared/src/index.ts"),
      "hono/http-exception": localDependency("hono/dist/http-exception.js"),
      "hono/secure-headers": localDependency("hono/dist/middleware/secure-headers/index.js"),
      hono: localDependency("hono/dist/index.js"),
      zod: localDependency("zod/index.js"),
    },
    preserveSymlinks: true,
  },
  build: { sourcemap: true },
});
