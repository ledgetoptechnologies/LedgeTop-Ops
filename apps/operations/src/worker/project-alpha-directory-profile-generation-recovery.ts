import {withEnabledConfiguredProjectAlphaApiV2Connection,type ProjectAlphaApiV2ConnectionEnvironment} from './project-alpha-api-v2-connections';
import {readAuthorizedDirectoryProfileUpdateReservation,validatedDirectoryProfileUpdateReservation,dispatchProjectAlphaDirectoryProfileOutboxCommand} from './project-alpha-directory-profile-outbox-dispatcher';
import {profileRecoverySnapshotGuards,sameProfileRecoverySnapshot} from './directory-profile-recovery-reservation';
import {readAutomaticProfileRecoveryIdentity} from './directory-profile-recovery-identity';
import {sendProjectAlphaDirectoryProfileUpdate,sendProjectAlphaDirectoryClientContactProfileUpdate,validatedProjectAlphaDirectoryProfileGenerationConflict,type ProjectAlphaDirectoryProfileUpdateCommand,type ProjectAlphaDirectoryClientContactProfileUpdateCommand} from './project-alpha-directory-profile-api-v2';
import {readConfiguredProjectAlphaDirectoryBindingStatus,readConfiguredProjectAlphaDirectoryProfile} from './project-alpha-directory-read-api-v2';
import type {SharedProfilePortalAuthorityBinding} from '../../../../packages/shared/src/shared-business-profile';
type Environment=ProjectAlphaApiV2ConnectionEnvironment&{OPS_DB:D1Database;DELIVERY_DB?:D1Database;NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED?:string;CLIENT_ONBOARDING_ADMIN_ENABLED?:string;SHARED_PROFILE_PORTAL_AUTHORITY?:SharedProfilePortalAuthorityBinding};
const max=9223372036854775807n;
const generation=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(v)&&BigInt(v)<max;
const parse=(v:string)=>{try{return JSON.parse(v)as Record<string,any>;}catch{return null;}};
async function recoveryId(seed:string){const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(seed))).slice(0,16);b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;const s=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return`${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
export async function profileGenerationRecoverySchema(db:D1Database):Promise<boolean>{
 try{
  const required={
   project_alpha_directory_profile_generation_recoveries:'table',project_alpha_directory_profile_recovery_guards:'table',project_alpha_directory_profile_recovery_checks:'table',
   project_alpha_directory_profile_recovery_edges:'view',operations_directory_effective_materializations:'view',project_alpha_directory_unsettled_commands:'view',
   directory_profile_recovery_exact:'trigger',directory_profile_recovery_immutable:'trigger',directory_profile_recovery_durable:'trigger',directory_profile_recovery_successor:'trigger',
  }as const;
  const rows=(await db.prepare('SELECT name,type,sql FROM sqlite_master WHERE name IN(SELECT value FROM json_each(?))').bind(JSON.stringify(Object.keys(required)))
   .all<{name:string;type:string;sql:string}>()).results;
  if(rows.length!==Object.keys(required).length||rows.some(r=>r.type!==required[r.name as keyof typeof required]))return false;
  const sql=(name:string)=>rows.find(r=>r.name===name)?.sql.toLowerCase()??'';
  return sql('project_alpha_directory_profile_recovery_edges').includes('project_alpha_directory_create_generation_recoveries')
   &&sql('project_alpha_directory_profile_recovery_edges').includes('project_alpha_directory_profile_generation_recoveries')
   &&['operations_directory_effective_materializations','project_alpha_directory_unsettled_commands'].every(name=>sql(name).includes('project_alpha_directory_profile_recovery_edges'));
 }catch{return false;}
}
function sameProfile(profile:Record<string,any>,desired:Record<string,any>,kind:string){
 const map=kind==='organization'?{name:profile.name,generalEmail:profile.email??'',generalPhone:profile.phone??''}:{name:profile.name,email:profile.email??'',phone:profile.phone??''};
 const all={...map,addressLine1:profile.address.line1??'',addressLine2:profile.address.line2??'',city:profile.address.city??'',state:profile.address.state??'',postalCode:profile.address.postalCode??'',country:profile.address.country??''};
 return Object.entries(all).every(([k,v])=>desired[k]===v);
}
function sameFields(a:Record<string,any>|null,b:Record<string,any>|null){return!!a&&!!b&&Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([k,v])=>Object.hasOwn(b,k)&&b[k]===v);}
/** Recovery of an already-authorized immutable profile update, never a new
 * human approval. All uncertain requests retain their exact original command. */
export async function recoverDirectoryProfileGeneration(env:Environment,sourceId:string,predecessorId:string,send:typeof fetch=fetch){
 const blocked=(reason:string)=>({status:'blocked' as const,reason});
 if(env.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED!=='true'||!await profileGenerationRecoverySchema(env.OPS_DB))return blocked('disabled');
 try{
  const successorId=await recoveryId(`directory-profile-successor:${predecessorId}`),authorizationId=await recoveryId(`directory-profile-recovery:${predecessorId}`);
  const old=await env.OPS_DB.prepare('SELECT successor_command_id FROM project_alpha_directory_profile_generation_recoveries WHERE predecessor_command_id=?').bind(predecessorId).first<{successor_command_id:string}>();
  if(old){if(old.successor_command_id!==successorId)return blocked('lineage');return dispatchProjectAlphaDirectoryProfileOutboxCommand(env,sourceId,successorId,send);}
  const token=await readAuthorizedDirectoryProfileUpdateReservation(env,sourceId,predecessorId,false),initial=validatedDirectoryProfileUpdateReservation(token);
  if(!initial)return blocked('authority');const {row,checked}=initial;
  const depth=await env.OPS_DB.prepare('SELECT recovery_depth FROM project_alpha_directory_profile_generation_recoveries WHERE successor_command_id=?').bind(predecessorId).first<number>('recovery_depth')??0;
  if(depth>=3)return blocked('depth');
  const original=parse(row.command_json),root=parse(row.root_command_json);if(!original||!root||!generation(original.expectedAuthorizationGeneration))return blocked('command');
  const approvedNoop=await env.OPS_DB.prepare(`SELECT d.decision_id FROM client_onboarding_decisions d
   WHERE d.outcome='approved' AND d.organization_record_id=? AND d.organization_record_version=?`)
   .bind(row.record_id,row.record_version).first<{decision_id:string}>();
  if(approvedNoop){
   if(env.CLIENT_ONBOARDING_ADMIN_ENABLED!=='true'||row.resource_type!=='organization'||!await env.OPS_DB.prepare(`SELECT 1 FROM client_onboarding_portal_activation_intents WHERE decision_id=? AND state='pending'`).bind(approvedNoop.decision_id).first())return blocked('onboarding');
   const previous=await env.OPS_DB.prepare('SELECT profile_json FROM operations_directory_revisions WHERE record_id=? AND version=?').bind(row.record_id,row.record_version-1).first<string>('profile_json');
   if(!previous||!sameFields(parse(previous),parse(row.revision_profile_json)))return blocked('onboarding_native_not_noop');
  }
  let beforePostFailed=false;
  const current=async(withSnapshot=false)=>{
   const freshToken=await readAuthorizedDirectoryProfileUpdateReservation(env,sourceId,predecessorId,withSnapshot),fresh=validatedDirectoryProfileUpdateReservation(freshToken);
   if(!fresh||fresh.row.command_json!==row.command_json||fresh.row.root_command_id!==row.root_command_id||JSON.stringify(fresh.checked.transport)!==JSON.stringify(checked.transport))return null;
   return fresh;
  };
  const beforePost=async(body:string)=>{if(body!==JSON.stringify(checked.transport)||!await current()){beforePostFailed=true;throw Error('profile recovery authority changed');}};
  const configuredOutcome=await withEnabledConfiguredProjectAlphaApiV2Connection(env,sourceId,connection=>checked.identitySafeContactProfile
   ?sendProjectAlphaDirectoryClientContactProfileUpdate(connection,checked.publicId!,checked.transport as ProjectAlphaDirectoryClientContactProfileUpdateCommand,send,beforePost)
   :sendProjectAlphaDirectoryProfileUpdate(connection,row.resource_type,checked.publicId!,checked.transport as ProjectAlphaDirectoryProfileUpdateCommand,send,beforePost));
  if(configuredOutcome.status!=='enabled')return blocked('configuration');const outcome=configuredOutcome.value;
  if(beforePostFailed)return blocked('authority');
  const refusal=validatedProjectAlphaDirectoryProfileGenerationConflict(outcome);
  if(!refusal||refusal.commandJson!==JSON.stringify(checked.transport)||refusal.destinationOrigin!==row.destination_base_url
   ||refusal.kind!==row.resource_type||refusal.publicId!==checked.publicId||refusal.identitySafeContactProfile!==!!checked.identitySafeContactProfile
   ||refusal.sourceInstanceId!==row.expected_source_instance_id||refusal.applicationId!==row.application_id||refusal.historyEpoch!==row.expected_history_epoch_id)return blocked('nonexecution_not_proven');
  if(!await current())return blocked('authority');
  const binding=await readConfiguredProjectAlphaDirectoryBindingStatus(env,sourceId,row.resource_type,row.external_id,checked.publicId!,send);
  if(binding.status!=='observed'||!await current())return blocked('binding');
  const profile=await readConfiguredProjectAlphaDirectoryProfile(env,sourceId,row.resource_type,checked.publicId!,send);
  if(profile.status!=='observed'||!await current())return blocked('profile');
  const b=binding.observation,p=profile.observation;
  for(const v of [b,p])if(v.sourceId!==sourceId||v.sourceInstanceId!==row.expected_source_instance_id||v.applicationId!==row.application_id
    ||v.historyEpoch!==row.expected_history_epoch_id||v.resource.revision!==original.expectedRevision)return blocked('remote_changed');
  if(b.binding.externalId!==row.external_id||b.binding.publicId!==checked.publicId||p.profile.publicId!==checked.publicId
   ||!generation(b.authorizationGeneration)||b.authorizationGeneration!==p.authorizationGeneration||BigInt(b.authorizationGeneration)<=BigInt(original.expectedAuthorizationGeneration))return blocked('remote_changed');
  if(row.resource_type==='client'&&p.profile.organizationPublicId!==original.fields.organizationPublicId)return blocked('association_changed');
  if(approvedNoop&&!sameProfile(p.profile,original.fields,row.resource_type))return blocked('onboarding_remote_not_noop');
  let identityJson:string|null=null,identityPolicy:'staff'|'reviewed_manual'|'automatic_own'=checked.portalAuthority?'reviewed_manual':'staff';
  let identitySnapshot:Awaited<ReturnType<typeof current>>|null=null;
  if(checked.portalAuthority&&row.resource_type==='client'){
   const grant=checked.portalAuthority.grant,proof=await env.OPS_DB.prepare('SELECT principal_public_id,association_version FROM client_onboarding_portal_activation_proofs WHERE grant_id=?').bind(grant.id).first<{principal_public_id:string;association_version:string}>();
   if(proof){
    identitySnapshot=await current(true);if(!identitySnapshot?.snapshot)return blocked('authority');
    const identity=await readAutomaticProfileRecoveryIdentity(env,grant,{sourceId,sourceInstanceId:row.expected_source_instance_id,applicationId:row.application_id,
     historyEpoch:row.expected_history_epoch_id,recordId:row.record_id,externalId:row.external_id,publicId:checked.publicId!,expectedRevision:original.expectedRevision},send);
    if(identity.status==='denied')return blocked('identity');
    if(identity.status!=='observed')return blocked('identity_unavailable');
    identityJson=JSON.stringify(identity.observation);identityPolicy='automatic_own';
   }
  }
  const final=await current(true);if(!final?.snapshot||Date.now()-final.snapshot.capturedAt>10_000)return blocked('authority');
  if(identitySnapshot?.snapshot&&!sameProfileRecoverySnapshot(identitySnapshot.snapshot,final.snapshot))return blocked('authority');
  // Keep the exact rowsets that bracketed the final semantic proof; every
  // insertion/removal/change is checked inside the same atomic append batch.
  const confirm=final,snapshot=final.snapshot;
  const successor={...original,commandId:successorId,expectedAuthorizationGeneration:b.authorizationGeneration},successorJson=JSON.stringify(successor);
  const guardId=crypto.randomUUID();
  await env.OPS_DB.batch([
   ...profileRecoverySnapshotGuards(env.OPS_DB,snapshot,guardId),
   env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_profile_recovery_guards(id,ok) VALUES(?,CASE WHEN
    CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)<=? THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`)
    .bind(guardId,Math.min(snapshot.capturedAt+10_000,confirm.checked.portalAuthority?Date.parse(confirm.checked.portalAuthority.proof.verifiedUntil):Number.MAX_SAFE_INTEGER)),
   env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_profile_generation_recoveries(authorization_id,root_command_id,predecessor_command_id,successor_command_id,recovery_depth,
    intent_id,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,resource_type,record_id,external_id,predecessor_command_json,successor_command_json,
    actor_json,endpoint_policy,identity_policy,generation_conflict_request_id,generation_conflict_code,observed_authorization_generation,observed_binding_json,observed_profile_json,observed_identity_json,authority_snapshot_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'authorization_generation_conflict',?,?,?,?,?)`)
    .bind(authorizationId,row.root_command_id,predecessorId,successorId,depth+1,row.intent_id,sourceId,row.expected_source_instance_id,row.application_id,row.expected_history_epoch_id,
     row.destination_base_url,row.resource_type,row.record_id,row.external_id,row.command_json,successorJson,JSON.stringify(checked.actor),checked.identitySafeContactProfile?'contact':'regular',identityPolicy,
     refusal.requestId,b.authorizationGeneration,JSON.stringify(b),JSON.stringify(p),identityJson,JSON.stringify(snapshot.fences)),
   env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,destination_base_url,expected_source_instance_id,
    origin_snapshot_json,next_attempt_at,expected_history_epoch_id)VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(successorId,sourceId,row.application_id,row.resource_type,row.external_id,successorJson,row.destination_base_url,row.expected_source_instance_id,row.origin_snapshot_json,Date.now(),row.expected_history_epoch_id),
   env.OPS_DB.prepare('DELETE FROM project_alpha_directory_profile_recovery_guards WHERE id=?').bind(guardId),
  ]);
  return dispatchProjectAlphaDirectoryProfileOutboxCommand(env,sourceId,successorId,send);
 }catch{return{status:'uncertain' as const,reason:'recovery'};}
}
