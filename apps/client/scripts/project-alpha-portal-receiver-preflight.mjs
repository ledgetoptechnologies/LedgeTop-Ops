import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(directory, "..");
const defaultConfigPath = path.join(appDirectory, "wrangler.jsonc");
const requiredSecret = "PROJECT_ALPHA_PORTAL_HMAC_SECRET";
const previousSecret = "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET";
const disabledReceiverAdjacentFlags = Object.freeze([
  "CLIENT_PORTAL_CONTENT_AUDIT_ENABLED",
  "CLIENT_PORTAL_REQUEST_V2_ENABLED",
  "CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED",
  "PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED",
  "CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED",
  "CLIENT_REQUEST_ATTACHMENTS_ENABLED",
  "CLIENT_PORTAL_TEAM_ENABLED",
  "CLIENT_PORTAL_HIERARCHY_V2_ENABLED",
  "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED",
  "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED",
  "AUTHENTICATED_DELIVERY_GRANTS_ENABLED",
  "CLIENT_VIEWER_ENABLED",
  "CLIENT_VIEWER_SHARES_ENABLED",
  "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED",
  "PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED",
  "CLIENT_PORTAL_PEER_ADMIN_ENABLED",
  "CLIENT_PORTAL_ADDRESS_BOOK_ENABLED",
  "CLIENT_PORTAL_ACCESS_ENROLLMENT_READY",
  "CLIENT_PORTAL_INVITATION_EMAIL_ENABLED",
  "CLIENT_DELEGATED_SHARES_ENABLED",
]);
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function exactHttpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function parseSecretNames(value) {
  if (!Array.isArray(value)) throw new Error("Wrangler secret inventory must be a JSON array");
  const names = value.map((entry) => typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.name : null);
  if (names.some((name) => typeof name !== "string" || !name)) throw new Error("Wrangler secret inventory contains an invalid entry");
  return new Set(names);
}

export function validatePortalReceiverPreflight(config, secretNames) {
  const errors = [];
  const vars = config?.vars;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return ["Client Wrangler config is missing vars"];
  if (vars.PROJECT_ALPHA_PORTAL_SYNC_ENABLED !== "true") errors.push("PROJECT_ALPHA_PORTAL_SYNC_ENABLED must be exactly true for the receiver-only release");
  if (vars.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED !== "true") errors.push("CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED must be exactly true for schema-v3 ingestion");
  for (const flag of disabledReceiverAdjacentFlags) if (vars[flag] !== "false") errors.push(`${flag} must remain exactly false for the receiver-only release`);
  if (!safeId.test(vars.PROJECT_ALPHA_PORTAL_APPLICATION_KEY ?? "")) errors.push("PROJECT_ALPHA_PORTAL_APPLICATION_KEY is invalid");
  if (!safeId.test(vars.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID ?? "")) errors.push("PROJECT_ALPHA_PORTAL_HMAC_KEY_ID is invalid");
  if (!/^[a-f0-9]{64}$/i.test(vars.PROJECT_ALPHA_PORTAL_ACCESS_AUD ?? "")) errors.push("PROJECT_ALPHA_PORTAL_ACCESS_AUD must be a 64-character Access audience");
  if (!exactHttpsOrigin(vars.PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN)) errors.push("PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN must be an exact HTTPS origin");
  if (!secretNames.has(requiredSecret)) errors.push(`${requiredSecret} is not installed on ${config.name ?? "the Client Worker"}`);
  const previousKeyId = vars.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID ?? "";
  const hasPreviousSecret = secretNames.has(previousSecret);
  if (previousKeyId) {
    if (!safeId.test(previousKeyId) || previousKeyId === vars.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID) errors.push("PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID is invalid");
    if (!hasPreviousSecret) errors.push(`${previousSecret} is required while PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID is configured`);
  } else if (hasPreviousSecret) errors.push(`${previousSecret} must be removed when no previous key ID is configured`);
  return errors;
}

function readConfig(configPath) {
  try { return JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch (error) { throw new Error(`Unable to read Client Wrangler config: ${error instanceof Error ? error.message : "invalid JSON"}`); }
}

function readRemoteSecrets(configPath) {
  const wrangler = path.join(appDirectory, "node_modules", "wrangler", "bin", "wrangler.js");
  const result = spawnSync(process.execPath, [wrangler, "secret", "list", "--format", "json", "--config", configPath], {
    cwd: appDirectory, encoding: "utf8", windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Unable to verify remote Client Worker secrets${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  try { return parseSecretNames(JSON.parse(result.stdout)); }
  catch (error) { throw new Error(`Unable to parse Wrangler secret inventory: ${error instanceof Error ? error.message : "invalid JSON"}`); }
}

export function runPortalReceiverPreflight(configPath = defaultConfigPath, secretNames) {
  const config = readConfig(configPath);
  const errors = validatePortalReceiverPreflight(config, secretNames ?? readRemoteSecrets(configPath));
  if (errors.length) throw new Error(`Project Alpha portal receiver preflight failed:\n- ${errors.join("\n- ")}`);
  return config.name;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const worker = runPortalReceiverPreflight();
    console.log(`Project Alpha portal receiver preflight passed for ${worker}. Secret values were not read.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Project Alpha portal receiver preflight failed");
    process.exitCode = 1;
  }
}
