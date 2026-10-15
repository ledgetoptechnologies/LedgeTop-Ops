import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROFILE = "staging-ops-sync-v203";
export const TARGET = Object.freeze({
  worker: "ledgetop-ops-sync-staging", host: "ops-sync-staging.ledgetopdroneservices.com",
  account: "846c924bf17bf4f3dd15c97a4c5d1d51",
  opsDb: "78b34173-b168-4e3d-9832-bb9d245cc6b8", deliveryDb: "b6f653ab-9acd-4421-9ad0-207754b59aeb",
  primaryOrigin: "https://pa-staging.ledgetoptechnologies.com", applicationKey: "ledgetop_ops_staging",
});
const fail = () => { throw new Error("Isolated staging Ops Sync profile is invalid or incomplete"); };
function exact(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => fields.includes(key))
    && fields.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable && Object.hasOwn(d, "value"); });
}
function bootstrap(value) {
  if (!exact(value, ["snapshotOrigin", "applicationKey", "accessIssuer", "accessAudience", "accessClientId", "eventKeyId", "eventPublicKey"])
    || value.snapshotOrigin !== TARGET.primaryOrigin || value.applicationKey !== TARGET.applicationKey
    || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(value.accessIssuer)
    || !/^[a-f0-9]{64}$/.test(value.accessAudience) || !/^[a-f0-9]{32}\.access$/.test(value.accessClientId)
    || !/^pa_ed25519_[a-f0-9]{16}$/.test(value.eventKeyId) || !/^[A-Za-z0-9_-]{43}$/.test(value.eventPublicKey)) fail();
  const bytes = Buffer.from(value.eventPublicKey, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value.eventPublicKey || bytes.every(byte => byte === 0)) fail();
  return { ...value, fingerprint: crypto.createHash("sha256").update("ed25519\0").update(bytes).digest("hex") };
}
function sourceConfiguration(root) {
  const base = JSON.parse(fs.readFileSync(path.join(root, "apps/ops-sync/wrangler.jsonc"), "utf8"));
  // Detect new binding families instead of silently copying a new production dependency.
  const fields = ["$schema", "name", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "alias", "routes", "vars", "observability", "triggers", "d1_databases", "services"];
  if (!exact(base, fields) || base.main !== "src/index.ts" || base.workers_dev !== false || base.preview_urls !== false
    || !Array.isArray(base.compatibility_flags) || !base.compatibility_flags.includes("nodejs_compat")) fail();
  if (JSON.stringify(base.d1_databases.map(x => x.binding).sort()) !== JSON.stringify(["DELIVERY_DB", "OPS_DB"])
    || base.d1_databases.some(x => !exact(x, ["binding", "database_name", "database_id", "migrations_dir"]))
    || JSON.stringify(base.services.map(x => x.binding).sort()) !== JSON.stringify(["CLIENT_PORTAL_PROJECTION_INGRESS", "OPERATIONS_DELIVERY_INTENT_INGRESS"])
    || base.services.some(x => !exact(x, ["binding", "service", "entrypoint"]))) fail();
  const entrypoints = { CLIENT_PORTAL_PROJECTION_INGRESS: "OpsSyncPortalProjectionIngress", OPERATIONS_DELIVERY_INTENT_INGRESS: "ProjectAlphaDeliveryIntentIngress" };
  if (base.services.some(x => x.entrypoint !== entrypoints[x.binding])) fail();
  return base;
}

