import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import type { Env } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Checkpoint = Readonly<{sourceGeneration:string;sourceSequence:number;snapshotGenerationId:string}>;
export type WorkspaceBindingCommand = Readonly<{protocolVersion:1;operationId:string;clientAuthorityId:string;
  workspaceId:string;projectionSourceId:string;sourceWorkspaceId:string;rootType:"organization"|"standalone_client";
  rootPublicId:string;expectedCheckpoint:Checkpoint}>;
export type WorkspaceBindingReceipt = Readonly<{ok:true;protocolVersion:1;status:"recorded"|"duplicate";
  operationId:string;clientAuthorityId:string;workspaceId:string;projectionSourceId:string;sourceWorkspaceId:string;
  rootType:"organization"|"standalone_client";rootPublicId:string;checkpoint:Checkpoint;state:"inactive";revision:1}>
  | Readonly<{ok:false;protocolVersion:1;code:"disabled"|"invalid"|"conflict"|"temporarily-unavailable";retryable:boolean}>;
export interface ClientAuthorityWorkspaceBindingBinding {bindWorkspace(input:WorkspaceBindingCommand):Promise<unknown>}
export type WorkspaceBindingEnv = Pick<Env,"OPS_DB"|"CLIENT_AUTHORITY_WORKSPACE_BINDING"|"CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED">;

interface SelectionRow {selection_id:string;client_authority_id:string;workspace_id:string;source_id:string;
  source_workspace_id:string;root_type:"organization"|"standalone_client";root_public_id:string;
  checkpoint_source_generation:string;checkpoint_source_sequence:number;checkpoint_snapshot_generation_id:string;
  reviewed_by_staff_id:string;reviewed_access_subject:string;reviewed_admission_version:number;
  reviewed_profile_version:number;reviewed_grant_generation:number;verified_until:string}
interface OutboxRow extends SelectionRow {operation_id:string;projection_source_id:string;attempt_count:number;claim_token:string}
const denied = ():never => {throw Error("portal_workspace_binding_dispatch_denied");};

