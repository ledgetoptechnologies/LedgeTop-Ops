import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateEvidence } from "./staging-evidence.mjs";
import { REQUIRED_STAGING_MIGRATIONS, REQUIRED_STAGING_SECRETS, STAGING_ACCESS_AUDS, STAGING_ACCOUNT_ID, STAGING_CLIENT_PORTAL, STAGING_HOSTS, STAGING_INVENTORY, STAGING_STATIC_VARS } from "./staging-requirements.mjs";

const now = Date.parse("2026-07-30T12:30:00Z");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
function fixture(base) {
  fs.mkdirSync(path.join(base, ".backups"), { recursive: true });
  const backupBody = "backup".repeat(60);
  fs.writeFileSync(path.join(base, ".backups", "delivery.sql"), backupBody);
  fs.writeFileSync(path.join(base, ".backups", "operations.sql"), backupBody);
  const backupTime = new Date("2026-07-30T12:00:00Z");
  fs.utimesSync(path.join(base, ".backups", "delivery.sql"), backupTime, backupTime);
  fs.utimesSync(path.join(base, ".backups", "operations.sql"), backupTime, backupTime);
  const configs = {
    delivery: { vars: { CLIENT_PORTAL_ENABLED: "false", CLIENT_PORTAL_ORIGIN: `https://${STAGING_HOSTS.client}`, PUBLIC_BASE_URL: `https://${STAGING_HOSTS.client}`, CLIENT_ACCESS_TEAM_DOMAIN: STAGING_STATIC_VARS.delivery.CLIENT_ACCESS_TEAM_DOMAIN, CLIENT_ACCESS_AUD: "a".repeat(64) } },
    operations: { vars: { PROJECT_ALPHA_BASE_URL: "https://project-alpha-staging.ledgetopdroneservices.com" } },
    "ops-sync": { vars: { CF_ACCESS_GROUP_ID: "staging-group-id", CF_ACCESS_GROUP_NAME: "LTDS Staging Testers" } },
  };
  const evidence = {
    releaseCommit: "a".repeat(40),
    configSha256: { delivery: "B".repeat(64), operations: "C".repeat(64), "ops-sync": "D".repeat(64) },
    credential: { valid: true, accountId: STAGING_ACCOUNT_ID, verifiedAt: "2026-07-30T12:00:00Z", confirmedPermissions: ["workers:write", "d1:write", "zone:read"] },
    branchBuilds: Object.fromEntries(["delivery", "operations", "ops-sync"].map((app) => [app, { productionBranch: "main", nonProductionBuildsEnabled: false, verifiedAt: "2026-07-30T12:00:00Z", evidenceRef: `ticket:${app}` }])),
    projectAlpha: { baseUrl: configs.operations.vars.PROJECT_ALPHA_BASE_URL, approvalRef: "ticket:pa", operationsReadCredentialReady: true, opsSyncServiceAuthReady: true, opsSyncAccessGroupReady: true, ed25519Ready: true, paymentBillingContractReady: true, authorizationBypassUsed: false },
    hosts: {
      delivery: { hostname: STAGING_HOSTS.delivery, dnsReady: true, accessReady: true },
      client: { hostname: STAGING_HOSTS.client, dnsReady: true, accessReady: true },
      operations: { hostname: STAGING_HOSTS.operations, dnsReady: true, accessReady: true },
      incoming: { hostname: STAGING_HOSTS.incoming, published: false },
      "ops-sync": { hostname: STAGING_HOSTS["ops-sync"], dnsReady: true, accessReady: true },
    },
    access: { audiences: { ...STAGING_ACCESS_AUDS }, groupId: "staging-group-id", groupName: "LTDS Staging Testers", testerEmail: "tester@example.com", testerActiveOperationsUser: true, approvalRef: "ticket:access" },
    clientPortal: {
      hostname: STAGING_CLIENT_PORTAL.hostname,
      origin: `https://${STAGING_CLIENT_PORTAL.hostname}`,
      enabled: false,
      teamDomain: STAGING_STATIC_VARS.delivery.CLIENT_ACCESS_TEAM_DOMAIN,
      applicationName: STAGING_CLIENT_PORTAL.applicationName,
      applicationId: "client-portal-app-id",
      audience: configs.delivery.vars.CLIENT_ACCESS_AUD,
      groupId: "client-portal-group-id",
      groupName: STAGING_CLIENT_PORTAL.groupName,
      protectedPaths: [...STAGING_CLIENT_PORTAL.protectedPaths],
      publicAccess: { applicationName: STAGING_CLIENT_PORTAL.publicApplicationName, applicationId: "client-public-app-id", policyId: "client-public-policy-id", decision: "bypass", include: "everyone", destination: STAGING_CLIENT_PORTAL.hostname, workerPublicPaths: [...STAGING_CLIENT_PORTAL.publicPaths] },
      approvalRef: "ticket:client-access",
      tests: { portalDisabled404: true, invalidAudienceDenied: true, unprovisionedIdentityDenied: true, crossAccountDenied: true, staffAclDenied: true, publicShareAnonymousReachable: true, publicSharePasswordRechecked: true, accessHeaderAbsentOnPublicShare: true, observedAt: "2026-07-30T12:00:00Z", evidenceRef: "ticket:client-e2e" },
    },
    migrations: {
      delivery: { expected: [...REQUIRED_STAGING_MIGRATIONS.delivery], appliedToStaging: true, listEvidenceRef: "ticket:migrations:delivery:list", applyEvidenceRef: "ticket:migrations:delivery:apply" },
      operations: { expected: [...REQUIRED_STAGING_MIGRATIONS.operations], appliedToStaging: true, listEvidenceRef: "ticket:migrations:operations:list", applyEvidenceRef: "ticket:migrations:operations:apply" },
      productionUnchanged: true,
    },
    secrets: Object.fromEntries(Object.entries(REQUIRED_STAGING_SECRETS).map(([app, names]) => [app, { names: [...names], verifiedAt: "2026-07-30T12:00:00Z", source: "reviewed-secrets-file", workerIsNew: true, remoteNames: [], evidenceRef: `ticket:secrets:${app}` }])),
    backups: {
      delivery: { path: ".backups/delivery.sql", databaseName: STAGING_INVENTORY.delivery.d1_databases[0].database_name, databaseId: STAGING_INVENTORY.delivery.d1_databases[0].database_id, generatedAt: "2026-07-30T12:00:00Z", bytes: backupBody.length, sha256: digest(backupBody), confirmedIntentionallyEmpty: false },
      operations: { path: ".backups/operations.sql", databaseName: STAGING_INVENTORY.operations.d1_databases[0].database_name, databaseId: STAGING_INVENTORY.operations.d1_databases[0].database_id, generatedAt: "2026-07-30T12:00:00Z", bytes: backupBody.length, sha256: digest(backupBody), confirmedIntentionallyEmpty: false },
    },
    approvals: { stagingDnsAndRoutes: true, stagingMigrations: true, stagingDeployment: true, productionChanges: false },
  };
  return { configs, evidence };
}

