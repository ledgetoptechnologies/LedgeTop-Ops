import { DatabaseSync } from "node:sqlite";
import { describe,expect,it } from "vitest";
import migration from "../migrations/0199_native_viewer_grants.sql?raw";

describe("native Viewer grant migration",()=>{
  it("binds grants to one native source/workspace/project and prevents duplicate live authority",()=>{
    const db=new DatabaseSync(":memory:");db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,project_alpha_project_id TEXT);
      CREATE TABLE viewer_model_associations(id TEXT PRIMARY KEY,project_id TEXT);`);db.exec(migration);
    db.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,NULL,'active')").run("workspace-one","project-alpha:primary");
    db.prepare("INSERT INTO projects VALUES(?,?,?)").run("project-one","project-alpha:primary","pa-project-one");
    db.prepare("INSERT INTO viewer_model_associations VALUES(?,?)").run("association-one","project-one");
    const insert=()=>db.prepare(`INSERT INTO viewer_native_client_grants
      (id,source_id,workspace_id,project_public_id,scope_type,association_id,include_future_published,created_by_staff_id)
      VALUES(?,?,?,?,?,?,?,?)`);
    insert().run("grant-one","project-alpha:primary","workspace-one","pa-project-one","task","association-one",0,"staff-one");
    expect(()=>insert().run("grant-two","project-alpha:primary","workspace-one","pa-project-one","task","association-one",0,"staff-one")).toThrow();
    expect(()=>insert().run("grant-three","project-alpha:other","workspace-one","pa-project-one","project",null,1,"staff-one")).toThrow(/authority/);
    expect(()=>insert().run("grant-four","project-alpha:primary","workspace-one","other-project","task","association-one",0,"staff-one")).toThrow(/authority/);
    db.prepare("UPDATE viewer_native_client_grants SET status='revoked',revoked_at=datetime('now') WHERE id='grant-one'").run();
    expect(()=>db.prepare("UPDATE viewer_native_client_grants SET status='active',revoked_at=NULL WHERE id='grant-one'").run()).toThrow(/immutable/);
    expect(()=>insert().run("project-without-future","project-alpha:primary","workspace-one","pa-project-one","project",null,0,"staff-one")).toThrow();
    insert().run("grant-five","project-alpha:primary","workspace-one","pa-project-one","task","association-one",0,"staff-one");
    const receipt=db.prepare(`INSERT INTO viewer_native_client_grant_mutation_receipts
      (actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,response_json) VALUES(?,?,'grant.revoke',?,?,?)`);
    receipt.run("staff-one","revoke-key-one","fingerprint-one","grant-one",'{"success":true}');
    expect(()=>receipt.run("staff-two","revoke-key-two","fingerprint-two","grant-one",'{"success":true}')).toThrow();
    expect(db.prepare("SELECT COUNT(*) count FROM viewer_native_client_grants").get()).toEqual({count:2});db.close();
  });
});
