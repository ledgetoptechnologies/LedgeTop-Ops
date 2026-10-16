import {HTTPException} from 'hono/http-exception';
import type {Env,StaffPrincipal} from './types';
import {transitionSharedProfilePortalAuthority} from './shared-profile-portal-authority';

type RecoveryEnv=Pick<Env,'OPS_DB'|'DELIVERY_DB'>;
type Head={workspace_id:string;source_id:string;revision:number;state:'active'|'blocked';operation_id:string;pending_operation_id?:string|null};
type Owner={staffId:string;accessSubject:string;email:string;admissionVersion:number;profileVersion:number;profileGrantId:string;identityGrantId:string};
type OpsReceipt={operation_id:string;state:'pending'|'completed';ops_snapshot_json:string};
type ClientReceipt={operation_id:string;ownership_id:string;state:'pending'|'aligned'|'completed';snapshot_json:string;original_hooks_ready:number;final_heads_json:string|null};
export type SharedProfileAuthorityRecoveryStatus={available:boolean;pendingHeads:number;bulkPending:boolean;activeRecovery:{operationId:string;state:'pending'}|null};
export type SharedProfileAuthorityRecoveryOutcome={ok:true;operationId:string;state:'pending'|'completed';pendingHeads:number}|{ok:false;code:'denied'|'invalid'|'conflict'|'unavailable';operationId?:string};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_HEADS=512,MAX_STEPS=32;
const ownerSql=`SELECT staff_id staffId,access_subject accessSubject,login_email email,admission_version admissionVersion,profile_version profileVersion,profile_grant_id profileGrantId,identity_grant_id identityGrantId
 FROM shared_profile_authority_recovery_owners WHERE staff_id=? AND access_subject=? AND login_email=? ORDER BY profile_grant_id,identity_grant_id LIMIT 1`;
async function owner(env:RecoveryEnv,actor:StaffPrincipal):Promise<Owner|null>{return env.OPS_DB.prepare(ownerSql).bind(actor.id,actor.accessSubject,actor.email).first<Owner>();}
async function available(env:RecoveryEnv){return !!await env.OPS_DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shared_profile_authority_recoveries'").first()
 &&!!await env.DELIVERY_DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portal_shared_profile_authority_recoveries'").first();}
async function pendingHeads(env:RecoveryEnv){return(await env.DELIVERY_DB.prepare('SELECT count(*) n FROM portal_shared_profile_authority_heads WHERE pending_operation_id IS NOT NULL').first<number>('n'))??0;}
export async function readSharedProfileAuthorityRecoveryStatus(env:RecoveryEnv,actor:StaffPrincipal):Promise<SharedProfileAuthorityRecoveryStatus>{
 if(!await available(env))return{available:false,pendingHeads:0,bulkPending:false,activeRecovery:null};
 if(!await owner(env,actor))throw new HTTPException(403,{message:'A current owner or administrator with global directory authority is required'});
 const active=await env.OPS_DB.prepare("SELECT operation_id FROM shared_profile_authority_recoveries WHERE state='pending'").first<{operation_id:string}>()??await env.DELIVERY_DB.prepare("SELECT operation_id FROM portal_shared_profile_authority_recoveries WHERE state<>'completed'").first<{operation_id:string}>();
 return{available:true,pendingHeads:await pendingHeads(env),bulkPending:!!await env.DELIVERY_DB.prepare('SELECT operation_id FROM portal_shared_profile_bulk_latch WHERE id=1').first<string>('operation_id'),activeRecovery:active?{operationId:active.operation_id,state:'pending'}:null};
}
async function audit(env:RecoveryEnv,operationId:string,actor:StaffPrincipal,action:'resumed'|'completion_authorized'|'completed'){
 const current=await owner(env,actor);if(!current)throw Error('recovery-owner-changed');
 await env.OPS_DB.prepare('INSERT INTO shared_profile_authority_recovery_audit(id,operation_id,actor_id,actor_json,action) VALUES(?,?,?,?,?)')
  .bind(crypto.randomUUID(),operationId,actor.id,JSON.stringify(current),action).run();return current;
}
const snapshotSql=(table:string)=>`SELECT json_group_array(json_object('workspace_id',workspace_id,'source_id',source_id,'revision',revision,'state',state,'operation_id',operation_id${table.startsWith('portal_')?",'pending_operation_id',pending_operation_id":''})) FROM (SELECT * FROM ${table} ORDER BY workspace_id)`;
function checkClient(env:RecoveryEnv,condition:string,values:unknown[]=[]){return env.DELIVERY_DB.prepare(`INSERT INTO portal_shared_profile_runtime(id,hooks_ready) SELECT 0,0 WHERE NOT EXISTS(${condition})`).bind(...values as (string|number|null)[]);}
async function stepId(operationId:string,workspaceId:string,revision:number){const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(['shared-profile-recovery:v1',operationId,workspaceId,revision])))).slice(0,16);b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;const h=[...b].map(v=>v.toString(16).padStart(2,'0')).join('');return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
/** An explicit owner recovery only invalidates abandoned edit fences. It never
 * replays their customer/access mutation. Both databases stay closed until the
 * captured proof universe is monotonically blocked and matched. */
