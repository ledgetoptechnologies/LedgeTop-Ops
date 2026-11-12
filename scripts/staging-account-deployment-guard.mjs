import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderStagingAccountConfigs, STAGING_ACCESS_ISSUER, STAGING_ACCOUNT_ID, STAGING_TARGETS } from "./staging-account-wrangler-configs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIGS = Object.freeze({
  operations: "apps/operations/wrangler.staging-account.jsonc",
  client: "apps/client/wrangler.staging-account.jsonc",
  sync: "apps/ops-sync/wrangler.staging-account.jsonc",
});
const LOGS_OPS_CONFIG = "apps/operations/wrangler.logs-staging-account.jsonc";
const WORKER_MAIN_FILES = Object.freeze({
  [STAGING_TARGETS.operations.name]: "apps/operations/src/worker/index.ts",
  [STAGING_TARGETS.client.name]: "apps/client/src/worker/index.ts",
  [STAGING_TARGETS.operations.assetsWorker]: "apps/ui-release-assets/src/index.ts",
});
const EXPECTED_MAIN = Object.freeze({
  operations: "src/worker/index.ts",
  client: "src/worker/index.ts",
  sync: "src/index.ts",
});

export const DEPLOYMENT_BLOCKERS = Object.freeze([
  "Ops, Client and Sync Workers and their Access applications are provisioned in closed bootstrap state; Merger must reconcile current complete binding and route readbacks with these source configs.",
  "The confirmed Ops, Client and Sync Access applications use deny-all policies and workers.dev remains disabled; keep admission closed until separately reviewed acceptance and exposure decisions.",
  "Sync Access group ID/name, application key and service-only ingress contract remain unallocated or unverified.",
  "Incoming and public delivery hostnames and their account-local Access/public exposure plans remain unresolved.",
  "Target Queues are newly allocated and empty, but legacy backlog, producer mapping and event ownership must be reconciled; keep all target consumers disabled.",
  "Seven target Workflows are allocated with zero instances, but the source configs do not yet bind them; reconcile old execution histories, exact source names and non-replay behavior before wiring or invocation.",
  "No target-account thumbnail Durable Object/container namespace or entitlement readback is recorded.",
  "Client rate-limit namespaces and any other account-scoped limiter identities have not been allocated.",
  "The retained UI-assets Worker, catalog and routing must be read back in Staging; preserve and byte-verify all frontend assets served in the prior 48 hours.",
  "Fresh staging-only secrets and external provider credentials are not prepared; production secret values must not be copied.",
  "The Project Alpha staging origin, source identity, scopes and connector authority are not reconciled for this account migration.",
  "Target D1 schema and migration-ledger parity plus the approved staging data-transfer receipt are not verified.",
  "R2 object and metadata parity, pending work reconciliation and account-local access policy are not verified.",
  "Logs domain/service acceptance and the cross-Worker FLIGHT_LOGS binding are owned by the Logs migration workstream and remain incomplete.",
  "Logs-only Ops profile is closed with FLIGHT_LOGS_ENABLED=false; reconcile Ops and Logs D1 schemas/migration history and approved staging transfer before data use.",
  "Legacy staging dependencies in the Ledge Top production account remain in use until Merger verifies replacement acceptance and approves exact cleanup.",
]);

function readConfig(base, app) {
  const file = app === "logsOperations" ? LOGS_OPS_CONFIG : CONFIGS[app];
  return parseJsonc(fs.readFileSync(path.join(base, file), "utf8"));
}

