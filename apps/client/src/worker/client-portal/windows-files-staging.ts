import { Hono } from "hono";
import { nativeDeliveryDeploymentEnabled } from "../operations-native-delivery-deployment";
import { createOperationsNativeQueueRouter } from "./operations-native-queue-routes";
import { createWindowsPortalCatalogRouter, type WindowsPortalCatalogRouteEnv } from "./windows-portal-catalog-routes";
import { createWindowsPortalSuccessorRouter } from "./windows-portal-successor-routes";

export type WindowsPortalStagingDeployment = Readonly<{
  accountId: string; workerName: string; databaseId: string; bucketName: string; opsReaderWorkerName: string;
}>;
export type WindowsPortalStagingConfiguration = Readonly<{
  enabled: boolean; portalOrigin: string; issuer: string; audience: string; queueKey: Uint8Array;
  deployment: WindowsPortalStagingDeployment;
}>;
type Resources = Readonly<Pick<WindowsPortalCatalogRouteEnv, "DELIVERY_DB" | "DATA_BUCKET">>;
const ORIGIN = "https://portal-staging.ledgetopdroneservices.com";
const ISSUER = "https://ledgetoptechnologies.cloudflareaccess.com";
const PRODUCTION_AUDIENCE = "0fa9c4453634e4c74d4522e2d44407a49701320b06d8f21d8a58efa21e5f947f";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STAGING_NAME = /^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?-staging$/u;
const FAMILIES = ["windows-catalog", "windows-successor", "queue"] as const;
const BASE = "/api/client/operations/data/";
function shape(value: unknown, keys: string): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(",") === keys;
}

/** Source-only composition. Deployment tooling must independently verify the
 * declared physical resource IDs and private reader target before construction.
 * Neither names nor JS binding identity can prove a resource's physical UUID.
 * This factory does not mount itself, create authority or change global Env. */
export function createWindowsPortalStagingRouter(input: WindowsPortalStagingConfiguration, resources: Resources) {
  if (!shape(input, "audience,deployment,enabled,issuer,portalOrigin,queueKey")
    || !shape(input.deployment, "accountId,bucketName,databaseId,opsReaderWorkerName,workerName")
    || !shape(resources, "DATA_BUCKET,DELIVERY_DB")) throw Error("windows_portal_staging_configuration");
  const deployment = Object.freeze({ ...input.deployment });
  if (typeof input.enabled !== "boolean" || input.portalOrigin !== ORIGIN || input.issuer !== ISSUER
    || typeof input.audience !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.audience) || input.audience === PRODUCTION_AUDIENCE
    || !(input.queueKey instanceof Uint8Array) || input.queueKey.length !== 32
    || typeof deployment.accountId !== "string" || !/^[a-f0-9]{32}$/u.test(deployment.accountId)
    || typeof deployment.databaseId !== "string" || !UUID.test(deployment.databaseId) || deployment.databaseId === "7f40a7b7-c3ec-470e-a626-e798867f71f8"
    || ![deployment.workerName, deployment.bucketName, deployment.opsReaderWorkerName].every(x => typeof x === "string" && STAGING_NAME.test(x))
    || !resources.DELIVERY_DB || !resources.DATA_BUCKET) throw Error("windows_portal_staging_configuration");
  const config = Object.freeze({ enabled: input.enabled, portalOrigin: ORIGIN, issuer: input.issuer,
    audience: input.audience, queueKey: new Uint8Array(input.queueKey) });
  const database = resources.DELIVERY_DB, bucket = resources.DATA_BUCKET;
  const router = new Hono<{ Bindings: WindowsPortalCatalogRouteEnv }>();
  for (const family of FAMILIES) router.use(BASE + family + "/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (config.enabled !== true || c.env.ENVIRONMENT !== "staging" || !nativeDeliveryDeploymentEnabled(c.env)
      || c.env.CLIENT_PORTAL_ORIGIN !== ORIGIN || c.env.DELIVERY_DB !== database || c.env.DATA_BUCKET !== bucket)
      return c.json({ error: "windows_portal_staging_unavailable" }, 503);
    const reusedHandleKey = [c.env.DELIVERY_SESSION_SECRET, c.env.DELIVERY_PREVIOUS_SESSION_SECRET].some(secret => {
      if (typeof secret !== "string") return false;
      const bytes = new TextEncoder().encode(secret);
      return bytes.length === config.queueKey.length && bytes.every((byte, index) => byte === config.queueKey[index]);
    });
    if (reusedHandleKey)
      return c.json({ error: "windows_portal_staging_unavailable" }, 503);
    return next();
  });
  router.route("/", createWindowsPortalCatalogRouter(config));
  router.route("/", createWindowsPortalSuccessorRouter(config));
  router.route("/", createOperationsNativeQueueRouter(config));
  return router;
}
