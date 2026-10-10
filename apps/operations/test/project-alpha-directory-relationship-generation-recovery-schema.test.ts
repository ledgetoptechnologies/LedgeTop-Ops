import { readFileSync,readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe,expect,it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";

function apply(db:DatabaseSync,path:string){for(const sql of unstable_splitSqlQuery(readFileSync(path,"utf8")))try{db.exec(sql);}catch(error){throw new Error(`${path}\n${sql}`,{cause:error});}}
function schema(db:DatabaseSync,type:string,name:string){return String((db.prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?").get(type,name) as {sql:string}).sql);}

describe("assign-only relationship generation recovery schema",()=>{
  it("applies the complete immutable chain and preserves the original outbox contract",()=>{
    const db=new DatabaseSync(":memory:"),migrations=resolve(import.meta.dirname,"../migrations");db.exec("PRAGMA foreign_keys=ON");
    const names=readdirSync(migrations).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n.slice(0,4)<="0184").sort();
    for(const name of names)apply(db,resolve(migrations,name));
    expect(names.at(-1)).toBe("0184_project_alpha_directory_relationship_generation_recovery.sql");
    expect(schema(db,"table","project_alpha_directory_relationship_outbox")).toContain("UNIQUE(mutation_id,source_id,source_instance_id,application_id,history_epoch_id)");
    expect(schema(db,"table","project_alpha_directory_relationship_generation_recovery_reviews")).toContain("json_array_length(selected_grants_json)=8");
    expect(schema(db,"table","project_alpha_directory_relationship_generation_recoveries")).toContain("CHECK(recovery_depth=1)");
    expect(schema(db,"table","project_alpha_directory_relationship_generation_recoveries")).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(schema(db,"table","project_alpha_directory_relationship_generation_recoveries")).toContain("UNIQUE REFERENCES project_alpha_directory_relationship_recovery_outbox(command_id)");
    expect(schema(db,"table","project_alpha_directory_relationship_recovery_outbox")).not.toContain("mutation_id");
    expect(schema(db,"view","project_alpha_directory_effective_relationship_commands")).toContain("'generation_recovery'");
    expect(schema(db,"view","project_alpha_directory_live_relationship_commands")).toContain("FROM project_alpha_directory_relationship_outbox command");
    expect(schema(db,"view","project_alpha_directory_live_relationship_commands")).toContain("validated_recovery_relationship_acknowledgements");
    expect(schema(db,"view","project_alpha_directory_effective_relationship_revision_evidence")).toContain("validated_recovery_relationship_acknowledgements");
  });

  it("pins generation bounds, exact successor bytes, eight per-record grants, and exact ACK provenance",()=>{
    const text=readFileSync(resolve(import.meta.dirname,"../migrations/0184_project_alpha_directory_relationship_generation_recovery.sql"),"utf8");
    expect(text).toContain("CAST(observed_authorization_generation AS INTEGER)<9223372036854775807");
    expect(text).toContain("json_remove(NEW.successor_command_json,'$.commandId','$.expectedAuthorizationGeneration')");
    expect(text).toContain("count(DISTINCT json_extract(value,'$.recordId')||':'||json_extract(value,'$.permission'))");
    expect(text).toContain("BEFORE UPDATE OF review_id,client_record_id");
    expect(text).toContain("role_id IN ('role-owner','role-admin')");
    expect(text).toContain("$.sourceInstanceUUID");
    expect(text).toContain("$.externalCanonicalId");
    for(const permission of ["directory.profile.view","directory.profile.edit","directory.identity.link","directory.enrollment.manage"])
      expect(text).toContain(permission);
    for(const field of ["sourceInstanceId","applicationId","historyEpoch","organizationPublicId","requestId"])
      expect(text).toContain(field);
  });
});
