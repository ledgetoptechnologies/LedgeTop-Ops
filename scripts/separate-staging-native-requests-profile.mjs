/**
 * Source-only builder for a closed native-request preparation profile in the
 * separate Staging account. This does not enable browser exposure or runtime
 * acceptance. Secret values are never accepted by this module.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// The reviewed private Logs graph is the base, never an empty replacement.
// Pin canonical LF source bytes; drift requires a new composition review.
export const SEPARATE_STAGING_LOGS_BASE_SHA256 = "4d4adfd32adf6c45e34075f781b54fc02b745f8386ed273112f99177af374590";
function reviewedOperationsBase() {
  const source = readFileSync(new URL("../apps/operations/wrangler.logs-staging-account.jsonc", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  if (createHash("sha256").update(source).digest("hex") !== SEPARATE_STAGING_LOGS_BASE_SHA256) {
    throw new Error("reviewed separate-account Logs source profile changed; composition review required");
  }
  return JSON.parse(source);
}

export const SEPARATE_STAGING_NATIVE_REQUESTS_PROFILE = "separate-account-native-requests-v1";
export const SEPARATE_STAGING_NATIVE_REQUESTS_RUNTIME_READY = false;
export const CLOUDFLARE_FREE_WORKER_VARIABLE_LIMIT = 64;

export const SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY = Object.freeze({
  accountId: "df3f376bae6ee621f50cf972ebcc9484",
  workersSubdomain: "ledge-top-staging",
  teamDomain: "https://ledge-top-staging.cloudflareaccess.com",
  operations: Object.freeze({
    workerName: "ledge-top-ops-staging",
    databaseId: "a58ea102-f04d-417a-bfd1-b0654cfeb503",
    databaseName: "ledge-top-ops-staging",
    accessApplicationId: "37c5049c-a787-49cf-ac43-ba4d340bee70",
    accessAudience: "ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84",
  }),
  client: Object.freeze({
    workerName: "ledge-top-clients-staging",
    databaseId: "15d02028-8c52-40b2-9979-d67abf7d5bbf",
    databaseName: "ledge-top-portal-staging",
    accessApplicationId: "bba2498b-7576-4c4d-84e3-23a62d701778",
    accessAudience: "dd6be2a400a90ba47a09a692f491738f7fbad090a0240f5a8a0c175db9b36d44",
  }),
});

const originFor = worker => `https://${worker}.${SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.workersSubdomain}.workers.dev`;
export const SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS = Object.freeze({
  operations: originFor(SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.operations.workerName),
  client: originFor(SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.workerName),
});

export const SEPARATE_STAGING_NATIVE_REQUESTS_SECRET_NAMES = Object.freeze({
  client: Object.freeze([
    "CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_CSRF_SECRET",
  ]),
  operations: Object.freeze([
    "OPERATIONS_SESSION_SECRET",
  ]),
});

const CLIENT_VARS = Object.freeze({
  ENVIRONMENT: "staging",
  EXPECTED_HOST: new URL(SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.client).host,
  PUBLIC_BASE_URL: SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.client,
  CLIENT_PORTAL_ORIGIN: SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.client,
  CLIENT_PORTAL_ORIGINS: SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.client,
  CLIENT_PORTAL_ENABLED: "true",
  CLIENT_ACCESS_TEAM_DOMAIN: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.teamDomain,
  CLIENT_ACCESS_AUD: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.accessAudience,
  CLIENT_ACCESS_AUDS: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.accessAudience,
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_EXPECTED_HOST: new URL(SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.client).host,
  CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST: new URL(SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.client).host,
  CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "false",
  CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "false",
  CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED: "false",
  CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "false",
  CLIENT_PORTAL_REQUEST_V2_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: "false",
  CLIENT_PORTAL_OPS_INQUIRIES_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED: "false",
  CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_FINANCIAL_ENABLED: "false",
  CLIENT_VIEWER_ENABLED: "false",
  CLIENT_VIEWER_SHARES_ENABLED: "false",
  CLIENT_PORTAL_TEAM_ENABLED: "false",
  CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: "false",
  CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "false",
});

const OPERATIONS_VARS = Object.freeze({
  ENVIRONMENT: "staging",
  EXPECTED_HOST: new URL(SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.operations).host,
  PUBLIC_BASE_URL: SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.operations,
  OPERATIONS_ORIGINS: SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.operations,
  FLIGHT_LOGS_ENABLED: "false",
  DELIVERY_BASE_URL: SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.client,
  CLIENT_PORTAL_ORIGINS: SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS.client,
  TEAM_DOMAIN: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.teamDomain,
  OPERATIONS_AUD: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.operations.accessAudience,
  STAGING_NATIVE_REQUEST_PROFILE: SEPARATE_STAGING_NATIVE_REQUESTS_PROFILE,
  CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: "false",
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "false",
  CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "false",
  OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED: "false",
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED: "false",
  OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED: "false",
  CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED: "false",
});

const clientService = (binding, entrypoint) => Object.freeze({
  binding, service: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.operations.workerName, entrypoint,
});
const operationsService = (binding, entrypoint) => Object.freeze({
  binding, service: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.workerName, entrypoint,
});

function makeClientConfig() {
  return {
    "$schema": "node_modules/wrangler/config-schema.json",
    name: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.workerName,
    account_id: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.accountId,
    main: "src/worker/index.ts",
    compatibility_date: "2026-07-16",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    keep_vars: false,
    routes: [],
    assets: {
      binding: "ASSETS", directory: "./dist/client",
      not_found_handling: "single-page-application",
      run_worker_first: ["/", "/api/*", "/portal*", "/health"],
    },
    vars: { ...CLIENT_VARS },
    d1_databases: [{
      binding: "DELIVERY_DB",
      database_name: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.databaseName,
      database_id: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.databaseId,
      migrations_dir: "migrations",
    }],
    services: [
      clientService("CLIENT_PORTAL_SERVICE_METADATA_READER", "ClientPortalServiceMetadataReader"),
      clientService("OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT", "OperationsPortalNativeRecipientEnrollmentIngress"),
      clientService("OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES", "OperationsNativePrincipalInquiryIngress"),
    ],
  };
}

function makeOperationsConfig() {
  const base = reviewedOperationsBase();
  return {
    ...base,
    main: "src/worker/separate-staging-native-authority-entrypoint.ts",
    vars: { ...base.vars, ...OPERATIONS_VARS },
    services: [
      ...base.services,
      operationsService("OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY", "OperationsPortalNativeRecipientAuthorityIngress"),
      operationsService("OPERATIONS_PORTAL_WORKSPACE_PUBLICATION", "OperationsPortalWorkspacePublicationIngress"),
    ],
  };
}

function secretNamesInput(value) {
  if (value === undefined) return {
    client: [...SEPARATE_STAGING_NATIVE_REQUESTS_SECRET_NAMES.client],
    operations: [...SEPARATE_STAGING_NATIVE_REQUESTS_SECRET_NAMES.operations],
  };
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "client,operations") {
    throw new TypeError("reviewed secret-name metadata must have exactly client and operations arrays");
  }
  return { client: value.client, operations: value.operations };
}

export function buildSeparateStagingNativeRequestsProfile({ secretNames } = {}) {
  const names = secretNamesInput(secretNames);
  const configs = { client: makeClientConfig(), operations: makeOperationsConfig() };
  const profile = {
    schema: "ltt.separate-staging-native-requests-profile.v1",
    profile: SEPARATE_STAGING_NATIVE_REQUESTS_PROFILE,
    runtimeReady: false,
    runtimeAdmission: "not-admitted",
    accountId: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.accountId,
    workersSubdomain: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.workersSubdomain,
    origins: { ...SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS },
    accessApplications: {
      client: { id: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.accessApplicationId,
        audience: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.accessAudience },
      operations: { id: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.operations.accessApplicationId,
        audience: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.operations.accessAudience },
    },
    secretNames: { client: [...names.client], operations: [...names.operations] },
    variableCounts: {
      client: Object.keys(configs.client.vars).length + (Array.isArray(names.client) ? names.client.length : 0),
      operations: Object.keys(configs.operations.vars).length + (Array.isArray(names.operations) ? names.operations.length : 0),
    },
    configs,
  };
  const errors = validateSeparateStagingNativeRequestsProfile(profile);
  if (errors.length) throw new Error(errors.join("\n"));
  return profile;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

export function validateSeparateStagingNativeRequestsProfile(candidate) {
  const errors = [];
  if (!isPlainObject(candidate)) return ["profile must be a plain object"];
  if (candidate.schema !== "ltt.separate-staging-native-requests-profile.v1"
      || candidate.profile !== SEPARATE_STAGING_NATIVE_REQUESTS_PROFILE
      || candidate.runtimeReady !== false || candidate.runtimeAdmission !== "not-admitted") {
    errors.push("profile identity must remain a closed source-preparation profile with runtimeReady=false");
  }
  if (candidate.accountId !== SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.accountId
      || candidate.workersSubdomain !== SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.workersSubdomain) {
    errors.push("profile must pin the exact separate Staging account and workers.dev subdomain");
  }
  if (JSON.stringify(candidate.origins) !== JSON.stringify(SEPARATE_STAGING_NATIVE_REQUESTS_ORIGINS)) {
    errors.push("profile origins must exactly match the named Staging workers.dev origins");
  }
  const expectedAccessApplications = {
    client: { id: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.accessApplicationId,
      audience: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.client.accessAudience },
    operations: { id: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.operations.accessApplicationId,
      audience: SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.operations.accessAudience },
  };
  if (JSON.stringify(candidate.accessApplications) !== JSON.stringify(expectedAccessApplications)) {
    errors.push("profile Access application IDs and audiences must match the exact Staging readback metadata");
  }
  const topLevelKeys = ["schema", "profile", "runtimeReady", "runtimeAdmission", "accountId",
    "workersSubdomain", "origins", "accessApplications", "secretNames", "variableCounts", "configs"].sort();
  if (Object.keys(candidate).sort().join(",") !== topLevelKeys.join(",")) {
    errors.push("profile contains missing or unreviewed top-level fields");
  }
  const expected = { client: makeClientConfig(), operations: makeOperationsConfig() };
  if (!isPlainObject(candidate.configs) || Object.keys(candidate.configs).sort().join(",") !== "client,operations") {
    errors.push("profile must contain exactly Client and Operations configs");
  } else {
    for (const app of ["client", "operations"]) {
      const config = candidate.configs[app];
      if (!isPlainObject(config)) {
        errors.push(`${app} config must be a plain object`);
        continue;
      }
      if (JSON.stringify(config) !== JSON.stringify(expected[app])) {
        errors.push(`${app} config differs from the exact closed separate-account request profile`);
      }
      if (config.account_id !== SEPARATE_STAGING_NATIVE_REQUESTS_IDENTITY.accountId
          || config.workers_dev !== false || config.preview_urls !== false
          || !exactArray(config.routes, [])) {
        errors.push(`${app} config must remain unexposed with no routes, workers.dev, or preview URLs`);
      }
      for (const [name, value] of Object.entries(config.vars ?? {})) {
        if (name.endsWith("_ENABLED") && value !== "false" && name !== "CLIENT_PORTAL_ENABLED") {
          errors.push(`${app} gate ${name} must remain explicitly false in the preparation profile`);
        }
      }
      const secrets = candidate.secretNames?.[app];
      const allowedSecrets = SEPARATE_STAGING_NATIVE_REQUESTS_SECRET_NAMES[app];
      if (!exactArray(secrets, allowedSecrets)) errors.push(`${app} secret-name metadata must exactly match the minimal reviewed allowlist`);
      if (Array.isArray(secrets)) {
        if (new Set(secrets).size !== secrets.length) errors.push(`${app} secret-name metadata contains duplicates`);
        if (secrets.some(name => Object.hasOwn(config.vars ?? {}, name))) errors.push(`${app} secret names must not collide with text vars`);
      }
      const count = Object.keys(config.vars ?? {}).length + (Array.isArray(secrets) ? secrets.length : 0);
      if (!Number.isSafeInteger(count) || count > CLOUDFLARE_FREE_WORKER_VARIABLE_LIMIT) {
        errors.push(`${app} text vars plus secret names exceed the 64-item Free plan limit`);
      }
      if (candidate.variableCounts?.[app] !== count) errors.push(`${app} variable count metadata is inaccurate`);
    }
  }
  if (!isPlainObject(candidate.secretNames)
      || Object.keys(candidate.secretNames).sort().join(",") !== "client,operations") {
    errors.push("secret-name metadata must contain exactly Client and Operations lists");
  }
  if (!isPlainObject(candidate.variableCounts)
      || Object.keys(candidate.variableCounts).sort().join(",") !== "client,operations") {
    errors.push("variable count metadata must contain exactly Client and Operations counts");
  }
  return [...new Set(errors)];
}
