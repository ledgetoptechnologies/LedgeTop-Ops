import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import { requirePermission } from "./acl";
import { decodeRef, encodeRef, mediaKind } from "./delivery";
import { auditStatement, requireMutationSecurity } from "./request-security";
import { executeSourceDelete } from "./source-delete";
import { restoreTombstone } from "./trash";
import type { Env, StaffPrincipal } from "./types";
import type { Permission } from "@ltds/shared";
import { presignOperationsR2Part } from "./r2-signing";
import { canonicalThumbnailSourceKey, enqueueThumbnailJob, removeThumbnailStateForPath } from "./image-thumbnails";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { assertSafeCrudDestination, normalizeCrudKey, operationsMultipartPartSize } from "./r2-crud-validation";
import { artifactDirectory } from "./artifacts";
import {
  DIRECT_DELIVERY_UPLOADS_DISABLED_CODE,
  DIRECT_DELIVERY_UPLOADS_DISABLED_MESSAGE,
  directDeliveryUploadsCapability,
} from "./direct-upload-policy";
type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
type ConflictPolicy = "fail" | "skip" | "replace" | "rename";
type CrudPermission = Permission;

const permission = (value: string): CrudPermission => value as CrudPermission;
const CREATE = permission("delivery.files.create");
const COPY = permission("delivery.files.copy");
const MOVE = permission("delivery.files.move");
const UPLOAD = permission("delivery.files.upload");
const BATCH = permission("delivery.files.batch");
const RESTORE = permission("delivery.files.restore");
const MAX_BATCH_OPERATIONS = 25;
const MAX_JOB_OBJECTS_PER_TURN = 1;
const MAX_UPLOAD_SIZE = 500 * 1024 ** 3;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

function jsonBody(c: any): Promise<any> {
  return c.req.json().catch(() => { throw new HTTPException(400, { message: "Request body must be JSON" }); });
}


function policy(value: unknown): ConflictPolicy {
  if (value === undefined) return "fail";
  if (value !== "fail" && value !== "skip" && value !== "replace" && value !== "rename") throw new HTTPException(400, { message: "Invalid conflict policy" });
  return value;
}

function isFolderKey(key: string): boolean { return key.endsWith("/"); }
function prefixFor(key: string): string { return key.endsWith("/") ? key : `${key}/`; }
function leaf(key: string): string { return key.replace(/\/$/, "").split("/").pop() || "item"; }

async function divisionForKey(env: Env, key: string): Promise<string | null> {
  const rows = await env.OPS_DB.prepare("SELECT division_id,r2_prefix FROM project_folders ORDER BY length(r2_prefix) DESC").all<{ division_id: string; r2_prefix: string }>();
  const normalized = key.replace(/\\/g, "/");
  return rows.results.find(row => {
    const prefix = row.r2_prefix.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "") + "/";
    return normalized === prefix.slice(0, -1) || normalized.startsWith(prefix);
  })?.division_id ?? null;
}

async function requireCrudPermission(env: Env, principal: StaffPrincipal, required: CrudPermission, key: string): Promise<void> {
  const context = { divisionId: await divisionForKey(env, key) };
  await requirePermission(env, principal, "delivery.browse", context, true);
  await requirePermission(env, principal, required, context, true);
}

async function ensureSource(env: Env, key: string): Promise<{ object: R2Object; folder: boolean }> {
  const object = key.endsWith("/") ? null : await env.DATA_BUCKET.head(key);
  if (object) return { object, folder: false };
  const folder = prefixFor(key);
  const listed = await env.DATA_BUCKET.list({ prefix: folder, limit: 1 });
  if (!listed.objects.length && !listed.delimitedPrefixes.length) throw new HTTPException(404, { message: "Source object or folder not found" });
  return { object: null as never, folder: true };
}

async function targetName(env: Env, target: string, conflict: ConflictPolicy): Promise<string | null> {
  if (!(await env.DATA_BUCKET.head(target))) return target;
  if (conflict === "skip") return null;
  if (conflict === "fail") throw new HTTPException(409, { message: "The destination already exists" });
  if (conflict === "replace") return target;
  const slash = target.lastIndexOf("/"); const parent = slash >= 0 ? target.slice(0, slash + 1) : ""; const name = slash >= 0 ? target.slice(slash + 1) : target;
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : ""; const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 2; index <= 1001; index += 1) { const candidate = `${parent}${stem} (${index})${extension}`; if (!(await env.DATA_BUCKET.head(candidate))) return candidate; }
  throw new HTTPException(409, { message: "Could not find an available destination name" });
}

