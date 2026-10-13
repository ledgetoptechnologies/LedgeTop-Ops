import assert from "node:assert/strict";
import test from "node:test";
import { validateAcknowledgedScalarUpdate, validatePairedGrantCleanup } from "./staging-directory-scalar-settlement.mjs";
import { activationReceipt, acquired, cleanup, clone, destination, plan, settlement, settlementFixture } from "./staging-directory-scalar-authority-v184-fixtures.mjs";

test("accepts exact acknowledged scalar settlement and later paired cleanup",()=>{
  assert.deepEqual(validateAcknowledgedScalarUpdate(settlement()),{status:"acknowledged",mutationId:plan.mutationId,version:5,destinations:1});
  assert.deepEqual(validatePairedGrantCleanup(cleanup()),{status:"cleaned",mutationId:plan.mutationId,grantGeneration:12});
});

test("accepts generation zero and an acquired external ID only with explicit trusted evidence",()=>{
  const x=settlement(); const trusted=acquired(x,{activation:{expected_authorization_generation:"0",result_authorization_generation:"0"}});
  trusted.authorizationGeneration="0";trusted.expectedAuthorizationGeneration="0";
  const audit=JSON.parse(x.settled.audits[0].command_json);audit.destinations[0].expectedAuthorizationGeneration="0";x.settled.audits[0].command_json=JSON.stringify(audit);
  const command=JSON.parse(x.settled.materializations[0].command_json); command.externalId="pa-client";command.expectedAuthorizationGeneration="0";
  x.settled.materializations[0].command_json=JSON.stringify(command); const disposition=JSON.parse(x.settled.materializations[0].disposition_json);
  disposition.externalCanonicalId="pa-client";x.settled.materializations[0].disposition_json=JSON.stringify(disposition);
  Object.assign(x.settled.outbox[0],{external_id:"pa-client",command_json:JSON.stringify(command)});
  const outcome=JSON.parse(x.settled.outbox[0].outcome_json);outcome.response.result.authorizationGeneration="0";x.settled.outbox[0].outcome_json=JSON.stringify(outcome);
  assert.equal(validateAcknowledgedScalarUpdate(x).status,"acknowledged");
  trusted.acquisitionEvidence=null;
  assert.throws(()=>validateAcknowledgedScalarUpdate(x),/activation receipt provenance/);
});

test("selects exact terminal refresh or prior delivery acquired heads and rejects invented destination state",()=>{
  const refreshed=settlement(),trusted=acquired(refreshed,{activation:{project_alpha_revision:"6",expected_authorization_generation:"7",result_authorization_generation:"8"},refreshes:[{command:{command_id:"refresh-command",request_sha256:"e".repeat(64),predecessor_kind:"acquired_mapping",predecessor_acquired_receipt_id:"acquired",predecessor_refresh_receipt_id:null,native_owner_claim_id:"claim",record_id:"client-1",source_id:destination.sourceId,source_instance_id:destination.sourceInstanceUUID,application_id:destination.applicationUUID,history_epoch_id:destination.historyEpoch,resource_type:"client",external_id:"pa-client",project_alpha_public_id:"a".repeat(32),expected_prior_revision:"6",expected_live_revision:"7",expected_authorization_generation:"8",expected_local_record_version:4,created_at:"same"},receipt:{receipt_id:"refresh-receipt",request_sha256:"e".repeat(64),command_id:"refresh-command",native_owner_claim_id:"claim",record_id:"client-1",source_id:destination.sourceId,source_instance_id:destination.sourceInstanceUUID,application_id:destination.applicationUUID,history_epoch_id:destination.historyEpoch,resource_type:"client",external_id:"pa-client",project_alpha_public_id:"a".repeat(32),prior_revision:"6",live_revision:"7",authorization_generation:"9",local_record_version:4,pa_request_id:"request",pa_replayed:0,response_sha256:"f".repeat(64),received_at:"same",created_at:"same"}}]});
  assert.equal(validateAcknowledgedScalarUpdate(refreshed).status,"acknowledged");
  const wrongActivationVersion=clone(refreshed);wrongActivationVersion.plan.destinations[0].acquisitionEvidence.authoritativeHeadEvidence.activationReceipt.local_record_version=3;
  assert.throws(()=>validateAcknowledgedScalarUpdate(wrongActivationVersion),/activation local version/);
  const wrongVersion=clone(refreshed);wrongVersion.plan.destinations[0].acquisitionEvidence.authoritativeHeadEvidence.refreshes[0].receipt.local_record_version=3;
  assert.throws(()=>validateAcknowledgedScalarUpdate(wrongVersion),/refresh head evidence/);
  const wrongRevision=clone(refreshed);wrongRevision.plan.destinations[0].revision="8";assert.throws(()=>validateAcknowledgedScalarUpdate(wrongRevision),/authoritative head differs/);
  const wrongGeneration=clone(refreshed);wrongGeneration.plan.destinations[0].authorizationGeneration=wrongGeneration.plan.destinations[0].expectedAuthorizationGeneration="10";
  assert.throws(()=>validateAcknowledgedScalarUpdate(wrongGeneration),/authoritative head differs/);
  const delivered=settlement(),deliveryTrusted=acquired(delivered,{activation:{local_record_version:3},deliveries:[{intent:{...delivered.settled.intents[0],record_version:4,external_canonical_id:"pa-client"},materialization:{...delivered.settled.materializations[0],intent_id:delivered.settled.intents[0].intent_id},outbox:{...delivered.settled.outbox[0],external_id:"pa-client"}}]});
  const priorWire=JSON.parse(deliveryTrusted.acquisitionEvidence.authoritativeHeadEvidence.deliveries[0].materialization.command_json);priorWire.externalId="pa-client";deliveryTrusted.acquisitionEvidence.authoritativeHeadEvidence.deliveries[0].materialization.command_json=JSON.stringify(priorWire);deliveryTrusted.acquisitionEvidence.authoritativeHeadEvidence.deliveries[0].outbox.command_json=JSON.stringify(priorWire);
  const priorOutcome=JSON.parse(deliveryTrusted.acquisitionEvidence.authoritativeHeadEvidence.deliveries[0].outbox.outcome_json);priorOutcome.response.result.resource.revision="7";deliveryTrusted.acquisitionEvidence.authoritativeHeadEvidence.deliveries[0].outbox.outcome_json=JSON.stringify(priorOutcome);
  assert.equal(validateAcknowledgedScalarUpdate(delivered).status,"acknowledged");
});

