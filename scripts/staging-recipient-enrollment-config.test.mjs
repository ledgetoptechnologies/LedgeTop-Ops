import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRecipientEnrollmentConfigs,
  RECIPIENT_ENROLLMENT_ACTIVATION_VALUES,
  RECIPIENT_ENROLLMENT_CONFIGS,
  run,
  validateRecipientEnrollmentConfigs,
} from "./staging-recipient-enrollment-config.mjs";
import {
  STAGING_ACCOUNT_ID,
  STAGING_ALLOWED_VAR_NAMES,
  STAGING_HOSTS,
  STAGING_INVENTORY,
  STAGING_STATIC_VARS,
} from "./staging-requirements.mjs";

const clone = (value) => structuredClone(value);
const audiences = { delivery: "c".repeat(64), operations: "d".repeat(64) };

function sourceConfig(app) {
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
        CLIENT_ACCESS_AUD: "a".repeat(64),
        PROJECT_ALPHA_CATALOG_ACCESS_AUD: "b".repeat(64),
        MAPBOX_PUBLIC_TOKEN: "pk.staging-client-mapbox-token",
        MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false",
        CLIENT_PORTAL_INVITATION_FROM: "portal@staging.example.test",
      } : {
        OPERATIONS_AUD: audiences.operations,
        PUBLIC_BASE_URL: `https://${STAGING_HOSTS.operations}`,
        PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_SOURCE_ID: "project-alpha:staging",
        PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
        INCOMING_EXPECTED_HOST: STAGING_HOSTS.incoming,
        INCOMING_BASE_URL: `https://${STAGING_HOSTS.incoming}`,
        MAPBOX_PUBLIC_TOKEN: "pk.staging-operations-mapbox-token",
        MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false",
        CLIENT_REQUEST_TRIAGE_TO: "triage@staging.example.test",
        NOTIFICATION_FROM: "delivery@staging.example.test",
      }),
    },
    d1_databases: inventory.d1_databases,
    r2_buckets: inventory.r2_buckets,
    workflows: inventory.workflows,
    services: inventory.services,
    send_email: app === "delivery"
      ? [{ name: "CLIENT_PORTAL_INVITATION_EMAIL", allowed_sender_addresses: ["portal@staging.example.test"] }]
      : [{ name: "NOTIFICATION_EMAIL", allowed_sender_addresses: ["delivery@staging.example.test"] }],
    ratelimits: inventory.ratelimits,
    ...(inventory.queues.length || inventory.queueProducers?.length ? { queues: {
      consumers: inventory.queues, producers: inventory.queueProducers ?? [],
    } } : {}),
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
  production.vars.MAPBOX_PUBLIC_TOKEN = `pk.production-${production.name}`;
  production.d1_databases = production.d1_databases.map((item) => ({ ...item, database_id: `prod-${item.database_id}` }));
  production.r2_buckets = production.r2_buckets.map((item) => ({ ...item, bucket_name: `prod-${item.bucket_name}` }));
  production.workflows = production.workflows.map((item) => ({ ...item, name: `prod-${item.name}` }));
  production.services = production.services.map((item) => ({ ...item, service: item.service.replace("-staging", "") }));
  production.services = production.services.filter((item) => item.binding !== "VERIFIED_RECIPIENT_DELIVERY_AUTHORITY");
  production.ratelimits = production.ratelimits.map((item) => ({ ...item, namespace_id: `prod-${item.namespace_id}` }));
  if (production.queues) {
    production.queues.consumers = production.queues.consumers.map((item) => ({ ...item, queue: `prod-${item.queue}` }));
    production.queues.producers = production.queues.producers.map((item) => ({ ...item, queue: `prod-${item.queue}` }));
  }
  return production;
}

function pair() {
  const sources = { delivery: sourceConfig("delivery"), operations: sourceConfig("operations") };
  const productionConfigs = Object.fromEntries(Object.entries(sources).map(([app, config]) => [app, productionFrom(config)]));
  return { sources, productionConfigs };
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-recipient-enrollment-config-"));
  const { sources, productionConfigs } = pair();
  for (const [app, files] of Object.entries(RECIPIENT_ENROLLMENT_CONFIGS)) {
    fs.mkdirSync(path.dirname(path.join(base, files.source)), { recursive: true });
    fs.writeFileSync(path.join(base, files.source), `${JSON.stringify(sources[app], null, 2)}\n`);
    fs.writeFileSync(path.join(base, files.production), `${JSON.stringify(productionConfigs[app], null, 2)}\n`);
  }
  return { base, sources, productionConfigs };
}