/** Route-less owner enqueue. The D1 insert guard repeats every authority and source check atomically. */
export async function enqueuePortalWorkspaceBinding(db:D1Database,
  actor:AuthenticatedNativeStaffWithAdmissionVersion,selectionId:string,
):Promise<{operationId:string;state:string;replayed:boolean}>{
  const actorUntil=Date.parse(actor.verifiedUntil);
  if(!UUID.test(selectionId)||!Number.isFinite(actorUntil)||actorUntil<=Date.now())return denied();
  const session=db.withSession("first-primary");
  const row=await session.prepare(`SELECT selection_id,client_authority_id,workspace_id,source_id,
    source_workspace_id,root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,
    checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,reviewed_admission_version,
    reviewed_profile_version,reviewed_grant_generation,verified_until
    FROM client_portal_workspace_binding_selections WHERE selection_id=?`).bind(selectionId).first<SelectionRow>();
  if(!row||row.reviewed_by_staff_id!==actor.identity.staffId
    ||row.reviewed_access_subject!==actor.identity.verifiedAccessSubject
    ||row.reviewed_admission_version!==actor.admissionVersion
    ||row.reviewed_profile_version!==actor.identity.profileVersion
    ||Date.parse(row.verified_until)<=Date.now())return denied();
  try{
    await session.batch([
      session.prepare(`INSERT INTO client_portal_workspace_binding_outbox
        (operation_id,client_authority_id,workspace_id,projection_source_id,source_workspace_id,
          root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,
          checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,
          reviewed_admission_version,reviewed_profile_version,reviewed_grant_generation)
        SELECT selection_id,client_authority_id,workspace_id,source_id,source_workspace_id,
          root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,
          checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,
          reviewed_admission_version,reviewed_profile_version,reviewed_grant_generation
        FROM client_portal_workspace_binding_selections WHERE selection_id=?`).bind(selectionId),
      session.prepare(`INSERT INTO client_portal_workspace_binding_outbox_audit
        (operation_id,action,reviewed_by_staff_id,reviewed_grant_generation)
        SELECT operation_id,'inactive.binding.enqueued',reviewed_by_staff_id,reviewed_grant_generation
        FROM client_portal_workspace_binding_outbox WHERE operation_id=?`).bind(selectionId),
    ]);
  }catch(error){
    // The insert guard runs before uniqueness checks and revalidates the live
    // reviewer authority. Only an exact duplicate operation may take the
    // replay path; a revoked/stale reviewer must not learn current outbox state.
    if(!/UNIQUE constraint failed:\s*client_portal_workspace_binding_outbox\.(?:operation_id|workspace_id)/i.test(String(error)))return denied();
    const prior=await db.withSession("first-primary").prepare(`SELECT outbox.operation_id,outbox.state,outbox.client_authority_id,
      outbox.workspace_id,outbox.projection_source_id,outbox.source_workspace_id,outbox.root_type,outbox.root_public_id,
      outbox.checkpoint_source_generation,outbox.checkpoint_source_sequence,outbox.checkpoint_snapshot_generation_id,
      outbox.reviewed_by_staff_id,outbox.reviewed_access_subject,outbox.reviewed_admission_version,
      outbox.reviewed_profile_version,outbox.reviewed_grant_generation
      FROM client_portal_workspace_binding_outbox outbox
      JOIN client_portal_workspace_binding_selections selection ON selection.selection_id=outbox.operation_id
      JOIN project_alpha_existing_directory_binding_activation_receipts activation
        ON activation.activation_id=selection.activation_id
      JOIN operations_directory_records record ON record.record_id=selection.record_id
      JOIN native_staff_admissions admission ON admission.staff_id=outbox.reviewed_by_staff_id
      JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
      WHERE outbox.operation_id=? AND selection.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND activation.record_id=selection.record_id AND activation.source_id=selection.source_id
        AND activation.source_instance_id=selection.source_instance_id
        AND activation.application_id=selection.application_id
        AND activation.history_epoch_id=selection.history_epoch_id
        AND activation.project_alpha_public_id=selection.root_public_id
        AND ((activation.resource_type='organization' AND selection.root_type='organization')
          OR (activation.resource_type='client' AND selection.root_type='standalone_client'))
        AND record.current_version=selection.record_version
        AND record.current_version=activation.local_record_version
        AND admission.active=1
        AND admission.bound_access_subject=outbox.reviewed_access_subject
        AND admission.version=outbox.reviewed_admission_version
        AND profile.version=outbox.reviewed_profile_version
        AND generation.generation=outbox.reviewed_grant_generation
        AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
          AND role.role_id='role-owner' AND role.scope='global')
        AND EXISTS(SELECT 1 FROM native_directory_grants grant WHERE grant.staff_id=admission.staff_id
          AND grant.permission='directory.portal_access.manage' AND grant.effect='allow' AND grant.active=1
          AND (grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=selection.record_id)))
        AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=admission.staff_id
          AND deny.permission='directory.portal_access.manage' AND deny.effect='deny' AND deny.active=1
          AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=selection.record_id)
            OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=selection.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
            OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=selection.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))`)
      .bind(selectionId).first<OutboxRow&{state:string}>();
    if(!prior||prior.client_authority_id!==row.client_authority_id||prior.workspace_id!==row.workspace_id
      ||prior.projection_source_id!==row.source_id||prior.source_workspace_id!==row.source_workspace_id
      ||prior.root_type!==row.root_type||prior.root_public_id!==row.root_public_id
      ||prior.checkpoint_source_generation!==row.checkpoint_source_generation
      ||prior.checkpoint_source_sequence!==row.checkpoint_source_sequence
      ||prior.checkpoint_snapshot_generation_id!==row.checkpoint_snapshot_generation_id
      ||prior.reviewed_by_staff_id!==row.reviewed_by_staff_id
      ||prior.reviewed_access_subject!==row.reviewed_access_subject
      ||prior.reviewed_admission_version!==row.reviewed_admission_version
      ||prior.reviewed_profile_version!==row.reviewed_profile_version
      ||prior.reviewed_grant_generation!==row.reviewed_grant_generation)return denied();
    return {operationId:selectionId,state:prior.state,replayed:true};
  }
  const saved=await db.withSession("first-primary").prepare(`SELECT state FROM client_portal_workspace_binding_outbox
    WHERE operation_id=?`).bind(selectionId).first<{state:string}>();
  if(!saved)return denied();
  return {operationId:selectionId,state:saved.state,replayed:false};
}

