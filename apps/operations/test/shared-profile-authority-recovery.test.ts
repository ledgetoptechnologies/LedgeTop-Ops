import {readFileSync} from 'node:fs';
import {afterEach,expect,it} from 'vitest';
import {Miniflare} from 'miniflare';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {recoverSharedProfileAuthority,readSharedProfileAuthorityRecoveryStatus} from '../src/worker/shared-profile-authority-recovery';
import {blockOpsSharedProfileIdentity,assertOpsSharedProfileFences,releaseOpsSharedProfileFences} from '../src/worker/shared-profile-delivery-authority-fences';
import {blockBusinessProfileSource} from '../../client/src/worker/client-portal/business-profile-fences';
import {transitionSharedProfilePortalAuthority} from '../src/worker/shared-profile-portal-authority';
import type {Env,StaffPrincipal} from '../src/worker/types';
const active:Miniflare[]=[];
afterEach(async()=>{await Promise.all(active.splice(0).map(m=>m.dispose()));});
function failOnce(db:D1Database,match:string,after=false){
 let armed=true;
 const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>new Proxy(stmt,{get(target,key){
  if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values));
  if(key==='run')return async()=>{if(armed){armed=false;if(after)await target.run();throw Error('synthetic interrupted recovery');}return target.run();};
  const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;
 }});
 const database=(value:any):D1Database=>new Proxy(value,{get(target,key){
  if(key==='withSession')return(...args:unknown[])=>database(target.withSession(...args));
  if(key==='prepare')return(sql:string)=>sql.includes(match)?wrap(target.prepare(sql)):target.prepare(sql);
  const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;
 }});
 return database(db);
}

