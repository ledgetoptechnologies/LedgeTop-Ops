import { defineConfig } from "vitest/config";
// Explicit opt-in: requires local Docker and the exact Windows .NET SDK.
export default defineConfig({ resolve: { preserveSymlinks: true }, test: {
  environment: "node", include: ["test/windows-employee-transport.acceptance.ts"],
  fileParallelism: false, testTimeout: process.env.LEDGETOP_EMPLOYEE_LARGE === "1" ? 600_000 : 240_000,
} });
