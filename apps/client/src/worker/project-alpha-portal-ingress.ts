import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { createCatalogSourceContext } from "@ltds/shared";
import type { Env } from "./types";
import { applyPortalProjectionDelivery, parsePortalProjectionDelivery, verifyHmac } from "./project-alpha-portal";
import { portalSourceAuthoritiesReady, resolvePortalSourceAuthority, PortalSourceAuthorityError } from "./project-alpha-portal-authority";

type ResolvedAuthority = Awaited<ReturnType<typeof resolvePortalSourceAuthority>>;
export function portalSourceProjectionPath(sourceId: string): string {
  return `/api/internal/project-alpha/sources/${encodeURIComponent(createCatalogSourceContext(sourceId).sourceId)}/portal-v2`;
}
export async function verifyRegisteredPortalAccess(request: Request, authority: ResolvedAuthority, getKey?: JWTVerifyGetKey): Promise<void> {
  try {
    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion) throw new Error();
    const { payload } = await jwtVerify(assertion, getKey ?? createRemoteJWKSet(new URL(`${authority.accessIssuer}/cdn-cgi/access/certs`)), {
      issuer: authority.accessIssuer, audience: authority.accessAudience, algorithms: ["RS256"],
    });
    if (payload.sub !== authority.accessSubject) throw new Error();
  } catch { throw new Error("portal-access-invalid"); }
}
const maximumBytes = 256 * 1024;
async function readBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) throw new Error("portal-size-invalid");
  if (!request.body) throw new Error("portal-json-invalid");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + 10_000;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("portal-body-timeout")), 10_000); });
  try {
    while (true) {
      if (Date.now() >= deadline) throw new Error("portal-body-timeout");
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      if (!result.value.byteLength) continue;
      length += result.value.byteLength;
      if (length > maximumBytes) throw new Error("portal-size-invalid");
      chunks.push(result.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { clearTimeout(timer); reader.releaseLock(); }
  if (!length) throw new Error("portal-json-invalid");
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function hash(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function json(status: number, value: object): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
/** The URL is an untrusted candidate. Only the registered Access+HMAC proof
 * chooses the source passed to the existing projection implementation. */
export async function handleRegisteredProjectAlphaPortalRequest(request: Request, env: Env, sourceId: string,
  accessVerifier: (request: Request, authority: ResolvedAuthority) => Promise<void> = verifyRegisteredPortalAccess): Promise<Response> {
  if (env.PROJECT_ALPHA_PORTAL_SYNC_ENABLED !== "true" || request.method !== "POST") return json(404, { error: "not-found" });
  try {
    if (!await portalSourceAuthoritiesReady(env.DELIVERY_DB.withSession("first-primary"))) return json(503, { error: "portal-authority-unavailable" });
    const authority = await resolvePortalSourceAuthority(env, sourceId);
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return json(415, { error: "content-type-required" });
    await accessVerifier(request, authority);
    const raw = await readBody(request), bodyHash = await hash(raw);
    const timestamp = request.headers.get("X-Portal-Integration-Timestamp");
    if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60_000) throw new Error("portal-timestamp-invalid");
    if (request.headers.get("X-Portal-Integration-Application-Key") !== authority.applicationKey) throw new Error("portal-application-mismatch");
    if (request.headers.get("X-Portal-Integration-Body-SHA256") !== bodyHash) throw new Error("portal-body-digest-invalid");
    const keyId = request.headers.get("X-Portal-Integration-Key-Id"), deliveryId = request.headers.get("X-Portal-Integration-Delivery-Id");
    if (!keyId || !deliveryId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(deliveryId)) throw new Error("portal-signing-key-invalid");
    const key = keyId === authority.current.keyId ? authority.current : keyId === authority.previous?.keyId ? authority.previous : null;
    if (!key) throw new Error("portal-signing-key-invalid");
    await verifyHmac(raw, timestamp, keyId, deliveryId, request.headers.get("X-Portal-Integration-Signature"), key.value, portalSourceProjectionPath(authority.proof.sourceId));
    let wire: unknown;
    try { wire = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { throw new Error("portal-json-invalid"); }
    const delivery = parsePortalProjectionDelivery(wire, authority.applicationKey, env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true");
    if (delivery.deliveryId !== deliveryId) throw new Error("portal-delivery-id-mismatch");
    const status = await applyPortalProjectionDelivery(env, delivery, bodyHash, createCatalogSourceContext(authority.proof.sourceId), authority.proof);
    return json(200, { ok: true, deliveryId, status });
  } catch (error) {
    if (error instanceof PortalSourceAuthorityError) return json(error.code === "unavailable" ? 404 : error.code === "credentials_unavailable" ? 503 : error.code === "invalid" ? 400 : 409, { error: error.message });
    const message = error instanceof Error ? error.message : "";
    if (message.includes("pa_portal_source_write_guard")) return json(409, { error: "portal-authority-changed" });
    if (/^portal-[a-z-]+$/.test(message)) {
      const status = /access|signature|signing-key|timestamp/.test(message) ? 401 : /size/.test(message) ? 413
        : /timeout/.test(message) ? 408 : /conflict|stale|generation|sequence|reparent/.test(message) ? 409 : 422;
      return json(status, { error: message });
    }
    return json(500, { error: "portal-internal-error" });
  }
}
