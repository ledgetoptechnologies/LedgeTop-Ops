import { createHash, randomUUID } from "node:crypto";

const permissions=["directory.profile.edit","directory.identity.link","directory.enrollment.manage"] as const;
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"
  ?Object.fromEntries(Object.keys(value as Record<string,unknown>).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key])])):value;
const json=(value:unknown)=>JSON.stringify(canonical(value));
const guard=(db:D1Database,condition:string,params:unknown[]=[])=>db.prepare(
  `SELECT CASE WHEN (${condition}) THEN 1 ELSE json('synthetic-onboarding-authority-guard-failed') END`).bind(...params);

type Input={staffId:string;email:string;displayName:string;accessSubject:string;businessAreaId:string;
  approvalId:string;commandId:string;revokeApprovalId:string;revokeCommandId:string;
  issuedAt:string;expiresAt:string;executedAt:string;grantIds:readonly[string,string,string]};
type Provisioned={input:Input;planJson:string;planSha:string;verificationJson:string;verificationSha:string;
  approval:Record<string,unknown>;receipt:Record<string,unknown>};

async function rows(db:D1Database,sql:string,...params:unknown[]){return(await db.prepare(sql).bind(...params).all()).results;}
async function one(db:D1Database,sql:string,...params:unknown[]){return db.prepare(sql).bind(...params).first<Record<string,unknown>>();}
function insert(db:D1Database,table:string,row:Record<string,unknown>){const keys=Object.keys(row);return db.prepare(
  `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(()=>"?").join(",")})`).bind(...keys.map(key=>row[key]));}
function rowsGuard(db:D1Database,table:string,columns:readonly string[],expected:readonly Record<string,unknown>[],predicate:string,params:unknown[]=[]){
  const query=`SELECT ${columns.join(",")} FROM ${table} WHERE ${predicate}`;
  const compare=columns.map(column=>`t.${column} IS json_extract(e.value,'$.${column}')`).join(" AND ");
  const encoded=json(expected.map(row=>Object.fromEntries(columns.map(column=>[column,row[column]]))));
  return guard(db,`(SELECT count(*) FROM (${query}))=json_array_length(?)
    AND NOT EXISTS(SELECT 1 FROM (${query}) t WHERE NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE ${compare}))
    AND NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM (${query}) t WHERE ${compare}))`,
  [...params,encoded,...params,encoded,encoded,...params]);
}
const staffColumns=["id","email","display_name","access_subject","project_alpha_user_id","status","created_at","updated_at","last_seen_at"];
const roleColumns=["id","staff_id","role_id","scope","division_id","scope_key","created_by","created_at"];
const areaColumns=["id","name","active"];
const admissionColumns=["staff_id","bound_access_subject","active","admitted_by","created_at","updated_at","version"];
const profileColumns=["staff_id","login_email","display_name","version","created_at","updated_at"];
const grantColumns=["id","staff_id","permission","effect","scope_kind","business_area_id","division_id","resource_id","active","granted_by","created_at"];
const historyColumns=["grant_id","grant_version","staff_id","permission","effect","scope_kind","business_area_id","division_id","resource_id","active","grant_generation","recorded_at"];
const approvalColumns=["approval_id","canonical_plan_json","canonical_plan_sha256","approved_operator_staff_id","approved_operator_access_subject","independent_binding_verification_json","independent_binding_verification_sha256","issued_by_staff_id","issued_by_access_subject","issued_at","expires_at","revoked_at"];
const receiptColumns=["command_id","approval_id","operator_staff_id","operator_access_subject","canonical_plan_json","canonical_plan_sha256","independent_binding_verification_json","independent_binding_verification_sha256","result_json","result_sha256","executed_at"];
function noWork(db:D1Database,staffId:string){return guard(db,`NOT EXISTS(SELECT 1 FROM native_staff_management_fences WHERE actor_staff_id=? OR target_staff_id=?)
  AND NOT EXISTS(SELECT 1 FROM native_staff_admin_command_fences WHERE actor_staff_id=? OR target_staff_id=?)
  AND NOT EXISTS(SELECT 1 FROM operations_directory_write_fences WHERE actor_id=?)
  AND NOT EXISTS(SELECT 1 FROM project_alpha_project_outbox o JOIN native_project_command_proofs p ON p.command_id=o.command_id
    WHERE o.state IN ('pending','leased') AND p.actor_staff_id=?)
  AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE state IN ('pending','leased') AND json_extract(origin_snapshot_json,'$.actorId')=?)`,
  [staffId,staffId,staffId,staffId,staffId,staffId,staffId]);}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validate(input:Input){
  const ids=[input.approvalId,input.commandId,input.revokeApprovalId,input.revokeCommandId,...input.grantIds];
  if(ids.some(value=>!uuid.test(value))||new Set(ids).size!==ids.length)throw Error("synthetic-onboarding-authority-identities-invalid");
  if(!/^staging-native-only-[a-z0-9-]+$/.test(input.businessAreaId)||input.email!==input.email.toLowerCase())
    throw Error("synthetic-onboarding-authority-scope-invalid");
}

