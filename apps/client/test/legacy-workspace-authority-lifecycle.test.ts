import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { primaryWorkspaceAccount, primaryLegacyWorkspaceMembership } from "../src/worker/client-portal/project-alpha-source";

const migrations = new URL("../migrations/", import.meta.url);
const opened: DatabaseSync[] = [];
afterEach(() => opened.splice(0).forEach(db => db.close()));
function fixture(beforeLifecycle = false) {
  const db = new DatabaseSync(":memory:"); opened.push(db);
  for (const file of readdirSync(migrations).filter(f => f.endsWith(".sql")).sort()) {
    if (beforeLifecycle && file.startsWith("0195")) continue;
    if (file.startsWith("0121")) db.exec(`
      INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id,project_alpha_organization_id)
        VALUES('account','Client','active','client-a','org-a');
      INSERT INTO client_identity_links(id,account_id,issuer,subject) VALUES('person','account','issuer','subject');
      INSERT INTO client_account_members(account_id,identity_id,role) VALUES('account','person','manager');
    `);
    db.exec("BEGIN"); db.exec(readFileSync(new URL(file, migrations), "utf8")); db.exec("COMMIT");
  }
  return db;
}
function status(db: DatabaseSync, table: string) { return db.prepare(`SELECT status FROM ${table}`).get()?.status; }

it("atomically invalidates a primary legacy bootstrap when its source client moves organizations", () => {
  const db = fixture();
  expect(status(db, "portal_v2_workspaces")).toBe("active");
  // 0158 reserves legacy workspaces too: existence is not signed/native proof.
  expect(db.prepare("SELECT count(*) n FROM pa_portal_workspace_sources").get()?.n).toBe(1);
  db.exec("UPDATE client_accounts SET project_alpha_organization_id='org-b' WHERE id='account'");
  expect(status(db, "portal_v2_workspaces")).toBe("suspended");
  expect(status(db, "portal_v2_workspace_memberships")).toBe("revoked");
  expect(status(db, "portal_v2_entitlements")).toBe("revoked");
  expect(db.prepare("SELECT max(active) n FROM portal_v2_directory_entities").get()?.n).toBe(0);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it.each(["UPDATE client_account_members SET revoked_at=datetime('now')", "UPDATE client_account_members SET role='member'", "UPDATE client_identity_links SET revoked_at=datetime('now')", "DELETE FROM client_account_members"])("invalidates only legacy membership after %s", statement => {
  const db = fixture(); db.exec(statement);
  expect(status(db, "portal_v2_workspace_memberships")).toBe("revoked");
  expect(status(db, "portal_v2_entitlements")).toBe("revoked");
  expect(status(db, "portal_v2_identities")).toBe("active");
  expect(status(db, "portal_v2_workspaces")).toBe("active");
});

it("preserves a signed successor generation and harmless account edits", () => {
  const db = fixture();
  db.exec("UPDATE client_accounts SET display_name='Renamed'");
  expect(status(db,"portal_v2_workspaces")).toBe("active");
  db.exec(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
    VALUES('signed','workspace-account','signed',1,'active',1);
    UPDATE portal_v2_directory_checkpoints SET active_generation_id='signed',source_sequence=1;
    UPDATE portal_v2_workspace_memberships SET source_type='project_alpha';
    UPDATE portal_v2_entitlements SET source_type='project_alpha';
    UPDATE client_accounts SET project_alpha_organization_id='org-b';
    UPDATE client_account_members SET role='member';
    UPDATE client_account_members SET revoked_at=datetime('now');`);
  expect(status(db,"portal_v2_workspaces")).toBe("active");
  expect(status(db,"portal_v2_workspace_memberships")).toBe("active");
});

it("repairs populated stale bootstrap authority when the lifecycle migration is applied", () => {
  const db = fixture(true);
  db.exec("UPDATE client_accounts SET project_alpha_organization_id='org-b'");
  // Concrete pre-fix reproduction: old projected authorization remains live.
  expect(status(db,"portal_v2_workspaces")).toBe("active");
  expect(status(db,"portal_v2_entitlements")).toBe("active");
  expect(db.prepare(`SELECT w.id FROM portal_v2_workspaces w WHERE ${primaryWorkspaceAccount("w")}`).all()).toEqual([]);
  db.exec(readFileSync(new URL("0195_legacy_workspace_authority_lifecycle.sql", migrations),"utf8"));
  expect(status(db,"portal_v2_workspaces")).toBe("suspended");
  expect(status(db,"portal_v2_entitlements")).toBe("revoked");
});

it("read defense denies revoked legacy members before migration and preserves active members", () => {
  const db = fixture(true);
  const query = `SELECT m.id FROM portal_v2_workspace_memberships m JOIN portal_v2_workspaces w ON w.id=m.workspace_id
    WHERE ${primaryWorkspaceAccount("w")} AND ${primaryLegacyWorkspaceMembership("w","m")}`;
  expect(db.prepare(query).all()).toHaveLength(1);
  db.exec("UPDATE client_account_members SET revoked_at=datetime('now')");
  expect(status(db,"portal_v2_workspace_memberships")).toBe("active");
  expect(db.prepare(query).all()).toEqual([]);
});

it.each(["project_alpha_organization_id=NULL", "project_alpha_client_id='client-b'", "status='suspended'"])("invalidates changed source authority: %s", update => {
  const db=fixture(); db.exec(`UPDATE client_accounts SET ${update}`);
  expect(status(db,"portal_v2_workspaces")).toBe("suspended");
});

it("preserves public share tokens and projects through authority invalidation", () => {
  const db=fixture();
  db.exec(`INSERT INTO projects(id,client_name,project_name,r2_prefix) VALUES('project','Client','Delivery','Jobs/Client/');
    INSERT INTO shares(id,project_id,token_hash,created_by_type,created_by_id)
    VALUES('public-share','project','existing-public-token-hash','integration','test');`);
  const before=db.prepare("SELECT * FROM shares").all();
  db.exec("UPDATE client_accounts SET project_alpha_organization_id='org-b'");
  expect(db.prepare("SELECT * FROM shares").all()).toEqual(before);
  expect(db.prepare("SELECT r2_prefix FROM projects").get()?.r2_prefix).toBe("Jobs/Client/");
});

it("rolls back source mutation if atomic bootstrap invalidation cannot complete", () => {
  const db=fixture();
  db.exec(`CREATE TRIGGER fail_test_invalidation BEFORE UPDATE ON portal_v2_entitlements
    BEGIN SELECT RAISE(ABORT,'test-failure'); END;`);
  expect(()=>db.exec("UPDATE client_accounts SET project_alpha_organization_id='org-b'")).toThrow("test-failure");
  expect(db.prepare("SELECT project_alpha_organization_id root FROM client_accounts").get()?.root).toBe("org-a");
  expect(status(db,"portal_v2_workspaces")).toBe("active");
});
