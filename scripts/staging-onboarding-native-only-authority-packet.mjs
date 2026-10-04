import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STAGING_TARGET = Object.freeze({accountId:"846c924bf17bf4f3dd15c97a4c5d1d51",workerName:"ledgetop-ops-staging",
  hostname:"ops-staging.ledgetopdroneservices.com",databaseId:"78b34173-b168-4e3d-9832-bb9d245cc6b8",
  databaseName:"ltds-ops-staging",binding:"OPS_DB",environment:"staging"});
const CHAIN = Object.freeze({count:171,final:"0171_project_alpha_active_directory_update_guard.sql",
  names:"bc4590b90cccd1842b2496906986355cfde7522e970ac3ec95039cace437f61d",
  contents:"e3feca1f403a06f15495017fd843ac48173e39be2478f8d6b5060c262c0b1f5c"});
const PERMISSIONS = ["directory.profile.edit","directory.identity.link"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GRANT = ["id","staff_id","permission","effect","scope_kind","business_area_id","division_id","resource_id","active","granted_by","created_at"];
const HISTORY = ["grant_id","grant_version","staff_id","permission","effect","scope_kind","business_area_id","division_id","resource_id","active","grant_generation","recorded_at"];
const ADMISSION = ["staff_id","bound_access_subject","active","admitted_by","created_at","updated_at","version"];
const PROFILE = ["staff_id","login_email","display_name","version","created_at","updated_at"];
const GENERATION = ["staff_id","generation","updated_at"];
const APPROVAL = ["approval_id","canonical_plan_json","canonical_plan_sha256","approved_operator_staff_id","approved_operator_access_subject","independent_binding_verification_json","independent_binding_verification_sha256","issued_by_staff_id","issued_by_access_subject","issued_at","expires_at","revoked_at"];
const RECEIPT = ["command_id","approval_id","operator_staff_id","operator_access_subject","canonical_plan_json","canonical_plan_sha256","independent_binding_verification_json","independent_binding_verification_sha256","result_json","result_sha256","executed_at"];
const fail = message => {throw new Error(`native-only-authority-packet: ${message}`);};
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
const json = value=>JSON.stringify(canonical(value));
export function nativeOnlyGrantIds(staffId,businessAreaId,approvalId) {
  return PERMISSIONS.map(permission=>{
    const bytes=crypto.createHash('sha256').update(json({staffId,businessAreaId,approvalId,permission})).digest().subarray(0,16);
    bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
    const hex=bytes.toString('hex');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  });
}
function exact(value,keys,label) {
  if (!value || typeof value!=="object" || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype
    || !same(Object.keys(value).sort(),[...keys].sort())) fail(`${label} shape`);
}
function text(value,max,label) {
  if (typeof value!=="string" || !value.length || value.length>max || value!==value.trim() || /[\u0000-\u001f\u007f]/.test(value)) fail(label);
}
function timestamp(value,label) {
  if (typeof value!=="string" || !TS.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString()!==value) fail(label);
}
function positive(value,label) {if (!Number.isSafeInteger(value) || value<1 || value>Number.MAX_SAFE_INTEGER-2) fail(label);}
function rows(value,keys,identity,staffId,label) {
  if (!Array.isArray(value) || value.length>2048) fail(`${label} bounded array`);
  const seen = new Set();
  for (const row of value) {
    exact(row,keys,label); if (row.staff_id!==staffId) fail(`${label} staff`);
    const id=identity(row); if (seen.has(id)) fail(`${label} duplicate`); seen.add(id);
    for (const [key,item] of Object.entries(row)) {
      if (item===null && ["business_area_id","division_id","resource_id"].includes(key)) continue;
      if (key==='active') {if (item!==0 && item!==1) fail(`${label} active`);}
      else if (['grant_version','grant_generation'].includes(key)) positive(item,`${label} ${key}`);
      else if (['created_at','recorded_at'].includes(key)) timestamp(item,`${label} ${key}`);
      else text(item,191,`${label} ${key}`);
    }
    if (!['allow','deny'].includes(row.effect) || !['global','business_area','division','assigned','resource'].includes(row.scope_kind)) fail(`${label} scope/effect`);
    const scoped = row.scope_kind==='business_area'?row.business_area_id!==null && row.division_id===null && row.resource_id===null
      : row.scope_kind==='division'?row.business_area_id===null && row.division_id!==null && row.resource_id===null
      : row.scope_kind==='resource'?row.business_area_id===null && row.division_id===null && row.resource_id!==null
      : row.business_area_id===null && row.division_id===null && row.resource_id===null;
    if (!scoped) fail(`${label} invalid scope tuple`);
  }
}
function reviewedMigrations(root) {
  const dir=path.join(root,'apps','operations','migrations'), names=fs.readdirSync(dir).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort();
  const contents=names.map(name=>{
    const filename=path.join(dir,name), stat=fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('regular migration file required');
    return `${name}\0${sha(fs.readFileSync(filename))}`;
  });
  if (names.length!==CHAIN.count || names.at(-1)!==CHAIN.final || sha(names.join('\n'))!==CHAIN.names || sha(contents.join('\n'))!==CHAIN.contents)
    fail('exact reviewed migration names and contents required');
  return names;
}
function validate(raw) {
  const input=structuredClone(raw);
  exact(input,['schemaVersion','staging','phase','admission','profile','businessArea','grants','history','generation','approval','priorProvision'],'input');
  if (input.schemaVersion!==2 || !['provision','revoke'].includes(input.phase)) fail('version/phase');
  if (!same(input.staging,STAGING_TARGET)) fail('staging identity');
  exact(input.admission,ADMISSION,'admission'); exact(input.profile,PROFILE,'profile');
  exact(input.generation,GENERATION,'generation'); exact(input.businessArea,['id','name','active'],'business area');
  const a=input.admission,p=input.profile,g=input.generation;
  text(a.staff_id,191,'staff id'); text(a.bound_access_subject,191,'bound subject'); text(a.admitted_by,191,'admitting staff');
  if (a.active!==1 || p.staff_id!==a.staff_id || g.staff_id!==a.staff_id) fail('active exact operator');
  positive(a.version,'admission version'); positive(p.version,'profile version'); positive(g.generation,'grant generation');
  for (const value of [a.created_at,a.updated_at,p.created_at,p.updated_at,g.updated_at]) timestamp(value,'authority timestamp');
  text(p.login_email,254,'profile email'); text(p.display_name,160,'display name');
  if (p.login_email!==p.login_email.toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.login_email)) fail('normalized email');
  text(input.businessArea.id,191,'area id'); text(input.businessArea.name,160,'area name');
  if (input.businessArea.active!==1 || !/^staging-native-only-[a-z0-9-]+$/.test(input.businessArea.id)) fail('explicit synthetic area required');
  rows(input.grants,GRANT,row=>row.id,a.staff_id,'grants'); rows(input.history,HISTORY,row=>`${row.grant_id}:${row.grant_version}`,a.staff_id,'history');
  for (const row of input.history) if (!input.grants.some(grant=>grant.id===row.grant_id) || row.grant_generation>g.generation) fail('history lineage');
  for (const row of input.grants) {
    const last=input.history.filter(history=>history.grant_id===row.id).sort((x,y)=>y.grant_version-x.grant_version)[0];
    if (!last || !['staff_id','permission','effect','scope_kind','business_area_id','division_id','resource_id','active'].every(key=>last[key]===row[key]))
      fail('current grant/history disagreement');
  }
  const approval=input.approval;
  exact(approval,['approvalId','commandId','revokeApprovalId','revokeCommandId','issuedByStaffId','issuedByAccessSubject','issuedAt','expiresAt','executedAt','grantIds'],'approval');
  if (!Array.isArray(approval.grantIds) || approval.grantIds.length!==2) fail('two grant ids');
  const ids=[approval.approvalId,approval.commandId,approval.revokeApprovalId,approval.revokeCommandId,...approval.grantIds];
  if (!ids.every(id=>typeof id==='string' && UUID.test(id)) || new Set(ids).size!==ids.length) fail('unique approval UUIDs');
  if (!same(approval.grantIds,nativeOnlyGrantIds(a.staff_id,input.businessArea.id,approval.approvalId))) fail('deterministic permission-bound grant IDs required');
  if (approval.issuedByStaffId!==a.staff_id || approval.issuedByAccessSubject!==a.bound_access_subject) fail('reviewed issuer identity');
  for (const key of ['issuedAt','expiresAt','executedAt']) timestamp(approval[key],key);
  const duration=Date.parse(approval.expiresAt)-Date.parse(approval.issuedAt);
  if (duration<=0 || duration>4*3600_000 || Date.parse(approval.executedAt)<Date.parse(approval.issuedAt)
    || Date.parse(approval.executedAt)>=Date.parse(approval.expiresAt)) fail('bounded approval window');
  if (input.phase==='provision' && input.priorProvision!==null) fail('provision cannot carry prior receipt');
  if (input.phase==='revoke') {
    exact(input.priorProvision,['approval','receipt'],'prior provision');
    exact(input.priorProvision.approval,APPROVAL,'prior approval'); exact(input.priorProvision.receipt,RECEIPT,'prior receipt');
  }
  if (Buffer.byteLength(json(input))>240_000) fail('bounded packet bytes');
  return input;
}

