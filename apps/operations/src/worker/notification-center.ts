import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { evaluatePermission, loadGrants } from "./acl";
import { base64Url, sha256 } from "./crypto";
import { d1TablesPresent } from "./schema-readiness";
import { authorizeClientFolderNotificationBatch, readClientFolderNotificationBatchScope } from "./client-folder-notification-batches";
import {
  nativeDeliveryNotificationsReady, nativeNotificationCandidates,
  readNativeDeliveryNotificationScope, authorizeNativeDeliveryNotification,
  presentNativeDeliveryNotification, readNativeDeliveryNotification,
  controlNativeDeliveryNotification,
} from "./native-delivery-notification-center";
import type { Env, GrantRow, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
type Action = "send-now" | "cancel";
type View = "pending" | "history";
interface BatchRow {
  id: string; account_id: string; logical_grant_id: string; association_id: string; recipient_identity_id: string;
  revision: number; status: "pending" | "processing" | "sent" | "cancelled" | "suppressed" | "failed";
  eligible_at: string; created_at: string; updated_at: string; delivered_at: string | null; last_error: string | null;
  added_count: number; removed_count: number; attempt_count: number;
  r2_prefix: string; account_status: string; project_alpha_client_id: string | null; project_alpha_organization_id: string | null;
}
interface Receipt { batch_id: string; action: Action; fingerprint: string; result_revision: number; result_status: "pending" | "cancelled" }
type Scope = NonNullable<Awaited<ReturnType<typeof readClientFolderNotificationBatchScope>>>;
interface Cursor { v: 1; view: View; q: string; policy: string; after: [string,string]; expires: number }
interface CombinedCursor {
  v: 2; view: View; q: string; policy: string; nativeReady: boolean;
  legacyAfter: [string,string] | null; nativeAfter: [string,string] | null; expires: number;
}
const selectBatch = `SELECT batch.*,association.r2_prefix,account.status account_status,account.project_alpha_client_id,account.project_alpha_organization_id
  FROM client_folder_notification_batches batch
  JOIN client_folder_associations association ON association.id=batch.association_id
    AND association.account_id=batch.account_id AND association.logical_grant_id=batch.logical_grant_id
  JOIN client_accounts account ON account.id=batch.account_id AND account.project_alpha_source_id='project-alpha:primary'`;
const tables = ["client_folder_notification_batches", "client_folder_notification_batch_items", "client_folder_notification_batch_controls"];
const actions = z.object({ expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1) }).strict();

function changed(): never { throw new HTTPException(409, { message: "Notification or permissions changed. Refresh before trying again." }); }
async function ready(env: Env) {
  if (!(await d1TablesPresent(env.DELIVERY_DB, tables))) throw new HTTPException(503, { message: "The notification center is not ready. Its database upgrade must finish first." });
}
function cleanQuery(value: string): string {
  if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new HTTPException(400, { message: "Notification search is invalid" });
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase("en-US");
  if (normalized.length > 200) throw new HTTPException(400, { message: "Notification search is too long after normalization" });
  return normalized;
}
function iso(value: string): string { return new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toISOString(); }
function allowed(grants: GrantRow[], principal: StaffPrincipal, permission: "delivery.share.audit" | "delivery.share.create" | "delivery.share.revoke", divisionId: string) {
  return evaluatePermission(grants, principal, permission, { divisionId });
}
async function policy(env: Env, principal: StaffPrincipal) {
  const grants = await loadGrants(env, principal.id);
  const audit = grants.filter(row => row.permission === "delivery.share.audit");
  if (!audit.some(row => row.effect === "allow") || audit.some(row => row.source === "override" && row.effect === "deny" && row.scope === "global"))
    throw new HTTPException(403, { message: "Delivery notification audit permission is required" });
  const proof = await sha256(JSON.stringify([principal.id, grants.map(row => JSON.stringify(row)).sort()]));
  return { grants, proof };
}
async function combinedPolicy(env: Env, principal: StaffPrincipal) {
  const [access, staff] = await Promise.all([policy(env,principal),
    env.OPS_DB.withSession("first-primary").prepare("SELECT email,access_subject,project_alpha_user_id FROM staff_users WHERE id=? AND status='active'")
      .bind(principal.id).first<{email:string;access_subject:string|null;project_alpha_user_id:string|null}>()]);
  if (!staff || staff.email !== principal.email || staff.access_subject !== principal.accessSubject || staff.project_alpha_user_id !== principal.projectAlphaUserId)
    throw new HTTPException(403,{message:"Current staff authentication required"});
  return {grants:access.grants,proof:await sha256(JSON.stringify([access.proof,staff]))};
}
// Encrypt cursors, not just sign them: a bounded scan may end at a notification
// the caller cannot see, and its identifier/date must not become cursor metadata.
async function cursorKey(env: Env) {
  if (env.OPERATIONS_SESSION_SECRET.length < 32) throw new Error("Operations session secret is not configured");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`notification-center:v1:${env.OPERATIONS_SESSION_SECRET}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid-base64");
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
}
async function encodeCursor(env: Env, principal: StaffPrincipal, value: Cursor | CombinedCursor) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(principal.id) }, await cursorKey(env), new TextEncoder().encode(JSON.stringify(value)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(data))}`;
}

