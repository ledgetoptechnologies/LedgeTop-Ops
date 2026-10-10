import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import { validateClosedRelationshipRecoveryLineageV184 } from "./staging-project-business-area-authority-v184.mjs";
import { RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2 } from "./staging-relationship-generation-recovery-authority-v184.mjs";
import { validateAcknowledgedScalarUpdate } from "./staging-directory-scalar-settlement.mjs";
import { validateAuthorityMigrationChainV185 } from "./staging-authority-migration-chain-v185.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN = Object.freeze({
  count: 184,
  final: "0184_project_alpha_directory_relationship_generation_recovery.sql",
  names: "c6d567a0c4d9450cc867d99db6188dc54e7a827e581059d4714e7bf55b66bc15",
  contents: "52a45f212ce83e639a9ac3b9753a7122a56d897c187bf4dcbc741b4a059948cc",
});
export const DIRECTORY_SCALAR_AUTHORITY_V184_TARGET = Object.freeze({
  staffId: "staff-beau-koltz",
  clientRecordId: "614ed50f-8800-4ab3-aa69-009d8e5cefa9",
  clientVersion: 2,
  organizationRecordId: "staging-directory-acceptance-ff089045-ea88-4c34-90a5-2ef898b9142f",
  organizationVersion: 1,
  relationshipVersion: 2,
  sourceId: "project-alpha:staging",
});
const GRANT = [
  "id", "staff_id", "permission", "effect", "scope_kind", "business_area_id",
  "division_id", "resource_id", "active", "granted_by", "created_at",
];
const HISTORY=["grant_id","grant_version","staff_id","permission","effect","scope_kind","business_area_id","division_id","resource_id","active","grant_generation","recorded_at"];
const APPROVAL=["approval_id","canonical_plan_json","canonical_plan_sha256","approved_operator_staff_id","approved_operator_access_subject","independent_binding_verification_json","independent_binding_verification_sha256","issued_by_staff_id","issued_by_access_subject","issued_at","expires_at","revoked_at"];
const RECEIPT=["command_id","approval_id","operator_staff_id","operator_access_subject","canonical_plan_json","canonical_plan_sha256","independent_binding_verification_json","independent_binding_verification_sha256","result_json","result_sha256","executed_at"];
const STAFF=["id","status","access_subject"],ADMISSION=["staff_id","bound_access_subject","active","admitted_by","created_at","updated_at","version"],PROFILE=["staff_id","login_email","display_name","version","created_at","updated_at"],GENERATION=["staff_id","generation","updated_at"],RECORD=["record_id","record_kind","current_version"],RELATIONSHIP=["client_record_id","organization_record_id","relationship_version"];
const PERMISSIONS=["directory.profile.edit","directory.identity.link"];
const TS=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=m=>{throw Error(`staging-directory-scalar-authority-v184: ${m}`)};
const sha=v=>crypto.createHash("sha256").update(v).digest("hex");
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const json=v=>JSON.stringify(canonical(v));
const exact=(v,keys,label)=>{if(!v||typeof v!=="object"||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||!same(Object.keys(v).sort(),[...keys].sort()))fail(`${label} shape`)};
const rows=(table,columns,wanted,predicate,params,label)=>{const compare=columns.map(c=>`a.${c} IS json_extract(e.value,'$.${c}')`).join(" AND "),query=`SELECT ${columns.join(",")} FROM ${table} WHERE ${predicate}`;return{sql:`SELECT CASE WHEN ((SELECT count(*) FROM (${query}))=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM (${query}) a WHERE NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE ${compare})) AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM (${query}) a WHERE ${compare}))) THEN 1 ELSE json('scalar-authority-${label}-guard-failed') END verified`,params:[...params,json(wanted),...params,json(wanted),json(wanted),...params]}};
const guard=(sql,params,label)=>({sql:`SELECT CASE WHEN (${sql}) THEN 1 ELSE json('scalar-authority-${label}-guard-failed') END verified`,params});
const insert=(table,columns,row)=>({sql:`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`,params:columns.map(k=>row[k])});
function migrations(root,names){return validateAuthorityMigrationChainV185(root,names,fail)}
function completeHistory(i){
  const grants=new Map(i.grants.map(row=>[row.id,row]));
  if(grants.size!==i.grants.length||i.history.length!==i.generation.generation
    ||new Set(i.history.map(row=>row.grant_generation)).size!==i.history.length
    ||i.history.some(row=>row.staff_id!==i.target.staffId||!grants.has(row.grant_id)
      ||!Number.isSafeInteger(row.grant_generation)||row.grant_generation<1||!TS.test(row.recorded_at)))fail("complete grant history required");
  for(let generation=1;generation<=i.generation.generation;generation++)if(!i.history.some(row=>row.grant_generation===generation))fail("continuous grant history required");
  for(const grant of i.grants){
    const history=i.history.filter(row=>row.grant_id===grant.id).sort((a,b)=>a.grant_version-b.grant_version);
    if(!history.length||history.some((row,index)=>row.grant_version!==index+1
      ||!["staff_id","permission","effect","scope_kind","business_area_id","division_id","resource_id"].every(key=>row[key]===grant[key]))
      ||history.at(-1).active!==grant.active)fail("current immutable grant history required");
  }
}
function selected(i){return PERMISSIONS.map(permission=>{const found=i.grants.filter(g=>g.staff_id===i.target.staffId&&g.permission===permission&&g.effect==="allow"&&g.scope_kind==="resource"&&g.business_area_id===null&&g.division_id===null&&g.resource_id===i.target.clientRecordId);if(found.length!==1)fail(`exact ${permission} grant required`);return found[0]})}
const byId=values=>[...values].sort((a,b)=>a.id.localeCompare(b.id));
const byGeneration=values=>[...values].sort((a,b)=>a.grant_generation-b.grant_generation);
function validateAuthorityTransition(i,chosen){
  const closed=i.recoveryLineage;
  if(i.phase==="provision"){
    const closedActor=closed.revokeArtifact.input;
    if(!same(i.staff,closedActor.staff)||!same(i.admission,closedActor.admission)||!same(i.profile,closedActor.profile)
      ||!same(byId(i.grants),byId(closed.directoryGrants))||!same(byGeneration(i.history),byGeneration(closed.directoryGrantHistory))
      ||!same(i.generation,closed.directoryGrantGeneration))fail("exact closed recovery authority required");
    return;
  }
  const before=i.provisionArtifact.input,ids=chosen.map(row=>row.id),expectedGrants=before.grants.map(row=>ids.includes(row.id)?{...row,active:1}:row);
  if(!same(i.staff,before.staff)||!same(i.admission,before.admission)||!same(i.profile,before.profile)
    ||!same(i.recoveryLineage,before.recoveryLineage)||!same(byId(i.grants),byId(expectedGrants))
    ||i.generation.staff_id!==before.generation.staff_id||i.generation.generation!==before.generation.generation+2
    ||!TS.test(i.generation.updated_at))fail("exact provision authority successor required");
  const prefix=i.history.filter(row=>row.grant_generation<=before.generation.generation),suffix=byGeneration(i.history.filter(row=>row.grant_generation>before.generation.generation));
  if(!same(byGeneration(prefix),byGeneration(before.history))||suffix.length!==2)fail("exact two activation history successors required");
  for(const [index,row] of suffix.entries()){
    const grant=expectedGrants.find(value=>value.id===ids[index]),prior=before.history.filter(value=>value.grant_id===ids[index]).length;
    const structural=row&&Object.fromEntries(Object.entries(row).filter(([key])=>key!=="recorded_at"));
    const expected={grant_id:grant.id,grant_version:prior+1,staff_id:grant.staff_id,permission:grant.permission,effect:grant.effect,scope_kind:grant.scope_kind,business_area_id:grant.business_area_id,division_id:grant.division_id,resource_id:grant.resource_id,active:1,grant_generation:before.generation.generation+index+1};
    if(!same(structural,expected)||!TS.test(row.recorded_at))fail("exact two activation history successors required");
  }
  if(Math.min(...suffix.map(row=>Date.parse(row.recorded_at)))<Date.parse(i.provisionArtifact.receipt.executed_at)
    ||Math.max(...suffix.map(row=>Date.parse(row.recorded_at)))!==Date.parse(i.generation.updated_at))fail("activation generation timestamp mismatch");
}
function snapshotReadbackStatements(s,recordId,label){const result=[
  rows("operations_directory_records",Object.keys(s.record),[s.record],"record_id=?",[recordId],`${label}-record`),
  rows("operations_directory_client_organizations",Object.keys(s.relationship),[s.relationship],"client_record_id=?",[recordId],"settled-relationship"),
  rows("native_directory_enrollments",Object.keys(s.enrollment),[s.enrollment],"record_id=?",[recordId],"settled-enrollment")];
  const exactArray=(table,values,predicate,params,rowLabel)=>result.push(values.length
    ?rows(table,Object.keys(values[0]),values,predicate,params,rowLabel)
    :guard(`NOT EXISTS(SELECT 1 FROM ${table} WHERE ${predicate})`,params,rowLabel));
  exactArray("operations_directory_revisions",s.revisions,"record_id=?",[recordId],"settled-revisions");
  exactArray("operations_directory_audit",s.audits,"record_id=?",[recordId],"settled-audits");
  exactArray("operations_directory_intents",s.intents,"record_id=?",[recordId],"settled-intents");
  exactArray("operations_directory_materializations",s.materializations,"intent_id IN (SELECT intent_id FROM operations_directory_intents WHERE record_id=?)",[recordId],"settled-materializations");
  exactArray("project_alpha_directory_outbox",s.outbox,"command_id IN (SELECT m.command_id FROM operations_directory_materializations m JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=?)",[recordId],"settled-outbox");
  exactArray("operations_directory_client_organization_history",s.relationshipHistory,"client_record_id=?",[recordId],"settled-relationship-history");
  exactArray("native_directory_resource_scopes",s.resourceScopes,"record_id=?",[recordId],"settled-scopes");
  const dependencies=s.relationshipDependencies.map(x=>Object.fromEntries(Object.entries(x).filter(([k])=>k!=="resolved_parent_public_id")));
  exactArray("operations_directory_intent_relationship_dependencies",dependencies,"client_record_id=?",[recordId],"settled-dependencies");
  for(const proof of s.relationshipDependencyEvidence){result.push(rows("project_alpha_active_directory_mappings",Object.keys(proof.activeMapping),[proof.activeMapping],"provenance_id=? AND record_id=?",[proof.activeMapping.provenance_id,proof.activeMapping.record_id],"settled-parent-mapping"),rows("project_alpha_existing_directory_binding_activation_receipts",Object.keys(proof.activationReceipt),[proof.activationReceipt],"activation_id=?",[proof.activationReceipt.activation_id],"settled-parent-activation"));}
  const protectedTables={records:"operations_directory_records",resourceScopes:"native_directory_resource_scopes",enrollments:"native_directory_enrollments",relationships:"operations_directory_client_organizations",relationshipHistory:"operations_directory_client_organization_history"};
  for(const [name,table] of Object.entries(protectedTables)){
    const values=s.protectedSnapshots[name];
    const allRelationships=table==="operations_directory_client_organizations"||table==="operations_directory_client_organization_history",predicate=allRelationships?"1":"record_id<>?",params=allRelationships?[]:[recordId];
    if(values.length)result.push(rows(table,Object.keys(values[0]),values,predicate,params,`${label}-protected-${name}`));
    else result.push(guard(`NOT EXISTS(SELECT 1 FROM ${table} WHERE ${predicate})`,params,`${label}-protected-${name}`));
  }
  return result;
}
function validateScalarPrestate(value,target,grantIds,actorState){
  exact(value,["plan","before"],"scalar prestate");
  const p=value.plan,b=value.before;
  exact(p,["recordId","kind","mutationId","actor","expectedLocalVersion","field","beforeProfile","afterProfile","destinations","temporaryGrantIds"],"scalar plan");
  if(p.recordId!==target.clientRecordId||p.kind!=="client"||p.expectedLocalVersion!==target.clientVersion
    ||!same(p.actor,{staffId:target.staffId,accessSubject:actorState.admission.bound_access_subject,
      loginEmail:actorState.profile.login_email,admissionVersion:actorState.admission.version,
      profileVersion:actorState.profile.version,selectedGrantId:grantIds[0],selectedIdentityGrantId:grantIds[1]})
    ||p.temporaryGrantIds?.profileEdit!==grantIds[0]
    ||p.temporaryGrantIds?.identityLink!==grantIds[1]||p.field!=="email"
    ||!p.beforeProfile||!p.afterProfile||Object.getPrototypeOf(p.beforeProfile)!==Object.prototype
    ||Object.getPrototypeOf(p.afterProfile)!==Object.prototype)fail("exact intended scalar plan required");
  const keys=new Set([...Object.keys(p.beforeProfile),...Object.keys(p.afterProfile)]),changed=[...keys].filter(key=>!same(p.beforeProfile[key],p.afterProfile[key]));
  if(changed.length!==1||changed[0]!==p.field)fail("exact one-field scalar plan required");
  const phase=["record","revisions","audits","intents","materializations","outbox","relationshipDependencies","relationshipDependencyEvidence","relationship","relationshipHistory","resourceScopes","enrollment","protectedSnapshots"];
  exact(b,phase,"scalar before");
  if(!same(b.record,{record_id:target.clientRecordId,record_kind:"client",current_version:target.clientVersion})
    ||b.relationship?.client_record_id!==target.clientRecordId||b.relationship?.organization_record_id!==target.organizationRecordId
    ||b.relationship?.relationship_version!==target.relationshipVersion
    ||!same(b.resourceScopes,[{record_id:target.clientRecordId,scope_kind:"business_area",business_area_id:RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2.clientBusinessAreaId,division_id:null,active:1}]))fail("exact scalar prestate record, relationship, and current scope required");
}
export function compileDirectoryScalarAuthorityV184(raw,{root=ROOT}={}){
  const i=structuredClone(raw);exact(i,["schemaVersion","staging","phase","target","migrationNames","staff","admission","profile","generation","record","relationship","grants","history","recoveryLineage","scalarPrestate","approval",...(raw.phase==="revoke"?["provisionArtifact","settlement"]:[])],"input");
  const migrationChain=migrations(root,i.migrationNames);if(i.schemaVersion!==1||!same(i.staging,STAGING_TARGET)||!same(i.target,DIRECTORY_SCALAR_AUTHORITY_V184_TARGET)||!["provision","revoke"].includes(i.phase))fail("exact staging v184 target required");
  exact(i.staff,STAFF,"staff");exact(i.admission,ADMISSION,"admission");exact(i.profile,PROFILE,"profile");exact(i.generation,GENERATION,"generation");exact(i.record,RECORD,"record");exact(i.relationship,RELATIONSHIP,"relationship");i.grants.forEach(x=>exact(x,GRANT,"grant"));i.history.forEach(x=>exact(x,HISTORY,"history"));
  if(i.staff.id!==i.target.staffId||i.staff.status!=="active"||i.staff.access_subject!==i.admission.bound_access_subject||i.admission.staff_id!==i.target.staffId||i.admission.active!==1||i.profile.staff_id!==i.target.staffId||i.generation.staff_id!==i.target.staffId||!Number.isSafeInteger(i.generation.generation)||i.generation.generation<1)fail("active exact actor required");
  const expectedVersion=i.phase==="provision"?i.target.clientVersion:i.target.clientVersion+1;if(!same(i.record,{record_id:i.target.clientRecordId,record_kind:"client",current_version:expectedVersion})||!same(i.relationship,{client_record_id:i.target.clientRecordId,organization_record_id:i.target.organizationRecordId,relationship_version:i.target.relationshipVersion}))fail("exact record and relationship required");
  if(i.grants.some(g=>g.staff_id!==i.target.staffId)||i.grants.some(g=>g.effect==="deny"&&g.active===1))fail("complete no-deny grant snapshot required");completeHistory(i);
  const recovery=validateClosedRelationshipRecoveryLineageV184(i.recoveryLineage,{root}),chosen=selected(i),active=i.phase==="provision"?1:0;
  if(![2,3].includes(i.recoveryLineage.provisionArtifact.input.schemaVersion)||i.recoveryLineage.revokeArtifact.input.schemaVersion!==i.recoveryLineage.provisionArtifact.input.schemaVersion
    ||!same(i.recoveryLineage.provisionArtifact.input.target,RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2)
    ||!same(i.recoveryLineage.revokeArtifact.input.target,RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2))fail("exact closed v2 recovery lineage required");
  if(chosen.some(g=>g.active!==(active?0:1)||g.granted_by!==i.target.staffId))fail("exact paired grant prestate required");
  const recoveryIds=recovery.grantIds.slice(0,2);if(!same(chosen.map(x=>x.id),recoveryIds))fail("closed recovery grant identity required");
  validateAuthorityTransition(i,chosen);
  validateScalarPrestate(i.scalarPrestate,i.target,recoveryIds,i);
  exact(i.approval,["approvalId","commandId","issuedAt","expiresAt","executedAt"],"approval");
  const issued=Date.parse(i.approval.issuedAt),expires=Date.parse(i.approval.expiresAt),executed=Date.parse(i.approval.executedAt);
  const historicalIds=new Set([recovery.provisionApprovalId,recovery.revokeApprovalId,
    i.recoveryLineage.provisionArtifact.receipt.command_id,i.recoveryLineage.revokeArtifact.receipt.command_id,
    ...(i.provisionArtifact?[i.provisionArtifact.approval.approval_id,i.provisionArtifact.receipt.command_id]:[])]);
  if(!UUID.test(i.approval.approvalId)||!UUID.test(i.approval.commandId)||i.approval.approvalId===i.approval.commandId
    ||historicalIds.has(i.approval.approvalId)||historicalIds.has(i.approval.commandId)
    ||![i.approval.issuedAt,i.approval.expiresAt,i.approval.executedAt].every(value=>typeof value==="string"&&TS.test(value))
    ||!Number.isFinite(issued)||!Number.isFinite(expires)||!Number.isFinite(executed)
    ||expires<=issued||expires-issued>4*60*60_000||executed<issued||executed>=expires)fail("bounded fresh approval required");
  let settlementHash=null;if(i.phase==="revoke"){if(!i.provisionArtifact||!same(i.provisionArtifact,compileDirectoryScalarAuthorityV184(i.provisionArtifact.input,{root})))fail("exact paired provision artifact required");const settled=validateAcknowledgedScalarUpdate(i.settlement),p=i.settlement.plan;if(!same(i.scalarPrestate,i.provisionArtifact.input.scalarPrestate)||!same(p,i.scalarPrestate.plan)||!same(i.settlement.before,i.scalarPrestate.before)||settled.status!=="acknowledged"||p.kind!=="client"||p.recordId!==i.target.clientRecordId||p.expectedLocalVersion!==i.target.clientVersion||p.actor.staffId!==i.target.staffId||p.temporaryGrantIds.profileEdit!==chosen[0].id||p.temporaryGrantIds.identityLink!==chosen[1].id)fail("exact acknowledged scalar settlement required");settlementHash=sha(json(i.settlement))}
  const compactRecovery={provisionApprovalId:recovery.provisionApprovalId,revokeApprovalId:recovery.revokeApprovalId,provisionSha256:sha(json(i.recoveryLineage.provisionArtifact)),revokeSha256:sha(json(i.recoveryLineage.revokeArtifact))};
  const plan=json({...i,recoveryLineage:compactRecovery,...(i.provisionArtifact?{provisionArtifact:{approvalId:i.provisionArtifact.approval.approval_id,commandId:i.provisionArtifact.receipt.command_id,sha256:sha(json(i.provisionArtifact))}}:{}),...(i.settlement?{settlementSha256:settlementHash}:{} )}),planHash=sha(plan),verification=json({staging:i.staging,target:i.target,migrationChain,recoveryLineage:compactRecovery,grantIds:chosen.map(x=>x.id),settlementSha256:settlementHash});
  if(Buffer.byteLength(plan)>262_144||Buffer.byteLength(verification)>262_144)fail("bounded evidence required");const result=json({phase:i.phase,grantIds:chosen.map(x=>x.id),generation:i.generation.generation+2,active,settlementSha256:settlementHash});
  const approval={approval_id:i.approval.approvalId,canonical_plan_json:plan,canonical_plan_sha256:planHash,approved_operator_staff_id:i.target.staffId,approved_operator_access_subject:i.admission.bound_access_subject,independent_binding_verification_json:verification,independent_binding_verification_sha256:sha(verification),issued_by_staff_id:i.target.staffId,issued_by_access_subject:i.admission.bound_access_subject,issued_at:i.approval.issuedAt,expires_at:i.approval.expiresAt,revoked_at:null};
  const receipt={command_id:i.approval.commandId,approval_id:approval.approval_id,operator_staff_id:i.target.staffId,operator_access_subject:i.admission.bound_access_subject,canonical_plan_json:plan,canonical_plan_sha256:planHash,independent_binding_verification_json:verification,independent_binding_verification_sha256:sha(verification),result_json:result,result_sha256:sha(result),executed_at:i.approval.executedAt};
  const statements=[rows("d1_migrations",["name"],i.migrationNames.map(name=>({name})),"1",[],"migrations"),rows("staff_users",STAFF,[i.staff],"id=?",[i.target.staffId],"staff"),rows("native_staff_admissions",ADMISSION,[i.admission],"staff_id=?",[i.target.staffId],"admission"),rows("native_staff_profiles",PROFILE,[i.profile],"staff_id=?",[i.target.staffId],"profile"),rows("native_directory_grant_generations",GENERATION,[i.generation],"staff_id=?",[i.target.staffId],"generation"),rows("operations_directory_records",RECORD,[i.record],"record_id=?",[i.target.clientRecordId],"record"),rows("operations_directory_client_organizations",RELATIONSHIP,[i.relationship],"client_record_id=?",[i.target.clientRecordId],"relationship"),rows("native_directory_grants",GRANT,i.grants,"staff_id=?",[i.target.staffId],"grants"),rows("native_directory_grant_history",HISTORY,i.history,"staff_id=?",[i.target.staffId],"history"),rows("native_staff_bootstrap_approvals",APPROVAL,i.recoveryLineage.approvals,"approval_id IN (?,?)",[recovery.provisionApprovalId,recovery.revokeApprovalId],"recovery-approvals"),rows("native_staff_bootstrap_receipts",RECEIPT,i.recoveryLineage.receipts,"command_id IN (?,?)",[i.recoveryLineage.provisionArtifact.receipt.command_id,i.recoveryLineage.revokeArtifact.receipt.command_id],"recovery-receipts"),guard("NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=? AND effect='deny' AND active=1)",[i.target.staffId],"deny"),guard("NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=?) AND NOT EXISTS(SELECT 1 FROM operations_directory_relationship_write_fences WHERE actor_staff_id=? OR client_record_id=?) AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE state IN ('pending','leased') AND json_extract(origin_snapshot_json,'$.actorId')=?) AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox WHERE state IN ('pending','leased')) AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_recovery_outbox WHERE state IN ('pending','leased'))",[i.target.staffId,i.target.staffId,i.target.clientRecordId,i.target.staffId],"quiet"),guard("NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approved_operator_staff_id=? AND revoked_at IS NULL AND julianday(expires_at)>julianday('now') AND approval_id NOT IN (?,?,?))",[i.target.staffId,i.approval.approvalId,recovery.revokeApprovalId,i.phase==="revoke"?i.provisionArtifact.approval.approval_id:""],"open-window"),guard("julianday(?)<=julianday('now') AND julianday(?)>julianday('now') AND julianday(?)<=julianday('now') AND julianday(?)>=julianday('now','-5 minutes') AND julianday(?)>=julianday(?) AND julianday(?)<julianday(?)",[i.approval.issuedAt,i.approval.expiresAt,i.approval.executedAt,i.approval.executedAt,i.approval.executedAt,i.approval.issuedAt,i.approval.executedAt,i.approval.expiresAt],"expiry"),insert("native_staff_bootstrap_approvals",APPROVAL,approval)];
  statements.splice(-1,0,...snapshotReadbackStatements(i.phase==="provision"?i.scalarPrestate.before:i.settlement.settled,i.target.clientRecordId,i.phase==="provision"?"planned":"settled"));
  if(i.phase==="revoke")statements.push(rows("native_staff_bootstrap_approvals",APPROVAL,[i.provisionArtifact.approval],"approval_id=?",[i.provisionArtifact.approval.approval_id],"provision-approval"),rows("native_staff_bootstrap_receipts",RECEIPT,[i.provisionArtifact.receipt],"command_id=?",[i.provisionArtifact.receipt.command_id],"provision-receipt"),{sql:"UPDATE native_staff_bootstrap_approvals SET revoked_at=? WHERE approval_id=? AND revoked_at IS NULL",params:[i.approval.executedAt,i.provisionArtifact.approval.approval_id]},guard("changes()=1",[],"paired-revoke"));
  chosen.forEach((g,index)=>statements.push({sql:"UPDATE native_directory_grants SET active=? WHERE id=? AND staff_id=? AND permission=? AND effect='allow' AND scope_kind='resource' AND resource_id=? AND active=?",params:[active,g.id,i.target.staffId,g.permission,i.target.clientRecordId,active?0:1]},guard("changes()=1",[],`grant-${index}-cas`),guard("EXISTS(SELECT 1 FROM native_directory_grant_history WHERE grant_id=? AND grant_version=? AND active=? AND grant_generation=?)",[g.id,i.history.filter(h=>h.grant_id===g.id).length+1,active,i.generation.generation+index+1],`grant-${index}-history`)));
  statements.push(guard("(SELECT generation FROM native_directory_grant_generations WHERE staff_id=?)=?",[i.target.staffId,i.generation.generation+2],"generation-post"),guard("(SELECT count(*) FROM native_directory_grant_history WHERE staff_id=? AND grant_generation>?)=2",[i.target.staffId,i.generation.generation],"history-post"),insert("native_staff_bootstrap_receipts",RECEIPT,receipt),rows("native_staff_bootstrap_receipts",RECEIPT,[receipt],"command_id=?",[receipt.command_id],"receipt"));
  return Object.freeze({schemaVersion:1,input:i,selection:chosen.map(g=>({grantId:g.id,permission:g.permission})),approval,receipt,statements});
}
export async function applyDirectoryScalarAuthorityV184(db,artifact,{target=STAGING_TARGET,root=ROOT}={}){assert.deepEqual(target,STAGING_TARGET);assert.deepEqual(artifact,compileDirectoryScalarAuthorityV184(artifact.input,{root}));return db.batch(artifact.statements.map(s=>db.prepare(s.sql).bind(...s.params)))}
