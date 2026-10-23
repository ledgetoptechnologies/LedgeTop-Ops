import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { WINDOWS_STAGING_SECRET_SLOTS } from "./windows-files-staging-composition.mjs";
import { preserveWindowsStagingLiveVars, buildWindowsStagingCompositionWithLiveVars } from "./windows-files-staging-live-vars.mjs";

const APPS = ["operations", "delivery"];
function fixture() {
  const issuer = "https://ledgetoptechnologies.cloudflareaccess.com";
  const origins = { operations: "https://ops-staging.ledgetopdroneservices.com", delivery: "https://portal-staging.ledgetopdroneservices.com" };
  const audiences = { operations: "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b", delivery: "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc" };
  const sources = {}, versionDetails = {}, workers = [];
  for (const app of APPS) {
    const inventory = STAGING_INVENTORY[app];
    const live = { ENVIRONMENT: "staging", TEAM_DOMAIN: issuer, UNKNOWN_LIVE_VARIABLE: " \r\nfalse\t", EMPTY: "", FEATURE: "false",
      ...(app === "operations" ? { PUBLIC_BASE_URL: origins.operations, EXPECTED_HOST: new URL(origins.operations).host, OPERATIONS_AUD: audiences.operations }
        : { CLIENT_PORTAL_ORIGIN: origins.delivery, CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: audiences.delivery }) };
    sources[app] = { ...structuredClone(inventory), account_id: STAGING_ACCOUNT_ID, workers_dev: false, preview_urls: false,
      assets: { binding: "ASSETS", directory: "dist/client", run_worker_first: ["/api/*"] }, vars: { ...live, FEATURE: "true", TEMPLATE_ONLY: "remove" } };
    delete sources[app].vars.UNKNOWN_LIVE_VARIABLE;
    const versionId = "00000000-0000-4000-8000-000000000002";
    versionDetails[app] = { accountId: STAGING_ACCOUNT_ID, workerName: inventory.name, detail: { id: versionId, resources: {
      script_runtime: { compatibility_date: inventory.compatibility_date, compatibility_flags: [...inventory.compatibility_flags] },
      bindings: [...Object.entries(live).map(([name, text]) => ({ name, type: "plain_text", text })),
        { name: "EXISTING_PRIVATE_SLOT", type: "secret_text" }] } } };
    workers.push({ app, workerName: inventory.name, versionId, origin: origins[app], issuer, audience: audiences[app], foreignKeyViolationCount: 0,
      migrations: { status: "suffix_pending", pending: app === "operations" ? ["0222_employee_read_roots.sql", "0223_employee_read_provisioning.sql", "0224_windows_portal_publication_chain_index.sql"]
        : ["0235_windows_portal_successor_candidates.sql", "0236_windows_portal_successor_content_start_audit.sql"] }, secretSlots: [],
      databases: inventory.d1_databases.map(b => ({ binding: b.binding, name: b.database_name, id: b.database_id })),
      buckets: inventory.r2_buckets.map(b => ({ binding: b.binding, name: b.bucket_name })),
      services: inventory.services.map(s => ({ binding: s.binding, workerName: s.service, entrypoint: s.entrypoint })) });
  }
  return { sources, versionDetails, preflight: { status: "read_only_observed", accountId: STAGING_ACCOUNT_ID, versionBindingsMatchedInventory: true, workers },
    profile: { schemaVersion: 1, enabled: false, gateway: { origin: "https://synthetic-files-staging.ledgetopdroneservices.com", gatewayId: "00000000-0000-4000-8000-000000000001", keyId: "synthetic" }, secretSlots: structuredClone(WINDOWS_STAGING_SECRET_SLOTS) } };
}
test("preserves exact current variables, removes template extras, and never mutates input", () => {
  const input = fixture(), before = structuredClone(input), result = preserveWindowsStagingLiveVars(input);
  assert.deepEqual(input, before);
  for (const app of APPS) {
    const actual = Object.fromEntries(input.versionDetails[app].detail.resources.bindings.filter(b => b.type === "plain_text").map(b => [b.name, b.text]));
    assert.deepEqual(result.sources[app].vars, actual);
    assert.equal(result.sources[app].vars.FEATURE, "false"); assert.equal(result.sources[app].vars.EMPTY, "");
    assert.equal(result.sources[app].vars.UNKNOWN_LIVE_VARIABLE, " \r\nfalse\t");
    assert.equal(Object.hasOwn(result.sources[app].vars, "TEMPLATE_ONLY"), false);
    assert.deepEqual(Object.keys(result.receipt.workers.find(w => w.app === app)).sort(), ["app", "plainTextCount", "versionId", "workerName"]);
  }
  result.sources.operations.vars.FEATURE = "changed"; assert.deepEqual(input, before);
});
test("disabled real composition with pending suffix retains active disabled values and original admission", () => {
  const input = fixture();
  for (const app of APPS) input.versionDetails[app].detail.resources.bindings.push({ name: app === "operations" ? "OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED" : "CLIENT_PORTAL_ENABLED", type: "plain_text", text: "false" });
  const result = buildWindowsStagingCompositionWithLiveVars(input);
  assert.equal(result.receipt.enabled, false); assert.equal(result.receipt.activated, false);
  for (const app of APPS) assert.deepEqual(result.configs[app].vars, preserveWindowsStagingLiveVars(input).sources[app].vars);
  input.profile.enabled = true;
  assert.throws(() => buildWindowsStagingCompositionWithLiveVars(input), /inputs_invalid/);
});
test("requires live Ops membership binding retirement while preserving Client's disabled binding", () => {
  const name = "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED";
  const input = fixture();
  input.versionDetails.delivery.detail.resources.bindings.push({ name, type: "plain_text", text: "false" });
  assert.equal(buildWindowsStagingCompositionWithLiveVars(input).configs.delivery.vars[name], "false");
  for (const text of ["false", "true", "", "FALSE"]) {
    const stale = structuredClone(input);
    stale.versionDetails.operations.detail.resources.bindings.push({ name, type: "plain_text", text });
    const before = structuredClone(stale);
    assert.throws(() => preserveWindowsStagingLiveVars(stale), /windows_staging_live_vars_inputs_invalid/);
    assert.throws(() => buildWindowsStagingCompositionWithLiveVars(stale), /windows_staging_live_vars_inputs_invalid/);
    assert.deepEqual(stale, before);
  }
});
const bad = [
  ["wrong account", f => { f.versionDetails.operations.accountId = "other"; }],
  ["wrong worker", f => { f.versionDetails.operations.workerName = STAGING_INVENTORY.delivery.name; }],
  ["wrong version", f => { f.versionDetails.operations.detail.id = "00000000-0000-4000-8000-000000000003"; }],
  ["wrong source", f => { f.sources.operations.name = "other"; }],
  ["duplicate app", f => { f.preflight.workers[1].app = "operations"; }],
  ["wrong environment", f => { f.versionDetails.operations.detail.resources.bindings[0].text = "production"; }],
  ["date drift", f => { f.versionDetails.operations.detail.resources.script_runtime.compatibility_date = "2026-10-23"; }],
  ["flag drift", f => { f.versionDetails.operations.detail.resources.script_runtime.compatibility_flags.push("enable_request_signal"); }],
  ["duplicate runtime flags", f => { f.versionDetails.operations.detail.resources.script_runtime.compatibility_flags.push("nodejs_compat"); }],
  ["too many bindings", f => { f.versionDetails.operations.detail.resources.bindings = Array.from({ length: 1001 }, (_, i) => ({ name: `V_${i}`, type: "plain_text", text: "" })); }],
  ["aggregate text bound", f => { f.versionDetails.operations.detail.resources.bindings.push(...Array.from({ length: 33 }, (_, i) => ({ name: `V_${i}`, type: "plain_text", text: "x".repeat(32768) }))); }],
  ["JSON variable", f => { f.versionDetails.operations.detail.resources.bindings.push({ name: "JSON_VALUE", type: "json", json: {} }); }],
  ["duplicate plain", f => { f.versionDetails.operations.detail.resources.bindings.push({ name: "FEATURE", type: "plain_text", text: "x" }); }],
  ["plain secret collision", f => { f.versionDetails.operations.detail.resources.bindings.push({ name: "FEATURE", type: "secret_text" }); }],
  ["dedicated key as plain", f => { f.versionDetails.delivery.detail.resources.bindings.push({ name: "WINDOWS_EMPLOYEE_QUEUE_KEY", type: "plain_text", text: "x" }); }],
  ["dedicated source key", f => { f.sources.operations.vars.WINDOWS_PORTAL_QUEUE_KEY = "x"; }],
  ["lowercase name", f => { f.versionDetails.operations.detail.resources.bindings[0].name = "environment"; }],
  ["nonstring value", f => { f.versionDetails.operations.detail.resources.bindings[1].text = false; }],
  ["unbounded value", f => { f.versionDetails.operations.detail.resources.bindings[1].text = "x".repeat(32769); }],
  ["unknown binding", f => { f.versionDetails.operations.detail.resources.bindings.push({ name: "UNKNOWN", type: "future" }); }],
];
for (const [name, change] of bad) test(`rejects ${name} without echoing private input`, () => {
  const input = fixture(); input.versionDetails.delivery.detail.resources.bindings.push({ name: "PRIVATE_SENTINEL", type: "plain_text", text: "do-not-echo-private-sentinel" });
  change(input);
  assert.throws(() => preserveWindowsStagingLiveVars(input), e => e.message === "windows_staging_live_vars_inputs_invalid" && !JSON.stringify(e).includes("do-not-echo"));
});
test("receipts expose no variable values, names or per-variable hashes", () => {
  const input = fixture(); input.versionDetails.operations.detail.resources.bindings.push({ name: "PRIVATE_SENTINEL", type: "plain_text", text: "do-not-echo-private-sentinel" });
  const result = preserveWindowsStagingLiveVars(input);
  assert.doesNotMatch(JSON.stringify(result.receipt), /PRIVATE_SENTINEL|do-not-echo|sha256/i);
});
test("optional wrapper still rejects constructor resource drift without private diagnostics", () => {
  const input = fixture(); input.sources.operations.routes[0].pattern = "production.example.com";
  assert.throws(() => buildWindowsStagingCompositionWithLiveVars(input), e => e.message === "windows_staging_live_vars_inputs_invalid");
});
