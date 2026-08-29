import { defineConfig } from "vitest/config";

const windowsMiniflare = process.platform === "win32";

export default defineConfig({
  resolve: { preserveSymlinks: true },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Miniflare's loopback proxies can collide when many D1 suites start in
    // parallel on Windows. Keep Linux CI parallel, but make local Windows
    // release checks deterministic and allow for the additional startup cost.
    fileParallelism: !windowsMiniflare,
    testTimeout: windowsMiniflare ? 30_000 : 5_000,
    hookTimeout: windowsMiniflare ? 30_000 : 10_000,
  },
});
