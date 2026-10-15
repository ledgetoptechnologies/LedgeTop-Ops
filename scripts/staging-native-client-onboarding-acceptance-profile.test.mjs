import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderConfigs } from "./staging-config-scaffold.mjs";
import {
  buildNativeClientOnboardingAcceptanceConfigs,
  NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_ACTIVATION_VALUES,
  NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS,
  NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_GATES,
  NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_PROFILE_NAME,
  NATIVE_CLIENT_ONBOARDING_ADMIN_ORIGIN,
  run,
  validateNativeClientOnboardingAcceptanceConfigs,
} from "./staging-native-client-onboarding-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clone = value => structuredClone(value);
const values = Object.freeze({
  DELIVERY_STAGING_ACCESS_AUD: "a".repeat(64),
  OPERATIONS_STAGING_ACCESS_AUD: "b".repeat(64),
  PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD: "c".repeat(64),
  DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "d".repeat(64),
  STAGING_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging",
  STAGING_PROJECT_ALPHA_HTTPS_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
  CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.client-staging",
  OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.operations-staging",
  MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false",
  STAGING_EMAIL_DOMAIN: "staging.example.test",
  STAGING_TRIAGE_EMAIL: "triage@staging.example.test",
  STAGING_ACCESS_GROUP_ID: "11111111-1111-4111-8111-111111111111",
  STAGING_ACCESS_GROUP_NAME: "LTDS staging operators",
});

function pair() {
  const rendered = renderConfigs(root, values);
  const sources = { delivery: rendered.delivery, operations: rendered.operations };
  const productionConfigs = Object.fromEntries(
    Object.entries(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS).map(([app, files]) => [
      app, JSON.parse(fs.readFileSync(path.join(root, files.production), "utf8")),
    ]),
  );
  return { sources, productionConfigs };
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-native-client-onboarding-"));
  const { sources, productionConfigs } = pair();
  for (const [app, files] of Object.entries(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS)) {
    fs.mkdirSync(path.dirname(path.join(base, files.source)), { recursive: true });
    fs.writeFileSync(path.join(base, files.source), `${JSON.stringify(sources[app], null, 2)}\n`);
    fs.writeFileSync(path.join(base, files.production), `${JSON.stringify(productionConfigs[app], null, 2)}\n`);
  }
  return { base, sources, productionConfigs };
}

test("builds only the bounded native client onboarding activation window", () => {
  const { sources, productionConfigs } = pair();
  const before = clone({ sources, productionConfigs });
  const candidates = buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs);

  assert.equal(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_PROFILE_NAME,
    "native-client-onboarding-acceptance");
  assert.equal(NATIVE_CLIENT_ONBOARDING_ADMIN_ORIGIN,
    "https://ops-staging.ledgetopdroneservices.com");
  assert.deepEqual(new Set(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_GATES), new Set([
    "CLIENT_ONBOARDING_ADMIN_ENABLED", "CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED",
  ]));
  assert.deepEqual(validateNativeClientOnboardingAcceptanceConfigs(
    sources, candidates, productionConfigs,
  ), []);
  assert.deepEqual({ sources, productionConfigs }, before);

  for (const app of Object.keys(candidates)) {
    const restored = clone(candidates[app]);
    for (const [name, value] of Object.entries(
      NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_ACTIVATION_VALUES[app],
    )) {
      assert.equal(candidates[app].vars[name], value, `${app}.${name}`);
      restored.vars[name] = sources[app].vars[name];
    }
    assert.deepEqual(restored, sources[app], `${app} differs only by onboarding activation`);
  }

  for (const [app, flags] of Object.entries({
    delivery: [
      "CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED",
      "CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED",
      "CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED",
      "CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED",
      "CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED",
    ],
    operations: [
      "OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED",
      "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED",
      "CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED",
      "CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED",
      "CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED",
      "OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED",
    ],
  })) {
    for (const flag of flags) {
      assert.equal(candidates[app].vars[flag], sources[app].vars[flag], `${app}.${flag}`);
    }
  }
});