function parseJsonc(text) {
  let output = "", inString = false, escaped = false, lineComment = false, blockComment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index], next = text[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") { lineComment = false; output += char; }
      else output += " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { output += "  "; index++; blockComment = false; }
      else output += char === "\n" || char === "\r" ? char : " ";
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; output += char; continue; }
    if (char === "/" && next === "/") { output += "  "; index++; lineComment = true; continue; }
    if (char === "/" && next === "*") { output += "  "; index++; blockComment = true; continue; }
    output += char;
  }
  let clean = "", string = false, slash = false;
  for (let index = 0; index < output.length; index++) {
    const char = output[index];
    if (string) {
      clean += char;
      if (slash) slash = false;
      else if (char === "\\") slash = true;
      else if (char === '"') string = false;
      continue;
    }
    if (char === '"') { string = true; clean += char; continue; }
    if (char === ",") {
      let next = index + 1;
      while (/\s/u.test(output[next] ?? "")) next++;
      if (output[next] === "}" || output[next] === "]") continue;
    }
    clean += char;
  }
  return JSON.parse(clean);
}

function add(errors, condition, message) {
  if (!condition) errors.push(message);
}

function inspectConfig(app, config, source) {
  const errors = [];
  const target = STAGING_TARGETS[app];
  add(errors, config.name === target.name, `${app}: Worker name does not match the reviewed target identity`);
  add(errors, config.account_id === STAGING_ACCOUNT_ID, `${app}: account_id must be the separate Staging account`);
  add(errors, config.main === EXPECTED_MAIN[app], `${app}: main must remain ${EXPECTED_MAIN[app]}`);
  if (app === "operations" || app === "client") {
    add(errors, config.assets?.directory === "./dist/client", `${app}: assets.directory must remain the app-local built client directory`);
  }
  add(errors, config.workers_dev === false, `${app}: workers_dev must remain disabled`);
  add(errors, config.preview_urls === false, `${app}: preview URLs must remain disabled`);
  add(errors, Array.isArray(config.routes) && config.routes.length === 0, `${app}: staging routes must remain empty`);
  add(errors, !Object.hasOwn(config, "triggers"), `${app}: cron/scheduled triggers must remain absent`);
  if (app === "operations") {
    add(errors, JSON.stringify(config.queues?.producers) === JSON.stringify([{ binding: "THUMBNAIL_QUEUE", queue: "ledge-top-thumbnail-staging" }]), "operations: only the allocated staging thumbnail queue may be declared as a producer");
    add(errors, !config.queues?.consumers || config.queues.consumers.length === 0, "operations: queue consumers must remain absent until backlog and event ownership review");
  } else add(errors, !Object.hasOwn(config, "queues"), `${app}: queue producers/consumers must remain absent`);
  add(errors, !Object.hasOwn(config, "workflows"), `${app}: Workflow bindings must remain absent until source identities, history and non-replay behavior are reviewed`);
  add(errors, !Object.hasOwn(config, "durable_objects") && !Object.hasOwn(config, "containers"), `${app}: thumbnail Durable Object/container bindings must remain absent until allocation review`);
  add(errors, !Object.hasOwn(config, "send_email") && !Object.hasOwn(config, "stream") && !Object.hasOwn(config, "ratelimits"), `${app}: unallocated provider, mail, Stream or rate-limit bindings must remain absent`);
  add(errors, config.vars?.ENVIRONMENT === "staging", `${app}: ENVIRONMENT must be staging`);
  if (app === "operations") {
    add(errors, config.vars?.TEAM_DOMAIN === STAGING_ACCESS_ISSUER, "operations: TEAM_DOMAIN must use the confirmed Staging Access issuer URL");
    add(errors, config.vars?.OPERATIONS_AUD === STAGING_TARGETS.operations.accessAudience, "operations: OPERATIONS_AUD must match the closed Staging Ops application");
    add(errors, config.vars?.EXPECTED_HOST === new URL(STAGING_TARGETS.operations.origin).host, "operations: EXPECTED_HOST must match the allocated Ops Access host");
    add(errors, config.vars?.DELIVERY_BASE_URL === STAGING_TARGETS.client.origin, "operations: DELIVERY_BASE_URL must match the allocated Client Worker origin");
  } else if (app === "client") {
    add(errors, config.vars?.CLIENT_ACCESS_TEAM_DOMAIN === STAGING_ACCESS_ISSUER, "client: CLIENT_ACCESS_TEAM_DOMAIN must use the confirmed Staging Access issuer URL");
    add(errors, config.vars?.CLIENT_ACCESS_AUD === STAGING_TARGETS.client.accessAudience, "client: CLIENT_ACCESS_AUD must match the closed Staging Client application");
    add(errors, config.vars?.CLIENT_ACCESS_AUDS === STAGING_TARGETS.client.accessAudience, "client: CLIENT_ACCESS_AUDS must match the closed Staging Client application");
    add(errors, config.vars?.EXPECTED_HOST === STAGING_TARGETS.client.host, "client: EXPECTED_HOST must match the allocated Client Access host");
  } else if (app === "sync") {
    add(errors, config.vars?.TEAM_DOMAIN === STAGING_ACCESS_ISSUER, "sync: TEAM_DOMAIN must use the confirmed Staging Access issuer URL");
    add(errors, config.vars?.CF_ACCESS_AUD === STAGING_TARGETS.sync.accessAudience, "sync: CF_ACCESS_AUD must match the closed Staging Sync application");
    add(errors, config.vars?.EXPECTED_HOST === STAGING_TARGETS.sync.host, "sync: EXPECTED_HOST must match the allocated Sync Access host");
  }
  for (const [key, value] of Object.entries(config.vars ?? {})) {
    if (/(?:_ENABLED|_READY)$/.test(key)) add(errors, value === "false", `${app}: ${key} must remain explicitly false`);
    if (key === "PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED") {
      add(errors, value === "true", `${app}: connector source validation must fail closed`);
    } else add(errors, !(typeof value === "string" && value === "true"), `${app}: ${key} may not enable a feature in this closed config`);
  }
  for (const [key, value] of Object.entries(source.vars ?? {})) {
    if (/(?:_ENABLED|_READY)$/.test(key)) add(errors, config.vars?.[key] === "false", `${app}: source feature gate ${key} must be present and false`);
  }

  const serialized = JSON.stringify(config);
  for (const value of [
    "846c924bf17bf4f3dd15c97a4c5d1d51",
    "6ebf7514-d306-4615-ae56-ad869c874dbd",
    "7f40a7b7-c3ec-470e-a626-e798867f71f8",
    "client-data",
    "ltds-ops",
    "ltds-incoming",
    "ledgetop-ops",
    "ledgetop-clients",
    "ledgetoptechnologies.cloudflareaccess.com",
    "ledgetopdroneservices.com",
  ]) add(errors, !serialized.includes(value), `${app}: production or legacy-account value leaked into the Staging config (${value})`);
  return errors;
}

