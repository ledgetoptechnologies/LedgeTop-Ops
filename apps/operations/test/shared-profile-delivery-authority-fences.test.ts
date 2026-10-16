import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { afterEach,expect,it } from 'vitest';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { blockOpsSharedProfileWorkspace,blockOpsSharedProfileIdentity,assertOpsSharedProfileFences,releaseOpsSharedProfileFences } from '../src/worker/shared-profile-delivery-authority-fences';
import type { Env } from '../src/worker/types';
const active:Miniflare[]=[];
async function fixture(opsTable=true){
 const mf=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default{fetch(){return new Response("ok")}}',d1Databases:['OPS','CLIENT']});active.push(mf);
 const ops=await mf.getD1Database('OPS') as unknown as D1Database,client=await mf.getD1Database('CLIENT') as unknown as D1Database;
 for(const statement of splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0232_shared_profile_edit_authority.sql',import.meta.url),'utf8')))await client.prepare(statement).run();
 await client.exec("INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES('workspace','project-alpha:primary',1,'active','initial'); CREATE TABLE authority(value INTEGER CHECK(value IN(0,1))); INSERT INTO authority VALUES(1)");
 const createOps=()=>ops.exec("CREATE TABLE shared_profile_portal_authority_heads(workspace_id TEXT PRIMARY KEY,source_id TEXT,revision INTEGER,state TEXT,operation_id TEXT,updated_at TEXT); INSERT INTO shared_profile_portal_authority_heads VALUES('workspace','project-alpha:primary',1,'active','initial',NULL)");
 if(opsTable)await createOps();
 return{ops,client,createOps,env:{OPS_DB:ops,DELIVERY_DB:client} as Env};
}
afterEach(async()=>{await Promise.all(active.splice(0).map(m=>m.dispose()));});
it('blocks Ops before mirroring the same authority revision in Delivery',async()=>{
 const f=await fixture();const fences=await blockOpsSharedProfileWorkspace(f.env,'workspace','operation-one');
 const a=await f.ops.prepare('SELECT * FROM shared_profile_portal_authority_heads').first<Record<string,unknown>>();
 const b=await f.client.prepare('SELECT * FROM portal_shared_profile_authority_heads').first<Record<string,unknown>>();
 expect(a).toMatchObject({revision:2,state:'blocked'});expect(b).toMatchObject({revision:2,state:'blocked',pending_operation_id:a!.operation_id});
 expect(a!.operation_id).toBe(b!.operation_id);
 await f.client.batch([...assertOpsSharedProfileFences(f.env,fences),f.client.prepare('UPDATE authority SET value=0'),...releaseOpsSharedProfileFences(f.env,fences)]);
 expect(await f.client.prepare('SELECT pending_operation_id FROM portal_shared_profile_authority_heads').first('pending_operation_id')).toBeNull();
 expect(await f.client.prepare('SELECT value FROM authority').first('value')).toBe(0);
});
it('leaves a durable pending block when Ops is unavailable and resumes that operation safely',async()=>{
 const f=await fixture(false);await expect(blockOpsSharedProfileWorkspace(f.env,'workspace','operation-one')).rejects.toThrow('shared-profile-authority-changed');
 const reserved=await f.client.prepare('SELECT * FROM portal_shared_profile_authority_heads').first<Record<string,unknown>>();
 expect(reserved).toMatchObject({revision:1,state:'active'});expect(reserved!.pending_operation_id).toEqual(expect.any(String));
 await f.createOps();const fences=await blockOpsSharedProfileWorkspace(f.env,'workspace','operation-one');
 const saved=await f.client.prepare('SELECT * FROM portal_shared_profile_authority_heads').first<Record<string,unknown>>();
 expect(saved).toMatchObject({revision:2,state:'blocked',operation_id:reserved!.pending_operation_id,pending_operation_id:reserved!.pending_operation_id});
 expect(await blockOpsSharedProfileWorkspace(f.env,'workspace','operation-one')).toEqual(fences);
 await f.client.batch([...assertOpsSharedProfileFences(f.env,fences),...releaseOpsSharedProfileFences(f.env,fences)]);
});
it('does not mutate a head owned by another PA source',async()=>{
 const f=await fixture();await f.ops.prepare("UPDATE shared_profile_portal_authority_heads SET source_id='project-alpha:secondary'").run();
 await expect(blockOpsSharedProfileWorkspace(f.env,'workspace','operation-one')).rejects.toThrow('shared-profile-authority-changed');
 expect(await f.ops.prepare('SELECT revision,state FROM shared_profile_portal_authority_heads').first()).toEqual({revision:1,state:'active'});
 expect(await f.client.prepare('SELECT revision FROM portal_shared_profile_authority_heads').first<number>('revision')).toBe(1);
});
it('keeps a failed authority batch blocked and prevents another operation from consuming its fence',async()=>{
 const f=await fixture(),fences=await blockOpsSharedProfileWorkspace(f.env,'workspace','operation-one');
 await expect(blockOpsSharedProfileWorkspace(f.env,'workspace','operation-two')).rejects.toThrow('transition-in-progress');
 await expect(f.client.batch([...assertOpsSharedProfileFences(f.env,fences),f.client.prepare('UPDATE authority SET value=2'),...releaseOpsSharedProfileFences(f.env,fences)])).rejects.toThrow();
 expect(await f.client.prepare('SELECT pending_operation_id FROM portal_shared_profile_authority_heads').first('pending_operation_id')).toBe(fences[0]!.operationId);
 expect(await f.client.prepare('SELECT value FROM authority').first('value')).toBe(1);
 const retry=await blockOpsSharedProfileWorkspace(f.env,'workspace','operation-one');
 expect(retry).toEqual(fences);
 expect(await f.ops.prepare('SELECT revision FROM shared_profile_portal_authority_heads').first('revision')).toBe(2);
 await f.client.batch([...assertOpsSharedProfileFences(f.env,retry),f.client.prepare('UPDATE authority SET value=0'),...releaseOpsSharedProfileFences(f.env,retry)]);
 expect(await f.client.prepare('SELECT pending_operation_id FROM portal_shared_profile_authority_heads').first('pending_operation_id')).toBeNull();
});
it('advances two completed same-key mutations while the head stays blocked',async()=>{
 const f=await fixture();
 const first=await blockOpsSharedProfileWorkspace(f.env,'workspace','repeatable-authority-change');
 await f.client.batch([...assertOpsSharedProfileFences(f.env,first),f.client.prepare('UPDATE authority SET value=0'),...releaseOpsSharedProfileFences(f.env,first)]);
 const second=await blockOpsSharedProfileWorkspace(f.env,'workspace','repeatable-authority-change');
 expect(second[0]!.revision).toBe(3);expect(second[0]!.operationId).not.toBe(first[0]!.operationId);
 expect(await blockOpsSharedProfileWorkspace(f.env,'workspace','repeatable-authority-change')).toEqual(second);
 await f.client.batch([...assertOpsSharedProfileFences(f.env,second),f.client.prepare('UPDATE authority SET value=1'),...releaseOpsSharedProfileFences(f.env,second)]);
 expect(await f.ops.prepare('SELECT revision,state,operation_id FROM shared_profile_portal_authority_heads').first()).toEqual({revision:3,state:'blocked',operation_id:second[0]!.operationId});
 expect(await f.client.prepare('SELECT revision,state,pending_operation_id FROM portal_shared_profile_authority_heads').first()).toEqual({revision:3,state:'blocked',pending_operation_id:null});
 expect(await f.client.prepare('SELECT value FROM authority').first('value')).toBe(1);
});
it('allows the same completed bulk key to fence a later mutation at a new workspace revision',async()=>{
 const f=await fixture(),first=await blockOpsSharedProfileIdentity(f.env,'identity',null,'repeat-bulk');
 await f.client.batch([...assertOpsSharedProfileFences(f.env,first.fences,first.latch),...releaseOpsSharedProfileFences(f.env,first.fences,first.latch)]);
 const second=await blockOpsSharedProfileIdentity(f.env,'identity',null,'repeat-bulk');
 expect(second.latch).toEqual(first.latch);expect(second.fences[0]!.operationId).not.toBe(first.fences[0]!.operationId);expect(second.fences[0]!.revision).toBe(3);
 await f.client.batch([...assertOpsSharedProfileFences(f.env,second.fences,second.latch),...releaseOpsSharedProfileFences(f.env,second.fences,second.latch)]);
});
it('recovers an initial no-head reservation when the first Ops mirror failed',async()=>{
 const f=await fixture(false);
 await f.client.exec("UPDATE portal_shared_profile_runtime SET hooks_ready=1; CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT); INSERT INTO portal_v2_workspaces VALUES('new-workspace','project-alpha:primary',NULL)");
 await expect(blockOpsSharedProfileWorkspace(f.env,'new-workspace','initial-retry')).rejects.toThrow('shared-profile-authority-changed');
 const pending=await f.client.prepare("SELECT revision,state,pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id='new-workspace'").first<{revision:number;state:string;pending_operation_id:string}>();
 expect(pending).toMatchObject({revision:1,state:'blocked',pending_operation_id:expect.any(String)});
 await f.createOps();const fences=await blockOpsSharedProfileWorkspace(f.env,'new-workspace','initial-retry');
 expect(fences).toEqual([{workspaceId:'new-workspace',sourceId:'project-alpha:primary',revision:2,operationId:pending!.pending_operation_id}]);
 expect(await blockOpsSharedProfileWorkspace(f.env,'new-workspace','initial-retry')).toEqual(fences);
 await f.client.batch([...assertOpsSharedProfileFences(f.env,fences),...releaseOpsSharedProfileFences(f.env,fences)]);
});
it('resumes resolver-created initial heads with either missing or existing Ops owner-template heads',async()=>{
 for(const existingOpsHead of [false,true]){
  const f=await fixture();
  await f.client.prepare("UPDATE portal_shared_profile_authority_heads SET state='blocked',operation_id=?").bind(crypto.randomUUID()).run();
  if(!existingOpsHead)await f.ops.prepare('DELETE FROM shared_profile_portal_authority_heads').run();
  const fences=await blockOpsSharedProfileWorkspace(f.env,'workspace','resolver-initial-retry');
  expect(fences[0]!.revision).toBe(2);
  expect(await f.ops.prepare('SELECT revision,state,operation_id FROM shared_profile_portal_authority_heads').first()).toEqual({revision:2,state:'blocked',operation_id:fences[0]!.operationId});
  await f.client.batch([...assertOpsSharedProfileFences(f.env,fences),...releaseOpsSharedProfileFences(f.env,fences)]);
 }
});
it('excludes first-visit head creation throughout a bulk identity authority transaction',async()=>{
 const f=await fixture(),transition=await blockOpsSharedProfileIdentity(f.env,'identity',null,'bulk-one');
 expect(transition.fences).toHaveLength(1);expect(transition.latch).not.toBeNull();
 const insert=()=>f.client.prepare("INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES('new-workspace','project-alpha:primary',1,'blocked','first-visit')").run();
 await expect(insert()).rejects.toThrow('bulk-authority-pending');
 await expect(blockOpsSharedProfileIdentity(f.env,'another',null,'bulk-two')).rejects.toThrow('transition-in-progress');
 await f.client.batch([...assertOpsSharedProfileFences(f.env,transition.fences,transition.latch),f.client.prepare('UPDATE authority SET value=0'),...releaseOpsSharedProfileFences(f.env,transition.fences,transition.latch)]);
 expect(await f.client.prepare('SELECT operation_id FROM portal_shared_profile_bulk_latch WHERE id=1').first('operation_id')).toBeNull();
 await expect(insert()).resolves.toMatchObject({success:true});
});
it('reserves an unseen native workspace before an Ops-side authority change',async()=>{
 const f=await fixture();await f.client.exec("UPDATE portal_shared_profile_runtime SET hooks_ready=1; CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT); INSERT INTO portal_v2_workspaces VALUES('new-workspace','project-alpha:primary',NULL)");
 const fences=await blockOpsSharedProfileWorkspace(f.env,'new-workspace','operation-new');
 expect(fences).toHaveLength(1);expect(fences[0]!.revision).toBe(2);
 expect(await f.client.prepare("SELECT revision,state,pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id='new-workspace'").first()).toEqual({revision:2,state:'blocked',pending_operation_id:fences[0]!.operationId});
 await f.client.batch([...assertOpsSharedProfileFences(f.env,fences),f.client.prepare('UPDATE authority SET value=0'),...releaseOpsSharedProfileFences(f.env,fences)]);
 expect(await f.client.prepare("SELECT pending_operation_id FROM portal_shared_profile_authority_heads WHERE workspace_id='new-workspace'").first('pending_operation_id')).toBeNull();
});
