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
const canonical = read(path.join(migrations, "0182_project_alpha_directory_relationship_recovery_guard.sql"));
const withoutHeaderComments = sql => sql.replace(/^(?:--[^\n]*\n)+\n?/, "");
const liveStart = "DROP VIEW project_alpha_directory_live_relationship_commands;";
const revisionStart = "DROP VIEW project_alpha_directory_relationship_revision_evidence;";
const resolvedStart = "DROP VIEW operations_directory_intent_relationship_resolved;";
const revisionComment = "-- The 0181 recovery-aware revision view";
const validatedStart = "DROP VIEW IF EXISTS project_alpha_directory_validated_materialized_acknowledgements;";

test("canonical 0182 statements equal the reviewed proposal", () => {
  assert.equal(withoutHeaderComments(canonical),withoutHeaderComments(proposal));
});

test("local relationship proposal changes exactly one pending source in the live-command view", () => {
  const originalBody = original.slice(original.indexOf(liveStart)).trim();
  const proposalBody = proposal.slice(proposal.indexOf(liveStart), proposal.indexOf(resolvedStart)).trim();
  assert.ok(originalBody.startsWith(liveStart));
  assert.equal(originalBody.split("project_alpha_directory_outbox pending").length, 2);
  assert.equal(proposalBody, originalBody.replace(
    "project_alpha_directory_outbox pending", "project_alpha_directory_unsettled_commands pending"));
});

test("revision-evidence proposal changes only the materialized acknowledgement identity predicate", () => {
  const originalBody = recovery.slice(recovery.indexOf(revisionStart)).trim();
  const proposalBody = proposal.slice(proposal.indexOf(revisionStart),proposal.indexOf(validatedStart)).trim();
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
  assert.match(proposalBody, /count\(\*\) FROM json_each\(outbox\.outcome_json,'\$\.response\.result'\)\)=2[\s\S]*result\.data'\) IS NULL[\s\S]*operation'\)='create'[\s\S]*outbox\.resource_type='organization'/);
  assert.match(proposalBody, /count\(\*\) FROM json_each\(outbox\.outcome_json,'\$\.response\.result'\)\)=3[\s\S]*result\.data\.publicId'[\s\S]*result\.resource\.publicId'/);
  assert.doesNotMatch(proposalBody, /expectedRevision'[\s\S]{0,300}CAST\(CAST/);
});

