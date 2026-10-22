import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { windowsFilesStagingPreflight, WINDOWS_STAGING_READ_QUERIES, windowsStagingSchemaQuery } from "./windows-files-staging-preflight.mjs";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const baseline = { operations: "0221_portal_correspondence_lifecycle_write_guards.sql", delivery: "0234_pa_principal_reenrollment.sql" };
const suffix = { operations: ["0222_employee_read_roots.sql", "0223_employee_read_provisioning.sql", "0224_windows_portal_publication_chain_index.sql"],
  delivery: ["0235_windows_portal_successor_candidates.sql", "0236_windows_portal_successor_content_start_audit.sql"] };
function fixture() {
  const calls = [], configs = [], details = {}, ledgers = {}, deployments = {}, schemas = {};
  for (const [app, version] of [["operations", 10], ["delivery", 20]]) {
    const inv = STAGING_INVENTORY[app], vars = app === "operations" ? {
      ENVIRONMENT: "staging", TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com", PUBLIC_BASE_URL: "https://ops-staging.ledgetopdroneservices.com",
      EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com", OPERATIONS_AUD: "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b",
    } : { ENVIRONMENT: "staging", TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com", CLIENT_ACCESS_TEAM_DOMAIN: "https://ledgetoptechnologies.cloudflareaccess.com",
      CLIENT_PORTAL_ORIGIN: "https://portal-staging.ledgetopdroneservices.com", CLIENT_ACCESS_AUD: "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc" };
    details[app] = { id: id(version), resources: { bindings: [
      ...Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text })),
      ...inv.d1_databases.map(b => ({ type: "d1", name: b.binding, id: b.database_id })),
      ...inv.r2_buckets.map(b => ({ type: "r2_bucket", name: b.binding, bucket_name: b.bucket_name })),
      ...inv.services.map(b => ({ type: "service", name: b.binding, service: b.service, entrypoint: b.entrypoint })),
      { type: "secret_text", name: "SYNTHETIC_SECRET", text: "DO_NOT_PRINT_SECRET_VALUE" },
      { type: "plain_text", name: "UNRELATED_VALUE", text: "DO_NOT_PRINT_UNRELATED_VALUE" },
    ] } };
    deployments[app] = [
      { id: id(version + 1), created_on: "2026-10-22T01:00:00Z", versions: [{ version_id: id(version), percentage: 100 }] },
      { id: id(version + 2), created_on: "2026-10-21T01:00:00Z", versions: [{ version_id: id(version + 3), percentage: 100 }] },
    ];
    ledgers[app] = [{ name: "0001_initial.sql" }, { name: baseline[app] }];
    schemas[app] = [{ type: "table", name: "synthetic", tbl_name: "synthetic", sql: "CREATE TABLE synthetic(value TEXT DEFAULT 'DO_NOT_PRINT_SCHEMA')" }];
  }
  const run = async (args, options) => {
    calls.push(args); const configPath = args[args.indexOf("--config") + 1];
    configs.push({ path: configPath, cwd: options.cwd, data: JSON.parse(await readFile(configPath, "utf8")) });
    if (args[0] === "deployments") return JSON.stringify(deployments[args[args.indexOf("--name") + 1] === STAGING_INVENTORY.operations.name ? "operations" : "delivery"]);
    if (args[0] === "versions") return JSON.stringify(details[args[args.indexOf("--name") + 1] === STAGING_INVENTORY.operations.name ? "operations" : "delivery"]);
    assert.equal(args[0], "d1"); assert.equal(args[1], "execute"); assert.ok(args.includes("--remote"));
    const app = args[2] === "ltds-ops-staging" ? "operations" : "delivery", sql = args[args.indexOf("--command") + 1];
    const schemaOffset = sql.match(/ LIMIT 128 OFFSET (0|[1-9][0-9]*)$/)?.[1];
    assert.ok(sql === WINDOWS_STAGING_READ_QUERIES.ledger || sql === WINDOWS_STAGING_READ_QUERIES.foreignKeys
      || schemaOffset !== undefined && sql === windowsStagingSchemaQuery(Number(schemaOffset)));
    const results = sql === WINDOWS_STAGING_READ_QUERIES.ledger ? ledgers[app] : sql === WINDOWS_STAGING_READ_QUERIES.foreignKeys ? []
      : schemas[app].slice(Number(schemaOffset), Number(schemaOffset) + 128);
    return JSON.stringify([{ success: true, results }]);
  };
  return { calls, configs, details, ledgers, deployments, schemas, run };
}
test("requires explicit read-only opt-in before any process or temporary config", async () => {
  let calls = 0;
  assert.equal((await windowsFilesStagingPreflight({ run: () => { calls++; } })).status, "not_run");
  assert.equal(calls, 0);
});
test("validates both live versions before fixed staging-only queries and cleans its exact owned config", async () => {
  const f = fixture(), receipt = await windowsFilesStagingPreflight({ readOnly: true, run: f.run });
  assert.equal(receipt.accountId, STAGING_ACCOUNT_ID); assert.equal(receipt.status, "read_only_observed");
  assert.deepEqual(f.calls.slice(0, 4).map(a => a[0]), ["deployments", "versions", "deployments", "versions"]);
  assert.equal(f.calls.length, 10);
  for (const config of f.configs) {
    assert.equal(config.data.account_id, STAGING_ACCOUNT_ID);
    assert.deepEqual(config.data.d1_databases.map(x => x.database_name), ["ltds-ops-staging", "client-data-staging"]);
    assert.equal(config.data.d1_databases.length, 2); assert.equal(config.data.vars, undefined);
    await assert.rejects(access(config.path));
  }
  for (const worker of receipt.workers) {
    assert.equal(worker.migrations.status, "suffix_pending"); assert.equal(worker.migrations.count, 2);
    assert.equal(worker.migrations.canonicalBaselineVerified, false);
    assert.match(worker.migrations.note, /do not verify all earlier migrations/);
    assert.match(worker.migrations.sha256, /^[a-f0-9]{64}$/); assert.match(worker.schemaSha256, /^[a-f0-9]{64}$/);
    assert.equal(worker.foreignKeyViolationCount, 0);
    assert.equal(worker.schemaObjectCount, 1);
    assert.match(worker.schemaObservation, /not an atomic/);
  }
});
test("selects newest deployment by date rather than response order", async () => {
  const f = fixture(); f.deployments.operations.reverse();
  const receipt = await windowsFilesStagingPreflight({ readOnly: true, run: f.run });
  assert.equal(receipt.workers[0].versionId, id(10));
});
test("accepts the API default environment label only with exact staging service names and entrypoints", async () => {
  const f = fixture();
  for (const detail of Object.values(f.details))
    for (const binding of detail.resources.bindings.filter(b => b.type === "service")) binding.environment = "production";
  assert.equal((await windowsFilesStagingPreflight({ readOnly: true, run: f.run })).status, "read_only_observed");
  for (const patch of [{ environment: "staging" }, { service: "ledgetop-ops", environment: "production" },
    { entrypoint: "WrongEntrypoint", environment: "production" }]) {
    const changed = fixture();
    Object.assign(changed.details.delivery.resources.bindings.find(b => b.name === "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER"), patch);
    await assert.rejects(windowsFilesStagingPreflight({ readOnly: true, run: changed.run }), /version_service_mismatch/);
    assert.ok(changed.calls.every(a => a[0] !== "d1"));
  }
});
test("split or ambiguous deployment fails before database access", async () => {
  for (const change of [f => f.deployments.operations[0].versions.push({ version_id: id(99), percentage: 0 }),
    f => { f.deployments.delivery[0].versions[0].percentage = 50; },
    f => { f.deployments.operations[1].created_on = f.deployments.operations[0].created_on; }]) {
    const f = fixture(); change(f);
    await assert.rejects(windowsFilesStagingPreflight({ readOnly: true, run: f.run }), /deployment_/);
    assert.ok(f.calls.every(a => a[0] !== "d1"));
  }
});
test("production/mismatched bindings, service targets and auth vars fail before any DB query", async () => {
  const changes = [
    f => { f.details.delivery.resources.bindings.find(b => b.name === "ENVIRONMENT").text = "production"; },
    f => { f.details.operations.resources.bindings.find(b => b.name === "OPS_DB").id = id(90); },
    f => { f.details.delivery.resources.bindings.find(b => b.name === "DATA_BUCKET").bucket_name = "client-data"; },
    f => { f.details.delivery.resources.bindings.find(b => b.name === "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER").service = "ledgetop-ops"; },
    f => { f.details.operations.resources.bindings.find(b => b.name === "OPERATIONS_AUD").text = "a".repeat(64); },
    f => { f.details.delivery.resources.bindings.find(b => b.name === "CLIENT_PORTAL_ORIGIN").text = "https://portal.ledgetopdroneservices.com"; },
    f => { f.details.delivery.resources.bindings.find(b => b.name === "TEAM_DOMAIN").text = "https://other.cloudflareaccess.com"; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(windowsFilesStagingPreflight({ readOnly: true, run: f.run }), /version_/);
    assert.ok(f.calls.every(a => a[0] !== "d1"));
  }
});
test("bad JSON, oversized output and raw runner failures are sanitized", async () => {
  for (const [run, expected] of [[async () => "DO_NOT_PRINT_RAW_JSON", "wrangler_json_invalid"],
    [async () => "x".repeat(2 * 1024 * 1024 + 1), "wrangler_output_invalid"],
    [async () => { throw Error("DO_NOT_PRINT_CREDENTIAL_OR_PROVIDER_ERROR"); }, "wrangler_read_failed"]]) {
    await assert.rejects(windowsFilesStagingPreflight({ readOnly: true, run }), error => error.message === expected && !JSON.stringify(error).includes("DO_NOT_PRINT"));
  }
});
test("migration ledger status uses complete ordered names, not numeric max", async () => {
  for (const [extra, expected] of [[[], "suffix_pending"], [suffix.operations.slice(0, 1), "suffix_partially_applied"],
    [suffix.operations, "suffix_applied"], [[suffix.operations[1]], "ledger_order_requires_review"],
    [["0225_unreviewed.sql"], "ledger_order_requires_review"]]) {
    const f = fixture(); f.ledgers.operations.push(...extra.map(name => ({ name })));
    const receipt = await windowsFilesStagingPreflight({ readOnly: true, run: f.run });
    assert.equal(receipt.workers[0].migrations.status, expected);
  }
  const f = fixture(); f.ledgers.delivery = [{ name: "0233_older.sql" }, { name: suffix.delivery[0] }];
  assert.equal((await windowsFilesStagingPreflight({ readOnly: true, run: f.run })).workers[1].migrations.status, "baseline_missing");
});
test("receipt includes only approved metadata, hashes and secret slot names", async () => {
  const f = fixture(), receipt = await windowsFilesStagingPreflight({ readOnly: true, run: f.run });
  const serialized = JSON.stringify(receipt);
  assert.ok(serialized.includes("SYNTHETIC_SECRET")); assert.ok(!serialized.includes("DO_NOT_PRINT"));
  assert.ok(!serialized.includes("UNRELATED_VALUE")); assert.equal(receipt.activated, false); assert.equal(receipt.migrationsApplied, false);
});
test("counts foreign-key violations without exporting their table or row details", async () => {
  const f = fixture(), run = async (args, options) => {
    const ordinary = await f.run(args, options);
    return args[args.indexOf("--command") + 1] === WINDOWS_STAGING_READ_QUERIES.foreignKeys
      ? JSON.stringify([{ success: true, results: [{ table: "DO_NOT_PRINT_CLIENT_TABLE", rowid: 42, parent: "DO_NOT_PRINT_PARENT", fkid: 0 }] }]) : ordinary;
  };
  const receipt = await windowsFilesStagingPreflight({ readOnly: true, run });
  assert.ok(receipt.workers.every(w => w.foreignKeyViolationCount === 1));
  assert.ok(!JSON.stringify(receipt).includes("DO_NOT_PRINT"));
});
test("hashes every schema page in order without exporting schema text", async () => {
  const f = fixture();
  for (const [app, count] of [["operations", 257], ["delivery", 129]])
    f.schemas[app] = Array.from({ length: count }, (_, n) => ({ type: "table", name: `synthetic_${String(n).padStart(4, "0")}`,
      tbl_name: `synthetic_${String(n).padStart(4, "0")}`, sql: `CREATE TABLE synthetic_${n}(value TEXT DEFAULT 'DO_NOT_PRINT_SCHEMA')` }));
  const receipt = await windowsFilesStagingPreflight({ readOnly: true, run: f.run });
  for (const worker of receipt.workers) {
    const expected = createHash("sha256").update(JSON.stringify(f.schemas[worker.app].map(r => [r.type, r.name, r.tbl_name, r.sql]))).digest("hex");
    assert.equal(worker.schemaSha256, expected); assert.equal(worker.schemaObjectCount, f.schemas[worker.app].length);
  }
  assert.deepEqual(f.calls.filter(a => a[0] === "d1" && a[2] === "ltds-ops-staging" && a.includes("--command"))
    .map(a => a[a.indexOf("--command") + 1]).filter(sql => sql.startsWith(WINDOWS_STAGING_READ_QUERIES.schema)),
  [0, 128, 256].map(windowsStagingSchemaQuery));
  assert.ok(!JSON.stringify(receipt).includes("DO_NOT_PRINT"));
});
test("refuses a full final schema page rather than emitting a truncated digest", async () => {
  const f = fixture();
  f.schemas.operations = Array.from({ length: 4096 }, (_, n) => ({ type: "table", name: `synthetic_${n}`, tbl_name: `synthetic_${n}`, sql: null }));
  await assert.rejects(windowsFilesStagingPreflight({ readOnly: true, run: f.run }), /schema_page_limit/);
  const schemaCalls = f.calls.filter(a => a[0] === "d1" && a[a.indexOf("--command") + 1]?.startsWith(WINDOWS_STAGING_READ_QUERIES.schema));
  assert.equal(schemaCalls.length, 32);
  assert.equal(schemaCalls.at(-1)[schemaCalls.at(-1).indexOf("--command") + 1], windowsStagingSchemaQuery(3968));
});
test("schema query builder accepts only bounded internal page offsets", () => {
  for (const offset of [-128, 1, 127, 4096, Infinity, NaN, "128", "0; DROP TABLE example"])
    assert.throws(() => windowsStagingSchemaQuery(offset), /schema_page_invalid/);
  assert.equal(windowsStagingSchemaQuery(0), WINDOWS_STAGING_READ_QUERIES.schema + " LIMIT 128 OFFSET 0");
});

test("rejects a repeated schema object across pages instead of returning a misleading hash", async () => {
  const f = fixture();
  f.schemas.operations = Array.from({ length: 129 }, (_, n) => ({ type: "table",
    name: `synthetic_${String(n).padStart(4, "0")}`, tbl_name: `synthetic_${String(n).padStart(4, "0")}`, sql: null }));
  f.schemas.operations[128] = { ...f.schemas.operations[0] };
  await assert.rejects(windowsFilesStagingPreflight({ readOnly: true, run: f.run }), /schema_response_invalid/);
  assert.ok(!f.calls.some(args => args[0] === "d1" && args[2] === "client-data-staging"));
});
