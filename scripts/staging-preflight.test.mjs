import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateApp, validateCrossApp, validateFiles } from "./staging-preflight.mjs";
import { APP_SOURCE_DIRS, REQUIRED_STAGING_SECRETS, STAGING_ACCESS_AUDS, STAGING_ACCOUNT_ID, STAGING_HOSTS, STAGING_INVENTORY, STAGING_STATIC_VARS } from "./staging-requirements.mjs";

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
      PUBLIC_BASE_URL: app === "delivery" ? `https://${STAGING_HOSTS.client}` : `https://${inventory.routes[0].pattern}`,
      ...(app === "delivery" ? {
        CLIENT_PORTAL_ENABLED: "false",
        CLIENT_PORTAL_ORIGIN: `https://${STAGING_HOSTS.client}`,
        CLIENT_ACCESS_TEAM_DOMAIN: STAGING_STATIC_VARS.delivery.CLIENT_ACCESS_TEAM_DOMAIN,
        CLIENT_ACCESS_AUD: "a".repeat(64),
      } : {}),
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
    ...(inventory.queues.length || inventory.queueProducers?.length ? { queues: {
      consumers: inventory.queues,
      producers: inventory.queueProducers ?? [],
    } } : {}),
    ...(inventory.images ? { images: inventory.images } : {}),
    ...(inventory.crons ? { triggers: { crons: inventory.crons } } : {}),
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
  if (production.queues) {
    production.queues.consumers = production.queues.consumers.map((item) => ({ ...item, queue: `prod-${item.queue}` }));
    production.queues.producers = production.queues.producers.map((item) => ({ ...item, queue: `prod-${item.queue}` }));
  }
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
test("requires the thumbnail producer, Images binding, and five-minute notification cron", () => {
  const staging = stagingConfig("operations");
  const production = productionFrom(staging);
  staging.queues.producers = [];
  staging.images = undefined;
  staging.triggers.crons = ["*/15 * * * *"];
  const errors = validateApp("operations", staging, production);
  for (const expected of ["queue producers", "images", "cron triggers"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});
test("requires the authenticated client portal origin for Operations mail", () => {
  const staging = stagingConfig("operations");
  staging.vars.DELIVERY_BASE_URL = `https://${STAGING_HOSTS.delivery}`;
  const errors = validateApp("operations", staging, productionFrom(staging));
  assert(errors.some((error) => error.includes("DELIVERY_BASE_URL")), errors.join(" | "));
});
test("requires shared staging resources to agree", () => {
  const configs = { delivery: stagingConfig("delivery"), operations: stagingConfig("operations"), "ops-sync": stagingConfig("ops-sync") };
  configs.operations.d1_databases[1].database_id = "wrong";
  assert(validateCrossApp(configs).some((error) => error.includes("DELIVERY_DB")));
});
test("resolves logical delivery staging files from apps/client", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-staging-layout-"));
  for (const app of ["delivery", "operations", "ops-sync"]) {
    const directory = path.join(base, "apps", APP_SOURCE_DIRS[app]);
    fs.mkdirSync(directory, { recursive: true });
    const staging = stagingConfig(app);
    fs.writeFileSync(path.join(directory, "wrangler.staging.json"), JSON.stringify(staging));
    fs.writeFileSync(path.join(directory, "wrangler.jsonc"), JSON.stringify(productionFrom(staging)));
  }
  assert.deepEqual(validateFiles(base), []);
  fs.renameSync(path.join(base, "apps", "client"), path.join(base, "apps", "delivery"));
  assert(validateFiles(base).some((error) => error.includes(path.join("apps", "client", "wrangler.staging.json"))));
});
test("fails closed on client portal activation, origin, and audience reuse", () => {
  const staging = stagingConfig("delivery");
  const production = productionFrom(staging);
  staging.vars.CLIENT_PORTAL_ENABLED = "true";
  staging.vars.CLIENT_PORTAL_ORIGIN = "https://other-staging.example";
  staging.vars.CLIENT_ACCESS_AUD = STAGING_ACCESS_AUDS.operations;
  const errors = validateApp("delivery", staging, production);
  for (const expected of ["CLIENT_PORTAL_ENABLED", "client portal and public origins", "must not reuse"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});