test("requires exact activation-to-refresh and refresh-to-refresh revision continuity",()=>{
  const x=settlement(),trusted=acquired(x,{activation:{project_alpha_revision:"6",expected_authorization_generation:"7",result_authorization_generation:"8"},refreshes:[{command:{command_id:"refresh-one",request_sha256:"1".repeat(64),predecessor_kind:"acquired_mapping",predecessor_acquired_receipt_id:"acquired",predecessor_refresh_receipt_id:null,native_owner_claim_id:"claim",record_id:"client-1",source_id:destination.sourceId,source_instance_id:destination.sourceInstanceUUID,application_id:destination.applicationUUID,history_epoch_id:destination.historyEpoch,resource_type:"client",external_id:"pa-client",project_alpha_public_id:"a".repeat(32),expected_prior_revision:"6",expected_live_revision:"7",expected_authorization_generation:"8",expected_local_record_version:4,created_at:"same"},receipt:{receipt_id:"receipt-one",request_sha256:"1".repeat(64),command_id:"refresh-one",native_owner_claim_id:"claim",record_id:"client-1",source_id:destination.sourceId,source_instance_id:destination.sourceInstanceUUID,application_id:destination.applicationUUID,history_epoch_id:destination.historyEpoch,resource_type:"client",external_id:"pa-client",project_alpha_public_id:"a".repeat(32),prior_revision:"6",live_revision:"7",authorization_generation:"9",local_record_version:4,pa_request_id:"request-one",pa_replayed:0,response_sha256:"2".repeat(64),received_at:"same",created_at:"same"}},{command:{command_id:"refresh-two",request_sha256:"3".repeat(64),predecessor_kind:"revision_refresh",predecessor_acquired_receipt_id:null,predecessor_refresh_receipt_id:"receipt-one",native_owner_claim_id:"claim",record_id:"client-1",source_id:destination.sourceId,source_instance_id:destination.sourceInstanceUUID,application_id:destination.applicationUUID,history_epoch_id:destination.historyEpoch,resource_type:"client",external_id:"pa-client",project_alpha_public_id:"a".repeat(32),expected_prior_revision:"7",expected_live_revision:"8",expected_authorization_generation:"9",expected_local_record_version:4,created_at:"same"},receipt:{receipt_id:"receipt-two",request_sha256:"3".repeat(64),command_id:"refresh-two",native_owner_claim_id:"claim",record_id:"client-1",source_id:destination.sourceId,source_instance_id:destination.sourceInstanceUUID,application_id:destination.applicationUUID,history_epoch_id:destination.historyEpoch,resource_type:"client",external_id:"pa-client",project_alpha_public_id:"a".repeat(32),prior_revision:"7",live_revision:"8",authorization_generation:"10",local_record_version:4,pa_request_id:"request-two",pa_replayed:0,response_sha256:"4".repeat(64),received_at:"same",created_at:"same"}}]});
  trusted.revision="8";trusted.authorizationGeneration=trusted.expectedAuthorizationGeneration="10";
  const audit=JSON.parse(x.settled.audits[0].command_json);audit.destinations[0].expectedAuthorizationGeneration="10";x.settled.audits[0].command_json=JSON.stringify(audit);
  const wire=JSON.parse(x.settled.materializations[0].command_json);wire.expectedRevision="8";wire.expectedAuthorizationGeneration="10";x.settled.materializations[0].command_json=JSON.stringify(wire);x.settled.outbox[0].command_json=JSON.stringify(wire);
  const disposition=JSON.parse(x.settled.materializations[0].disposition_json);disposition.projectAlphaRevision="8";x.settled.materializations[0].disposition_json=JSON.stringify(disposition);
  const outcome=JSON.parse(x.settled.outbox[0].outcome_json);outcome.response.result.resource.revision="9";outcome.response.result.authorizationGeneration="10";x.settled.outbox[0].outcome_json=JSON.stringify(outcome);
  assert.equal(validateAcknowledgedScalarUpdate(x).status,"acknowledged");
  const wrongFirst=clone(x);wrongFirst.plan.destinations[0].acquisitionEvidence.authoritativeHeadEvidence.refreshes[0].command.expected_prior_revision="5";
  wrongFirst.plan.destinations[0].acquisitionEvidence.authoritativeHeadEvidence.refreshes[0].receipt.prior_revision="5";
  assert.throws(()=>validateAcknowledgedScalarUpdate(wrongFirst),/predecessor chain/);
  const wrongSuccessor=clone(x);wrongSuccessor.plan.destinations[0].acquisitionEvidence.authoritativeHeadEvidence.refreshes[1].command.expected_prior_revision="6";
  wrongSuccessor.plan.destinations[0].acquisitionEvidence.authoritativeHeadEvidence.refreshes[1].receipt.prior_revision="6";
  assert.throws(()=>validateAcknowledgedScalarUpdate(wrongSuccessor),/predecessor chain/);
});

