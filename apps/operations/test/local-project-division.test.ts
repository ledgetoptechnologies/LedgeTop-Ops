import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { assignLocalProjectDivision,localDivisionJoin,readLocalProjectDivision } from "../src/worker/local-project-division";
import type { Env,StaffPrincipal } from "../src/worker/types";

const primary="project-alpha:primary",secondary="project-alpha:secondary";
const instance="11111111-1111-4111-8111-111111111111",application="22222222-2222-4222-8222-222222222222",epoch="33333333-3333-4333-8333-333333333333";
const secondaryInstance="44444444-4444-4444-8444-444444444444";
const identity=(source=primary,history=epoch)=>JSON.stringify(["https://pa.example.test",source===primary?instance:secondaryInstance,application,history]);
const connections=(history=epoch)=>JSON.stringify({version:1,instances:Object.fromEntries([primary,secondary].map(sourceId=>[sourceId,{sourceId,enabled:true,baseUrl:"https://pa.example.test",apiKey:"fixture",sourceInstanceId:sourceId===primary?instance:secondaryInstance,applicationId:application,historyEpoch:history}]))});
const admin:StaffPrincipal={id:"admin",email:"admin@example.test",displayName:"Admin",accessSubject:"admin",projectAlphaUserId:"1"};
let runtime:Miniflare,db:D1Database,env:Env,next=0,migration:string;
const previous=new Map<string,unknown[]>();
const schema=`
CREATE TABLE divisions(id TEXT PRIMARY KEY,name TEXT,code TEXT,project_alpha_business_unit_id TEXT UNIQUE,active INTEGER,updated_at TEXT);
CREATE TABLE staff_users(id TEXT PRIMARY KEY,status TEXT);
CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
CREATE TABLE pa_connectors(source_id TEXT,read_visible INTEGER);
CREATE TABLE pa_projects(id TEXT PRIMARY KEY,projection_source_id TEXT,active INTEGER,business_unit_id TEXT);
CREATE TABLE pa_operations(id TEXT PRIMARY KEY,project_id TEXT,projection_source_id TEXT,active INTEGER,business_unit_id TEXT);
CREATE TABLE pa_tasks(id TEXT PRIMARY KEY,project_id TEXT,projection_source_id TEXT,active INTEGER,business_unit_id TEXT);
INSERT INTO divisions VALUES('a','Greenleaf','A','11',1,'original'),('b','Chippewa','B','22',1,'original'),('inactive','Retired','I','33',0,'original');
INSERT INTO staff_users VALUES('admin','active'),('staff','active');
INSERT INTO staff_role_assignments VALUES('admin','role-admin','global',NULL);
INSERT INTO role_permissions VALUES('role-admin','operations.manage');
INSERT INTO pa_connectors VALUES('project-alpha:secondary',1);
INSERT INTO pa_projects VALUES('p1','project-alpha:primary',1,'11'),('p2','project-alpha:primary',1,'22'),('unassigned','project-alpha:primary',1,NULL),('inactive','project-alpha:primary',1,'33'),('secondary','project-alpha:secondary',1,'11');
INSERT INTO pa_operations VALUES('normal','p1','project-alpha:primary',1,'11'),('mismatch','p1','project-alpha:primary',1,'22'),('orphan',NULL,'project-alpha:primary',1,'22'),('null','p1','project-alpha:primary',1,NULL),('unknown','p1','project-alpha:primary',1,'unknown'),('cross-source','p1','project-alpha:secondary',1,'11');
INSERT INTO pa_tasks VALUES('normal','p1','project-alpha:primary',1,'11'),('mismatch','p1','project-alpha:primary',1,'22'),('orphan',NULL,'project-alpha:primary',1,'22'),('null','p1','project-alpha:primary',1,NULL);
`;
beforeAll(async()=>{
  runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:Array.from({length:24},(_,i)=>`DB${i}`)});
  migration=await readFile(new URL("../migrations/0215_local_project_division_authority.sql",import.meta.url),"utf8");
});
afterAll(async()=>runtime.dispose());
beforeEach(async()=>{
  db=await runtime.getD1Database(`DB${next++}`) as D1Database;
  await db.batch(splitD1MigrationStatements(schema).map(sql=>db.prepare(sql)));
  previous.clear();
  for(const table of ["pa_projects","pa_operations","pa_tasks"]){
    previous.set(table,(await db.prepare(`SELECT r.id,d.id division_id FROM ${table} r LEFT JOIN divisions d ON d.project_alpha_business_unit_id=r.business_unit_id AND d.active=1 WHERE r.projection_source_id=? ORDER BY r.id`).bind(primary).all()).results);
  }
  await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));
  previous.set("unreviewed",(await db.prepare(`SELECT p.id,d.id division_id FROM pa_projects p ${localDivisionJoin("p","project")}`).all()).results);
  // Controlled legacy migration proof: reviewed identities are stamped once.
  await db.batch([primary,secondary].map(source=>db.prepare("INSERT INTO pa_local_division_source_heads VALUES(?,?,1,datetime('now'))").bind(source,identity(source))));
  await db.prepare("UPDATE pa_local_division_mappings SET identity_key=? WHERE projection_source_id=? AND assignment_kind='legacy_exact'").bind(identity(),primary).run();
  env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections()} as Env;
});
const rows=(table:string,kind:"project"|"operation"|"task")=>db.prepare(`SELECT r.id,d.id division_id FROM ${table} r ${localDivisionJoin("r",kind)} WHERE r.projection_source_id=? ORDER BY r.id`).bind(primary).all();

