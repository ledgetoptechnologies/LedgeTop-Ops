import {readFileSync,readdirSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Miniflare} from 'miniflare';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {writeReviewedImportEnrollment} from '../src/worker/reviewed-import-enrollment-writer';
import {writeNativeDirectoryProfile} from '../src/worker/native-directory-profile-writer';

let runtime:Miniflare,db:D1Database;
const recordId='legacy-local-customer',externalId='pa-customer-older-than-ops',staffId='staff-import-reviewer';
const subject='access|import-reviewer',sourceId='project-alpha:primary';
const instance='33333333-3333-4333-8333-333333333333',application='44444444-4444-4444-8444-444444444444';
const epoch='55555555-5555-4555-8555-555555555555',publicId='a'.repeat(32),origin='https://pa.example.test';
const uid=(n:number)=>`${String(n).padStart(8,'0')}-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=(c:string)=>c.repeat(64);

async function seedActivatedAcquisition(){
  const review=uid(21),command=uid(22),acquired=uid(23),claim=uid(24),ownerEpoch=uid(25),activation=uid(26),request=hash('1');
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(receipt_id,request_sha256,record_id,source_id,
    source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,
    reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,
    reviewed_at,reviewed_local_record_version) VALUES(?,?,?,?,?,?,?,'organization',?,?,'7',?,?,?,?,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1)`)
    .bind(review,request,recordId,sourceId,instance,application,epoch,externalId,publicId,uid(27),hash('7'),staffId,subject).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(command_id,request_sha256,record_id,source_id,
    source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id)
    VALUES(?,?,?,?,?,?,?,'organization',?,?,'7',?)`).bind(command,request,recordId,sourceId,instance,application,epoch,externalId,publicId,review).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(command_id,state_version,transition_id,request_sha256,state,occurred_at)
    VALUES(?,1,?,?,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(command,uid(28),request).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(command_id,state_version,transition_id,request_sha256,state,occurred_at)
    VALUES(?,2,?,?,'acknowledged',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(command,uid(29),request).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(command_id,source_instance_id,application_id,
    history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256,
    expected_authorization_generation,result_authorization_generation)
    VALUES(?,?,?,?,'organization',?,?,'7',?,?,0,?,'6','7')`).bind(command,instance,application,epoch,externalId,publicId,origin,uid(30),hash('2')).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(receipt_id,request_sha256,command_id,record_id,
    source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,
    acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256)
    VALUES(?,?,?,?,?,?,?,?,'organization',?,?,'7',?,?,?)`).bind(acquired,request,command,recordId,sourceId,instance,application,epoch,externalId,publicId,hash('2'),hash('3'),hash('4')).run();
  await db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(receipt_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,
    resource_type,external_id,project_alpha_public_id) VALUES(?,?,?,?,?,?,'organization',?,?)`).bind(acquired,recordId,sourceId,instance,application,epoch,externalId,publicId).run();
  await db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(claim_id,receipt_id,native_owner_epoch_id,record_id,source_id,source_instance_id,
    application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_local_record_version,actor_id,request_sha256)
    VALUES(?,?,?,?,?,?,?,?,'organization',?,?,1,?,?)`).bind(claim,acquired,ownerEpoch,recordId,sourceId,instance,application,epoch,externalId,publicId,staffId,request).run();
  await db.prepare('INSERT INTO project_alpha_acquired_mapping_activation(receipt_id) VALUES(?)').bind(acquired).run();
  const generation=await db.prepare('SELECT generation FROM native_directory_grant_generations WHERE staff_id=?').bind(staffId).first<number>('generation');
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(activation_id,review_receipt_id,idempotency_key,
    acquired_receipt_id,native_owner_claim_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
    project_alpha_public_id,project_alpha_revision,local_record_version,request_sha256,acquisition_evidence_sha256,profile_evidence_sha256,
    binding_status_evidence_sha256,activated_by_staff_id,directory_grant_generation,expected_authorization_generation,result_authorization_generation)
    VALUES(?,?,?,?,?,?,?,?,?,?,'organization',?,?,'7',1,?,?,?,?,?,?,'6','7')`)
    .bind(activation,review,uid(31),acquired,claim,recordId,sourceId,instance,application,epoch,externalId,publicId,request,hash('2'),hash('3'),hash('4'),staffId,generation).run();
  const inventoryRequest=uid(32);
  await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,
    request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count) VALUES(?,?,?,?,'directory',?,'7',NULL,NULL,?,1)`)
    .bind(sourceId,instance,application,epoch,inventoryRequest,hash('5')).run();
  await db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,request_id,
    resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision)
    VALUES(?,?,?,?,?,'organization',?,'7',1,'upsert',?,?,'active','7')`).bind(sourceId,instance,application,epoch,inventoryRequest,publicId,hash('6'),externalId).run();
}

