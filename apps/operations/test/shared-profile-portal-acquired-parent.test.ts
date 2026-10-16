import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {expect,it} from 'vitest';
import {runCanonicalPortalResourceAcceptance} from './helpers/operations-native-portal-resource-acceptance-fixture';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {sharedProfileCreationFence} from '../src/worker/native-directory-shared-profile-routes';
import {prepareSharedProfilePortalWrite,normalizePortalBusinessProfile} from '../src/worker/shared-profile-portal-authority';
import {writeNativeDirectoryProfile,writeNativeDirectorySharedPortalProfiles,type NativeDirectoryPortalWriterActor,type NativeDirectoryCreateWrite} from '../src/worker/native-directory-profile-writer';
import {dispatchProjectAlphaDirectoryProfileOutboxCommand} from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import type {SharedProfilePortalProof} from '../../../packages/shared/src/shared-business-profile';
it('uses an exact portal organization ACK as acquired parent revision for a nested client create',async()=>{
 await runCanonicalPortalResourceAcceptance(async c=>{
  const db=c.operations,directory=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(directory).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&n.slice(0,4)>='0204'&&n.slice(0,4)<='0209').sort())await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>db.prepare(sql)));
  const mapping=await db.prepare('SELECT external_id,project_alpha_public_id FROM project_alpha_active_directory_mappings WHERE record_id=? AND source_id=?').bind(c.organization,c.sourceId).first<{external_id:string;project_alpha_public_id:string}>();expect(mapping!.external_id).not.toBe(c.organization);
  const profile=JSON.parse((await db.prepare('SELECT profile_json FROM operations_directory_revisions WHERE record_id=? AND version=1').bind(c.organization).first<string>('profile_json'))!);
  const actor={staffId:c.owner.identity.staffId,accessSubject:c.owner.identity.verifiedAccessSubject,admissionVersion:c.owner.admissionVersion,profileVersion:c.owner.identity.profileVersion,loginEmail:c.owner.identity.email,selectedGrantId:'acceptance-native-grant-1',selectedIdentityGrantId:'acceptance-native-grant-2'};
  const groupId=randomUUID(),members=[{recordId:c.organization,kind:'organization' as const,version:1,profile,sourceIds:[c.sourceId],parentRecordId:null,relationshipVersion:null,parentVersion:null}];
  await db.batch([sharedProfileCreationFence(db,{groupId,mutationId:randomUUID(),mode:'single',requestSha256:'a'.repeat(64),actor,kind:'organization',profile,members,previewToken:null}),
   db.prepare("INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,'organization',?,?,?)").bind(groupId,JSON.stringify(profile),JSON.stringify([c.organization]),actor.staffId),
   db.prepare('INSERT INTO native_directory_shared_profile_members(record_id,group_id,initial_version) VALUES(?,?,1)').bind(c.organization,groupId),
   db.prepare('INSERT INTO native_directory_shared_profile_revisions(group_id,version,profile_json) VALUES(?,1,?)').bind(groupId,JSON.stringify(profile))]);
  const workspaceId=randomUUID(),grantId=randomUUID(),principalPublicId='f'.repeat(32);
  await db.batch([db.prepare("INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES(?,?,1,'active',?)").bind(workspaceId,c.sourceId,randomUUID()),
   db.prepare(`INSERT INTO shared_profile_portal_grants(id,workspace_id,source_id,source_instance_id,application_id,history_epoch_id,issuer,subject,principal_public_id,target_type,target_public_id,record_id,group_id,group_membership_json,revision,state,issued_by) VALUES(?,?,?,?,?,?,?,?,?,'organization',?,?,?,?,1,'active',?)`).bind(grantId,workspaceId,c.sourceId,c.sourceInstanceId,c.applicationId,c.historyEpochId,c.issuer,c.subject,principalPublicId,mapping!.project_alpha_public_id,c.organization,groupId,JSON.stringify([c.organization]),actor.staffId)]);
  const proof:SharedProfilePortalProof={protocolVersion:1,workspaceId,sourceId:c.sourceId,issuer:c.issuer,subject:c.subject,authorityRevision:1,contextVersion:'a'.repeat(64),verifiedUntil:new Date(Date.now()+45_000).toISOString(),targets:[{principalPublicId,scopeType:'organization',publicId:mapping!.project_alpha_public_id}]};
  const mutationId=randomUUID(),updated=normalizePortalBusinessProfile({...profile,name:'Portal organization parent update'}),prepared=await prepareSharedProfilePortalWrite({OPS_DB:db},{...proof,grantId,expectedVersion:1,mutationId,profile:updated});expect(prepared).not.toBeNull();
  const portalActor:NativeDirectoryPortalWriterActor={kind:'portal',actorId:`portal:${grantId}`,issuer:c.issuer,subject:c.subject,grantId,grantRevision:1,workspaceId,sourceId:c.sourceId,groupId,groupVersion:1,sharedMutationId:mutationId,authorityRevision:1,contextVersion:proof.contextVersion,verifiedUntil:proof.verifiedUntil};
  const destination={sourceId:c.sourceId,sourceInstanceUUID:c.sourceInstanceId,applicationUUID:c.applicationId,historyEpoch:c.historyEpochId,origin:'https://pa.example.test',externalCanonicalId:mapping!.external_id,expectedAuthorizationGeneration:'9'},memberMutation=randomUUID();
  expect(await writeNativeDirectorySharedPortalProfiles(db,{groupId,mutationId,expectedVersion:1,requestSha256:prepared!.requestSha256,profile:updated,authorityFence:prepared!.statement,writes:[{operation:'update',mutationId:memberMutation,recordId:c.organization,expectedLocalVersion:1,kind:'organization',profile:updated as typeof profile,actor:portalActor,destinations:[destination]}]})).toMatchObject({status:'written'});
  const orgCommand=await db.prepare('SELECT m.command_id FROM operations_directory_materializations m JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.mutation_id=?').bind(memberMutation).first<string>('command_id');
  let nestedId='';const posted:unknown[]=[];
  const send:typeof fetch=async(input,init)=>{
   const path=new URL(String(input)).pathname,requestId=randomUUID(),envelope={sourceInstanceId:c.sourceInstanceId,applicationId:c.applicationId,historyEpoch:c.historyEpochId,requestId};
   const reply=(body:object,status=200)=>new Response(JSON.stringify({...envelope,...body}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}});
   if(path.endsWith('/capabilities'))return reply({apiVersion:'2',grantedCapabilities:['api.capabilities.read','directory.organizations.write','directory.clients.create','directory.clients.organization.assign'].map(name=>({name})),implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},...[['/api/v2/directory/organizations/{publicId}/profile/commands','directory.organizations.write'],['/api/v2/directory/clients/commands','directory.clients.create']].map(([path,requiredCapability])=>({method:'POST',path,requiredCapability,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}))]});
   if(path.endsWith('/profile/commands'))return reply({replayed:false,result:{resource:{type:'organization',publicId:mapping!.project_alpha_public_id,revision:'8'},authorizationGeneration:'9'}});
   if(path==='/api/v2/directory/clients/commands'){const body=JSON.parse(String(init?.body));posted.push(body);return reply({replayed:false,result:{resource:{type:'client',id:nestedId,publicId:'e'.repeat(32),revision:'1'},authorizationGeneration:'10'}},201);}
   throw Error('Unexpected nested parent request '+path);
  };
  const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:c.projectAlphaConnections,SHARED_PROFILE_PORTAL_AUTHORITY:{readAuthority:async()=>({ok:true as const,proof:{...proof,verifiedUntil:new Date(Date.now()+45_000).toISOString()}})}};
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,c.sourceId,orgCommand!,send)).toMatchObject({status:'acknowledged'});
  expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_ack_witnesses WHERE command_id=?').bind(orgCommand).first('n')).toBe(1);
  await db.prepare("UPDATE shared_profile_portal_grants SET state='revoked',revision=revision+1 WHERE id=?").bind(grantId).run();
  nestedId=randomUUID();const clientProfile={name:'New nested client',email:'nested@example.test',phone:'',clientType:'business' as const,addressLine1:'2 Main',addressLine2:'',city:'Austin',state:'TX',postalCode:'78701',country:'US'},scopes=[{businessAreaId:'acceptance-area',divisionId:'acceptance-business-division'}],createAdmissionId=randomUUID();
  const childDestination={...destination,externalCanonicalId:nestedId,expectedAuthorizationGeneration:'9'};
  await db.batch([db.prepare('INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,?,?,?,?,?)').bind(createAdmissionId,actor.staffId,actor.accessSubject,nestedId,'client',JSON.stringify(scopes),JSON.stringify(clientProfile),JSON.stringify([{...childDestination,expectedAuthorizationGeneration:undefined}]),actor.staffId),db.prepare('INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,?,2)').bind(createAdmissionId,nestedId,c.organization)]);
  const write:NativeDirectoryCreateWrite={operation:'create',mutationId:randomUUID(),recordId:nestedId,expectedLocalVersion:0,kind:'client',createAdmissionId,profile:clientProfile,scopes,destinations:[childDestination],actor,relationship:{organizationRecordId:c.organization,expectedRelationshipVersion:0}};
  // Prove the exact old staff-only dependency guard rejects this accepted
  // portal parent, then restore the additive guard and replay the same intent.
  const historical=readFileSync(new URL('0203_effective_native_directory_enrollment_consumers.sql',directory),'utf8');
  const triggerName='operations_directory_intent_relationship_dependencies_insert_guard';
  const from=historical.indexOf('CREATE TRIGGER '+triggerName),terminator="BEGIN SELECT RAISE(ABORT,'directory intent relationship dependency requires live canonical evidence'); END;";
  const oldTrigger=historical.slice(from,historical.indexOf(terminator,from)+terminator.length);
  await db.batch([db.prepare('DROP TRIGGER '+triggerName),db.prepare(oldTrigger)]);
  expect(await writeNativeDirectoryProfile(db,write)).toMatchObject({status:'blocked',reason:'authority_or_atomic_write'});
  expect(await db.prepare('SELECT record_id FROM operations_directory_records WHERE record_id=?').bind(nestedId).first()).toBeNull();
  const additive=readFileSync(new URL('0209_shared_profile_portal_native_writes.sql',directory),'utf8');
  const restoredFrom=additive.indexOf('CREATE TRIGGER '+triggerName),restoredEnd=additive.indexOf(terminator,restoredFrom);
  expect(restoredFrom).toBeGreaterThanOrEqual(0);expect(restoredEnd).toBeGreaterThan(restoredFrom);
  const restoredTrigger=additive.slice(restoredFrom,restoredEnd+terminator.length);
  expect(restoredTrigger).not.toContain('CREATE TABLE');
  await db.batch([db.prepare('DROP TRIGGER '+triggerName),db.prepare(restoredTrigger)]);
  const batchErrors:string[]=[];const diagnosed=new Proxy(db,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{try{return await target.batch(statements);}catch(error){batchErrors.push(String(error));throw error;}};const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;}});
  const created=await writeNativeDirectoryProfile(diagnosed,write);expect(created,JSON.stringify({created,batchErrors})).toMatchObject({status:'written'});if(created.status!=='written')throw Error(JSON.stringify(created));
  const dispatched=await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,c.sourceId,created.commandIds[0]!,send);expect(dispatched,JSON.stringify({dispatched,posted})).toMatchObject({status:'acknowledged'});expect(posted).toHaveLength(1);expect((posted[0] as {organization:unknown}).organization).toEqual({externalId:mapping!.external_id,expectedRevision:'8'});
 },{stopAfterReady:true,operationsThroughMigration:'0203_effective_native_directory_enrollment_consumers.sql'});
},360_000);
