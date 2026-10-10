import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileRelationshipRecoveryAuthorityV184, RELATIONSHIP_RECOVERY_AUTHORITY_TARGET as target,
  RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2 as targetV2 } from "./staging-relationship-generation-recovery-authority-v184.mjs";
import { fixture, fixtureV2, grant, revokeFixture } from "./staging-directory-scalar-authority-v184-fixtures.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");

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
