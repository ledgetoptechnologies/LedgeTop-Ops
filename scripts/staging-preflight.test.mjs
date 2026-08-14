import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateApp, validateCrossApp, validateFiles } from "./staging-preflight.mjs";
import { APP_SOURCE_DIRS, REQUIRED_DISABLED_FEATURE_FLAGS, REQUIRED_STAGING_SECRETS, STAGING_ACCESS_AUDS, STAGING_ACCOUNT_ID, STAGING_HOSTS, STAGING_INVENTORY, STAGING_STATIC_VARS } from "./staging-requirements.mjs";

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
        PROJECT_ALPHA_CATALOG_ACCESS_AUD: "b".repeat(64),
        PROJECT_ALPHA_PORTAL_ACCESS_AUD: "c".repeat(64),
        MAPBOX_PUBLIC_TOKEN: "pk.staging-client-mapbox-token",
        CLIENT_PORTAL_INVITATION_FROM: "portal@staging.example.test",
      } : {}),
      CLOUD_TRANSFER_DROPBOX_ENABLED: "false",
      CLOUD_TRANSFER_GOOGLE_ENABLED: "false",
      CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED: "false",
      DROPBOX_IMPORT_ENABLED: "false",
      DIRECT_DELIVERY_UPLOADS_ENABLED: "false",
      R2_PURGE_ENABLED: "false",
      ...(app === "operations" ? {
        PROJECT_ALPHA_BASE_URL: STAGING_STATIC_VARS.operations.PROJECT_ALPHA_BASE_URL,
        INCOMING_EXPECTED_HOST: "incoming-staging.ledgetopdroneservices.com",
        INCOMING_BASE_URL: "https://incoming-staging.ledgetopdroneservices.com",
        MAPBOX_PUBLIC_TOKEN: "pk.staging-operations-mapbox-token",
        CLIENT_REQUEST_TRIAGE_TO: "triage@staging.example.test",
        NOTIFICATION_FROM: "delivery@staging.example.test",
      } : {}),
      ...(app === "ops-sync" ? { CF_ACCESS_GROUP_ID: "staging-group", CF_ACCESS_GROUP_NAME: "Staging Testers" } : {}),
    },
    secrets: { required: [...REQUIRED_STAGING_SECRETS[app]] },
    d1_databases: inventory.d1_databases,
    r2_buckets: inventory.r2_buckets,
    workflows: inventory.workflows,
    services: inventory.services,
    ...(app === "delivery" ? { send_email: [{ name: "CLIENT_PORTAL_INVITATION_EMAIL", allowed_sender_addresses: ["portal@staging.example.test"] }] } : {}),
    ...(app === "operations" ? { send_email: [{ name: "NOTIFICATION_EMAIL", allowed_sender_addresses: ["delivery@staging.example.test"] }] } : {}),
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
  production.services = production.services.map((item) => ({ ...item, service: item.service.replace("-staging", "") }));
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
test("requires the thumbnail producer and five-minute renderer recovery cron", () => {
  const staging = stagingConfig("operations");
  const production = productionFrom(staging);
  staging.queues.producers = [];
  staging.triggers.crons = ["*/15 * * * *"];
  const errors = validateApp("operations", staging, production);
  for (const expected of ["queue producers", "cron triggers"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});
test("requires the authenticated client portal origin for Operations mail", () => {
  const staging = stagingConfig("operations");
  staging.vars.DELIVERY_BASE_URL = `https://${STAGING_HOSTS.delivery}`;
  const errors = validateApp("operations", staging, productionFrom(staging));
  assert(errors.some((error) => error.includes("DELIVERY_BASE_URL")), errors.join(" | "));
});
test("requires staging-only map, triage, and email bindings", () => {
  const delivery = stagingConfig("delivery");
  delivery.vars.MAPBOX_PUBLIC_TOKEN = "";
  delivery.vars.PROJECT_ALPHA_PORTAL_ACCESS_AUD = delivery.vars.PROJECT_ALPHA_CATALOG_ACCESS_AUD;
  delivery.send_email[0].allowed_sender_addresses = ["wrong@staging.example.test"];
  const deliveryErrors = validateApp("delivery", delivery, productionFrom(stagingConfig("delivery")));
  assert(deliveryErrors.some((error) => error.includes("MAPBOX_PUBLIC_TOKEN")), deliveryErrors.join(" | "));
  assert(deliveryErrors.some((error) => error.includes("Access audiences must all be distinct")), deliveryErrors.join(" | "));
  assert(deliveryErrors.some((error) => error.includes("invitation email binding")), deliveryErrors.join(" | "));

  const operations = stagingConfig("operations");
  operations.vars.CLIENT_REQUEST_TRIAGE_TO = "not-an-email";
  operations.send_email = [];
  const operationsErrors = validateApp("operations", operations, productionFrom(stagingConfig("operations")));
  assert(operationsErrors.some((error) => error.includes("CLIENT_REQUEST_TRIAGE_TO")), operationsErrors.join(" | "));
  assert(operationsErrors.some((error) => error.includes("notification email binding")), operationsErrors.join(" | "));
});
test("requires shared staging resources to agree", () => {
  const configs = { delivery: stagingConfig("delivery"), operations: stagingConfig("operations"), "ops-sync": stagingConfig("ops-sync") };
  configs.operations.d1_databases[1].database_id = "wrong";
  configs.delivery.services[0].service = "wrong-ops-staging";
  const errors = validateCrossApp(configs);
  assert(errors.some((error) => error.includes("DELIVERY_DB")));
  assert(errors.some((error) => error.includes("delegated-share signer")));
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
test("requires every portal-v2 and Operations capability to be explicitly false", () => {
  for (const app of ["delivery", "operations"]) {
    for (const flag of REQUIRED_DISABLED_FEATURE_FLAGS[app]) {
      const staging = stagingConfig(app);
      delete staging.vars[flag];
      const errors = validateApp(app, staging, productionFrom(staging));
      assert(errors.some((error) => error.includes(flag)), `${app}.${flag}: ${errors.join(" | ")}`);
    }
  }
});
test("checked-in staging examples enumerate the same flags and secret manifests as the gate", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const [app, example] of [["delivery", "delivery.wrangler.json.example"], ["operations", "operations.wrangler.json.example"]]) {
    const config = JSON.parse(fs.readFileSync(path.join(root, "docs", "staging", example), "utf8"));
    assert.deepEqual(new Set(config.secrets.required), new Set(REQUIRED_STAGING_SECRETS[app]));
    for (const flag of REQUIRED_DISABLED_FEATURE_FLAGS[app]) assert.equal(config.vars[flag], "false", `${example}.${flag}`);
  }
});
