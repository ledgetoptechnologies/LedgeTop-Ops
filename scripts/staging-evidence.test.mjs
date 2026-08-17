import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateEvidence as validateEvidenceContract } from "./staging-evidence.mjs";
import { FEATURE_FLAG_ACTIVATION_POLICIES, PROJECT_ALPHA_STAGING, RELEASE_CANDIDATES, RELEASE_CONTRACT_FINALIZED, REQUIRED_DISABLED_FEATURE_FLAGS, REQUIRED_EXTERNAL_GATES, REQUIRED_EXTERNAL_GATE_PROOFS, REQUIRED_STAGING_MIGRATIONS, REQUIRED_STAGING_SECRETS, STAGING_ACCESS_AUDS, STAGING_ACCOUNT_ID, STAGING_CLIENT_PORTAL, STAGING_HOSTS, STAGING_INVENTORY, STAGING_STATIC_VARS, STAGING_VIEWER } from "./staging-requirements.mjs";

const now = Date.parse("2026-07-30T12:30:00Z");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
const validateEvidence = (evidence, options) => validateEvidenceContract(evidence, { ...options, allowUnfinalizedContractForTest: true });
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
    sourceControl: { pushed: true, remoteRef: "origin/codex/release", verifiedAt: "2026-07-30T12:00:00Z", evidenceRef: "ticket:source-control", runtimeCandidateCommit: RELEASE_CANDIDATES.operations, runtimeCandidatePushed: true, runtimeEvidenceRef: "ticket:source-control:runtime" },
    configSha256: { delivery: "B".repeat(64), operations: "C".repeat(64), "ops-sync": "D".repeat(64) },
    credential: { valid: true, accountId: STAGING_ACCOUNT_ID, verifiedAt: "2026-07-30T12:00:00Z", confirmedPermissions: ["workers:write", "d1:write", "zone:read"] },
    branchBuilds: Object.fromEntries(["delivery", "operations", "ops-sync"].map((app) => [app, { productionBranch: "main", nonProductionBuildsEnabled: false, verifiedAt: "2026-07-30T12:00:00Z", evidenceRef: `ticket:${app}` }])),
    projectAlpha: {
      baseUrl: configs.operations.vars.PROJECT_ALPHA_BASE_URL,
      approvalRef: "ticket:pa",
      operationsReadCredentialReady: true,
      opsSyncServiceAuthReady: true,
      opsSyncAccessGroupReady: true,
      ed25519Ready: false,
      paymentBillingContractReady: true,
      authorizationBypassUsed: false,
      releaseCommit: RELEASE_CANDIDATES.projectAlpha,
      sourceCommitVerified: true,
      remoteRef: "origin/codex/generic-portal-v2-integration",
      webImageDigest: `sha256:${"1".repeat(64)}`,
      cronImageDigest: `sha256:${"2".repeat(64)}`,
      imagesShareSourceCommit: true,
      deployedAt: "2026-07-30T12:00:00Z",
      deploymentEvidenceRef: "ticket:pa:deployment",
      migrations: {
        expected: Object.keys(PROJECT_ALPHA_STAGING.migrations),
        sourceSha256: { ...PROJECT_ALPHA_STAGING.migrations },
        appliedToStaging: true,
        ledgerVerified: true,
        secondRunEmpty: true,
        schemaIntegrityPassed: true,
        verifiedAt: "2026-07-30T12:00:00Z",
        ledgerEvidenceRef: "ticket:pa:migrations:ledger",
        verificationEvidenceRef: "ticket:pa:migrations:verify",
      },
      defaultOff: {
        settings: Object.fromEntries(PROJECT_ALPHA_STAGING.defaultOffSettings.map((setting) => [setting, false])),
        profileCapabilitiesDisabled: true,
        profileDeliveryDisabled: true,
        evidenceRef: "ticket:pa:default-off",
      },
      outbound: {
        senderInstalled: true,
        schedule: PROJECT_ALPHA_STAGING.outboundSchedule,
        deliveryEnabled: false,
        authoritativeHooksEnabled: false,
        workerInertWhileDisabled: true,
        deliveryKeyId: "pa-staging-v1",
        previousDeliveryKeyId: "",
        secretEncryptedAtRest: true,
        secretValuesExcluded: true,
        exactBodyHmacVerified: true,
        destinationValidationVerified: true,
        retryDeadLetterVerified: true,
        revocationPriorityVerified: true,
        verifiedAt: "2026-07-30T12:00:00Z",
        evidenceRef: "ticket:pa:outbound",
      },
      rollback: {
        backupRef: "ticket:pa:backup",
        targetWebImageDigest: `sha256:${"3".repeat(64)}`,
        targetCronImageDigest: `sha256:${"4".repeat(64)}`,
        restoreDrillPassed: true,
        migrationFixForwardReviewed: true,
        tombstoneDrainPlanReviewed: true,
        projectionAuthorityDisabledFirst: true,
        outboundHeldUntilTombstonesAcknowledged: true,
        senderDisabledAfterDrain: true,
        noDestructiveRollback: true,
        testedAt: "2026-07-30T12:00:00Z",
        evidenceRef: "ticket:pa:rollback",
      },
    },
    viewer: {
      hostname: STAGING_VIEWER.hostname,
      origin: STAGING_VIEWER.origin,
      releaseCommit: RELEASE_CANDIDATES.viewer,
      image: STAGING_VIEWER.image,
      configSha256: "5".repeat(64),
      deployedAt: "2026-07-30T12:00:00Z",
      deploymentEvidenceRef: "ticket:viewer:deployment",
      configuration: {
        publicBaseUrl: STAGING_VIEWER.origin,
        expectedHost: STAGING_VIEWER.hostname,
        opsBaseUrl: `https://${STAGING_HOSTS.operations}`,
        processingPlatformEnabled: false,
        processingWorkerProfileStarted: false,
        webodmEnabled: false,
        proxySharedSecretEnabled: false,
        trustedProxyAddressesEnabled: false,
        serviceKeyId: STAGING_VIEWER.serviceKeyId,
        eventKeyId: STAGING_VIEWER.eventKeyId,
        providerCredentialsKeyId: STAGING_VIEWER.providerCredentialsKeyId,
        secretNames: [...STAGING_VIEWER.requiredSecretNames],
        secretValuesExcluded: true,
        envFileMode: "0600",
        evidenceRef: "ticket:viewer:config",
      },
      healthCheckPassed: true,
      readinessCheckPassed: true,
      servedRevision: RELEASE_CANDIDATES.viewer,
      servedSchemaVersion: STAGING_VIEWER.schemaVersion,
      runtimeIdentityAttested: true,
      directIpHostDenied: true,
      canonicalHostViaProxyVerified: true,
      proxyForwardedHostVerified: true,
      narrowBindFirewallTopologyVerified: true,
      rootlessUidGidVerified: true,
      capabilitySetsEmpty: true,
      readOnlyRootFilesystem: true,
      persistentVolumeVerified: true,
      readOnlyImportsVerified: true,
      rangeNoStoreVerified: true,
      rollback: {
        targetImageDigest: `sha256:${"6".repeat(64)}`,
        configBackupRef: "ticket:viewer:config-backup",
        drillPassed: true,
        persistentDataPreserved: true,
        noDestructiveRollback: true,
        testedAt: "2026-07-30T12:00:00Z",
        evidenceRef: "ticket:viewer:rollback",
      },
    },
    hosts: {
      delivery: { hostname: STAGING_HOSTS.delivery, dnsReady: true, accessReady: true },
      client: { hostname: STAGING_HOSTS.client, dnsReady: true, accessReady: true },
      operations: { hostname: STAGING_HOSTS.operations, dnsReady: true, accessReady: true },
      incoming: { hostname: STAGING_HOSTS.incoming, published: false },
      "ops-sync": { hostname: STAGING_HOSTS["ops-sync"], dnsReady: true, accessReady: true },
      viewer: { hostname: STAGING_HOSTS.viewer, dnsReady: true, tlsReady: true, tunnelReady: true, protectedRoutesReady: true, publicShareBypassReady: true },
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
      delivery: { expected: [...REQUIRED_STAGING_MIGRATIONS.delivery], appliedToStaging: true, listEvidenceRef: "ticket:migrations:delivery:list", applyEvidenceRef: "ticket:migrations:delivery:apply", secondListEmpty: true, foreignKeyCheckPassed: true, idempotentReapplyPassed: true, videoRecoveryCompleted: true, videoRowsPendingForTrueNas: true, legacyBridgeAcceptanceMatrixPassed: true, verifiedAt: "2026-07-30T12:00:00Z", verificationEvidenceRef: "ticket:migrations:delivery:verify" },
      operations: { expected: [...REQUIRED_STAGING_MIGRATIONS.operations], appliedToStaging: true, listEvidenceRef: "ticket:migrations:operations:list", applyEvidenceRef: "ticket:migrations:operations:apply", secondListEmpty: true, foreignKeyCheckPassed: true, idempotentReapplyPassed: true, verifiedAt: "2026-07-30T12:00:00Z", verificationEvidenceRef: "ticket:migrations:operations:verify" },
      productionUnchanged: true,
    },
    externalGates: Object.fromEntries(REQUIRED_EXTERNAL_GATES.map((gate) => [gate, {
      ready: true,
      verifiedAt: "2026-07-30T12:00:00Z",
      evidenceRef: `ticket:gate:${gate}`,
      ...Object.fromEntries((REQUIRED_EXTERNAL_GATE_PROOFS[gate] ?? []).map((proof) => [proof, true])),
    }])),
    secrets: Object.fromEntries(Object.entries(REQUIRED_STAGING_SECRETS).map(([app, names]) => [app, { names: [...names], verifiedAt: "2026-07-30T12:00:00Z", source: "reviewed-secrets-file", workerIsNew: true, remoteNames: [], evidenceRef: `ticket:secrets:${app}` }])),
    backups: {
      delivery: { path: ".backups/delivery.sql", databaseName: STAGING_INVENTORY.delivery.d1_databases[0].database_name, databaseId: STAGING_INVENTORY.delivery.d1_databases[0].database_id, generatedAt: "2026-07-30T12:00:00Z", bytes: backupBody.length, sha256: digest(backupBody), confirmedIntentionallyEmpty: false },
      operations: { path: ".backups/operations.sql", databaseName: STAGING_INVENTORY.operations.d1_databases[0].database_name, databaseId: STAGING_INVENTORY.operations.d1_databases[0].database_id, generatedAt: "2026-07-30T12:00:00Z", bytes: backupBody.length, sha256: digest(backupBody), confirmedIntentionallyEmpty: false },
    },
    deployments: Object.fromEntries(["delivery", "operations", "ops-sync"].map((app) => [app, {
      versionId: `staging-version-${app}`,
      releaseCommit: RELEASE_CANDIDATES.operations,
      configSha256: { delivery: "B".repeat(64), operations: "C".repeat(64), "ops-sync": "D".repeat(64) }[app],
      deployedAt: "2026-07-30T12:00:00Z",
      bindingsVerified: true,
      healthCheckPassed: true,
      hostAdmissionDenied: true,
      disabledFeatureFlags: [...REQUIRED_DISABLED_FEATURE_FLAGS[app]],
      evidenceRef: `ticket:deployment:${app}`,
    }])),
    infrastructure: {
      remoteInventoryVerified: true, dnsTlsAndRoutesVerified: true, queuesAndDlqsVerified: true,
      eventNotificationsVerified: true, cronsVerified: true, workflowBindingsVerified: true,
      containerBindingAndEntitlementVerified: true, r2LifecycleVerified: true,
      accessPoliciesVerified: true, emailBindingsVerified: true, mapboxOriginRestrictionsVerified: true,
      observabilityAndAlertDestinationsVerified: true, costBudgetsVerified: true,
      verifiedAt: "2026-07-30T12:00:00Z", evidenceRef: "ticket:infrastructure",
    },
    rollback: {
      targetVersionIds: { delivery: "rollback-delivery", operations: "rollback-operations", "ops-sync": "rollback-ops-sync" },
      drillPassed: true, d1FixForwardReviewed: true, noDestructiveRollback: true,
      testedAt: "2026-07-30T12:00:00Z", evidenceRef: "ticket:rollback",
    },
    productionState: { unchanged: true, verifiedAt: "2026-07-30T12:00:00Z", evidenceRef: "ticket:production-state" },
    activationPlan: { requestedFlags: [], approvalGranted: false },
    approvals: { stagingDnsAndRoutes: true, stagingMigrations: true, stagingDeployment: true, productionChanges: false },
  };
  Object.assign(evidence.externalGates.workspaceAccessEnrollment, {
    mode: "dedicated_workspace_reconciler",
    clientGroupIsolated: true,
    enrollmentBeforeEmail: true,
    perInvitationReceiptEnforced: true,
    receiptBindsWorkspaceAndEmailHash: true,
    receiptRevocationRaceVerified: true,
    multiWorkspaceRetention: true,
    lastEligibilityRevocation: true,
    staffGroupUnchanged: true,
    processorEvidenceRef: "ticket:client-access-reconciler",
  });
  Object.assign(evidence.externalGates.requestAttachmentR2CorsAndLeastPrivilege, {
    corsArtifact: "docs/staging/request-attachments-r2-cors.json",
    allowedOriginPutVerified: true,
    outOfScopeOriginDenied: true,
    leastPrivilegeCredentialVerified: true,
  });
  return { configs, evidence, configHashes: evidence.configSha256 };
}

