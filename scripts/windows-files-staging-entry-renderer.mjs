import { isDeepStrictEqual } from "node:util";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { WINDOWS_STAGING_EXPORT_POLICY } from "./windows-files-staging-exports.mjs";

export const WINDOWS_STAGING_SECRET_SLOTS = Object.freeze({
  operations: ["WINDOWS_EMPLOYEE_GATEWAY_SIGNING_KEY", "WINDOWS_EMPLOYEE_HANDLE_KEY", "WINDOWS_EMPLOYEE_QUEUE_KEY"],
  delivery: ["WINDOWS_PORTAL_QUEUE_KEY"],
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function reject() { throw Error("windows_staging_composition_inputs_invalid"); }
function exact(value, names) { return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() === [...names].sort().join(); }
/** Public compile metadata only. This validates neither a gateway runtime nor deployment configuration. */
export function validateWindowsStagingProfile(profile) {
  if (!exact(profile, ["schemaVersion", "enabled", "gateway", "secretSlots"]) || profile.schemaVersion !== 1 || typeof profile.enabled !== "boolean"
    || !exact(profile.gateway, ["origin", "gatewayId", "keyId"]) || !UUID.test(profile.gateway.gatewayId)
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(profile.gateway.keyId) || !isDeepStrictEqual(profile.secretSlots, WINDOWS_STAGING_SECRET_SLOTS)) reject();
  let origin;
  try { origin = new URL(profile.gateway.origin); } catch { reject(); }
  if (origin.protocol !== "https:" || origin.origin !== profile.gateway.origin || origin.port || origin.username || origin.password
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-)?staging\.(?:ledgetopdroneservices|ledgetoptechnologies)\.com$/u.test(origin.hostname)
    || origin.origin === "https://ops-staging.ledgetopdroneservices.com") reject();
}
/** Shared renderer only; callers retain their separate admission contracts. */
export function renderWindowsStagingEntries(profile) {
  validateWindowsStagingProfile(profile);
  const entries = {};
  const deployment = { accountId: STAGING_ACCOUNT_ID, workerName: STAGING_INVENTORY.delivery.name,
    databaseId: STAGING_INVENTORY.delivery.d1_databases.find(b => b.binding === "DELIVERY_DB").database_id,
    bucketName: STAGING_INVENTORY.delivery.r2_buckets.find(b => b.binding === "DATA_BUCKET").bucket_name,
    opsReaderWorkerName: STAGING_INVENTORY.operations.name };
  entries.operations = `// Generated public metadata only. Never add secrets.\nimport standard from "../src/worker/staging-native-authority-entrypoint";\nimport {createWindowsEmployeeStagingWorker} from "../src/worker/windows-files-staging-worker";\nexport {${WINDOWS_STAGING_EXPORT_POLICY.operations.runtime.join(',')}} from "../src/worker/staging-native-authority-entrypoint";\nexport default createWindowsEmployeeStagingWorker(${JSON.stringify({ enabled: profile.enabled, gateway: profile.gateway })},standard);\n`;
  entries.delivery = `// Generated public metadata only. Never add secrets.\nimport standard from "../src/worker/index";\nimport {createWindowsPortalStagingWorker} from "../src/worker/client-portal/windows-files-staging-worker";\nexport {${WINDOWS_STAGING_EXPORT_POLICY.delivery.runtime.join(',')}} from "../src/worker/index";\nexport default createWindowsPortalStagingWorker(${JSON.stringify({ enabled: profile.enabled, deployment })},standard);\n`;
  return entries;
}
