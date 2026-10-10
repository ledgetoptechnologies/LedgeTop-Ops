import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration,
  type AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { dispatchStagedOperationsPortalNativeDeliveryAuthority,
  type OperationsPortalNativeDeliveryAuthorityDispatchEnv }
  from "./operations-portal-native-delivery-authority-dispatch";
import { issueOperationsPortalNativeDeliveryAuthority, listOperationsPortalNativeDeliveryCandidates,
  listOperationsPortalNativeDeliveryAuthoritiesForOwner, OperationsPortalNativeDeliveryCandidateStaleError,
  readOperationsPortalNativeDeliveryAuthorityStatusForOwner,
  revokeOperationsPortalNativeDeliveryAuthority, type OperationsPortalNativeDeliveryAuthorityOwnerStatus }
  from "./operations-portal-native-delivery-authority-issuer";
import { reserveOperationsPortalNativeDeliveryRecoveryInvocation }
  from "./operations-portal-native-delivery-recovery-invocations";
import { OPERATIONS_PORTAL_NATIVE_DELIVERY_FEATURES,
  type OperationsPortalNativeDeliveryFeature } from "@ltds/shared/operations-portal-native-delivery-authority";

const BASE = "/api/native-client-portal/operations-delivery-authority";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const CURSOR = /^v1\.([A-Za-z0-9_-]{1,900})\.([0-9a-f]{64})$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
type Actor = AuthenticatedNativeStaffWithAdmissionVersion;
type Configuration = NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
export type OperationsPortalNativeDeliveryAuthorityOwnerHttpDependencies = Readonly<{
  environment: string; expectedHost: string; configuration: Configuration;
  database: D1Database; dispatch: OperationsPortalNativeDeliveryAuthorityDispatchEnv;
}>;

