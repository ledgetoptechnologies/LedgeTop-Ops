import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ORGANIZATION_RELATIONSHIP_TARGET as target, compileOrganizationRelationshipAuthority,
  applyAndReconcileOrganizationRelationshipAuthority } from "./staging-organization-relationship-authority.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";

const root=path.resolve(import.meta.dirname,".."),ids=["10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002"];
const migrations=fs.readdirSync(path.join(root,"apps/operations/migrations")).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
const grant=(id,permission,active=1)=>({id,staff_id:target.staffId,permission,effect:"allow",scope_kind:"resource",business_area_id:null,division_id:null,resource_id:target.recordId,active,granted_by:target.staffId,created_at:"2026-10-08T12:00:45.000Z"});
const history=(row,grant_version,active,grant_generation)=>({grant_id:row.id,grant_version,staff_id:row.staff_id,permission:row.permission,effect:row.effect,scope_kind:row.scope_kind,business_area_id:row.business_area_id,division_id:row.division_id,resource_id:row.resource_id,active,grant_generation,recorded_at:`2026-10-08T12:${String(grant_generation).padStart(2,"0")}:00.000Z`});
let sequence=0;
function input({phase="provision",grants=[],rows=[],generation=0,grantIds=ids,provisionArtifact}={}) { const suffix=String(++sequence).padStart(12,"0");
  return {schemaVersion:2,staging:STAGING_TARGET,phase,target,migrationNames:migrations,
    admission:{staff_id:target.staffId,bound_access_subject:"access|staff",active:1,admitted_by:target.staffId,created_at:"2026-10-08T10:00:00.000Z",updated_at:"2026-10-08T10:00:00.000Z",version:1},
    profile:{staff_id:target.staffId,login_email:"staff@example.test",display_name:"Staff",version:1,created_at:"2026-10-08T10:00:00.000Z",updated_at:"2026-10-08T10:00:00.000Z"},
    generation:{staff_id:target.staffId,generation,updated_at:`2026-10-08T12:${String(generation).padStart(2,"0")}:30.000Z`},
    record:{record_id:target.recordId,record_kind:"organization",current_version:1},resourceScope:{record_id:target.recordId,scope_kind:"business_area",business_area_id:target.businessAreaId,division_id:null,active:1},grants,history:rows,
    approval:{approvalId:`20000000-0000-4000-8000-${suffix}`,commandId:`30000000-0000-4000-8000-${suffix}`,grantIds,issuedAt:"2026-10-08T12:00:00.000Z",expiresAt:"2026-10-08T13:00:00.000Z",executedAt:"2026-10-08T12:00:00.000Z"},...(provisionArtifact?{provisionArtifact}:{})}; }
function activeAfterFresh(provision) { const grants=[grant(ids[0],"directory.profile.edit"),grant(ids[1],"directory.identity.link")];return input({phase:"revoke",grants,rows:[history(grants[0],1,1,1),history(grants[1],1,1,2)],generation:2,provisionArtifact:provision}); }
function inactiveSnapshot() { const grants=[grant(ids[0],"directory.profile.edit",0),grant(ids[1],"directory.identity.link",0)];return input({grants,rows:[history(grants[0],1,1,1),history(grants[0],2,0,3),history(grants[1],1,1,2),history(grants[1],2,0,4)],generation:4}); }
function activeAfterReactivation(provision) { const value=inactiveSnapshot(),grants=value.grants.map(row=>({...row,active:1}));return input({phase:"revoke",grants,rows:[...value.history,history(grants[0],3,1,5),history(grants[1],3,1,6)],generation:6,provisionArtifact:provision}); }

test("v2 compiler provisions only a fresh exact organization grant pair",()=>{const artifact=compileOrganizationRelationshipAuthority(input()),sql=artifact.statements.map(row=>row.sql).join("\n"),result=JSON.parse(artifact.receipt.result_json);
  assert.deepEqual(artifact.selection,{mode:"fresh",historyVersions:[1,1]});assert.equal(artifact.schemaVersion,2);assert.equal((sql.match(/INSERT INTO native_directory_grants/g)??[]).length,2);assert.doesNotMatch(sql,/'global'/);assert.deepEqual(result,{active:1,generation:2,grantIds:ids,grantVersions:[1,1],operation:"fresh",phase:"provision"});});

test("v2 compiler reactivates the sole exact inactive pair with retained IDs and next versions",()=>{const value=inactiveSnapshot(),artifact=compileOrganizationRelationshipAuthority(value),updates=artifact.statements.filter(row=>row.sql.startsWith("UPDATE native_directory_grants"));
  assert.deepEqual(artifact.selection,{mode:"reactivate",historyVersions:[3,3]});assert.equal(updates.length,2);assert.deepEqual(updates.map(row=>row.params),[[1,ids[0],target.staffId,"directory.profile.edit",target.recordId,0,target.staffId],[1,ids[1],target.staffId,"directory.identity.link",target.recordId,0,target.staffId]]);assert.equal(JSON.parse(artifact.receipt.result_json).operation,"reactivate");});

test("paired revoke derives exact next versions from either fresh or reactivated provision",()=>{const fresh=compileOrganizationRelationshipAuthority(input()),freshRevoke=compileOrganizationRelationshipAuthority(activeAfterFresh(fresh));
  assert.deepEqual(freshRevoke.selection,{mode:"revoke",historyVersions:[2,2]});assert.match(freshRevoke.statements.map(row=>row.sql).join("\n"),/SET active=\? WHERE id=\?/);
  const reactivation=compileOrganizationRelationshipAuthority(inactiveSnapshot()),revoke=compileOrganizationRelationshipAuthority(activeAfterReactivation(reactivation));assert.deepEqual(revoke.selection,{mode:"revoke",historyVersions:[4,4]});
  const forged=activeAfterReactivation(reactivation);forged.provisionArtifact.receipt.command_id="forged";assert.throws(()=>compileOrganizationRelationshipAuthority(forged),/immutable provision artifact/);});

