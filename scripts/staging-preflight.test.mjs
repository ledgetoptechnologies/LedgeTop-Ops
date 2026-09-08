import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateApp, validateCrossApp, validateFiles, validateRequestAttachmentCors, validateSecretManifest } from "./staging-preflight.mjs";
import { APP_SOURCE_DIRS, FEATURE_FLAG_ACTIVATION_POLICIES, REQUIRED_DISABLED_FEATURE_FLAGS, REQUIRED_STAGING_MIGRATIONS, REQUIRED_STAGING_SECRETS, STAGING_ACCESS_AUDS, STAGING_ACCOUNT_ID, STAGING_ALLOWED_VAR_NAMES, STAGING_HOSTS, STAGING_INVENTORY, STAGING_REQUEST_ATTACHMENT_R2_CORS, STAGING_STATIC_VARS } from "./staging-requirements.mjs";

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
        POLICY_AUD: STAGING_ACCESS_AUDS.delivery,
        PUBLIC_BASE_URL: `https://${STAGING_HOSTS.delivery}`,
        CLIENT_PORTAL_ENABLED: "false",
        CLIENT_PORTAL_ORIGIN: `https://${STAGING_HOSTS.client}`,
        CLIENT_ACCESS_TEAM_DOMAIN: STAGING_STATIC_VARS.delivery.CLIENT_ACCESS_TEAM_DOMAIN,
        CLIENT_ACCESS_AUD: "a".repeat(64),
        PROJECT_ALPHA_CATALOG_ACCESS_AUD: "b".repeat(64),
        MAPBOX_PUBLIC_TOKEN: "pk.staging-client-mapbox-token",
        CLIENT_PORTAL_INVITATION_FROM: "portal@staging.example.test",
      } : {}),
      ...(app === "operations" ? {
        OPERATIONS_AUD: STAGING_ACCESS_AUDS.operations,
        PUBLIC_BASE_URL: `https://${inventory.routes[0].pattern}`,
        PROJECT_ALPHA_BASE_URL: STAGING_STATIC_VARS.operations.PROJECT_ALPHA_BASE_URL,
        INCOMING_EXPECTED_HOST: "incoming-staging.ledgetopdroneservices.com",
        INCOMING_BASE_URL: "https://incoming-staging.ledgetopdroneservices.com",
        MAPBOX_PUBLIC_TOKEN: "pk.staging-operations-mapbox-token",
        CLIENT_REQUEST_TRIAGE_TO: "triage@staging.example.test",
        NOTIFICATION_FROM: "delivery@staging.example.test",
      } : {}),
      ...(app === "ops-sync" ? { CF_ACCESS_AUD: STAGING_ACCESS_AUDS["ops-sync"], CF_ACCESS_GROUP_ID: "staging-group", CF_ACCESS_GROUP_NAME: "Staging Testers" } : {}),
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
  configs.delivery.services[1].entrypoint = "WrongViewerIssuer";
  configs["ops-sync"].services[0].entrypoint = "WrongPortalIngress";
  configs.delivery.vars.PROJECT_ALPHA_PORTAL_APPLICATION_KEY = "wrong-application-key";
  const errors = validateCrossApp(configs);
  assert(errors.some((error) => error.includes("DELIVERY_DB")));
  assert(errors.some((error) => error.includes("delegated-share signer")));
  assert(errors.some((error) => error.includes("Viewer session issuer")));
  assert(errors.some((error) => error.includes("portal projection ingress")));
  assert(errors.some((error) => error.includes("application key")));
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
  const corsDirectory = path.join(base, "docs", "staging");
  fs.mkdirSync(corsDirectory, { recursive: true });
  fs.writeFileSync(path.join(corsDirectory, "request-attachments-r2-cors.json"), JSON.stringify(STAGING_REQUEST_ATTACHMENT_R2_CORS));
  fs.writeFileSync(path.join(corsDirectory, "staging-secret-manifest.json"), JSON.stringify(REQUIRED_STAGING_SECRETS));
  assert.deepEqual(validateFiles(base), []);
  fs.renameSync(path.join(base, "apps", "client"), path.join(base, "apps", "delivery"));
  assert(validateFiles(base).some((error) => error.includes(path.join("apps", "client", "wrangler.staging.json"))));
});
test("fails closed on client portal activation, host namespace origins, and audience reuse", () => {
  const staging = stagingConfig("delivery");
  const production = productionFrom(staging);
  staging.vars.CLIENT_PORTAL_ENABLED = "true";
  staging.vars.CLIENT_PORTAL_ORIGIN = "https://other-staging.example";
  staging.vars.PUBLIC_SHARE_ORIGIN = `https://${STAGING_HOSTS.client}`;
  staging.vars.PUBLIC_BASE_URL = staging.vars.PUBLIC_SHARE_ORIGIN;
  staging.vars.CLIENT_ACCESS_AUD = STAGING_ACCESS_AUDS.operations;
  const errors = validateApp("delivery", staging, production);
  for (const expected of ["CLIENT_PORTAL_ENABLED", "authenticated client staging host", "anonymous delivery staging host", "must not reuse"]) {
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

test("pins the native portal, root-access, incoming-notification, pickup lifecycle, and 0200-0209 migration-first release contract", () => {
  assert.deepEqual(REQUIRED_STAGING_MIGRATIONS.delivery.slice(-26), [
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
  ]);
  assert.equal(REQUIRED_STAGING_MIGRATIONS.operations.at(-1), "0053_project_internal_notes.sql");
  assert(REQUIRED_DISABLED_FEATURE_FLAGS.delivery.includes("CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED"));
  assert(REQUIRED_DISABLED_FEATURE_FLAGS.delivery.includes("CLIENT_PORTAL_CONTENT_AUDIT_ENABLED"));
  assert.equal(STAGING_STATIC_VARS.delivery.CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.delivery.CLIENT_PORTAL_CONTENT_AUDIT_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.delivery.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.operations.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.delivery.PROJECT_ALPHA_PORTAL_SYNC_ENABLED, "true");
  assert.equal(STAGING_STATIC_VARS.delivery.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.delivery.PROJECT_ALPHA_PORTAL_APPLICATION_KEY, STAGING_STATIC_VARS["ops-sync"].APPLICATION_KEY);
  for (const obsolete of [
    "PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN", "PROJECT_ALPHA_PORTAL_ACCESS_AUD",
    "PROJECT_ALPHA_PORTAL_HMAC_KEY_ID", "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID",
  ]) assert.equal(STAGING_ALLOWED_VAR_NAMES.delivery.includes(obsolete), false, obsolete);
  for (const obsolete of ["PROJECT_ALPHA_PORTAL_HMAC_SECRET", "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET"])
    assert.equal(REQUIRED_STAGING_SECRETS.delivery.includes(obsolete), false, obsolete);
  assert.match(FEATURE_FLAG_ACTIVATION_POLICIES.delivery.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED.prohibitedReason, /private Client service binding/);
  assert.deepEqual(STAGING_INVENTORY["ops-sync"].services, [
    { binding: "CLIENT_PORTAL_PROJECTION_INGRESS", service: "ltds-delivery-staging", entrypoint: "OpsSyncPortalProjectionIngress" },
    { binding: "OPERATIONS_DELIVERY_INTENT_INGRESS", service: "ltds-ops-staging", entrypoint: "ProjectAlphaDeliveryIntentIngress" },
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
