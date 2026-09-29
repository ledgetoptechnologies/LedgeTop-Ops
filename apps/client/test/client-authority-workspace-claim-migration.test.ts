import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";

describe("client authority workspace ownership claim migration",()=>{
  let mf:Miniflare,db:D1Database;
  const authorityA="22222222-2222-4222-8222-222222222222";
  const authorityB="33333333-3333-4333-8333-333333333333";
  const claimA=()=>db.prepare(`INSERT INTO portal_client_authority_workspace_claims
    (client_authority_id,workspace_id,projection_source_id,source_workspace_id,state,ownership_epoch,reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id,last_operation_id)
    VALUES(?,?,?,?, 'active',1,'generation-7',7,'snapshot-7','claim-a')`)
    .bind(authorityA,"local-workspace-a","project-alpha:east","source-workspace-17").run();
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    db=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY)"),
      db.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT NOT NULL,source_workspace_id TEXT NOT NULL)"),
      db.prepare("CREATE TABLE pa_portal_projection_generations(id TEXT NOT NULL,workspace_id TEXT NOT NULL,source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,projection_source_id TEXT NOT NULL,UNIQUE(id,workspace_id))"),
      db.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,snapshot_generation_id TEXT NOT NULL)"),
      db.prepare("INSERT INTO portal_v2_workspaces(id) VALUES('local-workspace-a'),('local-workspace-b')"),
      db.prepare(`INSERT INTO pa_portal_workspace_sources VALUES
        ('local-workspace-a','project-alpha:east','source-workspace-17'),
        ('local-workspace-b','project-alpha:west','source-workspace-17')`),
      db.prepare(`INSERT INTO pa_portal_projection_generations VALUES
        ('snapshot-7','local-workspace-a','generation-7',7,'project-alpha:east'),
        ('snapshot-west-9','local-workspace-b','generation-west-9',9,'project-alpha:west')`),
      db.prepare(`INSERT INTO pa_portal_projection_checkpoints VALUES
        ('local-workspace-a','generation-7',7,'snapshot-7'),
        ('local-workspace-b','generation-west-9',9,'snapshot-west-9')`),
    ]);
    const sql=readFileSync(new URL("../migrations/0216_client_authority_workspace_ownership_claim.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)));
  });
  afterEach(async()=>mf.dispose());

  it("claims an existing workspace without conflating authority, local, or source identity",async()=>{
    await claimA();
    const row=await db.prepare(`SELECT client_authority_id,workspace_id,projection_source_id,source_workspace_id
      FROM portal_client_authority_workspace_claims WHERE client_authority_id=?`).bind(authorityA).first();
    expect(row).toEqual({client_authority_id:authorityA,workspace_id:"local-workspace-a",projection_source_id:"project-alpha:east",source_workspace_id:"source-workspace-17"});
  });

  it("permanently reserves one existing workspace per authority and exact source ownership",async()=>{
    await claimA();
    await expect(db.prepare(`INSERT INTO portal_client_authority_workspace_claims
      (client_authority_id,workspace_id,projection_source_id,source_workspace_id,state,ownership_epoch,reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id,last_operation_id)
      VALUES(?,?,?,?, 'active',1,'generation-7',7,'snapshot-7','claim-b')`).bind(authorityB,"local-workspace-a","project-alpha:east","source-workspace-17").run())
      .rejects.toThrow(/UNIQUE/);
    await expect(db.prepare(`INSERT INTO portal_client_authority_workspace_claims
      (client_authority_id,workspace_id,projection_source_id,source_workspace_id,state,ownership_epoch,reconciliation_source_generation,reconciliation_source_sequence,reconciliation_snapshot_generation_id,last_operation_id)
      VALUES(?,?,?,?, 'active',1,'generation-west-9',9,'snapshot-west-9','claim-wrong-source')`).bind(authorityB,"local-workspace-b","project-alpha:east","source-workspace-17").run())
      .rejects.toThrow(/explicit source ownership/);
    await expect(db.prepare(`UPDATE portal_client_authority_workspace_claims SET workspace_id='local-workspace-b',
      projection_source_id='project-alpha:west',ownership_epoch=2,reconciliation_source_generation='generation-west-9',
      reconciliation_source_sequence=9,reconciliation_snapshot_generation_id='snapshot-west-9',last_operation_id='rebind-a'
      WHERE client_authority_id=?`).bind(authorityA).run()).rejects.toThrow(/CAS or reconciliation/);
  });

  it("requires one-epoch CAS advancement and a newer checkpoint before release",async()=>{
    await claimA();
    await expect(db.prepare(`UPDATE portal_client_authority_workspace_claims SET state='active',ownership_epoch=2,
      reconciliation_source_generation='generation-7',reconciliation_source_sequence=7,
      reconciliation_snapshot_generation_id='snapshot-7',last_operation_id='active-churn' WHERE client_authority_id=?`).bind(authorityA).run())
      .rejects.toThrow(/CAS or reconciliation/);
    await expect(db.prepare(`UPDATE portal_client_authority_workspace_claims SET state='released',ownership_epoch=3,
      reconciliation_source_generation='generation-7',reconciliation_source_sequence=8,
      reconciliation_snapshot_generation_id='snapshot-7',last_operation_id='release-gap' WHERE client_authority_id=?`).bind(authorityA).run())
      .rejects.toThrow(/CAS or reconciliation/);
    await expect(db.prepare(`UPDATE portal_client_authority_workspace_claims SET state='released',ownership_epoch=2,
      reconciliation_source_generation='generation-7',reconciliation_source_sequence=8,
      reconciliation_snapshot_generation_id='snapshot-7',last_operation_id='release-before-checkpoint' WHERE client_authority_id=?`).bind(authorityA).run())
      .rejects.toThrow(/CAS or reconciliation/);
    await db.prepare("UPDATE pa_portal_projection_checkpoints SET source_sequence=8 WHERE workspace_id='local-workspace-a'").run();
    await expect(db.prepare(`UPDATE portal_client_authority_workspace_claims SET state='released',ownership_epoch=2,
      reconciliation_source_generation='wrong-generation',reconciliation_source_sequence=8,
      reconciliation_snapshot_generation_id='snapshot-7',last_operation_id='release-wrong-generation' WHERE client_authority_id=?`).bind(authorityA).run())
      .rejects.toThrow(/CAS or reconciliation/);
    await expect(db.prepare(`UPDATE portal_client_authority_workspace_claims SET state='released',ownership_epoch=2,
      reconciliation_source_generation='generation-7',reconciliation_source_sequence=8,
      reconciliation_snapshot_generation_id='wrong-snapshot',last_operation_id='release-wrong-snapshot' WHERE client_authority_id=?`).bind(authorityA).run())
      .rejects.toThrow(/CAS or reconciliation/);
    await expect(db.prepare(`UPDATE portal_client_authority_workspace_claims SET state='released',ownership_epoch=2,
      reconciliation_source_generation='generation-7',reconciliation_source_sequence=8,
      reconciliation_snapshot_generation_id='snapshot-7',last_operation_id='claim-a' WHERE client_authority_id=?`).bind(authorityA).run())
      .rejects.toThrow(/CAS or reconciliation/);
    await db.prepare(`UPDATE portal_client_authority_workspace_claims SET state='released',ownership_epoch=2,
      reconciliation_source_generation='generation-7',reconciliation_source_sequence=8,
      reconciliation_snapshot_generation_id='snapshot-7',last_operation_id='release-a' WHERE client_authority_id=? AND ownership_epoch=1`).bind(authorityA).run();
    expect(await db.prepare("SELECT state FROM portal_client_authority_workspace_claims WHERE client_authority_id=?").bind(authorityA).first("state")).toBe("released");
    await db.prepare("UPDATE pa_portal_projection_checkpoints SET source_sequence=9 WHERE workspace_id='local-workspace-a'").run();
    await expect(db.prepare(`UPDATE portal_client_authority_workspace_claims SET state='active',ownership_epoch=3,
      reconciliation_source_generation='generation-7',reconciliation_source_sequence=9,
      reconciliation_snapshot_generation_id='snapshot-7',last_operation_id='reactivate-a' WHERE client_authority_id=? AND ownership_epoch=2`).bind(authorityA).run())
      .rejects.toThrow(/CAS or reconciliation/);
  });

  it("defers audit and receipt evidence until an atomic writer migration exists",async()=>{
    const names=await db.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('portal_client_authority_workspace_claim_audit','portal_client_authority_workspace_claim_receipts')`).all();
    expect(names.results).toEqual([]);
  });
});
