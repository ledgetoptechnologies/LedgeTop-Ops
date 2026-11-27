import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { nativeDeliveryDeploymentEnabled } from "../operations-native-delivery-deployment";
import { resolveCloudflareRecipientEnrollmentProof } from "./access-identity";
import type { WindowsPortalCatalogRouteEnv } from "./windows-portal-catalog-routes";

const DATA = "/api/client/operations/data";
const BASE = DATA + "/windows-files";

/** Oldest desktop build the policy accepts. No build is refused yet. */
export const WINDOWS_FILES_MINIMUM_APP_VERSION = "0.0.0";

export type WindowsFilesRoot = Readonly<{
  id: string; name: string; backend: "nas" | "r2"; rights: readonly ("read" | "write")[]; listPath: string;
}>;
export type WindowsFilesPolicy = Readonly<{
  schemaVersion: 1; role: "client"; roots: readonly WindowsFilesRoot[];
  providerEnabled: boolean; hydrationEnabled: boolean; minimumAppVersion: string; sessionExpiresAt: string;
}>;

/** A signed-in client gets one read-only R2 root. Listing and bytes stay behind
 * the catalog and successor routes, which authorize every request against the
 * client's current delivery grants; this policy grants nothing by itself. */
export function windowsFilesClientPolicy(verifiedUntil: string): WindowsFilesPolicy {
  return {
    schemaVersion: 1, role: "client",
    roots: [{ id: "delivered", name: "Delivered files", backend: "r2", rights: ["read"], listPath: DATA + "/windows-catalog/deliveries" }],
    providerEnabled: false, hydrationEnabled: false, minimumAppVersion: WINDOWS_FILES_MINIMUM_APP_VERSION, sessionExpiresAt: verifiedUntil,
  };
}

const fail = (status: 400 | 401 | 403 | 404 | 503): never => { throw new HTTPException(status, { message: "Windows files are unavailable" }); };

/** Same gates and human proof as the Windows catalog router. Not mounted in production. */
export function createWindowsFilesPolicyRouter(input: Readonly<{ enabled: boolean; portalOrigin: string; issuer: string; audience: string }>) {
  const config = Object.freeze({ ...input });
  const router = new Hono<{ Bindings: WindowsPortalCatalogRouteEnv }>().basePath(BASE);
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store"); c.header("Cloudflare-CDN-Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff");
    if (config.enabled !== true || c.env.CLIENT_PORTAL_ENABLED !== "true" || !nativeDeliveryDeploymentEnabled(c.env)
      || c.env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED !== "true" || c.env.CLIENT_PORTAL_ORIGIN !== config.portalOrigin
      || c.env.CLIENT_ACCESS_TEAM_DOMAIN?.replace(/\/$/u, "") !== config.issuer) return fail(503);
    if (new URL(c.req.url).origin !== config.portalOrigin || c.req.header("Origin") !== undefined && c.req.header("Origin") !== config.portalOrigin
      || c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") return fail(403);
    if (c.req.method !== "GET") return c.body(null, 405);
    return next();
  });
  router.get("/policy", async c => {
    const human = await resolveCloudflareRecipientEnrollmentProof(c.req.raw, { ...c.env, CLIENT_ACCESS_AUD: config.audience, CLIENT_ACCESS_AUDS: config.audience });
    const until = human ? Date.parse(human.verifiedUntil) : NaN;
    if (!human || !Number.isSafeInteger(until) || until <= Date.now()) return fail(401);
    const url = new URL(c.req.url);
    if (url.search || url.pathname !== BASE + "/policy") return fail(400);
    return c.json(windowsFilesClientPolicy(new Date(until).toISOString()));
  });
  router.all("*", () => fail(404));
  router.onError((error, c) => c.json({ error: "Windows files are unavailable" }, error instanceof HTTPException ? error.status : 503));
  return router;
}
