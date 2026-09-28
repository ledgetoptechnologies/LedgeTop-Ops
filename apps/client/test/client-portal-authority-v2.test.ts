import {readFileSync} from "node:fs";
import {Miniflare} from "miniflare";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";
import {writeClientAuthorityWorkspaceBinding} from "../src/worker/client-authority-workspace-binding";
import {readClientPortalAuthorityV2Status,readClientPortalAuthorityV3Status,writeClientPortalAuthorityV2,
  writeClientPortalAuthorityV3} from "../src/worker/client-portal-authority-v2";

describe("Operations portal authority v2 control plane",()=>{
  let mf:Miniflare,db:D1Database;
  const authority="22222222-2222-4222-8222-222222222222",workspace="workspace-a",bindingOperationId="bind-1";
  const env=(enabled="true")=>({DELIVERY_DB:db,CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED:enabled,
    CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED:enabled});
  const command=(operationId:string,desiredState:"active"|"revoked"="active",expectedGrantRevision=0)=>({operationId,
    clientAuthorityId:authority,workspaceId:workspace,bindingOperationId,issuer:"https://access.example.test",
    subject:"person-1",desiredState,expectedOwnershipEpoch:desiredState==="active"&&expectedGrantRevision===0?0:1,
    expectedGrantRevision,scopes:[] as []});
  const commandV3=(operationId:string,permissions:[]|["operations.service_home.read"],expectedGrantRevision=0,
    desiredState:"active"|"revoked"="active")=>({operationId,clientAuthorityId:authority,workspaceId:workspace,bindingOperationId,
    issuer:"https://access.example.test",subject:"person-1",desiredState,
    expectedOwnershipEpoch:desiredState==="active"&&expectedGrantRevision===0?0:1,expectedGrantRevision,permissions});
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
      "0218_client_authority_workspace_binding.sql","0219_operations_portal_authority_v2.sql",
      "0220_operations_portal_authority_v3_permissions.sql"]){
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

  it("preserves legacy v2 replay and makes every v2 transition permissionless",async()=>{
    const first=await writeClientPortalAuthorityV2(env(),command("legacy-v2"));
    await expect(writeClientPortalAuthorityV2(env(),command("legacy-v2"))).resolves.toEqual({...first,replayed:true});
    await writeClientPortalAuthorityV3(env(),commandV3("v3-grant",["operations.service_home.read"],1));
    await writeClientPortalAuthorityV2(env(),command("v2-clear","active",2));
    await expect(db.prepare(`SELECT protocol_version,permissions_json,grant_revision FROM portal_operations_principal_grant_heads
      WHERE workspace_id=? AND issuer=? AND subject=?`).bind(workspace,"https://access.example.test","person-1").first())
      .resolves.toMatchObject({protocol_version:2,permissions_json:"[]",grant_revision:3});
  });

  it("grants, replays, removes permission, revokes, and regrants on one revision stream",async()=>{
    const grant=commandV3("v3-grant",["operations.service_home.read"]);
    await expect(writeClientPortalAuthorityV3(env(),grant)).resolves.toMatchObject({grantRevision:1,state:"active",
      permissions:["operations.service_home.read"],replayed:false});
    await expect(writeClientPortalAuthorityV3(env(),grant)).resolves.toMatchObject({replayed:true});
    await expect(readClientPortalAuthorityV3Status(env(),"v3-grant")).resolves.toMatchObject({grantRevision:1,
      permissions:["operations.service_home.read"]});
    await expect(writeClientPortalAuthorityV3(env(),commandV3("remove",[],1))).resolves.toMatchObject({grantRevision:2,
      state:"active",permissions:[]});
    await expect(writeClientPortalAuthorityV3(env(),commandV3("revoke",[],2,"revoked"))).resolves.toMatchObject({
      grantRevision:3,state:"revoked",permissions:[]});
    await expect(writeClientPortalAuthorityV3(env(),commandV3("regrant",["operations.service_home.read"],3)))
      .resolves.toMatchObject({grantRevision:4,state:"active",permissions:["operations.service_home.read"]});
  });

  it("rejects cross-version operation reuse, stale CAS, and permission-bearing revoke",async()=>{
    await writeClientPortalAuthorityV2(env(),command("shared-operation"));
    await expect(writeClientPortalAuthorityV3(env(),commandV3("shared-operation",["operations.service_home.read"])))
      .rejects.toThrow("operation-conflict");
    await expect(writeClientPortalAuthorityV3(env(),commandV3("stale",["operations.service_home.read"],0)))
      .rejects.toThrow("cas-conflict");
    await expect(writeClientPortalAuthorityV3(env(),commandV3("bad-revoke",["operations.service_home.read"],1,"revoked")))
      .rejects.toThrow("invalid");
  });

  it("rolls back a v3 head and audit when its receipt fails",async()=>{
    await db.prepare(`CREATE TRIGGER deny_v3_receipt BEFORE INSERT ON portal_operations_authority_v2_receipts
      BEGIN SELECT RAISE(ABORT,'test v3 receipt failure'); END`).run();
    await expect(writeClientPortalAuthorityV3(env(),commandV3("v3-grant",["operations.service_home.read"]))).rejects.toThrow();
    for(const table of ["portal_operations_workspace_authority_heads","portal_operations_principal_grant_heads",
      "portal_operations_authority_v2_audit","portal_operations_authority_v2_receipts"])
      expect(await db.prepare(`SELECT count(*) count FROM ${table}`).first("count")).toBe(0);
  });

  it("rejects direct protocol/permission tampering and preserves immutable evidence",async()=>{
    await writeClientPortalAuthorityV3(env(),commandV3("v3-grant",["operations.service_home.read"]));
    await expect(db.prepare(`UPDATE portal_operations_principal_grant_heads SET protocol_version=2,
      permissions_json='["operations.service_home.read"]',grant_revision=2,last_operation_id='tamper-v2'`).run())
      .rejects.toThrow(/protocol|CAS/i);
    await expect(db.prepare(`UPDATE portal_operations_principal_grant_heads SET state='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      permissions_json='["operations.service_home.read"]',grant_revision=2,last_operation_id='tamper-revoke'`).run())
      .rejects.toThrow(/protocol|CAS/i);
    await expect(db.prepare("UPDATE portal_operations_authority_v2_audit SET permissions_json='[]'").run())
      .rejects.toThrow(/immutable/);
    await expect(db.prepare(`INSERT INTO portal_operations_authority_v2_receipts
      (operation_id,request_fingerprint,workspace_id,client_authority_id,issuer,subject,ownership_epoch,grant_revision,
        resulting_state,protocol_version,permissions_json)
      SELECT 'mismatched-receipt',request_fingerprint,workspace_id,client_authority_id,issuer,subject,ownership_epoch,
        grant_revision,resulting_state,protocol_version,permissions_json FROM portal_operations_authority_v2_audit
        WHERE operation_id='v3-grant'`).run()).rejects.toThrow(/receipt|FOREIGN KEY/i);
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

describe("0220 populated protocol-2 migration",()=>{
  it("defaults historical rows to protocol 2/empty permissions and preserves exact replay fingerprint",async()=>{
    const historical=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {}",
      d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    const historicalDb=await historical.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const authority="33333333-3333-4333-8333-333333333333",workspace="historical-workspace",binding="historical-binding";
    const root="b".repeat(32),issuer="https://access.example.test",subject="historical-person",operation="historical-v2-grant";
    const command={operationId:operation,clientAuthorityId:authority,workspaceId:workspace,bindingOperationId:binding,
      issuer,subject,desiredState:"active" as const,expectedOwnershipEpoch:0,expectedGrantRevision:0,scopes:[] as []};
    try{
      await historicalDb.batch([
        historicalDb.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,root_type TEXT,pa_organization_public_id TEXT,pa_client_public_id TEXT,project_alpha_source_id TEXT)"),
        historicalDb.prepare("CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT)"),
        historicalDb.prepare("CREATE TABLE pa_portal_projection_generations(id TEXT,workspace_id TEXT,source_generation TEXT,source_sequence INTEGER,projection_source_id TEXT,workspace_root_type TEXT,workspace_root_public_id TEXT)"),
        historicalDb.prepare("CREATE TABLE pa_portal_projection_checkpoints(workspace_id TEXT PRIMARY KEY,source_generation TEXT,source_sequence INTEGER,snapshot_generation_id TEXT)"),
        historicalDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?, 'organization', ?, NULL, 'project-alpha:historical')").bind(workspace,root),
        historicalDb.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,'project-alpha:historical','source-historical')").bind(workspace),
        historicalDb.prepare("INSERT INTO pa_portal_projection_generations VALUES('snapshot-historical',?,'generation-historical',1,'project-alpha:historical','organization',?)").bind(workspace,root),
        historicalDb.prepare("INSERT INTO pa_portal_projection_checkpoints VALUES(?,'generation-historical',1,'snapshot-historical')").bind(workspace),
      ]);
      for(const migration of ["0216_client_authority_workspace_ownership_claim.sql","0217_client_authority_workspace_claim_evidence.sql",
        "0218_client_authority_workspace_binding.sql","0219_operations_portal_authority_v2.sql"]){
        const sql=readFileSync(new URL(`../migrations/${migration}`,import.meta.url),"utf8");
        await historicalDb.batch(splitD1MigrationStatements(sql).map(statement=>historicalDb.prepare(statement)));
      }
      await writeClientAuthorityWorkspaceBinding({DELIVERY_DB:historicalDb,CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED:"true"},{
        operationId:binding,clientAuthorityId:authority,workspaceId:workspace,projectionSourceId:"project-alpha:historical",
        sourceWorkspaceId:"source-historical",rootType:"organization",rootPublicId:root,
        expectedCheckpoint:{sourceGeneration:"generation-historical",sourceSequence:1,snapshotGenerationId:"snapshot-historical"}});
      const canonical=JSON.stringify({operationId:operation,clientAuthorityId:authority,workspaceId:workspace,bindingOperationId:binding,
        issuer,subject,desiredState:"active",expectedOwnershipEpoch:0,expectedGrantRevision:0,scopes:[]});
      const fingerprint=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical)))]
        .map(byte=>byte.toString(16).padStart(2,"0")).join("");
      await historicalDb.batch([
        historicalDb.prepare(`INSERT INTO portal_operations_workspace_authority_heads
          (workspace_id,client_authority_id,ownership_epoch,state,binding_operation_id,last_operation_id)
          VALUES(?,?,1,'active',?,?)`).bind(workspace,authority,binding,operation),
        historicalDb.prepare(`INSERT INTO portal_operations_principal_grant_heads
          (workspace_id,client_authority_id,issuer,subject,ownership_epoch,grant_revision,state,last_operation_id,revoked_at)
          VALUES(?,?,?,?,1,1,'active',?,NULL)`).bind(workspace,authority,issuer,subject,operation),
        historicalDb.prepare(`INSERT INTO portal_operations_authority_v2_audit
          (operation_id,request_fingerprint,workspace_id,client_authority_id,issuer,subject,action,ownership_epoch,grant_revision,resulting_state)
          VALUES(?,?,?,?,?,?,'grant',1,1,'active')`).bind(operation,fingerprint,workspace,authority,issuer,subject),
        historicalDb.prepare(`INSERT INTO portal_operations_authority_v2_receipts
          (operation_id,request_fingerprint,workspace_id,client_authority_id,issuer,subject,ownership_epoch,grant_revision,resulting_state)
          VALUES(?,?,?,?,?,?,1,1,'active')`).bind(operation,fingerprint,workspace,authority,issuer,subject),
      ]);
      const migration=readFileSync(new URL("../migrations/0220_operations_portal_authority_v3_permissions.sql",import.meta.url),"utf8");
      await historicalDb.batch(splitD1MigrationStatements(migration).map(statement=>historicalDb.prepare(statement)));
      for(const table of ["portal_operations_principal_grant_heads","portal_operations_authority_v2_audit",
        "portal_operations_authority_v2_receipts"]){
        await expect(historicalDb.prepare(`SELECT protocol_version,permissions_json FROM ${table}`).first())
          .resolves.toMatchObject({protocol_version:2,permissions_json:"[]"});
      }
      expect(await historicalDb.prepare("SELECT request_fingerprint FROM portal_operations_authority_v2_receipts").first("request_fingerprint"))
        .toBe(fingerprint);
      await expect(writeClientPortalAuthorityV2({DELIVERY_DB:historicalDb,CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED:"true"},command))
        .resolves.toMatchObject({operationId:operation,grantRevision:1,replayed:true});
      expect(await historicalDb.prepare("SELECT request_fingerprint FROM portal_operations_authority_v2_receipts").first("request_fingerprint"))
        .toBe(fingerprint);
    }finally{await historical.dispose();}
  });
});
