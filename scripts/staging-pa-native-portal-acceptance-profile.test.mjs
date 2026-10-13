import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { DIRECTORY_PROFILE_WRITE_ACCEPTANCE_VALUES } from "./staging-directory-writes-acceptance-profile.mjs";
import { NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES } from "./staging-native-portal-acceptance-profile.mjs";
import { WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES } from "./staging-native-workspace-acceptance-profile.mjs";
import { PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES } from "./staging-project-alpha-api-v2-acceptance-profile.mjs";
import { DIRECTORY_ADOPTION_ACCEPTANCE_VALUES } from "./staging-project-alpha-directory-adoption-acceptance-profile.mjs";
import { PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES } from "./staging-project-alpha-project-adoption-finalization-acceptance-profile.mjs";
import {
  buildPaNativePortalAcceptanceConfigs,
  PA_NATIVE_PORTAL_ACCEPTANCE_VALUES,
  validatePaNativePortalAcceptanceConfigs,
} from "./staging-pa-native-portal-acceptance-profile.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

function state() {
  // Clean CI checkouts intentionally do not contain concrete staging configs.
  // Render the tracked templates with synthetic, non-secret fixture values.
  const rendered = renderConfigs(root, {
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
  return {
    sources: {
      delivery: rendered.delivery,
      operations: rendered.operations,
    },
    production: {
      delivery: read("apps/client/wrangler.jsonc"),
      operations: read("apps/operations/wrangler.jsonc"),
    },
  };
}

const expectedValues = Object.freeze({
  delivery: Object.freeze({
    CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true",
    CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true",
    CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true",
  }),
  operations: Object.freeze({
    PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED: "true",
    PROJECT_ALPHA_API_V2_SYNC_ENABLED: "true",
    PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED: "true",
    PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED: "true",
    PROJECT_ALPHA_PROJECT_BINDING_REVISION_REFRESH_ENABLED: "true",
    PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED: "true",
    PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED: "true",
    NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: "true",
    PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED: "true",
    OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED: "true",
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED: "true",
    CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true",
    CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true",
  }),
});

test("composes exactly the PA, interactive Directory, native workspace, and native portal deltas", () => {
  const current = state();
  const untouched = structuredClone(current);
  assert.deepEqual(PA_NATIVE_PORTAL_ACCEPTANCE_VALUES, expectedValues);
  const candidates = buildPaNativePortalAcceptanceConfigs(current.sources, current.production);
  assert.deepEqual(current, untouched);
  for (const app of ["delivery", "operations"]) {
    const changed = Object.fromEntries(Object.keys(expectedValues[app]).map(name => [name, candidates[app].vars[name]]));
    assert.deepEqual(changed, expectedValues[app]);
    const reverted = structuredClone(candidates[app]);
    for (const name of Object.keys(expectedValues[app])) reverted.vars[name] = current.sources[app].vars[name];
    assert.deepEqual(reverted, current.sources[app]);
  }
  assert.deepEqual(validatePaNativePortalAcceptanceConfigs(current.sources, candidates, current.production), []);
});

test("preserves Viewer gates, identity, bindings, resources, names, and scheduler drain exactly", () => {
  const current = state();
  const candidates = buildPaNativePortalAcceptanceConfigs(current.sources, current.production);
  for (const app of ["delivery", "operations"]) {
    const viewerNames = Object.keys(current.sources[app].vars).filter(name => name.includes("VIEWER"));
    for (const name of viewerNames) assert.equal(candidates[app].vars[name], current.sources[app].vars[name], `${app}.${name}`);
    for (const key of ["name", "main", "routes", "assets", "d1_databases", "r2_buckets", "services"])
      assert.deepEqual(candidates[app][key], current.sources[app][key], `${app}.${key}`);
  }
  assert.equal(candidates.operations.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED, "false");
  const sourceText = fs.readFileSync(path.join(root, "scripts/staging-pa-native-portal-acceptance-profile.mjs"), "utf8");
  assert.doesNotMatch(sourceText, /viewer-acceptance|secretNames/i);
});

test("rejects missing, extra, gate, Viewer, unrelated, and resource candidate drift", () => {
  const mutations = [
    candidates => { delete candidates.delivery; },
    candidates => { candidates.viewer = {}; },
    candidates => { candidates.operations.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED = "false"; },
    candidates => { candidates.operations.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED = "true"; },
    candidates => { candidates.operations.vars.VIEWER_PUBLIC_SHARES_ENABLED = "true"; },
    candidates => { candidates.delivery.vars.UNRELATED = "true"; },
    candidates => { candidates.operations.services[0].service = "wrong-service"; },
    candidates => { candidates.delivery.d1_databases[0].database_id = "wrong-database"; },
  ];
  for (const mutate of mutations) {
    const current = state();
    const candidates = buildPaNativePortalAcceptanceConfigs(current.sources, current.production);
    mutate(candidates);
    assert.notDeepEqual(validatePaNativePortalAcceptanceConfigs(current.sources, candidates, current.production), []);
  }
});

test("requires every composed source and production gate to remain default-off", () => {
  for (const app of ["delivery", "operations"]) for (const flag of Object.keys(expectedValues[app])) {
    for (const side of ["sources", "production"]) {
      const current = state();
      current[side][app].vars[flag] = "true";
      assert.throws(() => buildPaNativePortalAcceptanceConfigs(current.sources, current.production),
        /false|default|source|production|approved staging value/, `${side}.${app}.${flag}`);
    }
  }
});

test("enforces exact Directory adoption and profile-write boundaries without scheduler activation", () => {
  assert.deepEqual(DIRECTORY_ADOPTION_ACCEPTANCE_VALUES, {
    PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED: "true",
    PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED: "true",
  });
  assert.deepEqual(DIRECTORY_PROFILE_WRITE_ACCEPTANCE_VALUES, {
    NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: "true",
  });
  const current = state();
  delete current.production.operations.vars.PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED;
  assert.doesNotThrow(() => buildPaNativePortalAcceptanceConfigs(current.sources, current.production));
  current.production.operations.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED = "true";
  assert.throws(() => buildPaNativePortalAcceptanceConfigs(current.sources, current.production),
    /NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED/);
});

test("fails closed when native constituent identity or required base gates drift", () => {
  const mutations = [
    current => { current.sources.operations.main = "src/worker/index.ts"; },
    current => { current.sources.operations.services.find(value =>
      value.binding === "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION").service = "wrong-client"; },
    current => { current.sources.delivery.services.find(value =>
      value.binding === "CLIENT_PORTAL_SERVICE_METADATA_READER").entrypoint = "WrongEntrypoint"; },
    current => { current.sources.delivery.vars.CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED = "false"; },
    current => { current.sources.operations.vars.CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED = "false"; },
  ];
  for (const mutate of mutations) {
    const current = state();
    mutate(current);
    assert.throws(() => buildPaNativePortalAcceptanceConfigs(current.sources, current.production));
  }
});

test("exports the exact union of constituent deltas without blanket activation", () => {
  assert.deepEqual(PA_NATIVE_PORTAL_ACCEPTANCE_VALUES.delivery, {
    ...WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES.delivery,
    ...NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES.delivery,
  });
  assert.deepEqual(PA_NATIVE_PORTAL_ACCEPTANCE_VALUES.operations, {
    ...PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES,
    ...DIRECTORY_ADOPTION_ACCEPTANCE_VALUES,
    ...DIRECTORY_PROFILE_WRITE_ACCEPTANCE_VALUES,
    ...PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES,
    ...WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES.operations,
    ...NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES.operations,
  });
  assert.equal(Object.keys(PA_NATIVE_PORTAL_ACCEPTANCE_VALUES.delivery).length, 3);
  assert.equal(Object.keys(PA_NATIVE_PORTAL_ACCEPTANCE_VALUES.operations).length, 13);
});
