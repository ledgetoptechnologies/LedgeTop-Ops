import { HTTPException } from "hono/http-exception";
import { evaluatePermission, loadGrants } from "./acl";
import { isAlphaPublicId, validatedUniquePublicIdExpression } from "./client-hub-source";
import { resolveProjectAlphaDeliveryPrincipalProof } from "./share-recipients";
import { PRIMARY_CATALOG_SOURCE } from "@ltds/shared";
import { authorizePortalDeliveryNotificationBatch, nativeBindingGuard, nativeDeliveryNotificationsReady,
  nativeNotificationHash, readNativeBinding, type NativeBatch } from "./portal-delivery-notification-batches";
import type { Env, GrantRow, StaffPrincipal } from "./types";
export { nativeDeliveryNotificationsReady };

export interface NativeNotificationRow extends NativeBatch {
  storageId: string; createdAt: string; scopeKey: string;
  deliveryMode: "staged" | "direct_legacy" | "awaiting_staging";
  eventType: "granted" | "revoked";
}
export interface NativeNotificationScope {
  divisionId: string; sourceId: string; sourceName: string; workspaceId: string; workspaceName: string;
  folderLabel: string; recipientEmail: string|null; contextProof: string;
}
const iso=(value:string)=>new Date(value.includes("T")?value:`${value.replace(" ","T")}Z`).toISOString();
const text=(value:string)=>value.replace(/[\u0000-\u001f\u007f-\u009f]/g,"").trim().slice(0,500);
function unavailable():never{throw new HTTPException(404,{message:"Notification is unavailable"});}
function changed():never{throw new HTTPException(409,{message:"Notification or permissions changed. Refresh before trying again."});}
async function ready(env:Env){if(!await nativeDeliveryNotificationsReady(env))throw new HTTPException(503,{message:"Native delivery notification staging is unavailable until its database upgrade finishes."});}

const batchCandidatesSql=`SELECT 'nb_'||batch.id public_id,batch.id storage_id,'staged' delivery_mode,'granted' event_type,batch.*
  FROM portal_delivery_notification_batches batch WHERE batch.source_id='project-alpha:primary'`;
const directCandidatesSql=`SELECT 'nd_'||outbox.id public_id,outbox.id storage_id,
    CASE WHEN outbox.status='pending' AND outbox.attempt_count=0 AND outbox.lease_expires_at IS NULL AND outbox.event_type='granted'
      THEN 'awaiting_staging' ELSE 'direct_legacy' END delivery_mode,outbox.event_type,
    outbox.id,receipt.project_alpha_source_id source_id,grant_row.workspace_id,grant_row.folder_binding_id,grant_row.binding_source_version,
    outbox.principal_public_id,outbox.principal_source_version,binding.owner_scope_type,binding.owner_public_id,binding.r2_prefix,
    1 revision,outbox.status,outbox.next_attempt_at eligible_at,outbox.attempt_count,NULL sealed_at,NULL lease_token,outbox.lease_expires_at,NULL dispatch_fingerprint,NULL published_recipient_email,NULL published_at,outbox.delivered_at,
    outbox.last_error,outbox.created_at,outbox.updated_at
  FROM project_alpha_delivery_portal_notification_outbox outbox
  JOIN project_alpha_delivery_intent_receipts receipt ON receipt.receipt_id=outbox.receipt_id
    AND receipt.access_mode='portal' AND receipt.resource_id=outbox.grant_id AND receipt.project_alpha_source_id='project-alpha:primary'
  JOIN project_alpha_delivery_portal_grants grant_row ON grant_row.id=outbox.grant_id
    AND grant_row.audience_public_id=outbox.principal_public_id AND grant_row.audience_source_version=outbox.principal_source_version
  JOIN portal_v2_folder_bindings binding ON binding.id=grant_row.folder_binding_id AND binding.workspace_id=grant_row.workspace_id
  WHERE NOT EXISTS(SELECT 1 FROM portal_delivery_notification_items item WHERE item.outbox_id=outbox.id)`;
