import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {initializeCorrespondenceComposerFixture,disposeCorrespondenceComposerFixture,portalFixture,footprint,diagnosedDatabase,uuid,correspondenceFixtureState} from './helpers/shared-profile-correspondence-fixture';
import {correspondenceLogicalSource as logical,correspondencePrimarySource as primary} from './helpers/central-correspondence-independentreview-fixture';
import {updateSharedPortalProfile} from '../src/worker/shared-profile-portal-composer';
beforeAll(initializeCorrespondenceComposerFixture,300_000);afterAll(disposeCorrespondenceComposerFixture);
describe('shared profile correspondence canonical fanout',()=>{
 it('keeps portal authority physical while writing both logical PA destinations, and denies a revoked bridge',async()=>{
  const {db,correspondence}=correspondenceFixtureState();const f=await portalFixture(true),input={...f.proof,grantId:f.grantId,expectedVersion:1,mutationId:uuid(),profile:{...f.profile,name:'Correspondence update'}};
  const errors:string[]=[];expect(await updateSharedPortalProfile({...f.env,OPS_DB:diagnosedDatabase(db,errors)},input),errors.join('\n')).toMatchObject({ok:true,profiles:[{version:2}]});
  const sources=(await db.prepare("SELECT o.source_id FROM project_alpha_directory_outbox o JOIN operations_directory_effective_materializations m ON m.command_id=o.command_id JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_version=2 AND i.record_id IN(SELECT record_id FROM native_directory_shared_profile_members WHERE group_id=?) ORDER BY o.source_id").bind(f.groupId).all<{source_id:string}>()).results;
  expect(sources.map(r=>r.source_id)).toEqual([logical,'project-alpha:secondary'].sort());
  const before=await footprint(f.groupId);
  const status=await import('../src/worker/portal-directory-correspondence').then(m=>m.previewPortalDirectoryCorrespondence(correspondence.env,logical));
  const manager=await import('../src/worker/portal-directory-correspondence');
  expect(await manager.managePortalDirectoryCorrespondence(correspondence.env,correspondence.actor,logical,{operationId:uuid(),action:'revoke',expectedVersion:status.current!.version,expectedProofSha256:status.current!.revocationProofSha256},correspondence.send)).toMatchObject({ok:true});
  expect(await updateSharedPortalProfile(f.env,{...input,mutationId:uuid()})).toEqual({ok:false,code:'denied'});
  expect(await footprint(f.groupId)).toEqual(before);
 },120_000);
 it('rolls back the portal fence and all profile/outbox writes when the second member fails',async()=>{
  const {db,correspondence}=correspondenceFixtureState();const f=await portalFixture(),before=await footprint(f.groupId),errors:string[]=[];
  const failing=f.records[1]!.input.recordId;
  await db.prepare(`CREATE TRIGGER fail_correspondence_second BEFORE INSERT ON operations_directory_revisions WHEN NEW.record_id='${failing}' AND NEW.version=2 BEGIN SELECT RAISE(ABORT,'correspondence rollback'); END`).run();
  try{expect(await updateSharedPortalProfile({...f.env,OPS_DB:diagnosedDatabase(db,errors)},{...f.proof,grantId:f.grantId,expectedVersion:1,mutationId:uuid(),profile:{...f.profile,phone:'555-0199'}})).toEqual({ok:false,code:'unavailable'});}
  finally{await db.prepare('DROP TRIGGER fail_correspondence_second').run();}
  expect(errors.join('\n')).toContain('correspondence rollback');expect(await footprint(f.groupId)).toEqual(before);
 },120_000);
 it('fails atomically when the primary connector changes after the read proof and before the write batch',async()=>{
  const {db,correspondence}=correspondenceFixtureState();const f=await portalFixture(),before=await footprint(f.groupId),count=await db.prepare('SELECT count(*) n FROM project_alpha_directory_outbox').first('n');
  let changed=false;const wrap=(value:any):any=>new Proxy(value,{get(target,key){
   if(key==='withSession')return (...args:unknown[])=>wrap(target.withSession(...args));
   if(key==='batch')return async(statements:D1PreparedStatement[])=>{
    if(!changed){changed=true;await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id=?").bind(primary).run();}
    return target.batch(statements);
   };
   const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});const raced=wrap(db) as D1Database;
  try{expect(await updateSharedPortalProfile({...f.env,OPS_DB:raced},{...f.proof,grantId:f.grantId,expectedVersion:1,mutationId:uuid(),profile:{...f.profile,phone:'555-0120'}})).toEqual({ok:false,code:'unavailable'});}
  finally{await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=?").bind(primary).run();}
  expect(changed).toBe(true);expect(await footprint(f.groupId)).toEqual(before);
  expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_outbox').first('n')).toBe(count);
 },120_000);

});
