import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { validateAcknowledgedScalarUpdate, validatePairedGrantCleanup } from "./staging-directory-scalar-settlement.mjs";

const root=path.resolve(import.meta.dirname,"..");
const viteUrl=pathToFileURL(path.join(root,"apps/operations/node_modules/vite/dist/node/index.js")).href;
const miniflareUrl=pathToFileURL(path.join(root,"apps/operations/node_modules/miniflare/dist/src/index.js")).href;
const clone=value=>structuredClone(value);
const rows=async(db,sql,...values)=>(await db.prepare(sql).bind(...values).all()).results;

async function acquiredActivation(db,{stem,recordId,kind,externalId,publicId,staffId,subject,sourceId,instance,application,epoch}){
  const id=n=>`${stem}${n}000000-0000-4000-8000-000000000001`,request=stem.repeat(64).slice(0,64),review=(stem+"1").repeat(64).slice(0,64);
  const acquisition=(stem+"2").repeat(64).slice(0,64),profile=(stem+"3").repeat(64).slice(0,64),binding=(stem+"4").repeat(64).slice(0,64);
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewed_at,reviewed_local_record_version) VALUES(?,?,?,?,?,?,?,?,?,?,'7',?,?,?,?,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1)`).bind(id(1),request,recordId,sourceId,instance,application,epoch,kind,externalId,publicId,id(6),review,staffId,subject).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(command_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id) VALUES(?,?,?,?,?,?,?,?,?,?,'7',?)`).bind(id(2),request,recordId,sourceId,instance,application,epoch,kind,externalId,publicId,id(1)).run();
  for(const [version,state,n] of [[1,"pending",7],[2,"acknowledged",8]])await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(command_id,state_version,transition_id,request_sha256,state,occurred_at) VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(id(2),version,id(n),request,state).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256,expected_authorization_generation,result_authorization_generation) VALUES(?,?,?,?,?,?,?,'7','https://pa.example.test',?,0,?,'0','1')`).bind(id(2),instance,application,epoch,kind,externalId,publicId,id(9),acquisition).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,'7',?,?,?)`).bind(id(3),request,id(2),recordId,sourceId,instance,application,epoch,kind,externalId,publicId,acquisition,profile,binding).run();
  await db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(receipt_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id) VALUES(?,?,?,?,?,?,?,?,?)`).bind(id(3),recordId,sourceId,instance,application,epoch,kind,externalId,publicId).run();
  await db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(claim_id,receipt_id,native_owner_epoch_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_local_record_version,actor_id,request_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(id(4),id(3),id(5),recordId,sourceId,instance,application,epoch,kind,externalId,publicId,staffId,request).run();
  await db.prepare("INSERT INTO project_alpha_acquired_mapping_activation(receipt_id) VALUES(?)").bind(id(3)).run();
  const activation=id(0);
  const debug=await db.prepare(`SELECT review.*,acquired.*,mapping.activation_state,mapping.native_owner_epoch_id,
    claim.claim_id,claim.actor_id,claim.expected_local_record_version,dormant.state,record.record_kind,record.current_version
    FROM project_alpha_existing_directory_binding_review_evidence review
    JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.review_receipt_id=review.receipt_id
    JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.command_id=command.command_id
    JOIN project_alpha_acquired_canonical_mappings mapping ON mapping.receipt_id=acquired.receipt_id
    JOIN project_alpha_acquired_native_owner_claims claim ON claim.receipt_id=mapping.receipt_id
    JOIN project_alpha_acquired_mapping_activation dormant ON dormant.receipt_id=mapping.receipt_id
    JOIN operations_directory_records record ON record.record_id=review.record_id WHERE review.receipt_id=?`).bind(id(1)).first();
  if(!debug)throw new Error("acquisition lineage join is empty before activation");
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(activation_id,review_receipt_id,idempotency_key,acquired_receipt_id,native_owner_claim_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,local_record_version,request_sha256,acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256,activated_by_staff_id,directory_grant_generation,expected_authorization_generation,result_authorization_generation) VALUES(?,?,?, ?,?,?,?,?,?,?,?,?,?,'7',1,?,?,?,?,?,2,'0','1')`).bind(activation,id(1),activation,id(3),id(4),recordId,sourceId,instance,application,epoch,kind,externalId,publicId,request,acquisition,profile,binding,staffId).run();
  return activation;
}
async function acquiredRefresh(db,{stem,recordId,kind,externalId,publicId,sourceId,instance,application,epoch,acquiredStem}){
  const id=n=>`${stem}${n}000000-0000-4000-8000-000000000001`,acquiredId=n=>`${acquiredStem}${n}000000-0000-4000-8000-000000000001`;
  const request=(stem+"5").repeat(64).slice(0,64),response=(stem+"6").repeat(64).slice(0,64),command=id(1);
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_revision_refresh_commands(command_id,request_sha256,
    predecessor_kind,predecessor_acquired_receipt_id,predecessor_refresh_receipt_id,native_owner_claim_id,record_id,source_id,
    source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_prior_revision,
    expected_live_revision,expected_authorization_generation,expected_local_record_version) VALUES(?,?,'acquired_mapping',?,NULL,?,?,?,?,?,?,?,?,?,'7','8','1',1)`)
    .bind(command,request,acquiredId(3),acquiredId(4),recordId,sourceId,instance,application,epoch,kind,externalId,publicId).run();
  for(const [version,state,n] of [[1,"pending",2],[2,"acknowledged",3]])await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_revision_refresh_events
    (command_id,state_version,transition_id,request_sha256,state,occurred_at) VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .bind(command,version,id(n),request,state).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_revision_refresh_receipts(receipt_id,request_sha256,command_id,
    native_owner_claim_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
    project_alpha_public_id,prior_revision,live_revision,authorization_generation,local_record_version,pa_request_id,pa_replayed,response_sha256)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?, '7','8','2',1,?,0,?)`)
    .bind(id(4),request,command,acquiredId(4),recordId,sourceId,instance,application,epoch,kind,externalId,publicId,id(5),response).run();
}
async function acquiredRefreshSuccessor(db,{recordId,externalId,publicId,sourceId,instance,application,epoch}){
  const id=n=>`f${n}000000-0000-4000-8000-000000000001`,request="f7".repeat(32),command=id(1);
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_revision_refresh_commands(command_id,request_sha256,
    predecessor_kind,predecessor_acquired_receipt_id,predecessor_refresh_receipt_id,native_owner_claim_id,record_id,source_id,
    source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_prior_revision,
    expected_live_revision,expected_authorization_generation,expected_local_record_version) VALUES(?,?,'revision_refresh',NULL,?,?,?,?,?,?,?,?,?,?,'8','9','2',1)`)
    .bind(command,request,"d4000000-0000-4000-8000-000000000001","b4000000-0000-4000-8000-000000000001",recordId,sourceId,instance,application,epoch,"client",externalId,publicId).run();
  for(const [version,state,n] of [[1,"pending",2],[2,"acknowledged",3]])await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_revision_refresh_events
    (command_id,state_version,transition_id,request_sha256,state,occurred_at) VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .bind(command,version,id(n),request,state).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_revision_refresh_receipts(receipt_id,request_sha256,command_id,
    native_owner_claim_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
    project_alpha_public_id,prior_revision,live_revision,authorization_generation,local_record_version,pa_request_id,pa_replayed,response_sha256)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'8','9','3',1,?,0,?)`).bind(id(4),request,command,"b4000000-0000-4000-8000-000000000001",
      recordId,sourceId,instance,application,epoch,"client",externalId,publicId,id(5),"f8".repeat(32)).run();
}

