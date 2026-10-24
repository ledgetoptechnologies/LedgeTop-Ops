import { z } from "zod";
import { ViewerServiceError, type ClientViewerSessionResultV1, type DirectClientViewerAuthorizationV1,
  type DirectClientViewerItemsResultV1, type DirectClientViewerSessionRequestV1 } from "@ltds/shared";
import type { Env } from "./types";
import type { Env as ClientEnv } from "../../../client/src/worker/types";
import { resolveNativePortalWorkspaceReadContext, nativePortalScopesAllowed } from "../../../client/src/worker/client-portal/workspace-v2";
import { readDirectViewerClientGrants, readDirectViewerClientBusinessName } from "./viewer-direct-client-grants";
import { viewerServiceClient } from "./viewer-integration";
import { base64Url, sha256 } from "./crypto";

const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const authorization = z.object({ protocolVersion: z.literal(1), sourceId: z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
  workspaceId: opaque, identityId: opaque, principalIssuer: z.string().min(1).max(512), principalSubject: z.string().min(1).max(512),
  verifiedEmail: z.email().max(320), contextVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const listRequest = authorization.extend({ cursor: z.string().min(1).max(8192).optional() });
const sessionRequest = authorization.extend({ grantId: opaque, taskId: opaque,
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/), displayUnits: z.enum(["imperial", "metric"]) });
const cursorSchema = z.object({ v: z.literal(1), scope: z.string(), index: z.number().int().min(0).max(100),
  after: z.string().max(2048).nullable(), expires: z.number().int().positive() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
type Auth = z.infer<typeof authorization>;
type Row = Awaited<ReturnType<typeof readDirectViewerClientGrants>>[number];
type FailureCode = "invalid_request" | "denied" | "not_found" | "configuration_error" | "temporarily_unavailable";
const failure = (code: FailureCode) => ({ ok: false as const, protocolVersion: 1 as const, code });
const database = (env: Env) => env.DELIVERY_DB.withSession("first-primary");
const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0,512);
function expiry(value: string | null | undefined): number {
  if (!value) return Infinity;
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(" ","T")}Z` : value);
}
function codeFor(error: unknown): FailureCode {
  if (error instanceof ViewerServiceError) return error.code === "not_found" ? "not_found" :
    ["not_configured", "invalid_configuration"].includes(error.code) ? "configuration_error" : "temporarily_unavailable";
  return error instanceof Error && /no such table/.test(error.message) ? "configuration_error" : "temporarily_unavailable";
}
async function contextFor(env: Env, input: Auth) {
  const context = await resolveNativePortalWorkspaceReadContext(env as unknown as ClientEnv,
    { issuer: input.principalIssuer, subject: input.principalSubject, email: input.verifiedEmail }, input.workspaceId);
  if (!context || context.identityId !== input.identityId || context.sourceId !== input.sourceId || context.contextVersion !== input.contextVersion)
    return null;
  // An explicit direct Viewer grant supplies the resource allow. Existing global
  // and account denials still win; it does not create PA project/file permissions.
  if (!nativePortalScopesAllowed(context, "delivery.view", new Set([`workspace:${input.workspaceId}`]), false)) return null;
  return context;
}
async function cursorKey(env: Env) {
  const secret = env.VIEWER_SERVICE_HMAC_SECRET;
  if (!secret || secret.length < 32) throw new Error("direct-viewer-cursor-unavailable");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`direct-viewer-cursor-v1\0${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encodeCursor(env: Env, cursor: Cursor): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv},await cursorKey(env),new TextEncoder().encode(JSON.stringify(cursor))));
  const bytes = new Uint8Array(iv.length+encoded.length); bytes.set(iv); bytes.set(encoded,iv.length);
  return `dv1_${base64Url(bytes)}`;
}
async function decodeCursor(env: Env, raw: string, scope: string): Promise<Cursor | null> {
  try {
    if (!/^dv1_[A-Za-z0-9_-]+$/.test(raw) || raw.length>8192) return null;
    const bytes=Uint8Array.from(atob(raw.slice(4).replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
    if (bytes.length<29 || `dv1_${base64Url(bytes)}`!==raw) return null;
    const cursor=cursorSchema.parse(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await crypto.subtle.decrypt(
      {name:"AES-GCM",iv:bytes.slice(0,12)},await cursorKey(env),bytes.slice(12)))));
    return cursor.scope===scope && cursor.expires>Date.now() && cursor.expires<=Date.now()+16*60_000 ? cursor : null;
  } catch { return null; }
}
async function grantScope(context: {contextVersion:string;identityId:string;workspaceId:string;sourceId:string}, rows: Row[]) {
  return sha256(JSON.stringify([context.sourceId,context.workspaceId,context.identityId,context.contextVersion,
    rows.map(row=>[row.id,row.grant_version,row.viewer_project_id,row.task_id,row.scope_type,row.authorization_expires_at,
      row.can_measure,row.can_view_cameras,row.can_download])]));
}

