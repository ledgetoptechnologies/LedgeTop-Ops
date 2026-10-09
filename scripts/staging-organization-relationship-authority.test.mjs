import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ORGANIZATION_RELATIONSHIP_TARGET as target, compileOrganizationRelationshipAuthority,
  applyAndReconcileOrganizationRelationshipAuthority } from "./staging-organization-relationship-authority.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";

const root=path.resolve(import.meta.dirname,".."),ids=["10000000-0000-4000-8000-000000000001","10000000-0000-4000-8000-000000000002"];
const migrations=fs.readdirSync(path.join(root,"apps/operations/migrations")).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
const grant=(id,permission)=>({id,staff_id:target.staffId,permission,effect:"allow",scope_kind:"resource",business_area_id:null,division_id:null,resource_id:target.recordId,active:1,granted_by:target.staffId,created_at:"2026-10-08T12:00:00.000Z"});
function fixture(phase="provision") { const provision=phase==="revoke"?compileOrganizationRelationshipAuthority(fixture()):null,grants=phase==="revoke"?[grant(ids[0],"directory.profile.edit"),grant(ids[1],"directory.identity.link")]:[];
 return {schemaVersion:1,staging:STAGING_TARGET,phase,target,migrationNames:migrations,
  admission:{staff_id:target.staffId,bound_access_subject:"access|staff",active:1,admitted_by:target.staffId,created_at:"2026-10-08T10:00:00.000Z",updated_at:"2026-10-08T10:00:00.000Z",version:1},
  profile:{staff_id:target.staffId,login_email:"staff@example.test",display_name:"Staff",version:1,created_at:"2026-10-08T10:00:00.000Z",updated_at:"2026-10-08T10:00:00.000Z"},
  generation:{staff_id:target.staffId,generation:phase==="revoke"?2:0,updated_at:"2026-10-08T10:00:00.000Z"},
  record:{record_id:target.recordId,record_kind:"organization",current_version:1},resourceScope:{record_id:target.recordId,scope_kind:"business_area",business_area_id:target.businessAreaId,division_id:null,active:1},grants,history:phase==="revoke"?grants.map((row,index)=>({grant_id:row.id,grant_version:1,staff_id:row.staff_id,permission:row.permission,effect:row.effect,scope_kind:row.scope_kind,business_area_id:null,division_id:null,resource_id:row.resource_id,active:1,grant_generation:index+1,recorded_at:"2026-10-08T12:00:00.000Z"})):[],
  approval:{approvalId:phase==="revoke"?"30000000-0000-4000-8000-000000000001":"20000000-0000-4000-8000-000000000001",commandId:phase==="revoke"?"30000000-0000-4000-8000-000000000002":"20000000-0000-4000-8000-000000000002",grantIds:ids,issuedAt:"2026-10-08T12:00:00.000Z",expiresAt:"2026-10-08T13:00:00.000Z",executedAt:"2026-10-08T12:00:00.000Z"},...(provision?{provisionArtifact:provision}:{})}; }

test("compiler grants only exact organization resource profile and identity authority",()=>{const artifact=compileOrganizationRelationshipAuthority(fixture()),sql=artifact.statements.map(row=>row.sql).join("\n");
 assert.match(sql,/scope_kind,business_area_id,division_id,resource_id/);assert.equal((sql.match(/'allow','resource',NULL,NULL/g)??[]).length,2);assert.doesNotMatch(sql,/'global'/);assert.deepEqual(artifact.input.approval.grantIds,ids);});
test("compiler rejects target, version, area, deny, and preexisting exact grant drift",()=>{for(const mutate of [v=>v.target={...v.target,recordId:"other"},v=>v.record.current_version=2,v=>v.resourceScope.business_area_id="other",v=>v.grants.push({...grant("deny","directory.profile.view"),effect:"deny"}),v=>v.grants.push(grant(ids[0],"directory.profile.edit"))]){const value=fixture();mutate(value);assert.throws(()=>compileOrganizationRelationshipAuthority(value));}});
test("paired revoke binds exact immutable provision and CAS disables only the same two IDs",()=>{const artifact=compileOrganizationRelationshipAuthority(fixture("revoke")),sql=artifact.statements.map(row=>row.sql).join("\n");assert.match(sql,/SET active=0 WHERE id=\?/);assert.match(sql,/provision-revoke-cas/);const bad=fixture("revoke");bad.provisionArtifact.receipt.command_id="forged";assert.throws(()=>compileOrganizationRelationshipAuthority(bad));});
test("paired revoke rejects a substituted current grant-ID pair",()=>{const bad=fixture("revoke");bad.approval.grantIds=[...bad.approval.grantIds];bad.approval.grantIds[1]="70000000-0000-4000-8000-000000000009";bad.grants[1]={...bad.grants[1],id:bad.approval.grantIds[1]};bad.history[1]={...bad.history[1],grant_id:bad.approval.grantIds[1]};assert.throws(()=>compileOrganizationRelationshipAuthority(bad),/immutable provision artifact/)});
test("unknown response reconciles only the immutable receipt",async()=>{const artifact=compileOrganizationRelationshipAuthority(fixture()),db={prepare:()=>({bind(){return this;},first:async()=>artifact.receipt})};assert.equal((await applyAndReconcileOrganizationRelationshipAuthority(db,artifact,{target:STAGING_TARGET,root})).status,"committed-after-response-recovery");});