/** Local configuration compilation only: no provider calls, secret reads, or deployment. */
export async function buildStagingOpsSyncProfile203(metadata, { root = ROOT } = {}) {
  try {
    if (!exact(metadata, ["profile", "version", "phase", "owner", "primaryBootstrap", "connectors", "privateInputs"])
      || metadata.profile !== PROFILE || metadata.version !== 203
      || !["isolated-disabled", "legacy-bootstrap", "registry"].includes(metadata.phase)
      || !exact(metadata.privateInputs, ["snapshotApiKey", "accessClientSecret", "eventPrivateKey", "hmacSecret"])
      || Object.values(metadata.privateInputs).some(value => value !== null)) fail();
    const phase = metadata.phase;
    if (phase !== "isolated-disabled" && (!exact(metadata.owner, ["staffId", "accessSubject"])
      || !/^staff-[a-z0-9_-]{1,64}$/.test(metadata.owner.staffId)
      || !/^[A-Za-z0-9|:_-]{1,128}$/.test(metadata.owner.accessSubject))) fail();
    let manifest = null, primary = null;
    if (phase === "isolated-disabled") {
      if (metadata.owner !== null || metadata.primaryBootstrap !== null || metadata.connectors !== null) fail();
    } else if (phase === "legacy-bootstrap") {
      if (metadata.connectors !== null) fail();
      primary = bootstrap(metadata.primaryBootstrap);
    } else {
      if (metadata.primaryBootstrap !== null) fail();
      const { buildConnectorManifest203 } = await import("./staging-pa-ops-connectors-v203.mjs");
      manifest = buildConnectorManifest203(metadata.connectors);
      const sources = JSON.parse(manifest).sources;
      const first = sources[0];
      if (first.sourceId !== "project-alpha:primary" || first.profile !== "primary_legacy"
        || first.snapshotOrigin !== TARGET.primaryOrigin || first.applicationKey !== TARGET.applicationKey
        || first.revision.snapshotBasePath !== "/" || !first.enabled || !first.readVisible
        || first.revision.eventCurrent.algorithm !== "ed25519") fail();
      primary = { accessIssuer: first.revision.accessIssuer, accessAudience: first.revision.accessAudience };
    }
    const base = sourceConfiguration(root), app = path.join(root, "apps/ops-sync");
    const config = {
      $schema: path.join(app, "node_modules/wrangler/config-schema.json"), name: TARGET.worker, account_id: TARGET.account,
      main: path.join(app, base.main), compatibility_date: base.compatibility_date,
      compatibility_flags: structuredClone(base.compatibility_flags), workers_dev: false, preview_urls: false,
      alias: Object.fromEntries(Object.entries(base.alias).map(([key, value]) => [key, path.resolve(app, value)])),
      routes: [{ pattern: TARGET.host, custom_domain: true }],
      vars: { ENVIRONMENT: "staging", EXPECTED_HOST: TARGET.host, APPLICATION_KEY: TARGET.applicationKey,
        TEAM_DOMAIN: primary?.accessIssuer ?? "", CF_ACCESS_AUD: primary?.accessAudience ?? "",
        PROJECT_ALPHA_ALLOW_LEGACY_HMAC: "false", PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED: phase === "legacy-bootstrap" ? "false" : "true",
        ...(phase === "legacy-bootstrap" ? { PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: primary.eventPublicKey } : {}) },
      observability: structuredClone(base.observability),
      // Existing cron reconciles the staff Access group. It is a separate activation.
      triggers: { crons: [] },
      d1_databases: [
        { binding: "OPS_DB", database_name: "ltds-ops-staging", database_id: TARGET.opsDb, migrations_dir: path.join(root, "apps/operations/migrations") },
        { binding: "DELIVERY_DB", database_name: "client-data-staging", database_id: TARGET.deliveryDb, migrations_dir: path.join(root, "apps/client/migrations") },
      ],
      services: [
        { binding: "CLIENT_PORTAL_PROJECTION_INGRESS", service: "ledgetop-clients-staging", entrypoint: "OpsSyncPortalProjectionIngress" },
        { binding: "OPERATIONS_DELIVERY_INTENT_INGRESS", service: "ledgetop-ops-staging", entrypoint: "ProjectAlphaDeliveryIntentIngress" },
      ],
    };
    const output = JSON.stringify(config);
    if (["6ebf7514-d306-4615-ae56-ad869c874dbd", "7f40a7b7-c3ec-470e-a626-e798867f71f8", '"ledgetop-clients"', '"ledgetop-ops"', '"ops-sync.ledgetopdroneservices.com"'].some(value => output.includes(value))) fail();
    return { profile: PROFILE, version: 203, phase, config, manifest,
      sourceConfigurationSha256: crypto.createHash("sha256").update(JSON.stringify(base)).digest("hex"),
      enabledSourceIds: phase === "isolated-disabled" ? [] : phase === "legacy-bootstrap" ? ["project-alpha:primary"] : JSON.parse(manifest).sources.filter(x => x.enabled).map(x => x.sourceId),
      requiredSecretNames: phase === "registry" ? ["PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS", "PROJECT_ALPHA_CONNECTOR_SOURCES"] : [],
      // Wrangler preserves secrets across deployments. An inert initial profile
      // is not a supported way to deactivate an existing registered receiver.
      providerReadbackRequired: { workerMustBeAbsent: phase === "isolated-disabled",
        connectorManifestMustBeAbsent: phase !== "registry", productionResourcesForbidden: true },
      schemaReadbackRequired: { operationsLedger: 203, clientMigration: "0231_portal_primary_private_ingress_authority.sql" },
      primaryAttestation: phase === "legacy-bootstrap" ? { function: "resolveProjectAlphaConnector(env, 'project-alpha:primary', 'events')", fingerprint: primary.fingerprint,
        officialEvent: "PA signed portal.projection through the existing primary /v1/project-alpha/events route",
        prerequisite: "Verify the isolated staging Access service application/audience/client identity before enabling the PA producer; no production event replay or manufactured entitlement." } : null,
      mutationsPerformed: false, deploymentAuthorized: false, liveAcceptanceProven: false };
  } catch { fail(); }
}
