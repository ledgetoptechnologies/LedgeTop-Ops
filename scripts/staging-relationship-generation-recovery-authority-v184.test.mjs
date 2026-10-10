import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileRelationshipRecoveryAuthorityV184, RELATIONSHIP_RECOVERY_AUTHORITY_TARGET as target,
  RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2 as targetV2 } from "./staging-relationship-generation-recovery-authority-v184.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const stamp="2026-10-10T12:00:00.000Z";
const permissions=["directory.profile.edit","directory.identity.link","directory.enrollment.manage"];
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const grant=(n,permission,recordId,active=0,scope="resource")=>({id:uuid(n),staff_id:target.staffId,permission,effect:"allow",scope_kind:scope,business_area_id:null,division_id:null,resource_id:recordId,active,granted_by:target.staffId,created_at:stamp});

function fixture(){
  const grants=[grant(1,"directory.profile.view",null,1,"global")];
  let number=2;
  for(const recordId of [target.clientRecordId,target.organizationRecordId]) for(const permission of permissions){
    if(recordId===target.organizationRecordId&&permission==="directory.enrollment.manage") continue;
    grants.push(grant(number++,permission,recordId));
  }
  const history=grants.map((row,index)=>({grant_id:row.id,grant_version:1,staff_id:row.staff_id,permission:row.permission,effect:row.effect,scope_kind:row.scope_kind,business_area_id:row.business_area_id,division_id:row.division_id,resource_id:row.resource_id,active:row.active,grant_generation:index+1,recorded_at:stamp}));
  return {schemaVersion:1,staging:STAGING_TARGET,phase:"provision",target,
    migrationNames:fs.readdirSync(path.join(root,"apps/operations/migrations")).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort(),
    staff:{id:target.staffId,status:"active",access_subject:"access|owner"},roles:[{id:"owner-role",staff_id:target.staffId,role_id:"role-owner",scope:"global",scope_key:"global"}],
    admission:{staff_id:target.staffId,bound_access_subject:"access|owner",active:1,admitted_by:target.staffId,created_at:stamp,updated_at:stamp,version:3},
    profile:{staff_id:target.staffId,login_email:"owner@example.test",display_name:"Owner",version:2,created_at:stamp,updated_at:stamp},
    generation:{staff_id:target.staffId,generation:history.length,updated_at:stamp},
    records:[{record_id:target.clientRecordId,record_kind:"client",current_version:2},{record_id:target.organizationRecordId,record_kind:"organization",current_version:1}],
    resourceScopes:[{record_id:target.clientRecordId,scope_kind:"business_area",business_area_id:target.businessAreaId,division_id:null,active:1},{record_id:target.organizationRecordId,scope_kind:"business_area",business_area_id:target.businessAreaId,division_id:null,active:1}],
    relationship:{client_record_id:target.clientRecordId,organization_record_id:target.organizationRecordId,relationship_version:2},
    predecessor:{command_id:target.predecessorCommandId,source_id:target.sourceId,source_instance_id:target.sourceInstanceId,application_id:target.applicationId,history_epoch_id:target.historyEpochId,destination_origin:target.destinationOrigin,client_record_id:target.clientRecordId,client_public_id:target.clientPublicId,relationship_version:2,action:"assign",organization_record_id:target.organizationRecordId,organization_public_id:target.organizationPublicId,command_json:JSON.stringify({expectedAuthorizationGeneration:"54"}),state:"terminal",outcome_json:JSON.stringify({httpStatus:409})},
    grants,history,approval:{approvalId:uuid(90),commandId:uuid(91),grantIds:[uuid(2),uuid(3),uuid(4),uuid(5),uuid(6),uuid(7)],issuedAt:stamp,expiresAt:"2026-10-10T13:00:00.000Z",executedAt:stamp}};
}

function fixtureV2(){
  const value=fixture();value.schemaVersion=2;value.target=targetV2;
  value.resourceScopes=[
    {record_id:targetV2.clientRecordId,scope_kind:"business_area",business_area_id:targetV2.clientBusinessAreaId,division_id:null,active:1},
    {record_id:targetV2.organizationRecordId,scope_kind:"business_area",business_area_id:targetV2.organizationBusinessAreaId,division_id:null,active:1},
  ];
  return value;
}

function revokeFixture(base,provisionArtifact){
  const value=base();
  value.phase="revoke";
  value.provisionArtifact=provisionArtifact;
  const generation=value.generation.generation;
  for(const [index,id] of value.approval.grantIds.entries()){
    const recordId=index<3?value.target.clientRecordId:value.target.organizationRecordId;
    const permission=permissions[index%3];
    let row=value.grants.find(grant=>grant.id===id);
    if(!row){row=grant(Number(id.slice(-12)),permission,recordId,1);value.grants.push(row)}else row.active=1;
    const prior=value.history.filter(history=>history.grant_id===id).length;
    value.history.push({grant_id:id,grant_version:prior+1,staff_id:row.staff_id,permission:row.permission,effect:row.effect,scope_kind:row.scope_kind,business_area_id:row.business_area_id,division_id:row.division_id,resource_id:row.resource_id,active:1,grant_generation:generation+index+1,recorded_at:stamp});
  }
  value.generation={...value.generation,generation:generation+6};
  value.approval={...value.approval,approvalId:uuid(92),commandId:uuid(93)};
  return value;
}

