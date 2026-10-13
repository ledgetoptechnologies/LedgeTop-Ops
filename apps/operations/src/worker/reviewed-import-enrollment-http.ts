import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion,
  type AuthenticatedNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { writeReviewedImportEnrollment, type ReviewedImportDestination,
  type ReviewedImportEnrollmentOutcome } from "./reviewed-import-enrollment-writer";

export const REVIEWED_IMPORT_ENROLLMENT_BASE = "/api/native-directory/reviewed-import-enrollment";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/u;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/u;
const encoder = new TextEncoder();
const HEADERS = { "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };

type Actor = AuthenticatedNativeStaffWithAdmissionVersion;
type Authority = Readonly<{ selectedProfileGrantId: string; selectedEnrollmentGrantId: string }>;
type Route = Readonly<{ kind: "client" | "organization"; recordId: string }>;
export type ReviewedImportEnrollmentCommittedReplay = Readonly<{status:"absent"}>
  | Readonly<{status:"exact";destinations:readonly ReviewedImportDestination[];authority:Authority}>
  | Readonly<{status:"denied"}>
  | Readonly<{status:"conflict"}>;
export type ReviewedImportEnrollmentResolution =
  | Readonly<{ status: "resolved"; destinations: readonly ReviewedImportDestination[] }>
  | Readonly<{ status: "conflict"; reason: "stale_record" | "stale_enrollment" | "source_authority_unavailable" }>
  | Readonly<{ status: "denied" }>;
export type ReviewedImportEnrollmentResolveInput = Readonly<{ recordId: string; kind: Route["kind"];
  expectedRecordVersion: number; expectedEnrollmentVersion: number; sourceIds: readonly string[] }>;

export type ReviewedImportEnrollmentHttpDependencies = Readonly<{
  environment: string; enabledFlag: string; expectedHost: string;
  configuration: NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
  database: D1Database;
  authenticate?: typeof authenticateNativeStaffWithAdmissionVersion;
  selectAuthority?: (db: D1Database, actor: Actor, recordId: string) => Promise<Authority | null>;
  readCommittedReplay?: (db: D1Database, actor: Actor, authority: Authority,
    input: ReviewedImportEnrollmentResolveInput & Readonly<{mutationId:string}>) => Promise<ReviewedImportEnrollmentCommittedReplay>;
  resolveDestinations: (db: D1Database, actor: Actor, input: ReviewedImportEnrollmentResolveInput) => Promise<ReviewedImportEnrollmentResolution>;
  write?: typeof writeReviewedImportEnrollment;
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
function config(d: ReviewedImportEnrollmentHttpDependencies) {
  try {
    const origin = new URL(d.configuration.origin), issuer = new URL(d.configuration.issuer);
    const secretLength = encoder.encode(d.configuration.csrfSecret).byteLength;
    if (d.environment !== "staging" || d.enabledFlag !== "true" || !HOST.test(d.expectedHost)
      || origin.protocol !== "https:" || origin.hostname !== d.expectedHost || origin.origin !== d.configuration.origin
      || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password || origin.port
      || d.configuration.enabled !== true || issuer.protocol !== "https:" || issuer.origin !== d.configuration.issuer
      || issuer.pathname !== "/" || issuer.search || issuer.hash || issuer.username || issuer.password || issuer.port
      || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com"
      || !AUDIENCE.test(d.configuration.staffAudience) || secretLength < 32 || secretLength > 512 || !d.database
      || typeof d.resolveDestinations !== "function") throw Error();
    return { origin: origin.origin, secret: d.configuration.csrfSecret };
  } catch { throw new Failure(404, "not_found"); }
}
function bytes(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength); new Uint8Array(result).set(value); return result;
}
function csrfMessage(origin: string, actor: Actor, bucket: number): Uint8Array {
  return encoder.encode(JSON.stringify(["reviewed-import-enrollment-csrf-v1", origin, actor.identity.staffId,
    actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.identity.profileVersion, bucket]));
}
async function csrf(secret: string, origin: string, actor: Actor, request?: Request): Promise<string> {
  const bucket = Math.floor(Date.now() / 600_000), token = request?.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u);
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
  if (method === "GET" && url.pathname === `${REVIEWED_IMPORT_ENROLLMENT_BASE}/session`) return "session";
  if (method !== "POST") return null;
  const match = new RegExp(`^${REVIEWED_IMPORT_ENROLLMENT_BASE}/(clients|organizations)/([^/]+)$`, "u").exec(url.pathname);
  if (!match) return null;
  let recordId: string;
  try { recordId = decodeURIComponent(match[2]!); } catch { return null; }
  if (!recordId || recordId.length > 191 || encoder.encode(recordId).byteLength > 764 || /[\p{C}/]/u.test(recordId)) return null;
  return { kind: match[1] === "clients" ? "client" : "organization", recordId };
}
type Grant = Readonly<{ id: string; effect: string; scope_kind: string; business_area_id: string | null;
  division_id: string | null; resource_id: string | null }>;
