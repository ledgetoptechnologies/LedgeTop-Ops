import {enqueueNativeDirectoryCreateObservations} from '../src/worker/native-directory-create-observations';
import {captureImportQueries,checkImportQueryDepth} from './helpers/native-import-query-depth';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {initializeCorrespondenceComposerFixture,disposeCorrespondenceComposerFixture,portalFixture,uuid,correspondenceFixtureState} from './helpers/shared-profile-correspondence-fixture';
import {correspondenceLogicalSource as logical,correspondencePrimarySource as primary} from './helpers/central-correspondence-independentreview-fixture';
import {updateSharedPortalProfile} from '../src/worker/shared-profile-portal-composer';
import {dispatchProjectAlphaDirectoryProfileOutboxCommand} from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import {drainNativeDirectoryOutboxes} from '../src/worker/native-directory-outbox-scheduler';
import {PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT} from '../src/worker/project-alpha-directory-profile-api-v2';
import {managePortalDirectoryCorrespondence,previewPortalDirectoryCorrespondence} from '../src/worker/portal-directory-correspondence';
beforeAll(initializeCorrespondenceComposerFixture,300_000);afterAll(disposeCorrespondenceComposerFixture);
async function pending(){
 const f=await portalFixture(true),{db,correspondence}=correspondenceFixtureState();
 expect(await updateSharedPortalProfile(f.env,{...f.proof,grantId:f.grantId,expectedVersion:1,mutationId:uuid(),profile:{...f.profile,phone:'555-0148'}})).toMatchObject({ok:true});
 const commands=(await db.prepare(`SELECT o.command_id,o.source_id FROM project_alpha_directory_outbox o JOIN operations_directory_materializations m ON m.command_id=o.command_id JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=? AND i.record_version=2 ORDER BY o.source_id`).bind(f.records[0]!.input.recordId).all<{command_id:string;source_id:string}>()).results;expect(commands).toHaveLength(2);
 const configured={...f.env,SHARED_PROFILE_PORTAL_AUTHORITY:{readAuthority:vi.fn(async()=>({ok:true as const,proof:{...f.proof,contextVersion:'b'.repeat(64),verifiedUntil:new Date(Date.now()+45_000).toISOString()}}))}};
 const connections=JSON.parse(f.env.PROJECT_ALPHA_API_V2_CONNECTIONS!).instances,posts:string[]=[];let probe:(()=>Promise<void>)|undefined,post:(()=>Promise<void>)|undefined;
 const send=vi.fn<typeof fetch>(async(input,init)=>{const u=new URL(String(input)),source=Object.keys(connections).find(s=>new URL(connections[s].baseUrl).origin===u.origin)!,c=connections[source],requestId=uuid();const identity={sourceInstanceId:c.sourceInstanceId,applicationId:c.applicationId,historyEpoch:c.historyEpoch,requestId};const reply=(x:unknown)=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}});
  if(u.pathname.endsWith('/capabilities')){if(probe)await probe();return reply({...identity,apiVersion:'2',grantedCapabilities:[{name:'api.capabilities.read'},{name:'directory.clients.write'}],implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT]});}
  posts.push(source);if(post)await post();expect(init?.method).toBe('POST');return reply({...identity,replayed:false,result:{resource:{type:'client',publicId:u.pathname.split('/')[5],revision:'2'},authorizationGeneration:'1'}});
 });
 const revoke=async()=>{const s=await previewPortalDirectoryCorrespondence(correspondence.env,logical);expect(await managePortalDirectoryCorrespondence(correspondence.env,correspondence.actor,logical,{operationId:uuid(),action:'revoke',expectedVersion:s.current!.version,expectedProofSha256:s.current!.revocationProofSha256},correspondence.send)).toMatchObject({ok:true});};
 return{...f,db,configured,commands,send,posts,revoke,setProbe:(x:()=>Promise<void>)=>{probe=x;},setPost:(x:()=>Promise<void>)=>{post=x;}};
}
it('dispatches both logical PA destinations under the exact approved physical-primary portal grant',async()=>{
 const f=await pending();expect(await f.db.prepare('SELECT source_id,directory_source_id FROM shared_profile_portal_grants WHERE id=?').bind(f.grantId).first()).toEqual({source_id:primary,directory_source_id:logical});
 // The preceding fixture creates legitimately enqueue independent metadata jobs.
 // Put only those jobs into a valid future retry state so this test exercises
 // the two profile commands rather than an unrelated inventory transport mock.
 await enqueueNativeDirectoryCreateObservations(f.db,[logical,'project-alpha:secondary']);
 const creates=f.records.flatMap(r=>r.outcome.status==='written'?r.outcome.commandIds:[]);expect(creates).toHaveLength(2);
 const schedulerNow=Date.now();await f.db.prepare('UPDATE native_directory_create_observation_dispatch SET next_attempt_at=? WHERE command_id IN(?,?)').bind(schedulerNow+600_000,...creates).run();
 const due=(await f.db.prepare(`SELECT 'profile' queue_kind,command_id FROM project_alpha_directory_outbox WHERE state='pending' AND next_attempt_at<=? UNION ALL SELECT 'create_observation',command_id FROM native_directory_create_observation_dispatch WHERE state='pending' AND next_attempt_at<=?`).bind(schedulerNow,schedulerNow).all<{queue_kind:string;command_id:string}>()).results;
 expect(due).toHaveLength(2);expect(due.every(r=>r.queue_kind==='profile')).toBe(true);expect(due.map(r=>r.command_id).sort()).toEqual(f.commands.map(c=>c.command_id).sort());
 const captured=captureImportQueries(f.db);const result=await drainNativeDirectoryOutboxes({...f.configured,OPS_DB:captured.database,NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true'},{maxCommands:2,rotationTime:0,now:()=>schedulerNow,send:f.send});expect(result,JSON.stringify({posts:f.posts,result,due})).toMatchObject({status:'drained',attempted:2,acknowledged:2,failed:0});
 expect(f.posts.sort()).toEqual([logical,'project-alpha:secondary'].sort());expect(captured.queries.length).toBeGreaterThan(10);expect(checkImportQueryDepth(captured.queries)).toMatchObject({failures:[]});
},120_000);
it('denies physical namespace substitution and stale correspondence before claiming',async()=>{
 const f=await pending(),c=f.commands.find(c=>c.source_id===logical)!;expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configured,primary,c.command_id,f.send)).toEqual({status:'conflict',reason:'source'});const altered=JSON.parse(f.configured.PROJECT_ALPHA_API_V2_CONNECTIONS!);altered.instances[logical].applicationId=uuid();const secondary=f.commands.find(c=>c.source_id!==logical)!;
 expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand({...f.configured,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify(altered)},secondary.source_id,secondary.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});await f.revoke();
 for(const c of f.commands)expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configured,c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});expect(f.send).not.toHaveBeenCalled();expect(await f.db.prepare('SELECT attempts FROM project_alpha_directory_outbox WHERE command_id=?').bind(c.command_id).first('attempts')).toBe(0);
},120_000);
it('rechecks correspondence after capability awaits and before the PA POST',async()=>{
 const f=await pending(),c=f.commands[0]!;f.setProbe(f.revoke);expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configured,c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});expect(f.posts).toHaveLength(0);
},120_000);

it('denies acknowledgement after correspondence is revoked during the PA POST',async()=>{
 const f=await pending(),c=f.commands[0]!;f.setPost(f.revoke);expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configured,c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});expect(f.posts).toHaveLength(1);expect(await f.db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id=?').bind(c.command_id).first('state')).not.toBe('acknowledged');
},120_000);

it('rejects an expired live authority proof before claiming or sending a portal command',async()=>{
 const f=await pending(),c=f.commands[0]!;f.configured.SHARED_PROFILE_PORTAL_AUTHORITY.readAuthority.mockResolvedValue({ok:true,proof:{...f.proof,contextVersion:'b'.repeat(64),verifiedUntil:new Date(Date.now()-1000).toISOString()}});
 expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configured,c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});
 expect(f.send).not.toHaveBeenCalled();expect(await f.db.prepare('SELECT attempts FROM project_alpha_directory_outbox WHERE command_id=?').bind(c.command_id).first('attempts')).toBe(0);
},120_000);
