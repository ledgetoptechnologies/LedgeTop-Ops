import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { renderStagingAccountConfigs, STAGING_ACCESS_ISSUER, STAGING_ACCOUNT_ID, STAGING_TARGETS, writeStagingAccountConfigs } from "./staging-account-wrangler-configs.mjs";
import { DEPLOYMENT_BLOCKERS, validateLogsStagingConfig, validateStagingAccountConfigs } from "./staging-account-deployment-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const temporaryRoots = [];
after(() => { for (const folder of temporaryRoots) fs.rmSync(folder, { recursive: true, force: true }); });

test("generated configs target only the confirmed Staging account and D1/R2 allocations", () => {
  const configs = renderStagingAccountConfigs(root);
  assert.equal(configs.operations.account_id, STAGING_ACCOUNT_ID);
  assert.equal(configs.logsOperations.account_id, STAGING_ACCOUNT_ID);
  assert.equal(configs.client.account_id, STAGING_ACCOUNT_ID);
  assert.equal(configs.sync.account_id, STAGING_ACCOUNT_ID);

  assert.deepEqual(configs.operations.d1_databases.map(({ binding, database_name, database_id }) => ({ binding, database_name, database_id })), [
    { binding: "OPS_DB", database_name: STAGING_TARGETS.operations.opsDb.name, database_id: STAGING_TARGETS.operations.opsDb.id },
    { binding: "DELIVERY_DB", database_name: STAGING_TARGETS.operations.portalDb.name, database_id: STAGING_TARGETS.operations.portalDb.id },
  ]);
  assert.deepEqual(configs.client.d1_databases, [{
    binding: "DELIVERY_DB", database_name: STAGING_TARGETS.client.portalDb.name,
    database_id: STAGING_TARGETS.client.portalDb.id, migrations_dir: "migrations",
  }]);
  assert.deepEqual(configs.operations.r2_buckets.map(({ bucket_name }) => bucket_name), [
    "ledge-top-delivery-staging", "ledge-top-incoming-staging",
  ]);
  assert.deepEqual(configs.client.r2_buckets, [{ binding: "DATA_BUCKET", bucket_name: "ledge-top-delivery-staging" }]);
  assert.deepEqual(configs.logsOperations.d1_databases, [{
    binding: "OPS_DB", database_name: STAGING_TARGETS.operations.opsDb.name,
    database_id: STAGING_TARGETS.operations.opsDb.id, migrations_dir: "migrations",
  }]);
  assert.deepEqual(configs.logsOperations.services, [{ binding: "FLIGHT_LOGS", service: "ledge-top-logs-staging", entrypoint: "FlightLogsService" }]);
  assert.equal(configs.logsOperations.vars.FLIGHT_LOGS_ENABLED, "false");
  assert.equal(configs.logsOperations.workers_dev, false);
});

test("Access issuer, audiences and Worker hosts match allocated closed applications", () => {
  const configs = renderStagingAccountConfigs(root);
  assert.equal(configs.operations.name, "ledge-top-ops-staging");
  assert.equal(configs.client.name, "ledge-top-clients-staging");
  assert.equal(configs.client.d1_databases[0].database_name, "ledge-top-portal-staging");
  assert.equal(configs.sync.name, "ledge-top-ops-sync-staging");

  assert.equal(configs.operations.vars.TEAM_DOMAIN, STAGING_ACCESS_ISSUER);
  assert.equal(configs.operations.vars.OPERATIONS_AUD, STAGING_TARGETS.operations.accessAudience);
  assert.equal(configs.operations.vars.EXPECTED_HOST, "ledge-top-ops-staging.ledge-top-staging.workers.dev");
  assert.equal(configs.client.vars.CLIENT_ACCESS_TEAM_DOMAIN, STAGING_ACCESS_ISSUER);
  assert.equal(configs.client.vars.CLIENT_ACCESS_AUD, STAGING_TARGETS.client.accessAudience);
  assert.equal(configs.client.vars.EXPECTED_HOST, STAGING_TARGETS.client.host);
  assert.equal(configs.sync.vars.TEAM_DOMAIN, STAGING_ACCESS_ISSUER);
  assert.equal(configs.sync.vars.CF_ACCESS_AUD, STAGING_TARGETS.sync.accessAudience);
  assert.equal(configs.sync.vars.EXPECTED_HOST, STAGING_TARGETS.sync.host);
  for (const config of Object.values(configs)) {
    assert.equal(config.workers_dev, false);
    assert.deepEqual(config.routes, []);
  }
});

