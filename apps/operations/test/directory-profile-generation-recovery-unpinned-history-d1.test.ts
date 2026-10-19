import {readFileSync,readdirSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Miniflare} from 'miniflare';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {writeNativeDirectoryProfile} from '../src/worker/native-directory-profile-writer';
import {readAuthorizedDirectoryProfileUpdateReservation} from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import {profileGenerationRecoverySchema,recoverDirectoryProfileGeneration} from '../src/worker/project-alpha-directory-profile-generation-recovery';

let runtime:Miniflare,db:D1Database;
const sourceId='project-alpha:primary',source='11111111-1111-4111-8111-111111111111';
const application='22222222-2222-4222-8222-222222222222',epoch='33333333-3333-4333-8333-333333333333';
const origin='https://pa.example.test',recordId='legacy-pre65-company',publicId='a'.repeat(32);
const createId='44444444-4444-4444-8444-444444444444',updateId='55555555-5555-4555-8555-555555555555';
const actor={staffId:'owner',accessSubject:'access|owner',admissionVersion:1,profileVersion:1,
 loginEmail:'owner@example.test',selectedGrantId:'edit-owner',selectedIdentityGrantId:'identity-owner'};
const profile={name:'Pre-epoch company',generalEmail:'legacy@example.test',generalPhone:'920-555-0100',
 addressLine1:'',addressLine2:'',city:'',state:'',postalCode:'',country:'US'};
const updated={...profile,name:'Pre-epoch updated company'};
const scopes=JSON.stringify([{businessAreaId:'area',divisionId:null}]);
const legacyDestination={sourceId,sourceInstanceUUID:source,applicationUUID:application,origin,externalCanonicalId:recordId};
const destinations=JSON.stringify([legacyDestination]);
const tables=['operations_directory_records','operations_directory_revisions','operations_directory_audit',
 'operations_directory_intents','operations_directory_materializations','project_alpha_directory_outbox',
 'project_alpha_directory_mappings','native_directory_enrollments']as const;
