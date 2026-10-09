import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import { REVIEWED_REFERENCE_BASELINE, verifyReviewedReferenceSchema } from "./staging-retained-directory-authority.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ORGANIZATION_RELATIONSHIP_TARGET = Object.freeze({ staffId: "staff-beau-koltz",
  recordId: "staging-directory-acceptance-ff089045-ea88-4c34-90a5-2ef898b9142f", recordKind: "organization",
  recordVersion: 1, sourceId: "project-alpha:staging", businessAreaId: "drone-services-staging" });
const PERMISSIONS = ["directory.profile.edit", "directory.identity.link"];
const GRANT = ["id","staff_id","permission","effect","scope_kind","business_area_id","division_id","resource_id","active","granted_by","created_at"];
const HISTORY = ["grant_id","grant_version","staff_id","permission","effect","scope_kind","business_area_id","division_id","resource_id","active","grant_generation","recorded_at"];
const APPROVAL = ["approval_id","canonical_plan_json","canonical_plan_sha256","approved_operator_staff_id","approved_operator_access_subject","independent_binding_verification_json","independent_binding_verification_sha256","issued_by_staff_id","issued_by_access_subject","issued_at","expires_at","revoked_at"];
const RECEIPT = ["command_id","approval_id","operator_staff_id","operator_access_subject","canonical_plan_json","canonical_plan_sha256","independent_binding_verification_json","independent_binding_verification_sha256","result_json","result_sha256","executed_at"];
const CHAIN = { count:182, final:"0182_project_alpha_directory_relationship_recovery_guard.sql",
  names:"5ca01798b82652a4b6bb64a35be85a82673d940d6e762805c147408e3ca298d8",
  contents:"09ebfcc544263a90c96b8ed5548cdc73e38e524aec977aa37042bc280f9dae56" };
const TS=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const fail = message => { throw new Error(`staging-organization-relationship-authority: ${message}`); };
const guard = (condition, params, label) => ({ sql:`SELECT CASE WHEN (${condition}) THEN 1 ELSE json('organization-relationship-${label}-failed') END verified`,params });
const insert = (table, columns, row) => ({ sql:`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`,params:columns.map(key=>row[key]) });
const equality=(table,columns,rows,where,params=[])=>guard(`(SELECT count(*) FROM ${table} WHERE ${where})=json_array_length(?) AND NOT EXISTS(SELECT 1 FROM ${table} actual WHERE ${where} AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE ${columns.map(key=>`json_extract(expected.value,'$.${key}') IS actual.${key}`).join(" AND ")}))`,[...params,JSON.stringify(rows),...params,JSON.stringify(rows)],`${table}-snapshot`);
function exact(value, keys, label) { if (!value || Object.getPrototypeOf(value)!==Object.prototype || !same(Object.keys(value).sort(),[...keys].sort())) fail(`${label} shape`); }
function migrations(root=ROOT) { const directory=path.join(root,"apps/operations/migrations"),names=fs.readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
  const contents=names.map(name=>`${name}\0${sha(fs.readFileSync(path.join(directory,name)))}`);
  if(names.length!==CHAIN.count||names.at(-1)!==CHAIN.final||sha(names.join("\n"))!==CHAIN.names||sha(contents.join("\n"))!==CHAIN.contents)fail("canonical 182 migration chain required");return names; }