test("complete canonical schema accepts proposal and preserves the existing relationship insert guard", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const names = fs.readdirSync(migrations).filter(name => /^\d{4}_.+\.sql$/.test(name) && name<"0182_").sort();
    assert.equal(names.length, 181);
    assert.equal(names.at(-1), "0181_project_alpha_directory_create_generation_recovery.sql");
    for (const name of names) db.exec(read(path.join(migrations, name)));
    const beforeSchema = new Map(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('view','trigger') AND sql IS NOT NULL").all().map(row=>[row.name,row.sql]));
    const before = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='project_alpha_directory_relationship_outbox_insert_guard'").get();
    assert.ok(before?.sql.includes("project_alpha_directory_live_relationship_commands"));
    db.exec(canonical);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='project_alpha_directory_relationship_outbox_insert_guard'").get(), before);
    const view = db.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='project_alpha_directory_live_relationship_commands'").get();
    assert.ok(view.sql.includes("project_alpha_directory_unsettled_commands pending"));
    assert.ok(!view.sql.includes("project_alpha_directory_outbox pending"));
    const revisions = db.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='project_alpha_directory_relationship_revision_evidence'").get();
    assert.ok(revisions.sql.includes("WHEN 'create'"));
    assert.ok(revisions.sql.includes("WHEN 'update'"));
    const afterSchema = new Map(db.prepare("SELECT name,sql FROM sqlite_schema WHERE type IN ('view','trigger') AND sql IS NOT NULL").all().map(row=>[row.name,row.sql]));
    const changed=[...afterSchema].filter(([name,sql])=>beforeSchema.get(name)!==sql).map(([name])=>name).sort();
    assert.deepEqual(changed,["operations_directory_intent_relationship_dependencies_existing_mapping_ack_insert_guard","operations_directory_intent_relationship_dependencies_insert_guard","operations_directory_intent_relationship_resolved","operations_directory_materializations_reserve","project_alpha_directory_live_relationship_commands","project_alpha_directory_relationship_revision_evidence","project_alpha_directory_validated_materialized_acknowledgements"].sort());
    for(const name of changed)if(!["project_alpha_directory_validated_materialized_acknowledgements","operations_directory_intent_relationship_dependencies_existing_mapping_ack_insert_guard"].includes(name))assert.ok(beforeSchema.has(name),`${name} must replace an existing canonical object`);
    assert.ok(!beforeSchema.has("project_alpha_directory_validated_materialized_acknowledgements"));
    assert.ok(!beforeSchema.has("operations_directory_intent_relationship_dependencies_existing_mapping_ack_insert_guard"));
    const historical=afterSchema.get("project_alpha_directory_validated_materialized_acknowledgements");
    assert.match(historical,/materialization\.command_json=outbox\.command_json/);
    assert.match(historical,/WHEN 'create'[\s\S]*WHEN 'update'/);
    assert.doesNotMatch(historical,/current_record|current_version/);
    for(const name of ["operations_directory_intent_relationship_dependencies_existing_mapping_ack_insert_guard","operations_directory_intent_relationship_resolved","operations_directory_materializations_reserve"])
      assert.match(afterSchema.get(name),/project_alpha_directory_validated_materialized_acknowledgements/);
    const resolved=afterSchema.get("operations_directory_intent_relationship_resolved");
    const dependencyGuard=afterSchema.get("operations_directory_intent_relationship_dependencies_insert_guard");
    const existingMappingAckGuard=afterSchema.get("operations_directory_intent_relationship_dependencies_existing_mapping_ack_insert_guard");
    assert.match(resolved,/evidence\.command_id=outbox\.command_id/);
    assert.doesNotMatch(resolved,/evidence\.record_version=dependency\.organization_record_version/);
    assert.doesNotMatch(dependencyGuard,/project_alpha_directory_validated_materialized_acknowledgements/);
    assert.doesNotMatch(dependencyGuard,/evidence\.record_version=NEW\.organization_record_version/);
    assert.match(existingMappingAckGuard,/evidence\.command_id=NEW\.parent_mapping_command_id/);
    assert.doesNotMatch(existingMappingAckGuard.slice(0,existingMappingAckGuard.indexOf("OR NOT EXISTS")),/evidence\.record_version=NEW\.organization_record_version/);
    assert.match(existingMappingAckGuard,/current_evidence\.record_version=NEW\.organization_record_version/);
    db.exec("BEGIN");
    assert.throws(()=>db.prepare(`INSERT INTO operations_directory_intent_relationship_dependencies(
      intent_id,client_record_id,client_record_version,relationship_version,relationship_mutation_id,
      organization_record_id,organization_record_version,source_id,source_instance_uuid,application_uuid,
      history_epoch_id,destination_origin,parent_external_canonical_id,evidence_kind,parent_mapping_command_id,
      parent_public_id,parent_ack_revision,parent_ack_command_json,parent_ack_outcome_json)
      VALUES('missing-intent','missing-client',1,1,'missing-mutation','missing-parent',2,'source',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','epoch',
        'https://project-alpha.invalid','org/external','existing_mapping','missing-command','org-public','1','{}','{}')`).run(),
      /relationship dependency existing mapping acknowledgement invalid/);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count(*) AS count FROM operations_directory_intent_relationship_dependencies WHERE intent_id='missing-intent'").get().count,0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec(`DROP VIEW project_alpha_directory_validated_materialized_acknowledgements;
      CREATE TABLE project_alpha_directory_validated_materialized_acknowledgements(
        command_id TEXT,record_id TEXT,record_kind TEXT,record_version INTEGER,source_id TEXT,
        source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,destination_origin TEXT,
        public_id TEXT,revision TEXT,identity_valid INTEGER);
      INSERT INTO project_alpha_directory_validated_materialized_acknowledgements VALUES(
        'bootstrap-command','parent','organization',1,'source','11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','epoch','https://project-alpha.invalid','parent-public','1',1);`);
    db.exec("BEGIN");
    assert.throws(()=>db.prepare(`INSERT INTO operations_directory_intent_relationship_dependencies(
      intent_id,client_record_id,client_record_version,relationship_version,relationship_mutation_id,
      organization_record_id,organization_record_version,source_id,source_instance_uuid,application_uuid,
      history_epoch_id,destination_origin,parent_external_canonical_id,evidence_kind,parent_mapping_command_id,
      parent_public_id,parent_ack_revision,parent_ack_command_json,parent_ack_outcome_json)
      VALUES('pending-current-intent','pending-client',1,1,'pending-mutation','parent',2,'source',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','epoch',
        'https://project-alpha.invalid','parent','existing_mapping','bootstrap-command','parent-public','1','{}','{}')`).run(),
      /relationship dependency existing mapping acknowledgement invalid/);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count(*) AS count FROM operations_directory_intent_relationship_dependencies WHERE intent_id='pending-current-intent'").get().count,0);
    db.prepare(`INSERT INTO project_alpha_directory_validated_materialized_acknowledgements VALUES(
      'current-command','parent','organization',2,'source','11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222','epoch','https://project-alpha.invalid','parent-public','2',1)`).run();
    db.exec("DROP TRIGGER operations_directory_intent_relationship_dependencies_insert_guard; PRAGMA foreign_keys=OFF; BEGIN");
    assert.doesNotThrow(()=>db.prepare(`INSERT INTO operations_directory_intent_relationship_dependencies(
      intent_id,client_record_id,client_record_version,relationship_version,relationship_mutation_id,
      organization_record_id,organization_record_version,source_id,source_instance_uuid,application_uuid,
      history_epoch_id,destination_origin,parent_external_canonical_id,evidence_kind,parent_mapping_command_id,
      parent_public_id,parent_ack_revision,parent_ack_command_json,parent_ack_outcome_json)
      VALUES('acknowledged-current-intent','acknowledged-client',1,1,'acknowledged-mutation','parent',2,'source',
        '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','epoch',
        'https://project-alpha.invalid','parent','existing_mapping','bootstrap-command','parent-public','1','{}','{}')`).run());
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT count(*) AS count FROM operations_directory_intent_relationship_dependencies WHERE intent_id='acknowledged-current-intent'").get().count,0);
  } finally {
    db.close();
  }
});

function behavioralFixture({kind="acquired",opsId="ops/client/42",paExternalId="pa/client/existing-7",
  operation="create",intentVersion=2,currentVersion=2,activationVersion=2,persistedShape="normalized",resourceKind="client"}={}) {
  const db=new DatabaseSync(":memory:");
  const names=fs.readdirSync(migrations).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name<"0182_").sort();
  for(const name of names)db.exec(read(path.join(migrations,name)));
  db.exec(canonical);
  // Seed immutable outputs of independently tested producers. The view under
  // test must still authenticate their complete coordinate/receipt pairing.
  db.exec("PRAGMA foreign_keys=OFF");
  for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger'").all())db.exec(`DROP TRIGGER \"${name}\"`);
  const source="project-alpha:staging",instance="22222222-2222-4222-8222-222222222222",app="33333333-3333-4333-8333-333333333333",epoch="44444444-4444-4444-8444-444444444444",origin="https://pa.example.test",pub="0123456789abcdef0123456789abcdef",commandId="55555555-5555-4555-8555-555555555555",receipt="66666666-6666-4666-8666-666666666666",activation="77777777-7777-4777-8777-777777777777";
  const transportExternalId=kind==="acquired"?paExternalId:opsId;
  db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,?,?)").run(opsId,resourceKind,currentVersion);
  db.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(? ,?,'mutation','{}')").run(opsId,intentVersion);
  db.prepare(`INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,application_uuid,destination_origin,external_canonical_id,desired_payload_json,state,expected_history_epoch_id)
    VALUES('intent','mutation',?,?,?,?,?,?,?,'{}','acknowledged',?)`).run(opsId,intentVersion,source,instance,app,origin,transportExternalId,epoch);
  const command=operation==="create"
    ? JSON.stringify({operation:"create",commandId,resourceType:resourceKind,externalId:transportExternalId,expectedRevision:"0",expectedAuthorizationGeneration:"4",fields:{name:"Exact"}})
    : JSON.stringify({operation:"update",commandId,resourceType:resourceKind,externalId:transportExternalId,expectedProjectAlphaPublicId:pub,expectedRevision:"1",expectedAuthorizationGeneration:"5",fields:{name:"Updated",organizationPublicId:null}});
  db.prepare(`INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,disposition_json,next_attempt_at,history_epoch_id)
    VALUES('intent',?,?,'{}','{}',0,?)`).run(commandId,command,epoch);
  const resource=operation==="create"?{id:kind==="legacy"?opsId:paExternalId,type:resourceKind,publicId:pub,revision:"1"}:{type:resourceKind,publicId:pub,revision:"2"};
  const result={authorizationGeneration:"5",resource};
  if(persistedShape==="normalized")result.data={publicId:pub};
  else if(persistedShape==="mismatched")result.data={publicId:"ffffffffffffffffffffffffffffffff"};
  else if(persistedShape==="extra")result.extra=true;
  else if(persistedShape!=="native")throw new Error(`unknown persisted shape ${persistedShape}`);
  const outcome=JSON.stringify({status:"acknowledged",response:{requestId:"88888888-8888-4888-8888-888888888888",replayed:false,sourceInstanceId:instance,applicationId:app,historyEpoch:epoch,result}});
  db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,attempts,next_attempt_at,outcome_json,expected_history_epoch_id)
    VALUES(?,?,?,?,?,?,?,?,?,'acknowledged',1,0,?,?)`).run(commandId,source,app,resourceKind,transportExternalId,command,origin,instance,'{}',outcome,epoch);
  if(kind==="legacy")db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,command_id,history_epoch_id) VALUES(?,?,?,?,?,?,?,?)`).run(source,resourceKind,opsId,pub,instance,app,commandId,epoch);
  else {
    db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256) VALUES(?,?,?, ?,?,?,?,?,'client',?,?,'1',?,?,?)`).run(receipt,'a'.repeat(64),'99999999-9999-4999-8999-999999999999',opsId,source,instance,app,epoch,paExternalId,pub,'b'.repeat(64),'c'.repeat(64),'d'.repeat(64));
    db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256,expected_authorization_generation,result_authorization_generation) VALUES(?,?,?,?, 'client',?,?,'1',?,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',0,?,'4','5')`).run('99999999-9999-4999-8999-999999999999',instance,app,epoch,paExternalId,pub,origin,'b'.repeat(64));
    db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(activation_id,review_receipt_id,idempotency_key,acquired_receipt_id,native_owner_claim_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,local_record_version,request_sha256,acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256,activated_by_staff_id,directory_grant_generation) VALUES(?,?,?,?,?,?,?,?,?,?,'client',?,?,'1',?,?,?,?,?,?,1)`).run(activation,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc',receipt,'dddddddd-dddd-4ddd-8ddd-dddddddddddd',opsId,source,instance,app,epoch,paExternalId,pub,activationVersion,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'d'.repeat(64),'staff');
  }
  return {db,ids:{opsId,paExternalId,source,instance,app,epoch,origin,pub,commandId,receipt,activation}};
}
const evidence=(db,recordId="ops/client/42")=>db.prepare("SELECT identity_valid FROM project_alpha_directory_relationship_revision_evidence WHERE record_id=?").get(recordId)?.identity_valid??0;
const updateEvidence=db=>db.prepare("SELECT identity_valid FROM project_alpha_directory_relationship_revision_evidence WHERE record_id='ops/client/42' AND revision='2'").get()?.identity_valid??0;
function insertParentIntentDependency(db,ids){
  db.prepare(`INSERT INTO operations_directory_intent_relationship_dependencies(
    intent_id,client_record_id,client_record_version,relationship_version,relationship_mutation_id,
    organization_record_id,organization_record_version,source_id,source_instance_uuid,application_uuid,
    history_epoch_id,destination_origin,parent_external_canonical_id,evidence_kind,parent_intent_id)
    VALUES('client-intent','client-record',1,1,'relationship-mutation',?,2,?,?,?,?,?,?,'parent_intent','intent')`)
    .run(ids.opsId,ids.source,ids.instance,ids.app,ids.epoch,ids.origin,ids.opsId);
}

test("parent-intent resolution accepts an exact current organization update and rejects malformed update data",()=>{
  for(const malformed of [false,true]){
    const {db,ids}=behavioralFixture({kind:"legacy",opsId:"ops/organization/42",operation:"update",
      intentVersion:2,currentVersion:2,persistedShape:"normalized",resourceKind:"organization"});
    try{
      if(malformed)db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.data','wrong')").run();
      insertParentIntentDependency(db,ids);
      const rows=db.prepare("SELECT resolved_parent_public_id FROM operations_directory_intent_relationship_resolved WHERE intent_id='client-intent'").all();
      assert.deepEqual(rows.map(row=>row.resolved_parent_public_id),malformed?[]:[ids.pub]);
    }finally{db.close();}
  }
});

test("full 0181 schema preserves legacy exact create ID",()=>{
  for(const kind of ["legacy"]){const {db}=behavioralFixture({kind});try{assert.equal(evidence(db),1);}finally{db.close();}}
  const {db}=behavioralFixture({kind:"legacy",paExternalId:"ignored"});try{db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.resource.id','wrong')").run();assert.equal(evidence(db),0);}finally{db.close();}
});

test("create evidence accepts only exact native or normalized persisted acknowledgement forms",()=>{
  const normalized=behavioralFixture({kind:"legacy",persistedShape:"normalized"});
  try{assert.equal(evidence(normalized.db),1,"normalized");}finally{normalized.db.close();}
  for(const persistedShape of ["mismatched","extra"]){
    const {db}=behavioralFixture({kind:"legacy",persistedShape});
    try{assert.equal(evidence(db),0,persistedShape);}finally{db.close();}
  }
  const wrongDataShape=behavioralFixture({kind:"legacy",persistedShape:"normalized"});
  try{
    wrongDataShape.db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.data.extra',1)").run();
    assert.equal(evidence(wrongDataShape.db),0,"non-singleton data");
  }finally{wrongDataShape.db.close();}
});

test("native organization bootstrap acknowledgement is accepted only with its exact mandatory wire shape",()=>{
  const recordId="ops/organization/bootstrap";
  const valid=behavioralFixture({kind:"legacy",resourceKind:"organization",opsId:recordId,
    paExternalId:"ignored",intentVersion:1,currentVersion:1,persistedShape:"native"});
  try{assert.equal(evidence(valid.db,recordId),1,"exact native bootstrap form");}finally{valid.db.close();}
  const mutations=[
    ["null data",db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.data',NULL)").run()],
    ["scalar data",db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.data','wrong')").run()],
    ["extra result field",db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.extra',1)").run()],
    ["missing resource",db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_remove(outcome_json,'$.response.result.resource')").run()],
    ["missing authorization generation",db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_remove(outcome_json,'$.response.result.authorizationGeneration')").run()],
    ["missing create external ID",db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_remove(outcome_json,'$.response.result.resource.id')").run()],
    ["mismatched create external ID",db=>db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.resource.id','wrong')").run()],
  ];
  // This consumer-view fixture seeds producer outputs with triggers disabled; it
  // verifies executed SQL recognition, not the complete bootstrap producer chain.
  for(const [label,mutate] of mutations){
    const value=behavioralFixture({kind:"legacy",resourceKind:"organization",opsId:recordId,
      paExternalId:"ignored",intentVersion:1,currentVersion:1,persistedShape:"native"});
    try{mutate(value.db);assert.equal(evidence(value.db,recordId),0,label);}finally{value.db.close();}
  }
  const nativeClient=behavioralFixture({kind:"legacy",persistedShape:"native"});
  try{assert.equal(evidence(nativeClient.db),0,"native client is not a bootstrap producer form");}finally{nativeClient.db.close();}
  const nativeUpdate=behavioralFixture({kind:"legacy",resourceKind:"organization",opsId:recordId,
    paExternalId:"ignored",operation:"update",intentVersion:1,currentVersion:1,persistedShape:"native"});
  try{assert.equal(evidence(nativeUpdate.db,recordId),0,"native update is not a bootstrap producer form");}finally{nativeUpdate.db.close();}
  const updateWithCreateId=behavioralFixture({kind:"legacy",resourceKind:"organization",opsId:recordId,
    paExternalId:"ignored",operation:"update",intentVersion:1,currentVersion:1,persistedShape:"normalized"});
  try{
    updateWithCreateId.db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=json_set(outcome_json,'$.response.result.resource.id','unexpected')").run();
    assert.equal(evidence(updateWithCreateId.db,recordId),0,"update resource.id is forbidden");
  }finally{updateWithCreateId.db.close();}
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
