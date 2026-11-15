import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildSeparateStagingNativeRequestsProfile,
  CLOUDFLARE_FREE_WORKER_VARIABLE_LIMIT,
  SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY,
  SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS,
  SEPARATE_STAGING_NATIVE_REQUESTS_PROFILE,
  SEPARATE_STAGING_NATIVE_REQUESTS_RUNTIME_READY,
  SEPARATE_STAGING_NATIVE_REQUESTS_SECRET_NAMES,
  validateSeparateStagingNativeRequestsProfile,
} from "./separate-staging-native-requests-profile.mjs";

test("builds an exact separate-account closed pair with bounded variable metadata", () => {
  const profile = buildSeparateStagingNativeRequestsProfile();
  assert.equal(profile.profile, SEPARATE_STAGING_NATIVE_REQUESTS_PROFILE);
  assert.equal(profile.runtimeReady, SEPARATE_STAGING_NATIVE_REQUESTS_RUNTIME_READY);
  assert.equal(profile.runtimeAdmission, "not-admitted");
  assert.equal(profile.accountId, "df3f376bae6ee621f50cf972ebcc9484");
  assert.deepEqual(profile.origins, SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS);
  assert.equal(profile.configs.operations.name, SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.operations.workerName);
  assert.equal(profile.configs.client.name, SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.workerName);
  assert.equal(profile.configs.operations.d1_databases[0].database_id,
    SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.operations.databaseId);
  assert.equal(profile.configs.client.d1_databases[0].database_id,
    SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.databaseId);
  for (const app of ["client", "operations"]) {
    assert.equal(profile.configs[app].account_id, profile.accountId);
    assert.equal(profile.configs[app].workers_dev, false);
    assert.equal(profile.configs[app].preview_urls, false);
    assert.deepEqual(profile.configs[app].routes, []);
    assert(profile.variableCounts[app] <= CLOUDFLARE_FREE_WORKER_VARIABLE_LIMIT);
    for (const [name, value] of Object.entries(profile.configs[app].vars)) {
      if (name.endsWith("_ENABLED") && name !== "CLIENT_PORTAL_ENABLED") assert.equal(value, "false");
    }
  }
  assert.deepEqual(profile.secretNames, {
    client: [...SEPARATE_STAGING_NATIVE_REQUESTS_SECRET_NAMES.client],
    operations: [...SEPARATE_STAGING_NATIVE_REQUESTS_SECRET_NAMES.operations],
  });
  assert.deepEqual(validateSeparateStagingNativeRequestsProfile(profile), []);
});

