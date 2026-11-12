import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderStagingAccountConfigs, STAGING_ACCOUNT_ID, STAGING_TARGETS } from "./staging-account-wrangler-configs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIGS = Object.freeze({
  operations: "apps/operations/wrangler.staging-account.jsonc",
  client: "apps/client/wrangler.staging-account.jsonc",
  sync: "apps/ops-sync/wrangler.staging-account.jsonc",
});
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
  "Merger has not completed the target-account Worker binding and route readback for all three proposed Workers.",
  "The Staging Access team issuer/domain needs current owner readback; only the Ops audience/app/host is allocated.",
  "Portal Access application, audience, protected host and policy have not been allocated or reviewed.",
  "Sync Access application, audience, service-only ingress policy and access-group identity have not been allocated or reviewed.",
  "Incoming and public delivery hostnames and their account-local Access/public exposure plans remain unresolved.",
  "Target Queues are newly allocated and empty, but legacy backlog, producer mapping and event ownership must be reconciled; keep all target consumers disabled.",
  "No target-account Workflows are allocated; reconcile old execution histories and names before creating replacements.",
  "No target-account thumbnail Durable Object/container namespace or entitlement readback is recorded.",
  "Client rate-limit namespaces and any other account-scoped limiter identities have not been allocated.",
  "The retained UI-assets Worker, catalog and routing must be read back in Staging; preserve and byte-verify all frontend assets served in the prior 48 hours.",
  "Fresh staging-only secrets and external provider credentials are not prepared; production secret values must not be copied.",
  "The Project Alpha staging origin, source identity, scopes and connector authority are not reconciled for this account migration.",
  "Target D1 schema and migration-ledger parity plus the approved staging data-transfer receipt are not verified.",
  "R2 object and metadata parity, pending work reconciliation and account-local access policy are not verified.",
  "Logs domain/service acceptance and the cross-Worker FLIGHT_LOGS binding are owned by the Logs migration workstream and remain incomplete.",
  "Legacy staging dependencies in the Ledge Top production account remain in use until Merger verifies replacement acceptance and approves exact cleanup.",
]);

function readConfig(base, app) {
  return JSON.parse(fs.readFileSync(path.join(base, CONFIGS[app]), "utf8"));
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
  add(errors, !Object.hasOwn(config, "workflows"), `${app}: Workflow bindings must remain absent until allocation and history review`);
  add(errors, !Object.hasOwn(config, "durable_objects") && !Object.hasOwn(config, "containers"), `${app}: thumbnail Durable Object/container bindings must remain absent until allocation review`);
  add(errors, !Object.hasOwn(config, "send_email") && !Object.hasOwn(config, "stream") && !Object.hasOwn(config, "ratelimits"), `${app}: unallocated provider, mail, Stream or rate-limit bindings must remain absent`);
  add(errors, config.vars?.ENVIRONMENT === "staging", `${app}: ENVIRONMENT must be staging`);
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
