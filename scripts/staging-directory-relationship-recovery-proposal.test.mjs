import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const migrations = path.join(root, "apps/operations/migrations");
const read = filename => fs.readFileSync(filename, "utf8").replace(/\r\n/g, "\n");
const original = read(path.join(migrations, "0172_project_alpha_active_directory_consumer_guards.sql"));
const recovery = read(path.join(migrations, "0181_project_alpha_directory_create_generation_recovery.sql"));
const proposal = read(path.join(root, "scripts/proposals/0182_project_alpha_directory_relationship_recovery_guard.sql"));
const liveStart = "DROP VIEW project_alpha_directory_live_relationship_commands;";
const revisionStart = "DROP VIEW project_alpha_directory_relationship_revision_evidence;";
const revisionComment = "-- The 0181 recovery-aware revision view";

test("local relationship proposal changes exactly one pending source in the live-command view", () => {
  const originalBody = original.slice(original.indexOf(liveStart)).trim();
  const proposalBody = proposal.slice(proposal.indexOf(liveStart), proposal.indexOf(revisionComment)).trim();
  assert.ok(originalBody.startsWith(liveStart));
  assert.equal(originalBody.split("project_alpha_directory_outbox pending").length, 2);
  assert.equal(proposalBody, originalBody.replace(
    "project_alpha_directory_outbox pending", "project_alpha_directory_unsettled_commands pending"));
});

