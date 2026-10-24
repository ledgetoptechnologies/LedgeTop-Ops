import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';
import {sqlScope} from './acl';
import {sha256} from './crypto';
import {portalRootAccessAllowedSql} from './client-portal-root-access';
import {viewerServiceClient} from './viewer-integration';
import {portalProjectionSourceGuard,readPortalProjectionSourceProof} from '../../../client/src/worker/project-alpha-portal-authority';
import type {Env,StaffPrincipal} from './types';

const opaque=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const source=z.string().min(15).max(78).regex(/^project-alpha:[a-z0-9][a-z0-9_-]*$/);
const key=z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const directViewerClientGrantListQuerySchema=z.object({q:z.string().trim().max(120).optional(),cursor:opaque.optional(),
 limit:z.coerce.number().int().min(1).max(100).default(25),viewerProjectId:opaque.optional()}).strict();
const inputSchema=z.object({sourceId:source,workspaceId:opaque,viewerProjectId:opaque,taskId:opaque.nullable(),
 scopeType:z.enum(['project','task']),includeFuturePublished:z.boolean(),confirmedScope:z.literal(true),
 expiresAt:z.iso.datetime({offset:true}).nullable(),permissions:z.object({measure:z.boolean(),cameras:z.boolean(),download:z.boolean()}).strict()}).strict()
 .refine(g=>g.scopeType==='project'?g.taskId===null&&g.includeFuturePublished:g.taskId!==null&&!g.includeFuturePublished);
export class DirectViewerGrantError extends HTTPException {
 constructor(status:400|403|404|409|503,public readonly code:string,message:string,public readonly grantId?:string){super(status,{message,cause:{code}});}
}
function fail(status:400|403|404|409|503,code:string,message:string):never{throw new DirectViewerGrantError(status,code,message);}
function db(env:Env){return env.DELIVERY_DB.withSession('first-primary');}
export async function readDirectViewerClientBusinessName(env:Env,sourceId:string):Promise<string>{
 const row=await env.OPS_DB.withSession('first-primary').prepare(`SELECT display_name FROM pa_connectors WHERE source_id=? AND read_visible=1`)
  .bind(sourceId).first<{display_name:string}>();
 return row?.display_name?.trim()||'Business';
}
async function manage(env:Env,principal:StaffPrincipal){
 for(const permission of ['viewer.view','viewer.manage'] as const){const scope=await sqlScope(env,principal,permission);
  if(!scope.global||scope.deniedGlobal)fail(403,'forbidden','Global Viewer management permission required');}
}
export interface DirectViewerClientGrantRow {
 id:string;source_id:string;workspace_id:string;viewer_project_id:string;task_id:string|null;scope_type:'project'|'task';
 include_future_published:number;can_measure:number;can_view_cameras:number;can_download:number;authorization_expires_at:string|null;
 grant_version:number;status:'active'|'revoked';created_by_staff_id:string;created_at:string;updated_at:string;revoked_at:string|null;
 revoked_by_staff_id:string|null;revoke_reason:string|null;client_display_name?:string;
}
export function directViewerClientGrantView(r:DirectViewerClientGrantRow){return {grantId:r.id,sourceId:r.source_id,workspaceId:r.workspace_id,
 viewerProjectId:r.viewer_project_id,taskId:r.task_id,scopeType:r.scope_type,includeFuturePublished:!!r.include_future_published,
 permissions:{measure:!!r.can_measure,cameras:!!r.can_view_cameras,download:!!r.can_download},expiresAt:r.authorization_expires_at,
 grantVersion:r.grant_version,revokedAt:r.revoked_at,createdAt:r.created_at,clientDisplayName:r.client_display_name??null};}
function recipientSql(env:Env){return `SELECT w.id,w.project_alpha_source_id,root.display_name,
 checkpoint.active_generation_id,checkpoint.source_sequence,root.source_version root_version
 FROM portal_v2_workspaces w JOIN pa_portal_workspace_sources mapping ON mapping.workspace_id=w.id
 AND mapping.projection_source_id=w.project_alpha_source_id
 JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=w.id
 JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
 AND generation.workspace_id=w.id AND generation.status='active' AND generation.complete=1
 JOIN portal_v2_directory_entities root ON root.workspace_id=w.id AND root.generation_id=generation.id
 AND root.entity_type=w.root_type AND root.public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id) AND root.active=1
 WHERE w.status='active' AND w.legacy_account_id IS NULL AND ${portalRootAccessAllowedSql(env,'w')}
 AND NOT EXISTS(SELECT 1 FROM portal_client_authority_workspace_claims claim WHERE claim.workspace_id=w.id AND claim.state='active')`;}
