import { readFileSync,readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe,expect,it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";

function apply(db:DatabaseSync,path:string){for(const sql of unstable_splitSqlQuery(readFileSync(path,"utf8")))try{db.exec(sql);}catch(error){throw new Error(`${path}\n${sql}`,{cause:error});}}
describe("Directory create generation recovery candidate schema",()=>{
  it("compiles in the complete reviewed 0181 automatic chain",()=>{
    const db=new DatabaseSync(":memory:"),migrations=resolve(import.meta.dirname,"../migrations");db.exec("PRAGMA foreign_keys=ON");
    for(const name of readdirSync(migrations).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort())apply(db,resolve(migrations,name));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_alpha_directory_create_generation_recoveries'").get())
      .toEqual({name:"project_alpha_directory_create_generation_recoveries"});
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='operations_directory_effective_materializations'").get())
      .toEqual({name:"operations_directory_effective_materializations"});
    const reserve=String((db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='operations_directory_materializations_reserve'").get() as {sql:string}).sql);
    expect(reserve).toContain("AFTER INSERT ON operations_directory_materializations");
    expect(reserve).toContain("JOIN operations_directory_effective_materializations m");
    expect(reserve).toContain("INSERT INTO project_alpha_directory_outbox");
    const dependency=String((db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='operations_directory_intent_relationship_dependencies_insert_guard'").get() as {sql:string}).sql);
    expect(dependency).toContain("JOIN operations_directory_effective_materializations materialization");
    const relationship=String((db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='project_alpha_directory_relationship_revision_evidence'").get() as {sql:string}).sql);
    expect(relationship).toContain("JOIN operations_directory_effective_materializations materialization");
    const resolved=String((db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='operations_directory_intent_relationship_resolved'").get() as {sql:string}).sql);
    expect(resolved).toContain("JOIN operations_directory_effective_materializations materialization");
    const recoveryGuard=String((db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='project_alpha_directory_create_generation_recoveries_exact'").get() as {sql:string}).sql);
    expect(recoveryGuard).toContain("json_remove(NEW.successor_command_json,'$.commandId','$.expectedAuthorizationGeneration')");
    expect(recoveryGuard).toContain("json_remove(predecessor.command_json,'$.commandId','$.expectedAuthorizationGeneration')");
    const predecessor={commandId:"00000000-0000-4000-8000-000000000001",operation:"create",resourceType:"client",externalId:"client-1",
      expectedRevision:"0",expectedAuthorizationGeneration:"52",fields:{name:"Client"},organization:{publicId:"a".repeat(32)}};
    const successor={...predecessor,commandId:"00000000-0000-4000-8000-000000000002",expectedAuthorizationGeneration:"53"};
    const exact=(candidate:unknown)=>db.prepare(`SELECT json_remove(?,'$.commandId','$.expectedAuthorizationGeneration')=
      json_remove(?,'$.commandId','$.expectedAuthorizationGeneration') exact`).get(JSON.stringify(candidate),JSON.stringify(predecessor));
    expect(exact(successor)).toEqual({exact:1});
    expect(exact({...successor,organization:{publicId:"b".repeat(32)}})).toEqual({exact:0});
    expect(exact({...successor,unexpected:true})).toEqual({exact:0});
    const recoveryTable=String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='project_alpha_directory_create_generation_recoveries'").get() as {sql:string}).sql);
    expect(recoveryTable).toContain("CAST(observed_authorization_generation AS INTEGER)<9223372036854775807");
    const accepted=(generation:string)=>db.prepare(`SELECT CAST(CAST(? AS INTEGER) AS TEXT)=?
      AND CAST(? AS INTEGER)>=0 AND CAST(? AS INTEGER)<9223372036854775807 accepted`).get(generation,generation,generation,generation);
    expect(accepted("9223372036854775806")).toEqual({accepted:1});
    expect(accepted("9223372036854775807")).toEqual({accepted:0});
    expect(readdirSync(migrations).at(-1)).toBe("0181_project_alpha_directory_create_generation_recovery.sql");
  });
});
