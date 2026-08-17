import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP_SOURCE_DIRS, FEATURE_FLAG_ACTIVATION_POLICIES, PROJECT_ALPHA_STAGING, RELEASE_CANDIDATES, RELEASE_CONTRACT_FINALIZED, REQUIRED_DISABLED_FEATURE_FLAGS, REQUIRED_EXTERNAL_GATES, REQUIRED_EXTERNAL_GATE_PROOFS, REQUIRED_STAGING_MIGRATIONS, REQUIRED_STAGING_SECRETS, STAGING_ACCESS_AUDS, STAGING_ACCOUNT_ID, STAGING_CLIENT_PORTAL, STAGING_HOSTS, STAGING_INVENTORY, STAGING_STATIC_VARS, STAGING_VIEWER } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultEvidence = path.join(root, ".backups", "staging-release-evidence.json");
const marker = /<[^>]+>|CHANGE[_-]?ME|REPLACE[_-]?ME|example\.invalid/i;
const apps = ["delivery", "operations", "ops-sync"];
const populated = (value) => typeof value === "string" && value.length > 0 && !marker.test(value);
const sha256Digest = (value) => /^sha256:[a-f0-9]{64}$/i.test(value ?? "");
const sha256Hex = (value) => /^[a-f0-9]{64}$/i.test(value ?? "");

function recentDate(value, now, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!populated(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now + 5 * 60 * 1000 && timestamp >= now - maxAgeMs;
}
function httpsStagingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(?:^|[.-])staging(?:[.-]|$)/i.test(url.hostname);
  } catch { return false; }
}
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
function resolvedBackup(base, relative) {
  if (!populated(relative)) return null;
  const backupRoot = path.resolve(base, ".backups");
  const file = path.resolve(base, relative);
  return file.startsWith(`${backupRoot}${path.sep}`) ? file : null;
}
const sameSet = (left, right) => Array.isArray(left) && Array.isArray(right)
  && new Set(left).size === left.length
  && new Set(right).size === right.length
  && left.length === right.length
  && left.every((item) => right.includes(item))
  && right.every((item) => left.includes(item));

export function validateActivationPlan(plan, evidence, options = {}) {
  const now = options.now ?? Date.now();
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["activationPlan must be an object"];
  const requested = plan.requestedFlags;
  if (!Array.isArray(requested) || new Set(requested).size !== requested.length) return ["activationPlan.requestedFlags must be a duplicate-free array"];
  if (requested.length > 1) errors.push("activationPlan may enable only one staging flag at a time");
  const evidenceCollection = plan.phase === "evidence-collection";
  for (const value of requested) {
    if (typeof value !== "string" || !value.includes(".")) { errors.push(`activation flag ${String(value)} is invalid`); continue; }
    const separator = value.indexOf(".");
    const app = value.slice(0, separator);
    const flag = value.slice(separator + 1);
    const policy = FEATURE_FLAG_ACTIVATION_POLICIES[app]?.[flag];
    if (!policy) { errors.push(`activation flag ${value} is not part of the reviewed release contract`); continue; }
    if (policy.prohibitedReason) { errors.push(`activation flag ${value} is prohibited: ${policy.prohibitedReason}`); continue; }
    const gates = evidenceCollection ? policy.stagingGates : policy.gates;
    if (evidenceCollection && (!Array.isArray(policy.stagingGates) || !(policy.gates ?? []).includes(plan.collectingGate) || policy.stagingGates.includes(plan.collectingGate))) {
      errors.push(`activation flag ${value} must name its non-prerequisite evidence gate in activationPlan.collectingGate`);
    }
    for (const gate of gates ?? []) {
      const result = evidence.externalGates?.[gate] ?? {};
      if (result.ready !== true || !recentDate(result.verifiedAt, now) || !populated(result.evidenceRef)) {
        errors.push(`activation flag ${value} requires current ready gate ${gate}`);
      }
      for (const proof of REQUIRED_EXTERNAL_GATE_PROOFS[gate] ?? []) {
        if (result[proof] !== true) errors.push(`activation flag ${value} requires gate ${gate} proof ${proof}`);
      }
    }
  }
  if (requested.length) {
    if (!evidenceCollection && plan.phase !== "post-evidence-validation") errors.push("activationPlan.phase must be evidence-collection or post-evidence-validation");
    if (plan.environment !== "staging" || plan.productionFlagsRemainOff !== true) errors.push("activationPlan must be staging-only while production flags remain off");
    if (plan.oneGateAtATime !== true || !populated(plan.rollbackRef)) errors.push("activationPlan must prove one-gate-at-a-time rollback control");
    if (evidenceCollection && evidence.externalGates?.[plan.collectingGate]?.ready !== false) errors.push("activationPlan.collectingGate must remain ready=false until staging evidence is captured and the flag is restored off");
    if (plan.approvalGranted !== true) errors.push("activationPlan.approvalGranted must be true when flags are requested");
    if (!recentDate(plan.approvedAt, now) || !populated(plan.approvalRef)) errors.push("activation plan approval must be current and referenced");
  } else if (plan.approvalGranted !== false) errors.push("empty activation plan must explicitly keep approvalGranted=false");
  return errors;
}