const targetGrant=(row,permission,target)=>row.staff_id===target.staffId&&row.permission===permission&&row.effect==="allow"&&row.scope_kind==="resource"&&row.resource_id===target.recordId;
const exactGrant=(row,permission,target,active)=>targetGrant(row,permission,target)&&row.business_area_id===null&&row.division_id===null&&row.active===active&&row.granted_by===target.staffId&&typeof row.created_at==="string"&&TS.test(row.created_at);
const historyIdentity=(row,grant)=>row.staff_id===grant.staff_id&&row.permission===grant.permission&&row.effect===grant.effect&&row.scope_kind===grant.scope_kind&&row.business_area_id===grant.business_area_id&&row.division_id===grant.division_id&&row.resource_id===grant.resource_id;
function validateHistorySnapshot(input) {
  if(!Number.isSafeInteger(input.generation.generation)||input.generation.generation<0||typeof input.generation.updated_at!=="string"||!TS.test(input.generation.updated_at))fail("exact grant generation required");
  if(input.history.length!==input.generation.generation)fail("complete grant history generation required");
  const grants=new Map();
  for(const grant of input.grants) { if(grant.staff_id!==input.target.staffId||grants.has(grant.id))fail("complete unique staff grant snapshot required");grants.set(grant.id,grant); }
  const chains=new Map([...grants.keys()].map(id=>[id,[]]));
  for(const row of input.history) {
    if(row.staff_id!==input.target.staffId||!grants.has(row.grant_id)||!Number.isSafeInteger(row.grant_version)||row.grant_version<1||!Number.isSafeInteger(row.grant_generation)||row.grant_generation<1||row.grant_generation>input.generation.generation||typeof row.recorded_at!=="string"||!TS.test(row.recorded_at)||!historyIdentity(row,grants.get(row.grant_id)))fail("complete immutable grant history required");
    chains.get(row.grant_id).push(row);
  }
  const ordered=[...input.history].sort((a,b)=>a.grant_generation-b.grant_generation);
  if(ordered.some((row,index)=>row.grant_generation!==index+1||Date.parse(row.recorded_at)>Date.parse(input.generation.updated_at)||(index>0&&Date.parse(row.recorded_at)<Date.parse(ordered[index-1].recorded_at))))fail("continuous chronological grant generations required");
  for(const [id,grant] of grants) { const rows=chains.get(id).sort((a,b)=>a.grant_version-b.grant_version);if(rows.length===0||rows.some((row,index)=>row.grant_version!==index+1)||rows.at(-1).active!==grant.active)fail("continuous current grant history required"); }
  return chains;
}
function validateTargetChain(rows,grant) {
  if(rows.length===0||rows.some((row,index)=>row.active!==(index%2===0?1:0))||rows.at(-1).active!==grant.active)fail("exact target grant history chain required");
  return rows.at(-1).grant_version+1;
}
function selectGrantOperation(input,chains) {
  const candidates=PERMISSIONS.map(permission=>input.grants.filter(row=>targetGrant(row,permission,input.target)));
  if(candidates.some(rows=>rows.length>1))fail("ambiguous target grant rows forbidden");
  const selected=input.approval.grantIds.map(id=>input.grants.find(row=>row.id===id));
  if(input.phase==="provision") {
    if(selected.every(row=>row===undefined)) {
      if(candidates.some(rows=>rows.length!==0)||input.approval.grantIds.some(id=>input.history.some(row=>row.grant_id===id)))fail("fresh grant ids conflict with retained authority");
      return {mode:"fresh",historyVersions:[1,1]};
    }
    if(selected.some(row=>row===undefined)||candidates.some((rows,index)=>rows.length!==1||rows[0]!==selected[index])||selected.some((row,index)=>!exactGrant(row,PERMISSIONS[index],input.target,0)))fail("exact inactive target grant pair required");
    return {mode:"reactivate",historyVersions:selected.map((row,index)=>validateTargetChain(chains.get(row.id),row))};
  }
  if(selected.some(row=>row===undefined)||candidates.some((rows,index)=>rows.length!==1||rows[0]!==selected[index])||selected.some((row,index)=>!exactGrant(row,PERMISSIONS[index],input.target,1)))fail("exact active target grant pair required");
  return {mode:"revoke",historyVersions:selected.map((row,index)=>validateTargetChain(chains.get(row.id),row))};
}
function verifyProvisionPoststate(input,selection) {
  const provision=input.provisionArtifact,prior=provision.input,priorIds=new Set(prior.approval.grantIds),currentIds=new Set(input.approval.grantIds);
  if(!same(input.staging,prior.staging)||!same(input.target,prior.target)||!same(input.migrationNames,prior.migrationNames)||!same(input.admission,prior.admission)||!same(input.profile,prior.profile)||!same(input.record,prior.record)||!same(input.resourceScope,prior.resourceScope))fail("immutable provision context changed");
  if(input.generation.generation!==prior.generation.generation+2||Date.parse(input.generation.updated_at)<Date.parse(prior.generation.updated_at)||selection.historyVersions.some((version,index)=>version!==provision.selection.historyVersions[index]+1))fail("exact prior provision poststate required");
  const priorOther=prior.grants.filter(row=>!priorIds.has(row.id)),currentOther=input.grants.filter(row=>!currentIds.has(row.id));
  if(!same(priorOther,currentOther)||input.history.length!==prior.history.length+2||prior.history.some(row=>!input.history.some(current=>same(current,row))))fail("immutable provision snapshot changed");
  if(provision.selection.mode==="reactivate"&&input.approval.grantIds.some(id=>{const before=prior.grants.find(row=>row.id===id),after=input.grants.find(row=>row.id===id);return !same(after,{...before,active:1});}))fail("reactivated grant metadata changed");
  for(const [index,id] of input.approval.grantIds.entries()) { const row=input.history.find(candidate=>candidate.grant_id===id&&candidate.grant_version===provision.selection.historyVersions[index]),grant=input.grants.find(candidate=>candidate.id===id);if(!row||row.active!==1||row.grant_generation!==prior.generation.generation+index+1||Date.parse(row.recorded_at)<Date.parse(prior.generation.updated_at)||(provision.selection.mode==="fresh"&&(Date.parse(grant.created_at)<Date.parse(prior.generation.updated_at)||Date.parse(grant.created_at)>Date.parse(input.generation.updated_at))))fail("exact provision history suffix required"); }
}
function approvalRows(input,plan,selection) { const p=input.approval,planSha=sha(plan),verification=json({staging:STAGING_TARGET,target:ORGANIZATION_RELATIONSHIP_TARGET,migrations:sha(input.migrationNames.join("\n"))}),result=json({phase:input.phase,operation:selection.mode,grantIds:p.grantIds,grantVersions:selection.historyVersions,active:input.phase==="provision"?1:0,generation:input.generation.generation+2});
  const approval={approval_id:p.approvalId,canonical_plan_json:plan,canonical_plan_sha256:planSha,approved_operator_staff_id:input.target.staffId,approved_operator_access_subject:input.admission.bound_access_subject,independent_binding_verification_json:verification,independent_binding_verification_sha256:sha(verification),issued_by_staff_id:input.target.staffId,issued_by_access_subject:input.admission.bound_access_subject,issued_at:p.issuedAt,expires_at:p.expiresAt,revoked_at:null};
  return {approval,receipt:{command_id:p.commandId,approval_id:p.approvalId,operator_staff_id:input.target.staffId,operator_access_subject:input.admission.bound_access_subject,canonical_plan_json:plan,canonical_plan_sha256:planSha,independent_binding_verification_json:verification,independent_binding_verification_sha256:sha(verification),result_json:result,result_sha256:sha(result),executed_at:p.executedAt}}; }