async function decodeCombinedCursor(env: Env, principal: StaffPrincipal, value: string, view: View, q: string, proof: string, nativeReady: boolean): Promise<CombinedCursor> {
  let cursor: CombinedCursor;
  try {
    if (value.length > 4096) throw new Error();
    const [iv, data, extra] = value.split(".");
    if (!iv || !data || extra !== undefined) throw new Error();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(iv), additionalData: new TextEncoder().encode(principal.id) }, await cursorKey(env), unbase64(data));
    const after = z.tuple([z.string().min(1).max(64), z.string().min(1).max(128)]).nullable();
    cursor = z.object({ v: z.literal(2), view: z.enum(["pending", "history"]), q: z.string().max(200), policy: z.string(),
      nativeReady: z.boolean(), legacyAfter: after, nativeAfter: after, expires: z.number().int() }).strict()
      .parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)));
  } catch { throw new HTTPException(400, { message: "Notification cursor is invalid" }); }
  if (cursor.view !== view || cursor.q !== q || cursor.policy !== proof || cursor.nativeReady !== nativeReady || cursor.expires < Date.now()) changed();
  return cursor;
}

/** One bounded server-side merge; independent scan positions retain each store's
 * indexed ordering without exposing an unauthorized candidate in the cursor. */
export async function listCombinedDeliveryNotifications(env: Env, principal: StaffPrincipal, query: { view?: string; q?: string; cursor?: string }) {
  const view = query.view || "pending";
  if (view !== "pending" && view !== "history") throw new HTTPException(400, { message: "Notification view is invalid" });
  const q = cleanQuery(query.q || ""), access = await combinedPolicy(env, principal);
  await ready(env);
  const nativeReady = await nativeDeliveryNotificationsReady(env);
  const cursor = query.cursor ? await decodeCombinedCursor(env, principal, query.cursor, view, q, access.proof, nativeReady) : null;
  let legacyAfter = cursor?.legacyAfter ?? null, nativeAfter = cursor?.nativeAfter ?? null;
  const legacy = await env.DELIVERY_DB.withSession("first-primary").prepare(`${selectBatch}
    WHERE batch.status ${view === "pending" ? "IN ('pending','processing')" : "IN ('sent','cancelled','suppressed','failed')"}
    ${legacyAfter ? "AND (batch.created_at<? OR (batch.created_at=? AND batch.id<?))" : ""}
    ORDER BY batch.created_at DESC,batch.id DESC LIMIT 51`)
    .bind(...(legacyAfter ? [legacyAfter[0], legacyAfter[0], legacyAfter[1]] : [])).all<BatchRow>();
  const native = nativeReady ? await nativeNotificationCandidates(env, view, nativeAfter ?? undefined, 51) : [];
  type NativeRow = (typeof native)[number];
  type NativeScope = NonNullable<Awaited<ReturnType<typeof readNativeDeliveryNotificationScope>>>;
  type Candidate = { kind: "folder_changes"; row: BatchRow; createdAt: string } | { kind: "portal_delivery"; row: NativeRow; createdAt: string };
  const candidates: Candidate[] = [
    ...legacy.results.map(row => ({ kind: "folder_changes" as const, row, createdAt: iso(row.created_at) })),
    ...native.map(row => ({ kind: "portal_delivery" as const, row, createdAt: row.createdAt })),
  ];
  const descending = (a: string, b: string) => a === b ? 0 : a > b ? -1 : 1;
  candidates.sort((a,b) => descending(a.createdAt,b.createdAt) || descending(a.kind,b.kind) || descending(a.row.id,b.row.id));
  const legacyKey = (row: BatchRow) => JSON.stringify([row.account_id,row.logical_grant_id,row.association_id,row.recipient_identity_id]);
  const legacyScopes = new Map<string, Scope | null>(), nativeScopes = new Map<string, NativeScope | null>();
  const selected: Array<{ kind: "folder_changes"; row: BatchRow; scope: Scope } | { kind: "portal_delivery"; row: NativeRow; scope: NativeScope }> = [];
  let examined = 0;
  for (const candidate of candidates.slice(0,50)) {
    examined += 1;
    if (candidate.kind === "folder_changes") {
      const row = candidate.row, key = legacyKey(row);
      legacyAfter = [row.created_at,row.id];
      if (!legacyScopes.has(key)) legacyScopes.set(key, await readClientFolderNotificationBatchScope(env,row));
      const scope = legacyScopes.get(key);
      if (!scope || !allowed(access.grants,principal,"delivery.share.audit",scope.divisionId)) continue;
      const search = `${scope.accountName}\n${scope.prefix.split("/").filter(Boolean).at(-1) || ""}\n${scope.recipientEmail || ""}`.normalize("NFC").toLocaleLowerCase("en-US");
      if (q && !search.includes(q)) continue;
      selected.push({ kind: candidate.kind, row, scope });
    } else {
      const row = candidate.row;
      nativeAfter = [row.createdAt,row.id];
      if (!nativeScopes.has(row.scopeKey)) nativeScopes.set(row.scopeKey,await readNativeDeliveryNotificationScope(env,row));
      const scope = nativeScopes.get(row.scopeKey);
      if (!scope || !allowed(access.grants,principal,"delivery.share.audit",scope.divisionId)) continue;
      const search = `${scope.sourceName}\n${scope.workspaceName}\n${scope.folderLabel}\n${scope.recipientEmail || ""}`.normalize("NFC").toLocaleLowerCase("en-US");
      if (q && !search.includes(q)) continue;
      selected.push({ kind: candidate.kind, row, scope });
    }
    if (selected.length === 25) break;
  }
  const items = [];
  const checked = new Set<string>(), legacySendable = new Map<string, boolean>();
  for (const entry of selected) {
    if (entry.kind === "folder_changes") {
      const key = legacyKey(entry.row);
      if (!checked.has(`legacy:${key}`)) {
        if (JSON.stringify(await readClientFolderNotificationBatchScope(env,entry.row)) !== JSON.stringify(entry.scope)) changed();
        checked.add(`legacy:${key}`);
      }
      if (entry.row.status === "pending" && !legacySendable.has(key)) legacySendable.set(key,Boolean(await authorizeClientFolderNotificationBatch(env,entry.row)));
      items.push({ ...presentation(entry.row,entry.scope,access.grants,principal,legacySendable.get(key) === true), kind: "folder_changes" as const });
    } else {
      const key = entry.row.scopeKey;
      const sendable = entry.row.status === "pending" ? Boolean(await authorizeNativeDeliveryNotification(env,entry.row)) : false;
      if (!checked.has(`native:${key}`)) {
        if (JSON.stringify(await readNativeDeliveryNotificationScope(env,entry.row)) !== JSON.stringify(entry.scope)) changed();
        checked.add(`native:${key}`);
      }
      items.push(presentNativeDeliveryNotification(entry.row,entry.scope,sendable,access.grants,principal));
    }
  }
  if ((await combinedPolicy(env,principal)).proof !== access.proof || await nativeDeliveryNotificationsReady(env) !== nativeReady) changed();
  return { items, nextCursor: examined < candidates.length ? await encodeCursor(env,principal,{ v:2, view,q,policy:access.proof,nativeReady,
    legacyAfter,nativeAfter,expires:Date.now()+30*60_000 }) : null,
    serverNow: new Date().toISOString(), coverage: "delivery_notifications_v2" as const,
    availability: { folderChanges: true as const, nativeDeliveries: nativeReady } };
}
async function decodeCursor(env: Env, principal: StaffPrincipal, value: string, view: View, q: string, proof: string): Promise<Cursor> {
  let cursor: Cursor;
  try {
    if (value.length > 2048) throw new Error();
    const [iv, data, extra] = value.split(".");
    if (!iv || !data || extra !== undefined) throw new Error();
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(iv), additionalData: new TextEncoder().encode(principal.id) }, await cursorKey(env), unbase64(data));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    const schema = z.object({ v: z.literal(1), view: z.enum(["pending","history"]), q: z.string().max(200), policy: z.string(), after: z.tuple([z.string().max(64), z.string().min(1).max(128)]), expires: z.number().int() }).strict();
    cursor = schema.parse(parsed);
  } catch { throw new HTTPException(400, { message: "Notification cursor is invalid" }); }
  if (cursor.view !== view || cursor.q !== q || cursor.policy !== proof || cursor.expires < Date.now()) changed();
  return cursor;
}
function presentation(row: BatchRow, scope: Scope, grants: GrantRow[], principal: StaffPrincipal, sendable: boolean) {
  return { id: row.id, revision: row.revision, status: row.status, accountName: scope.accountName,
    folderLabel: scope.prefix.split("/").filter(Boolean).at(-1) || "Client delivery", recipientEmail: scope.recipientEmail,
    addedCount: row.added_count, removedCount: row.removed_count, eligibleAt: iso(row.eligible_at),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), deliveredAt: row.delivered_at ? iso(row.delivered_at) : null,
    // Raw provider exceptions are intentionally not client-facing diagnostics.
    errorCode: row.last_error ? row.status === "suppressed" ? "no-longer-eligible" : row.status === "failed" || row.status === "pending" ? "delivery-attempt-failed" : null : null,
    canSendNow: sendable && row.status === "pending" && row.account_status === "active" && row.attempt_count < 3 && allowed(grants, principal, "delivery.share.create", scope.divisionId),
    canCancel: row.status === "pending" && row.account_status === "active" && allowed(grants, principal, "delivery.share.revoke", scope.divisionId) };
}