export async function listDirectClientViewerItems(env: Env, request: DirectClientViewerAuthorizationV1): Promise<DirectClientViewerItemsResultV1> {
  const parsed=listRequest.safeParse(request);
  if (!parsed.success) return failure("invalid_request");
  if (env.CLIENT_VIEWER_SESSION_ISSUER_ENABLED!=="true") return failure("configuration_error");
  try {
    const input=parsed.data, context=await contextFor(env,input); if(!context)return failure("denied");
    const rows=await readDirectViewerClientGrants(env,{sourceId:input.sourceId,workspaceId:input.workspaceId});
    const scope=await grantScope(context,rows);
    const cursor=input.cursor ? await decodeCursor(env,input.cursor,scope) : {v:1 as const,scope,index:0,after:null,expires:Date.now()+15*60_000};
    if(!cursor || cursor.index>rows.length)return failure("invalid_request");
    const client=viewerServiceClient(env), businessName=await readDirectViewerClientBusinessName(env,input.sourceId);
    let index=cursor.index, after=cursor.after, inspected=0;
    const items: Extract<DirectClientViewerItemsResultV1,{ok:true}>["items"]=[];
    // At most five bounded upstream pages per request, never an all-client catalog.
    while(index<rows.length && inspected++<5 && items.length===0){
      const row=rows[index]!;
      let catalog;
      try { catalog=await client.clientDeliveryCatalog({projectId:row.viewer_project_id,
        ...(row.scope_type==="task"?{taskId:row.task_id!}:{}),...(after?{cursor:after}:{}),limit:25}); }
      catch(error){if(error instanceof ViewerServiceError&&error.code==="not_found"){index++;after=null;continue;}throw error;}
      for(const task of catalog.tasks)items.push({grantId:row.id,workspaceId:input.workspaceId,taskId:task.id,scopeType:row.scope_type,
        title:clean(task.displayName||task.modelTitle),projectName:clean(catalog.project.displayName),businessName:clean(businessName),
        sharedAt:row.created_at,updatedAt:task.publishedAt,expiresAt:row.authorization_expires_at,
        permissions:{measure:row.can_measure===1,cameras:row.can_view_cameras===1,download:row.can_download===1}});
      if(catalog.nextCursor)after=catalog.nextCursor;else{index++;after=null;}
    }
    const current=await contextFor(env,input);if(!current)return failure("denied");
    const fresh=await readDirectViewerClientGrants(env,{sourceId:input.sourceId,workspaceId:input.workspaceId});
    if(await grantScope(current,fresh)!==scope)return failure("denied");
    return {ok:true,protocolVersion:1,items,nextCursor:index<rows.length?await encodeCursor(env,{...cursor,index,after}):null};
  }catch(error){return failure(codeFor(error));}
}

