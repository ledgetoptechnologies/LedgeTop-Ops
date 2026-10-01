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
const installedWrangler = path.join(root, "apps", "client", "node_modules", "wrangler", "bin", "wrangler.js");

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-native-migration-profile-"));
  temporary.push(base);
  fs.writeFileSync(path.join(base, ".gitignore"), "apps/*/wrangler.staging.*.json\napps/*/.staging-bootstrap/\n");
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: base, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(`fixture git init failed: ${initialized.stderr}`);
  for (const [application, contract] of Object.entries(NATIVE_MIGRATION_PROFILES)) {
    const app = path.join(base, "apps", application);
    fs.mkdirSync(app, { recursive: true });
    fs.cpSync(path.join(root, "apps", application, "migrations"), path.join(app, "migrations"), { recursive: true });
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

test("builds only the exact migration suffixes and strips every deployment field", () => {
  const profiles = buildProfiles(fixture());
  assert.deepEqual(profiles.operations.files.map(({ name }) => name),
    [...NATIVE_MIGRATION_PROFILES.operations.expectedAppliedMigrations]);
  assert.deepEqual(profiles.client.files.map(({ name }) => name),
    [...NATIVE_MIGRATION_PROFILES.client.expectedAppliedMigrations]);
  assert.equal(profiles.operations.manifest.requiredRemoteBaseline,
    "0151_verified_recipient_delivery_authority_outbox.sql");
  assert.equal(profiles.client.manifest.requiredRemoteBaseline,
    "0222_verified_recipient_delivery_cross_manager_revoke.sql");
  assert.equal(profiles.operations.manifest.reviewedFinalChain.count, 160);
  assert.equal(profiles.client.manifest.reviewedFinalChain.count, 147);
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
  assert.throws(() => buildProfiles(extra), /pinned base migration inventory changed/);

  const changed = fixture();
  fs.appendFileSync(path.join(changed, "apps", "operations", "migrations",
    "0159_operations_portal_native_delivery_recovery_invocations.sql"), " ");
  assert.throws(() => buildProfiles(changed), /native candidate changed: 0159_/);
});

test("rejects a missing or changed pinned base migration", () => {
  const missing = fixture();
  fs.rmSync(path.join(missing, "apps", "operations", "migrations", "0001_operations.sql"));
  assert.throws(() => buildProfiles(missing), /pinned base migration inventory changed/);

  const changed = fixture();
  fs.appendFileSync(path.join(changed, "apps", "client", "migrations", "0001_initial.sql"), " ");
  assert.throws(() => buildProfiles(changed), /pinned base migration contents changed/);
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

  fs.appendFileSync(path.join(profiles.client.migrationsDirectory,
    NATIVE_MIGRATION_PROFILES.client.expectedAppliedMigrations[0]), " ");
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
  const name = NATIVE_MIGRATION_PROFILES.client.expectedAppliedMigrations[0];
  fs.appendFileSync(path.join(overridden, ".gitignore"), [
    "!apps/client/.staging-bootstrap/",
    "!apps/client/.staging-bootstrap/native-portal-migrations/",
    "apps/client/.staging-bootstrap/native-portal-migrations/manifest.json",
    "!apps/client/.staging-bootstrap/native-portal-migrations/migrations/",
    "apps/client/.staging-bootstrap/native-portal-migrations/migrations/*",
    `!apps/client/.staging-bootstrap/native-portal-migrations/migrations/${name}`,
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
  writeProfiles(base);
  assert.throws(() => verifyLiveRemoteLedger(base, "operations", () => ({
    status: 1,
    stdout: "",
    stderr: "authentication unavailable",
  }), { cliPath: installedWrangler }), /read-only remote ledger query failed: authentication unavailable/);
});