export async function listDeliveryNotificationBatches(env: Env, principal: StaffPrincipal, query: { view?: string; q?: string; cursor?: string }) {
  const view = query.view || "pending";
  if (view !== "pending" && view !== "history") throw new HTTPException(400, { message: "Notification view is invalid" });
  const q = cleanQuery(query.q || ""), access = await policy(env, principal);
  await ready(env);
  const cursor = query.cursor ? await decodeCursor(env, principal, query.cursor, view, q, access.proof) : null;
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`${selectBatch}
    WHERE batch.status ${view === "pending" ? "IN ('pending','processing')" : "IN ('sent','cancelled','suppressed','failed')"}
    ${cursor ? "AND (batch.created_at<? OR (batch.created_at=? AND batch.id<?))" : ""}
    ORDER BY batch.created_at DESC,batch.id DESC LIMIT 101`)
    .bind(...(cursor ? [cursor.after[0], cursor.after[0], cursor.after[1]] : [])).all<BatchRow>();
  const selected: Array<{ row: BatchRow; scope: Scope }> = [];
  // Many historical batches share one exact grant/recipient. Resolve that live
  // authority once per request, then recheck each selected context before return.
  // Never cache this across requests or key it by account alone.
  const scopeKey = (row: BatchRow) => JSON.stringify([row.account_id,row.logical_grant_id,row.association_id,row.recipient_identity_id]);
  const scopes = new Map<string, Scope | null>();
  let examined = 0, after: [string,string] | null = null;
  for (const row of rows.results.slice(0, 100)) {
    examined += 1; after = [row.created_at, row.id];
    const key = scopeKey(row);
    if (!scopes.has(key)) scopes.set(key, await readClientFolderNotificationBatchScope(env, row));
    const scope = scopes.get(key);
    if (!scope || !allowed(access.grants, principal, "delivery.share.audit", scope.divisionId)) continue;
    const searchable = `${scope.accountName}\n${scope.prefix.split("/").filter(Boolean).at(-1) || ""}\n${scope.recipientEmail || ""}`.normalize("NFC").toLocaleLowerCase("en-US");
    if (q && !searchable.includes(q)) continue;
    selected.push({ row, scope });
    if (selected.length === 25) break;
  }
  const items = [];
  const checked = new Set<string>(), sendableScopes = new Map<string, boolean>();
  for (const entry of selected) {
    const key = scopeKey(entry.row);
    if (!checked.has(key)) {
      const current = await readClientFolderNotificationBatchScope(env, entry.row);
      if (JSON.stringify(current) !== JSON.stringify(entry.scope)) changed();
      checked.add(key);
    }
    if (entry.row.status === "pending" && !sendableScopes.has(key)) sendableScopes.set(key, Boolean(await authorizeClientFolderNotificationBatch(env, entry.row)));
    const sendable = entry.row.status === "pending" && sendableScopes.get(key) === true;
    items.push(presentation(entry.row, entry.scope, access.grants, principal, sendable));
  }
  if ((await policy(env, principal)).proof !== access.proof) changed();
  return { items,
    nextCursor: after && examined < rows.results.length ? await encodeCursor(env, principal, { v: 1, view, q, policy: access.proof, after, expires: Date.now() + 30 * 60_000 }) : null,
    serverNow: new Date().toISOString(), coverage: "legacy_folder_changes" as const };
}

