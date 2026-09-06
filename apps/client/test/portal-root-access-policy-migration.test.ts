import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import migration from "../migrations/0197_portal_root_access_policy.sql?raw";

const insertPolicy = (db: DatabaseSync, sourceId: string, publicId: string) => {
  db.prepare(`INSERT INTO portal_v2_root_access_policies(
      projection_source_id,root_type,root_public_id,state,reason_code,
      created_by_staff_id,updated_by_staff_id
    ) VALUES(?,?,?,?,?,?,?)`)
    .run(sourceId, "organization", publicId, "revoked", "security_concern", "staff-1", "staff-1");
};

describe("portal root access-policy migration", () => {
  it("applies cleanly and preserves source-scoped policy, receipt, and immutable audit records", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(migration);

    insertPolicy(db, "pa-ltds", "shared-root");
    insertPolicy(db, "pa-ltt", "shared-root");
    db.prepare(`INSERT INTO portal_v2_root_access_policy_mutations(
        actor_staff_id,idempotency_key,action,request_fingerprint,
        projection_source_id,root_type,root_public_id,result_version
      ) VALUES(?,?,?,?,?,?,?,?)`)
      .run("staff-1", "request-1", "root.revoke", "a".repeat(64), "pa-ltds", "organization", "shared-root", 1);
    db.prepare(`INSERT INTO portal_v2_root_access_policy_audit(
        operation_id,projection_source_id,root_type,root_public_id,action,version,reason_code,actor_staff_id
      ) VALUES(?,?,?,?,?,?,?,?)`)
      .run("operation-1", "pa-ltds", "organization", "shared-root", "root.revoked", 1, "security_concern", "staff-1");

    expect(db.prepare(`SELECT projection_source_id,state,version
      FROM portal_v2_root_access_policies ORDER BY projection_source_id`).all()).toEqual([
      { projection_source_id: "pa-ltds", state: "revoked", version: 1 },
      { projection_source_id: "pa-ltt", state: "revoked", version: 1 },
    ]);
    expect(() => db.prepare("DELETE FROM portal_v2_root_access_policies WHERE projection_source_id=?")
      .run("pa-ltds")).toThrow(/cannot be deleted/);
    expect(() => db.prepare("UPDATE portal_v2_root_access_policy_audit SET reason_code='changed' WHERE operation_id=?")
      .run("operation-1")).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM portal_v2_root_access_policy_audit WHERE operation_id=?")
      .run("operation-1")).toThrow(/immutable/);
    db.close();
  });

  it("is additive on a populated database and leaves existing portal data unchanged", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE portal_v2_workspaces(
      id TEXT PRIMARY KEY,
      projection_source_id TEXT NOT NULL,
      root_type TEXT NOT NULL,
      root_public_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO portal_v2_workspaces VALUES(
      'workspace-1','pa-ltds','organization','organization-1','active'
    );`);

    db.exec(migration);

    expect(db.prepare("SELECT * FROM portal_v2_workspaces").get()).toEqual({
      id: "workspace-1",
      projection_source_id: "pa-ltds",
      root_type: "organization",
      root_public_id: "organization-1",
      status: "active",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM portal_v2_root_access_policies").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT id,version FROM portal_v2_root_access_policy_lock").get()).toEqual({ id: 1, version: 0 });

    insertPolicy(db, "pa-ltds", "organization-1");
    expect(db.prepare(`SELECT state FROM portal_v2_root_access_policies
      WHERE projection_source_id='pa-ltds' AND root_type='organization' AND root_public_id='organization-1'`).get())
      .toEqual({ state: "revoked" });
    expect(db.prepare("SELECT status FROM portal_v2_workspaces WHERE id='workspace-1'").get())
      .toEqual({ status: "active" });
    db.close();
  });
});
