// Explicit opt-in: actual bundled Workerd processes and local synthetic D1/R2 only.
import { defineConfig } from "vitest/config";
export default defineConfig({ resolve: { preserveSymlinks: true }, test: {
  environment: "node", include: ["integration/windows-workerd-rpc.acceptance.ts"], fileParallelism: false, testTimeout: 300_000, hookTimeout: 120_000,
} });