test("compiles the exact six-resource transition and eight-entry selection",()=>{
  const artifact=compileRelationshipRecoveryAuthorityV184(fixture());
  assert.equal(artifact.selection.length,8);
  assert.equal(new Set(artifact.selection.map(row=>row.grantId)).size,7);
  assert.equal(JSON.parse(artifact.receipt.result_json).generation,12);
  assert.equal(artifact.statements.filter(row=>row.sql.includes("changes()=1")).length,6);
});

test("preserves historical v1 compilation while v2 pins the live mixed record scopes",()=>{
  const historical=compileRelationshipRecoveryAuthorityV184(fixture());
  const repeated=compileRelationshipRecoveryAuthorityV184(fixture());
  assert.deepEqual(repeated,historical);
  assert.equal(historical.receipt.canonical_plan_sha256,"6bedf7710d8bace3a740691a68915585df059c3eae45e390119738cf1574d853");
  assert.equal(historical.schemaVersion,1);
  const current=compileRelationshipRecoveryAuthorityV184(fixtureV2());
  assert.equal(current.schemaVersion,2);
  assert.deepEqual(current.input.resourceScopes,fixtureV2().resourceScopes);
  assert.deepEqual(current.selection,historical.selection);
  assert.deepEqual(JSON.parse(current.receipt.result_json).grantIds,JSON.parse(historical.receipt.result_json).grantIds);
});

test("v2 rejects either record being pinned to the other record's business area",()=>{
  for(const index of [0,1]){
    const value=fixtureV2();
    value.resourceScopes[index].business_area_id=index===0?targetV2.organizationBusinessAreaId:targetV2.clientBusinessAreaId;
    assert.throws(()=>compileRelationshipRecoveryAuthorityV184(value),/exact active resource scopes/);
  }
});

test("revoke remains available for v1 artifacts but rejects cross-version pairing",()=>{
  const historical=compileRelationshipRecoveryAuthorityV184(fixture());
  assert.equal(compileRelationshipRecoveryAuthorityV184(revokeFixture(fixture,historical)).schemaVersion,1);
  const crossVersion=revokeFixture(fixture,compileRelationshipRecoveryAuthorityV184(fixtureV2()));
  assert.throws(()=>compileRelationshipRecoveryAuthorityV184(crossVersion),/exact paired provision artifact/);
});

test("compiles the actual four-fresh plus two-inactive resource shape",()=>{
  const value=fixture(),removed=new Set(value.grants.filter(row=>row.resource_id===target.clientRecordId).map(row=>row.id));
  value.grants=value.grants.filter(row=>!removed.has(row.id));
  value.history=value.history.filter(row=>!removed.has(row.grant_id)).map((row,index)=>({...row,grant_generation:index+1}));
  value.generation={...value.generation,generation:value.history.length};
  const artifact=compileRelationshipRecoveryAuthorityV184(value);
  assert.equal(artifact.statements.filter(row=>row.sql.startsWith("INSERT INTO native_directory_grants")).length,4);
  assert.equal(artifact.statements.filter(row=>row.sql.startsWith("UPDATE native_directory_grants")).length,2);
});

test("rejects chain, target, relationship, predecessor, deny and grant drift",()=>{
  for(const mutate of [value=>value.migrationNames.pop(),value=>value.target={...value.target,clientRecordId:"other"},value=>value.relationship.relationship_version=3,value=>value.predecessor.source_id="wrong",value=>value.predecessor.source_instance_id="wrong",value=>value.predecessor.application_id="wrong",value=>value.predecessor.history_epoch_id="wrong",value=>value.predecessor.destination_origin="https://wrong.example",value=>value.predecessor.client_public_id="wrong",value=>value.predecessor.organization_public_id="wrong",value=>value.approval.grantIds[0]=value.approval.grantIds[1]]){
    const value=fixture();mutate(value);assert.throws(()=>compileRelationshipRecoveryAuthorityV184(value));
  }
  const value=fixture(),deny=grant(50,"directory.profile.edit",target.clientRecordId,1);deny.effect="deny";value.grants.push(deny);value.history.push({...value.history[0],grant_id:deny.id,permission:deny.permission,effect:"deny",scope_kind:"resource",resource_id:deny.resource_id,active:1,grant_generation:++value.generation.generation});
  assert.throws(()=>compileRelationshipRecoveryAuthorityV184(value));
});

test("rejects shortened snapshots, non-admin actors, and rewritten history",()=>{
  for(const mutate of [
    value=>delete value.admission.version,
    value=>delete value.predecessor.command_json,
    value=>value.staff.status="disabled",
    value=>value.roles[0].scope="business_area",
    value=>value.history[0].permission="directory.profile.edit",
    value=>value.history.pop(),
  ]){const value=fixture();mutate(value);assert.throws(()=>compileRelationshipRecoveryAuthorityV184(value));}
});
