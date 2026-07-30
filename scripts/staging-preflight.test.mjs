import test from "node:test";
import assert from "node:assert/strict";
import { validateApp, validateCrossApp } from "./staging-preflight.mjs";

function config(name) {
  return {
    name, workers_dev: false, preview_urls: false,
    routes: [{ pattern: `${name}.test`, custom_domain: true }],
    vars: { ENVIRONMENT: name.endsWith("-staging") ? "staging" : "production", EXPECTED_HOST: `${name}.test`, POLICY_AUD: `${name}-aud`, CLOUD_TRANSFER_DROPBOX_ENABLED: "false", CLOUD_TRANSFER_GOOGLE_ENABLED: "false", CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED: "false", INCOMING_UPLOADS_ENABLED: "false" },
    d1_databases: [{ binding: "DELIVERY_DB", database_id: `${name}-db` }],
    r2_buckets: [{ binding: "DATA_BUCKET", bucket_name: `${name}-bucket` }],
    workflows: [{ binding: "JOB", name: `${name}-workflow` }],
    ratelimits: [{ name: "LIMIT", namespace_id: `${name}-limit` }],
  };
}

test("accepts isolated fail-closed staging resources", () => assert.deepEqual(validateApp("delivery", config("delivery-staging"), config("delivery")), []));
test("rejects production resource reuse and enabled optional capabilities", () => {
  const production = config("delivery"); const staging = config("delivery-staging");
  staging.d1_databases[0].database_id = production.d1_databases[0].database_id;
  staging.vars.CLOUD_TRANSFER_DROPBOX_ENABLED = "true";
  staging.vars.INCOMING_UPLOADS_ENABLED = "true";
  const errors = validateApp("delivery", staging, production);
  assert(errors.some((error) => error.includes("reuses production")));
  assert(errors.some((error) => error.includes("CLOUD_TRANSFER_DROPBOX_ENABLED=false")));
  assert(errors.some((error) => error.includes("INCOMING_UPLOADS_ENABLED=false")));
});
test("rejects unresolved placeholders", () => {
  const staging = config("delivery-staging"); staging.routes[0].pattern = "<STAGING_HOST>";
  assert(validateApp("delivery", staging, config("delivery")).some((error) => error.includes("placeholder")));
});
test("requires shared staging resources to agree", () => {
  const configs = { delivery: config("delivery-staging"), operations: config("operations-staging"), "ops-sync": config("ops-sync-staging") };
  configs.operations.d1_databases.push({ binding: "OPS_DB", database_id: "ops-db" });
  configs["ops-sync"].d1_databases = [{ binding: "OPS_DB", database_id: "other-db" }];
  assert(validateCrossApp(configs).some((error) => error.includes("ops-sync OPS_DB")));
});
