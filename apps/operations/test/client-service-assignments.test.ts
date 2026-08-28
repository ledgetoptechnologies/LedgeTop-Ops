import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { listClientServiceAssignments } from "../src/worker/client-service-assignments";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { StaffPrincipal } from "../src/worker/types";

const active: Miniflare[] = [];
const actor = { id: "staff-one" } as StaffPrincipal;
const sql = (database: D1Database, statement: string) => database.exec(statement.replace(/\s*\n\s*/g, " "));

function context(version = "context-one"): ClientHubCollectionContext {
  return { root: { source_id: "project-alpha:primary", source_name: "Primary Project Alpha", root_namespace: "business",
    kind: "organization", public_id: "organization-internal", pa_public_id: "organization-public", mapping_status: "mapped",
    display_name: "Organization One", sort_name: "Organization One", status: "active", portal_status: "active",
    workspace_id: "workspace-one", legacy_account_id: null, account_count: 0, project_count: 0, request_count: 0,
    contact_count: 0, meaningful_activity_at: null, source_version: null, indexed_at: "", scan_generation: 1 },
  access: { directory: true, requests: true, delivery: false, viewer: false },
  canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "organization-internal" },
  contextVersion: version };
}

async function fixture() {
  const miniflare = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch(){ return new Response('ok'); } }", d1Databases: { DELIVERY_DB: "service-assignments" } });
  active.push(miniflare);
  const db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
  await sql(db, `
    CREATE TABLE pa_service_assignment_receiver_grants(source_id TEXT PRIMARY KEY,state TEXT NOT NULL);
    CREATE TABLE pa_service_assignment_receiver_workspaces(source_id TEXT NOT NULL,workspace_id TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE pa_service_assignment_source_capabilities(source_id TEXT PRIMARY KEY,state TEXT NOT NULL);
    CREATE TABLE pa_service_assignment_generations(id TEXT,source_id TEXT,source_generation TEXT,source_sequence INTEGER,status TEXT,complete INTEGER);
    CREATE TABLE pa_service_assignments(source_id TEXT,assignment_public_id TEXT,source_version TEXT,subject_type TEXT,subject_public_id TEXT,
      service_public_id TEXT,service_source_version TEXT,active INTEGER,effective_from TEXT,effective_until TEXT,source_updated_at TEXT,
      source_generation TEXT,source_sequence INTEGER);
    CREATE TABLE pa_service_assignment_checkpoints(source_id TEXT PRIMARY KEY,active_generation_id TEXT,source_generation TEXT,source_sequence INTEGER);
    CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT,projection_source_id TEXT);
    CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,root_type TEXT,pa_organization_public_id TEXT,
      pa_client_public_id TEXT,status TEXT);
    CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT,source_sequence INTEGER);
    CREATE TABLE portal_v2_directory_generations(id TEXT,workspace_id TEXT,source_sequence INTEGER,status TEXT,complete INTEGER);
    CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,parent_public_id TEXT,active INTEGER,source_version TEXT);
    CREATE TABLE pa_service_catalog_items(source_id TEXT,public_id TEXT,source_version TEXT,name TEXT,active INTEGER);
    CREATE TABLE pa_service_catalog_checkpoint(source_id TEXT PRIMARY KEY,active_generation_id TEXT,source_generation TEXT,source_sequence INTEGER);
    INSERT INTO pa_service_assignment_receiver_grants VALUES('project-alpha:primary','active');
    INSERT INTO pa_service_assignment_receiver_workspaces VALUES('project-alpha:primary','workspace-one','active');
    INSERT INTO pa_service_assignment_source_capabilities VALUES('project-alpha:primary','supported');
    INSERT INTO pa_service_assignment_generations VALUES('assignment-generation','project-alpha:primary','assignment-snapshot',10,'active',1);
    INSERT INTO pa_service_assignment_checkpoints VALUES('project-alpha:primary','assignment-generation','assignment-snapshot',10);
    INSERT INTO pa_portal_workspace_sources VALUES('workspace-one','project-alpha:primary');
    INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary','organization','organization-public',NULL,'active');
    INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','directory-generation',7);
    INSERT INTO portal_v2_directory_generations VALUES('directory-generation','workspace-one',7,'active',1);
    INSERT INTO portal_v2_directory_entities VALUES('workspace-one','directory-generation','organization','organization-public',NULL,1,'organization-v1');
    INSERT INTO portal_v2_directory_entities VALUES('workspace-one','directory-generation','project','project-public','organization-public',1,'project-v1');
    INSERT INTO pa_service_catalog_checkpoint VALUES('project-alpha:primary','catalog-generation','catalog-snapshot',4);
    INSERT INTO pa_service_catalog_items VALUES('project-alpha:primary','service-mapped','service-v1','Aerial Mapping',1);
    INSERT INTO pa_service_catalog_items VALUES('project-alpha:primary','service-stale','service-old','Stale label must not appear',1);
    INSERT INTO pa_service_catalog_items VALUES('project-alpha:secondary','service-cross-source','service-v1','Cross-source label',1);
    INSERT INTO pa_service_assignments VALUES
      ('project-alpha:primary','assignment-06','assignment-v6','organization','organization-public','service-mapped','service-v1',1,NULL,NULL,'2026-08-27T12:00:06Z','assignment-snapshot',10),
      ('project-alpha:primary','assignment-05','assignment-v5','organization','organization-public','service-stale','service-new',1,NULL,NULL,'2026-08-27T12:00:05Z','assignment-snapshot',10),
      ('project-alpha:primary','assignment-04','assignment-v4','organization','organization-public','service-upcoming','service-v1',1,'2099-01-01T00:00:00Z',NULL,'2026-08-27T12:00:04Z','assignment-snapshot',10),
      ('project-alpha:primary','assignment-03','assignment-v3','organization','organization-public','service-expired','service-v1',1,NULL,'2000-01-01T00:00:00Z','2026-08-27T12:00:03Z','assignment-snapshot',10),
      ('project-alpha:primary','assignment-02','assignment-v2','organization','organization-public','service-invalid','service-v1',1,'not-a-date',NULL,'2026-08-27T12:00:02Z','assignment-snapshot',10),
      ('project-alpha:primary','assignment-01','assignment-v1','organization','organization-public','service-last','service-v1',1,NULL,NULL,'2026-08-27T12:00:01Z','assignment-snapshot',10),
      ('project-alpha:primary','assignment-project','assignment-v1','project','project-public','service-project','service-v1',1,NULL,NULL,'2026-08-27T12:00:09Z','assignment-snapshot',10),
      ('project-alpha:primary','assignment-other','assignment-v1','organization','other-organization','service-other','service-v1',1,NULL,NULL,'2026-08-27T12:00:08Z','assignment-snapshot',10),
      ('project-alpha:secondary','assignment-cross-source','assignment-v1','organization','organization-public','service-cross-source','service-v1',1,NULL,NULL,'2026-08-27T12:00:07Z','secondary-snapshot',8),
      ('project-alpha:primary','assignment-tombstoned','assignment-v1','organization','organization-public','service-old','service-v1',0,NULL,NULL,'2026-08-27T12:00:10Z','assignment-snapshot',10);
  `);
  return db;
}