test("accepts complete, current, config-bound non-secret release evidence", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-"));
  const { configs, evidence } = fixture(base);
  assert.deepEqual(validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes: evidence.configSha256, now, sourceControlVerified: true, allowUnfinalizedContractForTest: true }), []);
});

test("operational verification reflects the final cross-repository pin gate", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-final-pins-"));
  const { configs, evidence } = fixture(base);
  const errors = validateEvidenceContract(evidence, { base, head: evidence.releaseCommit, configs, configHashes: evidence.configSha256, now, sourceControlVerified: true });
  assert.equal(errors.some((error) => error.includes("FINAL_* candidate placeholders")), !RELEASE_CONTRACT_FINALIZED, errors.join(" | "));
});

test("fails closed on Viewer and Project Alpha deployment-contract drift", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-cross-repo-"));
  const { configs, evidence, configHashes } = fixture(base);
  evidence.viewer.image = "ghcr.io/example/viewer:latest";
  evidence.viewer.servedRevision = "f".repeat(40);
  evidence.viewer.servedSchemaVersion = STAGING_VIEWER.schemaVersion - 1;
  evidence.viewer.runtimeIdentityAttested = false;
  evidence.viewer.configuration.proxySharedSecretEnabled = true;
  evidence.viewer.narrowBindFirewallTopologyVerified = false;
  evidence.projectAlpha.releaseCommit = "f".repeat(40);
  evidence.projectAlpha.migrations.sourceSha256["0066_generic_portal_v2_integration.sql"] = "0".repeat(64);
  evidence.projectAlpha.defaultOff.settings.portal_outbound_delivery_enabled = true;
  evidence.projectAlpha.outbound.secretValues = { signingSecret: "must-never-appear" };
  evidence.projectAlpha.rollback.restoreDrillPassed = false;
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes, now, sourceControlVerified: true });
  for (const expected of ["exact reviewed commit and image digest", "attest the exact reviewed revision and schema version", "proxy hardening", "narrowBindFirewallTopologyVerified", "reviewed source commit", "0066_generic_portal_v2_integration.sql SHA-256", "portal_outbound_delivery_enabled must remain false", "without containing secret values", "restoreDrillPassed"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});

