import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";
import {writeClientAuthorityWorkspaceBinding} from "../src/worker/client-authority-workspace-binding";
import {readClientPortalAuthorityV2Status,writeClientPortalAuthorityV2} from "../src/worker/client-portal-authority-v2";

describe("Operations portal authority v2 control plane",()=>{
  let mf:Miniflare,db:D1Database;
  const authority="22222222-2222-4222-8222-222222222222",workspace="workspace-a",bindingOperationId="bind-1";
  const env=(enabled="true")=>({DELIVERY_DB:db,CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED:enabled,
    CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED:enabled});
  const command=(operationId:string,desiredState:"active"|"revoked"="active",expectedGrantRevision=0)=>({operationId,
    clientAuthorityId:authority,workspaceId:workspace,bindingOperationId,issuer:"https://access.example.test",
    subject:"person-1",desiredState,expectedOwnershipEpoch:desiredState==="active"&&expectedGrantRevision===0?0:1,
    expectedGrantRevision,scopes:[] as []});
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    db=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const root="a".repeat(32);
    await db.batch([
      db.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT)"),
      db.prepare("CREATE TABLE portal_v2_workspace_memberships(workspace_id TEXT,identity_id TEXT,status TEXT)"),
      db.prepare("CREATE TABLE portal_v2_entitlements(workspace_id TEXT,identity_id TEXT,status TEXT)"),
      db.prepare("CREATE TABLE portal_v2_public_links(id TEXT PRIMARY KEY,token TEXT NOT NULL)"),
      db.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT)"),
      db.prepare("CREATE TABLE pa_portal_projection_generations(id TEXT,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,projection_source_id TEXT,workspace_root_type TEXT,workspace_root_public_id TEXT)"),
      db.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT,source_sequence INTEGER,snapshot_generation_id TEXT)"),
      db.prepare("INSERT INTO portal_v2_workspaces VALUES(?, 'organization', ?, NULL, 'project-alpha:east')").bind(workspace,root),
      db.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,'project-alpha:east','source-a')").bind(workspace),
      db.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-1',?,'generation-1',1,'project-alpha:east','organization',?)").bind(workspace,root),
      db.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES(?,'generation-1',1,'snapshot-1')").bind(workspace),
      db.prepare("INSERT INTO portal_v2_public_links VALUES('link-1','unchanged')"),
    ]);
    for(const migration of ["0216_client_authority_workspace_ownership_claim.sql","0217_client_authority_workspace_claim_evidence.sql",
      "0218_client_authority_workspace_binding.sql","0219_operations_portal_authority_v2.sql"]){
      const sql=readFileSync(new URL(`../migrations/${migration}`,import.meta.url),"utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)));
    }
    await writeClientAuthorityWorkspaceBinding({DELIVERY_DB:db,CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED:"true"},{
      operationId:bindingOperationId,clientAuthorityId:authority,workspaceId:workspace,projectionSourceId:"project-alpha:east",
      sourceWorkspaceId:"source-a",rootType:"organization",rootPublicId:root,
      expectedCheckpoint:{sourceGeneration:"generation-1",sourceSequence:1,snapshotGenerationId:"snapshot-1"}});
  });
  afterEach(async()=>mf.dispose());

  it("is default-off and access-neutral",async()=>{
    await expect(writeClientPortalAuthorityV2(env("false"),command("grant-1"))).rejects.toThrow("writer-disabled");
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_workspace_memberships").first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM portal_v2_entitlements").first("count")).toBe(0);
    expect(await db.prepare("SELECT token FROM portal_v2_public_links").first("token")).toBe("unchanged");
  });

  it("acquires the exact binding and records exact replay",async()=>{
    await expect(writeClientPortalAuthorityV2(env(),command("grant-1"))).resolves.toMatchObject({ownershipEpoch:1,
      grantRevision:1,state:"active",replayed:false});
    await expect(writeClientPortalAuthorityV2(env(),command("grant-1"))).resolves.toMatchObject({replayed:true});
    await expect(writeClientPortalAuthorityV2(env(),{...command("grant-1"),subject:"altered"})).rejects.toThrow("operation-conflict");
    await expect(readClientPortalAuthorityV2Status(env(),"grant-1")).resolves.toMatchObject({ownershipEpoch:1,grantRevision:1,state:"active"});
  });

  it("uses monotonic person revisions and leaves a durable revoke tombstone",async()=>{
    await writeClientPortalAuthorityV2(env(),command("grant-1"));
    await expect(writeClientPortalAuthorityV2(env(),command("revoke-2","revoked",1))).resolves.toMatchObject({grantRevision:2,state:"revoked"});
    await expect(writeClientPortalAuthorityV2(env(),command("revoke-2","revoked",1))).resolves.toMatchObject({
      grantRevision:2,state:"revoked",replayed:true});
    await expect(writeClientPortalAuthorityV2(env(),{...command("revoke-2","revoked",1),subject:"altered"}))
      .rejects.toThrow("operation-conflict");
    await expect(writeClientPortalAuthorityV2(env(),command("stale","active",1))).rejects.toThrow("cas-conflict");
    expect(await db.prepare("SELECT state FROM portal_operations_principal_grant_heads").first("state")).toBe("revoked");
    await expect(db.prepare("DELETE FROM portal_operations_principal_grant_heads").run()).rejects.toThrow("durable");
  });

  it("separates grants by issuer and subject under one workspace",async()=>{
    await writeClientPortalAuthorityV2(env(),command("grant-1"));
    const secondIssuer={...command("grant-issuer"),issuer:"https://other-issuer.example.test",expectedOwnershipEpoch:1};
    const secondSubject={...command("grant-subject"),subject:"person-2",expectedOwnershipEpoch:1};
    await expect(writeClientPortalAuthorityV2(env(),secondIssuer)).resolves.toMatchObject({grantRevision:1,state:"active"});
    await expect(writeClientPortalAuthorityV2(env(),secondSubject)).resolves.toMatchObject({grantRevision:1,state:"active"});
    await writeClientPortalAuthorityV2(env(),command("revoke-1","revoked",1));
    const rows=await db.prepare(`SELECT issuer,subject,state FROM portal_operations_principal_grant_heads
      WHERE workspace_id=? ORDER BY issuer,subject`).bind(workspace).all<{issuer:string;subject:string;state:string}>();
    expect(rows.results).toEqual([
      {issuer:"https://access.example.test",subject:"person-1",state:"revoked"},
      {issuer:"https://access.example.test",subject:"person-2",state:"active"},
      {issuer:"https://other-issuer.example.test",subject:"person-1",state:"active"},
    ]);
  });

  it("rolls back grant and audit if the receipt cannot be committed",async()=>{
    await db.prepare(`CREATE TRIGGER deny_test_receipt BEFORE INSERT ON portal_operations_authority_v2_receipts
      BEGIN SELECT RAISE(ABORT,'test receipt failure'); END`).run();
    await expect(writeClientPortalAuthorityV2(env(),command("grant-1"))).rejects.toThrow();
    for(const table of ["portal_operations_workspace_authority_heads","portal_operations_principal_grant_heads",
      "portal_operations_authority_v2_audit","portal_operations_authority_v2_receipts"]){
      expect(await db.prepare(`SELECT count(*) count FROM ${table}`).first("count")).toBe(0);
    }
  });

  it("rejects unsafe scopes, wrong bindings, and concurrent initial CAS",async()=>{
    await expect(writeClientPortalAuthorityV2(env(),{...command("scoped"),scopes:[{capability:"workspace.view"}]}))
      .rejects.toThrow("invalid");
    await expect(writeClientPortalAuthorityV2(env(),{...command("wrong"),bindingOperationId:"other"})).rejects.toThrow("v2");
    const settled=await Promise.allSettled([writeClientPortalAuthorityV2(env(),command("grant-a")),
      writeClientPortalAuthorityV2(env(),{...command("grant-b"),subject:"person-2"})]);
    expect(settled.filter(item=>item.status==="fulfilled")).toHaveLength(1);
    expect(settled.filter(item=>item.status==="rejected")).toHaveLength(1);
  });
});