/** Exact read, independent of queue pagination and current dispatch status.
 * History authority is deliberately separate from permission to send again. */
export async function getDeliveryNotificationBatch(env: Env, principal: StaffPrincipal, id: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id))
    throw new HTTPException(404, { message: "Notification is unavailable" });
  const access = await policy(env, principal);
  await ready(env);
  const db = env.DELIVERY_DB.withSession("first-primary");
  const row = await db.prepare(`${selectBatch} WHERE batch.id=?`).bind(id).first<BatchRow>();
  const scope = row ? await readClientFolderNotificationBatchScope(env, row) : null;
  if (!row || !scope || !allowed(access.grants, principal, "delivery.share.audit", scope.divisionId))
    throw new HTTPException(404, { message: "Notification is unavailable" });
  const eligibility = row.status === "pending" ? await authorizeClientFolderNotificationBatch(env, row) : null;
  const currentScope = await readClientFolderNotificationBatchScope(env, row);
  const currentEligibility = row.status === "pending" ? await authorizeClientFolderNotificationBatch(env, row) : null;
  const currentRow = await env.DELIVERY_DB.withSession("first-primary").prepare(`${selectBatch} WHERE batch.id=?`).bind(id).first<BatchRow>();
  if (JSON.stringify(currentScope) !== JSON.stringify(scope) || JSON.stringify(currentRow) !== JSON.stringify(row)
    || JSON.stringify(currentEligibility) !== JSON.stringify(eligibility)
    || (await policy(env, principal)).proof !== access.proof) changed();
  return { item: presentation(row, scope, access.grants, principal, Boolean(eligibility)),
    serverNow: new Date().toISOString(), coverage: "legacy_folder_changes" as const };
}