export function compileOrganizationRelationshipAuthority(raw,{root=ROOT}={}) {
  const input=structuredClone(raw); exact(input,["schemaVersion","staging","phase","target","migrationNames","admission","profile","generation","record","resourceScope","grants","history","approval",...(raw.phase==="revoke"?["provisionArtifact"]:[])],"input");
  if(input.schemaVersion!==2||!same(input.staging,STAGING_TARGET)||!same(input.target,ORGANIZATION_RELATIONSHIP_TARGET)||!same(input.migrationNames,migrations(root))||!["provision","revoke"].includes(input.phase))fail("version 2 exact reviewed target required");
  if(!same(input.record,{record_id:input.target.recordId,record_kind:"organization",current_version:1})||!same(input.resourceScope,{record_id:input.target.recordId,scope_kind:"business_area",business_area_id:input.target.businessAreaId,division_id:null,active:1}))fail("exact current organization resource required");
  if(input.admission.staff_id!==input.target.staffId||input.admission.active!==1||input.profile.staff_id!==input.target.staffId||input.generation.staff_id!==input.target.staffId)fail("active operator snapshot required");
  if(!Array.isArray(input.grants)||!Array.isArray(input.history))fail("complete grant snapshot required");input.grants.forEach(row=>exact(row,GRANT,"grant"));input.history.forEach(row=>exact(row,HISTORY,"history"));
  exact(input.approval,["approvalId","commandId","grantIds","issuedAt","expiresAt","executedAt"],"approval");
  if(!Array.isArray(input.approval.grantIds)||input.approval.grantIds.length!==2||new Set(input.approval.grantIds).size!==2)fail("exact two grant ids required");
  if(input.grants.some(row=>row.staff_id===input.target.staffId&&row.effect==="deny"&&row.active===1))fail("active Directory deny forbidden");
  const chains=validateHistorySnapshot(input),selection=selectGrantOperation(input,chains);
  if(![input.approval.issuedAt,input.approval.expiresAt,input.approval.executedAt].every(value=>typeof value==="string"&&!Number.isNaN(Date.parse(value)))||Date.parse(input.approval.expiresAt)<=Date.parse(input.approval.issuedAt)||Date.parse(input.approval.expiresAt)-Date.parse(input.approval.issuedAt)>4*3600000||Date.parse(input.approval.executedAt)<Date.parse(input.approval.issuedAt)||Date.parse(input.approval.executedAt)>=Date.parse(input.approval.expiresAt))fail("bounded fresh approval required");
  if(input.phase==="revoke"&&(!input.provisionArtifact||input.provisionArtifact.input?.phase!=="provision"||!same(input.approval.grantIds,input.provisionArtifact.input.approval.grantIds)||!same(input.provisionArtifact,compileOrganizationRelationshipAuthority(input.provisionArtifact.input,{root}))))fail("exact immutable provision artifact required");
  if(input.phase==="revoke")verifyProvisionPoststate(input,selection);
  const plan=json({...input,provisionArtifact:input.provisionArtifact?{approvalId:input.provisionArtifact.approval.approval_id,commandId:input.provisionArtifact.receipt.command_id,sha256:sha(json(input.provisionArtifact))}:undefined}),{approval,receipt}=approvalRows(input,plan,selection),active=input.phase==="provision"?1:0;
  if(Buffer.byteLength(plan)>262144)fail("bounded canonical plan required");
  const statements=[equality("d1_migrations",["name"],input.migrationNames.map(name=>({name})),"1"),
    equality("native_staff_admissions",Object.keys(input.admission),[input.admission],"staff_id=?",[input.target.staffId]),
    equality("native_staff_profiles",Object.keys(input.profile),[input.profile],"staff_id=?",[input.target.staffId]),
    equality("native_directory_grant_generations",Object.keys(input.generation),[input.generation],"staff_id=?",[input.target.staffId]),
    equality("native_directory_grants",GRANT,input.grants,"staff_id=?",[input.target.staffId]),
    equality("native_directory_grant_history",HISTORY,input.history,"staff_id=?",[input.target.staffId]),
    guard("NOT EXISTS(SELECT 1 FROM native_staff_management_fences WHERE actor_staff_id=? OR target_staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_staff_admin_command_fences WHERE actor_staff_id=? OR target_staff_id=?) AND NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=?) AND NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox o JOIN native_project_command_proofs p ON p.command_id=o.command_id WHERE o.state IN ('pending','leased') AND p.actor_staff_id=?) AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE state IN ('pending','leased') AND json_extract(origin_snapshot_json,'$.actorId')=?) AND NOT EXISTS(SELECT 1 FROM project_alpha_project_v2_live_recovery_authorizations WHERE actor_staff_id=?)",Array(8).fill(input.target.staffId),"work"),
    guard("NOT EXISTS(SELECT 1 FROM native_staff_target_memberships WHERE staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_staff_admin_delegations WHERE actor_staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations WHERE actor_staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_integration_control_grants WHERE actor_staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_integration_management_grants WHERE actor_staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_workforce_authority_grants WHERE staff_id=?)",Array(6).fill(input.target.staffId),"unrelated-authority"),
    guard("NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=? AND effect='deny' AND active=1)",[input.target.staffId],"deny"),
    guard("EXISTS(SELECT 1 FROM operations_directory_records WHERE record_id=? AND record_kind='organization' AND current_version=1)",[input.target.recordId],"record"),
    guard("(SELECT count(*) FROM native_directory_resource_scopes WHERE record_id=?)=1 AND EXISTS(SELECT 1 FROM native_directory_resource_scopes WHERE record_id=? AND scope_kind='business_area' AND business_area_id=? AND division_id IS NULL AND active=1)",[input.target.recordId,input.target.recordId,input.target.businessAreaId],"scope"),
    guard("julianday(?)<=julianday('now') AND julianday(?)>julianday('now') AND julianday(?)<=julianday('now') AND julianday(?)>=julianday('now','-5 minutes')",[input.approval.issuedAt,input.approval.expiresAt,input.approval.executedAt,input.approval.executedAt],"expiry"),
    guard("NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=?) AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=?)",[approval.approval_id,receipt.command_id],"unused"),insert("native_staff_bootstrap_approvals",APPROVAL,approval)];
  if(input.phase==="revoke")statements.push(equality("native_staff_bootstrap_approvals",APPROVAL,[input.provisionArtifact.approval],"approval_id=?",[input.provisionArtifact.approval.approval_id]),equality("native_staff_bootstrap_receipts",RECEIPT,[input.provisionArtifact.receipt],"command_id=?",[input.provisionArtifact.receipt.command_id]),{sql:"UPDATE native_staff_bootstrap_approvals SET revoked_at=? WHERE approval_id=? AND revoked_at IS NULL",params:[input.approval.executedAt,input.provisionArtifact.approval.approval_id]},guard("changes()=1",[],"provision-revoke-cas"));
  for(const [index,permission] of PERMISSIONS.entries()) { const id=input.approval.grantIds[index];
    if(selection.mode==="fresh")statements.push({sql:"INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,granted_by) SELECT ?,?,?,'allow','resource',NULL,NULL,?,1,? WHERE NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE id=? OR (staff_id=? AND permission=? AND effect='allow' AND scope_kind='resource' AND resource_id=?))",params:[id,input.target.staffId,permission,input.target.recordId,input.target.staffId,id,input.target.staffId,permission,input.target.recordId]});
    else statements.push({sql:`UPDATE native_directory_grants SET active=? WHERE id=? AND staff_id=? AND permission=? AND effect='allow' AND scope_kind='resource' AND business_area_id IS NULL AND division_id IS NULL AND resource_id=? AND active=? AND granted_by=?`,params:[active,id,input.target.staffId,permission,input.target.recordId,active===1?0:1,input.target.staffId]});
    statements.push(guard("changes()=1",[],`${permission}-cas`)); }
  for(const [index,permission] of PERMISSIONS.entries())statements.push(guard("EXISTS(SELECT 1 FROM native_directory_grants WHERE id=? AND staff_id=? AND permission=? AND effect='allow' AND scope_kind='resource' AND business_area_id IS NULL AND division_id IS NULL AND resource_id=? AND active=? AND granted_by=?)",[input.approval.grantIds[index],input.target.staffId,permission,input.target.recordId,active,input.target.staffId],`${permission}-poststate`),guard("EXISTS(SELECT 1 FROM native_directory_grant_history WHERE grant_id=? AND grant_version=? AND staff_id=? AND permission=? AND effect='allow' AND scope_kind='resource' AND business_area_id IS NULL AND division_id IS NULL AND resource_id=? AND active=? AND grant_generation=? AND julianday(recorded_at)>=julianday(?) AND julianday(recorded_at)<=(SELECT julianday(updated_at) FROM native_directory_grant_generations WHERE staff_id=?))",[input.approval.grantIds[index],selection.historyVersions[index],input.target.staffId,permission,input.target.recordId,active,input.generation.generation+index+1,input.generation.updated_at,input.target.staffId],`${permission}-history`));
  statements.push(guard("(SELECT generation FROM native_directory_grant_generations WHERE staff_id=?)=?",[input.target.staffId,input.generation.generation+2],"generation"),guard("(SELECT count(*) FROM native_directory_grant_history WHERE staff_id=?)=? AND (SELECT count(*) FROM native_directory_grant_history WHERE staff_id=? AND grant_generation>?)=2",[input.target.staffId,input.history.length+2,input.target.staffId,input.generation.generation],"history-suffix"),guard("julianday(?)>julianday('now')",[input.approval.expiresAt],"expiry-poststate"),insert("native_staff_bootstrap_receipts",RECEIPT,receipt),equality("native_staff_bootstrap_receipts",RECEIPT,[receipt],"command_id=?",[receipt.command_id]));
  return Object.freeze({schemaVersion:2,input,selection,approval,receipt,statements});
}

export async function applyOrganizationRelationshipAuthority(db,artifact,{target,root=ROOT}={}) { if(!same(target,STAGING_TARGET))fail("trusted staging target required");const expected=compileOrganizationRelationshipAuthority(artifact.input,{root});if(!same(expected,artifact))fail("compiled artifact changed");await verifyReviewedReferenceSchema(db);return db.batch(artifact.statements.map(statement=>db.prepare(statement.sql).bind(...statement.params))); }
export async function applyAndReconcileOrganizationRelationshipAuthority(db,artifact,options={}) { let error;try{await applyOrganizationRelationshipAuthority(db,artifact,options);}catch(value){error=value;}const found=await db.prepare("SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(artifact.receipt.command_id).first();if(same(found,artifact.receipt))return{status:error?"committed-after-response-recovery":"committed",receipt:found};if(error)throw error;fail("immutable receipt missing"); }
