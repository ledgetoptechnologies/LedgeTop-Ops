import { HTTPException } from "hono/http-exception";
import { evaluatePermission, loadGrants } from "./acl";
import {
  authenticatedDeliveryChangeNotificationsReady,
  authenticatedDeliveryNotificationsEnabled,
  authorizeAuthenticatedDeliveryChangeBatch,
  controlAuthenticatedDeliveryChangeBatch,
  saveAuthenticatedDeliveryNotificationPolicy,
  type AuthenticatedDeliveryChangeBatchRow,
  type AuthenticatedDeliveryChangeMode,
} from "./authenticated-delivery-change-notifications";
import {
  resolveAuthenticatedDeliveryGrantNotificationTarget,
  authenticatedDeliveryGrantNotificationRecipientUsable,
  authenticatedDeliveryGrantsEnabled,
  type AuthenticatedDeliveryGrantNotificationTarget,
} from "./authenticated-delivery-grants";
import { sha256 } from "./crypto";
import type { Env, GrantRow, StaffPrincipal } from "./types";

type View = "pending" | "history";
type Action = "send-now" | "cancel";
type PolicyRow = {
  grant_id:string; grant_version:number; logical_grant_id:string; workspace_id:string; source_id:string;
  identity_id:string; principal_public_id:string; principal_source_version:string; access_notice_enabled:number;
  change_mode:AuthenticatedDeliveryChangeMode; policy_version:number; updated_at:string;
};

export interface AuthenticatedDeliveryNotificationPolicyView {
  accessNoticeEnabled:boolean;
  changeMode:AuthenticatedDeliveryChangeMode;
  version:number;
}

export interface AuthenticatedDeliveryNotificationRow extends AuthenticatedDeliveryChangeBatchRow {
  created_at:string;
  updated_at:string;
  delivered_at:string|null;
  last_error:string|null;
  createdAt:string;
  scopeKey:string;
}

export interface AuthenticatedDeliveryNotificationScope {
  divisionId:string;
  sourceId:"project-alpha:primary";
  sourceName:"Project Alpha";
  workspaceId:string;
  workspaceName:string;
  folderLabel:string;
  recipientEmail:string|null;
  contextProof:string;
}

