import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SqlScope } from "../src/worker/acl";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const fullScope: SqlScope = { global: true, divisions: [], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false };
const acl = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true),
  sqlScope: vi.fn(async (): Promise<SqlScope> => ({ global: true, divisions: [], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false })),
  isAdministrator: vi.fn(async () => true), hasLocalGlobalAllow: vi.fn(async () => false) }));
vi.mock("../src/worker/acl", () => acl);
import { readClientHubBusinessProjectDetail } from "../src/worker/client-hub-business-project-detail";

const active: Miniflare[] = [];
const staff = { id: "staff-a", projectAlphaUserId: "user-a" } as StaffPrincipal;
function context(kind: "organization" | "standalone_client" = "organization", id = "org-a"): ClientHubCollectionContext {
  return { root: { source_id: "project-alpha:primary", root_namespace: "business", kind, public_id: id,
    pa_public_id: null, mapping_status: "missing", display_name: "Client root", sort_name: "client root", status: "active",
    portal_status: "not_provisioned", workspace_id: null, legacy_account_id: null, account_count: 0, project_count: 0,
    request_count: 0, contact_count: 0, meaningful_activity_at: null, source_version: null, indexed_at: "", scan_generation: 0 },
  canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind, publicId: id },
  access: { directory: true, requests: true, delivery: true, viewer: true }, contextVersion: "a".repeat(43) };
}
const sql = (db: D1Database, value: string) => db.exec(value.replace(/\s*\n\s*/g, " "));
function table(migration: string, name: string): string {
  const source = readFileSync(new URL("../migrations/" + migration, import.meta.url), "utf8");
  const start = source.indexOf("CREATE TABLE " + name + " (");
  if (start < 0) throw new Error("Missing production table " + name);
  return source.slice(start, source.indexOf("\n);", start) + 3);
}
async function fixture() {
  const mf = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){return new Response('ok')} }", d1Databases: { OPS_DB: "business-project-detail" } });
  active.push(mf);
  const db = await mf.getD1Database("OPS_DB") as unknown as D1Database;
  for (const name of ["pa_organizations", "pa_clients", "pa_projects", "pa_users", "pa_project_assignments"])
    await sql(db, table("0001_operations.sql", name));
  for (const name of ["pa_operations", "pa_operation_assignments", "pa_tasks"])
    await sql(db, table("0004_project_alpha_authority.sql", name));
  await sql(db, table("0008_project_units_task_assignments.sql", "pa_task_assignments"));
  await sql(db, "ALTER TABLE pa_projects ADD COLUMN manager_user_id TEXT;");
  await sql(db, `INSERT INTO pa_organizations(id,name,payload_json,last_sync_id) VALUES('org-a','Org A','{}','sync'),('org-b','Org B','{}','sync');
    INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id) VALUES
      ('client-a','Contact A','org-a','{"email":" a@example.test ","phone":"+1 (555) 123-4567","billing":"never-return"}','sync'),
      ('client-b','Other Contact','org-b','{"email":"private-other@example.test"}','sync'),
      ('standalone','Standalone',NULL,'{}','sync');
    INSERT INTO pa_users(id,display_name,payload_json,last_sync_id) VALUES('user-a','Manager A','{"private":"never-return"}','sync');
    INSERT INTO pa_projects(id,name,status,start_date,end_date,client_id,payload_json,last_sync_id,manager_user_id)
      VALUES('project-a','Project A','completed','2026-01-01','2026-02-01','client-a',
        '{"description":"Documented project description","created_at":"2026-01-01T08:00:00+05:00","billing_status":"private","contract":"never-return","notes":"secret memory"}','sync','user-a');`);
  return { db, env: { OPS_DB: db } as Env };
}
afterEach(async () => {
  vi.resetAllMocks();
  acl.hasPermission.mockResolvedValue(true); acl.sqlScope.mockResolvedValue(fullScope);
  acl.isAdministrator.mockResolvedValue(true); acl.hasLocalGlobalAllow.mockResolvedValue(false);
  await Promise.all(active.splice(0).map(mf => mf.dispose()));
});