for (const [name, mutate] of [
  ["served Viewer revision", evidence => { evidence.viewer.servedRevision = "f".repeat(40); }],
  ["served Viewer schema", evidence => { evidence.viewer.servedSchemaVersion = STAGING_VIEWER.schemaVersion + 1; }],
  ["Viewer runtime attestation", evidence => { evidence.viewer.runtimeIdentityAttested = false; }],
]) test(`requires the ${name} independently`, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-viewer-identity-"));
  const { configs, evidence, configHashes } = fixture(base);
  mutate(evidence);
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes, now, sourceControlVerified: true });
  assert(errors.some((error) => error.includes("attest the exact reviewed revision and schema version")), errors.join(" | "));
});

test("fails closed on stale credential, config drift, branch builds, secrets, and backup identity", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-"));
  const { configs, evidence } = fixture(base);
  evidence.credential.verifiedAt = "2026-07-28T12:00:00Z";
  evidence.configSha256.delivery = "E".repeat(64);
  evidence.branchBuilds.delivery.nonProductionBuildsEnabled = true;
  evidence.secrets.operations.names = [];
  evidence.backups.delivery.databaseId = "wrong";
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes: { ...evidence.configSha256, delivery: "B".repeat(64) }, now, sourceControlVerified: true });
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
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes: evidence.configSha256, now, sourceControlVerified: true });
  for (const expected of ["must not reuse", "public paths", "migration set", "must not bypass"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});
