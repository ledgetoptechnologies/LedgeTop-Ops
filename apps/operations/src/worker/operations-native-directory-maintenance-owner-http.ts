import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion,
  type AuthenticatedNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { compileNativeDirectoryMaintenanceAuthorityPlan,
  executeNativeDirectoryMaintenanceAuthority,
  NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET,
  readFrozenNativeDirectoryMaintenanceApproval,
  type CompiledNativeDirectoryMaintenanceAuthorityPlan,
  type FrozenNativeDirectoryMaintenanceApproval,
  type NativeDirectoryMaintenanceAuthorityResult } from "./native-directory-maintenance-authority";

export const OPERATIONS_NATIVE_DIRECTORY_MAINTENANCE_OWNER_BASE = "/api/native-client-portal/directory-maintenance-authority";
const HOST = "ops-staging.ledgetopdroneservices.com";
const ORIGIN = `https://${HOST}`;
const OWNER = "staff-beau-koltz";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/u;
const encoder = new TextEncoder();
const HEADERS = { "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };

export type OperationsNativeDirectoryMaintenanceOwnerHttpDependencies = Readonly<{
  environment: string;
  expectedHost: string;
  enabledFlag: string;
  configuration: NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
  database: D1Database;
  authenticate?: typeof authenticateNativeStaffWithAdmissionVersion;
  compile?: typeof compileNativeDirectoryMaintenanceAuthorityPlan;
  readApproval?: typeof readFrozenNativeDirectoryMaintenanceApproval;
  execute?: typeof executeNativeDirectoryMaintenanceAuthority;
}>;

type Actor = AuthenticatedNativeStaffWithAdmissionVersion;
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
  const until = Date.parse(actor.verifiedUntil);
  if (!Number.isFinite(until) || until <= Date.now()) throw new Failure(403, "denied");
}
function configuration(d: OperationsNativeDirectoryMaintenanceOwnerHttpDependencies) {
  try {
    const c = d.configuration;
    const issuer = new URL(c.issuer);
    const secretLength = encoder.encode(c.csrfSecret).byteLength;
    if (d.environment !== "staging" || d.enabledFlag !== "true" || d.expectedHost !== HOST
      || c.enabled !== true || c.origin !== ORIGIN || issuer.protocol !== "https:"
      || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com"
      || issuer.origin !== c.issuer || issuer.pathname !== "/" || issuer.search || issuer.hash
      || issuer.username || issuer.password || issuer.port || !AUDIENCE.test(c.staffAudience)
      || secretLength < 32 || secretLength > 512 || !d.database) throw Error();
    return { origin: ORIGIN, secret: c.csrfSecret,
      access: { enabled: true, issuer: c.issuer, staffAudience: c.staffAudience } };
  } catch { throw new Failure(404, "not_found"); }
}
function actorMessage(origin: string, access: NativeStaffAccessConfiguration, actor: Actor, bucket: number): Uint8Array {
  return encoder.encode(JSON.stringify(["operations-native-directory-maintenance-owner-csrf-v1", origin,
    access.issuer, access.staffAudience, actor.identity.staffId, actor.identity.verifiedAccessSubject,
    actor.admissionVersion, actor.identity.profileVersion, bucket]));
}
function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
async function csrfToken(secret: string, origin: string, access: NativeStaffAccessConfiguration,
  actor: Actor, bucket: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", arrayBuffer(encoder.encode(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, arrayBuffer(actorMessage(origin, access, actor, bucket))));
  return `${bucket}.${[...signature].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function requireCsrf(request: Request, config: ReturnType<typeof configuration>, actor: Actor): Promise<void> {
  const token = request.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u);
  const bucket = Math.floor(Date.now() / 600_000);
  const suppliedBucket = Number(token?.[1]);
  if (!token || (suppliedBucket !== bucket && suppliedBucket !== bucket - 1)) throw new Failure(403, "denied");
  const key = await crypto.subtle.importKey("raw", arrayBuffer(encoder.encode(config.secret)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signature = Uint8Array.from(token[2]!.match(/../gu)!, pair => Number.parseInt(pair, 16));
  if (!await crypto.subtle.verify("HMAC", key, arrayBuffer(signature), arrayBuffer(actorMessage(config.origin, config.access, actor, suppliedBucket))))
    throw new Failure(403, "denied");
}
async function body(request: Request, names: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type") ?? ""))
    throw new Failure(400, "invalid_request");
  let value: unknown;
  try { value = await readBoundedJson(request, 2_048, "native directory maintenance owner"); }
  catch (error) {
    if (error && typeof error === "object" && "status" in error && error.status === 413)
      throw new Failure(413, "invalid_request");
    throw new Failure(400, "invalid_request");
  }
  if (!exact(value, names)) throw new Failure(400, "invalid_request");
  return value;
}
function requireOwner(actor: Actor): void {
  if (actor.identity.kind !== "native" || actor.identity.staffId !== OWNER) throw new Failure(403, "denied");
}
function errorResponse(error: unknown): Response {
  if (error instanceof Failure) return response(error.status, { error: error.code });
  if (error instanceof Error && error.message === "native_directory_maintenance_authority_denied")
    return response(403, { error: "denied" });
  return response(503, { error: "unavailable" });
}

/**
 * Local-only, staging-only maintenance boundary. The evidence in a reviewed
 * plan is this Worker’s successful normal native Access authentication event:
 * this handler creates the event UUID/timestamp after authentication and never
 * accepts actor/evidence/target values from a caller. The plan is private and
 * bounded. Its out-of-band approver must independently verify the deployed
 * staging Worker binding and live D1 snapshot before preinstalling approval.
 * This HTTP boundary cannot install or alter approvals.
 */
export async function handleOperationsNativeDirectoryMaintenanceOwnerHttp(
  request: Request, d: OperationsNativeDirectoryMaintenanceOwnerHttpDependencies): Promise<Response> {
  try {
    const config = configuration(d);
    const url = new URL(request.url);
    const base = OPERATIONS_NATIVE_DIRECTORY_MAINTENANCE_OWNER_BASE;
    const session = request.method === "GET" && url.pathname === `${base}/session`;
    const review = request.method === "POST" && url.pathname === `${base}/review`;
    const execute = request.method === "POST" && url.pathname === `${base}/execute`;
    if (!session && !review && !execute) throw new Failure(404, "not_found");
    if (url.origin !== config.origin || url.search || url.hash || request.headers.get("Sec-Fetch-Site") !== "same-origin")
      throw new Failure(403, "denied");
    if (session) {
      if (request.headers.get("X-Native-Staff-Request") !== "1"
        || (request.headers.has("Origin") && request.headers.get("Origin") !== config.origin)) throw new Failure(403, "denied");
    } else if (request.headers.get("Origin") !== config.origin) throw new Failure(403, "denied");
    let actor: Actor;
    try { actor = await (d.authenticate ?? authenticateNativeStaffWithAdmissionVersion)(request, d.database, config.access); }
    catch { throw new Failure(403, "denied"); }
    alive(actor);
    requireOwner(actor);
    if (session) return response(200, { csrfToken: await csrfToken(config.secret, config.origin, config.access,
      actor, Math.floor(Date.now() / 600_000)), staffId: actor.identity.staffId, verifiedUntil: actor.verifiedUntil });
    await requireCsrf(request, config, actor);
    alive(actor);
    if (review) {
      const input = await body(request, []);
      if (Reflect.ownKeys(input).length !== 0) throw new Failure(400, "invalid_request");
      // Verification event metadata is generated only after successful normal
      // native authentication. It is not an independently supplied claim.
      const verifiedAt = new Date().toISOString();
      const verifiedUntil = Date.parse(actor.verifiedUntil);
      const expiresAt = new Date(Math.min(verifiedUntil, Date.parse(verifiedAt) + 15 * 60_000)).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(verifiedAt)) throw new Failure(403, "denied");
      const staffId = actor.identity.staffId;
      let compiled: CompiledNativeDirectoryMaintenanceAuthorityPlan;
      try {
        compiled = await (d.compile ?? compileNativeDirectoryMaintenanceAuthorityPlan)(d.database, {
          target: NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET, staffId,
          grantId: crypto.randomUUID(), commandId: crypto.randomUUID(),
          operator: { staffId, accessSubject: actor.identity.verifiedAccessSubject },
          approvalIssuer: { staffId, accessSubject: actor.identity.verifiedAccessSubject },
          identityEvidence: { staffId, accessSubject: actor.identity.verifiedAccessSubject,
            verificationId: crypto.randomUUID(), verifiedAt, expiresAt, issuer: config.access.issuer },
        });
      } catch (error) {
        if (error instanceof Error && error.message === "native_directory_maintenance_authority_denied")
          throw new Failure(403, "denied");
        throw new Failure(503, "unavailable");
      }
      alive(actor);
      const result = { plan: compiled.plan, planSha256: compiled.canonicalPlanSha256,
        independentBindingVerificationSha256: compiled.independentBindingVerificationSha256 };
      if (encoder.encode(JSON.stringify(result)).byteLength > 140_000) throw new Failure(503, "unavailable");
      return response(200, result);
    }
    const input = await body(request, ["approvalId", "commandId", "planSha256", "confirm"]);
    if (input.confirm !== true || typeof input.approvalId !== "string" || !UUID.test(input.approvalId)
      || typeof input.commandId !== "string" || !UUID.test(input.commandId)
      || typeof input.planSha256 !== "string" || !HASH.test(input.planSha256)) throw new Failure(400, "invalid_request");
    let approved: FrozenNativeDirectoryMaintenanceApproval;
    try {
      approved = await (d.readApproval ?? readFrozenNativeDirectoryMaintenanceApproval)(
        d.database, input.approvalId, input.commandId, input.planSha256);
    } catch (error) {
      if (error instanceof Error && error.message === "native_directory_maintenance_authority_denied")
        throw new Failure(409, "conflict");
      throw new Failure(503, "unavailable");
    }
    if (approved.approvalId !== input.approvalId || approved.plan.commandId !== input.commandId
      || approved.canonicalPlanSha256 !== input.planSha256 || approved.plan.operator.staffId !== actor.identity.staffId
      || approved.plan.operator.accessSubject !== actor.identity.verifiedAccessSubject
      || approved.plan.approvalIssuer.staffId !== actor.identity.staffId
      || approved.plan.approvalIssuer.accessSubject !== actor.identity.verifiedAccessSubject) throw new Failure(409, "conflict");
    let result: NativeDirectoryMaintenanceAuthorityResult;
    try {
      result = await (d.execute ?? executeNativeDirectoryMaintenanceAuthority)(d.database, {
        plan: approved.plan, approvalId: approved.approvalId, commandId: input.commandId,
        actor, target: NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "native_directory_maintenance_authority_denied")
        throw new Failure(409, "conflict");
      throw new Failure(503, "unavailable");
    }
    // The executor atomically verifies actor expiry at commit. If the Access
    // session expires immediately after an applied result, preserve the
    // client's frozen command by reporting uncertainty rather than a denial.
    if (Date.parse(actor.verifiedUntil) <= Date.now()) throw new Failure(503, "unavailable");
    if (result.commandId !== input.commandId || result.approvalId !== input.approvalId
      || result.grantId !== approved.plan.grantId || !Number.isSafeInteger(result.resultingGeneration)
      || result.resultingGeneration < 1 || result.status !== "applied" && result.status !== "replayed")
      throw new Failure(503, "unavailable");
    return response(200, result);
  } catch (error) { return errorResponse(error); }
}
