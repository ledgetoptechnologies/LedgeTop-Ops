import type { ProjectAlphaApiV2ConnectionEnvironment } from './project-alpha-api-v2-connections';
import { withEnabledConfiguredProjectAlphaApiV2Connection } from './project-alpha-api-v2-connections';
import { readConfiguredProjectAlphaDirectoryInventory, type ProjectAlphaDirectoryInventoryResource } from './project-alpha-directory-inventory-api-v2';
import { persistProjectAlphaDirectoryInventoryPage } from './project-alpha-v2-sync';
import { historicalCrossSurfaceGenerationConflict } from './project-alpha-inventory-historical-generation-evidence';
import { sendProjectAlphaDirectoryBindingRevisionRefreshCommand, isProjectAlphaDirectoryBindingRevisionRefreshCommand,
  validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement } from './project-alpha-directory-binding-revision-refresh-api-v2';

type Environment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB:D1Database; ENVIRONMENT?:string;
  NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED?:string }>;
type Job = {command_id:string;record_id:string;local_version:number;source_id:string;source_instance_id:string;application_id:string;
  history_epoch_id:string;destination_origin:string;resource_type:'client'|'organization';external_id:string;public_id:string;
  mapping_kind:string;mapping_provenance_id:string;acknowledged_command_json:string;acknowledged_outcome_json:string;
  live_revision:string;authorization_generation:string;actor_id:string;access_subject:string};
type Frozen = {job_command_id:string;refresh_command_id:string;command_json:string;request_sha256:string;prior_revision:string;
  live_revision:string;projection_sha256:string;authorization_generation:string};
export type ProfileBindingContinuationOutcome = {status:'acknowledged'|'blocked'|'conflict'|'uncertain';reason?:string};
const digest=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
class EvidenceChanged extends Error {}
export function profileBindingContinuationEnabled(env:Pick<Environment,'ENVIRONMENT'|'NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED'>):boolean{
  return env.NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED==='true'
    && (env.ENVIRONMENT==='local'||env.ENVIRONMENT==='staging'||env.ENVIRONMENT==='production');
}
function primary(database:D1Database):D1Database{
  const session=database.withSession('first-primary');
  return {prepare:sql=>session.prepare(sql),batch:statements=>session.batch(statements),withSession:()=>session,
    exec:sql=>database.exec(sql),dump:()=>database.dump()};
}
// Internal authority is an exact immutable ACK plus the already-owned mapping,
// not a human permission, owner impersonation or an identity-link grant. Actor
// revocation after durable ACK does not cancel this narrowly derived completion.
const current=`EXISTS(SELECT 1 FROM operations_directory_records r WHERE r.record_id=c.record_id AND r.record_kind=c.resource_type AND r.current_version=c.local_version)
  AND (SELECT count(*) FROM project_alpha_active_directory_mappings m WHERE m.source_id=c.source_id AND m.source_instance_id=c.source_instance_id
    AND m.application_id=c.application_id AND m.history_epoch_id=c.history_epoch_id AND m.resource_type=c.resource_type
    AND (m.record_id=c.record_id OR m.external_id=c.external_id OR m.project_alpha_public_id=c.public_id))=1
  AND EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings m WHERE m.record_id=c.record_id AND m.source_id=c.source_id
    AND m.source_instance_id=c.source_instance_id AND m.application_id=c.application_id AND m.history_epoch_id=c.history_epoch_id
    AND m.resource_type=c.resource_type AND m.external_id=c.external_id AND m.project_alpha_public_id=c.public_id
    AND m.mapping_kind=c.mapping_kind AND m.provenance_id=c.mapping_provenance_id)
  AND EXISTS(SELECT 1 FROM project_alpha_directory_outbox o JOIN operations_directory_effective_materializations x ON x.command_id=o.command_id
    JOIN operations_directory_intents i ON i.intent_id=x.intent_id JOIN operations_directory_audit a ON a.mutation_id=i.mutation_id
      AND a.record_id=i.record_id AND a.record_version=i.record_version
    WHERE o.command_id=c.command_id AND o.state='acknowledged' AND i.state='acknowledged'
      AND o.command_json=c.acknowledged_command_json AND x.command_json=c.acknowledged_command_json AND o.outcome_json=c.acknowledged_outcome_json
      AND i.record_id=c.record_id AND i.record_version=c.local_version AND i.source_id=c.source_id AND i.source_instance_uuid=c.source_instance_id
      AND i.application_uuid=c.application_id AND i.expected_history_epoch_id=c.history_epoch_id AND i.destination_origin=c.destination_origin
      AND i.external_canonical_id=c.external_id AND x.history_epoch_id=c.history_epoch_id
      AND a.actor_id=c.actor_id AND a.original_verified_access_subject=c.access_subject)
  AND NOT EXISTS(SELECT 1 FROM client_hub_native_project_effective_directory_conflicts conflict WHERE conflict.source_id=c.source_id
    AND conflict.source_instance_id=c.source_instance_id AND conflict.application_id=c.application_id AND conflict.history_epoch_id=c.history_epoch_id
    AND (conflict.resource_type='source' AND (conflict.conflict_kind IN('source_identity_changed','request_reuse_mismatch')
      OR conflict.inventory_kind='directory' AND NOT (${historicalCrossSurfaceGenerationConflict('directory')}))
      OR conflict.inventory_kind='directory' AND conflict.resource_type=c.resource_type
        AND (conflict.project_alpha_public_id=c.public_id OR conflict.external_id=c.external_id)))`;
