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

test("accepts only exact immutable reviewed artifact prefixes through 0199", () => {
  const migrationNames = names();
  for (const count of [184, 185, 186, 187, 190, 192, 194, 195, 196, 198, 199]) {
    const chain = validateAuthorityMigrationChainV185(root, migrationNames.slice(0, count), fail);
    assert.equal(chain.count, count);
    assert.equal(chain.final, migrationNames[count - 1]);
  }
  for (const count of [188, 189, 197]) assert.throws(() =>
    validateAuthorityMigrationChainV185(root, migrationNames.slice(0, count), fail),
    /exact authority artifact migration chain/);
  assert.throws(() => validateAuthorityMigrationChainV185(root,
    [...migrationNames.slice(0, 185), "0186_unknown.sql"], fail), /exact authority artifact migration chain/);
});

test("rejects altered reviewed migrations and an unknown repository suffix", () => {
  for (const mutate of [
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0184_project_alpha_directory_relationship_generation_recovery.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0185_project_alpha_directory_binding_generation_epochs.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0186_project_alpha_directory_conflict_evidence_binding.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0188_client_hub_native_project_preparations.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0189_client_hub_native_project_uncertain_recovery.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0190_client_hub_native_project_preparation_authority.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0191_operations_portal_native_billing_authority.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0192_ops_service_definition_authority.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0193_operations_portal_native_delivery_dead_conflict_recovery.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0194_operations_portal_native_delivery_terminal_cancellations.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0195_client_hub_native_project_current_owner_observation.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0196_native_directory_maintenance_authority.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql"), " "),
    base => fs.appendFileSync(path.join(base, "apps", "operations", "migrations",
      "0198_native_directory_active_binding_revision_refresh.sql"), " "),
    base => fs.writeFileSync(path.join(base, "apps", "operations", "migrations", "0199_unknown.sql"), "SELECT 1;\n"),
  ]) {
    const base = fixture(); mutate(base);
    assert.throws(() => validateAuthorityMigrationChainV185(base, names(base), fail),
      /exact reviewed 0199 migration chain/);
  }
});
