import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import { requirePermission } from "./acl";
import { decodeRef, encodeRef, mediaKind, mime } from "./delivery";
import { auditStatement, requireMutationSecurity } from "./request-security";
import { executeSourceDelete } from "./source-delete";
import { restoreTombstone } from "./trash";
import type { Env, StaffPrincipal } from "./types";
import type { Permission } from "@ltds/shared";
import { canonicalThumbnailSourceKey, enqueueThumbnailJob, removeThumbnailStateForPath, supportedThumbnailSource } from "./image-thumbnails";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  MAX_BROWSER_UPLOAD_BYTES,
  MAX_BROWSER_UPLOAD_FILE_BYTES,
  MAX_BROWSER_UPLOAD_FILES,
  assertSafeCrudDestination,
  browserUploadContentType,
  browserUploadObjectKey,
  normalizeCrudKey,
  operationsMultipartPartSize,
} from "./r2-crud-validation";
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
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_UPLOAD_SESSIONS = 10;
const MAX_UPLOAD_CLEANUP_ATTEMPTS = 8;

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

async function copyObject(env: Env, source: string, target: string, conflict: ConflictPolicy,roots?:{source:string;target:string},allowRecovery=true): Promise<{ target: string | null; skipped: boolean }> {
  const sourceHead = await env.DATA_BUCKET.head(source); if (!sourceHead) throw new Error("source-disappeared");
  const resolved = await targetName(env, target, conflict); if (!resolved) return { target: null, skipped: true };
  const indexed=await env.DELIVERY_DB.prepare("SELECT content_type,media_kind,stream_uid,stream_status,stream_error FROM file_index WHERE r2_key=?").bind(source).first<{content_type:string|null;media_kind:string;stream_uid:string|null;stream_status:string|null;stream_error:string|null}>();
  if(indexed&&indexed.media_kind!=="image")await env.OPS_DB.prepare("INSERT INTO r2_event_suppressions(object_key,event_kind,expires_at) VALUES(?,'create',datetime('now','+1 hour')) ON CONFLICT(object_key) DO UPDATE SET expires_at=excluded.expires_at").bind(resolved).run();
  const sourceObject = await env.DATA_BUCKET.get(source); if (!sourceObject) throw new Error("source-disappeared");
  let recovery: { id: string; key: string } | null = null;
  let replacementBaseline: string | null = null;
  if (conflict === "replace") {
    const existing = await env.DATA_BUCKET.get(resolved);
    replacementBaseline = existing?.httpEtag || null;
    if (existing && allowRecovery) {
      const id = crypto.randomUUID();
      const recoveryKey = `Jobs/Clients/_ltds/replacements/${id}/${leaf(resolved)}`;
      await env.DATA_BUCKET.put(recoveryKey, existing.body, { httpMetadata: existing.httpMetadata, customMetadata: existing.customMetadata });
      try {
        await env.OPS_DB.prepare("INSERT INTO r2_replacement_recovery(id,original_key,recovery_key,purge_after) VALUES(?,?,?,datetime('now','+7 days'))")
          .bind(id, resolved, recoveryKey).run();
        recovery = { id, key: recoveryKey };
      } catch (error) {
        await env.DATA_BUCKET.delete(recoveryKey);
        throw error;
      }
    }
  }
  const destinationMetadata = { ...(sourceObject.customMetadata || {}), ...(recovery ? { replacementRecoveryId: recovery.id } : {}) };
  const replacementCondition = conflict === "replace"
    ? new Headers(replacementBaseline ? { "If-Match": replacementBaseline } : { "If-None-Match": "*" })
    : undefined;
  let written:R2Object|null = null;
  try {
    if(roots&&source.endsWith("/manifest.json")&&source.includes("/.previews/")){const bytes=await sourceObject.arrayBuffer(),manifest=(()=>{try{return JSON.parse(new TextDecoder().decode(bytes))}catch{return null}})();if(manifest&&typeof manifest.sourceKey==="string"&&manifest.sourceKey.startsWith(roots.source)){manifest.sourceKey=`${roots.target}${manifest.sourceKey.slice(roots.source.length)}`;written=await env.DATA_BUCKET.put(resolved,JSON.stringify(manifest),{onlyIf:replacementCondition,httpMetadata:{...sourceObject.httpMetadata,contentType:"application/json"},customMetadata:destinationMetadata});}else written=await env.DATA_BUCKET.put(resolved,bytes,{onlyIf:replacementCondition,httpMetadata:sourceObject.httpMetadata,customMetadata:destinationMetadata});}
    else written=await env.DATA_BUCKET.put(resolved, sourceObject.body, { onlyIf: replacementCondition, httpMetadata: sourceObject.httpMetadata, customMetadata: destinationMetadata });
    if (!written) throw new HTTPException(409, { message: "The replacement destination changed before publication" });
    if (recovery) await env.OPS_DB.prepare("UPDATE r2_replacement_recovery SET replacement_result_etag=? WHERE id=?")
      .bind(written.httpEtag, recovery.id).run();
  } catch (error) {
    if (recovery && !written) {
      await env.DATA_BUCKET.delete(recovery.key);
      await env.OPS_DB.prepare("DELETE FROM r2_replacement_recovery WHERE id=?").bind(recovery.id).run();
    }
    throw error;
  }
  if (!written) throw new Error("replacement-write-missing");
  if(indexed)await env.DELIVERY_DB.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind,stream_uid,stream_status,stream_error)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,size=excluded.size,uploaded_at=excluded.uploaded_at,content_type=excluded.content_type,media_kind=excluded.media_kind,stream_uid=excluded.stream_uid,stream_status=excluded.stream_status,stream_error=excluded.stream_error,updated_at=datetime('now')`)
    .bind(resolved,written.httpEtag,written.size,written.uploaded.toISOString(),indexed.content_type,indexed.media_kind,indexed.stream_uid,indexed.stream_status,indexed.stream_error).run();
  if(indexed?.media_kind==="image"&&mediaKind(resolved)==="image"){
    try{await enqueueThumbnailJob(env,{sourceKey:resolved,sourceEtag:written.httpEtag,sourceSize:written.size});}
    catch(error){console.error(JSON.stringify({event:"thumbnail.copy-enqueue-failed",key:resolved,error:error instanceof Error?error.message:"unknown"}));}
  }
  return { target: resolved, skipped: false };
}

async function copyPreparedArtifacts(env:Env,source:string,target:string,move:boolean):Promise<void>{const sourcePrefix=await artifactDirectory(source),targetPrefix=await artifactDirectory(target);let cursor:string|undefined;do{const page=await env.DATA_BUCKET.list({prefix:sourcePrefix,limit:100,cursor});for(const object of page.objects){const destination=`${targetPrefix}${object.key.slice(sourcePrefix.length)}`;await copyObject(env,object.key,destination,"replace",{source,target},false);if(move)await env.DATA_BUCKET.delete(object.key);}cursor=page.truncated?page.cursor:undefined;}while(cursor);}

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

type BrowserUploadCollisionPolicy = "fail" | "rename" | "replace";
interface BrowserUploadIntentFile {
  ordinal: number;
  relativePath: string;
  key: string;
  size: number;
  contentType: string;
}
interface BrowserUploadSessionRow {
  id: string;
  upload_id: string;
  object_key: string;
  staging_key: string;
  expected_size: number;
  content_type: string;
  part_size: number;
  status: "active" | "completing" | "completed" | "aborted" | "expired";
  created_by: string;
  expires_at: string;
  intent_id: string;
  intent_ordinal: number;
  conflict_policy: BrowserUploadCollisionPolicy;
  result_key: string | null;
  result_etag: string | null;
  completion_claimed_at: string | null;
  destination_baseline: string;
  replacement_recovery_id: string | null;
  cleanup_status: "not_due" | "pending" | "complete" | "failed";
  cleanup_attempts: number;
  cleanup_error: string | null;
}

function browserCollisionPolicy(value: unknown): BrowserUploadCollisionPolicy {
  if (value === undefined || value === "fail") return "fail";
  if (value === "rename" || value === "replace") return value;
  throw new HTTPException(400, { message: "Upload collision policy is invalid" });
}

async function browserUploadFingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function browserIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key") || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new HTTPException(400, { message: "A valid Idempotency-Key is required" });
  return value;
}

function sessionResponse(session: BrowserUploadSessionRow, parts: Array<{part_number:number;etag:string;size:number}> = []) {
  return {
    sessionId: session.id,
    key: session.result_key || session.object_key,
    partSize: session.part_size,
    expiresAt: session.expires_at,
    status: session.status,
    etag: session.result_etag,
    cleanupStatus: session.cleanup_status,
    cleanupAttempts: session.cleanup_attempts,
    cleanupError: session.cleanup_error,
    parts: parts.map((part) => ({ partNumber: part.part_number, etag: part.etag, size: part.size })),
  };
}

async function uploadSession(env: Env, sessionId: string, principalId: string): Promise<BrowserUploadSessionRow | null> {
  return env.OPS_DB.prepare(`SELECT id,upload_id,object_key,staging_key,expected_size,content_type,part_size,status,
    created_by,expires_at,intent_id,intent_ordinal,conflict_policy,result_key,result_etag,completion_claimed_at,
    destination_baseline,replacement_recovery_id,cleanup_status,cleanup_attempts,cleanup_error
    FROM r2_upload_sessions WHERE id=? AND created_by=?`).bind(sessionId, principalId).first<BrowserUploadSessionRow>();
}

async function refreshFileIndexAndThumbnail(env: Env, object: R2Object, contentType: string): Promise<void> {
  await env.DELIVERY_DB.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
    VALUES(?,?,?,?,?,?) ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,size=excluded.size,
    uploaded_at=excluded.uploaded_at,content_type=excluded.content_type,media_kind=excluded.media_kind,
    stream_uid=NULL,stream_status=CASE WHEN excluded.media_kind='video' THEN 'disabled' ELSE NULL END,
    stream_upload_url=NULL,stream_upload_offset=0,stream_error=NULL,updated_at=datetime('now')`)
    .bind(object.key, object.httpEtag, object.size, object.uploaded.toISOString(), contentType, mediaKind(object.key)).run();
  if (canonicalThumbnailSourceKey(object.key) && supportedThumbnailSource(object.key, contentType)) {
    await enqueueThumbnailJob(env, {
      sourceKey: object.key,
      sourceEtag: object.httpEtag,
      sourceSize: object.size,
      eventTime: object.uploaded.toISOString(),
    });
  } else if (canonicalThumbnailSourceKey(object.key)) {
    await removeThumbnailStateForPath(env, object.key);
  }
}

