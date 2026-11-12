import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STAGING_ACCOUNT_ID = "df3f376bae6ee621f50cf972ebcc9484";
export const STAGING_ACCESS_ISSUER = "https://ledge-top-staging.cloudflareaccess.com";
export const STAGING_TARGETS = Object.freeze({
  operations: Object.freeze({
    name: "ledge-top-ops-staging",
    opsDb: Object.freeze({ name: "ledge-top-ops-staging", id: "a58ea102-f04d-417a-bfd1-b0654cfeb503" }),
    portalDb: Object.freeze({ name: "ledge-top-portal-staging", id: "15d02028-8c52-40b2-9979-d67abf7d5bbf" }),
    deliveryBucket: "ledge-top-delivery-staging",
    incomingBucket: "ledge-top-incoming-staging",
    fileEventsQueue: Object.freeze({ name: "ledge-top-file-events-staging", id: "135555ab78f74417917b9af9c0c708f9" }),
    fileEventsDeadLetterQueue: Object.freeze({ name: "ledge-top-file-events-staging-dlq", id: "265c2e906a0c4baaaa5c04c922edc439" }),
    thumbnailQueue: Object.freeze({ name: "ledge-top-thumbnail-staging", id: "0925633716464172bb0026f1a30e5cff" }),
    thumbnailDeadLetterQueue: Object.freeze({ name: "ledge-top-thumbnail-staging-dlq", id: "4e62d82515b14b3ca63a4951c15d53f7" }),
    accessApplicationId: "37c5049c-a787-49cf-ac43-ba4d340bee70",
    accessAudience: "ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84",
    portalWorker: "ledge-top-clients-staging",
    assetsWorker: "ledge-top-ui-assets-staging",
    origin: "https://ledge-top-ops-staging.ledge-top-staging.workers.dev",
  }),
  client: Object.freeze({
    name: "ledge-top-clients-staging",
    host: "ledge-top-clients-staging.ledge-top-staging.workers.dev",
    origin: "https://ledge-top-clients-staging.ledge-top-staging.workers.dev",
    accessApplicationId: "bba2498b-7576-4c4d-84e3-23a62d701778",
    accessAudience: "dd6be2a400a90ba47a09a692f491738f7fbad090a0240f5a8a0c175db9b36d44",
    portalDb: Object.freeze({ name: "ledge-top-portal-staging", id: "15d02028-8c52-40b2-9979-d67abf7d5bbf" }),
    deliveryBucket: "ledge-top-delivery-staging",
    operationsWorker: "ledge-top-ops-staging",
    assetsWorker: "ledge-top-ui-assets-staging",
  }),
  sync: Object.freeze({
    name: "ledge-top-ops-sync-staging",
    host: "ledge-top-ops-sync-staging.ledge-top-staging.workers.dev",
    accessApplicationId: "dde6d648-f427-43a3-9fbb-18944555e506",
    accessAudience: "61e0ecc56176cab2eaa1c007ca262e10dbd91df1cee36abf87d8a3928a720485",
    opsDb: Object.freeze({ name: "ledge-top-ops-staging", id: "a58ea102-f04d-417a-bfd1-b0654cfeb503" }),
    portalDb: Object.freeze({ name: "ledge-top-portal-staging", id: "15d02028-8c52-40b2-9979-d67abf7d5bbf" }),
    operationsWorker: "ledge-top-ops-staging",
    portalWorker: "ledge-top-clients-staging",
  }),
});

const profile = Object.freeze({
  operations: Object.freeze({ source: "apps/operations/wrangler.jsonc", output: "apps/operations/wrangler.staging-account.jsonc" }),
  client: Object.freeze({ source: "apps/client/wrangler.jsonc", output: "apps/client/wrangler.staging-account.jsonc" }),
  sync: Object.freeze({ source: "apps/ops-sync/wrangler.jsonc", output: "apps/ops-sync/wrangler.staging-account.jsonc" }),
});

function readConfig(base, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(base, relativePath), "utf8"));
}

function allGatesOff(sourceVars) {
  return Object.fromEntries(Object.entries(sourceVars ?? {})
    .filter(([key]) => /(?:_ENABLED|_READY)$/.test(key))
    .map(([key]) => [key, "false"]));
}

function service(binding, service, entrypoint) {
  return entrypoint ? { binding, service, entrypoint } : { binding, service };
}

function database(binding, allocation, migrationsDir) {
  return { binding, database_name: allocation.name, database_id: allocation.id, migrations_dir: migrationsDir };
}

function common(source, name, base) {
  return {
    $schema: source.$schema,
    name,
    account_id: STAGING_ACCOUNT_ID,
    main: source.main,
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags ?? [],
    workers_dev: false,
    preview_urls: false,
    keep_vars: false,
    routes: [],
    ...(source.assets ? { assets: source.assets } : {}),
    ...(source.limits ? { limits: source.limits } : {}),
    observability: source.observability ?? { enabled: true },
  };
}

