import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_SOURCE_DIRS, REQUIRED_STAGING_SECRETS, STAGING_ACCESS_AUDS, STAGING_ACCOUNT_ID, STAGING_HOSTS, STAGING_INVENTORY, STAGING_STATIC_VARS } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apps = ["delivery", "operations", "ops-sync"];
const markers = /<[^>]+>|CHANGE[_-]?ME|REPLACE[_-]?ME|example\.invalid/i;
const disabled = ["CLIENT_PORTAL_ENABLED", "CLOUD_TRANSFER_DROPBOX_ENABLED", "CLOUD_TRANSFER_GOOGLE_ENABLED", "CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED", "DROPBOX_IMPORT_ENABLED", "DIRECT_DELIVERY_UPLOADS_ENABLED", "R2_PURGE_ENABLED"];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const mapped = (entries = [], key) => new Map(entries.map((item) => [item.binding, item[key]]));
const routeHosts = (config) => (config.routes ?? []).map((route) => typeof route === "string" ? route : route.pattern);

function complete(value, label, errors) {
  if (typeof value !== "string" || !value || markers.test(value)) errors.push(`${label} is empty or contains a placeholder`);
}

function compareResources(app, kind, staging, production, key, errors) {
  const stage = mapped(staging, key);
  for (const [binding, productionValue] of mapped(production, key)) {
    const value = stage.get(binding);
    complete(value, `${app} ${kind} ${binding}`, errors);
    if (value === productionValue) errors.push(`${app} ${kind} ${binding} reuses production`);
  }
}