async function guarded(db:D1Database,j:Job,lease:string,statements:D1PreparedStatement[]):Promise<void>{
  const id=crypto.randomUUID();
  // Keep the canonical view predicates at the top query level. Wrapping the
  // entire assertion in EXISTS exceeds D1's expression-depth limit once its
  // effective conflict views are expanded. The second assertion rejects a
  // missing job without adding another layer around those views.
  try{await db.batch([db.prepare(`INSERT INTO native_directory_profile_binding_guards(guard_id,ok)
    SELECT ?,CASE WHEN ${current} AND EXISTS(SELECT 1 FROM native_directory_profile_binding_dispatch d
      WHERE d.command_id=c.command_id AND d.state='leased' AND d.lease_token=? AND d.lease_expires_at>?) THEN 1 ELSE 0 END
    FROM native_directory_profile_binding_jobs c WHERE c.command_id=?`)
    .bind(id,lease,Date.now(),j.command_id),db.prepare(`INSERT INTO native_directory_profile_binding_guards(guard_id,ok) VALUES(?,
      CASE WHEN EXISTS(SELECT 1 FROM native_directory_profile_binding_guards WHERE guard_id=?) THEN 1 ELSE 0 END)`).bind(`${id}:exists`,id),
    ...statements,db.prepare('DELETE FROM native_directory_profile_binding_guards WHERE guard_id IN(?,?)').bind(id,`${id}:exists`)]);
  }catch(error){
    // Lease loss is not identity drift. Re-read exact local authority separately
    // so expired ownership never permanently cancels a replayable frozen POST.
    if(error instanceof Error&&/CHECK constraint failed: ok=1|profile binding completion requires canonical aligned inventory/u.test(error.message)){
      const valid=await db.prepare(`SELECT 1 ok FROM native_directory_profile_binding_jobs c WHERE c.command_id=? AND ${current}`).bind(j.command_id).first();
      if(!valid)throw new EvidenceChanged('local_evidence_changed');
    }throw error;
  }
}
async function observed(env:Environment,j:Job,lease:string,send:typeof fetch):Promise<{item:ProjectAlphaDirectoryInventoryResource;generation:string;requestId:string}|null>{
  const progress=await env.OPS_DB.prepare('SELECT inventory_cursor,inventory_generation FROM native_directory_profile_binding_dispatch WHERE command_id=?')
    .bind(j.command_id).first<{inventory_cursor:string|null;inventory_generation:string|null}>();
  let cursor=progress?.inventory_cursor??null,generation=progress?.inventory_generation??null;
  let savedCursor=cursor,savedGeneration=generation;
  const save=async(next:string|null,at:string|null)=>{
    if(next===savedCursor&&at===savedGeneration)return;
    await guarded(env.OPS_DB,j,lease,[env.OPS_DB.prepare(`UPDATE native_directory_profile_binding_dispatch
      SET inventory_cursor=?,inventory_generation=? WHERE command_id=? AND state='leased' AND lease_token=?`).bind(next,at,j.command_id,lease)]);
    savedCursor=next;savedGeneration=at;
  };
  for(let page=0;page<5;page++){
    const out=await readConfiguredProjectAlphaDirectoryInventory(env,j.source_id,{type:j.resource_type,cursor,limit:200},send);
    if(out.status!=='observed'){
      // A valid non-null query rejected as HTTP400 is explicit cursor rejection.
      // Timeouts, transport failures, 5xx and unavailable preflight are not
      // evidence that previously persisted canonical progress became invalid.
      if(cursor&&out.status==='uncertain'&&out.reason==='http_status'&&out.httpStatus===400)await save(null,null);
      return null;
    }
    const inventory=out.inventory;
    if(inventory.sourceInstanceId!==j.source_instance_id||inventory.applicationId!==j.application_id||inventory.historyEpoch!==j.history_epoch_id
      ||generation!==null&&generation!==inventory.authorizationGeneration){await save(null,null);return null;}
    generation=inventory.authorizationGeneration;
    const candidates=inventory.resources.filter(x=>x.type===j.resource_type&&(x.publicId===j.public_id||x.binding?.externalId===j.external_id));
    // Persist only genuine bounded transport inventory through the canonical path.
    const saved=await persistProjectAlphaDirectoryInventoryPage(env.OPS_DB,inventory,cursor);
    if(saved.status==='conflicted')throw new EvidenceChanged('canonical_inventory_conflict');
    if(saved.status!=='persisted')return null;
    if(candidates.length){
      if(candidates.length!==1)throw new EvidenceChanged('inventory_identity_ambiguous');const item=candidates[0]!;
      if(item.publicId!==j.public_id||!item.present||item.lastAction!=='upsert'||item.binding?.status!=='active'||item.binding.externalId!==j.external_id)
        throw new EvidenceChanged('inventory_binding_changed');
      // Retain this page's legitimate cursor for a fresh canonical re-read.
      // Never synthesize a cursor from the target identity. A generation change
      // resets progress, so no pages from different source snapshots are joined.
      await save(cursor,cursor?generation:null);
      return{item,generation,requestId:inventory.requestId};
    }
    cursor=inventory.nextCursor;if(!cursor)throw new EvidenceChanged('inventory_binding_absent');
    // Checkpoint each successful page before the scheduler/request deadline
    // can interrupt the next fetch. Never wait for the whole page allowance.
    await save(cursor,generation);
  }
  await save(cursor,generation);return null;
}
const alignedInventory=`EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations_current o
  JOIN project_alpha_api_v2_inventory_receipts r ON r.source_id=o.source_id AND r.source_instance_id=o.source_instance_id
    AND r.application_id=o.application_id AND r.history_epoch_id=o.history_epoch_id AND r.inventory_kind='directory' AND r.request_id=o.request_id
  WHERE o.source_id=c.source_id AND o.source_instance_id=c.source_instance_id AND o.application_id=c.application_id AND o.history_epoch_id=c.history_epoch_id
    AND o.resource_type=c.resource_type AND o.project_alpha_public_id=c.public_id AND o.resource_revision=c.live_revision
    AND o.present=1 AND o.last_action='upsert' AND o.has_conflict=0 AND o.binding_status='active'
    AND o.binding_external_id=c.external_id AND o.binding_resource_revision=c.live_revision AND r.request_id=?)`;
