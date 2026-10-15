import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion,
  type AuthenticatedNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { writeNativeDirectoryLifecycle, type NativeDirectoryLifecycleActor,
  type NativeDirectoryLifecycleWriteOutcome } from "./native-directory-lifecycle-writer";

export const OPERATIONS_NATIVE_DIRECTORY_LIFECYCLE_OWNER_BASE = "/api/native-client-portal/directory-lifecycle";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/u;
const encoder = new TextEncoder();
const HEADERS = { "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };

type Grant = Readonly<{ id: string; effect: string; scope_kind: string; business_area_id: string | null;
  division_id: string | null; resource_id: string | null }>;
type Actor = AuthenticatedNativeStaffWithAdmissionVersion;
type SelectedAuthority = Readonly<{ selectedProfileGrantId: string; selectedEnrollmentGrantId: string }>;
type Route = Readonly<{ kind: "client" | "organization"; action: "archive" | "restore"; recordId: string }>;

export type OperationsNativeDirectoryLifecycleOwnerHttpDependencies = Readonly<{
  environment: string; enabledFlag: string; expectedHost: string;
  configuration: NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
  database: D1Database;
  authenticate?: typeof authenticateNativeStaffWithAdmissionVersion;
  selectAuthority?: (db: D1Database, actor: Actor, recordId: string) => Promise<SelectedAuthority | null>;
  write?: typeof writeNativeDirectoryLifecycle;
}>;

class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}
function exact(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && keys.every(key => typeof key === "string" && names.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}
function alive(actor: Actor): void {
  const expires = Date.parse(actor.verifiedUntil);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Failure(403, "denied");
}
function config(d: OperationsNativeDirectoryLifecycleOwnerHttpDependencies) {
  try {
    const origin = new URL(d.configuration.origin), issuer = new URL(d.configuration.issuer);
    const secretLength = encoder.encode(d.configuration.csrfSecret).byteLength;
    if (d.environment !== "staging" || d.enabledFlag !== "true" || !HOST.test(d.expectedHost)
      || origin.protocol !== "https:" || origin.hostname !== d.expectedHost || origin.origin !== d.configuration.origin
      || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password || origin.port
      || d.configuration.enabled !== true || issuer.protocol !== "https:" || issuer.origin !== d.configuration.issuer
      || issuer.pathname !== "/" || issuer.search || issuer.hash || issuer.username || issuer.password || issuer.port
      || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com"
      || !AUDIENCE.test(d.configuration.staffAudience) || secretLength < 32 || secretLength > 512 || !d.database) throw Error();
    return { origin: origin.origin, secret: d.configuration.csrfSecret,
      access: { enabled: true, issuer: d.configuration.issuer, staffAudience: d.configuration.staffAudience } };
  } catch { throw new Failure(404, "not_found"); }
}
function bytes(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength); new Uint8Array(result).set(value); return result;
}
function csrfMessage(origin: string, actor: Actor, bucket: number): Uint8Array {
  return encoder.encode(JSON.stringify(["operations-native-directory-lifecycle-csrf-v1", origin,
    actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.identity.profileVersion, bucket]));
}
async function csrf(secret: string, origin: string, actor: Actor, request?: Request): Promise<string> {
  const bucket = Math.floor(Date.now() / 600_000);
  const token = request?.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u);
  const key = await crypto.subtle.importKey("raw", bytes(encoder.encode(secret)), { name: "HMAC", hash: "SHA-256" }, false,
    request ? ["verify"] : ["sign"]);
  if (request) {
    const supplied = Number(token?.[1]);
    if (!token || supplied !== bucket && supplied !== bucket - 1
      || !await crypto.subtle.verify("HMAC", key, bytes(Uint8Array.from(token[2]!.match(/../gu)!, pair => Number.parseInt(pair, 16))),
        bytes(csrfMessage(origin, actor, supplied)))) throw new Failure(403, "denied");
    return "";
  }
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(csrfMessage(origin, actor, bucket))));
  return `${bucket}.${[...signature].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}
function route(url: URL, method: string): Route | "session" | null {
  if (method === "GET" && url.pathname === `${OPERATIONS_NATIVE_DIRECTORY_LIFECYCLE_OWNER_BASE}/session`) return "session";
  if (method !== "POST") return null;
  const match = new RegExp(`^${OPERATIONS_NATIVE_DIRECTORY_LIFECYCLE_OWNER_BASE}/(clients|organizations)/([^/]+)/(archive|restore)$`, "u")
    .exec(url.pathname);
  if (!match) return null;
  let recordId: string; try { recordId = decodeURIComponent(match[2]!); } catch { return null; }
  if (!recordId || recordId.length > 191 || /\p{C}/u.test(recordId) || recordId.includes("/")) return null;
  return { kind: match[1] === "clients" ? "client" : "organization", action: match[3] as "archive" | "restore", recordId };
}
function applies(grant: Grant, recordId: string, scopes: readonly { business_area_id: string; division_id: string | null }[], assigned: boolean): boolean {
  return grant.scope_kind === "global" || grant.scope_kind === "resource" && grant.resource_id === recordId
    || grant.scope_kind === "assigned" && assigned
    || grant.scope_kind === "business_area" && scopes.some(scope => scope.business_area_id === grant.business_area_id)
    || grant.scope_kind === "division" && scopes.some(scope => scope.division_id === grant.division_id);
}
async function selectedGrant(db: D1Database, actor: Actor, recordId: string, permission: string): Promise<string | null> {
  const grants = (await db.prepare(`SELECT grant.id,grant.effect,grant.scope_kind,grant.business_area_id,grant.division_id,grant.resource_id
    FROM native_directory_grants grant JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id JOIN staff_users staff ON staff.id=grant.staff_id
    WHERE grant.staff_id=? AND grant.permission=? AND grant.active=1 AND admission.active=1
      AND admission.bound_access_subject=? AND admission.version=? AND profile.login_email=? AND profile.version=?
      AND staff.status='active' AND staff.access_subject=? ORDER BY grant.id`)
    .bind(actor.identity.staffId, permission, actor.identity.verifiedAccessSubject, actor.admissionVersion,
      actor.identity.email, actor.identity.profileVersion, actor.identity.verifiedAccessSubject).all<Grant>()).results;
  const scopes = (await db.prepare(`SELECT business_area_id,division_id FROM native_directory_resource_scopes
    WHERE record_id=? AND active=1`).bind(recordId).all<{ business_area_id: string; division_id: string | null }>()).results;
  const assigned = !!await db.prepare(`SELECT 1 ok FROM native_directory_assignments WHERE record_id=? AND staff_id=? AND active=1`)
    .bind(recordId, actor.identity.staffId).first("ok");
  const applicable = grants.filter(grant => applies(grant, recordId, scopes, assigned));
  if (applicable.some(grant => grant.effect === "deny")) return null;
  return applicable.find(grant => grant.effect === "allow")?.id ?? null;
}
async function selectAuthority(db: D1Database, actor: Actor, recordId: string): Promise<SelectedAuthority | null> {
  const [profile, enrollment] = await Promise.all([selectedGrant(db, actor, recordId, "directory.profile.edit"),
    selectedGrant(db, actor, recordId, "directory.enrollment.manage")]);
  return profile && enrollment ? { selectedProfileGrantId: profile, selectedEnrollmentGrantId: enrollment } : null;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type") ?? ""))
    throw new Failure(400, "invalid_request");
  let value: unknown;
  try { value = await readBoundedJson(request, 1_024, "native directory lifecycle"); }
  catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 413) throw new Failure(413, "invalid_request");
    throw new Failure(400, "invalid_request");
  }
  if (!exact(value, ["mutationId", "expectedLifecycleVersion", "expectedRecordVersion"])) throw new Failure(400, "invalid_request");
  return value;
}
function outcomeResponse(outcome: NativeDirectoryLifecycleWriteOutcome): Response {
  if (outcome.status === "written") return response(200, { outcome });
  if (outcome.status === "rejected") return response(400, { error: outcome.reason });
  if (outcome.status === "conflict") return response(409, { error: outcome.reason });
  return response(outcome.reason === "authority" ? 403 : 409, { error: outcome.reason });
}

export async function handleOperationsNativeDirectoryLifecycleOwnerHttp(request: Request,
  d: OperationsNativeDirectoryLifecycleOwnerHttpDependencies): Promise<Response> {
  try {
    const configuration = config(d), url = new URL(request.url), selectedRoute = route(url, request.method);
    if (!selectedRoute) throw new Failure(404, "not_found");
    if (url.origin !== configuration.origin || url.search || url.hash || request.headers.get("Sec-Fetch-Site") !== "same-origin")
      throw new Failure(403, "denied");
    if (selectedRoute === "session") {
      if (request.headers.get("X-Native-Staff-Request") !== "1"
        || request.headers.has("Origin") && request.headers.get("Origin") !== configuration.origin) throw new Failure(403, "denied");
    } else if (request.headers.get("Origin") !== configuration.origin) throw new Failure(403, "denied");
    let actor: Actor;
    try { actor = await (d.authenticate ?? authenticateNativeStaffWithAdmissionVersion)(request, d.database, configuration.access); }
    catch { throw new Failure(403, "denied"); }
    alive(actor);
    if (selectedRoute === "session") return response(200, { csrfToken: await csrf(configuration.secret, configuration.origin, actor),
      verifiedUntil: actor.verifiedUntil });
    await csrf(configuration.secret, configuration.origin, actor, request); alive(actor);
    const value = await body(request);
    if (typeof value.mutationId !== "string" || !UUID.test(value.mutationId)
      || !Number.isSafeInteger(value.expectedLifecycleVersion) || Number(value.expectedLifecycleVersion) < 0
      || Number(value.expectedLifecycleVersion) >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(value.expectedRecordVersion) || Number(value.expectedRecordVersion) < 1
      || Number(value.expectedRecordVersion) >= Number.MAX_SAFE_INTEGER) throw new Failure(400, "invalid_request");
    const authority = await (d.selectAuthority ?? selectAuthority)(d.database, actor, selectedRoute.recordId);
    if (!authority) throw new Failure(403, "denied");
    const lifecycleActor: NativeDirectoryLifecycleActor = { staffId: actor.identity.staffId,
      accessSubject: actor.identity.verifiedAccessSubject, admissionVersion: actor.admissionVersion,
      loginEmail: actor.identity.email, profileVersion: actor.identity.profileVersion,
      verifiedUntil: actor.verifiedUntil, ...authority };
    alive(actor);
    const outcome = await (d.write ?? writeNativeDirectoryLifecycle)(d.database, {
      mutationId: value.mutationId, recordId: selectedRoute.recordId, kind: selectedRoute.kind, action: selectedRoute.action,
      expectedLifecycleVersion: Number(value.expectedLifecycleVersion), expectedRecordVersion: Number(value.expectedRecordVersion),
      actor: lifecycleActor,
    });
    return outcomeResponse(outcome);
  } catch (error) {
    if (error instanceof Failure) return response(error.status, { error: error.code });
    return response(503, { error: "unavailable" });
  }
}