const OPAQUE=/^[A-Za-z0-9_-]{1,128}$/;
const IDEMPOTENCY=/^[A-Za-z0-9._:-]{16,128}$/;
const iso=(value:string)=>new Date(value.includes("T")?value:`${value.replace(" ","T")}Z`).toISOString();
async function sha256Hex(value:string):Promise<string>{
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
function unavailable():never{throw new HTTPException(404,{message:"Notification is unavailable"});}
function changed():never{throw new HTTPException(409,{message:"Notification or permissions changed. Refresh before trying again."});}

export async function authenticatedDeliveryNotificationCenterReady(env:Env):Promise<boolean>{
  return authenticatedDeliveryNotificationsEnabled(env)&&authenticatedDeliveryGrantsEnabled(env)
    &&await authenticatedDeliveryChangeNotificationsReady(env);
}

async function staffPolicy(env:Env,principal:StaffPrincipal){
  const [staff,grants]=await Promise.all([
    env.OPS_DB.withSession("first-primary").prepare(`SELECT email,access_subject,project_alpha_user_id
      FROM staff_users WHERE id=? AND status='active'`).bind(principal.id)
      .first<{email:string;access_subject:string|null;project_alpha_user_id:string|null}>(),
    loadGrants(env,principal.id),
  ]);
  if(!staff||staff.email!==principal.email||staff.access_subject!==principal.accessSubject||staff.project_alpha_user_id!==principal.projectAlphaUserId)
    throw new HTTPException(403,{message:"Current staff authentication required"});
  return {grants,proof:await sha256(JSON.stringify([staff,grants.map(row=>JSON.stringify(row)).sort()]))};
}

function allowed(grants:GrantRow[],principal:StaffPrincipal,permission:"delivery.share.audit"|"delivery.share.create"|"delivery.share.revoke",divisionId:string){
  return evaluatePermission(grants,principal,permission,{divisionId});
}

function targetMatchesRow(target:AuthenticatedDeliveryGrantNotificationTarget,row:AuthenticatedDeliveryChangeBatchRow):boolean{
  return target.grantId===row.grant_id&&target.grantVersion===row.grant_version&&target.logicalGrantId===row.logical_grant_id
    &&target.workspaceId===row.workspace_id&&target.sourceId===row.source_id&&target.identityId===row.identity_id
    &&target.principalPublicId===row.principal_public_id&&target.principalSourceVersion===row.principal_source_version
    &&target.folderBindingId===row.folder_binding_id&&target.bindingSourceVersion===row.binding_source_version
    &&target.ownerScopeType===row.owner_scope_type&&target.ownerPublicId===row.owner_public_id&&target.r2Prefix===row.r2_prefix;
}

async function exactPolicy(env:Env,target:AuthenticatedDeliveryGrantNotificationTarget):Promise<PolicyRow|null>{
  const row=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT * FROM portal_authenticated_delivery_notification_policies
    WHERE grant_id=? AND identity_id=?`).bind(target.grantId,target.identityId).first<PolicyRow>();
  if(!row)return null;
  return row.grant_version===target.grantVersion&&row.logical_grant_id===target.logicalGrantId
    &&row.workspace_id===target.workspaceId&&row.source_id===target.sourceId
    &&row.principal_public_id===target.principalPublicId&&row.principal_source_version===target.principalSourceVersion?row:null;
}

function policyView(row:PolicyRow|null):AuthenticatedDeliveryNotificationPolicyView|null{
  return row?{accessNoticeEnabled:row.access_notice_enabled===1,changeMode:row.change_mode,version:row.policy_version}:null;
}

async function failClosedDisablePolicy(env:Env,actorStaffId:string,target:AuthenticatedDeliveryGrantNotificationTarget,requestKey:string){
  for(let attempt=0;attempt<3;attempt++){
    const current=await exactPolicy(env,target);
    if(!current||current.access_notice_enabled!==1||current.change_mode==="off")return;
    const fingerprint=await sha256Hex(JSON.stringify(["authority-race-disable",target.grantId,target.identityId,current.policy_version,requestKey]));
    const mutationKey=`policy-race:${fingerprint}`,auditId=`policy-race-audit:${fingerprint}`;
    try{
      const db=env.DELIVERY_DB.withSession("first-primary");
      const results=await db.batch([
        db.prepare(`UPDATE portal_authenticated_delivery_notification_policies
          SET access_notice_enabled=0,change_mode='off',policy_version=policy_version+1,updated_by_staff_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE grant_id=? AND identity_id=? AND policy_version=? AND access_notice_enabled=1 AND change_mode<>'off'`)
          .bind(actorStaffId,target.grantId,target.identityId,current.policy_version),
        db.prepare(`INSERT OR IGNORE INTO portal_authenticated_delivery_notification_policy_audit
          (id,grant_id,grant_version,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
            policy_version,access_notice_enabled,change_mode,action,actor_staff_id,request_fingerprint)
          SELECT ?,grant_id,grant_version,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
            policy_version,access_notice_enabled,change_mode,'policy.updated',?,?
          FROM portal_authenticated_delivery_notification_policies policy WHERE policy.grant_id=? AND policy.identity_id=?
            AND policy.policy_version=? AND policy.access_notice_enabled=0 AND policy.change_mode='off'`)
          .bind(auditId,actorStaffId,fingerprint,target.grantId,target.identityId,current.policy_version+1),
        db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policy_mutations
          (actor_staff_id,idempotency_key,request_fingerprint,grant_id,identity_id,expected_policy_version,result_policy_version,
            result_access_notice_enabled,result_change_mode)
          SELECT ?,?,?,?,?,?,?,0,'off' WHERE EXISTS(SELECT 1 FROM portal_authenticated_delivery_notification_policies policy
            WHERE policy.grant_id=? AND policy.identity_id=? AND policy.policy_version=?
              AND policy.access_notice_enabled=0 AND policy.change_mode='off')`).bind(actorStaffId,mutationKey,fingerprint,target.grantId,target.identityId,
            current.policy_version,current.policy_version+1,target.grantId,target.identityId,current.policy_version+1),
      ]);
      if(results.every(result=>Number(result.meta.changes)===1))return;
    }catch(error){
      const after=await exactPolicy(env,target);
      if(!after||after.access_notice_enabled!==1||after.change_mode==="off")return;
      if(attempt===2)throw new HTTPException(503,{message:"Notification policy could not be disabled after its authority changed",cause:error});
    }
  }
  const final=await exactPolicy(env,target);
  if(final?.access_notice_enabled===1&&final.change_mode!=="off")
    throw new HTTPException(503,{message:"Notification policy could not be disabled after its authority changed"});
}

