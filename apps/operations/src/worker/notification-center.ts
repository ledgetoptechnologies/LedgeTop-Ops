import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { evaluatePermission, loadGrants } from "./acl";
import { base64Url, sha256 } from "./crypto";
import { d1TablesPresent } from "./schema-readiness";
import { authorizeClientFolderNotificationBatch, readClientFolderNotificationBatchScope } from "./client-folder-notification-batches";
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
const selectBatch = `SELECT batch.*,association.r2_prefix,account.status account_status,account.project_alpha_client_id,account.project_alpha_organization_id
  FROM client_folder_notification_batches batch
  JOIN client_folder_associations association ON association.id=batch.association_id
    AND association.account_id=batch.account_id AND association.logical_grant_id=batch.logical_grant_id
  JOIN client_accounts account ON account.id=batch.account_id`;
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
async function encodeCursor(env: Env, principal: StaffPrincipal, value: Cursor) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(principal.id) }, await cursorKey(env), new TextEncoder().encode(JSON.stringify(value)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(data))}`;
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
            AND account.status='active' AND account.project_alpha_client_id IS ? AND account.project_alpha_organization_id IS ?)`)
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
  app.get("/api/notifications/deliveries", async c => c.json(await listDeliveryNotificationBatches(c.env,c.get("principal"),c.req.query())));
  app.post("/api/notifications/deliveries/:id/:action", async c => {
    const action = c.req.param("action");
    if (action !== "send-now" && action !== "cancel") throw new HTTPException(404, { message: "Notification action not found" });
    // The Operations /api middleware authenticates and enforces origin + CSRF.
    const parsed = await actionBody(c.req.raw);
    return c.json(await controlDeliveryNotificationBatch(c.env,c.get("principal"),c.req.param("id"),action,parsed.expectedRevision,c.req.header("Idempotency-Key") || ""));
  });
}