test("revision-evidence proposal changes only the materialized acknowledgement identity predicate", () => {
  const originalBody = recovery.slice(recovery.indexOf(revisionStart)).trim();
  const proposalBody = proposal.slice(proposal.indexOf(revisionStart)).trim();
  const predicate = "  CASE WHEN json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid";
  const unchangedTail = "FROM operations_directory_intents intent";
  assert.equal(proposalBody.slice(0, proposalBody.indexOf(predicate)), originalBody.slice(0, originalBody.indexOf(predicate)));
  assert.equal(proposalBody.slice(proposalBody.indexOf(unchangedTail)), originalBody.slice(originalBody.indexOf(unchangedTail)));
  assert.match(proposalBody, /CASE json_extract\(materialization\.command_json,'\$\.operation'\)[\s\S]*WHEN 'create'[\s\S]*WHEN 'update'[\s\S]*ELSE 0 END/);
  assert.match(proposalBody, /materialization\.command_json=outbox\.command_json/);
  assert.match(proposalBody, /expectedProjectAlphaPublicId/);
  assert.match(proposalBody, /project_alpha_active_directory_mappings mapping/);
  assert.match(proposalBody, /requestId'\),15,1\)='4'/);
  assert.match(proposalBody, /requestId'\),20,1\) GLOB '\[89ab\]'/);
  assert.match(proposalBody, /replace\(json_extract\(outbox\.outcome_json,'\$\.response\.requestId'\),'-',''\) NOT GLOB '\*\[\^0-9a-f\]\*'/);
  assert.match(proposalBody, /authorizationGeneration'[\s\S]*9223372036854775807/);
  assert.match(proposalBody, /resource\.revision'[\s\S]*>=\s*json_extract\(materialization\.command_json,'\$\.expectedRevision'\)/);
  assert.doesNotMatch(proposalBody, /expectedRevision'[\s\S]{0,300}CAST\(CAST/);
});

test("complete canonical schema accepts proposal and preserves the existing relationship insert guard", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const names = fs.readdirSync(migrations).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    assert.equal(names.length, 181);
    assert.equal(names.at(-1), "0181_project_alpha_directory_create_generation_recovery.sql");
    for (const name of names) db.exec(read(path.join(migrations, name)));
    const before = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='project_alpha_directory_relationship_outbox_insert_guard'").get();
    assert.ok(before?.sql.includes("project_alpha_directory_live_relationship_commands"));
    db.exec(proposal);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='project_alpha_directory_relationship_outbox_insert_guard'").get(), before);
    const view = db.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='project_alpha_directory_live_relationship_commands'").get();
    assert.ok(view.sql.includes("project_alpha_directory_unsettled_commands pending"));
    assert.ok(!view.sql.includes("project_alpha_directory_outbox pending"));
    const revisions = db.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='project_alpha_directory_relationship_revision_evidence'").get();
    assert.ok(revisions.sql.includes("WHEN 'create'"));
    assert.ok(revisions.sql.includes("WHEN 'update'"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

function behavioralFixture({kind="acquired",opsId="ops/client/42",paExternalId="pa/client/existing-7",
  operation="create",intentVersion=2,currentVersion=2,activationVersion=2}={}) {
  const db=new DatabaseSync(":memory:");
  const names=fs.readdirSync(migrations).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
  for(const name of names)db.exec(read(path.join(migrations,name)));
  db.exec(proposal);
  // Seed immutable outputs of independently tested producers. The view under
  // test must still authenticate their complete coordinate/receipt pairing.
  db.exec("PRAGMA foreign_keys=OFF");
  for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all())db.exec(`DROP TRIGGER \"${name}\"`);
  const source="project-alpha:staging",instance="22222222-2222-4222-8222-222222222222",app="33333333-3333-4333-8333-333333333333",epoch="44444444-4444-4444-8444-444444444444",origin="https://pa.example.test",pub="0123456789abcdef0123456789abcdef",commandId="55555555-5555-4555-8555-555555555555",receipt="66666666-6666-4666-8666-666666666666",activation="77777777-7777-4777-8777-777777777777";
  const transportExternalId=kind==="acquired"?paExternalId:opsId;
  db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',?)").run(opsId,currentVersion);
  db.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(? ,?,'mutation','{}')").run(opsId,intentVersion);
  db.prepare(`INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,application_uuid,destination_origin,external_canonical_id,desired_payload_json,state,expected_history_epoch_id)
    VALUES('intent','mutation',?,?,?,?,?,?,?,'{}','acknowledged',?)`).run(opsId,intentVersion,source,instance,app,origin,transportExternalId,epoch);
  const command=operation==="create"
    ? JSON.stringify({operation:"create",commandId,resourceType:"client",externalId:transportExternalId,expectedRevision:"0",expectedAuthorizationGeneration:"4",fields:{name:"Exact"}})
    : JSON.stringify({operation:"update",commandId,resourceType:"client",externalId:transportExternalId,expectedProjectAlphaPublicId:pub,expectedRevision:"1",expectedAuthorizationGeneration:"5",fields:{name:"Updated",organizationPublicId:null}});
  db.prepare(`INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,disposition_json,next_attempt_at,history_epoch_id)
    VALUES('intent',?,?,'{}','{}',0,?)`).run(commandId,command,epoch);
  const resource=operation==="create"?{id:kind==="legacy"?opsId:paExternalId,type:"client",publicId:pub,revision:"1"}:{type:"client",publicId:pub,revision:"2"};
  const outcome=JSON.stringify({status:"acknowledged",response:{requestId:"88888888-8888-4888-8888-888888888888",replayed:false,sourceInstanceId:instance,applicationId:app,historyEpoch:epoch,result:{data:{publicId:pub},authorizationGeneration:"5",resource}}});
  db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,outcome_json,expected_history_epoch_id)
    VALUES(?,?,?,'client',?,?,?,?,?,'acknowledged',1,0,?,?)`).run(commandId,source,app,transportExternalId,command,origin,instance,'{}',outcome,epoch);
  if(kind==="legacy")db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,command_id,history_epoch_id) VALUES(?,'client',?,?,?,?,?,?)`).run(source,opsId,pub,instance,app,commandId,epoch);
  else {
    db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256) VALUES(?,?,?, ?,?,?,?,?,'client',?,?,'1',?,?,?)`).run(receipt,'a'.repeat(64),'99999999-9999-4999-8999-999999999999',opsId,source,instance,app,epoch,paExternalId,pub,'b'.repeat(64),'c'.repeat(64),'d'.repeat(64));
    db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256,expected_authorization_generation,result_authorization_generation) VALUES(?,?,?,?, 'client',?,?,'1',?,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,?,'4','5')`).run('99999999-9999-4999-8999-999999999999',instance,app,epoch,paExternalId,pub,origin,'b'.repeat(64));
    db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(activation_id,review_receipt_id,idempotency_key,acquired_receipt_id,native_owner_claim_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,local_record_version,request_sha256,acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256,activated_by_staff_id,directory_grant_generation) VALUES(?,?,?,?,?,?,?,?,?,?,'client',?,?,'1',?,?,?,?,?,?,1)`).run(activation,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc',receipt,'dddddddd-dddd-4ddd-8ddd-dddddddddddd',opsId,source,instance,app,epoch,paExternalId,pub,activationVersion,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'d'.repeat(64),'staff');
  }
  return {db,ids:{opsId,paExternalId,source,instance,app,epoch,origin,pub,commandId,receipt,activation}};
}
const evidence=db=>db.prepare("SELECT identity_valid FROM project_alpha_directory_relationship_revision_evidence WHERE record_id='ops/client/42'").get()?.identity_valid??0;
const updateEvidence=db=>db.prepare("SELECT identity_valid FROM project_alpha_directory_relationship_revision_evidence WHERE record_id='ops/client/42' AND revision='2'").get()?.identity_valid??0;

test("full 0181 schema preserves legacy exact create ID",()=>{
  for(const kind of ["legacy"]){const {db}=behavioralFixture({kind});try{assert.equal(evidence(db),1);}finally{db.close();}}
  const {db}=behavioralFixture({kind:"legacy",paExternalId:"ignored"});try{db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.resource.id','wrong')").run();assert.equal(evidence(db),0);}finally{db.close();}
});

test("acquired activation v1 admits a genuine current-v2 acknowledged update only",()=>{
  const good=behavioralFixture({operation:"update",activationVersion:1,intentVersion:2,currentVersion:2});
  try{assert.equal(updateEvidence(good.db),1);}finally{good.db.close();}
  const stale=behavioralFixture({operation:"update",activationVersion:1,intentVersion:1,currentVersion:2});
  try{assert.equal(updateEvidence(stale.db),0);}finally{stale.db.close();}
  const wrong=behavioralFixture({operation:"update",activationVersion:1,intentVersion:2,currentVersion:2});
  try{wrong.db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.resource.publicId','ffffffffffffffffffffffffffffffff')").run();assert.equal(updateEvidence(wrong.db),0);}finally{wrong.db.close();}
});

test("acknowledged update wire contract fails closed under bounded identity drift",()=>{
  const mutations=[
    db=>db.prepare("UPDATE project_alpha_directory_outbox SET state='pending',outcome_json=NULL").run(),
    db=>db.prepare("UPDATE operations_directory_intents SET state='materialized'").run(),
    db=>db.prepare("UPDATE project_alpha_directory_outbox SET command_json=json_set(command_json,'$.commandId','ffffffff-ffff-4fff-8fff-ffffffffffff')").run(),
    db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.requestId','bad')").run(),
    db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.authorizationGeneration','6')").run(),
    db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.resource.type','organization')").run(),
    db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.resource.revision','0')").run(),
    db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.extra',1)").run(),
  ];
  for(const [index,mutate] of mutations.entries()){const {db}=behavioralFixture({operation:"update",activationVersion:1,intentVersion:2,currentVersion:2});try{mutate(db);assert.equal(updateEvidence(db),0,`wire mutation ${index}`);}finally{db.close();}}
});
