import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { queueContext, queuePrincipal, encodeQueueReference, decodeQueueReference, queueQuery } from "@ltds/shared/windows-queue-reference";
import type { Env } from "../types";
import { nativeDeliveryDeploymentEnabled } from "../operations-native-delivery-deployment";
import { resolveCloudflareRecipientEnrollmentProof } from "./access-identity";
import { authorizeNativeOperationsDelivery, type NativeOperationsDeliveryAuthorizationEnv } from "./operations-native-delivery-authorization";
import { decodeOperationsNativeDeliveryHandle, encodeOperationsNativeDeliveryHandle, operationsNativeDeliveryHandleMatchesCommand, type OperationsNativeDeliveryHandle } from "./operations-native-delivery-handles";
import { authorizeWindowsPortalSuccessor } from "./windows-portal-successor-authorization";
import { prepareWindowsPortalSuccessorManifest } from "./windows-portal-successor-routes";
import { selectWindowsPortalCatalogDownload } from "./windows-portal-catalog-routes";
import type { OperationsNativeContentAuditEnv } from "./operations-native-content-audit";
import type { VerifiedClientPrincipal } from "./types";
import { validateRelativePath } from "../files";

type QueueEnv = Env & NativeOperationsDeliveryAuthorizationEnv & OperationsNativeContentAuditEnv
  & Parameters<typeof authorizeWindowsPortalSuccessor>[0] & Parameters<typeof selectWindowsPortalCatalogDownload>[0];