function requireBinding(config, name, serviceName, entrypoint, errors, app) {
  const actual = (config.services ?? []).find((binding) => binding.binding === name);
  add(errors, Boolean(actual), `${app}: missing required service binding ${name}`);
  if (actual) {
    add(errors, actual.service === serviceName, `${app}: ${name} must target ${serviceName}`);
    if (entrypoint) add(errors, actual.entrypoint === entrypoint, `${app}: ${name} must select ${entrypoint}`);
  }
}

function validateEntrypointExports(base, configs, errors) {
  for (const [app, config] of Object.entries(configs)) {
    for (const binding of config.services ?? []) {
      if (!binding.entrypoint) continue;
      const mainPath = WORKER_MAIN_FILES[binding.service];
      if (!mainPath) {
        errors.push(`${app}: ${binding.binding} targets an unreviewed Worker identity ${binding.service}`);
        continue;
      }
      const source = fs.readFileSync(path.join(base, mainPath), "utf8");
      const exported = source.split(/\r?\n/u).some((line) =>
        /^\s*export\s/u.test(line) && new RegExp(`\\b${binding.entrypoint}\\b`, "u").test(line));
      add(errors, exported, `${app}: ${binding.binding} entrypoint ${binding.entrypoint} is not exported by ${mainPath}`);
    }
  }
}

