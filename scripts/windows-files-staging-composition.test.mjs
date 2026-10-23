import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { buildWindowsStagingComposition, WINDOWS_STAGING_SECRET_SLOTS } from "./windows-files-staging-composition.mjs";
import { writeWindowsStagingComposition } from "./windows-files-staging-composition-cli.mjs";
import { WINDOWS_STAGING_EXPORT_POLICY, assertWindowsStagingRuntimeExports } from "./windows-files-staging-exports.mjs";

export function fixture() {
  const issuer = "https://ledgetoptechnologies.cloudflareaccess.com";
  const audience = { operations: "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b", delivery: "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc" };
  const origin = { operations: "https://ops-staging.ledgetopdroneservices.com", delivery: "https://portal-staging.ledgetopdroneservices.com" };
  const sources = {};
  for (const app of ["operations", "delivery"]) sources[app] = { ...structuredClone(STAGING_INVENTORY[app]), account_id: STAGING_ACCOUNT_ID,
    workers_dev: false, preview_urls: false, assets: { binding: "ASSETS", directory: "dist/client", run_worker_first: ["/api/*"] },
    vars: { ENVIRONMENT: "staging", TEAM_DOMAIN: issuer, ...(app === "operations" ? { PUBLIC_BASE_URL: origin.operations, EXPECTED_HOST: new URL(origin.operations).host, OPERATIONS_AUD: audience.operations }
      : { CLIENT_PORTAL_ORIGIN: origin.delivery, CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: audience.delivery }) } };
  return { profile: { schemaVersion: 1, enabled: true, gateway: { origin: "https://synthetic-files-staging.ledgetopdroneservices.com", gatewayId: "00000000-0000-4000-8000-000000000001", keyId: "synthetic" }, secretSlots: structuredClone(WINDOWS_STAGING_SECRET_SLOTS) }, sources,
    preflight: { status: "read_only_observed", accountId: STAGING_ACCOUNT_ID, versionBindingsMatchedInventory: true, workers: ["operations", "delivery"].map(app => ({ app, workerName: STAGING_INVENTORY[app].name,
      origin: origin[app], issuer, audience: audience[app], versionId: "00000000-0000-4000-8000-000000000002", foreignKeyViolationCount: 0,
      migrations: { status: "suffix_applied" }, databases: STAGING_INVENTORY[app].d1_databases.map(b => ({ binding: b.binding, name: b.database_name, id: b.database_id })),
      buckets: STAGING_INVENTORY[app].r2_buckets.map(b => ({ binding: b.binding, name: b.bucket_name })), secretSlots: [...WINDOWS_STAGING_SECRET_SLOTS[app]],
      services: STAGING_INVENTORY[app].services.map(s => ({ binding: s.binding, workerName: s.service, entrypoint: s.entrypoint })) })) } };
}
test("builds executable paired staging mains and preserves all other config and private RPC exports", () => {
  const input = fixture(), before = structuredClone(input), result = buildWindowsStagingComposition(input);
  assert.deepEqual(input, before);
  for (const app of ["operations", "delivery"]) {
    const expected = structuredClone(input.sources[app]); expected.main = ".windows-files-staging/entrypoint.ts";
    if (app === "operations") {
      expected.vars.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED = "true";
      expected.compatibility_flags = [...(expected.compatibility_flags ?? []), "enable_request_signal"];
    }
    else Object.assign(expected.vars, { CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: "true" });
    assert.deepEqual(result.configs[app], expected);
    assert.doesNotMatch(result.entries[app], /export \* from/);
    assert.match(result.entries[app], /export \{/);
    for (const name of WINDOWS_STAGING_EXPORT_POLICY[app].runtime) assert.ok(result.entries[app].includes(name));
    for (const name of WINDOWS_STAGING_EXPORT_POLICY[app].helpers) assert.ok(!result.entries[app].includes(name));
    assert.doesNotMatch(result.entries[app], /SIGNING_KEY|HANDLE_KEY|QUEUE_KEY/);
  }
  assert.equal(result.receipt.physicallyVerified, false); assert.equal(result.receipt.activated, false);
});
test("enabled Ops opts into incoming request aborts while preserving existing flags and Client config", () => {
  const input = fixture();
  input.sources.operations.compatibility_flags = ["nodejs_compat", "some_future_reviewed_flag"];
  input.sources.delivery.compatibility_flags = ["nodejs_compat", "disable_request_signal"];
  const before = structuredClone(input), result = buildWindowsStagingComposition(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.configs.operations.compatibility_flags, ["nodejs_compat", "some_future_reviewed_flag", "enable_request_signal"]);
  assert.deepEqual(result.configs.delivery.compatibility_flags, input.sources.delivery.compatibility_flags);
});
test("existing incoming abort opt-in is emitted once without reordering other flags", () => {
  const input = fixture();
  input.sources.operations.compatibility_flags = ["nodejs_compat", "enable_request_signal", "some_future_reviewed_flag", "enable_request_signal"];
  assert.deepEqual(buildWindowsStagingComposition(input).configs.operations.compatibility_flags,
    ["nodejs_compat", "enable_request_signal", "some_future_reviewed_flag"]);
});
test("enabled Ops refuses an explicit incoming abort opt-out or malformed flags", () => {
  for (const flags of [["nodejs_compat", "disable_request_signal"], "nodejs_compat", ["nodejs_compat", null]]) {
    const input = fixture(); input.sources.operations.compatibility_flags = flags;
    assert.throws(() => buildWindowsStagingComposition(input), /inputs_invalid/);
  }
});
test("disabled composition leaves both apps compatibility flags unchanged", () => {
  const input = fixture(); input.profile.enabled = false;
  input.sources.operations.compatibility_flags = ["nodejs_compat", "disable_request_signal", "some_future_reviewed_flag"];
  input.sources.delivery.compatibility_flags = ["enable_request_signal", "some_other_reviewed_flag"];
  const before = structuredClone(input), result = buildWindowsStagingComposition(input);
  assert.deepEqual(input, before);
  for (const app of ["operations", "delivery"]) assert.deepEqual(result.configs[app].compatibility_flags, input.sources[app].compatibility_flags);
});
test("actual complete bundles preserve every reviewed runtime export and reject library export drift", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const generated = buildWindowsStagingComposition(fixture());
  for (const [app, directory, main] of [["operations", "operations", "staging-native-authority-entrypoint.ts"], ["delivery", "client", "index.ts"]]) {
    const base = path.join(root, "apps", directory);
    const { build } = createRequire(path.join(base, "package.json"))("esbuild");
    const options = { bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"], write: false, metafile: true, logLevel: "silent" };
    const baseline = await build({ ...options, entryPoints: [path.join(base, "src/worker", main)] });
    const stagingDirectory = fs.mkdtempSync(path.join(base, ".windows-staging-export-test-"));
    let candidate;
    try {
      candidate = await build({ ...options, stdin: { contents: generated.entries[app], loader: "ts",
        sourcefile: "entrypoint.ts", resolveDir: stagingDirectory } });
    } finally { fs.rmdirSync(stagingDirectory); } // Owned, empty directory; no recursive deletion.
    const exportsOf = result => Object.values(result.metafile.outputs).flatMap(output => output.exports);
    const before = exportsOf(baseline), after = exportsOf(candidate);
    assert.equal(assertWindowsStagingRuntimeExports(app, before, after).runtimeExportsPreserved, true);
    assert.throws(() => assertWindowsStagingRuntimeExports(app, [...before, "NewUnreviewedConstant"], after), /source_exports_unreviewed/);
    assert.throws(() => assertWindowsStagingRuntimeExports(app, before, after.filter(name => name !== WINDOWS_STAGING_EXPORT_POLICY[app].runtime[0])), /runtime_exports_changed/);
    assert.throws(() => assertWindowsStagingRuntimeExports(app, before, [...after, WINDOWS_STAGING_EXPORT_POLICY[app].helpers[0]]), /runtime_exports_changed/);
  }
});
test("disabled preparation cannot enable reader flags or require nonexistent private slots", () => {
  const input = fixture(); input.profile.enabled = false;
  input.preflight.workers.forEach(w => { w.secretSlots = []; w.migrations.status = "suffix_pending"; });
  const result = buildWindowsStagingComposition(input);
  assert.deepEqual(result.configs.operations.vars, input.sources.operations.vars);
  assert.deepEqual(result.configs.delivery.vars, input.sources.delivery.vars);
});
const cases = [
  ["production account", f => { f.preflight.accountId = "0".repeat(32); }],
  ["physical database drift", f => { f.preflight.workers[0].databases[0].id = "00000000-0000-4000-8000-000000000003"; }],
  ["private reader drift", f => { f.sources.delivery.services.find(s => s.binding === "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER").service = "ledgetop-ops"; }],
  ["production route", f => { f.sources.operations.routes[0].pattern = "ops.ledgetopdroneservices.com"; }],
  ["wrong source main", f => { f.sources.operations.main = "src/worker/index.ts"; }],
  ["wrong audience", f => { f.sources.operations.vars.OPERATIONS_AUD = "other-app"; }],
  ["foreign issuer", f => { f.preflight.workers[1].issuer = "https://other.cloudflareaccess.com"; }],
  ["missing migration", f => { f.preflight.workers[0].migrations.status = "suffix_pending"; }],
  ["missing slot", f => { f.preflight.workers[0].secretSlots.pop(); }],
  ["alternate slot", f => { f.profile.secretSlots.delivery = ["DELIVERY_SESSION_SECRET"]; }],
  ["key in vars", f => { f.sources.operations.vars.WINDOWS_EMPLOYEE_QUEUE_KEY = "not-a-real-key"; }],
  ["gateway HTTP", f => { f.profile.gateway.origin = "http://synthetic-files-staging.ledgetopdroneservices.com"; }],
  ["gateway production", f => { f.profile.gateway.origin = "https://files.ledgetopdroneservices.com"; }],
  ["gateway query", f => { f.profile.gateway.origin += "/?secret=x"; }],
  ["gateway ID", f => { f.profile.gateway.gatewayId = "fake"; }],
  ["foreign keys", f => { f.preflight.workers[1].foreignKeyViolationCount = 1; }],
];
for (const [name, mutate] of cases) test(`rejects ${name}`, () => { const input = fixture(); mutate(input); assert.throws(() => buildWindowsStagingComposition(input), /inputs_invalid/); });
test("writes only new explicit ignored build paths and refuses any overwrite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ledge-top-windows-composition-"));
  for (const app of ["operations", "client"]) fs.mkdirSync(path.join(root, "apps", app), { recursive: true });
  const receipt = writeWindowsStagingComposition(root, fixture()); assert.equal(receipt.activated, false);
  assert.match(fs.readFileSync(path.join(root, "apps/client/.windows-files-staging/entrypoint.ts"), "utf8"), /createWindowsPortalStagingWorker/);
  assert.throws(() => writeWindowsStagingComposition(root, fixture()), /output_exists/);
  // Keep this small caller-owned artifact for review; never recurse over a user path.
});
