// Explicit opt-in: this acceptance starts loopback TLS and a local .NET child.
import { defineConfig } from "vitest/config";
export default defineConfig({ resolve: { preserveSymlinks: true }, test: {
  environment: "node", include: ["integration/windows-real-transport.acceptance.ts"],
  fileParallelism: false, testTimeout: 300_000, hookTimeout: 120_000,
} });
