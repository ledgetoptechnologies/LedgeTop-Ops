import { spawnSync } from "node:child_process";
import { validateFiles } from "./staging-preflight.mjs";

if (process.argv.length !== 2) {
  console.error("This preparation command accepts no arguments and never deploys.");
  process.exit(2);
}
const errors = validateFiles();
if (errors.length) {
  console.error("Refusing release preparation because staging preflight failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
for (const script of ["check", "test", "build"]) {
  const result = spawnSync("npm", ["run", script], { shell: process.platform === "win32", stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`Refusing release preparation because npm run ${script} failed.`);
    process.exit(result.status ?? 1);
  }
}
console.log("Local staging release gates passed.\nNo migration, secret, Cloudflare API, or deployment command was run.\nFollow docs/staging/README.md only after separate release approval.");
