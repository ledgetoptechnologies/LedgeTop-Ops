// Separately versioned current204 successor; historical183 and203 compilers remain immutable.
import crypto from "node:crypto";
import {buildTwoSourceStagingConnectionPlan} from "./staging-ops-two-source-connection-profile-v1.mjs";
import { OPERATIONS_SOURCE_CHAIN_204 as CURRENT } from "./staging-operations-source-v204.mjs";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";
import { STAGING_TARGET } from "./staging-directory-authority-v203.mjs";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
export const SCHEMA_VERSION=1;
export const PURPOSE="synthetic-staging-business-area-project-shared-sync-v204";
export const PINNED_OPERATOR=Object.freeze({staffId:"staff-beau-koltz",email:"beaukoltz@ledgetopdroneservices.com",displayName:"Beau Koltz",accessSubject:"1fa6ad50-df7f-5b76-8884-6d46548d6627"});
export const PINNED_BUSINESS_AREA=Object.freeze({id:"staging-native-only-portal-acceptance-20261008-window-1",name:"Synthetic portal acceptance - 2026-10-08 window 1"});
const CHAIN = Object.freeze({count:CURRENT.count,final:CURRENT.finalMigration,names:CURRENT.namesSha256,contents:CURRENT.contentsSha256});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TS=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GRANT=["id","staff_id","capability","effect","scope_kind","business_area_id","division_id","external_project_id","active","version","granted_by","created_at"];
const fail=m=>{throw new Error(`project-business-area-authority-packet: ${m}`);};
const sha=v=>crypto.createHash("sha256").update(v).digest("hex");
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==="object")return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
const json=v=>JSON.stringify(canonical(v));
function exact(v,keys,label){if(!v||typeof v!=="object"||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||!same(Object.keys(v).sort(),[...keys].sort()))fail(`${label} shape`);}
function plainTree(v,label="input"){
 if(Array.isArray(v)){v.forEach((item,index)=>plainTree(item,`${label}[${index}]`));return;}
 if(v&&typeof v==="object"){
  if(Object.getPrototypeOf(v)!==Object.prototype)fail(`${label} plain object required`);
  for(const [key,item] of Object.entries(v))plainTree(item,`${label}.${key}`);
 }
}
function text(v,max,label){if(typeof v!=="string"||!v.length||v.length>max||v!==v.trim()||/[\u0000-\u001f\u007f]/.test(v))fail(label);}
function timestamp(v,label){if(typeof v!=="string"||!TS.test(v)||new Date(v).toISOString()!==v)fail(label);}
function actualTimestamp(v){return typeof v==="string"&&TS.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}
function reviewedMigrations(root) {
 if(CHAIN.count!==204||CHAIN.final!=="0204_native_project_archive_restore.sql") fail("explicit current204 source descriptor required");
 const dir=path.join(root,"apps","operations","migrations"),stat=fs.lstatSync(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink()) fail("regular migration directory required");
 const names=fs.readdirSync(dir).filter(name=>/\.sql$/i.test(name)).sort();
 if(names.some(name=>!/^\d{4}_.+\.sql$/.test(name))) fail("canonical migration names required");
 const contents=names.map(name=>{
  const file=path.join(dir,name),entry=fs.lstatSync(file);
  if(!entry.isFile()||entry.isSymbolicLink()) fail("regular migration file required");
  return `${name}\0${sha(fs.readFileSync(file))}`;
 });
 if(names.length!==CHAIN.count||names.at(-1)!==CHAIN.final||sha(names.join("\n"))!==CHAIN.names||sha(contents.join("\n"))!==CHAIN.contents)
  fail("exact reviewed migration chain required");
 return names;
}
function validate(raw){
 plainTree(raw);const i=structuredClone(raw);exact(i,["schemaVersion","purpose","staging","admission","profile","businessArea","generation","grants","approval","sourceMetadata"],"input");
 if(i.schemaVersion!==SCHEMA_VERSION||i.purpose!==PURPOSE||!same(i.staging,STAGING_TARGET))fail("staging contract");
 exact(i.admission,["staff_id","bound_access_subject","active","version"],"admission");exact(i.profile,["staff_id","login_email","display_name","version"],"profile");exact(i.businessArea,["id","name","active"],"business area");exact(i.generation,["staff_id","generation"],"generation");exact(i.approval,["approvalId","commandId","revokeApprovalId","revokeCommandId","grantId","issuedAt","expiresAt","provisionExecutedAt","revokeExecutedAt","changeTicket","reviewer"],"approval");
 buildTwoSourceStagingConnectionPlan(i.sourceMetadata);
 const {admission:a,profile:p,businessArea:b,generation:g,approval:x}=i;[a.staff_id,a.bound_access_subject,p.login_email,p.display_name,b.id,b.name,x.changeTicket,x.reviewer].forEach((v,n)=>text(v,n===2?254:191,"text field"));
 if(a.staff_id!==PINNED_OPERATOR.staffId||a.bound_access_subject!==PINNED_OPERATOR.accessSubject||p.login_email!==PINNED_OPERATOR.email||p.display_name!==PINNED_OPERATOR.displayName
  ||a.active!==1||p.staff_id!==a.staff_id||g.staff_id!==a.staff_id||b.active!==1||b.id!==PINNED_BUSINESS_AREA.id||b.name!==PINNED_BUSINESS_AREA.name)fail("exact pinned operator and synthetic area required");
 if(!Number.isSafeInteger(a.version)||a.version<1||!Number.isSafeInteger(p.version)||p.version<1||!Number.isSafeInteger(g.generation)||g.generation<0||g.generation>Number.MAX_SAFE_INTEGER-2)fail("versions");
 if(!Array.isArray(i.grants)||i.grants.length>2048)fail("bounded grants");const ids=new Set();
 for(const r of i.grants){exact(r,GRANT,"grant");if(r.staff_id!==a.staff_id||ids.has(r.id))fail("grant identity");ids.add(r.id);[r.id,r.capability,r.effect,r.scope_kind,r.granted_by].forEach(v=>text(v,191,"grant text"));timestamp(r.created_at,"grant created_at");if(r.capability!=="project.shared.sync"||!["allow","deny"].includes(r.effect)||![0,1].includes(r.active)||!Number.isSafeInteger(r.version)||r.version<1)fail("grant state");const tuple=r.scope_kind==="global"?r.business_area_id===null&&r.division_id===null&&r.external_project_id===null:r.scope_kind==="business_area"?typeof r.business_area_id==="string"&&r.division_id===null&&r.external_project_id===null:r.scope_kind==="division"?typeof r.business_area_id==="string"&&typeof r.division_id==="string"&&r.external_project_id===null:r.scope_kind==="exact_project"?r.business_area_id===null&&r.division_id===null&&typeof r.external_project_id==="string":false;if(!tuple)fail("grant scope tuple");}
 const existingAreaAllow=i.grants.find(r=>r.effect==='allow'&&r.scope_kind==='business_area'&&r.business_area_id===b.id);if(existingAreaAllow&&(existingAreaAllow.id!==x.grantId||existingAreaAllow.active!==0||existingAreaAllow.granted_by!==a.staff_id||existingAreaAllow.version>Number.MAX_SAFE_INTEGER-2))fail('exact inactive project area grant required');
 if(i.grants.some(r=>r.effect==='deny'&&r.active===1&&(r.scope_kind==='global'||r.business_area_id===b.id)))fail('applicable project deny');
 const unique=[x.approvalId,x.commandId,x.revokeApprovalId,x.revokeCommandId,x.grantId];if(!unique.every(v=>typeof v==="string"&&UUID.test(v))||new Set(unique).size!==unique.length||(ids.has(x.grantId)&&!i.grants.some(r=>r.id===x.grantId&&r.effect==="allow"&&r.scope_kind==="business_area"&&r.business_area_id===b.id&&r.active===0)))fail("unique packet UUIDs");[x.issuedAt,x.expiresAt,x.provisionExecutedAt,x.revokeExecutedAt].forEach(v=>timestamp(v,"approval timestamp"));const issued=Date.parse(x.issuedAt),expires=Date.parse(x.expiresAt),provision=Date.parse(x.provisionExecutedAt),revoke=Date.parse(x.revokeExecutedAt);if(expires<=issued||expires-issued>4*3600_000||provision<issued||provision>=expires||revoke<provision)fail("bounded paired window");if(Buffer.byteLength(json(i))>240_000)fail("bounded packet bytes");return i;
}
function guard(condition,params=[],label="state"){return {sql:`SELECT CASE WHEN (${condition}) THEN 1 ELSE json('project-business-area-${label}-guard-failed') END AS verified`,params};}
function insert(table,row){const columns=Object.keys(row);return {sql:`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`,params:columns.map(k=>row[k])};}
function insertReceipt(row){const columns=Object.keys(row).filter(key=>key!=="executed_at");return {sql:`INSERT INTO native_staff_bootstrap_receipts(${columns.join(",")},executed_at) VALUES(${columns.map(()=>"?").join(",")},strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,params:columns.map(k=>row[k])};}
function metadata(i,phase,plan){const a=i.admission,x=i.approval,on=phase==="provision",verification=json({staging:i.staging,migrations:CHAIN,admission:i.admission,profile:i.profile,businessArea:i.businessArea}),approval={approval_id:on?x.approvalId:x.revokeApprovalId,canonical_plan_json:plan,canonical_plan_sha256:sha(plan),approved_operator_staff_id:a.staff_id,approved_operator_access_subject:a.bound_access_subject,independent_binding_verification_json:verification,independent_binding_verification_sha256:sha(verification),issued_by_staff_id:a.staff_id,issued_by_access_subject:a.bound_access_subject,issued_at:x.issuedAt,expires_at:x.expiresAt,revoked_at:null},result=json({phase,staffId:a.staff_id,businessAreaId:i.businessArea.id,grantId:x.grantId,generation:i.generation.generation+(on?1:2),active:on?1:0});return {approval,receipt:{command_id:on?x.commandId:x.revokeCommandId,approval_id:approval.approval_id,operator_staff_id:a.staff_id,operator_access_subject:a.bound_access_subject,canonical_plan_json:plan,canonical_plan_sha256:sha(plan),independent_binding_verification_json:verification,independent_binding_verification_sha256:sha(verification),result_json:result,result_sha256:sha(result),executed_at:on?x.provisionExecutedAt:x.revokeExecutedAt}};}
export function compileBusinessAreaAuthorityPair204(raw,{root=ROOT}={}){
 const i=validate(raw),migrations=reviewedMigrations(root),a=i.admission,p=i.profile,b=i.businessArea,g=i.generation,x=i.approval,plan=json(i),provisionMeta=metadata(i,"provision",plan),revokeMeta=metadata(i,"revoke",plan);
 const identity=[guard("(SELECT count(*) FROM d1_migrations)=? AND NOT EXISTS(SELECT 1 FROM d1_migrations WHERE name NOT IN (SELECT value FROM json_each(?)))",[migrations.length,JSON.stringify(migrations)],"migrations"),guard("EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=? AND bound_access_subject=? AND active=1 AND version=?)",[a.staff_id,a.bound_access_subject,a.version],"admission"),guard("EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=? AND login_email=? AND display_name=? AND version=?)",[a.staff_id,p.login_email,p.display_name,p.version],"profile"),guard("EXISTS(SELECT 1 FROM native_business_areas WHERE id=? AND name=? AND active=1)",[b.id,b.name],"area")];
 // A handoff stays active until the reviewed SQL view proves exact inbound resolution
 // and immutable head advancement; its state label alone never releases cleanup.
 const noWork=guard("NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox o JOIN native_project_command_proofs proof ON proof.command_id=o.command_id WHERE proof.actor_staff_id=? AND o.state IN ('pending','leased')) AND NOT EXISTS(SELECT 1 FROM project_alpha_project_v2_live_recovery_authorizations WHERE actor_staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_commands command JOIN native_project_command_proofs proof ON proof.command_id=command.command_id WHERE proof.actor_staff_id=? AND (command.state NOT IN ('activated','rejected','inbound_review') OR command.state='inbound_review' AND EXISTS(SELECT 1 FROM native_project_lifecycle_pending_handoffs pending WHERE pending.command_id=command.command_id))) AND NOT EXISTS(SELECT 1 FROM native_project_lifecycle_commands command JOIN native_project_lifecycle_authorizations authorization ON authorization.command_id=command.command_id JOIN native_project_command_proofs proof ON proof.command_id=authorization.proof_command_id WHERE proof.actor_staff_id=? AND (command.state NOT IN ('activated','rejected','inbound_review') OR command.state='inbound_review' AND EXISTS(SELECT 1 FROM native_project_lifecycle_pending_handoffs pending WHERE pending.command_id=command.command_id))) AND NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=?) AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE state IN ('pending','leased') AND json_extract(origin_snapshot_json,'$.actorId')=?)",[a.staff_id,a.staff_id,a.staff_id,a.staff_id,a.staff_id,a.staff_id],"active-work"),expiry=guard("julianday(?)<=julianday('now') AND julianday(?)>julianday('now')",[x.issuedAt,x.expiresAt],"expiry");
 const rows=[guard("(SELECT count(*) FROM native_project_grants WHERE staff_id=?)=?",[a.staff_id,i.grants.length],"grant-count"),...i.grants.map(r=>guard("EXISTS(SELECT 1 FROM native_project_grants WHERE id=? AND staff_id=? AND capability=? AND effect=? AND scope_kind=? AND business_area_id IS ? AND division_id IS ? AND external_project_id IS ? AND active=? AND version=? AND granted_by=? AND created_at=?)",GRANT.map(k=>r[k]),"grant-row"))];
 const reused=i.grants.find(r=>r.id===x.grantId),grantVersion=(reused?.version??0)+1;
 const provision=[...identity,guard("EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=? AND generation=?)",[a.staff_id,g.generation],"generation"),...rows,noWork,expiry,guard("NOT EXISTS(SELECT 1 FROM native_project_grants WHERE (id=? AND active<>0) OR (staff_id=? AND capability='project.shared.sync' AND effect='allow' AND scope_kind='business_area' AND business_area_id=? AND active=1)) AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id IN (?,?)) AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id IN (?,?))",[x.grantId,a.staff_id,b.id,x.approvalId,x.revokeApprovalId,x.commandId,x.revokeCommandId],"unused-pair"),insert("native_staff_bootstrap_approvals",provisionMeta.approval),reused?{sql:"UPDATE native_project_grants SET active=1,version=version+1 WHERE id=? AND staff_id=? AND active=0 AND version=?",params:[x.grantId,a.staff_id,reused.version]}:{sql:"INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,active,granted_by) VALUES(?,?,'project.shared.sync','allow','business_area',?,1,?)",params:[x.grantId,a.staff_id,b.id,a.staff_id]},guard("EXISTS(SELECT 1 FROM native_project_grants WHERE id=? AND active=1 AND version=?) AND EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=? AND generation=?)",[x.grantId,grantVersion,a.staff_id,g.generation+1],"provision-poststate"),insertReceipt(provisionMeta.receipt)];
 const revoke=[...identity,guard("(SELECT count(*) FROM native_project_grants WHERE staff_id=?)=?",[a.staff_id,i.grants.length+(reused?0:1)],"revoke-grant-count"),...i.grants.filter(r=>r.id!==x.grantId).map(r=>guard("EXISTS(SELECT 1 FROM native_project_grants WHERE "+GRANT.map(k=>k+" IS ?").join(" AND ")+")",GRANT.map(k=>r[k]),"original-grant-preserved")),guard("EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=? AND generation=?)",[a.staff_id,g.generation+1],"revoke-generation"),noWork,guard("EXISTS(SELECT 1 FROM native_project_grants WHERE id=? AND staff_id=? AND capability='project.shared.sync' AND effect='allow' AND scope_kind='business_area' AND business_area_id=? AND division_id IS NULL AND external_project_id IS NULL AND active=1 AND version=? AND granted_by=?)",[x.grantId,a.staff_id,b.id,grantVersion,a.staff_id],"paired-grant"),guard("EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=? AND canonical_plan_sha256=? AND revoked_at IS NULL) AND EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=? AND approval_id=? AND canonical_plan_sha256=?) AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=?) AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=?)",[x.approvalId,sha(plan),x.commandId,x.approvalId,sha(plan),x.revokeApprovalId,x.revokeCommandId],"paired-lineage"),insert("native_staff_bootstrap_approvals",revokeMeta.approval),{sql:"UPDATE native_project_grants SET active=0,version=version+1 WHERE id=? AND staff_id=? AND active=1 AND version=?",params:[x.grantId,a.staff_id,grantVersion]},guard("changes()=1",[],"grant-cas"),{sql:"UPDATE native_staff_bootstrap_approvals SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE approval_id=? AND revoked_at IS NULL",params:[x.approvalId]},guard("changes()=1",[],"approval-cas"),guard("EXISTS(SELECT 1 FROM native_project_grants WHERE id=? AND active=0 AND version=?) AND EXISTS(SELECT 1 FROM native_project_grant_generations WHERE staff_id=? AND generation=?) AND EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=? AND revoked_at IS NOT NULL AND julianday(revoked_at)<=julianday('now'))",[x.grantId,grantVersion+1,a.staff_id,g.generation+2,x.approvalId],"revoke-poststate"),insertReceipt(revokeMeta.receipt)];
 return {schemaVersion:SCHEMA_VERSION,purpose:PURPOSE,input:i,planHash:sha(plan),provision:{...provisionMeta,statements:provision},revoke:{...revokeMeta,statements:revoke},trustedApplyOnly:true};
}

/** Module-only mutation helper. A trusted runner supplies the exact staging
 * binding identity; this module deliberately exposes no CLI or HTTP route. */
export async function applyBusinessAreaAuthorityPhase204(db,packet,phase,{target,root=ROOT}={}){
 if(!same(target,STAGING_TARGET))fail("trusted staging binding context required");
 if(!["provision","revoke"].includes(phase))fail("phase");
 const expected=compileBusinessAreaAuthorityPair204(packet?.input,{root});
 if(!same(packet,expected))fail("compiled pair altered");
 const selected=expected[phase],receipt=await db.prepare("SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(selected.receipt.command_id).first();
 if(receipt){
  const immutable=Object.fromEntries(Object.entries(receipt).filter(([key])=>key!=="executed_at"));
  const expectedImmutable=Object.fromEntries(Object.entries(selected.receipt).filter(([key])=>key!=="executed_at"));
  if(!same(immutable,expectedImmutable)||!actualTimestamp(receipt.executed_at))fail("replay receipt mismatch");
  const executed=Date.parse(receipt.executed_at),issued=Date.parse(expected.input.approval.issuedAt),expires=Date.parse(expected.input.approval.expiresAt);
  if(phase==="provision"&&(executed<issued||executed>=expires))fail("replay receipt chronology");
  if(phase==="revoke"){
   const prior=await db.prepare("SELECT receipt.executed_at provision_executed_at,approval.revoked_at FROM native_staff_bootstrap_receipts receipt JOIN native_staff_bootstrap_approvals approval ON approval.approval_id=receipt.approval_id WHERE receipt.command_id=?").bind(expected.input.approval.commandId).first();
   if(!prior||!actualTimestamp(prior.provision_executed_at)||!actualTimestamp(prior.revoked_at)
    ||executed<Date.parse(prior.provision_executed_at)||executed<Date.parse(prior.revoked_at))fail("replay receipt chronology");
  }
  return {replayed:true,phase};
 }
 await db.batch(selected.statements.map(statement=>db.prepare(statement.sql).bind(...statement.params)));
 return {replayed:false,phase};
}