async function finish(db:D1Database,j:Job,lease:string,requestId:string):Promise<void>{
  const id=crypto.randomUUID();
  await guarded(db,j,lease,[db.prepare(`INSERT INTO native_directory_profile_binding_guards(guard_id,ok)
    SELECT ?,CASE WHEN ${alignedInventory} THEN 1 ELSE 0 END FROM native_directory_profile_binding_jobs c WHERE c.command_id=?`)
    .bind(id,requestId,j.command_id),db.prepare(`UPDATE native_directory_profile_binding_dispatch SET state='complete',lease_token=NULL,lease_expires_at=NULL,reason=NULL
      WHERE command_id=? AND lease_token=?`).bind(j.command_id,lease),db.prepare('DELETE FROM native_directory_profile_binding_guards WHERE guard_id=?').bind(id)]);
}
/** Unrouted, scheduler-only continuation: never accepts a caller-supplied PA command or identity. */
export async function dispatchNativeDirectoryProfileBindingContinuation(env:Environment,sourceId:string,commandId:string,send:typeof fetch=fetch):Promise<ProfileBindingContinuationOutcome>{
  if(!profileBindingContinuationEnabled(env))return{status:'blocked',reason:'disabled'};
  env={...env,OPS_DB:primary(env.OPS_DB)};const db=env.OPS_DB;
  const j=await db.prepare('SELECT * FROM native_directory_profile_binding_jobs WHERE command_id=?').bind(commandId).first<Job>();
  if(!j||j.source_id!==sourceId)return{status:'conflict',reason:'source'};
  const d=await db.prepare('SELECT state,attempts FROM native_directory_profile_binding_dispatch WHERE command_id=?').bind(commandId).first<{state:string;attempts:number}>();
  if(d?.state==='complete')return{status:'acknowledged'};
  if(!d||d.state==='conflict')return{status:'conflict',reason:'parked'};
  const lease=crypto.randomUUID(),now=Date.now();
  const claimed=await db.prepare(`UPDATE native_directory_profile_binding_dispatch SET state='leased',attempts=attempts+1,lease_token=?,lease_expires_at=?
    WHERE command_id=? AND ((state IN('pending','uncertain') AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?))`)
    .bind(lease,now+60_000,commandId,now,now).run();
  if(claimed.meta.changes!==1)return{status:'blocked',reason:'not_due'};
  const park=async(reason:string,conflict:boolean):Promise<ProfileBindingContinuationOutcome>=>{
    await db.prepare(`UPDATE native_directory_profile_binding_dispatch SET state=?,reason=?,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=?
      WHERE command_id=? AND state='leased' AND lease_token=?`).bind(conflict?'conflict':'uncertain',reason,Date.now()+Math.min(3600_000,1000*2**Math.min(d.attempts,12)),commandId,lease).run();
    return{status:conflict?'conflict':'uncertain',reason};
  };
  try{
    const selected=await withEnabledConfiguredProjectAlphaApiV2Connection(env,sourceId,async connection=>{
      let phase:'local_guard'|'inventory'|'freeze'|'post'|'receipt'|'post_inventory'|'complete'='local_guard';
      try{
      if(connection.expectedSourceInstanceId!==j.source_instance_id||connection.expectedApplicationId!==j.application_id
        ||connection.expectedHistoryEpoch!==j.history_epoch_id||connection.baseUrl!==j.destination_origin)return park('destination_changed',true);
      await guarded(db,j,lease,[]);
      let frozen=await db.prepare('SELECT * FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(commandId).first<Frozen>();
      phase='inventory';const live=await observed(env,j,lease,send);if(!live)return park('inventory_unavailable',false);
      if(live.item.revision!==j.live_revision)return park('remote_revision_changed',true);
      if(!frozen){
        // Generation is global to the PA application: another authorized
        // customer refresh may advance it after this profile ACK. First freeze
        // uses fresh canonical inventory under exact owned-binding authority,
        // never a regressed generation. Once frozen, only exact G/G+1 replay
        // below is accepted; no uncertain command is rebased or superseded.
        if(BigInt(live.generation)<BigInt(j.authorization_generation))return park('authorization_generation_regressed',true);
        if(live.item.binding!.resourceRevision===j.live_revision){phase='complete';await finish(db,j,lease,live.requestId);return{status:'acknowledged' as const};}
        if(BigInt(live.generation)>=9223372036854775807n)return park('authorization_generation_exhausted',true);
        const command={commandId:crypto.randomUUID(),externalId:j.external_id,expectedPriorRevision:live.item.binding!.resourceRevision,
          expectedLiveRevision:j.live_revision,expectedAuthorizationGeneration:live.generation};
        if(!isProjectAlphaDirectoryBindingRevisionRefreshCommand(command))return park('binding_revision_changed',true);
        const body=JSON.stringify(command);
        frozen={job_command_id:commandId,refresh_command_id:command.commandId,command_json:body,request_sha256:await digest(body),prior_revision:command.expectedPriorRevision,
          live_revision:j.live_revision,projection_sha256:live.item.projectionSha256,authorization_generation:live.generation};
        phase='freeze';await guarded(db,j,lease,[db.prepare(`INSERT INTO native_directory_profile_binding_commands(job_command_id,refresh_command_id,command_json,request_sha256,
          prior_revision,live_revision,projection_sha256,authorization_generation) VALUES(?,?,?,?,?,?,?,?)`).bind(frozen.job_command_id,frozen.refresh_command_id,
          frozen.command_json,frozen.request_sha256,frozen.prior_revision,frozen.live_revision,frozen.projection_sha256,frozen.authorization_generation)]);
      }
      let command:unknown;try{command=JSON.parse(frozen.command_json);}catch{return park('command_invalid',true);}
      if(!isProjectAlphaDirectoryBindingRevisionRefreshCommand(command)||await digest(frozen.command_json)!==frozen.request_sha256)return park('command_invalid',true);
      const initial=live.generation===frozen.authorization_generation&&live.item.binding!.resourceRevision===frozen.prior_revision;
      const replay=d.attempts>0&&live.generation===(BigInt(frozen.authorization_generation)+1n).toString()&&live.item.binding!.resourceRevision===frozen.live_revision;
      if(live.item.projectionSha256!==frozen.projection_sha256||!initial&&!replay)return park('frozen_remote_head_changed',true);
      const receipt=await db.prepare('SELECT response_json FROM native_directory_profile_binding_receipts WHERE job_command_id=?').bind(commandId).first<{response_json:string}>();
      if(!receipt){
        phase='post';
        await guarded(db,j,lease,[]);
        const outcome=await sendProjectAlphaDirectoryBindingRevisionRefreshCommand(connection,j.resource_type,command,send);
        const evidence=validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement(outcome);
        if(!evidence)return park(outcome.status==='conflict'?'remote_conflict':'transport_uncertain',outcome.status==='conflict');
        if(JSON.stringify(evidence.command)!==frozen.command_json||evidence.destinationOrigin!==j.destination_origin||evidence.response.result.binding.publicId!==j.public_id)return park('receipt_mismatch',true);
        const body=JSON.stringify(evidence.response);
        phase='receipt';await guarded(db,j,lease,[db.prepare(`INSERT INTO native_directory_profile_binding_receipts(job_command_id,response_json,response_sha256,pa_request_id,authorization_generation)
          VALUES(?,?,?,?,?)`).bind(commandId,body,await digest(body),evidence.response.requestId,evidence.response.result.binding.authorizationGeneration)]);
      }
      phase='post_inventory';const after=await observed(env,j,lease,send);if(!after)return park('inventory_unavailable',false);
      if(after.generation!==(BigInt(frozen.authorization_generation)+1n).toString()||after.item.revision!==frozen.live_revision
        ||after.item.binding!.resourceRevision!==frozen.live_revision||after.item.projectionSha256!==frozen.projection_sha256)return park('post_ack_inventory_changed',true);
      phase='complete';await finish(db,j,lease,after.requestId);return{status:'acknowledged' as const};
      }catch(error){return park(error instanceof EvidenceChanged?error.message:`infrastructure_uncertain:${phase}`,error instanceof EvidenceChanged);}
    });
    return selected.status==='enabled'?selected.value:await park('configuration',false);
  }catch{return park('infrastructure_uncertain',false);}
}
