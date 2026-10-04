import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildArtifacts, run, transformSeed, validateGenerated, validateOwner, writeGenerated } from "./staging-bootstrap.mjs";

const owner = Object.freeze({ email: "owner@staging.example.test", displayName: "Synthetic Staging Owner", clientStaffId: "staging-client-owner", operationsStaffId: "staging-operations-owner" });
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const sourceClient = fs.readFileSync(new URL("../apps/client/migrations/0002_seed_initial_staff.sql", import.meta.url), "utf8");
const sourceOperations = fs.readFileSync(new URL("../apps/operations/migrations/0002_seed_acl.sql", import.meta.url), "utf8");

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-staging-bootstrap-"));
  for (const [source, example] of [
    ["client", "delivery.wrangler.json.example"],
    ["operations", "operations.wrangler.json.example"],
  ]) {
    const directory = path.join(base, "apps", source);
    fs.mkdirSync(directory, { recursive: true });
    const sourceMigrations = path.join(repositoryRoot, "apps", source, "migrations");
    const destinationMigrations = path.join(directory, "migrations");
    fs.mkdirSync(destinationMigrations);
    for (const name of fs.readdirSync(sourceMigrations).filter(name => name.endsWith(".sql")))
      fs.copyFileSync(path.join(sourceMigrations, name), path.join(destinationMigrations, name));
    fs.copyFileSync(path.join(repositoryRoot, "docs", "staging", example), path.join(directory, "wrangler.staging.json"));
  }
  for (const source of ["client", "operations", "ops-sync"]) {
    const directory = path.join(base, "apps", source);
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, "apps", source, "wrangler.jsonc"), path.join(directory, "wrangler.jsonc"));
  }
  fs.writeFileSync(path.join(base, "owner.json"), JSON.stringify({ owner }));
  return base;
}

function symlinkOrSkip(t, target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) { t.skip(`symlink creation unavailable: ${error.code}`); return false; }
    throw error;
  }
}

test("rewrites only the two 0002 seeds to one supplied synthetic owner", () => {
  const delivery = transformSeed("delivery", sourceClient, owner);
  assert.match(delivery, /staging-client-owner/);
  assert.equal((delivery.match(/INSERT OR IGNORE INTO staff_users/g) ?? []).length, 1);
  const operations = transformSeed("operations", sourceOperations, owner);
  assert.match(operations, /staging-operations-owner/);
  assert.match(operations, /assignment-staging-owner/);
  assert.doesNotMatch(`${delivery}\n${operations}`, /beau|kollins|chippewa/i);
  assert.match(operations, /role-owner/);
});

test("rejects canonical or non-staging owner identities", () => {
  assert.deepEqual(validateOwner(owner), []);
  assert(validateOwner({ ...owner, email: "beaukoltz@ledgetopdroneservices.com" }).length > 0);
  assert(validateOwner({ ...owner, operationsStaffId: "staff-owner" }).length > 0);
  assert(validateOwner({ ...owner, displayName: "Owner" }).length > 0);
});

test("builds full isolated chains, changes exactly 0002, and preserves staging config", () => {
  const base = fixture();
  const artifacts = buildArtifacts(base, owner);
  for (const [app, artifact] of Object.entries(artifacts)) {
    assert.equal(artifact.files.length, app === "delivery" ? 147 : 171, app);
    assert.deepEqual(artifact.manifest.transformedFiles, [artifact.entry.seed]);
    assert.equal(artifact.files.find(({ name }) => name.startsWith("0001_")).transformed, false);
    assert.equal(artifact.config.name.endsWith("-staging"), true);
    assert.equal(artifact.config.d1_databases[0].migrations_dir, ".staging-bootstrap/migrations");
  }
});

test("writes ignored artifacts idempotently, checks them, and rejects stale output", () => {
  const base = fixture();
  run(["--write", "--values", "owner.json"], base);
  assert.deepEqual(validateGenerated(base, buildArtifacts(base, owner)), []);
  run(["--write", "--values", "owner.json"], base);
  run(["--check", "--values", "owner.json"], base);
  fs.appendFileSync(path.join(base, "apps", "client", ".staging-bootstrap", "migrations", "0001_initial.sql"), "-- drift\n");
  assert.throws(() => run(["--check", "--values", "owner.json"], base), /stale or was edited/);
  assert.throws(() => run(["--write", "--values", "owner.json"], base), /invalid or stale/);
});

