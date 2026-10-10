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
function replay(p:Prior,i:DirectoryCreateRecoveryInput,a:DirectoryCreateRecoveryActor):DirectoryCreateRecoveryOutcome{return p.predecessor_command_id===i.predecessorCommandId&&p.successor_command_id===i.successorCommandId&&p.source_id===i.sourceId
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
async function grant(db:D1Database,staff:string,permission:string,record:string):Promise<string|null>{return db.withSession("first-primary")
  .prepare(`SELECT allow_grant.id FROM native_directory_grants allow_grant WHERE allow_grant.staff_id=?
    AND allow_grant.permission=? AND allow_grant.effect='allow' AND allow_grant.active=1
    AND (allow_grant.scope_kind='global' OR allow_grant.scope_kind='resource' AND allow_grant.resource_id=?
      OR allow_grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=? AND a.staff_id=? AND a.active=1)
      OR allow_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.business_area_id=allow_grant.business_area_id)
      OR allow_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.division_id=allow_grant.division_id))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=? AND deny.permission=? AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR deny.scope_kind='resource' AND deny.resource_id=?
        OR deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=? AND a.staff_id=? AND a.active=1)
        OR deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.business_area_id=deny.business_area_id)
        OR deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.division_id=deny.division_id)))
    ORDER BY CASE allow_grant.scope_kind WHEN 'resource' THEN 1 WHEN 'division' THEN 2 WHEN 'business_area' THEN 3 WHEN 'assigned' THEN 4 ELSE 5 END,allow_grant.id LIMIT 1`)
  .bind(staff,permission,record,record,staff,record,record,staff,permission,record,record,staff,record,record).first<string>("id");}
async function currentActor(db:D1Database,actor:Omit<DirectoryCreateRecoveryActor,"verifiedUntil">):Promise<boolean>{return !!await db.withSession("first-primary")
  .prepare(`SELECT 1 present FROM staff_users staff JOIN native_staff_admissions admission ON admission.staff_id=staff.id
    JOIN native_staff_profiles profile ON profile.staff_id=staff.id WHERE staff.id=? AND staff.status='active'
    AND staff.access_subject=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
    AND profile.login_email=? AND profile.version=?`).bind(actor.staffId,actor.accessSubject,actor.accessSubject,
      actor.admissionVersion,actor.email,actor.profileVersion).first();}

export type DirectoryCreateRecoveryReservationProof={profileGrantId:string;identityGrantId:string;enrollmentGrantId:string;
  rootCommandJson:string;rootCommandId:string;authorizationId:string};
/** Presend-only validator. Historical acknowledgements must use the immutable
 * ledger without requiring these current grants to remain active. */
export async function validateDirectoryCreateRecoveryReservation(db:D1Database,commandId:string,
  actor:Omit<DirectoryCreateRecoveryActor,"verifiedUntil">):Promise<DirectoryCreateRecoveryReservationProof|null>{
  if(!await currentActor(db,actor))return null;
  const row=await db.withSession("first-primary").prepare(`SELECT recovery.authorization_id,recovery.root_command_id,
      root.command_json root_command_json,recovery.record_id,recovery.actor_staff_id,recovery.actor_access_subject,
      recovery.actor_email,recovery.actor_admission_version,recovery.actor_profile_version,recovery.profile_grant_id,
      recovery.identity_grant_id,recovery.enrollment_grant_id
    FROM project_alpha_directory_create_generation_recoveries recovery
    JOIN project_alpha_directory_outbox root ON root.command_id=recovery.root_command_id
    JOIN native_staff_admissions admission ON admission.staff_id=recovery.actor_staff_id
      AND admission.active=1 AND admission.bound_access_subject=recovery.actor_access_subject
      AND admission.version=recovery.actor_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=recovery.actor_staff_id
      AND profile.login_email=recovery.actor_email AND profile.version=recovery.actor_profile_version
    WHERE recovery.successor_command_id=?`).bind(commandId).first<Record<string,unknown>>();
  if(!row||row.actor_staff_id!==actor.staffId||row.actor_access_subject!==actor.accessSubject||row.actor_email!==actor.email
    ||row.actor_admission_version!==actor.admissionVersion||row.actor_profile_version!==actor.profileVersion)return null;
  const selected=await Promise.all([grant(db,actor.staffId,"directory.profile.edit",String(row.record_id)),
    grant(db,actor.staffId,"directory.identity.link",String(row.record_id)),grant(db,actor.staffId,"directory.enrollment.manage",String(row.record_id))]);
  if(selected[0]!==row.profile_grant_id||selected[1]!==row.identity_grant_id||selected[2]!==row.enrollment_grant_id)return null;
  return{profileGrantId:selected[0]!,identityGrantId:selected[1]!,enrollmentGrantId:selected[2]!,
    rootCommandJson:String(row.root_command_json),rootCommandId:String(row.root_command_id),authorizationId:String(row.authorization_id)};
}

export async function prepareDirectoryCreateGenerationRecovery(env:DirectoryCreateRecoveryEnvironment,input:DirectoryCreateRecoveryInput,
  actor:DirectoryCreateRecoveryActor,send:typeof fetch=fetch):Promise<DirectoryCreateRecoveryOutcome>{
  if(env.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED!=="true")return{status:"blocked",reason:"disabled"};
  const verifiedUntil=Date.parse(actor.verifiedUntil);
  if(!UUID.test(input.authorizationId)||!UUID.test(input.predecessorCommandId)||!UUID.test(input.successorCommandId)
    ||input.reason.length<1||input.reason.length>500||!Number.isFinite(verifiedUntil)||verifiedUntil<=Date.now())return{status:"blocked",reason:"authority"};
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
    let replayCommand:ProjectAlphaWireCreateCommand;
    if(row.record_kind==="organization")replayCommand={commandId:command.commandId,externalId:command.externalId,
      expectedAuthorizationGeneration:command.expectedAuthorizationGeneration,
      profile:command.fields as Extract<ProjectAlphaWireCreateCommand,{organization?:never}>["profile"]};
    else{const fields={...command.fields} as Record<string,unknown>;if(fields.organizationPublicId!==null)return{status:"blocked",reason:"not_eligible"};
      delete fields.organizationPublicId;replayCommand={commandId:command.commandId,externalId:command.externalId,
        expectedAuthorizationGeneration:command.expectedAuthorizationGeneration,
        profile:fields as Extract<ProjectAlphaWireCreateCommand,{organization:unknown}>["profile"],organization:null};}
    const replayCommandJson=JSON.stringify(replayCommand);
    const replayOutcome=await sendConfiguredProjectAlphaDirectoryCreate(env,input.sourceId,row.record_kind,replayCommand,send);
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
    if(Date.now()>=verifiedUntil||!await currentActor(env.OPS_DB,actor))return{status:"blocked",reason:"authority"};
    const persisted=await persistProjectAlphaDirectoryInventoryPage(env.OPS_DB,observed.inventory,null);
    if(persisted.status!=="persisted"||persisted.continuationIdentity.authorizationGeneration!==observed.inventory.authorizationGeneration)return{status:"blocked",reason:"generation"};
    const successor=planDirectoryCreateGenerationRecovery(command,{predecessorCommandId:input.predecessorCommandId,
      successorCommandId:input.successorCommandId,predecessorState:"terminal",predecessorHttpStatus:409,
      observedAuthorizationGeneration:observed.inventory.authorizationGeneration});
    if(!successor||!plain(audit.actor)||typeof audit.actor.selectedGrantId!=="string"
      ||typeof audit.actor.selectedIdentityGrantId!=="string")
      return{status:"blocked",reason:"not_eligible"};const successorJson=JSON.stringify(successor);
    if(Date.now()>=verifiedUntil||!await currentActor(env.OPS_DB,actor))return{status:"blocked",reason:"authority"};
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