export async function recoverSharedProfileAuthority(env:RecoveryEnv,actor:StaffPrincipal,input:{operationId:string}):Promise<SharedProfileAuthorityRecoveryOutcome>{
 if(!input||Object.keys(input).length!==1||!UUID.test(input.operationId))return{ok:false,code:'invalid'};
 const operationId=input.operationId;
 try{
  if(!await available(env))return{ok:false,code:'unavailable',operationId};
  const authorized=await owner(env,actor);if(!authorized)return{ok:false,code:'denied',operationId};
  let receipt=await env.OPS_DB.prepare('SELECT * FROM shared_profile_authority_recoveries WHERE operation_id=?').bind(operationId).first<OpsReceipt>();
  if(!receipt){
   if(await env.OPS_DB.prepare("SELECT 1 FROM shared_profile_authority_recoveries WHERE state='pending'").first()||await env.DELIVERY_DB.prepare("SELECT 1 FROM portal_shared_profile_authority_recoveries WHERE state<>'completed'").first())return{ok:false,code:'conflict',operationId};
   await env.OPS_DB.batch([
    env.OPS_DB.prepare(`INSERT INTO shared_profile_authority_recoveries(operation_id,requested_by,actor_json,ops_snapshot_json)
     SELECT ?,?,?,(${snapshotSql('shared_profile_portal_authority_heads')}) WHERE (SELECT count(*) FROM shared_profile_portal_authority_heads)<=?`).bind(operationId,actor.id,JSON.stringify(authorized),MAX_HEADS),
    env.OPS_DB.prepare("INSERT INTO shared_profile_authority_recovery_audit(id,operation_id,actor_id,actor_json,action) VALUES(?,?,?,?,'requested')").bind(crypto.randomUUID(),operationId,actor.id,JSON.stringify(authorized)),
   ]);
   receipt=await env.OPS_DB.prepare('SELECT * FROM shared_profile_authority_recoveries WHERE operation_id=?').bind(operationId).first<OpsReceipt>();
  }
  if(!receipt)throw Error('recovery-receipt-unavailable');
  if(receipt.state==='completed'&&await env.DELIVERY_DB.prepare("SELECT 1 FROM portal_shared_profile_authority_recoveries WHERE operation_id=? AND state='completed'").bind(operationId).first())return{ok:true,operationId,state:'completed',pendingHeads:0};
  const actorProof=await audit(env,operationId,actor,'resumed');
  let captured=await env.DELIVERY_DB.prepare('SELECT * FROM portal_shared_profile_authority_recoveries WHERE operation_id=?').bind(operationId).first<ClientReceipt>();
  if(!captured){
   // Snapshot and takeover share one transaction. Whichever old authority batch
   // wins first commits completely; all later old receipts become invalid.
   const ownershipId=crypto.randomUUID();
   await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare(`INSERT INTO portal_shared_profile_authority_recoveries(operation_id,ownership_id,requested_by,actor_json,snapshot_json,original_hooks_ready,original_bulk_operation_id)
     SELECT ?,?,?,?,(${snapshotSql('portal_shared_profile_authority_heads')}),runtime.hooks_ready,latch.operation_id
     FROM portal_shared_profile_runtime runtime JOIN portal_shared_profile_bulk_latch latch ON latch.id=runtime.id
     WHERE runtime.id=1 AND (SELECT count(*) FROM portal_shared_profile_authority_heads)<=? AND latch.operation_id IS NOT ? AND NOT EXISTS(SELECT 1 FROM portal_shared_profile_authority_heads WHERE pending_operation_id=? OR operation_id=?)`).bind(operationId,ownershipId,actor.id,JSON.stringify(actorProof),MAX_HEADS,ownershipId,ownershipId,ownershipId),
    checkClient(env,"SELECT 1 FROM portal_shared_profile_authority_recoveries WHERE operation_id=? AND state='pending'",[operationId]),
    env.DELIVERY_DB.prepare('UPDATE portal_shared_profile_runtime SET hooks_ready=0 WHERE id=1'),
    env.DELIVERY_DB.prepare('UPDATE portal_shared_profile_bulk_latch SET operation_id=? WHERE id=1').bind(ownershipId),
    env.DELIVERY_DB.prepare('UPDATE portal_shared_profile_authority_heads SET pending_operation_id=?').bind(ownershipId),
   ]);
   captured=await env.DELIVERY_DB.prepare('SELECT * FROM portal_shared_profile_authority_recoveries WHERE operation_id=?').bind(operationId).first<ClientReceipt>();
  }
  if(!captured)throw Error('recovery-capture-unavailable');
  const ownershipId=captured.ownership_id;
  const opsHeads=JSON.parse(receipt.ops_snapshot_json) as Head[],clientHeads=JSON.parse(captured.snapshot_json) as Head[];
  if(!Array.isArray(opsHeads)||!Array.isArray(clientHeads)||opsHeads.length>MAX_HEADS||clientHeads.length>MAX_HEADS)throw Error('recovery-snapshot-invalid');
  const clients=new Map(clientHeads.map(h=>[h.workspace_id,h])),originalOps=new Map(opsHeads.map(h=>[h.workspace_id,h]));
  // Template-only heads have never issued a Client proof. Preserve blocked
  // revision one so a later first visit can create its normal revision-one head.
  for(const h of opsHeads)if(!clients.has(h.workspace_id)&&(h.state!=='blocked'||h.revision!==1))throw Error('recovery-unexpected-template');
  const finals:Head[]=[];let steps=0;
  for(const h of clientHeads){
   const original=originalOps.get(h.workspace_id);if(original&&original.source_id!==h.source_id)throw Error('recovery-source-conflict');
   const target=Math.max(h.revision,original?.revision??0)+1;
   if(!Number.isSafeInteger(target)||target<2)throw Error('recovery-revision-limit');
   let current=await env.OPS_DB.prepare('SELECT * FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(h.workspace_id).first<Head>();
   while(!current||current.revision<target){
    if(++steps>MAX_STEPS)return{ok:true,operationId,state:'pending',pendingHeads:await pendingHeads(env)};
    if(current&&current.source_id!==h.source_id)throw Error('recovery-source-conflict');
    const revision=(current?.revision??0)+1,id=await stepId(operationId,h.workspace_id,revision);
    const stepOwner=await audit(env,operationId,actor,'resumed');
    await env.OPS_DB.prepare('INSERT OR IGNORE INTO shared_profile_authority_recovery_steps(operation_id,workspace_id,source_id,revision,step_id,actor_json) VALUES(?,?,?,?,?,?)').bind(operationId,h.workspace_id,h.source_id,revision,id,JSON.stringify(stepOwner)).run();
    if(!(await transitionSharedProfilePortalAuthority(env,{protocolVersion:1,operationId:id,workspaceId:h.workspace_id,sourceId:h.source_id,expectedRevision:revision-1,revision,state:'blocked'})).ok)throw Error('recovery-step-pending');
    current=await env.OPS_DB.prepare('SELECT * FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(h.workspace_id).first<Head>();
   }
   const id=await stepId(operationId,h.workspace_id,target);
   if(!current||current.source_id!==h.source_id||current.revision!==target||current.state!=='blocked'||current.operation_id!==id)throw Error('recovery-head-changed');
   finals.push({...h,revision:target,state:'blocked',operation_id:id,pending_operation_id:ownershipId});
  }
  if(captured.state==='pending'){
   const finalJson=JSON.stringify(finals);
   // The Ops maintenance triggers freeze every non-recovery head transition.
   // Reauthorize the actual resuming owner immediately before the final Client
   // transaction; the immutable audit identifies who approved completion.
   await audit(env,operationId,actor,'completion_authorized');
   const stateGuard="SELECT 1 FROM portal_shared_profile_authority_recoveries receipt JOIN portal_shared_profile_bulk_latch latch ON latch.id=1 JOIN portal_shared_profile_runtime runtime ON runtime.id=1 WHERE receipt.operation_id=? AND receipt.state='pending' AND latch.operation_id=? AND runtime.hooks_ready=0";
   const statements=[checkClient(env,stateGuard,[operationId,ownershipId]),checkClient(env,`SELECT 1 WHERE (SELECT count(*) FROM portal_shared_profile_authority_heads)=? AND NOT EXISTS(SELECT 1 FROM portal_shared_profile_authority_heads head WHERE head.pending_operation_id IS NOT ? OR NOT EXISTS(SELECT 1 FROM json_each(?) planned WHERE json_extract(planned.value,'$.workspace_id')=head.workspace_id AND json_extract(planned.value,'$.source_id')=head.source_id))`,[finals.length,ownershipId,finalJson])];
   for(const h of finals)statements.push(env.DELIVERY_DB.prepare(`UPDATE portal_shared_profile_authority_heads SET revision=?,state='blocked',operation_id=?,updated_at=datetime('now')
    WHERE workspace_id=? AND source_id=? AND pending_operation_id=? AND revision IN(?,?)`).bind(h.revision,h.operation_id,h.workspace_id,h.source_id,ownershipId,clients.get(h.workspace_id)!.revision,h.revision));
   statements.push(checkClient(env,`SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM json_each(?) planned LEFT JOIN portal_shared_profile_authority_heads head ON head.workspace_id=json_extract(planned.value,'$.workspace_id') WHERE head.source_id IS NOT json_extract(planned.value,'$.source_id') OR head.revision IS NOT json_extract(planned.value,'$.revision') OR head.operation_id IS NOT json_extract(planned.value,'$.operation_id') OR head.state IS NOT 'blocked' OR head.pending_operation_id IS NOT ?)`,[finalJson,ownershipId]),
    env.DELIVERY_DB.prepare("UPDATE portal_shared_profile_authority_recoveries SET state='aligned',final_heads_json=? WHERE operation_id=? AND state='pending'").bind(finalJson,operationId));
   await env.DELIVERY_DB.batch(statements);
  }
  if(receipt.state!=='completed'){
   await audit(env,operationId,actor,'completion_authorized');
   await env.OPS_DB.prepare("UPDATE shared_profile_authority_recoveries SET state='completed',completion_json=? WHERE operation_id=? AND state='pending'").bind(JSON.stringify({actor:await owner(env,actor),clientSnapshot:captured.snapshot_json,heads:finals}),operationId).run();
  }
  await audit(env,operationId,actor,'completion_authorized');
  const finalJson=JSON.stringify(finals);
  await env.DELIVERY_DB.batch([
   checkClient(env,"SELECT 1 FROM portal_shared_profile_authority_recoveries receipt JOIN portal_shared_profile_bulk_latch latch ON latch.id=1 JOIN portal_shared_profile_runtime runtime ON runtime.id=1 WHERE receipt.operation_id=? AND receipt.state='aligned' AND receipt.final_heads_json=? AND latch.operation_id=? AND runtime.hooks_ready=0",[operationId,finalJson,ownershipId]),
   checkClient(env,`SELECT 1 WHERE (SELECT count(*) FROM portal_shared_profile_authority_heads)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) planned LEFT JOIN portal_shared_profile_authority_heads head ON head.workspace_id=json_extract(planned.value,'$.workspace_id') WHERE head.source_id IS NOT json_extract(planned.value,'$.source_id') OR head.revision IS NOT json_extract(planned.value,'$.revision') OR head.operation_id IS NOT json_extract(planned.value,'$.operation_id') OR head.state IS NOT 'blocked' OR head.pending_operation_id IS NOT ?)`,[finals.length,finalJson,ownershipId]),
   env.DELIVERY_DB.prepare('UPDATE portal_shared_profile_authority_heads SET pending_operation_id=NULL WHERE pending_operation_id=?').bind(ownershipId),
   env.DELIVERY_DB.prepare('UPDATE portal_shared_profile_bulk_latch SET operation_id=NULL WHERE id=1 AND operation_id=?').bind(ownershipId),
   env.DELIVERY_DB.prepare('UPDATE portal_shared_profile_runtime SET hooks_ready=? WHERE id=1').bind(captured.original_hooks_ready),
   env.DELIVERY_DB.prepare("UPDATE portal_shared_profile_authority_recoveries SET state='completed' WHERE operation_id=? AND state='aligned'").bind(operationId),
  ]);
  await audit(env,operationId,actor,'completed');
  return{ok:true,operationId,state:'completed',pendingHeads:0};
 }catch{
  try{if(await env.OPS_DB.prepare("SELECT 1 FROM shared_profile_authority_recoveries WHERE operation_id=?").bind(operationId).first())return{ok:true,operationId,state:'pending',pendingHeads:await pendingHeads(env)};}catch{}
  return{ok:false,code:'unavailable',operationId};
 }
}
