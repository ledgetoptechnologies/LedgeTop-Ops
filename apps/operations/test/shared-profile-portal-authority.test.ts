import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { authorizedSharedProfilePortalGrants,bindSharedProfilePortalIdentity,prepareSharedProfilePortalWrite,readSharedProfilePortalProfiles,stablePortalRequestFingerprint,transitionSharedProfilePortalAuthority } from '../src/worker/shared-profile-portal-authority';
import type { SharedProfilePortalProof } from '../../../packages/shared/src/shared-business-profile';
let mf:Miniflare,db:D1Database,n=0;
const uuid=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
async function fixture(template=false){
 const workspaceId=uuid(),group=uuid(),grant=uuid(),record=uuid(),sourceId='project-alpha:primary',pid=uuid();
 await db.batch([
 db.prepare("INSERT INTO operations_directory_records(record_id) VALUES(?)").bind(record),
 db.prepare("INSERT INTO native_directory_shared_profiles(id,kind,version,profile_json,membership_json) VALUES(?,'client',1,?,?)").bind(group,JSON.stringify({name:'Business',email:'business@example.test'}),JSON.stringify([record,'sibling'])),
 db.prepare('INSERT INTO native_directory_shared_profile_members(record_id,group_id) VALUES(?,?)').bind(record,group),
 db.prepare("INSERT INTO project_alpha_active_directory_mappings(record_id,source_id,resource_type,project_alpha_public_id,source_instance_id,application_id,history_epoch_id) VALUES(?,?,'client',?,'instance','application','epoch')").bind(record,sourceId,pid),
 db.prepare("INSERT INTO shared_profile_portal_authority_heads VALUES(?,?,1,'active',?,datetime('now'))").bind(workspaceId,sourceId,uuid()),
 db.prepare("INSERT INTO shared_profile_portal_grants(id,workspace_id,source_id,source_instance_id,application_id,history_epoch_id,recipient_mode,issuer,subject,principal_public_id,target_type,target_public_id,record_id,group_id,group_membership_json,revision,state,issued_by) VALUES(?,?,?,'instance','application','epoch',?,?,?,'principal','client',?,?,?,?,1,'active','owner')").bind(grant,workspaceId,sourceId,template?'first_verified_identity':'verified_identity',template?null:'issuer',template?null:'subject',pid,record,group,JSON.stringify([record,'sibling']))]);
 const proof:SharedProfilePortalProof={protocolVersion:1,workspaceId,sourceId,issuer:'issuer',subject:'subject',authorityRevision:1,contextVersion:'a'.repeat(64),verifiedUntil:new Date(Date.now()+30_000).toISOString(),targets:[{principalPublicId:'principal',scopeType:'client',publicId:pid}]};
 return{proof,grant,group,record};
}
beforeAll(async()=>{
 mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-08-06',d1Databases:['DB']});db=await mf.getD1Database('DB');
 await db.exec("CREATE TABLE staff_users(id TEXT PRIMARY KEY); CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY); CREATE TABLE native_directory_shared_profiles(id TEXT PRIMARY KEY,kind TEXT,version INTEGER,profile_json TEXT,membership_json TEXT); CREATE TABLE native_directory_shared_profile_members(record_id TEXT,group_id TEXT); CREATE TABLE project_alpha_active_directory_mappings(record_id TEXT,source_id TEXT,resource_type TEXT,project_alpha_public_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT); INSERT INTO staff_users VALUES('owner')");
 for(const sql of splitD1MigrationStatements(readFileSync(new URL('../migrations/0208_shared_profile_portal_authority.sql',import.meta.url),'utf8')))await db.prepare(sql).run();
});afterAll(async()=>{await mf.dispose();});
describe('portal shared profile exact authority',()=>{
 it('reads only an owner-granted exact source/client and keeps writes unavailable before composer integration',async()=>{
  const f=await fixture(),env={OPS_DB:db};const read=await readSharedProfilePortalProfiles(env,f.proof);expect(read.ok).toBe(true);if(read.ok){expect(read.profiles).toHaveLength(1);expect(read.profiles[0]?.editable).toBe(false);}
  expect(await authorizedSharedProfilePortalGrants(env,{...f.proof,subject:'other'})).toEqual([]);
  expect(await authorizedSharedProfilePortalGrants(env,{...f.proof,targets:[]})).toEqual([]);
 });
 it('rejects stale source epochs and authority revocations',async()=>{
  const f=await fixture(),env={OPS_DB:db};await db.prepare("UPDATE project_alpha_active_directory_mappings SET history_epoch_id='replacement' WHERE record_id=?").bind(f.record).run();expect(await authorizedSharedProfilePortalGrants(env,f.proof)).toEqual([]);
  const g=await fixture();expect(await transitionSharedProfilePortalAuthority(env,{protocolVersion:1,operationId:uuid(),workspaceId:g.proof.workspaceId,sourceId:g.proof.sourceId,expectedRevision:1,revision:2,state:'blocked'})).toEqual({ok:true,revision:2});expect(await authorizedSharedProfilePortalGrants(env,g.proof)).toEqual([]);
 });
 it('rechecks grant/authority in the actual same-transaction mutation fence',async()=>{
  const f=await fixture(),env={OPS_DB:db};const plan=await prepareSharedProfilePortalWrite(env,{...f.proof,grantId:f.grant,expectedVersion:1,mutationId:uuid(),profile:{name:'Updated',email:'business@example.test'}});expect(plan).not.toBeNull();
  await db.prepare("UPDATE shared_profile_portal_grants SET state='revoked',revision=2 WHERE id=?").bind(f.grant).run();await expect(plan!.statement.run()).rejects.toThrow(/shared_profile_portal_authority_changed/);
 });
 it('rejects changed group membership and identity scope without email-based fallback',async()=>{
  const f=await fixture(),env={OPS_DB:db};await db.prepare('UPDATE native_directory_shared_profiles SET membership_json=? WHERE id=?').bind(JSON.stringify([f.record,'replacement']),f.group).run();expect(await authorizedSharedProfilePortalGrants(env,f.proof)).toEqual([]);
  const g=await fixture();expect(await authorizedSharedProfilePortalGrants(env,{...g.proof,targets:[{principalPublicId:'foreign',scopeType:'organization',publicId:g.proof.targets[0]!.publicId}]})).toEqual([]);
 });
 it('accepts an unchanged exact guarded write, then rejects replayed fence mutation',async()=>{
  const f=await fixture(),env={OPS_DB:db};const plan=await prepareSharedProfilePortalWrite(env,{...f.proof,grantId:f.grant,expectedVersion:1,mutationId:uuid(),profile:{name:'Updated',email:'business@example.test'}});expect(plan).not.toBeNull();expect((await plan!.statement.run()).meta.changes).toBe(1);await expect(plan!.statement.run()).rejects.toThrow();
 });
 it('prepares the exact authorized contact change while leaving neutral-descriptor enforcement to the composer',async()=>{const f=await fixture();
  const before=await db.prepare('SELECT count(*) n FROM shared_profile_portal_write_fences').first('n');
  expect(await prepareSharedProfilePortalWrite({OPS_DB:db},{...f.proof,grantId:f.grant,expectedVersion:1,mutationId:uuid(),profile:{name:'Updated',email:'different@example.test'}})).not.toBeNull();
  expect(await prepareSharedProfilePortalWrite({OPS_DB:db},{...f.proof,subject:'foreign',grantId:f.grant,expectedVersion:1,mutationId:uuid(),profile:{name:'Updated',email:'different@example.test'}})).toBeNull();
  expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_write_fences').first('n')).toBe(before);
 });
 it('binds an owner-reviewed principal/client template once to the first verified identity',async()=>{
  const f=await fixture(true),env={OPS_DB:db};expect(await authorizedSharedProfilePortalGrants(env,f.proof)).toEqual([]);
  expect(await bindSharedProfilePortalIdentity(env,{...f.proof,targets:[{...f.proof.targets[0]!,principalPublicId:'wrong'}]})).toEqual({ok:true,bound:0});
  expect(await bindSharedProfilePortalIdentity(env,f.proof)).toEqual({ok:true,bound:1});expect(await bindSharedProfilePortalIdentity(env,f.proof)).toEqual({ok:true,bound:0});
  expect(await authorizedSharedProfilePortalGrants(env,f.proof)).toHaveLength(1);
  expect(await bindSharedProfilePortalIdentity(env,{...f.proof,subject:'replacement'})).toEqual({ok:true,bound:0});expect(await authorizedSharedProfilePortalGrants(env,{...f.proof,subject:'replacement'})).toEqual([]);
 });
 it('does not bind or resurrect a revoked first-login template',async()=>{const f=await fixture(true),env={OPS_DB:db};
  await db.prepare("UPDATE shared_profile_portal_grants SET state='revoked',revision=revision+1 WHERE id=?").bind(f.grant).run();
  expect(await bindSharedProfilePortalIdentity(env,f.proof)).toEqual({ok:true,bound:0});expect(await authorizedSharedProfilePortalGrants(env,f.proof)).toEqual([]);
 });
 it('rejects expired and unbounded proof leases',async()=>{const f=await fixture(true),env={OPS_DB:db};
  expect(await authorizedSharedProfilePortalGrants(env,{...f.proof,verifiedUntil:new Date(Date.now()-1000).toISOString()})).toBeNull();
  expect(await bindSharedProfilePortalIdentity(env,{...f.proof,verifiedUntil:new Date(Date.now()+120_000).toISOString()})).toEqual({ok:false});
 });
 it('keeps business idempotency stable across refreshed proof leases and normalizes field order',async()=>{
  const f=await fixture(),grant=(await authorizedSharedProfilePortalGrants({OPS_DB:db},f.proof))![0]!;
  const input={...f.proof,grantId:f.grant,expectedVersion:1,mutationId:uuid(),profile:{name:'  Updated  ',email:'BUSINESS@example.test'}};
  const initial=await stablePortalRequestFingerprint(input,grant);
  expect(await stablePortalRequestFingerprint({...input,mutationId:uuid(),authorityRevision:2,contextVersion:'b'.repeat(64),verifiedUntil:new Date(Date.now()+40_000).toISOString(),profile:{email:'business@example.test',name:'Updated'}},grant)).toBe(initial);
  expect(await stablePortalRequestFingerprint({...input,profile:{...input.profile,name:'Different'}},grant)).not.toBe(initial);
  expect(await stablePortalRequestFingerprint({...input,subject:'other'},grant)).not.toBe(initial);
 });
});
