import {HTTPException} from 'hono/http-exception';
import {PRIMARY_ALPHA_SOURCE_ID as PRIMARY_PROJECT_ALPHA_SOURCE_ID} from '@ltds/shared';
import {authorizePortalWorkspaceCapability,type PortalAuthorizationEnv,type PortalWorkspaceCapability,type PortalWorkspaceTarget} from './workspace-v2';
import type {VerifiedClientPrincipal} from './types';
import {captureWorkspaceInvitationDelegation} from './project-invitation-delegation';
import {prepareProjectAccessTerms,readProjectAccessTerms,projectAccessTermsSql,type ProjectAccessTermsInput,type ProjectAccessTermsView} from './project-access-terms';
import {invitationRecipientEmailHash} from './access-enrollment-receipts';
import {invitationRequestsReady} from './invitation-approval-policy';
export {invitationRequestsReady} from './invitation-approval-policy';

export type WorkspaceInvitationPolicy='allowed'|'disabled'|'require_approval';
export interface InvitationApprovalAuthorization {id:string;actorStaffId:string;fingerprint:string;publicationDeadline:string}
export interface InvitationRequestCoordinates {sourceId:string;workspaceId:string;requestId:string}
export interface WorkspaceInvitationRequestView {
 id:string;workspaceId:string;sourceId:string;sourceName:string;workspaceName:string;
 requesterIdentityId:string;requesterEmail:string|null;version:number;
 status:'pending'|'approving'|'approved'|'rejected'|'cancelled'|'stale';
 email:string;scope:{type:'workspace'|'organization'|'department'|'client'|'project';publicId:string};
 capabilities:PortalWorkspaceCapability[];accessTerms:ProjectAccessTermsView|null;policyVersion:number;
 createdAt:string;updatedAt:string;invitationId:string|null;reasonCode:string|null;canCancel:boolean;
}
export interface WorkspaceInvitationPolicyContext {sourceId:string;workspaceId:string;workspaceName:string;policy:WorkspaceInvitationPolicy;version:number;contextVersion:string}
export interface InvitationRequestAfter {createdAt:string;id:string}
export type InvitationApprovalDatabase=Pick<D1Database,'prepare'|'batch'>;
export interface InvitationRequestListInput {sourceId?:string;workspaceId?:string;status?:WorkspaceInvitationRequestView['status']|'open';q?:string;
 after?:InvitationRequestAfter;limit?:number;requesterIdentityId?:string}
export interface InvitationReviewInput extends InvitationRequestCoordinates {expectedVersion:number;expectedContextVersion:string;
 authorization:InvitationApprovalAuthorization;idempotencyKey:string}
interface RequestRow {id:string;workspace_id:string;source_id:string;requester_identity_id:string;recipient_email:string;
 scope_type:WorkspaceInvitationRequestView['scope']['type'];scope_public_id:string;capabilities_json:string;access_terms_id:string|null;
 request_hash:string;policy_version:number;status:'pending'|'approving'|'approved'|'rejected'|'cancelled';version:number;
 current_approval_id:string|null;reason_code:string|null;created_at:string;updated_at:string;
 workspace_name:string;requester_email:string|null;invitation_id:string|null;current_policy:string;current_policy_version:number}
interface ApprovalRow {id:string;request_id:string;request_version:number;invitation_id:string;actor_staff_id:string;
 authorization_fingerprint:string;context_version:string;delegation_proof:string;publication_deadline:string;status:'staged'|'published'|'closed'}
const requestSelect=`SELECT r.*,w.display_name workspace_name,i.verified_email requester_email,a.invitation_id,
 p.policy current_policy,p.version current_policy_version FROM portal_workspace_invitation_requests r
 JOIN portal_v2_workspaces w ON w.id=r.workspace_id AND w.project_alpha_source_id=r.source_id
 JOIN pa_portal_workspace_sources source ON source.workspace_id=w.id AND source.projection_source_id=r.source_id
 JOIN portal_v2_identities i ON i.id=r.requester_identity_id
 JOIN portal_workspace_invitation_policies p ON p.workspace_id=r.workspace_id
 LEFT JOIN portal_workspace_invitation_approvals a ON a.id=r.current_approval_id`;
const policyProofSql=`SELECT json_object('workspace',w.id,'source',w.project_alpha_source_id,'name',w.display_name,'status',w.status,
 'rootType',w.root_type,'rootId',COALESCE(w.pa_organization_public_id,w.pa_client_public_id),'legacyAccount',w.legacy_account_id,
 'externalWorkspace',s.source_workspace_id,'policy',COALESCE(p.policy,'allowed'),'version',COALESCE(p.version,0)) proof
 FROM portal_v2_workspaces w JOIN pa_portal_workspace_sources s ON s.workspace_id=w.id AND s.projection_source_id=w.project_alpha_source_id
 LEFT JOIN portal_workspace_invitation_policies p ON p.workspace_id=w.id WHERE w.id=? AND w.project_alpha_source_id=?`;
const iso=(value:string)=>/^\d{4}-\d{2}-\d{2} /.test(value)?`${value.replace(' ','T')}Z`:value;
function fail(status:400|403|404|409|429|503,code:string):never{throw new HTTPException(status,{message:code});}
async function ready(db:InvitationApprovalDatabase){if(!await invitationRequestsReady(db))fail(503,'invitation_requests_unavailable');}
export async function invitationApprovalDigest(value:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function key(value:string){if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value))fail(400,'invitation_request_invalid');}
function auth(value:InvitationApprovalAuthorization){if(!/^[a-f0-9]{64}$/.test(value.fingerprint)||!value.id||!value.actorStaffId
 ||!Number.isFinite(Date.parse(value.publicationDeadline))||Date.parse(value.publicationDeadline)<=Date.now()
 ||Date.parse(value.publicationDeadline)>Date.now()+10*60_000)fail(409,'invitation_authorization_expired');}
