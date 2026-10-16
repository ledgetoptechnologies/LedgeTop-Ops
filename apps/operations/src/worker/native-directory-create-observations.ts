import { resolveProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from './project-alpha-api-v2-connections';
import { readConfiguredProjectAlphaDirectoryInventory } from './project-alpha-directory-inventory-api-v2';
import { persistProjectAlphaDirectoryInventoryPage } from './project-alpha-v2-sync';

type Environment = ProjectAlphaApiV2ConnectionEnvironment & { OPS_DB:D1Database };
type Job = {command_id:string;record_id:string;source_id:string;source_instance_id:string;application_id:string;
  history_epoch_id:string;destination_origin:string;resource_type:'client'|'organization';external_id:string;public_id:string;
  provenance_id:string;acknowledged_command_json:string;acknowledged_outcome_json:string;
  inventory_cursor:string|null;inventory_generation:string|null};
export type CreateObservationOutcome = {status:'acknowledged'|'blocked'|'uncertain'|'conflict';reason?:string};

// A durable ACK authorizes only inventory reads and local evidence persistence.
// Neither the original actor nor a service identity is impersonated here.
const exactTarget=`EXISTS(SELECT 1 FROM native_directory_create_observation_targets t WHERE t.command_id=j.command_id
 AND t.record_id=j.record_id AND t.source_id=j.source_id AND t.source_instance_id=j.source_instance_id
 AND t.application_id=j.application_id AND t.history_epoch_id=j.history_epoch_id AND t.destination_origin=j.destination_origin
 AND t.resource_type=j.resource_type AND t.external_id=j.external_id AND t.public_id=j.public_id AND t.provenance_id=j.provenance_id
 AND t.acknowledged_command_json=j.acknowledged_command_json AND t.acknowledged_outcome_json=j.acknowledged_outcome_json)
 AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts replaced WHERE replaced.source_id=j.source_id
   AND (replaced.source_instance_id<>j.source_instance_id OR replaced.application_id<>j.application_id OR replaced.history_epoch_id<>j.history_epoch_id))
 AND (SELECT count(*) FROM project_alpha_active_directory_mappings m WHERE m.source_id=j.source_id
 AND m.source_instance_id=j.source_instance_id AND m.application_id=j.application_id AND m.history_epoch_id=j.history_epoch_id
 AND m.resource_type=j.resource_type AND (m.record_id=j.record_id OR m.external_id=j.external_id OR m.project_alpha_public_id=j.public_id))=1`;
const aligned=`EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations_current o
 WHERE o.source_id=j.source_id AND o.source_instance_id=j.source_instance_id AND o.application_id=j.application_id
 AND o.history_epoch_id=j.history_epoch_id AND o.resource_type=j.resource_type AND o.project_alpha_public_id=j.public_id
 AND o.present=1 AND o.last_action='upsert' AND o.has_conflict=0 AND o.binding_status='active'
 AND o.binding_external_id=j.external_id AND o.binding_resource_revision=o.resource_revision)`;

/** Backfills old ACKs as well as ordinary new creates, without scanning PA or
 * changing any grant. The bounded scheduler revisits the remaining targets. */
export async function enqueueNativeDirectoryCreateObservations(db:D1Database,sourceIds:readonly string[],limit=12):Promise<void>{
  if(!sourceIds.length)return;
  const placeholders=sourceIds.map(()=>'?').join(',');
  await db.batch([db.prepare(`INSERT OR IGNORE INTO native_directory_create_observation_jobs
    SELECT j.* FROM native_directory_create_observation_targets j
    WHERE j.source_id IN (${placeholders}) AND NOT EXISTS(SELECT 1 FROM native_directory_create_observation_jobs own WHERE own.command_id=j.command_id)
      AND NOT (${aligned}) ORDER BY j.created_at,j.command_id LIMIT ?`)
    .bind(...sourceIds,Math.max(1,Math.min(12,limit)))]);
}

export async function dispatchNativeDirectoryCreateObservation(env:Environment,sourceId:string,commandId:string,
  send:typeof fetch=fetch):Promise<CreateObservationOutcome>{
  const pinned=env.PROJECT_ALPHA_API_V2_CONNECTIONS;
  let selected:ReturnType<typeof resolveProjectAlphaApiV2Connection>;
  try{selected=resolveProjectAlphaApiV2Connection({PROJECT_ALPHA_API_V2_CONNECTIONS:pinned},sourceId);}
  catch{return{status:'blocked',reason:'configuration'};}
  if(!selected.enabled||!selected.connection.expectedHistoryEpoch)return{status:'blocked',reason:'configuration'};
  const connection=selected.connection,session=env.OPS_DB.withSession('first-primary');
  const db:D1Database={prepare:sql=>session.prepare(sql),batch:statements=>session.batch(statements),
    withSession:()=>session,exec:sql=>env.OPS_DB.exec(sql),dump:()=>env.OPS_DB.dump()};
  const token=crypto.randomUUID(),now=Date.now();
  const claimed=await db.prepare(`UPDATE native_directory_create_observation_dispatch SET state='leased',lease_token=?,lease_expires_at=?,attempts=attempts+1,reason=NULL
    WHERE command_id=? AND ((state IN('pending','uncertain') AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?))
    AND EXISTS(SELECT 1 FROM native_directory_create_observation_jobs j WHERE j.command_id=? AND j.source_id=?
      AND j.source_instance_id=? AND j.application_id=? AND j.history_epoch_id=? AND j.destination_origin=? AND ${exactTarget})`)
    .bind(token,now+30_000,commandId,now,now,commandId,sourceId,connection.expectedSourceInstanceId,
      connection.expectedApplicationId,connection.expectedHistoryEpoch,connection.baseUrl).run();
  if(claimed.meta.changes!==1){
    // Retired source identities or invalidated ACK/mappings must not remain
    // permanently due and monopolize a bounded queue. Never touch a live competing
    // lease or an otherwise valid job that is only waiting for its retry time.
    const obsolete=await db.prepare(`UPDATE native_directory_create_observation_dispatch AS d
      SET state='conflict',reason='target_superseded',lease_token=NULL,lease_expires_at=NULL
      WHERE d.command_id=? AND ((d.state IN('pending','uncertain') AND d.next_attempt_at<=?) OR (d.state='leased' AND d.lease_expires_at<=?))
        AND EXISTS(SELECT 1 FROM native_directory_create_observation_jobs j WHERE j.command_id=d.command_id AND j.source_id=?
          AND (j.source_instance_id<>? OR j.application_id<>? OR j.history_epoch_id<>? OR j.destination_origin<>? OR NOT (${exactTarget})))`)
      .bind(commandId,now,now,sourceId,connection.expectedSourceInstanceId,connection.expectedApplicationId,
        connection.expectedHistoryEpoch,connection.baseUrl).run();
    return{status:'blocked',reason:obsolete.meta.changes===1?'target_superseded':'not_eligible'};
  }
  const j=await db.prepare(`SELECT j.*,d.inventory_cursor,d.inventory_generation FROM native_directory_create_observation_jobs j
    JOIN native_directory_create_observation_dispatch d ON d.command_id=j.command_id WHERE j.command_id=? AND d.lease_token=?`)
    .bind(commandId,token).first<Job>();
  if(!j)return{status:'blocked',reason:'lease_lost'};
  const release=async(reason:string,reset=false):Promise<CreateObservationOutcome>=>{
    await db.prepare(`UPDATE native_directory_create_observation_dispatch SET state='uncertain',lease_token=NULL,lease_expires_at=NULL,
      reason=?,next_attempt_at=?,inventory_cursor=CASE WHEN ? THEN NULL ELSE inventory_cursor END,
      inventory_generation=CASE WHEN ? THEN NULL ELSE inventory_generation END WHERE command_id=? AND state='leased' AND lease_token=?`)
      .bind(reason,Date.now()+5_000,reset?1:0,reset?1:0,commandId,token).run();
    return{status:'uncertain',reason};
  };
  const outcome=await readConfiguredProjectAlphaDirectoryInventory({PROJECT_ALPHA_API_V2_CONNECTIONS:pinned},sourceId,
    {type:j.resource_type,cursor:j.inventory_cursor,limit:200},send);
  if(outcome.status!=='observed')return release('inventory_unavailable',!!j.inventory_cursor&&outcome.status==='uncertain'
    &&outcome.reason==='http_status'&&outcome.httpStatus===400);
  const inventory=outcome.inventory;
  if(inventory.sourceInstanceId!==j.source_instance_id||inventory.applicationId!==j.application_id||inventory.historyEpoch!==j.history_epoch_id)
    return release('source_changed',true);
  if(j.inventory_generation!==null&&j.inventory_generation!==inventory.authorizationGeneration)return release('generation_changed',true);
  const candidates=inventory.resources.filter(item=>item.publicId===j.public_id||item.binding?.externalId===j.external_id);
  const item=candidates.length===1?candidates[0]:undefined;
  const matches=!!item&&item.publicId===j.public_id&&item.present&&item.lastAction==='upsert'
    &&item.binding?.externalId===j.external_id&&item.binding.status==='active'&&item.binding.resourceRevision===item.revision;
  // A mismatched/absent target may be in transition. Start a later scan rather
  // than permanently treating a legitimately older binding as authoritative.
  const next=matches||candidates.length||inventory.nextCursor===null?null:inventory.nextCursor;
  const guardId=crypto.randomUUID();
  const fence=db.prepare(`INSERT INTO native_directory_create_observation_guards(id,ok) VALUES(?,CASE WHEN EXISTS(
    SELECT 1 FROM native_directory_create_observation_jobs j JOIN native_directory_create_observation_dispatch d ON d.command_id=j.command_id
    WHERE j.command_id=? AND d.state='leased' AND d.lease_token=? AND d.lease_expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
      AND d.inventory_cursor IS ? AND d.inventory_generation IS ? AND j.source_id=? AND j.source_instance_id=?
      AND j.application_id=? AND j.history_epoch_id=? AND j.destination_origin=? AND ${exactTarget}
      AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts r WHERE r.source_id=j.source_id
        AND r.source_instance_id=j.source_instance_id AND r.application_id=j.application_id AND r.history_epoch_id=j.history_epoch_id
        AND r.inventory_kind='directory' AND (length(r.authorization_generation)>length(?)
          OR length(r.authorization_generation)=length(?) AND r.authorization_generation>?))) THEN 1 ELSE 0 END)`)
    .bind(guardId,commandId,token,j.inventory_cursor,j.inventory_generation,sourceId,connection.expectedSourceInstanceId,
      connection.expectedApplicationId,connection.expectedHistoryEpoch,connection.baseUrl,
      inventory.authorizationGeneration,inventory.authorizationGeneration,inventory.authorizationGeneration);
  const finish=db.prepare(`UPDATE native_directory_create_observation_dispatch AS d SET
    state=CASE WHEN c.conflict_id IS NOT NULL THEN 'conflict'
      WHEN ? AND o.request_id=? AND o.present=1 AND o.last_action='upsert' AND o.has_conflict=0 AND o.binding_status='active'
        AND o.binding_external_id=j.external_id AND o.binding_resource_revision=o.resource_revision THEN 'complete' ELSE 'pending' END,
    inventory_cursor=CASE WHEN c.conflict_id IS NULL THEN ? ELSE NULL END,
    inventory_generation=CASE WHEN c.conflict_id IS NULL THEN ? ELSE NULL END,
    lease_token=NULL,lease_expires_at=NULL,next_attempt_at=?,reason=CASE WHEN c.conflict_id IS NOT NULL THEN 'inventory_conflict' ELSE ? END
    FROM native_directory_create_observation_jobs j LEFT JOIN project_alpha_api_v2_directory_observations_current o
      ON o.source_id=j.source_id AND o.source_instance_id=j.source_instance_id AND o.application_id=j.application_id
      AND o.history_epoch_id=j.history_epoch_id AND o.resource_type=j.resource_type AND o.project_alpha_public_id=j.public_id
    LEFT JOIN project_alpha_api_v2_inventory_conflicts c ON c.source_id=j.source_id AND c.source_instance_id=j.source_instance_id
      AND c.application_id=j.application_id AND c.history_epoch_id=j.history_epoch_id AND c.inventory_kind='directory' AND c.request_id=?
    WHERE d.command_id=j.command_id AND d.command_id=? AND d.state='leased' AND d.lease_token=?`)
    .bind(matches?1:0,inventory.requestId,next,next?inventory.authorizationGeneration:null,next?0:Date.now()+5_000,
      matches?null:candidates.length?'binding_misaligned':next?'inventory_pending':'target_absent',inventory.requestId,commandId,token);
  // Wrap only this call's canonical persistence batch. A failed guard rolls
  // back receipt, observations AND cursor/lease advancement together. Other
  // canonical callers retain their existing regression/conflict semantics.
  const fenced:D1Database={prepare:sql=>db.prepare(sql),withSession:()=>session,exec:sql=>db.exec(sql),dump:()=>db.dump(),batch:async <T>(statements:D1PreparedStatement[]):Promise<D1Result<T>[]>=>{
    const results=await db.batch<T>([fence,...statements,finish,db.prepare('DELETE FROM native_directory_create_observation_guards WHERE id=?').bind(guardId)]);
    return results.slice(1,1+statements.length);
  }};
  const saved=await persistProjectAlphaDirectoryInventoryPage(fenced,inventory,j.inventory_cursor);
  const state=await db.prepare('SELECT state FROM native_directory_create_observation_dispatch WHERE command_id=?').bind(commandId).first<string>('state');
  // A reused request ID intentionally retains its original receipt hash. The
  // canonical reader therefore reports storage mismatch even though this batch
  // durably recorded the conflict. Report the committed job state first.
  if(state==='complete')return{status:'acknowledged'};
  if(state==='conflict')return{status:'conflict',reason:'inventory_conflict'};
  if(saved.status==='blocked')return release('evidence_superseded',true);
  return{status:'uncertain',reason:'inventory_pending'};
}