export function validateEvidence(evidence, options = {}) {
  const base = options.base ?? root;
  const head = options.head ?? "";
  const configs = options.configs ?? {};
  const configHashes = options.configHashes ?? {};
  const sourceControlVerified = options.sourceControlVerified ?? false;
  const runtimeSourceControlVerified = options.runtimeSourceControlVerified ?? sourceControlVerified;
  const allowUnfinalizedContractForTest = options.allowUnfinalizedContractForTest === true;
  const now = options.now ?? Date.now();
  const errors = [];

  if (RELEASE_CONTRACT_FINALIZED !== true && !allowUnfinalizedContractForTest) errors.push("release contract FINAL_* candidate placeholders must be replaced before staging verification");
  if (RELEASE_CONTRACT_FINALIZED === true) {
    for (const [name, commit] of Object.entries(RELEASE_CANDIDATES)) if (!/^[a-f0-9]{40}$/i.test(commit)) errors.push(`${name} release candidate must be an immutable 40-character Git SHA`);
    if (!/^ghcr\.io\/[^@]+@sha256:[a-f0-9]{64}$/i.test(STAGING_VIEWER.image)) errors.push("Viewer release image must include an immutable sha256 digest");
    for (const [name, hash] of Object.entries(PROJECT_ALPHA_STAGING.migrations)) if (!sha256Hex(hash)) errors.push(`Project Alpha migration ${name} release hash must be finalized`);
  }

  if (!/^[a-f0-9]{40}$/i.test(evidence.releaseCommit ?? "") || evidence.releaseCommit !== head) errors.push("releaseCommit must equal the exact local HEAD SHA");
  const sourceControl = evidence.sourceControl ?? {};
  if (sourceControl.pushed !== true || !populated(sourceControl.remoteRef)) errors.push("sourceControl must prove the exact release commit is pushed to a named remote ref");
  if (!recentDate(sourceControl.verifiedAt, now) || !populated(sourceControl.evidenceRef)) errors.push("sourceControl pushed-commit evidence must be current and referenced");
  if (sourceControlVerified !== true) errors.push("releaseCommit must be reachable from the named local remote-tracking ref");
  if (sourceControl.runtimeCandidateCommit !== RELEASE_CANDIDATES.operations || sourceControl.runtimeCandidatePushed !== true) errors.push("sourceControl must pin and confirm the immutable Ops runtime candidate");
  if (!populated(sourceControl.runtimeEvidenceRef) || runtimeSourceControlVerified !== true) errors.push("Ops runtime candidate must be reachable from the named local remote-tracking ref");
  for (const app of apps) {
    if (!/^[A-F0-9]{64}$/i.test(evidence.configSha256?.[app] ?? "") || evidence.configSha256[app].toUpperCase() !== configHashes[app]) {
      errors.push(`${app} staging config SHA-256 must match the ignored config used for release`);
    }
  }

  const credential = evidence.credential ?? {};
  if (credential.valid !== true) errors.push("credential.valid must be confirmed true");
  if (credential.accountId !== STAGING_ACCOUNT_ID) errors.push("credential.accountId must be the LTDS account");
  if (!recentDate(credential.verifiedAt, now)) errors.push("credential.verifiedAt must be current (within 24 hours)");
  for (const permission of ["workers:write", "d1:write", "zone:read"]) if (!(credential.confirmedPermissions ?? []).includes(permission)) errors.push(`credential must confirm ${permission}`);

  for (const app of apps) {
    const build = evidence.branchBuilds?.[app] ?? {};
    if (build.productionBranch !== "main") errors.push(`${app} production branch must be main`);
    if (build.nonProductionBuildsEnabled !== false) errors.push(`${app} non-production builds must be disabled`);
    if (!recentDate(build.verifiedAt, now)) errors.push(`${app} branch control needs current verification (within 24 hours)`);
    if (!populated(build.evidenceRef)) errors.push(`${app} branch control needs a dashboard/API evidence reference`);
  }

  const projectAlpha = evidence.projectAlpha ?? {};
  if (!httpsStagingUrl(projectAlpha.baseUrl)) errors.push("Project Alpha baseUrl must be an approved HTTPS staging origin");
  if (projectAlpha.baseUrl !== configs.operations?.vars?.PROJECT_ALPHA_BASE_URL) errors.push("Project Alpha baseUrl must match Operations staging config");
  if (!populated(projectAlpha.approvalRef)) errors.push("Project Alpha needs an approval reference");
  for (const gate of ["operationsReadCredentialReady", "opsSyncServiceAuthReady", "opsSyncAccessGroupReady"]) if (projectAlpha[gate] !== true) errors.push(`Project Alpha ${gate} must be confirmed true`);
  if (projectAlpha.ed25519Ready !== true && projectAlpha.ed25519Ready !== false) errors.push("Project Alpha ed25519Ready must explicitly record the optional rollout state");
  if (projectAlpha.paymentBillingContractReady !== true) errors.push("Project Alpha paymentBillingContractReady must be confirmed true");
  if (projectAlpha.authorizationBypassUsed !== false) errors.push("Project Alpha must not bypass LTDS authorization");
  if (projectAlpha.releaseCommit !== PROJECT_ALPHA_STAGING.releaseCommit || projectAlpha.sourceCommitVerified !== true || !populated(projectAlpha.remoteRef)) errors.push("Project Alpha deployment must pin and verify the reviewed source commit");
  if (!sha256Digest(projectAlpha.webImageDigest) || !sha256Digest(projectAlpha.cronImageDigest) || projectAlpha.imagesShareSourceCommit !== true) errors.push("Project Alpha web and cron images must have immutable digests from the reviewed commit");
  if (!recentDate(projectAlpha.deployedAt, now) || !populated(projectAlpha.deploymentEvidenceRef)) errors.push("Project Alpha deployment evidence must be current and referenced");

  const projectAlphaMigrations = projectAlpha.migrations ?? {};
  if (!sameSet(projectAlphaMigrations.expected, Object.keys(PROJECT_ALPHA_STAGING.migrations))) errors.push("Project Alpha migration set must exactly match the release contract");
  for (const [name, expectedHash] of Object.entries(PROJECT_ALPHA_STAGING.migrations)) {
    if (projectAlphaMigrations.sourceSha256?.[name] !== expectedHash) errors.push(`Project Alpha migration ${name} SHA-256 must match the reviewed source`);
  }
  for (const proof of ["appliedToStaging", "ledgerVerified", "secondRunEmpty", "schemaIntegrityPassed"]) {
    if (projectAlphaMigrations[proof] !== true) errors.push(`Project Alpha migrations must prove ${proof}`);
  }
  if (!recentDate(projectAlphaMigrations.verifiedAt, now) || !populated(projectAlphaMigrations.ledgerEvidenceRef) || !populated(projectAlphaMigrations.verificationEvidenceRef)) errors.push("Project Alpha migration evidence must be current and referenced");

  const projectAlphaDefaults = projectAlpha.defaultOff ?? {};
  if (!sameSet(Object.keys(projectAlphaDefaults.settings ?? {}), PROJECT_ALPHA_STAGING.defaultOffSettings)) errors.push("Project Alpha default-off settings must exactly match the release contract");
  for (const setting of PROJECT_ALPHA_STAGING.defaultOffSettings) {
    if (projectAlphaDefaults.settings?.[setting] !== false) errors.push(`Project Alpha ${setting} must remain false in release preparation`);
  }
  if (projectAlphaDefaults.profileCapabilitiesDisabled !== true || projectAlphaDefaults.profileDeliveryDisabled !== true) errors.push("Project Alpha profile capabilities and delivery must remain default-off");
  if (!populated(projectAlphaDefaults.evidenceRef)) errors.push("Project Alpha default-off state needs an evidence reference");

  const projectAlphaOutbound = projectAlpha.outbound ?? {};
  if (projectAlphaOutbound.senderInstalled !== true || projectAlphaOutbound.schedule !== PROJECT_ALPHA_STAGING.outboundSchedule) errors.push("Project Alpha bounded portal sender must be installed on the reviewed schedule");
  if (projectAlphaOutbound.deliveryEnabled !== false || projectAlphaOutbound.authoritativeHooksEnabled !== false || projectAlphaOutbound.workerInertWhileDisabled !== true) errors.push("Project Alpha outbound publisher must remain inert while default-off");
  if (!populated(projectAlphaOutbound.deliveryKeyId) || projectAlphaOutbound.deliveryKeyId === projectAlphaOutbound.previousDeliveryKeyId) errors.push("Project Alpha outbound delivery key IDs must be non-empty and non-reused");
  if (projectAlphaOutbound.secretEncryptedAtRest !== true || projectAlphaOutbound.secretValuesExcluded !== true || Object.hasOwn(projectAlphaOutbound, "secretValues")) errors.push("Project Alpha outbound evidence must prove encrypted secrets without containing secret values");
  for (const proof of ["exactBodyHmacVerified", "destinationValidationVerified", "retryDeadLetterVerified", "revocationPriorityVerified"]) {
    if (projectAlphaOutbound[proof] !== true) errors.push(`Project Alpha outbound publisher must prove ${proof}`);
  }
  if (!recentDate(projectAlphaOutbound.verifiedAt, now) || !populated(projectAlphaOutbound.evidenceRef)) errors.push("Project Alpha outbound evidence must be current and referenced");

  const projectAlphaRollback = projectAlpha.rollback ?? {};
  if (!populated(projectAlphaRollback.backupRef) || !sha256Digest(projectAlphaRollback.targetWebImageDigest) || !sha256Digest(projectAlphaRollback.targetCronImageDigest)) errors.push("Project Alpha rollback requires backup and immutable target images");
  for (const proof of ["restoreDrillPassed", "migrationFixForwardReviewed", "tombstoneDrainPlanReviewed", "projectionAuthorityDisabledFirst", "outboundHeldUntilTombstonesAcknowledged", "senderDisabledAfterDrain", "noDestructiveRollback"]) {
    if (projectAlphaRollback[proof] !== true) errors.push(`Project Alpha rollback must prove ${proof}`);
  }
  if (!recentDate(projectAlphaRollback.testedAt, now) || !populated(projectAlphaRollback.evidenceRef)) errors.push("Project Alpha rollback evidence must be current and referenced");

  const viewer = evidence.viewer ?? {};
  if (viewer.hostname !== STAGING_VIEWER.hostname || viewer.origin !== STAGING_VIEWER.origin) errors.push("Viewer deployment must use the approved staging origin");
  if (viewer.releaseCommit !== RELEASE_CANDIDATES.viewer || viewer.image !== STAGING_VIEWER.image) errors.push("Viewer deployment must use the exact reviewed commit and image digest");
  if (!sha256Hex(viewer.configSha256) || !recentDate(viewer.deployedAt, now) || !populated(viewer.deploymentEvidenceRef)) errors.push("Viewer deployment needs a current referenced non-secret configuration hash");
  const viewerConfig = viewer.configuration ?? {};
  if (viewerConfig.publicBaseUrl !== STAGING_VIEWER.origin || viewerConfig.expectedHost !== STAGING_VIEWER.hostname || viewerConfig.opsBaseUrl !== `https://${STAGING_HOSTS.operations}`) errors.push("Viewer staging origins and host guard must match the reviewed topology");
  if (viewerConfig.processingPlatformEnabled !== false || viewerConfig.processingWorkerProfileStarted !== false || viewerConfig.webodmEnabled !== false) errors.push("Viewer processing, worker profile, and WebODM discovery must remain default-off in release preparation");
  if (viewerConfig.proxySharedSecretEnabled !== false || viewerConfig.trustedProxyAddressesEnabled !== false) errors.push("Viewer optional proxy hardening must remain default-off for this release contract");
  if (viewerConfig.serviceKeyId !== STAGING_VIEWER.serviceKeyId || viewerConfig.eventKeyId !== STAGING_VIEWER.eventKeyId || viewerConfig.providerCredentialsKeyId !== STAGING_VIEWER.providerCredentialsKeyId) errors.push("Viewer non-secret key IDs must match the staging contract");
  if (!sameSet(viewerConfig.secretNames, STAGING_VIEWER.requiredSecretNames) || viewerConfig.secretValuesExcluded !== true || Object.hasOwn(viewerConfig, "secretValues")) errors.push("Viewer secret evidence must contain only the exact approved secret names");
  if (viewerConfig.envFileMode !== "0600" || !populated(viewerConfig.evidenceRef)) errors.push("Viewer persistent environment file must be mode 0600 and referenced");
  for (const proof of ["healthCheckPassed", "readinessCheckPassed", "directIpHostDenied", "canonicalHostViaProxyVerified", "proxyForwardedHostVerified", "narrowBindFirewallTopologyVerified", "rootlessUidGidVerified", "capabilitySetsEmpty", "readOnlyRootFilesystem", "persistentVolumeVerified", "readOnlyImportsVerified", "rangeNoStoreVerified"]) {
    if (viewer[proof] !== true) errors.push(`Viewer deployment must prove ${proof}`);
  }
  const viewerRollback = viewer.rollback ?? {};
  if (!sha256Digest(viewerRollback.targetImageDigest) || viewerRollback.targetImageDigest === STAGING_VIEWER.image.split("@", 2)[1] || !populated(viewerRollback.configBackupRef)) errors.push("Viewer rollback requires a distinct immutable image and configuration backup");
  for (const proof of ["drillPassed", "persistentDataPreserved", "noDestructiveRollback"]) if (viewerRollback[proof] !== true) errors.push(`Viewer rollback must prove ${proof}`);
  if (!recentDate(viewerRollback.testedAt, now) || !populated(viewerRollback.evidenceRef)) errors.push("Viewer rollback evidence must be current and referenced");

  for (const [name, hostname] of Object.entries(STAGING_HOSTS)) {
    const host = evidence.hosts?.[name] ?? {};
    if (host.hostname !== hostname) errors.push(`${name} hostname does not match the approved staging topology`);
    if (name === "incoming") {
      if (host.published !== false) errors.push("incoming staging hostname must remain unpublished");
    } else if (name === "viewer") {
      for (const proof of ["dnsReady", "tlsReady", "tunnelReady", "protectedRoutesReady", "publicShareBypassReady"]) if (host[proof] !== true) errors.push(`viewer staging host must prove ${proof}`);
    } else {
      if (host.dnsReady !== true) errors.push(`${name} staging DNS must be confirmed ready`);
      if (host.accessReady !== true) errors.push(`${name} staging Access must be confirmed ready`);
    }
  }

  const access = evidence.access ?? {};
  for (const app of apps) {
    if (access.audiences?.[app] !== STAGING_ACCESS_AUDS[app]) errors.push(`${app} Access audience must match the approved staging app`);
  }
  if (!populated(access.groupId) || access.groupId !== configs["ops-sync"]?.vars?.CF_ACCESS_GROUP_ID) errors.push("Access groupId must match Ops Sync staging config");
  if (!populated(access.groupName) || access.groupName !== configs["ops-sync"]?.vars?.CF_ACCESS_GROUP_NAME) errors.push("Access groupName must match Ops Sync staging config");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(access.testerEmail ?? "")) errors.push("Access testerEmail must be explicit");
  if (access.testerActiveOperationsUser !== true) errors.push("Access tester must be confirmed as an active Operations user");
  if (!populated(access.approvalRef)) errors.push("Access setup needs an approval reference");

  const portal = evidence.clientPortal ?? {};
  const deliveryVars = configs.delivery?.vars ?? {};
  if (portal.hostname !== STAGING_CLIENT_PORTAL.hostname) errors.push("client portal hostname must match the approved staging topology");
  if (portal.origin !== `https://${STAGING_CLIENT_PORTAL.hostname}` || portal.origin !== deliveryVars.CLIENT_PORTAL_ORIGIN || portal.origin !== deliveryVars.PUBLIC_BASE_URL) errors.push("client portal origin must match the Delivery staging config and public origin");
  if (portal.enabled !== false || deliveryVars.CLIENT_PORTAL_ENABLED !== "false") errors.push("client portal must remain default-off in release preparation evidence");
  if (portal.teamDomain !== STAGING_STATIC_VARS.delivery.CLIENT_ACCESS_TEAM_DOMAIN || portal.teamDomain !== deliveryVars.CLIENT_ACCESS_TEAM_DOMAIN) errors.push("client portal Access team domain must match Delivery staging config");
  if (portal.applicationName !== STAGING_CLIENT_PORTAL.applicationName || !populated(portal.applicationId)) errors.push("client portal needs the dedicated Access application identity");
  if (!/^[a-f0-9]{64}$/i.test(portal.audience ?? "") || portal.audience !== deliveryVars.CLIENT_ACCESS_AUD) errors.push("client portal audience must match the dedicated Access app and Delivery staging config");
  if (Object.values(STAGING_ACCESS_AUDS).includes(portal.audience)) errors.push("client portal audience must not reuse Delivery, Operations, or Ops Sync Access");
  if (!populated(portal.groupId) || portal.groupName !== STAGING_CLIENT_PORTAL.groupName) errors.push("client portal needs the dedicated staging client group");
  if (portal.groupId === access.groupId || portal.groupName === access.groupName) errors.push("client portal group must not reuse the staff or Ops Sync group");
  if (!sameSet(portal.protectedPaths, STAGING_CLIENT_PORTAL.protectedPaths)) errors.push("client portal protected paths must exactly match the portal Access contract");
  const publicAccess = portal.publicAccess ?? {};
  if (publicAccess.applicationName !== STAGING_CLIENT_PORTAL.publicApplicationName || !populated(publicAccess.applicationId) || !populated(publicAccess.policyId)) errors.push("client public paths need a separately identified Access Bypass application and policy");
  if (publicAccess.decision !== "bypass" || publicAccess.include !== "everyone") errors.push("client public path policy must be Bypass Everyone");
  if (publicAccess.destination !== STAGING_CLIENT_PORTAL.hostname) errors.push("client public Bypass destination must be the client staging host root");
  if (!sameSet(publicAccess.workerPublicPaths, STAGING_CLIENT_PORTAL.publicPaths)) errors.push("client public paths must exactly match the reviewed Worker contract");
  if (!populated(portal.approvalRef)) errors.push("client portal Access setup needs an approval reference");

  const portalTests = portal.tests ?? {};
  for (const gate of ["portalDisabled404", "invalidAudienceDenied", "unprovisionedIdentityDenied", "crossAccountDenied", "staffAclDenied", "publicShareAnonymousReachable", "publicSharePasswordRechecked", "accessHeaderAbsentOnPublicShare"]) {
    if (portalTests[gate] !== true) errors.push(`client portal test ${gate} must be confirmed true`);
  }
  if (!recentDate(portalTests.observedAt, now) || !populated(portalTests.evidenceRef)) errors.push("client portal end-to-end evidence must be current and referenced");

  const migrations = evidence.migrations ?? {};
  for (const app of ["delivery", "operations"]) {
    const migration = migrations[app] ?? {};
    if (!sameSet(migration.expected, REQUIRED_STAGING_MIGRATIONS[app])) errors.push(`${app} portal/ACL migration set must exactly match the release contract`);
    if (migration.appliedToStaging !== true || !populated(migration.listEvidenceRef) || !populated(migration.applyEvidenceRef)) errors.push(`${app} staging migrations must be applied and evidenced`);
    for (const proof of ["secondListEmpty", "foreignKeyCheckPassed", "idempotentReapplyPassed"]) {
      if (migration[proof] !== true) errors.push(`${app} staging migrations must prove ${proof}`);
    }
    if (!recentDate(migration.verifiedAt, now) || !populated(migration.verificationEvidenceRef)) errors.push(`${app} migration verification must be current and referenced`);
  }
  const deliveryMigration = migrations.delivery ?? {};
  for (const proof of ["videoRecoveryCompleted", "videoRowsPendingForTrueNas", "legacyBridgeAcceptanceMatrixPassed"]) {
    if (deliveryMigration[proof] !== true) errors.push(`delivery staging migrations must prove ${proof}`);
  }
  if (migrations.productionUnchanged !== true) errors.push("production migrations must be confirmed unchanged");

  const externalGates = evidence.externalGates ?? {};
  const evidenceCollection = evidence.activationPlan?.phase === "evidence-collection" && (evidence.activationPlan?.requestedFlags?.length ?? 0) === 1;
  const collectingGate = evidenceCollection ? evidence.activationPlan.collectingGate : null;
  for (const gate of REQUIRED_EXTERNAL_GATES) {
    const result = externalGates[gate] ?? {};
    if (result.ready !== true) {
      if (gate === collectingGate && result.ready === false) continue;
      errors.push(`external gate ${gate} must be confirmed ready`);
      continue;
    }
    if (!recentDate(result.verifiedAt, now) || !populated(result.evidenceRef)) {
      errors.push(`external gate ${gate} needs current referenced staging evidence`);
    }
    for (const proof of REQUIRED_EXTERNAL_GATE_PROOFS[gate] ?? []) {
      if (result[proof] !== true) errors.push(`external gate ${gate} must prove ${proof}`);
    }
  }
  const accessEnrollment = externalGates.workspaceAccessEnrollment ?? {};
  if (accessEnrollment.ready === true) {
    if (accessEnrollment.mode !== "dedicated_workspace_reconciler") errors.push("workspace Access enrollment must use the dedicated workspace reconciler");
    for (const proof of ["clientGroupIsolated", "enrollmentBeforeEmail", "perInvitationReceiptEnforced", "receiptBindsWorkspaceAndEmailHash", "receiptRevocationRaceVerified", "multiWorkspaceRetention", "lastEligibilityRevocation", "staffGroupUnchanged"]) {
      if (accessEnrollment[proof] !== true) errors.push(`workspace Access enrollment must prove ${proof}`);
    }
    if (!populated(accessEnrollment.processorEvidenceRef)) errors.push("workspace Access enrollment needs dedicated processor evidence");
  }
  const attachmentCors = externalGates.requestAttachmentR2CorsAndLeastPrivilege ?? {};
  if (attachmentCors.ready === true) {
    if (attachmentCors.corsArtifact !== "docs/staging/request-attachments-r2-cors.json") errors.push("request attachment gate must identify the reviewed staging CORS artifact");
    for (const proof of ["allowedOriginPutVerified", "outOfScopeOriginDenied", "leastPrivilegeCredentialVerified"]) {
      if (attachmentCors[proof] !== true) errors.push(`request attachment gate must prove ${proof}`);
    }
  }

  for (const app of apps) {
    const secretEvidence = evidence.secrets?.[app] ?? {};
    const names = secretEvidence.names ?? [];
    if (!sameSet(names, REQUIRED_STAGING_SECRETS[app])) errors.push(`${app} secret names must exactly match the approved manifest`);
    if (!recentDate(secretEvidence.verifiedAt, now)) errors.push(`${app} secret-name evidence must be current`);
    if (typeof secretEvidence.workerIsNew !== "boolean") errors.push(`${app} must record whether the staging Worker is new`);
    if (secretEvidence.workerIsNew === true && secretEvidence.source !== "reviewed-secrets-file") errors.push(`${app} new Worker secret evidence must come from a reviewed secrets file`);
    if (secretEvidence.workerIsNew === false && (secretEvidence.source !== "wrangler-secret-list" || !sameSet(secretEvidence.remoteNames ?? [], REQUIRED_STAGING_SECRETS[app]))) errors.push(`${app} existing Worker remote secret names must exactly match the manifest`);
    if (!populated(secretEvidence.evidenceRef)) errors.push(`${app} secret evidence needs a reference`);
  }

  for (const app of ["delivery", "operations"]) {
    const backup = evidence.backups?.[app] ?? {};
    const expectedDb = STAGING_INVENTORY[app].d1_databases[0];
    if (backup.databaseName !== expectedDb.database_name || backup.databaseId !== expectedDb.database_id) errors.push(`${app} backup database identity is incorrect`);
    if (!recentDate(backup.generatedAt, now)) errors.push(`${app} backup must be fresh (within 24 hours)`);
    const file = resolvedBackup(base, backup.path);
    if (!file || !fs.existsSync(file)) errors.push(`${app} backup must exist under .backups`);
    else {
      const stat = fs.statSync(file);
      const bytes = stat.size;
      const generatedAt = Date.parse(backup.generatedAt);
      if (Math.abs(stat.mtimeMs - generatedAt) > 5 * 60 * 1000) errors.push(`${app} backup generatedAt must match file modification time`);
      if (!recentDate(new Date(stat.mtimeMs).toISOString(), now)) errors.push(`${app} backup file modification time must be fresh`);
      if (backup.bytes !== bytes) errors.push(`${app} backup byte count does not match`);
      if (bytes < 256 && backup.confirmedIntentionallyEmpty !== true) errors.push(`${app} small/empty backup requires explicit confirmation`);
      if (!/^[A-F0-9]{64}$/i.test(backup.sha256 ?? "") || sha256(file) !== backup.sha256.toUpperCase()) errors.push(`${app} backup SHA-256 does not match`);
    }
  }

  const deployments = evidence.deployments ?? {};
  for (const app of apps) {
    const deployment = deployments[app] ?? {};
    if (!populated(deployment.versionId)) errors.push(`${app} deployment needs an immutable staging version ID`);
    if (deployment.releaseCommit !== RELEASE_CANDIDATES.operations) errors.push(`${app} deployed release commit must match the immutable Ops runtime candidate`);
    if (typeof deployment.configSha256 !== "string" || deployment.configSha256.toUpperCase() !== configHashes[app]) errors.push(`${app} deployed config SHA-256 must match the reviewed config`);
    if (!recentDate(deployment.deployedAt, now) || !populated(deployment.evidenceRef)) errors.push(`${app} deployment evidence must be current and referenced`);
    for (const proof of ["bindingsVerified", "healthCheckPassed", "hostAdmissionDenied"]) {
      if (deployment[proof] !== true) errors.push(`${app} deployment must prove ${proof}`);
    }
    if (!sameSet(deployment.disabledFeatureFlags, REQUIRED_DISABLED_FEATURE_FLAGS[app] ?? [])) errors.push(`${app} deployed disabled feature flags must exactly match the release contract`);
  }

  const infrastructure = evidence.infrastructure ?? {};
  for (const proof of [
    "remoteInventoryVerified", "dnsTlsAndRoutesVerified", "queuesAndDlqsVerified",
    "eventNotificationsVerified", "cronsVerified", "workflowBindingsVerified",
    "containerBindingAndEntitlementVerified", "r2LifecycleVerified",
    "accessPoliciesVerified", "emailBindingsVerified", "mapboxOriginRestrictionsVerified",
    "observabilityAndAlertDestinationsVerified", "costBudgetsVerified",
  ]) if (infrastructure[proof] !== true) errors.push(`staging infrastructure must prove ${proof}`);
  if (!recentDate(infrastructure.verifiedAt, now) || !populated(infrastructure.evidenceRef)) errors.push("staging infrastructure verification must be current and referenced");

  const rollback = evidence.rollback ?? {};
  for (const app of apps) {
    const target = rollback.targetVersionIds?.[app];
    if (!populated(target)) errors.push(`${app} rollback target version ID is required`);
    else if (target === deployments[app]?.versionId) errors.push(`${app} rollback target must differ from the deployed version`);
  }
  for (const proof of ["drillPassed", "d1FixForwardReviewed", "noDestructiveRollback"]) if (rollback[proof] !== true) errors.push(`rollback must prove ${proof}`);
  if (!recentDate(rollback.testedAt, now) || !populated(rollback.evidenceRef)) errors.push("rollback evidence must be current and referenced");

  const productionState = evidence.productionState ?? {};
  if (productionState.unchanged !== true || !recentDate(productionState.verifiedAt, now) || !populated(productionState.evidenceRef)) {
    errors.push("production unchanged state must be current and referenced");
  }

  errors.push(...validateActivationPlan(evidence.activationPlan, evidence, { now }));

  for (const gate of ["stagingDnsAndRoutes", "stagingMigrations", "stagingDeployment"]) if (evidence.approvals?.[gate] !== true) errors.push(`approval ${gate} must be explicitly recorded`);
  if (evidence.approvals?.productionChanges !== false) errors.push("productionChanges must remain false");
  return errors;
}

