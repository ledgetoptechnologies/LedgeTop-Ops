import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCatalogSourceContext } from "@ltds/shared";
import migration from "../migrations/0158_portal_source_ownership.sql?raw";
import { PRIMARY_PORTAL_PROJECTION_SOURCE, resolvePortalWorkspaceSource } from "../src/worker/project-alpha-portal-source";

// Execute the actual reservation SQL against SQLite. Full migration and D1
// transaction behavior are covered separately; no fake query-result selection.
function databaseAdapter(sqlite: DatabaseSync): D1Database {
  const adapter = {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      const statement = {
        bind(...input: SQLInputValue[]) { values = input; return statement; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async run() { return sqlite.prepare(sql).run(...values); },
      };
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map(statement => statement.run()));
    },
  };
  return adapter as unknown as D1Database;
}

describe("portal workspace source reservations", () => {
  let sqlite: DatabaseSync;
  let db: D1Database;
  const secondary = createCatalogSourceContext("project-alpha:secondary");

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY)");
    for (const table of ["pa_portal_projection_generations", "pa_portal_projection_receipts", "pa_portal_projection_audit",
      "pa_portal_projection_checkpoints", "portal_v2_directory_generations", "portal_v2_directory_checkpoints"])
      sqlite.exec(`CREATE TABLE ${table}(workspace_id TEXT NOT NULL)`);
    sqlite.exec("INSERT INTO portal_v2_workspaces VALUES('existing-primary')");
    sqlite.exec("INSERT INTO pa_portal_projection_generations VALUES('pending-primary')");
    sqlite.exec(migration.split("ALTER TABLE portal_v2_workspaces")[0]!);
    db = databaseAdapter(sqlite);
  });
  afterEach(() => sqlite.close());

  it("preserves active and staging-only primary handles without creating a workspace", async () => {
    for (const id of ["existing-primary", "pending-primary"])
      expect(await resolvePortalWorkspaceSource(db, PRIMARY_PORTAL_PROJECTION_SOURCE, id, false))
        .toEqual({ sourceId: "project-alpha:primary", sourceWorkspaceId: id, workspaceId: id });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM portal_v2_workspaces").get()?.count).toBe(1);
  });

  it("separates identical external IDs and reuses only the exact source mapping", async () => {
    const primary = await resolvePortalWorkspaceSource(db, PRIMARY_PORTAL_PROJECTION_SOURCE, "shared-workspace", true);
    const other = await resolvePortalWorkspaceSource(db, secondary, "shared-workspace", true);
    expect(primary.workspaceId).toBe("shared-workspace");
    expect(other.workspaceId).not.toBe(primary.workspaceId);
    expect(other.sourceWorkspaceId).toBe(primary.sourceWorkspaceId);
    expect(await resolvePortalWorkspaceSource(db, secondary, "shared-workspace", false)).toEqual(other);
    expect(await resolvePortalWorkspaceSource(db, PRIMARY_PORTAL_PROJECTION_SOURCE, "shared-workspace", false)).toEqual(primary);
  });

  it("does not reserve a new mapping for an activation or event", async () => {
    await expect(resolvePortalWorkspaceSource(db, secondary, "not-staged", false)).rejects.toThrow(/missing/);
    expect(sqlite.prepare("SELECT COUNT(*) count FROM pa_portal_workspace_sources WHERE source_workspace_id='not-staged'").get()?.count).toBe(0);
  });

  it("collapses simultaneous secondary reservations instead of rejecting the losing insert", async () => {
    // Both async first() calls read missing before either continuation inserts.
    // The immutable SQL trigger rejects the losing proposed local UUID before
    // ON CONFLICT can run; the resolver must reread the exact winning mapping.
    const [one, two] = await Promise.all([
      resolvePortalWorkspaceSource(db, secondary, "simultaneous", true),
      resolvePortalWorkspaceSource(db, secondary, "simultaneous", true),
    ]);
    expect(one).toEqual(two);
    expect(sqlite.prepare("SELECT COUNT(*) count FROM pa_portal_workspace_sources WHERE source_workspace_id='simultaneous'").get()?.count).toBe(1);
  });

  it("does not steal a reserved local handle through primary compatibility", async () => {
    sqlite.prepare("INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)").run("reserved-primary-id", secondary.sourceId, "secondary-external");
    await expect(resolvePortalWorkspaceSource(db, PRIMARY_PORTAL_PROJECTION_SOURCE, "reserved-primary-id", true)).rejects.toThrow();
    expect(sqlite.prepare("SELECT projection_source_id,source_workspace_id FROM pa_portal_workspace_sources WHERE workspace_id='reserved-primary-id'").get())
      .toEqual({ projection_source_id: secondary.sourceId, source_workspace_id: "secondary-external" });
  });

  it("rejects malformed provenance and workspace IDs without a reservation", async () => {
    for (const sourceId of ["", "secondary", "project-alpha:Secondary", "project-alpha:secondary\u0000"])
      await expect(resolvePortalWorkspaceSource(db, { sourceId }, "not-created", true)).rejects.toThrow();
    for (const id of ["", "123", "with spaces", "path/to/workspace", "workspace\u0000", "workspace\n", "workspace\r\n"])
      await expect(resolvePortalWorkspaceSource(db, secondary, id, true)).rejects.toThrow();
    expect(sqlite.prepare("SELECT COUNT(*) count FROM pa_portal_workspace_sources").get()?.count).toBe(2);
  });

  it("rejects trailing source line breaks before any database lookup", async () => {
    const unreadable = { prepare() { throw new Error("Unexpected database lookup"); } } as unknown as D1Database;
    for (const sourceId of ["project-alpha:secondary\n", "project-alpha:secondary\r\n"])
      await expect(resolvePortalWorkspaceSource(unreadable, { sourceId }, "not-created", false))
        .rejects.toThrow("catalog-source-invalid");
  });
});
