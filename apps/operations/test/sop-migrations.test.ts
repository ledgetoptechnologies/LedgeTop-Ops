import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

function applyOperationsMigrations(database: DatabaseSync): string[] {
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  const migrations = readdirSync(directory)
    .filter(name => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    const sql = readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8")
      .replace(/\r\n/g, "\n");
    database.exec(sql);
  }
  return migrations;
}

function insertOperation(database: DatabaseSync, id: string): void {
  database.prepare(
    `INSERT INTO pa_operations
      (id,project_id,title,status,payload_json,last_sync_id,active)
     VALUES (?,?,'Mapping flight','scheduled','{}','test-sync',1)`,
  ).run(id, `project-${id}`);
  database.prepare(
    `INSERT INTO operational_job_briefs
      (operation_id,version,snapshot_json,created_by,updated_by)
     VALUES (?,1,'{"schemaVersion":1,"items":[],"attachments":[]}',?,?)`,
  ).run(id, "staff-beau-koltz", "staff-beau-koltz");
}

function insertDocument(database: DatabaseSync, id: string, slug: string): void {
  database.prepare(
    `INSERT INTO sop_documents
      (id,slug,status,version,created_by,updated_by)
     VALUES (?,?,'draft',1,?,?)`,
  ).run(id, slug, "staff-beau-koltz", "staff-beau-koltz");
}

function insertRevision(
  database: DatabaseSync,
  id: string,
  sopId: string,
  revisionNumber: number,
): void {
  database.prepare(
    `INSERT INTO sop_revisions
      (id,sop_id,revision_number,change_kind,title,purpose,markdown_body,
       rendered_html,toc_json,sanitizer_version,author_id,author_email,author_display_name)
     VALUES (?,?,?,'created','General flight','Safe flight execution','# General flight',
       '<h1 id="sop-heading-general-flight">General flight</h1>','[]',1,?,?,?)`,
  ).run(
    id,
    sopId,
    revisionNumber,
    "staff-beau-koltz",
    "beaukoltz@ledgetopdroneservices.com",
    "Beau Koltz",
  );
}