type StoredRow=NativeBatch&{public_id:string;storage_id:string;delivery_mode:NativeNotificationRow["deliveryMode"];event_type:"granted"|"revoked"};
function rowDto(row:StoredRow):NativeNotificationRow{
  return {...row,id:row.public_id,storageId:row.storage_id,createdAt:iso(row.created_at),deliveryMode:row.delivery_mode,eventType:row.event_type,
    scopeKey:JSON.stringify([row.source_id,row.workspace_id,row.folder_binding_id,row.binding_source_version,row.principal_public_id,row.principal_source_version,row.owner_scope_type,row.owner_public_id,row.r2_prefix,row.published_recipient_email,row.delivery_mode])};
}
export async function nativeNotificationCandidates(env:Env,view:"pending"|"history",after?:[string,string],limit=101):Promise<NativeNotificationRow[]>{
  if(!["pending","history"].includes(view)||!Number.isInteger(limit)||limit<1||limit>101)throw new HTTPException(400,{message:"Native notification query is invalid"});
  await ready(env);
  // Continue at the immutable raw creation timestamp; no date function is
  // applied to the indexed candidate order. Cursor timestamps are only proofs.
  let position:string|undefined;
  if(after){
    const prior=await exact(env,after[1]);
    if(!prior||iso(prior.created_at)!==after[0])changed();position=prior.created_at;
  }
  const branch=async(prefix:'nb_'|'nd_',alias:'batch'|'outbox',select:string)=>{
    const bindings:(string|number)[]=[];let seek='';
    if(after){
      const tie=after[1].startsWith(prefix)?`${alias}.id<?`:prefix<after[1].slice(0,3)?'1':'0';
      seek=`AND (${alias}.created_at<? OR (${alias}.created_at=? AND ${tie}))`;
      bindings.push(position!,position!);if(after[1].startsWith(prefix))bindings.push(after[1].slice(3));
    }
    const index=`idx_portal_delivery_notification_${alias==='outbox'?'direct_':''}${view==='pending'?'pending':'history'}`;
    const orderedSelect=select.replace(` ${alias} WHERE`,` ${alias} INDEXED BY ${index} WHERE`)
      .replace(`_outbox outbox\n`,`_outbox outbox INDEXED BY ${index}\n`);
    return env.DELIVERY_DB.withSession('first-primary').prepare(`${orderedSelect}
      AND ${alias}.status ${view==='pending'?"IN ('pending','processing')":"IN ('sent','cancelled','suppressed','failed')"}
      ${seek} ORDER BY ${alias}.created_at DESC,${alias}.id DESC LIMIT ?`).bind(...bindings,limit).all<StoredRow>();
  };
  const [batches,direct]=await Promise.all([branch('nb_','batch',batchCandidatesSql),branch('nd_','outbox',directCandidatesSql)]);
  return [...batches.results,...direct.results].map(rowDto).sort((a,b)=>a.createdAt===b.createdAt?(a.id===b.id?0:a.id>b.id?-1:1):a.createdAt>b.createdAt?-1:1).slice(0,limit);
}
async function exact(env:Env,id:string):Promise<NativeNotificationRow|null>{
  if(!/^(nb|nd)_[A-Za-z0-9_-]{1,128}$/.test(id))return null;
  const staged=id.startsWith('nb_');
  const row=await env.DELIVERY_DB.withSession("first-primary").prepare(`${staged?batchCandidatesSql:directCandidatesSql} AND ${staged?'batch':'outbox'}.id=?`).bind(id.slice(3)).first<StoredRow>();
  return row?rowDto(row):null;
}

/** Staff visibility requires exact public-ID correspondence, not a raw
 * numeric/public ID guess or a prefix that belongs to a different producer.
 * Department ownership has no projected Operations mapping in this slice. */