async function receipt(env: Env, actor: string, key: string) {
  return env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT batch_id,action,fingerprint,result_revision,result_status
    FROM client_folder_notification_batch_controls WHERE actor_id=? AND mutation_key=?`).bind(actor,key).first<Receipt>();
}
function result(saved: Receipt, fingerprint: string, replayed: boolean) {
  if (saved.fingerprint !== fingerprint) throw new HTTPException(409, { message: "This request key was already used for a different notification action" });
  return { ok: true as const, id: saved.batch_id, action: saved.action, revision: saved.result_revision, status: saved.result_status, replayed };
}
export async function controlDeliveryNotificationBatch(env: Env, principal: StaffPrincipal, id: string, action: Action, expectedRevision: number, key: string) {
  if (!["send-now","cancel"].includes(action) || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !/^[A-Za-z0-9._:-]{16,128}$/.test(key) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER)
    throw new HTTPException(400, { message: "Notification action identifiers are invalid" });
  const access = await policy(env, principal);
  await ready(env);
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`${selectBatch} WHERE batch.id=?`).bind(id).first<BatchRow>();
  const scope = row ? await readClientFolderNotificationBatchScope(env, row) : null;
  if (!row || !scope || !allowed(access.grants, principal, "delivery.share.audit", scope.divisionId)
    || !allowed(access.grants, principal, action === "send-now" ? "delivery.share.create" : "delivery.share.revoke", scope.divisionId))
    throw new HTTPException(404, { message: "Notification action is unavailable" });
  const fingerprint = await sha256(JSON.stringify([principal.id, id, action, expectedRevision]));
  const assertCurrentContext = async () => {
    if (JSON.stringify(await readClientFolderNotificationBatchScope(env, row)) !== JSON.stringify(scope)
      || (await policy(env, principal)).proof !== access.proof) changed();
  };
  const existing = await receipt(env, principal.id, key);
  await assertCurrentContext();
  if (existing) return result(existing, fingerprint, true);
  if (row.revision !== expectedRevision || row.status !== "pending" || (action === "send-now" && row.attempt_count >= 3)) changed();
  if (action === "send-now" && !(await authorizeClientFolderNotificationBatch(env, row))) changed();
  const status = action === "cancel" ? "cancelled" : "pending";
  let applied = false;
  try {
    const transaction = await env.DELIVERY_DB.batch([
      env.DELIVERY_DB.prepare(`UPDATE client_folder_notification_batches SET status=?,revision=revision+1,
        eligible_at=CASE WHEN ?='send-now' THEN datetime('now') ELSE eligible_at END,updated_at=datetime('now')
        WHERE id=? AND revision=? AND status='pending' AND EXISTS (
          SELECT 1 FROM client_folder_associations association JOIN client_accounts account ON account.id=association.account_id
          WHERE association.id=client_folder_notification_batches.association_id AND association.account_id=client_folder_notification_batches.account_id
            AND association.logical_grant_id=client_folder_notification_batches.logical_grant_id AND association.r2_prefix=?
            AND account.status='active' AND account.project_alpha_source_id='project-alpha:primary' AND account.project_alpha_client_id IS ? AND account.project_alpha_organization_id IS ?)`)
        .bind(status,action,id,expectedRevision,row.r2_prefix,row.project_alpha_client_id,row.project_alpha_organization_id),
      env.DELIVERY_DB.prepare(`INSERT INTO client_folder_notification_batch_controls
        (actor_id,mutation_key,fingerprint,batch_id,action,expected_revision,result_revision,result_status)
        SELECT ?,?,?,?,?,?,?,? WHERE changes()=1`).bind(principal.id,key,fingerprint,id,action,expectedRevision,expectedRevision+1,status),
      env.DELIVERY_DB.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
        SELECT 'staff',?,?,'client_folder_notification_batch',?,? WHERE changes()=1`)
        .bind(principal.id,action === "cancel" ? "client.folder.notification.cancelled" : "client.folder.notification.send_requested",id,
          JSON.stringify({ accountId: row.account_id, divisionId: scope.divisionId, expectedRevision, revision: expectedRevision+1 })),
    ]);
    applied = Number(transaction[0]?.meta.changes || 0) === 1;
  } catch (error) {
    const raced = await receipt(env, principal.id, key);
    if (raced) {
      await assertCurrentContext();
      return result(raced, fingerprint, true);
    }
    throw error;
  }
  const saved = await receipt(env, principal.id, key);
  if (!saved) changed();
  await assertCurrentContext();
  return result(saved,fingerprint,!applied);
}

