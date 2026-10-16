import type { Env } from '../types';
import type { SharedProfilePortalBinding } from '../../../../../packages/shared/src/shared-business-profile';
export type BusinessProfileAuthorityBinding=Pick<SharedProfilePortalBinding,'transitionAuthority'>;
type FenceEnvironment=Pick<Env,'DELIVERY_DB'> & {SHARED_PROFILE_PORTAL?:BusinessProfileAuthorityBinding};
type Head={workspace_id:string;source_id:string;revision:number;state:'active'|'blocked';operation_id:string;pending_operation_id:string|null};
export type BusinessProfileBulkFence=Readonly<{operationId:string}>;
export type BusinessProfileFenceGroup=Readonly<{receipts:BusinessProfileFence[];latch:BusinessProfileBulkFence|null}>;
export type BusinessProfileFence=Readonly<{workspaceId:string;sourceId:string;revision:number;operationId:string}>;
type AuthorityDatabase=Pick<D1Database,'prepare'|'batch'>;
async function operationUuid(key:string,workspace:string,originalRevision?:number):Promise<string>{
 if(!key)throw new Error('shared-profile-operation-key-required');
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(originalRevision===undefined?[key,workspace]:[key,workspace,originalRevision]))));
 bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
 const h=Array.from(bytes.slice(0,16),x=>x.toString(16).padStart(2,'0')).join('');return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
/** Retain pending ownership through the actual authority transaction. Stable
 * keys and original-revision salts recover unknown RPC outcomes, but never
 * allow a different authority request to release another request's fence.
 */
