// Opt-in full Worker boundary test. No Docker gateway, cloud resource or real credentials.
import { defineConfig } from "vitest/config";
export default defineConfig({ resolve: { preserveSymlinks: true }, test: {
  environment: "node", include: ["test/windows-employee-workerd.acceptance.ts"], fileParallelism: false, testTimeout: 240_000,
} });