type Rows=Record<string,unknown>[];
let retained:Record<string,Rows>;
async function history():Promise<Record<string,Rows>>{
 const rows=await db.batch< Record<string,unknown>>(tables.map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY 1`)));
 return Object.fromEntries(tables.map((table,index)=>[table,rows[index]!.results]));
}
function oldColumns(current:Record<string,Rows>){
 return Object.fromEntries(tables.map(table=>[table,current[table]!.map((row,index)=>
  Object.fromEntries(Object.keys(retained[table]![index]!).map(key=>[key,row[key]])))]));
}
// This exercises the committed pre0065 SQL contract, not a historical HTTP
// writer or real PA ACK. Every admission/fence/consumption trigger stays enabled.
async function legacyWrite(operation:'create'|'update'){
 const create=operation==='create',version=create?1:2,mutation=create?'legacy-create':'legacy-update';
 const commandId=create?createId:updateId,fields=create?profile:updated;
 const command={operation,commandId,resourceType:'organization',externalId:recordId,
  ...(create?{}:{expectedProjectAlphaPublicId:publicId}),expectedRevision:create?'0':'1',
  expectedAuthorizationGeneration:create?'0':'1',fields,...(create?{scopes:JSON.parse(scopes)}:{})};
 const admission='legacy-admission',profileJson=JSON.stringify(fields),commandJson=JSON.stringify(command);
 const statements:D1PreparedStatement[]=[];
 if(create)statements.push(db.prepare(`INSERT INTO native_directory_create_admissions
  (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
  VALUES(?,'owner','access|owner',?,'organization',?,?,?,'owner')`).bind(admission,recordId,scopes,profileJson,destinations));
 statements.push(db.prepare(`INSERT INTO operations_directory_write_fences(mutation_id,operation_kind,actor_id,bound_access_subject,
  permission,record_id,record_kind,expected_version,create_admission_id,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes)
  VALUES(?,?,'owner','access|owner','directory.profile.edit',?,'organization',?,?,'edit-owner',?,?,?,?,1)`)
  .bind(mutation,operation,recordId,version-1,create?admission:null,scopes,profileJson,commandJson,destinations));
 statements.push(create?db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version)VALUES(?,'organization',1)").bind(recordId)
  :db.prepare('UPDATE operations_directory_records SET current_version=2 WHERE record_id=? AND current_version=1').bind(recordId));
 statements.push(db.prepare('INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json)VALUES(?,?,?,?)').bind(recordId,version,mutation,profileJson),
  db.prepare(`INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json)
   VALUES(?,?,?,?,'staff','owner',?)`).bind(mutation+':audit',mutation,recordId,version,commandJson),
  db.prepare(`INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,
   application_uuid,destination_origin,external_canonical_id,desired_payload_json,predecessor_intent_id,state)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,'waiting')`).bind(mutation+':intent',mutation,recordId,version,sourceId,source,application,origin,recordId,profileJson,create?null:'legacy-create:intent'),
  db.prepare("UPDATE operations_directory_intents SET state='ready'WHERE intent_id=? AND state='waiting'").bind(mutation+':intent'),
  db.prepare(`INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,disposition_json,next_attempt_at)
   VALUES(?,?,?,?,?,0)`).bind(mutation+':intent',commandId,commandJson,JSON.stringify({actorId:'owner',authorityRevision:String(version)}),
   JSON.stringify({kind:create?'authorized_create':'existing',...legacyDestination,...(create?{}:{projectAlphaPublicId:publicId,projectAlphaRevision:'1'})})),
  db.prepare('DELETE FROM operations_directory_write_fences WHERE mutation_id=?').bind(mutation));
 await db.batch(statements);
}
beforeAll(async()=>{
 runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default{fetch(){return new Response('ok')}}",d1Databases:['OPS_DB']});
 db=await runtime.getD1Database('OPS_DB')as D1Database;
 const directory=new URL('../migrations/',import.meta.url),names=readdirSync(directory).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n.slice(0,4)<='0220').sort();
 const migrate=async(names:string[])=>{for(const n of names)await db.batch(splitD1MigrationStatements(readFileSync(new URL(n,directory),'utf8')).map(sql=>db.prepare(sql)));};
 await migrate(names.filter(n=>n.slice(0,4)<='0064'));
 await db.batch([
  db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status)VALUES('owner','owner@example.test','Owner','access|owner','active')"),
  db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)VALUES('owner','access|owner',1,'owner')"),
  db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name)VALUES('owner','owner@example.test','Owner')"),
  db.prepare("INSERT INTO native_business_areas(id,name,active)VALUES('area','Area',1)"),
  ...['edit','identity'].map((name,index)=>db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by)
   VALUES(?,'owner',?,'allow','global','owner')`).bind(name+'-owner',index?'directory.identity.link':'directory.profile.edit')),
 ]);
 await legacyWrite('create');
 // Modeled old ACK/mapping satisfies the real predecessor materialization
 // contract. It supplies no epoch and is never claimed as live PA evidence.
 await db.batch([
  db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',lease_token='legacy',lease_expires_at=9999999999999 WHERE command_id=?").bind(createId),
  db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,command_id)
   VALUES(?,'organization',?,?,?,?,?)`).bind(sourceId,recordId,publicId,source,application,createId),
  db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?")
   .bind(JSON.stringify({status:'acknowledged',response:{result:{data:{publicId},resource:{revision:'1'}}}}),createId),
  db.prepare("UPDATE operations_directory_intents SET state='acknowledged'WHERE intent_id='legacy-create:intent'"),
 ]);
 await legacyWrite('update');
 await db.prepare("UPDATE project_alpha_directory_outbox SET state='terminal',outcome_json=? WHERE command_id=?").bind(JSON.stringify({status:'rejected',httpStatus:409}),updateId).run();
 retained=await history();
 expect(retained.native_directory_enrollments![0]!.destinations_json).toBe(destinations);
 expect(JSON.parse(destinations)[0]).not.toHaveProperty('historyEpoch');
 await migrate(names.filter(n=>n.slice(0,4)>='0065'));
},240_000);
afterAll(async()=>{vi.unstubAllGlobals();await runtime?.dispose();});
describe('honest retained pre0065 unpinned directory history',()=>{
 it('preserves five-field enrollment and refuses to invent epoch authority for normal writes or recovery',async()=>{
  expect(oldColumns(await history())).toEqual(retained);
  expect(await db.prepare('SELECT destinations_json,enrollment_kind FROM effective_native_directory_enrollments WHERE record_id=?').bind(recordId).first())
   .toEqual({destinations_json:destinations,enrollment_kind:'native_create'});
  for(const[table,column]of[['operations_directory_intents','expected_history_epoch_id'],['operations_directory_materializations','history_epoch_id'],
   ['project_alpha_directory_outbox','expected_history_epoch_id'],['project_alpha_directory_mappings','history_epoch_id']]){
   expect((await db.prepare(`SELECT ${column} epoch FROM ${table}`).all<{epoch:string|null}>()).results.every(r=>r.epoch===null)).toBe(true);
   await expect(db.prepare(`UPDATE ${table} SET ${column}=?`).bind(epoch).run()).rejects.toThrow(/immutable/);
  }
  await expect(db.prepare('UPDATE native_directory_enrollments SET destinations_json=? WHERE record_id=?')
   .bind(JSON.stringify([{...legacyDestination,historyEpoch:epoch}]),recordId).run()).rejects.toThrow(/immutable/);
  await expect(db.prepare('DELETE FROM native_directory_enrollments WHERE record_id=?').bind(recordId).run()).rejects.toThrow(/durable/);
  const send=vi.fn<typeof fetch>(async()=>{throw Error('Unpinned legacy history must not reach network');});vi.stubGlobal('fetch',send);
  const env={OPS_DB:db,NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true',PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{
   sourceId,enabled:true,baseUrl:origin,apiKey:'local-test-key',sourceInstanceId:source,applicationId:application,historyEpoch:epoch}}})};
  expect(await profileGenerationRecoverySchema(db)).toBe(true);
  expect(await writeNativeDirectoryProfile(db,{operation:'update',kind:'organization',recordId,mutationId:'66666666-6666-4666-8666-666666666666',
   expectedLocalVersion:2,actor,profile:updated,destinations:[{...legacyDestination,historyEpoch:epoch,expectedAuthorizationGeneration:'1'}]}))
   .toEqual({status:'blocked',reason:'enrollment_drift'});
  expect(await readAuthorizedDirectoryProfileUpdateReservation(env,sourceId,updateId)).toBeNull();
  expect(await recoverDirectoryProfileGeneration(env,sourceId,updateId,send)).toEqual({status:'blocked',reason:'authority'});
  expect(send).not.toHaveBeenCalled();
  expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_profile_generation_recoveries').first('n')).toBe(0);
  expect(await db.prepare('SELECT count(*) n FROM operations_directory_write_fences').first('n')).toBe(0);
  expect(oldColumns(await history())).toEqual(retained);
  expect(await db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id=?').bind(updateId).first('state')).toBe('terminal');
 },120_000);
});