async function targetFolderName(env:Env,target:string,conflict:ConflictPolicy):Promise<string|null>{
  const exists=Boolean(await env.DATA_BUCKET.head(target))||(await env.DATA_BUCKET.list({prefix:prefixFor(target),limit:1})).objects.length>0;
  if(!exists)return prefixFor(target);if(conflict==="skip")return null;if(conflict==="fail")throw new HTTPException(409,{message:"The destination already exists"});if(conflict==="replace")return prefixFor(target);
  const clean=target.replace(/\/$/,""),slash=clean.lastIndexOf("/"),parent=slash>=0?clean.slice(0,slash+1):"",name=slash>=0?clean.slice(slash+1):clean;
  for(let index=2;index<=1001;index+=1){const candidate=`${parent}${name} (${index})/`;const found=Boolean(await env.DATA_BUCKET.head(candidate))||(await env.DATA_BUCKET.list({prefix:candidate,limit:1})).objects.length>0;if(!found)return candidate;}
  throw new HTTPException(409,{message:"Could not find an available destination folder name"});
}

async function copyObject(env: Env, source: string, target: string, conflict: ConflictPolicy,roots?:{source:string;target:string}): Promise<{ target: string | null; skipped: boolean }> {
  const sourceHead = await env.DATA_BUCKET.head(source); if (!sourceHead) throw new Error("source-disappeared");
  const resolved = await targetName(env, target, conflict); if (!resolved) return { target: null, skipped: true };
  if(conflict==="replace"){const existing=await env.DATA_BUCKET.get(resolved);if(existing){const id=crypto.randomUUID(),recoveryKey=`Jobs/Clients/_ltds/replacements/${id}/${leaf(resolved)}`;await env.DATA_BUCKET.put(recoveryKey,existing.body,{httpMetadata:existing.httpMetadata,customMetadata:existing.customMetadata});await env.OPS_DB.prepare("INSERT INTO r2_replacement_recovery(id,original_key,recovery_key,purge_after) VALUES(?,?,?,datetime('now','+7 days'))").bind(id,resolved,recoveryKey).run();}}
  const indexed=await env.DELIVERY_DB.prepare("SELECT content_type,media_kind,stream_uid,stream_status,stream_error FROM file_index WHERE r2_key=?").bind(source).first<{content_type:string|null;media_kind:string;stream_uid:string|null;stream_status:string|null;stream_error:string|null}>();
  if(indexed&&indexed.media_kind!=="image")await env.OPS_DB.prepare("INSERT INTO r2_event_suppressions(object_key,event_kind,expires_at) VALUES(?,'create',datetime('now','+1 hour')) ON CONFLICT(object_key) DO UPDATE SET expires_at=excluded.expires_at").bind(resolved).run();
  const sourceObject = await env.DATA_BUCKET.get(source); if (!sourceObject) throw new Error("source-disappeared");
  let written:R2Object;
  if(roots&&source.endsWith("/manifest.json")&&source.includes("/.previews/")){const bytes=await sourceObject.arrayBuffer(),manifest=(()=>{try{return JSON.parse(new TextDecoder().decode(bytes))}catch{return null}})();if(manifest&&typeof manifest.sourceKey==="string"&&manifest.sourceKey.startsWith(roots.source)){manifest.sourceKey=`${roots.target}${manifest.sourceKey.slice(roots.source.length)}`;written=await env.DATA_BUCKET.put(resolved,JSON.stringify(manifest),{httpMetadata:{...sourceObject.httpMetadata,contentType:"application/json"},customMetadata:sourceObject.customMetadata});}else written=await env.DATA_BUCKET.put(resolved,bytes,{httpMetadata:sourceObject.httpMetadata,customMetadata:sourceObject.customMetadata});}
  else written=await env.DATA_BUCKET.put(resolved, sourceObject.body, { httpMetadata: sourceObject.httpMetadata, customMetadata: sourceObject.customMetadata });
  if(indexed)await env.DELIVERY_DB.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind,stream_uid,stream_status,stream_error)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,size=excluded.size,uploaded_at=excluded.uploaded_at,content_type=excluded.content_type,media_kind=excluded.media_kind,stream_uid=excluded.stream_uid,stream_status=excluded.stream_status,stream_error=excluded.stream_error,updated_at=datetime('now')`)
    .bind(resolved,written.httpEtag,written.size,written.uploaded.toISOString(),indexed.content_type,indexed.media_kind,indexed.stream_uid,indexed.stream_status,indexed.stream_error).run();
  if(indexed?.media_kind==="image"&&mediaKind(resolved)==="image"){
    try{await enqueueThumbnailJob(env,{sourceKey:resolved,sourceEtag:written.httpEtag,sourceSize:written.size});}
    catch(error){console.error(JSON.stringify({event:"thumbnail.copy-enqueue-failed",key:resolved,error:error instanceof Error?error.message:"unknown"}));}
  }
  return { target: resolved, skipped: false };
}

async function copyPreparedArtifacts(env:Env,source:string,target:string,move:boolean):Promise<void>{const sourcePrefix=await artifactDirectory(source),targetPrefix=await artifactDirectory(target);let cursor:string|undefined;do{const page=await env.DATA_BUCKET.list({prefix:sourcePrefix,limit:100,cursor});for(const object of page.objects){const destination=`${targetPrefix}${object.key.slice(sourcePrefix.length)}`;await copyObject(env,object.key,destination,"replace",{source,target});if(move)await env.DATA_BUCKET.delete(object.key);}cursor=page.truncated?page.cursor:undefined;}while(cursor);}

async function revokeImpactedShares(env: Env, actorId: string, key: string): Promise<number> {
  const prefix = prefixFor(key);
  const rows = await env.DELIVERY_DB.prepare(`SELECT s.id FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE s.revoked_at IS NULL AND p.active=1 AND (COALESCE(s.r2_prefix,p.r2_prefix)=? OR substr(COALESCE(s.r2_prefix,p.r2_prefix),1,length(?))=?)`)
    .bind(key, prefix, prefix).all<{ id: string }>();
  if (!rows.results.length) return 0;
  await env.DELIVERY_DB.batch(rows.results.flatMap(row => [
    env.DELIVERY_DB.prepare("UPDATE shares SET revoked_at=datetime('now'),revoked_reason='staff_r2_mutation',share_version=share_version+1 WHERE id=? AND revoked_at IS NULL").bind(row.id),
    env.DELIVERY_DB.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('staff',?,'share.auto_revoked','share',?,?)").bind(actorId, row.id, JSON.stringify({ reason: "staff_r2_mutation", sourceKey: key })),
  ]));
  return rows.results.length;
}

async function keepImpactedShares(env: Env, source: string, target: string): Promise<number> {
  const prefix = prefixFor(source);
  const rows = await env.DELIVERY_DB.prepare(`SELECT s.id,s.project_id,COALESCE(s.r2_prefix,p.r2_prefix) root
    FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.revoked_at IS NULL AND p.active=1
    AND (COALESCE(s.r2_prefix,p.r2_prefix)=? OR substr(COALESCE(s.r2_prefix,p.r2_prefix),1,length(?))=?)`)
    .bind(source, prefix, prefix).all<{id:string;project_id:string;root:string}>();
  if(!rows.results.length)return 0;
  const statements:D1PreparedStatement[]=[];const projects=new Map<string,string>();
  for(const row of rows.results){const next=`${target}${row.root.slice(source.length)}`;statements.push(env.DELIVERY_DB.prepare("UPDATE shares SET r2_prefix=?,share_version=share_version+1 WHERE id=? AND revoked_at IS NULL").bind(next,row.id));projects.set(row.project_id,next);}
  for(const [projectId,next] of projects)statements.push(env.DELIVERY_DB.prepare("UPDATE projects SET r2_prefix=?,updated_at=datetime('now') WHERE id=?").bind(next,projectId));
  await env.DELIVERY_DB.batch(statements);return rows.results.length;
}

async function finalizeMovedShares(env:Env,principal:StaffPrincipal,source:string,target:string,sharePolicy:unknown):Promise<void>{
  if(sharePolicy==="keep")await keepImpactedShares(env,source,target);
  else await revokeImpactedShares(env,principal.id,source);
}

async function audit(env: Env, request: Request, principal: StaffPrincipal, action: string, key: string, detail?: unknown): Promise<void> {
  await env.OPS_DB.batch([await auditStatement(env, request, principal, action, "r2_object", key, null, detail)]);
}

async function createJob(env: Env, principal: StaffPrincipal, kind: "copy" | "move" | "batch", payload: unknown, sourceKey: string | null, targetKey: string | null, conflict: ConflictPolicy): Promise<string> {
  const id = crypto.randomUUID(); const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.OPS_DB.prepare(`INSERT INTO r2_operation_jobs(id,kind,requested_by,source_key,target_key,conflict_policy,payload_json,expires_at) VALUES(?,?,?,?,?,?,?,?)`)
    .bind(id, kind, principal.id, sourceKey, targetKey, conflict, JSON.stringify(payload), expires).run();
  return id;
}

async function processJob(env: Env, id: string): Promise<void> {
  const job = await env.OPS_DB.prepare("SELECT id,kind,status,requested_by,source_key,target_key,conflict_policy,payload_json,cursor,processed_items FROM r2_operation_jobs WHERE id=?").bind(id).first<any>();
  if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return;
  await env.OPS_DB.prepare("UPDATE r2_operation_jobs SET status='running',lease_until=datetime('now','+10 minutes'),updated_at=datetime('now') WHERE id=?").bind(id).run();
  try {
    if (job.kind === "batch") {
      const operations = JSON.parse(job.payload_json) as Array<{ kind: "copy" | "move"; sourceKey: string; targetKey: string; conflict: ConflictPolicy;sharePolicy?:"keep"|"revoke" }>;
      const start = Number(job.cursor || 0); const end = Math.min(operations.length, start + MAX_JOB_OBJECTS_PER_TURN);
      for (let index = start; index < end; index += 1) { const op = operations[index]!; const source = normalizeCrudKey(op.sourceKey, op.sourceKey.endsWith("/")); const target = normalizeCrudKey(op.targetKey, op.targetKey.endsWith("/")); const found = await ensureSource(env, source); if (found.folder) throw new Error("batch-folder-operation-requires-dedicated-job"); assertSafeCrudDestination(source,target,false);const result = await copyObject(env, source, target, op.conflict);if(result.target&&!result.skipped)await copyPreparedArtifacts(env,source,result.target,op.kind==="move"); if (op.kind === "move" && !result.skipped&&result.target) {await env.DATA_BUCKET.delete(source);await removeThumbnailStateForPath(env,source);if(op.sharePolicy==="keep")await keepImpactedShares(env,source,result.target);else await revokeImpactedShares(env,job.requested_by,source);} }
      if (end >= operations.length) await env.OPS_DB.prepare("UPDATE r2_operation_jobs SET status='completed',processed_items=?,total_items=?,completed_at=datetime('now'),updated_at=datetime('now'),lease_until=NULL WHERE id=? AND status='running'").bind(end, operations.length, id).run();
      else await env.OPS_DB.prepare("UPDATE r2_operation_jobs SET cursor=?,processed_items=?,total_items=?,updated_at=datetime('now'),lease_until=NULL WHERE id=? AND status='running'").bind(end, end, operations.length, id).run();
      return;
    }
    const source = normalizeCrudKey(job.source_key, true); const target = normalizeCrudKey(job.target_key, true); assertSafeCrudDestination(source,target,true);const page=await env.DATA_BUCKET.list({prefix:source,limit:MAX_JOB_OBJECTS_PER_TURN,...(job.cursor?{startAfter:String(job.cursor)}:{})});const batch=page.objects;
    for (const object of batch) { const relative = object.key.slice(source.length); const result = await copyObject(env, object.key, `${target}${relative}`, job.conflict_policy,{source,target}); if (job.kind === "move" && !result.skipped) { await env.DATA_BUCKET.delete(object.key); await removeThumbnailStateForPath(env,object.key); } }
    const processed = Number(job.processed_items || 0) + batch.length;
    if (!page.truncated) {const active=await env.OPS_DB.prepare("SELECT status FROM r2_operation_jobs WHERE id=?").bind(id).first<{status:string}>();if(active?.status!=="running")return;if(job.kind==="move"){const payload=JSON.parse(job.payload_json||"{}");if(payload.sharePolicy==="keep")await keepImpactedShares(env,source,target);else await revokeImpactedShares(env,job.requested_by,source);}await env.OPS_DB.prepare("UPDATE r2_operation_jobs SET status='completed',processed_items=?,total_items=MAX(COALESCE(total_items,0),?),completed_at=datetime('now'),updated_at=datetime('now'),lease_until=NULL WHERE id=? AND status='running'").bind(processed, processed, id).run();}
    else await env.OPS_DB.prepare("UPDATE r2_operation_jobs SET cursor=?,processed_items=?,total_items=MAX(COALESCE(total_items,0),?),updated_at=datetime('now'),lease_until=NULL WHERE id=? AND status='running'").bind(batch[batch.length - 1]!.key, processed, processed + 1, id).run();
  } catch (error) {
    await env.OPS_DB.prepare("UPDATE r2_operation_jobs SET status='failed',error_code='r2-operation-failed',error_message=?,updated_at=datetime('now'),lease_until=NULL WHERE id=?").bind((error instanceof Error ? error.message : "r2-operation-failed").slice(0, 240), id).run();
  }
}

export async function processR2OperationJobs(env: Env): Promise<void> {
  const jobs = await env.OPS_DB.prepare(`SELECT id FROM r2_operation_jobs WHERE status='queued' OR (status='running' AND (lease_until IS NULL OR datetime(lease_until)<=datetime('now'))) ORDER BY created_at LIMIT 3`).all<{ id: string }>();
  for (const job of jobs.results) await processJob(env, job.id);
}

export class R2CrudWorkflow extends WorkflowEntrypoint<Env,{jobId:string}>{
  async run(event:WorkflowEvent<{jobId:string}>,step:WorkflowStep):Promise<void>{
    for(let turn=0;turn<10_000;turn+=1){
      const status=await step.do(`r2-operation-${turn}`,{retries:{limit:3,delay:"10 seconds",backoff:"exponential"},timeout:"30 minutes"},async()=>{await processJob(this.env,event.payload.jobId);const row=await this.env.OPS_DB.prepare("SELECT status FROM r2_operation_jobs WHERE id=?").bind(event.payload.jobId).first<{status:string}>();return row?.status||"missing";});
      if(["completed","failed","cancelled","missing"].includes(status))return;
    }
    await this.env.OPS_DB.prepare("UPDATE r2_operation_jobs SET status='failed',error_code='operation_limit',error_message='Operation exceeded 10,000 durable steps',updated_at=datetime('now') WHERE id=? AND status IN ('queued','running')").bind(event.payload.jobId).run();
  }
}

async function startJob(c:any,jobId:string,instanceId=jobId):Promise<void>{try{await c.env.R2_CRUD_WORKFLOW.create({id:instanceId,params:{jobId}});}catch{c.executionCtx.waitUntil(processJob(c.env,jobId));}}

export async function purgeReplacementRecovery(env:Env):Promise<number>{const rows=await env.OPS_DB.prepare("SELECT id,recovery_key FROM r2_replacement_recovery WHERE datetime(purge_after)<=datetime('now') ORDER BY purge_after LIMIT 25").all<{id:string;recovery_key:string}>();for(const row of rows.results){await env.DATA_BUCKET.delete(row.recovery_key);await env.OPS_DB.prepare("DELETE FROM r2_replacement_recovery WHERE id=?").bind(row.id).run();}await env.OPS_DB.prepare("DELETE FROM r2_event_suppressions WHERE datetime(expires_at)<=datetime('now')").run();return rows.results.length;}

export function registerR2CrudRoutes(app: App): void {
  const requireDirectDeliveryUploads = async (c: any, next: () => Promise<void>) => {
    if (!directDeliveryUploadsCapability(c.env).enabled) {
      return c.json({
        error: DIRECT_DELIVERY_UPLOADS_DISABLED_CODE,
        message: DIRECT_DELIVERY_UPLOADS_DISABLED_MESSAGE,
      }, 503);
    }
    await next();
  };
  app.use("/api/delivery/uploads", requireDirectDeliveryUploads);
  app.use("/api/delivery/uploads/*", requireDirectDeliveryUploads);
  const guardUploadSession = async (c: any, next: () => Promise<void>) => {
    if (c.req.method === "GET") return next();
    const session = await c.env.OPS_DB.prepare("SELECT object_key,created_by,status,expires_at FROM r2_upload_sessions WHERE id=?").bind(c.req.param("id")).first() as { object_key: string; created_by: string; status: string; expires_at: string } | null;
    const principal = c.get("principal");
    if (!session || session.created_by !== principal.id || session.status !== "active" || Date.parse(session.expires_at) <= Date.now()) throw new HTTPException(404, { message: "Upload session not found or expired" });
    await requireCrudPermission(c.env, principal, UPLOAD, session.object_key);
    await next();
  };
  app.use("/api/delivery/uploads/:id", guardUploadSession);
  app.use("/api/delivery/uploads/:id/*", guardUploadSession);
  app.use("/api/delivery/fs/trash/:id/restore", async (c, next) => {
    const tombstone = await c.env.DELIVERY_DB.prepare("SELECT physical_key FROM delivery_tombstones WHERE id=? AND restored_at IS NULL").bind(c.req.param("id")).first<{ physical_key: string }>();
    if (!tombstone) throw new HTTPException(404, { message: "Trash item not found or already restored" });
    await requireCrudPermission(c.env, c.get("principal"), RESTORE, tombstone.physical_key);
    await next();
  });

  app.post("/api/delivery/fs/folders", async c => {
    const principal = c.get("principal"); const body = await jsonBody(c); const key = normalizeCrudKey(body.key, true); await requireCrudPermission(c.env, principal, CREATE, key);
    if (await c.env.DATA_BUCKET.head(key)||(await c.env.DATA_BUCKET.list({prefix:key,limit:1})).objects.length) throw new HTTPException(409, { message: "The folder already exists" });
    await c.env.DATA_BUCKET.put(`${key}_ltds/folder.json`,JSON.stringify({version:1,createdAt:new Date().toISOString(),createdBy:principal.id}),{httpMetadata:{contentType:"application/json"}}); await audit(c.env, c.req.raw, principal, "delivery.folder.created", key); return c.json({ key, id: encodeRef(key),status:"completed" }, 201);
  });

  for (const [route, kind, required] of [["copy", "copy", COPY], ["move", "move", MOVE], ["rename", "move", MOVE]] as const) app.post(`/api/delivery/fs/${route}`, async c => {
    const principal = c.get("principal"); const body = await jsonBody(c); const source = normalizeCrudKey(body.sourceKey, String(body.sourceKey || "").endsWith("/")); const target = normalizeCrudKey(body.targetKey, String(body.targetKey || "").endsWith("/")); await requireCrudPermission(c.env, principal, required, source); await requireCrudPermission(c.env, principal, required, target); const conflict = policy(body.conflict); const found = await ensureSource(c.env, source);
    const sharePolicy=body.sharePolicy==="keep"?"keep":"revoke";
    if (found.folder) {const folderSource=normalizeCrudKey(source,true),folderTarget=normalizeCrudKey(target,true);assertSafeCrudDestination(folderSource,folderTarget,true);const resolvedTarget=await targetFolderName(c.env,folderTarget,conflict);if(!resolvedTarget)return c.json({source:folderSource,target:null,skipped:true,status:"completed"});assertSafeCrudDestination(folderSource,resolvedTarget,true);const id = await createJob(c.env, principal, kind, { source:folderSource, target:resolvedTarget, sharePolicy }, folderSource, resolvedTarget, conflict);await startJob(c,id);await audit(c.env, c.req.raw, principal, `delivery.${kind}.queued`, folderSource, { target:resolvedTarget, jobId: id, sharePolicy }); return c.json({ jobId: id, status: "queued" }, 202); }
    assertSafeCrudDestination(source,target,false);
    const id=await createJob(c.env,principal,"batch",[{kind,sourceKey:source,targetKey:target,conflict,sharePolicy}],source,target,conflict);await startJob(c,id);await audit(c.env,c.req.raw,principal,`delivery.${kind}.queued`,source,{target,jobId:id,sharePolicy});return c.json({jobId:id,status:"queued"},202);
  });

  app.delete("/api/delivery/fs/items/:itemRef", async c => { const principal = c.get("principal"); const decoded = decodeRef(c.req.param("itemRef")); const folder = decoded.endsWith("/"); const key = normalizeCrudKey(decoded, folder); await requireCrudPermission(c.env, principal, permission("delivery.delete"), key); const body = await jsonBody(c).catch(() => ({})); const confirmation = body.confirmation || leaf(key); const result = await executeSourceDelete(c.env, principal, c.req.param("itemRef"), confirmation); await audit(c.env, c.req.raw, principal, "delivery.r2.delete.queued", key, result); return c.json({ deleted: result }); });

  app.post("/api/delivery/fs/batch", async c => { const principal = c.get("principal"); const body = await jsonBody(c); if (!Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > MAX_BATCH_OPERATIONS) throw new HTTPException(400, { message: `Batch operations must contain 1-${MAX_BATCH_OPERATIONS} items` }); const operations = body.operations.map((item: any) => ({ kind: item.kind === "move" ? "move" : item.kind === "copy" ? "copy" : (() => { throw new HTTPException(400, { message: "Unsupported batch operation" }); })(), sourceKey: normalizeCrudKey(item.sourceKey, false), targetKey: normalizeCrudKey(item.targetKey, false), conflict: policy(item.conflict),sharePolicy:item.sharePolicy==="keep"?"keep":"revoke" })); for (const operation of operations) { assertSafeCrudDestination(operation.sourceKey,operation.targetKey,false);await requireCrudPermission(c.env, principal, BATCH, operation.sourceKey); await requireCrudPermission(c.env, principal, BATCH, operation.targetKey); } const id = await createJob(c.env, principal, "batch", operations, null, null, "fail");await startJob(c,id);await audit(c.env, c.req.raw, principal, "delivery.batch.queued", id, { count: operations.length }); return c.json({ jobId: id, status: "queued" }, 202); });

  app.get("/api/delivery/fs/jobs/:id", async c => { const principal = c.get("principal"); await requirePermission(c.env, principal, permission("delivery.browse")); const job = await c.env.OPS_DB.prepare("SELECT id,kind,status,source_key,target_key,conflict_policy,total_items,processed_items,error_code,error_message,created_at,updated_at,completed_at FROM r2_operation_jobs WHERE id=? AND requested_by=?").bind(c.req.param("id"), principal.id).first(); if (!job) throw new HTTPException(404, { message: "Operation job not found" }); return c.json({ job }); });
  app.post("/api/delivery/fs/jobs/:id/cancel",async c=>{const principal=c.get("principal");await requirePermission(c.env,principal,BATCH);const result=await c.env.OPS_DB.prepare("UPDATE r2_operation_jobs SET status='cancelled',updated_at=datetime('now'),lease_until=NULL WHERE id=? AND requested_by=? AND status IN ('queued','running')").bind(c.req.param("id"),principal.id).run();if(result.meta.changes!==1)throw new HTTPException(409,{message:"Operation cannot be cancelled"});return c.json({success:true});});
  app.post("/api/delivery/fs/jobs/:id/retry",async c=>{const principal=c.get("principal");await requirePermission(c.env,principal,BATCH);const result=await c.env.OPS_DB.prepare("UPDATE r2_operation_jobs SET status='queued',error_code=NULL,error_message=NULL,updated_at=datetime('now'),lease_until=NULL WHERE id=? AND requested_by=? AND status='failed'").bind(c.req.param("id"),principal.id).run();if(result.meta.changes!==1)throw new HTTPException(409,{message:"Only failed operations can be retried"});await startJob(c,c.req.param("id"),`${c.req.param("id")}-${crypto.randomUUID()}`);return c.json({success:true,status:"queued"});});
  app.get("/api/delivery/fs/replacements",async c=>{const principal=c.get("principal");await requirePermission(c.env,principal,permission("delivery.delete"));const rows=await c.env.OPS_DB.prepare("SELECT id,original_key,created_at,purge_after FROM r2_replacement_recovery ORDER BY created_at DESC LIMIT 100").all();return c.json({items:rows.results});});
  app.post("/api/delivery/fs/replacements/:id/restore",async c=>{const principal=c.get("principal");await requirePermission(c.env,principal,permission("delivery.delete"));const row=await c.env.OPS_DB.prepare("SELECT id,original_key,recovery_key FROM r2_replacement_recovery WHERE id=?").bind(c.req.param("id")).first<{id:string;original_key:string;recovery_key:string}>();if(!row)throw new HTTPException(404,{message:"Replacement recovery item not found"});const object=await c.env.DATA_BUCKET.get(row.recovery_key);if(!object)throw new HTTPException(410,{message:"Replacement recovery object is unavailable"});const restored=await c.env.DATA_BUCKET.put(row.original_key,object.body,{httpMetadata:object.httpMetadata,customMetadata:object.customMetadata});if(canonicalThumbnailSourceKey(row.original_key)&&mediaKind(row.original_key)==="image")await enqueueThumbnailJob(c.env,{sourceKey:row.original_key,sourceEtag:restored.httpEtag,sourceSize:restored.size,eventTime:restored.uploaded.toISOString()});await c.env.DATA_BUCKET.delete(row.recovery_key);await c.env.OPS_DB.prepare("DELETE FROM r2_replacement_recovery WHERE id=?").bind(row.id).run();await audit(c.env,c.req.raw,principal,"delivery.replacement.restored",row.original_key,{recoveryId:row.id});return c.json({success:true});});

  app.post("/api/delivery/uploads", async c => { const principal = c.get("principal"); const body = await jsonBody(c); const key = normalizeCrudKey(body.key, false); await requireCrudPermission(c.env, principal, UPLOAD, key); const size = Number(body.size); if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_UPLOAD_SIZE) throw new HTTPException(400, { message: "Upload size must be between 1 byte and 500 GiB" }); const contentType = typeof body.contentType === "string" && body.contentType.length <= 200 ? body.contentType : "application/octet-stream"; const upload = await c.env.DATA_BUCKET.createMultipartUpload(key, { httpMetadata: { contentType } }); const id = crypto.randomUUID(); const expires = new Date(Date.now() + DEFAULT_UPLOAD_TTL_MS).toISOString(); await c.env.OPS_DB.prepare("INSERT INTO r2_upload_sessions(id,upload_id,object_key,expected_size,content_type,created_by,expires_at) VALUES(?,?,?,?,?,?,?)").bind(id, upload.uploadId, key, size, contentType, principal.id, expires).run(); await audit(c.env, c.req.raw, principal, "delivery.upload.created", key, { sessionId: id }); return c.json({ sessionId: id, key, uploadId: upload.uploadId, partSize: operationsMultipartPartSize(size), expiresAt: expires }, 201); });

  app.post("/api/delivery/uploads/:id/parts/:partNumber/ticket", async c => {const principal=c.get("principal");await requirePermission(c.env,principal,UPLOAD);const partNumber=Number(c.req.param("partNumber"));if(!Number.isSafeInteger(partNumber)||partNumber<1||partNumber>10_000)throw new HTTPException(400,{message:"A valid upload part is required"});const session=await c.env.OPS_DB.prepare("SELECT upload_id,object_key FROM r2_upload_sessions WHERE id=? AND created_by=? AND status='active' AND datetime(expires_at)>datetime('now')").bind(c.req.param("id"),principal.id).first<{upload_id:string;object_key:string}>();if(!session)throw new HTTPException(404,{message:"Upload session not found or expired"});if(!c.env.R2_ACCESS_KEY_ID||!c.env.R2_SECRET_ACCESS_KEY)throw new HTTPException(503,{message:"Direct R2 uploads are not configured"});const url=await presignOperationsR2Part({accountId:c.env.R2_ACCOUNT_ID,bucket:c.env.R2_BUCKET_NAME,key:session.object_key,uploadId:session.upload_id,partNumber,accessKeyId:c.env.R2_ACCESS_KEY_ID,secretAccessKey:c.env.R2_SECRET_ACCESS_KEY,expiresSeconds:300});return c.json({url,expiresIn:300});});

  app.put("/api/delivery/uploads/:id/parts/:partNumber", async c => { const principal = c.get("principal"); await requirePermission(c.env, principal, UPLOAD); const partNumber = Number(c.req.param("partNumber")); if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000 || !c.req.raw.body) throw new HTTPException(400, { message: "A valid upload part is required" }); const session = await c.env.OPS_DB.prepare("SELECT id,upload_id,object_key,status,expires_at FROM r2_upload_sessions WHERE id=? AND created_by=?").bind(c.req.param("id"), principal.id).first<any>(); if (!session || session.status !== "active" || Date.parse(session.expires_at) <= Date.now()) throw new HTTPException(404, { message: "Upload session not found or expired" }); const multipart = c.env.DATA_BUCKET.resumeMultipartUpload(session.object_key, session.upload_id); const result = await multipart.uploadPart(partNumber, c.req.raw.body); const length = Number(c.req.header("Content-Length") || 0); await c.env.OPS_DB.prepare("INSERT INTO r2_upload_parts(session_id,part_number,etag,size) VALUES(?,?,?,?) ON CONFLICT(session_id,part_number) DO UPDATE SET etag=excluded.etag,size=excluded.size,uploaded_at=datetime('now')").bind(session.id, partNumber, result.etag, length).run(); return c.json({ partNumber: result.partNumber, etag: result.etag, size: length }); });

  app.post("/api/delivery/uploads/:id/complete", async c => { const principal = c.get("principal"); await requirePermission(c.env, principal, UPLOAD); const session = await c.env.OPS_DB.prepare("SELECT id,upload_id,object_key,status,expected_size,expires_at FROM r2_upload_sessions WHERE id=? AND created_by=?").bind(c.req.param("id"), principal.id).first<any>(); if (!session || session.status !== "active" || Date.parse(session.expires_at) <= Date.now()) throw new HTTPException(404, { message: "Upload session not found or expired" }); const body = await jsonBody(c); if (!Array.isArray(body.parts) || !body.parts.length) throw new HTTPException(400, { message: "Upload parts are required" }); const parts = body.parts.map((part: any) => ({ partNumber: Number(part.partNumber), etag: String(part.etag) })).sort((a: any, b: any) => a.partNumber - b.partNumber); if (parts.some((part: any, index: number) => !Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || (index > 0 && parts[index - 1]!.partNumber === part.partNumber) || !/^"?[A-Za-z0-9+/=_-]+"?$/.test(part.etag))) throw new HTTPException(400, { message: "Invalid upload parts" }); const stored = await c.env.OPS_DB.prepare("SELECT part_number,etag,size FROM r2_upload_parts WHERE session_id=? ORDER BY part_number").bind(session.id).all<{part_number:number;etag:string;size:number}>(); if (stored.results.length&&(stored.results.length !== parts.length || parts.some((part: any, i: number) => part.partNumber !== stored.results[i]!.part_number || part.etag !== stored.results[i]!.etag))) throw new HTTPException(409, { message: "Upload parts do not match the session" }); const upload = c.env.DATA_BUCKET.resumeMultipartUpload(session.object_key, session.upload_id); const object=await upload.complete(parts); if(object.size!==session.expected_size){await c.env.DATA_BUCKET.delete(session.object_key);await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET status='aborted' WHERE id=? AND status='active'").bind(session.id).run();throw new HTTPException(422,{message:"Uploaded bytes do not match the declared size"});} await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET status='completed',completed_at=datetime('now') WHERE id=? AND status='active'").bind(session.id).run();if(canonicalThumbnailSourceKey(session.object_key)&&mediaKind(session.object_key)==="image")await enqueueThumbnailJob(c.env,{sourceKey:session.object_key,sourceEtag:object.httpEtag,sourceSize:object.size,eventTime:object.uploaded.toISOString()}); await audit(c.env, c.req.raw, principal, "delivery.upload.completed", session.object_key, { sessionId: session.id, size: object.size }); return c.json({ sessionId: session.id, key: session.object_key, size: object.size }); });

  app.delete("/api/delivery/uploads/:id", async c => { const principal = c.get("principal"); await requirePermission(c.env, principal, UPLOAD); const session = await c.env.OPS_DB.prepare("SELECT id,upload_id,object_key,status FROM r2_upload_sessions WHERE id=? AND created_by=?").bind(c.req.param("id"), principal.id).first<any>(); if (!session || session.status !== "active") throw new HTTPException(404, { message: "Upload session not found" }); await c.env.DATA_BUCKET.resumeMultipartUpload(session.object_key, session.upload_id).abort(); await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET status='aborted' WHERE id=? AND status='active'").bind(session.id).run(); await audit(c.env, c.req.raw, principal, "delivery.upload.aborted", session.object_key, { sessionId: session.id }); return c.json({ success: true }); });

  app.get("/api/delivery/uploads/:id", async c => { const principal = c.get("principal"); await requirePermission(c.env, principal, permission("delivery.browse")); const session = await c.env.OPS_DB.prepare("SELECT id,object_key,expected_size,content_type,status,created_at,expires_at,completed_at FROM r2_upload_sessions WHERE id=? AND created_by=?").bind(c.req.param("id"), principal.id).first<any>(); if (!session) throw new HTTPException(404, { message: "Upload session not found" }); const parts = await c.env.OPS_DB.prepare("SELECT part_number,etag,size,uploaded_at FROM r2_upload_parts WHERE session_id=? ORDER BY part_number").bind(session.id).all(); return c.json({ session, parts: parts.results }); });

  app.post("/api/delivery/fs/trash/:id/restore", async c => { const principal = c.get("principal"); await requirePermission(c.env, principal, RESTORE); await restoreTombstone(c.env, principal, c.req.param("id")); return c.json({ success: true }); });
}
