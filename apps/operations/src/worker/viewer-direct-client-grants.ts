import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';
import {ViewerServiceError} from '@ltds/shared';
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
 limit:z.coerce.number().int().min(1).max(50).default(25),viewerProjectId:opaque.optional()}).strict();
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
export type DirectViewerClientGrantPublicResult=ReturnType<typeof directViewerClientGrantView>;
export type DirectViewerClientRecipientAuthorityPin = Readonly<
 | {version:1;mode:'native_source';sourceId:string;workspaceId:string;sourceWorkspaceId:string;rootType:'organization'|'standalone_client';
    rootPublicId:string}
 | {version:1;mode:'operations_native';sourceId:string;workspaceId:string;sourceWorkspaceId:string;rootType:'organization'|'standalone_client';
    rootPublicId:string;authorityId:string;ownershipEpoch:number;claimOwnershipEpoch:number}>;
type CreateReceiptEnvelope = Readonly<{version:1;grant:unknown;recipientAuthorityPin:DirectViewerClientRecipientAuthorityPin}>;
export function directViewerClientGrantView(r:DirectViewerClientGrantRow){return {grantId:r.id,sourceId:r.source_id,workspaceId:r.workspace_id,
 viewerProjectId:r.viewer_project_id,taskId:r.task_id,scopeType:r.scope_type,includeFuturePublished:!!r.include_future_published,
 permissions:{measure:!!r.can_measure,cameras:!!r.can_view_cameras,download:!!r.can_download},expiresAt:r.authorization_expires_at,
 grantVersion:r.grant_version,revokedAt:r.revoked_at,createdAt:r.created_at,clientDisplayName:r.client_display_name??null};}
function recipientSql(env:Env){return `SELECT w.id,w.project_alpha_source_id,mapping.source_workspace_id,root.display_name,w.root_type,
 COALESCE(w.pa_organization_public_id,w.pa_client_public_id) root_public_id,
 checkpoint.active_generation_id,checkpoint.source_sequence,root.source_version root_version,
 claim.client_authority_id claim_authority_id,claim.projection_source_id claim_source_id,
 claim.source_workspace_id claim_source_workspace_id,claim.ownership_epoch claim_ownership_epoch
 FROM portal_v2_workspaces w JOIN pa_portal_workspace_sources mapping ON mapping.workspace_id=w.id
 AND mapping.projection_source_id=w.project_alpha_source_id
 LEFT JOIN portal_client_authority_workspace_claims claim ON claim.workspace_id=w.id AND claim.state='active'
 JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=w.id
 JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
 AND generation.workspace_id=w.id AND generation.status='active' AND generation.complete=1
 JOIN portal_v2_directory_entities root ON root.workspace_id=w.id AND root.generation_id=generation.id
 AND root.entity_type=w.root_type AND root.public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id) AND root.active=1
 WHERE w.status='active' AND w.legacy_account_id IS NULL AND ${portalRootAccessAllowedSql(env,'w')}`;}
interface Recipient {id:string;project_alpha_source_id:string;source_workspace_id:string;display_name:string;root_type:'organization'|'standalone_client';
 root_public_id:string;active_generation_id:string;source_sequence:number;root_version:string;
 claim_authority_id:string|null;claim_source_id:string|null;claim_source_workspace_id:string|null;claim_ownership_epoch:number|null}
