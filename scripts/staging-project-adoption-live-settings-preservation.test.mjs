import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { buildProjectAdoptionFinalizationAcceptanceConfig } from "./staging-project-alpha-project-adoption-finalization-acceptance-profile.mjs";
import {
  buildProjectAdoptionLiveSettingsPreservedConfig as overlay,
  EXPECTED_STAGING_PROJECT_ADOPTION_OPERATIONS_VERSION_ID,
  PROJECT_ADOPTION_LIVE_BOOLEAN_NAMES,
  REVIEWED_PROJECT_ADOPTION_LIVE_BOOLEAN_VALUES,
  STAGING_PROJECT_ADOPTION_OPERATIONS_WORKER,
  validateProjectAdoptionLiveSettingsPreservedConfig as validateOverlay,
} from "./staging-project-adoption-live-settings-preservation.mjs";

const root = path.resolve(import.meta.dirname, "..");
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

function fixture() {
  const source = renderConfigs(root, values).operations;
  const production = JSON.parse(fs.readFileSync(path.join(root, "apps/operations/wrangler.jsonc"), "utf8"));
  const baseline = buildProjectAdoptionFinalizationAcceptanceConfig(source, production);
  return { source, production, baseline };
}

const snapshot = () => ({
  schemaVersion: 1,
  environment: "staging",
  worker: {
    name: STAGING_PROJECT_ADOPTION_OPERATIONS_WORKER,
    versionId: EXPECTED_STAGING_PROJECT_ADOPTION_OPERATIONS_VERSION_ID,
  },
  settings: { ...REVIEWED_PROJECT_ADOPTION_LIVE_BOOLEAN_VALUES },
});

const preflight = () => ({
  workerName: STAGING_PROJECT_ADOPTION_OPERATIONS_WORKER,
  versions: [{ versionId: EXPECTED_STAGING_PROJECT_ADOPTION_OPERATIONS_VERSION_ID, percentage: 100 }],
});

const build = (current, live = snapshot(), active = preflight()) =>
  overlay(current.source, current.baseline, current.production, live, active);
const validate = (current, candidate, live = snapshot(), active = preflight()) =>
  validateOverlay(current.source, current.baseline, candidate, current.production, live, active);

test("preserves exactly two reviewed booleans on the validated finalization candidate", () => {
  const current = fixture();
  const before = structuredClone(current.baseline);
  for (const name of PROJECT_ADOPTION_LIVE_BOOLEAN_NAMES) assert.equal(current.baseline.vars[name], "false");

  const candidate = build(current);
  assert.deepEqual(current.baseline, before);
  for (const name of PROJECT_ADOPTION_LIVE_BOOLEAN_NAMES) assert.equal(candidate.vars[name], "true");

  const reverted = structuredClone(candidate);
  for (const name of PROJECT_ADOPTION_LIVE_BOOLEAN_NAMES) reverted.vars[name] = "false";
  assert.deepEqual(reverted, current.baseline);
  assert.deepEqual(candidate.routes, current.baseline.routes);
  assert.deepEqual(candidate.assets, current.baseline.assets);
  assert.deepEqual(candidate.d1_databases, current.baseline.d1_databases);
  assert.equal(candidate.vars.VIEWER_PUBLIC_SHARES_ENABLED, current.baseline.vars.VIEWER_PUBLIC_SHARES_ENABLED);
  assert.deepEqual(validate(current, candidate), []);
});

test("requires an exact staging snapshot schema and exact string-true settings", () => {
  const current = fixture();
  for (const mutate of [
    value => { value.schemaVersion = 2; },
    value => { value.schemaVersion = "1"; },
    value => { value.environment = "production"; },
    value => { value.note = "unreviewed"; },
    value => { delete value.settings.CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED; },
    value => { value.settings.UNRELATED = "true"; },
    value => { value.settings.CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED = true; },
    value => { value.settings.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED = "false"; },
  ]) {
    const live = snapshot();
    mutate(live);
    assert.throws(() => build(current, live), /project-adoption-live-settings-preservation/);
  }
});

test("pins the reviewed staging Operations worker and version without automatic version acceptance", () => {
  const current = fixture();
  for (const mutate of [
    value => { value.worker.name = "ledgetop-ops"; },
    value => { value.worker.name = "ledgetop-clients-staging"; },
    value => { value.worker.versionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; },
    value => { value.worker.versionId = 712; },
    value => { value.worker.extra = "unreviewed"; },
  ]) {
    const live = snapshot();
    mutate(live);
    assert.throws(() => build(current, live), /exact reviewed active staging Operations version/);
  }
});

test("requires exactly one reviewed Operations version at numeric 100 percent", () => {
  const current = fixture();
  for (const mutate of [
    value => { value.workerName = "ledgetop-ops"; },
    value => { value.versions[0].versionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"; },
    value => { value.versions[0].percentage = 99; },
    value => { value.versions[0].percentage = "100"; },
    value => { value.versions.push({ versionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", percentage: 0 }); },
    value => { value.versions = []; },
    value => { value.activeVersionId = EXPECTED_STAGING_PROJECT_ADOPTION_OPERATIONS_VERSION_ID; },
    value => { value.versions[0].extra = true; },
  ]) {
    const active = preflight();
    mutate(active);
    assert.throws(() => build(current, snapshot(), active), /active-version preflight/);
  }
});

test("rejects an unvalidated or already widened finalization baseline", () => {
  const current = fixture();
  for (const mutate of [
    value => { value.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED = "false"; },
    value => { value.vars.CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED = "true"; },
    value => { value.vars.UNRELATED = "true"; },
    value => { value.routes[0].pattern = "wrong.example.test"; },
    value => { value.d1_databases[0].database_id = "wrong-database"; },
  ]) {
    const baseline = structuredClone(current.baseline);
    mutate(baseline);
    assert.throws(() => overlay(current.source, baseline, current.production, snapshot(), preflight()),
      /finalization baseline is not validated/);
  }
});

test("rejects every candidate delta outside the exact two-boolean overlay", () => {
  const current = fixture();
  for (const mutate of [
    value => { value.vars.CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED = "false"; },
    value => { value.vars.UNRELATED = "true"; },
    value => { value.vars.VIEWER_PUBLIC_SHARES_ENABLED = "true"; },
    value => { value.routes[0].pattern = "wrong.example.test"; },
    value => { value.d1_databases[0].database_id = "wrong-database"; },
    value => { value.r2_buckets[0].bucket_name = "wrong-bucket"; },
    value => { value.services[0].service = "wrong-service"; },
    value => { value.extra = {}; },
  ]) {
    const candidate = build(current);
    mutate(candidate);
    assert.deepEqual(validate(current, candidate), [
      "project-adoption live-settings candidate drifted outside the exact two-boolean preservation overlay",
    ]);
  }
});
