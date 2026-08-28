import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readProjectOperationalWorkspace, saveProjectMemory, saveProjectOperationalContacts,
  type ProjectMemorySnapshot } from "../src/worker/project-operational-memory";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const source = "project-alpha:primary";
const TEST_TIMEOUT_MS = 30_000;
const owner: StaffPrincipal = { id: "staff-beau-koltz", email: "beaukoltz@ledgetopdroneservices.com",
  displayName: "Beau Koltz", accessSubject: "owner", projectAlphaUserId: null };
const operationKey = () => `project_memory_${crypto.randomUUID()}`;
const memory = (suffix = ""): ProjectMemorySnapshot => ({ plan: `Plan${suffix}`, actualOutcome: `Outcome${suffix}`,
  deviationsAndReasons: "", observations: "Observed", problems: "", successes: "Worked", recommendations: "",
  nextTimeRequests: "" });
let runtime: Miniflare, database: D1Database, environment: Pick<Env, "OPS_DB">, sequence = 0;
let beforeMigration: unknown, afterMigration: unknown;

async function stableAuthority() {
  const tables = ["staff_users", "staff_role_assignments", "staff_permission_overrides", "pa_clients", "pa_organizations",
    "pa_projects", "pa_projection_record_ids", "pa_application_entitlements", "viewer_processing_notification_outbox"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return result;
}
interface Fixture { context: ClientHubCollectionContext; projectId: string; contactId: string; secondContactId: string; otherContactId: string }
async function fixture(status = "active"): Promise<Fixture> {
  const n = ++sequence, org = `memory-org-${n}`, project = `memory-project-${n}`, contact = `memory-contact-${n}`,
    second = `memory-contact-second-${n}`, otherOrg = `memory-other-org-${n}`, other = `memory-other-contact-${n}`;
  const mappings = [["organization", org], ["project", project], ["client", contact], ["client", second],
    ["organization", otherOrg], ["client", other]];
  await database.batch([
    ...mappings.map(([kind, id]) => database.prepare(`INSERT INTO pa_projection_record_ids
      (projection_source_id,record_kind,external_id,local_id) VALUES(?,?,?,?)`).bind(source, kind, id, id)),
    database.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?, ?,1,'{}',?,?)")
      .bind(org, `Organization ${n}`, `org-sync-${n}`, source),
    database.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?, ?,1,'{}',?,?)")
      .bind(otherOrg, `Other ${n}`, `other-org-sync-${n}`, source),
    database.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,?,?,?)")
      .bind(contact, `Project Contact ${n}`, org, JSON.stringify({ email: `project-${n}@example.test`, phone: "+15550000001" }), `contact-sync-${n}`, source),
    database.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,?,?,?)")
      .bind(second, `Site Contact ${n}`, org, JSON.stringify({ email: `site-${n}@example.test` }), `second-sync-${n}`, source),
    database.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,?,?,?)")
      .bind(other, `Other Contact ${n}`, otherOrg, "{}", `other-contact-sync-${n}`, source),
    database.prepare("INSERT INTO pa_projects(id,organization_id,name,status,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,?,1,'{}',?,?)")
      .bind(project, org, `Project ${n}`, status, `project-sync-${n}`, source),
  ]);
  const contextVersion = "c".repeat(43);
  return { projectId: project, contactId: contact, secondContactId: second, otherContactId: other,
    context: { root: { source_id: source, root_namespace: "business", kind: "organization", public_id: org,
      pa_public_id: org, mapping_status: "mapped", display_name: `Organization ${n}`, source_name: "Project Alpha",
      sort_name: `organization ${n}`, status: "active", portal_status: "none", workspace_id: null, legacy_account_id: null,
      account_count: 0, project_count: 1, request_count: 0, contact_count: 2, meaningful_activity_at: null,
      source_version: `org-sync-${n}`, indexed_at: "2026-08-27T00:00:00.000Z", scan_generation: 1 },
      access: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion,
      canonicalRoot: { sourceId: source, rootNamespace: "business", kind: "organization", publicId: org } } };
}

