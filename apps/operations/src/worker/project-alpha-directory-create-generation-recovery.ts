import { readAuthorizedDirectoryCreateReservation } from "./project-alpha-directory-profile-outbox-dispatcher";
import { directoryCreateRecoveryGrant as grant,directoryCreateRecoveryActorCurrent as currentActor } from "./project-alpha-directory-create-recovery-reservation";
import { readConfiguredProjectAlphaDirectoryInventory } from "./project-alpha-directory-command-api-v2";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { persistProjectAlphaDirectoryInventoryPage } from "./project-alpha-v2-sync";
import { sendConfiguredProjectAlphaDirectoryCreate,validatedProjectAlphaDirectoryCreateGenerationConflict }
  from "./project-alpha-directory-profile-api-v2";
import type { ProjectAlphaDirectoryCreateCommand as ProjectAlphaWireCreateCommand }
  from "./project-alpha-directory-profile-api-v2";
import { planDirectoryCreateGenerationRecovery,type DirectoryCreateCommand } from "./project-alpha-directory-create-generation-recovery-proposal";

export type DirectoryCreateRecoveryEnvironment={OPS_DB:D1Database;PROJECT_ALPHA_API_V2_CONNECTIONS?:string;
  PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED?:string};
export type DirectoryCreateRecoveryActor={staffId:string;accessSubject:string;email:string;admissionVersion:number;
  profileVersion:number;verifiedUntil:string};
export type DirectoryCreateRecoveryInput={authorizationId:string;predecessorCommandId:string;successorCommandId:string;
  sourceId:string;reason:string};
export type DirectoryCreateRecoveryOutcome={status:"prepared";successorCommandId:string;generation:string;replayed:boolean}
  |{status:"blocked";reason:"disabled"|"configuration"|"authority"|"stale"|"not_eligible"|"generation"|"depth"}
  |{status:"conflict";reason:"authorization_id"}|{status:"uncertain";reason:"database"};
type Row={root_command_id:string;recovery_depth:number;intent_id:string;record_id:string;record_kind:"client"|"organization";
  source_id:string;application_id:string;expected_source_instance_id:string;expected_history_epoch_id:string;
  destination_base_url:string;external_id:string;command_json:string;origin_snapshot_json:string;outcome_json:string|null;
  state:string;audit_actor_id:string;audit_subject:string;audit_command_json:string};
