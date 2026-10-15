// Test-only immutable source boundary for frozen184/185 authority compilers.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateAuthorityMigrationChainV185 } from "./staging-authority-migration-chain-v185.mjs";
const repository = path.resolve(import.meta.dirname, "..");
let reviewed;
export function reviewed204AuthorityTestRoot() {
  if (reviewed) return reviewed;
  reviewed = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-reviewed204-authority-test-"));
  const directory = path.join(reviewed, "apps/operations/migrations");
  fs.mkdirSync(directory, { recursive: true });
  const source = path.join(repository, "apps/operations/migrations");
  for (const name of fs.readdirSync(source)) {
    if (/^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 204) {
      const file = path.join(source, name);
      assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
      fs.copyFileSync(file, path.join(directory, name));
    }
  }
  const names = fs.readdirSync(directory).sort();
  assert.equal(names.length, 204);
  validateAuthorityMigrationChainV185(reviewed, names.slice(0, 199), message => { throw Error(message); });
  return reviewed;
}
test.after(() => {
  if (!reviewed) return;
  assert.equal(path.dirname(reviewed), path.resolve(os.tmpdir()));
  assert.match(path.basename(reviewed), /^ltds-reviewed204-authority-test-/);
  fs.rmSync(reviewed, { recursive: true, force: true });
});
