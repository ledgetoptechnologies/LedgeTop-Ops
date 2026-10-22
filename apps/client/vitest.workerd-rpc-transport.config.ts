// Explicit opt-in: loopback TLS/.NET plus local multiworker Workerd RPC and owned synthetic D1/R2.
import { defineConfig } from "vitest/config";
export default defineConfig({ resolve: { preserveSymlinks: true }, test: {
  environment: "node", include: ["integration/windows-workerd-rpc-transport.acceptance.ts"],
  fileParallelism: false, testTimeout: 300_000, hookTimeout: 120_000,
} });