function raceDatabase(action: () => Promise<void>): D1Database {
  const statements = new WeakMap<D1PreparedStatement, { raw: D1PreparedStatement; sql: string }>(); let fired = false;
  const wrap = (raw: D1PreparedStatement, sql: string): D1PreparedStatement => { const proxy = new Proxy(raw, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } }); statements.set(proxy, { raw, sql }); return proxy; };
  const proxy: D1Database = new Proxy(database, { get(target, property) {
    if (property === "withSession") return () => proxy;
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
    if (property === "batch") return async <T>(values: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (!fired && values.some(value => statements.get(value)?.sql.includes("INSERT INTO project_operational_write_fences"))) {
        fired = true; await action();
      }
      return target.batch<T>(values.map(value => statements.get(value)?.raw ?? value));
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return proxy;
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
    script: "export default {fetch(){return new Response('memory')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database; environment = { OPS_DB: database };
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter(name => name.endsWith(".sql") && name < "0043_").sort())
    await database.batch(splitD1MigrationStatements(readFileSync(new URL(filename, directory), "utf8")).map(sql => database.prepare(sql)));
  await database.batch([
    database.prepare("INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,?,?,?)")
      .bind(source, "organization", "migration-existing-org", "migration-existing-org"),
    database.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES('migration-existing-org','Existing',1,'{}','existing-sync',?)").bind(source),
  ]);
  beforeMigration = await stableAuthority();
  await database.batch(splitD1MigrationStatements(readFileSync(new URL("0043_project_operational_memory.sql", directory), "utf8"))
    .map(sql => database.prepare(sql)));
  afterMigration = await stableAuthority();
}, 120_000);
afterAll(async () => { await runtime?.dispose(); });

describe("source-qualified operational contacts and project memory", () => {
  it("migrates populated D1 without inference and grants only owner/admin defaults", async () => {
    expect(afterMigration).toEqual(beforeMigration);
    expect(await database.prepare("SELECT count(*) count FROM project_operational_contact_sets").first("count")).toBe(0);
    expect(await database.prepare("SELECT count(*) count FROM project_operational_memory").first("count")).toBe(0);
    expect((await database.prepare(`SELECT role_id,permission_key FROM role_permissions WHERE permission_key IN
      ('project.contacts.manage','project.memory.manage') ORDER BY role_id,permission_key`).all()).results)
      .toEqual([{ role_id: "role-admin", permission_key: "project.contacts.manage" }, { role_id: "role-admin", permission_key: "project.memory.manage" },
        { role_id: "role-owner", permission_key: "project.contacts.manage" }, { role_id: "role-owner", permission_key: "project.memory.manage" }]);
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("saves exact-root operational roles without changing access, billing, notification, or staff roles", async () => {
    const item = await fixture(), authority = await stableAuthority();
    const input = { expectedContextVersion: item.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(), assignments: [
      { contactId: item.contactId, role: "project_contact", preferredContactMethod: "email", instructions: "Call before arrival" },
      { contactId: item.secondContactId, role: "site_contact", preferredContactMethod: "phone", instructions: "Gate access" },
    ] };
    const saved = await saveProjectOperationalContacts(environment, owner, item.context, item.projectId, input);
    expect(saved).toMatchObject({ version: 1, replayed: false });
    expect(await saveProjectOperationalContacts(environment, owner, item.context, item.projectId, input)).toEqual({ ...saved, replayed: true });
    const workspace = await readProjectOperationalWorkspace(environment, owner, item.context, item.projectId);
    expect(workspace.contacts.assignments.map(value => value.role)).toEqual(["project_contact", "site_contact"]);
    expect(workspace.contacts.assignments[0]?.contact?.email).toContain("@example.test");
    expect(await stableAuthority()).toEqual(authority);
    const audit = JSON.stringify((await database.prepare("SELECT details_json FROM project_operational_events WHERE project_id=?")
      .bind(item.projectId).all()).results);
    expect(audit).not.toContain("Call before arrival"); expect(audit).not.toContain("@example.test");
    expect(await database.prepare("SELECT count(*) count FROM project_operational_write_fences").first("count")).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("rejects duplicate, outside-root and inactive contacts with no partial current or history", async () => {
    const item = await fixture();
    for (const assignments of [
      [{ contactId: item.contactId, role: "project_contact" }, { contactId: item.contactId, role: "project_contact" }],
      [{ contactId: item.otherContactId, role: "site_contact" }],
    ]) await expect(saveProjectOperationalContacts(environment, owner, item.context, item.projectId, {
      expectedContextVersion: item.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(), assignments,
    })).rejects.toMatchObject({ status: expect.any(Number) });
    await database.prepare("UPDATE pa_clients SET active=0 WHERE id=?").bind(item.contactId).run();
    await expect(saveProjectOperationalContacts(environment, owner, item.context, item.projectId, {
      expectedContextVersion: item.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(),
      assignments: [{ contactId: item.contactId, role: "project_contact" }],
    })).rejects.toMatchObject({ status: 409 });
    expect(await database.prepare("SELECT count(*) count FROM project_operational_contact_sets WHERE project_id=?").bind(item.projectId).first("count")).toBe(0);
    expect(await database.prepare("SELECT count(*) count FROM project_operational_contact_revisions WHERE project_id=?").bind(item.projectId).first("count")).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("keeps immutable revisions, rejects stale versions, and rejects reuse of an exhausted service fence", async () => {
    const item = await fixture(), first = { expectedContextVersion: item.context.contextVersion, expectedVersion: 0,
      idempotencyKey: operationKey(), assignments: [{ contactId: item.contactId, role: "project_contact" }] };
    await saveProjectOperationalContacts(environment, owner, item.context, item.projectId, first);
    await expect(saveProjectOperationalContacts(environment, owner, item.context, item.projectId, { ...first, idempotencyKey: operationKey() }))
      .rejects.toMatchObject({ status: 409 });
    await expect(database.prepare("DELETE FROM project_operational_contact_assignments WHERE project_id=?").bind(item.projectId).run()).rejects.toThrow(/current context/);
    await expect(database.prepare("UPDATE project_operational_contact_revisions SET snapshot_json='{}' WHERE project_id=?").bind(item.projectId).run()).rejects.toThrow(/immutable/);
    const set = await database.prepare("SELECT * FROM project_operational_contact_sets WHERE project_id=?").bind(item.projectId).first<Record<string, unknown>>();
    await database.prepare(`INSERT INTO project_operational_write_fences(projection_source_id,project_id,actor_id,permission_key,record_kind,
      root_record_kind,root_id,root_last_sync_id,project_client_id,project_organization_id,project_status,project_last_sync_id,expected_version,
      current_writes,assignment_deletes,assignment_inserts,revision_writes,event_writes,mutation_writes,write_guard)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,0,1)`).bind(source, item.projectId, owner.id, "project.contacts.manage", "contacts", set!.root_record_kind,
      set!.root_id, String(item.context.root.source_version), null, item.context.root.public_id, "active", `project-sync-${sequence}`, 1).run();
    await expect(database.prepare("DELETE FROM project_operational_contact_assignments WHERE project_id=?").bind(item.projectId).run()).rejects.toThrow(/current context/);
    await database.prepare("UPDATE pa_organizations SET last_sync_id='changed-root' WHERE id=?").bind(item.context.root.public_id).run();
    await expect(database.prepare("DELETE FROM project_operational_contact_assignments WHERE project_id=?").bind(item.projectId).run()).rejects.toThrow(/current context/);
    await database.prepare("DELETE FROM project_operational_write_fences WHERE project_id=?").bind(item.projectId).run();
  }, TEST_TIMEOUT_MS);

  it("versions structured memory and requires a protected reason for post-completion amendments", async () => {
    const item = await fixture();
    await saveProjectMemory(environment, owner, item.context, item.projectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: operationKey(), memory: memory() });
    await database.prepare("UPDATE pa_projects SET status='completed',last_sync_id='completed-sync' WHERE id=?").bind(item.projectId).run();
    await expect(saveProjectMemory(environment, owner, item.context, item.projectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 1, idempotencyKey: operationKey(), memory: memory(" revised") })).rejects.toMatchObject({ status: 409 });
    await saveProjectMemory(environment, owner, item.context, item.projectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 1, idempotencyKey: operationKey(), memory: memory(" revised"), amendmentReason: "Client confirmed the final outcome" });
    const workspace = await readProjectOperationalWorkspace(environment, owner, item.context, item.projectId);
    expect(workspace.memory).toMatchObject({ version: 2, snapshot: { plan: "Plan revised" } });
    expect(workspace.memory.revisions[0]).toMatchObject({ changeKind: "post_completion_amendment",
      amendmentReason: "Client confirmed the final outcome" });
    const audit = JSON.stringify((await database.prepare("SELECT details_json FROM project_operational_events WHERE project_id=?")
      .bind(item.projectId).all()).results);
    expect(audit).not.toContain("Client confirmed"); expect(audit).not.toContain("Plan revised");
  }, TEST_TIMEOUT_MS);

  it("fails closed before releasing or saving an overlay after project reassignment", async () => {
    const original = await fixture(), replacement = await fixture();
    await saveProjectOperationalContacts(environment, owner, original.context, original.projectId, {
      expectedContextVersion: original.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(),
      assignments: [{ contactId: original.contactId, role: "project_contact", instructions: "Old owner secret instructions" }],
    });
    await saveProjectMemory(environment, owner, original.context, original.projectId, { expectedContextVersion: original.context.contextVersion,
      expectedVersion: 0, idempotencyKey: operationKey(), memory: { ...memory(), observations: "Old owner secret memory" } });
    await database.prepare("UPDATE pa_projects SET organization_id=?,last_sync_id='reassigned-sync' WHERE id=?")
      .bind(replacement.context.root.public_id, original.projectId).run();
    const reassigned = { ...replacement.context, contextVersion: "r".repeat(43) };
    await expect(readProjectOperationalWorkspace(environment, owner, reassigned, original.projectId)).rejects.toMatchObject({
      status: 409, message: expect.stringContaining("audited administrator reset or transfer"),
    });
    await expect(saveProjectMemory(environment, owner, reassigned, original.projectId, { expectedContextVersion: reassigned.contextVersion,
      expectedVersion: 1, idempotencyKey: operationKey(), memory: memory(" new owner") })).rejects.toMatchObject({ status: 409 });
    await expect(saveProjectOperationalContacts(environment, owner, reassigned, original.projectId, {
      expectedContextVersion: reassigned.contextVersion, expectedVersion: 1, idempotencyKey: operationKey(),
      assignments: [{ contactId: replacement.contactId, role: "project_contact" }],
    })).rejects.toMatchObject({ status: 409 });
    expect(JSON.stringify(await database.prepare("SELECT snapshot_json FROM project_operational_memory WHERE project_id=?")
      .bind(original.projectId).first())).toContain("Old owner secret memory");
  }, TEST_TIMEOUT_MS);

  it("rejects mismatched actor fields under a prepared service fence and excludes arbitrary source status from audit", async () => {
    const item = await fixture(), sensitiveStatus = `client-secret@example.test-${"x".repeat(1500)}`;
    await database.prepare("UPDATE pa_projects SET status=?,last_sync_id='sensitive-status-sync' WHERE id=?")
      .bind(sensitiveStatus, item.projectId).run();
    await saveProjectMemory(environment, owner, item.context, item.projectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: operationKey(), memory: memory() });
    const details = await database.prepare("SELECT details_json FROM project_operational_events WHERE project_id=?")
      .bind(item.projectId).first<string>("details_json");
    expect(details).toBe(JSON.stringify({ schemaVersion: 1, sectionCount: 4 }));
    expect(details).not.toContain("client-secret");
    await database.prepare(`INSERT INTO project_operational_write_fences(projection_source_id,project_id,actor_id,permission_key,record_kind,
      root_record_kind,root_id,root_last_sync_id,project_client_id,project_organization_id,project_status,project_last_sync_id,expected_version,
      current_writes,assignment_deletes,assignment_inserts,revision_writes,event_writes,mutation_writes,write_guard)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,1,0,1)`).bind(source, item.projectId, owner.id, "project.memory.manage", "memory", "organization",
      item.context.root.public_id, `org-sync-${sequence}`, null, item.context.root.public_id, sensitiveStatus, "sensitive-status-sync", 1).run();
    await expect(database.prepare(`INSERT INTO project_operational_events
      (id,projection_source_id,project_id,actor_id,event_kind,result_version,details_json) VALUES(?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), source, item.projectId, "staff-kollins-stirn", "memory_saved", 2, "{}").run())
      .rejects.toThrow(/current context/);
    await database.prepare("DELETE FROM project_operational_write_fences WHERE project_id=?").bind(item.projectId).run();
    await database.prepare(`INSERT INTO project_operational_write_fences(projection_source_id,project_id,actor_id,permission_key,record_kind,
      root_record_kind,root_id,root_last_sync_id,project_client_id,project_organization_id,project_status,project_last_sync_id,expected_version,
      current_writes,assignment_deletes,assignment_inserts,revision_writes,event_writes,mutation_writes,write_guard)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,0,0,0,0,1)`).bind(source, item.projectId, owner.id, "project.memory.manage", "memory", "organization",
      item.context.root.public_id, `org-sync-${sequence}`, null, item.context.root.public_id, sensitiveStatus, "sensitive-status-sync", 1).run();
    await expect(database.prepare(`UPDATE project_operational_memory SET version=version+1,updated_by=?
      WHERE projection_source_id=? AND project_id=? AND version=1`).bind("staff-kollins-stirn", source, item.projectId).run())
      .rejects.toThrow(/current context/);
    await database.prepare("DELETE FROM project_operational_write_fences WHERE project_id=?").bind(item.projectId).run();
  }, TEST_TIMEOUT_MS);

  it("atomically rejects a root change between preflight and the D1 batch", async () => {
    const item = await fixture();
    const raced = raceDatabase(() => database.prepare("UPDATE pa_organizations SET last_sync_id='raced-root' WHERE id=?")
      .bind(item.context.root.public_id).run().then(() => undefined));
    await expect(saveProjectMemory({ OPS_DB: raced } as Pick<Env, "OPS_DB">, owner, item.context, item.projectId, {
      expectedContextVersion: item.context.contextVersion, expectedVersion: 0, idempotencyKey: operationKey(), memory: memory(),
    })).rejects.toMatchObject({ status: 409 });
    expect(await database.prepare("SELECT count(*) count FROM project_operational_memory WHERE project_id=?").bind(item.projectId).first("count")).toBe(0);
    expect(await database.prepare("SELECT count(*) count FROM project_operational_memory_revisions WHERE project_id=?").bind(item.projectId).first("count")).toBe(0);
    expect(await database.prepare("SELECT count(*) count FROM project_operational_write_fences").first("count")).toBe(0);
  }, TEST_TIMEOUT_MS);
});