test("rejects every partial placement and every incorrect administrator origin", () => {
  const mutations = [
    candidates => { candidates.delivery.vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = "false"; },
    candidates => { candidates.operations.vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = "false"; },
    candidates => { candidates.operations.vars.CLIENT_ONBOARDING_ADMIN_ENABLED = "false"; },
    candidates => { candidates.operations.vars.CLIENT_ONBOARDING_ADMIN_ORIGIN = ""; },
    candidates => { candidates.operations.vars.CLIENT_ONBOARDING_ADMIN_ORIGIN = "https://client-staging.ledgetopdroneservices.com"; },
    candidates => { candidates.operations.vars.CLIENT_ONBOARDING_ADMIN_ORIGIN = "http://ops-staging.ledgetopdroneservices.com"; },
    candidates => { candidates.operations.vars.CLIENT_ONBOARDING_ADMIN_ORIGIN = `${NATIVE_CLIENT_ONBOARDING_ADMIN_ORIGIN}/path`; },
    candidates => { candidates.operations.vars.CLIENT_ONBOARDING_ADMIN_ORIGIN = `${NATIVE_CLIENT_ONBOARDING_ADMIN_ORIGIN}?query=1`; },
    candidates => { candidates.operations.vars.CLIENT_ONBOARDING_ADMIN_ORIGIN = "https://user@ops-staging.ledgetopdroneservices.com"; },
    candidates => { candidates.operations.vars.CLIENT_ONBOARDING_ADMIN_ORIGIN = `${NATIVE_CLIENT_ONBOARDING_ADMIN_ORIGIN}:8443`; },
  ];
  for (const mutate of mutations) {
    const { sources, productionConfigs } = pair();
    const candidates = buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs);
    mutate(candidates);
    const errors = validateNativeClientOnboardingAcceptanceConfigs(
      sources, candidates, productionConfigs,
    );
    assert(errors.some(error => error.includes("outside the bounded onboarding activation window")),
      errors.join(" | "));
  }
});

test("rejects active source or production gates and populated disabled origins", () => {
  const mutations = [
    state => { state.sources.delivery.vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = "true"; },
    state => { state.sources.operations.vars.CLIENT_ONBOARDING_ADMIN_ENABLED = "true"; },
    state => { state.sources.operations.vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = "true"; },
    state => { state.productionConfigs.delivery.vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = "true"; },
    state => { state.productionConfigs.operations.vars.CLIENT_ONBOARDING_ADMIN_ENABLED = "true"; },
    state => { state.productionConfigs.operations.vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = "true"; },
    state => { state.sources.operations.vars.CLIENT_ONBOARDING_ADMIN_ORIGIN = NATIVE_CLIENT_ONBOARDING_ADMIN_ORIGIN; },
    state => { state.productionConfigs.operations.vars.CLIENT_ONBOARDING_ADMIN_ORIGIN = "https://ops.example.com"; },
  ];
  for (const mutate of mutations) {
    const state = pair();
    mutate(state);
    assert.throws(() => buildNativeClientOnboardingAcceptanceConfigs(
      state.sources, state.productionConfigs,
    ), /default staging config|production config|origin must remain empty|origin blank/);
  }
});

test("rejects missing, duplicate, and wrong private bridge bindings", () => {
  const mutations = [
    sources => { sources.delivery.services = sources.delivery.services.filter(
      row => row.binding !== "CLIENT_ONBOARDING_RECIPIENT_BRIDGE"); },
    sources => { sources.delivery.services.push(clone(sources.delivery.services.find(
      row => row.binding === "CLIENT_ONBOARDING_RECIPIENT_BRIDGE"))); },
    sources => { sources.delivery.services.find(
      row => row.binding === "CLIENT_ONBOARDING_RECIPIENT_BRIDGE").service = "ledgetop-ops"; },
    sources => { sources.delivery.services.find(
      row => row.binding === "CLIENT_ONBOARDING_RECIPIENT_BRIDGE").entrypoint = "DefaultEntrypoint"; },
  ];
  for (const mutate of mutations) {
    const { sources, productionConfigs } = pair();
    mutate(sources);
    assert.throws(() => buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs),
      /private Operations staging bridge|services/);
  }
});