function fence(db:InvitationApprovalDatabase,condition:string,values:unknown[]):D1PreparedStatement{return db.prepare(`INSERT INTO portal_workspace_invitation_approval_fences(id,write_guard)
 VALUES(?,CASE WHEN (${condition}) THEN 1 ELSE 0 END)`).bind(crypto.randomUUID(),...values);}
function audit(db:InvitationApprovalDatabase,workspaceId:string,requestId:string|null,actorType:'staff'|'identity',actorId:string,action:string,authorizationId:string|null,details:unknown){
 return db.prepare(`INSERT INTO portal_workspace_invitation_request_audit(id,workspace_id,request_id,actor_type,actor_id,action,authorization_id,details_json)
 VALUES(?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),workspaceId,requestId,actorType,actorId,action,authorizationId,JSON.stringify(details));
}
async function command(db:InvitationApprovalDatabase,workspaceId:string,actorId:string,idempotencyKey:string,operation:string,hash:string){
 key(idempotencyKey);
 const row=await db.prepare(`SELECT operation,request_hash,request_id,authorization_id,result_json FROM portal_workspace_invitation_request_commands
 WHERE workspace_id=? AND actor_id=? AND idempotency_key=?`).bind(workspaceId,actorId,idempotencyKey)
 .first<{operation:string;request_hash:string;request_id:string|null;authorization_id:string|null;result_json:string}>();
 if(row&&(row.operation!==operation||row.request_hash!==hash))fail(409,'invitation_idempotency_conflict');return row;
}
function commandInsert(db:InvitationApprovalDatabase,workspaceId:string,actorId:string,idempotencyKey:string,operation:string,hash:string,requestId:string|null,authorizationId:string|null,result:unknown){
 return db.prepare(`INSERT INTO portal_workspace_invitation_request_commands(workspace_id,actor_id,idempotency_key,operation,request_hash,request_id,authorization_id,result_json)
 VALUES(?,?,?,?,?,?,?,?)`).bind(workspaceId,actorId,idempotencyKey,operation,hash,requestId,authorizationId,JSON.stringify(result));
}
async function row(db:InvitationApprovalDatabase,input:InvitationRequestCoordinates):Promise<RequestRow|null>{return db.prepare(`${requestSelect} WHERE r.id=? AND r.workspace_id=? AND r.source_id=?`)
 .bind(input.requestId,input.workspaceId,input.sourceId).first<RequestRow>();}
async function view(db:InvitationApprovalDatabase,r:RequestRow):Promise<WorkspaceInvitationRequestView>{
 const terms=r.access_terms_id?await readProjectAccessTerms(db,r.access_terms_id):null;
 const stale=r.status==='pending'&&(r.current_policy!=='require_approval'||r.current_policy_version!==r.policy_version||Boolean(terms?.expired));
 return {id:r.id,workspaceId:r.workspace_id,sourceId:r.source_id,sourceName:r.source_id===PRIMARY_PROJECT_ALPHA_SOURCE_ID?'Project Alpha':r.source_id,
 workspaceName:r.workspace_name,requesterIdentityId:r.requester_identity_id,requesterEmail:r.requester_email,version:r.version,
 status:stale?'stale':r.status,email:r.recipient_email,scope:{type:r.scope_type,publicId:r.scope_public_id},
 capabilities:JSON.parse(r.capabilities_json) as PortalWorkspaceCapability[],accessTerms:terms,policyVersion:r.policy_version,
 createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),invitationId:r.status==='approved'?r.invitation_id:null,
 reasonCode:stale?'invitation_request_stale':r.reason_code,canCancel:r.status==='pending'||r.status==='approving'};
}
export async function readWorkspaceInvitationRequest(db:InvitationApprovalDatabase,input:InvitationRequestCoordinates):Promise<WorkspaceInvitationRequestView|null>{
 await ready(db);const r=await row(db,input);return r?view(db,r):null;
}
/** Used by both issuance lanes before deciding whether this retry would create
 * an invitation or an approval request. The schema repeats this namespace
 * check inside each lane's transaction for policy-flip/concurrent races. */
export async function replaySubmittedWorkspaceInvitationRequest(db:InvitationApprovalDatabase,input:{workspaceId:string;actorId:string;idempotencyKey:string;requestHash:string}){
 const saved=await command(db,input.workspaceId,input.actorId,input.idempotencyKey,'submit',input.requestHash);
 return saved?.request_id?readWorkspaceInvitationRequest(db,{workspaceId:input.workspaceId,sourceId:PRIMARY_PROJECT_ALPHA_SOURCE_ID,requestId:saved.request_id}):null;
}
async function submissionLimited(db:InvitationApprovalDatabase,workspaceId:string,actorId:string){return (await db.prepare(`SELECT 1 limited FROM portal_v2_invitation_rate_limits
 WHERE workspace_id=? AND actor_identity_id=? AND datetime(window_started_at,'+1 hour')>datetime('now') AND request_count>=10`).bind(workspaceId,actorId).first('limited'))!==null;}
export async function listWorkspaceInvitationRequests(db:InvitationApprovalDatabase,input:InvitationRequestListInput={}){
 await ready(db);const limit=input.limit??25;if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail(400,'invitation_request_invalid');
 const q=(input.q??'').normalize('NFC').trim().toLocaleLowerCase('en-US');if(q.length>100)fail(400,'invitation_request_invalid');
 const clauses:string[]=[],values:unknown[]=[];
 for(const [column,value] of [['r.source_id',input.sourceId],['r.workspace_id',input.workspaceId],['r.requester_identity_id',input.requesterIdentityId]] as const){
  if(value!==undefined){clauses.push(`${column}=?`);values.push(value);}}
 const staleSql=`(p.policy<>'require_approval' OR p.version<>r.policy_version OR NOT ${projectAccessTermsSql({termsId:'r.access_terms_id',workspaceId:'r.workspace_id',projectId:'r.scope_public_id',legacyRetained:'1'})})`;
 const oldest=input.status!==undefined&&['open','pending','approving','stale'].includes(input.status);
 if(input.status==='open')clauses.push("r.status IN ('pending','approving')");
 else if(input.status==='stale')clauses.push(`r.status='pending' AND ${staleSql}`);
 else if(input.status==='pending')clauses.push(`r.status='pending' AND NOT ${staleSql}`);
 else if(input.status){if(!['pending','approving','approved','rejected','cancelled','stale'].includes(input.status))fail(400,'invitation_request_invalid');
  clauses.push('r.status=?');values.push(input.status);}
 if(q){clauses.push("(instr(lower(r.recipient_email),?)>0 OR instr(lower(COALESCE(i.verified_email,'')),?)>0 OR instr(lower(w.display_name),?)>0)");values.push(q,q,q);}
 if(input.after){const operator=oldest?'>':'<';clauses.push(`(r.created_at${operator}? OR (r.created_at=? AND r.id${operator}?))`);values.push(input.after.createdAt,input.after.createdAt,input.after.id);}
 const direction=oldest?'ASC':'DESC';
 const rows=(await db.prepare(`${requestSelect}${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY r.created_at ${direction},r.id ${direction} LIMIT ?`).bind(...values,limit+1).all<RequestRow>()).results;
 const hasMore=rows.length>limit,selected=rows.slice(0,limit),last=selected.at(-1);
 return {items:await Promise.all(selected.map(r=>view(db,r))),hasMore,nextAfter:hasMore&&last?{createdAt:last.created_at,id:last.id}:null};
}
export async function readWorkspaceInvitationPolicyContext(db:InvitationApprovalDatabase,input:{sourceId:string;workspaceId:string}):Promise<WorkspaceInvitationPolicyContext>{
 await ready(db);const proof=await db.prepare(policyProofSql).bind(input.workspaceId,input.sourceId).first<string>('proof');if(!proof)fail(404,'invitation_workspace_unavailable');
 const state=JSON.parse(proof) as {name:string;policy:WorkspaceInvitationPolicy;version:number};
 return {sourceId:input.sourceId,workspaceId:input.workspaceId,workspaceName:state.name,policy:state.policy,version:state.version,contextVersion:await invitationApprovalDigest(proof)};
}
export async function applyWorkspaceInvitationPolicy(db:InvitationApprovalDatabase,input:{sourceId:string;workspaceId:string;policy:WorkspaceInvitationPolicy;expectedVersion:number;
 expectedContextVersion:string;authorization:InvitationApprovalAuthorization;idempotencyKey:string}){
 await ready(db);const hash=await invitationApprovalDigest(JSON.stringify({sourceId:input.sourceId,workspaceId:input.workspaceId,policy:input.policy,
 expectedVersion:input.expectedVersion,contextVersion:input.expectedContextVersion}));
 const saved=await command(db,input.workspaceId,input.authorization.actorStaffId,input.idempotencyKey,'policy',hash);
 if(saved)return {policy:await readWorkspaceInvitationPolicyContext(db,input),replayed:true};
 auth(input.authorization);if(!['allowed','disabled','require_approval'].includes(input.policy))fail(400,'invitation_request_invalid');
 const current=await readWorkspaceInvitationPolicyContext(db,input);
 if(current.version!==input.expectedVersion||current.contextVersion!==input.expectedContextVersion)fail(409,'invitation_policy_changed');
 const proof=await db.prepare(policyProofSql).bind(input.workspaceId,input.sourceId).first<string>('proof');
 if(!proof||await invitationApprovalDigest(proof)!==current.contextVersion)fail(409,'invitation_policy_changed');
 const result={...current,policy:input.policy,version:current.version+1};
 try{await db.batch([fence(db,`((${policyProofSql})=?) AND datetime(?)>datetime('now')`,[input.workspaceId,input.sourceId,proof,input.authorization.publicationDeadline]),
  current.version===0?db.prepare(`INSERT INTO portal_workspace_invitation_policies(workspace_id,policy,version,updated_by_staff_id) VALUES(?,?,1,?)`).bind(input.workspaceId,input.policy,input.authorization.actorStaffId)
   :db.prepare(`UPDATE portal_workspace_invitation_policies SET policy=?,version=version+1,updated_by_staff_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND version=?`)
    .bind(input.policy,input.authorization.actorStaffId,input.workspaceId,current.version),
  commandInsert(db,input.workspaceId,input.authorization.actorStaffId,input.idempotencyKey,'policy',hash,null,input.authorization.id,result),
  audit(db,input.workspaceId,null,'staff',input.authorization.actorStaffId,'policy.changed',input.authorization.id,{from:current.policy,to:input.policy,version:result.version})]);
 }catch(error){const raced=await command(db,input.workspaceId,input.authorization.actorStaffId,input.idempotencyKey,'policy',hash);if(raced)return {policy:await readWorkspaceInvitationPolicyContext(db,input),replayed:true};throw error;}
 return {policy:await readWorkspaceInvitationPolicyContext(db,input),replayed:false};
}

async function delegation(env:PortalAuthorizationEnv,r:RequestRow){
 const principal=await env.DELIVERY_DB.prepare(`SELECT issuer,subject,verified_email email FROM portal_v2_identities
  WHERE id=? AND status='active' AND revoked_at IS NULL`).bind(r.requester_identity_id).first<VerifiedClientPrincipal>();
 if(!principal?.email)fail(403,'invitation_requester_unavailable');
 const terms=r.access_terms_id?await readProjectAccessTerms(env.DELIVERY_DB,r.access_terms_id):null;
 if(r.scope_type==='project'&&(!terms||terms.expired))fail(409,'invitation_access_terms_expired');
 const capabilities=JSON.parse(r.capabilities_json) as PortalWorkspaceCapability[];
 const target:PortalWorkspaceTarget={scopeType:r.scope_type,publicId:r.scope_public_id};
 const proof=await captureWorkspaceInvitationDelegation(env,{workspaceId:r.workspace_id,target,identityId:r.requester_identity_id,
  ...principal,email:principal.email.trim().toLowerCase()},capabilities,terms);
 for(const capability of new Set<PortalWorkspaceCapability>(['member.manage','workspace.view',...capabilities])){
  if(!await authorizePortalWorkspaceCapability(env,principal,r.workspace_id,capability,capability==='workspace.view'?{scopeType:'workspace',publicId:r.workspace_id}:target))
   fail(403,'invitation_requester_authority_changed');
 }
 return proof;
}
async function review(env:PortalAuthorizationEnv,input:InvitationRequestCoordinates){
 await ready(env.DELIVERY_DB);const r=await row(env.DELIVERY_DB,input);if(!r)fail(404,'invitation_request_unavailable');
 const request=await view(env.DELIVERY_DB,r),workspace=await readWorkspaceInvitationPolicyContext(env.DELIVERY_DB,input);
 let proof:Awaited<ReturnType<typeof delegation>>|null=null,unavailableReason:string|null=null;
 if(env.CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED!=='true'||env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED!=='true')unavailableReason='invitation_management_unavailable';
 else if(r.status!=='pending'&&r.status!=='approving')unavailableReason='invitation_request_decided';
 else if(request.status==='stale'||workspace.policy!=='require_approval'||workspace.version!==r.policy_version)unavailableReason='invitation_policy_changed';
 else if(input.sourceId!==PRIMARY_PROJECT_ALPHA_SOURCE_ID)unavailableReason='invitation_source_unsupported';
 else try{proof=await delegation(env,r);}catch(error){if(error instanceof HTTPException)unavailableReason=error.message;else throw error;}
 // Review identity is independent of Approve versus Reject. Approval captures
 // and atomically checks current delegation separately; stale requests remain
 // rejectable without inventing authority for their original requester.
 const contextVersion=await invitationApprovalDigest(JSON.stringify({request:{...request,canCancel:false},workspace}));
 return {r,proof,request,contextVersion,policyVersion:workspace.version,canApprove:unavailableReason===null,unavailableReason};
}
export async function prepareWorkspaceInvitationDecision(env:PortalAuthorizationEnv,input:InvitationRequestCoordinates&{decision:'approve'|'reject'}){
 const {request,contextVersion,policyVersion,canApprove,unavailableReason}=await review(env,input);
 return {request,contextVersion,policyVersion,canApprove,unavailableReason};
}
function requestFence(db:InvitationApprovalDatabase,r:RequestRow){return fence(db,`EXISTS(SELECT 1 FROM portal_workspace_invitation_requests r JOIN portal_workspace_invitation_policies p ON p.workspace_id=r.workspace_id
 WHERE r.id=? AND r.version=? AND r.status=? AND p.policy='require_approval' AND p.version=r.policy_version
 AND ${projectAccessTermsSql({termsId:'r.access_terms_id',workspaceId:'r.workspace_id',projectId:'r.scope_public_id',legacyRetained:'1'})})`,[r.id,r.version,r.status]);}

export async function submitWorkspaceInvitationRequest(env:PortalAuthorizationEnv,principal:VerifiedClientPrincipal,input:{workspaceId:string;requesterIdentityId:string;
 email:string;target:PortalWorkspaceTarget;capabilities:PortalWorkspaceCapability[];accessTerms?:ProjectAccessTermsInput;requestHash:string;idempotencyKey:string}){
 const db=env.DELIVERY_DB;await ready(db);
 const saved=await command(db,input.workspaceId,input.requesterIdentityId,input.idempotencyKey,'submit',input.requestHash);
 const coordinates={sourceId:PRIMARY_PROJECT_ALPHA_SOURCE_ID,workspaceId:input.workspaceId};
 if(saved?.request_id){const request=await readWorkspaceInvitationRequest(db,{...coordinates,requestId:saved.request_id});if(!request)fail(409,'invitation_request_unavailable');return {request,replayed:true};}
 if(await db.prepare('SELECT 1 used FROM portal_v2_invitation_commands WHERE workspace_id=? AND actor_identity_id=? AND idempotency_key=?')
  .bind(input.workspaceId,input.requesterIdentityId,input.idempotencyKey).first('used'))fail(409,'invitation_idempotency_conflict');
 if(await submissionLimited(db,input.workspaceId,input.requesterIdentityId))fail(429,'invitation_rate_limited');
 const policy=await readWorkspaceInvitationPolicyContext(db,coordinates);
 if(policy.policy!=='require_approval')fail(409,'invitation_policy_changed');
 if(input.target.scopeType==='project'&&!input.accessTerms)fail(400,'invitation_project_terms_required');
 if(input.target.scopeType!=='project'&&input.accessTerms)fail(400,'invitation_request_invalid');
 const id=crypto.randomUUID();const terms=input.accessTerms?await prepareProjectAccessTerms(db,{...coordinates,projectPublicId:input.target.publicId},
  input.accessTerms,{type:'identity',id:input.requesterIdentityId},`invitation-request-${id}`):null;
 const proof=await captureWorkspaceInvitationDelegation(env,{workspaceId:input.workspaceId,target:input.target,identityId:input.requesterIdentityId,
  ...principal,email:principal.email.trim().toLowerCase()},input.capabilities,terms?.view??null);
 for(const capability of new Set<PortalWorkspaceCapability>(['member.manage','workspace.view',...input.capabilities])){
  if(!await authorizePortalWorkspaceCapability(env,principal,input.workspaceId,capability,capability==='workspace.view'?{scopeType:'workspace',publicId:input.workspaceId}:input.target))fail(403,'invitation_requester_authority_changed');
 }
 try{await db.batch([proof.fence(`request-${id}`),
  fence(db,`NOT EXISTS(SELECT 1 FROM portal_v2_invitation_rate_limits WHERE workspace_id=? AND actor_identity_id=? AND datetime(window_started_at,'+1 hour')>datetime('now') AND request_count>=10)`,[input.workspaceId,input.requesterIdentityId]),
  ...(terms?[terms.statement,fence(db,`EXISTS(SELECT 1 FROM portal_project_access_terms submitted_term WHERE submitted_term.id=?
    AND ${projectAccessTermsSql({termsId:'submitted_term.id',workspaceId:'submitted_term.workspace_id',projectId:'submitted_term.project_public_id',legacyRetained:'0'})})`,[terms.id])]:[]),db.prepare(`INSERT INTO portal_workspace_invitation_requests(id,workspace_id,source_id,requester_identity_id,recipient_email,scope_type,scope_public_id,capabilities_json,access_terms_id,request_hash,policy_version)
   VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id,input.workspaceId,coordinates.sourceId,input.requesterIdentityId,input.email,input.target.scopeType,input.target.publicId,JSON.stringify(input.capabilities),terms?.id??null,input.requestHash,policy.version),
  commandInsert(db,input.workspaceId,input.requesterIdentityId,input.idempotencyKey,'submit',input.requestHash,id,null,{requestId:id}),
  db.prepare(`INSERT INTO portal_v2_invitation_rate_limits(workspace_id,actor_identity_id,window_started_at,request_count) VALUES(?,?,datetime('now'),1)
   ON CONFLICT(workspace_id,actor_identity_id) DO UPDATE SET window_started_at=CASE WHEN datetime(window_started_at,'+1 hour')<=datetime('now') THEN datetime('now') ELSE window_started_at END,
   request_count=CASE WHEN datetime(window_started_at,'+1 hour')<=datetime('now') THEN 1 ELSE request_count+1 END`).bind(input.workspaceId,input.requesterIdentityId),
  audit(db,input.workspaceId,id,'identity',input.requesterIdentityId,'request.submitted',null,{scope:input.target,policyVersion:policy.version})]);
 }catch(error){const raced=await command(db,input.workspaceId,input.requesterIdentityId,input.idempotencyKey,'submit',input.requestHash);
  if(raced?.request_id){const request=await readWorkspaceInvitationRequest(db,{...coordinates,requestId:raced.request_id});if(request)return {request,replayed:true};}
  if(await submissionLimited(db,input.workspaceId,input.requesterIdentityId))fail(429,'invitation_rate_limited');throw error;}
 return {request:(await readWorkspaceInvitationRequest(db,{...coordinates,requestId:id}))!,replayed:false};
}