function operationsConfig(base) {
  const source = readConfig(base, profile.operations.source);
  const target = STAGING_TARGETS.operations;
  return {
    ...common(source, target.name, base),
    vars: {
      ...allGatesOff(source.vars),
      ENVIRONMENT: "staging",
      PUBLIC_BASE_URL: target.origin,
      EXPECTED_HOST: new URL(target.origin).host,
      OPERATIONS_ORIGINS: target.origin,
      TEAM_DOMAIN: STAGING_ACCESS_ISSUER,
      OPERATIONS_AUD: target.accessAudience,
      DIRECT_DELIVERY_UPLOADS_ENABLED: "false",
      INCOMING_BASE_URL: "REQUIRES_ALLOCATION:incoming_staging_origin",
      INCOMING_EXPECTED_HOST: "REQUIRES_ALLOCATION:incoming_staging_host",
      DELIVERY_BASE_URL: STAGING_TARGETS.client.origin,
      CLIENT_PORTAL_ORIGINS: STAGING_TARGETS.client.origin,
      PUBLIC_SHARE_ORIGIN: "REQUIRES_ALLOCATION:public_delivery_staging_origin",
      PROJECT_ALPHA_BASE_URL: "REQUIRES_ALLOCATION:project_alpha_staging_origin",
      R2_ACCOUNT_ID: STAGING_ACCOUNT_ID,
      R2_BUCKET_NAME: target.deliveryBucket,
      R2_INCOMING_BUCKET_NAME: target.incomingBucket,
      R2_PURGE_ENABLED: "false",
      FILE_EVENTS_QUEUE_NAME: target.fileEventsQueue.name,
      THUMBNAIL_QUEUE_NAME: target.thumbnailQueue.name,
      THUMBNAIL_DLQ_NAME: target.thumbnailDeadLetterQueue.name,
      THUMBNAIL_INGEST_EXPECTED_HOST: "REQUIRES_ALLOCATION:thumbnail_ingest_host",
      THUMBNAIL_RENDERER_EXPECTED_HOST: "REQUIRES_ALLOCATION:thumbnail_renderer_host",
    },
    r2_buckets: [
      { binding: "DATA_BUCKET", bucket_name: target.deliveryBucket },
      { binding: "INCOMING_BUCKET", bucket_name: target.incomingBucket },
    ],
    d1_databases: [
      database("OPS_DB", target.opsDb, "migrations"),
      database("DELIVERY_DB", target.portalDb, "../client/migrations"),
    ],
    services: [
      service("SHARED_PROFILE_PORTAL_AUTHORITY", target.portalWorker, "SharedProfilePortalAuthorityReader"),
      service("OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY", target.portalWorker, "OperationsPortalNativeDeliveryAuthorityIngress"),
      service("OPERATIONS_PORTAL_WORKSPACE_PUBLICATION", target.portalWorker, "OperationsPortalWorkspacePublicationIngress"),
      service("OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY", target.portalWorker, "OperationsPortalNativeRecipientAuthorityIngress"),
      service("CLIENT_PORTAL_AUTHORITY_V2", target.portalWorker, "ClientPortalAuthorityV2Ingress"),
      service("CLIENT_AUTHORITY_WORKSPACE_BINDING", target.portalWorker, "ClientAuthorityWorkspaceBindingIngress"),
      service("CLIENT_PORTAL_ACCESS_AUTHORITY", target.portalWorker, "OpsPortalAccessAuthorityIngress"),
      service("OPS_INVENTORY_CATALOG_PROMOTION", target.portalWorker, "OpsInventoryCatalogPromotionCoordinator"),
      service("OPS_INVENTORY_CATALOG_STAGING", target.portalWorker, "OpsInventoryCatalogStagingIngress"),
      service("VERIFIED_RECIPIENT_DELIVERY_AUTHORITY", target.portalWorker, "VerifiedRecipientDeliveryAuthorityIngress"),
      service("UI_RELEASE_ASSETS", target.assetsWorker),
    ],
    queues: {
      producers: [{ binding: "THUMBNAIL_QUEUE", queue: target.thumbnailQueue.name }],
    },
  };
}