describe("internal SOP migration sequence", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("applies every Operations migration cleanly with valid foreign keys and integrity", () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    const migrations = applyOperationsMigrations(database);

    const sopMigration = migrations.indexOf("0020_internal_sop_library.sql");
    const uploadConflictMigration = migrations.indexOf("0019_browser_upload_conflict_resolution.sql");
    expect(sopMigration).toBeGreaterThan(uploadConflictMigration);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);

    const tables = database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name IN
         ('sop_documents','sop_revisions','operational_job_brief_sop_links',
          'work_context_sop_link_sets','work_context_sop_links')
       ORDER BY name`,
    ).all();
    expect(tables).toEqual([
      { name: "operational_job_brief_sop_links" },
      { name: "sop_documents" },
      { name: "sop_revisions" },
      { name: "work_context_sop_link_sets" },
      { name: "work_context_sop_links" },
    ]);

    const grants = database.prepare(
      `SELECT role_id,permission_key FROM role_permissions
       WHERE permission_key LIKE 'sops.%' ORDER BY permission_key,role_id`,
    ).all();
    expect(grants).toEqual([
      { role_id: "role-admin", permission_key: "sops.assign" },
      { role_id: "role-owner", permission_key: "sops.assign" },
      { role_id: "role-admin", permission_key: "sops.manage" },
      { role_id: "role-owner", permission_key: "sops.manage" },
      { role_id: "role-admin", permission_key: "sops.view" },
      { role_id: "role-delivery-coordinator", permission_key: "sops.view" },
      { role_id: "role-division-manager", permission_key: "sops.view" },
      { role_id: "role-operator", permission_key: "sops.view" },
      { role_id: "role-owner", permission_key: "sops.view" },
    ]);

    expect(database.prepare(
      `SELECT role_id,permission_key FROM role_permissions
       WHERE permission_key='administration.view' AND role_id IN ('role-owner','role-admin')
       ORDER BY role_id`,
    ).all()).toEqual([
      { role_id: "role-admin", permission_key: "administration.view" },
      { role_id: "role-owner", permission_key: "administration.view" },
    ]);
  });

  it("keeps revisions and slugs immutable and enforces document-owned pointers", () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    applyOperationsMigrations(database);

    insertDocument(database, "sop-1", "general-flight");
    insertRevision(database, "revision-1", "sop-1", 1);
    database.prepare(
      "UPDATE sop_documents SET draft_revision_id=? WHERE id=?",
    ).run("revision-1", "sop-1");

    expect(() => database!.prepare(
      "UPDATE sop_revisions SET title='Changed in place' WHERE id='revision-1'",
    ).run()).toThrow(/SOP revisions are immutable/);
    expect(() => database!.prepare(
      "DELETE FROM sop_revisions WHERE id='revision-1'",
    ).run()).toThrow(/SOP revisions are immutable/);
    expect(() => database!.prepare(
      "UPDATE sop_documents SET slug='changed' WHERE id='sop-1'",
    ).run()).toThrow(/SOP slugs are immutable/);
    expect(() => database!.prepare(
      "DELETE FROM sop_documents WHERE id='sop-1'",
    ).run()).toThrow(/SOP documents must be archived/);

    insertDocument(database, "sop-2", "mapping-flight");
    insertRevision(database, "revision-2", "sop-2", 1);
    expect(() => database!.prepare(
      "UPDATE sop_documents SET draft_revision_id='revision-1' WHERE id='sop-2'",
    ).run()).toThrow(/draft revision does not belong/);
    expect(() => insertRevision(database!, "revision-2-duplicate", "sop-2", 1))
      .toThrow(/UNIQUE constraint failed/);

    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
  });

  it("links only the current published revision and preserves links after archival", () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    applyOperationsMigrations(database);
    insertOperation(database, "operation-1");
    insertOperation(database, "operation-2");
    insertDocument(database, "sop-1", "general-flight");
    insertRevision(database, "revision-1", "sop-1", 1);
    database.prepare(
      "UPDATE sop_documents SET draft_revision_id='revision-1' WHERE id='sop-1'",
    ).run();

    const link = (operationId: string) => database!.prepare(
      `INSERT INTO operational_job_brief_sop_links
        (operation_id,sop_id,revision_id,linked_by)
       VALUES (?,'sop-1','revision-1','staff-beau-koltz')`,
    ).run(operationId);

    expect(() => link("operation-1")).toThrow(/current published SOP revision/);
    database.prepare(
      `UPDATE sop_documents
       SET status='published',published_revision_id='revision-1',published_at=datetime('now')
       WHERE id='sop-1'`,
    ).run();
    expect(link("operation-1").changes).toBe(1);

    database.prepare(
      "UPDATE sop_documents SET status='archived',archived_at=datetime('now') WHERE id='sop-1'",
    ).run();
    expect(() => link("operation-2")).toThrow(/current published SOP revision/);
    expect(database.prepare(
      `SELECT operation_id,sop_id,revision_id
       FROM operational_job_brief_sop_links WHERE operation_id='operation-1'`,
    ).get()).toEqual({
      operation_id: "operation-1",
      sop_id: "sop-1",
      revision_id: "revision-1",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
  });

  it("keeps Project and Task links direct, immutable, and pinned after archival", () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys=ON");
    applyOperationsMigrations(database);
    database.prepare(
      `INSERT INTO pa_projects
        (id,name,status,active,payload_json,last_sync_id)
       VALUES ('project-1','North site','active',1,'{}','test-sync')`,
    ).run();
    database.prepare(
      `INSERT INTO pa_tasks
        (id,project_id,title,status,payload_json,last_sync_id,active)
       VALUES ('task-1','project-1','Capture LiDAR','todo','{}','test-sync',1)`,
    ).run();
    for (const [kind, id] of [["project", "project-1"], ["task", "task-1"]] as const) {
      database.prepare(
        `INSERT INTO work_context_sop_link_sets
          (context_kind,context_id,version,mutation_id,updated_by)
         VALUES (?,?,1,?,?)`,
      ).run(kind, id, `mutation-${kind}`, "staff-beau-koltz");
    }
    insertDocument(database, "sop-context", "lidar-capture");
    insertRevision(database, "revision-context", "sop-context", 1);
    database.prepare(
      "UPDATE sop_documents SET draft_revision_id='revision-context' WHERE id='sop-context'",
    ).run();
    const link = (kind: "project" | "task", id: string) => database!.prepare(
      `INSERT INTO work_context_sop_links
        (context_kind,context_id,sop_id,revision_id,linked_by)
       VALUES (?,?,'sop-context','revision-context','staff-beau-koltz')`,
    ).run(kind, id);

    expect(() => link("project", "project-1")).toThrow(/current published SOP revision/);
    database.prepare(
      `UPDATE sop_documents SET status='published',published_revision_id='revision-context',
        published_at=datetime('now') WHERE id='sop-context'`,
    ).run();
    expect(link("project", "project-1").changes).toBe(1);
    expect(database.prepare(
      "SELECT COUNT(*) count FROM work_context_sop_links WHERE context_kind='task' AND context_id='task-1'",
    ).get()).toEqual({ count: 0 });
    expect(() => database!.prepare(
      "UPDATE work_context_sop_links SET context_kind='task' WHERE context_kind='project' AND context_id='project-1'",
    ).run()).toThrow(/immutable/);

    database.prepare(
      "UPDATE sop_documents SET status='archived',archived_at=datetime('now') WHERE id='sop-context'",
    ).run();
    expect(() => link("task", "task-1")).toThrow(/current published SOP revision/);
    expect(database.prepare(
      `SELECT context_kind,context_id,sop_id,revision_id FROM work_context_sop_links
       WHERE context_kind='project' AND context_id='project-1'`,
    ).get()).toEqual({
      context_kind: "project",
      context_id: "project-1",
      sop_id: "sop-context",
      revision_id: "revision-context",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
  });
});
