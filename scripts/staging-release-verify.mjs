import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvidenceFile } from "./staging-evidence.mjs";
import { validateFiles } from "./staging-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.length !== 2) {
  console.error("This verification command accepts no arguments and never deploys.");
  process.exit(2);
}

const errors = [...validateFiles(), ...validateEvidenceFile(root)];
const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.status !== 0) errors.push("git status could not be verified");
else if (status.stdout.trim()) errors.push("working tree must be clean before final staging release verification");
if (errors.length) {
  console.error("Refusing final staging release verification because a gate failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const local = spawnSync("npm", ["run", "staging:release:prepare"], {
  cwd: root,
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (local.status !== 0) process.exit(local.status ?? 1);

console.log("Final staging release verification passed for the exact pushed and deployed commit.\nNo migration, secret, Cloudflare API, or deployment command was run.");