export async function stageApprovedWorkspaceInvitation(env:PortalAuthorizationEnv,input:InvitationReviewInput&{expectedPolicyVersion:number}){
 const db=env.DELIVERY_DB;await ready(db);const hash=await invitationApprovalDigest(JSON.stringify({sourceId:input.sourceId,workspaceId:input.workspaceId,requestId:input.requestId,
  version:input.expectedVersion,policy:input.expectedPolicyVersion,context:input.expectedContextVersion}));
 const saved=await command(db,input.workspaceId,input.authorization.actorStaffId,input.idempotencyKey,'approve',hash);
 if(saved){const request=await readWorkspaceInvitationRequest(db,input);if(!request)fail(404,'invitation_request_unavailable');return {request,replayed:true};}
 auth(input.authorization);const prepared=await review(env,input);
 if(!prepared.canApprove||!prepared.proof||prepared.r.status!=='pending'||prepared.r.version!==input.expectedVersion||prepared.policyVersion!==input.expectedPolicyVersion||prepared.contextVersion!==input.expectedContextVersion){
  const winner=await command(db,input.workspaceId,input.authorization.actorStaffId,input.idempotencyKey,'approve',hash);
  if(winner){const request=await readWorkspaceInvitationRequest(db,input);if(request)return {request,replayed:true};}
  fail(409,prepared.unavailableReason??'invitation_request_changed');
 }
 const r=prepared.r,invitationId=crypto.randomUUID(),tokenBytes=crypto.getRandomValues(new Uint8Array(32));
 const token=btoa(String.fromCharCode(...tokenBytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const tokenDigest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));
 const tokenHash=btoa(String.fromCharCode(...tokenDigest)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
 const recipientHash=await invitationRecipientEmailHash(r.recipient_email);if(!recipientHash)fail(400,'invitation_request_invalid');
 const expiresAt=new Date(Date.now()+7*86400_000).toISOString(),caps=new Set<PortalWorkspaceCapability>(['workspace.view',...prepared.request.capabilities]);
 try{await db.batch([prepared.proof.fence(`approval-${input.authorization.id}`),requestFence(db,r),
  db.prepare(`INSERT INTO portal_workspace_invitation_approvals(id,request_id,request_version,invitation_id,actor_staff_id,authorization_fingerprint,context_version,delegation_proof,publication_deadline)
   VALUES(?,?,?,?,?,?,?,?,?)`).bind(input.authorization.id,r.id,r.version,invitationId,input.authorization.actorStaffId,input.authorization.fingerprint,input.expectedContextVersion,prepared.proof.proof,input.authorization.publicationDeadline),
  db.prepare(`UPDATE portal_workspace_invitation_requests SET status='approving',current_approval_id=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=? AND status='pending'`).bind(input.authorization.id,r.id,r.version),
  db.prepare(`INSERT INTO portal_v2_invitations(id,workspace_id,token_hash,invited_email,invited_by_identity_id,expires_at) VALUES(?,?,?,?,?,?)`).bind(invitationId,r.workspace_id,tokenHash,r.recipient_email,r.requester_identity_id,expiresAt),
  ...[...caps].map(capability=>db.prepare(`INSERT INTO portal_v2_invitation_entitlements(invitation_id,capability,scope_type,scope_public_id,access_terms_id) VALUES(?,?,?,?,?)`)
   .bind(invitationId,capability,capability==='workspace.view'?'workspace':r.scope_type,capability==='workspace.view'?r.workspace_id:r.scope_public_id,r.access_terms_id)),
  db.prepare(`INSERT INTO portal_v2_invitation_email_outbox(id,invitation_id,recipient_email,payload_json,recipient_email_hash) VALUES(?,?,?,?,?)`)
   .bind(crypto.randomUUID(),invitationId,r.recipient_email,JSON.stringify({invitationId,token,expiresAt}),recipientHash),
  commandInsert(db,r.workspace_id,input.authorization.actorStaffId,input.idempotencyKey,'approve',hash,r.id,input.authorization.id,{requestId:r.id}),
  audit(db,r.workspace_id,r.id,'staff',input.authorization.actorStaffId,'request.approval_staged',input.authorization.id,{invitationId})]);
 }catch(error){const raced=await command(db,input.workspaceId,input.authorization.actorStaffId,input.idempotencyKey,'approve',hash);if(raced){const request=await readWorkspaceInvitationRequest(db,input);if(request)return {request,replayed:true};}throw error;}
 return {request:(await readWorkspaceInvitationRequest(db,input))!,replayed:false};
}
export async function publishApprovedWorkspaceInvitation(env:PortalAuthorizationEnv,input:{authorizationId:string}){
 const db=env.DELIVERY_DB;await ready(db);const a=await db.prepare('SELECT * FROM portal_workspace_invitation_approvals WHERE id=?').bind(input.authorizationId).first<ApprovalRow>();
 if(!a)fail(404,'invitation_approval_unavailable');
 const r=await db.prepare(`${requestSelect} WHERE r.id=?`).bind(a.request_id).first<RequestRow>();if(!r)fail(404,'invitation_request_unavailable');
 if(a.status==='published'&&r.status==='approved'&&r.current_approval_id===a.id)return view(db,r);
 if(a.status!=='staged'||r.status!=='approving'||r.current_approval_id!==a.id)fail(409,'invitation_approval_changed');
 try{const prepared=await review(env,{sourceId:r.source_id,workspaceId:r.workspace_id,requestId:r.id});
 if(!prepared.canApprove||!prepared.proof||prepared.proof.proof!==a.delegation_proof)fail(409,'invitation_requester_authority_changed');
 await db.batch([prepared.proof.fence(`publication-${a.id}`),requestFence(db,r),
  db.prepare(`UPDATE portal_workspace_invitation_approvals SET status='published',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='staged'`).bind(a.id),
  db.prepare(`UPDATE portal_workspace_invitation_requests SET status='approved',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=? AND status='approving' AND current_approval_id=?`).bind(r.id,r.version,a.id),
  audit(db,r.workspace_id,r.id,'staff',a.actor_staff_id,'request.approved',a.id,{invitationId:a.invitation_id})]);
 }catch(error){
  const winner=await db.prepare(`${requestSelect} WHERE r.id=? AND r.current_approval_id=? AND r.status='approved' AND a.status='published'`).bind(r.id,a.id).first<RequestRow>();
  if(winner)return view(db,winner);throw error;
 }
 return (await readWorkspaceInvitationRequest(db,{sourceId:r.source_id,workspaceId:r.workspace_id,requestId:r.id}))!;
}
export async function abandonStagedWorkspaceInvitation(db:InvitationApprovalDatabase,input:{authorizationId:string}){
 await ready(db);const a=await db.prepare('SELECT * FROM portal_workspace_invitation_approvals WHERE id=?').bind(input.authorizationId).first<ApprovalRow>();
 if(!a)return null;const r=await db.prepare(`${requestSelect} WHERE r.id=?`).bind(a.request_id).first<RequestRow>();if(!r)fail(404,'invitation_request_unavailable');
 if(a.status==='published')return view(db,r);
 if(a.status==='closed')return view(db,r);if(a.status!=='staged'||r.current_approval_id!==a.id||r.status!=='approving')fail(409,'invitation_approval_changed');
 await db.batch([fence(db,`EXISTS(SELECT 1 FROM portal_workspace_invitation_requests WHERE id=? AND version=? AND status='approving' AND current_approval_id=?)`,[r.id,r.version,a.id]),
  db.prepare(`UPDATE portal_workspace_invitation_approvals SET status='closed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='staged'`).bind(a.id),
  db.prepare(`UPDATE portal_v2_invitations SET status='revoked',revoked_at=datetime('now') WHERE id=? AND status='pending'`).bind(a.invitation_id),
  db.prepare(`UPDATE portal_v2_invitation_email_outbox SET status='cancelled',payload_json='{"redacted":true}',lease_expires_at=NULL,updated_at=datetime('now') WHERE invitation_id=? AND status<>'sent'`).bind(a.invitation_id),
  db.prepare(`UPDATE portal_workspace_invitation_requests SET status='pending',current_approval_id=NULL,reason_code='approval_not_published',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`).bind(r.id,r.version),
  audit(db,r.workspace_id,r.id,'staff',a.actor_staff_id,'request.approval_abandoned',a.id,{})]);
 return (await readWorkspaceInvitationRequest(db,{sourceId:r.source_id,workspaceId:r.workspace_id,requestId:r.id}))!;
}
/** Bounded cleanup only: it never issues, publishes, approves or renews terms.
 * Expired staging reservations can be reviewed again with a new staff receipt. */
export async function reconcileExpiredWorkspaceInvitationApprovals(db:InvitationApprovalDatabase,now=new Date()):Promise<number>{
 if(!await invitationRequestsReady(db))return 0;
 const cutoff=now.toISOString();
 const candidates=(await db.prepare(`SELECT a.id FROM portal_workspace_invitation_approvals a
  JOIN portal_workspace_invitation_requests r ON r.id=a.request_id AND r.current_approval_id=a.id AND r.status='approving'
  JOIN portal_v2_invitations i ON i.id=a.invitation_id AND i.status='pending'
  WHERE a.status='staged' AND a.publication_deadline<=? ORDER BY a.publication_deadline,a.id LIMIT 10`).bind(cutoff).all<{id:string}>()).results;
 let changed=0;
 for(const candidate of candidates){
  try{const result=await abandonStagedWorkspaceInvitation(db,{authorizationId:candidate.id});if(result?.status==='pending'||result?.status==='stale')changed++;}
  catch(error){if(!(error instanceof HTTPException&&error.status===409))throw error;}
 }
 return changed;
}
export async function rejectWorkspaceInvitationRequest(db:InvitationApprovalDatabase,input:InvitationReviewInput&{reason:string}){
 await ready(db);const hash=await invitationApprovalDigest(JSON.stringify({sourceId:input.sourceId,workspaceId:input.workspaceId,requestId:input.requestId,version:input.expectedVersion,context:input.expectedContextVersion,reason:input.reason}));
 const saved=await command(db,input.workspaceId,input.authorization.actorStaffId,input.idempotencyKey,'reject',hash);
 if(saved){const request=await readWorkspaceInvitationRequest(db,input);if(!request)fail(404,'invitation_request_unavailable');return {request,replayed:true};}
 auth(input.authorization);const r=await row(db,input);if(!r)fail(404,'invitation_request_unavailable');
 if(r.status!=='pending'||r.version!==input.expectedVersion)fail(409,'invitation_request_changed');
 const workspace=await readWorkspaceInvitationPolicyContext(db,input);
 const context=await invitationApprovalDigest(JSON.stringify({request:{...await view(db,r),canCancel:false},workspace}));
 if(context!==input.expectedContextVersion)fail(409,'invitation_request_changed');
 const workspaceProof=await db.prepare(policyProofSql).bind(input.workspaceId,input.sourceId).first<string>('proof');
 if(!workspaceProof||await invitationApprovalDigest(workspaceProof)!==workspace.contextVersion)fail(409,'invitation_policy_changed');
 if(input.reason.length>500||/[\u0000-\u001f\u007f]/.test(input.reason))fail(400,'invitation_reason_invalid');
 await db.batch([fence(db,`((${policyProofSql})=?) AND datetime(?)>datetime('now')`,[input.workspaceId,input.sourceId,workspaceProof,input.authorization.publicationDeadline]),
  fence(db,`EXISTS(SELECT 1 FROM portal_workspace_invitation_requests WHERE id=? AND version=? AND status='pending')`,[r.id,r.version]),
  db.prepare(`UPDATE portal_workspace_invitation_requests SET status='rejected',reason_code=?,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=? AND status='pending'`).bind(input.reason,r.id,r.version),
  commandInsert(db,r.workspace_id,input.authorization.actorStaffId,input.idempotencyKey,'reject',hash,r.id,input.authorization.id,{requestId:r.id}),
  audit(db,r.workspace_id,r.id,'staff',input.authorization.actorStaffId,'request.rejected',input.authorization.id,{reason:input.reason})]);
 return {request:(await readWorkspaceInvitationRequest(db,input))!,replayed:false};
}
/** Caller authenticates the current staff actor before this read. A terminal
 * replay makes no new authority or writes and does not extend a publication
 * deadline. A staged/abandoned operation is never reported as completed. */
export async function readWorkspaceInvitationReviewReplay(db:InvitationApprovalDatabase,input:{sourceId:string;workspaceId:string;requestId?:string;
 action:'approve'|'reject'|'policy';authorizationId:string;actorStaffId:string;idempotencyKey:string}):Promise<null|{request?:WorkspaceInvitationRequestView;policy?:WorkspaceInvitationPolicyContext;replayed:true}>{
 await ready(db);const saved=await db.prepare(`SELECT operation,request_id,authorization_id FROM portal_workspace_invitation_request_commands
  WHERE workspace_id=? AND actor_id=? AND idempotency_key=?`).bind(input.workspaceId,input.actorStaffId,input.idempotencyKey)
  .first<{operation:string;request_id:string|null;authorization_id:string|null}>();
 if(!saved)return null;
 if(saved.operation!==input.action||saved.authorization_id!==input.authorizationId||saved.request_id!==(input.requestId??null))fail(409,'invitation_idempotency_conflict');
 if(input.action==='policy')return {policy:await readWorkspaceInvitationPolicyContext(db,input),replayed:true};
 if(!input.requestId)return null;
 const request=await readWorkspaceInvitationRequest(db,{...input,requestId:input.requestId});if(!request)fail(404,'invitation_request_unavailable');
 if(input.action==='reject')return request.status==='rejected'?{request,replayed:true}:null;
 const published=await db.prepare(`SELECT 1 ok FROM portal_workspace_invitation_approvals a JOIN portal_workspace_invitation_requests r
  ON r.id=a.request_id AND r.current_approval_id=a.id WHERE a.id=? AND a.status='published' AND r.status='approved' AND r.id=?`)
  .bind(input.authorizationId,input.requestId).first('ok');
 return published?{request,replayed:true}:null;
}
export async function cancelWorkspaceInvitationRequest(env:PortalAuthorizationEnv,principal:VerifiedClientPrincipal,input:{workspaceId:string;requestId:string;expectedVersion:number;idempotencyKey:string}){
 const db=env.DELIVERY_DB;await ready(db);const identity=await db.prepare(`SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=? AND verified_email=? AND status='active' AND revoked_at IS NULL`)
  .bind(principal.issuer,principal.subject,principal.email.trim().toLowerCase()).first<string>('id');if(!identity)fail(403,'invitation_request_unavailable');
 const coordinates={workspaceId:input.workspaceId,sourceId:PRIMARY_PROJECT_ALPHA_SOURCE_ID,requestId:input.requestId};
 const hash=await invitationApprovalDigest(JSON.stringify({requestId:input.requestId,expectedVersion:input.expectedVersion}));
 const saved=await command(db,input.workspaceId,identity,input.idempotencyKey,'cancel',hash);
 const r=await row(db,coordinates);if(!r||r.requester_identity_id!==identity)fail(404,'invitation_request_unavailable');
 if(saved)return {request:await view(db,r),replayed:true};
 if(r.version!==input.expectedVersion||!['pending','approving'].includes(r.status))fail(409,'invitation_request_changed');
 const statements:D1PreparedStatement[]=[fence(db,`EXISTS(SELECT 1 FROM portal_workspace_invitation_requests r JOIN portal_v2_identities i ON i.id=r.requester_identity_id
  JOIN portal_v2_workspaces w ON w.id=r.workspace_id AND w.project_alpha_source_id=r.source_id WHERE r.id=? AND r.version=? AND r.requester_identity_id=?
  AND r.status IN ('pending','approving') AND i.status='active' AND i.revoked_at IS NULL AND i.issuer=? AND i.subject=? AND i.verified_email=? AND w.status='active')`,
  [r.id,r.version,identity,principal.issuer,principal.subject,principal.email.trim().toLowerCase()])];
 if(r.current_approval_id){statements.push(db.prepare(`UPDATE portal_workspace_invitation_approvals SET status='closed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='staged'`).bind(r.current_approval_id),
  db.prepare(`UPDATE portal_v2_invitations SET status='revoked',revoked_at=datetime('now') WHERE id=? AND status='pending'`).bind(r.invitation_id),
  db.prepare(`UPDATE portal_v2_invitation_email_outbox SET status='cancelled',payload_json='{"redacted":true}',lease_expires_at=NULL,updated_at=datetime('now') WHERE invitation_id=? AND status<>'sent'`).bind(r.invitation_id));}
 await db.batch([...statements,db.prepare(`UPDATE portal_workspace_invitation_requests SET status='cancelled',version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`).bind(r.id,r.version),
  commandInsert(db,r.workspace_id,identity,input.idempotencyKey,'cancel',hash,r.id,null,{requestId:r.id}),audit(db,r.workspace_id,r.id,'identity',identity,'request.cancelled',null,{})]);
 return {request:(await readWorkspaceInvitationRequest(db,coordinates))!,replayed:false};
}
export async function listOwnWorkspaceInvitationRequests(env:PortalAuthorizationEnv,principal:VerifiedClientPrincipal,workspaceId:string,cursor?:string){
 const db=env.DELIVERY_DB;await ready(db);
 if(!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'workspace.view',{scopeType:'workspace',publicId:workspaceId}))fail(404,'invitation_workspace_unavailable');
 const identity=await db.prepare(`SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=? AND lower(verified_email)=? AND status='active' AND revoked_at IS NULL`)
  .bind(principal.issuer,principal.subject,principal.email.trim().toLowerCase()).first<string>('id');if(!identity)fail(404,'invitation_workspace_unavailable');
 let after:InvitationRequestAfter|undefined;
 if(cursor){if(cursor.length>128)fail(400,'invitation_cursor_invalid');
  const previous=await db.prepare(`SELECT created_at,id FROM portal_workspace_invitation_requests WHERE id=? AND workspace_id=? AND requester_identity_id=?`)
   .bind(cursor,workspaceId,identity).first<{created_at:string;id:string}>();if(!previous)fail(400,'invitation_cursor_invalid');after={createdAt:previous.created_at,id:previous.id};}
 const page=await listWorkspaceInvitationRequests(db,{workspaceId,sourceId:PRIMARY_PROJECT_ALPHA_SOURCE_ID,requesterIdentityId:identity,after,limit:25});
 if(!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'workspace.view',{scopeType:'workspace',publicId:workspaceId}))fail(404,'invitation_workspace_unavailable');
 return {items:page.items,nextCursor:page.nextAfter?.id??null};
}
