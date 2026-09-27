import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {writeClientAuthorityWorkspaceClaim} from "../src/worker/client-authority-workspace-claim";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";

describe("private client authority workspace claim writer",()=>{
  let mf:Miniflare,db:D1Database;
  const authority="22222222-2222-4222-8222-222222222222";
  const base={action:"claim" as const,operationId:"claim-1",clientAuthorityId:authority,projectionSourceId:"project-alpha:east",sourceWorkspaceId:"source-workspace-17",expectedOwnershipEpoch:0 as const};
  const env=(enabled="true")=>({DELIVERY_DB:db,CLIENT_AUTHORITY_WORKSPACE_CLAIM_WRITER_ENABLED:enabled});
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    db=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY)"),
      db.prepare("CREATE TABLE portal_v2_workspace_members(workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,source_type TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id))"),
      db.prepare("CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,source_type TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(workspace_id,identity_id))"),
      db.prepare("CREATE TABLE portal_v2_entitlements(workspace_id TEXT NOT NULL,entitlement TEXT NOT NULL,source_type TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(workspace_id,entitlement))"),
      db.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT NOT NULL,source_workspace_id TEXT NOT NULL)"),
      db.prepare("CREATE TABLE pa_portal_projection_generations(id TEXT NOT NULL,workspace_id TEXT NOT NULL,source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,projection_source_id TEXT NOT NULL,UNIQUE(id,workspace_id))"),
      db.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT NOT NULL,source_sequence INTEGER NOT NULL,snapshot_generation_id TEXT NOT NULL)"),
      db.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-a')"),
      db.prepare("INSERT INTO portal_v2_workspace_members VALUES('workspace-a','existing-reader','local','active')"),
      db.prepare("INSERT INTO portal_v2_entitlements VALUES('workspace-a','existing-read','local','active')"),
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES('workspace-a','project-alpha:east','source-workspace-17')"),
      db.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-7','workspace-a','generation-7',7,'project-alpha:east')"),
      db.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES('workspace-a','generation-7',7,'snapshot-7')"),
    ]);
    for(const name of ["0216_client_authority_workspace_ownership_claim.sql","0217_client_authority_workspace_claim_evidence.sql"]){
      const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),"utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)));
    }
  });
  afterEach(async()=>mf.dispose());

  it("is default-off, route-less, and changes no existing access",async()=>{
    await expect(writeClientAuthorityWorkspaceClaim(env("false"),base)).rejects.toThrow("writer-disabled");
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_claims").first("count")).toBe(0);
    expect(await db.prepare("SELECT user_id FROM portal_v2_workspace_members WHERE workspace_id='workspace-a'").first("user_id")).toBe("existing-reader");
    expect(await db.prepare("SELECT entitlement FROM portal_v2_entitlements WHERE workspace_id='workspace-a'").first("entitlement")).toBe("existing-read");
    expect(readFileSync(new URL("../src/worker/index.ts",import.meta.url),"utf8")).not.toContain("client-authority-workspace-claim");
  });

  it("claims only the exact existing source and current checkpoint, with immutable evidence",async()=>{
    await expect(writeClientAuthorityWorkspaceClaim(env(),{...base,workspaceId:"caller-selected"})).rejects.toThrow("invalid");
    const written=await writeClientAuthorityWorkspaceClaim(env(),base);
    expect(written).toEqual({operationId:"claim-1",clientAuthorityId:authority,workspaceId:"workspace-a",projectionSourceId:"project-alpha:east",sourceWorkspaceId:"source-workspace-17",ownershipEpoch:1,state:"active",checkpoint:{sourceGeneration:"generation-7",sourceSequence:7,snapshotGenerationId:"snapshot-7"},replayed:false});
    expect(await db.prepare("SELECT projection_source_id||'/'||source_workspace_id source FROM portal_client_authority_workspace_claims").first("source")).toBe("project-alpha:east/source-workspace-17");
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_claim_audit").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_claim_receipts").first("count")).toBe(1);
    await expect(db.prepare("DELETE FROM portal_client_authority_workspace_claim_audit").run()).rejects.toThrow("immutable");
    expect(await db.prepare("SELECT user_id FROM portal_v2_workspace_members").first("user_id")).toBe("existing-reader");
  });

  it("replays only an exact command fingerprint and rejects operation reuse",async()=>{
    await writeClientAuthorityWorkspaceClaim(env(),base);
    expect((await writeClientAuthorityWorkspaceClaim(env(),base)).replayed).toBe(true);
    await expect(writeClientAuthorityWorkspaceClaim(env(),{...base,sourceWorkspaceId:"other"})).rejects.toThrow("operation-conflict");
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_claim_audit").first("count")).toBe(1);
  });

  it("rejects a command for a source pair that was never reserved without writing anything",async()=>{
    await expect(writeClientAuthorityWorkspaceClaim(env(),{...base,sourceWorkspaceId:"unreserved-source-workspace"})).rejects.toThrow("source-missing");
    for(const table of ["portal_client_authority_workspace_claims","portal_client_authority_workspace_claim_audit","portal_client_authority_workspace_claim_receipts"])
      expect(await db.prepare(`SELECT count(*) count FROM ${table}`).first("count")).toBe(0);
  });

  it("releases through exact CAS at a newer current checkpoint and leaves a terminal tombstone",async()=>{
    await writeClientAuthorityWorkspaceClaim(env(),base);
    await db.prepare("UPDATE pa_portal_projection_checkpoints SET source_sequence=8 WHERE workspace_id='workspace-a'").run();
    const release={action:"release" as const,operationId:"release-1",clientAuthorityId:authority,projectionSourceId:base.projectionSourceId,sourceWorkspaceId:base.sourceWorkspaceId,expectedOwnershipEpoch:1};
    expect((await writeClientAuthorityWorkspaceClaim(env(),release)).state).toBe("released");
    await expect(writeClientAuthorityWorkspaceClaim(env(),{...release,operationId:"release-2",expectedOwnershipEpoch:1})).rejects.toThrow("cas-conflict");
    expect(await db.prepare("SELECT state||':'||ownership_epoch value FROM portal_client_authority_workspace_claims").first("value")).toBe("released:2");
  });

  it("fails closed when a claimed PA tombstone leaves effective authorization and no later delivery reconciles it",async()=>{
    await writeClientAuthorityWorkspaceClaim(env(),base);
    await db.batch([
      db.prepare("INSERT INTO portal_v2_workspace_memberships VALUES('workspace-a','stale-pa-reader','project_alpha','active')"),
      db.prepare("INSERT INTO portal_v2_entitlements VALUES('workspace-a','stale-pa-grant','project_alpha','active')"),
      db.prepare("UPDATE pa_portal_projection_checkpoints SET source_sequence=8 WHERE workspace_id='workspace-a'"),
    ]);
    const release={action:"release" as const,operationId:"release-after-tombstone",clientAuthorityId:authority,projectionSourceId:base.projectionSourceId,sourceWorkspaceId:base.sourceWorkspaceId,expectedOwnershipEpoch:1};
    await expect(writeClientAuthorityWorkspaceClaim(env(),release)).rejects.toThrow("release-blocked-effective-authorization");
    expect(await db.prepare("SELECT state||':'||ownership_epoch value FROM portal_client_authority_workspace_claims").first("value")).toBe("active:1");
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_claim_audit").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_claim_receipts").first("count")).toBe(1);
  });

  it("atomically selects one concurrent claimant and leaves no loser evidence",async()=>{
    const other={...base,operationId:"claim-2",clientAuthorityId:"33333333-3333-4333-8333-333333333333"};
    const settled=await Promise.allSettled([writeClientAuthorityWorkspaceClaim(env(),base),writeClientAuthorityWorkspaceClaim(env(),other)]);
    expect(settled.filter(item=>item.status==="fulfilled")).toHaveLength(1);
    expect(settled.filter(item=>item.status==="rejected")).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_claims").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_claim_audit").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM portal_client_authority_workspace_claim_receipts").first("count")).toBe(1);
  });
});