test("configs preserve observed live service bindings without production routes or enabled gates", () => {
  const configs = renderStagingAccountConfigs(root);
  for (const [app, config] of Object.entries(configs)) {
    assert.equal(config.workers_dev, false, app);
    assert.equal(config.preview_urls, false, app);
    assert.deepEqual(config.routes, [], app);
    assert.equal(Object.hasOwn(config, "triggers"), false, app);
    if (app === "operations") {
      assert.deepEqual(config.queues, { producers: [{ binding: "THUMBNAIL_QUEUE", queue: "ledge-top-thumbnail-staging" }] });
      assert.equal(Object.hasOwn(config.queues, "consumers"), false);
    } else assert.equal(Object.hasOwn(config, "queues"), false, app);
    assert.equal(Object.hasOwn(config, "workflows"), false, app);
    assert.equal(Object.hasOwn(config, "containers"), false, app);
    assert.equal(Object.hasOwn(config, "durable_objects"), false, app);
    for (const [key, value] of Object.entries(config.vars)) {
      if (/(?:_ENABLED|_READY)$/.test(key)) assert.equal(value, "false", `${app}.${key}`);
      if (key === "PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED") assert.equal(value, "true", `${app}.${key}`);
      else assert.notEqual(value, "true", `${app}.${key}`);
    }
  }

  const services = (app) => new Set(configs[app].services.map((binding) => binding.binding));
  for (const binding of [
    "CLIENT_AUTHORITY_WORKSPACE_BINDING", "CLIENT_PORTAL_ACCESS_AUTHORITY",
    "CLIENT_PORTAL_AUTHORITY_V2",
    "OPS_INVENTORY_CATALOG_PROMOTION", "OPS_INVENTORY_CATALOG_STAGING",
    "VERIFIED_RECIPIENT_DELIVERY_AUTHORITY",
  ]) assert.ok(services("operations").has(binding), `operations missing ${binding}`);
  for (const binding of [
    "CLIENT_ONBOARDING_RECIPIENT_BRIDGE", "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE",
    "OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES",
  ]) assert.ok(services("client").has(binding), `client missing ${binding}`);
});

test("committed config files match the renderer and readiness remains blocked on explicit prerequisites", () => {
  for (const [app, file] of Object.entries({
    operations: "apps/operations/wrangler.staging-account.jsonc",
    logsOperations: "apps/operations/wrangler.logs-staging-account.jsonc",
    client: "apps/client/wrangler.staging-account.jsonc",
    sync: "apps/ops-sync/wrangler.staging-account.jsonc",
  })) assert.deepEqual(read(file), renderStagingAccountConfigs(root)[app]);

  const readiness = validateStagingAccountConfigs(root);
  assert.ok(readiness.errors.some((error) => error.includes("OperationsNativePrincipalInquiryIngress")));
  assert.ok(readiness.errors.filter((error) => !error.startsWith("logs:")).every((error) => error.includes("OperationsNativePrincipalInquiryIngress")));
  assert.deepEqual(readiness.errors.filter((error) => error.startsWith("logs:")), [
    "logs: preview URLs must remain disabled",
    "logs: staging routes must remain empty",
  ]);
  assert.deepEqual(readiness.blockers, [...DEPLOYMENT_BLOCKERS]);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("legacy backlog")));
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("deny-all policies")));
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("Seven target Workflows")));
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("Logs domain/service")));
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("FLIGHT_LOGS_ENABLED=false")));
  assert.ok(readiness.errors.every((error) => !error.includes("logsOperations")), readiness.errors.join("\n"));
});

test("staging config generator reads but never changes production configs", () => {
  const before = [
    "apps/operations/wrangler.jsonc", "apps/client/wrangler.jsonc", "apps/ops-sync/wrangler.jsonc",
  ].map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  renderStagingAccountConfigs(root);
  const after = [
    "apps/operations/wrangler.jsonc", "apps/client/wrangler.jsonc", "apps/ops-sync/wrangler.jsonc",
  ].map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  assert.deepEqual(after, before);
});