test("fails closed on production, ambiguous, filtered, or wrong-database configs", () => {
  for (const mutate of [
    (config) => { config.name = "ledgetop-clients"; },
    (config) => { config.account_id = "production-account"; },
    (config) => { config.vars.ENVIRONMENT = "production"; },
    (config) => { config.d1_databases[0].database_name = "client-data"; },
    (config) => { config.d1_databases[0].migrations_pattern = "*.sql"; },
  ]) {
    const base = fixture();
    const file = path.join(base, "apps", "client", "wrangler.staging.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    mutate(config);
    fs.writeFileSync(file, JSON.stringify(config));
    assert.throws(() => buildArtifacts(base, owner), /staging|canonical migrations directory/);
  }
});

test("rejects a mutated secondary Operations DELIVERY_DB binding", () => {
  const base = fixture();
  const file = path.join(base, "apps", "operations", "wrangler.staging.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.d1_databases.find(({ binding }) => binding === "DELIVERY_DB").database_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  fs.writeFileSync(file, JSON.stringify(config));
  assert.throws(() => buildArtifacts(base, owner), /complete exact reviewed staging D1 binding inventory/);
});

test("rejects any missing or extra canonical migration filename", () => {
  const missing = fixture();
  fs.rmSync(path.join(missing, "apps", "client", "migrations", "0214_ops_inventory_catalog_staging.sql"));
  assert.throws(() => buildArtifacts(missing, owner), /exact complete ordered 147-file chain/);
  const extra = fixture();
  fs.writeFileSync(path.join(extra, "apps", "operations", "migrations", "0123_unreviewed.sql"), "-- unreviewed\n");
  assert.throws(() => buildArtifacts(extra, owner), /exact complete ordered 171-file chain/);
});

test("rejects one-byte content drift in an ordinary canonical migration", () => {
  const base = fixture();
  const file = path.join(base, "apps", "client", "migrations", "0003_delivery_platform.sql");
  fs.appendFileSync(file, " ");
  assert.throws(() => buildArtifacts(base, owner), /delivery canonical migration contents do not match the reviewed full-chain digest/);
});

test("rejects one-byte content drift in either canonical seed before transformation", () => {
  for (const [source, seed, app] of [
    ["client", "0002_seed_initial_staff.sql", "delivery"],
    ["operations", "0002_seed_acl.sql", "operations"],
  ]) {
    const base = fixture();
    fs.appendFileSync(path.join(base, "apps", source, "migrations", seed), " ");
    assert.throws(() => buildArtifacts(base, owner), new RegExp(`${app} canonical migration contents do not match the reviewed full-chain digest`));
  }
});

test("rejects seed and ordinary migration file symlinks", (t) => {
  for (const name of ["0002_seed_initial_staff.sql", "0003_delivery_platform.sql"]) {
    const base = fixture();
    const file = path.join(base, "apps", "client", "migrations", name);
    const target = path.join(base, `${name}.target`);
    fs.copyFileSync(file, target);
    fs.rmSync(file);
    if (!symlinkOrSkip(t, target, file, "file")) return;
    assert.throws(() => buildArtifacts(base, owner), new RegExp(`${name} must be a regular non-symlink file`));
  }
});

test("rejects a canonical migration directory junction", (t) => {
  const base = fixture();
  const directory = path.join(base, "apps", "client", "migrations");
  const target = path.join(base, "client-migrations-target");
  fs.renameSync(directory, target);
  if (!symlinkOrSkip(t, target, directory, process.platform === "win32" ? "junction" : "dir")) return;
  assert.throws(() => buildArtifacts(base, owner), /canonical migration directory must be a regular non-symlink directory/);
});

test("rejects a generated output ancestor junction", (t) => {
  const ancestorBase = fixture();
  const ancestorArtifacts = buildArtifacts(ancestorBase, owner);
  const generated = path.join(ancestorBase, "apps", "client", ".staging-bootstrap");
  const targetDirectory = path.join(ancestorBase, "generated-target");
  fs.mkdirSync(targetDirectory);
  if (!symlinkOrSkip(t, targetDirectory, generated, process.platform === "win32" ? "junction" : "dir")) return;
  assert.throws(() => writeGenerated(ancestorBase, ancestorArtifacts), /generated output ancestor .*regular non-symlink directory/);
});

test("rejects an existing generated file symlink", (t) => {
  const fileBase = fixture();
  const fileArtifacts = buildArtifacts(fileBase, owner);
  writeGenerated(fileBase, fileArtifacts);
  const generatedFile = path.join(fileBase, "apps", "client", ".staging-bootstrap", "migrations", "0001_initial.sql");
  const targetFile = path.join(fileBase, "generated-file-target.sql");
  fs.copyFileSync(generatedFile, targetFile);
  fs.rmSync(generatedFile);
  if (!symlinkOrSkip(t, targetFile, generatedFile, "file")) return;
  const errors = validateGenerated(fileBase, fileArtifacts);
  assert(errors.some((error) => error.includes("0001_initial.sql must be a regular non-symlink file")), errors.join(" | "));
});

test("checked-in canonical 0002 migrations remain the reviewed source shapes", () => {
  assert.doesNotThrow(() => transformSeed("delivery", sourceClient, owner));
  assert.doesNotThrow(() => transformSeed("operations", sourceOperations, owner));
  assert.match(sourceClient, /initial-beau-koltz/);
  assert.match(sourceOperations, /staff-beau-koltz/);
});

test("builds the complete checked-in 147/171 chains with both Client 0199 filenames", () => {
  const base = fixture();
  const artifacts = buildArtifacts(base, owner);
  assert.equal(artifacts.delivery.files.length, 147);
  assert.equal(artifacts.operations.files.length, 171);
  assert.deepEqual(artifacts.delivery.files.filter(({ name }) => name.startsWith("0199_")).map(({ name }) => name), [
    "0199_incoming_upload_pickup_lifecycle.sql", "0199_native_viewer_grants.sql",
  ]);
  assert.equal(artifacts.delivery.files.at(-1).name, "0228_operations_portal_native_content_start_audit.sql");
  assert.equal(artifacts.operations.files.at(-1).name, "0171_project_alpha_active_directory_update_guard.sql");
  assert.deepEqual(artifacts.delivery.manifest.transformedFiles, ["0002_seed_initial_staff.sql"]);
  assert.deepEqual(artifacts.operations.manifest.transformedFiles, ["0002_seed_acl.sql"]);
  assert.equal(artifacts.delivery.manifest.sourceChainSha256, "8a6cb183feae5ec6490cb4710f02a3289a05421786b9593e6392803a1e890f5c");
  assert.equal(artifacts.operations.manifest.sourceChainSha256, "e3feca1f403a06f15495017fd843ac48173e39be2478f8d6b5060c262c0b1f5c");
});

const disposableTargets = (runId = "portal-home-20260928") => ({ runId, applications: {
  delivery: { databaseName: `client-data-staging-rehearsal-${runId}`, databaseId: "11111111-1111-4111-8111-111111111111" },
  operations: { databaseName: `ltds-ops-staging-rehearsal-${runId}`, databaseId: "22222222-2222-4222-8222-222222222222" },
} });

test("builds isolated run-scoped migration-only disposable rehearsal artifacts", () => {
  const base = fixture(), targets = disposableTargets();
  const artifacts = buildArtifacts(base, owner, { disposableTargets: targets });
  for (const [app, artifact] of Object.entries(artifacts)) {
    const target = targets.applications[app];
    assert.equal(artifact.runDirectory, `.staging-bootstrap/rehearsals/${targets.runId}`);
    assert.equal(artifact.configFilename, `wrangler.staging.bootstrap.${targets.runId}.json`);
    assert.deepEqual(Object.keys(artifact.config).sort(), ["account_id", "d1_databases", "name", "vars"]);
    assert.equal(artifact.config.name, `${artifact.entry.workerName}-rehearsal-${targets.runId}`);
    assert.deepEqual(artifact.config.vars, { ENVIRONMENT: "staging" });
    assert.deepEqual(artifact.config.d1_databases, [{ binding: artifact.entry.binding, database_name: target.databaseName,
      database_id: target.databaseId, migrations_dir: `${artifact.runDirectory}/migrations` }]);
    for (const forbidden of ["main", "routes", "assets", "services", "secrets", "triggers", "workflows", "containers"])
      assert.equal(Object.hasOwn(artifact.config, forbidden), false, `${app} excludes ${forbidden}`);
    assert.equal(artifact.manifest.mode, "disposable-remote-rehearsal");
    assert.equal(artifact.manifest.runId, targets.runId);
    assert.deepEqual(artifact.manifest.disposableTarget, { workerName: artifact.config.name,
      databaseName: target.databaseName, databaseId: target.databaseId });
    assert.equal(artifact.manifest.canonicalSource.databaseName, artifact.entry.databaseName);
  }
  const written = writeGenerated(base, artifacts);
  assert(written.every(file => file.includes(targets.runId)));
  assert.deepEqual(validateGenerated(base, artifacts), []);
});

test("disposable rehearsal targets fail closed on malformed, reused, current, or production identities", () => {
  const cases = [];
  cases.push({ runId: "../escape", applications: disposableTargets().applications });
  cases.push({ ...disposableTargets(), extra: true });
  cases.push({ ...disposableTargets(), applications: { delivery: disposableTargets().applications.delivery } });
  const malformed = disposableTargets(); malformed.applications.delivery.databaseId = "not-a-uuid"; cases.push(malformed);
  const wrongName = disposableTargets(); wrongName.applications.delivery.databaseName = "some-staging-database"; cases.push(wrongName);
  const duplicate = disposableTargets(); duplicate.applications.operations.databaseId = duplicate.applications.delivery.databaseId; cases.push(duplicate);
  const current = disposableTargets(); current.applications.delivery.databaseId = "b6f653ab-9acd-4421-9ad0-207754b59aeb"; cases.push(current);
  const production = disposableTargets(); production.applications.operations.databaseId = "6ebf7514-d306-4615-ae56-ad869c874dbd"; cases.push(production);
  for (const targets of cases) assert.throws(() => buildArtifacts(fixture(), owner, { disposableTargets: targets }),
    /strict runId|exactly delivery and operations|exact name|UUIDv4|distinct|must not reuse/);
});

test("canonical source guards run before disposable target validation", () => {
  const base = fixture(), targets = disposableTargets();
  targets.runId = "../invalid";
  fs.appendFileSync(path.join(base, "apps", "client", "migrations", "0003_delivery_platform.sql"), " ");
  assert.throws(() => buildArtifacts(base, owner, { disposableTargets: targets }),
    /delivery canonical migration contents do not match the reviewed full-chain digest/);
});

test("disposable rehearsal requires regular strict production configs and rejects output drift", () => {
  const malformedBase = fixture();
  fs.writeFileSync(path.join(malformedBase, "apps", "client", "wrangler.jsonc"), "// not strict JSON\n{}");
  assert.throws(() => buildArtifacts(malformedBase, owner, { disposableTargets: disposableTargets() }), /strict JSON/);
  const productionDriftBase = fixture(), productionFile = path.join(productionDriftBase, "apps", "operations", "wrangler.jsonc");
  const productionConfig = JSON.parse(fs.readFileSync(productionFile, "utf8"));
  productionConfig.d1_databases[0].database_id = "33333333-3333-4333-8333-333333333333";
  fs.writeFileSync(productionFile, JSON.stringify(productionConfig));
  assert.throws(() => buildArtifacts(productionDriftBase, owner, { disposableTargets: disposableTargets() }), /reviewed production inventory/);
  const driftBase = fixture(), artifacts = buildArtifacts(driftBase, owner, { disposableTargets: disposableTargets() });
  writeGenerated(driftBase, artifacts);
  const generated = path.join(driftBase, "apps", "client", artifacts.delivery.configFilename);
  fs.appendFileSync(generated, " ");
  assert(validateGenerated(driftBase, artifacts).some(error => error.includes("stale or was edited")));
  assert.throws(() => writeGenerated(driftBase, artifacts), /invalid or stale/);
});

test("disposable rehearsal rejects a symlinked production config", (t) => {
  const base = fixture(), production = path.join(base, "apps", "operations", "wrangler.jsonc");
  const target = path.join(base, "production-config.target");
  fs.copyFileSync(production, target); fs.rmSync(production);
  if (!symlinkOrSkip(t, target, production, "file")) return;
  assert.throws(() => buildArtifacts(base, owner, { disposableTargets: disposableTargets() }),
    /production config must be a regular non-symlink file/);
});

test("disposable target input is local, regular, strict JSON and drives run-scoped CLI output", () => {
  const base = fixture(), targetFile = path.join(base, "targets.json");
  fs.writeFileSync(targetFile, JSON.stringify(disposableTargets()));
  const written = run(["--write", "--values", "owner.json", "--disposable-targets", "targets.json"], base);
  assert(written.length > 0 && written.every(file => file.includes("portal-home-20260928")));
  run(["--check", "--values", "owner.json", "--disposable-targets", "targets.json"], base);
  assert.throws(() => run(["--check", "--values", "owner.json", "--disposable-targets", "../outside.json"], base), /remain below/);
  fs.writeFileSync(targetFile, "// not strict JSON\n{}");
  assert.throws(() => run(["--check", "--values", "owner.json", "--disposable-targets", "targets.json"], base), /strict JSON/);
});

test("disposable target input rejects a symlink", (t) => {
  const linkBase = fixture(), link = path.join(linkBase, "targets.json"), source = path.join(linkBase, "targets.source.json");
  fs.writeFileSync(source, JSON.stringify(disposableTargets()));
  if (!symlinkOrSkip(t, source, link, "file")) return;
  assert.throws(() => run(["--check", "--values", "owner.json", "--disposable-targets", "targets.json"], linkBase),
    /must be a regular non-symlink file/);
});

test("disposable target input rejects a symlinked ancestor", (t) => {
  const base = fixture(), real = path.join(base, "target-input-real"), link = path.join(base, "target-input-link");
  fs.mkdirSync(real); fs.writeFileSync(path.join(real, "targets.json"), JSON.stringify(disposableTargets()));
  if (!symlinkOrSkip(t, real, link, process.platform === "win32" ? "junction" : "dir")) return;
  assert.throws(() => run(["--check", "--values", "owner.json", "--disposable-targets", "target-input-link/targets.json"], base),
    /ancestor .*regular non-symlink directory/);
});
