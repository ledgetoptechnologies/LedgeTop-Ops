import { readBoundedJson } from "./bounded-json";
import { HTTPException } from "hono/http-exception";
import { authenticateNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration,
  type AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { reserveOperationsPortalWorkspace, type ReserveOperationsPortalWorkspace }
  from "./operations-portal-workspace-reservations";
import { reserveOperationsPortalWorkspacePublication, dispatchOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublicationBinding, type ReserveOperationsPortalWorkspacePublicationInput }
  from "./operations-portal-workspace-publication-outbox";
import { reserveOperationsPortalWorkspacePublicationInvocation }
  from "./operations-portal-workspace-publication-invocations";

const BASE = "/api/native-client-portal/operations-workspaces";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const encoder = new TextEncoder();
type Actor = AuthenticatedNativeStaffWithAdmissionVersion;
type Configuration = NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
export type OperationsPortalWorkspaceOwnerHttpDependencies = Readonly<{
  environment: string; expectedHost: string; configuration: Configuration; database: D1Database;
  publication: OperationsPortalWorkspacePublicationBinding;
}>;

class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const response = (status: number, body: unknown) => Response.json(body, { status, headers: {
  "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
} });
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const own = Reflect.ownKeys(value); if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return null;
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number) { return typeof value === "string" && value === value.trim()
  && value.length > 0 && value.length <= maximum && !/\p{C}/u.test(value) ? value : null; }
function version(value: unknown, zero = false) { return Number.isSafeInteger(value) && Number(value) >= (zero ? 0 : 1)
  ? Number(value) : null; }
function workspaceInput(value: unknown): ReserveOperationsPortalWorkspace | null {
  const row = exact(value, ["operationId", "targetId", "clientAuthorityId", "workspaceId", "rootKind", "rootRecordId",
    "rootRecordVersion", "relationshipVersion", "expectedRevision", "reason"]);
  if (!row || typeof row.operationId !== "string" || !UUID.test(row.operationId)
    || typeof row.targetId !== "string" || !UUID.test(row.targetId)
    || typeof row.clientAuthorityId !== "string" || !UUID.test(row.clientAuthorityId)) return null;
  const workspaceId = text(row.workspaceId, 200), rootRecordId = text(row.rootRecordId, 191), reason = text(row.reason, 500);
  const rootRecordVersion = version(row.rootRecordVersion), expectedRevision = version(row.expectedRevision, true);
  if (!workspaceId || !rootRecordId || !reason || rootRecordVersion === null || expectedRevision !== 0
    || (row.rootKind !== "organization" && row.rootKind !== "standalone_client")) return null;
  if (row.rootKind === "organization" && row.relationshipVersion !== null) return null;
  const relationshipVersion = row.rootKind === "organization" ? null : version(row.relationshipVersion);
  if (row.rootKind === "standalone_client" && relationshipVersion === null) return null;
  return { operationId: row.operationId, targetId: row.targetId, clientAuthorityId: row.clientAuthorityId, workspaceId,
    rootKind: row.rootKind, rootRecordId, rootRecordVersion, relationshipVersion, expectedRevision: 0, reason };
}
type PublicationInput = ReserveOperationsPortalWorkspacePublicationInput & Readonly<{ invocationId: string }>;
function publicationInput(value: unknown): PublicationInput | null {
  const row = exact(value, ["operationId", "publicationId", "snapshotId", "checkpointId", "invocationId",
    "expectedRevision", "reason"]);
  if (!row) return null;
  for (const key of ["operationId", "publicationId", "snapshotId", "checkpointId", "invocationId"] as const)
    if (typeof row[key] !== "string" || !UUID.test(row[key])) return null;
  const expectedRevision = version(row.expectedRevision, true), reason = text(row.reason, 500);
  if (expectedRevision !== 0 || !reason || new Set([row.operationId, row.publicationId, row.snapshotId,
    row.checkpointId, row.invocationId]).size !== 5) return null;
  return { operationId: row.operationId as string, publicationId: row.publicationId as string,
    targetId: "", snapshotId: row.snapshotId as string, checkpointId: row.checkpointId as string,
    invocationId: row.invocationId as string, expectedRevision: 0, reason };
}
function settings(d: OperationsPortalWorkspaceOwnerHttpDependencies) {
  try {
    const origin = new URL(d.configuration.origin), issuer = new URL(d.configuration.issuer);
    if (d.environment !== "staging" || d.configuration.enabled !== true || origin.protocol !== "https:"
      || origin.origin !== d.configuration.origin || origin.pathname !== "/" || origin.hostname !== d.expectedHost
      || origin.port || origin.search || origin.hash || issuer.protocol !== "https:"
      || issuer.origin !== d.configuration.issuer || issuer.pathname !== "/"
      || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com"
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(d.configuration.staffAudience)
      || encoder.encode(d.configuration.csrfSecret).byteLength < 32
      || typeof d.publication?.publishWorkspace !== "function"
      || typeof d.publication?.getPublicationStatus !== "function") throw Error();
    return { origin: origin.origin, secret: d.configuration.csrfSecret,
      access: { enabled: true, issuer: issuer.origin, staffAudience: d.configuration.staffAudience } };
  } catch { throw new Failure(404, "not_found"); }
}
async function hmac(secret: string, data: Uint8Array, signature?: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false,
    signature ? ["verify"] : ["sign"]);
  const bytes = new Uint8Array(data).buffer;
  return signature ? crypto.subtle.verify("HMAC", key, new Uint8Array(signature).buffer, bytes)
    : new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
}
const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], part => Number.parseInt(part, 16));
function csrfMessage(origin: string, actor: Actor, bucket: number) {
  return encoder.encode(JSON.stringify(["operations-workspace-owner-csrf-v1", origin, actor.identity.staffId,
    actor.identity.verifiedAccessSubject, actor.admissionVersion, bucket]));
}
async function csrf(secret: string, origin: string, actor: Actor, request?: Request) {
  const bucket = Math.floor(Date.now() / 600_000);
  if (!request) return `${bucket}.${hex(await hmac(secret, csrfMessage(origin, actor, bucket)) as Uint8Array)}`;
  const token = request.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u), supplied = Number(token?.[1]);
  if (!token || (supplied !== bucket && supplied !== bucket - 1)
    || !await hmac(secret, csrfMessage(origin, actor, supplied), unhex(token[2]!))) throw new Failure(403, "denied");
}
function sameOrigin(request: Request, origin: string) {
  const url = new URL(request.url);
  if (url.origin !== origin || request.headers.get("Origin") !== origin
    || request.headers.get("Sec-Fetch-Site") !== "same-origin") throw new Failure(403, "denied");
}