interface Recipient {id:string;project_alpha_source_id:string;display_name:string;active_generation_id:string;source_sequence:number;root_version:string}
async function recipient(env:Env,sourceId:string,workspaceId:string){
 const database=db(env);const row=await database.prepare(`${recipientSql(env)} AND w.id=? AND w.project_alpha_source_id=?`)
 .bind(workspaceId,sourceId).first<Recipient>();
 const proof=row&&await readPortalProjectionSourceProof(env,database,sourceId);
 if(!row||!proof)fail(409,'relationship_missing','Client connection is unavailable; refresh the client connection');
 return {row,guard:portalProjectionSourceGuard(proof)};
}
export async function readDirectViewerClientGrants(env:Env,input:{sourceId:string;workspaceId:string;grantId?:string}){
 const parsed=z.object({sourceId:source,workspaceId:opaque,grantId:opaque.optional()}).strict().safeParse(input);
 if(!parsed.success)fail(400,'invalid_request','Invalid client grant selector');
 const rows=await db(env).prepare(`SELECT * FROM viewer_direct_client_grants WHERE source_id=? AND workspace_id=?
 AND status='active' AND revoked_at IS NULL AND (authorization_expires_at IS NULL OR datetime(authorization_expires_at)>datetime('now'))
 ${input.grantId?'AND id=?':''} ORDER BY id LIMIT 101`).bind(input.sourceId,input.workspaceId,...(input.grantId?[input.grantId]:[])).all<DirectViewerClientGrantRow>();
 if(rows.results.length>100)fail(503,'grant_limit','Client Viewer grant limit exceeded');return rows.results;
}
export async function listDirectViewerClientGrantWorkspace(env:Env,principal:StaffPrincipal,query:unknown={}){
 await manage(env,principal);const parsed=directViewerClientGrantListQuerySchema.safeParse(query);
 if(!parsed.success)fail(400,'invalid_request','Invalid client picker query');const q=parsed.data,database=db(env);
 const rows=await database.prepare(`${recipientSql(env)} AND w.id>? AND (?='' OR instr(lower(root.display_name),lower(?))>0)
 ORDER BY w.id LIMIT ?`).bind(q.cursor??'',q.q??'',q.q??'',q.limit+1).all<Recipient>();
 const page=rows.results.slice(0,q.limit);const clients=[],businessNames=new Map<string,string>();
 for(const row of page){if(!await readPortalProjectionSourceProof(env,database,row.project_alpha_source_id))continue;
  if(!businessNames.has(row.project_alpha_source_id))businessNames.set(row.project_alpha_source_id,await readDirectViewerClientBusinessName(env,row.project_alpha_source_id));
  clients.push({sourceId:row.project_alpha_source_id,workspaceId:row.id,displayName:row.display_name,
   businessName:businessNames.get(row.project_alpha_source_id)!});}
 const grants=await database.prepare(`SELECT grant_row.*,w.display_name client_display_name FROM viewer_direct_client_grants grant_row
 JOIN portal_v2_workspaces w ON w.id=grant_row.workspace_id AND w.project_alpha_source_id=grant_row.source_id
 WHERE grant_row.status='active' AND (? IS NULL OR grant_row.viewer_project_id=?) ORDER BY grant_row.id LIMIT 101`)
 .bind(q.viewerProjectId??null,q.viewerProjectId??null).all<DirectViewerClientGrantRow>();
 if(grants.results.length>100)fail(503,'grant_limit','Filter Viewer grants by project');
 return {clients,clientsNextCursor:rows.results.length>q.limit?page.at(-1)!.id:null,grants:grants.results.map(directViewerClientGrantView)};
}
async function receipt(env:Env,actor:string,idempotencyKey:string,fingerprint:string){
 const row=await db(env).prepare(`SELECT request_fingerprint,response_json FROM viewer_direct_client_grant_mutation_receipts
 WHERE actor_staff_id=? AND idempotency_key=?`).bind(actor,idempotencyKey).first<{request_fingerprint:string;response_json:string}>();
 if(row&&row.request_fingerprint!==fingerprint)fail(409,'idempotency_conflict','Idempotency key already used for another request');
 return row?JSON.parse(row.response_json):null;
}
function mutationStatements(database:Pick<D1Database,'prepare'>,principal:StaffPrincipal,idempotencyKey:string,fingerprint:string,id:string,action:string,response:unknown,now:string){return [
 database.prepare(`INSERT INTO viewer_direct_client_grant_mutation_receipts VALUES(?,?,?,?,?,?,?)`)
 .bind(principal.id,idempotencyKey,action,fingerprint,id,JSON.stringify(response),now),
 database.prepare(`INSERT INTO viewer_direct_client_grant_audit VALUES(?,?,?,?,?,?,?)`)
 .bind(crypto.randomUUID(),id,action,principal.id,idempotencyKey,JSON.stringify(response),now)];}