describe('reviewed imported-record enrollment foundation',()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['OPS_DB']});
    db=await runtime.getD1Database('OPS_DB') as D1Database;
    const directory=new URL('../migrations/',import.meta.url);
    for(const name of readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort()){
      const statements=splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8'));
      await db.batch(statements.map(sql=>db.prepare(sql)));
      if(name.startsWith('0055_'))await db.batch([
        db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)").bind(recordId),
        db.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,'legacy-import',json_object('name','Legacy'))").bind(recordId),
        db.prepare("INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json) VALUES('legacy-audit','legacy-import',?,1,'system','legacy-import',json_object('imported',1))").bind(recordId),
      ]);
      if(name.startsWith('0057_'))await db.batch([
        db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('imports','Imports',1)"),
        db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('imports-division','imports','Imported',1)"),
        db.prepare("INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,active) VALUES(?,'business_area','imports',1)").bind(recordId),
        db.prepare("INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,division_id,active) VALUES(?,'division','imports','imports-division',1)").bind(recordId),
      ]);
    }
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,'reviewer@example.test','Reviewer',?,'active')").bind(staffId,subject),
      db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(staffId,subject,staffId),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,'reviewer@example.test','Reviewer')").bind(staffId),
      db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key,created_by) VALUES('import-owner',?,'role-owner','global','global',?)").bind(staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('import-profile',?,'directory.profile.edit','allow','global',?)").bind(staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('import-enrollment',?,'directory.enrollment.manage','allow','global',?)").bind(staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('import-identity',?,'directory.identity.link','allow','global',?)").bind(staffId,staffId),
    ]);
    await seedActivatedAcquisition();
  },120_000);
  afterAll(async()=>runtime.dispose());

  it('applies after the real full D1 chain and exposes an empty effective view',async()=>{
    expect(await db.prepare("SELECT count(*) count FROM sqlite_master WHERE name IN ('reviewed_import_enrollment_admissions','reviewed_import_enrollment_receipts','effective_native_directory_enrollments')")
      .first<number>('count')).toBe(3);
    expect(await db.prepare('SELECT count(*) count FROM effective_native_directory_enrollments').first<number>('count')).toBe(0);
  });

  it('keeps admission and receipt ledgers immutable',async()=>{
    const triggers=(await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'reviewed_import_enrollment_%_no_%'").all<{name:string}>()).results;
    expect(triggers.map(row=>row.name).sort()).toEqual([
      'reviewed_import_enrollment_admissions_no_delete','reviewed_import_enrollment_admissions_no_update',
      'reviewed_import_enrollment_receipts_no_delete','reviewed_import_enrollment_receipts_no_update',
    ]);
  });

  it('does not alter the historical native enrollment shape',async()=>{
    const columns=(await db.prepare('PRAGMA table_info(native_directory_enrollments)').all<{name:string}>()).results.map(row=>row.name);
    expect(columns).toEqual(['record_id','destinations_json','create_admission_id','created_at']);
    const viewSql=await db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='effective_native_directory_enrollments'").first<string>('sql');
    expect(viewSql).toContain("'historyEpochs'");
    expect(viewSql).not.toContain('json_set(native.destinations_json');
  });

  it('rejects malformed outer input without touching D1',async()=>{
    await expect(writeReviewedImportEnrollment(db,undefined as never)).resolves.toEqual({status:'rejected',reason:'invalid_write'});
    await expect(writeReviewedImportEnrollment(db,{destinations:[]} as never)).resolves.toEqual({status:'rejected',reason:'invalid_write'});
  });

  it('rejects an older complete page when the equal-time current request is incomplete',async()=>{
    const observedAt=await db.prepare(`SELECT observed_at FROM project_alpha_api_v2_inventory_receipts
      WHERE source_id=? AND request_id=?`).bind(sourceId,uid(32)).first<string>('observed_at');
    expect(observedAt).toBeTruthy();
    async function observe(requestId:string,nextCursor:string|null){
      await db.batch([
        db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
          history_epoch_id,inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,
          item_count,observed_at) VALUES(?,?,?,?,'directory',?,'7',NULL,?,?,1,?)`)
          .bind(sourceId,instance,application,epoch,requestId,nextCursor,hash('8'),observedAt),
        db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,
          history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,
          projection_sha256,binding_external_id,binding_status,binding_resource_revision)
          VALUES(?,?,?,?,?,'organization',?,'7',1,'upsert',?,?,'active','7')`)
          .bind(sourceId,instance,application,epoch,requestId,publicId,hash('6'),externalId),
      ]);
    }
    // Resource and binding evidence is identical, so no conflict obscures the
    // ordering predicate. Only the higher request ID's page completeness differs.
    await observe(uid(80),'synthetic-continuation');
    const current=await db.prepare(`SELECT observation.request_id,observation.has_conflict,receipt.next_cursor
      FROM project_alpha_api_v2_directory_observations_current observation
      JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id
        AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id
        AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='directory'
        AND receipt.request_id=observation.request_id
      WHERE observation.source_id=? AND observation.project_alpha_public_id=?`)
      .bind(sourceId,publicId).first<{request_id:string;has_conflict:number;next_cursor:string|null}>();
    expect(current).toEqual({request_id:uid(80),has_conflict:0,next_cursor:'synthetic-continuation'});

    const admissionId=uid(81),mutationId=uid(82),reviewedAt=new Date().toISOString();
    const destinations=JSON.stringify([{sourceId,sourceInstanceUUID:instance,applicationUUID:application,
      historyEpoch:epoch,origin,externalCanonicalId:externalId}]);
    await db.prepare(`INSERT INTO reviewed_import_enrollment_admissions(admission_id,mutation_id,record_id,record_kind,
      enrollment_version,expected_record_version,expected_enrollment_version,destinations_json,actor_staff_id,
      actor_access_subject,actor_admission_version,actor_email,actor_profile_version,selected_profile_grant_id,
      selected_enrollment_grant_id,actor_verified_until,reviewed_at)
      VALUES(?,?,?,'organization',1,1,0,?,?,?,1,'reviewer@example.test',1,'import-profile','import-enrollment',?,?)`)
      .bind(admissionId,mutationId,recordId,destinations,staffId,subject,
        new Date(Date.now()+10*60_000).toISOString(),reviewedAt).run();
    await expect(db.prepare(`INSERT INTO reviewed_import_enrollment_receipts(receipt_id,admission_id,mutation_id,
      record_id,enrollment_version,destinations_json,admitted_by_staff_id,admitted_at) VALUES(?,?,?,?,1,?,?,?)`)
      .bind(uid(83),admissionId,mutationId,recordId,destinations,staffId,reviewedAt).run())
      .rejects.toThrow(/requires fresh complete inventory evidence/);
    expect(await db.prepare('SELECT count(*) count FROM reviewed_import_enrollment_receipts')
      .first<number>('count')).toBe(0);

    // Append a later request, without mutating either immutable observation,
    // so the following positive writer test also proves recovery with fresh evidence.
    await observe(uid(90),null);
    expect(await db.prepare(`SELECT request_id FROM project_alpha_api_v2_directory_observations_current
      WHERE source_id=? AND project_alpha_public_id=?`).bind(sourceId,publicId).first<string>('request_id')).toBe(uid(90));
  });

  it('explicitly enrolls a legacy imported record whose PA external ID differs from its Ops ID',async()=>{
    const mutationId=uid(40),startedAt=Date.now(),verifiedUntil=new Date(startedAt+7*24*60*60_000).toISOString();
    const input={mutationId,recordId,kind:'organization' as const,expectedRecordVersion:1,expectedEnrollmentVersion:0,
      destinations:[{sourceId,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:externalId}],
      actor:{staffId,accessSubject:subject,admissionVersion:1,loginEmail:'reviewer@example.test',profileVersion:1,
        selectedProfileGrantId:'import-profile',selectedEnrollmentGrantId:'import-enrollment',verifiedUntil}};
    const result=await writeReviewedImportEnrollment(db,input);
    expect(result).toMatchObject({status:'written',replayed:false,recordId,enrollmentVersion:1});
    const boundedUntil=await db.prepare('SELECT actor_verified_until FROM reviewed_import_enrollment_admissions WHERE mutation_id=?')
      .bind(mutationId).first<string>('actor_verified_until');
    expect(Date.parse(boundedUntil!)).toBeLessThanOrEqual(startedAt+15*60_000+1000);
    expect(await db.prepare('SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?').bind(recordId).first()).toBeNull();
    expect(JSON.parse((await db.prepare('SELECT destinations_json FROM effective_native_directory_enrollments WHERE record_id=?').bind(recordId)
      .first<string>('destinations_json'))!)[0].externalCanonicalId).toBe(externalId);
    await expect(writeReviewedImportEnrollment(db,{...input,actor:{...input.actor,verifiedUntil:new Date(Date.now()+12*60_000).toISOString()}}))
      .resolves.toMatchObject({status:'written',replayed:true,enrollmentVersion:1});
    await expect(writeReviewedImportEnrollment(db,{...input,recordId:'different-body'})).resolves.toEqual({status:'conflict',reason:'idempotency_body_conflict'});
    await expect(writeReviewedImportEnrollment(db,{...input,mutationId:uid(41),expectedEnrollmentVersion:0})).resolves.toEqual({status:'conflict',reason:'stale_enrollment'});
  });

  it('honors assigned and division allows with deny-wins at each matching scope',async()=>{
    await db.batch([
      db.prepare('INSERT INTO native_directory_assignments(record_id,staff_id,active,assigned_by) VALUES(?,?,1,?)').bind(recordId,staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('assigned-profile',?,'directory.profile.edit','allow','assigned',?)").bind(staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('assigned-enrollment',?,'directory.enrollment.manage','allow','assigned',?)").bind(staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,division_id,granted_by) VALUES('division-profile',?,'directory.profile.edit','allow','division','imports-division',?)").bind(staffId,staffId),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,division_id,granted_by) VALUES('division-enrollment',?,'directory.enrollment.manage','allow','division','imports-division',?)").bind(staffId,staffId),
    ]);
    const destinations=[{sourceId,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:externalId}];
    const actor=(profile:string,enrollment:string)=>({staffId,accessSubject:subject,admissionVersion:1,loginEmail:'reviewer@example.test',profileVersion:1,
      selectedProfileGrantId:profile,selectedEnrollmentGrantId:enrollment,verifiedUntil:new Date(Date.now()+60*60_000).toISOString()});
    const assigned=await writeReviewedImportEnrollment(db,{mutationId:uid(50),recordId,kind:'organization',expectedRecordVersion:1,
      expectedEnrollmentVersion:1,destinations,actor:actor('assigned-profile','assigned-enrollment')});
    expect(assigned).toMatchObject({status:'written',enrollmentVersion:2});
    await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES('assigned-deny',?,'directory.enrollment.manage','deny','assigned',?)")
      .bind(staffId,staffId).run();
    await expect(writeReviewedImportEnrollment(db,{mutationId:uid(51),recordId,kind:'organization',expectedRecordVersion:1,
      expectedEnrollmentVersion:2,destinations,actor:actor('assigned-profile','assigned-enrollment')})).resolves.toEqual({status:'blocked',reason:'authority_or_evidence'});
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='assigned-deny'").run();
    const division=await writeReviewedImportEnrollment(db,{mutationId:uid(52),recordId,kind:'organization',expectedRecordVersion:1,
      expectedEnrollmentVersion:2,destinations,actor:actor('division-profile','division-enrollment')});
    expect(division).toMatchObject({status:'written',enrollmentVersion:3});
    await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,division_id,granted_by) VALUES('division-deny',?,'directory.profile.edit','deny','division','imports-division',?)")
      .bind(staffId,staffId).run();
    await expect(writeReviewedImportEnrollment(db,{mutationId:uid(53),recordId,kind:'organization',expectedRecordVersion:1,
      expectedEnrollmentVersion:3,destinations,actor:actor('division-profile','division-enrollment')})).resolves.toEqual({status:'blocked',reason:'authority_or_evidence'});
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='division-deny'").run();
  });

  it('direct SQL receipt admission is deny-wins and cannot forge admitted time',async()=>{
    const destinations=JSON.stringify([{sourceId,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:externalId}]);
    const reviewedAt=new Date().toISOString(),admission=uid(42),mutation=uid(43);
    await db.prepare(`INSERT INTO reviewed_import_enrollment_admissions(admission_id,mutation_id,record_id,record_kind,enrollment_version,
      expected_record_version,expected_enrollment_version,destinations_json,actor_staff_id,actor_access_subject,actor_admission_version,
      actor_email,actor_profile_version,selected_profile_grant_id,selected_enrollment_grant_id,actor_verified_until,reviewed_at)
      VALUES(?,?,?,'organization',4,1,3,?,?,?,1,'reviewer@example.test',1,'import-profile','import-enrollment',?,?)`)
      .bind(admission,mutation,recordId,destinations,staffId,subject,new Date(Date.now()+10*60_000).toISOString(),reviewedAt).run();
    const statement=(at:string)=>db.prepare(`INSERT INTO reviewed_import_enrollment_receipts(receipt_id,admission_id,mutation_id,record_id,
      enrollment_version,destinations_json,admitted_by_staff_id,admitted_at) VALUES(?,?,?,?,4,?,?,?)`)
      .bind(uid(at===reviewedAt?44:45),admission,mutation,recordId,destinations,staffId,at);
    await expect(statement(new Date(Date.now()-60_000).toISOString()).run()).rejects.toThrow(/exact current authority/);
    await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES('import-deny',?,'directory.enrollment.manage','deny','resource',?,?)")
      .bind(staffId,recordId,staffId).run();
    await expect(statement(reviewedAt).run()).rejects.toThrow(/current scoped permissions/);
    expect(await db.prepare('SELECT count(*) count FROM reviewed_import_enrollment_receipts WHERE enrollment_version=4').first<number>('count')).toBe(0);
  });

  it('does not let an orphan admission squat a version and settles only one competing admission',async()=>{
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='import-deny'").run();
    const destinations=[{sourceId,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:externalId}];
    const actor={staffId,accessSubject:subject,admissionVersion:1,loginEmail:'reviewer@example.test',profileVersion:1,
      selectedProfileGrantId:'import-profile',selectedEnrollmentGrantId:'import-enrollment',verifiedUntil:new Date(Date.now()+60*60_000).toISOString()};
    await expect(writeReviewedImportEnrollment(db,{mutationId:uid(60),recordId,kind:'organization',expectedRecordVersion:1,
      expectedEnrollmentVersion:3,destinations,actor})).resolves.toMatchObject({status:'written',enrollmentVersion:4});
    const encoded=JSON.stringify(destinations),reviewedAt=new Date().toISOString();
    async function admission(admissionId:string,mutationId:string){
      await db.prepare(`INSERT INTO reviewed_import_enrollment_admissions(admission_id,mutation_id,record_id,record_kind,enrollment_version,
        expected_record_version,expected_enrollment_version,destinations_json,actor_staff_id,actor_access_subject,actor_admission_version,
        actor_email,actor_profile_version,selected_profile_grant_id,selected_enrollment_grant_id,actor_verified_until,reviewed_at)
        VALUES(?,?,?,'organization',5,1,4,?,?,?,1,'reviewer@example.test',1,'import-profile','import-enrollment',?,?)`)
        .bind(admissionId,mutationId,recordId,encoded,staffId,subject,new Date(Date.now()+10*60_000).toISOString(),reviewedAt).run();
    }
    const firstAdmission=uid(61),secondAdmission=uid(62),firstMutation=uid(63),secondMutation=uid(64);
    await admission(firstAdmission,firstMutation);await admission(secondAdmission,secondMutation);
    const receipt=(receiptId:string,admissionId:string,mutationId:string)=>db.prepare(`INSERT INTO reviewed_import_enrollment_receipts(
      receipt_id,admission_id,mutation_id,record_id,enrollment_version,destinations_json,admitted_by_staff_id,admitted_at)
      VALUES(?,?,?,?,5,?,?,?)`).bind(receiptId,admissionId,mutationId,recordId,encoded,staffId,reviewedAt);
    await expect(receipt(uid(65),firstAdmission,firstMutation).run()).resolves.toBeDefined();
    await expect(receipt(uid(66),secondAdmission,secondMutation).run()).rejects.toThrow(/exact current authority/);
    expect(await db.prepare('SELECT count(*) count FROM reviewed_import_enrollment_receipts WHERE record_id=? AND enrollment_version=5')
      .bind(recordId).first<number>('count')).toBe(1);
  });

  it('edits an imported profile using its acquired external ID and freezes enrollment until the update settles',async()=>{
    const destination={sourceId,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,
      origin,externalCanonicalId:externalId};
    const profileMutation=uid(100);
    const updated=await writeNativeDirectoryProfile(db,{operation:'update',mutationId:profileMutation,recordId,
      kind:'organization',expectedLocalVersion:1,
      profile:{name:'Reviewed imported organization',generalEmail:'',generalPhone:'',addressLine1:'',addressLine2:'',
        city:'',state:'',postalCode:'',country:''},
      destinations:[{...destination,expectedAuthorizationGeneration:'7'}],
      actor:{staffId,accessSubject:subject,admissionVersion:1,loginEmail:'reviewer@example.test',profileVersion:1,
        selectedGrantId:'import-profile',selectedIdentityGrantId:'import-identity'}});
    expect(updated).toMatchObject({status:'written',recordId,version:2});
    if(updated.status!=='written')throw new Error(`Imported profile update rejected: ${updated.reason}`);
    expect(updated.commandIds).toHaveLength(1);
    const commandId=updated.commandIds[0]!;
    expect(await db.prepare(`SELECT external_id FROM project_alpha_directory_outbox WHERE command_id=?`)
      .bind(commandId).first<string>('external_id')).toBe(externalId);

    const actor={staffId,accessSubject:subject,admissionVersion:1,loginEmail:'reviewer@example.test',profileVersion:1,
      selectedProfileGrantId:'import-profile',selectedEnrollmentGrantId:'import-enrollment',
      verifiedUntil:new Date(Date.now()+10*60_000).toISOString()};
    await expect(writeReviewedImportEnrollment(db,{mutationId:uid(101),recordId,kind:'organization',expectedRecordVersion:2,
      expectedEnrollmentVersion:5,destinations:[destination],actor}))
      .resolves.toEqual({status:'blocked',reason:'authority_or_evidence'});
    const admissionId=uid(102),mutationId=uid(103),reviewedAt=new Date().toISOString(),encoded=JSON.stringify([destination]);
    await db.prepare(`INSERT INTO reviewed_import_enrollment_admissions(admission_id,mutation_id,record_id,record_kind,
      enrollment_version,expected_record_version,expected_enrollment_version,destinations_json,actor_staff_id,
      actor_access_subject,actor_admission_version,actor_email,actor_profile_version,selected_profile_grant_id,
      selected_enrollment_grant_id,actor_verified_until,reviewed_at)
      VALUES(?,?,?,'organization',6,2,5,?,?,?,1,'reviewer@example.test',1,'import-profile','import-enrollment',?,?)`)
      .bind(admissionId,mutationId,recordId,encoded,staffId,subject,actor.verifiedUntil,reviewedAt).run();
    await expect(db.prepare(`INSERT INTO reviewed_import_enrollment_receipts(receipt_id,admission_id,mutation_id,
      record_id,enrollment_version,destinations_json,admitted_by_staff_id,admitted_at) VALUES(?,?,?,?,6,?,?,?)`)
      .bind(uid(104),admissionId,mutationId,recordId,encoded,staffId,reviewedAt).run())
      .rejects.toThrow(/requires completed directory work/);

    // Settle through the normal immutable-outcome/state guards. No trigger or
    // mapping is replaced; this is the same lease/ACK sequence the dispatcher uses.
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='fixture-lease',
      lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`).bind(commandId).run();
    const outcome={status:'acknowledged',response:{requestId:commandId,replayed:false,sourceInstanceId:instance,
      applicationId:application,historyEpoch:epoch,result:{resource:{type:'organization',id:externalId,publicId,revision:'8'},
        data:{publicId},authorizationGeneration:'7'}}};
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,
      lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(JSON.stringify(outcome),commandId).run();
    await db.prepare(`UPDATE operations_directory_intents SET state='acknowledged'
      WHERE mutation_id=? AND state='materialized'`).bind(profileMutation).run();
    expect(await db.prepare(`SELECT state FROM native_directory_profile_binding_dispatch WHERE command_id=?`)
      .bind(commandId).first<string>('state')).toBe('pending');
    await expect(writeReviewedImportEnrollment(db,{mutationId:uid(105),recordId,kind:'organization',expectedRecordVersion:2,
      expectedEnrollmentVersion:5,destinations:[destination],actor}))
      .resolves.toEqual({status:'blocked',reason:'authority_or_evidence'});
    await expect(db.prepare(`INSERT INTO reviewed_import_enrollment_receipts(receipt_id,admission_id,mutation_id,
      record_id,enrollment_version,destinations_json,admitted_by_staff_id,admitted_at) VALUES(?,?,?,?,6,?,?,?)`)
      .bind(uid(106),admissionId,mutationId,recordId,encoded,staffId,reviewedAt).run())
      .rejects.toThrow(/requires completed profile binding work/);

    // The continuation's legitimate already-aligned path requires fresh,
    // exact canonical inventory; completing a job without that evidence is forbidden.
    await db.prepare(`UPDATE native_directory_profile_binding_dispatch SET state='leased',attempts=1,
      lease_token='fixture-binding-lease',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`)
      .bind(commandId).run();
    await expect(db.prepare(`UPDATE native_directory_profile_binding_dispatch SET state='complete',lease_token=NULL,
      lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(commandId).run())
      .rejects.toThrow(/requires canonical aligned inventory/);
    const inventoryRequest=uid(107);
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
        history_epoch_id,inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count)
        VALUES(?,?,?,?,'directory',?,'7',NULL,NULL,?,1)`).bind(sourceId,instance,application,epoch,inventoryRequest,hash('9')),
      db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,
        history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,
        projection_sha256,binding_external_id,binding_status,binding_resource_revision)
        VALUES(?,?,?,?,?,'organization',?,'8',1,'upsert',?,?,'active','8')`)
        .bind(sourceId,instance,application,epoch,inventoryRequest,publicId,hash('9'),externalId),
    ]);
    await db.prepare(`UPDATE native_directory_profile_binding_dispatch SET state='complete',lease_token=NULL,
      lease_expires_at=NULL WHERE command_id=? AND state='leased'`).bind(commandId).run();
    await expect(writeReviewedImportEnrollment(db,{mutationId:uid(108),recordId,kind:'organization',expectedRecordVersion:2,
      expectedEnrollmentVersion:5,destinations:[destination],actor}))
      .resolves.toMatchObject({status:'written',enrollmentVersion:6});
  });

  it('freezes enrollment while a lifecycle mutation is pending',async()=>{
    const destinations=[{sourceId,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:externalId}];
    await db.prepare(`INSERT INTO operations_directory_lifecycle_fences(mutation_id,record_id,record_kind,action,expected_lifecycle_version,
      expected_record_version,actor_staff_id,actor_access_subject,actor_admission_version,actor_email,actor_profile_version,
      selected_profile_grant_id,selected_enrollment_grant_id,destinations_json,observations_json,verified_until)
      VALUES(?,?,'organization','archive',0,2,?,?,1,'reviewer@example.test',1,'import-profile','import-enrollment',?,json_array(),?)`)
      .bind(uid(70),recordId,staffId,subject,JSON.stringify(destinations),new Date(Date.now()+10*60_000).toISOString()).run();
    await expect(writeReviewedImportEnrollment(db,{mutationId:uid(71),recordId,kind:'organization',expectedRecordVersion:2,
      expectedEnrollmentVersion:6,destinations,actor:{staffId,accessSubject:subject,admissionVersion:1,loginEmail:'reviewer@example.test',
        profileVersion:1,selectedProfileGrantId:'import-profile',selectedEnrollmentGrantId:'import-enrollment',
        verifiedUntil:new Date(Date.now()+60*60_000).toISOString()}})).resolves.toEqual({status:'blocked',reason:'authority_or_evidence'});
  });
});