type Prior={predecessor_command_id:string;successor_command_id:string;source_id:string;observed_authorization_generation:string;
  actor_staff_id:string;actor_access_subject:string;actor_email:string;actor_admission_version:number;actor_profile_version:number;
  record_id:string;profile_grant_id:string;identity_grant_id:string;enrollment_grant_id:string;reason:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECOVERABLE_GENERATION=/^(?:0|[1-9][0-9]{0,18})$/;
const MAX_GENERATION=9223372036854775807n;
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
async function prior(db:D1Database,id:string){return db.withSession("first-primary").prepare(`SELECT predecessor_command_id,successor_command_id,source_id,
  observed_authorization_generation,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,
  actor_profile_version,record_id,profile_grant_id,identity_grant_id,enrollment_grant_id,reason
  FROM project_alpha_directory_create_generation_recoveries WHERE authorization_id=?`).bind(id).first<Prior>();}
function replay(p:Prior,i:DirectoryCreateRecoveryInput,a:Omit<DirectoryCreateRecoveryActor,"verifiedUntil">):DirectoryCreateRecoveryOutcome{return p.predecessor_command_id===i.predecessorCommandId&&p.successor_command_id===i.successorCommandId&&p.source_id===i.sourceId
  &&p.reason===i.reason&&p.actor_staff_id===a.staffId&&p.actor_access_subject===a.accessSubject&&p.actor_email===a.email
  &&p.actor_admission_version===a.admissionVersion&&p.actor_profile_version===a.profileVersion
    ?{status:"prepared",successorCommandId:p.successor_command_id,generation:p.observed_authorization_generation,replayed:true}
    :{status:"conflict",reason:"authorization_id"};}
async function load(db:D1Database,id:string){return db.withSession("first-primary").prepare(`SELECT
  COALESCE(recovery.root_command_id,materialization.command_id) root_command_id,COALESCE(recovery.recovery_depth,0) recovery_depth,
  intent.intent_id,intent.record_id,record.record_kind,outbox.source_id,outbox.application_id,outbox.expected_source_instance_id,
  outbox.expected_history_epoch_id,outbox.destination_base_url,outbox.external_id,outbox.command_json,outbox.origin_snapshot_json,
  outbox.outcome_json,outbox.state,audit.actor_id audit_actor_id,audit.original_verified_access_subject audit_subject,
  audit.command_json audit_command_json FROM project_alpha_directory_outbox outbox
  LEFT JOIN project_alpha_directory_create_generation_recoveries recovery ON recovery.successor_command_id=outbox.command_id
  JOIN operations_directory_materializations materialization ON materialization.command_id=COALESCE(recovery.root_command_id,outbox.command_id)
  JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
  JOIN operations_directory_records record ON record.record_id=intent.record_id
  JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id AND audit.record_id=intent.record_id
    AND audit.record_version=intent.record_version WHERE outbox.command_id=?`).bind(id).first<Row>();}
export async function prepareDirectoryCreateGenerationRecovery(env:DirectoryCreateRecoveryEnvironment,input:DirectoryCreateRecoveryInput,
 actor:DirectoryCreateRecoveryActor,send:typeof fetch=fetch):Promise<DirectoryCreateRecoveryOutcome>{
 const expiry=Date.parse(actor.verifiedUntil);
 return prepareRecovery(env,input,actor,()=>Promise.resolve(Number.isFinite(expiry)&&expiry>Date.now()),false,send);
}
async function prepareRecovery(env:DirectoryCreateRecoveryEnvironment,input:DirectoryCreateRecoveryInput,
 actor:Omit<DirectoryCreateRecoveryActor,"verifiedUntil">,authority:()=>Promise<boolean>,sharedTransport:boolean,
 send:typeof fetch):Promise<DirectoryCreateRecoveryOutcome>{
  if(env.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED!=="true")return{status:"blocked",reason:"disabled"};
  if(!UUID.test(input.authorizationId)||!UUID.test(input.predecessorCommandId)||!UUID.test(input.successorCommandId)
    ||input.reason.length<1||input.reason.length>500||!await authority())return{status:"blocked",reason:"authority"};
  try{
    if(!await currentActor(env.OPS_DB,actor))return{status:"blocked",reason:"authority"};
    const old=await prior(env.OPS_DB,input.authorizationId);if(old){const exact=replay(old,input,actor);if(exact.status!=="prepared")return exact;
      const grants=await Promise.all([grant(env.OPS_DB,actor.staffId,"directory.profile.edit",old.record_id),
        grant(env.OPS_DB,actor.staffId,"directory.identity.link",old.record_id),
        grant(env.OPS_DB,actor.staffId,"directory.enrollment.manage",old.record_id)]);
      return grants[0]===old.profile_grant_id&&grants[1]===old.identity_grant_id&&grants[2]===old.enrollment_grant_id
        ?exact:{status:"blocked",reason:"authority"};}
    const row=await load(env.OPS_DB,input.predecessorCommandId);if(!row)return{status:"blocked",reason:"stale"};
    if(row.recovery_depth>=3)return{status:"blocked",reason:"depth"};
    let command:DirectoryCreateCommand,audit:Record<string,unknown>,outcome:Record<string,unknown>;
    try{command=JSON.parse(row.command_json);audit=JSON.parse(row.audit_command_json);outcome=JSON.parse(row.outcome_json??"");}catch{return{status:"blocked",reason:"not_eligible"};}
    if(row.state!=="terminal"||outcome.httpStatus!==409||row.source_id!==input.sourceId||row.audit_actor_id!==actor.staffId
      ||row.audit_subject!==actor.accessSubject||!plain(audit.actor)||audit.actor.loginEmail!==actor.email
      ||audit.actor.admissionVersion!==actor.admissionVersion||audit.actor.profileVersion!==actor.profileVersion)
      return{status:"blocked",reason:"not_eligible"};
    const grants=await Promise.all([grant(env.OPS_DB,actor.staffId,"directory.profile.edit",row.record_id),
      grant(env.OPS_DB,actor.staffId,"directory.identity.link",row.record_id),grant(env.OPS_DB,actor.staffId,"directory.enrollment.manage",row.record_id)]);
    if(grants.some(value=>!value))return{status:"blocked",reason:"authority"};
    let configured:ReturnType<typeof resolveProjectAlphaApiV2Connection>;try{configured=resolveProjectAlphaApiV2Connection(env,input.sourceId);}catch{return{status:"blocked",reason:"configuration"};}
    if(!configured.enabled||configured.connection.expectedSourceInstanceId!==row.expected_source_instance_id
      ||configured.connection.expectedApplicationId!==row.application_id||configured.connection.expectedHistoryEpoch!==row.expected_history_epoch_id
      ||new URL(configured.connection.baseUrl).origin!==new URL(row.destination_base_url).origin)return{status:"blocked",reason:"configuration"};
    const validateSharedTransport=sharedTransport||(row.record_kind==="client"&&command.fields.organizationPublicId!==null);
    let replayCommand:ProjectAlphaWireCreateCommand;
    if(validateSharedTransport){
      const checked=await readAuthorizedDirectoryCreateReservation(env,input.sourceId,input.predecessorCommandId);
      if(!checked)return{status:"blocked",reason:"authority"};replayCommand=checked;
    }else if(row.record_kind==="organization")replayCommand={commandId:command.commandId,externalId:command.externalId,
      expectedAuthorizationGeneration:command.expectedAuthorizationGeneration,
      profile:command.fields as Extract<ProjectAlphaWireCreateCommand,{organization?:never}>["profile"]};
    else{const fields={...command.fields} as Record<string,unknown>;if(fields.organizationPublicId!==null)return{status:"blocked",reason:"not_eligible"};
      delete fields.organizationPublicId;replayCommand={commandId:command.commandId,externalId:command.externalId,
        expectedAuthorizationGeneration:command.expectedAuthorizationGeneration,
        profile:fields as Extract<ProjectAlphaWireCreateCommand,{organization:unknown}>["profile"],organization:null};}
    const replayCommandJson=JSON.stringify(replayCommand);
    let replayAuthorityRejected=false;
    const replayOutcome=await sendConfiguredProjectAlphaDirectoryCreate(env,input.sourceId,row.record_kind,replayCommand,send,async body=>{
      const selected=await Promise.all([grant(env.OPS_DB,actor.staffId,"directory.profile.edit",row.record_id),
        grant(env.OPS_DB,actor.staffId,"directory.identity.link",row.record_id),grant(env.OPS_DB,actor.staffId,"directory.enrollment.manage",row.record_id)]);
      const checked=validateSharedTransport?await readAuthorizedDirectoryCreateReservation(env,input.sourceId,input.predecessorCommandId):replayCommand;
      if(!await authority()||!await currentActor(env.OPS_DB,actor)||selected.some((v,n)=>v!==grants[n])
       ||!checked||JSON.stringify(checked)!==body){replayAuthorityRejected=true;throw Error("recovery authority changed");}
    });
    if(replayAuthorityRejected)return{status:"blocked",reason:"authority"};
    const conflictProof=validatedProjectAlphaDirectoryCreateGenerationConflict(replayOutcome);
    if(!conflictProof||conflictProof.commandJson!==replayCommandJson
      ||conflictProof.destinationOrigin!==new URL(row.destination_base_url).origin
      ||conflictProof.sourceInstanceId!==row.expected_source_instance_id||conflictProof.applicationId!==row.application_id
      ||conflictProof.historyEpoch!==row.expected_history_epoch_id)return{status:"blocked",reason:"not_eligible"};
    const observed=await readConfiguredProjectAlphaDirectoryInventory(env,input.sourceId,{type:"all",limit:1},send);
    if(observed.status!=="observed"||observed.inventory.sourceInstanceId!==row.expected_source_instance_id
      ||observed.inventory.applicationId!==row.application_id||observed.inventory.historyEpoch!==row.expected_history_epoch_id
      ||!RECOVERABLE_GENERATION.test(observed.inventory.authorizationGeneration)
      ||BigInt(observed.inventory.authorizationGeneration)>=MAX_GENERATION)return{status:"blocked",reason:"generation"};
    if(!await authority()||!await currentActor(env.OPS_DB,actor))return{status:"blocked",reason:"authority"};
    if(validateSharedTransport){const checked=await readAuthorizedDirectoryCreateReservation(env,input.sourceId,input.predecessorCommandId);
      if(!checked||JSON.stringify(checked)!==replayCommandJson)return{status:"blocked",reason:"stale"};}
    const persisted=await persistProjectAlphaDirectoryInventoryPage(env.OPS_DB,observed.inventory,null);
    if(persisted.status!=="persisted"||persisted.continuationIdentity.authorizationGeneration!==observed.inventory.authorizationGeneration)return{status:"blocked",reason:"generation"};
    const successor=planDirectoryCreateGenerationRecovery(command,{predecessorCommandId:input.predecessorCommandId,
      successorCommandId:input.successorCommandId,predecessorState:"terminal",predecessorHttpStatus:409,
      observedAuthorizationGeneration:observed.inventory.authorizationGeneration});
    if(!successor||!plain(audit.actor)||typeof audit.actor.selectedGrantId!=="string"
      ||typeof audit.actor.selectedIdentityGrantId!=="string")
      return{status:"blocked",reason:"not_eligible"};const successorJson=JSON.stringify(successor);
    if(!await authority()||!await currentActor(env.OPS_DB,actor))return{status:"blocked",reason:"authority"};
    await env.OPS_DB.batch([env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_create_generation_recoveries(
      authorization_id,root_command_id,predecessor_command_id,successor_command_id,recovery_depth,intent_id,source_id,
      source_instance_id,application_id,history_epoch_id,destination_origin,resource_type,record_id,external_id,
      predecessor_command_json,successor_command_json,generation_conflict_request_id,generation_conflict_code,
      observed_inventory_request_id,observed_authorization_generation,
      actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,
      original_profile_grant_id,original_identity_grant_id,profile_grant_id,
      identity_grant_id,enrollment_grant_id,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(input.authorizationId,row.root_command_id,input.predecessorCommandId,input.successorCommandId,row.recovery_depth+1,row.intent_id,
        row.source_id,row.expected_source_instance_id,row.application_id,row.expected_history_epoch_id,new URL(row.destination_base_url).origin,
        row.record_kind,row.record_id,row.external_id,row.command_json,successorJson,conflictProof.requestId,
        "authorization_generation_conflict",observed.inventory.requestId,
        observed.inventory.authorizationGeneration,actor.staffId,actor.accessSubject,actor.email,actor.admissionVersion,actor.profileVersion,
        audit.actor.selectedGrantId,audit.actor.selectedIdentityGrantId,grants[0],grants[1],grants[2],input.reason),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,
        source_id,application_id,resource_type,external_id,command_json,destination_base_url,expected_source_instance_id,
        origin_snapshot_json,next_attempt_at,expected_history_epoch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(input.successorCommandId,
        row.source_id,row.application_id,row.record_kind,row.external_id,successorJson,new URL(row.destination_base_url).origin,
        row.expected_source_instance_id,row.origin_snapshot_json,Date.now(),row.expected_history_epoch_id)]);
    return{status:"prepared",successorCommandId:input.successorCommandId,generation:observed.inventory.authorizationGeneration,replayed:false};
  }catch{return{status:"uncertain",reason:"database"};}
}

/** Durable approval delegation, not a human authentication session. Authority
 * is derived afresh from the exact immutable approved decision and audited
 * original reviewer; current native admission/profile/grants still fence it. */
async function approvedOnboardingActor(db:D1Database,commandId:string){
 return db.withSession("first-primary").prepare(`SELECT decision.decision_id,decision.reviewer_staff_id staffId,
 decision.reviewer_subject accessSubject,decision.reviewer_email email,decision.original_admission_version admissionVersion,
 decision.original_profile_version profileVersion FROM operations_directory_effective_materializations m
 JOIN project_alpha_directory_outbox outbox ON outbox.command_id=m.command_id
 JOIN operations_directory_intents intent ON intent.intent_id=m.intent_id
 JOIN operations_directory_records record ON record.record_id=intent.record_id AND record.current_version=intent.record_version
 JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id AND audit.record_id=intent.record_id
  AND audit.record_version=intent.record_version AND audit.actor_type='staff'
 JOIN client_onboarding_decisions decision ON decision.outcome='approved' AND decision.reviewer_staff_id=audit.actor_id
  AND decision.reviewer_subject=audit.original_verified_access_subject
  AND decision.reviewer_email=json_extract(audit.command_json,'$.actor.loginEmail')
  AND decision.original_admission_version=json_extract(audit.command_json,'$.actor.admissionVersion')
  AND decision.original_profile_version=json_extract(audit.command_json,'$.actor.profileVersion')
 JOIN client_onboarding_portal_activation_intents activation ON activation.decision_id=decision.decision_id AND activation.state='pending'
 WHERE outbox.command_id=? AND outbox.state='terminal' AND json_extract(outbox.outcome_json,'$.httpStatus')=409
 AND json_extract(outbox.command_json,'$.operation')='create'
 AND ((record.record_id=decision.client_record_id AND record.current_version=decision.client_record_version
       AND json_extract(audit.command_json,'$.createAdmissionId')='client-onboarding:'||decision.decision_id||':client')
  OR (record.record_id=decision.organization_record_id AND record.current_version=decision.organization_record_version
       AND json_extract(audit.command_json,'$.createAdmissionId')='client-onboarding:'||decision.decision_id||':organization')
  OR EXISTS(SELECT 1 FROM client_onboarding_shared_company_child_receipts receipt
   JOIN client_onboarding_shared_company_plan_children child ON child.plan_id=receipt.plan_id AND child.client_record_id=receipt.client_record_id
   WHERE receipt.decision_id=decision.decision_id AND child.client_record_id=record.record_id AND record.current_version=1
    AND child.mutation_id=intent.mutation_id AND child.create_admission_id=json_extract(audit.command_json,'$.createAdmissionId')))
 AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_state lifecycle WHERE lifecycle.record_id=record.record_id AND lifecycle.status<>'active')
 AND NOT EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
  LEFT JOIN operations_directory_records parent ON parent.record_id=relation.organization_record_id AND parent.record_kind='organization'
  LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=relation.organization_record_id
  WHERE relation.client_record_id=record.record_id AND relation.organization_record_id IS NOT NULL
   AND (parent.record_id IS NULL OR coalesce(lifecycle.status,'active')<>'active'))
 AND EXISTS(SELECT 1 FROM json_each(activation.destinations_json) destination
  WHERE json_extract(destination.value,'$.sourceId')=intent.source_id
   AND json_extract(destination.value,'$.sourceInstanceUUID')=intent.source_instance_uuid
   AND json_extract(destination.value,'$.applicationUUID')=intent.application_uuid
   AND json_extract(destination.value,'$.historyEpoch')=intent.expected_history_epoch_id
   AND json_extract(destination.value,'$.origin')=intent.destination_origin)
 AND EXISTS(SELECT 1 FROM effective_native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination
  WHERE enrollment.record_id=record.record_id AND json_extract(destination.value,'$.sourceId')=intent.source_id
   AND json_extract(destination.value,'$.sourceInstanceUUID')=intent.source_instance_uuid
   AND json_extract(destination.value,'$.applicationUUID')=intent.application_uuid
   AND json_extract(destination.value,'$.historyEpoch')=intent.expected_history_epoch_id
   AND json_extract(destination.value,'$.origin')=intent.destination_origin
   AND json_extract(destination.value,'$.externalCanonicalId')=intent.external_canonical_id)
 LIMIT 2`).bind(commandId).all<Omit<DirectoryCreateRecoveryActor,"verifiedUntil">&{decision_id:string}>();
}
export async function prepareApprovedOnboardingCreateGenerationRecovery(
 env:DirectoryCreateRecoveryEnvironment&{CLIENT_ONBOARDING_ADMIN_ENABLED?:string},input:DirectoryCreateRecoveryInput,
 send:typeof fetch=fetch):Promise<DirectoryCreateRecoveryOutcome>{
 if(env.CLIENT_ONBOARDING_ADMIN_ENABLED!=="true"||env.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED!=="true")
  return{status:"blocked",reason:"disabled"};
 const selected=(await approvedOnboardingActor(env.OPS_DB,input.predecessorCommandId)).results;
 if(selected.length!==1)return{status:"blocked",reason:"authority"};
 const original=selected[0]!;
 const authority=async()=>{const current=(await approvedOnboardingActor(env.OPS_DB,input.predecessorCommandId)).results;
  return current.length===1&&JSON.stringify(current[0])===JSON.stringify(original);};
 return prepareRecovery(env,input,original,authority,true,send);
}

/** Candidate qualification only; the recovery service repeats it after network
 * waits and still checks current admission and all three native permissions. */
export async function hasApprovedOnboardingCreateRecovery(env:{OPS_DB:D1Database},commandId:string){
 return (await approvedOnboardingActor(env.OPS_DB,commandId)).results.length===1;
}