function plain(value:unknown,keys:readonly string[]):Record<string,unknown>|null{
  try{
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)return null;
    const descriptors=Object.getOwnPropertyDescriptors(value),names=Object.keys(descriptors);
    if(names.length!==keys.length||names.some(key=>!keys.includes(key)||!("value" in descriptors[key]!)))return null;
    return Object.fromEntries(names.map(key=>[key,descriptors[key]!.value]));
  }catch{return null;}
}
function successReceipt(value:unknown,command:WorkspaceBindingCommand):value is Extract<WorkspaceBindingReceipt,{ok:true}>{
  const row=plain(value,["ok","protocolVersion","status","operationId","clientAuthorityId","workspaceId",
    "projectionSourceId","sourceWorkspaceId","rootType","rootPublicId","checkpoint","state","revision"]);
  if(!row||row.ok!==true||row.protocolVersion!==1||(row.status!=="recorded"&&row.status!=="duplicate")
    ||row.operationId!==command.operationId||row.clientAuthorityId!==command.clientAuthorityId
    ||row.workspaceId!==command.workspaceId||row.projectionSourceId!==command.projectionSourceId
    ||row.sourceWorkspaceId!==command.sourceWorkspaceId||row.rootType!==command.rootType
    ||row.rootPublicId!==command.rootPublicId||row.state!=="inactive"||row.revision!==1)return false;
  const checkpoint=plain(row.checkpoint,["sourceGeneration","sourceSequence","snapshotGenerationId"]);
  return Boolean(checkpoint&&checkpoint.sourceGeneration===command.expectedCheckpoint.sourceGeneration
    &&checkpoint.sourceSequence===command.expectedCheckpoint.sourceSequence
    &&checkpoint.snapshotGenerationId===command.expectedCheckpoint.snapshotGenerationId);
}
function definitiveRejection(value:unknown):"invalid"|"conflict"|null{
  const row=plain(value,["ok","protocolVersion","code","retryable"]);
  return row&&row.ok===false&&row.protocolVersion===1&&row.retryable===false
    &&(row.code==="invalid"||row.code==="conflict")?row.code:null;
}
export type WorkspaceBindingDispatchResult={status:"disabled"|"idle"}
  |{status:"acknowledged"|"retry"|"rejected";operationId:string;code?:string};

