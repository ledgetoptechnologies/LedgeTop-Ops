import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildProfiles, NATIVE_MIGRATION_PROFILES, validateGenerated, writeProfiles } from "./staging-native-migration-profile.mjs";
import { parseRemoteLedgerJson, validateExactRemoteLedger, verifyLiveRemoteLedger } from "./staging-native-migration-ledger-gate.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporary = [];

function fixture(operationsCutoff = 205) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-native-migration-profile-"));
  temporary.push(base);
  fs.writeFileSync(path.join(base, ".gitignore"), "apps/*/wrangler.staging.*.json\napps/*/.staging-bootstrap/\n");
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: base, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(`fixture git init failed: ${initialized.stderr}`);
  for (const [application, contract] of Object.entries(NATIVE_MIGRATION_PROFILES)) {
    const app = path.join(base, "apps", application);
    fs.mkdirSync(app, { recursive: true });
    fs.cpSync(path.join(root, "apps", application, "migrations"), path.join(app, "migrations"), { recursive: true });
    // This fixture rehearses only the frozen Client150/Operations205 contract.
    for (const name of fs.readdirSync(path.join(app, "migrations"))) {
      if (Number(name.slice(0, 4)) > (application === "operations" ? operationsCutoff : 231))
        fs.rmSync(path.join(app, "migrations", name));
    }
    fs.writeFileSync(path.join(app, "wrangler.staging.json"), JSON.stringify({
      name: contract.workerName,
      account_id: "846c924bf17bf4f3dd15c97a4c5d1d51",
      vars: { ENVIRONMENT: "staging", SHOULD_NOT_COPY: "true" },
      main: "do-not-copy.ts",
      routes: [{ pattern: "do-not-copy.example" }],
      d1_databases: [{ binding: contract.binding, database_name: contract.databaseName,
        database_id: contract.databaseId, migrations_dir: "migrations" }],
    }));
  }
  return base;
}