type Configuration = Readonly<{ enabled: boolean; portalOrigin: string; issuer: string; audience: string; queueKey: Uint8Array }>;
type Human = { principal: VerifiedClientPrincipal; verifiedUntil: string };
const BASE = "/api/client/operations/data", ttl = 900_000;
const error = (status: number) => Response.json({ error: "queue_unavailable" }, { status, headers: { "Cache-Control": "private, no-store" } });
/** All authority lifecycle pins are retained; ephemeral content/provider pins are freshly resolved. */
function selection(h: OperationsNativeDeliveryHandle): Record<string, unknown> {
  const { expires: _expiry, etag: _etag, providerVersion: _version, sha256: _sha, ...rest } = h;
  return rest;
}
/** Unmounted source-only queue API; native delivery deployment admission remains mandatory. */
export function createOperationsNativeQueueRouter(input: Configuration) {
  const config = { ...input, queueKey: new Uint8Array(input.queueKey) };
  const context = queueContext({ source: "portal", origin: config.portalOrigin, issuer: config.issuer, audience: config.audience, key: config.queueKey });
  const router = new Hono<{ Bindings: QueueEnv; Variables: { human: Human } }>().basePath(BASE + "/queue");
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store"); c.header("Cloudflare-CDN-Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff");
    if (!config.enabled || c.env.CLIENT_PORTAL_ENABLED !== "true" || c.env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED !== "true" || !nativeDeliveryDeploymentEnabled(c.env)) return error(503);
    if (c.env.CLIENT_PORTAL_ORIGIN !== config.portalOrigin || new URL(c.req.url).origin !== config.portalOrigin
      || c.req.header("Origin") !== undefined && c.req.header("Origin") !== config.portalOrigin || c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") return error(403);
    if (c.req.method !== "GET") return error(405);
    // The queue is one exact Access app. Existing multi-audience portal routes remain unchanged.
    if (c.env.CLIENT_ACCESS_TEAM_DOMAIN?.replace(/\/$/u, "") !== config.issuer) return error(503);
    const env = { ...c.env, CLIENT_ACCESS_AUD: config.audience, CLIENT_ACCESS_AUDS: config.audience };
    const human = await resolveCloudflareRecipientEnrollmentProof(c.req.raw, env);
    if (!human) return error(401);
    c.set("human", human); return next();
  });
  const principal = (h: Human) => queuePrincipal(context, [h.principal.subject]);
  router.get("/session", async c => {
    queueQuery(c.req.url, []); const h = c.get("human"), principalId = await principal(h);
    if (Date.parse(h.verifiedUntil) <= Date.now()) return error(401);
    return c.json({ schemaVersion: 1, principalId, expiresAt: Math.floor(Date.parse(h.verifiedUntil) / 1000) });
  });
  for (const operation of ["reference", "resolve"] as const) router.get("/" + operation, async c => {
    const h = c.get("human"), principalId = await principal(h);
    let handle: OperationsNativeDeliveryHandle;
    if (operation === "reference") {
      const q = queueQuery(c.req.url, ["fileHandle"]), raw = q.get("fileHandle")!;
      if (raw.startsWith("wpc1_")) {
        const selected = await selectWindowsPortalCatalogDownload(c.env, raw, h.principal, Date.parse(h.verifiedUntil), c.req.raw.signal);
        const resourceRef = await encodeQueueReference(context, principalId, selection(selected.originalSelector));
        const final = await authorizeWindowsPortalSuccessor(c.env, h.principal, selected.originalSelector.authorityId);
        if (!final.ok || JSON.stringify(final.successorContext) !== JSON.stringify(selected.downloadContext) || Date.parse(h.verifiedUntil) <= Date.now())
          return error(!final.ok && final.code === "unavailable" ? 503 : 409);
        return c.json({ schemaVersion: 1, principalId, resourceRef });
      }
      const decoded = await decodeOperationsNativeDeliveryHandle(c.env, raw);
      if (!decoded || decoded.kind !== "file" || decoded.issuer !== h.principal.issuer || decoded.subject !== h.principal.subject) return error(404);
      handle = decoded;
    } else {
      const q = queueQuery(c.req.url, ["resourceRef"]), reference = await decodeQueueReference(context, q.get("resourceRef")!);
      if (!reference || reference.principalId !== principalId) return error(409);
      // Rebuild only a short selector; the old reference never extends a grant.
      // Fresh current command and exact old lifecycle comparison are mandatory below.
      const r = reference.resource;
      if (r.kind !== "file" || typeof r.authorityId !== "string" || typeof r.path !== "string" || !r.path || validateRelativePath(r.path) !== r.path
        || r.issuer !== h.principal.issuer || r.subject !== h.principal.subject) return error(409);
      const fresh = await authorizeWindowsPortalSuccessor(c.env, h.principal, r.authorityId);
      if (!fresh.ok) return error(fresh.code === "unavailable" ? 503 : 409);
      const successorContext = fresh.successorContext;
      const expires = Math.min(Date.now() + ttl, Date.parse(h.verifiedUntil), Date.parse(successorContext.originalGrant.expiresAt!));
      // No storage access until the reference's exact original pins have been checked.
      const candidate = { ...r, etag: "pending", expires } as OperationsNativeDeliveryHandle;
      // Validate exact original selector shape before any index read.
      await encodeOperationsNativeDeliveryHandle(c.env, candidate);
      if (!operationsNativeDeliveryHandleMatchesCommand(candidate, successorContext.originalGrant)) return error(409);
      // Keep every original lifecycle pin in the durable reference. Only the
      // distinct short selector uses the proved effective publication.
      const response = await prepareWindowsPortalSuccessorManifest(c.env, successorContext, h.principal,
        Date.parse(h.verifiedUntil), r.path, c.req.raw.signal);
      if (response.status !== 200) return response;
      const manifest: unknown = await response.json();
      const final = await authorizeWindowsPortalSuccessor(c.env, h.principal, r.authorityId);
      if (!final.ok || JSON.stringify(final.successorContext) !== JSON.stringify(successorContext) || Date.parse(h.verifiedUntil) <= Date.now())
        return error(!final.ok && final.code === "unavailable" ? 503 : 409);
      return c.json({ schemaVersion: 1, principalId, manifest });
    }
    const auth = await authorizeNativeOperationsDelivery(c.env, h.principal, handle.authorityId, "file.download", handle);
    if (!auth.ok) return error(auth.code === "unavailable" ? 503 : 409);
    if (operation === "reference") {
      const resourceRef = await encodeQueueReference(context, principalId, selection(handle));
      const final = await authorizeNativeOperationsDelivery(c.env, h.principal, handle.authorityId, "file.download", handle);
      if (!final.ok || Date.parse(h.verifiedUntil) <= Date.now()) return error(final.ok || final.code !== "unavailable" ? 409 : 503);
      return c.json({ schemaVersion: 1, principalId, resourceRef });
    }
    return error(503);
  });
  router.onError(failure => error(failure instanceof HTTPException ? failure.status : 503)); return router;
}