function applies(grant: Grant, recordId: string, scopes: readonly {business_area_id:string;division_id:string|null}[], assigned: boolean): boolean {
  return grant.scope_kind === "global" || grant.scope_kind === "resource" && grant.resource_id === recordId
    || grant.scope_kind === "assigned" && assigned
    || grant.scope_kind === "business_area" && scopes.some(scope => scope.business_area_id === grant.business_area_id)
    || grant.scope_kind === "division" && scopes.some(scope => scope.division_id === grant.division_id);
}
async function selectedGrant(db: D1Database, actor: Actor, recordId: string, permission: string): Promise<string | null> {
  const grants = (await db.withSession("first-primary").prepare(`SELECT grant.id,grant.effect,grant.scope_kind,
      grant.business_area_id,grant.division_id,grant.resource_id FROM native_directory_grants grant
    JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id JOIN staff_users staff ON staff.id=grant.staff_id
    WHERE grant.staff_id=? AND grant.permission=? AND grant.active=1 AND admission.active=1
      AND admission.bound_access_subject=? AND admission.version=? AND profile.login_email=? AND profile.version=?
      AND staff.status='active' AND staff.access_subject=? ORDER BY grant.id`)
    .bind(actor.identity.staffId, permission, actor.identity.verifiedAccessSubject, actor.admissionVersion,
      actor.identity.email, actor.identity.profileVersion, actor.identity.verifiedAccessSubject).all<Grant>()).results;
  const scopes = (await db.prepare(`SELECT business_area_id,division_id FROM native_directory_resource_scopes
    WHERE record_id=? AND active=1`).bind(recordId).all<{business_area_id:string;division_id:string|null}>()).results;
  const assigned = !!await db.prepare(`SELECT 1 ok FROM native_directory_assignments WHERE record_id=? AND staff_id=? AND active=1`)
    .bind(recordId, actor.identity.staffId).first("ok");
  const applicable = grants.filter(grant => applies(grant, recordId, scopes, assigned));
  return applicable.some(grant => grant.effect === "deny") ? null : applicable.find(grant => grant.effect === "allow")?.id ?? null;
}
async function selectAuthority(db: D1Database, actor: Actor, recordId: string): Promise<Authority | null> {
  const [profile, enrollment] = await Promise.all([selectedGrant(db, actor, recordId, "directory.profile.edit"),
    selectedGrant(db, actor, recordId, "directory.enrollment.manage")]);
  return profile && enrollment ? { selectedProfileGrantId: profile, selectedEnrollmentGrantId: enrollment } : null;
}
async function frozenGrantCurrent(db: D1Database, actor: Actor, recordId: string, permission: string,
  frozenGrantId: string): Promise<boolean> {
  const grants = (await db.withSession("first-primary").prepare(`SELECT grant.id,grant.effect,grant.scope_kind,
      grant.business_area_id,grant.division_id,grant.resource_id FROM native_directory_grants grant
    JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id JOIN staff_users staff ON staff.id=grant.staff_id
    WHERE grant.staff_id=? AND grant.permission=? AND grant.active=1 AND admission.active=1
      AND admission.bound_access_subject=? AND admission.version=? AND profile.login_email=? AND profile.version=?
      AND staff.status='active' AND staff.access_subject=? ORDER BY grant.id`)
    .bind(actor.identity.staffId, permission, actor.identity.verifiedAccessSubject, actor.admissionVersion,
      actor.identity.email, actor.identity.profileVersion, actor.identity.verifiedAccessSubject).all<Grant>()).results;
  const scopes = (await db.prepare(`SELECT business_area_id,division_id FROM native_directory_resource_scopes
    WHERE record_id=? AND active=1`).bind(recordId).all<{business_area_id:string;division_id:string|null}>()).results;
  const assigned = !!await db.prepare(`SELECT 1 ok FROM native_directory_assignments WHERE record_id=? AND staff_id=? AND active=1`)
    .bind(recordId, actor.identity.staffId).first("ok");
  const applicable = grants.filter(grant => applies(grant, recordId, scopes, assigned));
  return !applicable.some(grant => grant.effect === "deny")
    && applicable.some(grant => grant.id === frozenGrantId && grant.effect === "allow");
}
async function readCommittedReplay(db: D1Database, actor: Actor, _authority: Authority,
  input: ReviewedImportEnrollmentResolveInput & Readonly<{mutationId:string}>): Promise<ReviewedImportEnrollmentCommittedReplay> {
  const row = await db.withSession("first-primary").prepare(`SELECT admission.record_id,admission.record_kind,
      admission.expected_record_version,admission.expected_enrollment_version,admission.destinations_json,
      admission.actor_staff_id,admission.actor_access_subject,admission.actor_admission_version,admission.actor_email,
      admission.actor_profile_version,admission.selected_profile_grant_id,admission.selected_enrollment_grant_id
    FROM reviewed_import_enrollment_admissions admission JOIN reviewed_import_enrollment_receipts receipt
      ON receipt.admission_id=admission.admission_id AND receipt.mutation_id=admission.mutation_id
      AND receipt.record_id=admission.record_id AND receipt.destinations_json=admission.destinations_json
    WHERE admission.mutation_id=? LIMIT 2`).bind(input.mutationId).all<Record<string,unknown>>();
  if (row.results.length === 0) return {status:"absent"};
  if (row.results.length !== 1) return {status:"conflict"};
  const value = row.results[0]!;
  if (value.record_id !== input.recordId || value.record_kind !== input.kind
    || value.expected_record_version !== input.expectedRecordVersion
    || value.expected_enrollment_version !== input.expectedEnrollmentVersion
    || value.actor_staff_id !== actor.identity.staffId || value.actor_access_subject !== actor.identity.verifiedAccessSubject
    || value.actor_admission_version !== actor.admissionVersion || value.actor_email !== actor.identity.email
    || value.actor_profile_version !== actor.identity.profileVersion) return {status:"conflict"};
  if (typeof value.selected_profile_grant_id !== "string" || typeof value.selected_enrollment_grant_id !== "string")
    return {status:"conflict"};
  const frozenAuthority = { selectedProfileGrantId: value.selected_profile_grant_id,
    selectedEnrollmentGrantId: value.selected_enrollment_grant_id };
  if (!await frozenGrantCurrent(db, actor, input.recordId, "directory.profile.edit", frozenAuthority.selectedProfileGrantId)
    || !await frozenGrantCurrent(db, actor, input.recordId, "directory.enrollment.manage", frozenAuthority.selectedEnrollmentGrantId))
    return {status:"denied"};
  let destinations: unknown;
  try { destinations = JSON.parse(String(value.destinations_json)); } catch { return {status:"conflict"}; }
  if (!validDestinations(destinations as ReviewedImportDestination[], input.sourceIds)) return {status:"conflict"};
  return {status:"exact",destinations:destinations as ReviewedImportDestination[],authority:frozenAuthority};
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type") ?? ""))
    throw new Failure(400, "invalid_request");
  let value: unknown;
  try { value = await readBoundedJson(request, 2_048, "reviewed import enrollment"); }
  catch (error) { if (error && typeof error === "object" && "status" in error && error.status === 413)
    throw new Failure(413, "invalid_request"); throw new Failure(400, "invalid_request"); }
  if (!exact(value, ["mutationId", "expectedRecordVersion", "expectedEnrollmentVersion", "sourceIds"]))
    throw new Failure(400, "invalid_request");
  return value;
}
function validDestinations(value: readonly ReviewedImportDestination[], sources: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return false;
  const ids = value.map(item => item?.sourceId);
  return value.every(item => item && typeof item === "object" && !Array.isArray(item)
    && Object.keys(item).length === 6
    && ["sourceId", "sourceInstanceUUID", "applicationUUID", "historyEpoch", "origin", "externalCanonicalId"]
      .every(field => Object.hasOwn(item, field))
    && SOURCE.test(item.sourceId)
    && typeof item.sourceInstanceUUID === "string" && UUID.test(item.sourceInstanceUUID)
    && typeof item.applicationUUID === "string" && UUID.test(item.applicationUUID)
    && typeof item.historyEpoch === "string" && UUID.test(item.historyEpoch)
    && typeof item.origin === "string" && (() => { try { const url = new URL(item.origin);
      return url.protocol === "https:" && url.origin === item.origin; } catch { return false; } })()
    && typeof item.externalCanonicalId === "string" && item.externalCanonicalId.length > 0
    && encoder.encode(item.externalCanonicalId).byteLength <= 764 && !/[\p{C}]/u.test(item.externalCanonicalId))
    && new Set(ids).size === ids.length && JSON.stringify([...ids].sort()) === JSON.stringify([...sources].sort());
}
function outcome(outcome: ReviewedImportEnrollmentOutcome): Response {
  if (outcome.status === "written") return response(outcome.replayed ? 200 : 201, { outcome: { status: outcome.status,
    replayed: outcome.replayed, recordId: outcome.recordId, enrollmentVersion: outcome.enrollmentVersion,
    sourceIds: outcome.destinations.map(value => value.sourceId) } });
  if (outcome.status === "rejected") return response(400, { error: outcome.reason });
  if (outcome.status === "conflict") return response(409, { error: outcome.reason });
  return response(409, { error: outcome.reason });
}

