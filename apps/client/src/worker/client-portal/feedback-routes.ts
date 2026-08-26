import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { ClientFeedbackDetail, ClientFeedbackItem, ClientFeedbackEvent } from "@ltds/shared";
import type { Env } from "../types";
import type { ClientPortalSession, VerifiedClientPrincipal } from "./types";
import type { EffectivePortalWorkspaceContext } from "./workspace-v2";
import {
  createFeedbackRecord, feedbackFingerprint, feedbackScopeKey, FeedbackStoreError, readFeedbackRecord,
  type FeedbackRecord,
} from "./feedback-store";
import {
  clientFeedbackTargetActionPath, feedbackTargetInputSchema, reauthorizeFeedbackRecipient,
  resolveClientFeedbackTarget, resolveClientFeedbackFileMetadata, type ResolvedFeedbackTarget,
} from "./feedback-target";
import { d1ClientPortalRepository } from "./repository";

type Variables = { clientSession: ClientPortalSession; clientPrincipal: VerifiedClientPrincipal; clientWorkspace: EffectivePortalWorkspaceContext | null };
type FeedbackContext = Context<{ Bindings: Env; Variables: Variables }>;
const uuid = z.string().uuid();
const opaqueId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const PAGE_SIZE = 5;

export async function clientFeedbackSchemaAvailable(env: Pick<Env, "DELIVERY_DB">): Promise<boolean> {
  const count = await env.DELIVERY_DB.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name IN
    ('client_feedback','client_feedback_events','client_feedback_mutations','client_feedback_notifications','client_feedback_notification_outbox')`).first<number>("count");
  return count === 5;
}
function sameOrigin(c: FeedbackContext) {
  const origin = new URL(c.req.url).origin;
  if (origin !== c.env.CLIENT_PORTAL_ORIGIN || c.req.header("Origin") !== origin)
    throw new HTTPException(403, { message: "This request is not allowed" });
}
async function body(c: FeedbackContext): Promise<unknown> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: "A JSON body is required" });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 32_768) { await reader.cancel(); throw new HTTPException(413, { message: "Feedback is too large" }); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HTTPException(400, { message: "Feedback JSON is invalid" }); }
}
function owns(c: FeedbackContext, record: FeedbackRecord): boolean {
  const session = c.get("clientSession"), principal = c.get("clientPrincipal"), workspace = c.get("clientWorkspace");
  return record.context.accountId === session.accountId && record.context.identityId === session.identityId &&
    record.context.workspaceId === (workspace?.workspaceId ?? null) && record.context.workspaceIdentityId === (workspace?.identityId ?? null) &&
    record.context.issuer === principal.issuer && record.context.subject === principal.subject;
}
async function authorized(c: FeedbackContext, record: FeedbackRecord): Promise<ResolvedFeedbackTarget | null> {
  if (!owns(c,record)) return null;
  return (await reauthorizeFeedbackRecipient(c.env,record))?.authorization ?? null;
}
async function current(c: FeedbackContext, resolved: ResolvedFeedbackTarget) {
  if (!(await c.env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT 1 ok WHERE ${resolved.guard.sql}`)
    .bind(...resolved.guard.bindings).first("ok"))) throw new HTTPException(409, { message: "Feedback access changed. Refresh the client workspace." });
}
export async function clientFeedbackItem(env: Env, record: FeedbackRecord, resolved: ResolvedFeedbackTarget): Promise<ClientFeedbackItem> {
  return { id: record.id, status: record.status, revision: record.revision, message: record.message,
    completionNote: record.completionNote, createdAt: record.createdAt, updatedAt: record.updatedAt, completedAt: record.completedAt,
    target: { kind: record.target.kind, projectId: record.target.projectId, label: record.target.label,
      projectName: record.target.projectName, available: resolved.available, actionPath: await clientFeedbackTargetActionPath(env,resolved) } };
}
async function detail(c: FeedbackContext, record: FeedbackRecord, resolved: ResolvedFeedbackTarget): Promise<ClientFeedbackDetail> {
  const rows = await c.env.DELIVERY_DB.prepare(`SELECT revision,actor_type actor,status,note,created_at createdAt
    FROM client_feedback_events WHERE feedback_id=? ORDER BY revision LIMIT 4`).bind(record.id).all<ClientFeedbackEvent>();
  if (rows.results.length > 3) throw new HTTPException(503, { message: "Feedback history is unavailable" });
  const result = { feedback: await clientFeedbackItem(c.env,record,resolved), events: rows.results };
  await current(c,resolved);
  return result;
}
interface PageCursor { scope: string; at: string; id: string }
async function paging(c: FeedbackContext, kind: string) {
  const query = c.req.queries();
  if (Object.keys(query).some(key => !["cursor","limit"].includes(key)) || Object.values(query).some(values => values.length !== 1))
    throw new HTTPException(400, { message: "Feedback query is invalid" });
  const limitValue = c.req.query("limit") ?? String(PAGE_SIZE);
  if (!/^[1-5]$/.test(limitValue)) throw new HTTPException(400, { message: "Feedback page size is invalid" });
  const principal = c.get("clientPrincipal"), session = c.get("clientSession"), workspace = c.get("clientWorkspace");
  const scope = await feedbackFingerprint([kind,session.accountId,session.identityId,workspace?.workspaceId ?? null,
    workspace?.identityId ?? null,principal.issuer,principal.subject]);
  const value = c.req.query("cursor"); let cursor: PageCursor | null = null;
  if (value) try {
    if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = z.object({ scope: z.string().length(64), at: z.string().max(40), id: uuid }).strict()
      .parse(JSON.parse(atob(value.replace(/-/g,"+").replace(/_/g,"/"))));
    if (parsed.scope !== scope || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
    cursor = parsed;
  } catch { throw new HTTPException(409, { message: "Feedback page changed. Refresh the client workspace." }); }
  return { limit: Number(limitValue), cursor, scope };
}
function cursor(scope: string, row: { created_at: string; id: string }) {
  return btoa(JSON.stringify({ scope, at: row.created_at, id: row.id })).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

export function createClientFeedbackRouter(schemaAvailable: (env: Env) => Promise<boolean> = clientFeedbackSchemaAvailable) {
  const router = new Hono<{ Bindings: Env; Variables: Variables }>();
  const requireSchema: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c,next) => {
    c.header("Cache-Control","private, no-store");
    if (!await schemaAvailable(c.env)) throw new HTTPException(503, { message: "Client feedback is not available" });
    await next();
  };
  for (const path of ["/feedback", "/feedback/*", "/feedback-notifications", "/feedback-notifications/*", "/files/:fileId/metadata"])
    router.use(path,requireSchema);
  router.onError((error,c) => {
    if (error instanceof FeedbackStoreError) return c.json({ error: error.code === "invalid" ? "Feedback is invalid" : "Feedback changed. Refresh and try again." }, error.code === "invalid" ? 400 : 409);
    if (error instanceof HTTPException) return error.getResponse();
    throw error;
  });
  router.get("/feedback/target", async c => {
    const values = c.req.queries("target");
    if (values?.length !== 1 || values[0]!.length > 8192 || Object.keys(c.req.queries()).some(key => key !== "target"))
      throw new HTTPException(400, { message: "Feedback target is invalid" });
    let value: unknown;
    try { value = JSON.parse(values[0]!); } catch { throw new HTTPException(400, { message: "Feedback target is invalid" }); }
    const parsed = feedbackTargetInputSchema.safeParse(value);
    if (!parsed.success) throw new HTTPException(400, { message: "Feedback target is invalid" });
    const resolved = await resolveClientFeedbackTarget(c.env,c.get("clientPrincipal"),c.get("clientSession"),c.get("clientWorkspace"),parsed.data);
    await current(c,resolved);
    return c.json({ target: { kind: resolved.target.kind,projectId: resolved.target.projectId,label: resolved.target.label,
      projectName: resolved.target.projectName,available: true,actionPath: await clientFeedbackTargetActionPath(c.env,resolved) },workspaceId: resolved.context.workspaceId });
  });
  router.get("/files/:fileId/metadata", async c => {
    const projects = c.req.queries("projectId");
    const projectId = projects ? opaqueId.safeParse(projects[0]) : null;
    if ((projects && projects.length !== 1) || (projectId && !projectId.success)) throw new HTTPException(400, { message: "File target is invalid" });
    const requested = { kind: "file" as const,projectId: projectId?.success ? projectId.data : null,fileId: c.req.param("fileId") };
    const resolved = await resolveClientFeedbackFileMetadata(c.env,c.get("clientPrincipal"),c.get("clientSession"),c.get("clientWorkspace"),requested);
    const file = await d1ClientPortalRepository.getAuthorizedFile(c.env,c.get("clientSession"),requested.fileId,requested.projectId);
    if (!file) throw new HTTPException(404, { message: "File not found" });
    const { storageKey: _storageKey,...safe } = file;
    await current(c,resolved);
    return c.json({ file: { ...safe,id: requested.fileId },projectId: requested.projectId,workspaceId: resolved.context.workspaceId });
  });
  router.post("/feedback", async c => {
    sameOrigin(c);
    const parsed = z.object({ target: feedbackTargetInputSchema,message: z.string().trim().min(1).max(5000) }).strict().safeParse(await body(c));
    const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/).safeParse(c.req.header("Idempotency-Key"));
    if (!parsed.success || !key.success) throw new HTTPException(400, { message: "Feedback is invalid" });
    const limiter = c.env.PUBLIC_BULK_RATE_LIMITER;
    if (!limiter?.limit) throw new HTTPException(503, { message: "Feedback submission is unavailable" });
    const principal = c.get("clientPrincipal");
    if (!(await limiter.limit({ key: `feedback:${await feedbackFingerprint([principal.issuer,principal.subject])}` })).success)
      throw new HTTPException(429, { message: "Please wait before submitting more feedback" });
    const resolved = await resolveClientFeedbackTarget(c.env,principal,c.get("clientSession"),c.get("clientWorkspace"),parsed.data.target);
    const saved = await createFeedbackRecord(c.env.DELIVERY_DB.withSession("first-primary"),resolved,parsed.data.message,key.data);
    const authorizedSaved = await authorized(c,saved.record);
    if (!authorizedSaved) throw new HTTPException(404, { message: "Feedback not found" });
    return c.json({ ...await detail(c,saved.record,authorizedSaved),replayed: saved.replayed },saved.replayed ? 200 : 201);
  });
  router.get("/feedback", async c => {
    const page = await paging(c,"feedback"), session = c.get("clientSession"), principal = c.get("clientPrincipal");
    const rows = await c.env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,created_at FROM client_feedback
      WHERE scope_key=? AND account_id=? AND principal_issuer=? AND principal_subject=? AND creator_identity_id=?
        AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
      .bind(feedbackScopeKey({accountId:session.accountId,workspaceId:c.get("clientWorkspace")?.workspaceId ?? null}),session.accountId,
        principal.issuer,principal.subject,session.identityId,page.cursor?.at ?? null,page.cursor?.at ?? null,page.cursor?.at ?? null,page.cursor?.id ?? null,page.limit+1)
      .all<{ id: string; created_at: string }>();
    const examined = rows.results.slice(0,page.limit), items: ClientFeedbackItem[] = [], proofs: ResolvedFeedbackTarget[] = [];
    for (const row of examined) {
      const record = await readFeedbackRecord(c.env.DELIVERY_DB,row.id); if (!record) continue;
      const resolved = await authorized(c,record); if (!resolved) continue;
      items.push(await clientFeedbackItem(c.env,record,resolved)); proofs.push(resolved);
    }
    for (const proof of proofs) await current(c,proof);
    return c.json({ items,nextCursor: rows.results.length>page.limit ? cursor(page.scope,examined.at(-1)!) : null });
  });
  router.get("/feedback/:id", async c => {
    const id = uuid.safeParse(c.req.param("id"));
    const record = id.success ? await readFeedbackRecord(c.env.DELIVERY_DB,id.data) : null;
    const resolved = record ? await authorized(c,record) : null;
    if (!record || !resolved) throw new HTTPException(404, { message: "Feedback not found" });
    return c.json(await detail(c,record,resolved));
  });
  router.get("/feedback-notifications", async c => {
    const page = await paging(c,"notifications"), session = c.get("clientSession"), workspace = c.get("clientWorkspace");
    const rows = await c.env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,feedback_id,read_at,created_at FROM client_feedback_notifications
      WHERE account_id=? AND recipient_identity_id=? AND workspace_id IS ? AND workspace_identity_id IS ? AND dismissed_at IS NULL
        AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`)
      .bind(session.accountId,session.identityId,workspace?.workspaceId ?? null,workspace?.identityId ?? null,
        page.cursor?.at ?? null,page.cursor?.at ?? null,page.cursor?.at ?? null,page.cursor?.id ?? null,page.limit+1)
      .all<{ id: string;feedback_id: string;read_at: string|null;created_at: string }>();
    const examined = rows.results.slice(0,page.limit), notifications = [], proofs: ResolvedFeedbackTarget[] = [];
    for (const row of examined) {
      const record = await readFeedbackRecord(c.env.DELIVERY_DB,row.feedback_id); if (!record) continue;
      const resolved = await authorized(c,record); if (!resolved) continue;
      const query = workspace ? `?workspace=${encodeURIComponent(workspace.workspaceId)}` : "";
      notifications.push({ id: row.id,feedbackId: record.id,title: "Feedback completed",body: record.completionNote ?? "Your feedback has been handled.",
        actionPath: `/portal/feedback/${encodeURIComponent(record.id)}${query}`,readAt: row.read_at,createdAt: row.created_at });
      proofs.push(resolved);
    }
    for (const proof of proofs) await current(c,proof);
    return c.json({ notifications,nextCursor: rows.results.length>page.limit ? cursor(page.scope,examined.at(-1)!) : null });
  });
  router.patch("/feedback-notifications/:id", async c => {
    sameOrigin(c);
    const id = uuid.safeParse(c.req.param("id")), action = z.object({action:z.enum(["read","dismiss"])}).strict().safeParse(await body(c));
    if (!id.success || !action.success) throw new HTTPException(400, { message: "Notification update is invalid" });
    const row = await c.env.DELIVERY_DB.prepare("SELECT feedback_id FROM client_feedback_notifications WHERE id=?").bind(id.data).first<{feedback_id:string}>();
    const record = row ? await readFeedbackRecord(c.env.DELIVERY_DB,row.feedback_id) : null;
    const resolved = record ? await authorized(c,record) : null;
    if (!record || !resolved) throw new HTTPException(404, { message: "Notification not found" });
    const result = await c.env.DELIVERY_DB.prepare(`UPDATE client_feedback_notifications SET read_at=COALESCE(read_at,datetime('now')),
      dismissed_at=CASE WHEN ?='dismiss' THEN COALESCE(dismissed_at,datetime('now')) ELSE dismissed_at END
      WHERE id=? AND account_id=? AND recipient_identity_id=? AND workspace_id IS ? AND workspace_identity_id IS ? AND (${resolved.guard.sql})`)
      .bind(action.data.action,id.data,record.context.accountId,record.context.identityId,record.context.workspaceId,record.context.workspaceIdentityId,...resolved.guard.bindings).run();
    if (Number(result.meta.changes)!==1) throw new HTTPException(409, { message: "Notification access changed" });
    return c.json({success:true});
  });
  return router;
}