export async function readNativeDeliveryNotificationScope(env:Env,row:NativeNotificationRow):Promise<NativeNotificationScope|null>{
  if(!isAlphaPublicId(row.owner_public_id)||row.owner_scope_type==='department'||row.r2_prefix.length>1000)return null;
  const binding=await readNativeBinding(env,row);if(!binding)return null;
  const ancestors:string[]=[];let prefix="";
  for(const part of row.r2_prefix.split('/').filter(Boolean)){prefix+=`${part}/`;ancestors.push(prefix,prefix.slice(0,-1));}
  if(!ancestors.length||prefix!==row.r2_prefix)return null;
  const owners=await env.OPS_DB.withSession("first-primary").prepare(`WITH matching AS (
    SELECT pf.project_id,pf.division_id,pf.r2_prefix,length(rtrim(pf.r2_prefix,'/')||'/') prefix_length
    FROM project_folders pf WHERE pf.r2_prefix IN(SELECT value FROM json_each(?))
  ) SELECT matching.project_id,matching.division_id,matching.r2_prefix,
      p.active project_active,p.projection_source_id project_source,division.active division_active,
      ${validatedUniquePublicIdExpression('pa_projects','p')} project_public_id,
      ${validatedUniquePublicIdExpression('pa_clients','client')} client_public_id,
      ${validatedUniquePublicIdExpression('pa_organizations','org')} organization_public_id
    FROM matching LEFT JOIN divisions division ON division.id=matching.division_id
    LEFT JOIN pa_projects p ON p.id=matching.project_id
    LEFT JOIN pa_clients client ON client.id=p.client_id AND client.projection_source_id=p.projection_source_id AND client.active=1
    LEFT JOIN pa_organizations org ON org.id=p.organization_id AND org.projection_source_id=p.projection_source_id AND org.active=1
    WHERE prefix_length=(SELECT MAX(prefix_length) FROM matching) LIMIT 2`).bind(JSON.stringify(ancestors))
    .all<{project_id:string;division_id:string; r2_prefix:string;project_active:number|null;project_source:string|null;division_active:number|null;
      project_public_id:string|null;client_public_id:string|null;organization_public_id:string|null}>();
  if(owners.results.length!==1)return null;const owner=owners.results[0]!;
  if(owner.project_active!==1||owner.project_source!=='project-alpha:primary'||owner.division_active!==1)return null;
  const publicId=row.owner_scope_type==='project'?owner.project_public_id:row.owner_scope_type==='client'?owner.client_public_id:owner.organization_public_id;
  if(!owner.division_id||publicId!==row.owner_public_id)return null;
  let recipientEmail:string|null=null,recipientIdentity:unknown=null;
  try{const current=await resolveProjectAlphaDeliveryPrincipalProof(env,row.r2_prefix,row.principal_public_id,row.principal_source_version,row.binding_source_version,PRIMARY_CATALOG_SOURCE);
    if(current.audience.workspaceId===row.workspace_id&&current.audience.folderBindingId===row.folder_binding_id){recipientEmail=current.identity.email;recipientIdentity=current.identity;}
  }catch(error){if(!(error instanceof HTTPException))throw error;}
  // Do not relabel a historical send with a newly configured email address.
  // A changed/missing current recipient is redacted, not rebound for history.
  if(row.published_recipient_email&&row.published_recipient_email!==recipientEmail)recipientEmail=null;
  if(row.deliveryMode==='direct_legacy')recipientEmail=null; // Old attempts never froze their destination address.
  return {divisionId:owner.division_id,sourceId:row.source_id,sourceName:'Project Alpha',workspaceId:row.workspace_id,
    workspaceName:text(binding.workspace_name),folderLabel:text(binding.owner_name),recipientEmail,
    contextProof:await nativeNotificationHash(JSON.stringify([row.scopeKey,binding,owner,recipientIdentity]))};
}
export async function authorizeNativeDeliveryNotification(env:Env,row:NativeNotificationRow){
  if(row.deliveryMode!=='staged'||row.status!=='pending'||row.attempt_count>=3)return null;
  return authorizePortalDeliveryNotificationBatch(env,{...row,id:row.storageId});
}
const allowed=(grants:GrantRow[],principal:StaffPrincipal,permission:"delivery.share.audit"|"delivery.share.create"|"delivery.share.revoke",scope:NativeNotificationScope)=>evaluatePermission(grants,principal,permission,{divisionId:scope.divisionId});
export function presentNativeDeliveryNotification(row:NativeNotificationRow,scope:NativeNotificationScope,sendable:boolean,grants:GrantRow[],principal:StaffPrincipal){
  return {kind:'portal_delivery' as const,id:row.id,revision:row.revision,status:row.status,deliveryMode:row.deliveryMode,
    sourceName:scope.sourceName,workspaceName:scope.workspaceName,folderLabel:scope.folderLabel,recipientEmail:scope.recipientEmail,
    eventLabel:row.eventType==='granted'?'Delivery available':'Delivery access revoked',eligibleAt:iso(row.eligible_at),
    createdAt:row.createdAt,updatedAt:iso(row.updated_at),deliveredAt:row.delivered_at?iso(row.delivered_at):null,
    errorCode:row.last_error?(row.status==='suppressed'?'no-longer-eligible':row.status==='failed'||row.status==='pending'?'delivery-attempt-failed':null):null,
    canSendNow:row.deliveryMode==='staged'&&row.status==='pending'&&sendable&&allowed(grants,principal,'delivery.share.create',scope),
    canCancel:row.deliveryMode==='staged'&&row.status==='pending'&&allowed(grants,principal,'delivery.share.revoke',scope)};
}
async function policy(env:Env,principal:StaffPrincipal){
  const [staff,grants]=await Promise.all([
    env.OPS_DB.withSession('first-primary').prepare("SELECT email,access_subject,project_alpha_user_id FROM staff_users WHERE id=? AND status='active'")
      .bind(principal.id).first<{email:string;access_subject:string|null;project_alpha_user_id:string|null}>(),loadGrants(env,principal.id)]);
  if(!staff||staff.email!==principal.email||staff.access_subject!==principal.accessSubject||staff.project_alpha_user_id!==principal.projectAlphaUserId)
    throw new HTTPException(403,{message:'Current staff authentication required'});
  return {grants,proof:await nativeNotificationHash(JSON.stringify([staff,grants.map(g=>JSON.stringify(g)).sort()]))};
}
export async function readNativeDeliveryNotification(env:Env,id:string,principal:StaffPrincipal){
  await ready(env);const access=await policy(env,principal),row=await exact(env,id),scope=row?await readNativeDeliveryNotificationScope(env,row):null;
  if(!row||!scope||!allowed(access.grants,principal,'delivery.share.audit',scope))unavailable();
  const auth=await authorizeNativeDeliveryNotification(env,row);
  if((await readNativeDeliveryNotificationScope(env,row))?.contextProof!==scope.contextProof
    ||JSON.stringify(await authorizeNativeDeliveryNotification(env,row))!==JSON.stringify(auth)
    ||JSON.stringify(await exact(env,id))!==JSON.stringify(row)||(await policy(env,principal)).proof!==access.proof)changed();
  return {item:presentNativeDeliveryNotification(row,scope,Boolean(auth),access.grants,principal),serverNow:new Date().toISOString()};
}
export const getPortalDeliveryNotificationBatch=readNativeDeliveryNotification;
type ControlReceipt={batch_id:string;fingerprint:string;action:'send-now'|'cancel';result_revision:number;result_status:'pending'|'cancelled'};
export async function controlNativeDeliveryNotification(env:Env,principal:StaffPrincipal,id:string,action:'send-now'|'cancel',expectedRevision:number,key:string){
  if(!/^[A-Za-z0-9._:-]{16,128}$/.test(key)||!Number.isSafeInteger(expectedRevision)||expectedRevision<1||expectedRevision>=Number.MAX_SAFE_INTEGER
    ||!['send-now','cancel'].includes(action))throw new HTTPException(400,{message:'Notification action identifiers are invalid'});
  await ready(env);const access=await policy(env,principal),row=await exact(env,id),scope=row?await readNativeDeliveryNotificationScope(env,row):null;
  if(!row||row.deliveryMode!=='staged'||!scope||!allowed(access.grants,principal,'delivery.share.audit',scope)
    ||!allowed(access.grants,principal,action==='send-now'?'delivery.share.create':'delivery.share.revoke',scope))unavailable();
  const fingerprint=await nativeNotificationHash(JSON.stringify([principal.id,id,action,expectedRevision]));
  const receipt=()=>env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT batch_id,fingerprint,action,result_revision,result_status
    FROM portal_delivery_notification_controls WHERE actor_id=? AND mutation_key=?`).bind(principal.id,key).first<ControlReceipt>();
  const recheck=async()=>{if((await readNativeDeliveryNotificationScope(env,row))?.contextProof!==scope.contextProof||(await policy(env,principal)).proof!==access.proof)changed();};
  const result=(saved:ControlReceipt,replayed:boolean)=>{
    if(saved.fingerprint!==fingerprint)throw new HTTPException(409,{message:'This request key was already used for a different notification action'});
    return {ok:true as const,id,action:saved.action,revision:saved.result_revision,status:saved.result_status,replayed};};
  const prior=await receipt();await recheck();if(prior)return result(prior,true);
  if(row.status!=='pending'||row.revision!==expectedRevision)changed();
  const auth=action==='send-now'?await authorizeNativeDeliveryNotification(env,row):null;
  if(action==='send-now'&&!auth)changed();
  const guard=auth?.guard??nativeBindingGuard(row),status=action==='cancel'?'cancelled':'pending';
  let applied=false;
  try{
    await recheck();
    const transaction=await env.DELIVERY_DB.batch([
      env.DELIVERY_DB.prepare(`UPDATE portal_delivery_notification_batches SET status=?,revision=revision+1,
        sealed_at=COALESCE(sealed_at,datetime('now')),eligible_at=CASE WHEN ?='send-now' THEN datetime('now') ELSE eligible_at END,updated_at=datetime('now')
        WHERE id=? AND revision=? AND status='pending' AND ${guard.sql}`)
        .bind(status,action,row.storageId,expectedRevision,...guard.bindings),
      env.DELIVERY_DB.prepare(`INSERT INTO portal_delivery_notification_controls(actor_id,mutation_key,fingerprint,batch_id,action,expected_revision,result_revision,result_status)
        SELECT ?,?,?,?,?,?,?,? WHERE changes()=1`).bind(principal.id,key,fingerprint,row.storageId,action,expectedRevision,expectedRevision+1,status),
      env.DELIVERY_DB.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
        SELECT 'staff',?,?,'portal_delivery_notification_batch',?,? WHERE changes()=1`).bind(principal.id,
          action==='cancel'?'portal.delivery.notification.cancelled':'portal.delivery.notification.send_requested',row.storageId,
          JSON.stringify({sourceId:row.source_id,workspaceId:row.workspace_id,divisionId:scope.divisionId,expectedRevision})),
    ]);applied=Number(transaction[0]?.meta.changes||0)===1;
  }catch(error){const raced=await receipt();if(raced){await recheck();return result(raced,true);}throw error;}
  const saved=await receipt();if(!saved)changed();await recheck();return result(saved,!applied);
}