async function actionBody(request: Request): Promise<z.infer<typeof actions>> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") || !request.body)
    throw new HTTPException(400, { message: "Notification action must be JSON" });
  const reader = request.body.getReader(), bytes = new Uint8Array(1024);
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > bytes.byteLength) {
        await reader.cancel();
        throw new HTTPException(413, { message: "Notification action is too large" });
      }
      bytes.set(chunk.value,length); length += chunk.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  try { return actions.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0,length)))); }
  catch { throw new HTTPException(400, { message: "Notification action requires the displayed revision" }); }
}

export function registerNotificationCenterRoutes(app: App): void {
  app.get("/api/notifications/deliveries", async c => {
    const params = new URL(c.req.url).searchParams;
    for (const key of params.keys()) {
      if (!["format", "view", "q", "cursor"].includes(key) || params.getAll(key).length !== 1)
        throw new HTTPException(400, { message: "Notification list query is invalid" });
    }
    if (params.has("format") && params.get("format") !== "combined")
      throw new HTTPException(400, { message: "Notification format is invalid" });
    c.header("Cache-Control", "no-store");
    return c.json(await (params.get("format") === "combined" ? listCombinedDeliveryNotifications : listDeliveryNotificationBatches)(c.env,c.get("principal"),c.req.query()));
  });
  app.get("/api/notifications/deliveries/portal_delivery/:id", async c => {
    if (new URL(c.req.url).searchParams.size) throw new HTTPException(400, { message: "Notification detail query is invalid" });
    c.header("Cache-Control", "no-store");
    return c.json({ ...await readNativeDeliveryNotification(c.env,c.req.param("id"),c.get("principal")),
      coverage: "delivery_notifications_v2" as const, availability: { folderChanges: true, nativeDeliveries: true } });
  });
  app.post("/api/notifications/deliveries/portal_delivery/:id/:action", async c => {
    const action = c.req.param("action");
    if (action !== "send-now" && action !== "cancel") throw new HTTPException(404, { message: "Notification action not found" });
    if (new URL(c.req.url).searchParams.size) throw new HTTPException(400, { message: "Notification action query is invalid" });
    const parsed = await actionBody(c.req.raw);
    c.header("Cache-Control", "no-store");
    return c.json({ ...await controlNativeDeliveryNotification(c.env,c.get("principal"),c.req.param("id"),action,parsed.expectedRevision,c.req.header("Idempotency-Key") || ""),kind: "portal_delivery" as const });
  });
  app.get("/api/notifications/deliveries/:id", async c => {
    if (new URL(c.req.url).searchParams.size) throw new HTTPException(400, { message: "Notification detail query is invalid" });
    c.header("Cache-Control", "no-store");
    return c.json(await getDeliveryNotificationBatch(c.env, c.get("principal"), c.req.param("id")));
  });
  app.post("/api/notifications/deliveries/:id/:action", async c => {
    const action = c.req.param("action");
    if (action !== "send-now" && action !== "cancel") throw new HTTPException(404, { message: "Notification action not found" });
    if (new URL(c.req.url).searchParams.size) throw new HTTPException(400, { message: "Notification action query is invalid" });
    // The Operations /api middleware authenticates and enforces origin + CSRF.
    const parsed = await actionBody(c.req.raw);
    c.header("Cache-Control", "no-store");
    return c.json(await controlDeliveryNotificationBatch(c.env,c.get("principal"),c.req.param("id"),action,parsed.expectedRevision,c.req.header("Idempotency-Key") || ""));
  });
}