/** One idempotent private delivery. Ambiguous outcomes retry the SAME command forever. */
export async function dispatchNextPortalWorkspaceBinding(env:WorkspaceBindingEnv):Promise<WorkspaceBindingDispatchResult>{
  if(env.CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED!=="true")return {status:"disabled"};
  if(!env.CLIENT_AUTHORITY_WORKSPACE_BINDING)return {status:"retry",operationId:"configuration",code:"configuration"};
  const db=env.OPS_DB.withSession("first-primary"),claimToken=crypto.randomUUID();
  await db.prepare(`UPDATE client_portal_workspace_binding_outbox
    SET state='dispatching',claim_token=?,claim_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE operation_id=(SELECT operation_id FROM client_portal_workspace_binding_outbox
      WHERE (state IN ('pending','retry') AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (state='dispatching' AND claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ORDER BY created_at,operation_id LIMIT 1)
      AND ((state IN ('pending','retry') AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        OR (state='dispatching' AND claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))`).bind(claimToken).run();
  const row=await db.prepare(`SELECT operation_id,client_authority_id,workspace_id,projection_source_id source_id,
    source_workspace_id,root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,
    checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,reviewed_admission_version,
    reviewed_profile_version,reviewed_grant_generation,attempt_count,claim_token
    FROM client_portal_workspace_binding_outbox WHERE state='dispatching' AND claim_token=?`)
    .bind(claimToken).first<OutboxRow>();
  if(!row)return {status:"idle"};
  const command:WorkspaceBindingCommand={protocolVersion:1,operationId:row.operation_id,
    clientAuthorityId:row.client_authority_id,workspaceId:row.workspace_id,projectionSourceId:row.source_id,
    sourceWorkspaceId:row.source_workspace_id,rootType:row.root_type,rootPublicId:row.root_public_id,
    expectedCheckpoint:{sourceGeneration:row.checkpoint_source_generation,
      sourceSequence:row.checkpoint_source_sequence,snapshotGenerationId:row.checkpoint_snapshot_generation_id}};
  let response:unknown;
  try{response=await env.CLIENT_AUTHORITY_WORKSPACE_BINDING.bindWorkspace(command);}catch{response=null;}
  if(successReceipt(response,command)){
    const receipt=response;
    try{await db.batch([
      db.prepare(`INSERT OR IGNORE INTO client_portal_workspace_binding_outbox_receipts
        (operation_id,client_authority_id,workspace_id,projection_source_id,source_workspace_id,
          root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,
          checkpoint_snapshot_generation_id,state,revision,replayed,acknowledged_claim_token)
        SELECT operation_id,client_authority_id,workspace_id,projection_source_id,source_workspace_id,
          root_type,root_public_id,checkpoint_source_generation,checkpoint_source_sequence,
          checkpoint_snapshot_generation_id,'inactive',1,?,? FROM client_portal_workspace_binding_outbox
        WHERE operation_id=? AND state='dispatching' AND claim_token=?
          AND claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .bind(receipt.status==="duplicate"?1:0,claimToken,row.operation_id,claimToken),
      db.prepare(`UPDATE client_portal_workspace_binding_outbox SET state='acknowledged',
        attempt_count=attempt_count+1,last_error_code=NULL,claim_token=NULL,claim_until=NULL,
        acknowledged_claim_token=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state='dispatching' AND claim_token=?
          AND EXISTS(SELECT 1 FROM client_portal_workspace_binding_outbox_receipts receipt
            WHERE receipt.operation_id=? AND receipt.acknowledged_claim_token=?)`)
        .bind(claimToken,row.operation_id,claimToken,row.operation_id,claimToken),
    ]);}catch{return {status:"retry",operationId:row.operation_id,code:"lease-lost-or-storage"};}
    const acknowledged=await db.prepare(`SELECT 1 ok FROM client_portal_workspace_binding_outbox
      WHERE operation_id=? AND state='acknowledged' AND acknowledged_claim_token=?`)
      .bind(row.operation_id,claimToken).first("ok");
    return acknowledged===1?{status:"acknowledged",operationId:row.operation_id}
      :{status:"retry",operationId:row.operation_id,code:"lease-lost"};
  }
  const rejected=definitiveRejection(response);
  const attempts=row.attempt_count+1,delay=Math.min(3600,15*2**Math.min(attempts,8));
  await db.prepare(`UPDATE client_portal_workspace_binding_outbox
    SET state=?,attempt_count=attempt_count+1,last_error_code=?,
      next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),
      claim_token=NULL,claim_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE operation_id=? AND state='dispatching' AND claim_token=?
      AND claim_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .bind(rejected?"rejected":"retry",rejected??"transport-or-ambiguous",`+${delay} seconds`,row.operation_id,claimToken).run();
  const state=await db.prepare(`SELECT state FROM client_portal_workspace_binding_outbox WHERE operation_id=?`)
    .bind(row.operation_id).first("state");
  if(state!=="rejected"&&state!=="retry")return {status:"retry",operationId:row.operation_id,code:"lease-lost"};
  return {status:state,operationId:row.operation_id,code:rejected??"transport-or-ambiguous"};
}