describe("local Operations division authority",()=>{
  it("migrates exactly the old active division relationship including orphan, mismatched and null work",async()=>{
    expect(previous.get("unreviewed")?.every(row=>(row as {division_id:unknown}).division_id===null)).toBe(true);
    for(const [table,kind] of [["pa_projects","project"],["pa_operations","operation"],["pa_tasks","task"]] as const)
      expect((await rows(table,kind)).results).toEqual(previous.get(table));
    expect(await db.prepare("SELECT count(*) count FROM pa_local_division_mappings WHERE projection_source_id=?").bind(secondary).first("count")).toBe(0);
    expect((await db.prepare(`SELECT p.id,d.id division_id FROM pa_projects p ${localDivisionJoin("p","project")} WHERE p.id='secondary'`).all()).results).toEqual([{id:"secondary",division_id:null}]);
  });
  it("keeps null and inactive overrides unassigned without falling back to a broader project division",async()=>{
    await db.prepare("UPDATE divisions SET active=0 WHERE id='b'").run();
    const values=(await rows("pa_operations","operation")).results;
    expect(values.find(row=>row.id==="mismatch")?.division_id).toBeNull();
    expect(values.find(row=>row.id==="null")?.division_id).toBeNull();
    expect(values.find(row=>row.id==="normal")?.division_id).toBe("a");
  });
  it("keeps new PA projects unassigned until reviewed even if they carry a retired unit",async()=>{
    await db.prepare("INSERT INTO pa_projects VALUES('new',?,1,'11')").bind(primary).run();
    expect(await readLocalProjectDivision(env,admin,"new")).toMatchObject({divisionId:null,version:0,status:"unassigned"});
  });
  it("version-checks an explicit administrator assignment and records idempotent audit history",async()=>{
    const key=crypto.randomUUID(),body={divisionId:"b",expectedVersion:0,reason:"Reviewed correct local division"};
    expect(await assignLocalProjectDivision(env,admin,"unassigned",body,key)).toMatchObject({divisionId:"b",version:1,replayed:false});
    expect(await assignLocalProjectDivision(env,admin,"unassigned",body,key)).toMatchObject({divisionId:"b",version:1,replayed:true});
    await expect(assignLocalProjectDivision(env,admin,"unassigned",{...body,divisionId:"a"},crypto.randomUUID())).rejects.toMatchObject({status:409});
    expect(await db.prepare("SELECT count(*) count FROM pa_local_division_changes").first("count")).toBe(1);
  });
  it("denies ordinary staff, target-division denies and inactive target divisions",async()=>{
    await expect(assignLocalProjectDivision(env,{...admin,id:"staff"},"p1",{divisionId:"b",expectedVersion:1,reason:"Review this target division"},crypto.randomUUID())).rejects.toMatchObject({status:403});
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('admin','operations.manage','deny','division','b')").run();
    await expect(assignLocalProjectDivision(env,admin,"p1",{divisionId:"b",expectedVersion:1,reason:"Review this target division"},crypto.randomUUID())).rejects.toMatchObject({status:403});
    await db.prepare("DELETE FROM staff_permission_overrides").run();
    await expect(assignLocalProjectDivision(env,admin,"p1",{divisionId:"inactive",expectedVersion:1,reason:"Review this target division"},crypto.randomUUID())).rejects.toMatchObject({status:409});
    expect(await readLocalProjectDivision(env,admin,"p1")).toMatchObject({divisionId:"a",version:1});
  });
  it("can explicitly unassign without a null wildcard or legacy-unit fallback",async()=>{
    await assignLocalProjectDivision(env,admin,"p1",{divisionId:null,expectedVersion:1,reason:"Reviewed project remains unassigned"},crypto.randomUUID());
    expect((await rows("pa_projects","project")).results.find(row=>row.id==="p1")?.division_id).toBeNull();
    expect((await rows("pa_operations","operation")).results.find(row=>row.id==="normal")?.division_id).toBeNull();
    expect((await rows("pa_operations","operation")).results.find(row=>row.id==="mismatch")?.division_id).toBe("b");
  });
  it("never crosses source boundaries when a secondary project uses a colliding old unit",async()=>{
    await assignLocalProjectDivision(env,admin,"secondary",{divisionId:"b",expectedVersion:0,reason:"Explicit secondary local division"},crypto.randomUUID());
    expect(await readLocalProjectDivision(env,admin,"p1")).toMatchObject({sourceId:primary,divisionId:"a"});
    expect(await readLocalProjectDivision(env,admin,"secondary")).toMatchObject({sourceId:secondary,divisionId:"b"});
    expect((await db.prepare(`SELECT o.id,d.id division_id FROM pa_operations o ${localDivisionJoin("o","operation")} WHERE o.id='cross-source'`).all()).results).toEqual([{id:"cross-source",division_id:null}]);
  });
  it("atomically rechecks a deny added after review and leaves both mapping and audit untouched",async()=>{
    const raced=new Proxy(db,{get(target,property){
      if(property==="batch")return async(statements:D1PreparedStatement[])=>{
        await db.prepare("INSERT INTO staff_permission_overrides VALUES('admin','operations.manage','deny','division','b')").run();
        return target.batch(statements);
      };
      const value=Reflect.get(target,property,target);
      return typeof value==="function"?value.bind(target):value;
    }});
    await expect(assignLocalProjectDivision({...env,OPS_DB:raced},admin,"p1",{divisionId:"b",expectedVersion:1,reason:"Reviewed before concurrent deny"},crypto.randomUUID())).rejects.toMatchObject({status:409});
    expect(await db.prepare("SELECT division_id FROM pa_local_division_mappings WHERE resource_kind='project' AND resource_id='p1'").first("division_id")).toBe("a");
    expect(await db.prepare("SELECT count(*) count FROM pa_local_division_changes").first("count")).toBe(0);
  });
  it("keeps a source hidden by a concurrent visibility decision from receiving a mapping",async()=>{
    const raced=new Proxy(db,{get(target,property){
      if(property==="batch")return async(statements:D1PreparedStatement[])=>{
        await db.prepare("INSERT INTO pa_connectors VALUES('project-alpha:primary',0)").run();
        return target.batch(statements);
      };
      const value=Reflect.get(target,property,target);
      return typeof value==="function"?value.bind(target):value;
    }});
    await expect(assignLocalProjectDivision({...env,OPS_DB:raced},admin,"unassigned",{divisionId:"b",expectedVersion:0,reason:"Reviewed before source was hidden"},crypto.randomUUID())).rejects.toMatchObject({status:409});
    expect(await db.prepare("SELECT count(*) count FROM pa_local_division_mappings WHERE resource_id='unassigned'").first("count")).toBe(0);
  });

  it("retires mappings on every source identity component and blocks stale work fallback",async()=>{
    const nextEpoch="55555555-5555-4555-8555-555555555555";
    for(const changed of [JSON.stringify(["https://other.example.test",instance,application,epoch]),JSON.stringify(["https://pa.example.test",secondaryInstance,application,epoch]),JSON.stringify(["https://pa.example.test",instance,secondaryInstance,epoch]),identity(primary,nextEpoch)]) {
      await db.prepare("UPDATE pa_local_division_source_heads SET identity_key=? WHERE projection_source_id=?").bind(changed,primary).run();
      expect((await rows("pa_projects","project")).results.every(row=>row.division_id===null)).toBe(true);
      expect((await rows("pa_operations","operation")).results.every(row=>row.division_id===null)).toBe(true);
    }
    await assignLocalProjectDivision({...env,PROJECT_ALPHA_API_V2_CONNECTIONS:connections(nextEpoch)},admin,"p1",{divisionId:"a",expectedVersion:1,reason:"Reviewed restored PA identity explicitly"},crypto.randomUUID());
    const work=(await rows("pa_operations","operation")).results;
    expect(work.find(row=>row.id==="normal")?.division_id).toBe("a");
    expect(work.find(row=>row.id==="mismatch")?.division_id).toBeNull();
    expect(work.find(row=>row.id==="null")?.division_id).toBeNull();
  });
  it("rejects stale runtime pins and an identity replacement racing a review",async()=>{
    await expect(readLocalProjectDivision({...env,PROJECT_ALPHA_API_V2_CONNECTIONS:connections("55555555-5555-4555-8555-555555555555")},admin,"p1")).rejects.toMatchObject({status:409});
    const raced=new Proxy(db,{get(target,property){
      if(property==="batch")return async(statements:D1PreparedStatement[])=>{
        await db.prepare("UPDATE pa_local_division_source_heads SET identity_key=NULL WHERE projection_source_id=?").bind(primary).run();
        return target.batch(statements);
      };
      const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
    }});
    await expect(assignLocalProjectDivision({...env,OPS_DB:raced},admin,"p1",{divisionId:"b",expectedVersion:1,reason:"Review before identity is retired"},crypto.randomUUID())).rejects.toMatchObject({status:409});
    expect(await db.prepare("SELECT count(*) count FROM pa_local_division_changes").first("count")).toBe(0);
  });

});