export function validateStagingAccountConfigs(base = root) {
  const errors = [];
  const generated = renderStagingAccountConfigs(base);
  const loaded = {};
  for (const app of Object.keys(CONFIGS)) {
    try {
      loaded[app] = readConfig(base, app);
      add(errors, JSON.stringify(loaded[app]) === JSON.stringify(generated[app]), `${app}: tracked config is stale; regenerate it from current source`);
      const sourcePath = app === "sync" ? "apps/ops-sync/wrangler.jsonc" : `apps/${app}/wrangler.jsonc`;
      errors.push(...inspectConfig(app, loaded[app], JSON.parse(fs.readFileSync(path.join(base, sourcePath), "utf8"))));
    } catch (error) {
      errors.push(`${app}: configuration could not be validated (${error.message})`);
    }
  }
  validateEntrypointExports(base, loaded, errors);

  errors.push(...validateLogsStagingConfig(base));

  try {
    const actual = readConfig(base, "logsOperations");
    const expected = generated.logsOperations;
    add(errors, JSON.stringify(actual) === JSON.stringify(expected), "logsOperations: tracked config is stale; regenerate it from current source");
    add(errors, actual.name === STAGING_TARGETS.operations.name, "logsOperations: Worker name must match the Staging Ops allocation");
    add(errors, actual.account_id === STAGING_ACCOUNT_ID, "logsOperations: account_id must be the separate Staging account");
    add(errors, actual.workers_dev === false && actual.preview_urls === false && Array.isArray(actual.routes) && actual.routes.length === 0,
      "logsOperations: public Workers.dev, preview URLs and custom routes must remain disabled");
    add(errors, actual.vars?.FLIGHT_LOGS_ENABLED === "false", "logsOperations: FLIGHT_LOGS_ENABLED must remain explicitly false");
    add(errors, actual.vars?.ENVIRONMENT === "staging", "logsOperations: ENVIRONMENT must be staging");
    add(errors, actual.vars?.TEAM_DOMAIN === STAGING_ACCESS_ISSUER, "logsOperations: TEAM_DOMAIN must use the confirmed Staging Access issuer URL");
    add(errors, actual.vars?.OPERATIONS_AUD === STAGING_TARGETS.operations.accessAudience, "logsOperations: OPERATIONS_AUD must match the closed Staging Ops application");
    add(errors, actual.vars?.EXPECTED_HOST === new URL(STAGING_TARGETS.operations.origin).host, "logsOperations: EXPECTED_HOST must match the allocated Ops host");
    add(errors, actual.assets?.run_worker_first?.includes("/fleet"), "logsOperations: /fleet must route through the Worker");
    add(errors, actual.d1_databases?.length === 1 && actual.d1_databases[0]?.database_id === STAGING_TARGETS.operations.opsDb.id,
      "logsOperations: only the allocated Staging Ops D1 may be bound");
    add(errors, actual.services?.length === 1 && actual.services[0]?.binding === "FLIGHT_LOGS"
      && actual.services[0]?.service === "ledge-top-logs-staging" && actual.services[0]?.entrypoint === "FlightLogsService",
      "logsOperations: only the allocated Logs Worker FlightLogsService may be bound");
    const opsSource = fs.readFileSync(path.join(base, WORKER_MAIN_FILES[STAGING_TARGETS.operations.name]), "utf8");
    add(errors, /^\s*export\s*\{\s*StaffDirectory\s*\}\s*from\s*["']\.\/staff-directory["']/m.test(opsSource),
      "logsOperations: Ops source does not export StaffDirectory for the Logs cross-Worker binding");
  } catch (error) {
    errors.push(`logsOperations: configuration could not be validated (${error.message})`);
  }

  if (loaded.operations) {
    const portal = STAGING_TARGETS.client.name;
    for (const [name, entrypoint] of [
      ["CLIENT_AUTHORITY_WORKSPACE_BINDING", "ClientAuthorityWorkspaceBindingIngress"],
      ["CLIENT_PORTAL_AUTHORITY_V2", "ClientPortalAuthorityV2Ingress"],
      ["CLIENT_PORTAL_ACCESS_AUTHORITY", "OpsPortalAccessAuthorityIngress"],
      ["OPS_INVENTORY_CATALOG_PROMOTION", "OpsInventoryCatalogPromotionCoordinator"],
      ["OPS_INVENTORY_CATALOG_STAGING", "OpsInventoryCatalogStagingIngress"],
      ["VERIFIED_RECIPIENT_DELIVERY_AUTHORITY", "VerifiedRecipientDeliveryAuthorityIngress"],
    ]) requireBinding(loaded.operations, name, portal, entrypoint, errors, "operations");
  }
  if (loaded.client) {
    const ops = STAGING_TARGETS.operations.name;
    for (const [name, entrypoint] of [
      ["CLIENT_ONBOARDING_RECIPIENT_BRIDGE", "ClientOnboardingRecipientBridge"],
      ["CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE", "ClientPortalRecipientEnrollmentBridge"],
      ["OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES", "OperationsNativePrincipalInquiryIngress"],
    ]) requireBinding(loaded.client, name, ops, entrypoint, errors, "client");
  }
  return { errors, blockers: [...DEPLOYMENT_BLOCKERS], ready: errors.length === 0 && DEPLOYMENT_BLOCKERS.length === 0 };
}

export function validateLogsStagingConfig(base = root) {
  const errors = [];
  try {
    const config = parseJsonc(fs.readFileSync(path.join(base, "apps/logs/wrangler.staging.jsonc"), "utf8"));
    add(errors, config.name === "ledge-top-logs-staging", "logs: Worker name must match the allocated Logs Worker");
    add(errors, config.account_id === STAGING_ACCOUNT_ID, "logs: account_id must be the separate Staging account");
    add(errors, config.main === "src/worker/index.mjs", "logs: main must remain src/worker/index.mjs");
    add(errors, config.workers_dev === false, "logs: workers_dev must remain disabled");
    add(errors, config.preview_urls === false, "logs: preview URLs must remain disabled");
    add(errors, Array.isArray(config.routes) && config.routes.length === 0, "logs: staging routes must remain empty");
    const databases = config.d1_databases ?? [];
    add(errors, databases.length === 1 && databases[0]?.binding === "LOGS_DB"
      && databases[0]?.database_name === "ledge-top-logs-staging"
      && databases[0]?.database_id === "33542156-96f0-4e83-8bf4-406cb1228640",
    "logs: LOGS_DB must match the allocated Staging D1 database");
    const buckets = config.r2_buckets ?? [];
    add(errors, buckets.length === 1 && buckets[0]?.binding === "LOGS_BUCKET"
      && buckets[0]?.bucket_name === "ledge-top-logs-staging",
    "logs: LOGS_BUCKET must match the allocated Staging bucket");
    const services = config.services ?? [];
    add(errors, services.length === 1 && services[0]?.binding === "OPS_DIRECTORY"
      && services[0]?.service === STAGING_TARGETS.operations.name
      && services[0]?.entrypoint === "StaffDirectory",
    "logs: OPS_DIRECTORY must target the Staging Ops StaffDirectory entrypoint");
  } catch (error) {
    errors.push(`logs: configuration could not be validated (${error.message})`);
  }
  return errors;
}

export function run(argv = process.argv.slice(2), base = root) {
  if (argv.length !== 0) throw new Error("usage: node scripts/staging-account-deployment-guard.mjs");
  const result = validateStagingAccountConfigs(base);
  if (result.errors.length) {
    console.error("Staging account config guard: INVALID AND BLOCKED; no provider action performed.");
    for (const error of result.errors) console.error(`- ${error}`);
  } else if (result.blockers.length) {
    console.log("Staging account config guard: BLOCKED; no provider action performed.");
  } else {
    console.log("Staging account config guard: READY FOR MERGER REVIEW; no provider action performed.");
    return 0;
  }
  console.log("Open migration prerequisites:");
  for (const blocker of result.blockers) console.log(`- ${blocker}`);
  return result.errors.length ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(); }
  catch (error) { console.error(`Staging account config guard failed: ${error.message}`); process.exitCode = 2; }
}