test("guard propagates safety errors when generation faithfully carries an unsafe source field", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-stage-account-guard-"));
  temporaryRoots.push(base);
  const files = [
    "apps/operations/wrangler.jsonc", "apps/client/wrangler.jsonc", "apps/ops-sync/wrangler.jsonc",
    "apps/operations/src/worker/index.ts", "apps/client/src/worker/index.ts", "apps/ui-release-assets/src/index.ts",
    "apps/logs/src/worker/index.mjs",
  ];
  for (const file of files) {
    const target = path.join(base, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  const operationsPath = path.join(base, "apps/operations/wrangler.jsonc");
  const operations = JSON.parse(fs.readFileSync(operationsPath, "utf8"));
  operations.assets.directory = "C:/Windows";
  fs.writeFileSync(operationsPath, `${JSON.stringify(operations, null, 2)}\n`, "utf8");

  writeStagingAccountConfigs(base);
  const readiness = validateStagingAccountConfigs(base);
  assert.ok(readiness.errors.some((error) => error.includes("assets.directory must remain")));
});

test("Logs-only Ops profile fails closed when the flight-log gate is changed", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-stage-logs-guard-"));
  temporaryRoots.push(base);
  const files = [
    "apps/operations/wrangler.jsonc", "apps/client/wrangler.jsonc", "apps/ops-sync/wrangler.jsonc",
    "apps/operations/src/worker/index.ts", "apps/client/src/worker/index.ts", "apps/ui-release-assets/src/index.ts",
    "apps/logs/src/worker/index.mjs",
  ];
  for (const file of files) {
    const target = path.join(base, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  writeStagingAccountConfigs(base);
  const configPath = path.join(base, "apps/operations/wrangler.logs-staging-account.jsonc");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.vars.FLIGHT_LOGS_ENABLED = "true";
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const readiness = validateStagingAccountConfigs(base);
  assert.ok(readiness.errors.some((error) => error.includes("logsOperations: tracked config is stale")));
});

test("Logs staging config validator rejects each account, binding and exposure drift", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-stage-logs-config-"));
  temporaryRoots.push(base);
  const configPath = path.join(base, "apps/logs/wrangler.staging.jsonc");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const valid = {
    name: "ledge-top-logs-staging", account_id: STAGING_ACCOUNT_ID, main: "src/worker/index.mjs",
    workers_dev: false, preview_urls: false, routes: [],
    d1_databases: [{ binding: "LOGS_DB", database_name: "ledge-top-logs-staging", database_id: "33542156-96f0-4e83-8bf4-406cb1228640" }],
    r2_buckets: [{ binding: "LOGS_BUCKET", bucket_name: "ledge-top-logs-staging" }],
    services: [{ binding: "OPS_DIRECTORY", service: "ledge-top-ops-staging", entrypoint: "StaffDirectory" }],
  };
  const write = (config) => fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  write(valid);
  assert.deepEqual(validateLogsStagingConfig(base), []);

  const cases = [
    ["foreign account", config => { config.account_id = "846c924bf17bf4f3dd15c97a4c5d1d51"; }, "account_id must be the separate Staging account"],
    ["wrong D1", config => { config.d1_databases[0].database_id = "wrong"; }, "LOGS_DB must match the allocated Staging D1 database"],
    ["wrong bucket", config => { config.r2_buckets[0].bucket_name = "production-bucket"; }, "LOGS_BUCKET must match the allocated Staging bucket"],
    ["wrong service target", config => { config.services[0].service = "ledge-top-ops"; }, "OPS_DIRECTORY must target the Staging Ops StaffDirectory entrypoint"],
    ["wrong service entrypoint", config => { config.services[0].entrypoint = "OtherEntrypoint"; }, "OPS_DIRECTORY must target the Staging Ops StaffDirectory entrypoint"],
    ["Workers.dev exposure", config => { config.workers_dev = true; }, "workers_dev must remain disabled"],
    ["preview exposure", config => { config.preview_urls = true; }, "preview URLs must remain disabled"],
    ["custom route", config => { config.routes = ["logs.example.test/*"]; }, "staging routes must remain empty"],
  ];
  for (const [label, mutate, expected] of cases) {
    const changed = structuredClone(valid);
    mutate(changed);
    write(changed);
    assert.ok(validateLogsStagingConfig(base).some(error => error.includes(expected)), `${label} was not rejected`);
  }
});
