import { HTTPException } from 'hono/http-exception';
import { d1TablesPresent } from './schema-readiness';
import type { Env } from './types';

type Databases=Pick<Env,'OPS_DB'|'DELIVERY_DB'>;
export type FolderMutationWitness={projectId:string;previous:{divisionId:string;r2Prefix:string}|null;next:{divisionId:string;r2Prefix:string};confirmedBy:string};
export type DivisionMutationWitness={divisionIds:string[];sourceId?:string;leaseOwner?:string;
  expectedRows?:Array<{id:string;active:number;project_alpha_business_unit_id:string|null;updated_at:string}>};
export type PrimaryFolderMutation={operationId:string;kind:'project_folder'|'division_deactivation';witness:FolderMutationWitness|DivisionMutationWitness};
const conflict=(message:string):never=>{throw new HTTPException(409,{message});};

/** Reserve before any Delivery deny phase or OPS write. No timeout releases it. */
export async function reservePrimaryFolderMutation(env:Databases,actorId:string,kind:PrimaryFolderMutation['kind'],witness:PrimaryFolderMutation['witness']):Promise<PrimaryFolderMutation|null>{
  if(!env.DELIVERY_DB||!await d1TablesPresent(env.DELIVERY_DB,['portal_primary_folder_authority_mutations']))return null;
  const mutation={operationId:crypto.randomUUID(),kind,witness};
  try{await env.DELIVERY_DB.prepare(`INSERT INTO portal_primary_folder_authority_mutations(operation_id,kind,actor_id,witness_json,phase)
    VALUES(?,?,?,?,'reserved')`).bind(mutation.operationId,kind,actorId,JSON.stringify(witness)).run();}
  catch{conflict('Folder ownership is being changed or awaiting outcome review; review the pending operation before linking another folder');}
  return mutation;
}

/** All selected divisions change or none do. The original command is fenced
 * by its exact snapshot lease, so a reviewed retry can retire a late dispatch. */
