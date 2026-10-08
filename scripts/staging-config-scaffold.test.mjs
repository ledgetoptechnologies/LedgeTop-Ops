import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderConfigs, REQUIRED_STAGING_CONFIG_VALUES, validateRenderedConfigs, validateValues, writeRenderedConfigs } from "./staging-config-scaffold.mjs";

const root = path.resolve(import.meta.dirname, "..");
const operationsWorkspacePage = "/administration/client-portal/operations-workspaces";
const values = Object.freeze({
  DELIVERY_STAGING_ACCESS_AUD: "a".repeat(64),
  OPERATIONS_STAGING_ACCESS_AUD: "b".repeat(64),
  PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD: "c".repeat(64),
  DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "d".repeat(64),
  STAGING_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging",
  STAGING_PROJECT_ALPHA_HTTPS_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
  CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.client-staging-test",
  OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.operations-staging-test",
  MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false",
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
  assert.equal(configs.delivery.vars.CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED, "true");
  assert(configs.delivery.services.some(({ binding, entrypoint }) => binding === "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER"
    && entrypoint === "OperationsPortalNativeDeliveryAuthorizationReader"));
  assert.equal(configs.operations.vars.NATIVE_INTEGRATION_CONTROL_ENABLED, "false");
  assert.equal(configs.operations.vars.NATIVE_INTEGRATION_CONTROL_ORIGIN, "");
  assert.equal(configs.operations.vars.PROJECT_ALPHA_API_V2_SYNC_ENABLED, "false");
  assert.equal(configs.operations.vars.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED, "false");
  assert.equal(configs.operations.vars.PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED, "false");
  assert.equal(configs.operations.vars.CLIENT_REQUEST_TRIAGE_TO, values.STAGING_TRIAGE_EMAIL);
  assert.equal(configs.operations.main, "src/worker/staging-native-authority-entrypoint.ts");
  assert.deepEqual(configs.operations.triggers?.crons,
    JSON.parse(fs.readFileSync(path.join(root, "apps/operations/wrangler.jsonc"), "utf8")).triggers.crons,
    "staging must preserve every Operations cron handler, including API-v2, outbox, and reconciliation schedules");
  assert.equal(configs.operations.vars.OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED, "true");
  assert.equal(configs.operations.vars.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED, "false");
  assert.equal(configs.operations.vars.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED, "false");
  assert.deepEqual(configs.operations.assets.run_worker_first, [
    "/api/*", "/health", "/r/*",
    "/administration/client-portal/operations-recipients",
    "/administration/client-portal/operations-delivery-authority",
    operationsWorkspacePage,
  ]);
  assert.equal(configs.operations.assets.run_worker_first.filter((route) => route === operationsWorkspacePage).length, 1);
  assert(configs.operations.services.some(({ binding, service, entrypoint }) => binding === "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION"
    && service === "ledgetop-clients-staging" && entrypoint === "OperationsPortalWorkspacePublicationIngress"));
  assert(configs.operations.services.some(({ binding, entrypoint }) => binding === "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY"
    && entrypoint === "OperationsPortalNativeDeliveryAuthorityIngress"));
  assert.equal(configs["ops-sync"].vars.CF_ACCESS_GROUP_ID, values.STAGING_ACCESS_GROUP_ID);
  assert.equal(JSON.stringify(configs).includes("<"), false);
});

test("keeps native authority registration out of production Wrangler configs", () => {
  const client = JSON.parse(fs.readFileSync(path.join(root, "apps/client/wrangler.jsonc"), "utf8"));
  const operations = JSON.parse(fs.readFileSync(path.join(root, "apps/operations/wrangler.jsonc"), "utf8"));
  assert.equal(operations.assets?.run_worker_first?.includes(operationsWorkspacePage) ?? false, false,
    "operations production must not register the staging-only workspace owner page");
  for (const flag of ["CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED", "CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED"])
    assert.equal(Object.hasOwn(client.vars ?? {}, flag), false, `client production must omit ${flag}`);
  for (const flag of ["CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED", "CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED"])
    assert.equal(client.vars?.[flag], "false", `client production must preserve ${flag}=false`);
  for (const flag of ["CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED",
    "OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED", "OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED",
    "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED", "OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED",
    "OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED", "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED"])
    assert.equal(Object.hasOwn(operations.vars ?? {}, flag), false, `operations production must omit ${flag}`);
  for (const binding of ["OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT", "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER"])
    assert.equal((client.services ?? []).some(service => service.binding === binding), false, `client production must omit ${binding}`);
  for (const binding of ["OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY", "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY",
    "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION"])
    assert.equal((operations.services ?? []).some(service => service.binding === binding), false, `operations production must omit ${binding}`);
});

test("rejects missing, unexpected, duplicated, and malformed values", () => {
  assert.equal(new Set(REQUIRED_STAGING_CONFIG_VALUES).size, REQUIRED_STAGING_CONFIG_VALUES.length);
  const invalid = { ...values };
  delete invalid.STAGING_TRIAGE_EMAIL;
  invalid.UNKNOWN = "value";
  invalid.PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD = invalid.OPERATIONS_STAGING_ACCESS_AUD;
  invalid.OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN = "secret-token";
  const errors = validateValues(invalid);
  for (const expected of ["STAGING_TRIAGE_EMAIL", "unexpected", "distinct", "public Mapbox"]) assert(errors.some((error) => error.includes(expected)), errors.join(" | "));
});

test("allows an explicit Mapbox staging deferral only with both rendered tokens empty", () => {
  const deferred = {
    ...values,
    MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "true",
    CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "",
    OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "",
  };
  assert.deepEqual(validateValues(deferred), []);
  const configs = renderConfigs(root, deferred);
  assert.equal(configs.delivery.vars.MAPBOX_PUBLIC_TOKEN, "");
  assert.equal(configs.operations.vars.MAPBOX_PUBLIC_TOKEN, "");
  assert.equal(configs.delivery.vars.MAPBOX_STAGING_ACCEPTANCE_DEFERRED, "true");
  assert.equal(configs.operations.vars.MAPBOX_STAGING_ACCEPTANCE_DEFERRED, "true");
  assert.deepEqual(validateRenderedConfigs(root, configs), []);

  const mixed = { ...deferred, CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.must-not-be-rendered" };
  assert(validateValues(mixed).some((error) => error.includes("empty string")));
  const unflagged = { ...deferred, MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false" };
  assert(validateValues(unflagged).some((error) => error.includes("CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN is missing")));
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