test("rejects an acquired parent proof whose stored parent public ID contradicts its active mapping",()=>{
  const x=settlement(),dependency=x.settled.relationshipDependencies[0],publicId="b".repeat(32);
  Object.assign(dependency,{evidence_kind:"acquired_mapping",parent_mapping_command_id:null,parent_activation_id:"parent-activation",
    parent_public_id:publicId,parent_ack_revision:"4",parent_ack_command_json:null,parent_ack_outcome_json:null});
  const receipt={...activationReceipt(x.plan.destinations[0]),activation_id:"parent-activation",record_id:"org-1",resource_type:"organization",
    external_id:"org-1",project_alpha_public_id:publicId,project_alpha_revision:"4",local_record_version:3};
  x.settled.relationshipDependencyEvidence=[{intent_id:dependency.intent_id,activeMapping:{source_id:destination.sourceId,
    resource_type:"organization",record_id:"org-1",external_id:"org-1",project_alpha_public_id:publicId,
    source_instance_id:destination.sourceInstanceUUID,application_id:destination.applicationUUID,history_epoch_id:destination.historyEpoch,
    provenance_id:"parent-activation",mapping_kind:"acquired",created_at:"same"},activationReceipt:receipt}];
  assert.equal(validateAcknowledgedScalarUpdate(x).status,"acknowledged");
  x.settled.relationshipDependencies[0].parent_public_id="c".repeat(32);
  assert.throws(()=>validateAcknowledgedScalarUpdate(x),/acquired parent dependency lacks exact/);
});