class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const response = (status: number, body: unknown) => Response.json(body, { status, headers: {
  "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
} });
function httpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash
    || url.username || url.password || url.port) throw Error();
  return url;
}
function configuration(d: OperationsPortalNativeDeliveryAuthorityOwnerHttpDependencies) {
  if (d.environment !== "staging" || !d.configuration.enabled) throw new Failure(404, "not_found");
  try {
    const origin = httpsOrigin(d.configuration.origin), issuer = httpsOrigin(d.configuration.issuer);
    const secretBytes = encoder.encode(d.configuration.csrfSecret).byteLength;
    if (origin.hostname !== d.expectedHost || !/(?:^|[-.])staging(?:[-.]|$)/u.test(origin.hostname)
      || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com"
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(d.configuration.staffAudience)
      || secretBytes < 32 || secretBytes > 512
      || d.dispatch.ENVIRONMENT !== "staging" || d.dispatch.EXPECTED_HOST !== d.expectedHost
      || d.dispatch.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED !== "true"
      || typeof d.dispatch.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY?.applyNativeDeliveryAuthority !== "function"
      || typeof d.dispatch.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY?.getNativeDeliveryAuthorityStatus !== "function") throw Error();
    return { origin: origin.origin, secret: d.configuration.csrfSecret,
      access: { enabled: true, issuer: issuer.origin, staffAudience: d.configuration.staffAudience } };
  } catch { throw new Failure(503, "unavailable"); }
}
const alive = (actor: Actor) => {
  if (!Number.isFinite(Date.parse(actor.verifiedUntil)) || Date.parse(actor.verifiedUntil) <= Date.now())
    throw new Failure(403, "denied");
};
async function hmac(secret: string, value: Uint8Array, mode: "sign" | "verify", signature?: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false,
    [mode]);
  const data = new Uint8Array(value).buffer;
  return mode === "sign" ? new Uint8Array(await crypto.subtle.sign("HMAC", key, data))
    : crypto.subtle.verify("HMAC", key, new Uint8Array(signature!).buffer, data);
}
function hex(bytes: Uint8Array) { return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function bytes(value: string) { return Uint8Array.from(value.match(/../gu)!, part => Number.parseInt(part, 16)); }
function csrfMessage(origin: string, actor: Actor, bucket: number) {
  return encoder.encode(JSON.stringify(["operations-native-delivery-owner-csrf-v1", origin,
    actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion, bucket]));
}
async function csrf(secret: string, origin: string, actor: Actor, request?: Request): Promise<string> {
  const bucket = Math.floor(Date.now() / 600_000);
  if (!request) return `${bucket}.${hex(await hmac(secret, csrfMessage(origin, actor, bucket), "sign") as Uint8Array)}`;
  const token = request.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u);
  const supplied = Number(token?.[1]);
  if (!token || supplied !== bucket && supplied !== bucket - 1
    || !await hmac(secret, csrfMessage(origin, actor, supplied), "verify", bytes(token[2]!)))
    throw new Failure(403, "denied");
  return "";
}
function b64url(value: Uint8Array) {
  let binary = ""; for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
function unb64url(value: string) {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}
async function encodeCursor(secret: string, actor: Actor, targetId: string,
  next: Readonly<{ recipientBindingId: string; folderReservationId: string }> | null) {
  if (!next) return null;
  const payload = encoder.encode(JSON.stringify([targetId, actor.identity.staffId,
    actor.identity.verifiedAccessSubject, actor.admissionVersion, next.recipientBindingId, next.folderReservationId]));
  const encoded = b64url(payload), signature = hex(await hmac(secret,
    encoder.encode(`operations-native-delivery-owner-cursor-v1.${encoded}`), "sign") as Uint8Array);
  return `v1.${encoded}.${signature}`;
}
async function decodeCursor(secret: string, actor: Actor, targetId: string, value: string | null) {
  if (value === null) return null;
  if (value.length > 1024) throw new Failure(400, "invalid_request");
  const match = value.match(CURSOR); if (!match) throw new Failure(400, "invalid_request");
  if (!await hmac(secret, encoder.encode(`operations-native-delivery-owner-cursor-v1.${match[1]}`),
    "verify", bytes(match[2]!))) throw new Failure(403, "denied");
  let payload: unknown;
  try { payload = JSON.parse(decoder.decode(unb64url(match[1]!))); } catch { throw new Failure(400, "invalid_request"); }
  if (!Array.isArray(payload) || payload.length !== 6 || payload[0] !== targetId
    || payload[1] !== actor.identity.staffId || payload[2] !== actor.identity.verifiedAccessSubject
    || payload[3] !== actor.admissionVersion || !UUID.test(payload[4]) || !UUID.test(payload[5]))
    throw new Failure(403, "denied");
  return { recipientBindingId: payload[4], folderReservationId: payload[5] };
}
async function encodeAuthorityCursor(secret: string, actor: Actor, targetId: string, authorityId: string | null) {
  if (!authorityId) return null;
  const payload = encoder.encode(JSON.stringify(["authorities", targetId, actor.identity.staffId,
    actor.identity.verifiedAccessSubject, actor.admissionVersion, authorityId]));
  const encoded = b64url(payload), signature = hex(await hmac(secret,
    encoder.encode(`operations-native-delivery-owner-authority-cursor-v1.${encoded}`), "sign") as Uint8Array);
  return `v1.${encoded}.${signature}`;
}
async function decodeAuthorityCursor(secret: string, actor: Actor, targetId: string, value: string | null) {
  if (value === null) return null;
  if (value.length > 1024) throw new Failure(400, "invalid_request");
  const match = value.match(CURSOR); if (!match) throw new Failure(400, "invalid_request");
  if (!await hmac(secret, encoder.encode(`operations-native-delivery-owner-authority-cursor-v1.${match[1]}`),
    "verify", bytes(match[2]!))) throw new Failure(403, "denied");
  let payload: unknown;
  try { payload = JSON.parse(decoder.decode(unb64url(match[1]!))); } catch { throw new Failure(400, "invalid_request"); }
  if (!Array.isArray(payload) || payload.length !== 6 || payload[0] !== "authorities" || payload[1] !== targetId
    || payload[2] !== actor.identity.staffId || payload[3] !== actor.identity.verifiedAccessSubject
    || payload[4] !== actor.admissionVersion || !uuid(payload[5])) throw new Failure(403, "denied");
  return payload[5];
}
async function body(request: Request, names: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type") ?? ""))
    throw new Failure(400, "invalid_request");
  let value: unknown; try { value = await readBoundedJson(request, 8192, "native delivery owner"); }
  catch { throw new Failure(400, "invalid_request"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name)))
    throw new Failure(400, "invalid_request");
  return value as Record<string, unknown>;
}
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && value === value.trim()
    && !/\p{C}/u.test(value);
}
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function features(value: unknown): value is readonly OperationsPortalNativeDeliveryFeature[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPERATIONS_PORTAL_NATIVE_DELIVERY_FEATURES.length)
    return false;
  let previous = -1;
  return value.every(item => {
    const position = OPERATIONS_PORTAL_NATIVE_DELIVERY_FEATURES.indexOf(item as OperationsPortalNativeDeliveryFeature);
    if (position <= previous) return false; previous = position; return true;
  });
}
function expiry(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value && time > Date.now()
    && time <= Date.now() + 30 * 86_400_000;
}
function ownerAuthority(status: OperationsPortalNativeDeliveryAuthorityOwnerStatus) {
  return Object.freeze({ ...status.authority, latestAction: status.latestAction,
    transportStatus: status.transportStatus, recoveryOperationId: status.recoveryOperationId });
}
async function mutationResponse(database: D1Database, authorityId: string, operationId: string, actor: Actor,
  dispatched: Awaited<ReturnType<typeof dispatchStagedOperationsPortalNativeDeliveryAuthority>>, replayed = false) {
  alive(actor);
  const status = await readOperationsPortalNativeDeliveryAuthorityStatusForOwner(database, authorityId, actor); alive(actor);
  if (dispatched?.state === "dead" || status.transportStatus === "dead")
    return response(409, { operationId, status: "rejected" });
  const acknowledged = status.transportStatus === "acknowledged";
  return response(acknowledged ? 200 : 202, { operationId,
    status: acknowledged ? "acknowledged" : "pending", authority: ownerAuthority(status), replayed,
    recoveryOperationId: status.recoveryOperationId });
}

