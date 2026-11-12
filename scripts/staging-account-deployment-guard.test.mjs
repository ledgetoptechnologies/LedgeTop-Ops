import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { renderStagingAccountConfigs, STAGING_ACCOUNT_ID, STAGING_TARGETS, writeStagingAccountConfigs } from "./staging-account-wrangler-configs.mjs";
import { DEPLOYMENT_BLOCKERS, validateStagingAccountConfigs } from "./staging-account-deployment-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const temporaryRoots = [];
after(() => { for (const folder of temporaryRoots) fs.rmSync(folder, { recursive: true, force: true }); });

test("generated configs target only the confirmed Staging account and D1/R2 allocations", () => {
  const configs = renderStagingAccountConfigs(root);
  assert.equal(configs.operations.account_id, STAGING_ACCOUNT_ID);
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
    client: "apps/client/wrangler.staging-account.jsonc",
    sync: "apps/ops-sync/wrangler.staging-account.jsonc",
  })) assert.deepEqual(read(file), renderStagingAccountConfigs(root)[app]);

  const readiness = validateStagingAccountConfigs(root);
  assert.ok(readiness.errors.some((error) => error.includes("OperationsNativePrincipalInquiryIngress")));
  assert.ok(readiness.errors.every((error) => error.includes("OperationsNativePrincipalInquiryIngress")));
  assert.deepEqual(readiness.blockers, [...DEPLOYMENT_BLOCKERS]);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("legacy backlog")));
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("Portal Access")));
  assert.ok(readiness.blockers.some((blocker) => blocker.includes("Logs domain/service")));
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
