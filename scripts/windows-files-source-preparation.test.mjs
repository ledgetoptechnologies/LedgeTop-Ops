import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { WINDOWS_STAGING_SECRET_SLOTS, renderWindowsStagingEntries } from "./windows-files-staging-entry-renderer.mjs";
import { prepareWindowsStagingSources, writeWindowsStagingSources, buildWindowsStagingSourceModules, observeWindowsBundleInputs, WINDOWS_SOURCE_DIRECTORY } from "./windows-files-source-preparation.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fixture() {
  const issuer = "https://ledgetoptechnologies.cloudflareaccess.com", origins = { operations: "https://ops-staging.ledgetopdroneservices.com", delivery: "https://portal-staging.ledgetopdroneservices.com" };
  const audiences = { operations: "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b", delivery: "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc" };
  return { profile: { schemaVersion: 1, enabled: false, gateway: { origin: "https://synthetic-files-staging.ledgetopdroneservices.com", gatewayId: "00000000-0000-4000-8000-000000000001", keyId: "synthetic" }, secretSlots: structuredClone(WINDOWS_STAGING_SECRET_SLOTS) },
    preflight: { status: "read_only_observed", accountId: STAGING_ACCOUNT_ID, versionBindingsMatchedInventory: true,
      workers: ["operations", "delivery"].map(app => ({ app, workerName: STAGING_INVENTORY[app].name, origin: origins[app], issuer, audience: audiences[app], versionId: "00000000-0000-4000-8000-000000000002", foreignKeyViolationCount: 0, migrations: { status: "suffix_pending" }, secretSlots: [],
        databases: STAGING_INVENTORY[app].d1_databases.map(b => ({ binding: b.binding, name: b.database_name, id: b.database_id })), buckets: STAGING_INVENTORY[app].r2_buckets.map(b => ({ binding: b.binding, name: b.bucket_name })), services: STAGING_INVENTORY[app].services.map(b => ({ binding: b.binding, workerName: b.service, entrypoint: b.entrypoint })) })) } };
}
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ops-windows-source-prep-test-"));
  for (const name of ["scripts/windows-files-staging-entry-renderer.mjs", "scripts/windows-files-staging-exports.mjs", "scripts/windows-files-source-preparation.mjs", "scripts/staging-requirements.mjs", "apps/operations/src/worker/staging-native-authority-entrypoint.ts", "apps/operations/src/worker/windows-files-staging-worker.ts", "apps/client/src/worker/index.ts", "apps/client/src/worker/client-portal/windows-files-staging-worker.ts"]) {
    const dest = path.join(root, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(repository, name), dest);
  }
  return root; // Tiny caller-owned artifacts retained; no recursive cleanup of user paths.
}

