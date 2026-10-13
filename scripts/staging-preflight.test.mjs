import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateApp, validateCrossApp, validateFiles, validateMigrationInventory, validateRequestAttachmentCors, validateSecretManifest } from "./staging-preflight.mjs";
import { APP_SOURCE_DIRS, FEATURE_FLAG_ACTIVATION_POLICIES, REQUIRED_DISABLED_FEATURE_FLAGS, REQUIRED_STAGING_MIGRATIONS, REQUIRED_STAGING_MIGRATION_SHA256, REQUIRED_STAGING_SECRETS, STAGING_ACCOUNT_ID, STAGING_ALLOWED_VAR_NAMES, STAGING_HOSTS, STAGING_INVENTORY, STAGING_PROJECT_ALPHA_ORIGIN, STAGING_REQUEST_ATTACHMENT_R2_CORS, STAGING_STATIC_VARS } from "./staging-requirements.mjs";

const audiences = Object.freeze({ delivery: "c".repeat(64), operations: "d".repeat(64), "ops-sync": "b".repeat(64) });
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const operationsWorkspacePage = "/administration/client-portal/operations-workspaces";

const clone = (value) => JSON.parse(JSON.stringify(value));
function stagingConfig(app) {
  const inventory = clone(STAGING_INVENTORY[app]);
  return {
    account_id: STAGING_ACCOUNT_ID,
    name: inventory.name,
    main: inventory.main,
    compatibility_date: inventory.compatibility_date,
    compatibility_flags: inventory.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    routes: inventory.routes,
    vars: {
      ...Object.fromEntries(STAGING_ALLOWED_VAR_NAMES[app].map((key) => [key, ""])),
      ...STAGING_STATIC_VARS[app],
      ENVIRONMENT: "staging",
      EXPECTED_HOST: inventory.routes[0].pattern,
      ...(app === "delivery" ? {
        POLICY_AUD: audiences.delivery,
        PUBLIC_BASE_URL: `https://${STAGING_HOSTS.delivery}`,
        CLIENT_PORTAL_ENABLED: "true",
        CLIENT_PORTAL_ORIGIN: `https://${STAGING_HOSTS.client}`,
        CLIENT_ACCESS_TEAM_DOMAIN: STAGING_STATIC_VARS.delivery.CLIENT_ACCESS_TEAM_DOMAIN,
        CLIENT_ACCESS_AUD: "a".repeat(64),
        PROJECT_ALPHA_CATALOG_ACCESS_AUD: "b".repeat(64),
        MAPBOX_PUBLIC_TOKEN: "pk.staging-client-mapbox-token",
        MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false",
        CLIENT_PORTAL_INVITATION_FROM: "portal@staging.example.test",
      } : {}),
      ...(app === "operations" ? {
        OPERATIONS_AUD: audiences.operations,
        PUBLIC_BASE_URL: `https://${inventory.routes[0].pattern}`,
        PROJECT_ALPHA_BASE_URL: STAGING_STATIC_VARS.operations.PROJECT_ALPHA_BASE_URL,
        PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_SOURCE_ID: "project-alpha:staging",
        PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
        INCOMING_EXPECTED_HOST: "incoming-staging.ledgetopdroneservices.com",
        INCOMING_BASE_URL: "https://incoming-staging.ledgetopdroneservices.com",
        MAPBOX_PUBLIC_TOKEN: "pk.staging-operations-mapbox-token",
        MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false",
        CLIENT_REQUEST_TRIAGE_TO: "triage@staging.example.test",
        NOTIFICATION_FROM: "delivery@staging.example.test",
      } : {}),
      ...(app === "ops-sync" ? { CF_ACCESS_AUD: audiences["ops-sync"], CF_ACCESS_GROUP_ID: "staging-group", CF_ACCESS_GROUP_NAME: "Staging Testers" } : {}),
    },
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
    ...(inventory.limits ? { limits: inventory.limits } : {}),
    ...(inventory.assets ? { assets: inventory.assets } : {}),
    ...(inventory.observability ? { observability: inventory.observability } : {}),
    ...(inventory.stream ? { stream: inventory.stream } : {}),
    ...(inventory.durable_objects ? { durable_objects: inventory.durable_objects } : {}),
    ...(inventory.exports ? { exports: inventory.exports } : {}),
    ...(inventory.containers ? { containers: inventory.containers } : {}),
    ...(inventory.crons ? { triggers: { crons: inventory.crons } } : {}),
  };
}
function productionFrom(staging) {
  const production = clone(staging);
  production.name = production.name.replace("-staging", "");
  production.routes = production.routes.map((route) => ({ ...route, pattern: route.pattern.replace("-staging", "") }));
  for (const key of Object.keys(production.vars)) if (/(?:EXPECTED_HOST|BASE_URL|_ORIGIN|_AUD)$/.test(key)) production.vars[key] = `production-${key}`;
  if (production.vars.MAPBOX_PUBLIC_TOKEN) production.vars.MAPBOX_PUBLIC_TOKEN = `pk.production-${production.name}-mapbox-token`;
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
test("keeps Project Alpha Directory reconciliation modeled and default-off", () => {
  const staging = stagingConfig("operations"), production = productionFrom(staging);
  assert.equal(staging.vars.PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED, "false");
  assert.deepEqual(validateApp("operations", staging, production), []);
  staging.vars.PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED = "true";
  const errors = validateApp("operations", staging, production);
  assert(errors.some(error => error.includes("PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED")), errors.join(" | "));
});
test("pins the inactive workspace binding to staging and keeps its release flags off", () => {
  const base = stagingConfig("operations");
  const production = productionFrom(base);
  const wrongTarget = structuredClone(base);
  wrongTarget.services.find((item) => item.binding === "CLIENT_AUTHORITY_WORKSPACE_BINDING").service = "ledgetop-clients";
  const targetErrors = validateApp("operations", wrongTarget, production);
  assert(targetErrors.some((error) => error.includes("service") && error.includes("CLIENT_AUTHORITY_WORKSPACE_BINDING")), targetErrors.join(" | "));
  const enabled = structuredClone(base);
  enabled.vars.CLIENT_PORTAL_WORKSPACE_BINDING_ADMIN_ENABLED = "true";
  enabled.vars.CLIENT_PORTAL_WORKSPACE_BINDING_ADMIN_ORIGIN = "https://ops.ledgetopdroneservices.com";
  enabled.vars.CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED = "true";
  const errors = validateApp("operations", enabled, production);
  assert(errors.some((error) => error.includes("CLIENT_PORTAL_WORKSPACE_BINDING_ADMIN_ENABLED")), errors.join(" | "));
  assert(errors.some((error) => error.includes("CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED")), errors.join(" | "));
  assert(errors.some((error) => error.includes("workspace binding admin requires the exact Ops HTTPS staging origin")), errors.join(" | "));
});

test("authority v3 owner origin is blank only while disabled and exact when enabled", () => {
  const disabled = stagingConfig("operations"), production = productionFrom(disabled);
  assert.deepEqual(validateApp("operations", disabled, production), []);
  disabled.vars.CLIENT_PORTAL_AUTHORITY_V3_OWNER_ORIGIN = "https://ops-staging.example.test";
  assert(validateApp("operations", disabled, production).some(error => error.includes("authority v3 owner origin")));
  const enabled = stagingConfig("operations");
  enabled.vars.CLIENT_PORTAL_AUTHORITY_V3_OWNER_ENABLED = "true";
  enabled.vars.CLIENT_PORTAL_AUTHORITY_V3_OWNER_ORIGIN = `https://${STAGING_HOSTS.operations}`;
  assert(!validateApp("operations", enabled, productionFrom(stagingConfig("operations"))).some(error => error.includes("exact Ops HTTPS staging origin")));
  enabled.vars.CLIENT_PORTAL_AUTHORITY_V3_OWNER_ORIGIN = "https://wrong-staging.example.test";
  assert(validateApp("operations", enabled, productionFrom(stagingConfig("operations"))).some(error => error.includes("exact Ops HTTPS staging origin")));
});
test("recipient enrollment stays staging-only, separately gated, and secret-backed", () => {
  const delivery = stagingConfig("delivery");
  const operations = stagingConfig("operations");
  const configs = { delivery, operations, "ops-sync": stagingConfig("ops-sync") };
  const bridge = delivery.services.find(({ binding }) => binding === "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE");

  assert.deepEqual(bridge, {
    binding: "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE",
    service: "ledgetop-ops-staging",
    entrypoint: "ClientPortalRecipientEnrollmentBridge",
  });
  assert.equal(Object.hasOwn(delivery.vars, "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET"), false);
  assert(REQUIRED_STAGING_SECRETS.delivery.includes("CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET"));
  assert.match(FEATURE_FLAG_ACTIVATION_POLICIES.delivery.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED.prohibitedReason, /separately reviewed staging-only activation window/);
  assert.match(FEATURE_FLAG_ACTIVATION_POLICIES.operations.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED.prohibitedReason, /independent from owner mutation authority/);
  assert.match(FEATURE_FLAG_ACTIVATION_POLICIES.operations.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_OWNER_ENABLED.prohibitedReason, /separate reviewed activation/);

  bridge.service = "ledgetop-ops";
  let errors = validateApp("delivery", delivery, productionFrom(stagingConfig("delivery")));
  assert(errors.some((error) => error.includes("services") || error.includes("service CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE")), errors.join(" | "));
  errors = validateCrossApp(configs);
  assert(errors.some((error) => error.includes("recipient enrollment bridge")), errors.join(" | "));

  const disabledWithOrigin = stagingConfig("operations");
  disabledWithOrigin.vars.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_OWNER_ORIGIN = `https://${STAGING_HOSTS.operations}`;
  errors = validateApp("operations", disabledWithOrigin, productionFrom(stagingConfig("operations")));
  assert(errors.some((error) => error.includes("owner origin must remain empty while disabled")), errors.join(" | "));

  const enabled = stagingConfig("operations");
  enabled.vars.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_OWNER_ENABLED = "true";
  enabled.vars.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_OWNER_ORIGIN = `https://${STAGING_HOSTS.operations}`;
  errors = validateApp("operations", enabled, productionFrom(stagingConfig("operations")));
  assert(!errors.some((error) => error.includes("exact Ops HTTPS staging origin")), errors.join(" | "));
  enabled.vars.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_OWNER_ORIGIN = "https://ops.ledgetopdroneservices.com";
  errors = validateApp("operations", enabled, productionFrom(stagingConfig("operations")));
  assert(errors.some((error) => error.includes("exact Ops HTTPS staging origin")), errors.join(" | "));
});
test("rejects missing, unexpected, or non-regular release migrations", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-staging-migrations-"));
  for (const app of ["delivery", "operations"]) {
    const directory = path.join(base, "apps", APP_SOURCE_DIRS[app], "migrations");
    fs.mkdirSync(directory, { recursive: true });
    for (const name of REQUIRED_STAGING_MIGRATIONS[app]) {
      const reviewed = REQUIRED_STAGING_MIGRATION_SHA256[app]?.[name];
      if (reviewed) fs.copyFileSync(path.join(repositoryRoot, "apps", APP_SOURCE_DIRS[app], "migrations", name), path.join(directory, name));
      else fs.writeFileSync(path.join(directory, name), "-- migration\n");
    }
  }
  assert.deepEqual(validateMigrationInventory(base), []);
  fs.appendFileSync(path.join(base, "apps", "operations", "migrations", "0163_project_alpha_directory_read_adoption_field_review_receipts.sql"), "\n-- drift\n");
  assert(validateMigrationInventory(base).some((error) => error.includes("0163_project_alpha_directory_read_adoption_field_review_receipts.sql SHA-256")));
  fs.appendFileSync(path.join(base, "apps", "operations", "migrations", "0168_project_alpha_directory_read_adoption_local_profiles.sql"), "\n-- drift\n");
  assert(validateMigrationInventory(base).some((error) => error.includes("0168_project_alpha_directory_read_adoption_local_profiles.sql SHA-256")));
  fs.appendFileSync(path.join(base, "apps", "operations", "migrations", "0171_project_alpha_active_directory_update_guard.sql"), "\n-- drift\n");
  assert(validateMigrationInventory(base).some((error) => error.includes("0171_project_alpha_active_directory_update_guard.sql SHA-256")));
  fs.rmSync(path.join(base, "apps", "client", "migrations", "0213_incoming_rclone_promotion.sql"));
  fs.writeFileSync(path.join(base, "apps", "client", "migrations", "0214_unreviewed.sql"), "-- unexpected\n");
  assert(validateMigrationInventory(base).some((error) => error.includes("delivery release migration inventory")));
});
test("rejects an Access audience reused from any production audience field", () => {
  const staging = stagingConfig("delivery");
  const production = productionFrom(staging);
  const productionAudience = "f".repeat(64);
  production.vars.UNRELATED_LEGACY_AUD = productionAudience;
  staging.vars.POLICY_AUD = productionAudience;
  const errors = validateApp("delivery", staging, production);
  assert(errors.some((error) => error.includes("POLICY_AUD reuses a production Access audience")), errors.join(" | "));
});
test("rejects account, route, resource, secret, and capability drift", () => {
  const staging = stagingConfig("delivery");
  const production = productionFrom(staging);
  staging.account_id = "wrong";
  staging.routes[0].pattern = "other-staging.test";
  staging.d1_databases[0].database_id = "wrong";
  staging.vars.CLOUD_TRANSFER_DROPBOX_ENABLED = "true";
  const errors = validateApp("delivery", staging, production);
  for (const expected of ["account_id", "routes", "d1_databases", "CLOUD_TRANSFER_DROPBOX_ENABLED"]) assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  assert(validateSecretManifest({ delivery: ["UNEXPECTED"], operations: [...REQUIRED_STAGING_SECRETS.operations], "ops-sync": [...REQUIRED_STAGING_SECRETS["ops-sync"]] }).length > 0);
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
test("requires the anonymous public-share origin for Operations share links", () => {
  const staging = stagingConfig("operations");
  staging.vars.PUBLIC_SHARE_ORIGIN = `https://${STAGING_HOSTS.client}`;
  const errors = validateApp("operations", staging, productionFrom(staging));
  assert(errors.some((error) => error.includes("PUBLIC_SHARE_ORIGIN")), errors.join(" | "));
});
test("requires staging-only map, triage, and email bindings", () => {
  const delivery = stagingConfig("delivery");
  delivery.vars.MAPBOX_PUBLIC_TOKEN = "";
  delivery.vars.CLIENT_ACCESS_AUD = delivery.vars.PROJECT_ALPHA_CATALOG_ACCESS_AUD;
  delivery.send_email[0].allowed_sender_addresses = ["wrong@staging.example.test"];
  const deliveryErrors = validateApp("delivery", delivery, productionFrom(stagingConfig("delivery")));
  assert(deliveryErrors.some((error) => error.includes("MAPBOX_PUBLIC_TOKEN")), deliveryErrors.join(" | "));
  assert(deliveryErrors.some((error) => error.includes("client portal audience must remain distinct")), deliveryErrors.join(" | "));
  assert(deliveryErrors.some((error) => error.includes("invitation email binding")), deliveryErrors.join(" | "));

  const operations = stagingConfig("operations");
  operations.vars.CLIENT_REQUEST_TRIAGE_TO = "not-an-email";
  operations.send_email = [];
  const operationsErrors = validateApp("operations", operations, productionFrom(stagingConfig("operations")));
  assert(operationsErrors.some((error) => error.includes("CLIENT_REQUEST_TRIAGE_TO")), operationsErrors.join(" | "));
  assert(operationsErrors.some((error) => error.includes("notification email binding")), operationsErrors.join(" | "));
});
test("keeps native integration control inert", () => {
  const exact = stagingConfig("operations");
  assert.deepEqual(validateApp("operations", exact, productionFrom(exact)), []);

  const populatedDisabledOrigin = stagingConfig("operations");
  populatedDisabledOrigin.vars.NATIVE_INTEGRATION_CONTROL_ORIGIN = "https://ops-staging.ledgetopdroneservices.com";
  let errors = validateApp("operations", populatedDisabledOrigin, productionFrom(stagingConfig("operations")));
  assert(errors.some((error) => error.includes("origin must remain empty")), errors.join(" | "));

  const enabled = stagingConfig("operations");
  enabled.vars.NATIVE_INTEGRATION_CONTROL_ENABLED = "true";
  errors = validateApp("operations", enabled, productionFrom(stagingConfig("operations")));
  assert(errors.some((error) => error.includes("NATIVE_INTEGRATION_CONTROL_ENABLED=false")), errors.join(" | "));
  assert(errors.some((error) => error.includes("requires an exact HTTPS staging origin")), errors.join(" | "));

});
test("requires shared staging resources to agree", () => {
  const configs = { delivery: stagingConfig("delivery"), operations: stagingConfig("operations"), "ops-sync": stagingConfig("ops-sync") };
  configs.operations.d1_databases[1].database_id = "wrong";
  configs.delivery.services.find(service => service.binding === "CLIENT_DELEGATED_SHARE_SIGNER").service = "wrong-ops-staging";
  configs.delivery.services.find(service => service.binding === "VIEWER_SESSION_ISSUER").entrypoint = "WrongViewerIssuer";
  configs.delivery.services.find(service => service.binding === "CLIENT_PORTAL_SERVICE_METADATA_READER").entrypoint = "WrongMetadataReader";
  configs.delivery.services.find(service => service.binding === "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE").entrypoint = "WrongRecipientEnrollmentBridge";
  configs.delivery.services.find(service => service.binding === "OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT").entrypoint = "WrongNativeRecipientIngress";
  configs.delivery.services.find(service => service.binding === "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER").entrypoint = "WrongNativeDeliveryReader";
  configs.operations.services.find(service => service.binding === "OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY").entrypoint = "WrongNativeRecipientAuthority";
  configs.operations.services.find(service => service.binding === "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY").entrypoint = "WrongNativeDeliveryAuthority";
  configs["ops-sync"].services[0].entrypoint = "WrongPortalIngress";
  configs.delivery.vars.PROJECT_ALPHA_PORTAL_APPLICATION_KEY = "wrong-application-key";
  const errors = validateCrossApp(configs);
  assert(errors.some((error) => error.includes("DELIVERY_DB")));
  assert(errors.some((error) => error.includes("delegated-share signer")));
  assert(errors.some((error) => error.includes("Viewer session issuer")));
  assert(errors.some((error) => error.includes("service metadata reader")));
  assert(errors.some((error) => error.includes("recipient enrollment bridge")));
  assert(errors.some((error) => error.includes("native recipient enrollment")));
  assert(errors.some((error) => error.includes("native authorization reader")));
  assert(errors.some((error) => error.includes("native recipient authority")));
  assert(errors.some((error) => error.includes("native delivery authority")));
  assert(errors.some((error) => error.includes("portal projection ingress")));
  assert(errors.some((error) => error.includes("application key")));
});
test("allows Mapbox staging deferral only as an all-or-none explicit state", () => {
  const configs = { delivery: stagingConfig("delivery"), operations: stagingConfig("operations"), "ops-sync": stagingConfig("ops-sync") };
  for (const app of ["delivery", "operations"]) {
    configs[app].vars.MAPBOX_STAGING_ACCEPTANCE_DEFERRED = "true";
    configs[app].vars.MAPBOX_PUBLIC_TOKEN = "";
  }
  assert.deepEqual(validateApp("delivery", configs.delivery, productionFrom(stagingConfig("delivery"))), []);
  assert.deepEqual(validateApp("operations", configs.operations, productionFrom(stagingConfig("operations"))), []);
  assert.deepEqual(validateCrossApp(configs), []);

  configs.operations.vars.MAPBOX_STAGING_ACCEPTANCE_DEFERRED = "false";
  let errors = validateCrossApp(configs);
  assert(errors.some((error) => error.includes("deferral must match")), errors.join(" | "));
  assert(errors.some((error) => error.includes("requires both rendered MAPBOX_PUBLIC_TOKEN values to be populated")), errors.join(" | "));

  configs.operations.vars.MAPBOX_STAGING_ACCEPTANCE_DEFERRED = "true";
  configs.operations.vars.MAPBOX_PUBLIC_TOKEN = "pk.must-not-be-rendered";
  errors = validateCrossApp(configs);
  assert(errors.some((error) => error.includes("requires both rendered MAPBOX_PUBLIC_TOKEN values to be empty")), errors.join(" | "));
});
test("rejects a configured staging Mapbox token reused from production", () => {
  const staging = stagingConfig("delivery");
  const production = productionFrom(staging);
  production.vars.MAPBOX_PUBLIC_TOKEN = staging.vars.MAPBOX_PUBLIC_TOKEN;
  const errors = validateApp("delivery", staging, production);
  assert(errors.some((error) => error.includes("reuses a production Mapbox token")), errors.join(" | "));
});
test("rejects a staging Access audience reused from another production Worker", () => {
  const configs = { delivery: stagingConfig("delivery"), operations: stagingConfig("operations"), "ops-sync": stagingConfig("ops-sync") };
  const productionConfigs = Object.fromEntries(Object.entries(configs).map(([app, config]) => [app, productionFrom(config)]));
  productionConfigs.operations.vars.UNRELATED_AUD = configs.delivery.vars.POLICY_AUD;
  const errors = validateCrossApp(configs, productionConfigs);
  assert(errors.some((error) => error.includes("delivery staging Access audience reuses a production Access audience")), errors.join(" | "));
});
test("requires every active staging Access audience to be distinct", () => {
  const configs = { delivery: stagingConfig("delivery"), operations: stagingConfig("operations"), "ops-sync": stagingConfig("ops-sync") };
  configs.operations.vars.OPERATIONS_AUD = configs.delivery.vars.CLIENT_ACCESS_AUD;
  const errors = validateCrossApp(configs);
  assert(errors.some((error) => error.includes("Access audiences must all be distinct")), errors.join(" | "));
});

test("rejects an Operations staging config without the required SPA assets binding", () => {
  const operations = stagingConfig("operations");
  delete operations.assets;
  const errors = validateApp("operations", operations, productionFrom(stagingConfig("operations")));
  assert(errors.some((error) => error.includes("operations assets does not match the approved staging inventory")), errors.join(" | "));
});
test("routes the workspace owner page through the guarded staging Worker exactly once", () => {
  const approvedRoutes = STAGING_INVENTORY.operations.assets.run_worker_first;
  assert.deepEqual(approvedRoutes, [
    "/api/*", "/health", "/r/*",
    "/administration/client-portal/operations-recipients",
    "/administration/client-portal/operations-delivery-authority",
    operationsWorkspacePage,
  ]);
  assert.equal(approvedRoutes.filter((route) => route === operationsWorkspacePage).length, 1);

  const missing = stagingConfig("operations");
  missing.assets.run_worker_first = missing.assets.run_worker_first.filter((route) => route !== operationsWorkspacePage);
  let errors = validateApp("operations", missing, productionFrom(stagingConfig("operations")));
  assert(errors.some((error) => error.includes("operations assets does not match the approved staging inventory")), errors.join(" | "));

  const duplicated = stagingConfig("operations");
  duplicated.assets.run_worker_first.push(operationsWorkspacePage);
  errors = validateApp("operations", duplicated, productionFrom(stagingConfig("operations")));
  assert(errors.some((error) => error.includes("operations assets does not match the approved staging inventory")), errors.join(" | "));
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
  for (const app of ["delivery", "operations"]) {
    const directory = path.join(base, "apps", APP_SOURCE_DIRS[app], "migrations");
    fs.mkdirSync(directory, { recursive: true });
    for (const name of REQUIRED_STAGING_MIGRATIONS[app]) {
      const reviewed = REQUIRED_STAGING_MIGRATION_SHA256[app]?.[name];
      if (reviewed) fs.copyFileSync(path.join(repositoryRoot, "apps", APP_SOURCE_DIRS[app], "migrations", name), path.join(directory, name));
      else fs.writeFileSync(path.join(directory, name), "-- migration\n");
    }
  }
  const corsDirectory = path.join(base, "docs", "staging");
  fs.mkdirSync(corsDirectory, { recursive: true });
  fs.writeFileSync(path.join(corsDirectory, "request-attachments-r2-cors.json"), JSON.stringify(STAGING_REQUEST_ATTACHMENT_R2_CORS));
  fs.writeFileSync(path.join(corsDirectory, "staging-secret-manifest.json"), JSON.stringify(REQUIRED_STAGING_SECRETS));
  assert.deepEqual(validateFiles(base), []);
  fs.renameSync(path.join(base, "apps", "client"), path.join(base, "apps", "delivery"));
  assert(validateFiles(base).some((error) => error.includes(path.join("apps", "client", "wrangler.staging.json"))));
});
test("fails closed on client portal deactivation, host namespace origins, and audience reuse", () => {
  const staging = stagingConfig("delivery");
  const production = productionFrom(staging);
  staging.vars.CLIENT_PORTAL_ENABLED = "false";
  staging.vars.CLIENT_PORTAL_ORIGIN = "https://other-staging.example";
  staging.vars.PUBLIC_SHARE_ORIGIN = `https://${STAGING_HOSTS.client}`;
  staging.vars.PUBLIC_BASE_URL = staging.vars.PUBLIC_SHARE_ORIGIN;
  staging.vars.CLIENT_ACCESS_AUD = staging.vars.PROJECT_ALPHA_CATALOG_ACCESS_AUD;
  const errors = validateApp("delivery", staging, production);
  for (const expected of ["CLIENT_PORTAL_ENABLED", "authenticated client staging host", "anonymous delivery staging host", "must remain distinct"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});
test("requires EXPECTED_HOST to move atomically with the anonymous public origin", () => {
  const staging = stagingConfig("delivery");
  const production = productionFrom(staging);
  staging.vars.EXPECTED_HOST = STAGING_HOSTS.client;
  const errors = validateApp("delivery", staging, production);
  assert(errors.some((error) => error.includes("EXPECTED_HOST")), errors.join(" | "));
});
test("requires the exact staging request-attachment R2 CORS policy", () => {
  assert.deepEqual(validateRequestAttachmentCors(clone(STAGING_REQUEST_ATTACHMENT_R2_CORS)), []);
  for (const drift of [
    { rules: [{ ...clone(STAGING_REQUEST_ATTACHMENT_R2_CORS).rules[0], allowed: { ...clone(STAGING_REQUEST_ATTACHMENT_R2_CORS).rules[0].allowed, origins: ["*"] } }] },
    { rules: [{ ...clone(STAGING_REQUEST_ATTACHMENT_R2_CORS).rules[0], allowed: { ...clone(STAGING_REQUEST_ATTACHMENT_R2_CORS).rules[0].allowed, methods: ["GET", "PUT"] } }] },
    { rules: [{ ...clone(STAGING_REQUEST_ATTACHMENT_R2_CORS).rules[0], allowed: { ...clone(STAGING_REQUEST_ATTACHMENT_R2_CORS).rules[0].allowed, headers: ["*"] } }] },
  ]) assert.equal(validateRequestAttachmentCors(drift).length, 1);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const checkedIn = JSON.parse(fs.readFileSync(path.join(root, "docs", "staging", "request-attachments-r2-cors.json"), "utf8"));
  assert.deepEqual(checkedIn, clone(STAGING_REQUEST_ATTACHMENT_R2_CORS));
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

test("pins the native portal, the complete Operations chain, both 0199 files, and the 0200-0228 release contract", () => {
  assert.equal(REQUIRED_STAGING_MIGRATIONS.operations.length, 174);
  assert.equal(REQUIRED_STAGING_MIGRATIONS.operations[0], "0014_staff_acl_controls.sql");
  assert.equal(REQUIRED_STAGING_MIGRATIONS.operations.at(-1), "0187_operations_portal_native_delivery_literal_prefix_guard.sql");
  assert.deepEqual(REQUIRED_STAGING_MIGRATIONS.delivery.slice(-46), [
    "0184_native_client_feedback.sql",
    "0185_native_service_request_ownership.sql",
    "0186_delivery_notification_authority_provenance.sql",
    "0187_authenticated_content_audit.sql",
    "0188_native_feedback_completion_notices.sql",
    "0189_primary_staff_folder_bindings.sql",
    "0190_portal_contact_assignments_v4.sql",
    "0191_portal_projection_wire_contract_claim.sql",
    "0192_contact_assignment_billing_independence.sql",
    "0193_bulk_download_parts.sql",
    "0194_client_delegated_share_expiry.sql",
    "0195_legacy_workspace_authority_lifecycle.sql",
    "0196_bulk_download_archive_cache.sql",
    "0197_portal_root_access_policy.sql",
    "0198_incoming_upload_owner_notifications.sql",
    "0199_incoming_upload_pickup_lifecycle.sql",
    "0199_native_viewer_grants.sql",
    "0200_native_feedback_workspace_history.sql",
    "0201_native_draft_quote_notifications.sql",
    "0202_native_delivery_recipient_events.sql",
    "0203_primary_delivery_authority.sql",
    "0204_delivery_change_receipts.sql",
    "0205_authenticated_delivery_change_sequence.sql",
    "0206_delivery_index_provider_identity.sql",
    "0207_delivery_change_projection.sql",
    "0208_authenticated_delivery_change_batch_provider_identity.sql",
    "0209_authenticated_delivery_change_recipient_events.sql",
    "0210_client_delegated_share_expiry_health.sql",
    "0211_incoming_upload_verification_lifecycle.sql",
    "0212_incoming_upload_archive_inventory.sql",
    "0213_incoming_rclone_promotion.sql",
    "0214_ops_inventory_catalog_staging.sql",
    "0215_operations_portal_access_authority_shadow.sql",
    "0216_client_authority_workspace_ownership_claim.sql",
    "0217_client_authority_workspace_claim_evidence.sql",
    "0218_client_authority_workspace_binding.sql",
    "0219_operations_portal_authority_v2.sql",
    "0220_operations_portal_authority_v3_permissions.sql",
    "0221_verified_recipient_delivery_authority.sql",
    "0222_verified_recipient_delivery_cross_manager_revoke.sql",
    "0223_operations_portal_workspace_publications.sql",
    "0224_operations_portal_native_recipient_authority.sql",
    "0225_operations_portal_workspace_publication_cancellations.sql",
    "0226_operations_portal_native_workspace_cleanup.sql",
    "0227_operations_portal_native_delivery_authority.sql",
    "0228_operations_portal_native_content_start_audit.sql",
  ]);
  assert.deepEqual(REQUIRED_STAGING_MIGRATIONS.operations.slice(REQUIRED_STAGING_MIGRATIONS.operations.indexOf("0123_native_directory_authority_history.sql")), [
    "0123_native_directory_authority_history.sql",
    "0124_project_alpha_project_adoption_review_evidence.sql",
    "0125_project_alpha_existing_directory_binding_activation.sql",
    "0126_project_alpha_project_active_directory_mapping_bridge.sql",
    "0127_project_alpha_existing_directory_binding_activation_evidence_transition.sql",
    "0128_project_alpha_project_adoption_bind_bridge.sql",
    "0129_project_alpha_existing_directory_binding_activation_relationship.sql",
    "0130_project_alpha_project_adoption_review_producer.sql",
    "0131_project_alpha_project_active_directory_mapping_guards.sql",
    "0132_operations_directory_acquired_relationship_dependencies.sql",
    "0133_project_alpha_directory_relationship_outbox.sql",
    "0134_native_directory_create_admission_relationships.sql",
    "0135_operations_directory_relationship_canonical_ids.sql",
    "0136_project_alpha_directory_reconciliation.sql",
    "0137_project_alpha_directory_reconciliation_scheduler.sql",
    "0138_project_alpha_directory_reconciliation_review.sql",
    "0139_native_directory_staging_empty_enrollment_fixture_guard.sql",
    "0140_client_onboarding_one_time_reveal.sql",
    "0141_deferred_directory_client_materialization.sql",
    "0142_client_portal_access_authority_outbox.sql",
    "0143_client_portal_workspace_binding_selection.sql",
    "0144_client_portal_workspace_binding_outbox.sql",
    "0145_client_portal_authority_v2_outbox.sql",
    "0146_ops_customer_service_enrollments.sql",
    "0147_client_portal_authority_v3_permissions.sql",
    "0148_client_portal_recipient_enrollment.sql",
    "0149_client_portal_recipient_enrollment_sql_fences.sql",
    "0150_client_portal_recipient_enrollment_cancellation.sql",
    "0151_verified_recipient_delivery_authority_outbox.sql",
    "0152_operations_portal_workspace_reservations.sql",
    "0153_operations_portal_workspace_publication_outbox.sql",
    "0154_operations_portal_native_recipient_authority.sql",
    "0155_operations_portal_workspace_publication_cancellations.sql",
    "0156_operations_portal_workspace_publication_invocations.sql",
    "0157_operations_portal_native_workspace_cleanup.sql",
    "0158_operations_portal_native_delivery_authority.sql",
    "0159_operations_portal_native_delivery_recovery_invocations.sql",
    "0160_operations_portal_native_recipient_labels.sql",
    "0161_project_alpha_api_v2_inventory_observations.sql",
    "0162_project_alpha_directory_read_adoption_claims.sql",
    "0163_project_alpha_directory_read_adoption_field_review_receipts.sql",
    "0164_project_alpha_directory_read_adoption_authority_recheck.sql",
    "0165_project_alpha_inventory_generation_surface_scope.sql",
    "0166_project_alpha_reviewed_standalone_display.sql",
    "0167_project_alpha_directory_read_adoption_finalizations.sql",
    "0168_project_alpha_directory_read_adoption_local_profiles.sql",
    "0169_project_alpha_existing_directory_binding_generation_evidence.sql",
    "0170_project_alpha_active_directory_project_guard.sql",
    "0171_project_alpha_active_directory_update_guard.sql",
    "0172_project_alpha_active_directory_consumer_guards.sql",
    "0173_operations_directory_intent_acquired_destination_transition.sql",
    "0174_project_alpha_directory_preserved_external_identity.sql",
    "0175_operations_directory_acquired_parent_enrollment_identity.sql",
    "0176_operations_directory_acquired_intent_authority.sql",
    "0177_operations_directory_acquired_intent_update_authority.sql",
    "0178_project_alpha_project_inbound_reconciliation.sql",
    "0179_project_alpha_acquired_native_identity_collision.sql",
    "0180_project_alpha_project_v2_recovery_authorization.sql",
    "0181_project_alpha_directory_create_generation_recovery.sql",
    "0182_project_alpha_directory_relationship_recovery_guard.sql",
    "0183_project_alpha_binding_standalone_relationship_rows.sql",
    "0184_project_alpha_directory_relationship_generation_recovery.sql",
    "0185_project_alpha_directory_binding_generation_epochs.sql",
    "0186_project_alpha_directory_conflict_evidence_binding.sql",
    "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
  ]);
  const nativeDirectoryStart = REQUIRED_STAGING_MIGRATIONS.operations.indexOf("0054_project_alpha_directory_outbox.sql");
  assert.deepEqual(REQUIRED_STAGING_MIGRATIONS.operations.slice(nativeDirectoryStart, nativeDirectoryStart + 3), [
    "0054_project_alpha_directory_outbox.sql",
    "0055_operations_directory_authority.sql",
    "0056_operations_directory_materialization.sql",
  ]);
  assert(REQUIRED_DISABLED_FEATURE_FLAGS.delivery.includes("CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED"));
  assert(REQUIRED_DISABLED_FEATURE_FLAGS.delivery.includes("CLIENT_PORTAL_CONTENT_AUDIT_ENABLED"));
  assert.equal(STAGING_STATIC_VARS.delivery.CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.delivery.CLIENT_PORTAL_CONTENT_AUDIT_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.delivery.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.operations.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED, "false");
  for (const flag of ["PROJECT_ALPHA_API_V2_SYNC_ENABLED", "PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED"]) {
    assert(REQUIRED_DISABLED_FEATURE_FLAGS.operations.includes(flag), flag);
    assert(STAGING_ALLOWED_VAR_NAMES.operations.includes(flag), flag);
    assert.equal(STAGING_STATIC_VARS.operations[flag], "false", flag);
  }
  assert(REQUIRED_DISABLED_FEATURE_FLAGS.operations.includes("PROJECT_ALPHA_PROJECT_V2_RECOVERY_ENABLED"));
  assert(STAGING_ALLOWED_VAR_NAMES.operations.includes("PROJECT_ALPHA_PROJECT_V2_RECOVERY_ENABLED"));
  assert.equal(STAGING_STATIC_VARS.operations.PROJECT_ALPHA_PROJECT_V2_RECOVERY_ENABLED, "false");
  for (const flag of ["NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED", "NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED"]) {
    assert(REQUIRED_DISABLED_FEATURE_FLAGS.operations.includes(flag), flag);
    assert(STAGING_ALLOWED_VAR_NAMES.operations.includes(flag), flag);
    assert.equal(STAGING_STATIC_VARS.operations[flag], "false", flag);
  }
  assert(REQUIRED_DISABLED_FEATURE_FLAGS.operations.includes("PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED"));
  assert(STAGING_ALLOWED_VAR_NAMES.operations.includes("PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED"));
  assert.equal(STAGING_STATIC_VARS.operations.PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED, "false");
  assert(REQUIRED_DISABLED_FEATURE_FLAGS.operations.includes("PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED"));
  assert(STAGING_ALLOWED_VAR_NAMES.operations.includes("PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED"));
  assert.equal(STAGING_STATIC_VARS.operations.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED, "false");
  assert.match(FEATURE_FLAG_ACTIVATION_POLICIES.operations.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED.prohibitedReason,
    /separately approved bounded staging-only finalization window/);
  assert(REQUIRED_DISABLED_FEATURE_FLAGS.operations.includes("PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED"));
  assert(STAGING_ALLOWED_VAR_NAMES.operations.includes("PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED"));
  assert.equal(STAGING_STATIC_VARS.operations.PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.delivery.PROJECT_ALPHA_PORTAL_SYNC_ENABLED, "true");
  assert.equal(STAGING_STATIC_VARS.delivery.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.delivery.PROJECT_ALPHA_PORTAL_APPLICATION_KEY, STAGING_STATIC_VARS["ops-sync"].APPLICATION_KEY);
  assert.equal(STAGING_STATIC_VARS.operations.INCOMING_RCLONE_PROMOTION_ENABLED, "false");
  assert.deepEqual(STAGING_INVENTORY.operations.workflows.find(({ binding }) => binding === "INCOMING_RCLONE_PROMOTION_WORKFLOW"), {
    name: "ledgetop-incoming-rclone-promotion-staging",
    binding: "INCOMING_RCLONE_PROMOTION_WORKFLOW",
    class_name: "IncomingRclonePromotionWorkflow",
  });
  assert.equal(STAGING_PROJECT_ALPHA_ORIGIN, "https://pa-staging.ledgetoptechnologies.com");
  assert.deepEqual(Object.fromEntries(Object.entries(STAGING_INVENTORY).map(([app, inventory]) => [app, inventory.name])), {
    delivery: "ledgetop-clients-staging",
    operations: "ledgetop-ops-staging",
    "ops-sync": "ledgetop-ops-sync-staging",
  });
  for (const obsolete of [
    "PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN", "PROJECT_ALPHA_PORTAL_ACCESS_AUD",
    "PROJECT_ALPHA_PORTAL_HMAC_KEY_ID", "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID",
  ]) assert.equal(STAGING_ALLOWED_VAR_NAMES.delivery.includes(obsolete), false, obsolete);
  for (const obsolete of ["PROJECT_ALPHA_PORTAL_HMAC_SECRET", "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET"])
    assert.equal(REQUIRED_STAGING_SECRETS.delivery.includes(obsolete), false, obsolete);
  assert.match(FEATURE_FLAG_ACTIVATION_POLICIES.delivery.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED.prohibitedReason, /private Client service binding/);
  assert.deepEqual(STAGING_INVENTORY["ops-sync"].services, [
    { binding: "CLIENT_PORTAL_PROJECTION_INGRESS", service: "ledgetop-clients-staging", entrypoint: "OpsSyncPortalProjectionIngress" },
    { binding: "OPERATIONS_DELIVERY_INTENT_INGRESS", service: "ledgetop-ops-staging", entrypoint: "ProjectAlphaDeliveryIntentIngress" },
  ]);
  assert.equal(STAGING_INVENTORY.delivery.workflows.find(({ binding }) => binding === "BULK_DOWNLOAD_WORKFLOW").limits.steps, 25000);
  assert.deepEqual(FEATURE_FLAG_ACTIVATION_POLICIES.delivery.CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED.gates, [
    "projectAlphaCatalogProjection", "projectAlphaPortalProjection", "nativePortalRequests",
  ]);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runbook = fs.readFileSync(path.join(root, "docs", "operations", "native-portal-requests-feedback.md"), "utf8").replace(/\s+/g, " ");
  for (const invariant of [
    "never resolved through the primary source as a fallback",
    "must never appear in legacy account administration",
    "This document intentionally contains no values",
    "CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED=false` and clear",
    "does not exclude storage-only accounts is not a safe rollback target",
  ]) assert(runbook.includes(invariant), invariant);

  const evidence = JSON.parse(fs.readFileSync(path.join(root, "docs", "staging", "release-evidence.json.example"), "utf8"));
  assert.deepEqual(evidence.migrations.delivery.expected, REQUIRED_STAGING_MIGRATIONS.delivery);
  assert.deepEqual(evidence.migrations.operations.expected, REQUIRED_STAGING_MIGRATIONS.operations);
  assert.equal(evidence.externalGates.nativePortalRequests.ready, false);
  assert.equal(evidence.externalGates.nativePortalFeedback.ready, false);
});
test("checked-in staging examples exactly match every approved deployment-critical inventory field", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const critical = ["name", "main", "compatibility_date", "compatibility_flags", "routes", "d1_databases", "r2_buckets", "workflows", "services", "ratelimits", "limits", "assets", "observability", "stream", "durable_objects", "exports", "containers"];
  for (const [app, example] of [["delivery", "delivery.wrangler.json.example"], ["operations", "operations.wrangler.json.example"], ["ops-sync", "ops-sync.wrangler.json.example"]]) {
    const config = JSON.parse(fs.readFileSync(path.join(root, "docs", "staging", example), "utf8"));
    assert.equal(Object.hasOwn(config, "secrets"), false, `${example} must remain valid Wrangler configuration`);
    for (const key of critical) {
      const expected = STAGING_INVENTORY[app][key];
      const actual = config[key] ?? (Array.isArray(expected) ? [] : undefined);
      assert.deepEqual(actual, expected, `${example}.${key}`);
    }
    for (const [key, expected] of Object.entries(STAGING_STATIC_VARS[app])) assert.equal(config.vars[key], expected, `${example}.vars.${key}`);
    assert.deepEqual(new Set(Object.keys(config.vars)), new Set(STAGING_ALLOWED_VAR_NAMES[app]), `${example}.vars`);
    for (const flag of REQUIRED_DISABLED_FEATURE_FLAGS[app]) assert.equal(config.vars[flag], "false", `${example}.${flag}`);
  }
  const secretManifest = JSON.parse(fs.readFileSync(path.join(root, "docs", "staging", "staging-secret-manifest.json"), "utf8"));
  assert.deepEqual(validateSecretManifest(secretManifest), []);
});

test("rejects missing renderer structure, observability drift, extra email bindings, and pseudo secret fields", () => {
  const operations = stagingConfig("operations");
  delete operations.durable_objects;
  operations.observability = { enabled: false };
  operations.vars.SMTP_NOTIFICATIONS_ENABLED = "true";
  operations.send_email.push({ name: "UNREVIEWED_EMAIL", allowed_sender_addresses: ["other@staging.example.test"] });
  operations.secrets = { required: [] };
  const errors = validateApp("operations", operations, productionFrom(stagingConfig("operations")));
  for (const expected of ["durable_objects", "observability", "SMTP_NOTIFICATIONS_ENABLED", "notification email binding", "release-only secret manifest"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});