async function fullSchema(t){
  const [{createServer},{Miniflare}]=await Promise.all([import(viteUrl),import(miniflareUrl)]);
  const server=await createServer({root:path.join(root,"apps/operations"),configFile:false,server:{middlewareMode:true},appType:"custom",logLevel:"silent"});
  const runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
  t.after(async()=>{
    try { await runtime.dispose(); }
    finally { await server.close(); }
  });
  const db=await runtime.getD1Database("OPS_DB");
  const [{splitD1MigrationStatements},writer,dispatcher,relationshipWriter,relationshipDispatcher]=await Promise.all([
    server.ssrLoadModule("/../client/test/helpers/d1-migrations.ts"),
    server.ssrLoadModule("/src/worker/native-directory-profile-writer.ts"),
    server.ssrLoadModule("/src/worker/project-alpha-directory-profile-outbox-dispatcher.ts"),
    server.ssrLoadModule("/src/worker/native-directory-relationship-writer.ts"),
    server.ssrLoadModule("/src/worker/project-alpha-directory-relationship-outbox-dispatcher.ts"),
  ]);
  const migrationDir=path.join(root,"apps/operations/migrations");
  const migrations=readdirSync(migrationDir).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name.slice(0,4)<="0184").sort();
  assert.equal(migrations.length,184);
  const acquiredOrg="77777777-7777-4777-8777-777777777777",acquiredClient="88888888-8888-4888-8888-888888888888";
  const acquiredDestination={sourceId:"project-alpha:primary",sourceInstanceUUID:"33333333-3333-4333-8333-333333333333",
    applicationUUID:"44444444-4444-4444-8444-444444444444",historyEpoch:"55555555-5555-4555-8555-555555555555",
    origin:"https://pa.example.test"};
  const acquiredOrgProfile={name:"Acquired Parent",generalEmail:"parent@example.test",generalPhone:"",addressLine1:"",addressLine2:"",city:"",state:"",postalCode:"",country:""};
  const acquiredClientProfile={name:"Acquired Client",email:"client@example.test",phone:"1",addressLine1:"",addressLine2:"",city:"",state:"TX",postalCode:"",country:""};
  for(const name of migrations){const sql=readFileSync(path.join(migrationDir,name),"utf8"),statements=splitD1MigrationStatements(sql);
    if(name.startsWith("0065_")){
      const admissionTrigger=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='native_directory_create_admissions_immutable'").first("sql");
      const enrollmentTrigger=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='native_directory_enrollments_no_update'").first("sql");
      await db.batch([db.prepare("DROP TRIGGER native_directory_create_admissions_immutable"),db.prepare("DROP TRIGGER native_directory_enrollments_no_update")]);
      for(const [recordId,admission] of [[acquiredOrg,"acquired-org-admission"],[acquiredClient,"acquired-client-admission"]]){
        const upgraded=JSON.stringify([{...acquiredDestination,externalCanonicalId:recordId===acquiredOrg?acquiredOrg:"pa-acquired-client"}]);
        await db.batch([db.prepare("UPDATE native_directory_create_admissions SET destinations_json=? WHERE id=?").bind(upgraded,admission),
          db.prepare("UPDATE native_directory_enrollments SET destinations_json=? WHERE record_id=?").bind(upgraded,recordId)]);
      }
      await db.batch([db.prepare(admissionTrigger),db.prepare(enrollmentTrigger)]);
    }
    if(name.startsWith("0058_")){
      for(const statement of statements){await db.prepare(statement).run();if(statement.includes("CREATE TABLE native_directory_enrollments")){
        await db.batch([
          db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,active,issued_by) VALUES('acquired-org-admission','staff-beau-koltz','access|migration-chain-reviewer',?,'organization','[{"businessAreaId":"acquired-area","divisionId":null}]',?,?,0,'staff-beau-koltz')`).bind(acquiredOrg,JSON.stringify(acquiredOrgProfile),JSON.stringify([{sourceId:acquiredDestination.sourceId,sourceInstanceUUID:acquiredDestination.sourceInstanceUUID,applicationUUID:acquiredDestination.applicationUUID,origin:acquiredDestination.origin,externalCanonicalId:acquiredOrg}])),
          db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,active,issued_by) VALUES('acquired-client-admission','staff-beau-koltz','access|migration-chain-reviewer',?,'client','[{"businessAreaId":"acquired-area","divisionId":null}]',?,?,0,'staff-beau-koltz')`).bind(acquiredClient,JSON.stringify({...acquiredClientProfile,clientType:"business"}),JSON.stringify([{sourceId:acquiredDestination.sourceId,sourceInstanceUUID:acquiredDestination.sourceInstanceUUID,applicationUUID:acquiredDestination.applicationUUID,origin:acquiredDestination.origin,externalCanonicalId:acquiredClient}])),
          db.prepare("INSERT INTO native_directory_enrollments(record_id,destinations_json,create_admission_id) SELECT record_id,destinations_json,id FROM native_directory_create_admissions WHERE id='acquired-org-admission'"),
          db.prepare("INSERT INTO native_directory_enrollments(record_id,destinations_json,create_admission_id) SELECT record_id,destinations_json,id FROM native_directory_create_admissions WHERE id='acquired-client-admission'")]);
      }}
    }else await db.batch(statements.map(statement=>db.prepare(statement)));
    if(name.startsWith("0057_"))await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('acquired-area','Acquired Area',1)").run();
    if(name.startsWith("0055_"))await db.batch([
      db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)").bind(acquiredOrg),
      db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(acquiredClient),
      db.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,'acquired-org-create',?)").bind(acquiredOrg,JSON.stringify(acquiredOrgProfile)),
      db.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,'acquired-client-create',?)").bind(acquiredClient,JSON.stringify(acquiredClientProfile))]);
  }
  assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results,[]);

  const acquisitionStaff="acquisition-reviewer",acquisitionSubject="access|acquisition-reviewer";
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(acquisitionStaff,"acquisition@example.test","Acquisition",acquisitionSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(acquisitionStaff,acquisitionSubject,acquisitionStaff),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(acquisitionStaff,"acquisition@example.test","Acquisition"),
    db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by) VALUES('acquisition-owner-role',?,'role-owner','global',NULL,'global',?)").bind(acquisitionStaff,acquisitionStaff),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES('acquisition-edit',?,'directory.profile.edit','allow','global',1,?)").bind(acquisitionStaff,acquisitionStaff),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES('acquisition-identity',?,'directory.identity.link','allow','global',1,?)").bind(acquisitionStaff,acquisitionStaff)]);
  const acquisitionBase={staffId:acquisitionStaff,subject:acquisitionSubject,sourceId:"project-alpha:primary",instance:"33333333-3333-4333-8333-333333333333",application:"44444444-4444-4444-8444-444444444444",epoch:"55555555-5555-4555-8555-555555555555"};
  const acquiredOrgActivation=await acquiredActivation(db,{...acquisitionBase,stem:"a",recordId:acquiredOrg,kind:"organization",externalId:acquiredOrg,publicId:"1".repeat(32)});
  const acquiredClientActivation=await acquiredActivation(db,{...acquisitionBase,stem:"b",recordId:acquiredClient,kind:"client",externalId:"pa-acquired-client",publicId:"2".repeat(32)});
  await acquiredRefresh(db,{...acquisitionBase,stem:"c",acquiredStem:"a",recordId:acquiredOrg,kind:"organization",externalId:acquiredOrg,publicId:"1".repeat(32)});
  await acquiredRefresh(db,{...acquisitionBase,stem:"d",acquiredStem:"b",recordId:acquiredClient,kind:"client",externalId:"pa-acquired-client",publicId:"2".repeat(32)});
  for(const [recordId,activation] of [[acquiredOrg,acquiredOrgActivation],[acquiredClient,acquiredClientActivation]]){
    const mapping=await db.prepare("SELECT * FROM project_alpha_active_directory_mappings WHERE record_id=? AND mapping_kind='acquired'").bind(recordId).first();
    const receipt=await db.prepare("SELECT * FROM project_alpha_existing_directory_binding_activation_receipts WHERE activation_id=?").bind(activation).first();
    assert.equal(mapping.provenance_id,activation);assert.equal(receipt.record_id,recordId);assert.equal(mapping.external_id,receipt.external_id);
  }
  const acquiredEnv={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[acquiredDestination.sourceId]:{
    sourceId:acquiredDestination.sourceId,enabled:true,baseUrl:acquiredDestination.origin,apiKey:"local-test-only",
    sourceInstanceId:acquiredDestination.sourceInstanceUUID,applicationId:acquiredDestination.applicationUUID,historyEpoch:acquiredDestination.historyEpoch}}})};
  const relationshipMutation="99999999-9999-4999-8999-999999999999";
  const relationshipActor={staffId:acquisitionStaff,accessSubject:acquisitionSubject,email:"acquisition@example.test",admissionVersion:1,profileVersion:1};
  const initialRelationshipMutation="99999999-9999-4999-8999-999999999998",verifiedUntil=new Date(Date.now()+60_000).toISOString();
  await db.batch([db.prepare(`INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,
      expected_relationship_version,previous_organization_record_id,organization_record_id,client_record_version,
      previous_organization_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,
      actor_admission_version,actor_profile_version,verified_until) VALUES(?,?,0,NULL,NULL,1,NULL,NULL,?,?,?,?,?,?)`)
      .bind(initialRelationshipMutation,acquiredClient,acquisitionStaff,acquisitionSubject,relationshipActor.email,1,1,verifiedUntil),
    db.prepare("INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version) VALUES(?,NULL,1)").bind(acquiredClient),
    db.prepare("DELETE FROM operations_directory_relationship_write_fences WHERE mutation_id=?").bind(initialRelationshipMutation)]);
  const acquiredRevisionEvidence=await rows(db,"SELECT * FROM project_alpha_directory_relationship_revision_evidence WHERE record_id IN (?,?) ORDER BY record_id",acquiredClient,acquiredOrg);
  const linked=await relationshipWriter.writeNativeDirectoryRelationship(db,{mutationId:relationshipMutation,clientRecordId:acquiredClient,
    expectedRelationshipVersion:1,expectedClientRecordVersion:1,previousOrganization:null,
    organization:{recordId:acquiredOrg,expectedRecordVersion:1},actor:relationshipActor});
  if(linked.status!=="written")throw new Error(`relationship writer: ${JSON.stringify({linked,acquiredRevisionEvidence})}`);
  assert.equal(linked.relationshipVersion,2);
  assert.equal(linked.reservations.length,1);
  const relationshipReservation=linked.reservations[0],relationshipRequest="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal(relationshipReservation.command.expectedClientRevision,"8");
  assert.equal(relationshipReservation.command.expectedAuthorizationGeneration,"2");
  const relationshipPosts=[];
  const relationshipSend=async(url,init)=>{
    if(String(url).endsWith("/capabilities"))return Response.json({apiVersion:"2",sourceInstanceId:acquiredDestination.sourceInstanceUUID,
      applicationId:acquiredDestination.applicationUUID,historyEpoch:acquiredDestination.historyEpoch,requestId:relationshipRequest,
      grantedCapabilities:[{name:"api.capabilities.read"},{name:"directory.clients.organization.assign"}],implementedEndpoints:[
        {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
        {method:"POST",path:"/api/v2/directory/clients/{publicId}/organization/assign/commands",requiredCapability:"directory.clients.organization.assign",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]},
      {headers:{"Cache-Control":"no-store","X-Request-ID":relationshipRequest}});
    relationshipPosts.push(JSON.parse(String(init?.body)));
    return Response.json({sourceInstanceId:acquiredDestination.sourceInstanceUUID,applicationId:acquiredDestination.applicationUUID,
      historyEpoch:acquiredDestination.historyEpoch,requestId:relationshipRequest,replayed:false,result:{action:"assign",
        client:{publicId:"2".repeat(32),revision:"9"},organizationPublicId:"1".repeat(32),authorizationGeneration:"3"}},
      {headers:{"Cache-Control":"no-store","X-Request-ID":relationshipRequest}});
  };
  const relationshipAck=await relationshipDispatcher.dispatchProjectAlphaDirectoryRelationshipCommand(acquiredEnv,acquiredDestination.sourceId,
    relationshipReservation.commandId,relationshipSend);
  assert.deepEqual(relationshipAck,{status:"acknowledged",commandId:relationshipReservation.commandId,replayed:false,
    clientPublicId:"2".repeat(32),revision:"9"});
  assert.deepEqual(relationshipPosts,[relationshipReservation.command]);
  assert.deepEqual(await db.prepare("SELECT organization_record_id,relationship_version FROM operations_directory_client_organizations WHERE client_record_id=?")
    .bind(acquiredClient).first(),{organization_record_id:acquiredOrg,relationship_version:2});
  await acquiredRefreshSuccessor(db,{...acquisitionBase,recordId:acquiredClient,externalId:"pa-acquired-client",publicId:"2".repeat(32)});
  const acquiredEvidenceContext={record_id:acquiredClient,external_id:"pa-acquired-client",source_id:acquiredDestination.sourceId,
    expected_source_instance_id:acquiredDestination.sourceInstanceUUID,application_id:acquiredDestination.applicationUUID,
    expected_history_epoch_id:acquiredDestination.historyEpoch,resource_type:"client",destination_base_url:acquiredDestination.origin,record_version:2};
  assert.equal(await dispatcher.acquiredDirectoryMappingUpdateEvidence(db,acquiredEvidenceContext,"9","3","2".repeat(32)),true);
  assert.equal(await dispatcher.acquiredDirectoryMappingUpdateEvidence(db,acquiredEvidenceContext,"8","2","2".repeat(32)),false);
  assert.equal(await dispatcher.acquiredDirectoryMappingUpdateEvidence(db,acquiredEvidenceContext,"9","3","3".repeat(32)),false);
  const conflictingRefreshDb=new Proxy(db,{get(target,property){if(property!=="prepare")return typeof target[property]==="function"?target[property].bind(target):target[property];
    return sql=>{const statement=target.prepare(sql);if(!sql.includes("FROM project_alpha_existing_directory_binding_revision_refresh_receipts refresh"))return statement;
      return{bind(...values){const bound=statement.bind(...values);return{async all(){const result=await bound.all();return{...result,results:[...result.results,{revision:"9",authorization_generation:"4"}]}}}}};}}});
  assert.equal(await dispatcher.acquiredDirectoryMappingUpdateEvidence(conflictingRefreshDb,acquiredEvidenceContext,"9","3","2".repeat(32)),false);
  const deliveredEvidenceDb=revisionValue=>new Proxy(db,{get(target,property){if(property!=="prepare")return typeof target[property]==="function"?target[property].bind(target):target[property];
    return sql=>{const statement=target.prepare(sql);if(!sql.includes("FROM operations_directory_intents intent")||!sql.includes("record_version=?"))return statement;
      return{bind(...values){return{async all(){return{results:[{revision:revisionValue,authorization_generation:"3"}],success:true}}}}};}}});
  assert.equal(await dispatcher.acquiredDirectoryMappingUpdateEvidence(deliveredEvidenceDb("8"),acquiredEvidenceContext,"9","3","2".repeat(32)),true);
  assert.equal(await dispatcher.acquiredDirectoryMappingUpdateEvidence(deliveredEvidenceDb("10"),acquiredEvidenceContext,"10","3","2".repeat(32)),true);
  const refreshEvidenceDb=value=>new Proxy(db,{get(target,property){if(property!=="prepare")return typeof target[property]==="function"?target[property].bind(target):target[property];
    return sql=>{const statement=target.prepare(sql);if(!sql.includes("SELECT refresh.live_revision revision"))return statement;
      return{bind(...values){return{async all(){return{results:value===undefined?[]:[value],success:true}}}}};}}});
  assert.equal(await dispatcher.acquiredDirectoryMappingUpdateEvidence(refreshEvidenceDb(undefined),acquiredEvidenceContext,"9","3","2".repeat(32)),false);
  for(const malformed of [{revision:9,authorization_generation:"3"},{revision:"9",authorization_generation:null},
    {revision:"9223372036854775808",authorization_generation:"3"}])
    assert.equal(await dispatcher.acquiredDirectoryMappingUpdateEvidence(refreshEvidenceDb(malformed),acquiredEvidenceContext,"9","3","2".repeat(32)),false);
  await db.batch([
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,active,granted_by) VALUES('acquired-temp-edit',?,'directory.profile.edit','allow','resource',?,1,?)").bind(acquisitionStaff,acquiredClient,acquisitionStaff),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,active,granted_by) VALUES('acquired-temp-identity',?,'directory.identity.link','allow','resource',?,1,?)").bind(acquisitionStaff,acquiredClient,acquisitionStaff)]);
  const acquiredUpdateMutation="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",acquiredAfterProfile={...acquiredClientProfile,email:"updated-client@example.test"};
  const acquiredProfileActor={staffId:acquisitionStaff,accessSubject:acquisitionSubject,admissionVersion:1,
    selectedGrantId:"acquired-temp-edit",loginEmail:"acquisition@example.test",profileVersion:1,selectedIdentityGrantId:"acquired-temp-identity"};
  const acquiredTableSnapshot=async()=>{
    const relationshipDependencies=await rows(db,`SELECT d.intent_id,d.client_record_id,d.client_record_version,d.relationship_version,
      d.relationship_mutation_id,d.organization_record_id,d.organization_record_version,d.source_id,d.source_instance_uuid,d.application_uuid,
      d.history_epoch_id,d.destination_origin,d.parent_external_canonical_id,d.evidence_kind,d.parent_intent_id,d.parent_mapping_command_id,
      d.parent_activation_id,d.parent_public_id,d.parent_ack_revision,d.parent_ack_command_json,d.parent_ack_outcome_json,r.resolved_parent_public_id
      FROM operations_directory_intent_relationship_dependencies d
      JOIN operations_directory_intent_relationship_resolved r ON r.intent_id=d.intent_id WHERE d.client_record_id=? ORDER BY d.intent_id`,acquiredClient);
    const relationshipDependencyEvidence=[];
    for(const dependency of relationshipDependencies.filter(value=>value.evidence_kind==="acquired_mapping"))relationshipDependencyEvidence.push({intent_id:dependency.intent_id,
      activeMapping:(await rows(db,"SELECT * FROM project_alpha_active_directory_mappings WHERE provenance_id=? AND record_id=?",dependency.parent_activation_id,dependency.organization_record_id))[0],
      activationReceipt:(await rows(db,"SELECT * FROM project_alpha_existing_directory_binding_activation_receipts WHERE activation_id=?",dependency.parent_activation_id))[0]});
    return{record:(await rows(db,"SELECT record_id,record_kind,current_version FROM operations_directory_records WHERE record_id=?",acquiredClient))[0],
      revisions:await rows(db,"SELECT record_id,version,mutation_id,profile_json FROM operations_directory_revisions WHERE record_id=? ORDER BY version",acquiredClient),
      audits:await rows(db,"SELECT audit_id,mutation_id,record_id,record_version,actor_type,actor_id,original_verified_access_subject,command_json FROM operations_directory_audit WHERE record_id=? ORDER BY record_version",acquiredClient),
      intents:await rows(db,"SELECT intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,application_uuid,expected_history_epoch_id,destination_origin,external_canonical_id,desired_payload_json,state FROM operations_directory_intents WHERE record_id=? ORDER BY record_version",acquiredClient),
      materializations:await rows(db,`SELECT m.intent_id,m.command_id,m.command_json,m.origin_snapshot_json,m.disposition_json,m.history_epoch_id FROM operations_directory_materializations m JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=? ORDER BY i.record_version`,acquiredClient),
      outbox:await rows(db,`SELECT o.command_id,o.source_id,o.application_id,o.resource_type,o.external_id,o.command_json,o.destination_base_url,o.expected_source_instance_id,o.expected_history_epoch_id,o.origin_snapshot_json,o.state,o.outcome_json FROM project_alpha_directory_outbox o JOIN operations_directory_materializations m ON m.command_id=o.command_id JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=? ORDER BY i.record_version`,acquiredClient),
      relationshipDependencies,relationshipDependencyEvidence,
      relationship:await db.prepare("SELECT client_record_id,organization_record_id,relationship_version,created_at,updated_at FROM operations_directory_client_organizations WHERE client_record_id=?").bind(acquiredClient).first(),
      relationshipHistory:await rows(db,"SELECT client_record_id,relationship_version,mutation_id FROM operations_directory_client_organization_history WHERE client_record_id=? ORDER BY relationship_version",acquiredClient),
      resourceScopes:await rows(db,"SELECT record_id,scope_kind,business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id=? ORDER BY scope_kind",acquiredClient),
      enrollment:await db.prepare("SELECT record_id,destinations_json FROM native_directory_enrollments WHERE record_id=?").bind(acquiredClient).first(),
      protectedSnapshots:{records:await rows(db,"SELECT record_id,record_kind,current_version FROM operations_directory_records WHERE record_id<>? ORDER BY record_id",acquiredClient),
        resourceScopes:await rows(db,"SELECT record_id,scope_kind,business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id<>? ORDER BY record_id,scope_kind",acquiredClient),
        enrollments:await rows(db,"SELECT record_id,destinations_json FROM native_directory_enrollments WHERE record_id<>? ORDER BY record_id",acquiredClient),
        relationships:await rows(db,"SELECT client_record_id,organization_record_id,relationship_version FROM operations_directory_client_organizations ORDER BY client_record_id"),
        relationshipHistory:await rows(db,"SELECT client_record_id,relationship_version,mutation_id FROM operations_directory_client_organization_history ORDER BY client_record_id,relationship_version")}};
  };
  const acquiredBefore=await acquiredTableSnapshot();
  const acquiredUpdated=await writer.writeNativeDirectoryProfile(db,{operation:"update",mutationId:acquiredUpdateMutation,
    recordId:acquiredClient,expectedLocalVersion:1,kind:"client",profile:acquiredAfterProfile,
    relationship:{organizationRecordId:acquiredOrg,expectedRelationshipVersion:2},
    destinations:[{...acquiredDestination,externalCanonicalId:"pa-acquired-client",expectedAuthorizationGeneration:"3"}],actor:acquiredProfileActor});
  if(acquiredUpdated.status!=="written")throw new Error(`acquired client profile writer: ${JSON.stringify(acquiredUpdated)}`);
  const acquiredUpdateCommand=acquiredUpdated.commandIds[0],acquiredWire=JSON.parse(await db.prepare("SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?")
    .bind(acquiredUpdateCommand).first("command_json"));
  assert.deepEqual(acquiredWire,{commandId:acquiredUpdateCommand,operation:"update",resourceType:"client",externalId:"pa-acquired-client",
    expectedRevision:"9",expectedAuthorizationGeneration:"3",expectedProjectAlphaPublicId:"2".repeat(32),
    fields:{...acquiredAfterProfile,organizationPublicId:"1".repeat(32)}});
  const acquiredProfileRequest="ffffffff-ffff-4fff-8fff-ffffffffffff",acquiredProfilePosts=[];
  const acquiredProfileSend=async(url,init)=>{
    if(String(url).endsWith("/capabilities"))return Response.json({apiVersion:"2",sourceInstanceId:acquiredDestination.sourceInstanceUUID,
      applicationId:acquiredDestination.applicationUUID,historyEpoch:acquiredDestination.historyEpoch,requestId:acquiredProfileRequest,
      grantedCapabilities:[{name:"api.capabilities.read"},{name:"directory.clients.write"}],implementedEndpoints:[
        {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
        {method:"POST",path:"/api/v2/directory/clients/{publicId}/profile/commands",requiredCapability:"directory.clients.write",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]},
      {headers:{"Cache-Control":"no-store","X-Request-ID":acquiredProfileRequest}});
    acquiredProfilePosts.push(JSON.parse(String(init?.body)));
    return Response.json({sourceInstanceId:acquiredDestination.sourceInstanceUUID,applicationId:acquiredDestination.applicationUUID,
      historyEpoch:acquiredDestination.historyEpoch,requestId:acquiredProfileRequest,replayed:false,result:{resource:{type:"client",
        publicId:"2".repeat(32),revision:"10"},authorizationGeneration:"3"}},
      {headers:{"Cache-Control":"no-store","X-Request-ID":acquiredProfileRequest}});
  };
  const acquiredProfileAck=await dispatcher.dispatchProjectAlphaDirectoryProfileOutboxCommand(acquiredEnv,acquiredDestination.sourceId,
    acquiredUpdateCommand,acquiredProfileSend);
  assert.deepEqual(acquiredProfileAck,{status:"acknowledged",commandId:acquiredUpdateCommand,replayed:false,publicId:"2".repeat(32),revision:"10"});
  assert.deepEqual(acquiredProfilePosts,[{commandId:acquiredUpdateCommand,expectedRevision:"9",expectedAuthorizationGeneration:"3",profile:acquiredAfterProfile}]);
  const acquiredSettled=await acquiredTableSnapshot(),clientMapping=await db.prepare("SELECT * FROM project_alpha_active_directory_mappings WHERE record_id=?").bind(acquiredClient).first(),
    clientActivation=await db.prepare("SELECT * FROM project_alpha_existing_directory_binding_activation_receipts WHERE activation_id=?").bind(acquiredClientActivation).first();
  const clientRefreshReceipts=await rows(db,"SELECT * FROM project_alpha_existing_directory_binding_revision_refresh_receipts WHERE record_id=? ORDER BY received_at,receipt_id",acquiredClient),clientRefreshes=[];
  for(const receipt of clientRefreshReceipts)clientRefreshes.push({command:await db.prepare("SELECT * FROM project_alpha_existing_directory_binding_revision_refresh_commands WHERE command_id=?").bind(receipt.command_id).first(),receipt});
  const acquiredPlan={recordId:acquiredClient,kind:"client",mutationId:acquiredUpdateMutation,actor:acquiredProfileActor,expectedLocalVersion:1,
    field:"email",beforeProfile:acquiredClientProfile,afterProfile:acquiredAfterProfile,destinations:[{...acquiredDestination,
      enrollmentExternalCanonicalId:"pa-acquired-client",externalCanonicalId:"pa-acquired-client",projectAlphaPublicId:"2".repeat(32),revision:"9",
      authorizationGeneration:"3",expectedAuthorizationGeneration:"3",acquisitionEvidence:{activeMapping:clientMapping,
        authoritativeHeadEvidence:{schemaVersion:1,activationReceipt:clientActivation,refreshes:clientRefreshes,deliveries:[]}}}],
    temporaryGrantIds:{profileEdit:"acquired-temp-edit",identityLink:"acquired-temp-identity"}};
  const acquiredSettlement={plan:acquiredPlan,before:acquiredBefore,settled:acquiredSettled};
  assert.deepEqual(validateAcknowledgedScalarUpdate(acquiredSettlement),
    {status:"acknowledged",mutationId:acquiredUpdateMutation,version:2,destinations:1});
  const acquiredGrantProjection=()=>rows(db,"SELECT id,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,granted_by,created_at FROM native_directory_grants WHERE id IN ('acquired-temp-edit','acquired-temp-identity') ORDER BY id");
  const acquiredHistoryProjection=()=>rows(db,"SELECT grant_id,grant_version,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,grant_generation FROM native_directory_grant_history WHERE grant_id IN ('acquired-temp-edit','acquired-temp-identity') ORDER BY grant_id,grant_version");
  const acquiredCleanupProtected=async()=>({
    otherGrants:await rows(db,"SELECT id,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,granted_by,created_at FROM native_directory_grants WHERE id NOT IN ('acquired-temp-edit','acquired-temp-identity') ORDER BY id"),
    actorAdmission:await rows(db,"SELECT staff_id,bound_access_subject,active,admitted_by,version,created_at,updated_at FROM native_staff_admissions WHERE staff_id=?",acquisitionStaff),
    actorProfile:await rows(db,"SELECT staff_id,login_email,display_name,version,created_at,updated_at FROM native_staff_profiles WHERE staff_id=?",acquisitionStaff),
    otherGrantGenerations:await rows(db,"SELECT staff_id,generation,updated_at FROM native_directory_grant_generations WHERE staff_id<>? ORDER BY staff_id",acquisitionStaff)});
  const acquiredAcknowledged={grants:await acquiredGrantProjection(),grantGeneration:await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?").bind(acquisitionStaff).first("generation"),
    grantHistory:await acquiredHistoryProjection(),settlementSnapshot:{plan:clone(acquiredPlan),before:clone(acquiredBefore),settled:await acquiredTableSnapshot()},protectedSnapshots:await acquiredCleanupProtected()};
  await db.batch([db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='acquired-temp-edit' AND active=1"),
    db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='acquired-temp-identity' AND active=1")]);
  const acquiredCleaned={grants:await acquiredGrantProjection(),grantGeneration:await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?").bind(acquisitionStaff).first("generation"),
    grantHistory:await acquiredHistoryProjection(),settlementSnapshot:{plan:clone(acquiredPlan),before:clone(acquiredBefore),settled:await acquiredTableSnapshot()},protectedSnapshots:await acquiredCleanupProtected()};
  assert.equal(validatePairedGrantCleanup({settlement:acquiredSettlement,acknowledged:acquiredAcknowledged,cleaned:acquiredCleaned}).status,"cleaned");

  const staffId="scalar-settlement-staff",subject="access|scalar-settlement",recordId="scalar-settlement-organization";
  const sourceId="project-alpha:staging",sourceInstanceUUID="11111111-1111-4111-8111-111111111111";
  const applicationUUID="22222222-2222-4222-8222-222222222222",historyEpoch="33333333-3333-4333-8333-333333333333";
  const origin="https://pa.example.test",createMutation="44444444-4444-4444-8444-444444444444";
  const updateMutation="55555555-5555-4555-8555-555555555555",publicId="a".repeat(32);
  const beforeProfile={name:"Actual Writer Organization",generalEmail:"before@example.test",generalPhone:"512-555-0100",
    addressLine1:"1 Main",addressLine2:"",city:"Austin",state:"Texas",postalCode:"78701",country:"US"};
  const afterProfile={...beforeProfile,generalEmail:"after@example.test"};
  const enrolled={sourceId,sourceInstanceUUID,applicationUUID,historyEpoch,origin,externalCanonicalId:recordId};
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(staffId,"scalar@example.test","Scalar",subject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(staffId,subject,staffId),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(staffId,"scalar@example.test","Scalar"),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('scalar-area','Scalar Area',1)"),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES('create-edit',?,'directory.profile.edit','allow','global',1,?)").bind(staffId,staffId),
  ]);
  const createActor={staffId,accessSubject:subject,admissionVersion:1,selectedGrantId:"create-edit",loginEmail:"scalar@example.test",profileVersion:1,selectedIdentityGrantId:"create-edit"};
  await db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES('scalar-admission',?,?,?,'organization',?,?,?,?)`).bind(staffId,subject,recordId,
      JSON.stringify([{businessAreaId:"scalar-area",divisionId:null}]),JSON.stringify(beforeProfile),JSON.stringify([enrolled]),staffId).run();
  const created=await writer.writeNativeDirectoryProfile(db,{operation:"create",mutationId:createMutation,recordId,expectedLocalVersion:0,
    kind:"organization",createAdmissionId:"scalar-admission",profile:beforeProfile,scopes:[{businessAreaId:"scalar-area",divisionId:null}],
    destinations:[{...enrolled,expectedAuthorizationGeneration:"0"}],actor:createActor});
  assert.equal(created.status,"written"); const createCommand=created.commandIds[0];
  await db.batch([
    db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',lease_token='create-lease',lease_expires_at=9999999999999 WHERE command_id=?").bind(createCommand),
    db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      VALUES(?,'organization',?,?,?,?,?,?)`).bind(sourceId,recordId,publicId,sourceInstanceUUID,applicationUUID,historyEpoch,createCommand),
    db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?")
      .bind(JSON.stringify({status:"acknowledged",response:{sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch,
        requestId:createCommand,replayed:false,result:{resource:{type:"organization",id:recordId,publicId,revision:"1"},authorizationGeneration:"1",data:{publicId}}}}),createCommand),
    db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=?").bind(createMutation),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,active,granted_by) VALUES('temp-edit',?,'directory.profile.edit','allow','resource',?,1,?)").bind(staffId,recordId,staffId),
  ]);
  const actor={...createActor,selectedGrantId:"temp-edit",selectedIdentityGrantId:"temp-edit"};
  const tableSnapshot=async()=>({
    record:(await rows(db,"SELECT record_id,record_kind,current_version FROM operations_directory_records WHERE record_id=?",recordId))[0],
    revisions:await rows(db,"SELECT record_id,version,mutation_id,profile_json FROM operations_directory_revisions WHERE record_id=? ORDER BY version",recordId),
    audits:await rows(db,"SELECT audit_id,mutation_id,record_id,record_version,actor_type,actor_id,original_verified_access_subject,command_json FROM operations_directory_audit WHERE record_id=? ORDER BY record_version",recordId),
    intents:await rows(db,"SELECT intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,application_uuid,expected_history_epoch_id,destination_origin,external_canonical_id,desired_payload_json,state FROM operations_directory_intents WHERE record_id=? ORDER BY record_version",recordId),
    materializations:await rows(db,`SELECT m.intent_id,m.command_id,m.command_json,m.origin_snapshot_json,m.disposition_json,m.history_epoch_id FROM operations_directory_materializations m JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=? ORDER BY i.record_version`,recordId),
    outbox:await rows(db,`SELECT o.command_id,o.source_id,o.application_id,o.resource_type,o.external_id,o.command_json,o.destination_base_url,o.expected_source_instance_id,o.expected_history_epoch_id,o.origin_snapshot_json,o.state,o.outcome_json FROM project_alpha_directory_outbox o JOIN operations_directory_materializations m ON m.command_id=o.command_id JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=? ORDER BY i.record_version`,recordId),
    relationshipDependencies:[],relationshipDependencyEvidence:[],relationship:null,relationshipHistory:[],
    resourceScopes:await rows(db,"SELECT record_id,scope_kind,business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id=? ORDER BY scope_kind",recordId),
    enrollment:(await rows(db,"SELECT record_id,destinations_json FROM native_directory_enrollments WHERE record_id=?",recordId))[0],
    protectedSnapshots:{
      records:await rows(db,"SELECT record_id,record_kind,current_version FROM operations_directory_records WHERE record_id<>? ORDER BY record_id",recordId),
      resourceScopes:await rows(db,"SELECT record_id,scope_kind,business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id<>? ORDER BY record_id,scope_kind",recordId),
      enrollments:await rows(db,"SELECT record_id,destinations_json FROM native_directory_enrollments WHERE record_id<>? ORDER BY record_id",recordId),
      relationships:await rows(db,"SELECT client_record_id,organization_record_id,relationship_version FROM operations_directory_client_organizations ORDER BY client_record_id"),
      relationshipHistory:await rows(db,"SELECT client_record_id,relationship_version,mutation_id FROM operations_directory_client_organization_history ORDER BY client_record_id,relationship_version")},
  });
  const before=await tableSnapshot();
  const updated=await writer.writeNativeDirectoryProfile(db,{operation:"update",mutationId:updateMutation,recordId,expectedLocalVersion:1,
    kind:"organization",profile:afterProfile,destinations:[{...enrolled,expectedAuthorizationGeneration:"1"}],actor});
  assert.equal(updated.status,"written");const updateCommand=updated.commandIds[0];
  const wire=JSON.parse(await db.prepare("SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?").bind(updateCommand).first("command_json"));
  assert.equal(wire.expectedRevision,"1");
  const requestId="66666666-6666-4666-8666-666666666666",posts=[];
  const send=async(url,init)=>{const pathname=new URL(String(url)).pathname;
    if(pathname.endsWith("/capabilities"))return Response.json({apiVersion:"2",sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,
      historyEpoch,requestId,grantedCapabilities:[{name:"api.capabilities.read"},{name:"directory.organizations.write"}],implementedEndpoints:[
        {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
        {method:"POST",path:"/api/v2/directory/organizations/{publicId}/profile/commands",requiredCapability:"directory.organizations.write",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]},
      {headers:{"Cache-Control":"no-store","X-Request-ID":requestId}});
    posts.push(JSON.parse(String(init?.body)));return Response.json({sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch,requestId,replayed:false,
      result:{resource:{type:"organization",publicId,revision:"2"},authorizationGeneration:"1"}},
      {headers:{"Cache-Control":"no-store","X-Request-ID":requestId}})};
  const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{sourceId,enabled:true,baseUrl:origin,
    apiKey:"local-test-only",sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch}}})};
  const dispatched=await dispatcher.dispatchProjectAlphaDirectoryProfileOutboxCommand(env,sourceId,updateCommand,send);
  assert.deepEqual(dispatched,{status:"acknowledged",commandId:updateCommand,replayed:false,publicId,revision:"2"});
  assert.deepEqual(posts,[{commandId:updateCommand,expectedRevision:"1",expectedAuthorizationGeneration:"1",profile:afterProfile}]);
  const settled=await tableSnapshot();
  const plan={recordId,kind:"organization",mutationId:updateMutation,actor,expectedLocalVersion:1,field:"generalEmail",beforeProfile,afterProfile,
    destinations:[{sourceId,sourceInstanceUUID,applicationUUID,historyEpoch,origin,enrollmentExternalCanonicalId:recordId,externalCanonicalId:recordId,
      projectAlphaPublicId:publicId,revision:"1",authorizationGeneration:"1",expectedAuthorizationGeneration:"1",acquisitionEvidence:null}],temporaryGrantIds:{profileEdit:"temp-edit"}};
  const settlement={plan,before,settled};
  assert.deepEqual(validateAcknowledgedScalarUpdate(settlement),{status:"acknowledged",mutationId:updateMutation,version:2,destinations:1});

  const grantProjection=()=>rows(db,"SELECT id,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,granted_by,created_at FROM native_directory_grants WHERE id='temp-edit'");
  const historyProjection=()=>rows(db,"SELECT grant_id,grant_version,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,grant_generation FROM native_directory_grant_history WHERE grant_id='temp-edit' ORDER BY grant_version");
  const cleanupProtected=async()=>({
    otherGrants:await rows(db,"SELECT id,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,granted_by,created_at FROM native_directory_grants WHERE id<>'temp-edit' ORDER BY id"),
    actorAdmission:await rows(db,"SELECT staff_id,bound_access_subject,active,admitted_by,version,created_at,updated_at FROM native_staff_admissions WHERE staff_id=?",staffId),
    actorProfile:await rows(db,"SELECT staff_id,login_email,display_name,version,created_at,updated_at FROM native_staff_profiles WHERE staff_id=?",staffId),
    otherGrantGenerations:await rows(db,"SELECT staff_id,generation,updated_at FROM native_directory_grant_generations WHERE staff_id<>? ORDER BY staff_id",staffId)});
  const acknowledged={grants:await grantProjection(),grantGeneration:await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?").bind(staffId).first("generation"),
    grantHistory:await historyProjection(),settlementSnapshot:{plan:clone(plan),before:clone(before),settled:await tableSnapshot()},protectedSnapshots:await cleanupProtected()};
  await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='temp-edit' AND active=1").run();
  const cleaned={grants:await grantProjection(),grantGeneration:await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?").bind(staffId).first("generation"),
    grantHistory:await historyProjection(),settlementSnapshot:{plan:clone(plan),before:clone(before),settled:await tableSnapshot()},protectedSnapshots:await cleanupProtected()};
  assert.equal(validatePairedGrantCleanup({settlement,acknowledged,cleaned}).status,"cleaned");
  const drift=clone(settlement);drift.settled.outbox[1].destination_base_url="https://wrong.example.test";
  assert.throws(()=>validateAcknowledgedScalarUpdate(drift),/outbox identity/);
}
test("full 0001-0184 schema settles acquired linked-client and organization updates before exact grant cleanup",{timeout:240_000},async t=>{
  try{return await fullSchema(t)}catch(error){process.stderr.write(`${error?.stack??error}\n`);throw error}
});