export async function blockBusinessProfileWorkspace(env:FenceEnvironment,workspaceId:string,operationKey:string):Promise<BusinessProfileFence|null>{
 let head:Head|null;
 try{if(!await env.DELIVERY_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portal_shared_profile_authority_heads'").first())return null;
  head=await env.DELIVERY_DB.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(workspaceId).first<Head>();}
 catch(error){if(/no such table/.test(String(error)))return null;throw error;}
 if(!head){
  // Before activation there can be no issued shared-profile proof.
  if(!await env.DELIVERY_DB.prepare('SELECT 1 FROM portal_shared_profile_runtime WHERE id=1 AND hooks_ready=1').first())return null;
  const workspace=await env.DELIVERY_DB.prepare('SELECT project_alpha_source_id FROM portal_v2_workspaces WHERE id=?').bind(workspaceId).first<{project_alpha_source_id:string}>();
  if(!workspace?.project_alpha_source_id)return null;
  if(!env.SHARED_PROFILE_PORTAL)throw new Error('shared-profile-authority-unavailable');
  const initial=await operationUuid(operationKey+'\0initial',workspaceId,0);
  await env.DELIVERY_DB.prepare("INSERT OR IGNORE INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES(?,?,1,'blocked',?)").bind(workspaceId,workspace.project_alpha_source_id,initial).run();
  head=await env.DELIVERY_DB.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(workspaceId).first<Head>();
  if(!head)throw new Error('shared-profile-authority-changed');
 }
 if(!env.SHARED_PROFILE_PORTAL)throw new Error('shared-profile-authority-unavailable');
 const mirrored=head.pending_operation_id!==null&&head.state==='blocked'&&head.operation_id===head.pending_operation_id;
 const expectedRevision=head.revision-(mirrored?1:0),revision=expectedRevision+1;
 const operationId=await operationUuid(operationKey,workspaceId,expectedRevision);
 if(head.pending_operation_id&&head.pending_operation_id!==operationId)throw new Error('shared-profile-authority-busy');
 if(!head.pending_operation_id){const pending=await env.DELIVERY_DB.prepare("UPDATE portal_shared_profile_authority_heads SET pending_operation_id=? WHERE workspace_id=? AND revision=? AND pending_operation_id IS NULL")
  .bind(operationId,workspaceId,head.revision).run();if(pending.meta.changes!==1)throw new Error('shared-profile-authority-changed');}
 // Retry an interrupted initial registration only after retaining mutation
 // ownership. An owner template can reject0-to-1; normal1-to-2 must succeed.
 if(head.revision===1&&head.state==='blocked'&&!mirrored)await env.SHARED_PROFILE_PORTAL.transitionAuthority({protocolVersion:1,operationId:head.operation_id,workspaceId,sourceId:head.source_id,expectedRevision:0,revision:1,state:'blocked'});
 const blocked=await env.SHARED_PROFILE_PORTAL.transitionAuthority({protocolVersion:1,operationId,workspaceId,sourceId:head.source_id,expectedRevision,revision,state:'blocked'});
 if(!blocked.ok)throw new Error('shared-profile-authority-changed');
 if(!mirrored){const saved=await env.DELIVERY_DB.prepare("UPDATE portal_shared_profile_authority_heads SET revision=?,state='blocked',operation_id=?,updated_at=datetime('now') WHERE workspace_id=? AND revision=? AND pending_operation_id=?")
  .bind(revision,operationId,workspaceId,expectedRevision,operationId).run();
  if(!saved.success||saved.meta.changes!==1)throw new Error('shared-profile-authority-changed');}
 return{workspaceId,sourceId:head.source_id,revision,operationId};
}
/** Assertions and releases belong in the SAME batch as the authority writes. */
export function businessProfileFenceStatements(db:AuthorityDatabase,receipts:readonly(BusinessProfileFence|null)[],release=false):D1PreparedStatement[]{
 return receipts.filter((r):r is BusinessProfileFence=>r!==null).map(r=>release
  ?db.prepare("UPDATE portal_shared_profile_authority_heads SET pending_operation_id=NULL WHERE workspace_id=? AND source_id=? AND revision=? AND state='blocked' AND operation_id=? AND pending_operation_id=?").bind(r.workspaceId,r.sourceId,r.revision,r.operationId,r.operationId)
  :db.prepare(`INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id,pending_operation_id)
    SELECT ?,?,0,'blocked',?,? WHERE NOT EXISTS(SELECT 1 FROM portal_shared_profile_authority_heads WHERE workspace_id=? AND source_id=? AND revision=? AND state='blocked' AND operation_id=? AND pending_operation_id=?)`)
    .bind(r.workspaceId,r.sourceId,r.operationId,r.operationId,r.workspaceId,r.sourceId,r.revision,r.operationId,r.operationId));
}
export async function reserveBusinessProfileBulkLatch(env:Pick<Env,'DELIVERY_DB'>,operationKey:string):Promise<BusinessProfileBulkFence|null>{
 if(!await env.DELIVERY_DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portal_shared_profile_bulk_latch'").first())return null;
 const operationId=await operationUuid(operationKey,'shared-profile-global-bulk');
 const result=await env.DELIVERY_DB.prepare('UPDATE portal_shared_profile_bulk_latch SET operation_id=? WHERE id=1 AND (operation_id IS NULL OR operation_id=?)').bind(operationId,operationId).run();
 if(result.meta.changes!==1)throw new Error('shared-profile-bulk-authority-busy');
 return{operationId};
}
export function businessProfileBulkLatchStatements(db:AuthorityDatabase,latch:BusinessProfileBulkFence|null|undefined,release=false):D1PreparedStatement[]{
 if(!latch)return[];
 return[release?db.prepare('UPDATE portal_shared_profile_bulk_latch SET operation_id=NULL WHERE id=1 AND operation_id=?').bind(latch.operationId)
  :db.prepare('INSERT INTO portal_shared_profile_bulk_latch(id,operation_id) SELECT 0,? WHERE NOT EXISTS(SELECT 1 FROM portal_shared_profile_bulk_latch WHERE id=1 AND operation_id=?)').bind(latch.operationId,latch.operationId)];
}
export async function businessProfileAuthorityBatch<T=unknown>(db:AuthorityDatabase,receipts:readonly(BusinessProfileFence|null)[],statements:D1PreparedStatement[],latch?:BusinessProfileBulkFence|null):Promise<D1Result<T>[]>{
 const before=[...businessProfileBulkLatchStatements(db,latch),...businessProfileFenceStatements(db,receipts)],after=[...businessProfileFenceStatements(db,receipts,true),...businessProfileBulkLatchStatements(db,latch,true)];
 return(await db.batch<T>([...before,...statements,...after])).slice(before.length,before.length+statements.length);
}
export async function blockBusinessProfileSource(env:FenceEnvironment,sourceId:string,operationKey:string):Promise<BusinessProfileFenceGroup>{
 const latch=await reserveBusinessProfileBulkLatch(env,operationKey);
 if(!latch)return{receipts:[],latch:null};
 const rows=(await env.DELIVERY_DB.prepare('SELECT * FROM portal_shared_profile_authority_heads WHERE source_id=?').bind(sourceId).all<Head>()).results;
 const receipts:BusinessProfileFence[]=[];for(const row of rows){const receipt=await blockBusinessProfileWorkspace(env,row.workspace_id,operationKey);if(receipt)receipts.push(receipt);}return{receipts,latch};
}
export async function blockBusinessProfileIdentity(env:FenceEnvironment,_identityId:string,operationKey:string):Promise<BusinessProfileFenceGroup>{
 // Identity transitions conservatively include all heads, not membership rows.
 const latch=await reserveBusinessProfileBulkLatch(env,operationKey);
 if(!latch)return{receipts:[],latch:null};
 const rows=(await env.DELIVERY_DB.prepare('SELECT * FROM portal_shared_profile_authority_heads').all<Head>()).results;
 const receipts:BusinessProfileFence[]=[];for(const row of rows){const receipt=await blockBusinessProfileWorkspace(env,row.workspace_id,operationKey);if(receipt)receipts.push(receipt);}return{receipts,latch};
}