export async function handleOperationsPortalWorkspaceOwnerHttp(request: Request,
  dependencies: OperationsPortalWorkspaceOwnerHttpDependencies): Promise<Response> {
  try {
    const config = settings(dependencies), url = new URL(request.url);
    if (url.origin !== config.origin || (url.pathname !== `${BASE}/csrf` && url.pathname !== `${BASE}/reserve-and-publish`
      && url.pathname !== `${BASE}/recover-publication`))
      throw new Failure(404, "not_found");
    const actor = await authenticateNativeStaffWithAdmissionVersion(request, dependencies.database, config.access);
    if (url.pathname === `${BASE}/csrf` && request.method === "GET")
      return response(200, { csrfToken: await csrf(config.secret, config.origin, actor) });
    if (request.method !== "POST") throw new Failure(405, "method_not_allowed");
    sameOrigin(request, config.origin); await csrf(config.secret, config.origin, actor, request);
    if (url.pathname === `${BASE}/recover-publication`) {
      const body = exact(await readBoundedJson(request, 2048, "operations workspace publication recovery"),
        ["operationId", "invocationId", "reason"]);
      if (!body || typeof body.operationId !== "string" || !UUID.test(body.operationId)
        || typeof body.invocationId !== "string" || !UUID.test(body.invocationId) || !text(body.reason, 500)
        || request.headers.get("Idempotency-Key") !== body.invocationId) throw new Failure(400, "invalid_request");
      await reserveOperationsPortalWorkspacePublicationInvocation(dependencies.database, actor, {
        operationId: body.operationId, invocationId: body.invocationId, action: "recover", reason: body.reason as string });
      const dispatch = await dispatchOperationsPortalWorkspacePublication({ db: dependencies.database,
        binding: dependencies.publication, operationId: body.operationId, invocationId: body.invocationId, action: "recover" });
      return response(200, { operationId: dispatch.operationId, status: dispatch.status, replayed: dispatch.replayed === true });
    }
    const body = exact(await readBoundedJson(request, 8192, "operations workspace owner"), ["workspace", "publication"]);
    const workspace = workspaceInput(body?.workspace), publication = publicationInput(body?.publication);
    if (!workspace || !publication || request.headers.get("Idempotency-Key") !== workspace.operationId)
      throw new Failure(400, "invalid_request");
    const reserved = await reserveOperationsPortalWorkspace(dependencies.database, actor, workspace);
    const staged = await reserveOperationsPortalWorkspacePublication(dependencies.database, actor, {
      operationId: publication.operationId, publicationId: publication.publicationId, targetId: workspace.targetId,
      snapshotId: publication.snapshotId, checkpointId: publication.checkpointId,
      expectedRevision: publication.expectedRevision, reason: publication.reason,
    });
    await reserveOperationsPortalWorkspacePublicationInvocation(dependencies.database, actor, {
      invocationId: publication.invocationId, operationId: publication.operationId, action: "publish", reason: publication.reason,
    });
    const dispatched = await dispatchOperationsPortalWorkspacePublication({ db: dependencies.database,
      binding: dependencies.publication, operationId: publication.operationId,
      invocationId: publication.invocationId, action: "publish" });
    return response(200, { workspaceOperationId: reserved.operationId, targetId: reserved.targetId,
      workspaceRevision: reserved.revision, workspaceReplayed: reserved.replayed,
      publicationOperationId: staged.operationId, publicationRevision: staged.publicationRevision,
      publicationState: dispatched.status, publicationReplayed: staged.replayed || dispatched.replayed === true });
  } catch (error) {
    if (error instanceof Failure) return response(error.status, { error: error.code });
    if (error instanceof HTTPException && (error.status === 400 || error.status === 413))
      return response(error.status, { error: error.status === 413 ? "payload_too_large" : "invalid_request" });
    const denied = error instanceof Error && (error.message.includes("_denied") || error.message === "native_staff_access_denied");
    return response(denied ? 403 : 409, { error: denied ? "denied" : "conflict" });
  }
}
