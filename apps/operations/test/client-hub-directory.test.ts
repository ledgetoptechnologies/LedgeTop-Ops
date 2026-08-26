import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientHubDetailPath, findClientHubRoot, listClientHubRoots, normalizeClientHubText,
  type ClientHubKind, type ClientHubSource } from "../src/worker/client-hub-directory";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";

const staff: StaffPrincipal = { id: "staff-a", email: "a@example.test", displayName: "A", accessSubject: "subject-a", projectAlphaUserId: "pa-user-a" };
const migration = readFileSync(new URL("../migrations/0032_client_hub_directory.sql", import.meta.url), "utf8");
const sql = (value: string) => value.replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " ");

describe("source-qualified Client Hub directory", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default { fetch(){return new Response('ok')} }", d1Databases: { OPS_DB: "hub-directory" } });
    db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    env = { OPS_DB: db } as Env;
    await db.exec(sql(`
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
      INSERT INTO role_permissions VALUES('directory','team.view'),('projects','projects.view');
      CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,active INTEGER,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_clients(id TEXT PRIMARY KEY,active INTEGER,organization_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_projects(id TEXT PRIMARY KEY,active INTEGER,manager_user_id TEXT,client_id TEXT,organization_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}',projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_project_assignments(project_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_operations(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_operation_assignments(operation_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_tasks(id TEXT,project_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_task_assignments(task_id TEXT,user_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
    `));
    await db.exec(sql(migration));
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0034_client_hub_projection_sources.sql", import.meta.url), "utf8")).map(statement => db.prepare(statement)));
    await applyConnectorSchema(db);
  });
  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM client_hub_search_values"), db.prepare("DELETE FROM client_hub_roots"),
      db.prepare("DELETE FROM staff_role_assignments"), db.prepare("DELETE FROM staff_permission_overrides"),
      db.prepare("DELETE FROM pa_projects"), db.prepare("DELETE FROM pa_project_assignments"),
      db.prepare("DELETE FROM pa_clients"), db.prepare("DELETE FROM pa_organizations"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','directory','global',NULL)"),
      db.prepare("UPDATE client_hub_directory_state SET ready=1,last_success_at=NULL WHERE id='directory'"),
      db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id<>'project-alpha:primary'"),
    ]);
  });
  afterAll(async () => runtime.dispose());

  async function roots(rows: Array<{ id: string; name?: string; kind?: ClientHubKind; source?: ClientHubSource; status?: string }>) {
    const statements = rows.flatMap(row => [db.prepare(`INSERT INTO client_hub_roots
      (source_id,root_namespace,kind,public_id,display_name,sort_name,status) VALUES(?,?,?,?,?,?,?)`)
      .bind(row.source ?? "project-alpha:primary", row.source === "delivery:local" ? "account" : "business", row.kind ?? "standalone_client", row.id,
        row.name ?? row.id, normalizeClientHubText(row.name ?? row.id), row.status ?? "active"),
      ...(row.source === "delivery:local" ? [] : [db.prepare(row.kind === "organization"
        ? "INSERT OR IGNORE INTO pa_organizations(id,active,projection_source_id) VALUES(?,1,?)"
        : "INSERT OR IGNORE INTO pa_clients(id,active,organization_id,projection_source_id) VALUES(?,1,NULL,?)").bind(row.id, row.source ?? "project-alpha:primary")]),
    ]);
    for (let start = 0; start < statements.length; start += 50) await db.batch(statements.slice(start, start + 50));
  }

  it("labels secondary business roots and keeps exact source ownership during search and lookup", async () => {
    await registerVisibleTestSource(db, "project-alpha:secondary", "Second company");
    await roots([{ id: "primary-org", kind: "organization", name: "Same name" },
      { id: "secondary-org", kind: "organization", name: "Same name", source: "project-alpha:secondary" }]);
    const publicId = "b".repeat(32);
    await db.prepare("UPDATE pa_organizations SET payload_json=?").bind(JSON.stringify({ public_id: publicId })).run();
    const page = await listClientHubRoots(env, staff, { q: "Same name" });
    expect(page.clients).toHaveLength(2);
    expect(page.clients.find(row => row.source_id === "project-alpha:secondary")).toMatchObject({
      public_id: "secondary-org", pa_public_id: publicId, source_name: "Second company",
      workspace_id: null, account_count: 0,
      detail_path: "/clients/sources/project-alpha%3Asecondary/business/organizations/secondary-org",
    });
    await expect(findClientHubRoot(env, "organization", "secondary-org", "project-alpha:primary", "business"))
      .rejects.toMatchObject({ status: 404 });
    await db.prepare("INSERT INTO pa_clients(id,active,organization_id,projection_source_id) VALUES('secondary-contact',1,'secondary-org','project-alpha:secondary')").run();
    for (const [source, root] of [["project-alpha:primary", "primary-org"], ["project-alpha:secondary", "secondary-org"]]) {
      await db.prepare(`INSERT INTO client_hub_search_values(source_id,root_namespace,kind,root_public_id,record_type,record_id,field,normalized_value)
        VALUES(?,'business','organization',?,'pa_client','secondary-contact','contact','secondary-only@example.test')`).bind(source, root).run();
    }
    expect((await listClientHubRoots(env, staff, { q: "secondary-only@example.test" })).clients.map(row => row.source_id))
      .toEqual(["project-alpha:secondary"]);
  });
  it("hides unregistered and hidden sources before limits, search, and exact lookup", async () => {
    await roots([{ id: "hidden", name: "A hidden", source: "project-alpha:unregistered" }, { id: "primary", name: "Z primary" }]);
    expect((await listClientHubRoots(env, staff, { limit: 1 })).clients.map(row => row.public_id)).toEqual(["primary"]);
    expect((await listClientHubRoots(env, staff, { q: "hidden" })).clients).toEqual([]);
    await expect(findClientHubRoot(env, "standalone_client", "hidden", "project-alpha:unregistered", "business")).rejects.toMatchObject({ status: 404 });
    await expect(listClientHubRoots(env, staff, { source: "project-alpha:unregistered" })).rejects.toMatchObject({ status: 404 });
    await registerVisibleTestSource(db, "project-alpha:unregistered", "Business B");
    const visible = await listClientHubRoots(env, staff, { source: "project-alpha:unregistered", limit: 1 });
    expect(visible.clients.map(row => row.public_id)).toEqual(["hidden"]);
    expect(visible.sources).toContainEqual({ source_id: "project-alpha:unregistered", display_name: "Business B" });
    await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:unregistered'").run();
    expect((await listClientHubRoots(env, staff)).sources.some(row => row.source_id === "project-alpha:unregistered")).toBe(false);
    await expect(findClientHubRoot(env, "standalone_client", "hidden", "project-alpha:unregistered", "business")).rejects.toMatchObject({ status: 404 });
  });

  it("binds cursors to source selection and registry revision while suspension retains visible projected data", async () => {
    await registerVisibleTestSource(db, "project-alpha:secondary", "Business B");
    await roots([{ id: "a", source: "project-alpha:secondary" }, { id: "b", source: "project-alpha:secondary" }, { id: "primary" }]);
    const selection = { source: "project-alpha:secondary", limit: 1 };
    const first = await listClientHubRoots(env, staff, selection);
    await expect(listClientHubRoots(env, staff, { limit: 1, cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
    expect((await listClientHubRoots(env, staff, { ...selection, cursor: first.nextCursor! })).clients[0]?.public_id).toBe("b");
    await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id='project-alpha:secondary'").run();
    const stale = await listClientHubRoots(env, staff, { ...selection, cursor: first.nextCursor! }).catch(error => error);
    expect(stale.status).toBe(409);
    expect(await stale.getResponse().json()).toMatchObject({ code: "source_visibility_changed" });
    const refreshed = await listClientHubRoots(env, staff, selection);
    expect(refreshed.clients[0]?.public_id).toBe("a");
    await db.prepare("UPDATE pa_connectors SET display_name='Renamed business',version=version+1 WHERE source_id='project-alpha:secondary'").run();
    await expect(listClientHubRoots(env, staff, { ...selection, cursor: refreshed.nextCursor! })).rejects.toMatchObject({ status: 409 });
    expect((await listClientHubRoots(env, staff, selection)).clients[0]?.source_name).toBe("Renamed business");
  });
  async function field(root: string, type: string, value: string, projectId: string | null = null) {
    await db.prepare("INSERT OR IGNORE INTO pa_clients(id,active,organization_id) VALUES(?,1,NULL)").bind(root).run();
    await db.prepare(`INSERT INTO client_hub_search_values
      (source_id,kind,root_public_id,record_type,record_id,field,normalized_value,project_id)
      VALUES('project-alpha:primary','standalone_client',?,?,?,?,?,?)`)
      .bind(root, projectId === null ? "pa_client" : "pa_project", projectId ?? root,
        type, normalizeClientHubText(value), projectId).run();
  }

  it("progressively reads more than 500 roots and resolves an unloaded exact root without DELIVERY_DB", async () => {
    await db.exec(sql(`WITH RECURSIVE ids(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM ids WHERE n<536)
      INSERT INTO client_hub_roots(source_id,kind,public_id,display_name,sort_name,status)
      SELECT 'project-alpha:primary','standalone_client',printf('%04d',n),printf('Client %04d',n),printf('client %04d',n),'active' FROM ids;`));
    await db.prepare("INSERT INTO pa_clients(id,active,organization_id) SELECT public_id,1,NULL FROM client_hub_roots").run();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listClientHubRoots(env, staff, { limit: 100, cursor });
      seen.push(...page.clients.map(client => client.public_id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(537);
    expect(new Set(seen).size).toBe(537);
    expect(await findClientHubRoot(env, "standalone_client", "0536", "project-alpha:primary"))
      .toMatchObject({ public_id: "0536" });
    expect((await listClientHubRoots(env, staff, { q: "0536", limit: 24 })).clients.map(client => client.public_id)).toEqual(["0536"]);
  }, 30_000);

  it("searches all stored contact/email/phone values, not only loaded summaries", async () => {
    await roots([{ id: "a" }, { id: "z" }]);
    await field("z", "contact", "Jane O'Neil");
    await field("z", "email", "Jane@EXAMPLE.test");
    await field("z", "phone", "19205551234");
    expect((await listClientHubRoots(env, staff, { limit: 1 })).clients.map(client => client.public_id)).toEqual(["a"]);
    for (const q of ["o'NEIL", "jane@example", "(920) 555-1234"])
      expect((await listClientHubRoots(env, staff, { q })).clients.map(client => client.public_id), q).toEqual(["z"]);
  });

  it("matches case-insensitively with literal percent/underscore/escape and normalized Unicode", async () => {
    await roots([{ id: "exact", name: "CAFÉ 100%_Done\\Files" }, { id: "neighbor", name: "Cafe 100ABDone Files" }]);
    for (const q of ["cafe\u0301", "100%_done", "\\files"])
      expect((await listClientHubRoots(env, staff, { q })).clients.map(client => client.public_id)).toEqual(["exact"]);
  });

  it("supports long literal Unicode search beyond D1's 50-byte LIKE limit", async () => {
    const name = `${"界".repeat(80)}%_tail`;
    const contact = `${"É".repeat(90)}%_contact`;
    await roots([{ id: "a", name }, { id: "z", name: "Unloaded contact" }]);
    await field("z", "contact", contact);
    expect(new TextEncoder().encode(name).length).toBeGreaterThan(200);
    expect((await listClientHubRoots(env, staff, { q: name })).clients.map(client => client.public_id)).toEqual(["a"]);
    expect((await listClientHubRoots(env, staff, { q: contact.toLowerCase() })).clients.map(client => client.public_id)).toEqual(["z"]);
    expect((await listClientHubRoots(env, staff, { q: "%_" })).clients.map(client => client.public_id).sort()).toEqual(["a", "z"]);
  });

  it("does not use a stale moved/deactivated business contact as a search match", async () => {
    await roots([{ id: "old-org", kind: "organization" }, { id: "new-org", kind: "organization" }]);
    await db.exec("INSERT INTO pa_clients(id,active,organization_id) VALUES('contact-a',1,'old-org');");
    await db.prepare(`INSERT INTO client_hub_search_values
      (source_id,kind,root_public_id,record_type,record_id,field,normalized_value)
      VALUES('project-alpha:primary','organization','old-org','pa_client','contact-a','email','private@example.test')`).run();
    expect((await listClientHubRoots(env, staff, { q: "private@example" })).clients.map(client => client.public_id)).toEqual(["old-org"]);
    await db.prepare("UPDATE pa_clients SET organization_id='new-org' WHERE id='contact-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "private@example" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_clients SET organization_id='old-org',active=0 WHERE id='contact-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "private@example" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_clients SET active=1 WHERE id='contact-a'").run();
    await db.prepare("UPDATE pa_organizations SET active=0 WHERE id='old-org'").run();
    expect((await listClientHubRoots(env, staff, { q: "private@example" })).clients).toEqual([]);
  });

  it("does not expose a stale standalone root after client reassignment or deactivation", async () => {
    await roots([{ id: "old-client", name: "Sensitive name" }]);
    expect((await listClientHubRoots(env, staff, { q: "Sensitive" })).clients).toHaveLength(1);
    await db.prepare("UPDATE pa_clients SET organization_id='new-org'").run();
    expect((await listClientHubRoots(env, staff, { q: "Sensitive" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_clients SET organization_id=NULL,active=0").run();
    expect((await listClientHubRoots(env, staff, { q: "Sensitive" })).clients).toEqual([]);
  });

  it("does not guess a portal principal's business-root mapping to produce a search match", async () => {
    await roots([{ id: "business-id", name: "Business root" }]);
    await db.prepare(`INSERT INTO client_hub_search_values
      (source_id,kind,root_public_id,record_type,record_id,field,normalized_value)
      VALUES('project-alpha:primary','standalone_client','business-id','portal_principal','public-principal-id','email','unproven@example.test')`).run();
    expect((await listClientHubRoots(env, staff, { q: "unproven@example" })).clients).toEqual([]);
  });

  it("applies organization/individual filters before keyset limits and hides closed/inactive roots", async () => {
    await roots([{ id: "a", kind: "organization" }, { id: "b" }, { id: "c", kind: "organization" }, { id: "d", status: "closed" }, { id: "e", status: "inactive" }]);
    const first = await listClientHubRoots(env, staff, { kind: "organization", limit: 1 });
    expect(first.clients.map(client => client.public_id)).toEqual(["a"]);
    expect((await listClientHubRoots(env, staff, { kind: "organization", limit: 1, cursor: first.nextCursor! })).clients.map(client => client.public_id)).toEqual(["c"]);
    expect((await listClientHubRoots(env, staff, { kind: "standalone_client" })).clients.map(client => client.public_id)).toEqual(["b"]);
  });

  it("never infers a source from a colliding raw ID; old URLs fail ambiguous and exact-source routes stay separate", async () => {
    await roots([{ id: "42", name: "Alpha" }, { id: "42", name: "Local", source: "delivery:local" }]);
    await expect(findClientHubRoot(env, "standalone_client", "42")).rejects.toMatchObject({ status: 409 });
    const local = await findClientHubRoot(env, "standalone_client", "42", "delivery:local");
    expect(local.display_name).toBe("Local");
    expect(clientHubDetailPath(local)).toBe("/clients/sources/delivery%3Alocal/account/standalone/42");
    expect((await findClientHubRoot(env, "standalone_client", "42", "project-alpha:primary")).display_name).toBe("Alpha");
    await expect(findClientHubRoot(env, "standalone_client", "42", "project-alpha:second")).rejects.toMatchObject({ status: 404 });
    await expect(db.prepare("UPDATE client_hub_roots SET source_id='project-alpha:second' WHERE source_id='delivery:local'").run()).rejects.toThrow();
  });

  it("separates same-source business and portal keys in lookup and keyset pagination", async () => {
    await roots([{ id: "42", name: "Same name" }]);
    await db.prepare(`INSERT INTO client_hub_roots(source_id,root_namespace,kind,public_id,display_name,sort_name,status)
      VALUES('project-alpha:primary','portal','standalone_client','42','Same name','same name','active')`).run();
    await expect(findClientHubRoot(env, "standalone_client", "42", "project-alpha:primary")).rejects.toMatchObject({ status: 409 });
    expect(await findClientHubRoot(env, "standalone_client", "42", "project-alpha:primary", "business"))
      .toMatchObject({ root_namespace: "business" });
    const portal = await findClientHubRoot(env, "standalone_client", "42", "project-alpha:primary", "portal");
    expect(clientHubDetailPath(portal)).toBe("/clients/sources/project-alpha%3Aprimary/portal/standalone/42");
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    const second = await listClientHubRoots(env, staff, { limit: 1, cursor: first.nextCursor! });
    expect([...first.clients, ...second.clients].map(client => client.root_namespace)).toEqual(["business", "portal"]);
  });

  it("rejects stale or mismatched cursors, but scan-only/no-op reconciliation does not break pagination", async () => {
    await roots([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    const revision = await db.prepare("SELECT revision FROM client_hub_directory_state").first("revision");
    await db.prepare("UPDATE client_hub_roots SET scan_generation=9,indexed_at=datetime('now'),source_version='new-version',display_name=display_name").run();
    expect(await db.prepare("SELECT revision FROM client_hub_directory_state").first("revision")).toBe(revision);
    expect((await listClientHubRoots(env, staff, { limit: 1, cursor: first.nextCursor! })).clients[0]?.public_id).toBe("b");
    await expect(listClientHubRoots(env, staff, { q: "a", cursor: first.nextCursor! })).rejects.toMatchObject({ status: 400 });
    await db.prepare("UPDATE client_hub_roots SET sort_name='renamed' WHERE public_id='b'").run();
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
  });

  it("invalidates cursors on effective search changes, not identical search or scan marks", async () => {
    await roots([{ id: "a" }, { id: "b" }]);
    await field("b", "email", "first@example.test");
    const first = await listClientHubRoots(env, staff, { limit: 1 });
    await db.prepare("UPDATE client_hub_search_values SET normalized_value=normalized_value,scan_generation=2").run();
    expect((await listClientHubRoots(env, staff, { cursor: first.nextCursor! })).clients[0]?.public_id).toBe("b");
    await db.prepare("UPDATE client_hub_search_values SET normalized_value='second@example.test'").run();
    await expect(listClientHubRoots(env, staff, { cursor: first.nextCursor! })).rejects.toMatchObject({ status: 409 });
  });

  it("checks project permission and live assignments before a project field can match a client", async () => {
    await roots([{ id: "a" }, { id: "b" }]);
    await field("a", "project", "Hidden renovation", "hidden");
    await field("b", "project", "Visible renovation", "visible");
    await db.exec("INSERT INTO pa_projects(id,active,manager_user_id,client_id,organization_id) VALUES('hidden',1,NULL,'a',NULL),('visible',1,'pa-user-a','b',NULL);");
    expect((await listClientHubRoots(env, staff, { q: "renovation" })).clients).toEqual([]);
    await db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','projects','global',NULL)").run();
    expect((await listClientHubRoots(env, staff, { q: "renovation" })).clients.map(client => client.public_id)).toEqual(["b"]);
    await db.prepare("INSERT INTO pa_project_assignments(project_id,user_id,active) VALUES('hidden','pa-user-a',1)").run();
    expect((await listClientHubRoots(env, staff, { q: "renovation" })).clients.map(client => client.public_id)).toEqual(["a", "b"]);
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('staff-a','projects.view','deny','global',NULL)").run();
    expect((await listClientHubRoots(env, staff, { q: "renovation" })).clients).toEqual([]);
  });

  async function scopedProject() {
    await roots([{ id: "client-a" }, { id: "client-b" }, { id: "org-a", kind: "organization" }]);
    await field("client-a", "project", "Scoped renovation", "project-a");
    await db.batch([
      db.prepare("INSERT INTO pa_projects(id,active,manager_user_id,client_id,organization_id) VALUES('project-a',1,'pa-user-a','client-a',NULL)"),
      db.prepare("INSERT INTO staff_role_assignments VALUES('staff-a','projects','global',NULL)"),
    ]);
  }

  it("requires the current active project owner before stale cached project text can match", async () => {
    await scopedProject();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients.map(client => client.public_id)).toEqual(["client-a"]);
    await db.prepare("UPDATE pa_projects SET client_id='client-b'").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_projects SET client_id='client-a',active=0").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
  });

  it("prioritizes an explicit project organization over a stale standalone search root", async () => {
    await scopedProject();
    await db.prepare("UPDATE pa_projects SET organization_id='org-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
    await db.prepare(`UPDATE client_hub_search_values SET kind='organization',root_public_id='org-a' WHERE record_id='project-a'`).run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients.map(client => client.public_id)).toEqual(["org-a"]);
  });

  it("rechecks inherited organization ownership and active client state for project matches", async () => {
    await scopedProject();
    await db.batch([
      db.prepare(`UPDATE client_hub_search_values SET kind='organization',root_public_id='org-a' WHERE record_id='project-a'`),
      db.prepare("UPDATE pa_clients SET organization_id='org-a' WHERE id='client-a'"),
    ]);
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients.map(client => client.public_id)).toEqual(["org-a"]);
    await db.prepare("UPDATE pa_clients SET organization_id='other-org' WHERE id='client-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
    await db.prepare("UPDATE pa_clients SET organization_id='org-a',active=0 WHERE id='client-a'").run();
    expect((await listClientHubRoots(env, staff, { q: "Scoped renovation" })).clients).toEqual([]);
  });

  it("returns explicit source labels and real directory reconciliation freshness", async () => {
    await roots([{ id: "a" }, { id: "b", source: "delivery:local" }]);
    const completed = "2026-08-25T13:40:00.000Z";
    await db.prepare("UPDATE client_hub_directory_state SET last_success_at=?").bind(completed).run();
    const result = await listClientHubRoots(env, staff);
    expect(result.indexUpdatedAt).toBe(completed);
    expect(result.searchCapabilities).toEqual({ businessContacts: true, portalContacts: false });
    expect(result.clients.map(client => client.source_name)).toEqual(["Project Alpha", "Local delivery"]);
    expect(result.clients.every(client => client.meaningful_activity_at === null)).toBe(true);
  });

  it("requires global directory permission and never treats business indexing as a grant", async () => {
    await roots([{ id: "a" }]);
    await db.prepare("UPDATE staff_role_assignments SET scope='division',division_id='division-a'").run();
    await expect(listClientHubRoots(env, staff)).rejects.toMatchObject({ status: 403 });
    await db.prepare("UPDATE staff_role_assignments SET scope='global'").run();
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('staff-a','team.view','deny','global',NULL)").run();
    await expect(listClientHubRoots(env, staff)).rejects.toMatchObject({ status: 403 });
    expect(await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'portal_v2_%'").first("n")).toBe(0);
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { kind: "all" }, { source: "bad-source" }, { source: "" }, { q: "x".repeat(201) }, { q: "bad\0query" }, { cursor: "" }, { cursor: "not-a-cursor" }])
    ("rejects invalid search input %j", async options => {
      await expect(listClientHubRoots(env, staff, options)).rejects.toMatchObject({ status: 400 });
    });

  it("distinguishes unfinished backfill from empty ready results and unknown clients", async () => {
    await db.prepare("UPDATE client_hub_directory_state SET ready=0").run();
    await expect(listClientHubRoots(env, staff)).rejects.toMatchObject({ status: 503 });
    await expect(findClientHubRoot(env, "organization", "missing")).rejects.toMatchObject({ status: 503 });
    await db.prepare("UPDATE client_hub_directory_state SET ready=1").run();
    expect(await listClientHubRoots(env, staff)).toMatchObject({ clients: [], nextCursor: null });
    await expect(findClientHubRoot(env, "organization", "missing")).rejects.toMatchObject({ status: 404 });
  });
});
