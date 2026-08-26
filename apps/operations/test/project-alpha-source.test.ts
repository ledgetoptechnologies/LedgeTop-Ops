import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  createProjectAlphaSourceContext, mapProjectAlphaSourceRow, prepareProjectAlphaSourceRecords,
  PRIMARY_PROJECT_ALPHA_SOURCE, projectAlphaSourceReferences, type ProjectAlphaSourceReference,
} from "../src/worker/project-alpha-source";

const primary = "project-alpha:primary";
const secondary = createProjectAlphaSourceContext("project-alpha:technologies-test");
const rawPayload = '{ "id": "001", "name": "Original", "nested": {"id":"001"} }';
const metadataTables = ["pa_projection_fingerprints", "pa_projection_entity_versions", "pa_projection_entity_leases", "integration_event_receipts", "integration_reconciliation", "integration_health", "sync_runs"] as const;
const preservedTables = ["pa_users", "pa_clients", "pa_projects", "pa_operations", "pa_calendar_events", "staff_users", "divisions", "project_folders", "operational_job_briefs", "operational_job_brief_revisions", "work_context_sop_link_sets", ...metadataTables] as const;
let miniflare: Miniflare;
let db: D1Database;
const preserved = new Map<string, Record<string, unknown>[]>();

async function rows(table: string): Promise<Record<string, unknown>[]> {
  return (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string, unknown>>()).results;
}

beforeAll(async () => {
  miniflare = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await miniflare.getD1Database("OPS_DB") as D1Database;
  const directory = resolve(import.meta.dirname, "../migrations");
  for (const name of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name) && name < "0033_projection_sources.sql").sort()) {
    const statements = splitD1MigrationStatements(await readFile(resolve(directory, name), "utf8"));
    if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
  }
  await db.batch([
    db.prepare("INSERT INTO pa_users(id,email,payload_json,last_sync_id,updated_at) VALUES('001','same@example.test',?,'old','2026-01-01')").bind(rawPayload),
    db.prepare("INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id,updated_at) VALUES('001','Client','missing-organization',?,'old','2026-01-01')").bind(rawPayload),
    db.prepare("INSERT INTO pa_projects(id,name,client_id,manager_user_id,payload_json,last_sync_id,updated_at) VALUES('001','Project','001','missing-manager',?,'old','2026-01-01')").bind(rawPayload),
    db.prepare("INSERT INTO pa_operations(id,project_id,title,status,created_by_user_id,payload_json,last_sync_id) VALUES('001','001','Operation','draft','001',?,'old')").bind(rawPayload),
    db.prepare("INSERT INTO pa_calendar_events(id,source_type,source_id,title,start_at,project_id,payload_json,last_sync_id) VALUES('operation:001','operation','001','Operation','2026-01-01','001',?,'old')").bind(rawPayload),
    db.prepare("INSERT INTO staff_users(id,email,display_name,project_alpha_user_id,status) VALUES('source-test-staff','source-test@example.test','Staff','001','active')"),
    db.prepare("INSERT INTO divisions(id,code,name,project_alpha_business_unit_id) VALUES('source-test-division','source-test','Division','missing-unit')"),
    db.prepare("INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by) VALUES('001','source-test-division','clients/source-test/','manual','source-test-staff')"),
    db.prepare("INSERT INTO operational_job_briefs(operation_id,version,snapshot_json,created_by,updated_by) VALUES('001',1,?,'source-test-staff','source-test-staff')").bind(rawPayload),
    db.prepare("INSERT INTO operational_job_brief_revisions(id,operation_id,version,change_kind,snapshot_json,author_id,author_email,author_display_name) VALUES('source-test-revision','001',1,'scope_saved',?,'source-test-staff','source-test@example.test','Staff')").bind(rawPayload),
    db.prepare("INSERT INTO work_context_sop_link_sets(context_kind,context_id,version,mutation_id,updated_by) VALUES('project','001',1,'old-mutation','source-test-staff')"),
    db.prepare("INSERT INTO pa_projection_fingerprints(collection,fingerprint,last_sync_id,updated_at) VALUES('projects','old-fingerprint','old','2026-01-01')"),
    db.prepare("INSERT INTO pa_projection_entity_versions(entity_type,entity_id,source_updated_at,event_id,updated_at) VALUES('project','001','2026-01-01','same-event','2026-01-01')"),
    db.prepare("INSERT INTO pa_projection_entity_leases(entity_type,entity_id,owner_event_id,lease_until,updated_at) VALUES('project','001','same-event','2026-12-01','2026-01-01')"),
    db.prepare("INSERT INTO integration_event_receipts(event_id,integration,event_type,user_id,occurred_at,payload_hash,status,received_at,processed_at) VALUES('same-event','project-alpha','projection.changed','001','2026-01-01','unchanged-hash','completed','2026-01-01','2026-01-02')"),
    db.prepare("UPDATE integration_reconciliation SET last_event_at='2026-01-01',access_consecutive_failures=2 WHERE integration='project-alpha'"),
    db.prepare("INSERT INTO integration_health(integration,status,last_success_at,details_json) VALUES('source-test-integration','healthy','2026-01-01',?)").bind(rawPayload),
    db.prepare("INSERT INTO sync_runs(id,integration,status,started_at) VALUES('source-test-run','project-alpha','success','2026-01-01')"),
  ]);
  for (const table of preservedTables) preserved.set(table, await rows(table));
  // Prove the actual migration is one atomic D1 batch, including trigger bodies.
  await db.batch(splitD1MigrationStatements(await readFile(resolve(directory, "0033_projection_sources.sql"), "utf8")).map(statement => db.prepare(statement)));
}, 60_000);