test("accepts an organization update with only its edit grant",()=>{
  const x=settlement(), p=x.plan; p.kind="organization";p.recordId="org-1";p.temporaryGrantIds={profileEdit:"edit"};
  p.beforeProfile={name:"Org",generalEmail:"old@example.test",generalPhone:"",addressLine1:"",addressLine2:"",city:"",state:"",postalCode:"",country:""};
  p.afterProfile={...p.beforeProfile,generalEmail:"new@example.test"};p.field="generalEmail";
  Object.assign(p.destinations[0],{enrollmentExternalCanonicalId:"org-1",externalCanonicalId:"org-1"});
  Object.assign(x.before.record,{record_id:"org-1",record_kind:"organization"});Object.assign(x.settled.record,{record_id:"org-1",record_kind:"organization"});
  x.before.revisions[0]={record_id:"org-1",version:4,mutation_id:"old",profile_json:JSON.stringify(p.beforeProfile)};
  x.settled.revisions=[x.before.revisions[0],{record_id:"org-1",version:5,mutation_id:p.mutationId,profile_json:JSON.stringify(p.afterProfile)}];
  x.before.relationship=null;x.settled.relationship=null;x.before.relationshipHistory=[];x.settled.relationshipHistory=[];
  x.before.resourceScopes[0].record_id="org-1";x.settled.resourceScopes[0].record_id="org-1";
  const enrolled=JSON.parse(x.before.enrollment.destinations_json);enrolled[0].externalCanonicalId="org-1";
  x.before.enrollment={record_id:"org-1",destinations_json:JSON.stringify(enrolled)};x.settled.enrollment=clone(x.before.enrollment);
  const intent=x.settled.intents[0];Object.assign(intent,{record_id:"org-1",external_canonical_id:"org-1",desired_payload_json:JSON.stringify(p.afterProfile)});
  x.settled.relationshipDependencies=[];
  const wire=JSON.parse(x.settled.materializations[0].command_json);wire.resourceType="organization";wire.externalId="org-1";wire.fields=p.afterProfile;
  x.settled.materializations[0].command_json=JSON.stringify(wire);const disp=JSON.parse(x.settled.materializations[0].disposition_json);disp.externalCanonicalId="org-1";
  x.settled.materializations[0].disposition_json=JSON.stringify(disp);
  const box=x.settled.outbox[0];Object.assign(box,{resource_type:"organization",external_id:"org-1",command_json:JSON.stringify(wire)});
  const outcome=JSON.parse(box.outcome_json);outcome.response.result.resource.type="organization";box.outcome_json=JSON.stringify(outcome);
  const audit=JSON.parse(x.settled.audits[0].command_json);Object.assign(audit,{resourceType:"organization",recordId:"org-1",fields:p.afterProfile,
    destinations:p.destinations.map(d=>({sourceId:d.sourceId,sourceInstanceUUID:d.sourceInstanceUUID,applicationUUID:d.applicationUUID,historyEpoch:d.historyEpoch,
      origin:d.origin,externalCanonicalId:d.externalCanonicalId,expectedAuthorizationGeneration:d.expectedAuthorizationGeneration})),relationship:null});
  Object.assign(x.settled.audits[0],{record_id:"org-1",command_json:JSON.stringify(audit)});
  assert.equal(validateAcknowledgedScalarUpdate(x).status,"acknowledged");
});

for(const [name,mutate] of [
  ["version jump",x=>x.settled.record.current_version=6],
  ["missing trusted V profile",x=>x.before.revisions[0].profile_json=JSON.stringify({...plan.beforeProfile,phone:"invented"})],
  ["second scalar mutation",x=>{x.plan.afterProfile.email="changed@example.test"}],
  ["relationship drift",x=>x.settled.relationship.relationship_version++],
  ["scope drift",x=>x.settled.resourceScopes[0].active=0],
  ["enrollment drift",x=>x.settled.enrollment.destinations_json="[]"],
  ["unacknowledged intent",x=>x.settled.intents[0].state="materialized"],
  ["stale remote revision",x=>{const o=JSON.parse(x.settled.outbox[0].outcome_json);o.response.result.resource.revision="7";x.settled.outbox[0].outcome_json=JSON.stringify(o)}],
  ["outbox origin drift",x=>x.settled.outbox[0].destination_base_url="https://other.example.test"],
  ["extra outbox row",x=>x.settled.outbox.push({...x.settled.outbox[0],command_id:"extra"})],
  ["extra evidence key",x=>x.settled.unreviewed=true],
  ["duplicate intent identity",x=>x.before.intents.push({...x.settled.intents[0]})],
]) test(`rejects ${name}`,()=>{const x=settlement();mutate(x);assert.throws(()=>validateAcknowledgedScalarUpdate(x),/directory scalar settlement/)});

test("rejects non-JSON evidence",()=>{const x=settlement();x.plan.afterProfile.phone=undefined;
  assert.throws(()=>validateAcknowledgedScalarUpdate(x),/JSON-safe|undefined/)});

for(const [name,mutate] of [
  ["cleanup before ACK proof",x=>x.acknowledged.settlementSnapshot.settled.intents[0].state="pending"],
  ["only one grant cleaned",x=>x.cleaned.grants[1].active=1],
  ["wrong resource grant",x=>x.cleaned.grants[0].resource_id="other"],
  ["grant identity mutation",x=>x.cleaned.grants[0].granted_by="other"],
  ["generation delta",x=>x.cleaned.grantGeneration=11],
  ["missing history",x=>x.cleaned.grantHistory.pop()],
  ["prior history mutation",x=>x.cleaned.grantHistory[0].active=0],
  ["unrelated cleanup mutation",x=>x.cleaned.protectedSnapshots.otherGrants.push({id:"changed",active:0})],
]) test(`rejects ${name}`,()=>{const x=cleanup();mutate(x);assert.throws(()=>validatePairedGrantCleanup(x),/directory scalar settlement/)});
