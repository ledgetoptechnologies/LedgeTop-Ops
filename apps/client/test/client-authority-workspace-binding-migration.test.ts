import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";

describe("inert client authority workspace binding migration",()=>{
  let mf:Miniflare,db:D1Database;
  const authority="22222222-2222-4222-8222-222222222222";
  const head=(id=authority,workspace="workspace-a",source="source-workspace-17",sequence=7)=>
    db.prepare(`INSERT INTO portal_client_authority_workspace_bindings
      (client_authority_id,workspace_id,projection_source_id,source_workspace_id,
        reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id,operation_id)
      VALUES(?,?,?,?,'generation-7',?,'snapshot-7',?)`)
      .bind(id,workspace,"project-alpha:east",source,sequence,`bind-${id}`);
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    db=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY)"),
      db.prepare("CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT)"),
      db.prepare("CREATE TABLE portal_v2_entitlements(workspace_id TEXT,entitlement TEXT,status TEXT)"),
      db.prepare("CREATE TABLE portal_v2_public_links(id TEXT PRIMARY KEY,token TEXT NOT NULL)"),
      db.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT NOT NULL,source_workspace_id TEXT NOT NULL)"),
      db.prepare("CREATE TABLE pa_portal_projection_generations(id TEXT NOT NULL,workspace_id TEXT NOT NULL,source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,projection_source_id TEXT NOT NULL)"),
      db.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,snapshot_generation_id TEXT NOT NULL)"),
      db.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-a')"),
      db.prepare("INSERT INTO portal_v2_public_links VALUES('old-link','unchanged')"),
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES('workspace-a','project-alpha:east','source-workspace-17')"),
      db.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-7','workspace-a','generation-7',7,'project-alpha:east')"),
      db.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES('workspace-a','generation-7',7,'snapshot-7')"),
    ]);
    const sql=readFileSync(new URL("../migrations/0218_client_authority_workspace_binding.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)));
  });
  afterEach(async()=>mf.dispose());

  it("creates no effective access or changes to public links",async()=>{
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_bindings").first("count")).toBe(0);
    await head().run();
    expect(await db.prepare("SELECT state FROM portal_client_authority_workspace_bindings").first("state")).toBe("inactive");
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_entitlements").first("count")).toBe(0);
    expect(await db.prepare("SELECT token FROM portal_v2_public_links").first("token")).toBe("unchanged");
  });

  it("requires the exact source reservation and current checkpoint",async()=>{
    await expect(head(authority,"workspace-a","wrong-source").run()).rejects.toThrow("current explicit source ownership");
    await expect(head(authority,"workspace-a","source-workspace-17",6).run()).rejects.toThrow("current explicit source ownership");
    await db.prepare("UPDATE pa_portal_projection_checkpoints SET source_sequence=8 WHERE workspace_id='workspace-a'").run();
    await expect(head().run()).rejects.toThrow("current explicit source ownership");
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_bindings").first("count")).toBe(0);
  });

  it("keeps both authority and workspace one-to-one, without remapping",async()=>{
    await head().run();
    await expect(head("33333333-3333-4333-8333-333333333333").run()).rejects.toThrow("UNIQUE");
    await expect(db.prepare("UPDATE portal_client_authority_workspace_bindings SET workspace_id='other' WHERE client_authority_id=?").bind(authority).run()).rejects.toThrow("immutable");
    await expect(db.prepare("DELETE FROM portal_client_authority_workspace_bindings").run()).rejects.toThrow("immutable");
  });

  it("allows only one of two racing authority roots to reserve a workspace",async()=>{
    const other="33333333-3333-4333-8333-333333333333";
    const settled=await Promise.allSettled([head().run(),head(other).run()]);
    expect(settled.filter(item=>item.status==="fulfilled")).toHaveLength(1);
    expect(settled.filter(item=>item.status==="rejected")).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_bindings").first("count")).toBe(1);
  });

  it("requires matching immutable evidence and blocks altered receipt replay",async()=>{
    await head().run();
    const fingerprint="a".repeat(64);
    const audit=db.prepare(`INSERT INTO portal_client_authority_workspace_binding_audit
      (operation_id,request_fingerprint,client_authority_id,workspace_id,projection_source_id,source_workspace_id,
        reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id)
      VALUES(?,?,?,?,? ,?,'generation-7',7,'snapshot-7')`)
      .bind(`bind-${authority}`,fingerprint,authority,"workspace-a","project-alpha:east","source-workspace-17");
    await audit.run();
    await expect(db.prepare(`INSERT INTO portal_client_authority_workspace_binding_receipts
      (operation_id,request_fingerprint,client_authority_id,workspace_id) VALUES(?,?,?,?)`)
      .bind(`bind-${authority}`,"b".repeat(64),authority,"workspace-a").run()).rejects.toThrow("exact immutable audit");
    await db.prepare(`INSERT INTO portal_client_authority_workspace_binding_receipts
      (operation_id,request_fingerprint,client_authority_id,workspace_id) VALUES(?,?,?,?)`)
      .bind(`bind-${authority}`,fingerprint,authority,"workspace-a").run();
    await expect(db.prepare("UPDATE portal_client_authority_workspace_binding_receipts SET request_fingerprint=?").bind("b".repeat(64)).run()).rejects.toThrow("immutable");
  });
});
