import migration from "../migrations/0244_direct_workspace_folder_grants.sql?raw";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {Miniflare} from "miniflare";
import {splitD1MigrationStatements} from "./helpers/d1-migrations";

describe("direct workspace folder grant migration",()=>{
  let mf:Miniflare,db:D1Database;
  const workspace="direct-folder-workspace",folderRef="Sm9icy9DbGllbnRzL0xvcmk",grant="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  beforeEach(async()=>{
    mf=new Miniflare({compatibilityDate:"2026-07-22",modules:true,script:"export default {}",
      d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
    db=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY)"),
      db.prepare("CREATE TABLE portal_v2_public_links(id TEXT PRIMARY KEY,token TEXT NOT NULL)"),
      db.prepare("INSERT INTO portal_v2_workspaces VALUES(?)").bind(workspace),
      db.prepare("INSERT INTO portal_v2_public_links VALUES('old','still-valid')"),
    ]);
    await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));
  });
  afterEach(async()=>mf.dispose());

  const addGrant=()=>db.prepare(`INSERT INTO operations_portal_direct_folder_grants(grant_id,grant_version,workspace_id,target_id,
    client_authority_id,target_revision,publication_revision,publication_snapshot_id,publication_snapshot_sha256,source_id,
    folder_ref,owner_scope_type,owner_record_id,recipient_record_id,audience,status,created_by_operation_id)
    VALUES(?,1,?,'target','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,1,'snapshot',?,'project-alpha:primary',?,
    'organization','pa-root','ops-root','all_members','active','create-op')`)
    .bind(grant,workspace,"c".repeat(64),folderRef);

  it("keeps grant history immutable and confirms mutations match committed state",async()=>{
    await addGrant().run();
    await expect(db.prepare(`INSERT INTO operations_portal_direct_folder_grant_mutations(operation_id,request_fingerprint,action,
      grant_id,resulting_version,resulting_state) VALUES('bad-create',?,'grant.create',?,1,'active')`)
      .bind("d".repeat(64),grant).run()).rejects.toThrow("direct folder mutation did not commit");
    await db.prepare(`INSERT INTO operations_portal_direct_folder_grant_mutations(operation_id,request_fingerprint,action,
      grant_id,resulting_version,resulting_state) VALUES('create-op',?,'grant.create',?,1,'active')`)
      .bind("d".repeat(64),grant).run();
    await db.prepare(`INSERT INTO operations_portal_direct_folder_grant_audit(operation_id,grant_id,grant_version,workspace_id,action)
      VALUES('create-op',?,1,?,'grant.created')`).bind(grant,workspace).run();
    await expect(db.prepare(`UPDATE operations_portal_direct_folder_grants SET owner_record_id='other' WHERE grant_id=?`).bind(grant).run())
      .rejects.toThrow("direct folder grant authority is immutable");
    await expect(db.prepare("DELETE FROM operations_portal_direct_folder_grants WHERE grant_id=?").bind(grant).run())
      .rejects.toThrow("direct folder grant history is immutable");
    expect(await db.prepare("SELECT token FROM portal_v2_public_links WHERE id='old'").first("token")).toBe("still-valid");
  });

  it("rejects false revoke receipts after a stale compare-and-swap",async()=>{
    await addGrant().run();
    await db.prepare(`UPDATE operations_portal_direct_folder_grants SET status='revoked',grant_version=2,
      revoked_at='2026-11-02T10:00:00.000Z',revoked_by_operation_id='real-revoke' WHERE grant_id=?`).bind(grant).run();
    await expect(db.prepare(`INSERT INTO operations_portal_direct_folder_grant_mutations(operation_id,request_fingerprint,action,
      grant_id,resulting_version,resulting_state) VALUES('stale-revoke',?,'grant.revoke',?,2,'revoked')`)
      .bind("e".repeat(64),grant).run()).rejects.toThrow("direct folder mutation did not commit");
    await db.prepare(`INSERT INTO operations_portal_direct_folder_grant_mutations(operation_id,request_fingerprint,action,
      grant_id,resulting_version,resulting_state) VALUES('real-revoke',?,'grant.revoke',?,2,'revoked')`)
      .bind("f".repeat(64),grant).run();
  });

  it("stores no raw R2 prefix or workspace binding and only supports the all-members audience",async()=>{
    const columns=await db.prepare("PRAGMA table_info(operations_portal_direct_folder_grants)").all<{name:string}>();
    expect(columns.results.map(row=>row.name)).not.toContain("r2_prefix");
    expect(columns.results.map(row=>row.name)).not.toContain("folder_binding_id");
    expect(columns.results.map(row=>row.name)).toContain("folder_ref");
    await expect(db.prepare(`INSERT INTO operations_portal_direct_folder_grants(grant_id,grant_version,workspace_id,target_id,
      client_authority_id,target_revision,publication_revision,publication_snapshot_id,publication_snapshot_sha256,source_id,
      folder_ref,owner_scope_type,owner_record_id,recipient_record_id,
      audience,status,created_by_operation_id) VALUES('other',1,?,'target','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,1,'snapshot',?,
      'project-alpha:primary',?,'organization','pa-root','ops-root','principal','active','other-op')`)
      .bind(workspace,"c".repeat(64),folderRef).run()).rejects.toThrow();
  });
});