export function validateApp(app, staging, production) {
  const errors = [];
  const inventory = STAGING_INVENTORY[app];
  if (staging.account_id !== STAGING_ACCOUNT_ID) errors.push(`${app} account_id must equal the approved LTDS staging account`);
  for (const key of ["name", "routes", "d1_databases", "r2_buckets", "workflows", "ratelimits", "images"]) {
    const actual = staging[key] ?? (Array.isArray(inventory[key]) ? [] : undefined);
    if (JSON.stringify(actual) !== JSON.stringify(inventory[key])) errors.push(`${app} ${key} does not match the approved staging inventory`);
  }
  const consumers = staging.queues?.consumers ?? [];
  if (JSON.stringify(consumers) !== JSON.stringify(inventory.queues)) errors.push(`${app} queues do not match the approved staging inventory`);
  const producers = staging.queues?.producers ?? [];
  if (JSON.stringify(producers) !== JSON.stringify(inventory.queueProducers ?? [])) errors.push(`${app} queue producers do not match the approved staging inventory`);
  const crons = staging.triggers?.crons ?? [];
  if (JSON.stringify(crons) !== JSON.stringify(inventory.crons ?? [])) errors.push(`${app} cron triggers do not match the approved staging inventory`);
  complete(staging.name, `${app} worker name`, errors);
  if (staging.name === production.name) errors.push(`${app} reuses the production worker name`);
  if (!staging.name?.endsWith("-staging")) errors.push(`${app} worker name must end in -staging`);
  if (staging.workers_dev !== false) errors.push(`${app} must set workers_dev=false`);
  if (staging.preview_urls !== false) errors.push(`${app} must set preview_urls=false`);

  const vars = staging.vars ?? {};
  for (const [key, expected] of Object.entries(STAGING_STATIC_VARS[app])) {
    if (vars[key] !== expected) errors.push(`${app} ${key} must match the approved staging value`);
  }
  const audienceKey = { delivery: "POLICY_AUD", operations: "OPERATIONS_AUD", "ops-sync": "CF_ACCESS_AUD" }[app];
  if (vars.EXPECTED_HOST !== STAGING_HOSTS[app]) errors.push(`${app} EXPECTED_HOST must match the approved staging host`);
  if (vars[audienceKey] !== STAGING_ACCESS_AUDS[app]) errors.push(`${app} Access audience must match the approved staging app`);
  if (app === "operations" && vars.PUBLIC_BASE_URL !== `https://${STAGING_HOSTS.operations}`) errors.push("operations PUBLIC_BASE_URL must match the approved staging host");
  if (app === "delivery") {
    if (vars.CLIENT_PORTAL_ENABLED !== "false") errors.push("delivery CLIENT_PORTAL_ENABLED must remain false for release preparation");
    if (vars.CLIENT_PORTAL_ORIGIN !== `https://${STAGING_HOSTS.client}` || vars.PUBLIC_BASE_URL !== vars.CLIENT_PORTAL_ORIGIN) errors.push("delivery client portal and public origins must match the approved client staging host");
    if (vars.CLIENT_ACCESS_TEAM_DOMAIN !== STAGING_STATIC_VARS.delivery.CLIENT_ACCESS_TEAM_DOMAIN) errors.push("delivery CLIENT_ACCESS_TEAM_DOMAIN must match the approved Access team");
    if (!/^[a-f0-9]{64}$/i.test(vars.CLIENT_ACCESS_AUD ?? "")) errors.push("delivery CLIENT_ACCESS_AUD must be the dedicated client portal Access audience");
    if (Object.values(STAGING_ACCESS_AUDS).includes(vars.CLIENT_ACCESS_AUD)) errors.push("delivery CLIENT_ACCESS_AUD must not reuse another staging Access audience");
  }
  if (app === "operations" && (vars.INCOMING_EXPECTED_HOST !== STAGING_HOSTS.incoming || vars.INCOMING_BASE_URL !== `https://${STAGING_HOSTS.incoming}`)) errors.push("operations incoming host variables must match the reserved staging hostname");
  const declaredSecrets = staging.secrets?.required ?? [];
  if (!Array.isArray(declaredSecrets)) errors.push(`${app} secrets.required must be an array`);
  else {
    const expectedSecrets = REQUIRED_STAGING_SECRETS[app] ?? [];
    for (const secret of expectedSecrets) if (!declaredSecrets.includes(secret)) errors.push(`${app} secrets.required is missing ${secret}`);
    for (const secret of declaredSecrets) if (!expectedSecrets.includes(secret)) errors.push(`${app} secrets.required contains unexpected ${secret}`);
    if (new Set(declaredSecrets).size !== declaredSecrets.length) errors.push(`${app} secrets.required contains duplicates`);
  }
  if (vars.ENVIRONMENT !== "staging") errors.push(`${app} must set ENVIRONMENT=staging`);
  for (const flag of disabled) if (flag in (production.vars ?? {}) && vars[flag] !== "false") errors.push(`${app} must explicitly set ${flag}=false`);
  if (app === "ops-sync") for (const key of ["CF_ACCESS_GROUP_ID", "CF_ACCESS_GROUP_NAME"]) complete(vars[key], `${app} vars.${key}`, errors);
  for (const key of Object.keys(production.vars ?? {})) {
    if (!/(?:EXPECTED_HOST|BASE_URL|_AUD)$/.test(key)) continue;
    complete(vars[key], `${app} vars.${key}`, errors);
    if (vars[key] === production.vars[key]) errors.push(`${app} vars.${key} reuses production`);
  }
  if (app === "operations" && vars.PROJECT_ALPHA_BASE_URL) {
    try {
      const projectAlpha = new URL(vars.PROJECT_ALPHA_BASE_URL);
      if (projectAlpha.protocol !== "https:" || !/(?:^|[.-])staging(?:[.-]|$)/i.test(projectAlpha.hostname)) {
        errors.push("operations PROJECT_ALPHA_BASE_URL must be an HTTPS staging origin");
      }
    } catch {
      errors.push("operations PROJECT_ALPHA_BASE_URL must be a valid URL");
    }
  }

  const stageRoutes = routeHosts(staging);
  const prodRoutes = new Set(routeHosts(production));
  if (!stageRoutes.length) errors.push(`${app} must declare an explicit staging route`);
  for (const host of stageRoutes) {
    complete(host, `${app} route`, errors);
    if (prodRoutes.has(host)) errors.push(`${app} route ${host} reuses production`);
  }
  for (const route of staging.routes ?? []) {
    if (typeof route !== "object" || route.custom_domain !== true) errors.push(`${app} routes must use explicit custom_domain=true objects`);
    if (typeof route === "object" && !/(?:^|[.-])staging(?:[.-]|$)/i.test(route.pattern ?? "")) errors.push(`${app} route must be a staging hostname`);
  }

  compareResources(app, "D1", staging.d1_databases, production.d1_databases, "database_id", errors);
  compareResources(app, "R2", staging.r2_buckets, production.r2_buckets, "bucket_name", errors);
  compareResources(app, "workflow", staging.workflows, production.workflows, "name", errors);

  const prodQueues = new Set((production.queues?.consumers ?? []).map((item) => item.queue));
  const prodProducerQueues = new Set((production.queues?.producers ?? []).map((item) => item.queue));
  const stageQueues = staging.queues?.consumers ?? [];
  if ((production.queues?.consumers?.length ?? 0) && !stageQueues.length) errors.push(`${app} is missing its staging queue consumer`);
  for (const consumer of stageQueues) {
    complete(consumer.queue, `${app} queue`, errors);
    if (!consumer.queue?.endsWith("-dlq")) complete(consumer.dead_letter_queue, `${app} queue DLQ`, errors);
    if (prodQueues.has(consumer.queue)) errors.push(`${app} queue ${consumer.queue} reuses production`);
  }
  for (const producer of staging.queues?.producers ?? []) {
    complete(producer.binding, `${app} queue producer binding`, errors);
    complete(producer.queue, `${app} queue producer`, errors);
    if (prodProducerQueues.has(producer.queue)) errors.push(`${app} queue producer ${producer.queue} reuses production`);
  }

  const prodLimits = mapped(production.ratelimits, "namespace_id");
  const seen = new Set();
  for (const limiter of staging.ratelimits ?? []) {
    complete(limiter.namespace_id, `${app} rate limit ${limiter.name}`, errors);
    if (prodLimits.get(limiter.name) === limiter.namespace_id) errors.push(`${app} rate limit ${limiter.name} reuses production`);
    if (seen.has(limiter.namespace_id)) errors.push(`${app} rate-limit namespace ${limiter.namespace_id} is duplicated`);
    seen.add(limiter.namespace_id);
  }
  if ((staging.ratelimits?.length ?? 0) !== (production.ratelimits?.length ?? 0)) errors.push(`${app} must define every rate-limit binding`);
  return errors;
}