/** Staging-only current-manager boundary. Registration is intentionally separate. */
export async function handleOperationsPortalNativeDeliveryAuthorityOwnerHttp(request: Request,
  d: OperationsPortalNativeDeliveryAuthorityOwnerHttpDependencies): Promise<Response> {
  try {
    const config = configuration(d), url = new URL(request.url);
    if (url.origin !== config.origin || url.hash || request.headers.get("Sec-Fetch-Site") !== "same-origin")
      throw new Failure(403, "denied");
    const relative = url.pathname.startsWith(`${BASE}/`) ? url.pathname.slice(BASE.length) : "";
    const sessionRoute = request.method === "GET" && relative === "/session";
    const candidatesRoute = request.method === "GET" && relative === "/candidates";
    const authoritiesRoute = request.method === "GET" && relative === "/authorities";
    const issueRoute = request.method === "POST" && relative === "/authorities";
    const readRoute = request.method === "GET" && /^\/authorities\/[0-9a-f-]{36}$/u.test(relative);
    const mutationRoute = request.method === "POST"
      && /^\/authorities\/[0-9a-f-]{36}\/(revoke|recover)$/u.test(relative);
    if (!sessionRoute && !candidatesRoute && !authoritiesRoute && !issueRoute && !readRoute && !mutationRoute)
      throw new Failure(404, "not_found");
    const collectionRoute = candidatesRoute || authoritiesRoute;
    if (!collectionRoute && url.search || collectionRoute && [...url.searchParams.keys()]
      .some(key => key !== "targetId" && key !== "cursor")) throw new Failure(400, "invalid_request");
    if (request.headers.has("Origin") && request.headers.get("Origin") !== config.origin
      || request.method === "POST" && request.headers.get("Origin") !== config.origin
      || request.method === "GET" && request.headers.get("X-Native-Staff-Request") !== "1")
      throw new Failure(403, "denied");
    let actor: Actor;
    try { actor = await authenticateNativeStaffWithAdmissionVersion(request, d.database, config.access); }
    catch { throw new Failure(403, "denied"); }
    alive(actor);
    if (sessionRoute) return response(200, { csrfToken: await csrf(config.secret, config.origin, actor),
      verifiedUntil: actor.verifiedUntil });
    if (candidatesRoute) {
      const targetId = url.searchParams.get("targetId");
      if (!targetId || !UUID.test(targetId) || url.searchParams.getAll("targetId").length !== 1
        || url.searchParams.getAll("cursor").length > 1) throw new Failure(400, "invalid_request");
      const after = await decodeCursor(config.secret, actor, targetId, url.searchParams.get("cursor"));
      const page = await listOperationsPortalNativeDeliveryCandidates(d.database, { targetId, after, owner: actor });
      alive(actor); return response(200, { items: page.items,
        page: { nextCursor: await encodeCursor(config.secret, actor, targetId, page.next) } });
    }
    if (authoritiesRoute) {
      const targetId = url.searchParams.get("targetId");
      if (!targetId || !UUID.test(targetId) || url.searchParams.getAll("targetId").length !== 1
        || url.searchParams.getAll("cursor").length > 1) throw new Failure(400, "invalid_request");
      const afterAuthorityId = await decodeAuthorityCursor(config.secret, actor, targetId,
        url.searchParams.get("cursor"));
      const page = await listOperationsPortalNativeDeliveryAuthoritiesForOwner(d.database, {
        targetId, afterAuthorityId, owner: actor });
      alive(actor); return response(200, { items: page.items.map(ownerAuthority),
        page: { nextCursor: await encodeAuthorityCursor(config.secret, actor, targetId, page.nextAuthorityId) } });
    }
    const authorityId = readRoute || mutationRoute ? relative.split("/")[2]! : null;
    if (authorityId && !UUID.test(authorityId)) throw new Failure(404, "not_found");
    if (readRoute) {
      const status = await readOperationsPortalNativeDeliveryAuthorityStatusForOwner(d.database, authorityId!, actor);
      alive(actor); return response(200, { authority: ownerAuthority(status) });
    }
    await csrf(config.secret, config.origin, actor, request); alive(actor);
    if (issueRoute) {
      const value = await body(request, ["operationId", "authorityId", "recipientBindingId", "folderReservationId",
        "expectedRevision", "expectedCandidateFingerprint", "features", "expiresAt", "reasonCode"]);
      if (!uuid(value.operationId) || !uuid(value.authorityId) || !uuid(value.recipientBindingId)
        || !uuid(value.folderReservationId) || !integer(value.expectedRevision, 0)
        || !hash(value.expectedCandidateFingerprint)
        || !features(value.features) || !expiry(value.expiresAt) || !bounded(value.reasonCode, 200))
        throw new Failure(400, "invalid_request");
      let issued;
      try { issued = await issueOperationsPortalNativeDeliveryAuthority(d.database, {
        operationId: value.operationId, authorityId: value.authorityId,
        recipientBindingId: value.recipientBindingId, folderReservationId: value.folderReservationId,
        expectedRevision: value.expectedRevision, expectedCandidateFingerprint: value.expectedCandidateFingerprint,
        features: value.features, expiresAt: value.expiresAt, reasonCode: value.reasonCode, owner: actor,
      }); } catch (error) {
        if (error instanceof OperationsPortalNativeDeliveryCandidateStaleError)
          return response(409, { error: "candidate_review_stale" });
        throw error;
      }
      alive(actor);
      const dispatched = await dispatchStagedOperationsPortalNativeDeliveryAuthority(d.dispatch, value.operationId);
      return mutationResponse(d.database, value.authorityId, value.operationId, actor, dispatched, issued.replayed);
    }
    const action = relative.split("/")[3]!;
    const value = await body(request, action === "revoke" ? ["operationId", "expectedRevision", "reasonCode"]
      : ["invocationId", "operationId", "expectedRevision", "reason"]);
    if (!uuid(value.operationId) || !integer(value.expectedRevision, 1)) throw new Failure(400, "invalid_request");
    if (action === "revoke") {
      if (!bounded(value.reasonCode, 200)) throw new Failure(400, "invalid_request");
      const revoked = await revokeOperationsPortalNativeDeliveryAuthority(d.database, { operationId: value.operationId,
        authorityId: authorityId!, expectedRevision: value.expectedRevision, reasonCode: value.reasonCode, owner: actor });
      alive(actor);
      const dispatched = await dispatchStagedOperationsPortalNativeDeliveryAuthority(d.dispatch, value.operationId);
      return mutationResponse(d.database, authorityId!, value.operationId, actor, dispatched, revoked.replayed);
    }
    if (!uuid(value.invocationId) || !bounded(value.reason, 500)) throw new Failure(400, "invalid_request");
    const before = await readOperationsPortalNativeDeliveryAuthorityStatusForOwner(d.database, authorityId!, actor); alive(actor);
    if (before.authority.revision !== value.expectedRevision || before.recoveryOperationId !== value.operationId
      || before.transportStatus !== "pending") return response(409, { operationId: value.operationId, status: "rejected" });
    const invocation = await reserveOperationsPortalNativeDeliveryRecoveryInvocation(d.database, {
      invocationId: value.invocationId, operationId: value.operationId, authorityId: authorityId!,
      expectedRevision: value.expectedRevision, reason: value.reason, owner: actor });
    alive(actor);
    const dispatched = invocation.state === "authorized"
      ? await dispatchStagedOperationsPortalNativeDeliveryAuthority(d.dispatch, value.operationId, value.invocationId) : null;
    return mutationResponse(d.database, authorityId!, value.operationId, actor, dispatched, invocation.replayed);
  } catch (error) {
    const denied = error instanceof Error && (error.message === "operations_portal_native_delivery_authority_denied"
      || error.message === "operations_portal_native_delivery_recovery_invocation_denied");
    const failure = error instanceof Failure ? error : new Failure(
      denied ? 403 : 503, denied ? "denied" : "unavailable");
    return response(failure.status, { error: failure.code });
  }
}
