import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";
import {writeClientAuthorityWorkspaceBinding} from "../src/worker/client-authority-workspace-binding";

describe("inert client authority workspace binding migration",()=>{
  let mf:Miniflare,db:D1Database;
  const authority="22222222-2222-4222-8222-222222222222";
  const rootPublicId="a".repeat(32);
  const command={operationId:"bind-1",clientAuthorityId:authority,workspaceId:"workspace-a",
    projectionSourceId:"project-alpha:east",sourceWorkspaceId:"source-workspace-17",
    rootType:"organization" as const,rootPublicId,
    expectedCheckpoint:{sourceGeneration:"generation-7",sourceSequence:7,snapshotGenerationId:"snapshot-7"}};
  const env=(enabled="true")=>({DELIVERY_DB:db,CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED:enabled});
  const head=(id=authority,workspace="workspace-a",source="source-workspace-17",sequence=7)=>
    db.prepare(`INSERT INTO portal_client_authority_workspace_bindings
      (client_authority_id,workspace_id,projection_source_id,source_workspace_id,root_type,root_public_id,
        reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id,operation_id)
      VALUES(?,?,?,?,'organization',?,'generation-7',?,'snapshot-7',?)`)
      .bind(id,workspace,"project-alpha:east",source,rootPublicId,sequence,`bind-${id}`);
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    db=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.batch([
      db.prepare(`CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT NOT NULL,
        pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT NOT NULL)`),
      db.prepare("CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT)"),
      db.prepare("CREATE TABLE portal_v2_entitlements(workspace_id TEXT,entitlement TEXT,status TEXT)"),
      db.prepare("CREATE TABLE portal_v2_public_links(id TEXT PRIMARY KEY,token TEXT NOT NULL)"),
      db.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT NOT NULL,source_workspace_id TEXT NOT NULL)"),
      db.prepare(`CREATE TABLE pa_portal_projection_generations(id TEXT NOT NULL,workspace_id TEXT NOT NULL,
        source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,projection_source_id TEXT NOT NULL,
        workspace_root_type TEXT NOT NULL,workspace_root_public_id TEXT NOT NULL)`),
      db.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,snapshot_generation_id TEXT NOT NULL)"),
      db.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-a','organization',?,NULL,'project-alpha:east')").bind(rootPublicId),
      db.prepare("INSERT INTO portal_v2_public_links VALUES('old-link','unchanged')"),
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES('workspace-a','project-alpha:east','source-workspace-17')"),
      db.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-7','workspace-a','generation-7',7,'project-alpha:east','organization',?)").bind(rootPublicId),
      db.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES('workspace-a','generation-7',7,'snapshot-7')"),
    ]);
    for(const migration of ["0216_client_authority_workspace_ownership_claim.sql",
      "0217_client_authority_workspace_claim_evidence.sql","0218_client_authority_workspace_binding.sql"]){
      const sql=readFileSync(new URL(`../migrations/${migration}`,import.meta.url),"utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)));
    }
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
        root_type,root_public_id,
        reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id)
      VALUES(?,?,?,?,?,?,'organization',?,'generation-7',7,'snapshot-7')`)
      .bind(`bind-${authority}`,fingerprint,authority,"workspace-a","project-alpha:east","source-workspace-17",rootPublicId);
    await audit.run();
    await expect(db.prepare(`INSERT INTO portal_client_authority_workspace_binding_receipts
      (operation_id,request_fingerprint,client_authority_id,workspace_id) VALUES(?,?,?,?)`)
      .bind(`bind-${authority}`,"b".repeat(64),authority,"workspace-a").run()).rejects.toThrow("exact immutable audit");
    await db.prepare(`INSERT INTO portal_client_authority_workspace_binding_receipts
      (operation_id,request_fingerprint,client_authority_id,workspace_id) VALUES(?,?,?,?)`)
      .bind(`bind-${authority}`,fingerprint,authority,"workspace-a").run();
    await expect(db.prepare("UPDATE portal_client_authority_workspace_binding_receipts SET request_fingerprint=?").bind("b".repeat(64)).run()).rejects.toThrow("immutable");
  });

  it("keeps the private writer disabled, unmounted, and access-neutral by default",async()=>{
    await expect(writeClientAuthorityWorkspaceBinding(env("false"),command)).rejects.toThrow("writer-disabled");
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_bindings").first("count")).toBe(0);
    expect(readFileSync(new URL("../src/worker/index.ts",import.meta.url),"utf8"))
      .not.toContain('from "./client-authority-workspace-binding"');
  });

  it("writes one exact inactive mapping with atomic evidence and exact replay",async()=>{
    const first=await writeClientAuthorityWorkspaceBinding(env(),command);
    expect(first).toEqual({operationId:command.operationId,clientAuthorityId:command.clientAuthorityId,
      workspaceId:command.workspaceId,projectionSourceId:command.projectionSourceId,
      sourceWorkspaceId:command.sourceWorkspaceId,rootType:command.rootType,rootPublicId,
      checkpoint:command.expectedCheckpoint,
      state:"inactive",revision:1,replayed:false});
    expect((await writeClientAuthorityWorkspaceBinding(env(),command)).replayed).toBe(true);
    await expect(writeClientAuthorityWorkspaceBinding(env(),{...command,workspaceId:"other"}))
      .rejects.toThrow("operation-conflict");
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_binding_audit").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_binding_receipts").first("count")).toBe(1);
    expect(await db.prepare("SELECT token FROM portal_v2_public_links").first("token")).toBe("unchanged");
  });

  it("rejects stale checkpoints and wrong sources without leaving partial evidence",async()=>{
    await expect(writeClientAuthorityWorkspaceBinding(env(),{...command,sourceWorkspaceId:"wrong"})).rejects.toThrow("binding-conflict");
    await expect(writeClientAuthorityWorkspaceBinding(env(),{...command,rootPublicId:"b".repeat(32)}))
      .rejects.toThrow("binding-conflict");
    await expect(writeClientAuthorityWorkspaceBinding(env(),{...command,rootType:"standalone_client"}))
      .rejects.toThrow("binding-conflict");
    await expect(writeClientAuthorityWorkspaceBinding(env(),{...command,expectedCheckpoint:{...command.expectedCheckpoint,sourceSequence:6}}))
      .rejects.toThrow("binding-conflict");
    await db.prepare("UPDATE pa_portal_projection_checkpoints SET source_sequence=8 WHERE workspace_id='workspace-a'").run();
    await expect(writeClientAuthorityWorkspaceBinding(env(),command)).rejects.toThrow("binding-conflict");
    for(const table of ["portal_client_authority_workspace_bindings","portal_client_authority_workspace_binding_audit",
      "portal_client_authority_workspace_binding_receipts"])
      expect(await db.prepare(`SELECT count(*) count FROM ${table}`).first("count")).toBe(0);
  });

  it("allows only one concurrent root to bind the workspace",async()=>{
    const other={...command,operationId:"bind-2",clientAuthorityId:"33333333-3333-4333-8333-333333333333"};
    const settled=await Promise.allSettled([writeClientAuthorityWorkspaceBinding(env(),command),
      writeClientAuthorityWorkspaceBinding(env(),other)]);
    expect(settled.filter(item=>item.status==="fulfilled")).toHaveLength(1);
    expect(settled.filter(item=>item.status==="rejected")).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_bindings").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_binding_audit").first("count")).toBe(1);
  });

  it("keeps separate authority handles for two PA-backed workspaces",async()=>{
    const otherAuthority="33333333-3333-4333-8333-333333333333";
    const otherRoot="b".repeat(32);
    await db.batch([
      db.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-b','organization',?,NULL,'project-alpha:west')").bind(otherRoot),
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES('workspace-b','project-alpha:west','source-workspace-29')"),
      db.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-9','workspace-b','generation-9',9,'project-alpha:west','organization',?)").bind(otherRoot),
      db.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES('workspace-b','generation-9',9,'snapshot-9')"),
    ]);
    await writeClientAuthorityWorkspaceBinding(env(),command);
    await writeClientAuthorityWorkspaceBinding(env(),{operationId:"bind-west",clientAuthorityId:otherAuthority,
      workspaceId:"workspace-b",projectionSourceId:"project-alpha:west",sourceWorkspaceId:"source-workspace-29",
      rootType:"organization",rootPublicId:otherRoot,
      expectedCheckpoint:{sourceGeneration:"generation-9",sourceSequence:9,snapshotGenerationId:"snapshot-9"}});
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_bindings").first("count")).toBe(2);
    expect(await db.prepare("SELECT count(DISTINCT client_authority_id) count FROM portal_client_authority_workspace_bindings").first("count")).toBe(2);
  });

  it("does not bind a workspace with an existing ownership claim",async()=>{
    await db.prepare(`INSERT INTO portal_client_authority_workspace_claims
      (client_authority_id,workspace_id,projection_source_id,source_workspace_id,state,ownership_epoch,
        reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id,last_operation_id)
      VALUES(?,?,?,?,'active',1,'generation-7',7,'snapshot-7','older-claim')`)
      .bind("33333333-3333-4333-8333-333333333333","workspace-a","project-alpha:east","source-workspace-17").run();
    await expect(writeClientAuthorityWorkspaceBinding(env(),command)).rejects.toThrow("binding-conflict");
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_bindings").first("count")).toBe(0);
  });
});