afterAll(async () => { await miniflare?.dispose(); });

describe("source-qualified Project Alpha projection storage", () => {
  it("preserves populated primary records, local evidence, receipts and dangling references byte-for-byte", async () => {
    for (const table of preservedTables) {
      const current = await rows(table);
      expect(current.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "projection_source_id")))).toEqual(preserved.get(table));
      for (const row of current) if ("projection_source_id" in row) expect(row.projection_source_id).toBe(primary);
    }
    for (const [kind, id] of [["organization", "missing-organization"], ["user", "missing-manager"], ["business_unit", "missing-unit"]]) {
      expect(await db.prepare("SELECT local_id FROM pa_projection_record_ids WHERE projection_source_id=? AND record_kind=? AND external_id=?").bind(primary, kind, id).first("local_id")).toBe(id);
    }
    expect(await db.prepare("SELECT count(*) count FROM pa_organizations").first("count")).toBe(0);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await db.prepare("PRAGMA quick_check").first("quick_check")).toBe("ok");
    await expect(db.prepare("UPDATE operational_job_brief_revisions SET snapshot_json='{}' WHERE id='source-test-revision'").run()).rejects.toThrow("job brief revisions are immutable");
  });

  it("keeps primary IDs exact, separates sources and kinds, and persists preallocated missing parents", async () => {
    const references: ProjectAlphaSourceReference[] = [{ kind: "project", externalId: "001" }, { kind: "client", externalId: "001" }, { kind: "organization", externalId: "future-parent" }];
    const main = await prepareProjectAlphaSourceRecords(db, PRIMARY_PROJECT_ALPHA_SOURCE, references);
    const other = await prepareProjectAlphaSourceRecords(db, secondary, references);
    const again = await prepareProjectAlphaSourceRecords(db, secondary, references);
    expect(main.get("project", "001")).toBe("001");
    expect(other.get("project", "001")).not.toBe("001");
    expect(other.get("project", "001")).not.toBe(other.get("client", "001"));
    expect(again.get("project", "001")).toBe(other.get("project", "001"));
    await db.prepare("INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id,projection_source_id) VALUES(?,'Secondary client',?,'{}','test',?)")
      .bind(other.get("client", "001"), other.get("organization", "future-parent"), secondary.sourceId).run();
    expect(await db.prepare("SELECT count(*) count FROM pa_organizations WHERE id=?").bind(other.get("organization", "future-parent")).first("count")).toBe(0);
    await db.prepare("INSERT INTO pa_organizations(id,name,payload_json,last_sync_id,projection_source_id) VALUES(?,'Future parent','{}','test',?)")
      .bind(other.get("organization", "future-parent"), secondary.sourceId).run();
    expect(other.optional("project", null)).toBeNull();
    expect(() => other.get("project", "not-requested")).toThrow("reference-unmapped");
  });

  it("resolves concurrent allocators to the same immutable handle", async () => {
    const refs: ProjectAlphaSourceReference[] = [{ kind: "task", externalId: "concurrent" }];
    const [a, b] = await Promise.all([prepareProjectAlphaSourceRecords(db, secondary, refs), prepareProjectAlphaSourceRecords(db, secondary, refs)]);
    expect(a.get("task", "concurrent")).toBe(b.get("task", "concurrent"));
    await expect(db.prepare("UPDATE pa_projection_record_ids SET local_id='replacement' WHERE projection_source_id=? AND record_kind='task' AND external_id='concurrent'").bind(secondary.sourceId).run()).rejects.toThrow("identity is immutable");
    await expect(db.prepare("DELETE FROM pa_projection_record_ids WHERE projection_source_id=? AND record_kind='task' AND external_id='concurrent'").bind(secondary.sourceId).run()).rejects.toThrow("cannot be deleted");
    await expect(db.prepare("INSERT OR REPLACE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'task','concurrent','replacement')").bind(secondary.sourceId).run()).rejects.toThrow("identity is immutable");
    await expect(db.prepare("INSERT OR REPLACE INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'task','replacement-external',?)").bind(secondary.sourceId, a.get("task", "concurrent")).run()).rejects.toThrow("identity is immutable");
  });

  it("maps only typed scalar IDs and keeps original payload and calendar provenance separate", async () => {
    const raw = { id: "raw-task", project_id: "001", created_by: "001", created_by_user_id: "001", payload: { id: "001" }, title: "001" };
    const calendar = { id: "task:raw-task", source_type: "task", source_id: "raw-task", project_id: "001" };
    const mapping = await prepareProjectAlphaSourceRecords(db, secondary, [...projectAlphaSourceReferences("tasks", raw), ...projectAlphaSourceReferences("calendar_events", calendar)]);
    const mapped = mapProjectAlphaSourceRow("tasks", raw, mapping);
    expect(mapped.id).toBe(mapping.get("task", "raw-task"));
    expect(mapped.created_by).toBe(mapping.get("user", "001"));
    expect(mapped.created_by_user_id).toBe(mapped.created_by);
    expect(mapped.payload).toBe(raw.payload);
    expect(mapped.title).toBe("001");
    expect(raw.id).toBe("raw-task");
    const mappedCalendar = mapProjectAlphaSourceRow("calendar_events", calendar, mapping);
    expect(mappedCalendar.id).toBe(mapping.get("calendar_event", "task:raw-task"));
    expect(mappedCalendar.source_id).toBe(mapping.get("task", "raw-task"));
    expect(mappedCalendar.id).not.toBe(`task:${String(mappedCalendar.source_id)}`);
    expect(projectAlphaSourceReferences("operation_assignments", { operation_id: 1, user_id: 2, assigned_by: 3, assigned_by_user_id: 3 })).toEqual([
      { kind: "operation", externalId: "1" }, { kind: "user", externalId: "2" }, { kind: "user", externalId: "3" }, { kind: "user", externalId: "3" },
    ]);
  });

  it("rejects known cross-source links, wrong typed references and provenance changes", async () => {
    const mapping = await prepareProjectAlphaSourceRecords(db, secondary, [{ kind: "project", externalId: "guard-project" }, { kind: "client", externalId: "guard-client" }]);
    const project = mapping.get("project", "guard-project");
    await expect(db.prepare("INSERT INTO pa_projects(id,name,client_id,payload_json,last_sync_id,projection_source_id) VALUES(?,'Bad','001','{}','test',?)").bind(project, secondary.sourceId).run()).rejects.toThrow("source mismatch");
    await expect(db.prepare("INSERT INTO pa_projects(id,name,client_id,payload_json,last_sync_id,projection_source_id) VALUES(?,'Bad',?,'{}','test',?)").bind(project, project, secondary.sourceId).run()).rejects.toThrow("source mismatch");
    await db.prepare("INSERT INTO pa_projects(id,name,client_id,payload_json,last_sync_id,projection_source_id) VALUES(?,'Good',?,'{}','test',?)").bind(project, mapping.get("client", "guard-client"), secondary.sourceId).run();
    await expect(db.prepare("UPDATE pa_projects SET client_id='001' WHERE id=?").bind(project).run()).rejects.toThrow("source mismatch");
    await expect(db.prepare("UPDATE pa_projects SET projection_source_id=? WHERE id=?").bind(primary, project).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE pa_projects SET id='replacement' WHERE id=?").bind(project).run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO pa_projects(id,name,client_id,payload_json,last_sync_id) VALUES('primary-cannot-adopt','Bad',?,'{}','test')").bind(mapping.get("client", "guard-client")).run()).rejects.toThrow("identity is immutable");
    expect(await db.prepare("SELECT count(*) count FROM pa_projection_record_ids WHERE projection_source_id=? AND external_id='primary-cannot-adopt'").bind(primary).first("count")).toBe(0);
  });

  it("auto-adopts old primary inserts without allowing secondary staff authority", async () => {
    await db.prepare("INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id) VALUES('primary-default','Old insert','primary-new-parent','{}','test')").run();
    expect(await db.prepare("SELECT local_id FROM pa_projection_record_ids WHERE projection_source_id=? AND record_kind='organization' AND external_id='primary-new-parent'").bind(primary).first("local_id")).toBe("primary-new-parent");
    const mapping = await prepareProjectAlphaSourceRecords(db, secondary, [{ kind: "application_entitlement", externalId: "staff-denied" }, { kind: "user", externalId: "staff-denied" }]);
    await expect(db.prepare("INSERT INTO pa_application_entitlements(id,user_id,application_key,enabled,role_key,payload_json,last_sync_id,projection_source_id) VALUES(?,?,'ltds_ops',1,'role-operator','{}','test',?)")
      .bind(mapping.get("application_entitlement", "staff-denied"), mapping.get("user", "staff-denied"), secondary.sourceId).run()).rejects.toThrow("no staff authority");
  });

  it("supports repeated primary UPSERT and assignment replay without conflict-policy trigger failures", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db.batch([
        db.prepare(`INSERT INTO pa_clients(id,name,organization_id,payload_json,last_sync_id)
          VALUES('upsert-client',?,'upsert-organization','{}','test')
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,organization_id=excluded.organization_id,last_sync_id=excluded.last_sync_id`).bind(`Attempt ${attempt}`),
        db.prepare(`INSERT INTO pa_projects(id,name,client_id,payload_json,last_sync_id)
          VALUES('upsert-project',?,'upsert-client','{}','test')
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,client_id=excluded.client_id`).bind(`Attempt ${attempt}`),
        db.prepare(`INSERT INTO pa_project_assignments(id,project_id,user_id,payload_json,last_sync_id)
          VALUES('upsert-assignment','upsert-project','upsert-user','{}','test')
          ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,user_id=excluded.user_id`),
        db.prepare(`INSERT INTO pa_worker_business_units(user_id,business_unit_id,payload_json,last_sync_id)
          VALUES('upsert-user','upsert-unit','{}','test')
          ON CONFLICT(user_id,business_unit_id) DO UPDATE SET last_sync_id=excluded.last_sync_id`),
      ]);
    }
    expect(await db.prepare("SELECT name FROM pa_projects WHERE id='upsert-project'").first("name")).toBe("Attempt 2");
    expect(await db.prepare("SELECT count(*) count FROM pa_projection_record_ids WHERE projection_source_id=? AND record_kind='client' AND external_id='upsert-client'").bind(primary).first("count")).toBe(1);
  });

  it("guards natural assignment keys, dynamic calendar references and local airspace relationships", async () => {
    const mapping = await prepareProjectAlphaSourceRecords(db, secondary, [
      { kind: "operation", externalId: "relation-operation" }, { kind: "project", externalId: "relation-project" },
      { kind: "user", externalId: "relation-user" }, { kind: "calendar_event", externalId: "operation:relation-operation" },
    ]);
    const operation = mapping.get("operation", "relation-operation");
    const project = mapping.get("project", "relation-project");
    const user = mapping.get("user", "relation-user");
    await db.prepare("INSERT INTO pa_operations(id,project_id,title,status,payload_json,last_sync_id,projection_source_id) VALUES(?,?,'Related','draft','{}','test',?)").bind(operation, project, secondary.sourceId).run();
    await db.prepare("INSERT INTO pa_operation_assignments(operation_id,user_id,payload_json,last_sync_id,projection_source_id) VALUES(?,?,'{}','test',?)").bind(operation, user, secondary.sourceId).run();
    await expect(db.prepare("UPDATE pa_operation_assignments SET user_id='001' WHERE operation_id=?").bind(operation).run()).rejects.toThrow("source mismatch");
    const calendar = mapping.get("calendar_event", "operation:relation-operation");
    await db.prepare("INSERT INTO pa_calendar_events(id,source_type,source_id,title,start_at,payload_json,last_sync_id,projection_source_id) VALUES(?,'operation',?,'Related','2026-01-01','{}','test',?)").bind(calendar, operation, secondary.sourceId).run();
    await expect(db.prepare("UPDATE pa_calendar_events SET source_type='task' WHERE id=?").bind(calendar).run()).rejects.toThrow("source mismatch");
    await db.prepare("INSERT INTO pa_operation_airspace_matches(operation_id,source_type,source_id,match_type,projection_source_id) VALUES(?,'tfr','external-tfr-unchanged','nearby',?)").bind(operation, secondary.sourceId).run();
    await expect(db.prepare("UPDATE pa_operation_airspace_matches SET operation_id='001' WHERE operation_id=?").bind(operation).run()).rejects.toThrow("source mismatch");
    expect(await db.prepare("SELECT source_id FROM pa_operation_airspace_matches WHERE operation_id=?").bind(operation).first("source_id")).toBe("external-tfr-unchanged");
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("isolates colliding coordination IDs and keeps external entity IDs unchanged", async () => {
    await db.batch([
      db.prepare("INSERT INTO pa_projection_fingerprints(projection_source_id,collection,fingerprint,last_sync_id) VALUES(?,'projects','other-fingerprint','other')").bind(secondary.sourceId),
      db.prepare("INSERT INTO pa_projection_entity_versions(projection_source_id,entity_type,entity_id,source_updated_at,event_id) VALUES(?,'project','001','2026-02-01','same-event')").bind(secondary.sourceId),
      db.prepare("INSERT INTO pa_projection_entity_leases(projection_source_id,entity_type,entity_id,owner_event_id,lease_until) VALUES(?,'project','001','other-owner','2026-12-02')").bind(secondary.sourceId),
      db.prepare("INSERT INTO integration_event_receipts(projection_source_id,event_id,integration,event_type,user_id,occurred_at,payload_hash,status) VALUES(?,'same-event','project-alpha','projection.changed','001','2026-02-01','other-hash','pending')").bind(secondary.sourceId),
      db.prepare("INSERT INTO integration_reconciliation(projection_source_id,integration,last_event_at) VALUES(?,'project-alpha','2026-02-01')").bind(secondary.sourceId),
      db.prepare("INSERT INTO integration_health(projection_source_id,integration,status) VALUES(?,'source-test-integration','error')").bind(secondary.sourceId),
    ]);
    expect(await db.prepare("SELECT fingerprint FROM pa_projection_fingerprints WHERE projection_source_id=? AND collection='projects'").bind(primary).first("fingerprint")).toBe("old-fingerprint");
    expect(await db.prepare("SELECT owner_event_id FROM pa_projection_entity_leases WHERE projection_source_id=? AND entity_type='project' AND entity_id='001'").bind(primary).first("owner_event_id")).toBe("same-event");
    expect(await db.prepare("SELECT payload_hash FROM integration_event_receipts WHERE projection_source_id=? AND event_id='same-event'").bind(primary).first("payload_hash")).toBe("unchanged-hash");
    expect(await db.prepare("SELECT count(*) count FROM pa_projection_entity_versions WHERE entity_type='project' AND entity_id='001'").first("count")).toBe(2);
    expect(await db.prepare("SELECT status FROM integration_health WHERE projection_source_id=? AND integration='source-test-integration'").bind(primary).first("status")).toBe("healthy");
  });

  it("uses bounded set-based exact-source indexed mapping instead of one query per reference", async () => {
    let prepares = 0;
    const instrumented: Pick<D1Database, "prepare" | "batch"> = {
      prepare(sql) { prepares += 1; return db.prepare(sql); },
      batch<T = unknown>(statements: D1PreparedStatement[]) { return db.batch<T>(statements); },
    };
    const requested: ProjectAlphaSourceReference[] = Array.from({ length: 1201 }, (_, index) => ({ kind: "task", externalId: `bulk-${index}` }));
    const mapping = await prepareProjectAlphaSourceRecords(instrumented, secondary, requested);
    expect(prepares).toBe(9); // three chunks, read + reserve + read per chunk
    expect(mapping.get("task", "bulk-1200")).toMatch(/^pa-local-/);
    const plan = (await db.prepare("EXPLAIN QUERY PLAN SELECT m.local_id FROM json_each(?) requested CROSS JOIN pa_projection_record_ids m ON m.projection_source_id=? AND m.record_kind=json_extract(requested.value,'$[0]') AND m.external_id=json_extract(requested.value,'$[1]')").bind('[["task","bulk-1200"]]', secondary.sourceId).all<{ detail: string }>()).results;
    expect(plan.map(row => row.detail)).toEqual(expect.arrayContaining([expect.stringMatching(/SEARCH m USING (?:COVERING )?INDEX.*projection_source_id=\? AND record_kind=\? AND external_id=\?/)]));
  }, 15_000);

  it("validates source identities without caller-controlled staff authority or value coercion", async () => {
    for (const invalid of [null, undefined, 7, {}, "", "project-alpha:", "project-alpha:PRIMARY", "project-alpha:has space", `project-alpha:${"a".repeat(65)}`])
      expect(() => createProjectAlphaSourceContext(invalid)).toThrow();
    expect(PRIMARY_PROJECT_ALPHA_SOURCE.staffAuthority).toBe(true);
    expect(secondary.staffAuthority).toBe(false);
    const mapped = await prepareProjectAlphaSourceRecords(db, { sourceId: secondary.sourceId, staffAuthority: true }, [{ kind: "project", externalId: "authority-not-trusted" }]);
    expect(mapped.get("project", "authority-not-trusted")).not.toBe("authority-not-trusted");
    for (const id of ["", "a\u0000b", "x".repeat(1025)]) await expect(prepareProjectAlphaSourceRecords(db, secondary, [{ kind: "project", externalId: id }])).rejects.toThrow("record-id-invalid");
    expect(() => projectAlphaSourceReferences("projects", { id: {} })).toThrow("record-id-invalid");
    expect(() => projectAlphaSourceReferences("calendar_events", { id: "bad", source_type: "user", source_id: "001" })).toThrow("calendar-kind-invalid");
  });
});