test("fails closed when any portal-v2 external dependency lacks current evidence", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-gate-"));
  const { evidence, configs, configHashes } = fixture(base);
  evidence.externalGates.delegatedShareSignerBinding.ready = false;
  evidence.externalGates.requestAttachmentScanner.evidenceRef = "";
  evidence.externalGates.trueNasVideoThumbnailRenderer.ready = false;
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes, now, sourceControlVerified: true });
  assert(errors.some((error) => error.includes("delegatedShareSignerBinding")), errors.join(" | "));
  assert(errors.some((error) => error.includes("requestAttachmentScanner")), errors.join(" | "));
  assert(errors.some((error) => error.includes("trueNasVideoThumbnailRenderer")), errors.join(" | "));
});
test("rejects generic or legacy Access enrollment evidence for autonomous invitations", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-enrollment-"));
  const { evidence, configs, configHashes } = fixture(base);
  evidence.externalGates.workspaceAccessEnrollment.mode = "manual_pre_enrollment";
  evidence.externalGates.workspaceAccessEnrollment.enrollmentBeforeEmail = false;
  evidence.externalGates.workspaceAccessEnrollment.perInvitationReceiptEnforced = false;
  evidence.externalGates.workspaceAccessEnrollment.processorEvidenceRef = "";
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes, now, sourceControlVerified: true });
  for (const expected of ["dedicated workspace reconciler", "enrollmentBeforeEmail", "perInvitationReceiptEnforced", "processor evidence"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});