test("source-only preparation renders the shared disabled entries without configuration or private slots", () => {
  const input = fixture(), before = structuredClone(input), result = prepareWindowsStagingSources(input);
  assert.deepEqual(input, before); assert.deepEqual(result.entries, renderWindowsStagingEntries(input.profile));
  assert.equal(result.receipt.status, "disabled_source_entries_only_not_configuration"); assert.equal(result.receipt.enabled, false);
  assert.equal(result.receipt.configWritten, false); assert.equal(result.receipt.deployReady, false); assert.equal(result.receipt.physicallyVerified, false);
  assert.equal(result.receipt.gatewayMetadata.provisioned, false);
  assert.equal(Object.hasOwn(result, "configs"), false); assert.match(result.entries.operations, /"enabled":false/);
  assert.doesNotMatch(result.entries.operations + result.entries.delivery, /SIGNING_KEY|HANDLE_KEY|QUEUE_KEY/);
});
for (const [name, mutate] of [
  ["enabled profile", f => { f.profile.enabled = true; }],
  ["configuration inputs", f => { f.sources = {}; }],
  ["profile key value", f => { f.profile.secret = "never-serialize"; }],
  ["production gateway", f => { f.profile.gateway.origin = "https://files.ledgetopdroneservices.com"; }],
  ["account drift", f => { f.preflight.accountId = "0".repeat(32); }],
  ["unverified inventory", f => { f.preflight.versionBindingsMatchedInventory = false; }],
  ["duplicate workers", f => { f.preflight.workers[1] = structuredClone(f.preflight.workers[0]); }],
  ["wrong worker", f => { f.preflight.workers[0].workerName = "ledgetop-ops"; }],
  ["wrong origin", f => { f.preflight.workers[1].origin = "https://portal.ledgetop.app"; }],
  ["wrong audience", f => { f.preflight.workers[0].audience = "wrong"; }],
  ["wrong issuer", f => { f.preflight.workers[1].issuer = "https://other.cloudflareaccess.com"; }],
  ["invalid version", f => { f.preflight.workers[0].versionId = "latest"; }],
  ["database drift", f => { f.preflight.workers[0].databases[0].id = "00000000-0000-4000-8000-000000000009"; }],
  ["bucket drift", f => { f.preflight.workers[1].buckets[0].name = "production"; }],
  ["reader drift", f => { f.preflight.workers[1].services[0].workerName = "ledgetop-ops"; }],
  ["duplicate services", f => { f.preflight.workers[0].services.push(f.preflight.workers[0].services[0]); }],
  ["missing mandatory service", f => { f.preflight.workers[1].services = []; }],
  ["foreign key failures", f => { f.preflight.workers[0].foreignKeyViolationCount = 1; }],
]) test(`source-only rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => prepareWindowsStagingSources(f), /invalid|disabled/); });

test("writer creates only separate entry/public-input/receipt artifacts and never a Wrangler config", () => {
  const root = workspace(), input = fixture(), receipt = writeWindowsStagingSources(root, input);
  assert.equal(receipt.configWritten, false);
  for (const directory of ["operations", "client"]) {
    const base = path.join(root, "apps", directory);
    assert.deepEqual(fs.readdirSync(path.join(base, WINDOWS_SOURCE_DIRECTORY)).sort(), ["entrypoint.ts", "public-inputs.json", "receipt.json"]);
    assert.equal(fs.existsSync(path.join(base, "wrangler.staging.windows-files.json")), false);
    assert.equal(fs.existsSync(path.join(base, ".windows-files-staging")), false);
  }
  const entry = fs.readFileSync(path.join(root, "apps/client", WINDOWS_SOURCE_DIRECTORY, "entrypoint.ts"));
  assert.throws(() => writeWindowsStagingSources(root, input), /output_exists/);
  assert.deepEqual(fs.readFileSync(path.join(root, "apps/client", WINDOWS_SOURCE_DIRECTORY, "entrypoint.ts")), entry);
});
test("writer checks both existing output paths before any write", () => {
  const root = workspace(); fs.mkdirSync(path.join(root, "apps/client", WINDOWS_SOURCE_DIRECTORY));
  assert.throws(() => writeWindowsStagingSources(root, fixture()), /output_exists/);
  assert.equal(fs.existsSync(path.join(root, "apps/operations", WINDOWS_SOURCE_DIRECTORY)), false);
});
for (const [name, alter] of [
  ["entry", root => fs.appendFileSync(path.join(root, "apps/operations", WINDOWS_SOURCE_DIRECTORY, "entrypoint.ts"), "\nexport const unreviewed=1;\n")],
  ["pinned main", root => fs.appendFileSync(path.join(root, "apps/client/src/worker/index.ts"), "\n// drift\n")],
  ["public input", root => { const p = path.join(root, "apps/operations", WINDOWS_SOURCE_DIRECTORY, "public-inputs.json"), f = JSON.parse(fs.readFileSync(p)); f.profile.gateway.keyId = "drift"; fs.writeFileSync(p, JSON.stringify(f)); }],
  ["receipt status", root => { const p = path.join(root, "apps/operations", WINDOWS_SOURCE_DIRECTORY, "receipt.json"), r = JSON.parse(fs.readFileSync(p)); r.status = "source_composition_only"; fs.writeFileSync(p, JSON.stringify(r)); }],
]) test(`module build refuses ${name} drift before esbuild`, async () => {
  const root = workspace(); writeWindowsStagingSources(root, fixture()); alter(root);
  await assert.rejects(buildWindowsStagingSourceModules(root), /inputs_drifted/);
  assert.equal(fs.existsSync(path.join(root, "apps/operations", WINDOWS_SOURCE_DIRECTORY, "module-build")), false);
});
test("source preparation rejects a root directory alias", () => {
  const root = workspace(), parent = fs.mkdtempSync(path.join(os.tmpdir(), "ops-windows-source-alias-")), alias = path.join(parent, "alias");
  fs.symlinkSync(root, alias, "junction");
  assert.throws(() => writeWindowsStagingSources(alias, fixture()), /path_alias/);
});
test("source preparation rejects an app directory alias", () => {
  const root = workspace(), target = fs.mkdtempSync(path.join(os.tmpdir(), "ops-windows-app-alias-"));
  const existing = path.join(root, "apps/client"); fs.renameSync(existing, path.join(root, "apps/client-original")); fs.symlinkSync(target, existing, "junction");
  assert.throws(() => writeWindowsStagingSources(root, fixture()), /path_alias/);
});

test("bundle evidence handles only zero-byte esbuild browser-disabled virtual inputs", () => {
  const root = workspace(), name = "(disabled):apps/operations/node_modules/postcss/lib/terminal-highlight";
  const rows = observeWindowsBundleInputs(root, { [name]: { bytes: 0 } });
  assert.deepEqual(rows, [{ inputName: name, kind: "esbuild_browser_disabled_virtual", sourceBytes: 0, physicalSourceSha256: null }]);
  assert.throws(() => observeWindowsBundleInputs(root, { [name]: { bytes: 1 } }), /bundle_input_invalid/);
  assert.throws(() => observeWindowsBundleInputs(root, { "(unknown):arbitrary": { bytes: 0 } }), /bundle_input_invalid/);
  assert.throws(() => observeWindowsBundleInputs(root, { "(disabled):../outside": { bytes: 0 } }), /path_alias/);
  const physical = observeWindowsBundleInputs(root, { "scripts/windows-files-staging-exports.mjs": { bytes: 0 } });
  assert.equal(physical[0].kind, "physical_source"); assert.match(physical[0].sha256, /^[a-f0-9]{64}$/);
});

test("module build refuses an existing output before resolving build dependencies", async () => {
  const root = workspace(); writeWindowsStagingSources(root, fixture());
  fs.mkdirSync(path.join(root, "apps/client", WINDOWS_SOURCE_DIRECTORY, "module-build"));
  await assert.rejects(buildWindowsStagingSourceModules(root), /output_exists/);
  assert.equal(fs.existsSync(path.join(root, "apps/operations", WINDOWS_SOURCE_DIRECTORY, "module-build")), false);
});
test("module build rejects individually valid but different paired public inputs", async () => {
  const root = workspace(); const original = writeWindowsStagingSources(root, fixture()), changed = fixture();
  changed.profile.gateway.keyId = "other-compile-input";
  const prepared = prepareWindowsStagingSources(changed), dir = path.join(root, "apps/client", WINDOWS_SOURCE_DIRECTORY);
  fs.writeFileSync(path.join(dir, "entrypoint.ts"), prepared.entries.delivery);
  fs.writeFileSync(path.join(dir, "public-inputs.json"), JSON.stringify(changed));
  fs.writeFileSync(path.join(dir, "receipt.json"), JSON.stringify({ ...prepared.receipt, sourceSha256: original.sourceSha256 }));
  await assert.rejects(buildWindowsStagingSourceModules(root), /paired_inputs_drifted/);
});
