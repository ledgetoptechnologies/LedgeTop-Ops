import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { constants, createHash, generateKeyPairSync, randomUUID, sign as signBytes } from "node:crypto";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { PERMISSIONS } from "@ltds/shared";
import { evaluatePermission } from "../src/worker/acl";
import { executeNativeStaffBootstrapD1 as execute, prepareNativeStaffBootstrapD1 as prepare,
  readNativeStaffBootstrapSnapshot as snapshot,compileNativeStaffBootstrapManagementBatch as compileManagementBatch,
  submitNativeStaffBootstrapManagementBatch as submitManagementBatch } from "../../../scripts/native-staff-bootstrap-d1.mjs";
import { buildOwnerApprovalReceipt, canonicalJson as approvalCanonical,
  verifyNativeStaffBootstrapOwnerApprovalReceipt } from "../../../scripts/native-staff-bootstrap-owner-approval.mjs";
import { composeNativeStaffBootstrapArtifact } from "../../../scripts/native-staff-bootstrap-artifact-composer.mjs";

let runtime:Miniflare, db:D1Database, serial=0;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const stable=(value:unknown):string=>Array.isArray(value)?`[${value.map(stable).join(",")}]`:!value||typeof value!=="object"?JSON.stringify(value):`{${Object.keys(value as object).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(",")}}`;
type Person={id:string;email:string;subject:string};
async function person(label:string):Promise<Person>{
  const id=`${label}-${++serial}`,email=`${id}@example.test`,subject=`access|${id}`;
  await db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(id,email,id,subject).run();
  return {id,email,subject};
}
async function nativeIdentity(p:Person){await db.batch([
  db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(p.id,p.subject,p.id),
  db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(p.id,p.email,p.id),
]);}
async function existingControlPlane(p:Person){
  await nativeIdentity(p);
  const caps=["staff.onboarding.create","staff.onboarding.approve","staff.admission.disable","staff.membership.manage",
    "staff.directory_grant.manage","staff.admin_delegation.manage","staff.admission.enable","staff.profile.edit","staff.profile.read"];
  await db.batch(caps.map(cap=>db.prepare(`INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by)
    VALUES(?,?,?,'allow','global',?)`).bind(`${p.id}:${cap}`,p.id,cap,p.id)));
  const ceilingCaps=[...(["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage","directory.portal_access.manage"] as const)
    .map(cap=>["directory",cap] as const),...["staff.onboarding.create","staff.onboarding.approve","staff.admission.disable","staff.membership.manage","staff.directory_grant.manage","staff.admin_delegation.manage"]
    .map(cap=>["staff_admin",cap] as const)];
  await db.batch(ceilingCaps.map(([domain,cap])=>db.prepare(`INSERT INTO native_staff_delegation_ceilings
    (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,scope_kind)
    VALUES(?,?,?,?,'allow',1,1,1,1,'global')`).bind(`${p.id}:ceiling:${domain}:${cap}`,
      `${p.id}:${domain==='directory'?'staff.directory_grant.manage':'staff.admin_delegation.manage'}`,domain,cap)));
}
async function fixture(){
  const pa=await person("pa-independent"), ops=await person("ops-target"), operator=await person("bootstrap-operator"), root=await person("offline-root");
  const divisionRow=await db.prepare("SELECT id FROM divisions ORDER BY id LIMIT 1").first<{id:string}>();
  if(typeof divisionRow?.id!=="string")throw new Error("native_staff_bootstrap_test_division_missing");
  const division=divisionRow.id;
  await db.batch([
    db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by) VALUES(?,?,'role-operator','global',NULL,'global',?)").bind(`pa-role:${pa.id}`,pa.id,pa.id),
    db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by) VALUES(?,?,'role-operator','division',?,? ,?)").bind(`ops-role:${ops.id}`,ops.id,division,division,ops.id),
    db.prepare("INSERT INTO local_staff_role_assignments(id,staff_id,role_id,scope,division_id,created_by) VALUES(?,?,'role-division-manager','division',?,?)").bind(`ops-local:${ops.id}`,ops.id,division,ops.id),
    db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by) VALUES(?,?,'operations.manage','deny','division',?,?,?)").bind(`ops-deny:${ops.id}`,ops.id,division,division,ops.id),
  ]);
  await existingControlPlane(operator);
  // Preserve representative existing native scoped grant, deny, membership and delegation rows.
  const existingArea=`existing-scope-${operator.id}`;
  await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?, 'Existing scope',1)").bind(existingArea).run();
  await db.batch([
    db.prepare("INSERT INTO native_staff_target_memberships(id,staff_id,scope_kind,business_area_id,active,created_by) VALUES(?,?,'business_area',?,1,?)").bind(`existing-membership:${operator.id}`,operator.id,existingArea,operator.id),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by) VALUES(?,?,'directory.profile.view','allow','business_area',?,1,?)").bind(`existing-allow:${operator.id}`,operator.id,existingArea,operator.id),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by) VALUES(?,?,'directory.profile.view','deny','business_area',?,1,?)").bind(`existing-deny:${operator.id}`,operator.id,existingArea,operator.id),
  ]);
  return {pa,ops,operator,root,division};
}
function planFor(snap:any,p:{pa:Person;ops:Person;operator:Person;root:Person;division:string}){
  const area=`installer-scope-${p.ops.id}`,id=p.ops.id;
  const rows=[
    {table:"native_business_areas",row:{id:area,name:"Installer test scope",active:1}},
    {table:"native_staff_admissions",row:{staff_id:id,bound_access_subject:p.ops.subject,active:1,admitted_by:p.operator.id}},
    {table:"native_staff_profiles",row:{staff_id:id,login_email:p.ops.email,display_name:id,version:1}},
    {table:"native_staff_target_memberships",row:{id:`membership:${id}`,staff_id:id,scope_kind:"business_area",business_area_id:area,division_id:null,active:1,version:1,created_by:p.operator.id}},
    {table:"native_staff_management_delegations",row:{id:`scoped-read:${id}`,actor_staff_id:id,contract_version:1,authority_domain:"staff_admin",capability:"staff.profile.read",effect:"allow",scope_kind:"business_area",business_area_id:area,division_id:null,target_staff_id:null,active:1,version:1,granted_by:p.operator.id}},
    {table:"native_directory_grants",row:{id:`scoped-grant:${id}`,staff_id:id,permission:"directory.profile.view",effect:"allow",scope_kind:"business_area",business_area_id:area,division_id:null,resource_id:null,active:1,granted_by:p.operator.id}},
  ];
  const approvalId=`synthetic-trusted-test-approval-${p.ops.id}`,commandId=`synthetic-trusted-test-command-${p.ops.id}`;
  const plan={kind:"operations-native-staff-bootstrap-install-v1",reviewedSnapshotSha256:snap.snapshotSha256,approvalId,
    staffCohort:[id],controlPlaneStaffIds:[...new Set([...snap.controlPlaneStaffIds,p.operator.id])].sort(),rows};
  const canonicalPlanJson=stable(plan),bindingEvidenceJson=stable({kind:"synthetic-binding-test-only",staffId:id,accessSubject:p.ops.subject});
  const approval={approvalId,approvedOperatorStaffId:p.operator.id,approvedOperatorAccessSubject:p.operator.subject,
    issuedByStaffId:p.root.id,issuedByAccessSubject:p.root.subject,issuedAt:"2026-10-26T00:00:00.000Z",expiresAt:"2030-01-01T00:00:00.000Z"};
  const trustEnvelope={schemaVersion:1,action:"install-operations-native-staff-bootstrap",ownerSessionId:"synthetic-owner-session",
    authorizationChallenge:"synthetic-one-shot-challenge",approvalId,commandId,approvedOperatorStaffId:p.operator.id,
    approvedOperatorAccessSubject:p.operator.subject,issuedByStaffId:p.root.id,issuedByAccessSubject:p.root.subject,
    authorizedAt:approval.issuedAt,expiresAt:approval.expiresAt,reviewedSnapshotSha256:snap.snapshotSha256,
    canonicalPlanSha256:hash(canonicalPlanJson),bindingEvidenceSha256:hash(bindingEvidenceJson),
    consentPhrase:"I approve this exact Operations staff cohort and native authority plan"};
  return {approval,canonicalPlanJson,bindingEvidenceJson,reviewedSnapshot:snap,commandId,trustEnvelope};
}
async function existingOwnerBootstrapFixture(){
  const owner=await person("existing-owner"),kstirn=await person("preserved-kstirn"),employee=await person("owner-cohort-employee");
  await Promise.all([nativeIdentity(owner),nativeIdentity(kstirn)]);
  const ownerGrants=["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage","directory.portal_access.manage"];
  await db.batch(ownerGrants.map((permission,index)=>db.prepare(`INSERT INTO native_directory_grants
    (id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES(?,?,?,'allow','global',1,?)`)
    .bind(`existing-owner-grant:${owner.id}:${index}`,owner.id,permission,owner.id)));
  await db.prepare(`INSERT INTO native_directory_grants
    (id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES(?,?,'directory.profile.view','allow','global',1,?)`)
    .bind(`existing-kstirn-grant:${kstirn.id}`,kstirn.id,kstirn.id).run();
  const priorPlanJson=stable({kind:"already-consumed-out-of-band-owner-approval",ownerStaffId:owner.id});
  const priorBindingJson=stable({kind:"existing-owner-binding-evidence",ownerStaffId:owner.id});
  const priorApprovalId=`prior-consumed-owner-approval:${owner.id}`,priorCommandId=`prior-consumed-owner-command:${owner.id}`;
  const priorResultJson=stable({kind:"already-executed-owner-bootstrap",ownerStaffId:owner.id});
  await db.prepare(`INSERT INTO native_staff_bootstrap_approvals(approval_id,canonical_plan_json,canonical_plan_sha256,
    approved_operator_staff_id,approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,
    issued_by_staff_id,issued_by_access_subject,issued_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(priorApprovalId,priorPlanJson,hash(priorPlanJson),owner.id,owner.subject,priorBindingJson,hash(priorBindingJson),owner.id,owner.subject,
      "2026-10-01T00:00:00.000Z","2030-10-01T00:00:00.000Z").run();
  await db.prepare(`INSERT INTO native_staff_bootstrap_receipts(command_id,approval_id,operator_staff_id,operator_access_subject,
    canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(priorCommandId,priorApprovalId,owner.id,owner.subject,priorPlanJson,hash(priorPlanJson),priorBindingJson,
      hash(priorBindingJson),priorResultJson,hash(priorResultJson)).run();
  return {owner,kstirn,employee,priorApprovalId,priorCommandId};
}
function planForExistingOwner(snap:any,p:{owner:Person;employee:Person;priorApprovalId:string;priorCommandId:string}){
  const area=`owner-initial-scope-${p.employee.id}`,ownerId=p.owner.id,employeeId=p.employee.id;
  const managementCaps=["staff.onboarding.create","staff.onboarding.approve","staff.admission.disable","staff.membership.manage",
    "staff.directory_grant.manage","staff.admin_delegation.manage","staff.admission.enable","staff.profile.edit","staff.profile.read"];
  const explicitPolicyRows:any[]=[
    {table:"native_business_areas",row:{id:area,name:"Owner approved employee scope",active:1}},
    {table:"native_staff_target_memberships",row:{id:`owner-approved-membership:${employeeId}`,staff_id:employeeId,scope_kind:"business_area",business_area_id:area,division_id:null,active:1,version:1,created_by:ownerId}},
    ...managementCaps.map(capability=>({table:"native_staff_management_delegations",row:{id:`owner-initial-delegation:${ownerId}:${capability}`,
      actor_staff_id:ownerId,contract_version:1,authority_domain:"staff_admin",capability,effect:"allow",scope_kind:"global",business_area_id:null,
      division_id:null,target_staff_id:null,active:1,version:1,granted_by:ownerId}})),
    ...[...(["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage","directory.portal_access.manage"] as const)
      .map(capability=>["directory",capability] as const),...managementCaps.slice(0,6).map(capability=>["staff_admin",capability] as const)]
      .map(([domain,capability])=>({table:"native_staff_delegation_ceilings",row:{id:`owner-initial-ceiling:${ownerId}:${domain}:${capability}`,
        parent_delegation_id:`owner-initial-delegation:${ownerId}:${domain==="directory"?"staff.directory_grant.manage":"staff.admin_delegation.manage"}`,
        contract_version:1,authority_domain:domain,capability,effect:"allow",grant_allow:1,grant_deny:1,operation_create:1,operation_revoke:1,
        scope_kind:"global",business_area_id:null,division_id:null,resource_id:null,target_staff_id:null}})),
  ];
  const composition=composeNativeStaffBootstrapArtifact({reviewedSnapshot:snap,proposedStaffIds:[employeeId],
    controlPlaneStaffIds:snap.controlPlaneStaffIds,preservationRoles:{ownerStaffId:ownerId,kstirnStaffId:p.kstirn.id},
    explicitPolicyRows,decisionReference:"synthetic native staff bootstrap integration fixture"});
  const artifact=composition.artifact,plan=JSON.parse(artifact.canonicalPlanJson);
  const issuedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+5*60_000).toISOString();
  const approval={approvalId:plan.approvalId,approvedOperatorStaffId:ownerId,approvedOperatorAccessSubject:p.owner.subject,
    issuedByStaffId:ownerId,issuedByAccessSubject:p.owner.subject,issuedAt,expiresAt};
  const trustEnvelope={schemaVersion:1,action:"install-operations-native-staff-bootstrap",ownerSessionId:"synthetic-existing-owner-session",
    authorizationChallenge:`synthetic-owner-challenge:${ownerId}`,approvalId:approval.approvalId,commandId:artifact.commandId,
    approvedOperatorStaffId:ownerId,approvedOperatorAccessSubject:p.owner.subject,issuedByStaffId:ownerId,
    issuedByAccessSubject:p.owner.subject,authorizedAt:issuedAt,expiresAt,reviewedSnapshotSha256:snap.snapshotSha256,
    canonicalPlanSha256:hash(artifact.canonicalPlanJson),bindingEvidenceSha256:hash(artifact.bindingEvidenceJson),
    consentPhrase:"I approve this exact Operations staff cohort and native authority plan"};
  return {...artifact,approval,trustEnvelope};
}
const trusted=async({trustEnvelope}:any)=>typeof trustEnvelope?.ownerSessionId==="string"&&trustEnvelope.ownerSessionId.startsWith("synthetic-");
async function legacyEffectiveSnapshot(people:Person[]){
  const output:any={};
  const divisions=(await db.prepare("SELECT id FROM divisions ORDER BY id").all<{id:string}>()).results.map(row=>row.id);
  for(const p of people){
    const grants=(await db.prepare(`SELECT rp.permission_key permission,'allow' effect,a.scope,a.division_id divisionId,'role' source FROM staff_role_assignments a JOIN role_permissions rp ON rp.role_id=a.role_id WHERE a.staff_id=?
      UNION ALL SELECT rp.permission_key permission,'allow' effect,a.scope,a.division_id divisionId,'role' source FROM local_staff_role_assignments a JOIN role_permissions rp ON rp.role_id=a.role_id WHERE a.staff_id=?
      UNION ALL SELECT permission_key permission,effect,scope,division_id divisionId,'override' source FROM staff_permission_overrides WHERE staff_id=?`).bind(p.id,p.id,p.id).all()).results as any[];
    output[p.id]={status:await db.prepare("SELECT status,access_subject,email FROM staff_users WHERE id=?").bind(p.id).first(),
      grants:PERMISSIONS.flatMap(permission=>[
        [undefined],...divisions.map(id=>[{divisionId:id}]),[{ownerId:p.id}],[{assignedStaffIds:[p.id]}],[{divisionAuthorityUnknown:true}],
      ].map(([context])=>[permission,context??null,evaluatePermission(grants,{id:p.id} as any,permission as any,context as any)]))};
  }
  return output;
}

describe("source-only trusted native staff bootstrap installer against full Ops D1 schema through 0225",()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
    db=await runtime.getD1Database("OPS_DB") as D1Database;
    await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    const dir=new URL("../migrations/",import.meta.url);
    for(const name of readdirSync(dir).filter(name=>/^\d{4}_.+\.sql$/u.test(name)&&Number(name.slice(0,4))<=225).sort()){
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,dir),"utf8")).map(sql=>db.prepare(sql)));
      await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name).run();
    }
  // Applying the complete 225-migration chain to local Miniflare D1 is slow
  // on this Windows host; this timeout covers test setup only, not production.
  },240_000);
  afterAll(async()=>runtime?.dispose());

  it("composes and installs initial owner authority from an observed empty control plane while preserving existing identities",async()=>{
    const ownerShape=await existingOwnerBootstrapFixture();
    const ownerReviewed=await snapshot(db,[ownerShape.employee.id]),ownerBefore=JSON.parse(ownerReviewed.snapshotJson).rows;
    expect(ownerReviewed.controlPlaneStaffIds).toEqual([]);
    const ownerInput=planForExistingOwner(ownerReviewed,ownerShape),ownerPrepared=await prepare(ownerInput,{verifyTrust:trusted});
    const ownerPlan=JSON.parse(ownerInput.canonicalPlanJson),ownerBinding=JSON.parse(ownerInput.bindingEvidenceJson);
    expect(ownerBinding.observedControlPlaneStaffIds).toEqual([]);
    expect(ownerBinding.plannedControlPlaneStaffIds).toEqual([ownerShape.owner.id]);
    expect(ownerPlan.controlPlaneStaffIds).toEqual([ownerShape.owner.id]);
    expect(ownerPrepared.plan.staffCohort).toEqual([ownerShape.employee.id]);
    expect(ownerPrepared.plan.rows.filter((row:any)=>row.table==="native_staff_admissions"||row.table==="native_staff_profiles")
      .map((row:any)=>row.row.staff_id)).toEqual([ownerShape.employee.id,ownerShape.employee.id]);
    expect(ownerPrepared.plan.rows.filter((row:any)=>row.table==="native_staff_management_delegations"
      &&row.row.actor_staff_id===ownerShape.owner.id)).toHaveLength(9);
    expect(ownerPrepared.plan.rows.filter((row:any)=>row.table==="native_staff_delegation_ceilings")).toHaveLength(11);
    const ownerReceipt=await execute(db,ownerPrepared,{verifyTrust:trusted});
    expect(ownerReceipt).toMatchObject({staffCount:1,insertedRowCount:ownerPrepared.plan.rows.length+2});
    const ownerAfter=JSON.parse((await snapshot(db,[ownerShape.employee.id])).snapshotJson).rows;
    for(const [table,filter] of [
      ["staff_users",(row:any)=>row.id===ownerShape.owner.id||row.id===ownerShape.kstirn.id],
      ["native_staff_admissions",(row:any)=>row.staff_id===ownerShape.owner.id],
      ["native_staff_profiles",(row:any)=>row.staff_id===ownerShape.owner.id],
      ["native_staff_admissions",(row:any)=>row.staff_id===ownerShape.kstirn.id],
      ["native_staff_profiles",(row:any)=>row.staff_id===ownerShape.kstirn.id],
      ["native_directory_grants",(row:any)=>row.staff_id===ownerShape.owner.id||row.staff_id===ownerShape.kstirn.id],
      ["native_directory_assignments",(row:any)=>row.staff_id===ownerShape.owner.id||row.staff_id===ownerShape.kstirn.id],
      ["native_directory_grant_generations",(row:any)=>row.staff_id===ownerShape.owner.id||row.staff_id===ownerShape.kstirn.id],
      ["native_directory_grant_history",(row:any)=>row.staff_id===ownerShape.owner.id||row.staff_id===ownerShape.kstirn.id],
      ["native_staff_bootstrap_approvals",(row:any)=>row.approval_id===ownerShape.priorApprovalId],
      ["native_staff_bootstrap_receipts",(row:any)=>row.command_id===ownerShape.priorCommandId],
    ] as const){
      expect((ownerAfter[table]??[]).filter(filter),`preserved ${table} rows changed`).toEqual((ownerBefore[table]??[]).filter(filter));
    }
    expect(await db.prepare("SELECT COUNT(*) n FROM native_staff_management_delegations WHERE actor_staff_id=?")
      .bind(ownerShape.owner.id).first("n")).toBe(9);
    expect(await db.prepare("SELECT COUNT(*) n FROM native_staff_delegation_ceilings c JOIN native_staff_management_delegations d ON d.id=c.parent_delegation_id WHERE d.actor_staff_id=?")
      .bind(ownerShape.owner.id).first("n")).toBe(11);
    expect((await db.prepare("SELECT staff_id FROM native_staff_lifecycle_control_plane_candidates ORDER BY staff_id").all())
      .results.map((row:any)=>row.staff_id)).toEqual([ownerShape.owner.id]);
  },240_000);

  it("compiles one bounded management batch without coercing or splitting bind values",async()=>{
    const statements=[{sql:"INSERT INTO x VALUES(?,?,?)",params:["active",1,null]}];
    let calls=0;
    const response=await submitManagementBatch(async request=>{calls++;expect(request).toEqual({batch:statements});return [{success:true,results:[]}];},statements);
    expect(calls).toBe(1);
    expect(response).toEqual([{success:true,results:[]}]);
    const compiled=compileManagementBatch(statements),compiledStatement=compiled.batch.at(0);
    if(!compiledStatement)throw new Error("native_staff_bootstrap_test_compiled_statement_missing");
    expect(compiledStatement.params).toEqual(["active",1,null]);
    expect(()=>compileManagementBatch([{sql:"SELECT ?",params:[true]}])).toThrow(/management_parameter_type_unsupported/u);
    expect(()=>compileManagementBatch(Array.from({length:257},()=>({sql:"SELECT ?",params:[1]})))).toThrow(/management_batch_size_invalid/u);
  });

  it("installs approved synthetic admission/profile/scope grant rows while preserving Ops/PA permissions and existing authority bytes",async()=>{
    const people=await fixture(),ids=[people.pa.id,people.ops.id,people.operator.id,people.root.id];
    const seeded=(await db.prepare("SELECT id,email,access_subject FROM staff_users WHERE id IN ('staff-beau-koltz','staff-kollins-stirn') ORDER BY id").all()).results as any[];
    const preservedPrincipals=[people.pa,people.ops,people.operator,people.root,
      ...seeded.map(row=>({id:row.id,email:row.email,subject:row.access_subject??''}))];
    let reviewed=await snapshot(db,[people.ops.id]);
    let reviewedState=JSON.parse(reviewed.snapshotJson);
    const operatorDelegationIds=new Set(reviewedState.rows.native_staff_management_delegations
      .filter((row:any)=>row.actor_staff_id===people.operator.id).map((row:any)=>row.id));
    const operatorCeilings=reviewedState.rows.native_staff_delegation_ceilings
      .filter((row:any)=>operatorDelegationIds.has(row.parent_delegation_id));
    expect(operatorCeilings).toHaveLength(11);
    expect(operatorCeilings.every((row:any)=>row.target_staff_id===null)).toBe(true);
    const identityBefore=(await db.prepare("SELECT id,email,status,access_subject,project_alpha_user_id,sync_protected FROM staff_users ORDER BY id").all()).results;
    const before=await legacyEffectiveSnapshot(preservedPrincipals);
    let input=planFor(reviewed,people),prepared=await prepare(input,{verifyTrust:trusted});
    expect(Object.isFrozen(prepared.plan.rows)).toBe(true);
    expect(Object.isFrozen(prepared.plan.staffCohort)).toBe(true);
    const mutatedPlan={...prepared.plan,staffCohort:[...prepared.plan.staffCohort,"unreviewed-cohort-member"],
      rows:[...prepared.plan.rows,{table:"native_directory_grants",row:{id:`unapproved-extra-grant:${people.ops.id}`,staff_id:people.ops.id,
        permission:"directory.profile.edit",effect:"allow",scope_kind:"global",business_area_id:null,division_id:null,resource_id:null,active:1,granted_by:people.operator.id}}]};
    const mutatedPrepared={...prepared,plan:mutatedPlan};
    await expect(execute(db,mutatedPrepared,{verifyTrust:trusted})).rejects.toThrow(/prepared_artifact_invalid/u);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_directory_grants WHERE id=?").bind(`unapproved-extra-grant:${people.ops.id}`).first("n")).toBe(0);
    const digestMismatch={...input,canonicalPlanJson:stable({...prepared.plan,rows:prepared.plan.rows.map((row:any,index:number)=>index===0
      ? {...row,row:{...row.row,name:"Tampered after owner review"}}:row)})};
    await expect(prepare(digestMismatch,{verifyTrust:trusted})).rejects.toThrow(/trust_envelope_invalid/u);
    // A broad (NULL target_staff_id) policy ceiling added after review must be
    // included in the same atomic full-state CAS, even though it names no staff.
    await db.prepare(`INSERT INTO native_staff_delegation_ceilings
      (id,parent_delegation_id,authority_domain,capability,effect,grant_allow,grant_deny,operation_create,operation_revoke,
       scope_kind,business_area_id,active,version)
      VALUES(?,?,'staff_admin','staff.onboarding.create','allow',1,1,1,1,'business_area',?,0,1)`)
      .bind(`post-review-broad-ceiling:${people.operator.id}`,
        `${people.operator.id}:staff.admin_delegation.manage`, `existing-scope-${people.operator.id}`).run();
    await expect(execute(db,prepared,{verifyTrust:trusted})).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(input.commandId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_admissions WHERE staff_id=?").bind(people.ops.id).first("n")).toBe(0);
    reviewed=await snapshot(db,[people.ops.id]);
    reviewedState=JSON.parse(reviewed.snapshotJson);
    input=planFor(reviewed,people);
    prepared=await prepare(input,{verifyTrust:trusted});
    const lateCeilingId=`post-review-broad-ceiling:${people.operator.id}`;
    await expect(execute(db,prepared,{verifyTrust:trusted,submitManagementBatch:async request=>{
      // Simulate authority drift after the execution probe, immediately before
      // the provider submits the single guarded D1 transaction.
      await db.prepare("UPDATE native_staff_delegation_ceilings SET active=1,version=version+1 WHERE id=? AND active=0")
        .bind(lateCeilingId).run();
      return db.batch(request.batch.map((statement:any)=>db.prepare(statement.sql).bind(...statement.params)));
    }})).rejects.toThrow(/native_staff_bootstrap_atomic_batch_refused/u);
    expect(await db.prepare("SELECT active FROM native_staff_delegation_ceilings WHERE id=?").bind(lateCeilingId).first("active")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(input.commandId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_admissions WHERE staff_id=?").bind(people.ops.id).first("n")).toBe(0);
    reviewed=await snapshot(db,[people.ops.id]);
    reviewedState=JSON.parse(reviewed.snapshotJson);
    input=planFor(reviewed,people);
    prepared=await prepare(input,{verifyTrust:trusted});
    // Normal authenticated activity changes this telemetry field between
    // review and execution. It is intentionally excluded from the authority CAS.
    await db.prepare("UPDATE staff_users SET last_seen_at='2026-10-26T19:35:00.000Z' WHERE id=?").bind(people.ops.id).run();
    const receipt=await execute(db,prepared,{verifyTrust:trusted});
    expect(receipt).toMatchObject({staffCount:1,insertedRowCount:8});
    expect(await legacyEffectiveSnapshot(preservedPrincipals)).toEqual(before);
    expect((await db.prepare("SELECT id,email,access_subject,status FROM staff_users ORDER BY id").all()).results).toHaveLength(ids.length+2);
    expect(await db.prepare("SELECT bound_access_subject FROM native_staff_admissions WHERE staff_id=?").bind(people.ops.id).first("bound_access_subject")).toBe(people.ops.subject);
    expect(await db.prepare("SELECT login_email FROM native_staff_profiles WHERE staff_id=?").bind(people.ops.id).first("login_email")).toBe(people.ops.email);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_target_memberships WHERE staff_id=? AND business_area_id=?").bind(people.ops.id,`installer-scope-${people.ops.id}`).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_directory_grants WHERE id=?").bind(`scoped-grant:${people.ops.id}`).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_receipts WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(1);
    expect((await db.prepare("SELECT id,email,status,access_subject,project_alpha_user_id,sync_protected FROM staff_users ORDER BY id").all()).results).toEqual(identityBefore);
    const installedState=JSON.parse((await snapshot(db,[people.ops.id])).snapshotJson),installedKeys:Record<string,Set<string>>={};
    const rowKeyForTable:Record<string,string>={native_business_areas:"id",native_staff_admissions:"staff_id",native_staff_profiles:"staff_id",
      native_staff_target_memberships:"id",native_staff_management_delegations:"id",native_staff_admin_delegations:"id",
      native_staff_delegation_ceilings:"id",native_directory_grants:"id",native_directory_assignments:"record_id",
      native_staff_bootstrap_approvals:"approval_id",native_staff_bootstrap_receipts:"command_id"};
    for(const operation of prepared.plan.rows){
      const key=rowKeyForTable[operation.table];
      if(!key)throw new Error(`native_staff_bootstrap_test_row_key_missing:${operation.table}`);
      const tableKeys=installedKeys[operation.table]??new Set<string>();
      tableKeys.add(operation.row[key]);
      installedKeys[operation.table]=tableKeys;
    }
    installedKeys.native_staff_bootstrap_approvals=new Set([input.approval.approvalId]);
    installedKeys.native_staff_bootstrap_receipts=new Set([input.commandId]);
    for(const table of Object.keys(reviewedState.rows).filter(name=>name.startsWith("native_"))){
      const key=rowKeyForTable[table];
      if(table==="native_directory_grant_generations"){
        const originalByStaff=new Map(reviewedState.rows[table].map((row:any)=>[row.staff_id,row]));
        for(const row of installedState.rows[table]??[]){
          if(originalByStaff.has(row.staff_id))expect(row,`preexisting ${table} row changed`).toEqual(originalByStaff.get(row.staff_id));
        }
        expect((installedState.rows[table]??[]).filter((row:any)=>!originalByStaff.has(row.staff_id)))
          .toEqual([{staff_id:people.ops.id,generation:1,updated_at:expect.any(String)}]);
        continue;
      }
      if(table==="native_directory_grant_history"){
        expect((installedState.rows[table]??[]).filter((row:any)=>row.grant_id===`scoped-grant:${people.ops.id}`)).toHaveLength(1);
        const prior=(installedState.rows[table]??[]).filter((row:any)=>row.grant_id!==`scoped-grant:${people.ops.id}`);
        expect(prior,`preexisting ${table} rows changed`).toEqual(reviewedState.rows[table]);
        continue;
      }
      if(!key){
        expect(installedState.rows[table]??[],`preexisting ${table} rows changed`).toEqual(reviewedState.rows[table]);
        continue;
      }
      const kept=(installedState.rows[table]??[]).filter((row:any)=>!installedKeys[table]?.has(row[key]));
      expect(kept,`preexisting ${table} rows changed`).toEqual(reviewedState.rows[table]);
    }
    await expect(execute(db,prepared,{verifyTrust:trusted})).rejects.toThrow();
    const replaySnapshot=await snapshot(db,[people.ops.id]),replayInput=planFor(replaySnapshot,people),replayPrepared=await prepare(replayInput,{verifyTrust:trusted});
    await expect(execute(db,replayPrepared,{verifyTrust:trusted})).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(input.commandId).first("n")).toBe(1);

  },240_000);

  it("rolls back on stale cohort/role/schema, unexpected native authority, missing trust, and late row failure",async()=>{
    const people=await fixture(),reviewed=await snapshot(db,[people.ops.id]),input=planFor(reviewed,people);
    await expect(prepare(input)).rejects.toThrow(/trust_verifier_required/u);
    const expiredInput=planFor(reviewed,people);
    expiredInput.approval.expiresAt="2026-10-26T00:00:00.000Z";
    expiredInput.trustEnvelope.expiresAt=expiredInput.approval.expiresAt;
    const expired=await prepare(expiredInput,{verifyTrust:trusted});
    await expect(execute(db,expired,{verifyTrust:trusted})).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(expiredInput.approval.approvalId).first("n")).toBe(0);
    const revoked=await prepare(planFor(reviewed,people),{verifyTrust:trusted});
    await expect(execute(db,revoked,{verifyTrust:async()=>false})).rejects.toThrow(/independent_approval_revoked/u);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(revoked.approval.approvalId).first("n")).toBe(0);
    const prepared=await prepare(input,{verifyTrust:trusted});
    await db.prepare("UPDATE staff_permission_overrides SET effect='allow' WHERE id=?").bind(`ops-deny:${people.ops.id}`).run();
    await expect(execute(db,prepared,{verifyTrust:trusted})).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(input.approval.approvalId).first("n")).toBe(0);
    await db.prepare("UPDATE staff_permission_overrides SET effect='deny' WHERE id=?").bind(`ops-deny:${people.ops.id}`).run();
    const second=await snapshot(db,[people.ops.id]),secondInput=planFor(second,people),secondPrepared=await prepare(secondInput,{verifyTrust:trusted});
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(people.ops.id).run();
    await expect(execute(db,secondPrepared,{verifyTrust:trusted})).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(secondInput.approval.approvalId).first("n")).toBe(0);
    await db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(people.ops.id).run();
    const third=await snapshot(db,[people.ops.id]),thirdInput=planFor(third,people),thirdPrepared=await prepare(thirdInput,{verifyTrust:trusted});
    await db.prepare("UPDATE staff_users SET access_subject='changed-subject' WHERE id=?").bind(people.ops.id).run();
    await expect(execute(db,thirdPrepared,{verifyTrust:trusted})).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(thirdInput.approval.approvalId).first("n")).toBe(0);
    await db.prepare("UPDATE staff_users SET access_subject=? WHERE id=?").bind(people.ops.subject,people.ops.id).run();
    const fourth=await snapshot(db,[people.ops.id]),fourthInput=planFor(fourth,people),fourthPrepared=await prepare(fourthInput,{verifyTrust:trusted});
    await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by) VALUES(?,?,'directory.profile.view','deny','global',NULL,?)")
      .bind(`unexpected:${people.operator.id}`,people.operator.id,people.operator.id).run();
    await expect(execute(db,fourthPrepared,{verifyTrust:trusted})).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM native_staff_admissions WHERE staff_id=?").bind(people.ops.id).first("n")).toBe(0);
    const fifth=await snapshot(db,[people.ops.id]),fifthInput=planFor(fifth,people);
    const invalid=JSON.parse(fifthInput.canonicalPlanJson);invalid.rows.at(-1).row.active=2;fifthInput.canonicalPlanJson=stable(invalid);
    fifthInput.trustEnvelope.canonicalPlanSha256=hash(fifthInput.canonicalPlanJson);
    const fifthPrepared=await prepare(fifthInput,{verifyTrust:trusted});
    await expect(execute(db,fifthPrepared,{verifyTrust:trusted})).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(fifthInput.approval.approvalId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_target_memberships WHERE staff_id=?").bind(people.ops.id).first("n")).toBe(0);
    const sixth=await snapshot(db,[people.ops.id]),sixthInput=planFor(sixth,people),sixthPrepared=await prepare(sixthInput,{verifyTrust:trusted});
    await db.prepare("CREATE TABLE native_unreviewed_schema_change(id TEXT PRIMARY KEY)").run();
    await expect(execute(db,sixthPrepared,{verifyTrust:trusted})).rejects.toThrow(/snapshot_changed_schema_count/u);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?").bind(sixthInput.approval.approvalId).first("n")).toBe(0);
  },240_000);

  it("treats a self-consistent but plan-divergent durable receipt as uncertain",async()=>{
    const people=await fixture(),reviewed=await snapshot(db,[people.ops.id]),input=planFor(reviewed,people),prepared=await prepare(input,{verifyTrust:trusted});
    let batchCount=0;
    const tamperingDb:any={
      prepare:(sql:string)=>db.prepare(sql),
      batch:async(statements:any[])=>{
        const result=await db.batch(statements);batchCount++;
        if(batchCount===2){
          const tamperedResult=stable({schemaVersion:1,approvalId:prepared.approval.approvalId,commandId:prepared.commandId,
            canonicalPlanSha256:prepared.planSha256,bindingEvidenceSha256:prepared.bindingSha256,
            installedStaffCount:99,insertedRowCount:prepared.plan.rows.length});
          await db.prepare("DROP TRIGGER native_staff_bootstrap_receipts_no_update").run();
          try{
            await db.prepare("UPDATE native_staff_bootstrap_receipts SET result_json=?,result_sha256=? WHERE command_id=?")
              .bind(tamperedResult,hash(tamperedResult),prepared.commandId).run();
          }finally{
            await db.prepare(`CREATE TRIGGER native_staff_bootstrap_receipts_no_update BEFORE UPDATE ON native_staff_bootstrap_receipts
              BEGIN SELECT RAISE(ABORT,'native staff bootstrap receipt is immutable'); END`).run();
          }
        }
        return result;
      },
    };
    await expect(execute(tamperingDb,prepared,{verifyTrust:trusted})).rejects.toThrow(/commit_outcome_uncertain/u);
    expect(batchCount).toBe(2);
    const durable=await db.prepare("SELECT result_json,result_sha256 FROM native_staff_bootstrap_receipts WHERE command_id=?").bind(prepared.commandId).first() as any;
    expect(hash(durable.result_json)).toBe(durable.result_sha256);
    expect(JSON.parse(durable.result_json).installedStaffCount).toBe(99);
  },120_000);

  it("pins global permission-defining division and resource-scope rows in the reviewed snapshot",async()=>{
    const people=await fixture();
    const area=(await db.prepare("SELECT id FROM native_business_areas ORDER BY id LIMIT 1").first<{id:string}>())?.id;
    if(!area)throw new Error("native_staff_bootstrap_test_authority_area_missing");
    await db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES(?,?,?,1)")
      .bind(`snapshot-division:${people.ops.id}`,area,"Snapshot division").run();
    await db.prepare("DROP TRIGGER operations_directory_records_write_guard_insert").run();
    try {
      await db.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)")
        .bind(`snapshot-resource:${people.ops.id}`).run();
    } finally {
      await db.prepare(`CREATE TRIGGER operations_directory_records_write_guard_insert BEFORE INSERT ON operations_directory_records
        WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence WHERE fence.mutation_id IS NOT NULL
          AND fence.operation_kind='create' AND fence.record_id=NEW.record_id AND fence.record_kind=NEW.record_kind
          AND fence.expected_version=0 AND fence.record_writes=1 AND NEW.current_version=1)
        BEGIN SELECT RAISE(ABORT,'directory create requires current native authority'); END`).run();
    }
    await db.prepare("DROP TRIGGER native_directory_resource_scopes_create_guard").run();
    try {
      await db.prepare(`INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,division_id,active)
        VALUES(?,'business_area',?,NULL,1)`).bind(`snapshot-resource:${people.ops.id}`,area).run();
    } finally {
      await db.prepare(`CREATE TRIGGER native_directory_resource_scopes_create_guard BEFORE INSERT ON native_directory_resource_scopes
        WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence,json_each(fence.scopes_json) scope
          WHERE fence.operation_kind='create' AND fence.record_id=NEW.record_id AND fence.record_writes=0
            AND json_extract(scope.value,'$.businessAreaId')=NEW.business_area_id
            AND json_extract(scope.value,'$.divisionId') IS NEW.division_id)
        BEGIN SELECT RAISE(ABORT,'native directory scope requires a create admission'); END`).run();
    }

    const divisionReview=await snapshot(db,[people.ops.id]),divisionPlan=planFor(divisionReview,people);
    const divisionPrepared=await prepare(divisionPlan,{verifyTrust:trusted});
    expect(JSON.parse(divisionReview.snapshotJson).rows.native_business_divisions)
      .toContainEqual(expect.objectContaining({id:`snapshot-division:${people.ops.id}`,active:1}));
    await db.prepare("UPDATE native_business_divisions SET active=0 WHERE id=?")
      .bind(`snapshot-division:${people.ops.id}`).run();
    await expect(execute(db,divisionPrepared,{verifyTrust:trusted})).rejects.toThrow(/snapshot_changed/u);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?")
      .bind(divisionPlan.approval.approvalId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_admissions WHERE staff_id=?")
      .bind(people.ops.id).first("n")).toBe(0);

    await db.prepare("UPDATE native_business_divisions SET active=1 WHERE id=?")
      .bind(`snapshot-division:${people.ops.id}`).run();
    const scopeReview=await snapshot(db,[people.ops.id]),scopePlan=planFor(scopeReview,people);
    const scopePrepared=await prepare(scopePlan,{verifyTrust:trusted});
    expect(JSON.parse(scopeReview.snapshotJson).rows.native_directory_resource_scopes)
      .toContainEqual(expect.objectContaining({record_id:`snapshot-resource:${people.ops.id}`,active:1}));
    await db.prepare("UPDATE native_directory_resource_scopes SET active=0 WHERE record_id=?")
      .bind(`snapshot-resource:${people.ops.id}`).run();
    await expect(execute(db,scopePrepared,{verifyTrust:trusted})).rejects.toThrow(/snapshot_changed/u);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?")
      .bind(scopePlan.approval.approvalId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_admissions WHERE staff_id=?")
      .bind(people.ops.id).first("n")).toBe(0);
  },120_000);

  it("prepares and executes only under a genuine signed owner-receipt verifier",async()=>{
    const fixtureData=await existingOwnerBootstrapFixture();
    const reviewed=await snapshot(db,[fixtureData.employee.id]);
    const installerInput=planForExistingOwner(reviewed,fixtureData);
    const plan=JSON.parse(installerInput.canonicalPlanJson),approvalId=randomUUID(),commandId=randomUUID();
    plan.approvalId=approvalId;
    installerInput.canonicalPlanJson=stable(plan);installerInput.commandId=commandId;
    const artifact={canonicalPlanJson:installerInput.canonicalPlanJson,bindingEvidenceJson:installerInput.bindingEvidenceJson,
      reviewedSnapshot:reviewed,commandId};
    const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:3072});
    const publicKeyPem=publicKey.export({type:"spki",format:"pem"}).toString();
    const keyId=createHash("sha256").update(publicKey.export({type:"spki",format:"der"}).toString("base64"),"base64").digest("hex");
    const config:any={target:{accountId:"a".repeat(32),databaseId:randomUUID()},
      source:{commit:"b".repeat(40),migrationNamesSha256:reviewed.migrationNamesSha256},
      access:{origin:"https://ops.example.test",issuer:"https://example.cloudflareaccess.com",audience:"A".repeat(32),
        owner:{staffId:fixtureData.owner.id,accessSubject:fixtureData.owner.subject}},
      signer:{algorithm:"RSA-PSS-SHA256",keyId,publicKeyPem}};
    const state=JSON.parse(reviewed.snapshotJson),users=(await db.prepare("SELECT * FROM staff_users ORDER BY id").all()).results as any[];
    const cohort=users.map(person=>{
      const admission=(state.rows.native_staff_admissions??[]).find((row:any)=>row.staff_id===person.id)??null;
      const profile=(state.rows.native_staff_profiles??[]).find((row:any)=>row.staff_id===person.id)??null;
      return {staffId:person.id,email:person.email,displayName:person.display_name,accessSubject:person.access_subject,
        status:person.status,bridgeStatus:!admission?"not_admitted":!profile?"profile_missing":"matched",admission,profile,
        directoryGrantCount:(state.rows.native_directory_grants??[]).filter((row:any)=>row.staff_id===person.id).length,
        projectGrantCount:(state.rows.native_project_grants??[]).filter((row:any)=>row.staff_id===person.id).length,
        managementDelegationCount:(state.rows.native_staff_management_delegations??[]).filter((row:any)=>row.actor_staff_id===person.id).length};
    });
    const packet={schemaVersion:1,kind:"operations-current-staff-cohort-review-draft-v1",ownerStaffId:fixtureData.owner.id,
      snapshotSha256:hash("synthetic advisory review"),schema:[],tables:{...state.rows,staff_users:users},cohort,status:"draft",
      advisory:true,executionAuthority:false,bootstrapApproval:false,acceptedReceipt:false,installerClaim:false};
    const liveReview={packet,packetSha256:hash(stable(packet))};
    const ownerClaims={issuer:config.access.issuer,audience:config.access.audience,subject:fixtureData.owner.subject,
      assertionSha256:hash("synthetic verified JWT"),issuedAt:Math.floor(Date.now()/1000)-30,
      expiresAt:Math.floor(Date.now()/1000)+1200};
    const signed=buildOwnerApprovalReceipt({config,artifact,liveReview,ownerClaims,authorizationChallenge:hash("synthetic typed consent challenge")});
    const signature=signBytes("sha256",Buffer.from(signed.payloadJson),{key:privateKey,
      padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}).toString("base64");
    const receipt={schemaVersion:1,kind:"operations-native-staff-bootstrap-owner-approval-v1",
      algorithm:signed.algorithm,keyId:signed.keyId,payload:signed.payload,signature};
    const verifyTrust=async(input:any)=>verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt,{config,expected:input}).trusted===true;
    const envelope=signed.payload.trustEnvelope;
    const input={...installerInput,approval:{approvalId,approvedOperatorStaffId:fixtureData.owner.id,
      approvedOperatorAccessSubject:fixtureData.owner.subject,issuedByStaffId:fixtureData.owner.id,
      issuedByAccessSubject:fixtureData.owner.subject,issuedAt:envelope.authorizedAt,expiresAt:envelope.expiresAt},trustEnvelope:envelope};
    const prepared=await prepare(input,{verifyTrust});
    const result=await execute(db,prepared,{verifyTrust});
    expect(result).toMatchObject({staffCount:1,approvalId,commandId});
    expect(verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt,{config,expected:input}).trusted).toBe(true);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_approvals WHERE approval_id=?")
      .bind(approvalId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_bootstrap_receipts WHERE command_id=?")
      .bind(commandId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_profiles WHERE staff_id=?")
      .bind(fixtureData.owner.id).first("n")).toBe(1);
  },240_000);

  it("composes and prepares from the real full-schema D1 snapshot shape",async()=>{
    const owner=await person("composer-owner"),kstirn=await person("composer-kstirn"),target=await person("composer-target");
    await existingControlPlane(owner);
    await nativeIdentity(kstirn);

    // Exercise the installer reader against the actual Miniflare D1 database migrated above.
    const reviewed=await snapshot(db,[target.id]);
    expect(reviewed.migrationNames).toHaveLength(225);
    expect(reviewed.controlPlaneStaffIds).toContain(owner.id);
    const composed=composeNativeStaffBootstrapArtifact({
      reviewedSnapshot:reviewed,
      proposedStaffIds:[target.id],
      controlPlaneStaffIds:reviewed.controlPlaneStaffIds,
      preservationRoles:{ownerStaffId:owner.id,kstirnStaffId:kstirn.id},
      decisionReference:"synthetic-fullschema-d1-interoperability",
    });
    const artifact=composed.artifact,plan=JSON.parse(artifact.canonicalPlanJson),approvalId=plan.approvalId;
    const authorizedAt="2026-10-27T00:00:00.000Z",expiresAt="2030-10-27T00:00:00.000Z";
    const approval={approvalId,approvedOperatorStaffId:owner.id,approvedOperatorAccessSubject:owner.subject,
      issuedByStaffId:owner.id,issuedByAccessSubject:owner.subject,issuedAt:authorizedAt,expiresAt};
    const trustEnvelope={schemaVersion:1,action:"install-operations-native-staff-bootstrap",
      ownerSessionId:"synthetic-fullschema-owner-session",authorizationChallenge:"synthetic-fullschema-challenge",
      approvalId,commandId:artifact.commandId,approvedOperatorStaffId:owner.id,
      approvedOperatorAccessSubject:owner.subject,issuedByStaffId:owner.id,issuedByAccessSubject:owner.subject,
      authorizedAt,expiresAt,reviewedSnapshotSha256:reviewed.snapshotSha256,
      canonicalPlanSha256:composed.planSha256,bindingEvidenceSha256:composed.bindingSha256,
      consentPhrase:"I approve this exact Operations staff cohort and native authority plan"};
    const prepared=await prepare({approval,canonicalPlanJson:artifact.canonicalPlanJson,
      bindingEvidenceJson:artifact.bindingEvidenceJson,reviewedSnapshot:artifact.reviewedSnapshot,
      commandId:artifact.commandId,trustEnvelope},{verifyTrust:trusted});

    expect(prepared.reviewedSnapshot.snapshotSha256).toBe(reviewed.snapshotSha256);
    expect(prepared.plan.staffCohort).toEqual([target.id]);
    expect(prepared.plan.rows).toEqual([
      {table:"native_staff_admissions",row:{staff_id:target.id,bound_access_subject:target.subject,active:1,admitted_by:owner.id}},
      {table:"native_staff_profiles",row:{staff_id:target.id,login_email:target.email,display_name:target.id,version:1}},
    ]);
    expect(composed.preservedStaff).toEqual([{role:"owner",staffId:owner.id},{role:"kstirn",staffId:kstirn.id}]);
  },240_000);
});
