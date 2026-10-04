import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { DIRECTORY_ADOPTION_ACCEPTANCE_VALUES } from "./staging-project-alpha-directory-adoption-acceptance-profile.mjs";
import { PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES } from "./staging-project-alpha-api-v2-acceptance-profile.mjs";
import { VIEWER_ACCEPTANCE_SECRET_NAMES, VIEWER_ACCEPTANCE_VALUES } from "./staging-project-alpha-api-v2-viewer-acceptance-profile.mjs";
import { WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES } from "./staging-native-workspace-acceptance-profile.mjs";
import { NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES } from "./staging-native-portal-acceptance-profile.mjs";
import { buildPairedEndToEndAcceptanceConfigs as build, mergeAcceptanceDeltas, validatePairedEndToEndAcceptanceConfigs as validate } from "./staging-paired-end-to-end-acceptance-profile.mjs";

const root = path.resolve(import.meta.dirname, "..");
const values = Object.freeze({ DELIVERY_STAGING_ACCESS_AUD: "a".repeat(64), OPERATIONS_STAGING_ACCESS_AUD: "b".repeat(64),
  PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD: "c".repeat(64), DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "d".repeat(64),
  STAGING_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging", STAGING_PROJECT_ALPHA_HTTPS_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
  CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.client-staging", OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.operations-staging",
  MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false", STAGING_EMAIL_DOMAIN: "staging.example.test", STAGING_TRIAGE_EMAIL: "triage@staging.example.test",
  STAGING_ACCESS_GROUP_ID: "11111111-1111-4111-8111-111111111111", STAGING_ACCESS_GROUP_NAME: "LTDS staging operators" });
function state() {
  const rendered = renderConfigs(root, values);
  return { sources: { delivery: rendered.delivery, operations: rendered.operations }, production: {
    delivery: JSON.parse(fs.readFileSync(path.join(root, "apps/client/wrangler.jsonc"), "utf8")),
    operations: JSON.parse(fs.readFileSync(path.join(root, "apps/operations/wrangler.jsonc"), "utf8")),
  }, secretNames: { names: [...VIEWER_ACCEPTANCE_SECRET_NAMES] } };
}
const deltas = (app) => ({
  ...(app === "operations" ? PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES : {}),
  ...(app === "operations" ? VIEWER_ACCEPTANCE_VALUES : {}),
  ...(app === "operations" ? DIRECTORY_ADOPTION_ACCEPTANCE_VALUES : {}),
  ...WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES[app],
  ...NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES[app],
});

test("builds the exact paired end-to-end window from one validated default-off baseline", () => {
  const current = state(), before = structuredClone(current);
  const candidates = build(current.sources, current.production, current.secretNames);
  assert.deepEqual(validate(current.sources, candidates, current.production, current.secretNames), []);
  assert.deepEqual(current, before);
  for (const app of ["delivery", "operations"])
    for (const [flag, value] of Object.entries(deltas(app))) assert.equal(candidates[app].vars[flag], value, `${app}.${flag}`);
  assert.equal(candidates.operations.vars.VIEWER_SERVICE_KEY_ID, "staging-v1");
  assert.equal(candidates.operations.vars.VIEWER_PUBLIC_SHARES_ENABLED, "false");
});

test("rejects every omitted composed gate", () => {
  for (const app of ["delivery", "operations"]) for (const flag of Object.keys(deltas(app))) {
    const current = state(), candidates = build(current.sources, current.production, current.secretNames);
    candidates[app].vars[flag] = "false";
    assert(validate(current.sources, candidates, current.production, current.secretNames)
      .some(error => error.includes(`${app} paired-end-to-end-staging-acceptance candidate drifted`)), `${app}.${flag}`);
  }
});

test("rejects partial pairs, Viewer drift, extra resources, and unrelated flags", () => {
  for (const mutate of [
    pair => { delete pair.delivery; },
    pair => { pair.extra = structuredClone(pair.delivery); },
    pair => { pair.operations.vars.VIEWER_SERVICE_KEY_ID = "other"; },
    pair => { pair.operations.d1_databases[0].database_id = "production-db"; },
    pair => { pair.delivery.vars.UNRELATED_AUTHORITY_ENABLED = "true"; },
  ]) {
    const current = state(), candidates = build(current.sources, current.production, current.secretNames); mutate(candidates);
    assert(validate(current.sources, candidates, current.production, current.secretNames).length > 0);
  }
});

test("rejects missing native prerequisites and production-enabled constituent gates", () => {
  for (const mutate of [
    current => { current.sources.operations.vars.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED = "false"; },
    current => { current.sources.operations.services.find(value => value.binding === "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION").service = "wrong"; },
    current => { current.production.delivery.vars.CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED = "true"; },
    current => { current.production.operations.vars.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED = "true"; },
  ]) {
    const current = state(); mutate(current);
    assert.throws(() => build(current.sources, current.production, current.secretNames));
  }
});

test("requires the approved names-only Viewer inventory", () => {
  const current = state();
  assert.throws(() => build(current.sources, current.production, { names: [] }), /secret names/);
  assert.throws(() => build(current.sources, current.production, { names: [...VIEWER_ACCEPTANCE_SECRET_NAMES], values: {} }), /secret values/);
});

test("rejects conflicting exported constituent deltas", () => {
  assert.deepEqual(mergeAcceptanceDeltas({ A: "true" }, { A: "true", B: "false" }), { A: "true", B: "false" });
  assert.throws(() => mergeAcceptanceDeltas({ A: "true" }, { A: "false" }), /profiles conflict on A/);
});
