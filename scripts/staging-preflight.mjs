import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apps = ["delivery", "operations", "ops-sync"];
const markers = /<[^>]+>|CHANGE[_-]?ME|REPLACE[_-]?ME|example\.invalid/i;
const disabled = ["CLOUD_TRANSFER_DROPBOX_ENABLED", "CLOUD_TRANSFER_GOOGLE_ENABLED", "CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED", "DROPBOX_IMPORT_ENABLED", "R2_PURGE_ENABLED"];
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
  complete(staging.name, `${app} worker name`, errors);
  if (staging.name === production.name) errors.push(`${app} reuses the production worker name`);
  if (!staging.name?.endsWith("-staging")) errors.push(`${app} worker name must end in -staging`);
  if (staging.workers_dev !== false) errors.push(`${app} must set workers_dev=false`);
  if (staging.preview_urls !== false) errors.push(`${app} must set preview_urls=false`);

  const vars = staging.vars ?? {};
  if (vars.ENVIRONMENT !== "staging") errors.push(`${app} must set ENVIRONMENT=staging`);
  for (const flag of disabled) if (flag in (production.vars ?? {}) && vars[flag] !== "false") errors.push(`${app} must explicitly set ${flag}=false`);
  for (const key of Object.keys(production.vars ?? {})) {
    if (!/(?:EXPECTED_HOST|BASE_URL|_AUD)$/.test(key)) continue;
    complete(vars[key], `${app} vars.${key}`, errors);
    if (vars[key] === production.vars[key]) errors.push(`${app} vars.${key} reuses production`);
  }

  const stageRoutes = routeHosts(staging);
  const prodRoutes = new Set(routeHosts(production));
  if (!stageRoutes.length) errors.push(`${app} must declare an explicit staging route`);
  for (const host of stageRoutes) {
    complete(host, `${app} route`, errors);
    if (prodRoutes.has(host)) errors.push(`${app} route ${host} reuses production`);
  }

  compareResources(app, "D1", staging.d1_databases, production.d1_databases, "database_id", errors);
  compareResources(app, "R2", staging.r2_buckets, production.r2_buckets, "bucket_name", errors);
  compareResources(app, "workflow", staging.workflows, production.workflows, "name", errors);

  const prodQueues = new Set((production.queues?.consumers ?? []).map((item) => item.queue));
  const stageQueues = staging.queues?.consumers ?? [];
  if ((production.queues?.consumers?.length ?? 0) && !stageQueues.length) errors.push(`${app} is missing its staging queue consumer`);
  for (const consumer of stageQueues) {
    complete(consumer.queue, `${app} queue`, errors);
    complete(consumer.dead_letter_queue, `${app} queue DLQ`, errors);
    if (prodQueues.has(consumer.queue)) errors.push(`${app} queue ${consumer.queue} reuses production`);
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
    const stagingFile = path.join(base, "apps", app, "wrangler.staging.json");
    if (!fs.existsSync(stagingFile)) { errors.push(`${path.relative(base, stagingFile)} is missing`); continue; }
    try {
      configs[app] = readJson(stagingFile);
      errors.push(...validateApp(app, configs[app], readJson(path.join(base, "apps", app, "wrangler.jsonc"))));
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