export async function readAuthenticatedDeliveryNotificationPolicy(env:Env,principal:StaffPrincipal,grantId:string){
  if(!OPAQUE.test(grantId))unavailable();
  if(!await authenticatedDeliveryNotificationCenterReady(env))return {policy:null,available:false as const};
  const access=await staffPolicy(env,principal),target=await resolveAuthenticatedDeliveryGrantNotificationTarget(env,grantId);
  if(!target||!allowed(access.grants,principal,"delivery.share.create",target.divisionId))unavailable();
  const row=await exactPolicy(env,target);
  const [currentTarget,currentAccess,currentRow]=await Promise.all([
    resolveAuthenticatedDeliveryGrantNotificationTarget(env,grantId),staffPolicy(env,principal),exactPolicy(env,target),
  ]);
  if(JSON.stringify(currentTarget)!==JSON.stringify(target)||currentAccess.proof!==access.proof||JSON.stringify(currentRow)!==JSON.stringify(row))changed();
  return {policy:policyView(row),available:true as const};
}

function mapPolicyError(error:unknown):never{
  const message=error instanceof Error?error.message:"";
  if(message.endsWith("-disabled")||message.endsWith("-schema-unavailable"))
    throw new HTTPException(503,{message:"Authenticated delivery notifications are not ready"});
  if(message.endsWith("-invalid"))throw new HTTPException(400,{message:"Notification policy is invalid"});
  if(message.includes("idempotency-conflict"))throw new HTTPException(409,{message:"This request key was already used for a different notification policy"});
  if(message.includes("version-conflict")||message.includes("write-conflict"))changed();
  if(message.includes("grant-unavailable"))unavailable();
  throw error;
}

export async function updateAuthenticatedDeliveryNotificationPolicy(env:Env,principal:StaffPrincipal,grantId:string,input:{
  accessNoticeEnabled:boolean;changeMode:AuthenticatedDeliveryChangeMode;expectedVersion:number|null;idempotencyKey:string;
},dependencies?:{beforeFinalAuthorization?():Promise<void>}){
  if(!OPAQUE.test(grantId)||!IDEMPOTENCY.test(input.idempotencyKey)
    ||input.expectedVersion!==null&&(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1)
    ||!["off","added","removed","both"].includes(input.changeMode)||input.accessNoticeEnabled&&input.changeMode==="off")
    throw new HTTPException(400,{message:"Notification policy is invalid"});
  if(!await authenticatedDeliveryNotificationCenterReady(env))
    throw new HTTPException(503,{message:"Authenticated delivery notifications are not ready"});
  const access=await staffPolicy(env,principal),target=await resolveAuthenticatedDeliveryGrantNotificationTarget(env,grantId);
  if(!target||!allowed(access.grants,principal,"delivery.share.create",target.divisionId))unavailable();
  const enabling=input.accessNoticeEnabled&&input.changeMode!=="off";
  if(enabling&&!await authenticatedDeliveryGrantNotificationRecipientUsable(env,target))changed();
  let row:PolicyRow;
  try{row=await saveAuthenticatedDeliveryNotificationPolicy(env,principal.id,{grantId,
    identityId:target.identityId,expectedPolicyVersion:input.expectedVersion,accessNoticeEnabled:input.accessNoticeEnabled,
    changeMode:input.changeMode,idempotencyKey:input.idempotencyKey}) as PolicyRow;}
  catch(error){mapPolicyError(error);}
  await dependencies?.beforeFinalAuthorization?.();
  let mismatched=true;
  try{
    const [currentTarget,currentAccess,currentRow]=await Promise.all([
      resolveAuthenticatedDeliveryGrantNotificationTarget(env,grantId),staffPolicy(env,principal),exactPolicy(env,target),
    ]);
    mismatched=JSON.stringify(currentTarget)!==JSON.stringify(target)||currentAccess.proof!==access.proof
      ||JSON.stringify(currentRow)!==JSON.stringify(row)||!allowed(currentAccess.grants,principal,"delivery.share.create",target.divisionId)
      ||enabling&&(!currentTarget||!await authenticatedDeliveryGrantNotificationRecipientUsable(env,currentTarget));
  }catch{/* An unreadable post-write proof is not proof of continuing authority. */}
  if(mismatched){if(enabling)await failClosedDisablePolicy(env,principal.id,target,input.idempotencyKey);changed();}
  return {policy:policyView(row),available:true as const};
}

