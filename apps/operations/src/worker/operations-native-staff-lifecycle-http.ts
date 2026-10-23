import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion, type AuthenticatedNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { executeOperationsStaffLifecycleCommand } from "./native-staff-management-command";
import { readNativeStaffManagement } from "./native-staff-management-read";

export const OPERATIONS_NATIVE_STAFF_LIFECYCLE_BASE = "/api/native-staff";
const BASE = OPERATIONS_NATIVE_STAFF_LIFECYCLE_BASE;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEADERS = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
type Actor = AuthenticatedNativeStaffWithAdmissionVersion;
export type OperationsNativeStaffLifecycleHttpDependencies = Readonly<{
  enabledFlag: string; expectedHost: string;
  configuration: NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
  database: D1Database;
  authenticate?: typeof authenticateNativeStaffWithAdmissionVersion;
}>;
class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const response = (status: number, value: unknown) => new Response(JSON.stringify(value),
  { status, headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const d = Object.getOwnPropertyDescriptor(value, key); return !!d && d.enumerable && "value" in d;
  });
}
function config(d: OperationsNativeStaffLifecycleHttpDependencies) {
  try {
    const origin = new URL(d.configuration.origin), issuer = new URL(d.configuration.issuer);
    if (d.enabledFlag !== "true" || d.configuration.enabled !== true || origin.protocol !== "https:"
      || origin.origin !== d.configuration.origin || origin.hostname !== d.expectedHost || origin.port
      || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
      || issuer.protocol !== "https:" || issuer.origin !== d.configuration.issuer || issuer.port
      || issuer.username || issuer.password || issuer.pathname !== "/" || issuer.search || issuer.hash
      || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com"
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(d.configuration.staffAudience)
      || typeof d.configuration.csrfSecret !== "string" || new TextEncoder().encode(d.configuration.csrfSecret).length < 32
      || new TextEncoder().encode(d.configuration.csrfSecret).length > 512) throw Error();
    return { origin: origin.origin, secret: d.configuration.csrfSecret, access: { enabled: true,
      issuer: d.configuration.issuer, staffAudience: d.configuration.staffAudience } };
  } catch { throw new Failure(404, "not_found"); }
}
function alive(actor: Actor): void {
  if (!Number.isFinite(Date.parse(actor.verifiedUntil)) || Date.parse(actor.verifiedUntil) <= Date.now()) throw new Failure(403, "denied");
}
function message(origin: string, actor: Actor, bucket: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(["operations-native-staff-lifecycle-csrf-v1", origin,
    actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.identity.profileVersion, bucket]));
}
async function csrf(secret: string, origin: string, actor: Actor, request?: Request): Promise<string> {
  const bucket = Math.floor(Date.now() / 600_000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, request ? ["verify"] : ["sign"]);
  if (request) {
    const match = request.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u), supplied = Number(match?.[1]);
    if (!match || supplied !== bucket && supplied !== bucket - 1
      || !await crypto.subtle.verify("HMAC", key, Uint8Array.from(match[2]!.match(/../gu)!, s => Number.parseInt(s, 16)),
        message(origin, actor, supplied))) throw new Failure(403, "denied");
    return "";
  }
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, message(origin, actor, bucket)));
  return `${bucket}.${[...signature].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function currentBridge(d: OperationsNativeStaffLifecycleHttpDependencies, actor: Actor): Promise<boolean> {
  return !!await d.database.withSession("first-primary").prepare(`SELECT 1 ok FROM native_staff_admissions a
    JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
    WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=? AND a.version=? AND p.version=?
      AND p.login_email=? AND s.email=p.login_email COLLATE BINARY AND s.access_subject=a.bound_access_subject AND s.status='active'`)
    .bind(actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion,
      actor.identity.profileVersion, actor.identity.email).first("ok");
}

/** This surface cannot create staff, install bootstrap approvals, bind an
 * identity, grant management powers, or enable the separately reviewed cutover. */
export async function handleOperationsNativeStaffLifecycleHttp(request: Request,
  d: OperationsNativeStaffLifecycleHttpDependencies): Promise<Response> {
  try {
    const c = config(d), url = new URL(request.url);
    const session = request.method === "GET" && url.pathname === `${BASE}/session`;
    const match = new RegExp(`^${BASE}/([^/]+)(?:/(disable|enable|profile))?$`, "u").exec(url.pathname);
    const targetId = match?.[1];
    const read = request.method === "GET" && !!targetId && !match?.[2] && ID.test(targetId);
    const mutation = request.method === "POST" && !!targetId && !!match?.[2] && ID.test(targetId);
    if (!session && !read && !mutation) throw new Failure(404, "not_found");
    if (url.origin !== c.origin || url.search || url.hash || request.headers.get("Sec-Fetch-Site") !== "same-origin"
      || request.headers.has("Origin") && request.headers.get("Origin") !== c.origin
      || mutation && request.headers.get("Origin") !== c.origin
      || !mutation && request.headers.get("X-Native-Staff-Request") !== "1") throw new Failure(403, "denied");
    const enabled = await d.database.withSession("first-primary").prepare(
      "SELECT 1 ok FROM native_staff_access_reconciliation WHERE singleton=1 AND enabled=1").first("ok");
    if (!enabled) throw new Failure(404, "not_found");
    let actor: Actor;
    try { actor = await (d.authenticate ?? authenticateNativeStaffWithAdmissionVersion)(request, d.database, c.access); }
    catch { throw new Failure(403, "denied"); }
    alive(actor);
    if (!await currentBridge(d, actor)) throw new Failure(403, "denied");
    if (session) {
      const csrfToken = await csrf(c.secret, c.origin, actor); alive(actor);
      return response(200, { csrfToken, verifiedUntil: actor.verifiedUntil });
    }
    if (read) {
      const value = await readNativeStaffManagement(d.database, { actorStaffId: actor.identity.staffId,
        verifiedAccessSubject: actor.identity.verifiedAccessSubject, targetStaffId: targetId, capability: "staff.profile.read" });
      alive(actor); if (!await currentBridge(d, actor)) throw new Failure(403, "denied");
      return response(200, value);
    }
    await csrf(c.secret, c.origin, actor, request); alive(actor);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type") ?? "")) throw new Failure(400, "invalid_request");
    let value: unknown;
    try { value = await readBoundedJson(request, 2_048, "staff lifecycle"); }
    catch { throw new Failure(400, "invalid_request"); }
    const edit = match![2] === "profile";
    if (!exact(value, ["commandId", "expectedVersion", "reason", ...(edit ? ["displayName"] : [])])
      || typeof value.commandId !== "string" || !UUID.test(value.commandId)) throw new Failure(400, "invalid_request");
    const receipt = await executeOperationsStaffLifecycleCommand(d.database, { ...value, contractVersion: 1,
      capability: edit ? "staff.profile.edit" : match![2] === "disable" ? "staff.admission.disable" : "staff.admission.enable",
      actor: { staffId: actor.identity.staffId, verifiedAccessSubject: actor.identity.verifiedAccessSubject }, targetStaffId: targetId },
    { admissionVersion: actor.admissionVersion, profileVersion: actor.identity.profileVersion, verifiedUntil: actor.verifiedUntil });
    return response(200, { receipt, accessReconciliation: edit ? "unchanged" : "pending" });
  } catch (error) {
    if (error instanceof Failure) return response(error.status, { error: error.code });
    if (error instanceof Error && ["operations_staff_lifecycle_denied", "native_staff_management_read_denied"].includes(error.message))
      return response(403, { error: "denied" });
    return response(503, { error: "unavailable" });
  }
}
