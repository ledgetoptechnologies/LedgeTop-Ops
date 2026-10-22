import { defineConfig } from "vitest/config";
// Explicit opt-in: bounded owned Docker + actual full local Ops Worker + .NET TLS client.
export default defineConfig({ resolve: { preserveSymlinks: true }, test: {
  environment: "node", include: ["test/windows-employee-workerd-transport.acceptance.ts"],
  fileParallelism: false, testTimeout: 300_000,
} });