export async function issueDirectClientViewerSession(env: Env, request: DirectClientViewerSessionRequestV1): Promise<ClientViewerSessionResultV1> {
  const parsed=sessionRequest.safeParse(request);if(!parsed.success)return failure("invalid_request");
  if(env.CLIENT_VIEWER_SESSION_ISSUER_ENABLED!=="true")return failure("configuration_error");
  try{
    const input=parsed.data,context=await contextFor(env,input);if(!context)return failure("denied");
    const rows=await readDirectViewerClientGrants(env,{sourceId:input.sourceId,workspaceId:input.workspaceId,grantId:input.grantId});
    const row=rows.find(row=>row.id===input.grantId);if(!row || (row.scope_type==="task"&&row.task_id!==input.taskId))return failure("denied");
    const client=viewerServiceClient(env),catalog=await client.clientDeliveryCatalog({projectId:row.viewer_project_id,taskId:input.taskId,limit:1});
    const task=catalog.tasks[0];if(!task || task.id!==input.taskId)return failure("denied");
    const scope=await grantScope(context,[row]);
    const fingerprint=await sha256(JSON.stringify([scope,input.taskId,task.modelId,task.modelVersionId,input.displayUnits]));
    const key=`direct_${await sha256(JSON.stringify([input.identityId,input.idempotencyKey]))}`;
    const receipt=await database(env).prepare(`SELECT request_fingerprint,response_json,expires_at FROM viewer_session_issuance_receipts
      WHERE actor_id=? AND audience='client' AND idempotency_key=?`).bind(input.identityId,key)
      .first<{request_fingerprint:string;response_json:string;expires_at:string}>();
    if(receipt && receipt.request_fingerprint!==fingerprint)return failure("invalid_request");
    const recheck=async()=>{
      const current=await contextFor(env,input);if(!current)return false;
      const fresh=await readDirectViewerClientGrants(env,{sourceId:input.sourceId,workspaceId:input.workspaceId,grantId:input.grantId});
      return fresh.length===1 && await grantScope(current,fresh)===scope;
    };
    if(receipt && expiry(receipt.expires_at)>Date.now()){
      if(!await recheck())return failure("denied");
      return {ok:true,protocolVersion:1,...JSON.parse(receipt.response_json)};
    }
    const membership=context.workspace as unknown as {membership_expires_at?:string|null};
    const maximumDeadline=Math.min(Date.now()+30*60_000,expiry(row.authorization_expires_at),expiry(membership.membership_expires_at),
      ...(context.grants as Array<{effect:string;expires_at?:string|null}>).filter(rule=>rule.effect==="allow").map(rule=>expiry(rule.expires_at)));
    if(!Number.isFinite(maximumDeadline)||maximumDeadline<=Date.now()+60_000)return failure("denied");
    await database(env).prepare(`INSERT INTO viewer_direct_client_session_intents
      (actor_identity_id,idempotency_key,grant_id,grant_version,request_fingerprint,authorization_expires_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(actor_identity_id,idempotency_key) DO NOTHING`)
      .bind(input.identityId,key,row.id,row.grant_version,fingerprint,new Date(maximumDeadline).toISOString()).run();
    const intent=await database(env).prepare(`SELECT request_fingerprint,authorization_expires_at FROM viewer_direct_client_session_intents
      WHERE actor_identity_id=? AND idempotency_key=?`).bind(input.identityId,key)
      .first<{request_fingerprint:string;authorization_expires_at:string}>();
    if(!intent||intent.request_fingerprint!==fingerprint)return failure("invalid_request");
    const deadline=expiry(intent.authorization_expires_at);
    if(!Number.isFinite(deadline)||deadline>maximumDeadline||deadline<=Date.now()+60_000)return failure("denied");
    if(!await recheck())return failure("denied");
    const grant=await client.createSession({modelId:task.modelId,modelVersionId:task.modelVersionId,subject:`client:${input.identityId}`,
      audience:"client",idempotencyKey:key,authorizationExpiresAt:new Date(deadline).toISOString(),displayUnits:input.displayUnits,
      permissions:{view:true,measure:row.can_measure===1,cameras:row.can_view_cameras===1,download:row.can_download===1,personalMeasurements:true},
      sourceAuthorization:{type:"direct_client_grant",id:row.id,version:row.grant_version}});
    // Publication can change in Viewer while the remote session is being minted.
    // Do not return a capability for a task/version no longer in the allowed set.
    const latest=await client.clientDeliveryCatalog({projectId:row.viewer_project_id,taskId:input.taskId,limit:1});
    if(latest.tasks[0]?.modelId!==task.modelId||latest.tasks[0]?.modelVersionId!==task.modelVersionId)return failure("denied");
    if(!await recheck())return failure("denied");
    const result={...grant,modelId:task.modelId};
    await database(env).prepare(`INSERT INTO viewer_session_issuance_receipts(actor_id,audience,idempotency_key,request_fingerprint,response_json,expires_at)
      VALUES (?,'client',?,?,?,?) ON CONFLICT(actor_id,audience,idempotency_key) DO NOTHING`)
      .bind(input.identityId,key,fingerprint,JSON.stringify(result),grant.grantExpiresAt).run();
    return {ok:true,protocolVersion:1,...result};
  }catch(error){return failure(codeFor(error));}
}

/** Keep lost-response retries stable for a day after authorization expires. */
export async function pruneDirectViewerSessionIntents(env: Env): Promise<number> {
  const result=await database(env).prepare(`DELETE FROM viewer_direct_client_session_intents WHERE rowid IN (
    SELECT rowid FROM viewer_direct_client_session_intents
    WHERE datetime(authorization_expires_at)<=datetime('now','-1 day') ORDER BY authorization_expires_at LIMIT 500
  )`).run();
  return result.meta.changes||0;
}
