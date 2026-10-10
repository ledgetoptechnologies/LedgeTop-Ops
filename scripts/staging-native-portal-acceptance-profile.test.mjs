import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import {
  buildNativePortalAcceptanceConfigs,
  NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES,
  NATIVE_PORTAL_ACCEPTANCE_CONFIGS,
  NATIVE_PORTAL_ACCEPTANCE_GATES,
  NATIVE_PORTAL_ACCEPTANCE_PROFILE_NAME,
  run,
  validateNativePortalAcceptanceConfigs,
} from "./staging-native-portal-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clone = (value) => structuredClone(value);
const operationsWorkspacePage = "/administration/client-portal/operations-workspaces";
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
  const productionConfigs = Object.fromEntries(Object.entries(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)
    .map(([app, files]) => [app, JSON.parse(fs.readFileSync(path.join(root, files.production), "utf8"))]));
  return { sources, productionConfigs };
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-native-portal-acceptance-"));
  const { sources, productionConfigs } = pair();
  for (const [app, files] of Object.entries(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)) {
    fs.mkdirSync(path.dirname(path.join(base, files.source)), { recursive: true });
    fs.writeFileSync(path.join(base, files.source), `${JSON.stringify(sources[app], null, 2)}\n`);
    fs.writeFileSync(path.join(base, files.production), `${JSON.stringify(productionConfigs[app], null, 2)}\n`);
  }
  return { base, sources, productionConfigs };
}

test("builds the separately named three-gate native portal acceptance profile", () => {
  const { sources, productionConfigs } = pair();
  const candidates = buildNativePortalAcceptanceConfigs(sources, productionConfigs);
  assert.equal(NATIVE_PORTAL_ACCEPTANCE_PROFILE_NAME, "native-recipient-service-home-acceptance");
  assert.deepEqual(new Set(NATIVE_PORTAL_ACCEPTANCE_GATES), new Set([
    "CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED",
    "CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED",
    "CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED",
  ]));
  assert.deepEqual(validateNativePortalAcceptanceConfigs(sources, candidates, productionConfigs), []);
  assert.deepEqual(candidates.operations.assets.run_worker_first, sources.operations.assets.run_worker_first);
  assert.equal(candidates.operations.assets.run_worker_first.filter((route) => route === operationsWorkspacePage).length, 1);
  for (const app of Object.keys(candidates)) {
    const comparable = clone(candidates[app]);
    for (const [flag, value] of Object.entries(NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES[app])) {
      assert.equal(sources[app].vars[flag], "false", `${app}.${flag} source`);
      assert.equal(productionConfigs[app].vars[flag], "false", `${app}.${flag} production`);
      assert.equal(comparable.vars[flag], value, `${app}.${flag} candidate`);
      comparable.vars[flag] = sources[app].vars[flag];
    }
    assert.deepEqual(comparable, sources[app], `${app} must differ only by the acceptance gates`);
  }
});

test("rejects partial selection, unrelated drift, and any legacy-fallback-capable candidate", () => {
  const { sources, productionConfigs } = pair();
  const candidates = buildNativePortalAcceptanceConfigs(sources, productionConfigs);
  candidates.delivery.vars.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED = "false";
  candidates.operations.vars.CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED = "true";
  const errors = validateNativePortalAcceptanceConfigs(sources, candidates, productionConfigs);
  assert(errors.some((error) => error.includes("outside the three-gate activation window")), errors.join(" | "));
  assert(errors.some((error) => error.includes("legacy PA fallback is forbidden")), errors.join(" | "));
  assert(errors.some((error) => error.includes("CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED=true")), errors.join(" | "));
});

test("refuses active base or production gates, missing native prerequisites, and a mismatched RPC binding", () => {
  for (const mutate of [
    ({ sources }) => { sources.delivery.vars.CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED = "true"; },
    ({ productionConfigs }) => { productionConfigs.operations.vars.CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED = "true"; },
    ({ sources }) => { sources.operations.vars.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED = "false"; },
    ({ sources }) => { sources.delivery.services.find(({ binding }) => binding === "CLIENT_PORTAL_SERVICE_METADATA_READER").service = "ledgetop-ops"; },
  ]) {
    const state = pair();
    mutate(state);
    assert.throws(() => buildNativePortalAcceptanceConfigs(state.sources, state.productionConfigs),
      /explicitly set|default staging config|production config|native portal acceptance source|metadata reader/);
  }
});

test("writes ignored candidates without changing the default-off sources and checks idempotently", () => {
  const { base } = fixture();
  const sourceBytes = Object.fromEntries(Object.entries(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)
    .map(([app, files]) => [app, fs.readFileSync(path.join(base, files.source), "utf8")]));
  const written = run(["--write"], base);
  assert.deepEqual(written, Object.values(NATIVE_PORTAL_ACCEPTANCE_CONFIGS).map(({ output }) => output));
  run(["--write"], base);
  run(["--check"], base);
  for (const [app, files] of Object.entries(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)) {
    assert.equal(fs.readFileSync(path.join(base, files.source), "utf8"), sourceBytes[app]);
    assert.equal(fs.existsSync(path.join(base, files.output)), true);
  }
});

test("refuses stale existing candidates instead of overwriting them", () => {
  const { base } = fixture();
  run(["--write"], base);
  const output = path.join(base, NATIVE_PORTAL_ACCEPTANCE_CONFIGS.operations.output);
  const stale = JSON.parse(fs.readFileSync(output, "utf8"));
  stale.vars.CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED = "false";
  fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`);
  const before = fs.readFileSync(output, "utf8");
  assert.throws(() => run(["--write"], base), /invalid or stale/);
  assert.equal(fs.readFileSync(output, "utf8"), before);
});
