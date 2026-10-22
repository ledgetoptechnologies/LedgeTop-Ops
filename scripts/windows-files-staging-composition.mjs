import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { WINDOWS_STAGING_EXPORT_POLICY } from "./windows-files-staging-exports.mjs";

export const WINDOWS_STAGING_SECRET_SLOTS = Object.freeze({
  operations: ["WINDOWS_EMPLOYEE_GATEWAY_SIGNING_KEY", "WINDOWS_EMPLOYEE_HANDLE_KEY", "WINDOWS_EMPLOYEE_QUEUE_KEY"],
  delivery: ["WINDOWS_PORTAL_QUEUE_KEY"],
});
const ORIGINS = { operations: "https://ops-staging.ledgetopdroneservices.com", delivery: "https://portal-staging.ledgetopdroneservices.com" };
const AUDIENCES = { operations: "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b", delivery: "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc" };
const ISSUER = "https://ledgetoptechnologies.cloudflareaccess.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function reject() { throw Error("windows_staging_composition_inputs_invalid"); }
function exact(value, names) { return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() === [...names].sort().join(); }

/** Pure public-artifact constructor: no secret reads, cloud calls, migration or
 * deployment. Consistency with an observation is not signed approval or proof
 * of remote ownership. Re-read physical bindings before eventual activation. */
