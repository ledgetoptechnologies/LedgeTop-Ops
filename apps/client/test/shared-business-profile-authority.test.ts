import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { splitD1MigrationStatements } from './helpers/d1-migrations';
import { blockBusinessProfileSource,blockBusinessProfileWorkspace,createBusinessProfileRouter } from '../src/worker/client-portal/business-profile';
import {businessProfileAuthorityBatch,reserveBusinessProfileBulkLatch,blockBusinessProfileIdentity} from '../src/worker/client-portal/business-profile-fences';
import type { SharedProfilePortalBinding } from '../../../packages/shared/src/shared-business-profile';
let mf:Miniflare,db:D1Database,n=0;
beforeAll(async()=>{mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-08-06',d1Databases:['DB']});db=await mf.getD1Database('DB');
 for(const sql of splitD1MigrationStatements(readFileSync(new URL('../migrations/0232_shared_profile_edit_authority.sql',import.meta.url),'utf8')))await db.prepare(sql).run();});
afterAll(async()=>{await mf.dispose();});
async function head(){const id=`workspace-${++n}`;await db.prepare("INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES(?,'project-alpha:primary',1,'active','initial')").bind(id).run();return id;}
function binding(transitionAuthority:SharedProfilePortalBinding['transitionAuthority']):SharedProfilePortalBinding{return{transitionAuthority,bindProfileIdentity:async()=>({ok:true,bound:0}),readProfile:async()=>({ok:false,code:'unavailable'}),updateProfile:async()=>({ok:false,code:'unavailable'})};}
describe('Client business profile authority fencing',()=>{
 it('blocks Operations before the Delivery authority can change',async()=>{const id=await head();const transition=vi.fn(async()=>{
  const row=await db.prepare('SELECT revision,state,pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(id).first();
  expect(row?.revision).toBe(1);expect(row?.state).toBe('active');expect(row?.pending_operation_id).toBeTruthy();return{ok:true,revision:2};});
  await blockBusinessProfileWorkspace({DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(transition)},id,'change-one');expect(transition).toHaveBeenCalledOnce();
  expect(await db.prepare('SELECT revision,state,pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(id).first()).toMatchObject({revision:2,state:'blocked',pending_operation_id:expect.any(String)});
  const receipt=await blockBusinessProfileWorkspace({DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(async()=>({ok:true}))},id,'change-one');
  await businessProfileAuthorityBatch(db,[receipt],[]);
  expect(await db.prepare('SELECT pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(id).first()).toEqual({pending_operation_id:null});
 });
 it('retains a durable idempotent retry if the cross-DB RPC fails',async()=>{const id=await head(),operations:string[]=[];let fail=true;
  const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(async input=>{operations.push(input.operationId);return{ok:!fail,revision:2};})};
  await expect(blockBusinessProfileWorkspace(env,id,'retry-change')).rejects.toThrow('shared-profile-authority-changed');
  const pending=await db.prepare('SELECT revision,pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(id).first();expect(pending?.revision).toBe(1);expect(pending?.pending_operation_id).toBe(operations[0]);
  fail=false;await blockBusinessProfileWorkspace(env,id,'retry-change');expect(operations[1]).toBe(operations[0]);
  const receipt=await blockBusinessProfileWorkspace(env,id,'retry-change');await businessProfileAuthorityBatch(db,[receipt],[]);
 });
 it('blocks every registered workspace when its source retires',async()=>{const first=await head(),second=await head();const seen:string[]=[];
  const receipts=await blockBusinessProfileSource({DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(async input=>{seen.push(input.workspaceId);return{ok:true};})},'project-alpha:primary','source-retire');expect(seen).toContain(first);expect(seen).toContain(second);await businessProfileAuthorityBatch(db,receipts.receipts,[],receipts.latch);
 });
 it('refuses different pending owners and leaves failed authority batches blocked',async()=>{const id=await head();const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(async()=>({ok:true}))};
  const receipt=await blockBusinessProfileWorkspace(env,id,'mutation-A');
  await expect(blockBusinessProfileWorkspace(env,id,'mutation-B')).rejects.toThrow('shared-profile-authority-busy');
  await expect(businessProfileAuthorityBatch(db,[receipt],[db.prepare("INSERT INTO portal_shared_profile_runtime(id,hooks_ready) VALUES(2,0)")])).rejects.toThrow();
  expect(await db.prepare('SELECT state,pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(id).first()).toMatchObject({state:'blocked',pending_operation_id:receipt!.operationId});
  const recovered=await blockBusinessProfileWorkspace(env,id,'mutation-A');expect(recovered).toEqual(receipt);
  await businessProfileAuthorityBatch(db,[recovered],[]);
 });
 it('closes bulk head registration and activation until the same authority batch releases the latch',async()=>{
  const id=await head(),env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(async()=>({ok:true}))};
  const latch=await reserveBusinessProfileBulkLatch(env,'bulk-source-A');
  await expect(reserveBusinessProfileBulkLatch(env,'bulk-source-B')).rejects.toThrow('shared-profile-bulk-authority-busy');
  await expect(db.prepare("INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES('racing-new-head','project-alpha:primary',1,'blocked','initial')").run()).rejects.toThrow('shared-profile-bulk-authority-pending');
  await expect(db.prepare("UPDATE portal_shared_profile_authority_heads SET state='active',operation_id='racing-activation' WHERE workspace_id=?").bind(id).run()).rejects.toThrow('shared-profile-authority-pending');
  const recovered=await reserveBusinessProfileBulkLatch(env,'bulk-source-A');expect(recovered).toEqual(latch);
  await businessProfileAuthorityBatch(db,[],[],latch);
  expect(await db.prepare('SELECT operation_id FROM portal_shared_profile_bulk_latch WHERE id=1').first('operation_id')).toBeNull();
 });
 it('identity bulk blocks all immutable heads including workspaces absent from membership enumeration',async()=>{
  const id=await head(),env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(async()=>({ok:true}))};
  const group=await blockBusinessProfileIdentity(env,'identity-with-no-membership','identity-bulk');
  expect(group.receipts.some(r=>r.workspaceId===id)).toBe(true);
  await expect(db.prepare("UPDATE portal_shared_profile_authority_heads SET source_id='project-alpha:secondary' WHERE workspace_id=?").bind(id).run()).rejects.toThrow('shared-profile-head-identity-immutable');
  await expect(db.prepare('DELETE FROM portal_shared_profile_authority_heads WHERE workspace_id=?').bind(id).run()).rejects.toThrow('shared-profile-head-identity-immutable');
  await businessProfileAuthorityBatch(db,group.receipts,[],group.latch);
 });
 it('reserves an absent workspace head before single-workspace authority can change once hooks are ready',async()=>{
  await db.exec("CREATE TABLE IF NOT EXISTS portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT); INSERT INTO portal_v2_workspaces VALUES('first-proof-race','project-alpha:primary'); UPDATE portal_shared_profile_runtime SET hooks_ready=1");
  const calls:unknown[]=[];const receipt=await blockBusinessProfileWorkspace({DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(async input=>{calls.push(input);return{ok:true};})},'first-proof-race','first-revocation');
  expect(calls).toHaveLength(2);expect(receipt?.revision).toBe(2);
  expect(await db.prepare("SELECT revision,state,pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id='first-proof-race'").first()).toEqual({revision:2,state:'blocked',pending_operation_id:receipt!.operationId});
  await businessProfileAuthorityBatch(db,[receipt],[db.prepare('UPDATE portal_shared_profile_runtime SET hooks_ready=0')]);
 });
 it('salts completed repeated logical operations by their original revision while pending retries retain ownership',async()=>{
  const id=await head();let remote={revision:1,operationId:'initial'};
  const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(async input=>{
   if(input.operationId===remote.operationId)return{ok:input.revision===remote.revision};
   if(input.expectedRevision!==remote.revision)return{ok:false};
   remote={revision:input.revision,operationId:input.operationId};return{ok:true};
  })};
  const first=await blockBusinessProfileWorkspace(env,id,'same-logical-operation');
  const retry=await blockBusinessProfileWorkspace(env,id,'same-logical-operation');expect(retry).toEqual(first);
  await businessProfileAuthorityBatch(db,[first],[]);
  const second=await blockBusinessProfileWorkspace(env,id,'same-logical-operation');expect(second?.revision).toBe(3);expect(second?.operationId).not.toBe(first?.operationId);
  const secondRetry=await blockBusinessProfileWorkspace(env,id,'same-logical-operation');expect(secondRetry).toEqual(second);
  await businessProfileAuthorityBatch(db,[second],[]);
 });
 it('recovers initial head registration after its first Ops bootstrap RPC fails',async()=>{
  await db.exec("INSERT INTO portal_v2_workspaces VALUES('initial-rpc-retry','project-alpha:primary'); UPDATE portal_shared_profile_runtime SET hooks_ready=1");
  let fail=true,remoteRevision=0;const observed:number[]=[];
  const env={DELIVERY_DB:db,SHARED_PROFILE_PORTAL:binding(async input=>{observed.push(input.expectedRevision);if(fail||input.expectedRevision!==remoteRevision)return{ok:false};remoteRevision=input.revision;return{ok:true};})};
  await expect(blockBusinessProfileWorkspace(env,'initial-rpc-retry','initial-mutation')).rejects.toThrow('shared-profile-authority-changed');
  expect(await db.prepare("SELECT revision,state,pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id='initial-rpc-retry'").first()).toMatchObject({revision:1,state:'blocked',pending_operation_id:expect.any(String)});
  fail=false;const receipt=await blockBusinessProfileWorkspace(env,'initial-rpc-retry','initial-mutation');expect(receipt?.revision).toBe(2);expect(observed).toEqual([0,1,0,1]);
  await businessProfileAuthorityBatch(db,[receipt],[db.prepare('UPDATE portal_shared_profile_runtime SET hooks_ready=0')]);
 });
 it('does not enable self-service merely by installing the migration',async()=>{const router=createBusinessProfileRouter();
  const response=await router.request('https://client.example.test/workspace/business-profile',{}, {DELIVERY_DB:db} as never);
  expect(response.status).toBe(503);expect(await response.json()).toEqual({ok:false,code:'unavailable'});
 });
 it('rejects cross-origin mutations before invoking any profile authority',async()=>{const router=createBusinessProfileRouter();
  const response=await router.request('https://client.example.test/workspace/business-profile',{method:'PATCH',headers:{Origin:'https://evil.example.test'},body:'{}'},{DELIVERY_DB:db} as never);expect(response.status).toBe(403);
 });
});