test("rejects missing or changed limiter, Worker-first routes, staging Worker, and database", () => {
  const mutations = [
    sources => { sources.delivery.ratelimits = sources.delivery.ratelimits.filter(
      row => row.name !== "PUBLIC_SESSION_RATE_LIMITER"); },
    sources => { sources.delivery.ratelimits.push(clone(sources.delivery.ratelimits.find(
      row => row.name === "PUBLIC_SESSION_RATE_LIMITER"))); },
    sources => { sources.delivery.ratelimits.find(
      row => row.name === "PUBLIC_SESSION_RATE_LIMITER").simple.limit = 21; },
    sources => { sources.delivery.assets.run_worker_first = sources.delivery.assets.run_worker_first.filter(
      route => route !== "/api/*"); },
    sources => { sources.delivery.assets.run_worker_first = sources.delivery.assets.run_worker_first.filter(
      route => route !== "/onboarding/*"); },
    sources => { sources.operations.main = "src/worker/index.ts"; },
    sources => { sources.operations.name = "ledgetop-ops"; },
    sources => { sources.operations.d1_databases.find(
      row => row.binding === "OPS_DB").database_name = "ltds-ops"; },
  ];
  for (const mutate of mutations) {
    const { sources, productionConfigs } = pair();
    mutate(sources);
    assert.throws(() => buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs),
      /rate limiter|Worker-first|isolated Operations staging Worker|staging database|staging inventory/);
  }
});

test("rejects workspace, recipient, resource, and arbitrary candidate drift", () => {
  const mutations = [
    candidates => { candidates.delivery.vars.CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED = "true"; },
    candidates => { candidates.operations.vars.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED = "true"; },
    candidates => { candidates.delivery.vars.CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED = "true"; },
    candidates => { candidates.operations.vars.CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED = "true"; },
    candidates => { candidates.operations.vars.CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED = "false"; },
    candidates => { candidates.delivery.d1_databases[0].database_id = "production-db"; },
    candidates => { candidates.delivery.routes = []; },
    candidates => { candidates.operations.vars.UNRELATED_FLAG = "true"; },
  ];
  for (const mutate of mutations) {
    const { sources, productionConfigs } = pair();
    const candidates = buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs);
    mutate(candidates);
    const errors = validateNativeClientOnboardingAcceptanceConfigs(
      sources, candidates, productionConfigs,
    );
    assert(errors.some(error => error.includes("outside the bounded onboarding activation window")),
      errors.join(" | "));
  }
});

test("requires exactly the Client and Operations candidate pair", () => {
  const { sources, productionConfigs } = pair();
  const missing = buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs);
  delete missing.delivery;
  assert(validateNativeClientOnboardingAcceptanceConfigs(sources, missing, productionConfigs)
    .some(error => error.includes("exactly Client and Operations")));
  const extra = buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs);
  extra["ops-sync"] = {};
  assert(validateNativeClientOnboardingAcceptanceConfigs(sources, extra, productionConfigs)
    .some(error => error.includes("exactly Client and Operations")));
});

test("writes ignored candidates idempotently without changing source or production", () => {
  const { base } = fixture();
  const originals = Object.fromEntries(Object.entries(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS)
    .flatMap(([app, files]) => [
      [`${app}:source`, fs.readFileSync(path.join(base, files.source), "utf8")],
      [`${app}:production`, fs.readFileSync(path.join(base, files.production), "utf8")],
    ]));
  const written = run(["--write"], base);
  assert.deepEqual(written,
    Object.values(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS).map(({ output }) => output));
  run(["--write"], base);
  run(["--check"], base);
  for (const [app, files] of Object.entries(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS)) {
    assert.equal(fs.readFileSync(path.join(base, files.source), "utf8"), originals[`${app}:source`]);
    assert.equal(fs.readFileSync(path.join(base, files.production), "utf8"), originals[`${app}:production`]);
    assert.equal(fs.existsSync(path.join(base, files.output)), true);
  }
});

test("check rejects missing output and write refuses stale output without overwriting", () => {
  const missingFixture = fixture();
  assert.throws(() => run(["--check"], missingFixture.base), /missing; generate with --write/);

  const staleFixture = fixture();
  run(["--write"], staleFixture.base);
  const output = path.join(staleFixture.base,
    NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS.operations.output);
  const stale = JSON.parse(fs.readFileSync(output, "utf8"));
  stale.vars.CLIENT_ONBOARDING_ADMIN_ENABLED = "false";
  fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`);
  const before = fs.readFileSync(output, "utf8");
  assert.throws(() => run(["--write"], staleFixture.base), /invalid or stale/);
  assert.equal(fs.readFileSync(output, "utf8"), before);
});

test("CLI rejects unsupported arguments and missing default-off sources", () => {
  assert.throws(() => run([], root), /usage:/);
  assert.throws(() => run(["--deploy"], root), /usage:/);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-native-client-onboarding-missing-"));
  assert.throws(() => run(["--write"], base), /missing; render and validate default-off/);
});
