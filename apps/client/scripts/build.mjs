import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.WRANGLER_WRITE_LOGS = "false";

const result = spawnSync(process.execPath, [path.resolve("node_modules/vite/bin/vite.js"), "build"], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