describe("read-only source-qualified business project detail", () => {
  it("returns only documented business fields and a factual linked contact, never grants or billing payload", async () => {
    const { db, env } = await fixture();
    // Session bookkeeping can increment SQLite total_changes independently of
    // application rows. Guard actual domain tables against any write instead.
    for (const name of ["pa_projects", "pa_clients", "pa_organizations", "pa_users", "pa_project_assignments",
      "pa_operations", "pa_operation_assignments", "pa_tasks", "pa_task_assignments"]) {
      for (const action of ["INSERT", "UPDATE", "DELETE"])
        await db.prepare(`CREATE TRIGGER readonly_${name}_${action} BEFORE ${action} ON ${name}
          BEGIN SELECT RAISE(ABORT,'read-only project endpoint wrote domain data'); END`).run();
    }
    const result = await readClientHubBusinessProjectDetail(env, staff, context(), "project-a");
    expect(result).toMatchObject({
      canonicalRoot: context().canonicalRoot, contextVersion: context().contextVersion,
      client: { detail_path: "/clients/sources/project-alpha%3Aprimary/business/organizations/org-a" },
      project: { id: "project-a", name: "Project A", status: "completed", description: "Documented project description",
        start_date: "2026-01-01", end_date: "2026-02-01", created_at: "2026-01-01T03:00:00.000Z",
        manager: { id: "user-a", display_name: "Manager A" } },
      linkedContact: { id: "client-a", display_name: "Contact A", email: "a@example.test", phone: "+1 (555) 123-4567",
        sourceField: "project.client_id" },
      availability: { linkedContact: "available", siteContacts: "not_projected", billingContacts: "not_projected", projectMemory: "not_projected" },
    });
    expect(result.linkedContact).not.toHaveProperty("role");
    expect(JSON.stringify(result)).not.toMatch(/payload_json|billing_status|never-return|secret memory|has_workspace_access|entitlements/);
  });

  it("uses explicit organization precedence and does not disclose an out-of-root linked contact", async () => {
    const { db, env } = await fixture();
    await db.prepare("UPDATE pa_projects SET organization_id='org-a',client_id='client-b'").run();
    const result = await readClientHubBusinessProjectDetail(env, staff, context(), "project-a");
    expect(result.linkedContact).toBeNull(); expect(result.availability.linkedContact).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("private-other@example.test");
    await expect(readClientHubBusinessProjectDetail(env, staff, context("organization", "org-b"), "project-a"))
      .rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_projects SET client_id=NULL").run();
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).availability.linkedContact).toBe("not_projected");
  });

  it("treats zone-less source timestamps as UTC and omits inactive projected managers", async () => {
    const { db, env } = await fixture();
    await db.prepare("UPDATE pa_projects SET payload_json=?").bind(JSON.stringify({ created_at: "2026-01-01 09:00:00" })).run();
    await db.prepare("UPDATE pa_users SET active=0 WHERE id='user-a'").run();
    const result = await readClientHubBusinessProjectDetail(env, staff, context(), "project-a");
    expect(result.project.created_at).toBe("2026-01-01T09:00:00.000Z");
    expect(result.project.manager).toBeNull();
  });

  it("does not revive inactive or reparented projects, clients or roots", async () => {
    const { db, env } = await fixture();
    await db.prepare("UPDATE pa_projects SET active=0").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_projects SET active=1").run();
    await db.prepare("UPDATE pa_clients SET active=0 WHERE id='client-a'").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_clients SET active=1,organization_id='org-b' WHERE id='client-a'").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_clients SET organization_id='org-a' WHERE id='client-a'").run();
    await db.prepare("UPDATE pa_organizations SET active=0 WHERE id='org-a'").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
  });

  it("allows a current standalone project only under its exact source-qualified standalone root", async () => {
    const { db, env } = await fixture();
    await db.prepare("UPDATE pa_projects SET client_id='standalone'").run();
    const root = context("standalone_client", "standalone");
    expect((await readClientHubBusinessProjectDetail(env, staff, root, "project-a")).linkedContact?.id).toBe("standalone");
    for (const namespace of ["account", "portal"] as const) {
      const wrong = context("standalone_client", "standalone");
      wrong.root.root_namespace = namespace;
      await expect(readClientHubBusinessProjectDetail(env, staff, wrong, "project-a")).rejects.toMatchObject({ status: 404 });
    }
    await expect(readClientHubBusinessProjectDetail(env, staff, { ...root, root: { ...root.root, source_id: "delivery:local" } }, "project-a"))
      .rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE pa_clients SET organization_id='org-a' WHERE id='standalone'").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, root, "project-a")).rejects.toMatchObject({ status: 404 });
  });

  it("requires directory and project-view permission without adding new write authority", async () => {
    const { env } = await fixture();
    acl.hasPermission.mockResolvedValue(false);
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 403 });
    acl.hasPermission.mockResolvedValue(true);
    acl.sqlScope.mockResolvedValue({ ...fullScope, deniedGlobal: true });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 403 });
    acl.sqlScope.mockResolvedValue(fullScope);
    const root = context(); root.access.directory = false;
    await expect(readClientHubBusinessProjectDetail(env, staff, root, "project-a")).rejects.toMatchObject({ status: 403 });
  });

  it("uses the same manager and direct/operation/task assignment scope as business history", async () => {
    const { db, env } = await fixture();
    acl.isAdministrator.mockResolvedValue(false);
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).project.id).toBe("project-a");
    await db.prepare("UPDATE pa_projects SET manager_user_id=NULL").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
    await sql(db, `INSERT INTO pa_project_assignments(id,project_id,user_id,payload_json,last_sync_id) VALUES('assignment','project-a','user-a','{}','sync');`);
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).project.id).toBe("project-a");
    await db.prepare("UPDATE pa_project_assignments SET active=0").run();
    await sql(db, `INSERT INTO pa_operations(id,project_id,title,status,payload_json,last_sync_id) VALUES('op','project-a','Operation','scheduled','{}','sync');
      INSERT INTO pa_operation_assignments(operation_id,user_id,payload_json,last_sync_id) VALUES('op','user-a','{}','sync');`);
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).project.id).toBe("project-a");
    await db.prepare("UPDATE pa_operation_assignments SET active=0").run();
    await sql(db, `INSERT INTO pa_tasks(id,project_id,title,status,payload_json,last_sync_id) VALUES('task','project-a','Task','todo','{}','sync');
      INSERT INTO pa_task_assignments(task_id,user_id,payload_json,last_sync_id) VALUES('task','user-a','{}','sync');`);
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).project.id).toBe("project-a");
    await db.prepare("UPDATE pa_task_assignments SET active=0").run();
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects stale optional contexts and malformed identifiers before selecting detail", async () => {
    const { env } = await fixture();
    for (const id of ["", "a".repeat(513), "bad\u0000id"])
      await expect(readClientHubBusinessProjectDetail(env, staff, context(), id)).rejects.toMatchObject({ status: 400 });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a", { expectedContextVersion: "bad" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a", { expectedContextVersion: "b".repeat(43) }))
      .rejects.toMatchObject({ status: 409 });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a", { expectedContextVersion: context().contextVersion }))
      .resolves.toMatchObject({ project: { id: "project-a" } });
  });

  it.each(["project", "contact", "assignment", "permission", "source"] as const)("rechecks %s changes after hydration", async change => {
    const { db, env } = await fixture();
    const admin = change !== "assignment";
    if (!admin) {
      await db.prepare("UPDATE pa_projects SET manager_user_id=NULL").run();
      await sql(db, `INSERT INTO pa_project_assignments(id,project_id,user_id,payload_json,last_sync_id) VALUES('assignment','project-a','user-a','{}','sync');`);
    }
    acl.isAdministrator.mockImplementationOnce(async () => admin).mockImplementationOnce(async () => {
      const updates = {
        project: "UPDATE pa_projects SET organization_id='org-b'",
        contact: "UPDATE pa_clients SET organization_id='org-b' WHERE id='client-a'",
        assignment: "UPDATE pa_project_assignments SET active=0",
        permission: "SELECT 1",
        source: `UPDATE pa_organizations SET payload_json='{"public_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' WHERE id='org-a'`,
      };
      await sql(db, updates[change]);
      return change === "permission" ? !admin : admin;
    });
    await expect(readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).rejects.toMatchObject({ status: 409 });
  });

  it("returns unknown for malformed, non-scalar, oversized and control-bearing source fields", async () => {
    const { db, env } = await fixture();
    for (const payload of ["not-json", "[]", '{"description":{"private":"secret"},"created_at":12}',
      JSON.stringify({ description: "a".repeat(8001), created_at: "now" }),
      JSON.stringify({ description: "bad\u0000text", created_at: "2026-02-30T00:00:00Z" })]) {
      await db.prepare("UPDATE pa_projects SET payload_json=?,start_date='not-a-date'").bind(payload).run();
      const detail = await readClientHubBusinessProjectDetail(env, staff, context(), "project-a");
      expect(detail.project).toMatchObject({ description: null, created_at: null, start_date: null });
    }
    await db.prepare("UPDATE pa_clients SET payload_json=? WHERE id='client-a'")
      .bind(JSON.stringify({ email: { secret: "private" }, phone: "bad\u0000phone" })).run();
    expect((await readClientHubBusinessProjectDetail(env, staff, context(), "project-a")).linkedContact)
      .toMatchObject({ email: null, phone: null });
  });
});
