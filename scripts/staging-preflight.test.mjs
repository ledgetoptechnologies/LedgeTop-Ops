import assert from "node:assert/strict";
import test from "node:test";
import { validateApp, validateCrossApp } from "./staging-preflight.mjs";
import { REQUIRED_STAGING_SECRETS, STAGING_ACCESS_AUDS, STAGING_ACCOUNT_ID, STAGING_INVENTORY, STAGING_STATIC_VARS } from "./staging-requirements.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
function stagingConfig(app) {
  const inventory = clone(STAGING_INVENTORY[app]);
  return {
    account_id: STAGING_ACCOUNT_ID,
    name: inventory.name,
    workers_dev: false,
    preview_urls: false,
    routes: inventory.routes,
    vars: {
      ...STAGING_STATIC_VARS[app],
      ENVIRONMENT: "staging",
      EXPECTED_HOST: inventory.routes[0].pattern,
      POLICY_AUD: STAGING_ACCESS_AUDS.delivery,
      OPERATIONS_AUD: STAGING_ACCESS_AUDS.operations,
      CF_ACCESS_AUD: STAGING_ACCESS_AUDS["ops-sync"],
      PUBLIC_BASE_URL: `https://${inventory.routes[0].pattern}`,
      CLOUD_TRANSFER_DROPBOX_ENABLED: "false",
      CLOUD_TRANSFER_GOOGLE_ENABLED: "false",
      CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED: "false",
      DROPBOX_IMPORT_ENABLED: "false",
      DIRECT_DELIVERY_UPLOADS_ENABLED: "false",
      R2_PURGE_ENABLED: "false",
      ...(app === "operations" ? { PROJECT_ALPHA_BASE_URL: "https://project-alpha-staging.test", INCOMING_EXPECTED_HOST: "incoming-staging.ledgetopdroneservices.com", INCOMING_BASE_URL: "https://incoming-staging.ledgetopdroneservices.com" } : {}),
      ...(app === "ops-sync" ? { CF_ACCESS_GROUP_ID: "staging-group", CF_ACCESS_GROUP_NAME: "Staging Testers" } : {}),
    },
    secrets: { required: [...REQUIRED_STAGING_SECRETS[app]] },
    d1_databases: inventory.d1_databases,
    r2_buckets: inventory.r2_buckets,
    workflows: inventory.workflows,
    ratelimits: inventory.ratelimits,
    ...(inventory.queues.length ? { queues: { consumers: inventory.queues } } : {}),
  };
}
function productionFrom(staging) {
  const production = clone(staging);
  production.name = production.name.replace("-staging", "");
  production.routes = production.routes.map((route) => ({ ...route, pattern: route.pattern.replace("-staging", "") }));
  for (const key of Object.keys(production.vars)) if (/(?:EXPECTED_HOST|BASE_URL|_AUD)$/.test(key)) production.vars[key] = `production-${key}`;
  production.d1_databases = production.d1_databases.map((item) => ({ ...item, database_id: `prod-${item.database_id}` }));
  production.r2_buckets = production.r2_buckets.map((item) => ({ ...item, bucket_name: `prod-${item.bucket_name}` }));
  production.workflows = production.workflows.map((item) => ({ ...item, name: `prod-${item.name}` }));
  production.ratelimits = production.ratelimits.map((item) => ({ ...item, namespace_id: `prod-${item.namespace_id}` }));
  if (production.queues) production.queues.consumers = production.queues.consumers.map((item) => ({ ...item, queue: `prod-${item.queue}` }));
  return production;
}

test("accepts the exact approved isolated staging inventory", () => {
  for (const app of ["delivery", "operations", "ops-sync"]) {
    const staging = stagingConfig(app);
    assert.deepEqual(validateApp(app, staging, productionFrom(staging)), []);
  }
});
test("rejects account, route, resource, secret, and capability drift", () => {
  const staging = stagingConfig("delivery");
  const production = productionFrom(staging);
  staging.account_id = "wrong";
  staging.routes[0].pattern = "other-staging.test";
  staging.d1_databases[0].database_id = "wrong";
  staging.secrets.required = ["UNEXPECTED"];
  staging.vars.CLOUD_TRANSFER_DROPBOX_ENABLED = "true";
  const errors = validateApp("delivery", staging, production);
  for (const expected of ["account_id", "routes", "d1_databases", "secrets.required", "CLOUD_TRANSFER_DROPBOX_ENABLED"]) assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
});
test("rejects unresolved Ops Sync authority", () => {
  const staging = stagingConfig("ops-sync");
  staging.vars.CF_ACCESS_GROUP_ID = "<STAGING_ACCESS_GROUP_ID>";
  assert(validateApp("ops-sync", staging, productionFrom(staging)).some((error) => error.includes("placeholder")));
});
test("requires shared staging resources to agree", () => {
  const configs = { delivery: stagingConfig("delivery"), operations: stagingConfig("operations"), "ops-sync": stagingConfig("ops-sync") };
  configs.operations.d1_databases[1].database_id = "wrong";
  assert(validateCrossApp(configs).some((error) => error.includes("DELIVERY_DB")));
});