export function validateEvidenceFile(base = root, evidenceFile = defaultEvidence, headOverride) {
  if (!fs.existsSync(evidenceFile)) return [`${path.relative(base, evidenceFile)} is missing`];
  try {
    const evidence = JSON.parse(fs.readFileSync(evidenceFile, "utf8"));
    const configs = {};
    const configHashes = {};
    for (const app of apps) {
      const file = path.join(base, "apps", APP_SOURCE_DIRS[app], "wrangler.staging.json");
      configs[app] = JSON.parse(fs.readFileSync(file, "utf8"));
      configHashes[app] = sha256(file);
    }
    const head = headOverride ?? spawnSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" }).stdout.trim();
    const remoteRef = evidence.sourceControl?.remoteRef;
    const safeRemoteRef = typeof remoteRef === "string" && /^(?:origin|upstream)\/[A-Za-z0-9._/-]+$/.test(remoteRef);
    const sourceControlVerified = safeRemoteRef
      && spawnSync("git", ["merge-base", "--is-ancestor", head, remoteRef], { cwd: base, encoding: "utf8" }).status === 0;
    const runtimeSourceControlVerified = safeRemoteRef
      && spawnSync("git", ["merge-base", "--is-ancestor", RELEASE_CANDIDATES.operations, remoteRef], { cwd: base, encoding: "utf8" }).status === 0;
    return validateEvidence(evidence, { base, head, configs, configHashes, sourceControlVerified, runtimeSourceControlVerified });
  } catch (error) { return [`staging release evidence is invalid: ${error.message}`]; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const supplied = process.argv[2] ? path.resolve(process.argv[2]) : defaultEvidence;
  const errors = validateEvidenceFile(root, supplied);
  if (errors.length) {
    console.error("Staging release evidence failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log("Staging release evidence passed. No remote action was performed.");
}
