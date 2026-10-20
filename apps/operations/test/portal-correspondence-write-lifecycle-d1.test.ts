import {beforeAll,afterAll,expect,it} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {initializeCorrespondenceComposerFixture,disposeCorrespondenceComposerFixture,portalFixture,footprint,diagnosedDatabase,uuid,correspondenceFixtureState} from './helpers/shared-profile-correspondence-fixture';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {updateSharedPortalProfile} from '../src/worker/shared-profile-portal-composer';
import {stagePrimaryDeliveryAuthority,synchronizePrimaryDeliveryAuthority} from '../src/worker/project-alpha-primary-delivery-authority';
import {managePortalDirectoryCorrespondence,previewPortalDirectoryCorrespondence} from '../src/worker/portal-directory-correspondence';
const primary='project-alpha:primary',logical='project-alpha:staging',migration='0221_portal_correspondence_lifecycle_write_guards.sql';
const directory=new URL('../migrations/',import.meta.url);
async function apply(name:string){const {db}=correspondenceFixtureState();await db.batch([...splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>db.prepare(sql)),db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);}
beforeAll(async()=>{await initializeCorrespondenceComposerFixture();for(const name of readdirSync(directory).filter(n=>n>='0213_'&&n<migration).sort())await apply(name);},300_000);
afterAll(disposeCorrespondenceComposerFixture);
async function transition(state:'active'|'suspended'){
 const {db,correspondence}=correspondenceFixtureState();const old=(await db.prepare('SELECT version,active_revision,state FROM pa_connectors WHERE source_id=?').bind(primary).first<{version:number;active_revision:number;state:'active'|'suspended'}>())!;
 const current={kind:'primary_connector' as const,sourceId:primary as 'project-alpha:primary',mode:'registry' as const,connectorRevision:old.active_revision,connectorVersion:old.version};
 await stagePrimaryDeliveryAuthority(correspondence.client,current,old.state);await stagePrimaryDeliveryAuthority(correspondence.client,{...current,connectorVersion:old.version+1},state);
 await db.prepare('UPDATE pa_connectors SET state=?,version=version+1 WHERE source_id=?').bind(state,primary).run();
}
it('upgrades the actual220 write pipeline without reapproval: old exact counters roll back;221 commits original mutation and both PA outboxes',async()=>{
 const {db}=correspondenceFixtureState(),f=await portalFixture(true),before=await footprint(f.groupId),grant=await db.prepare('SELECT * FROM shared_profile_portal_grants WHERE id=?').bind(f.grantId).first();
 const approval=await db.prepare("SELECT sql FROM sqlite_master WHERE name='portal_directory_correspondence_revision_proof'").first('sql');
 const schema=(await db.prepare('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all<{name:string;sql:string}>()).results;
 await transition('suspended');await transition('active');
 const input={...f.proof,verifiedUntil:new Date(Date.now()+45_000).toISOString(),grantId:f.grantId,expectedVersion:1,mutationId:uuid(),profile:{...f.profile,phone:'920-555-0148'}};
 const errors:string[]=[];expect(await updateSharedPortalProfile({...f.env,OPS_DB:diagnosedDatabase(db,errors)},input)).toEqual({ok:false,code:'unavailable'});
 expect(errors.join('\n')).toContain('shared_profile_portal_authority_changed');expect(await footprint(f.groupId)).toEqual(before);
 await apply(migration);
 const after=(await db.prepare('SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name').all<{name:string;sql:string}>()).results;
 expect(after.filter((row,index)=>row.sql!==schema[index]!.sql).map(row=>row.name)).toEqual(['native_directory_shared_portal_command_authority','operations_directory_live_portal_write_fences','shared_profile_portal_write_fence_guard']);
 expect(await db.prepare("SELECT sql FROM sqlite_master WHERE name='portal_directory_correspondence_revision_proof'").first('sql')).toEqual(approval);
 input.verifiedUntil=new Date(Date.now()+45_000).toISOString();
 expect(await updateSharedPortalProfile(f.env,input)).toMatchObject({ok:true,profiles:[{version:2,profile:{phone:'920-555-0148'}}]});
 expect(await db.prepare('SELECT * FROM shared_profile_portal_grants WHERE id=?').bind(f.grantId).first()).toEqual(grant);
 expect(await db.prepare('SELECT mutation_id FROM native_directory_shared_profile_commands WHERE mutation_id=?').bind(input.mutationId).first('mutation_id')).toBe(input.mutationId);
 expect(await db.prepare('SELECT mutation_id FROM shared_profile_portal_write_fences WHERE mutation_id=?').bind(input.mutationId).first('mutation_id')).toBe(input.mutationId);
 const sources=(await db.prepare("SELECT o.source_id FROM project_alpha_directory_outbox o JOIN operations_directory_effective_materializations m ON m.command_id=o.command_id JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_version=2 AND i.record_id=? ORDER BY o.source_id").bind(f.records[0]!.input.recordId).all<{source_id:string}>()).results;
 expect(sources.map(x=>x.source_id)).toEqual([logical,'project-alpha:secondary'].sort());
 expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},120_000);
function race(db:D1Database,change:()=>Promise<void>):D1Database{
 let changed=false;const wrap=(value:any):any=>new Proxy(value,{get(target,key){
  if(key==='withSession')return(...args:unknown[])=>wrap(target.withSession(...args));
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!changed){changed=true;await change();}return target.batch(statements);};
  const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }});return wrap(db);
}
it('retains atomic key, revision, grant, revoked bridge and suspended-source denials after migration',async()=>{
 const {db,correspondence}=correspondenceFixtureState();
 for(const scenario of ['grant','bridge','state','revision','key']){
  const f=await portalFixture(true),before=await footprint(f.groupId),errors:string[]=[];let changed=false;
  const change=async()=>{changed=true;if(scenario==='grant')await db.prepare("UPDATE shared_profile_portal_grants SET revision=revision+1,state='revoked' WHERE id=?").bind(f.grantId).run();
   else if(scenario==='bridge'){const status=await previewPortalDirectoryCorrespondence(f.env,logical);expect(await managePortalDirectoryCorrespondence(f.env,correspondence.actor,logical,{operationId:uuid(),action:'revoke',expectedVersion:status.current!.version,expectedProofSha256:status.current!.revocationProofSha256},correspondence.send)).toMatchObject({ok:true});}
   else if(scenario==='state')await transition('suspended');
   else {
    const current=(await db.prepare('SELECT active_revision FROM pa_connectors WHERE source_id=?').bind(primary).first<number>('active_revision'))!;
    const oldKey=(await db.prepare('SELECT current_key_fingerprint FROM pa_connector_revisions WHERE source_id=? AND revision=?').bind(primary,current).first<string>('current_key_fingerprint'))!,key=scenario==='key'?'f'.repeat(64):oldKey;
    if(scenario==='key')await db.prepare("INSERT INTO pa_connector_signing_keys(fingerprint,source_id,algorithm) VALUES(?,?,'ed25519')").bind(key,primary).run();
    await db.batch([db.prepare(`INSERT INTO pa_connector_revisions(source_id,revision,credential_ref,snapshot_base_path,access_issuer,access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
      SELECT source_id,revision+1,credential_ref,snapshot_base_path,access_issuer,access_audience,access_subject,?, ?,created_by FROM pa_connector_revisions WHERE source_id=? AND revision=?`).bind(`key-${current+1}`,key,primary,current),db.prepare('UPDATE pa_connectors SET active_revision=active_revision+1,version=version+1 WHERE source_id=?').bind(primary)]);
   }};
  expect(await updateSharedPortalProfile({...f.env,OPS_DB:diagnosedDatabase(race(db,change),errors)},{...f.proof,verifiedUntil:new Date(Date.now()+45_000).toISOString(),grantId:f.grantId,expectedVersion:1,mutationId:uuid(),profile:{...f.profile,phone:'920-555-0148'}})).toEqual({ok:false,code:'unavailable'});
  expect(changed,scenario).toBe(true);expect(errors.join('\n'),scenario).toContain('shared_profile_portal_authority_changed');
  expect(await footprint(f.groupId)).toEqual(before);if(scenario==='state')await transition('active');
  if(scenario==='revision'||scenario==='key'){const c=(await db.prepare('SELECT active_revision,version FROM pa_connectors WHERE source_id=?').bind(primary).first<{active_revision:number;version:number}>())!;await synchronizePrimaryDeliveryAuthority(correspondence.client,{kind:'primary_connector',sourceId:primary,mode:'registry',connectorRevision:c.active_revision,connectorVersion:c.version});}
 }
},120_000);
it('keeps below-floor and hidden-primary registry observations impossible, and all three SQL floors explicit',async()=>{
 const {db}=correspondenceFixtureState();const current=await db.prepare('SELECT version FROM pa_connectors WHERE source_id=?').bind(primary).first<number>('version');
 await expect(db.prepare('UPDATE pa_connectors SET version=? WHERE source_id=?').bind(current!-1,primary).run()).rejects.toThrow();
 await expect(db.prepare('UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id=?').bind(primary).run()).rejects.toThrow();
 const rows=(await db.prepare("SELECT sql FROM sqlite_master WHERE name IN('shared_profile_portal_write_fence_guard','operations_directory_live_portal_write_fences','native_directory_shared_portal_command_authority')").all<{sql:string}>()).results;
 expect(rows).toHaveLength(3);for(const row of rows){expect(row.sql).toContain("connector.version>=json_extract(revision.proof_json,'$.connectorVersion')");expect(row.sql).toContain("connector.read_visible=1");expect(row.sql).toContain("connector.active_revision=json_extract(revision.proof_json,'$.connectorRevision')");expect(row.sql).toContain("signing.current_key_fingerprint=json_extract(revision.proof_json,'$.currentKeyFingerprint')");}
});
