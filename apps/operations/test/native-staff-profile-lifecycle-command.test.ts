import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { executeNativeStaffManagementCommand } from "../src/worker/native-staff-management-command";

let runtime: Miniflare | undefined;
let db: D1Database;
const actor = "lifecycle-admin";
const target = "lifecycle-target";
const base = (commandId:string, capability:string, expectedVersion:number) => ({commandId,contractVersion:1,capability,actor:{staffId:actor,verifiedAccessSubject:"lifecycle-subject"},targetStaffId:target,expectedVersion,reason:"Lifecycle test"});

describe("native staff profile and admission lifecycle commands",()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
    db=await runtime.getD1Database("OPS_DB") as D1Database;
    const directory=new URL("../migrations/",import.meta.url);
    for(const migration of readdirSync(directory).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n.slice(0,4)<="0069").sort()) await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration,directory),"utf8")).map(s=>db.prepare(s)));
    for(const [id,subject,active] of [[actor,"lifecycle-subject",1],[target,"target-subject",0]] as const) await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name) VALUES(?,?,?)").bind(id,`${id}@example.test`,id),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,?,'staff-beau-koltz')").bind(id,subject,active),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id,`${id}@example.test`,id),
    ]);
    for(const capability of ["staff.profile.edit","staff.admission.enable"]) await db.prepare("INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)").bind(`lifecycle:${capability}`,actor,capability,actor).run();
  },120_000);
  afterAll(async()=>runtime?.dispose());

  it("edits only the display name and durably replays",async()=>{
    const input={...base("profile-edit","staff.profile.edit",1),displayName:"Renamed target"};
    expect(await executeNativeStaffManagementCommand(db,input)).toMatchObject({replayed:false,resultVersion:2});
    expect(await executeNativeStaffManagementCommand(db,input)).toMatchObject({replayed:true,resultVersion:2});
    expect(await db.prepare("SELECT login_email,display_name,version FROM native_staff_profiles WHERE staff_id=?").bind(target).first()).toEqual({login_email:`${target}@example.test`,display_name:"Renamed target",version:2});
    expect(await db.prepare("SELECT active,version,bound_access_subject FROM native_staff_admissions WHERE staff_id=?").bind(target).first()).toEqual({active:0,version:1,bound_access_subject:"target-subject"});
    await expect(executeNativeStaffManagementCommand(db,{...input,displayName:"Different replay"})).rejects.toThrow("native_staff_management_command_denied");
  });

  it("enables only an existing bound inactive admission",async()=>{
    const input=base("admission-enable","staff.admission.enable",1);
    expect(await executeNativeStaffManagementCommand(db,input)).toMatchObject({replayed:false,resultVersion:2});
    expect(await executeNativeStaffManagementCommand(db,input)).toMatchObject({replayed:true,resultVersion:2});
    expect(await db.prepare("SELECT active,version,bound_access_subject FROM native_staff_admissions WHERE staff_id=?").bind(target).first()).toEqual({active:1,version:2,bound_access_subject:"target-subject"});
  });

  it("allows only one pending fence for the same mutation identity",async()=>{
    const insert=`INSERT INTO native_staff_management_fences(command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,display_name,result_json,result_sha256)
      VALUES(?,? ,1,'staff.profile.edit',?,?,?,?,3,'Pending fence','Pending name','{}',?)`;
    await db.prepare(insert).bind("pending-one","0".repeat(64),actor,"lifecycle-subject",target,2,"1".repeat(64)).run();
    await expect(db.prepare(insert).bind("pending-two","2".repeat(64),actor,"lifecycle-subject",target,2,"3".repeat(64)).run()).rejects.toThrow();
    await db.prepare("DELETE FROM native_staff_management_fences WHERE command_id='pending-one'").run();
  });

  it("rolls back profile edits and admission enables when late audit insertion fails",async()=>{
    await db.prepare(`CREATE TRIGGER synthetic_lifecycle_audit_failure BEFORE INSERT ON native_staff_management_commands
      WHEN NEW.command_id IN ('late-edit','late-enable') BEGIN SELECT RAISE(ABORT,'synthetic lifecycle audit failure'); END`).run();
    await expect(executeNativeStaffManagementCommand(db,{...base("late-edit","staff.profile.edit",2),displayName:"Must roll back"})).rejects.toThrow("native_staff_management_command_denied");
    expect(await db.prepare("SELECT display_name,version FROM native_staff_profiles WHERE staff_id=?").bind(target).first()).toEqual({display_name:"Renamed target",version:2});
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?").bind(target).run();
    await expect(executeNativeStaffManagementCommand(db,base("late-enable","staff.admission.enable",3))).rejects.toThrow("native_staff_management_command_denied");
    expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id=?").bind(target).first()).toEqual({active:0,version:3});
    expect(await db.prepare("SELECT count(*) count FROM native_staff_management_fences WHERE command_id IN ('late-edit','late-enable')").first("count")).toBe(0);
  });

  it("keeps version domains and legacy authority action-specific",async()=>{
    await expect(executeNativeStaffManagementCommand(db,{...base("wrong-profile-version","staff.profile.edit",3),displayName:"Wrong domain"})).rejects.toThrow("native_staff_management_command_denied");
    await expect(executeNativeStaffManagementCommand(db,base("wrong-admission-version","staff.admission.enable",2))).rejects.toThrow("native_staff_management_command_denied");
    await db.prepare("UPDATE native_staff_management_delegations SET active=0,version=version+1 WHERE id='lifecycle:staff.admission.enable'").run();
    await db.prepare("INSERT INTO native_staff_admin_delegations(id,actor_staff_id,action,effect,scope_kind,granted_by) VALUES('legacy-profile-only',?,'staff.profile.edit','allow','global',?)").bind(actor,actor).run();
    await expect(executeNativeStaffManagementCommand(db,base("legacy-cannot-enable","staff.admission.enable",3))).rejects.toThrow("native_staff_management_command_denied");
    await db.prepare("UPDATE native_staff_management_delegations SET active=1,version=version+1 WHERE id='lifecycle:staff.admission.enable'").run();
    await expect(executeNativeStaffManagementCommand(db,{...base("missing-account","staff.admission.enable",1),targetStaffId:"does-not-exist"})).rejects.toThrow("native_staff_management_command_denied");
    expect(await db.prepare("SELECT count(*) count FROM native_staff_admissions WHERE staff_id='does-not-exist'").first("count")).toBe(0);
  });

  it("rejects malformed action shapes and self-enable",async()=>{
    await expect(executeNativeStaffManagementCommand(db,{...base("bad-extra","staff.admission.enable",2),displayName:"Extra"})).rejects.toThrow("native_staff_management_command_denied");
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?").bind(actor).run();
    await expect(executeNativeStaffManagementCommand(db,{...base("self-enable","staff.admission.enable",2),targetStaffId:actor})).rejects.toThrow("native_staff_management_command_denied");
  });
});