type OperationsWorkspaceAuthorityPin={targetId:string;targetRevision:number;ownershipEpoch:number};
async function readCurrentOperationsWorkspaceAuthority(env:Env,row:Recipient):Promise<OperationsWorkspaceAuthorityPin|null>{
 if(!row.claim_authority_id||!row.claim_ownership_epoch||row.claim_source_id!==row.project_alpha_source_id
   ||row.claim_source_workspace_id!==row.source_workspace_id)return null;
 try{return await db(env).prepare(`SELECT workspace.target_id targetId,workspace.target_revision targetRevision,
   workspace.ownership_epoch ownershipEpoch
  FROM portal_client_authority_workspace_claims claim
  JOIN operations_portal_native_workspace_authority_heads workspace
    ON workspace.client_authority_id=claim.client_authority_id AND workspace.workspace_id=claim.workspace_id
      AND workspace.state='active' AND workspace.root_kind=?
  JOIN operations_portal_workspace_publication_heads publication
    ON publication.target_id=workspace.target_id AND publication.target_revision=workspace.target_revision
      AND publication.client_authority_id=workspace.client_authority_id AND publication.workspace_id=workspace.workspace_id
      AND publication.root_kind=workspace.root_kind AND publication.root_record_id=workspace.root_record_id
  JOIN operations_portal_workspace_publication_snapshots snapshot
    ON snapshot.snapshot_id=publication.snapshot_id AND snapshot.operation_id=publication.latest_operation_id
      AND snapshot.target_id=publication.target_id AND snapshot.revision=publication.revision
      AND snapshot.source_sequence=publication.source_sequence AND snapshot.snapshot_sha256=publication.snapshot_sha256
  JOIN operations_portal_workspace_publication_receipts publication_receipt
    ON publication_receipt.operation_id=publication.latest_operation_id AND publication_receipt.target_id=publication.target_id
      AND publication_receipt.resulting_revision=publication.revision AND publication_receipt.source_sequence=publication.source_sequence
      AND publication_receipt.snapshot_id=snapshot.snapshot_id AND publication_receipt.snapshot_sha256=snapshot.snapshot_sha256
  JOIN operations_portal_workspace_publication_history publication_history
    ON publication_history.operation_id=publication_receipt.operation_id AND publication_history.target_id=publication.target_id
      AND publication_history.revision=publication.revision AND publication_history.source_sequence=publication.source_sequence
      AND publication_history.snapshot_id=snapshot.snapshot_id AND publication_history.snapshot_sha256=snapshot.snapshot_sha256
  WHERE claim.workspace_id=? AND claim.client_authority_id=? AND claim.projection_source_id=?
    AND claim.source_workspace_id=? AND claim.ownership_epoch=? AND claim.state='active'`)
   .bind(row.root_type,row.id,row.claim_authority_id,row.claim_source_id,row.claim_source_workspace_id,row.claim_ownership_epoch)
   .first<OperationsWorkspaceAuthorityPin>();}catch{return null;}
}
async function recipient(env:Env,sourceId:string,workspaceId:string){
 const database=db(env);const row=await database.prepare(`${recipientSql(env)} AND w.id=? AND w.project_alpha_source_id=?`)
 .bind(workspaceId,sourceId).first<Recipient>();
 const proof=row&&await readPortalProjectionSourceProof(env,database,sourceId);
 if(!row||!proof)fail(409,'relationship_missing','Client connection is unavailable; refresh the client connection');
 if(row.claim_authority_id!==null&&(row.claim_source_id!==sourceId||row.claim_source_workspace_id!==row.source_workspace_id
  ||!Number.isSafeInteger(row.claim_ownership_epoch)||row.claim_ownership_epoch! < 1))
  fail(409,'relationship_missing','Client authority changed; refresh the client connection');
 const operationsAuthority=row.claim_authority_id===null?null:await readCurrentOperationsWorkspaceAuthority(env,row);
 if(row.claim_authority_id!==null&&!operationsAuthority)
  fail(409,'relationship_missing','Operations client authority is unavailable; refresh the client connection');
 const pin:DirectViewerClientRecipientAuthorityPin=row.claim_authority_id===null?{
  version:1,mode:'native_source',sourceId:row.project_alpha_source_id,workspaceId:row.id,sourceWorkspaceId:row.source_workspace_id,
  rootType:row.root_type,rootPublicId:row.root_public_id,
 }:{version:1,mode:'operations_native',sourceId:row.project_alpha_source_id,workspaceId:row.id,
  sourceWorkspaceId:row.source_workspace_id,rootType:row.root_type,rootPublicId:row.root_public_id,
  authorityId:row.claim_authority_id,ownershipEpoch:operationsAuthority!.ownershipEpoch,claimOwnershipEpoch:row.claim_ownership_epoch!};
 return {row,guard:portalProjectionSourceGuard(proof),pin,operationsAuthority};
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
 const page=rows.results.slice(0,q.limit);const clients=[],businessNames=new Map<string,string>(),sourceReadiness=new Map<string,boolean>();
 for(const row of page){
  if(row.claim_authority_id!==null&&!await readCurrentOperationsWorkspaceAuthority(env,row))continue;
  if(!sourceReadiness.has(row.project_alpha_source_id))sourceReadiness.set(row.project_alpha_source_id,
   !!await readPortalProjectionSourceProof(env,database,row.project_alpha_source_id));
  if(!sourceReadiness.get(row.project_alpha_source_id))continue;
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
function createReceiptGrant(value:unknown):DirectViewerClientGrantPublicResult {
 if(value&&typeof value==='object'&&!Array.isArray(value)&&('recipientAuthorityPin' in value||'version' in value)){
  const envelope=value as Record<string,unknown>,grant=envelope.grant;
  if(Object.keys(envelope).length!==3||envelope.version!==1||!('grant'in envelope)||!('recipientAuthorityPin'in envelope)
    ||!validRecipientAuthorityPin(envelope.recipientAuthorityPin)||!validCreateReceiptGrant(grant))
   fail(503,'grant_receipt_unavailable','Viewer share receipt is unavailable; contact support');
  return grant;
 }
 if(!validCreateReceiptGrant(value))fail(503,'grant_receipt_unavailable','Viewer share receipt is unavailable; contact support');
 return value;
}
function createReceiptAuthorityPin(value:unknown):DirectViewerClientRecipientAuthorityPin|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const envelope=value as Record<string,unknown>;
 return envelope.version===1&&validRecipientAuthorityPin(envelope.recipientAuthorityPin)?envelope.recipientAuthorityPin:null;
}
async function workspaceHasClaimHistory(env:Env,workspaceId:string):Promise<boolean>{
 const database=db(env);
 const present=await database.prepare(`SELECT 1 present FROM sqlite_master WHERE type='table'
   AND name='portal_client_authority_workspace_claims'`).first<number>('present');
 if(present!==1)return false;
 return !!await database.prepare(`SELECT 1 FROM portal_client_authority_workspace_claims WHERE workspace_id=? LIMIT 1`)
  .bind(workspaceId).first();
}
function validCreateReceiptGrant(value:unknown):value is DirectViewerClientGrantPublicResult{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const grant=value as Record<string,unknown>,keys=['grantId','sourceId','workspaceId','viewerProjectId','taskId','scopeType',
  'includeFuturePublished','permissions','expiresAt','grantVersion','revokedAt','createdAt','clientDisplayName'];
 if(Object.keys(grant).length!==keys.length||Object.keys(grant).some(key=>!keys.includes(key)))return false;
 const permissions=grant.permissions;
 if(!permissions||typeof permissions!=='object'||Array.isArray(permissions))return false;
 const permission=permissions as Record<string,unknown>;
 return typeof grant.grantId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(grant.grantId)
  &&typeof grant.sourceId==='string'&&/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(grant.sourceId)
  &&typeof grant.workspaceId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(grant.workspaceId)
  &&typeof grant.viewerProjectId==='string'&&typeof grant.scopeType==='string'
  &&(grant.scopeType==='task'?typeof grant.taskId==='string'&&grant.includeFuturePublished===false
    :grant.scopeType==='project'&&grant.taskId===null&&grant.includeFuturePublished===true)
  &&Object.keys(permission).length===3&&typeof permission.measure==='boolean'&&typeof permission.cameras==='boolean'
  &&typeof permission.download==='boolean'&&(grant.expiresAt===null||typeof grant.expiresAt==='string')
  &&grant.grantVersion===1&&grant.revokedAt===null&&typeof grant.createdAt==='string'
  &&(grant.clientDisplayName===null||typeof grant.clientDisplayName==='string');
}
function validRecipientAuthorityPin(value:unknown):value is DirectViewerClientRecipientAuthorityPin {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const pin=value as Record<string,unknown>;
 const common=['version','mode','sourceId','workspaceId','sourceWorkspaceId','rootType','rootPublicId'];
 const expected=pin.mode==='native_source'?common:pin.mode==='operations_native'?[...common,'authorityId','ownershipEpoch','claimOwnershipEpoch']:[];
 if(expected.length===0||Object.keys(pin).length!==expected.length||Object.keys(pin).some(key=>!expected.includes(key)))return false;
 return pin.version===1&&(pin.mode==='native_source'||pin.mode==='operations_native')
  &&typeof pin.sourceId==='string'&&/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(pin.sourceId)
  &&typeof pin.workspaceId==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(pin.workspaceId)
  &&typeof pin.sourceWorkspaceId==='string'&&pin.sourceWorkspaceId.length>0&&pin.sourceWorkspaceId.length<=200
  &&(pin.rootType==='organization'||pin.rootType==='standalone_client')
  &&typeof pin.rootPublicId==='string'&&pin.rootPublicId.length>0&&pin.rootPublicId.length<=191
  &&(pin.mode==='native_source'||(typeof pin.authorityId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pin.authorityId)
    &&Number.isSafeInteger(pin.ownershipEpoch)&&Number(pin.ownershipEpoch)>0
    &&Number.isSafeInteger(pin.claimOwnershipEpoch)&&Number(pin.claimOwnershipEpoch)>0));
}
export async function readDirectViewerClientGrantAuthorityPin(env:Env,grantId:string):Promise<DirectViewerClientRecipientAuthorityPin|null>{
 const rows=await db(env).prepare(`SELECT response_json FROM viewer_direct_client_grant_mutation_receipts
  WHERE grant_id=? AND action='grant.create' ORDER BY created_at LIMIT 2`).bind(grantId).all<{response_json:string}>();
 if(rows.results.length===0)return null;
 if(rows.results.length!==1)throw new Error('direct-viewer-grant-authority-receipt-ambiguous');
 let value:unknown;
 try{value=JSON.parse(rows.results[0]!.response_json);}catch{throw new Error('direct-viewer-grant-authority-receipt-invalid');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('direct-viewer-grant-authority-receipt-invalid');
 const envelope=value as Record<string,unknown>;
 // Existing raw public-result receipts remain identifiable as legacy. Anything
 // claiming to be a versioned envelope must validate fully or deny the read.
 if(!('recipientAuthorityPin'in envelope)&&!('version'in envelope))return null;
 if(Object.keys(envelope).length!==3||envelope.version!==1||!('grant'in envelope)||!('recipientAuthorityPin'in envelope))
  throw new Error('direct-viewer-grant-authority-receipt-invalid');
 const grant=envelope.grant,pin=envelope.recipientAuthorityPin;
 if(!validCreateReceiptGrant(grant)||grant.grantId!==grantId||!validRecipientAuthorityPin(pin)
  ||grant.workspaceId!==pin.workspaceId||grant.sourceId!==pin.sourceId)
  throw new Error('direct-viewer-grant-authority-receipt-invalid');
 return pin;
}
export function directViewerGrantMatchesRecipientAuthority(pin:DirectViewerClientRecipientAuthorityPin|null,
 context:{mode:'native'|'operations_native';sourceId:string;workspaceId:string;sourceWorkspaceId:string;rootType:'organization'|'standalone_client';
  rootPublicId:string;authorityId?:string;ownershipEpoch?:number;authorityOwnershipEpoch?:number}):boolean{
 if(!pin||pin.version!==1||pin.mode!==(context.mode==='native'?'native_source':'operations_native')
  ||pin.sourceId!==context.sourceId||pin.workspaceId!==context.workspaceId||pin.sourceWorkspaceId!==context.sourceWorkspaceId
  ||pin.rootType!==context.rootType||pin.rootPublicId!==context.rootPublicId)return false;
 return pin.mode==='native_source'||(pin.authorityId===context.authorityId&&pin.ownershipEpoch===context.authorityOwnershipEpoch
  &&pin.claimOwnershipEpoch===context.ownershipEpoch);
}
function mutationStatements(database:Pick<D1Database,'prepare'>,principal:StaffPrincipal,idempotencyKey:string,fingerprint:string,id:string,
 action:string,response:unknown,now:string,storedResponse:unknown=response){return [
 database.prepare(`INSERT INTO viewer_direct_client_grant_mutation_receipts VALUES(?,?,?,?,?,?,?)`)
 .bind(principal.id,idempotencyKey,action,fingerprint,id,JSON.stringify(storedResponse),now),
 database.prepare(`INSERT INTO viewer_direct_client_grant_audit VALUES(?,?,?,?,?,?,?)`)
 .bind(crypto.randomUUID(),id,action,principal.id,idempotencyKey,JSON.stringify(response),now)];}
export async function createDirectViewerClientGrant(input:{env:Env;principal:StaffPrincipal;grant:unknown;idempotencyKey:string;request:Request})
 :Promise<{grant:DirectViewerClientGrantPublicResult;replayed:boolean}>{
 const {env,principal}=input;await manage(env,principal);const parsed=inputSchema.safeParse(input.grant);
 if(!parsed.success||!key.safeParse(input.idempotencyKey).success)fail(400,'invalid_request','Invalid Viewer sharing request');
 const g=parsed.data,fingerprint=await sha256(JSON.stringify(['direct.create',g]));
 const prior=await receipt(env,principal.id,input.idempotencyKey,fingerprint);
 if(prior){
  const priorPin=createReceiptAuthorityPin(prior);
  if(priorPin){
   const current=await recipient(env,g.sourceId,g.workspaceId);
   if(JSON.stringify(priorPin)!==JSON.stringify(current.pin))
    fail(409,'relationship_missing','Client authority changed; refresh the client connection');
  }else{
   // Pre-pin receipts cannot establish that a share was created for a later
   // Operations owner. Preserve replay only for currently native recipients.
   const current=await recipient(env,g.sourceId,g.workspaceId);
   if(current.pin.mode==='operations_native'||await workspaceHasClaimHistory(env,g.workspaceId))
    fail(409,'relationship_missing','Client authority changed; refresh the client connection');
  }
  return {grant:createReceiptGrant(prior),replayed:true};
 }
 if(g.expiresAt!==null&&Date.parse(g.expiresAt)<=Date.now())fail(400,'expired_at_invalid','Expiration must be in the future');
 let catalog;
 try{catalog=await viewerServiceClient(env).clientDeliveryCatalog({projectId:g.viewerProjectId,...(g.taskId?{taskId:g.taskId}:{})});}
 catch(error){
  if(error instanceof ViewerServiceError){
   if(error.code==='not_found')fail(409,g.taskId?'task_not_published':'relationship_missing',g.taskId
    ?'This task is not currently published in the selected Viewer project':'This Viewer project is unavailable');
   fail(503,'viewer_unavailable','Viewer is temporarily unavailable. Please try again.');
  }
  throw error;
 }
 if(catalog.project.id!==g.viewerProjectId)fail(409,'task_not_in_project','Viewer project does not match');
 if(g.taskId&&(catalog.tasks.length!==1||catalog.tasks[0]?.id!==g.taskId))fail(409,'task_not_published','Task is not published in this project');
 // Recheck recipient authority after the remote catalog request, then pin it in the INSERT itself.
 const {row,guard,operationsAuthority,pin}=await recipient(env,g.sourceId,g.workspaceId),database=db(env),id=crypto.randomUUID(),now=new Date().toISOString();
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
 AND checkpoint.active_generation_id=? AND checkpoint.source_sequence=? AND root.source_version=?
 AND claim.client_authority_id IS ? AND claim.projection_source_id IS ? AND claim.source_workspace_id IS ? AND claim.ownership_epoch IS ?
 ${operationsAuthority?`AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads authority
   JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=authority.target_id
     AND publication.target_revision=authority.target_revision AND publication.client_authority_id=authority.client_authority_id
     AND publication.workspace_id=authority.workspace_id AND publication.root_kind=authority.root_kind
     AND publication.root_record_id=authority.root_record_id
   JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=publication.snapshot_id
     AND snapshot.operation_id=publication.latest_operation_id AND snapshot.target_id=publication.target_id
     AND snapshot.revision=publication.revision AND snapshot.source_sequence=publication.source_sequence
     AND snapshot.snapshot_sha256=publication.snapshot_sha256
   JOIN operations_portal_workspace_publication_receipts receipt ON receipt.operation_id=publication.latest_operation_id
     AND receipt.target_id=publication.target_id AND receipt.resulting_revision=publication.revision
     AND receipt.source_sequence=publication.source_sequence AND receipt.snapshot_id=snapshot.snapshot_id
     AND receipt.snapshot_sha256=snapshot.snapshot_sha256
   JOIN operations_portal_workspace_publication_history history ON history.operation_id=receipt.operation_id
     AND history.target_id=publication.target_id AND history.revision=publication.revision
     AND history.source_sequence=publication.source_sequence AND history.snapshot_id=snapshot.snapshot_id
     AND history.snapshot_sha256=snapshot.snapshot_sha256
   WHERE authority.client_authority_id=claim.client_authority_id AND authority.workspace_id=w.id AND authority.state='active'
     AND authority.target_id=? AND authority.target_revision=? AND authority.ownership_epoch=? AND authority.root_kind=w.root_type)`:''})`)
 .bind(id,g.sourceId,g.workspaceId,g.viewerProjectId,g.taskId,g.scopeType,+g.includeFuturePublished,+g.permissions.measure,+g.permissions.cameras,+g.permissions.download,
 g.expiresAt,principal.id,now,now,...guard.bindings,g.workspaceId,g.sourceId,row.active_generation_id,row.source_sequence,row.root_version,
 row.claim_authority_id,row.claim_source_id,row.claim_source_workspace_id,row.claim_ownership_epoch,
 ...(operationsAuthority?[operationsAuthority.targetId,operationsAuthority.targetRevision,operationsAuthority.ownershipEpoch]:[])),
 ...mutationStatements(database,principal,input.idempotencyKey,fingerprint,id,'grant.create',result,now,
   {version:1,grant:result,recipientAuthorityPin:pin} satisfies CreateReceiptEnvelope)]);
 }catch(error){const replay=await receipt(env,principal.id,input.idempotencyKey,fingerprint);if(replay){
   const current=await recipient(env,g.sourceId,g.workspaceId),priorPin=createReceiptAuthorityPin(replay);
   if((priorPin&&JSON.stringify(priorPin)!==JSON.stringify(current.pin))
    ||(!priorPin&&(current.pin.mode==='operations_native'||await workspaceHasClaimHistory(env,g.workspaceId))))
    fail(409,'relationship_missing','Client authority changed; refresh the client connection');
   return {grant:createReceiptGrant(replay),replayed:true};}
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
