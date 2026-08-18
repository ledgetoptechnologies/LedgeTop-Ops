import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import grantMigration from "../migrations/0144_viewer_client_grants.sql?raw";
import auditMigration from "../migrations/0146_viewer_client_grant_audit.sql?raw";

describe("viewer client-grant authoritative audit migration", () => {
  it("applies fresh and replays without weakening the colocated audit contract", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE client_accounts(id TEXT PRIMARY KEY);
      CREATE TABLE projects(id TEXT PRIMARY KEY);
      CREATE TABLE viewer_model_associations(id TEXT PRIMARY KEY);`);
    db.exec(grantMigration);
    db.exec(auditMigration);
    db.exec(auditMigration);
    db.prepare("INSERT INTO client_accounts VALUES(?)").run("account-one");
    db.prepare("INSERT INTO projects VALUES(?)").run("project-one");
    db.prepare(`INSERT INTO viewer_client_grants(id,account_id,project_id,scope_type,association_id,created_by_staff_id)
      VALUES(?,?,?,'project',NULL,?)`).run("grant-one", "account-one", "project-one", "staff-one");
    db.prepare(`INSERT INTO viewer_client_grant_audit(id,grant_id,action,actor_staff_id,idempotency_key,details_json)
      VALUES(?,?,'grant.created',?,?,?)`).run("audit-one", "grant-one", "staff-one", "request-one", "{}");
    expect(() => db.prepare(`INSERT INTO viewer_client_grant_audit(id,grant_id,action,actor_staff_id,idempotency_key,details_json)
      VALUES(?,?,'grant.created',?,?,?)`).run("audit-two", "grant-one", "staff-one", "request-one", "{}"))
      .toThrow();
    expect(db.prepare("SELECT COUNT(*) count FROM viewer_client_grant_audit").get()).toEqual({ count: 1 });
    db.close();
  });
});
