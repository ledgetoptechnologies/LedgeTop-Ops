import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { executeNativeStaffManagementCommand } from "../src/worker/native-staff-management-command";

let runtime: Miniflare | undefined;
let db: D1Database;
let sequence = 0;
async function staff(id: string, active = 1) {
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name) VALUES(?,?,?)").bind(id,`${id}@example.test`,id),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,?,'staff-beau-koltz')").bind(id,`access|${id}`,active),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id,`${id}@example.test`,id),
  ]);
}
function request(actor:string,target:string,capability:"staff.profile.edit"|"staff.admission.enable",expectedVersion=1) {
  sequence++; return {commandId:`scope-command-${sequence}`,contractVersion:1,capability,actor:{staffId:actor,verifiedAccessSubject:`access|${actor}`},targetStaffId:target,expectedVersion,reason:"Scoped lifecycle test",...(capability==="staff.profile.edit"?{displayName:`Edited ${sequence}`}:{})};
}
async function delegation(actor:string,capability:string,scope:"global"|"business_area"|"division"|"exact_staff",effect:"allow"|"deny",target:string) {
  return db.prepare(`INSERT INTO native_staff_management_delegations
    (id,actor_staff_id,capability,effect,scope_kind,business_area_id,division_id,target_staff_id,granted_by) VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(`delegation-${++sequence}`,actor,capability,effect,scope,scope==="business_area"||scope==="division"?"scope-area":null,scope==="division"?"scope-division":null,scope==="exact_staff"?target:null,actor).run();
}

describe("native staff profile lifecycle scoped authority",()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
    db=await runtime.getD1Database("OPS_DB") as D1Database;
    const directory=new URL("../migrations/",import.meta.url);
    for(const migration of readdirSync(directory).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n.slice(0,4)<="0069").sort()) await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration,directory),"utf8")).map(sql=>db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO native_business_areas(id,name) VALUES('scope-area','Scope area'),('other-area','Other area')"),
      db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name) VALUES('scope-division','scope-area','Scope division'),('other-division','other-area','Other division')"),
    ]);
  },120_000);
  afterAll(async()=>runtime?.dispose());

  for(const scope of ["global","business_area","division","exact_staff"] as const) it(`allows ${scope} targets and rejects an outside target`,async()=>{
    const actor=`actor-${scope}`,target=`target-${scope}`,other=`other-${scope}`; await staff(actor);await staff(target,0);await staff(other,0);
    if(scope==="business_area"||scope==="division"){
      await db.prepare("INSERT INTO native_staff_target_memberships(id,staff_id,scope_kind,business_area_id,division_id,created_by) VALUES(?,?,'division','scope-area','scope-division',?)").bind(`member-${scope}`,target,actor).run();
      await db.prepare("INSERT INTO native_staff_target_memberships(id,staff_id,scope_kind,business_area_id,division_id,created_by) VALUES(?,?,'division','other-area','other-division',?)").bind(`other-member-${scope}`,other,actor).run();
    }
    await delegation(actor,"staff.profile.edit",scope,"allow",target);
    expect(await executeNativeStaffManagementCommand(db,request(actor,target,"staff.profile.edit"))).toMatchObject({replayed:false});
    if(scope!=="global") await expect(executeNativeStaffManagementCommand(db,request(actor,other,"staff.profile.edit"))).rejects.toThrow("native_staff_management_command_denied");
    await delegation(actor,"staff.admission.enable",scope,"allow",target);
    expect(await executeNativeStaffManagementCommand(db,request(actor,target,"staff.admission.enable"))).toMatchObject({replayed:false});
    if(scope!=="global") await expect(executeNativeStaffManagementCommand(db,request(actor,other,"staff.admission.enable"))).rejects.toThrow("native_staff_management_command_denied");
  });

  it("applies new and legacy denies while legacy profile authority cannot enable",async()=>{
    const actor="actor-denies",target="target-denies";await staff(actor);await staff(target,0);
    await delegation(actor,"staff.profile.edit","global","allow",target);
    await db.prepare("INSERT INTO native_staff_admin_delegations(id,actor_staff_id,action,effect,scope_kind,target_staff_id,granted_by) VALUES('legacy-profile-deny',?,'staff.profile.edit','deny','exact_staff',?,?)").bind(actor,target,actor).run();
    await expect(executeNativeStaffManagementCommand(db,request(actor,target,"staff.profile.edit"))).rejects.toThrow("native_staff_management_command_denied");
    await db.prepare("UPDATE native_staff_admin_delegations SET active=0,version=version+1 WHERE id='legacy-profile-deny'").run();
    await db.prepare("UPDATE native_staff_management_delegations SET active=0,version=version+1 WHERE actor_staff_id=? AND capability='staff.profile.edit'").bind(actor).run();
    await db.prepare("INSERT INTO native_staff_admin_delegations(id,actor_staff_id,action,effect,scope_kind,granted_by) VALUES('legacy-profile-allow',?,'staff.profile.edit','allow','global',?)").bind(actor,actor).run();
    expect(await executeNativeStaffManagementCommand(db,request(actor,target,"staff.profile.edit"))).toMatchObject({replayed:false});
    await expect(executeNativeStaffManagementCommand(db,request(actor,target,"staff.admission.enable"))).rejects.toThrow("native_staff_management_command_denied");
    await delegation(actor,"staff.profile.edit","exact_staff","deny",target);
    await delegation(actor,"staff.admission.enable","global","allow",target);
    await delegation(actor,"staff.admission.enable","exact_staff","deny",target);
    await expect(executeNativeStaffManagementCommand(db,request(actor,target,"staff.profile.edit",2))).rejects.toThrow("native_staff_management_command_denied");
    await expect(executeNativeStaffManagementCommand(db,request(actor,target,"staff.admission.enable"))).rejects.toThrow("native_staff_management_command_denied");
  });

  it("denies inactive membership parents for edit and enable",async()=>{
    const actor="actor-inactive-parent",editTarget="inactive-edit",enableTarget="inactive-enable";await staff(actor);await staff(editTarget,0);await staff(enableTarget,0);
    await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('inactive-scope-area','Inactive',0)").run();
    for(const target of [editTarget,enableTarget]) await db.prepare("INSERT INTO native_staff_target_memberships(id,staff_id,scope_kind,business_area_id,created_by) VALUES(?,?,'business_area','inactive-scope-area',?)").bind(`inactive-member-${target}`,target,actor).run();
    for(const capability of ["staff.profile.edit","staff.admission.enable"]) await db.prepare("INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,business_area_id,granted_by) VALUES(?,?,?,'allow','business_area','inactive-scope-area',?)").bind(`inactive-${capability}`,actor,capability,actor).run();
    await expect(executeNativeStaffManagementCommand(db,request(actor,editTarget,"staff.profile.edit"))).rejects.toThrow("native_staff_management_command_denied");
    await expect(executeNativeStaffManagementCommand(db,request(actor,enableTarget,"staff.admission.enable"))).rejects.toThrow("native_staff_management_command_denied");
  });

  it("retains identity and grants while enabling without a PA account",async()=>{
    const actor="actor-enable-retain",target="target-enable-retain";await staff(actor);await staff(target,0);
    await delegation(actor,"staff.admission.enable","exact_staff","allow",target);
    await db.prepare("INSERT INTO native_staff_admin_delegations(id,actor_staff_id,action,effect,scope_kind,granted_by) VALUES('retained-target-grant',?,'staff.profile.edit','allow','global',?)").bind(target,actor).run();
    expect(await executeNativeStaffManagementCommand(db,request(actor,target,"staff.admission.enable"))).toMatchObject({replayed:false});
    expect(await db.prepare("SELECT bound_access_subject,active FROM native_staff_admissions WHERE staff_id=?").bind(target).first()).toEqual({bound_access_subject:`access|${target}`,active:1});
    expect(await db.prepare("SELECT active FROM native_staff_admin_delegations WHERE id='retained-target-grant'").first("active")).toBe(1);
    expect(await db.prepare("SELECT project_alpha_user_id FROM staff_users WHERE id=?").bind(target).first("project_alpha_user_id")).toBeNull();
  });
});
