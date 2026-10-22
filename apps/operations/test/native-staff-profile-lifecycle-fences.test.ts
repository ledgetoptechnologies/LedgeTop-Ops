import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { executeNativeStaffManagementCommand } from "../src/worker/native-staff-management-command";

let runtime: Miniflare | undefined;
let db: D1Database;
const subject=(id:string)=>`provider|${id}/opaque`;
const command=(capability:"staff.profile.edit"|"staff.admission.enable",target:string,id:string,version:number,actor="manager")=>({commandId:id,contractVersion:1,capability,actor:{staffId:actor,verifiedAccessSubject:subject(actor)},targetStaffId:target,expectedVersion:version,reason:"Reviewed lifecycle",...(capability==="staff.profile.edit"?{displayName:"Reviewed profile"}:{})});
async function person(id:string,active=1){await db.batch([
 db.prepare("INSERT INTO staff_users(id,email,display_name,status,provisioning_source,sync_protected) VALUES(?,?,?,'active','local',1)").bind(id,`${id}@example.test`,id),
 db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,?,?)").bind(id,subject(id),active,id),
 db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id,`${id}@example.test`,id),
]);}
async function allow(actor:string,cap:string,scope="global",target:string|null=null){await db.prepare("INSERT INTO native_staff_management_delegations(id,actor_staff_id,capability,effect,scope_kind,target_staff_id,granted_by) VALUES(?,?,?,'allow',?,?,?)").bind(`${actor}:${cap}:${scope}:${target??"all"}`,actor,cap,scope,target,actor).run();}
function beforeBatch(change:()=>Promise<unknown>):D1Database{let used=false;return new Proxy(db,{get(base,key){if(key==="withSession")return(...args:Parameters<D1Database["withSession"]>)=>{const session=base.withSession(...args);return new Proxy(session,{get(target,p){if(p==="batch")return async(statements:D1PreparedStatement[])=>{if(!used){used=true;await change();}return target.batch(statements);};const v=Reflect.get(target,p,target);return typeof v==="function"?v.bind(target):v;}});};const v=Reflect.get(base,key,base);return typeof v==="function"?v.bind(base):v;}}) as D1Database;}
beforeAll(async()=>{runtime=new Miniflare({modules:true,compatibilityDate:"2026-07-22",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});db=await runtime.getD1Database("OPS_DB") as D1Database;const dir=new URL("../migrations/",import.meta.url);for(const name of readdirSync(dir).filter(x=>/^\d{4}_.+\.sql$/.test(x)&&x.slice(0,4)<="0069").sort())await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,dir),"utf8")).map(sql=>db.prepare(sql)));for(const [id,active] of [["manager",1],["profile-target",1],["enable-target",0],["scope-target",1],["race-target",1]] as const)await person(id,active);await allow("manager","staff.profile.edit");await allow("manager","staff.admission.enable");},120000);
afterAll(async()=>{await runtime?.dispose();});
describe("independent profile and enable lifecycle fences",()=>{
 it.each(["staff.profile.edit", "staff.admission.enable"] as const)("does not certify identity replacement as %s", async capability => {
  const target = capability === "staff.profile.edit" ? "mixed-profile" : "mixed-admission";
  await person(target, capability === "staff.profile.edit" ? 1 : 0);
  const result = JSON.stringify({contractVersion:1,capability,targetStaffId:target,resultVersion:2,
   ...(capability === "staff.profile.edit" ? {displayName:"Reviewed profile"} : {})});
  const fence = db.prepare(`INSERT INTO native_staff_management_fences
   (command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
    expected_version,result_version,reason,display_name,result_json,result_sha256)
   VALUES(?,?,1,?,'manager',?,?,1,2,'Mixed mutation test',?,?,?)`)
   .bind(target,"a".repeat(64),capability,subject("manager"),target,
    capability === "staff.profile.edit" ? "Reviewed profile" : null,result,"b".repeat(64));
  const mixedMutation = capability === "staff.profile.edit"
   ? db.prepare("UPDATE native_staff_profiles SET display_name='Reviewed profile',login_email='replacement@example.test',version=version+1 WHERE staff_id=?").bind(target)
   : db.prepare("UPDATE native_staff_admissions SET active=1,bound_access_subject='replacement-subject',version=version+1 WHERE staff_id=?").bind(target);
  const receipt = db.prepare(`INSERT INTO native_staff_management_commands
   (command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
    expected_version,result_version,reason,display_name,result_json,result_sha256)
   SELECT command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
    expected_version,result_version,reason,display_name,result_json,result_sha256
   FROM native_staff_management_fences WHERE command_id=?`).bind(target);
  await expect(db.batch([fence,mixedMutation,receipt])).rejects.toThrow();
  expect(await db.prepare("SELECT login_email,version FROM native_staff_profiles WHERE staff_id=?").bind(target).first())
   .toEqual({login_email:`${target}@example.test`,version:1});
  expect(await db.prepare("SELECT bound_access_subject,active,version FROM native_staff_admissions WHERE staff_id=?").bind(target).first())
   .toEqual({bound_access_subject:subject(target),active:capability === "staff.profile.edit" ? 1 : 0,version:1});
  expect(await db.prepare("SELECT count(*) n FROM native_staff_management_commands WHERE command_id=?").bind(target).first("n")).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM native_staff_management_fences WHERE command_id=?").bind(target).first("n")).toBe(0);
 });
 it("edits only profile display name and enables only admission with independent versions",async()=>{await executeNativeStaffManagementCommand(db,command("staff.profile.edit","profile-target","profile-one",1));expect(await db.prepare("SELECT display_name,version FROM native_staff_profiles WHERE staff_id='profile-target'").first()).toEqual({display_name:"Reviewed profile",version:2});expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id='profile-target'").first()).toEqual({active:1,version:1});await executeNativeStaffManagementCommand(db,command("staff.admission.enable","enable-target","enable-one",1));expect(await db.prepare("SELECT active,version FROM native_staff_admissions WHERE staff_id='enable-target'").first()).toEqual({active:1,version:2});});
 it("rechecks authority at batch time and replay",async()=>{const raced=beforeBatch(()=>db.prepare("UPDATE native_staff_management_delegations SET active=0,version=version+1 WHERE id='manager:staff.profile.edit:global:all'").run());await expect(executeNativeStaffManagementCommand(raced,command("staff.profile.edit","scope-target","raced",1))).rejects.toThrow();expect(await db.prepare("SELECT count(*) count FROM native_staff_management_commands WHERE command_id='raced'").first("count")).toBe(0);expect(await db.prepare("SELECT count(*) count FROM native_staff_management_fences WHERE command_id='raced'").first("count")).toBe(0);await expect(executeNativeStaffManagementCommand(db,command("staff.profile.edit","profile-target","profile-one",1))).rejects.toThrow();});
 it("rejects accessors and allows only one concurrent same-version profile command",async()=>{await db.prepare("UPDATE native_staff_management_delegations SET active=1,version=version+1 WHERE id='manager:staff.profile.edit:global:all'").run();let reads=0;const getter:any=command("staff.profile.edit","race-target","getter",1);Object.defineProperty(getter.actor,"verifiedAccessSubject",{enumerable:true,get(){reads++;return subject("manager")}});await expect(executeNativeStaffManagementCommand(db,getter)).rejects.toThrow();expect(reads).toBe(0);const [a,b]=await Promise.allSettled([executeNativeStaffManagementCommand(db,command("staff.profile.edit","race-target","race-a",1)),executeNativeStaffManagementCommand(db,command("staff.profile.edit","race-target","race-b",1))]);expect([a,b].filter(x=>x.status==="fulfilled")).toHaveLength(1);});
});
