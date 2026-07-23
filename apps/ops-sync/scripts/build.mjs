import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.WRANGLER_LOG_PATH = path.join(os.tmpdir(), "ltds-wrangler-logs");
process.env.WRANGLER_WRITE_LOGS = "false";

const result = spawnSync(
  process.execPath,
  [
    path.resolve("node_modules/wrangler/bin/wrangler.js"),
    "deploy",
    "--dry-run",
    "--outdir",
    "dist",
  ],
  { stdio: "inherit", env: process.env },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