async function finalizeBrowserUpload(
  env: Env,
  session: BrowserUploadSessionRow,
  object: R2Object,
): Promise<void> {
  await refreshFileIndexAndThumbnail(env, object, session.content_type);
  const completed = await env.OPS_DB.prepare(`UPDATE r2_upload_sessions SET status='completed',result_key=?,result_etag=?,
    completed_at=COALESCE(completed_at,datetime('now')),completion_claimed_at=NULL,
    cleanup_status='pending',cleanup_next_attempt_at=datetime('now'),cleanup_claimed_at=NULL,cleanup_error=NULL
    WHERE id=? AND status='completing'`)
    .bind(object.key, object.httpEtag, session.id).run();
  if (completed.meta.changes !== 1) throw new HTTPException(409, { message: "Upload completion no longer owns the session" });
  await env.OPS_DB.batch([
    env.OPS_DB.prepare(`UPDATE browser_upload_intent_files SET status='completed',result_key=?,result_etag=?,
      error_code=NULL,updated_at=datetime('now') WHERE intent_id=? AND ordinal=?`)
      .bind(object.key, object.httpEtag, session.intent_id, session.intent_ordinal),
  ]);
  await env.OPS_DB.prepare(`UPDATE browser_upload_intents SET status='completed',completed_at=datetime('now'),updated_at=datetime('now')
    WHERE id=? AND status='active' AND NOT EXISTS (
      SELECT 1 FROM browser_upload_intent_files WHERE intent_id=? AND status<>'completed'
    )`).bind(session.intent_id, session.intent_id).run();
}

