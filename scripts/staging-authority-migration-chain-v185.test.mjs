import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateAuthorityMigrationChainV185 } from "./staging-authority-migration-chain-v185.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporary = [];
const fail = message => { throw new Error(message); };

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-authority-chain-"));
  temporary.push(base);
  const destination = path.join(base, "apps", "operations", "migrations");
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(root, "apps", "operations", "migrations"), destination, { recursive: true });
  return base;
}

function names(base = root) {
  return fs.readdirSync(path.join(base, "apps", "operations", "migrations"))
    .filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
}

test.afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("accepts exact immutable 0184 through 0187 artifact prefixes on reviewed 0187", () => {
  const migrationNames = names();
  for (const count of [184, 185, 186, 187]) {
    const chain = validateAuthorityMigrationChainV185(root, migrationNames.slice(0, count), fail);
    assert.equal(chain.count, count);
    assert.equal(chain.final, migrationNames[count - 1]);
  }
  assert.throws(() => validateAuthorityMigrationChainV185(root,
    [...migrationNames.slice(0, 185), "0186_unknown.sql"], fail), /exact authority artifact migration chain/);
});

test("rejects altered reviewed suffixes and an unknown 0188 repository suffix", () => {
  for (const mutate of [
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0185_project_alpha_directory_binding_generation_epochs.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0186_project_alpha_directory_conflict_evidence_binding.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql"), " "),
    base => fs.writeFileSync(path.join(base, "apps", "operations", "migrations", "0188_unknown.sql"), "SELECT 1;\n"),
  ]) {
    const base = fixture(); mutate(base);
    assert.throws(() => validateAuthorityMigrationChainV185(base, names(base).slice(0, 187), fail),
      /exact reviewed 0187 migration chain/);
  }
});