test("requires staging attachment CORS and least-privilege browser evidence", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-cors-"));
  const { evidence, configs, configHashes } = fixture(base);
  evidence.externalGates.requestAttachmentR2CorsAndLeastPrivilege.corsArtifact = "apps/client/r2-request-attachments-cors.json";
  evidence.externalGates.requestAttachmentR2CorsAndLeastPrivilege.outOfScopeOriginDenied = false;
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes, now, sourceControlVerified: true });
  assert(errors.some((error) => error.includes("reviewed staging CORS artifact")), errors.join(" | "));
  assert(errors.some((error) => error.includes("outOfScopeOriginDenied")), errors.join(" | "));
});

test("requires structured migration, deployment, rollback, infrastructure, and pushed-commit evidence", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-structured-"));
  const { evidence, configs, configHashes } = fixture(base);
  evidence.sourceControl.pushed = false;
  evidence.migrations.delivery.secondListEmpty = false;
  evidence.deployments.operations.bindingsVerified = false;
  evidence.infrastructure.containerBindingAndEntitlementVerified = false;
  evidence.rollback.drillPassed = false;
  evidence.rollback.targetVersionIds.operations = evidence.deployments.operations.versionId;
  evidence.productionState.unchanged = false;
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes, now, sourceControlVerified: false });
  for (const expected of ["pushed", "reachable", "secondListEmpty", "bindingsVerified", "containerBindingAndEntitlementVerified", "drillPassed", "must differ", "production unchanged"]) {
    assert(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join(" | ")}`);
  }
});

test("requires every named external-gate proof instead of a generic ready attestation", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-proofs-"));
  const { evidence, configs, configHashes } = fixture(base);
  evidence.externalGates.projectAlphaDraftQuotes.noFinancialSideEffects = false;
  evidence.externalGates.trueNasVideoThumbnailRenderer.opaqueLeaseVerified = false;
  const errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes, now, sourceControlVerified: true });
  assert(errors.some((error) => error.includes("projectAlphaDraftQuotes must prove noFinancialSideEffects")), errors.join(" | "));
  assert(errors.some((error) => error.includes("trueNasVideoThumbnailRenderer must prove opaqueLeaseVerified")), errors.join(" | "));
});

test("activation dependencies cover every default-off flag and reject prohibited or ungated activation", () => {
  for (const [app, flags] of Object.entries(REQUIRED_DISABLED_FEATURE_FLAGS)) {
    assert.deepEqual(new Set(Object.keys(FEATURE_FLAG_ACTIVATION_POLICIES[app])), new Set(flags), app);
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-activation-"));
  const { evidence, configs, configHashes } = fixture(base);
  evidence.activationPlan = { requestedFlags: ["delivery.CLIENT_PORTAL_INVITATION_EMAIL_ENABLED"], phase: "post-evidence-validation", environment: "staging", productionFlagsRemainOff: true, oneGateAtATime: true, rollbackRef: "ticket:rollback", approvalGranted: true, approvedAt: "2026-07-30T12:00:00Z", approvalRef: "ticket:activation" };
  evidence.externalGates.workspaceAccessEnrollment.ready = false;
  let errors = validateEvidence(evidence, { base, head: evidence.releaseCommit, configs, configHashes, now, sourceControlVerified: true });
  assert(errors.some((error) => error.includes("requires current ready gate workspaceAccessEnrollment")), errors.join(" | "));

  const freshBase = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-prohibited-"));
  const fresh = fixture(freshBase);
  fresh.evidence.activationPlan = { requestedFlags: ["operations.R2_PURGE_ENABLED"], phase: "post-evidence-validation", environment: "staging", productionFlagsRemainOff: true, oneGateAtATime: true, rollbackRef: "ticket:rollback", approvalGranted: true, approvedAt: "2026-07-30T12:00:00Z", approvalRef: "ticket:activation" };
  errors = validateEvidence(fresh.evidence, { base: freshBase, head: fresh.evidence.releaseCommit, configs: fresh.configs, configHashes: fresh.configHashes, now, sourceControlVerified: true });
  assert(errors.some((error) => error.includes("R2_PURGE_ENABLED is prohibited")), errors.join(" | "));

  const viewerBase = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-evidence-viewer-activation-"));
  const viewer = fixture(viewerBase);
  viewer.evidence.activationPlan = { requestedFlags: ["operations.VIEWER_PROCESSING_ENABLED"], phase: "evidence-collection", collectingGate: "viewerProcessing", environment: "staging", productionFlagsRemainOff: true, oneGateAtATime: true, rollbackRef: "ticket:viewer-rollback", approvalGranted: true, approvedAt: "2026-07-30T12:00:00Z", approvalRef: "ticket:viewer-activation" };
  viewer.evidence.externalGates.viewerProcessing.ready = false;
  viewer.evidence.externalGates.viewerDeployment.ready = false;
  errors = validateEvidence(viewer.evidence, { base: viewerBase, head: viewer.evidence.releaseCommit, configs: viewer.configs, configHashes: viewer.configHashes, now, sourceControlVerified: true });
  assert(errors.some((error) => error.includes("requires current ready gate viewerDeployment")), errors.join(" | "));
  viewer.evidence.externalGates.viewerDeployment.ready = true;
  viewer.evidence.externalGates.projectAlphaDraftQuotes.ready = false;
  errors = validateEvidence(viewer.evidence, { base: viewerBase, head: viewer.evidence.releaseCommit, configs: viewer.configs, configHashes: viewer.configHashes, now, sourceControlVerified: true });
  assert(errors.some((error) => error.includes("external gate projectAlphaDraftQuotes must be confirmed ready")), errors.join(" | "));
  viewer.evidence.externalGates.projectAlphaDraftQuotes.ready = true;
  assert.deepEqual(validateEvidence(viewer.evidence, { base: viewerBase, head: viewer.evidence.releaseCommit, configs: viewer.configs, configHashes: viewer.configHashes, now, sourceControlVerified: true, allowUnfinalizedContractForTest: true }), []);

  viewer.evidence.activationPlan.phase = "post-evidence-validation";
  errors = validateEvidence(viewer.evidence, { base: viewerBase, head: viewer.evidence.releaseCommit, configs: viewer.configs, configHashes: viewer.configHashes, now, sourceControlVerified: true });
  assert(errors.some((error) => error.includes("viewerProcessing")), errors.join(" | "));
});

test("checked-in evidence example stays complete as migrations, flags, gates, and proofs evolve", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const example = JSON.parse(fs.readFileSync(path.join(root, "docs", "staging", "release-evidence.json.example"), "utf8"));
  for (const app of ["delivery", "operations"]) assert.deepEqual(example.migrations[app].expected, [...REQUIRED_STAGING_MIGRATIONS[app]], `migrations.${app}`);
  for (const app of ["delivery", "operations", "ops-sync"]) assert.deepEqual(new Set(example.deployments[app].disabledFeatureFlags), new Set(REQUIRED_DISABLED_FEATURE_FLAGS[app]), `deployments.${app}.disabledFeatureFlags`);
  assert.deepEqual(new Set(Object.keys(example.externalGates)), new Set(REQUIRED_EXTERNAL_GATES));
  for (const gate of REQUIRED_EXTERNAL_GATES) {
    for (const proof of REQUIRED_EXTERNAL_GATE_PROOFS[gate] ?? []) assert.equal(example.externalGates[gate][proof], false, `${gate}.${proof}`);
  }
  assert.equal(example.sourceControl.runtimeCandidateCommit, RELEASE_CANDIDATES.operations);
  assert.equal(example.viewer.releaseCommit, RELEASE_CANDIDATES.viewer);
  assert.equal(example.viewer.image, STAGING_VIEWER.image);
  assert.equal(example.viewer.servedRevision, RELEASE_CANDIDATES.viewer);
  assert.equal(example.viewer.servedSchemaVersion, STAGING_VIEWER.schemaVersion);
  assert.equal(example.viewer.runtimeIdentityAttested, false);
  assert.deepEqual(new Set(example.viewer.configuration.secretNames), new Set(STAGING_VIEWER.requiredSecretNames));
  assert.equal(example.viewer.configuration.proxySharedSecretEnabled, false);
  assert.equal(example.projectAlpha.releaseCommit, RELEASE_CANDIDATES.projectAlpha);
  assert.deepEqual(example.projectAlpha.migrations.sourceSha256, PROJECT_ALPHA_STAGING.migrations);
  assert.deepEqual(new Set(Object.keys(example.projectAlpha.defaultOff.settings)), new Set(PROJECT_ALPHA_STAGING.defaultOffSettings));
  assert.deepEqual(example.activationPlan, { requestedFlags: [], approvalGranted: false });
});

test("Viewer processing cannot disappear from the staging release inventory", () => {
  assert(REQUIRED_STAGING_MIGRATIONS.operations.includes("0027_viewer_processing_control_plane.sql"));
  assert(REQUIRED_STAGING_SECRETS.operations.includes("VIEWER_SERVICE_HMAC_SECRET"));
  assert(REQUIRED_STAGING_SECRETS.operations.includes("VIEWER_EVENT_HMAC_SECRET"));
  assert(REQUIRED_DISABLED_FEATURE_FLAGS.operations.includes("VIEWER_PROCESSING_ENABLED"));
  assert.equal(STAGING_STATIC_VARS.operations.VIEWER_PROCESSING_ENABLED, "false");
  assert.equal(STAGING_STATIC_VARS.operations.VIEWER_EVENT_KEY_ID, "viewer-staging-v1");
  assert.equal(STAGING_HOSTS.viewer, STAGING_VIEWER.hostname);
  assert.deepEqual(FEATURE_FLAG_ACTIVATION_POLICIES.operations.VIEWER_PROCESSING_ENABLED.gates, ["viewerDeployment", "viewerServiceContract", "viewerProcessing"]);
  assert.deepEqual(FEATURE_FLAG_ACTIVATION_POLICIES.operations.VIEWER_PROCESSING_ENABLED.stagingGates, ["viewerDeployment", "viewerServiceContract"]);
  assert.equal(FEATURE_FLAG_ACTIVATION_POLICIES.operations.VIEWER_PROCESSING_ENABLED.prohibitedReason, undefined);
});

test("pre-deployment preparation and post-deployment verification remain non-circular", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const prepare = fs.readFileSync(path.join(root, "scripts", "staging-release.mjs"), "utf8");
  const verify = fs.readFileSync(path.join(root, "scripts", "staging-release-verify.mjs"), "utf8");
  assert.equal(prepare.includes("validateEvidenceFile"), false);
  assert.equal(verify.includes("validateEvidenceFile"), true);
  assert.equal(verify.includes('"staging:release:prepare"'), true);
});

test("migration reapply evidence uses Wrangler's ledger instead of replaying raw SQL", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const relative of [
    ["docs", "staging", "client-portal-rollout.md"],
    ["docs", "staging", "release-checklist.md"],
  ]) {
    const document = fs.readFileSync(path.join(root, ...relative), "utf8");
    assert.match(document, /idempotentReapplyPassed/);
    assert.match(document, /wrangler d1 migrations apply/);
    assert.match(document, /No migrations to apply/);
    assert.match(document, /(?:raw SQL files a second time|migration SQL files directly)/i);
    assert.match(document, /(?:Do not|Never)/);
  }
});
