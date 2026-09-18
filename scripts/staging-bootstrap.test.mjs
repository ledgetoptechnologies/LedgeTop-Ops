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
    fs.cpSync(path.join(repositoryRoot, "apps", source, "migrations"), path.join(directory, "migrations"), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, "docs", "staging", example), path.join(directory, "wrangler.staging.json"));
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
    assert.equal(artifact.files.length, app === "delivery" ? 132 : 122, app);
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
  fs.rmSync(path.join(missing, "apps", "client", "migrations", "0213_incoming_rclone_promotion.sql"));
  assert.throws(() => buildArtifacts(missing, owner), /exact complete ordered 132-file chain/);
  const extra = fixture();
  fs.writeFileSync(path.join(extra, "apps", "operations", "migrations", "0123_unreviewed.sql"), "-- unreviewed\n");
  assert.throws(() => buildArtifacts(extra, owner), /exact complete ordered 122-file chain/);
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

test("builds the complete checked-in 132/122 chains with both Client 0199 filenames", () => {
  const base = fixture();
  const artifacts = buildArtifacts(base, owner);
  assert.equal(artifacts.delivery.files.length, 132);
  assert.equal(artifacts.operations.files.length, 122);
  assert.deepEqual(artifacts.delivery.files.filter(({ name }) => name.startsWith("0199_")).map(({ name }) => name), [
    "0199_incoming_upload_pickup_lifecycle.sql", "0199_native_viewer_grants.sql",
  ]);
  assert.equal(artifacts.delivery.files.at(-1).name, "0213_incoming_rclone_promotion.sql");
  assert.equal(artifacts.operations.files.at(-1).name, "0122_project_alpha_project_v2_canonical_activation.sql");
  assert.deepEqual(artifacts.delivery.manifest.transformedFiles, ["0002_seed_initial_staff.sql"]);
  assert.deepEqual(artifacts.operations.manifest.transformedFiles, ["0002_seed_acl.sql"]);
  assert.equal(artifacts.delivery.manifest.sourceChainSha256, "c5b6271f9edff677237c45734bbf1b6eeebaaf1c7256b6b561ea1e2c03adb4a0");
  assert.equal(artifacts.operations.manifest.sourceChainSha256, "20f127ae3193884494a021ac2f1851f6c2db06834d6f94498850d315e02df5d7");
});