test("builds only the explicit joined recipient-enrollment activation window", () => {
  const { sources, productionConfigs } = pair();
  const candidates = buildRecipientEnrollmentConfigs(sources, productionConfigs);
  assert.deepEqual(validateRecipientEnrollmentConfigs(sources, candidates, productionConfigs), []);
  for (const app of Object.keys(candidates)) {
    const comparable = clone(candidates[app]);
    for (const [flag, value] of Object.entries(RECIPIENT_ENROLLMENT_ACTIVATION_VALUES[app])) {
      assert.equal(comparable.vars[flag], value);
      comparable.vars[flag] = sources[app].vars[flag];
    }
    assert.deepEqual(comparable, sources[app]);
  }
  assert.equal(candidates.delivery.vars.CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED, "false");
  assert.equal(candidates.delivery.vars.CLIENT_AUTHORITY_WORKSPACE_BINDING_STATUS_ENABLED, "false");
  assert.equal(candidates.operations.vars.CLIENT_PORTAL_WORKSPACE_BINDING_ADMIN_ENABLED, "false");
  assert.equal(candidates.operations.vars.CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED, "false");
  assert.equal(candidates.operations.vars.CLIENT_PORTAL_WORKSPACE_BINDING_ADMIN_ORIGIN, "");
  assert.equal(candidates.delivery.vars.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED, "false");
  assert.equal(candidates.delivery.vars.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED, "false");
  assert.equal(candidates.operations.vars.VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_DISPATCH_ENABLED, "false");
  assert.equal(Object.hasOwn(candidates.delivery.vars, "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET"), false);
});

test("rejects production targets, source activation, audience collapse, and secret vars", () => {
  for (const mutate of [
    ({ sources }) => { sources.delivery.services.find(({ binding }) => binding === "CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE").service = "ledgetop-ops"; },
    ({ sources }) => { sources.delivery.vars.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_ENABLED = "true"; },
    ({ sources }) => { sources.operations.vars.OPERATIONS_AUD = sources.delivery.vars.CLIENT_ACCESS_AUD; },
    ({ sources }) => { sources.delivery.vars.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET = "must-not-be-here"; },
  ]) {
    const state = pair();
    mutate(state);
    assert.throws(() => buildRecipientEnrollmentConfigs(state.sources, state.productionConfigs), /service|explicitly set|audiences distinct|secret manifest/);
  }
});

test("rejects any candidate drift outside the known flag window", () => {
  const { sources, productionConfigs } = pair();
  const candidates = buildRecipientEnrollmentConfigs(sources, productionConfigs);
  candidates.operations.routes[0].pattern = "ops.ledgetopdroneservices.com";
  candidates.delivery.vars.CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED = "true";
  candidates.delivery.vars.CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET = "not-a-real-secret";
  const errors = validateRecipientEnrollmentConfigs(sources, candidates, productionConfigs);
  assert(errors.some((error) => error.includes("outside the explicit reviewed activation window")), errors.join(" | "));
  assert(errors.some((error) => error.includes("keep CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED=false")), errors.join(" | "));
  assert(errors.some((error) => error.includes("must not be written")), errors.join(" | "));
});

test("writes only ignored candidates, preserves source bytes, and checks idempotently", () => {
  const { base } = fixture();
  const sourceBytes = Object.fromEntries(Object.entries(RECIPIENT_ENROLLMENT_CONFIGS)
    .map(([app, files]) => [app, fs.readFileSync(path.join(base, files.source), "utf8")]));
  const written = run(["--write"], base);
  assert.deepEqual(written, Object.values(RECIPIENT_ENROLLMENT_CONFIGS).map(({ output }) => output));
  run(["--write"], base);
  run(["--check"], base);
  for (const [app, files] of Object.entries(RECIPIENT_ENROLLMENT_CONFIGS)) {
    assert.equal(fs.readFileSync(path.join(base, files.source), "utf8"), sourceBytes[app]);
    assert.equal(fs.existsSync(path.join(base, files.output)), true);
  }
});

test("refuses a stale existing candidate instead of overwriting it", () => {
  const { base } = fixture();
  run(["--write"], base);
  const output = path.join(base, RECIPIENT_ENROLLMENT_CONFIGS.delivery.output);
  const stale = JSON.parse(fs.readFileSync(output, "utf8"));
  stale.vars.CLIENT_PORTAL_ENABLED = "false";
  fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`);
  const before = fs.readFileSync(output, "utf8");
  assert.throws(() => run(["--write"], base), /invalid or stale/);
  assert.equal(fs.readFileSync(output, "utf8"), before);
});