async function exact(env:Env,id:string):Promise<AuthenticatedDeliveryNotificationRow|null>{
  if(!OPAQUE.test(id))return null;
  const row=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT * FROM portal_authenticated_delivery_change_batches WHERE id=?`)
    .bind(id).first<AuthenticatedDeliveryNotificationRow>();
  return row?{...row,createdAt:iso(row.created_at),scopeKey:JSON.stringify([row.id,row.revision,row.status,row.published_recipient_email,
    row.grant_id,row.grant_version,row.identity_id,row.policy_version,row.workspace_id,row.folder_binding_id,row.binding_source_version,
    row.owner_scope_type,row.owner_public_id,row.r2_prefix])}:null;
}

export async function authenticatedDeliveryNotificationCandidates(env:Env,view:View,after?:[string,string],limit=51):Promise<AuthenticatedDeliveryNotificationRow[]>{
  if(!["pending","history"].includes(view)||!Number.isInteger(limit)||limit<1||limit>101)
    throw new HTTPException(400,{message:"Authenticated notification query is invalid"});
  if(!await authenticatedDeliveryNotificationCenterReady(env))return [];
  let position:string|undefined;
  if(after){const prior=await exact(env,after[1]);if(!prior||prior.createdAt!==after[0])changed();position=prior.created_at;}
  const rows=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT * FROM portal_authenticated_delivery_change_batches batch
    WHERE batch.status ${view==="pending"?"IN ('pending','processing')":"IN ('sent','cancelled','suppressed','failed')"}
      ${after?"AND (batch.created_at<? OR (batch.created_at=? AND batch.id<?))":""}
    ORDER BY batch.created_at DESC,batch.id DESC LIMIT ?`).bind(...(after?[position!,position!,after[1]]:[]),limit)
    .all<AuthenticatedDeliveryNotificationRow>();
  return rows.results.map(row=>({...row,createdAt:iso(row.created_at),scopeKey:JSON.stringify([row.id,row.revision,row.status,row.published_recipient_email,
    row.grant_id,row.grant_version,row.identity_id,row.policy_version,row.workspace_id,row.folder_binding_id,row.binding_source_version,
    row.owner_scope_type,row.owner_public_id,row.r2_prefix])}));
}

export async function readAuthenticatedDeliveryNotificationScope(env:Env,row:AuthenticatedDeliveryNotificationRow):Promise<AuthenticatedDeliveryNotificationScope|null>{
  const target=await resolveAuthenticatedDeliveryGrantNotificationTarget(env,row.grant_id);
  if(!target||!targetMatchesRow(target,row))return null;
  const authorization=await authorizeAuthenticatedDeliveryChangeBatch(env,row);
  let recipientEmail:string|null=null;
  if(row.published_recipient_email)recipientEmail=authorization?.recipient_email===row.published_recipient_email?row.published_recipient_email:null;
  else if(row.status==="pending")recipientEmail=authorization?.recipient_email??null;
  return {divisionId:target.divisionId,sourceId:target.sourceId,sourceName:"Project Alpha",workspaceId:target.workspaceId,
    workspaceName:target.workspaceLabel,folderLabel:target.folderLabel,recipientEmail,
    contextProof:await sha256(JSON.stringify([target,row.scopeKey,row.status,row.revision,row.published_recipient_email,recipientEmail]))};
}

export function presentAuthenticatedDeliveryNotification(row:AuthenticatedDeliveryNotificationRow,scope:AuthenticatedDeliveryNotificationScope,
  sendable:boolean,grants:GrantRow[],principal:StaffPrincipal){
  return {kind:"authenticated_delivery" as const,id:row.id,revision:row.revision,status:row.status,workspaceName:scope.workspaceName,folderLabel:scope.folderLabel,
    recipientEmail:scope.recipientEmail,addedCount:row.added_count,removedCount:row.removed_count,eligibleAt:iso(row.eligible_at),
    createdAt:row.createdAt,updatedAt:iso(row.updated_at),deliveredAt:row.delivered_at?iso(row.delivered_at):null,
    errorCode:row.last_error?(row.status==="suppressed"?"no-longer-eligible":row.status==="failed"||row.status==="pending"?"delivery-attempt-failed":null):null,
    canSendNow:row.status==="pending"&&row.attempt_count<3&&sendable&&allowed(grants,principal,"delivery.share.create",scope.divisionId),
    canCancel:row.status==="pending"&&allowed(grants,principal,"delivery.share.revoke",scope.divisionId)};
}

