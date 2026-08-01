import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { APP_SOURCE_DIRS, REQUIRED_STAGING_MIGRATIONS, REQUIRED_STAGING_SECRETS, STAGING_ACCESS_AUDS, STAGING_ACCOUNT_ID, STAGING_CLIENT_PORTAL, STAGING_HOSTS, STAGING_INVENTORY, STAGING_STATIC_VARS } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultEvidence = path.join(root, ".backups", "staging-release-evidence.json");
const marker = /<[^>]+>|CHANGE[_-]?ME|REPLACE[_-]?ME|example\.invalid/i;
const apps = ["delivery", "operations", "ops-sync"];
const populated = (value) => typeof value === "string" && value.length > 0 && !marker.test(value);

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

export function validateEvidence(evidence, options = {}) {
  const base = options.base ?? root;
  const head = options.head ?? "";
  const configs = options.configs ?? {};
  const configHashes = options.configHashes ?? {};
  const now = options.now ?? Date.now();
  const errors = [];

  if (!/^[a-f0-9]{40}$/i.test(evidence.releaseCommit ?? "") || evidence.releaseCommit !== head) errors.push("releaseCommit must equal the exact local HEAD SHA");
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
  for (const gate of ["operationsReadCredentialReady", "opsSyncServiceAuthReady", "opsSyncAccessGroupReady", "ed25519Ready"]) if (projectAlpha[gate] !== true) errors.push(`Project Alpha ${gate} must be confirmed true`);
  if (projectAlpha.paymentBillingContractReady !== true) errors.push("Project Alpha paymentBillingContractReady must be confirmed true");
  if (projectAlpha.authorizationBypassUsed !== false) errors.push("Project Alpha must not bypass LTDS authorization");

  for (const [name, hostname] of Object.entries(STAGING_HOSTS)) {
    const host = evidence.hosts?.[name] ?? {};
    if (host.hostname !== hostname) errors.push(`${name} hostname does not match the approved staging topology`);
    if (name === "incoming") {
      if (host.published !== false) errors.push("incoming staging hostname must remain unpublished");
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
  }
  if (migrations.productionUnchanged !== true) errors.push("production migrations must be confirmed unchanged");

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
    return validateEvidence(evidence, { base, head, configs, configHashes });
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
