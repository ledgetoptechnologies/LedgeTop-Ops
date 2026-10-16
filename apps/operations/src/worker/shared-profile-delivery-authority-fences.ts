import type { Env } from './types';
import { transitionSharedProfilePortalAuthority } from './shared-profile-portal-authority';
type Head={workspace_id:string;source_id:string;revision:number;state:'active'|'blocked';operation_id:string;pending_operation_id:string|null};
export type OpsSharedProfileFence={workspaceId:string;sourceId:string;revision:number;operationId:string};
type BulkLatch={operationId:string};
type BulkTransition={fences:OpsSharedProfileFence[];latch:BulkLatch|null};
async function available(env:Env){return !!await env.DELIVERY_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portal_shared_profile_authority_heads'").first();}
/** Ops also owns Delivery deny policies. Mirror the same durable block used by
 * Client before changing authority, so previously issued edit proofs fail shut. */
export async function blockOpsSharedProfileWorkspace(env:Env,workspaceId:string,operationKey:string):Promise<OpsSharedProfileFence[]>{
  if(!await available(env))return [];
  const db=env.DELIVERY_DB.withSession('first-primary');
  let head=await db.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(workspaceId).first<Head>();
  if(!head){
    const ready=await db.prepare('SELECT hooks_ready FROM portal_shared_profile_runtime WHERE id=1').first<number>('hooks_ready');
    if(ready!==1)return [];
    const source=await db.prepare("SELECT project_alpha_source_id FROM portal_v2_workspaces WHERE id=? AND legacy_account_id IS NULL")
      .bind(workspaceId).first<string>('project_alpha_source_id');
    if(!source||!/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(source))return [];
    const initialId=await operationUuid(operationKey+'\0initial',workspaceId,0);
    const pendingId=await operationUuid(operationKey,workspaceId,1);
    await db.prepare("INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id,pending_operation_id) VALUES(?,?,1,'blocked',?,?)")
      .bind(workspaceId,source,initialId,pendingId).run();
    head=await db.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(workspaceId).first<Head>();
    if(!head)throw new Error('shared-profile-authority-changed');
  }
  const alreadyMirrored=!!head.pending_operation_id&&head.state==='blocked'&&head.operation_id===head.pending_operation_id;
  // A pending retry retains its original revision even after the mirrored head
  // advances. Once released, the same logical key starts a new operation ID.
  const operationId=await operationUuid(operationKey,workspaceId,head.revision-(alreadyMirrored?1:0));
  if(head.pending_operation_id&&head.pending_operation_id!==operationId)throw new Error('shared-profile-authority-transition-in-progress');
  if(!head.pending_operation_id){
    const reserved=await db.prepare('UPDATE portal_shared_profile_authority_heads SET pending_operation_id=? WHERE workspace_id=? AND revision=? AND pending_operation_id IS NULL')
      .bind(operationId,workspaceId,head.revision).run();
    if(reserved.meta.changes!==1)throw new Error('shared-profile-authority-changed');
  }
  if(head.revision===1&&head.state==='blocked'&&!alreadyMirrored){
    // Retry interrupted initial publication, including resolver-created heads.
    // An existing Ops owner-template head may already be at revision one with
    // another ID; the subsequent strict 1→2 transition decides acceptance.
    await transitionSharedProfilePortalAuthority(env,{protocolVersion:1,operationId:head.operation_id,workspaceId,
      sourceId:head.source_id,expectedRevision:0,revision:1,state:'blocked'});
  }
  const revision=alreadyMirrored?head.revision:head.revision+1;
  const result=await transitionSharedProfilePortalAuthority(env,{protocolVersion:1,operationId,workspaceId,sourceId:head.source_id,
    expectedRevision:revision-1,revision,state:'blocked'});
  if(!result.ok)throw new Error('shared-profile-authority-changed');
  if(!alreadyMirrored){
    const saved=await db.prepare("UPDATE portal_shared_profile_authority_heads SET revision=?,state='blocked',operation_id=?,updated_at=datetime('now') WHERE workspace_id=? AND revision=? AND pending_operation_id=?")
      .bind(revision,operationId,workspaceId,head.revision,operationId).run();
    if(saved.meta.changes!==1)throw new Error('shared-profile-authority-changed');
  }
  return[{workspaceId,sourceId:head.source_id,revision,operationId}];
}
/** Append these to the SAME Delivery authority batch, after its mutations.
 * A proof cannot reactivate the head in the gap before that batch commits. */
export function releaseOpsSharedProfileFences(env:Env,fences:readonly OpsSharedProfileFence[],latch:BulkLatch|null=null):D1PreparedStatement[]{
  return [...[...new Map(fences.map(f=>[f.workspaceId,f])).values()].map(f=>env.DELIVERY_DB.prepare(`UPDATE portal_shared_profile_authority_heads
    SET pending_operation_id=NULL,updated_at=datetime('now') WHERE workspace_id=? AND source_id=? AND revision=? AND state='blocked' AND operation_id=? AND pending_operation_id=?`)
    .bind(f.workspaceId,f.sourceId,f.revision,f.operationId,f.operationId)),...(latch?[env.DELIVERY_DB.prepare('UPDATE portal_shared_profile_bulk_latch SET operation_id=NULL WHERE id=1 AND operation_id=?').bind(latch.operationId)]:[])];
}
export function assertOpsSharedProfileFences(env:Env,fences:readonly OpsSharedProfileFence[],latch:BulkLatch|null=null):D1PreparedStatement[]{
  return [...(latch?[env.DELIVERY_DB.prepare(`INSERT INTO portal_shared_profile_bulk_latch(id,operation_id) SELECT 0,? WHERE NOT EXISTS(
    SELECT 1 FROM portal_shared_profile_bulk_latch WHERE id=1 AND operation_id=?)`).bind(latch.operationId,latch.operationId)]:[]),
    ...[...new Map(fences.map(f=>[f.workspaceId,f])).values()].map(f=>env.DELIVERY_DB.prepare(`INSERT INTO portal_shared_profile_authority_heads
    (workspace_id,source_id,revision,state,operation_id,pending_operation_id) SELECT ?,?,0,'blocked',?,?
    WHERE NOT EXISTS(SELECT 1 FROM portal_shared_profile_authority_heads WHERE workspace_id=? AND source_id=? AND revision=? AND state='blocked' AND operation_id=? AND pending_operation_id=?)`)
    .bind(f.workspaceId,f.sourceId,f.operationId,f.operationId,f.workspaceId,f.sourceId,f.revision,f.operationId,f.operationId))];
}
export async function blockOpsSharedProfileIdentity(env:Env,_identityId:string,_workspaceId:string|null,operationKey:string):Promise<BulkTransition>{
  return blockOpsSharedProfileBulk(env,operationKey);
}
export async function blockOpsSharedProfileRoot(env:Env,root:{sourceId:string;rootType:string;rootPublicId:string},operationKey:string):Promise<OpsSharedProfileFence[]>{
  if(!await available(env))return [];
  const rows=(await env.DELIVERY_DB.prepare(`SELECT w.id workspace_id FROM portal_v2_workspaces w WHERE w.project_alpha_source_id=? AND w.root_type=?
    AND COALESCE(w.pa_organization_public_id,w.pa_client_public_id)=?`).bind(root.sourceId,root.rootType,root.rootPublicId).all<{workspace_id:string}>()).results;
  const fences:OpsSharedProfileFence[]=[];for(const row of rows)fences.push(...await blockOpsSharedProfileWorkspace(env,row.workspace_id,operationKey));return fences;
}
export async function blockOpsSharedProfileEligibility(env:Env,_target:{issuer:string|null;subject:string|null;normalizedEmail:string|null},operationKey:string):Promise<BulkTransition>{
  return blockOpsSharedProfileBulk(env,operationKey);
}
async function blockOpsSharedProfileBulk(env:Env,operationKey:string):Promise<BulkTransition>{
  if(!await available(env))return{fences:[],latch:null};
  const operationId=await operationUuid(operationKey,'shared-profile-global-bulk');
  await env.DELIVERY_DB.prepare('UPDATE portal_shared_profile_bulk_latch SET operation_id=? WHERE id=1 AND (operation_id IS NULL OR operation_id=?)')
    .bind(operationId,operationId).run();
  if(await env.DELIVERY_DB.prepare('SELECT operation_id FROM portal_shared_profile_bulk_latch WHERE id=1').first<string>('operation_id')!==operationId)
    throw new Error('shared-profile-authority-transition-in-progress');
  // Identity changes may race a first profile visit in any workspace. The SQL
  // latch prevents new heads; fence every existing head before mutating identity.
  const rows=(await env.DELIVERY_DB.prepare('SELECT workspace_id FROM portal_shared_profile_authority_heads ORDER BY workspace_id').all<{workspace_id:string}>()).results;
  const fences:OpsSharedProfileFence[]=[];for(const row of rows)fences.push(...await blockOpsSharedProfileWorkspace(env,row.workspace_id,operationKey));
  return{fences,latch:{operationId}};
}
async function operationUuid(key:string,workspaceId:string,originalRevision?:number){
  if(!key)throw new Error('shared-profile-operation-key-required');
  const identity=originalRevision===undefined?[key,workspaceId]:[key,workspaceId,originalRevision];
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identity)))).slice(0,16);
  bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
  const h=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
