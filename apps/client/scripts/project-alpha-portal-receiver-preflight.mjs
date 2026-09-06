import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePortalReleaseProfile } from "../../../scripts/client-portal-release-profile.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(directory, "..");
const defaultConfigPath = path.join(appDirectory, "wrangler.jsonc");
const repositoryDirectory = path.resolve(appDirectory, "../..");
const releaseProfilePath = path.join(repositoryDirectory, "scripts/client-portal-release-profile.json");
const operationsConfigPath = path.join(repositoryDirectory, "apps/operations/wrangler.jsonc");
const disabledReceiverAdjacentFlags = Object.freeze([
  "CLIENT_PORTAL_CONTENT_AUDIT_ENABLED",
  "CLIENT_PORTAL_REQUEST_V2_ENABLED",
  "CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED",
  "PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED",
  "CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED",
  "CLIENT_REQUEST_ATTACHMENTS_ENABLED",
  "CLIENT_PORTAL_TEAM_ENABLED",
  "CLIENT_VIEWER_ENABLED",
  "CLIENT_VIEWER_SHARES_ENABLED",
  "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED",
  "CLIENT_PORTAL_PEER_ADMIN_ENABLED",
  "CLIENT_PORTAL_ADDRESS_BOOK_ENABLED",
  "CLIENT_PORTAL_ACCESS_ENROLLMENT_READY",
  "CLIENT_PORTAL_INVITATION_EMAIL_ENABLED",
  "CLIENT_DELEGATED_SHARES_ENABLED",
]);
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function parseSecretNames(value) {
  if (!Array.isArray(value)) throw new Error("Wrangler secret inventory must be a JSON array");
  const names = value.map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.name : null);
  if (names.some((name) => typeof name !== "string" || !name)) throw new Error("Wrangler secret inventory contains an invalid entry");
  return new Set(names);
}

function validatePortalCommonPreflight(config, secretNames) {
  const errors = [];
  const vars = config?.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return ["Client Wrangler config is missing vars"];
  if (vars.PROJECT_ALPHA_PORTAL_SYNC_ENABLED !== "true") errors.push("PROJECT_ALPHA_PORTAL_SYNC_ENABLED must be exactly true for the portal release");
  if (vars.PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED !== "false") errors.push("PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED must remain exactly false; Project Alpha writes enter through Ops Sync");
  if (vars.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED !== "true") errors.push("CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED must be exactly true for schema-v3 ingestion");
  for (const flag of disabledReceiverAdjacentFlags) if (vars[flag] !== "false") errors.push(`${flag} must remain exactly false for the portal release`);
  if (!safeId.test(vars.PROJECT_ALPHA_PORTAL_APPLICATION_KEY ?? "")) errors.push("PROJECT_ALPHA_PORTAL_APPLICATION_KEY is invalid");
  return errors;
}

// Retained strict receiver-only entry point: callers cannot implicitly opt into activation.
export function validatePortalReceiverPreflight(config, secretNames = new Set()) {
  const errors = validatePortalCommonPreflight(config, secretNames);
  if (!config?.vars || typeof config.vars !== "object" || Array.isArray(config.vars)) return errors;
  for (const flag of ["CLIENT_PORTAL_HIERARCHY_V2_ENABLED", "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED", "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED", "CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED",
    "AUTHENTICATED_DELIVERY_GRANTS_ENABLED", "PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED", "AUTHENTICATED_DELIVERY_CREATION_ENABLED"]) {
    if (config.vars[flag] !== "false") errors.push(`${flag} must remain exactly false for the receiver-only release`);
  }
  const denyManagement = config.vars.CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED;
  if (denyManagement !== undefined && denyManagement !== "false") errors.push("CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED must remain absent or exactly false for the receiver-only release");
  return errors;
}

export function validatePortalReleasePreflight(config, operationsConfig, declaration, secretNames = new Set()) {
  return [
    ...validatePortalReleaseProfile(declaration, config, operationsConfig),
    ...validatePortalCommonPreflight(config, secretNames),
  ];
}

function readConfig(configPath) {
  try { return JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch (error) { throw new Error(`Unable to read portal release input ${path.basename(configPath)}: ${error instanceof Error ? error.message : "invalid JSON"}`); }
}

export function runPortalReceiverPreflight(configPath = defaultConfigPath, secretNames) {
  const config = readConfig(configPath);
  const errors = validatePortalReceiverPreflight(config, secretNames);
  if (errors.length) throw new Error(`Project Alpha portal receiver preflight failed:\n- ${errors.join("\n- ")}`);
  return config.name;
}

export function runPortalReleasePreflight(secretNames) {
  const config = readConfig(defaultConfigPath);
  const operationsConfig = readConfig(operationsConfigPath);
  const declaration = readConfig(releaseProfilePath);
  // Reject invalid local intent before any remote inventory call.
  const profileErrors = [
    ...validatePortalReleaseProfile(declaration, config, operationsConfig),
    ...validatePortalCommonPreflight(config),
  ];
  if (profileErrors.length) throw new Error(`Portal release profile preflight failed:\n- ${profileErrors.join("\n- ")}`);
  const errors = validatePortalReleasePreflight(config, operationsConfig, declaration, secretNames);
  if (errors.length) throw new Error(`Project Alpha portal release preflight failed:\n- ${errors.join("\n- ")}`);
  return { worker: config.name, profile: declaration.profile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { worker, profile } = runPortalReleasePreflight();
    console.log(`Project Alpha portal release preflight passed for ${worker} (${profile}). Secret values were not read. Deployed flags, migrations, and approval require separate verification.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Project Alpha portal receiver preflight failed");
    process.exitCode = 1;
  }
}
