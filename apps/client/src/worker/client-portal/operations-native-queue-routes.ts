import { Hono } from "hono";
import { queueContext, queuePrincipal, encodeQueueReference, decodeQueueReference, queueQuery } from "@ltds/shared/windows-queue-reference";
import type { Env } from "../types";
import { nativeDeliveryDeploymentEnabled } from "../operations-native-delivery-deployment";
import { resolveCloudflareRecipientEnrollmentProof } from "./access-identity";
import { authorizeNativeOperationsDelivery, type NativeOperationsDeliveryAuthorizationEnv } from "./operations-native-delivery-authorization";
import { decodeOperationsNativeDeliveryHandle, encodeOperationsNativeDeliveryHandle, type OperationsNativeDeliveryHandle } from "./operations-native-delivery-handles";
import { createOperationsNativeDeliveryRouter } from "./operations-native-delivery-routes";
import type { OperationsNativeContentAuditEnv } from "./operations-native-content-audit";
import type { VerifiedClientPrincipal } from "./types";
import { validateRelativePath } from "../files";

type QueueEnv = Env & NativeOperationsDeliveryAuthorizationEnv & OperationsNativeContentAuditEnv;
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
      const q = queueQuery(c.req.url, ["fileHandle"]), decoded = await decodeOperationsNativeDeliveryHandle(c.env, q.get("fileHandle")!);
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
      const fresh = await authorizeNativeOperationsDelivery(c.env, h.principal, r.authorityId, "file.download");
      if (!fresh.ok) return error(fresh.code === "unavailable" ? 503 : 409);
      const expires = Math.min(Date.now() + ttl, Date.parse(h.verifiedUntil), Date.parse(fresh.context.command.expiresAt!));
      // No storage access until the reference's exact original pins have been checked.
      const candidate = { ...r, etag: "pending", expires } as OperationsNativeDeliveryHandle;
      // Validate exact original selector shape before any index read.
      await encodeOperationsNativeDeliveryHandle(c.env, candidate);
      const pinned = await authorizeNativeOperationsDelivery(c.env, h.principal, r.authorityId, "file.download", candidate);
      if (!pinned.ok) return error(pinned.code === "unavailable" ? 503 : 409);
      const key = pinned.context.selectedR2Prefix + r.path;
      const row = await c.env.DELIVERY_DB.withSession("first-primary").prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(key).first<{ etag: string }>();
      if (!row || typeof row.etag !== "string") return error(409);
      handle = { ...candidate, etag: row.etag };
    }
    const auth = await authorizeNativeOperationsDelivery(c.env, h.principal, handle.authorityId, "file.download", handle);
    if (!auth.ok) return error(auth.code === "unavailable" ? 503 : 409);
    if (operation === "reference") {
      const resourceRef = await encodeQueueReference(context, principalId, selection(handle));
      const final = await authorizeNativeOperationsDelivery(c.env, h.principal, handle.authorityId, "file.download", handle);
      if (!final.ok || Date.parse(h.verifiedUntil) <= Date.now()) return error(final.ok || final.code !== "unavailable" ? 409 : 503);
      return c.json({ schemaVersion: 1, principalId, resourceRef });
    }
    handle = { ...handle, expires: Math.min(handle.expires, Date.parse(h.verifiedUntil)) };
    const encoded = await encodeOperationsNativeDeliveryHandle(c.env, handle);
    // In-process reuse of the existing full native manifest implementation: no
    // network hop, bearer forwarding or alternate storage validation path.
    const reads = createOperationsNativeDeliveryRouter({ resolvePrincipal: async () => h.principal });
    const response = await reads.fetch(new Request(config.portalOrigin + "/files/" + encoded + "/download-manifest", { signal: c.req.raw.signal }), c.env);
    if (response.status !== 200) return response;
    const manifest: unknown = await response.json();
    const final = await authorizeNativeOperationsDelivery(c.env, h.principal, handle.authorityId, "file.download", handle);
    if (!final.ok || Date.parse(h.verifiedUntil) <= Date.now()) return error(final.ok || final.code !== "unavailable" ? 409 : 503);
    return c.json({ schemaVersion: 1, principalId, manifest });
  });
  router.onError(() => error(503)); return router;
}
