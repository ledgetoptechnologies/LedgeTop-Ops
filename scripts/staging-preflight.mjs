import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_SOURCE_DIRS, REQUIRED_DISABLED_FEATURE_FLAGS, REQUIRED_STAGING_MIGRATIONS, REQUIRED_STAGING_SECRETS, STAGING_ACCOUNT_ID, STAGING_ALLOWED_VAR_NAMES, STAGING_HOSTS, STAGING_INVENTORY, STAGING_REQUEST_ATTACHMENT_R2_CORS, STAGING_STATIC_VARS } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apps = ["delivery", "operations", "ops-sync"];
const markers = /<[^>]+>|CHANGE[_-]?ME|REPLACE[_-]?ME|example\.invalid/i;
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const mapped = (entries = [], key) => new Map(entries.map((item) => [item.binding, item[key]]));
const routeHosts = (config) => (config.routes ?? []).map((route) => typeof route === "string" ? route : route.pattern);
const email = (value) => typeof value === "string" && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const reviewedTopLevelKeys = new Set([
  "$schema", "name", "account_id", "main", "compatibility_date", "compatibility_flags",
  "workers_dev", "preview_urls", "routes", "limits", "triggers", "assets", "vars",
  "observability", "send_email", "ratelimits", "r2_buckets", "d1_databases", "services",
  "stream", "workflows", "queues", "durable_objects", "exports", "containers", "images",
]);

function complete(value, label, errors) {
  if (typeof value !== "string" || !value || markers.test(value)) errors.push(`${label} is empty or contains a placeholder`);
}