export async function readAuthenticatedDeliveryNotification(env:Env,id:string,principal:StaffPrincipal){
  if(!await authenticatedDeliveryNotificationCenterReady(env))unavailable();
  const access=await staffPolicy(env,principal),row=await exact(env,id),scope=row?await readAuthenticatedDeliveryNotificationScope(env,row):null;
  if(!row||!scope||!allowed(access.grants,principal,"delivery.share.audit",scope.divisionId))unavailable();
  const authorization=row.status==="pending"?await authorizeAuthenticatedDeliveryChangeBatch(env,row):null;
  const [currentRow,currentScope,currentAuthorization,currentAccess]=await Promise.all([
    exact(env,id),readAuthenticatedDeliveryNotificationScope(env,row),
    row.status==="pending"?authorizeAuthenticatedDeliveryChangeBatch(env,row):Promise.resolve(null),staffPolicy(env,principal),
  ]);
  if(JSON.stringify(currentRow)!==JSON.stringify(row)||currentScope?.contextProof!==scope.contextProof
    ||JSON.stringify(currentAuthorization)!==JSON.stringify(authorization)||currentAccess.proof!==access.proof)changed();
  return {item:presentAuthenticatedDeliveryNotification(row,scope,Boolean(authorization),access.grants,principal),serverNow:new Date().toISOString()};
}

function mapControlError(error:unknown):never{
  const message=error instanceof Error?error.message:"";
  if(message.endsWith("-invalid"))throw new HTTPException(400,{message:"Notification action identifiers are invalid"});
  if(message.includes("idempotency-conflict"))throw new HTTPException(409,{message:"This request key was already used for a different notification action"});
  if(message.includes("control-conflict"))changed();
  if(message.endsWith("-disabled")||message.endsWith("-schema-unavailable"))
    throw new HTTPException(503,{message:"Authenticated delivery notifications are not ready"});
  throw error;
}

export async function controlAuthenticatedDeliveryNotification(env:Env,principal:StaffPrincipal,id:string,action:Action,
  expectedRevision:number,key:string){
  if(!OPAQUE.test(id)||!IDEMPOTENCY.test(key)||!["send-now","cancel"].includes(action)
    ||!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER)
    throw new HTTPException(400,{message:"Notification action identifiers are invalid"});
  if(!await authenticatedDeliveryNotificationCenterReady(env))unavailable();
  const access=await staffPolicy(env,principal),row=await exact(env,id),scope=row?await readAuthenticatedDeliveryNotificationScope(env,row):null;
  if(!row||!scope||!allowed(access.grants,principal,"delivery.share.audit",scope.divisionId)
    ||!allowed(access.grants,principal,action==="send-now"?"delivery.share.create":"delivery.share.revoke",scope.divisionId))unavailable();
  const recheck=async()=>{const [currentScope,currentAccess]=await Promise.all([readAuthenticatedDeliveryNotificationScope(env,row),staffPolicy(env,principal)]);
    if(currentScope?.contextProof!==scope.contextProof||currentAccess.proof!==access.proof)changed();};
  await recheck();
  const invoke=()=>controlAuthenticatedDeliveryChangeBatch(env,principal.id,{batchId:id,action,expectedRevision,idempotencyKey:key},true);
  const prior=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT 1 ok FROM portal_authenticated_delivery_change_controls
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(principal.id,key).first("ok");
  if(prior!==null){let replayed:{status:"pending"|"cancelled";revision:number;replayed?:boolean};
    try{replayed=await invoke();}catch(error){mapControlError(error);}await recheck();
    return {ok:true as const,id,action,revision:replayed.revision,status:replayed.status,replayed:replayed.replayed===true};}
  if(row.status!=="pending"||row.revision!==expectedRevision||action==="send-now"&&row.attempt_count>=3)changed();
  if(action==="send-now"&&!await authorizeAuthenticatedDeliveryChangeBatch(env,row))changed();
  let result:{status:"pending"|"cancelled";revision:number;replayed?:boolean};
  try{result=await invoke();}
  catch(error){mapControlError(error);}
  await recheck();
  return {ok:true as const,id,action,revision:result.revision,status:result.status,replayed:result.replayed===true};
}
