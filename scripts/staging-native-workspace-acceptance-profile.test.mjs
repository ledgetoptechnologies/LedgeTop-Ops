import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { buildNativeWorkspaceAcceptanceConfigs as build, validateNativeWorkspaceAcceptanceConfigs as validate,
  WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES as gates } from "./staging-native-workspace-acceptance-profile.mjs";

const root = path.resolve(import.meta.dirname, "..");
function state() {
  const configs = renderConfigs(root, {
    DELIVERY_STAGING_ACCESS_AUD: "a".repeat(64), OPERATIONS_STAGING_ACCESS_AUD: "b".repeat(64),
    PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD: "c".repeat(64), DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "d".repeat(64),
    STAGING_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging", STAGING_PROJECT_ALPHA_HTTPS_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
    CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "", OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "",
    MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "true", STAGING_EMAIL_DOMAIN: "staging.example.test",
    STAGING_TRIAGE_EMAIL: "triage@staging.example.test", STAGING_ACCESS_GROUP_ID: "staging-group", STAGING_ACCESS_GROUP_NAME: "Staging testers",
  });
  return { sources: { delivery: configs.delivery, operations: configs.operations }, production: {
    delivery: JSON.parse(fs.readFileSync(path.join(root, "apps/client/wrangler.jsonc"), "utf8")),
    operations: JSON.parse(fs.readFileSync(path.join(root, "apps/operations/wrangler.jsonc"), "utf8")),
  } };
}

test("activates only the paired publication gates without changing sources or production", () => {
  const { sources, production } = state(), before = structuredClone({ sources, production });
  const candidates = build(sources, production);
  assert.deepEqual(validate(sources, candidates, production), []);
  assert.deepEqual({ sources, production }, before);
  for (const app of ["delivery", "operations"]) {
    const restored = structuredClone(candidates[app]);
    for (const flag of Object.keys(gates[app])) {
      assert.equal(restored.vars[flag], "true");
      restored.vars[flag] = "false";
    }
    assert.deepEqual(restored, sources[app]);
  }
});

test("rejects partial activation, recipient grants, resource and unrelated variable drift", () => {
  for (const mutate of [
    pair => { pair.delivery.vars.CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED = "false"; },
    pair => { pair.operations.vars.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED = "false"; },
    pair => { pair.delivery.vars.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED = "true"; },
    pair => { pair.operations.d1_databases[0].database_id = "production-db"; },
  ]) {
    const { sources, production } = state(), candidates = build(sources, production);
    mutate(candidates);
    assert(validate(sources, candidates, production).some(error => error.includes("three-gate window")));
  }
});

test("rejects active baseline/production gates and incorrect publication destination", () => {
  for (const mutate of [
    data => { data.sources.operations.vars.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED = "true"; },
    data => { data.production.delivery.vars.CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED = "true"; },
    data => { data.production.operations.vars.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED = "true"; },
    data => { data.sources.operations.services.find(value => value.binding === "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION").service = "ledgetop-clients"; },
    data => { data.sources.operations.main = "src/worker/index.ts"; },
  ]) {
    const data = state(); mutate(data);
    assert.throws(() => build(data.sources, data.production));
  }
});
