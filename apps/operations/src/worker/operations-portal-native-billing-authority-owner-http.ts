import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion, type AuthenticatedNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from "./native-staff-auth";

const BASE = "/api/native-client-portal/operations-billing-authority";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
type Actor = AuthenticatedNativeStaffWithAdmissionVersion;
type Entity = Readonly<{ kind: "organization" | "client" | "project"; nativeId: string }>;
type Selection = Readonly<{ targetId: string; recipientBindingId: string; entity: Entity; expiresAt: string | null }>;
type ReviewInput = Selection;
type GrantInput = Selection & Readonly<{ operationId: string; grantId: string; expectedRevision: number;
  reviewFingerprint: string }>;
type RevokeInput = Readonly<{ operationId: string; grantId: string; expectedRevision: number }>;
type Configuration = NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
export type OperationsPortalNativeBillingAuthorityOwnerHttpDependencies = Readonly<{
  environment: string; expectedHost: string; lifecycleFlag: string;
  configuration: Configuration; database: D1Database;
  core: Readonly<{
    review: (db: D1Database, actor: Actor, input: ReviewInput) => Promise<unknown>;
    grant: (db: D1Database, actor: Actor, input: GrantInput) => Promise<unknown>;
    revoke: (db: D1Database, actor: Actor, input: RevokeInput) => Promise<unknown>;
    readStatus: (db: D1Database, actor: Actor, grantId: string) => Promise<unknown>;
  }>;
  authenticate?: typeof authenticateNativeStaffWithAdmissionVersion;
}>;

class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const response = (status: number, body: unknown) => Response.json(body, { status, headers: {
  "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
} });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value)
  && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && HASH.test(value);
const revision = (value: unknown, minimum: number): value is number => typeof value === "number"
  && Number.isSafeInteger(value) && value >= minimum;
function entity(value: unknown): value is Entity {
  return exact(value, ["kind", "nativeId"])
    && (value.kind === "organization" || value.kind === "client" || value.kind === "project")
    && typeof value.nativeId === "string" && value.nativeId.length >= 1 && value.nativeId.length <= 191
    && value.nativeId === value.nativeId.trim() && !/\p{C}/u.test(value.nativeId);
}
function expires(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value && time > Date.now();
}
function selection(value: Record<string, unknown>): Selection {
  if (!uuid(value.targetId) || !uuid(value.recipientBindingId)
    || !entity(value.entity) || !expires(value.expiresAt)) throw new Failure(400, "invalid_request");
  return { targetId: value.targetId, recipientBindingId: value.recipientBindingId,
    entity: value.entity, expiresAt: value.expiresAt };
}
function httpsOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash
    || url.username || url.password || url.port) throw Error();
  return url;
}
function configuration(d: OperationsPortalNativeBillingAuthorityOwnerHttpDependencies) {
  if (d.environment !== "staging" || d.lifecycleFlag !== "true" || !d.configuration.enabled)
    throw new Failure(404, "not_found");
  try {
    const origin = httpsOrigin(d.configuration.origin), issuer = httpsOrigin(d.configuration.issuer);
    const secretBytes = encoder.encode(d.configuration.csrfSecret).byteLength;
    if (origin.hostname !== d.expectedHost || !/(?:^|[-.])staging(?:[-.]|$)/u.test(origin.hostname)
      || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com"
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(d.configuration.staffAudience)
      || secretBytes < 32 || secretBytes > 512 || !d.database
      || typeof d.core?.review !== "function" || typeof d.core.grant !== "function"
      || typeof d.core.revoke !== "function" || typeof d.core.readStatus !== "function") throw Error();
    return { origin: origin.origin, secret: d.configuration.csrfSecret,
      access: { enabled: true, issuer: issuer.origin, staffAudience: d.configuration.staffAudience } };
  } catch { throw new Failure(503, "unavailable"); }
}
function alive(actor: Actor) {
  if (!Number.isFinite(Date.parse(actor.verifiedUntil)) || Date.parse(actor.verifiedUntil) <= Date.now())
    throw new Failure(403, "denied");
}
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (value: string) => Uint8Array.from(value.match(/../gu)!, part => Number.parseInt(part, 16));
function buffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
function csrfMessage(origin: string, actor: Actor, bucket: number) {
  return encoder.encode(JSON.stringify(["operations-native-billing-owner-csrf-v1", origin,
    actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion,
    actor.identity.profileVersion, bucket]));
}
async function signature(secret: string, message: Uint8Array, supplied?: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", buffer(encoder.encode(secret)), { name: "HMAC", hash: "SHA-256" },
    false, supplied ? ["verify"] : ["sign"]);
  if (supplied) return crypto.subtle.verify("HMAC", key, buffer(supplied), buffer(message));
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer(message)));
}
async function csrf(secret: string, origin: string, actor: Actor, request?: Request) {
  const bucket = Math.floor(Date.now() / 600_000);
  if (!request) return `${bucket}.${hex(await signature(secret, csrfMessage(origin, actor, bucket)) as Uint8Array)}`;
  const token = request.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u);
  const supplied = Number(token?.[1]);
  if (!token || supplied !== bucket && supplied !== bucket - 1
    || !await signature(secret, csrfMessage(origin, actor, supplied), fromHex(token[2]!)))
    throw new Failure(403, "denied");
  return "";
}
async function body(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type") ?? ""))
    throw new Failure(400, "invalid_request");
  let value: unknown;
  try { value = await readBoundedJson(request, 4096, "native billing owner"); }
  catch { throw new Failure(400, "invalid_request"); }
  if (!exact(value, keys)) throw new Failure(400, "invalid_request");
  return value;
}
function reviewOutput(value: unknown) {
  if (!object(value) || !uuid(value.targetId) || !uuid(value.recipientBindingId)
    || !entity(value.entity) || !expires(value.expiresAt) || !revision(value.expectedRevision, 0)
    || !hash(value.reviewFingerprint) || !(value.grantId === null || uuid(value.grantId)))
    throw new Failure(503, "unavailable");
  return { targetId: value.targetId, recipientBindingId: value.recipientBindingId,
    entity: value.entity, expiresAt: value.expiresAt, expectedRevision: value.expectedRevision,
    reviewFingerprint: value.reviewFingerprint, grantId: value.grantId };
}
function mutationOutput(value: unknown, operationId: string, grantId: string) {
  if (!object(value)) throw new Failure(503, "unavailable");
  if (value.status === "conflict") throw new Failure(409, "conflict");
  if (value.operationId !== operationId || value.status !== "applied" && value.status !== "replayed")
    throw new Failure(503, "unavailable");
  return { operationId, status: value.status, authority: statusOutput(value.authority, grantId) };
}
function statusOutput(value: unknown, grantId: string) {
  if (!object(value) || value.grantId !== grantId || !revision(value.revision, 1)
    || value.state !== "active" && value.state !== "revoked" || typeof value.live !== "boolean"
    || !uuid(value.targetId) || !uuid(value.recipientBindingId) || !entity(value.entity)
    || !(value.expiresAt === null || typeof value.expiresAt === "string"
      && Number.isFinite(Date.parse(value.expiresAt)) && new Date(value.expiresAt).toISOString() === value.expiresAt))
    throw new Failure(503, "unavailable");
  return { grantId, revision: value.revision, state: value.state, live: value.live,
    targetId: value.targetId, recipientBindingId: value.recipientBindingId,
    entity: value.entity, expiresAt: value.expiresAt };
}