export async function buildSyntheticOnboardingOperatorInput(db:D1Database,input:Omit<Input,"approvalId"|"commandId"|"revokeApprovalId"|"revokeCommandId"|"grantIds">):Promise<Input>{
  const approvalId=randomUUID();
  return{...input,approvalId,commandId:randomUUID(),revokeApprovalId:randomUUID(),revokeCommandId:randomUUID(),
    grantIds:permissions.map(permission=>{const bytes=Buffer.from(sha(json({approvalId,permission,staffId:input.staffId,businessAreaId:input.businessAreaId})).slice(0,32),"hex");
      bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;const h=bytes.toString("hex");
      return`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}) as unknown as readonly[string,string,string]};
}

export async function provisionSyntheticOnboardingOperator(db:D1Database,input:Input,
  options:{lateFailure?:boolean}={}):Promise<Provisioned>{
  validate(input);
  const staff=await one(db,"SELECT * FROM staff_users WHERE id=?",input.staffId);
  const roles=await rows(db,"SELECT * FROM staff_role_assignments WHERE staff_id=? ORDER BY id",input.staffId);
  const area=await one(db,"SELECT * FROM native_business_areas WHERE id=?",input.businessAreaId);
  if(!staff||!area)throw Error("synthetic-onboarding-authority-prestate-missing");
  if(staff.email!==input.email||staff.display_name!==input.displayName||staff.access_subject!==input.accessSubject||staff.status!=="active")
    throw Error("synthetic-onboarding-authority-staff-binding-invalid");
  const preHash=sha(json({staff,roles,area}));
  const plan={schemaVersion:1,kind:"test-only-synthetic-onboarding-operator",phase:"provision",input,preHash,
    grants:permissions.map((permission,index)=>({id:input.grantIds[index],permission,effect:"allow",scopeKind:"business_area"}))};
  const planJson=json(plan),planSha=sha(planJson),verificationJson=json({staff,roles,area,preHash}),verificationSha=sha(verificationJson);
  const approval={approval_id:input.approvalId,canonical_plan_json:planJson,canonical_plan_sha256:planSha,
    approved_operator_staff_id:input.staffId,approved_operator_access_subject:input.accessSubject,
    independent_binding_verification_json:verificationJson,independent_binding_verification_sha256:verificationSha,
    issued_by_staff_id:input.staffId,issued_by_access_subject:input.accessSubject,issued_at:input.issuedAt,
    expires_at:input.expiresAt,revoked_at:null};
  const resultJson=json({admissionVersion:1,profileVersion:1,generation:3,grantIds:input.grantIds});
  const receipt={command_id:input.commandId,approval_id:input.approvalId,operator_staff_id:input.staffId,
    operator_access_subject:input.accessSubject,canonical_plan_json:planJson,canonical_plan_sha256:planSha,
    independent_binding_verification_json:verificationJson,independent_binding_verification_sha256:verificationSha,
    result_json:resultJson,result_sha256:sha(resultJson),executed_at:input.executedAt};
  if(roles.length!==1||roles[0]?.role_id!=="role-owner"||roles[0]?.scope!=="global"||roles[0]?.scope_key!=="global")
    throw Error("synthetic-onboarding-authority-owner-role-invalid");
  const admission={staff_id:input.staffId,bound_access_subject:input.accessSubject,active:1,admitted_by:input.staffId,
    created_at:input.executedAt,updated_at:input.executedAt,version:1};
  const profile={staff_id:input.staffId,login_email:input.email,display_name:input.displayName,version:1,
    created_at:input.executedAt,updated_at:input.executedAt};
  const grants=permissions.map((permission,index)=>({id:input.grantIds[index],staff_id:input.staffId,permission,effect:"allow",
    scope_kind:"business_area",business_area_id:input.businessAreaId,division_id:null,resource_id:null,active:1,
    granted_by:input.staffId,created_at:input.executedAt}));
  const statements:D1PreparedStatement[]=[
    guard(db,"(SELECT count(*) FROM d1_migrations)=183 AND (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1)='0183_project_alpha_binding_standalone_relationship_rows.sql'"),
    rowsGuard(db,"staff_users",staffColumns,[staff],"id=?",[input.staffId]),
    rowsGuard(db,"staff_role_assignments",roleColumns,roles,"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_business_areas",areaColumns,[area],"id=?",[input.businessAreaId]),
    guard(db,"(SELECT count(*) FROM staff_users WHERE id<>? AND (lower(email)=? OR access_subject=?))=0",[input.staffId,input.email,input.accessSubject]),
    guard(db,"(SELECT count(*) FROM native_business_areas WHERE id=? AND active=1)=1",[input.businessAreaId]),
    guard(db,"NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=? OR bound_access_subject=?) AND NOT EXISTS(SELECT 1 FROM native_staff_profiles WHERE staff_id=? OR login_email=?) AND NOT EXISTS(SELECT 1 FROM native_directory_grants WHERE staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_directory_grant_generations WHERE staff_id=?) AND NOT EXISTS(SELECT 1 FROM native_directory_grant_history WHERE staff_id=?)",
      [input.staffId,input.accessSubject,input.staffId,input.email,input.staffId,input.staffId,input.staffId]),
    guard(db,"NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_approvals WHERE approval_id IN (?,?)) AND NOT EXISTS(SELECT 1 FROM native_staff_bootstrap_receipts WHERE command_id IN (?,?))",
      [input.approvalId,input.revokeApprovalId,input.commandId,input.revokeCommandId]),
    guard(db,"julianday(?)<=julianday('now') AND julianday(?)>julianday('now') AND julianday(?)<=julianday('now') AND julianday(?)>=julianday('now','-5 minutes')",
      [input.issuedAt,input.expiresAt,input.executedAt,input.executedAt]),
    noWork(db,input.staffId),insert(db,"native_staff_bootstrap_approvals",approval),
    insert(db,"native_staff_admissions",admission),insert(db,"native_staff_profiles",profile),
    ...grants.map(row=>insert(db,"native_directory_grants",row)),
    insert(db,"native_staff_bootstrap_receipts",receipt),
    rowsGuard(db,"staff_users",staffColumns,[staff],"id=?",[input.staffId]),rowsGuard(db,"staff_role_assignments",roleColumns,roles,"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_business_areas",areaColumns,[area],"id=?",[input.businessAreaId]),
    rowsGuard(db,"native_staff_admissions",admissionColumns,[admission],"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_staff_profiles",profileColumns,[profile],"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_directory_grants",grantColumns,grants,"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_staff_bootstrap_approvals",approvalColumns,[approval],"approval_id=?",[input.approvalId]),
    rowsGuard(db,"native_staff_bootstrap_receipts",receiptColumns,[receipt],"command_id=?",[input.commandId]),
    guard(db,`(SELECT generation FROM native_directory_grant_generations WHERE staff_id=?)=3
      AND (SELECT count(*) FROM native_directory_grant_generations WHERE staff_id=?)=1
      AND (SELECT count(*) FROM native_directory_grant_history WHERE staff_id=?)=3
      AND NOT EXISTS(SELECT 1 FROM native_directory_grant_history h JOIN native_directory_grants g ON g.id=h.grant_id
        WHERE h.staff_id=? AND (h.grant_version<>1 OR h.permission<>g.permission OR h.effect<>'allow' OR h.scope_kind<>'business_area'
          OR h.business_area_id IS NOT ? OR h.division_id IS NOT NULL OR h.resource_id IS NOT NULL OR h.active<>1
          OR h.grant_generation NOT BETWEEN 1 AND 3 OR length(h.recorded_at)<>24))`,[input.staffId,input.staffId,input.staffId,input.staffId,input.businessAreaId]),
    noWork(db,input.staffId),
  ];
  if(options.lateFailure)statements.push(db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES('late-failure','bad','bad')"));
  await db.batch(statements);
  return{input,planJson,planSha,verificationJson,verificationSha,approval,receipt};
}

export async function cleanupSyntheticOnboardingOperator(db:D1Database,provisioned:Provisioned,
  options:{lateFailure?:boolean}={}){
  const{input}=provisioned;
  validate(input);
  const now=(await one(db,"SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') stamp"))!.stamp as string;
  const staff=await one(db,"SELECT * FROM staff_users WHERE id=?",input.staffId);
  const roles=await rows(db,"SELECT * FROM staff_role_assignments WHERE staff_id=? ORDER BY id",input.staffId);
  const area=await one(db,"SELECT * FROM native_business_areas WHERE id=?",input.businessAreaId);
  const admission=await one(db,"SELECT * FROM native_staff_admissions WHERE staff_id=?",input.staffId);
  const profile=await one(db,"SELECT * FROM native_staff_profiles WHERE staff_id=?",input.staffId);
  const grants=await rows(db,"SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id",input.staffId);
  const histories=await rows(db,"SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_generation",input.staffId);
  if(!staff||!area||!admission||!profile)throw Error("synthetic-onboarding-cleanup-prestate-missing");
  const cleanupPlan=json({schemaVersion:1,kind:"test-only-synthetic-onboarding-operator",phase:"cleanup",
    provisionPlanSha256:provisioned.planSha,staffId:input.staffId,grantIds:input.grantIds,executedAt:now});
  const approval={...provisioned.approval,approval_id:input.revokeApprovalId,canonical_plan_json:cleanupPlan,
    canonical_plan_sha256:sha(cleanupPlan),issued_at:new Date(Date.parse(now)-60_000).toISOString(),expires_at:new Date(Date.parse(now)+3_600_000).toISOString()};
  const resultJson=json({admissionVersion:2,generation:6,grantIds:input.grantIds,active:false});
  const receipt={command_id:input.revokeCommandId,approval_id:input.revokeApprovalId,operator_staff_id:input.staffId,
    operator_access_subject:input.accessSubject,canonical_plan_json:cleanupPlan,canonical_plan_sha256:sha(cleanupPlan),
    independent_binding_verification_json:provisioned.verificationJson,independent_binding_verification_sha256:provisioned.verificationSha,
    result_json:resultJson,result_sha256:sha(resultJson),executed_at:now};
  const inactiveGrants=grants.map(row=>({...row,active:0}));
  const inactiveAdmission={...admission,active:0,version:2,updated_at:now};
  const revokedProvision={...provisioned.approval,revoked_at:now};
  const statements:D1PreparedStatement[]=[
    guard(db,"(SELECT count(*) FROM d1_migrations)=200 AND (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1)='0200_native_directory_active_binding_refresh_supersessions.sql'"),
    rowsGuard(db,"staff_users",staffColumns,[staff],"id=?",[input.staffId]),rowsGuard(db,"staff_role_assignments",roleColumns,roles,"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_business_areas",areaColumns,[area],"id=?",[input.businessAreaId]),
    rowsGuard(db,"native_staff_admissions",admissionColumns,[admission],"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_staff_profiles",profileColumns,[profile],"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_directory_grants",grantColumns,grants,"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_directory_grant_history",historyColumns,histories,"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_staff_bootstrap_approvals",approvalColumns,[provisioned.approval],"approval_id=?",[input.approvalId]),
    rowsGuard(db,"native_staff_bootstrap_receipts",receiptColumns,[provisioned.receipt],"command_id=?",[input.commandId]),
    guard(db,"(SELECT generation FROM native_directory_grant_generations WHERE staff_id=?)=3 AND (SELECT count(*) FROM native_directory_grant_generations WHERE staff_id=?)=1",[input.staffId,input.staffId]),
    guard(db,"(SELECT count(*) FROM native_directory_grants WHERE staff_id=? AND active=1 AND effect='allow' AND scope_kind='business_area' AND business_area_id=? AND division_id IS NULL AND resource_id IS NULL)=3",[input.staffId,input.businessAreaId]),
    noWork(db,input.staffId),insert(db,"native_staff_bootstrap_approvals",approval),
    ...input.grantIds.flatMap(id=>[db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=? AND staff_id=? AND active=1").bind(id,input.staffId),guard(db,"changes()=1")]),
    db.prepare("UPDATE native_staff_admissions SET active=0,version=2,updated_at=? WHERE staff_id=? AND bound_access_subject=? AND active=1 AND version=1").bind(now,input.staffId,input.accessSubject),
    guard(db,"changes()=1"),
    db.prepare("UPDATE native_staff_bootstrap_approvals SET revoked_at=? WHERE approval_id=? AND revoked_at IS NULL").bind(now,input.approvalId),
    guard(db,"changes()=1"),
    insert(db,"native_staff_bootstrap_receipts",receipt),
    rowsGuard(db,"staff_users",staffColumns,[staff],"id=?",[input.staffId]),rowsGuard(db,"staff_role_assignments",roleColumns,roles,"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_business_areas",areaColumns,[area],"id=?",[input.businessAreaId]),
    rowsGuard(db,"native_staff_admissions",admissionColumns,[inactiveAdmission],"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_staff_profiles",profileColumns,[profile],"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_directory_grants",grantColumns,inactiveGrants,"staff_id=?",[input.staffId]),
    rowsGuard(db,"native_staff_bootstrap_approvals",approvalColumns,[revokedProvision,approval],"approval_id IN (?,?)",[input.approvalId,input.revokeApprovalId]),
    rowsGuard(db,"native_staff_bootstrap_receipts",receiptColumns,[provisioned.receipt,receipt],"command_id IN (?,?)",[input.commandId,input.revokeCommandId]),
    guard(db,`(SELECT generation FROM native_directory_grant_generations WHERE staff_id=?)=6
      AND (SELECT count(*) FROM native_directory_grant_history WHERE staff_id=?)=6
      AND (SELECT count(*) FROM native_directory_grant_history WHERE staff_id=? AND grant_version=2 AND active=0 AND grant_generation BETWEEN 4 AND 6)=3
      AND NOT EXISTS(SELECT 1 FROM native_directory_grant_history WHERE staff_id=? AND (effect<>'allow' OR scope_kind<>'business_area'
        OR business_area_id IS NOT ? OR division_id IS NOT NULL OR resource_id IS NOT NULL OR length(recorded_at)<>24))`,
      [input.staffId,input.staffId,input.staffId,input.staffId,input.businessAreaId]),noWork(db,input.staffId),
  ];
  if(options.lateFailure)statements.push(db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES('late-cleanup-failure','bad','bad')"));
  await db.batch(statements);
}