function clientConfig(base) {
  const source = readConfig(base, profile.client.source);
  const target = STAGING_TARGETS.client;
  const operationsTarget = STAGING_TARGETS.operations;
  const deploymentProfile = {
    version: 1,
    accountId: STAGING_ACCOUNT_ID,
    workerName: target.name,
    databaseBinding: "DELIVERY_DB",
    databaseId: target.portalDb.id,
    portalOrigin: target.origin,
    publicShareOrigin: "REQUIRES_ALLOCATION:public_delivery_staging_origin",
    privateRequestOrigins: [target.origin],
  };
  return {
    ...common(source, target.name, base),
    vars: {
      ...allGatesOff(source.vars),
      ENVIRONMENT: "staging",
      CLIENT_PORTAL_ENABLED: "false",
      EXPECTED_HOST: target.host,
      PUBLIC_BASE_URL: target.origin,
      PUBLIC_SHARE_ORIGIN: "REQUIRES_ALLOCATION:public_delivery_staging_origin",
      CLIENT_PORTAL_ORIGIN: target.origin,
      CLIENT_PORTAL_ORIGINS: target.origin,
      CLIENT_ACCESS_TEAM_DOMAIN: STAGING_ACCESS_ISSUER,
      CLIENT_ACCESS_AUD: target.accessAudience,
      CLIENT_ACCESS_AUDS: target.accessAudience,
      R2_S3_ENDPOINT: `https://${STAGING_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: JSON.stringify(deploymentProfile),
    },
    r2_buckets: [{ binding: "DATA_BUCKET", bucket_name: target.deliveryBucket }],
    d1_databases: [database("DELIVERY_DB", target.portalDb, "migrations")],
    services: [
      service("SHARED_PROFILE_PORTAL", operationsTarget.name, "SharedProfilePortalIngress"),
      service("CLIENT_PORTAL_SERVICE_METADATA_READER", operationsTarget.name, "ClientPortalServiceMetadataReader"),
      service("CLIENT_DELEGATED_SHARE_SIGNER", operationsTarget.name, "ClientDelegatedShareSigner"),
      service("VIEWER_SESSION_ISSUER", operationsTarget.name, "ViewerSessionIssuer"),
      service("CLIENT_PORTAL_NATIVE_FINANCIAL_READER", operationsTarget.name, "ClientPortalNativeFinancialReader"),
      service("OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER", operationsTarget.name, "OperationsPortalNativeDeliveryAuthorizationReader"),
      service("OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT", operationsTarget.name, "OperationsPortalNativeRecipientEnrollmentIngress"),
      service("CLIENT_ONBOARDING_RECIPIENT_BRIDGE", operationsTarget.name, "ClientOnboardingRecipientBridge"),
      service("CLIENT_PORTAL_RECIPIENT_ENROLLMENT_BRIDGE", operationsTarget.name, "ClientPortalRecipientEnrollmentBridge"),
      service("OPERATIONS_NATIVE_PRINCIPAL_INQUIRIES", operationsTarget.name, "OperationsNativePrincipalInquiryIngress"),
      service("UI_RELEASE_ASSETS", target.assetsWorker),
    ],
  };
}

function syncConfig(base) {
  const source = readConfig(base, profile.sync.source);
  const target = STAGING_TARGETS.sync;
  return {
    ...common(source, target.name, base),
    vars: {
      ENVIRONMENT: "staging",
      EXPECTED_HOST: target.host,
      TEAM_DOMAIN: STAGING_ACCESS_ISSUER,
      CF_ACCESS_AUD: target.accessAudience,
      CF_ACCOUNT_ID: STAGING_ACCOUNT_ID,
      CF_ACCESS_GROUP_ID: "REQUIRES_ALLOCATION:sync_access_group_id",
      CF_ACCESS_GROUP_NAME: "REQUIRES_ALLOCATION:sync_access_group_name",
      APPLICATION_KEY: "REQUIRES_ALLOCATION:sync_application_key",
      PROJECT_ALPHA_ALLOW_LEGACY_HMAC: "false",
      PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED: "true",
    },
    d1_databases: [
      database("OPS_DB", target.opsDb, "../operations/migrations"),
      database("DELIVERY_DB", target.portalDb, "../client/migrations"),
    ],
    services: [
      service("CLIENT_PORTAL_PROJECTION_INGRESS", target.portalWorker, "OpsSyncPortalProjectionIngress"),
      service("OPERATIONS_DELIVERY_INTENT_INGRESS", target.operationsWorker, "ProjectAlphaDeliveryIntentIngress"),
    ],
  };
}

export function renderStagingAccountConfigs(base = root) {
  return {
    operations: operationsConfig(base),
    client: clientConfig(base),
    sync: syncConfig(base),
  };
}

export function writeStagingAccountConfigs(base = root) {
  const configs = renderStagingAccountConfigs(base);
  const written = [];
  for (const [app, paths] of Object.entries(profile)) {
    const output = path.join(base, paths.output);
    const expected = `${JSON.stringify(configs[app], null, 2)}\n`;
    if (fs.existsSync(output)) {
      if (fs.readFileSync(output, "utf8") !== expected) {
        throw new Error(`${paths.output} already exists and differs; review it before regenerating`);
      }
    } else {
      fs.writeFileSync(output, expected, { encoding: "utf8", flag: "wx" });
      written.push(paths.output);
    }
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--write", "--check"].includes(args[0])) {
    console.error("usage: node scripts/staging-account-wrangler-configs.mjs --write|--check");
    process.exitCode = 2;
  } else if (args[0] === "--write") {
    for (const file of writeStagingAccountConfigs()) console.log(`Wrote ${file}`);
  } else {
    const configs = renderStagingAccountConfigs();
    const differences = Object.entries(profile).filter(([app, paths]) =>
      !fs.existsSync(path.join(root, paths.output))
      || JSON.stringify(readConfig(root, paths.output)) !== JSON.stringify(configs[app]));
    if (differences.length) {
      console.error(`Staging account configs differ from source; regenerate with --write: ${differences.map(([app]) => app).join(", ")}`);
      process.exitCode = 1;
    } else console.log("Separate-account staging configs match current source and confirmed target allocations.");
  }
}
