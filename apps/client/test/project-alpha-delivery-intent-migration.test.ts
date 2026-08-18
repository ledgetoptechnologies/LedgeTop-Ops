import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import migration from "../migrations/0147_project_alpha_delivery_intents.sql?raw";

describe("Project Alpha delivery-intent migration", () => {
  it("applies fresh and replays while preserving principal-only and lifecycle authority", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY);
      CREATE TABLE portal_v2_folder_bindings(id TEXT,workspace_id TEXT,PRIMARY KEY(id,workspace_id));
      CREATE TABLE shares(id TEXT PRIMARY KEY);`);
    db.exec(migration);
    db.exec(migration);
    db.prepare("INSERT INTO portal_v2_workspaces VALUES(?)").run("workspace-one");
    db.prepare("INSERT INTO portal_v2_folder_bindings VALUES(?,?)").run("binding-one", "workspace-one");
    db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
      (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id) VALUES(?,?,?,?,?)`)
      .run("receipt-one", "delivery-one", "a".repeat(64), "portal", "grant-one");
    db.prepare(`INSERT INTO project_alpha_delivery_portal_grants
      (id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,
       audience_public_id,audience_source_version,actor_id)
      VALUES(?,?,?,?,?,'principal',?,?,?)`)
      .run("grant-one", "receipt-one", "workspace-one", "binding-one", "binding-v1",
        "principal-one", "principal-v1", "delivery-one");
    expect(() => db.prepare(`INSERT INTO project_alpha_delivery_portal_grants
      (id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,
       audience_public_id,audience_source_version,actor_id)
      VALUES(?,?,?,?,?,'project',?,?,?)`)
      .run("bad-grant", "receipt-one", "workspace-one", "binding-one", "binding-v1",
        "project-one", "project-v1", "delivery-one")).toThrow();
    expect(() => db.prepare("UPDATE project_alpha_delivery_portal_grants SET audience_public_id='other',status='revoked',grant_version=2,revoked_at=datetime('now'),revoke_reason_code='project_alpha_delivery_revoked' WHERE id='grant-one'").run()).toThrow();
    db.prepare("INSERT INTO shares VALUES(?)").run("share-one");
    db.prepare(`INSERT INTO project_alpha_delivery_guest_authority
      (share_id,workspace_id,folder_binding_id,binding_source_version,directory_generation_id,
       principal_public_id,principal_source_version,label) VALUES(?,?,?,?,?,?,?,?)`)
      .run("share-one","workspace-one","binding-one","binding-v1","generation-one","principal-one","principal-v1",null);
    expect(() => db.prepare("DELETE FROM shares WHERE id='share-one'").run()).toThrow();
    db.close();
  });
});