test("accepts complete, current, config-bound non-secret release evidence", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-"));
  const { configs, evidence } = fixture(base);
  assert.deepEqual(validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes: evidence.configSha256, now }), []);
});

test("fails closed on stale credential, config drift, branch builds, secrets, and backup identity", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-"));
  const { configs, evidence } = fixture(base);
  evidence.credential.verifiedAt = "2026-07-28T12:00:00Z";
  evidence.configSha256.delivery = "E".repeat(64);
  evidence.branchBuilds.delivery.nonProductionBuildsEnabled = true;
  evidence.secrets.operations.names = [];
  evidence.backups.delivery.databaseId = "wrong";
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes: { ...evidence.configSha256, delivery: "B".repeat(64) }, now });
  assert(errors.some((error) => error.includes("config SHA-256")));
  assert(errors.some((error) => error.includes("within 24 hours")));
  assert(errors.some((error) => error.includes("non-production builds")));
  assert(errors.some((error) => error.includes("secret names")));
  assert(errors.some((error) => error.includes("database identity")));
});

test("fails closed on client Access reuse, public-share bypass drift, and missing migrations", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-"));
  const { configs, evidence } = fixture(base);
  evidence.clientPortal.audience = STAGING_ACCESS_AUDS.delivery;
  evidence.clientPortal.publicAccess.workerPublicPaths = ["/"];
  evidence.migrations.delivery.expected = [];
  evidence.projectAlpha.authorizationBypassUsed = true;
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes: evidence.configSha256, now });
  for (const expected of ["must not reuse", "public paths", "migration set", "must not bypass"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});
