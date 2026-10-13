import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration,
  type AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { issueOperationsPortalNativeRecipientIntent, readOperationsPortalNativeRecipientIntentForOwner,
  readOperationsPortalNativeAuthorityCommand,
  cancelOperationsPortalNativeRecipientIntent, confirmOperationsPortalNativeRecipientIntent,
  revokeOperationsPortalNativeRecipient, revokeOperationsPortalNativeWorkspaceAuthority,
  readOperationsPortalNativeWorkspaceCleanupForOwner } from "./operations-portal-native-recipient-authority";
import { materializeOperationsPortalNativeRecipientAuthority, dispatchOperationsPortalNativeRecipientAuthority,
  type OperationsPortalNativeRecipientAuthorityDispatchEnv } from "./operations-portal-native-recipient-authority-dispatch";
import { reserveOperationsPortalNativeWorkspaceCleanupRecovery } from "./operations-portal-native-workspace-cleanup";

const BASE = "/api/native-client-portal/operations-recipient-enrollment";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const encoder = new TextEncoder();
type Actor = AuthenticatedNativeStaffWithAdmissionVersion;
type Configuration = NativeStaffAccessConfiguration & Readonly<{ origin: string; recipientOrigin: string; csrfSecret: string }>;
export type OperationsNativeRecipientOwnerHttpDependencies = Readonly<{
  environment: string; expectedHost: string; configuration: Configuration;
  database: D1Database; dispatch: OperationsPortalNativeRecipientAuthorityDispatchEnv;
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
function configuration(d: OperationsNativeRecipientOwnerHttpDependencies) {
  if (d.environment !== "staging" || !d.configuration.enabled) throw new Failure(404, "not_found");
  try {
    const origin = httpsOrigin(d.configuration.origin), recipient = httpsOrigin(d.configuration.recipientOrigin);
    const issuer = httpsOrigin(d.configuration.issuer), size = encoder.encode(d.configuration.csrfSecret).byteLength;
    if (origin.hostname !== d.expectedHost || !/(?:^|[-.])staging(?:[-.]|$)/u.test(origin.hostname)
      || !/(?:^|[-.])staging(?:[-.]|$)/u.test(recipient.hostname) || origin.origin === recipient.origin
      || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com"
      || !/^[A-Za-z0-9_-]{16,128}$/u.test(d.configuration.staffAudience) || size < 32 || size > 512
      || d.dispatch.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED !== "true"
      || typeof d.dispatch.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?.applyNativeAuthority !== "function"
      || typeof d.dispatch.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?.getNativeAuthorityStatus !== "function") throw Error();
    return { origin: origin.origin, recipientOrigin: recipient.origin, secret: d.configuration.csrfSecret,
      access: { enabled: true, issuer: issuer.origin, staffAudience: d.configuration.staffAudience } };
  } catch { throw new Failure(503, "unavailable"); }
}
const alive = (actor: Actor) => {
  if (!Number.isFinite(Date.parse(actor.verifiedUntil)) || Date.parse(actor.verifiedUntil) <= Date.now())
    throw new Failure(403, "denied");
};
function csrfMessage(origin: string, actor: Actor, bucket: number) {
  return encoder.encode(JSON.stringify(["operations-native-recipient-owner-csrf-v1", origin,
    actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion, bucket]));
}
async function csrf(secret: string, origin: string, actor: Actor, request?: Request): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const bucket = Math.floor(Date.now() / 600_000);
  if (!request) {
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, csrfMessage(origin, actor, bucket)));
    return `${bucket}.${[...signature].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  const token = request.headers.get("X-CSRF-Token")?.match(/^(\d{1,12})\.([0-9a-f]{64})$/u);
  const suppliedBucket = Number(token?.[1]);
  if (!token || (suppliedBucket !== bucket && suppliedBucket !== bucket - 1)) throw new Failure(403, "denied");
  const signature = Uint8Array.from(token[2]!.match(/../gu)!, part => Number.parseInt(part, 16));
  if (!await crypto.subtle.verify("HMAC", key, signature, csrfMessage(origin, actor, suppliedBucket))) throw new Failure(403, "denied");
  return "";
}
async function body(request: Request, names: readonly string[]): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers.get("Content-Type") ?? ""))
    throw new Failure(400, "invalid_request");
  let value: unknown;
  try { value = await readBoundedJson(request, 4096, "native recipient owner"); }
  catch { throw new Failure(400, "invalid_request"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name)))
    throw new Failure(400, "invalid_request");
  return value as Record<string, unknown>;
}
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }

/** Independent native manager boundary. It never infers client identity, PA roles or file access. */
export async function handleOperationsNativeRecipientOwnerHttp(request: Request, d: OperationsNativeRecipientOwnerHttpDependencies): Promise<Response> {
  try {
    const config = configuration(d), url = new URL(request.url);
    if (url.origin !== config.origin || url.search || url.hash || request.headers.get("Sec-Fetch-Site") !== "same-origin")
      throw new Failure(403, "denied");
    const relative = url.pathname.startsWith(`${BASE}/`) ? url.pathname.slice(BASE.length) : "";
    const session = request.method === "GET" && relative === "/session";
    const issue = request.method === "POST" && relative === "/intents";
    const read = request.method === "GET" && /^\/intents\/[0-9a-f-]{36}$/u.test(relative);
    const mutation = request.method === "POST" && /^\/intents\/[0-9a-f-]{36}\/(confirm|revoke|cancel|recover)$/u.test(relative);
    const workspaceRead = request.method === "GET" && /^\/workspaces\/[0-9a-f-]{36}$/u.test(relative);
    const workspaceMutation = request.method === "POST" && /^\/workspaces\/[0-9a-f-]{36}\/(revoke|recover)$/u.test(relative);
    if (!session && !issue && !read && !mutation && !workspaceRead && !workspaceMutation) throw new Failure(404, "not_found");
    const intentId = read || mutation ? relative.split("/")[2]! : null;
    if (intentId && !uuid(intentId)) throw new Failure(404, "not_found");
    const workspaceTargetId = workspaceRead || workspaceMutation ? relative.split("/")[2]! : null;
    if (workspaceTargetId && !uuid(workspaceTargetId)) throw new Failure(404, "not_found");
    if (session && request.headers.get("X-Native-Staff-Request") !== "1"
      || request.method === "POST" && request.headers.get("Origin") !== config.origin
      || request.headers.has("Origin") && request.headers.get("Origin") !== config.origin) throw new Failure(403, "denied");
    let actor: Actor;
    try { actor = await authenticateNativeStaffWithAdmissionVersion(request, d.database, config.access); }
    catch { throw new Failure(403, "denied"); }
    alive(actor);
    if (session) {
      const csrfToken = await csrf(config.secret, config.origin, actor); alive(actor);
      return response(200, { csrfToken, verifiedUntil: actor.verifiedUntil, recipientOrigin: config.recipientOrigin });
    }
    if (read) {
      const intent = await readOperationsPortalNativeRecipientIntentForOwner(d.database, intentId!, actor); alive(actor);
      return response(200, { intent });
    }
    if (workspaceRead) {
      const workspace = await readOperationsPortalNativeWorkspaceCleanupForOwner(d.database, workspaceTargetId!, actor);
      alive(actor); return response(200, { workspace });
    }
    await csrf(config.secret, config.origin, actor, request); alive(actor);
    if (workspaceMutation) {
      const action = relative.split("/")[3]!;
      const value = await body(request, action === "revoke"
        ? ["operationId", "expectedOwnershipEpoch", "reason"] : ["operationId", "expectedOwnershipEpoch"]);
      if (!uuid(value.operationId) || typeof value.expectedOwnershipEpoch !== "number"
        || !Number.isSafeInteger(value.expectedOwnershipEpoch) || value.expectedOwnershipEpoch < 1
        || action === "revoke" && (typeof value.reason !== "string" || value.reason.length < 1
          || value.reason.length > 500 || value.reason.trim() !== value.reason || /\p{C}/u.test(value.reason)))
        throw new Failure(400, "invalid_request");
      let replayed: boolean | undefined;
      if (action === "revoke") {
        const result = await revokeOperationsPortalNativeWorkspaceAuthority(d.database, {
          operationId: value.operationId, targetId: workspaceTargetId!, expectedOwnershipEpoch: value.expectedOwnershipEpoch,
          reason: value.reason as string, owner: actor,
        });
        alive(actor); replayed = result.replayed;
      } else {
        // Cleanup recovery uses the stored workspace command, not current
        // customer relationships and not a client-supplied owner/recipient.
        const workspace = await readOperationsPortalNativeWorkspaceCleanupForOwner(d.database, workspaceTargetId!, actor);
        alive(actor);
        const command = await readOperationsPortalNativeAuthorityCommand(d.database, value.operationId); alive(actor);
        if ((workspace.state !== "revoking" && workspace.state !== "revoked")
          || workspace.ownershipEpoch !== value.expectedOwnershipEpoch
          || workspace.recoveryOperationId !== value.operationId || command?.operation_id !== value.operationId
          || command.action !== "workspace.revoke" || command.target_id !== workspaceTargetId
          || command.resulting_ownership_epoch !== workspace.ownershipEpoch)
          throw new Failure(403, "denied");
      }
      await materializeOperationsPortalNativeRecipientAuthority(d.database, value.operationId); alive(actor);
      const beforeDispatch = await readOperationsPortalNativeWorkspaceCleanupForOwner(d.database, workspaceTargetId!, actor);
      alive(actor);
      let invocationId: string | undefined;
      if (beforeDispatch.state === "revoking") {
        if (beforeDispatch.recoveryOperationId !== value.operationId) throw new Failure(403, "denied");
        // A fresh invoker proof is independent of the immutable business command.
        // It permits recovery after the original login or automatic retry budget
        // expires without rewriting the historical wire or accepting an owner flag.
        invocationId = crypto.randomUUID();
        await reserveOperationsPortalNativeWorkspaceCleanupRecovery(d.database, {
          invocationId, operationId: value.operationId, owner: actor,
        }); alive(actor);
      } else if (beforeDispatch.state !== "revoked" || beforeDispatch.recoveryOperationId !== value.operationId)
        throw new Failure(403, "denied");
      const dispatched = invocationId
        ? await dispatchOperationsPortalNativeRecipientAuthority(d.dispatch, value.operationId, invocationId)
        : await dispatchOperationsPortalNativeRecipientAuthority(d.dispatch, value.operationId);
      alive(actor);
      if (dispatched.status === "rejected") return response(409, { operationId: value.operationId, status: "rejected" });
      if (dispatched.status === "disabled") throw new Failure(503, "unavailable");
      const workspace = await readOperationsPortalNativeWorkspaceCleanupForOwner(d.database, workspaceTargetId!, actor);
      alive(actor);
      return response(dispatched.status === "acknowledged" ? 200 : 202, { operationId: value.operationId,
        status: dispatched.status === "acknowledged" ? "acknowledged" : "pending", workspace,
        ...(replayed === undefined ? {} : { replayed }) });
    }
    if (issue) {
      const value = await body(request, ["operationId", "targetId", "targetClientRecordId", "expiresAt"]);
      if (!uuid(value.operationId) || !uuid(value.targetId) || typeof value.targetClientRecordId !== "string"
        || value.targetClientRecordId.length < 1 || value.targetClientRecordId.length > 191
        || /\p{C}/u.test(value.targetClientRecordId) || value.targetClientRecordId.trim() !== value.targetClientRecordId
        || typeof value.expiresAt !== "string") throw new Failure(400, "invalid_request");
      const result = await issueOperationsPortalNativeRecipientIntent(d.database, { operationId: value.operationId,
        targetId: value.targetId, targetClientRecordId: value.targetClientRecordId, expiresAt: value.expiresAt, owner: actor });
      alive(actor); return response(result.replayed ? 200 : 201, result);
    }
    const value = await body(request, ["operationId", "expectedRevision"]);
    if (!uuid(value.operationId) || typeof value.expectedRevision !== "number"
      || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) throw new Failure(400, "invalid_request");
    const input = { operationId: value.operationId, intentId: intentId!, expectedRevision: value.expectedRevision, owner: actor };
    const action = relative.split("/")[3]!;
    if (action === "recover") {
      // Recovery consumes only a currently reviewed intent's exact immutable
      // command. It cannot select another recipient, target or create a grant.
      const intent = await readOperationsPortalNativeRecipientIntentForOwner(d.database, intentId!, actor); alive(actor);
      const command = await readOperationsPortalNativeAuthorityCommand(d.database, value.operationId); alive(actor);
      const recoverable = command?.action === "recipient.grant" ? intent.state === "confirming" || intent.state === "active"
        : command?.action === "recipient.revoke" ? intent.state === "revoking" || intent.state === "revoked" : false;
      if (!recoverable || intent.revision !== value.expectedRevision || !intent.principal || !intent.recipientBindingId
        || command?.operation_id !== value.operationId || command.enrollment_intent_id !== intentId
        || command.target_id !== intent.target.targetId || command.target_revision !== intent.target.targetRevision
        || command.target_client_record_id !== intent.target.clientRecordId || command.recipient_binding_id !== intent.recipientBindingId
        || command.issuer !== intent.principal.issuer || command.subject !== intent.principal.subject) throw new Failure(403, "denied");
      await materializeOperationsPortalNativeRecipientAuthority(d.database, value.operationId); alive(actor);
      const dispatched = await dispatchOperationsPortalNativeRecipientAuthority(d.dispatch, value.operationId); alive(actor);
      if (dispatched.status === "rejected") return response(409, { operationId: value.operationId, status: "rejected" });
      if (dispatched.status === "disabled") throw new Failure(503, "unavailable");
      const current = await readOperationsPortalNativeRecipientIntentForOwner(d.database, intentId!, actor); alive(actor);
      return response(dispatched.status === "acknowledged" ? 200 : 202, { operationId: value.operationId,
        status: dispatched.status === "acknowledged" ? "acknowledged" : "pending", intent: current });
    }
    if (action === "cancel") {
      const result = await cancelOperationsPortalNativeRecipientIntent(d.database, input); alive(actor);
      return response(200, result);
    }
    const result = action === "confirm" ? await confirmOperationsPortalNativeRecipientIntent(d.database, input)
      : await revokeOperationsPortalNativeRecipient(d.database, input);
    alive(actor);
    await materializeOperationsPortalNativeRecipientAuthority(d.database, result.authorityOperationId); alive(actor);
    const dispatched = await dispatchOperationsPortalNativeRecipientAuthority(d.dispatch, result.authorityOperationId); alive(actor);
    if (dispatched.status === "rejected") return response(409, { operationId: result.authorityOperationId, status: "rejected" });
    if (dispatched.status === "disabled") throw new Failure(503, "unavailable");
    const intent = await readOperationsPortalNativeRecipientIntentForOwner(d.database, intentId!, actor); alive(actor);
    return response(dispatched.status === "acknowledged" ? 200 : 202, { operationId: result.authorityOperationId,
      status: dispatched.status === "acknowledged" ? "acknowledged" : "pending", intent, replayed: result.replayed });
  } catch (error) {
    const denied = error instanceof Error && (error.message === "operations_portal_native_recipient_denied"
      || error.message === "operations_portal_native_workspace_cleanup_denied");
    const failure = error instanceof Failure ? error : new Failure(
      denied ? 403 : 503, denied ? "denied" : "unavailable");
    return response(failure.status, { error: failure.code });
  }
}