export function validateCrossApp(configs) {
  const errors = [];
  const deliveryDb = mapped(configs.delivery.d1_databases, "database_id").get("DELIVERY_DB");
  if (deliveryDb !== mapped(configs.operations.d1_databases, "database_id").get("DELIVERY_DB")) errors.push("operations DELIVERY_DB must equal delivery staging DELIVERY_DB");
  const operationsDb = mapped(configs.operations.d1_databases, "database_id").get("OPS_DB");
  if (operationsDb !== mapped(configs["ops-sync"].d1_databases, "database_id").get("OPS_DB")) errors.push("ops-sync OPS_DB must equal operations staging OPS_DB");
  const deliveryBucket = mapped(configs.delivery.r2_buckets, "bucket_name").get("DATA_BUCKET");
  if (deliveryBucket !== mapped(configs.operations.r2_buckets, "bucket_name").get("DATA_BUCKET")) errors.push("operations DATA_BUCKET must equal delivery staging DATA_BUCKET");
  return errors;
}

export function validateFiles(base = root) {
  const configs = {};
  const errors = [];
  for (const app of apps) {
    const sourceDir = APP_SOURCE_DIRS[app];
    const stagingFile = path.join(base, "apps", sourceDir, "wrangler.staging.json");
    if (!fs.existsSync(stagingFile)) { errors.push(`${path.relative(base, stagingFile)} is missing`); continue; }
    try {
      configs[app] = readJson(stagingFile);
      errors.push(...validateApp(app, configs[app], readJson(path.join(base, "apps", sourceDir, "wrangler.jsonc"))));
    } catch (error) { errors.push(`${path.relative(base, stagingFile)} is invalid JSON: ${error.message}`); }
  }
  if (apps.every((app) => configs[app])) errors.push(...validateCrossApp(configs));
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validateFiles();
  if (errors.length) {
    console.error("Staging preflight failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else console.log("Staging configuration preflight passed. No remote action was performed.");
}
