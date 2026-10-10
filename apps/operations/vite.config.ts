import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const localDependency = (name: string) => path.resolve(import.meta.dirname, "node_modules", ...name.split("/"));
const sharedSource = (name: string) => localDependency(`@ltds/shared/src/${name}.ts`);

export const sharedAliases = [
  { find: "@ltds/shared/authenticated-delivery-authority", replacement: sharedSource("authenticated-delivery-authority") },
  { find: "@ltds/shared/verified-recipient-delivery-authority", replacement: sharedSource("verified-recipient-delivery-authority") },
  { find: "@ltds/shared/api-v2-portal-publication-proof", replacement: sharedSource("api-v2-portal-publication-proof") },
  { find: "@ltds/shared/operations-portal-workspace-publication", replacement: sharedSource("operations-portal-workspace-publication") },
  { find: "@ltds/shared/operations-portal-native-authority", replacement: sharedSource("operations-portal-native-authority") },
  { find: "@ltds/shared/operations-portal-native-delivery-authority", replacement: sharedSource("operations-portal-native-delivery-authority") },
  // A regular expression is required here: Vite string aliases also match package subpaths.
  { find: /^@ltds\/shared$/, replacement: sharedSource("index") },
] as const;

export default defineConfig({
  plugins: [react(), cloudflare()],
  resolve: {
    // Operations intentionally reuses a small set of Client portal authority
    // modules. Cloudflare installs each Worker from its app root, so package
    // imports inside those sibling sources must resolve from this app's
    // declared dependencies rather than an incidental monorepo node_modules.
    alias: [...sharedAliases,
      { find: "hono/http-exception", replacement: localDependency("hono/dist/http-exception.js") },
      { find: "hono/secure-headers", replacement: localDependency("hono/dist/middleware/secure-headers/index.js") },
      { find: "hono", replacement: localDependency("hono/dist/index.js") },
      { find: "zod", replacement: localDependency("zod/index.js") },
    ],
    preserveSymlinks: true,
  },
  build: { sourcemap: true },
});