test.afterEach(() => {
  for (const directory of temporary.splice(0)) {
    const resolved = path.resolve(directory), temp = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), temp);
    assert.match(path.basename(resolved), /^ltds-native-migration-profile-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test("accepts the exact latest Client source suffix without changing the frozen rollout window", () => {
  const base=fixture();
  for(const name of ['0232_shared_profile_edit_authority.sql','0233_explicit_primary_workspace_folder_ownership.sql'])
    fs.copyFileSync(path.join(root,'apps','client','migrations',name),path.join(base,'apps','client','migrations',name));
  const profiles=buildProfiles(base);
  assert.deepEqual(profiles.client.files.map(({name})=>name),['0229_operations_portal_native_delivery_regrant.sql','0230_operations_portal_native_delivery_terminal_cancellations.sql']);
  fs.appendFileSync(path.join(base,'apps','client','migrations','0233_explicit_primary_workspace_folder_ownership.sql'),'\n-- changed\n');
  assert.throws(()=>buildProfiles(base),/current repository migration inventory changed/);
});

test("builds only the exact migration suffixes and strips every deployment field", () => {
  const profiles = buildProfiles(fixture());
  assert.deepEqual(profiles.operations.files.map(({ name }) => name),
    [
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
      "0191_operations_portal_native_billing_authority.sql",
      "0192_ops_service_definition_authority.sql",
      "0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
      "0194_operations_portal_native_delivery_terminal_cancellations.sql",
      "0195_client_hub_native_project_current_owner_observation.sql",
      "0196_native_directory_maintenance_authority.sql",
      "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql",
      "0198_native_directory_active_binding_revision_refresh.sql",
      "0199_native_directory_profile_binding_continuations.sql",
    ]);
  assert.deepEqual(profiles.client.files.map(({ name }) => name),
    ["0229_operations_portal_native_delivery_regrant.sql",
      "0230_operations_portal_native_delivery_terminal_cancellations.sql"]);
  assert.equal(profiles.operations.manifest.requiredRemoteBaseline,
    "0183_project_alpha_binding_standalone_relationship_rows.sql");
  assert.equal(profiles.client.manifest.requiredRemoteBaseline,
    "0228_operations_portal_native_content_start_audit.sql");
  assert.equal(profiles.operations.expectedRemoteAppliedMigrations.length, 183);
  assert.equal(profiles.client.expectedRemoteAppliedMigrations.length, 147);
  assert.equal(profiles.operations.manifest.reviewedFinalChain.count, 199);
  assert.equal(profiles.operations.manifest.reviewedFinalChain.finalMigration,
    "0199_native_directory_profile_binding_continuations.sql");
  assert.equal(profiles.operations.manifest.reviewedFinalChain.namesSha256,
    "7be05fcb2b54c3a345b76b1f37e3dbbf33c0f4278b6cabe8307a064549c33821");
  assert.equal(profiles.operations.files.some(({ name }) => /^020[0-5]_/.test(name)), false,
    "the exact current repository suffix is verified but never enters the staging migration-only profile");
  assert.equal(profiles.client.manifest.reviewedFinalChain.count, 149);
  assert.equal(profiles.client.manifest.reviewedFinalChain.finalMigration,
    "0230_operations_portal_native_delivery_terminal_cancellations.sql");
  assert.equal(profiles.client.manifest.reviewedFinalChain.namesSha256,
    "adec3554555949068ac785d0720c6dcddc8813489c98b5c88e88c0afd23ee659");
  for (const profile of Object.values(profiles)) {
    assert.deepEqual(Object.keys(profile.config).sort(), ["$schema", "account_id", "d1_databases", "name"]);
    assert.equal(profile.config.d1_databases.length, 1);
    assert.equal(profile.manifest.remoteActionsPerformed, false);
  }
});

test("rejects a wrong staging database name or ID", () => {
  for (const field of ["database_name", "database_id"]) {
    const base = fixture();
    const file = path.join(base, "apps", "operations", "wrangler.staging.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.d1_databases[0][field] = field === "database_name" ? "ltds-ops" : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => buildProfiles(base), /exact ltds-ops-staging name and ID/);
  }
});

test("rejects an extra SQL file and a changed native migration", () => {
  const extra = fixture();
  fs.writeFileSync(path.join(extra, "apps", "client", "migrations", "0229_unreviewed.sql"), "-- no\n");
  assert.throws(() => buildProfiles(extra), /current repository migration inventory changed/);

  const changed = fixture(199);
  fs.appendFileSync(path.join(changed, "apps", "operations", "migrations",
    "0174_project_alpha_directory_preserved_external_identity.sql"), " ");
  assert.throws(() => buildProfiles(changed), /native candidate changed: 0174_/);
  for (const name of ["0188_client_hub_native_project_preparations.sql",
    "0189_client_hub_native_project_uncertain_recovery.sql",
    "0190_client_hub_native_project_preparation_authority.sql",
    "0191_operations_portal_native_billing_authority.sql",
    "0192_ops_service_definition_authority.sql"]) {
    const currentChanged = fixture(199);
    fs.appendFileSync(path.join(currentChanged, "apps", "operations", "migrations", name), " ");
    assert.throws(() => buildProfiles(currentChanged), new RegExp(`native candidate changed: ${name.slice(0, 4)}_`));
  }
  for (const [application, name] of [["client", "0229_operations_portal_native_delivery_regrant.sql"],
    ["client", "0230_operations_portal_native_delivery_terminal_cancellations.sql"],
    ["client", "0231_portal_primary_private_ingress_authority.sql"],
    ["operations", "0193_operations_portal_native_delivery_dead_conflict_recovery.sql"],
    ["operations", "0194_operations_portal_native_delivery_terminal_cancellations.sql"],
    ["operations", "0195_client_hub_native_project_current_owner_observation.sql"],
    ["operations", "0196_native_directory_maintenance_authority.sql"],
    ["operations", "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql"],
    ["operations", "0198_native_directory_active_binding_revision_refresh.sql"],
    ["operations", "0199_native_directory_profile_binding_continuations.sql"]]) {
    const stableChanged = fixture(application === "operations" ? 199 : 200);
    fs.appendFileSync(path.join(stableChanged, "apps", application, "migrations", name), " ");
    assert.throws(() => buildProfiles(stableChanged), application === "client"
      ? /current repository migration inventory changed/ : new RegExp(`native candidate changed: ${name.slice(0, 4)}_`));
  }
  for (const name of ["0200_native_directory_active_binding_refresh_supersessions.sql", "0201_native_directory_lifecycle.sql",
    "0202_reviewed_import_enrollment.sql", "0203_effective_native_directory_enrollment_consumers.sql", "0204_native_project_archive_restore.sql",
    "0205_native_billing_source_authority.sql"]) {
    const changed = fixture();
    fs.appendFileSync(path.join(changed, "apps", "operations", "migrations", name), " ");
    assert.throws(() => buildProfiles(changed), /current repository migration inventory changed/);
  }
  const unknown = fixture();
  fs.writeFileSync(path.join(unknown, "apps", "operations", "migrations", "0206_unknown.sql"), "SELECT 1;\n");
  assert.throws(() => buildProfiles(unknown), /current repository migration inventory changed/);
});

test("rejects a partial current 204/205 suffix without admitting an orphan tail", () => {
  for (const name of ["0204_native_project_archive_restore.sql", "0205_native_billing_source_authority.sql"]) {
    const partial = fixture();
    fs.rmSync(path.join(partial, "apps", "operations", "migrations", name));
    assert.throws(() => buildProfiles(partial), /current repository migration suffix is incomplete/);
  }
});

test("accepts exact historical 0187, 0190, 0192, 0194, 0195, and 0196 chains but rejects partial successors", () => {
  const historical = fixture(196);
  for (const name of ["0188_client_hub_native_project_preparations.sql",
    "0189_client_hub_native_project_uncertain_recovery.sql",
    "0190_client_hub_native_project_preparation_authority.sql",
    "0191_operations_portal_native_billing_authority.sql",
    "0192_ops_service_definition_authority.sql",
    "0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
    "0194_operations_portal_native_delivery_terminal_cancellations.sql",
    "0195_client_hub_native_project_current_owner_observation.sql", "0196_native_directory_maintenance_authority.sql"])
    fs.rmSync(path.join(historical, "apps", "operations", "migrations", name));
  const profile = buildProfiles(historical).operations;
  assert.equal(profile.manifest.reviewedFinalChain.count, 187);
  assert.equal(profile.manifest.finalMigration, "0187_operations_portal_native_delivery_literal_prefix_guard.sql");

  const historical190 = fixture(196);
  for (const name of ["0191_operations_portal_native_billing_authority.sql", "0192_ops_service_definition_authority.sql",
    "0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
    "0194_operations_portal_native_delivery_terminal_cancellations.sql",
    "0195_client_hub_native_project_current_owner_observation.sql", "0196_native_directory_maintenance_authority.sql"])
    fs.rmSync(path.join(historical190, "apps", "operations", "migrations", name));
  const profile190 = buildProfiles(historical190).operations;
  assert.equal(profile190.manifest.reviewedFinalChain.count, 190);
  assert.equal(profile190.manifest.finalMigration, "0190_client_hub_native_project_preparation_authority.sql");

  const historical192 = fixture(196);
  for (const name of ["0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
    "0194_operations_portal_native_delivery_terminal_cancellations.sql",
    "0195_client_hub_native_project_current_owner_observation.sql", "0196_native_directory_maintenance_authority.sql"])
    fs.rmSync(path.join(historical192, "apps", "operations", "migrations", name));
  const profile192 = buildProfiles(historical192).operations;
  assert.equal(profile192.manifest.reviewedFinalChain.count, 192);
  assert.equal(profile192.manifest.finalMigration, "0192_ops_service_definition_authority.sql");

  const historical194 = fixture(196);
  for (const name of ["0195_client_hub_native_project_current_owner_observation.sql", "0196_native_directory_maintenance_authority.sql"])
    fs.rmSync(path.join(historical194, "apps", "operations", "migrations", name));
  const profile194 = buildProfiles(historical194).operations;
  assert.equal(profile194.manifest.reviewedFinalChain.count, 194);
  assert.equal(profile194.manifest.reviewedFinalChain.namesSha256,
    "21797f48e9c38621119a6e78eb431594609ae5520aea9036f1e5db288a984a10");
  assert.equal(profile194.manifest.finalMigration,
    "0194_operations_portal_native_delivery_terminal_cancellations.sql");
  assert.equal(profile194.files.some(({ name }) => name.startsWith("0195_")), false);
  assert.equal(profile194.manifest.expectedAppliedMigrations.some(name => name.startsWith("0195_")), false);

  const historical195 = fixture(196);
  fs.rmSync(path.join(historical195, "apps", "operations", "migrations", "0196_native_directory_maintenance_authority.sql"));
  const profile195 = buildProfiles(historical195).operations;
  assert.equal(profile195.manifest.reviewedFinalChain.count, 195);
  assert.equal(profile195.manifest.reviewedFinalChain.namesSha256,
    "3aecb42400d7a5e95687cca3eb256e880aa306dd4184747c0171f6301ffb71fd");
  assert.equal(profile195.manifest.finalMigration, "0195_client_hub_native_project_current_owner_observation.sql");

  const profile196 = buildProfiles(fixture(196)).operations;
  assert.equal(profile196.manifest.reviewedFinalChain.count, 196);
  assert.equal(profile196.manifest.finalMigration, "0196_native_directory_maintenance_authority.sql");
  assert.equal(profile196.manifest.reviewedFinalChain.namesSha256,
    "c8f55f7a543d1e51d69abce753c2ce54a4640c35fd93c2769c8e971bb8162106");
  assert.deepEqual(profile196.manifest.expectedAppliedMigrations,
    NATIVE_MIGRATION_PROFILES.operations.expectedAppliedMigrations.slice(0, -3));
  const profile198 = buildProfiles(fixture(198)).operations;
  assert.equal(profile198.manifest.reviewedFinalChain.count, 198);
  assert.equal(profile198.manifest.reviewedFinalChain.namesSha256,
    "d88ba83a54c045e5eb416fb912324047d68160f9f198e6b56591f0f0909788f2");
  const profile199 = buildProfiles(fixture(199)).operations;
  assert.equal(profile199.manifest.reviewedFinalChain.count, 199);
  assert.equal(profile199.manifest.finalMigration, "0199_native_directory_profile_binding_continuations.sql");
  assert.equal(profile199.manifest.reviewedFinalChain.namesSha256,
    "7be05fcb2b54c3a345b76b1f37e3dbbf33c0f4278b6cabe8307a064549c33821");
  assert.equal(profile196.files.some(({ name }) => /^019[78]_/.test(name)), false);
  assert.throws(() => buildProfiles(fixture(197)), /not an exact reviewed historical or current chain/);
  const missing197 = fixture(199);
  fs.rmSync(path.join(missing197, "apps", "operations", "migrations",
    "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql"));
  assert.throws(() => buildProfiles(missing197), /not an exact reviewed historical or current chain/);

  for (const remove of [["0190_client_hub_native_project_preparation_authority.sql"],
    ["0189_client_hub_native_project_uncertain_recovery.sql"],
    ["0189_client_hub_native_project_uncertain_recovery.sql", "0190_client_hub_native_project_preparation_authority.sql"]]) {
    const partial = fixture(199);
    for (const name of remove) fs.rmSync(path.join(partial, "apps", "operations", "migrations", name));
    assert.throws(() => buildProfiles(partial), /not an exact reviewed historical or current chain/);
  }
  const unknown = fixture(199);
  fs.writeFileSync(path.join(unknown, "apps", "operations", "migrations", "0197_unknown.sql"), "SELECT 1;\n");
  assert.throws(() => buildProfiles(unknown), /pinned base migration inventory changed/);
});

test("accepts the exact historical Client 147 chain", () => {
  const historical = fixture();
  for (const name of ["0229_operations_portal_native_delivery_regrant.sql",
    "0230_operations_portal_native_delivery_terminal_cancellations.sql", "0231_portal_primary_private_ingress_authority.sql"])
    fs.rmSync(path.join(historical, "apps", "client", "migrations", name));

  const profile = buildProfiles(historical).client;
  assert.deepEqual(profile.files, []);
  assert.deepEqual(profile.manifest.expectedAppliedMigrations, []);
  assert.equal(profile.manifest.reviewedFinalChain.count, 147);
  assert.equal(profile.manifest.finalMigration, "0228_operations_portal_native_content_start_audit.sql");
});

test("rejects a missing or changed pinned base migration", () => {
  const missing = fixture(199);
  fs.rmSync(path.join(missing, "apps", "operations", "migrations", "0001_operations.sql"));
  assert.throws(() => buildProfiles(missing), /pinned base migration inventory changed/);

  const changed = fixture();
  fs.appendFileSync(path.join(changed, "apps", "client", "migrations", "0001_initial.sql"), " ");
  assert.throws(() => buildProfiles(changed), /current repository migration inventory changed/);
});

test("writes deterministic ignored outputs and detects stale or extra output", () => {
  const base = fixture();
  const profiles = writeProfiles(base);
  assert.equal(validateGenerated(base, profiles), true);
  writeProfiles(base);
  assert.equal(validateGenerated(base), true);
  const config = JSON.parse(fs.readFileSync(profiles.client.configPath, "utf8"));
  assert.equal(config.vars, undefined);
  assert.equal(config.main, undefined);
  assert.equal(config.d1_databases[0].database_id, NATIVE_MIGRATION_PROFILES.client.databaseId);

  const generated0184 = path.join(profiles.operations.migrationsDirectory,
    "0184_project_alpha_directory_relationship_generation_recovery.sql");
  const lfOnly = fs.readFileSync(generated0184, "utf8");
  assert.equal(lfOnly.includes("\r"), false);
  fs.writeFileSync(generated0184, lfOnly.replace("\n", "\r\n"));
  assert.throws(() => validateGenerated(base), /generated migration must use LF-only line endings: 0184_/);
  writeProfiles(base);

  fs.appendFileSync(path.join(profiles.operations.migrationsDirectory,
    NATIVE_MIGRATION_PROFILES.operations.expectedAppliedMigrations[0]), " ");
  assert.throws(() => validateGenerated(base), /generated migration changed/);

  writeProfiles(base);
  fs.writeFileSync(path.join(profiles.operations.migrationsDirectory, "unexpected.sql"), "-- no\n");
  assert.throws(() => validateGenerated(base), /stale or contains extras/);
  assert.throws(() => writeProfiles(base), /unexpected or unsafe entry unexpected.sql/);
});

test("refuses output symlinks and unignored output paths", (t) => {
  const unignored = fixture();
  fs.writeFileSync(path.join(unignored, ".gitignore"), "node_modules/\n");
  assert.throws(() => buildProfiles(unignored), /not effectively ignored/);

  const overridden = fixture();
  fs.appendFileSync(path.join(overridden, ".gitignore"), "!apps/client/wrangler.staging.native-migrations.json\n");
  assert.throws(() => buildProfiles(overridden), /not effectively ignored: apps\/client\/wrangler\.staging\.native-migrations\.json/);

  const base = fixture();
  const profiles = buildProfiles(base);
  fs.mkdirSync(path.dirname(profiles.client.configPath), { recursive: true });
  try { fs.symlinkSync(path.join(base, "outside.json"), profiles.client.configPath, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) { t.skip(`symlinks unavailable: ${error.code}`); return; }
    throw error;
  }
  assert.throws(() => writeProfiles(base, profiles), /generated config must be a regular non-symlink file/);
});

test("refuses a nested ignore override or tracked concrete generated migration", () => {
  const overridden = fixture();
  const name = NATIVE_MIGRATION_PROFILES.operations.expectedAppliedMigrations[0];
  fs.appendFileSync(path.join(overridden, ".gitignore"), [
    "!apps/operations/.staging-bootstrap/",
    "!apps/operations/.staging-bootstrap/native-portal-migrations/",
    "apps/operations/.staging-bootstrap/native-portal-migrations/manifest.json",
    "!apps/operations/.staging-bootstrap/native-portal-migrations/migrations/",
    "apps/operations/.staging-bootstrap/native-portal-migrations/migrations/*",
    `!apps/operations/.staging-bootstrap/native-portal-migrations/migrations/${name}`,
    "",
  ].join("\n"));
  assert.throws(() => buildProfiles(overridden), new RegExp(`not effectively ignored: .*${name}`));

  const tracked = fixture();
  const profiles = writeProfiles(tracked);
  const trackedPath = path.join(profiles.operations.migrationsDirectory,
    NATIVE_MIGRATION_PROFILES.operations.expectedAppliedMigrations[0]);
  const added = spawnSync("git", ["add", "-f", "--", path.relative(tracked, trackedPath)],
    { cwd: tracked, encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  assert.throws(() => buildProfiles(tracked), /generated output must not be tracked/);
});

test("live ledger gate uses only a read-only query and requires the exact pre-suffix history", () => {
  const base = fixture();
  const installedWrangler = path.join(base, "mock-wrangler.js");
  fs.writeFileSync(installedWrangler, "// Never executed: the test injects its read-only command runner.\n", { flag: "wx" });
  const profiles = writeProfiles(base);
  const expected = profiles.client.expectedRemoteAppliedMigrations;
  let invocation;
  const verified = verifyLiveRemoteLedger(base, "client", (executable, args, options) => {
    invocation = { executable, args, options };
    return {
      status: 0,
      stdout: JSON.stringify([{ success: true, results: expected.map((name) => ({ name })) }]),
      stderr: "",
    };
  }, { cliPath: installedWrangler });
  assert.equal(verified.baseline, NATIVE_MIGRATION_PROFILES.client.remoteBaseline);
  assert.deepEqual(invocation.args.slice(0, 5), [installedWrangler, "d1", "execute", "DELIVERY_DB", "--remote"]);
  assert.ok(invocation.args.includes("--json"));
  assert.ok(invocation.args.includes('SELECT name FROM "d1_migrations" ORDER BY id'));
  assert.equal(invocation.args.includes("apply"), false);

  for (const actual of [expected.slice(1), [...expected, "0223_unexpected.sql"], [...expected].reverse()]) {
    assert.throws(() => validateExactRemoteLedger(profiles.client, actual), /not the exact pinned pre-suffix history/);
  }
  assert.throws(() => parseRemoteLedgerJson("not json"), /not strict JSON/);
  assert.throws(() => parseRemoteLedgerJson(JSON.stringify([{ success: false, results: [] }])), /unsuccessful or malformed/);
});

test("live ledger gate fails closed when the remote read cannot be completed", () => {
  const base = fixture();
  const installedWrangler = path.join(base, "mock-wrangler.js");
  fs.writeFileSync(installedWrangler, "// Never executed: the test injects its failing command runner.\n", { flag: "wx" });
  writeProfiles(base);
  assert.throws(() => verifyLiveRemoteLedger(base, "operations", () => ({
    status: 1,
    stdout: "",
    stderr: "authentication unavailable",
  }), { cliPath: installedWrangler }), /read-only remote ledger query failed: authentication unavailable/);
});

test("live ledger gate rejects a missing pinned launcher before invoking any runner", () => {
  const base = fixture();
  writeProfiles(base);
  let invoked = false;
  assert.throws(() => verifyLiveRemoteLedger(base, "client", () => {
    invoked = true;
    throw new Error("runner must not execute");
  }, { cliPath: path.join(base, "missing-wrangler.js") }), /pinned Wrangler CLI entrypoint is missing/);
  assert.equal(invoked, false);
});

test("current migration profile refuses hidden uppercase SQL", () => {
  const base = fixture();
  fs.writeFileSync(path.join(base, "apps/operations/migrations/unreviewed.SQL"), "SELECT 1;");
  assert.throws(() => buildProfiles(base), /canonical migration names/);
});