export function buildWindowsStagingComposition({ profile, preflight, sources }) {
  if (!exact(profile, ["schemaVersion", "enabled", "gateway", "secretSlots"]) || profile.schemaVersion !== 1 || typeof profile.enabled !== "boolean"
    || !exact(profile.gateway, ["origin", "gatewayId", "keyId"]) || !UUID.test(profile.gateway.gatewayId)
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(profile.gateway.keyId) || !isDeepStrictEqual(profile.secretSlots, WINDOWS_STAGING_SECRET_SLOTS)) reject();
  let origin;
  try { origin = new URL(profile.gateway.origin); } catch { reject(); }
  if (origin.protocol !== "https:" || origin.origin !== profile.gateway.origin || origin.port || origin.username || origin.password
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-)?staging\.(?:ledgetopdroneservices|ledgetoptechnologies)\.com$/u.test(origin.hostname)
    || origin.origin === ORIGINS.operations) reject();
  if (preflight?.status !== "read_only_observed" || preflight.accountId !== STAGING_ACCOUNT_ID || preflight.versionBindingsMatchedInventory !== true
    || !Array.isArray(preflight.workers) || preflight.workers.length !== 2 || new Set(preflight.workers.map(w => w.app)).size !== 2) reject();
  const configs = {}, entries = {};
  for (const app of ["operations", "delivery"]) {
    const inventory = STAGING_INVENTORY[app], worker = preflight.workers.find(w => w.app === app), source = sources?.[app];
    if (!worker || worker.workerName !== inventory.name || worker.origin !== ORIGINS[app] || worker.audience !== AUDIENCES[app] || worker.issuer !== ISSUER
      || !UUID.test(worker.versionId) || !source || source.name !== inventory.name || source.account_id !== STAGING_ACCOUNT_ID || source.main !== inventory.main
      || source.workers_dev !== false || source.preview_urls !== false || source.vars?.ENVIRONMENT !== "staging"
      || !isDeepStrictEqual(source.d1_databases, inventory.d1_databases) || !isDeepStrictEqual(source.r2_buckets, inventory.r2_buckets)
      || !isDeepStrictEqual(worker.databases, inventory.d1_databases.map(b => ({ binding: b.binding, name: b.database_name, id: b.database_id })))
      || !isDeepStrictEqual(worker.buckets, inventory.r2_buckets.map(b => ({ binding: b.binding, name: b.bucket_name })))
      || worker.foreignKeyViolationCount !== 0 || profile.enabled && worker.migrations?.status !== "suffix_applied") reject();
    if (!Array.isArray(source.services) || source.services.some(service => !inventory.services.some(expected => isDeepStrictEqual(service, expected)))
      || new Set(source.services.map(s => s.binding)).size !== source.services.length) reject();
    const services = source.services.map(s => ({ binding: s.binding, workerName: s.service, entrypoint: s.entrypoint })).sort((a,b) => a.binding.localeCompare(b.binding));
    if (!Array.isArray(worker.services) || !isDeepStrictEqual(services, [...worker.services].sort((a,b) => a.binding.localeCompare(b.binding)))) reject();
    const permittedHosts = app === "operations" ? [new URL(ORIGINS.operations).host]
      : [...inventory.routes.map(r => r.pattern), new URL(ORIGINS.delivery).host];
    if (!Array.isArray(source.routes) || !source.routes.length || source.routes.some(r => r.custom_domain !== true || !permittedHosts.includes(r.pattern))
      || source.assets?.binding !== "ASSETS" || !Array.isArray(source.assets.run_worker_first) || !source.assets.run_worker_first.includes("/api/*")) reject();
    const requiredService = app === "delivery" ? "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER" : "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION";
    if (!source.services.some(s => s.binding === requiredService) || !worker.services?.some(s => s.binding === requiredService
      && inventory.services.some(i => i.binding === s.binding && i.service === s.workerName && i.entrypoint === s.entrypoint))) reject();
    if (profile.enabled && WINDOWS_STAGING_SECRET_SLOTS[app].some(slot => !worker.secretSlots?.includes(slot))) reject();
    const vars = source.vars;
    if (vars.TEAM_DOMAIN !== ISSUER || app === "operations" && (vars.PUBLIC_BASE_URL !== ORIGINS.operations || vars.EXPECTED_HOST !== new URL(ORIGINS.operations).host || vars.OPERATIONS_AUD !== AUDIENCES.operations)
      || app === "delivery" && (vars.CLIENT_PORTAL_ORIGIN !== ORIGINS.delivery || vars.CLIENT_ACCESS_TEAM_DOMAIN !== ISSUER || vars.CLIENT_ACCESS_AUD !== AUDIENCES.delivery)) reject();
    // Never serialize a dedicated server key into generated source/config.
    if (Object.keys(WINDOWS_STAGING_SECRET_SLOTS).flatMap(k => WINDOWS_STAGING_SECRET_SLOTS[k]).some(slot => Object.hasOwn(vars, slot))) reject();
    const candidate = structuredClone(source);
    candidate.main = ".windows-files-staging/entrypoint.ts";
    if (profile.enabled) {
      if (app === "operations") {
        candidate.vars.OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED = "true";
        const flags = source.compatibility_flags ?? [];
        if (!Array.isArray(flags) || flags.some(flag => typeof flag !== "string") || flags.includes("disable_request_signal")) reject();
        candidate.compatibility_flags = flags.filter((flag, index) => flag !== "enable_request_signal" || flags.indexOf(flag) === index);
        if (!candidate.compatibility_flags.includes("enable_request_signal")) candidate.compatibility_flags.push("enable_request_signal");
      }
      else Object.assign(candidate.vars, { CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: "true" });
    }
    configs[app] = candidate;
  }
  const deployment = { accountId: STAGING_ACCOUNT_ID, workerName: STAGING_INVENTORY.delivery.name,
    databaseId: STAGING_INVENTORY.delivery.d1_databases.find(b => b.binding === "DELIVERY_DB").database_id,
    bucketName: STAGING_INVENTORY.delivery.r2_buckets.find(b => b.binding === "DATA_BUCKET").bucket_name,
    opsReaderWorkerName: STAGING_INVENTORY.operations.name };
  entries.operations = `// Generated public metadata only. Never add secrets.\nimport standard from "../src/worker/staging-native-authority-entrypoint";\nimport {createWindowsEmployeeStagingWorker} from "../src/worker/windows-files-staging-worker";\nexport {${WINDOWS_STAGING_EXPORT_POLICY.operations.runtime.join(',')}} from "../src/worker/staging-native-authority-entrypoint";\nexport default createWindowsEmployeeStagingWorker(${JSON.stringify({ enabled: profile.enabled, gateway: profile.gateway })},standard);\n`;
  entries.delivery = `// Generated public metadata only. Never add secrets.\nimport standard from "../src/worker/index";\nimport {createWindowsPortalStagingWorker} from "../src/worker/client-portal/windows-files-staging-worker";\nexport {${WINDOWS_STAGING_EXPORT_POLICY.delivery.runtime.join(',')}} from "../src/worker/index";\nexport default createWindowsPortalStagingWorker(${JSON.stringify({ enabled: profile.enabled, deployment })},standard);\n`;
  return { configs, entries, receipt: { schemaVersion: 1, status: "source_composition_only", enabled: profile.enabled,
    profileSha256: hash(profile), preflightSha256: hash(preflight), configSha256: Object.fromEntries(Object.entries(configs).map(([k,v]) => [k,hash(v)])),
    entrySha256: Object.fromEntries(Object.entries(entries).map(([k,v]) => [k,createHash("sha256").update(v).digest("hex")])),
    secretSlots: WINDOWS_STAGING_SECRET_SLOTS, physicallyVerified: false, activated: false, secretsRead: false,
    note: "Reviewed-input consistency only; matching hashes are not independent approval, physical ownership or deployment evidence." } };
}