interface BrowserUploadCleanupRow {
  id: string;
  upload_id: string;
  staging_key: string | null;
  cleanup_attempts: number;
}

function knownTerminalMultipartError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as {code:unknown}).code) : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "NoSuchUpload" || /no such upload|unknown multipart upload|already (?:completed|aborted)|not found/i.test(message);
}

function cleanupErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown upload cleanup error").replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

export async function cleanupBrowserUploadSessions(env: Env, limit = 25, onlySessionId?: string): Promise<number> {
  const boundedLimit = Math.max(1, Math.min(100, limit));
  const rows = onlySessionId
    ? await env.OPS_DB.prepare(`SELECT id FROM r2_upload_sessions WHERE id=? AND status IN ('completed','aborted','expired')
        AND cleanup_status='pending' AND cleanup_attempts<? AND datetime(COALESCE(cleanup_next_attempt_at,'1970-01-01'))<=datetime('now')
        AND (cleanup_claimed_at IS NULL OR datetime(cleanup_claimed_at)<=datetime('now','-5 minutes')) LIMIT 1`)
      .bind(onlySessionId, MAX_UPLOAD_CLEANUP_ATTEMPTS).all<{id:string}>()
    : await env.OPS_DB.prepare(`SELECT id FROM r2_upload_sessions WHERE status IN ('completed','aborted','expired')
        AND cleanup_status='pending' AND cleanup_attempts<? AND datetime(COALESCE(cleanup_next_attempt_at,'1970-01-01'))<=datetime('now')
        AND (cleanup_claimed_at IS NULL OR datetime(cleanup_claimed_at)<=datetime('now','-5 minutes'))
        ORDER BY cleanup_next_attempt_at,id LIMIT ?`)
      .bind(MAX_UPLOAD_CLEANUP_ATTEMPTS, boundedLimit).all<{id:string}>();
  let cleaned = 0;
  for (const candidate of rows.results) {
    const claimed = await env.OPS_DB.prepare(`UPDATE r2_upload_sessions SET cleanup_claimed_at=datetime('now'),
      cleanup_attempts=cleanup_attempts+1 WHERE id=? AND status IN ('completed','aborted','expired')
      AND cleanup_status='pending' AND cleanup_attempts<?
      AND datetime(COALESCE(cleanup_next_attempt_at,'1970-01-01'))<=datetime('now')
      AND (cleanup_claimed_at IS NULL OR datetime(cleanup_claimed_at)<=datetime('now','-5 minutes'))`)
      .bind(candidate.id, MAX_UPLOAD_CLEANUP_ATTEMPTS).run();
    if (claimed.meta.changes !== 1) continue;
    const row = await env.OPS_DB.prepare("SELECT id,upload_id,staging_key,cleanup_attempts FROM r2_upload_sessions WHERE id=?")
      .bind(candidate.id).first<BrowserUploadCleanupRow>();
    if (!row) continue;
    try {
      if (row.staging_key) {
        try {
          await env.DATA_BUCKET.resumeMultipartUpload(row.staging_key, row.upload_id).abort();
        } catch (error) {
          if (!knownTerminalMultipartError(error)) throw error;
        }
        await env.DATA_BUCKET.delete(row.staging_key);
        if (await env.DATA_BUCKET.head(row.staging_key)) throw new Error("Upload staging object remained after cleanup");
      }
      await env.OPS_DB.prepare(`UPDATE r2_upload_sessions SET cleanup_status='complete',cleanup_next_attempt_at=NULL,
        cleanup_claimed_at=NULL,cleanup_error=NULL WHERE id=?`).bind(row.id).run();
      cleaned += 1;
    } catch (error) {
      const terminal = row.cleanup_attempts >= MAX_UPLOAD_CLEANUP_ATTEMPTS;
      const delayMinutes = Math.min(60, Math.max(1, row.cleanup_attempts * 5));
      await env.OPS_DB.prepare(`UPDATE r2_upload_sessions SET cleanup_status=?,
        cleanup_next_attempt_at=CASE WHEN ? THEN NULL ELSE datetime('now','+' || ? || ' minutes') END,
        cleanup_claimed_at=NULL,cleanup_error=? WHERE id=?`)
        .bind(terminal ? "failed" : "pending", terminal ? 1 : 0, delayMinutes, cleanupErrorMessage(error), row.id).run();
    }
  }
  return cleaned;
}