test("provision rejects wrong, mixed, active, and ambiguous retained target selection",()=>{const wrong=inactiveSnapshot();wrong.approval.grantIds=["70000000-0000-4000-8000-000000000001","70000000-0000-4000-8000-000000000002"];
  const mixed=inactiveSnapshot();mixed.grants.pop();mixed.history=mixed.history.filter(row=>row.grant_id===ids[0]);mixed.generation.generation=2;
  const active=activeAfterFresh(compileOrganizationRelationshipAuthority(input()));delete active.provisionArtifact;active.phase="provision";
  const ambiguous=inactiveSnapshot(),duplicate=grant("70000000-0000-4000-8000-000000000003","directory.profile.edit",0);ambiguous.grants.push(duplicate);ambiguous.history.push(history(duplicate,1,0,5));ambiguous.generation.generation=5;
  for(const value of [wrong,mixed,active,ambiguous])assert.throws(()=>compileOrganizationRelationshipAuthority(value));});

test("compiler rejects malformed or incomplete immutable history and metadata",()=>{const gap=inactiveSnapshot();gap.history[1].grant_version=3;
  const repeated=inactiveSnapshot();repeated.history[1].active=1;repeated.grants[0].active=1;
  const missing=inactiveSnapshot();missing.history.pop();
  const wrongGrantor=inactiveSnapshot();wrongGrantor.grants[0].granted_by="other";
  const duplicateGeneration=inactiveSnapshot();duplicateGeneration.history[1].grant_generation=2;
  const timeTravel=inactiveSnapshot();timeTravel.history[2].recorded_at="2026-10-08T12:04:00.000Z";
  for(const value of [gap,repeated,missing,wrongGrantor,duplicateGeneration,timeTravel])assert.throws(()=>compileOrganizationRelationshipAuthority(value));});

test("paired revoke rejects intervening snapshot or immutable context drift and a substituted current pair",()=>{const provision=compileOrganizationRelationshipAuthority(input()),drift=activeAfterFresh(provision),unrelated=grant("70000000-0000-4000-8000-000000000004","directory.profile.view");drift.grants.push(unrelated);drift.history.push(history(unrelated,1,1,3));drift.generation={...drift.generation,generation:3,updated_at:"2026-10-08T12:03:30.000Z"};assert.throws(()=>compileOrganizationRelationshipAuthority(drift),/prior provision poststate/);
  const context=activeAfterFresh(provision);context.profile={...context.profile,display_name:"Changed"};assert.throws(()=>compileOrganizationRelationshipAuthority(context),/provision context changed/);
  const forgedCreated=activeAfterFresh(provision);forgedCreated.grants[0].created_at="2026-10-08T11:59:59.000Z";assert.throws(()=>compileOrganizationRelationshipAuthority(forgedCreated),/provision history suffix/);
  const substituted=activeAfterFresh(provision);substituted.approval.grantIds=[ids[0],"70000000-0000-4000-8000-000000000005"];assert.throws(()=>compileOrganizationRelationshipAuthority(substituted));});

test("compiler retains target, record, area, and deny fail-closed guards",()=>{for(const mutate of [value=>value.target={...value.target,recordId:"other"},value=>value.record.current_version=2,value=>value.resourceScope.business_area_id="other",value=>{const deny=grant("deny","directory.profile.view");deny.effect="deny";value.grants.push(deny);value.history.push(history(deny,1,1,1));value.generation.generation=1;}]){const value=input();mutate(value);assert.throws(()=>compileOrganizationRelationshipAuthority(value));}});

test("compiler requires exact snapshot shapes and fresh distinct UUID identifiers",()=>{const extraAdmission=input();extraAdmission.admission.extra=true;
  const missingProfile=input();delete missingProfile.profile.version;
  const extraGeneration=input();extraGeneration.generation.extra=0;
  const badUuid=input();badUuid.approval.commandId="not-a-uuid";
  const collision=input();collision.approval.approvalId=collision.approval.grantIds[0];
  for(const value of [extraAdmission,missingProfile,extraGeneration,badUuid,collision])assert.throws(()=>compileOrganizationRelationshipAuthority(value));
  const provision=compileOrganizationRelationshipAuthority(input()),revoke=activeAfterFresh(provision);revoke.approval.approvalId=provision.approval.approval_id;assert.throws(()=>compileOrganizationRelationshipAuthority(revoke),/fresh revoke identifiers/);});

test("unknown response reconciles v2 and already-committed v1 artifacts only by exact receipt",async()=>{const artifact=compileOrganizationRelationshipAuthority(input()),db={prepare:()=>({bind(){return this;},first:async()=>artifact.receipt})};assert.equal((await applyAndReconcileOrganizationRelationshipAuthority(db,artifact,{target:STAGING_TARGET,root})).status,"committed-after-response-recovery");
  const old={schemaVersion:1,input:{schemaVersion:1},receipt:{command_id:"old-command",result_json:"old"}},oldDb={prepare:()=>({bind(){return this;},first:async()=>old.receipt})};assert.equal((await applyAndReconcileOrganizationRelationshipAuthority(oldDb,old,{target:STAGING_TARGET,root})).status,"committed-after-response-recovery");});