// An evaluated SQL failure (not a zero-row SELECT) aborts the entire D1.batch.
function guard(condition,params=[],label='state') {
  return {sql:`SELECT CASE WHEN (${condition}) THEN 1 ELSE json('native-only-${label}-guard-failed') END AS verified`,params};
}
function equality(table,columns,expected,predicate,predicateParams=[]) {
  const compare=columns.map(column=>`t.${column} IS json_extract(e.value,'$.${column}')`).join(' AND ');
  const query=`SELECT ${columns.join(',')} FROM ${table} WHERE ${predicate}`;
  return {condition:`(SELECT count(*) FROM (${query}))=json_array_length(?)
    AND NOT EXISTS(SELECT 1 FROM (${query}) t WHERE NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE ${compare}))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM (${query}) t WHERE ${compare}))`,
    params:[...predicateParams,json(expected),...predicateParams,json(expected),json(expected),...predicateParams]};
}
function rowsGuard(table,columns,expected,predicate,params,label) {
  const equal=equality(table,columns,expected,predicate,params); return guard(equal.condition,equal.params,label);
}
const unchanged=input=>[
  rowsGuard('native_staff_admissions',ADMISSION,[input.admission],'staff_id=?',[input.admission.staff_id],'admission'),
  rowsGuard('native_staff_profiles',PROFILE,[input.profile],'staff_id=?',[input.admission.staff_id],'profile'),
  rowsGuard('native_business_areas',['id','name','active'],[input.businessArea],'id=?',[input.businessArea.id],'area'),
];
function noWork(staff) {
  return guard(`NOT EXISTS(SELECT 1 FROM native_staff_management_fences WHERE actor_staff_id=? OR target_staff_id=?)
    AND NOT EXISTS(SELECT 1 FROM native_staff_admin_command_fences WHERE actor_staff_id=? OR target_staff_id=?)
    AND NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=?)
    AND NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox o JOIN native_project_command_proofs p ON p.command_id=o.command_id
      WHERE o.state IN ('pending','leased') AND p.actor_staff_id=?)
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE state IN ('pending','leased') AND json_extract(origin_snapshot_json,'$.actorId')=?)`,Array(7).fill(staff),'active-work');
}
function metadata(input,planJson) {
  const p=input.approval,a=input.admission,provision=input.phase==='provision';
  const verificationJson=json({staging:input.staging,admission:input.admission,profile:input.profile,businessArea:input.businessArea,migrations:CHAIN});
  const resultJson=json({phase:input.phase,staffId:a.staff_id,businessAreaId:input.businessArea.id,grantIds:p.grantIds,generation:input.generation.generation+2});
  const approval={approval_id:provision?p.approvalId:p.revokeApprovalId,canonical_plan_json:planJson,canonical_plan_sha256:sha(planJson),
    approved_operator_staff_id:a.staff_id,approved_operator_access_subject:a.bound_access_subject,
    independent_binding_verification_json:verificationJson,independent_binding_verification_sha256:sha(verificationJson),
    issued_by_staff_id:p.issuedByStaffId,issued_by_access_subject:p.issuedByAccessSubject,issued_at:p.issuedAt,expires_at:p.expiresAt,revoked_at:null};
  const receipt={command_id:provision?p.commandId:p.revokeCommandId,approval_id:approval.approval_id,operator_staff_id:a.staff_id,
    operator_access_subject:a.bound_access_subject,canonical_plan_json:planJson,canonical_plan_sha256:sha(planJson),
    independent_binding_verification_json:verificationJson,independent_binding_verification_sha256:sha(verificationJson),
    result_json:resultJson,result_sha256:sha(resultJson),executed_at:p.executedAt};
  return {approval,receipt};
}
function insert(table,columns,row) {
  return {sql:`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,params:columns.map(key=>row[key])};
}

export function compileNativeOnlyAuthorityPacket(raw,{root=ROOT}={}) {
  const input=validate(raw),migrations=reviewedMigrations(root),a=input.admission,p=input.approval,staff=a.staff_id;
  const planJson=json(input),meta=metadata(input,planJson);
  const statements=[rowsGuard('d1_migrations',['name'],migrations.map(name=>({name})),'1',[],'migration-ledger'),...unchanged(input),
    rowsGuard('native_directory_grant_generations',GENERATION,[input.generation],'staff_id=?',[staff],'generation'),
    rowsGuard('native_directory_grants',GRANT,input.grants,'staff_id=?',[staff],'grant-prestate'),
    rowsGuard('native_directory_grant_history',HISTORY,input.history,'staff_id=?',[staff],'history-prestate'),noWork(staff),
    guard(`julianday(?)<=julianday('now') AND julianday(?)>julianday('now')
      AND julianday(?)<=julianday('now') AND julianday(?)>=julianday('now','-5 minutes')`,[p.issuedAt,p.expiresAt,p.executedAt,p.executedAt],'expiry'),
    // Reject every active deny for these permissions, including narrower scopes.
    guard(`NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=? AND active=1 AND effect='deny'
      AND permission IN ('directory.profile.edit','directory.identity.link'))`,[staff],'deny')];
  let priorInput=null;
  if (input.phase==='provision') {
    if (input.grants.some(row=>p.grantIds.includes(row.id) || (row.scope_kind==='business_area' && row.business_area_id===input.businessArea.id
      && PERMISSIONS.includes(row.permission) && row.effect==='allow'))) fail('existing targeted grant conflict');
    statements.push(guard(`NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id IN (?,?))
      AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id IN (?,?))`,[p.approvalId,p.revokeApprovalId,p.commandId,p.revokeCommandId],'unused-packet'));
  } else {
    const previous=input.priorProvision;
    let parsed; try {parsed=JSON.parse(previous.approval.canonical_plan_json);} catch {fail('prior plan JSON');}
    if (parsed.phase!=='provision') fail('prior must be provision');
    const original=compileNativeOnlyAuthorityPacket(parsed,{root}); priorInput=original.input;
    if (!same(previous.approval,original.approval) || !same(previous.receipt,original.receipt)
      || !same(priorInput.staging,input.staging) || !same(priorInput.businessArea,input.businessArea)
      || !same(priorInput.admission,input.admission) || !same(priorInput.profile,input.profile)
      || !['approvalId','commandId','revokeApprovalId','revokeCommandId','issuedByStaffId','issuedByAccessSubject','grantIds'].every(key=>same(priorInput.approval[key],p[key])))
      fail('paired prior provision mismatch');
    statements.push(rowsGuard('native_staff_bootstrap_approvals',APPROVAL,[original.approval],'approval_id=?',[p.approvalId],'paired-approval'),
      rowsGuard('native_staff_bootstrap_receipts',RECEIPT,[original.receipt],'command_id=?',[p.commandId],'paired-receipt'),
      guard(`NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id=?)
        AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id=?)`,[p.revokeApprovalId,p.revokeCommandId],'unused-revoke'));
  }
  const targetRows=PERMISSIONS.map((permission,index)=>({id:p.grantIds[index],staff_id:staff,permission,effect:'allow',scope_kind:'business_area',
    business_area_id:input.businessArea.id,division_id:null,resource_id:null,active:1,granted_by:p.issuedByStaffId,created_at:priorInput?.approval.executedAt??p.executedAt}));
  if (input.phase==='revoke') {
    if (!targetRows.every(target=>input.grants.some(row=>same(row,target)))) fail('exact active packet grants required');
    for (const target of targetRows) {
      const history=input.history.filter(row=>row.grant_id===target.id);
      if (history.length!==1 || history[0].grant_version!==1 || history[0].active!==1) fail('target was modified since provision');
    }
  }
  statements.push(insert('native_staff_bootstrap_approvals',APPROVAL,meta.approval),
    rowsGuard('native_staff_bootstrap_approvals',APPROVAL,[meta.approval],'approval_id=?',[meta.approval.approval_id],'new-approval'));
  for (const target of targetRows) {
    if (input.phase==='provision') statements.push(insert('native_directory_grants',GRANT,target));
    else statements.push({sql:'UPDATE native_directory_grants SET active=0 WHERE id=? AND staff_id=? AND active=1',params:[target.id,staff]},guard('changes()=1',[],'grant-cas'));
  }
  if (input.phase==='revoke') statements.push({sql:'UPDATE native_staff_bootstrap_approvals SET revoked_at=? WHERE approval_id=? AND revoked_at IS NULL',params:[p.executedAt,p.approvalId]},
    guard('changes()=1',[],'approval-cas'),rowsGuard('native_staff_bootstrap_approvals',APPROVAL,[{...input.priorProvision.approval,revoked_at:p.executedAt}],'approval_id=?',[p.approvalId],'revoked-approval'));
  const postGrants=input.phase==='provision'?[...input.grants,...targetRows]:input.grants.map(row=>p.grantIds.includes(row.id)?{...row,active:0}:row);
  statements.push(...unchanged(input),noWork(staff),rowsGuard('native_directory_grants',GRANT,postGrants,'staff_id=?',[staff],'grant-poststate'),
    // Preserve the ENTIRE prior history prefix; only old+1 and old+2 append.
    rowsGuard('native_directory_grant_history',HISTORY,input.history,'staff_id=? AND grant_generation<=?',[staff,input.generation.generation],'history-prefix'),
    guard('(SELECT count(*) FROM native_directory_grant_history WHERE staff_id=? AND grant_generation>?)=2',[staff,input.generation.generation],'history-suffix-count'));
  targetRows.forEach((target,index)=>{
    const row={grant_id:target.id,grant_version:input.phase==='provision'?1:2,staff_id:staff,permission:target.permission,effect:'allow',scope_kind:'business_area',
      business_area_id:input.businessArea.id,division_id:null,resource_id:null,active:input.phase==='provision'?1:0,grant_generation:input.generation.generation+index+1};
    statements.push(rowsGuard('native_directory_grant_history',HISTORY.filter(key=>key!=='recorded_at'),[row],'staff_id=? AND grant_generation=?',[staff,row.grant_generation],'history-suffix-tuple'),
      guard(`EXISTS(SELECT 1 FROM native_directory_grant_history WHERE staff_id=? AND grant_generation=?
        AND julianday(recorded_at)>=julianday(?) AND julianday(recorded_at)<=julianday('now')
        AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS recorded_at)`,[staff,row.grant_generation,p.executedAt],'history-suffix-time'));
  });
  statements.push(guard(`EXISTS(SELECT 1 FROM native_directory_grant_generations g JOIN native_directory_grant_history h
      ON h.staff_id=g.staff_id AND h.grant_generation=g.generation WHERE g.staff_id=? AND g.generation=? AND g.updated_at=h.recorded_at)`,[staff,input.generation.generation+2],'generation-poststate'),
    rowsGuard('native_staff_bootstrap_approvals',APPROVAL,[meta.approval],'approval_id=?',[meta.approval.approval_id],'approval-poststate'),
    guard("julianday(?)>julianday('now')",[p.expiresAt],'expiry-poststate'),
    insert('native_staff_bootstrap_receipts',RECEIPT,meta.receipt),rowsGuard('native_staff_bootstrap_receipts',RECEIPT,[meta.receipt],'command_id=?',[meta.receipt.command_id],'receipt-poststate'));
  return {schemaVersion:2,input,planHash:sha(planJson),approval:meta.approval,receipt:meta.receipt,statements};
}

/** A trusted out-of-band runner supplies the configured staging binding
 * identity. There is deliberately no HTTP route or CLI remote apply. */
export async function applyNativeOnlyAuthorityPacket(db,packet,{target,root=ROOT}={}) {
  if (!same(target,STAGING_TARGET)) fail('trusted staging binding context required');
  const expected=compileNativeOnlyAuthorityPacket(packet.input,{root});
  if (!same(packet,expected)) fail('compiled packet altered');
  const receipt=await db.prepare('SELECT * FROM native_staff_bootstrap_receipts WHERE command_id=?').bind(expected.receipt.command_id).first();
  if (receipt) {
    if (!same(receipt,expected.receipt)) fail('replay receipt mismatch');
    return {replayed:true}; // Replaying never restores revoked authority.
  }
  await db.batch(expected.statements.map(statement=>db.prepare(statement.sql).bind(...statement.params)));
  return {replayed:false};
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const index=process.argv.indexOf('--values');
  if (index<0 || !process.argv[index+1] || process.argv.length!==4) fail('--values <reviewed JSON> required; no remote apply');
  const values=JSON.parse(fs.readFileSync(path.resolve(process.argv[index+1]),'utf8'));
  process.stdout.write(`${JSON.stringify(compileNativeOnlyAuthorityPacket(values),null,2)}\n`);
}