/** Unmounted, staging-only boundary; core remains the sole local-ledger authority. */
export async function handleOperationsPortalNativeBillingAuthorityOwnerHttp(request: Request,
  d: OperationsPortalNativeBillingAuthorityOwnerHttpDependencies): Promise<Response> {
  try {
    const config = configuration(d), url = new URL(request.url);
    if (url.origin !== config.origin || url.hash || request.headers.get("Sec-Fetch-Site") !== "same-origin")
      throw new Failure(403, "denied");
    const relative = url.pathname.startsWith(`${BASE}/`) ? url.pathname.slice(BASE.length) : "";
    const session = request.method === "GET" && relative === "/session";
    const review = request.method === "POST" && relative === "/review";
    const grant = request.method === "POST" && relative === "/grants";
    const read = request.method === "GET" && /^\/grants\/[0-9a-f-]{36}$/u.test(relative);
    const revoke = request.method === "POST" && /^\/grants\/[0-9a-f-]{36}\/revoke$/u.test(relative);
    if (!session && !review && !grant && !read && !revoke) throw new Failure(404, "not_found");
    if (url.search) throw new Failure(400, "invalid_request");
    if (request.headers.has("Origin") && request.headers.get("Origin") !== config.origin
      || request.method === "POST" && request.headers.get("Origin") !== config.origin
      || request.method === "GET" && request.headers.get("X-Native-Staff-Request") !== "1")
      throw new Failure(403, "denied");
    let actor: Actor;
    try { actor = await (d.authenticate ?? authenticateNativeStaffWithAdmissionVersion)(request,
      d.database, config.access); }
    catch { throw new Failure(403, "denied"); }
    alive(actor);
    if (session) return response(200, { csrfToken: await csrf(config.secret, config.origin, actor) });
    if (read) {
      const grantId = relative.split("/")[2]!;
      if (!uuid(grantId)) throw new Failure(404, "not_found");
      const status = await d.core.readStatus(d.database, actor, grantId); alive(actor);
      return response(200, { authority: statusOutput(status, grantId) });
    }
    await csrf(config.secret, config.origin, actor, request); alive(actor);
    if (review) {
      const value = await body(request, ["targetId", "recipientBindingId", "entity", "expiresAt"]);
      const candidate = await d.core.review(d.database, actor, selection(value)); alive(actor);
      return response(200, { review: reviewOutput(candidate) });
    }
    if (grant) {
      const value = await body(request, ["confirm", "operationId", "grantId", "targetId", "recipientBindingId",
        "entity", "expiresAt", "expectedRevision", "reviewFingerprint"]);
      if (value.confirm !== true || !uuid(value.operationId) || !uuid(value.grantId)
        || !revision(value.expectedRevision, 0) || !hash(value.reviewFingerprint))
        throw new Failure(400, "invalid_request");
      const input = { ...selection(value), operationId: value.operationId, grantId: value.grantId,
        expectedRevision: value.expectedRevision, reviewFingerprint: value.reviewFingerprint };
      const result = await d.core.grant(d.database, actor, input); alive(actor);
      return response(200, mutationOutput(result, value.operationId, value.grantId));
    }
    const grantId = relative.split("/")[2]!;
    if (!uuid(grantId)) throw new Failure(404, "not_found");
    const value = await body(request, ["confirm", "operationId", "expectedRevision"]);
    if (value.confirm !== true || !uuid(value.operationId) || !revision(value.expectedRevision, 1))
      throw new Failure(400, "invalid_request");
    const result = await d.core.revoke(d.database, actor, { operationId: value.operationId, grantId,
      expectedRevision: value.expectedRevision }); alive(actor);
    return response(200, mutationOutput(result, value.operationId, grantId));
  } catch (error) {
    const denied = error instanceof Error && error.message === "native_billing_authority_denied";
    const failure = error instanceof Failure ? error : new Failure(denied ? 403 : 503,
      denied ? "denied" : "unavailable");
    return response(failure.status, { error: failure.code });
  }
}