export async function handleReviewedImportEnrollmentHttp(request: Request,
  d: ReviewedImportEnrollmentHttpDependencies): Promise<Response> {
  try {
    const configured = config(d), url = new URL(request.url), selected = route(url, request.method);
    if (!selected) throw new Failure(404, "not_found");
    if (url.origin !== configured.origin || url.search || url.hash || request.headers.get("Sec-Fetch-Site") !== "same-origin")
      throw new Failure(403, "denied");
    if (selected === "session") {
      if (request.headers.get("X-Native-Staff-Request") !== "1"
        || request.headers.has("Origin") && request.headers.get("Origin") !== configured.origin) throw new Failure(403, "denied");
    } else if (request.headers.get("Origin") !== configured.origin) throw new Failure(403, "denied");
    let actor: Actor;
    try { actor = await (d.authenticate ?? authenticateNativeStaffWithAdmissionVersion)(request, d.database,
      { enabled: true, issuer: d.configuration.issuer, staffAudience: d.configuration.staffAudience }); }
    catch { throw new Failure(403, "denied"); }
    alive(actor);
    if (selected === "session") return response(200, { csrfToken: await csrf(configured.secret, configured.origin, actor),
      verifiedUntil: actor.verifiedUntil });
    await csrf(configured.secret, configured.origin, actor, request); alive(actor);
    const value = await body(request), sourceIds = value.sourceIds;
    if (typeof value.mutationId !== "string" || !UUID.test(value.mutationId)
      || request.headers.get("Idempotency-Key") !== value.mutationId
      || !Number.isSafeInteger(value.expectedRecordVersion) || Number(value.expectedRecordVersion) < 1
      || !Number.isSafeInteger(value.expectedEnrollmentVersion) || Number(value.expectedEnrollmentVersion) < 0
      || !Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 16
      || !sourceIds.every(item => typeof item === "string" && SOURCE.test(item)) || new Set(sourceIds).size !== sourceIds.length)
      throw new Failure(400, "invalid_request");
    const authority = await (d.selectAuthority ?? selectAuthority)(d.database, actor, selected.recordId);
    if (!authority) throw new Failure(403, "denied");
    const resolveInput = { recordId: selected.recordId, kind: selected.kind,
      expectedRecordVersion: Number(value.expectedRecordVersion), expectedEnrollmentVersion: Number(value.expectedEnrollmentVersion),
      sourceIds: sourceIds as string[] };
    const committed = await (d.readCommittedReplay ?? readCommittedReplay)(d.database, actor, authority,
      { mutationId: value.mutationId, ...resolveInput });
    if (committed.status === "conflict") return response(409, {error:"idempotency_body_conflict"});
    if (committed.status === "denied") throw new Failure(403, "denied");
    if (committed.status === "exact") {
      alive(actor);
      return outcome(await (d.write ?? writeReviewedImportEnrollment)(d.database, {
        mutationId: value.mutationId, recordId: resolveInput.recordId, kind: resolveInput.kind,
        expectedRecordVersion: resolveInput.expectedRecordVersion, expectedEnrollmentVersion: resolveInput.expectedEnrollmentVersion,
        destinations: committed.destinations, actor: { staffId: actor.identity.staffId,
          accessSubject: actor.identity.verifiedAccessSubject, admissionVersion: actor.admissionVersion,
          loginEmail: actor.identity.email, profileVersion: actor.identity.profileVersion, verifiedUntil: actor.verifiedUntil,
          ...committed.authority },
      }));
    }
    const resolved = await d.resolveDestinations(d.database, actor, resolveInput);
    if (resolved.status === "denied") throw new Failure(403, "denied");
    if (resolved.status === "conflict") return response(409, { error: resolved.reason });
    if (!validDestinations(resolved.destinations, resolveInput.sourceIds)) throw new Failure(503, "unavailable");
    alive(actor);
    return outcome(await (d.write ?? writeReviewedImportEnrollment)(d.database, {
      mutationId: value.mutationId, recordId: resolveInput.recordId, kind: resolveInput.kind,
      expectedRecordVersion: resolveInput.expectedRecordVersion, expectedEnrollmentVersion: resolveInput.expectedEnrollmentVersion,
      destinations: resolved.destinations,
      actor: { staffId: actor.identity.staffId, accessSubject: actor.identity.verifiedAccessSubject,
        admissionVersion: actor.admissionVersion, loginEmail: actor.identity.email, profileVersion: actor.identity.profileVersion,
        verifiedUntil: actor.verifiedUntil, ...authority },
    }));
  } catch (error) { return error instanceof Failure ? response(error.status, { error: error.code }) : response(503, { error: "unavailable" }); }
}
