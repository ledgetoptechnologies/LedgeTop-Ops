import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvidenceFile } from "./staging-evidence.mjs";
import { validateFiles } from "./staging-preflight.mjs";
import { APP_SOURCE_DIRS } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.length !== 2) {
  console.error("This preparation command accepts no arguments and never deploys.");
  process.exit(2);
}
const errors = [...validateFiles(), ...validateEvidenceFile(root)];
const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.status !== 0) errors.push("git status could not be verified");
else if (status.stdout.trim()) errors.push("working tree must be clean before release preparation");
if (errors.length) {
  console.error("Refusing release preparation because a staging release gate failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
for (const script of ["staging:check:test", "staging:evidence:check:test", "check", "test", "build"]) {
  const result = spawnSync("npm", ["run", script], { shell: process.platform === "win32", stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Refusing release preparation because npm run ${script} failed.`);
    process.exit(result.status ?? 1);
  }
}
for (const app of ["delivery", "operations", "ops-sync"]) {
  const sourceDir = APP_SOURCE_DIRS[app];
  const executable = path.join(root, "apps", sourceDir, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  const result = spawnSync(executable, [
    "deploy", "--dry-run",
    "--config", path.join(root, "apps", sourceDir, "wrangler.staging.json"),
    "--outdir", path.join(root, ".backups", "dry-run", app),
  ], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Refusing release preparation because ${app} staging dry-run failed.`);
    process.exit(result.status ?? 1);
  }
}
console.log("Local staging release gates and explicit-config dry-runs passed.\nNo migration, secret, Cloudflare API, or deployment command was run.\nFollow docs/staging/release-checklist.md only after separate release approval.");
