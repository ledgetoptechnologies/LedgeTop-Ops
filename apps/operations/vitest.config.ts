import { defineConfig } from "vitest/config";

const windowsMiniflare = process.platform === "win32";
const constrainedMiniflare = windowsMiniflare || process.env.CI === "true";

export default defineConfig({
  resolve: { preserveSymlinks: true },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Miniflare's loopback proxies can collide when many D1 suites start in
    // parallel on Windows, while shared CI runners can briefly starve an
    // otherwise healthy proxy request. Keep Linux CI parallel, but give both
    // constrained environments the same bounded request/startup allowance.
    fileParallelism: !windowsMiniflare,
    testTimeout: constrainedMiniflare ? 30_000 : 5_000,
    hookTimeout: constrainedMiniflare ? 30_000 : 10_000,
  },
});
