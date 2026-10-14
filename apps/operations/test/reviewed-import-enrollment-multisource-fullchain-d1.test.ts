import {readFileSync,readdirSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Miniflare} from 'miniflare';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {readReviewedImportEnrollmentReview,resolveReviewedImportEnrollmentDestinations} from '../src/worker/reviewed-import-enrollment-destinations';
import {writeReviewedImportEnrollment} from '../src/worker/reviewed-import-enrollment-writer';

let runtime:Miniflare,db:D1Database;
const recordId='two-source-imported-customer',staffId='staff-two-source-reviewer',subject='access|two-source-reviewer';
const uid=(n:number)=>`${String(n).padStart(8,'0')}-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(character:string)=>character.repeat(64);
const sources=[
  {sourceId:'project-alpha:primary',instance:uid(101),application:uid(102),epoch:uid(103),
    origin:'https://pa-primary.example.test',externalId:'primary-external-customer',publicId:'a'.repeat(32)},
  {sourceId:'project-alpha:secondary',instance:uid(201),application:uid(202),epoch:uid(203),
    origin:'https://pa-secondary.example.test',externalId:'secondary-external-customer',publicId:'b'.repeat(32)},
] as const;

function environment(){
  return {OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:Object.fromEntries(sources.map(source=>[
    source.sourceId,{sourceId:source.sourceId,enabled:true,baseUrl:source.origin,apiKey:'synthetic-full-chain-test-only',
      sourceInstanceId:source.instance,applicationId:source.application,historyEpoch:source.epoch},
  ]))})};
}

async function observe(source:typeof sources[number],requestId:string,nextCursor:string|null){
  await db.batch([
    db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,
      inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count)
      VALUES(?,?,?,?,'directory',?,'7',NULL,?,?,1)`).bind(source.sourceId,source.instance,source.application,source.epoch,
        requestId,nextCursor,hash(source===sources[0]?'8':'9')),
    db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,
      request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,
      binding_external_id,binding_status,binding_resource_revision)
      VALUES(?,?,?,?,?,'client',?,'7',1,'upsert',?,?, 'active','7')`).bind(source.sourceId,source.instance,
        source.application,source.epoch,requestId,source.publicId,hash(source===sources[0]?'6':'7'),source.externalId),
  ]);
}

async function seedAcquiredMapping(source:typeof sources[number],offset:number){
  const review=uid(offset+1),command=uid(offset+2),acquired=uid(offset+3),claim=uid(offset+4);
  const ownerEpoch=uid(offset+5),activation=uid(offset+6),request=hash(source===sources[0]?'1':'2');
  const evidence=source===sources[0]?{response:hash('4'),profile:hash('5'),binding:hash('6')}
    :{response:hash('a'),profile:hash('b'),binding:hash('c')};
  const reviewedBinding=hash(source===sources[0]?'3':'9');
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(receipt_id,request_sha256,record_id,source_id,
    source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,
    reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,
    reviewed_at,reviewed_local_record_version) VALUES(?,?,?,?,?,?,?,'client',?,?,'7',?,?,?,?,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1)`)
    .bind(review,request,recordId,source.sourceId,source.instance,source.application,source.epoch,source.externalId,source.publicId,
      uid(offset+7),reviewedBinding,staffId,subject).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(command_id,request_sha256,record_id,source_id,
    source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id)
    VALUES(?,?,?,?,?,?,?,'client',?,?,'7',?)`).bind(command,request,recordId,source.sourceId,source.instance,source.application,
      source.epoch,source.externalId,source.publicId,review).run();
  for(const [version,state] of [[1,'pending'],[2,'acknowledged']] as const) await db.prepare(`INSERT INTO
    project_alpha_existing_directory_binding_acquisition_events(command_id,state_version,transition_id,request_sha256,state,occurred_at)
    VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(command,version,uid(offset+7+version),request,state).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(command_id,source_instance_id,
    application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,
    pa_replayed,response_sha256,expected_authorization_generation,result_authorization_generation)
    VALUES(?,?,?,?,'client',?,?,'7',?,?,0,?,'6','7')`).bind(command,source.instance,source.application,source.epoch,
      source.externalId,source.publicId,source.origin,uid(offset+10),evidence.response).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(receipt_id,request_sha256,command_id,
    record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
    project_alpha_revision,acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256)
    VALUES(?,?,?,?,?,?,?,?,'client',?,?,'7',?,?,?)`).bind(acquired,request,command,recordId,source.sourceId,source.instance,
      source.application,source.epoch,source.externalId,source.publicId,evidence.response,evidence.profile,evidence.binding).run();
  await db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(receipt_id,record_id,source_id,source_instance_id,application_id,
    history_epoch_id,resource_type,external_id,project_alpha_public_id) VALUES(?,?,?,?,?,?,'client',?,?)`)
    .bind(acquired,recordId,source.sourceId,source.instance,source.application,source.epoch,source.externalId,source.publicId).run();
  await db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(claim_id,receipt_id,native_owner_epoch_id,record_id,source_id,
    source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_local_record_version,
    actor_id,request_sha256) VALUES(?,?,?,?,?,?,?,?,'client',?,?,1,?,?)`).bind(claim,acquired,ownerEpoch,recordId,source.sourceId,
      source.instance,source.application,source.epoch,source.externalId,source.publicId,staffId,request).run();
  await db.prepare('INSERT INTO project_alpha_acquired_mapping_activation(receipt_id) VALUES(?)').bind(acquired).run();
  const generation=await db.prepare('SELECT generation FROM native_directory_grant_generations WHERE staff_id=?').bind(staffId).first<number>('generation');
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(activation_id,review_receipt_id,idempotency_key,
    acquired_receipt_id,native_owner_claim_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
    project_alpha_public_id,project_alpha_revision,local_record_version,request_sha256,acquisition_evidence_sha256,profile_evidence_sha256,
    binding_status_evidence_sha256,activated_by_staff_id,directory_grant_generation,expected_authorization_generation,result_authorization_generation)
    VALUES(?,?,?,?,?,?,?,?,?,?,'client',?,?,'7',1,?,?,?,?,?,?,'6','7')`).bind(activation,review,uid(offset+11),acquired,claim,
      recordId,source.sourceId,source.instance,source.application,source.epoch,source.externalId,source.publicId,request,evidence.response,evidence.profile,
      evidence.binding,staffId,generation).run();
  await observe(source,uid(offset+12),null);
}

describe('reviewed import enrollment with two real D1 acquisition chains',()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['OPS_DB']});
    db=await runtime.getD1Database('OPS_DB') as D1Database;
    const directory=new URL('../migrations/',import.meta.url);
    for(const name of readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort()){
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>db.prepare(sql)));
      if(name.startsWith('0055_')) await db.batch([
        db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(recordId),
        db.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,'two-source-import',json_object('name','Two Source'))").bind(recordId),
        db.prepare("INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json) VALUES('two-source-audit','two-source-import',?,1,'system','import',json_object('imported',1))").bind(recordId),
      ]);
      if(name.startsWith('0057_')) await db.batch([
        db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('imports','Imports',1)"),
        db.prepare("INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,active) VALUES(?,'business_area','imports',1)").bind(recordId),
      ]);
    }
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,'reviewer@example.test','Reviewer',?,'active')").bind(staffId,subject),
      db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(staffId,subject,staffId),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,'reviewer@example.test','Reviewer')").bind(staffId),
      db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES('two-source-owner',?,'role-owner','global','global',?)").bind(staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('two-source-profile',?,'directory.profile.edit','allow','global',?)").bind(staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('two-source-enrollment',?,'directory.enrollment.manage','allow','global',?)").bind(staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('two-source-identity',?,'directory.identity.link','allow','global',?)").bind(staffId,staffId),
    ]);
    await seedAcquiredMapping(sources[0],300);await seedAcquiredMapping(sources[1],400);
  },120_000);
  afterAll(async()=>runtime.dispose());

  it('reviews, atomically enrolls, and idempotently replays two independently acquired mappings',async()=>{
    const env=environment();
    await expect(readReviewedImportEnrollmentReview(env,{recordId,kind:'client'})).resolves.toEqual({status:'reviewed',review:{
      recordId,kind:'client',recordVersion:1,enrollmentVersion:0,sources:sources.map(source=>({sourceId:source.sourceId,enrolled:false}))}});
    const selection={recordId,kind:'client' as const,expectedRecordVersion:1,expectedEnrollmentVersion:0,
      sourceIds:[sources[1].sourceId,sources[0].sourceId]};
    const resolved=await resolveReviewedImportEnrollmentDestinations(env,selection);
    expect(resolved).toEqual({status:'resolved',destinations:sources.map(source=>({sourceId:source.sourceId,sourceInstanceUUID:source.instance,
      applicationUUID:source.application,historyEpoch:source.epoch,origin:source.origin,externalCanonicalId:source.externalId}))});
    if(resolved.status!=='resolved') throw Error('expected both destinations to resolve');
    const actor={staffId,accessSubject:subject,admissionVersion:1,loginEmail:'reviewer@example.test',profileVersion:1,
      selectedProfileGrantId:'two-source-profile',selectedEnrollmentGrantId:'two-source-enrollment',
      verifiedUntil:new Date(Date.now()+60*60_000).toISOString()};
    const input={mutationId:uid(500),recordId,kind:'client' as const,expectedRecordVersion:1,expectedEnrollmentVersion:0,
      destinations:resolved.destinations,actor};

    await observe(sources[1],uid(490),'missing-final-page');
    await expect(writeReviewedImportEnrollment(db,input)).resolves.toEqual({status:'blocked',reason:'authority_or_evidence'});
    expect(await db.prepare('SELECT count(*) count FROM reviewed_import_enrollment_admissions').first<number>('count')).toBe(0);
    expect(await db.prepare('SELECT count(*) count FROM reviewed_import_enrollment_receipts').first<number>('count')).toBe(0);

    await observe(sources[1],uid(491),null);
    const written=await writeReviewedImportEnrollment(db,input);
    expect(written).toEqual({status:'written',replayed:false,recordId,enrollmentVersion:1,destinations:resolved.destinations});
    await expect(writeReviewedImportEnrollment(db,input)).resolves.toEqual({...written,replayed:true});
    const enrolled=await db.prepare('SELECT enrollment_version,destinations_json FROM effective_native_directory_enrollments WHERE record_id=?')
      .bind(recordId).first<{enrollment_version:number;destinations_json:string}>();
    expect(enrolled?.enrollment_version).toBe(1);
    expect(JSON.parse(enrolled!.destinations_json).map((destination:{externalCanonicalId:string})=>destination.externalCanonicalId))
      .toEqual(sources.map(source=>source.externalId));
    expect(await db.prepare('SELECT count(*) count FROM reviewed_import_enrollment_admissions').first<number>('count')).toBe(1);
    expect(await db.prepare('SELECT count(*) count FROM reviewed_import_enrollment_receipts').first<number>('count')).toBe(1);
  });
});