test("preserves the reviewed Logs graph while adding request and native parent RPCs", () => {
  const { configs } = buildSeparateStagingNativeRequestsProfile();
  assert.deepEqual(configs.client.services, [
    { binding: "CLIENT_PORTAL_SERVICE_METADATA_READER", service: "ledge-top-ops-staging",
      entrypoint: "ClientPortalServiceMetadataReader" },
    { binding: "OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT", service: "ledge-top-ops-staging",
      entrypoint: "OperationsPortalNativeRecipientEnrollmentIngress" },
    { binding: "OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES", service: "ledge-top-ops-staging",
      entrypoint: "OperationsNativePrincipalInquiryIngress" },
  ]);
  assert.deepEqual(configs.operations.services, [
    { binding: "FLIGHT_LOGS", service: "ledge-top-logs-staging", entrypoint: "FlightLogsService" },
    { binding: "OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY", service: "ledge-top-clients-staging",
      entrypoint: "OperationsPortalNativeRecipientAuthorityIngress" },
    { binding: "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION", service: "ledge-top-clients-staging",
      entrypoint: "OperationsPortalWorkspacePublicationIngress" },
  ]);
  const base = JSON.parse(readFileSync(new URL("../apps/operations/wrangler.logs-staging-account.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(configs.operations.assets, base.assets);
  assert.deepEqual(configs.operations.d1_databases, base.d1_databases);
  assert.deepEqual(configs.operations.compatibility_flags, base.compatibility_flags);
  assert.equal(configs.operations.vars.FLIGHT_LOGS_ENABLED, "false");
  for (const path of ["/fleet", "/account", "/api/*", "/administration/client-portal/operations-recipients"]) {
    assert(configs.operations.assets.run_worker_first.includes(path));
  }
});

test("rejects exposure, routes, gate activation, binding drift, and production identity drift", () => {
  const mutations = [
    profile => { profile.configs.client.workers_dev = true; },
    profile => { profile.configs.operations.preview_urls = true; },
    profile => { profile.configs.client.routes = [{ pattern: "portal.example.test" }]; },
    profile => { profile.configs.client.vars.CLIENT_PORTAL_OPS_INQUIRIES_ENABLED = "true"; },
    profile => { profile.configs.client.vars.CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED = "true"; },
    profile => { profile.configs.operations.vars.OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED = "true"; },
    profile => { profile.configs.operations.vars.FLIGHT_LOGS_ENABLED = "true"; },
    profile => { profile.configs.operations.services = profile.configs.operations.services.filter(item => item.binding !== "FLIGHT_LOGS"); },
    profile => { profile.configs.operations.services[0].service = "ledge-top-logs"; },
    profile => { profile.configs.operations.assets.run_worker_first = ["/api/*"]; },
    profile => { profile.configs.operations.services[0].service = "ledgetop-clients"; },
    profile => { profile.configs.client.d1_databases[0].database_id = "7f40a7b7-c3ec-470e-a626-e798867f71f8"; },
    profile => { profile.accountId = "846c924bf17bf4f3dd15c97a4c5d1d51"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(buildSeparateStagingNativeRequestsProfile());
    mutate(candidate);
    assert.notDeepEqual(validateSeparateStagingNativeRequestsProfile(candidate), []);
  }
});

test("rejects secret values, duplicate/unknown secret names, collisions, and inaccurate counts", () => {
  assert.throws(() => buildSeparateStagingNativeRequestsProfile({
    secretNames: { client: ["CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_CSRF_SECRET", "secret-value"],
      operations: ["OPERATIONS_SESSION_SECRET"] },
  }));
  const checks = [
    profile => { profile.secretNames.client.push(profile.secretNames.client[0]); },
    profile => { profile.secretNames.operations.push("UNREVIEWED_SECRET"); },
    profile => { profile.secretNames.client = ["ENVIRONMENT"]; },
    profile => { profile.variableCounts.client += 1; },
    profile => { profile.extra = "not allowed"; },
  ];
  for (const mutate of checks) {
    const candidate = structuredClone(buildSeparateStagingNativeRequestsProfile());
    mutate(candidate);
    assert.notDeepEqual(validateSeparateStagingNativeRequestsProfile(candidate), []);
  }
});

test("rejects Worker configs over the Free plan's combined text and secret cap", () => {
  const candidate = structuredClone(buildSeparateStagingNativeRequestsProfile());
  for (let index = 0; index < 64; index += 1) candidate.configs.client.vars[`EXTRA_${index}`] = "false";
  assert(validateSeparateStagingNativeRequestsProfile(candidate).some(error => error.includes("64-item")));
});

test("profile origins remain preparation metadata and do not enable workers.dev", () => {
  const profile = buildSeparateStagingNativeRequestsProfile();
  assert.match(profile.origins.client, /^https:\/\/ledge-top-clients-staging\.ledge-top-staging\.workers\.dev$/);
  assert.match(profile.origins.operations, /^https:\/\/ledge-top-ops-staging\.ledge-top-staging\.workers\.dev$/);
  assert.equal(profile.configs.client.workers_dev, false);
  assert.equal(profile.configs.operations.workers_dev, false);
  assert.equal(profile.runtimeReady, false);
});

test("reports malformed vars shapes without throwing", () => {
  for (const malformed of [null, [], "not-a-vars-object"]) {
    const candidate = structuredClone(buildSeparateStagingNativeRequestsProfile());
    candidate.configs.client.vars = malformed;
    assert.doesNotThrow(() => validateSeparateStagingNativeRequestsProfile(candidate));
    assert.notDeepEqual(validateSeparateStagingNativeRequestsProfile(candidate), []);
  }
});