function validateMapbox(app, vars, production, errors) {
  const deferred = vars.MAPBOX_STAGING_ACCEPTANCE_DEFERRED;
  const token = vars.MAPBOX_PUBLIC_TOKEN;
  if (!["true", "false"].includes(deferred)) {
    errors.push(`${app} MAPBOX_STAGING_ACCEPTANCE_DEFERRED must be the string true or false`);
    return;
  }
  if (deferred === "true") {
    if (token !== "") errors.push(`${app} must render an empty MAPBOX_PUBLIC_TOKEN when Mapbox staging acceptance is deferred`);
    return;
  }
  complete(token, `${app} vars.MAPBOX_PUBLIC_TOKEN`, errors);
  if (typeof token === "string" && token && !markers.test(token) && !token.startsWith("pk.")) {
    errors.push(`${app} vars.MAPBOX_PUBLIC_TOKEN must be a restricted public Mapbox token`);
  }
  if (token && token === production.vars?.MAPBOX_PUBLIC_TOKEN) errors.push(`${app} vars.MAPBOX_PUBLIC_TOKEN reuses a production Mapbox token`);
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
  for (const key of [
    "name", "main", "compatibility_date", "compatibility_flags", "routes",
    "d1_databases", "r2_buckets", "workflows", "services", "ratelimits",
    "limits", "assets", "observability", "stream", "durable_objects",
    "exports", "containers", "images",
  ]) {
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
  if (Object.hasOwn(staging, "secrets")) errors.push(`${app} must not place the release-only secret manifest in Wrangler configuration`);
  for (const key of Object.keys(staging)) if (!reviewedTopLevelKeys.has(key)) errors.push(`${app} contains unreviewed Wrangler field ${key}`);

  const vars = staging.vars ?? {};
  const allowedVars = STAGING_ALLOWED_VAR_NAMES[app] ?? [];
  for (const key of allowedVars) if (!Object.hasOwn(vars, key)) errors.push(`${app} vars is missing reviewed field ${key}`);
  for (const key of Object.keys(vars)) if (!allowedVars.includes(key)) errors.push(`${app} vars contains unreviewed field ${key}`);
  for (const [key, expected] of Object.entries(STAGING_STATIC_VARS[app])) {
    if (vars[key] !== expected) errors.push(`${app} ${key} must match the approved staging value`);
  }
  const audienceKey = { delivery: "POLICY_AUD", operations: "OPERATIONS_AUD", "ops-sync": "CF_ACCESS_AUD" }[app];
  if (vars.EXPECTED_HOST !== STAGING_HOSTS[app]) errors.push(`${app} EXPECTED_HOST must match the approved staging host`);
  if (!/^[a-f0-9]{64}$/i.test(vars[audienceKey] ?? "")) errors.push(`${app} Access audience must be a 64-character staging audience`);
  if (app === "operations" && vars.PUBLIC_BASE_URL !== `https://${STAGING_HOSTS.operations}`) errors.push("operations PUBLIC_BASE_URL must match the approved staging host");
  if (app === "delivery") {
    if (vars.CLIENT_PORTAL_ENABLED !== "false") errors.push("delivery CLIENT_PORTAL_ENABLED must remain false for release preparation");
    if (vars.CLIENT_PORTAL_ORIGIN !== `https://${STAGING_HOSTS.client}`) errors.push("delivery CLIENT_PORTAL_ORIGIN must match the approved authenticated client staging host");
    if (vars.CLIENT_PORTAL_ORIGINS !== STAGING_STATIC_VARS.delivery.CLIENT_PORTAL_ORIGINS)
      errors.push("delivery CLIENT_PORTAL_ORIGINS must contain both approved staging client origins");
    if (vars.PUBLIC_SHARE_ORIGIN !== `https://${STAGING_HOSTS.delivery}` || vars.PUBLIC_BASE_URL !== vars.PUBLIC_SHARE_ORIGIN)
      errors.push("delivery public origins must match the approved anonymous delivery staging host");
    if (vars.CLIENT_ACCESS_TEAM_DOMAIN !== STAGING_STATIC_VARS.delivery.CLIENT_ACCESS_TEAM_DOMAIN) errors.push("delivery CLIENT_ACCESS_TEAM_DOMAIN must match the approved Access team");
    if (!/^[a-f0-9]{64}$/i.test(vars.CLIENT_ACCESS_AUD ?? "")) errors.push("delivery CLIENT_ACCESS_AUD must be the dedicated client portal Access audience");
    if (!/^[a-f0-9]{64}$/i.test(vars.PROJECT_ALPHA_CATALOG_ACCESS_AUD ?? "")) errors.push("delivery PROJECT_ALPHA_CATALOG_ACCESS_AUD must be a 64-character Ops Sync staging audience");
    if (vars.CLIENT_ACCESS_AUD === vars.PROJECT_ALPHA_CATALOG_ACCESS_AUD || vars.CLIENT_ACCESS_AUD === vars.POLICY_AUD)
      errors.push("delivery client portal audience must remain distinct from Delivery and Ops Sync audiences");
    validateMapbox(app, vars, production, errors);
    if (!email(vars.CLIENT_PORTAL_INVITATION_FROM)) errors.push("delivery CLIENT_PORTAL_INVITATION_FROM must be a valid staging sender");
    const emailBindings = staging.send_email ?? [];
    const invitationEmail = emailBindings.find((binding) => binding.name === "CLIENT_PORTAL_INVITATION_EMAIL");
    if (emailBindings.length !== 1 || !invitationEmail || JSON.stringify(invitationEmail.allowed_sender_addresses) !== JSON.stringify([vars.CLIENT_PORTAL_INVITATION_FROM])) {
      errors.push("delivery invitation email binding must allow exactly CLIENT_PORTAL_INVITATION_FROM");
    }
  }
  if (app === "operations") {
    if (vars.CLIENT_ONBOARDING_ADMIN_ENABLED === "false" && vars.CLIENT_ONBOARDING_ADMIN_ORIGIN !== "")
      errors.push("operations client onboarding admin origin must remain empty while disabled");
    if (vars.CLIENT_ONBOARDING_ADMIN_ENABLED === "true") {
      try {
        const adminOrigin = new URL(vars.CLIENT_ONBOARDING_ADMIN_ORIGIN);
        if (adminOrigin.protocol !== "https:" || adminOrigin.origin !== vars.CLIENT_ONBOARDING_ADMIN_ORIGIN
          || !/(?:^|[.-])staging(?:[.-]|$)/i.test(adminOrigin.hostname)) throw new Error();
      } catch {
        errors.push("operations enabled client onboarding admin requires an exact HTTPS staging origin");
      }
    }
    if (vars.NATIVE_INTEGRATION_CONTROL_ENABLED === "false" && vars.NATIVE_INTEGRATION_CONTROL_ORIGIN !== "")
      errors.push("operations native integration control origin must remain empty while control is disabled");
    if (vars.NATIVE_INTEGRATION_CONTROL_ENABLED === "true") {
      try {
        const nativeControlOrigin = new URL(vars.NATIVE_INTEGRATION_CONTROL_ORIGIN);
        if (nativeControlOrigin.protocol !== "https:" || nativeControlOrigin.origin !== vars.NATIVE_INTEGRATION_CONTROL_ORIGIN
          || !/(?:^|[.-])staging(?:[.-]|$)/i.test(nativeControlOrigin.hostname)) throw new Error();
      } catch {
        errors.push("operations enabled native integration control requires an exact HTTPS staging origin");
      }
    }
    if (vars.DELIVERY_BASE_URL !== `https://${STAGING_HOSTS.client}`)
      errors.push("operations DELIVERY_BASE_URL must match the approved authenticated client staging host");
    if (vars.PUBLIC_SHARE_ORIGIN !== `https://${STAGING_HOSTS.delivery}`)
      errors.push("operations PUBLIC_SHARE_ORIGIN must match the approved anonymous delivery staging host");
    if (vars.INCOMING_EXPECTED_HOST !== STAGING_HOSTS.incoming || vars.INCOMING_BASE_URL !== `https://${STAGING_HOSTS.incoming}`) errors.push("operations incoming host variables must match the reserved staging hostname");
    validateMapbox(app, vars, production, errors);
    if (!email(vars.CLIENT_REQUEST_TRIAGE_TO)) errors.push("operations CLIENT_REQUEST_TRIAGE_TO must be a valid staging recipient");
    if (!email(vars.NOTIFICATION_FROM)) errors.push("operations NOTIFICATION_FROM must be a valid staging sender");
    const emailBindings = staging.send_email ?? [];
    const notificationEmail = emailBindings.find((binding) => binding.name === "NOTIFICATION_EMAIL");
    if (emailBindings.length !== 1 || !notificationEmail || JSON.stringify(notificationEmail.allowed_sender_addresses) !== JSON.stringify([vars.NOTIFICATION_FROM])) {
      errors.push("operations notification email binding must allow exactly NOTIFICATION_FROM");
    }
  }
  if (vars.ENVIRONMENT !== "staging") errors.push(`${app} must set ENVIRONMENT=staging`);
  for (const flag of REQUIRED_DISABLED_FEATURE_FLAGS[app] ?? []) {
    if (vars[flag] !== "false") errors.push(`${app} must explicitly set ${flag}=false`);
  }
  if (app === "ops-sync") for (const key of ["CF_ACCESS_GROUP_ID", "CF_ACCESS_GROUP_NAME"]) complete(vars[key], `${app} vars.${key}`, errors);
  const productionAudienceValues = new Set(
    Object.entries(production.vars ?? {})
      .filter(([key, value]) => key.endsWith("_AUD") && /^[a-f0-9]{64}$/i.test(value ?? ""))
      .map(([, value]) => value),
  );
  for (const [key, value] of Object.entries(vars)) {
    if (key.endsWith("_AUD") && productionAudienceValues.has(value)) {
      errors.push(`${app} vars.${key} reuses a production Access audience`);
    }
  }
  for (const key of Object.keys(production.vars ?? {})) {
    if (!/(?:EXPECTED_HOST|BASE_URL|_ORIGIN)$/.test(key)) continue;
    if (app === "operations" && key === "NATIVE_INTEGRATION_CONTROL_ORIGIN"
      && vars.NATIVE_INTEGRATION_CONTROL_ENABLED === "false" && vars[key] === "") continue;
    if (app === "operations" && key === "CLIENT_ONBOARDING_ADMIN_ORIGIN"
      && vars.CLIENT_ONBOARDING_ADMIN_ENABLED === "false" && vars[key] === "") continue;
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
  compareResources(app, "service", staging.services, production.services, "service", errors);

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

export function validateCrossApp(configs, productionConfigs = {}) {
  const errors = [];
  const deliveryDb = mapped(configs.delivery.d1_databases, "database_id").get("DELIVERY_DB");
  if (deliveryDb !== mapped(configs.operations.d1_databases, "database_id").get("DELIVERY_DB")) errors.push("operations DELIVERY_DB must equal delivery staging DELIVERY_DB");
  const operationsDb = mapped(configs.operations.d1_databases, "database_id").get("OPS_DB");
  if (operationsDb !== mapped(configs["ops-sync"].d1_databases, "database_id").get("OPS_DB")) errors.push("ops-sync OPS_DB must equal operations staging OPS_DB");
  const deliveryBucket = mapped(configs.delivery.r2_buckets, "bucket_name").get("DATA_BUCKET");
  if (deliveryBucket !== mapped(configs.operations.r2_buckets, "bucket_name").get("DATA_BUCKET")) errors.push("operations DATA_BUCKET must equal delivery staging DATA_BUCKET");
  const delegatedSigner = (configs.delivery.services ?? []).find((service) => service.binding === "CLIENT_DELEGATED_SHARE_SIGNER");
  if (delegatedSigner?.service !== configs.operations.name || delegatedSigner?.entrypoint !== "ClientDelegatedShareSigner") {
    errors.push("delivery delegated-share signer must target the Operations staging Worker and named signer entrypoint");
  }
  const viewerSessionIssuer = (configs.delivery.services ?? []).find((service) => service.binding === "VIEWER_SESSION_ISSUER");
  if (viewerSessionIssuer?.service !== configs.operations.name || viewerSessionIssuer?.entrypoint !== "ViewerSessionIssuer") {
    errors.push("delivery Viewer session issuer must target the Operations staging Worker and named issuer entrypoint");
  }
  const portalIngress = (configs["ops-sync"].services ?? []).find((service) => service.binding === "CLIENT_PORTAL_PROJECTION_INGRESS");
  if (portalIngress?.service !== configs.delivery.name || portalIngress?.entrypoint !== "OpsSyncPortalProjectionIngress") {
    errors.push("ops-sync portal projection ingress must target the Client staging Worker and private named entrypoint");
  }
  if (configs.delivery.vars?.PROJECT_ALPHA_PORTAL_APPLICATION_KEY !== configs["ops-sync"].vars?.APPLICATION_KEY) {
    errors.push("Client and Ops Sync must share the reviewed Project Alpha staging application key");
  }
  const mapboxStates = ["delivery", "operations"].map((app) => ({
    app,
    deferred: configs[app].vars?.MAPBOX_STAGING_ACCEPTANCE_DEFERRED,
    token: configs[app].vars?.MAPBOX_PUBLIC_TOKEN,
  }));
  if (new Set(mapboxStates.map(({ deferred }) => deferred)).size !== 1) {
    errors.push("Delivery and Operations Mapbox staging acceptance deferral must match");
  }
  const mapboxDeferred = mapboxStates.every(({ deferred }) => deferred === "true");
  const mapboxConfigured = mapboxStates.every(({ token }) => typeof token === "string" && token.length > 0);
  const mapboxEmpty = mapboxStates.every(({ token }) => token === "");
  if (mapboxDeferred && !mapboxEmpty) errors.push("deferred Mapbox staging acceptance requires both rendered MAPBOX_PUBLIC_TOKEN values to be empty");
  if (!mapboxDeferred && !mapboxConfigured) errors.push("verified Mapbox staging acceptance requires both rendered MAPBOX_PUBLIC_TOKEN values to be populated");
  const accessAudiences = {
    delivery: configs.delivery.vars?.POLICY_AUD,
    operations: configs.operations.vars?.OPERATIONS_AUD,
    "ops-sync": configs["ops-sync"].vars?.CF_ACCESS_AUD,
    clientPortal: configs.delivery.vars?.CLIENT_ACCESS_AUD,
  };
  if (new Set(Object.values(accessAudiences)).size !== Object.keys(accessAudiences).length)
    errors.push("Delivery, Operations, Ops Sync, and client portal Access audiences must all be distinct");
  if (configs.delivery.vars?.PROJECT_ALPHA_CATALOG_ACCESS_AUD !== accessAudiences["ops-sync"])
    errors.push("delivery catalog authorization must use the single Ops Sync staging Access audience");
  const productionAudiences = new Set(
    Object.values(productionConfigs)
      .flatMap((config) => Object.entries(config?.vars ?? {}))
      .filter(([key, value]) => key.endsWith("_AUD") && /^[a-f0-9]{64}$/i.test(value ?? ""))
      .map(([, value]) => value),
  );
  for (const [name, audience] of Object.entries(accessAudiences)) {
    if (productionAudiences.has(audience)) errors.push(`${name} staging Access audience reuses a production Access audience`);
  }
  return errors;
}

export function validateSecretManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["staging secret manifest must be an object"];
  for (const app of apps) {
    const declared = manifest[app];
    const expected = REQUIRED_STAGING_SECRETS[app] ?? [];
    if (!Array.isArray(declared)) { errors.push(`staging secret manifest ${app} must be an array`); continue; }
    if (new Set(declared).size !== declared.length) errors.push(`staging secret manifest ${app} contains duplicates`);
    for (const secret of expected) if (!declared.includes(secret)) errors.push(`staging secret manifest ${app} is missing ${secret}`);
    for (const secret of declared) if (!expected.includes(secret)) errors.push(`staging secret manifest ${app} contains unexpected ${secret}`);
  }
  for (const app of Object.keys(manifest)) if (!apps.includes(app)) errors.push(`staging secret manifest contains unexpected app ${app}`);
  return errors;
}

export function validateRequestAttachmentCors(config) {
  return JSON.stringify(config) === JSON.stringify(STAGING_REQUEST_ATTACHMENT_R2_CORS)
    ? []
    : ["staging request-attachment R2 CORS must exactly match the approved origin, PUT method, content-type header, etag exposure, and max age"];
}

export function validateFiles(base = root) {
  const configs = {};
  const productionConfigs = {};
  const errors = [];
  for (const app of apps) {
    const sourceDir = APP_SOURCE_DIRS[app];
    const stagingFile = path.join(base, "apps", sourceDir, "wrangler.staging.json");
    if (!fs.existsSync(stagingFile)) { errors.push(`${path.relative(base, stagingFile)} is missing`); continue; }
    try {
      configs[app] = readJson(stagingFile);
      productionConfigs[app] = readJson(path.join(base, "apps", sourceDir, "wrangler.jsonc"));
      errors.push(...validateApp(app, configs[app], productionConfigs[app]));
    } catch (error) { errors.push(`${path.relative(base, stagingFile)} is invalid JSON: ${error.message}`); }
  }
  const corsFile = path.join(base, "docs", "staging", "request-attachments-r2-cors.json");
  if (!fs.existsSync(corsFile)) errors.push(`${path.relative(base, corsFile)} is missing`);
  else {
    try { errors.push(...validateRequestAttachmentCors(readJson(corsFile))); }
    catch (error) { errors.push(`${path.relative(base, corsFile)} is invalid JSON: ${error.message}`); }
  }
  const secretManifestFile = path.join(base, "docs", "staging", "staging-secret-manifest.json");
  if (!fs.existsSync(secretManifestFile)) errors.push(`${path.relative(base, secretManifestFile)} is missing`);
  else {
    try { errors.push(...validateSecretManifest(readJson(secretManifestFile))); }
    catch (error) { errors.push(`${path.relative(base, secretManifestFile)} is invalid JSON: ${error.message}`); }
  }
  if (apps.every((app) => configs[app])) errors.push(...validateCrossApp(configs, productionConfigs));
  errors.push(...validateMigrationInventory(base));
  return errors;
}

export function validateMigrationInventory(base = root) {
  const errors = [];
  for (const app of ["delivery", "operations"]) {
    const directory = path.join(base, "apps", APP_SOURCE_DIRS[app], "migrations");
    if (!fs.existsSync(directory)) { errors.push(`${path.relative(base, directory)} is missing`); continue; }
    const first = REQUIRED_STAGING_MIGRATIONS[app][0];
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.endsWith(".sql") && entry.name.localeCompare(first) >= 0 && (!entry.isFile() || entry.isSymbolicLink())) errors.push(`${app} release migration ${entry.name} must be a regular non-symlink file`);
    }
    const actual = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".sql") && entry.name.localeCompare(first) >= 0).map((entry) => entry.name).sort();
    const expected = [...REQUIRED_STAGING_MIGRATIONS[app]];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${app} release migration inventory must exactly match the ordered contract`);
  }
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