export function primaryDivisionDeactivationStatement(env:Databases,witness:DivisionMutationWitness,original=true):D1PreparedStatement{
  if(!witness.sourceId||!witness.leaseOwner||!witness.expectedRows?.length||witness.expectedRows.length!==witness.divisionIds.length)
    return conflict('Division deactivation has no complete original authority witness');
  return env.OPS_DB.prepare(`UPDATE divisions SET active=0,updated_at=datetime('now')
    WHERE id IN(SELECT value FROM json_each(?)) AND NOT EXISTS(
      SELECT 1 FROM json_each(?) expected LEFT JOIN divisions current ON current.id=json_extract(expected.value,'$.id')
      WHERE current.id IS NULL OR current.active IS NOT json_extract(expected.value,'$.active')
        OR current.project_alpha_business_unit_id IS NOT json_extract(expected.value,'$.project_alpha_business_unit_id')
        OR current.updated_at IS NOT json_extract(expected.value,'$.updated_at'))
    AND ${original?`EXISTS(SELECT 1 FROM pa_projection_entity_leases WHERE projection_source_id=?
      AND entity_type='integration_projection' AND entity_id='project-alpha' AND owner_event_id=? AND datetime(lease_until)>datetime('now'))`
      :`NOT EXISTS(SELECT 1 FROM pa_projection_entity_leases WHERE projection_source_id=?
      AND entity_type='integration_projection' AND entity_id='project-alpha' AND owner_event_id<>?)`}`)
    .bind(JSON.stringify(witness.divisionIds),JSON.stringify(witness.expectedRows),witness.sourceId,witness.leaseOwner);
}
export async function readPrimaryFolderMutationReview(env:Databases,operationId:string){
  const row=await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT operation_id,kind,witness_json,phase FROM portal_primary_folder_authority_mutations WHERE operation_id=?`)
    .bind(operationId).first<{operation_id:string;kind:PrimaryFolderMutation['kind'];witness_json:string;phase:string}>();
  if(!row)throw new HTTPException(404,{message:'Folder authority operation not found'});
  const witness=JSON.parse(row.witness_json) as PrimaryFolderMutation['witness'];
  let currentRows:DivisionMutationWitness['expectedRows']=[],lease:unknown=null;
  if(row.kind==='division_deactivation'){
    const division=witness as DivisionMutationWitness;
    currentRows=(await env.OPS_DB.withSession('first-primary').prepare(`SELECT id,active,project_alpha_business_unit_id,updated_at FROM divisions
      WHERE id IN(SELECT value FROM json_each(?)) ORDER BY id`).bind(JSON.stringify(division.divisionIds)).all<NonNullable<DivisionMutationWitness['expectedRows']>[number]>()).results;
    lease=division.sourceId?await env.OPS_DB.withSession('first-primary').prepare(`SELECT owner_event_id,lease_until FROM pa_projection_entity_leases
      WHERE projection_source_id=? AND entity_type='integration_projection' AND entity_id='project-alpha'`).bind(division.sourceId).first():null;
  }
  const proof=JSON.stringify([row,currentRows,lease]);
  const contextVersion=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(proof))),b=>b.toString(16).padStart(2,'0')).join('');
  return {operationId,kind:row.kind,phase:row.phase,witness,currentRows,lease,contextVersion};
}
export async function retryPrimaryDivisionMutation(env:Databases,operationId:string,expectedContextVersion:string){
  const review=await readPrimaryFolderMutationReview(env,operationId);
  if(review.kind!=='division_deactivation'||review.phase!=='attempted'||review.contextVersion!==expectedContextVersion)
    return conflict('The original division operation changed; review the same operation again');
  const witness=review.witness as DivisionMutationWitness;
  const mutation={operationId,kind:'division_deactivation' as const,witness};
  if(await desiredWitnessPresent(env,mutation))return reconcilePrimaryFolderMutation(env,operationId,'reconcile');
  const sorted=(rows:NonNullable<DivisionMutationWitness['expectedRows']>)=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));
  if(!witness.expectedRows||JSON.stringify(sorted(review.currentRows!))!==JSON.stringify(sorted(witness.expectedRows)))
    return conflict('Division authority differs from the original request; no retry was dispatched');
  const lease=review.lease as {owner_event_id:string}|null;
  if(lease&&lease.owner_event_id!==witness.leaseOwner)return conflict('A newer snapshot owns the division context; no retry was dispatched');
  const results=await env.OPS_DB.batch([
    env.OPS_DB.prepare(`DELETE FROM pa_projection_entity_leases WHERE projection_source_id=? AND entity_type='integration_projection'
      AND entity_id='project-alpha' AND owner_event_id=?`).bind(witness.sourceId!,witness.leaseOwner!),
    primaryDivisionDeactivationStatement(env,witness,false),
  ]);
  if(Number(results[1]?.meta.changes)!==witness.divisionIds.length)conflict('Division authority changed during retry; the same operation remains pending');
  await completePrimaryFolderMutation(env,mutation);
  return {operationId,state:'completed' as const,replayed:false};
}
export async function attemptPrimaryFolderMutation(env:Databases,mutation:PrimaryFolderMutation|null):Promise<void>{
  if(!mutation)return;
  const changed=await env.DELIVERY_DB.prepare(`UPDATE portal_primary_folder_authority_mutations SET phase='attempted',updated_at=datetime('now')
    WHERE operation_id=? AND phase='reserved'`).bind(mutation.operationId).run();
  if(Number(changed.meta.changes)!==1)conflict('Folder ownership mutation changed before dispatch');
}
async function desiredWitnessPresent(env:Databases,mutation:PrimaryFolderMutation):Promise<boolean>{
  if(mutation.kind==='project_folder'){
    const witness=mutation.witness as FolderMutationWitness;
    const row=await env.OPS_DB.withSession('first-primary').prepare('SELECT division_id,r2_prefix,confirmed_by FROM project_folders WHERE project_id=?')
      .bind(witness.projectId).first<{division_id:string;r2_prefix:string;confirmed_by:string}>();
    return !!row&&row.division_id===witness.next.divisionId&&row.r2_prefix===witness.next.r2Prefix&&row.confirmed_by===witness.confirmedBy;
  }
  const witness=mutation.witness as DivisionMutationWitness;
  if(!witness.divisionIds.length)return false;
  const rows=await env.OPS_DB.withSession('first-primary').prepare(`SELECT id,active FROM divisions WHERE id IN(SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(witness.divisionIds)).all<{id:string;active:number}>();
  return rows.results.length===witness.divisionIds.length&&rows.results.every(row=>row.active===0);
}
export async function completePrimaryFolderMutation(env:Databases,mutation:PrimaryFolderMutation|null,definiteNoWrite=false):Promise<void>{
  if(!mutation)return;
  if(!definiteNoWrite&&!await desiredWitnessPresent(env,mutation))conflict('Folder ownership outcome is not confirmed; its publication fence remains closed');
  const changed=await env.DELIVERY_DB.prepare(`UPDATE portal_primary_folder_authority_mutations SET phase='completed',updated_at=datetime('now')
    WHERE operation_id=? AND phase='attempted'`).bind(mutation.operationId).run();
  if(Number(changed.meta.changes)!==1)conflict('Folder ownership outcome changed during confirmation');
}

/** Normal owner recovery reconciles the same operation; it never dispatches SQL. */
export async function reconcilePrimaryFolderMutation(env:Databases,operationId:string,action:'reconcile'|'cancel_reserved'){
  const row=await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT operation_id,kind,witness_json,phase FROM portal_primary_folder_authority_mutations WHERE operation_id=?`)
    .bind(operationId).first<{operation_id:string;kind:PrimaryFolderMutation['kind'];witness_json:string;phase:string}>();
  if(!row)throw new HTTPException(404,{message:'Folder authority operation not found'});
  if(row.phase==='completed')return {operationId,state:'completed' as const,replayed:true};
  const mutation={operationId,kind:row.kind,witness:JSON.parse(row.witness_json)} as PrimaryFolderMutation;
  if(action==='cancel_reserved'){
    if(row.phase!=='reserved')conflict('An attempted write cannot be cancelled without a confirmed outcome');
  }else if(row.phase!=='attempted'||!await desiredWitnessPresent(env,mutation)){
    conflict('The original write outcome is still unresolved; the fence remains closed');
  }
  const changed=await env.DELIVERY_DB.prepare(`UPDATE portal_primary_folder_authority_mutations SET phase='completed',updated_at=datetime('now') WHERE operation_id=? AND phase=?`)
    .bind(operationId,row.phase).run();
  if(Number(changed.meta.changes)!==1)conflict('Folder authority operation changed during review');
  return {operationId,state:'completed' as const,replayed:false};
}