async function fixture(){
 const runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default{fetch(){return new Response("ok")}}',d1Databases:['OPS','CLIENT']});active.push(runtime);
 const ops=await runtime.getD1Database('OPS') as unknown as D1Database,client=await runtime.getD1Database('CLIENT') as unknown as D1Database;
 await ops.exec("CREATE TABLE staff_users(id TEXT PRIMARY KEY,access_subject TEXT,status TEXT); CREATE TABLE native_staff_admissions(staff_id TEXT,active INTEGER,bound_access_subject TEXT,version INTEGER); CREATE TABLE native_staff_profiles(staff_id TEXT,login_email TEXT,version INTEGER); CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT); CREATE TABLE native_directory_grants(id TEXT,staff_id TEXT,permission TEXT,scope_kind TEXT,effect TEXT,active INTEGER)");
 const heads=splitD1MigrationStatements(readFileSync(new URL('../migrations/0208_shared_profile_portal_authority.sql',import.meta.url),'utf8')).find(sql=>sql.includes('CREATE TABLE shared_profile_portal_authority_heads'))!;await ops.prepare(heads).run();
 const opsDDL=readFileSync(new URL('../migrations/0209_shared_profile_portal_native_writes.sql',import.meta.url),'utf8');await ops.batch(splitD1MigrationStatements(opsDDL.slice(opsDDL.indexOf('CREATE TABLE shared_profile_authority_recoveries'))).map(sql=>ops.prepare(sql)));
 await client.batch(splitD1MigrationStatements(readFileSync(new URL('../../client/migrations/0232_shared_profile_edit_authority.sql',import.meta.url),'utf8')).map(sql=>client.prepare(sql)));
 const owners:StaffPrincipal[]=[];
 for(const id of ['owner-one','owner-two']){const subject='access|'+id,email=id+'@example.test';owners.push({id,email,accessSubject:subject,displayName:id,projectAlphaUserId:null});await ops.batch([
  ops.prepare("INSERT INTO staff_users VALUES(?,?,'active')").bind(id,subject),ops.prepare('INSERT INTO native_staff_admissions VALUES(?,1,?,1)').bind(id,subject),ops.prepare('INSERT INTO native_staff_profiles VALUES(?,?,1)').bind(id,email),ops.prepare("INSERT INTO staff_role_assignments VALUES(?,'role-owner','global')").bind(id),
  ...['directory.profile.edit','directory.identity.link'].map((permission,index)=>ops.prepare("INSERT INTO native_directory_grants VALUES(?,?,?,'global','allow',1)").bind(id+'-'+index,id,permission)),
 ]);}
 const oldId=crypto.randomUUID();await ops.prepare("INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES('workspace','project-alpha:primary',3,'blocked',?)").bind(oldId).run();
 await client.batch([client.prepare('UPDATE portal_shared_profile_runtime SET hooks_ready=1 WHERE id=1'),client.prepare("INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id,pending_operation_id) VALUES('workspace','project-alpha:primary',3,'blocked',?,?)").bind(oldId,oldId)]);
 await client.exec("CREATE TABLE business_authority(id TEXT PRIMARY KEY,payload TEXT); INSERT INTO business_authority VALUES('keep','{\"access\":true,\"profile\":\"unchanged\"}')");
 return{ops,client,owners,oldId,env:{OPS_DB:ops,DELIVERY_DB:client} as Env,oldFence:{workspaceId:'workspace',sourceId:'project-alpha:primary',revision:3,operationId:oldId}};
}
it('invalidates colliding old receipt ownership, stays closed after unknown block commit, and allows a new current owner to resume',async()=>{
 const f=await fixture(),operationId=f.oldId;
 expect(await recoverSharedProfileAuthority({...f.env,OPS_DB:failOnce(f.ops,'UPDATE shared_profile_portal_authority_heads SET revision=',true)},f.owners[0]!,{operationId})).toMatchObject({ok:true,state:'pending'});
 const captured=await f.client.prepare('SELECT ownership_id,snapshot_json FROM portal_shared_profile_authority_recoveries WHERE operation_id=?').bind(operationId).first<{ownership_id:string;snapshot_json:string}>();expect(captured!.ownership_id).not.toBe(operationId);
 expect(await f.client.prepare('SELECT hooks_ready FROM portal_shared_profile_runtime').first('hooks_ready')).toBe(0);
 await expect(f.client.batch([...assertOpsSharedProfileFences(f.env,[f.oldFence]),f.client.prepare("UPDATE business_authority SET payload='unsafe'"),...releaseOpsSharedProfileFences(f.env,[f.oldFence])])).rejects.toThrow();
 await expect(f.client.prepare("INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES('new','project-alpha:primary',1,'blocked','new')").run()).rejects.toThrow('bulk-authority-pending');
 await expect(f.ops.prepare("INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES('new','project-alpha:primary',1,'blocked','new')").run()).rejects.toThrow('recovery-maintenance');
 await f.ops.prepare('DELETE FROM staff_role_assignments WHERE staff_id=?').bind(f.owners[0]!.id).run();
 expect(await recoverSharedProfileAuthority(f.env,f.owners[0]!,{operationId})).toEqual({ok:false,code:'denied',operationId});
 expect(await recoverSharedProfileAuthority(f.env,f.owners[1]!,{operationId})).toEqual({ok:true,operationId,state:'completed',pendingHeads:0});
 expect(await f.client.prepare('SELECT hooks_ready FROM portal_shared_profile_runtime').first('hooks_ready')).toBe(1);
 expect(await f.client.prepare('SELECT revision,pending_operation_id FROM portal_shared_profile_authority_heads').first()).toEqual({revision:4,pending_operation_id:null});
 expect(await f.ops.prepare("SELECT count(*) n FROM shared_profile_authority_recovery_audit WHERE actor_id='owner-two'").first<number>('n')).toBeGreaterThan(0);
 expect(await f.client.prepare('SELECT payload FROM business_authority').first('payload')).toBe('{"access":true,"profile":"unchanged"}');
});
it('keeps the Client gate closed after Ops completion and resumes final release without reserving unrelated authority work',async()=>{
 const f=await fixture(),operationId=crypto.randomUUID();
 expect(await recoverSharedProfileAuthority({...f.env,OPS_DB:failOnce(f.ops,"UPDATE shared_profile_authority_recoveries SET state='completed'",true)},f.owners[0]!,{operationId})).toMatchObject({ok:true,state:'pending'});
 expect(await f.ops.prepare('SELECT state FROM shared_profile_authority_recoveries').first('state')).toBe('completed');
 expect(await f.client.prepare('SELECT state FROM portal_shared_profile_authority_recoveries').first('state')).toBe('aligned');
 expect(await readSharedProfileAuthorityRecoveryStatus(f.env,f.owners[1]!)).toMatchObject({activeRecovery:{operationId,state:'pending'},bulkPending:true});
 await expect(blockOpsSharedProfileIdentity(f.env,'identity',null,'unrelated')).rejects.toThrow('transition-in-progress');
 await expect(blockBusinessProfileSource({DELIVERY_DB:f.client} as never,'project-alpha:primary','unrelated')).rejects.toThrow();
 expect(await recoverSharedProfileAuthority(f.env,f.owners[1]!,{operationId})).toEqual({ok:true,operationId,state:'completed',pendingHeads:0});
 // A completed operation is an immutable result; later pending work is separate.
 const next=crypto.randomUUID();await f.client.prepare('UPDATE portal_shared_profile_authority_heads SET pending_operation_id=?').bind(next).run();
 expect(await recoverSharedProfileAuthority(f.env,f.owners[1]!,{operationId})).toEqual({ok:true,operationId,state:'completed',pendingHeads:0});
 expect(await f.client.prepare('SELECT pending_operation_id FROM portal_shared_profile_authority_heads').first('pending_operation_id')).toBe(next);
});
it('preserves unused Ops revision-one templates and advances Ops-ahead proof heads monotonically',async()=>{
 const f=await fixture();await f.ops.batch([
  f.ops.prepare("UPDATE shared_profile_portal_authority_heads SET revision=5 WHERE workspace_id='workspace'"),
  f.ops.prepare("INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES('template','project-alpha:secondary',1,'blocked',?)").bind(crypto.randomUUID()),
 ]);
 expect(await recoverSharedProfileAuthority(f.env,f.owners[0]!,{operationId:crypto.randomUUID()})).toMatchObject({ok:true,state:'completed'});
 expect(await f.client.prepare("SELECT revision FROM portal_shared_profile_authority_heads WHERE workspace_id='workspace'").first('revision')).toBe(6);
 expect(await f.ops.prepare("SELECT revision,state FROM shared_profile_portal_authority_heads WHERE workspace_id='template'").first()).toEqual({revision:1,state:'blocked'});
 const id=crypto.randomUUID();await f.client.prepare("INSERT INTO portal_shared_profile_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES('template','project-alpha:secondary',1,'blocked',?)").bind(id).run();
 expect(await transitionSharedProfilePortalAuthority(f.env,{protocolVersion:1,operationId:crypto.randomUUID(),workspaceId:'template',sourceId:'project-alpha:secondary',expectedRevision:1,revision:1,state:'active'})).toEqual({ok:true,revision:1});
});
it('rejects unauthorized and different-body recovery requests without changing authority',async()=>{
 const f=await fixture(),operationId=crypto.randomUUID();await f.ops.prepare('DELETE FROM staff_role_assignments WHERE staff_id=?').bind(f.owners[0]!.id).run();
 expect(await recoverSharedProfileAuthority(f.env,f.owners[0]!,{operationId})).toEqual({ok:false,code:'denied',operationId});
 expect(await recoverSharedProfileAuthority(f.env,f.owners[1]!,{operationId,profile:{name:'forbidden'}} as never)).toEqual({ok:false,code:'invalid'});
 expect(await f.ops.prepare('SELECT count(*) n FROM shared_profile_authority_recoveries').first('n')).toBe(0);
});