function mutateAfterAssignmentRead(database: D1Database, mutation: () => Promise<unknown>): D1Database {
  const session = database.withSession("first-primary");
  let mutated = false;
  const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), query);
      if (property === "all") return async () => {
        const result = await target.all();
        if (!mutated && query.includes("WITH effective AS")) { mutated = true; await mutation(); }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { withSession: () => ({ prepare: (query: string) => wrap(session.prepare(query), query) }) } as unknown as D1Database;
}

afterEach(async () => { await Promise.all(active.splice(0).map(instance => instance.dispose())); });

describe("Client Hub Project Alpha service assignments", () => {
  it("lists only the exact source-qualified root subject and uses only same-version catalog labels", async () => {
    const db = await fixture();
    const result = await listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { limit: 25 });
    expect(result.page).toMatchObject({ available: true, returned: 6, hasMore: false });
    expect(result.items.map(item => item.assignment_public_id)).not.toEqual(expect.arrayContaining([
      "assignment-project", "assignment-other", "assignment-cross-source", "assignment-tombstoned"]));
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ assignment_public_id: "assignment-06", service_name: "Aerial Mapping",
        service_label: "Aerial Mapping", subject_type: "organization", subject_public_id: "organization-public",
        subject_name: "Organization One", source_id: "project-alpha:primary", source_name: "Primary Project Alpha" }),
      expect.objectContaining({ assignment_public_id: "assignment-05", service_name: null, service_label: "service-stale" }),
    ]));
    expect(JSON.stringify(result)).not.toMatch(/price|summary|question_schema/i);
  });

  it("filters effective status and searches service labels without widening subject containment", async () => {
    const db = await fixture();
    const effective = await listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { status: "effective", limit: 25 });
    expect(effective.items.map(item => item.effective_status)).toEqual(["effective", "effective", "effective"]);
    const upcoming = await listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { status: "upcoming", limit: 25 });
    expect(upcoming.items).toEqual([expect.objectContaining({ service_public_id: "service-upcoming" })]);
    const searched = await listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { q: "aerial mapping", limit: 25 });
    expect(searched.items).toEqual([expect.objectContaining({ service_public_id: "service-mapped" })]);
  });

  it("uses an actor, source, root, context, filter, and checkpoint-bound opaque cursor", async () => {
    const db = await fixture();
    const first = await listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { limit: 2 });
    expect(first.page).toMatchObject({ returned: 2, hasMore: true, limit: 2 });
    expect(first.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const second = await listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { limit: 2, cursor: first.page.nextCursor! });
    expect(second.items.map(item => item.row_key)).not.toEqual(expect.arrayContaining(first.items.map(item => item.row_key)));
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, { id: "other-staff" } as StaffPrincipal,
      context(), { limit: 2, cursor: first.page.nextCursor! })).rejects.toMatchObject({ status: 409 });
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, actor, context("changed-context"),
      { limit: 2, cursor: first.page.nextCursor! })).rejects.toMatchObject({ status: 409 });
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(),
      { status: "expired", limit: 2, cursor: first.page.nextCursor! })).rejects.toMatchObject({ status: 409 });
    await db.prepare("UPDATE pa_service_assignment_checkpoints SET source_sequence=11 WHERE source_id='project-alpha:primary'").run();
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(),
      { limit: 2, cursor: first.page.nextCursor! })).resolves.toMatchObject({ page: { available: false, reason: "projection_not_ready" } });
  });

  it("reports permission, receiver, directory, projection, and schema readiness without false empty histories", async () => {
    const db = await fixture(), denied = context();
    denied.access.requests = false;
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, actor, denied)).rejects.toMatchObject({ status: 403 });
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, actor, denied, { initial: true }))
      .resolves.toMatchObject({ page: { available: false, reason: "permission_required" } });
    await db.prepare("UPDATE pa_service_assignment_receiver_grants SET state='suspended'").run();
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { initial: true }))
      .resolves.toMatchObject({ page: { available: false, reason: "receiver_not_ready" }, readiness: { receiver: "suspended" } });
    await db.prepare("UPDATE pa_service_assignment_receiver_grants SET state='active'").run();
    await db.prepare("UPDATE portal_v2_directory_entities SET active=0 WHERE entity_type='organization'").run();
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { initial: true }))
      .resolves.toMatchObject({ page: { available: false, reason: "directory_not_ready" } });
    await db.prepare("UPDATE portal_v2_directory_entities SET active=1 WHERE entity_type='organization'").run();
    await db.prepare("DELETE FROM pa_service_assignment_checkpoints").run();
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { initial: true }))
      .resolves.toMatchObject({ page: { available: false, reason: "projection_not_ready" } });
    await db.prepare("DROP TABLE pa_service_assignments").run();
    await expect(listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { initial: true }))
      .resolves.toMatchObject({ page: { available: false, reason: "schema_unavailable" }, readiness: { tables: "unavailable" } });
  });

  it("falls back to service IDs when the catalog receiver is absent", async () => {
    const db = await fixture();
    await db.batch([db.prepare("DROP TABLE pa_service_catalog_items"), db.prepare("DROP TABLE pa_service_catalog_checkpoint")]);
    const result = await listClientServiceAssignments({ DELIVERY_DB: db }, actor, context(), { limit: 25 });
    expect(result).toMatchObject({ readiness: { catalog: "unavailable" }, page: { available: true } });
    expect(result.items.every(item => item.service_name === null && item.service_label === item.service_public_id)).toBe(true);
  });

  it("rejects a receiver suspension that races the cross-D1 assignment read", async () => {
    const db = await fixture();
    const raced = mutateAfterAssignmentRead(db, () => db.prepare("UPDATE pa_service_assignment_receiver_grants SET state='suspended'").run());
    await expect(listClientServiceAssignments({ DELIVERY_DB: raced }, actor, context(), { limit: 25 }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("readiness changed") });
  });

  it("rejects current directory generation drift that races the assignment read", async () => {
    const db = await fixture();
    const raced = mutateAfterAssignmentRead(db, () => db.batch([
      db.prepare("INSERT INTO portal_v2_directory_generations VALUES('directory-generation-two','workspace-one',8,'active',1)"),
      db.prepare("INSERT INTO portal_v2_directory_entities VALUES('workspace-one','directory-generation-two','organization','organization-public',NULL,1,'organization-v2')"),
      db.prepare("UPDATE portal_v2_directory_checkpoints SET active_generation_id='directory-generation-two',source_sequence=8 WHERE workspace_id='workspace-one'"),
    ]));
    await expect(listClientServiceAssignments({ DELIVERY_DB: raced }, actor, context(), { limit: 25 }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("readiness changed") });
  });
});