export async function createDirectViewerClientGrant(input:{env:Env;principal:StaffPrincipal;grant:unknown;idempotencyKey:string;request:Request}){
 const {env,principal}=input;await manage(env,principal);const parsed=inputSchema.safeParse(input.grant);
 if(!parsed.success||!key.safeParse(input.idempotencyKey).success)fail(400,'invalid_request','Invalid Viewer sharing request');
 const g=parsed.data,fingerprint=await sha256(JSON.stringify(['direct.create',g]));
 const prior=await receipt(env,principal.id,input.idempotencyKey,fingerprint);if(prior)return {grant:prior,replayed:true};
 if(g.expiresAt!==null&&Date.parse(g.expiresAt)<=Date.now())fail(400,'expired_at_invalid','Expiration must be in the future');
 const catalog=await viewerServiceClient(env).clientDeliveryCatalog({projectId:g.viewerProjectId,...(g.taskId?{taskId:g.taskId}:{})});
 if(catalog.project.id!==g.viewerProjectId)fail(409,'task_not_in_project','Viewer project does not match');
 if(g.taskId&&(catalog.tasks.length!==1||catalog.tasks[0]?.id!==g.taskId))fail(409,'task_not_published','Task is not published in this project');
 // Recheck recipient authority after the remote catalog request, then pin it in the INSERT itself.
 const {row,guard}=await recipient(env,g.sourceId,g.workspaceId),database=db(env),id=crypto.randomUUID(),now=new Date().toISOString();
 const duplicate=await database.prepare(`SELECT id FROM viewer_direct_client_grants WHERE source_id=? AND workspace_id=? AND viewer_project_id=?
 AND scope_type=? AND task_id IS ? AND status='active'`).bind(g.sourceId,g.workspaceId,g.viewerProjectId,g.scopeType,g.taskId).first<{id:string}>();
 if(duplicate)throw new DirectViewerGrantError(409,'duplicate_active_grant','Client already has this share',duplicate.id);
 const count=await database.prepare(`SELECT count(*) n FROM viewer_direct_client_grants WHERE source_id=? AND workspace_id=? AND status='active'`)
 .bind(g.sourceId,g.workspaceId).first<number>('n');if((count??0)>=100)fail(409,'grant_limit','Client Viewer grant limit reached');
 const result={grantId:id,sourceId:g.sourceId,workspaceId:g.workspaceId,viewerProjectId:g.viewerProjectId,taskId:g.taskId,scopeType:g.scopeType,
 includeFuturePublished:g.includeFuturePublished,permissions:g.permissions,expiresAt:g.expiresAt,grantVersion:1,revokedAt:null,createdAt:now,clientDisplayName:row.display_name};
 try{await database.batch([
 database.prepare(`INSERT INTO viewer_direct_client_grants(id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,
 can_measure,can_view_cameras,can_download,authorization_expires_at,grant_version,status,created_by_staff_id,created_at,updated_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,1,'active',?,?,? WHERE (${guard.sql}) AND EXISTS(${recipientSql(env)} AND w.id=? AND w.project_alpha_source_id=?
 AND checkpoint.active_generation_id=? AND checkpoint.source_sequence=? AND root.source_version=?)`)
 .bind(id,g.sourceId,g.workspaceId,g.viewerProjectId,g.taskId,g.scopeType,+g.includeFuturePublished,+g.permissions.measure,+g.permissions.cameras,+g.permissions.download,
 g.expiresAt,principal.id,now,now,...guard.bindings,g.workspaceId,g.sourceId,row.active_generation_id,row.source_sequence,row.root_version),
 ...mutationStatements(database,principal,input.idempotencyKey,fingerprint,id,'grant.create',result,now)]);
 }catch(error){const replay=await receipt(env,principal.id,input.idempotencyKey,fingerprint);if(replay)return {grant:replay,replayed:true};
  const duplicate=await database.prepare(`SELECT id FROM viewer_direct_client_grants WHERE source_id=? AND workspace_id=? AND viewer_project_id=?
   AND scope_type=? AND task_id IS ? AND status='active'`).bind(g.sourceId,g.workspaceId,g.viewerProjectId,g.scopeType,g.taskId).first<{id:string}>();
  if(duplicate)throw new DirectViewerGrantError(409,'duplicate_active_grant','Client already has this share',duplicate.id);
  if(error instanceof Error&&/FOREIGN KEY|direct-viewer-recipient-invalid/.test(error.message))fail(409,'relationship_missing','Client connection changed; refresh before sharing');
  throw error;}
 return {grant:result,replayed:false};
}
export async function drainDirectViewerClientGrantRevocations(env:Env,options:{limit?:number;grantId?:string}={}){
 const database=db(env),limit=Math.min(100,Math.max(1,options.limit??25));const rows=await database.prepare(`SELECT grant_id,grant_version FROM viewer_direct_client_grant_revocations
 WHERE status='pending' AND (? IS NULL OR grant_id=?) ORDER BY created_at,grant_id LIMIT ?`)
 .bind(options.grantId??null,options.grantId??null,limit).all<{grant_id:string;grant_version:number}>();
 for(const row of rows.results){try{await viewerServiceClient(env).revokePublishedSessionSourceAuthorization({
  sourceAuthorization:{type:'direct_client_grant',id:row.grant_id,version:row.grant_version},idempotencyKey:`direct-revoke:${row.grant_id}:${row.grant_version}`});
  await database.prepare(`UPDATE viewer_direct_client_grant_revocations SET status='complete',attempts=attempts+1,last_error=NULL,completed_at=?
   WHERE grant_id=? AND grant_version=? AND status='pending'`).bind(new Date().toISOString(),row.grant_id,row.grant_version).run();
 }catch{await database.prepare(`UPDATE viewer_direct_client_grant_revocations SET attempts=attempts+1,last_error='viewer_unavailable'
  WHERE grant_id=? AND grant_version=? AND status='pending'`).bind(row.grant_id,row.grant_version).run();}}
 return {attempted:rows.results.length};
}
export async function revokeDirectViewerClientGrant(input:{env:Env;principal:StaffPrincipal;grantId:string;reason:string;idempotencyKey:string;request:Request}){
 const {env,principal}=input;await manage(env,principal);
 if(!opaque.safeParse(input.grantId).success||!key.safeParse(input.idempotencyKey).success||!z.string().trim().min(1).max(240).safeParse(input.reason).success)
  fail(400,'invalid_request','Invalid Viewer revocation');
 const fingerprint=await sha256(JSON.stringify(['direct.revoke',input.grantId,input.reason]));
 const prior=await receipt(env,principal.id,input.idempotencyKey,fingerprint),database=db(env);
 const row=await database.prepare(`SELECT * FROM viewer_direct_client_grants WHERE id=?`).bind(input.grantId).first<DirectViewerClientGrantRow>();
 if(!row)fail(404,'not_found','Viewer share not found');let replayed=!!prior||row.status==='revoked';
 if(!prior&&row.status==='active'){const now=new Date().toISOString();try{await database.batch([
  database.prepare(`UPDATE viewer_direct_client_grants SET status='revoked',revoked_at=?,revoked_by_staff_id=?,revoke_reason=?,updated_at=? WHERE id=? AND status='active'`)
   .bind(now,principal.id,input.reason,now,row.id),
  database.prepare(`INSERT OR IGNORE INTO viewer_direct_client_grant_revocations(grant_id,grant_version,created_at) VALUES(?,?,?)`).bind(row.id,row.grant_version,now),
  ...mutationStatements(database,principal,input.idempotencyKey,fingerprint,row.id,'grant.revoke',{success:true},now)]);
 }catch(error){if(!await receipt(env,principal.id,input.idempotencyKey,fingerprint))throw error;replayed=true;}}
 await drainDirectViewerClientGrantRevocations(env,{limit:1,grantId:row.id});
 const delivery=await database.prepare(`SELECT status FROM viewer_direct_client_grant_revocations WHERE grant_id=? AND grant_version=?`)
 .bind(row.id,row.grant_version).first<{status:string}>();
 return {success:true as const,replayed,sessionRevocation:{pending:delivery?.status!=='complete'}};
}
