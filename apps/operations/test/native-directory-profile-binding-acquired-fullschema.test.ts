import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runCanonicalPortalResourceAcceptance } from './helpers/operations-native-portal-resource-acceptance-fixture';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { writeNativeDirectoryProfile } from '../src/worker/native-directory-profile-writer';
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import { dispatchNativeDirectoryProfileBindingContinuation } from '../src/worker/native-directory-profile-binding-continuation';

it('continues a genuinely acquired mapping with distinct native and external IDs through canonical 0203', async()=>{
  await runCanonicalPortalResourceAcceptance(async c=>{
    const db=c.operations;
    for(const name of ['0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql',
      '0198_native_directory_active_binding_revision_refresh.sql','0199_native_directory_profile_binding_continuations.sql']){
      await db.batch([...splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(sql=>db.prepare(sql)),
        db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);
    }
    const mapping=await db.prepare(`SELECT external_id,project_alpha_public_id public_id,mapping_kind,provenance_id
      FROM project_alpha_active_directory_mappings WHERE record_id=? AND source_id=?`).bind(c.organization,c.sourceId)
      .first<{external_id:string;public_id:string;mapping_kind:string;provenance_id:string}>();
    expect(mapping?.mapping_kind).toBe('acquired');expect(mapping?.external_id).not.toBe(c.organization);
    if(!mapping)throw Error('genuine activation missing');
    const current=await db.prepare('SELECT current_version FROM operations_directory_records WHERE record_id=?').bind(c.organization).first<number>('current_version');
    const profile=JSON.parse((await db.prepare('SELECT profile_json FROM operations_directory_revisions WHERE record_id=? AND version=?')
      .bind(c.organization,current).first<string>('profile_json'))!);
    const activation=await db.prepare(`SELECT project_alpha_revision FROM project_alpha_existing_directory_binding_activation_receipts
      WHERE activation_id=?`).bind(mapping.provenance_id).first<{project_alpha_revision:string}>();
    expect(activation?.project_alpha_revision).toBe('7');
    const env={OPS_DB:db,ENVIRONMENT:'local',NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED:'true',
      PROJECT_ALPHA_API_V2_CONNECTIONS:c.projectAlphaConnections};
    const destination={sourceId:c.sourceId,sourceInstanceUUID:c.sourceInstanceId,applicationUUID:c.applicationId,
      historyEpoch:c.historyEpochId,origin:'https://pa.example.test',externalCanonicalId:mapping.external_id,expectedAuthorizationGeneration:'9'};
    const written=await writeNativeDirectoryProfile(db,{operation:'update',mutationId:randomUUID(),recordId:c.organization,
      expectedLocalVersion:current!,kind:'organization',profile:{...profile,name:'Acquired continuation update'},destinations:[destination],
      actor:{staffId:c.owner.identity.staffId,accessSubject:c.owner.identity.verifiedAccessSubject,admissionVersion:c.owner.admissionVersion,
        profileVersion:c.owner.identity.profileVersion,loginEmail:c.owner.identity.email,selectedGrantId:'acceptance-native-grant-1',
        selectedIdentityGrantId:'acceptance-native-grant-2'}});
    expect(written).toMatchObject({status:'written'});if(written.status!=='written')throw Error(JSON.stringify(written));
    let generation='9',bindingRevision='7',posts=0;const requests:string[]=[];
    const send:typeof fetch=async(input,init)=>{
      const path=new URL(String(input)).pathname,requestId=randomUUID();
      requests.push(path);
      const envelope={sourceInstanceId:c.sourceInstanceId,applicationId:c.applicationId,historyEpoch:c.historyEpochId,requestId};
      const reply=(body:unknown)=>new Response(JSON.stringify({...envelope,...body as object}),{headers:{'Content-Type':'application/json',
        'Cache-Control':'no-store','X-Request-ID':requestId}});
      if(path==='/api/v2/capabilities'){
        const endpoints=[['POST','/api/v2/directory/organizations/{publicId}/profile/commands','directory.organizations.write'],
          ['GET','/api/v2/directory/inventory','directory.inventory.read'],
          ['POST','/api/v2/directory/organizations/bindings/revisions/commands','directory.organizations.binding.revision.refresh']];
        return reply({apiVersion:'2',grantedCapabilities:['api.capabilities.read',...endpoints.map(x=>x[2])].map(name=>({name})),
          implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},
            ...endpoints.map(([method,path,requiredCapability])=>({method,path,requiredCapability,requiresSourceInstanceId:true,
              requiresApplicationId:true,requiresHistoryEpoch:true}))]});
      }
      if(path.endsWith('/profile/commands'))return reply({replayed:false,result:{resource:{type:'organization',publicId:mapping.public_id,revision:'8'},authorizationGeneration:'9'}});
      if(path==='/api/v2/directory/inventory')return reply({authorizationGeneration:generation,resources:[{type:'organization',publicId:mapping.public_id,
        revision:'8',present:true,lastAction:'upsert',projectionSha256:'b'.repeat(64),binding:{status:'active',externalId:mapping.external_id,resourceRevision:bindingRevision}}],nextCursor:null});
      if(path.endsWith('/bindings/revisions/commands')){
        posts++;const command=JSON.parse(String(init?.body));expect(command.externalId).toBe(mapping.external_id);
        generation='10';bindingRevision='8';return reply({replayed:false,result:{resource:{type:'organization',id:mapping.external_id,revision:'8'},
          binding:{publicId:mapping.public_id,previousRevision:'7',authorizationGeneration:generation}}});
      }
      throw Error(`Unexpected acquired-fixture HTTP ${path}`);
    };
    const commandId=written.commandIds[0]!;
    expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,c.sourceId,commandId,send)).toMatchObject({status:'acknowledged'});
    expect(await db.prepare('SELECT external_id,record_id,mapping_kind FROM native_directory_profile_binding_jobs WHERE command_id=?')
      .bind(commandId).first()).toEqual({external_id:mapping.external_id,record_id:c.organization,mapping_kind:'acquired'});
    const continued=await dispatchNativeDirectoryProfileBindingContinuation(env,c.sourceId,commandId,send);
    expect(continued,JSON.stringify({requests,posts,dispatch:await db.prepare('SELECT * FROM native_directory_profile_binding_dispatch WHERE command_id=?').bind(commandId).first(),
      frozen:await db.prepare('SELECT * FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(commandId).first(),
      receipt:await db.prepare('SELECT * FROM native_directory_profile_binding_receipts WHERE job_command_id=?').bind(commandId).first()})).toEqual({status:'acknowledged'});
    expect(posts).toBe(1);expect(await db.prepare('SELECT state FROM native_directory_profile_binding_dispatch WHERE command_id=?').bind(commandId).first('state')).toBe('complete');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  },{stopAfterReady:true,operationsThroughMigration:"0203_effective_native_directory_enrollment_consumers.sql"});
},240000);
