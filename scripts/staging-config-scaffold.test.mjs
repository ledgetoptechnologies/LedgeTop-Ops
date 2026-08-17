import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderConfigs, REQUIRED_STAGING_CONFIG_VALUES, validateRenderedConfigs, validateValues, writeRenderedConfigs } from "./staging-config-scaffold.mjs";

const root = path.resolve(import.meta.dirname, "..");
const values = Object.freeze({
  PROJECT_ALPHA_CATALOG_STAGING_ACCESS_AUD: "a".repeat(64),
  PROJECT_ALPHA_PORTAL_STAGING_ACCESS_AUD: "b".repeat(64),
  DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "c".repeat(64),
  CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.client-staging-test",
  OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.operations-staging-test",
  STAGING_EMAIL_DOMAIN: "staging.example.test",
  STAGING_TRIAGE_EMAIL: "triage@staging.example.test",
  STAGING_ACCESS_GROUP_ID: "staging-group-id",
  STAGING_ACCESS_GROUP_NAME: "LTDS Staging Testers",
});

test("renders all three exact staging configs without placeholders", () => {
  assert.deepEqual(validateValues(values), []);
  const configs = renderConfigs(root, values);
  assert.deepEqual(validateRenderedConfigs(root, configs), []);
  assert.equal(configs.delivery.vars.CLIENT_ACCESS_AUD, values.DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD);
  assert.equal(configs.operations.vars.CLIENT_REQUEST_TRIAGE_TO, values.STAGING_TRIAGE_EMAIL);
  assert.equal(configs["ops-sync"].vars.CF_ACCESS_GROUP_ID, values.STAGING_ACCESS_GROUP_ID);
  assert.equal(JSON.stringify(configs).includes("<"), false);
});

test("rejects missing, unexpected, duplicated, and malformed values", () => {
  assert.equal(new Set(REQUIRED_STAGING_CONFIG_VALUES).size, REQUIRED_STAGING_CONFIG_VALUES.length);
  const invalid = { ...values };
  delete invalid.STAGING_TRIAGE_EMAIL;
  invalid.UNKNOWN = "value";
  invalid.PROJECT_ALPHA_PORTAL_STAGING_ACCESS_AUD = invalid.PROJECT_ALPHA_CATALOG_STAGING_ACCESS_AUD;
  invalid.OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN = "secret-token";
  const errors = validateValues(invalid);
  for (const expected of ["STAGING_TRIAGE_EMAIL", "unexpected", "distinct", "public Mapbox"]) assert(errors.some((error) => error.includes(expected)), errors.join(" | "));
});

test("writes only absent ignored targets and refuses replacement", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-staging-scaffold-"));
  for (const directory of ["apps/client", "apps/operations", "apps/ops-sync"]) fs.mkdirSync(path.join(base, directory), { recursive: true });
  const configs = renderConfigs(root, values);
  const written = writeRenderedConfigs(base, configs);
  assert.deepEqual(written.map((file) => file.replaceAll("\\", "/")).sort(), ["apps/client/wrangler.staging.json", "apps/operations/wrangler.staging.json", "apps/ops-sync/wrangler.staging.json"].sort());
  for (const file of written) assert.equal(fs.existsSync(path.join(base, file)), true);
  assert.throws(() => writeRenderedConfigs(base, configs), /already exists/);
});