export async function expireBrowserUploadSessions(env: Env, limit = 25): Promise<number> {
  const rows = await env.OPS_DB.prepare(`SELECT id,upload_id,object_key,staging_key,intent_id,intent_ordinal FROM r2_upload_sessions
    WHERE datetime(expires_at)<=datetime('now') AND (
      status='active' OR (status='completing' AND datetime(completion_claimed_at)<=datetime('now','-5 minutes'))
    ) ORDER BY expires_at LIMIT ?`)
    .bind(Math.max(1, Math.min(100, limit))).all<{id:string;upload_id:string;object_key:string;staging_key:string|null;intent_id:string|null;intent_ordinal:number|null}>();
  let expired = 0;
  for (const row of rows.results) {
    const changed = await env.OPS_DB.prepare(`UPDATE r2_upload_sessions SET status='expired',completion_claimed_at=NULL,
      cleanup_status='pending',cleanup_next_attempt_at=datetime('now'),cleanup_claimed_at=NULL,cleanup_error=NULL WHERE id=?
      AND datetime(expires_at)<=datetime('now') AND (
        status='active' OR (status='completing' AND datetime(completion_claimed_at)<=datetime('now','-5 minutes'))
      )`).bind(row.id).run();
    if (!changed.meta.changes) continue;
    if (row.intent_id !== null && row.intent_ordinal !== null) {
      await env.OPS_DB.prepare("UPDATE browser_upload_intent_files SET status='aborted',error_code='expired',updated_at=datetime('now') WHERE intent_id=? AND ordinal=? AND status<>'completed'")
        .bind(row.intent_id, row.intent_ordinal).run();
    }
    await cleanupBrowserUploadSessions(env, 1, row.id);
    expired += 1;
  }
  await env.OPS_DB.prepare("UPDATE browser_upload_intents SET status='expired',updated_at=datetime('now') WHERE status='active' AND datetime(expires_at)<=datetime('now')").run();
  return expired;
}

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
  app.get("/api/delivery/fs/replacements", async c => {
    const principal = c.get("principal");
    if (c.get("administrator")) await requirePermission(c.env, principal, permission("delivery.delete"));
    const rows = await c.env.OPS_DB.prepare(`SELECT id,original_key,created_at,purge_after
      FROM r2_replacement_recovery ORDER BY created_at DESC LIMIT 500`)
      .all<{id:string;original_key:string;created_at:string;purge_after:string}>();
    if (c.get("administrator")) return c.json({ items: rows.results.slice(0, 100) });
    const visible: typeof rows.results = [];
    for (const row of rows.results) {
      try {
        await requireCrudPermission(c.env, principal, permission("delivery.delete"), row.original_key);
        visible.push(row);
        if (visible.length >= 100) break;
      } catch (error) {
        if (!(error instanceof HTTPException) || (error.status !== 403 && error.status !== 404)) throw error;
      }
    }
    return c.json({ items: visible });
  });
  app.post("/api/delivery/fs/replacements/:id/restore", async c => {
    const principal = c.get("principal");
    const row = await c.env.OPS_DB.prepare(`SELECT id,original_key,recovery_key,replacement_result_etag
      FROM r2_replacement_recovery WHERE id=?`).bind(c.req.param("id"))
      .first<{id:string;original_key:string;recovery_key:string;replacement_result_etag:string|null}>();
    if (!row) throw new HTTPException(404, { message: "Replacement recovery item not found" });
    await requireCrudPermission(c.env, principal, RESTORE, row.original_key);
    let current = await c.env.DATA_BUCKET.head(row.original_key);
    const alreadyRestored = current?.customMetadata?.replacementRecoveryRestore === row.id;
    if (!row.replacement_result_etag && current?.customMetadata?.replacementRecoveryId === row.id) {
      row.replacement_result_etag = current.httpEtag;
      await c.env.OPS_DB.prepare("UPDATE r2_replacement_recovery SET replacement_result_etag=? WHERE id=? AND replacement_result_etag IS NULL")
        .bind(current.httpEtag, row.id).run();
    }
    let restored: R2Object;
    if (alreadyRestored && current) {
      restored = current;
    } else {
      if (!row.replacement_result_etag || !current || current.httpEtag !== row.replacement_result_etag) {
        throw new HTTPException(409, { message: "The replacement destination changed; recovery was preserved" });
      }
      const object = await c.env.DATA_BUCKET.get(row.recovery_key);
      if (!object) throw new HTTPException(410, { message: "Replacement recovery object is unavailable" });
      const condition = new Headers({ "If-Match": row.replacement_result_etag });
      const published = await c.env.DATA_BUCKET.put(row.original_key, object.body, {
        onlyIf: condition,
        httpMetadata: object.httpMetadata,
        customMetadata: { ...(object.customMetadata || {}), replacementRecoveryRestore: row.id },
      });
      if (!published) throw new HTTPException(409, { message: "The replacement destination changed; recovery was preserved" });
      restored = published;
      current = published;
    }
    const contentType = restored.httpMetadata?.contentType || mime(row.original_key);
    await refreshFileIndexAndThumbnail(c.env, restored, contentType);
    await c.env.DATA_BUCKET.delete(row.recovery_key);
    await c.env.OPS_DB.prepare("DELETE FROM r2_replacement_recovery WHERE id=?").bind(row.id).run();
    await audit(c.env, c.req.raw, principal, "delivery.replacement.restored", row.original_key, { recoveryId: row.id });
    return c.json({ success: true, etag: current.httpEtag });
  });

  app.post("/api/delivery/uploads/intents", async c => {
    const principal = c.get("principal");
    const idempotencyKey = browserIdempotencyKey(c.req.raw);
    const body = await jsonBody(c);
    const collisionPolicy = browserCollisionPolicy(body.collisionPolicy);
    if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > MAX_BROWSER_UPLOAD_FILES) {
      throw new HTTPException(400, { message: `Upload intents require 1-${MAX_BROWSER_UPLOAD_FILES} files` });
    }
    const normalized: BrowserUploadIntentFile[] = body.files.map((file: any, ordinal: number) => {
      const path = browserUploadObjectKey(body.rootPrefix, file?.relativePath);
      const size = Number(file?.size);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BROWSER_UPLOAD_FILE_BYTES) {
        throw new HTTPException(400, { message: "Upload file size is invalid" });
      }
      return { ordinal, relativePath: path.relative, key: path.key, size, contentType: browserUploadContentType(file?.contentType) };
    });
    if (new Set(normalized.map((file) => file.relativePath)).size !== normalized.length) {
      throw new HTTPException(400, { message: "Upload relative paths must be unique" });
    }
    const totalBytes = normalized.reduce((sum, file) => sum + file.size, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BROWSER_UPLOAD_BYTES) {
      throw new HTTPException(400, { message: "Upload batch size is too large" });
    }
    const root = browserUploadObjectKey(body.rootPrefix, normalized[0]!.relativePath).root;
    await requireCrudPermission(c.env, principal, UPLOAD, root);
    for (const file of normalized) await requireCrudPermission(c.env, principal, UPLOAD, file.key);
    const fingerprint = await browserUploadFingerprint({ root, collisionPolicy, files: normalized.map(({ relativePath, size, contentType }) => ({ relativePath, size, contentType })) });
    const existing = await c.env.OPS_DB.prepare("SELECT id,request_fingerprint,status,expires_at FROM browser_upload_intents WHERE created_by=? AND idempotency_key=?")
      .bind(principal.id, idempotencyKey).first<{id:string;request_fingerprint:string;status:string;expires_at:string}>();
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new HTTPException(409, { message: "Idempotency-Key was already used for a different upload" });
      return c.json({ intentId: existing.id, status: existing.status, expiresAt: existing.expires_at, fileCount: normalized.length, totalBytes });
    }
    const id = crypto.randomUUID();
    const expires = new Date(Date.now() + DEFAULT_UPLOAD_TTL_MS).toISOString();
    try {
      await c.env.OPS_DB.batch([
        c.env.OPS_DB.prepare(`INSERT INTO browser_upload_intents
          (id,created_by,idempotency_key,request_fingerprint,root_prefix,collision_policy,file_count,total_bytes,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).bind(id, principal.id, idempotencyKey, fingerprint, root, collisionPolicy, normalized.length, totalBytes, expires),
        ...normalized.map((file) => c.env.OPS_DB.prepare(`INSERT INTO browser_upload_intent_files
          (intent_id,ordinal,relative_path,object_key,expected_size,content_type) VALUES(?,?,?,?,?,?)`)
          .bind(id, file.ordinal, file.relativePath, file.key, file.size, file.contentType)),
      ]);
    } catch (error) {
      const replay = await c.env.OPS_DB.prepare("SELECT id,request_fingerprint,status,expires_at FROM browser_upload_intents WHERE created_by=? AND idempotency_key=?")
        .bind(principal.id, idempotencyKey).first<{id:string;request_fingerprint:string;status:string;expires_at:string}>();
      if (!replay) throw error;
      if (replay.request_fingerprint !== fingerprint) throw new HTTPException(409, { message: "Idempotency-Key was already used for a different upload" });
      return c.json({ intentId: replay.id, status: replay.status, expiresAt: replay.expires_at, fileCount: normalized.length, totalBytes });
    }
    await audit(c.env, c.req.raw, principal, "delivery.upload.intent.created", id, { fileCount: normalized.length, totalBytes, collisionPolicy });
    return c.json({ intentId: id, status: "active", expiresAt: expires, fileCount: normalized.length, totalBytes }, 201);
  });

  app.post("/api/delivery/uploads", async c => {
    const principal = c.get("principal");
    const body = await jsonBody(c);
    const ordinal = Number(body.ordinal);
    if (typeof body.intentId !== "string" || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= MAX_BROWSER_UPLOAD_FILES) {
      throw new HTTPException(400, { message: "A valid upload intent item is required" });
    }
    const file = await c.env.OPS_DB.prepare(`SELECT i.id intent_id,i.collision_policy,i.expires_at,i.status intent_status,
      f.ordinal,f.object_key,f.expected_size,f.content_type,f.session_id
      FROM browser_upload_intents i JOIN browser_upload_intent_files f ON f.intent_id=i.id
      WHERE i.id=? AND i.created_by=? AND f.ordinal=?`).bind(body.intentId, principal.id, ordinal)
      .first<{intent_id:string;collision_policy:BrowserUploadCollisionPolicy;expires_at:string;intent_status:string;ordinal:number;object_key:string;expected_size:number;content_type:string;session_id:string|null}>();
    if (!file || file.intent_status !== "active" || Date.parse(file.expires_at) <= Date.now()) throw new HTTPException(404, { message: "Upload intent not found or expired" });
    await requireCrudPermission(c.env, principal, UPLOAD, file.object_key);
    if (file.session_id) {
      const existing = await uploadSession(c.env, file.session_id, principal.id);
      if (existing) return c.json(sessionResponse(existing));
    }
    let target = file.object_key;
    if (file.collision_policy === "fail" && await c.env.DATA_BUCKET.head(target)) throw new HTTPException(409, { message: "The upload destination already exists" });
    if (file.collision_policy === "rename") target = (await targetName(c.env, target, "rename"))!;
    const destinationAtOpen = file.collision_policy === "replace" ? await c.env.DATA_BUCKET.head(target) : null;
    const destinationBaseline = file.collision_policy === "replace"
      ? destinationAtOpen ? `etag:${destinationAtOpen.httpEtag}` : "absent"
      : "unknown";
    const id = crypto.randomUUID();
    const stagingKey = `_ltds/browser-uploads/${file.intent_id}/${id}`;
    const partSize = operationsMultipartPartSize(file.expected_size);
    const upload = await c.env.DATA_BUCKET.createMultipartUpload(stagingKey, {
      httpMetadata: { contentType: file.content_type },
      customMetadata: { browserUploadSession: id },
    });
    try {
      const created = await c.env.OPS_DB.batch([
        c.env.OPS_DB.prepare(`INSERT INTO r2_upload_sessions
          (id,upload_id,object_key,expected_size,content_type,created_by,expires_at,intent_id,intent_ordinal,staging_key,part_size,conflict_policy,destination_baseline)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
          WHERE (SELECT COUNT(*) FROM r2_upload_sessions
            WHERE created_by=? AND status IN ('active','completing') AND datetime(expires_at)>datetime('now')) < ?`)
          .bind(id, upload.uploadId, target, file.expected_size, file.content_type,
            principal.id, file.expires_at, file.intent_id, file.ordinal, stagingKey, partSize, file.collision_policy,
            destinationBaseline, principal.id, MAX_ACTIVE_UPLOAD_SESSIONS),
        c.env.OPS_DB.prepare(`UPDATE browser_upload_intent_files SET status='uploading',session_id=?,updated_at=datetime('now')
          WHERE intent_id=? AND ordinal=? AND session_id IS NULL
            AND EXISTS (SELECT 1 FROM r2_upload_sessions WHERE id=? AND created_by=? AND status='active')`)
          .bind(id, file.intent_id, file.ordinal, id, principal.id),
      ]);
      if (created[0]?.meta.changes !== 1) {
        await upload.abort();
        throw new HTTPException(429, { message: "Too many active upload sessions" });
      }
      if (created[1]?.meta.changes !== 1) {
        await c.env.OPS_DB.prepare("DELETE FROM r2_upload_sessions WHERE id=? AND status='active'").bind(id).run();
        await upload.abort();
        const replay = await c.env.OPS_DB.prepare("SELECT session_id FROM browser_upload_intent_files WHERE intent_id=? AND ordinal=?")
          .bind(file.intent_id, file.ordinal).first<{session_id:string|null}>();
        if (replay?.session_id) {
          const existing = await uploadSession(c.env, replay.session_id, principal.id);
          if (existing) return c.json(sessionResponse(existing));
        }
        throw new HTTPException(409, { message: "Upload intent item is already associated with another session" });
      }
    } catch (error) {
      if (!(error instanceof HTTPException && error.status === 429)) await upload.abort();
      const replay = await c.env.OPS_DB.prepare("SELECT session_id FROM browser_upload_intent_files WHERE intent_id=? AND ordinal=?")
        .bind(file.intent_id, file.ordinal).first<{session_id:string|null}>();
      if (replay?.session_id) {
        const existing = await uploadSession(c.env, replay.session_id, principal.id);
        if (existing) return c.json(sessionResponse(existing));
      }
      throw error;
    }
    const session = await uploadSession(c.env, id, principal.id);
    await audit(c.env, c.req.raw, principal, "delivery.upload.created", target, { sessionId: id, intentId: file.intent_id, ordinal });
    return c.json(sessionResponse(session!), 201);
  });

  app.put("/api/delivery/uploads/:id/parts/:partNumber", async c => {
    const principal = c.get("principal");
    const session = await uploadSession(c.env, c.req.param("id"), principal.id);
    const partNumber = Number(c.req.param("partNumber"));
    if (!session || session.status !== "active" || Date.parse(session.expires_at) <= Date.now()) throw new HTTPException(404, { message: "Upload session not found or expired" });
    await requireCrudPermission(c.env, principal, UPLOAD, session.object_key);
    const offset = (partNumber - 1) * session.part_size;
    const expectedLength = Math.min(session.part_size, session.expected_size - offset);
    const suppliedLength = Number(c.req.header("Content-Length") || 0);
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10_000 || expectedLength <= 0 ||
      suppliedLength !== expectedLength || !c.req.raw.body) throw new HTTPException(400, { message: "Upload part size or number is invalid" });
    const result = await c.env.DATA_BUCKET.resumeMultipartUpload(session.staging_key, session.upload_id).uploadPart(partNumber, c.req.raw.body);
    await c.env.OPS_DB.prepare(`INSERT INTO r2_upload_parts(session_id,part_number,etag,size) VALUES(?,?,?,?)
      ON CONFLICT(session_id,part_number) DO UPDATE SET etag=excluded.etag,size=excluded.size,uploaded_at=datetime('now')`)
      .bind(session.id, partNumber, result.etag, suppliedLength).run();
    return c.json({ partNumber: result.partNumber, etag: result.etag, size: suppliedLength });
  });

  app.post("/api/delivery/uploads/:id/complete", async c => {
    const principal = c.get("principal");
    let session = await uploadSession(c.env, c.req.param("id"), principal.id);
    if (!session) throw new HTTPException(404, { message: "Upload session not found" });
    await requireCrudPermission(c.env, principal, UPLOAD, session.object_key);
    if (session.status === "completed") return c.json(sessionResponse(session));
    const staleCompletion = session.status === "completing" && Boolean(session.completion_claimed_at) &&
      Date.parse(session.completion_claimed_at!) <= Date.now() - 5 * 60 * 1000;
    if ((session.status !== "active" && !staleCompletion) || Date.parse(session.expires_at) <= Date.now()) {
      if (session.status === "completing") throw new HTTPException(409, { message: "Upload completion is already in progress; retry shortly" });
      throw new HTTPException(404, { message: "Upload session not found or expired" });
    }
    const claim = await c.env.OPS_DB.prepare(`UPDATE r2_upload_sessions SET status='completing',completion_claimed_at=datetime('now')
      WHERE id=? AND datetime(expires_at)>datetime('now') AND (
        status='active' OR (status='completing' AND datetime(completion_claimed_at)<=datetime('now','-5 minutes'))
      )`)
      .bind(session.id).run();
    if (claim.meta.changes !== 1) throw new HTTPException(409, { message: "Upload completion is already in progress; retry shortly" });
    let recovery: { id: string; key: string } | null = null;
    let replacementPublished = false;
    try {
    const stored = await c.env.OPS_DB.prepare("SELECT part_number,etag,size FROM r2_upload_parts WHERE session_id=? ORDER BY part_number")
      .bind(session.id).all<{part_number:number;etag:string;size:number}>();
    const activeSession = session;
    const expectedParts = Math.ceil(activeSession.expected_size / activeSession.part_size);
    if (stored.results.length !== expectedParts || stored.results.some((part, index) => part.part_number !== index + 1 ||
      part.size !== Math.min(activeSession.part_size, activeSession.expected_size - index * activeSession.part_size))) {
      await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET status='active',completion_claimed_at=NULL WHERE id=? AND status='completing'").bind(session.id).run();
      throw new HTTPException(409, { message: "Upload parts are incomplete" });
    }
    let staged = await c.env.DATA_BUCKET.head(session.staging_key);
    if (!staged) {
      staged = await c.env.DATA_BUCKET.resumeMultipartUpload(session.staging_key, session.upload_id)
        .complete(stored.results.map((part) => ({ partNumber: part.part_number, etag: part.etag })));
    }
    if (staged.size !== session.expected_size) {
      await c.env.DATA_BUCKET.delete(session.staging_key);
      await c.env.OPS_DB.batch([
        c.env.OPS_DB.prepare(`UPDATE r2_upload_sessions SET status='aborted',completion_claimed_at=NULL,
          cleanup_status='pending',cleanup_next_attempt_at=datetime('now'),cleanup_claimed_at=NULL,cleanup_error=NULL
          WHERE id=? AND status='completing'`).bind(session.id),
        c.env.OPS_DB.prepare("UPDATE browser_upload_intent_files SET status='failed',error_code='size_mismatch',updated_at=datetime('now') WHERE intent_id=? AND ordinal=?").bind(session.intent_id, session.intent_ordinal),
      ]);
      await cleanupBrowserUploadSessions(c.env, 1, session.id);
      throw new HTTPException(422, { message: "Uploaded bytes do not match the declared size" });
    }

    const current = await c.env.DATA_BUCKET.head(session.object_key);
    if (current?.customMetadata?.browserUploadSession === session.id && current.size === session.expected_size) {
      if (session.replacement_recovery_id) {
        await c.env.OPS_DB.prepare("UPDATE r2_replacement_recovery SET replacement_result_etag=? WHERE id=? AND replacement_result_etag IS NULL")
          .bind(current.httpEtag, session.replacement_recovery_id).run();
      }
      await finalizeBrowserUpload(c.env, session, current);
      await cleanupBrowserUploadSessions(c.env, 1, session.id);
      session = (await uploadSession(c.env, session.id, principal.id))!;
      return c.json(sessionResponse(session));
    }
    if (session.conflict_policy !== "replace" && current) {
      await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET status='active',completion_claimed_at=NULL WHERE id=? AND status='completing'").bind(session.id).run();
      throw new HTTPException(409, { message: "The upload destination changed before completion" });
    }

    if (session.conflict_policy === "replace") {
      const baselineMatches = session.destination_baseline === "absent"
        ? !current
        : session.destination_baseline.startsWith("etag:") &&
          current?.httpEtag === session.destination_baseline.slice("etag:".length);
      if (!baselineMatches) {
        await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET status='active',completion_claimed_at=NULL WHERE id=? AND status='completing'").bind(session.id).run();
        throw new HTTPException(409, { message: "The upload destination changed before replacement" });
      }
    }

    const stagedBody = await c.env.DATA_BUCKET.get(session.staging_key);
    if (!stagedBody) throw new HTTPException(409, { message: "Completed upload staging object is unavailable" });
    if (current && session.conflict_policy === "replace") {
      const original = await c.env.DATA_BUCKET.get(session.object_key);
      const baselineEtag = session.destination_baseline.slice("etag:".length);
      if (!original || original.httpEtag !== baselineEtag) throw new HTTPException(409, { message: "The upload destination changed before replacement" });
      recovery = { id: crypto.randomUUID(), key: `Jobs/Clients/_ltds/replacements/${crypto.randomUUID()}/${leaf(session.object_key)}` };
      try {
        await c.env.DATA_BUCKET.put(recovery.key, original.body, { httpMetadata: original.httpMetadata, customMetadata: original.customMetadata });
        await c.env.OPS_DB.prepare("INSERT INTO r2_replacement_recovery(id,original_key,recovery_key,purge_after) VALUES(?,?,?,datetime('now','+7 days'))")
          .bind(recovery.id, session.object_key, recovery.key).run();
        const linked = await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET replacement_recovery_id=? WHERE id=? AND status='completing'")
          .bind(recovery.id, session.id).run();
        if (linked.meta.changes !== 1) throw new HTTPException(409, { message: "Upload completion no longer owns the recovery" });
        session.replacement_recovery_id = recovery.id;
      } catch (error) {
        await c.env.DATA_BUCKET.delete(recovery.key);
        await c.env.OPS_DB.prepare("DELETE FROM r2_replacement_recovery WHERE id=?").bind(recovery.id).run();
        throw error;
      }
    }
    const condition = new Headers();
    if (session.conflict_policy === "replace" && session.destination_baseline.startsWith("etag:")) {
      condition.set("If-Match", session.destination_baseline.slice("etag:".length));
    } else {
      condition.set("If-None-Match", "*");
    }
    const stillClaimed = await c.env.OPS_DB.prepare("SELECT id FROM r2_upload_sessions WHERE id=? AND status='completing'")
      .bind(session.id).first<{id:string}>();
    if (!stillClaimed) throw new HTTPException(409, { message: "Upload completion no longer owns the session" });
    const published = await c.env.DATA_BUCKET.put(session.object_key, stagedBody.body, {
      onlyIf: condition,
      httpMetadata: { ...stagedBody.httpMetadata, contentType: session.content_type },
      customMetadata: {
        ...(stagedBody.customMetadata || {}),
        browserUploadSession: session.id,
        ...(recovery ? { replacementRecoveryId: recovery.id } : {}),
      },
    });
    if (!published) {
      if (recovery) {
        await c.env.DATA_BUCKET.delete(recovery.key);
        await c.env.OPS_DB.prepare("DELETE FROM r2_replacement_recovery WHERE id=?").bind(recovery.id).run();
        await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET replacement_recovery_id=NULL WHERE id=?").bind(session.id).run();
        recovery = null;
      }
      await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET status='active',completion_claimed_at=NULL WHERE id=? AND status='completing'").bind(session.id).run();
      throw new HTTPException(409, { message: "The upload destination changed before publication" });
    }
    replacementPublished = true;
    if (recovery) {
      await c.env.OPS_DB.prepare("UPDATE r2_replacement_recovery SET replacement_result_etag=? WHERE id=?")
        .bind(published.httpEtag, recovery.id).run();
    }
    await finalizeBrowserUpload(c.env, session, published);
    await cleanupBrowserUploadSessions(c.env, 1, session.id);
    await audit(c.env, c.req.raw, principal, "delivery.upload.completed", published.key, { sessionId: session.id, intentId: session.intent_id, size: published.size, collisionPolicy: session.conflict_policy });
    session = (await uploadSession(c.env, session.id, principal.id))!;
    return c.json(sessionResponse(session));
    } catch (error) {
      if (recovery && !replacementPublished) {
        await c.env.DATA_BUCKET.delete(recovery.key);
        await c.env.OPS_DB.prepare("DELETE FROM r2_replacement_recovery WHERE id=?").bind(recovery.id).run();
        await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET replacement_recovery_id=NULL WHERE id=?").bind(session.id).run();
      }
      await c.env.OPS_DB.prepare("UPDATE r2_upload_sessions SET status='active',completion_claimed_at=NULL WHERE id=? AND status='completing'").bind(session.id).run();
      throw error;
    }
  });

  app.delete("/api/delivery/uploads/:id", async c => {
    const principal = c.get("principal");
    const session = await uploadSession(c.env, c.req.param("id"), principal.id);
    if (!session || session.status !== "active") throw new HTTPException(404, { message: "Upload session not found" });
    await requireCrudPermission(c.env, principal, UPLOAD, session.object_key);
    const cancelled = await c.env.OPS_DB.prepare(`UPDATE r2_upload_sessions SET status='aborted',completion_claimed_at=NULL,
      cleanup_status='pending',cleanup_next_attempt_at=datetime('now'),cleanup_claimed_at=NULL,cleanup_error=NULL
      WHERE id=? AND status='active'`)
      .bind(session.id).run();
    if (cancelled.meta.changes !== 1) throw new HTTPException(409, { message: "Upload completion is already in progress" });
    await cleanupBrowserUploadSessions(c.env, 1, session.id);
    await c.env.OPS_DB.batch([
      c.env.OPS_DB.prepare("UPDATE browser_upload_intent_files SET status='aborted',error_code='cancelled',updated_at=datetime('now') WHERE intent_id=? AND ordinal=? AND status<>'completed'").bind(session.intent_id, session.intent_ordinal),
    ]);
    await audit(c.env, c.req.raw, principal, "delivery.upload.aborted", session.object_key, { sessionId: session.id, intentId: session.intent_id });
    return c.json({ success: true });
  });

  app.post("/api/delivery/uploads/:id/cleanup/retry", async c => {
    const principal = c.get("principal");
    const session = await uploadSession(c.env, c.req.param("id"), principal.id);
    if (!session || !["completed", "aborted", "expired"].includes(session.status)) throw new HTTPException(404, { message: "Terminal upload session not found" });
    await requireCrudPermission(c.env, principal, UPLOAD, session.result_key || session.object_key);
    const reset = await c.env.OPS_DB.prepare(`UPDATE r2_upload_sessions SET cleanup_status='pending',cleanup_attempts=0,
      cleanup_next_attempt_at=datetime('now'),cleanup_claimed_at=NULL,cleanup_error=NULL WHERE id=? AND cleanup_status='failed'`)
      .bind(session.id).run();
    if (reset.meta.changes !== 1) throw new HTTPException(409, { message: "Upload cleanup is not in a failed state" });
    await cleanupBrowserUploadSessions(c.env, 1, session.id);
    const updated = await uploadSession(c.env, session.id, principal.id);
    return c.json(sessionResponse(updated!));
  });

  app.get("/api/delivery/uploads/:id", async c => {
    const principal = c.get("principal");
    const session = await uploadSession(c.env, c.req.param("id"), principal.id);
    if (!session) throw new HTTPException(404, { message: "Upload session not found" });
    await requireCrudPermission(c.env, principal, permission("delivery.browse"), session.result_key || session.object_key);
    const parts = await c.env.OPS_DB.prepare("SELECT part_number,etag,size FROM r2_upload_parts WHERE session_id=? ORDER BY part_number")
      .bind(session.id).all<{part_number:number;etag:string;size:number}>();
    return c.json(sessionResponse(session, parts.results));
  });

  app.post("/api/delivery/fs/trash/:id/restore", async c => { const principal = c.get("principal"); await requirePermission(c.env, principal, RESTORE); await restoreTombstone(c.env, principal, c.req.param("id")); return c.json({ success: true }); });
}
