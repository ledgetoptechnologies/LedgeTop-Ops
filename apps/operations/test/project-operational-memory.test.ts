import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { guardedFence, prepareProject, projectGuard, readProjectOperationalWorkspace, saveProjectMemory, saveProjectOperationalContacts,
  type ProjectMemorySnapshot } from "../src/worker/project-operational-memory";
import { cleanupProjectMemoryAttachmentUploads, serveProjectMemoryAttachment, uploadProjectMemoryAttachment }
  from "../src/worker/project-memory-attachments";
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
class AttachmentBucket {
  objects = new Map<string, { bytes: Uint8Array; etag: string; httpEtag: string; size: number;
    customMetadata: Record<string, string>; httpMetadata: R2HTTPMetadata | Headers }>();
  heads = 0; gets = 0; deletes = 0; bodyless = false;
  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptions): Promise<R2Object | null> {
    if (options?.onlyIf && "etagDoesNotMatch" in options.onlyIf && options.onlyIf.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value)
      : typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    const etag = `raw-${crypto.randomUUID()}`, item = { bytes: new Uint8Array(bytes), etag, httpEtag: `"${etag}"`, size: bytes.byteLength,
      customMetadata: options?.customMetadata ?? {}, httpMetadata: options?.httpMetadata ?? {} };
    this.objects.set(key, item); return item as unknown as R2Object;
  }
  async head(key: string): Promise<R2Object | null> { this.heads += 1; return (this.objects.get(key) ?? null) as unknown as R2Object | null; }
  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | R2Object | null> {
    this.gets += 1; const item = this.objects.get(key); if (!item) return null;
    if (this.bodyless || (options?.onlyIf && "etagMatches" in options.onlyIf && options.onlyIf.etagMatches !== item.etag))
      return item as unknown as R2Object;
    const range = options?.range && "offset" in options.range && typeof options.range.offset === "number"
      && typeof options.range.length === "number" ? { offset: options.range.offset, length: options.range.length } : null;
    const bytes = range ? item.bytes.slice(range.offset, range.offset + range.length) : item.bytes;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return { ...item, body: new Blob([buffer]).stream(), bodyUsed: false, arrayBuffer: async () => buffer,
      text: async () => new TextDecoder().decode(bytes), json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      blob: async () => new Blob([buffer]) } as unknown as R2ObjectBody;
  }
  async delete(key: string): Promise<void> { this.deletes += 1; this.objects.delete(key); }
}
let runtime: Miniflare, database: D1Database, bucket: AttachmentBucket,
  environment: Pick<Env, "OPS_DB" | "DATA_BUCKET">, sequence = 0;
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
function jpeg(seed = 1): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, seed, 1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xd9]);
}
function uploadRequest(item: Fixture, expectedVersion: number, key: string, bytes: Uint8Array,
  name = "field-note.jpg", contentType = "image/jpeg", reason?: string): Request {
  const headers: Record<string, string> = { "Content-Type": contentType, "X-Expected-Context-Version": item.context.contextVersion,
    "X-Expected-Version": String(expectedVersion), "X-Idempotency-Key": key, "X-File-Name": encodeURIComponent(name) };
  if (reason) headers["X-Amendment-Reason"] = reason;
  return new Request("https://ops.example.test/upload", { method: "POST", headers,
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer });
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
    script: "export default {fetch(){return new Response('memory')}}", d1Databases: ["OPS_DB"] });
  database = await runtime.getD1Database("OPS_DB") as D1Database; bucket = new AttachmentBucket();
  environment = { OPS_DB: database, DATA_BUCKET: bucket as unknown as R2Bucket };
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
  await database.batch(splitD1MigrationStatements(readFileSync(new URL("0047_project_memory_staff_attachments.sql", directory), "utf8"))
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
    expect(workspace.project.revision).toMatch(/^project-sync-/);
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
    await database.prepare("UPDATE project_operational_write_fences SET event_writes=0 WHERE project_id=?").bind(item.projectId).run();
    await database.prepare("DELETE FROM project_operational_write_fences WHERE project_id=?").bind(item.projectId).run();
    await database.prepare(`INSERT INTO project_operational_write_fences(projection_source_id,project_id,actor_id,permission_key,record_kind,
      root_record_kind,root_id,root_last_sync_id,project_client_id,project_organization_id,project_status,project_last_sync_id,expected_version,
      current_writes,assignment_deletes,assignment_inserts,revision_writes,event_writes,mutation_writes,write_guard)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,0,0,0,0,1)`).bind(source, item.projectId, owner.id, "project.memory.manage", "memory", "organization",
      item.context.root.public_id, `org-sync-${sequence}`, null, item.context.root.public_id, sensitiveStatus, "sensitive-status-sync", 1).run();
    await expect(database.prepare(`UPDATE project_operational_memory SET version=version+1,updated_by=?
      WHERE projection_source_id=? AND project_id=? AND version=1`).bind("staff-kollins-stirn", source, item.projectId).run())
      .rejects.toThrow(/current context/);
    await database.prepare("UPDATE project_operational_write_fences SET current_writes=0 WHERE project_id=?").bind(item.projectId).run();
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

  it("uploads a verified opaque staff attachment exactly once and returns only public metadata", async () => {
    const item = await fixture(), key = operationKey(), bytes = jpeg();
    const result = await uploadProjectMemoryAttachment(environment, owner, item.context, item.projectId,
      uploadRequest(item, 0, key, bytes, "现场 résumé's.jpg"));
    expect(result).toMatchObject({ sourceId: source, projectId: item.projectId, version: 1, replayed: false,
      attachment: { name: "现场 résumé's.jpg", contentType: "image/jpeg", size: bytes.length, sourceKind: "staff_upload", versionAdded: 1 } });
    expect(JSON.stringify(result)).not.toMatch(/sha256|object_key|objectKey|etag/i);
    const stored = await database.prepare("SELECT object_key,object_etag,sha256 FROM project_memory_attachments WHERE id=?")
      .bind(result.attachment.id).first<{ object_key: string; object_etag: string; sha256: string }>();
    expect(stored?.object_key).toMatch(/^_ltds\/ProjectMemory\/[0-9a-f-]+\/content$/);
    expect(stored?.object_key).not.toContain("résumé");
    const workspace = await readProjectOperationalWorkspace(environment, owner, item.context, item.projectId);
    expect(workspace.memory.attachments).toEqual([result.attachment]);
    expect(JSON.stringify(workspace.memory.attachments)).not.toMatch(/sha256|object_key|objectKey|etag/i);
    await expect(uploadProjectMemoryAttachment(environment, owner, item.context, item.projectId,
      uploadRequest(item, 0, key, bytes, "现场 résumé's.jpg"))).resolves.toEqual({ ...result, replayed: true });
    await expect(uploadProjectMemoryAttachment(environment, owner, item.context, item.projectId,
      uploadRequest(item, 0, key, jpeg(2), "现场 résumé's.jpg"))).rejects.toMatchObject({ status: 409 });
    expect(await database.prepare("SELECT count(*) count FROM project_memory_attachments WHERE project_id=?")
      .bind(item.projectId).first("count")).toBe(1);
    const persisted = JSON.stringify((await database.prepare(`SELECT details_json FROM project_memory_attachment_events WHERE project_id=?
      UNION ALL SELECT result_json FROM project_memory_attachment_mutations WHERE project_id=?`).bind(item.projectId, item.projectId).all()).results);
    expect(persisted).not.toMatch(/résumé|object|etag|sha256/i);
  }, TEST_TIMEOUT_MS);

  it("serves authorized HEAD and ranges with pinned metadata and rejects a bodyless R2 precondition result", async () => {
    const item = await fixture(), result = await uploadProjectMemoryAttachment(environment, owner, item.context, item.projectId,
      uploadRequest(item, 0, operationKey(), jpeg(), "résumé's.jpg"));
    const head = await serveProjectMemoryAttachment(environment, owner, item.context, item.projectId, result.attachment.id,
      new Request("https://ops.example.test/content", { method: "HEAD" }));
    expect(head.status).toBe(200); expect(head.headers.get("Content-Length")).toBe(String(jpeg().length));
    expect(head.headers.get("Content-Disposition")).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%27s.jpg");
    expect(head.headers.get("Cache-Control")).toBe("private, no-store"); expect(head.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const range = await serveProjectMemoryAttachment(environment, owner, item.context, item.projectId, result.attachment.id,
      new Request("https://ops.example.test/content", { headers: { Range: "bytes=2-5" } }));
    expect(range.status).toBe(206); expect(new Uint8Array(await range.arrayBuffer())).toEqual(jpeg().slice(2, 6));
    bucket.bodyless = true;
    await expect(serveProjectMemoryAttachment(environment, owner, item.context, item.projectId, result.attachment.id,
      new Request("https://ops.example.test/content"))).rejects.toMatchObject({ status: 409 });
    bucket.bodyless = false;
    const before = bucket.heads;
    await expect(serveProjectMemoryAttachment(environment, owner, item.context, "sibling-project", result.attachment.id,
      new Request("https://ops.example.test/content"))).rejects.toMatchObject({ status: 404 });
    expect(bucket.heads).toBe(before);
  }, TEST_TIMEOUT_MS);

  it("rejects unauthorized/stale calls before reading bodies and rejects hostile or mismatched content", async () => {
    const item = await fixture(); let pulls = 0; const deniedKey = operationKey();
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(jpeg()); controller.close(); } });
    const request = uploadRequest(item, 0, deniedKey, jpeg());
    const guarded = new Request(request.url, { method: "POST", headers: request.headers, body: stream, duplex: "half" } as RequestInit);
    const objectsBefore = bucket.objects.size;
    await expect(uploadProjectMemoryAttachment(environment, { ...owner, id: "staff-kollins-stirn" }, item.context, item.projectId, guarded))
      .rejects.toMatchObject({ status: 403 });
    expect(bucket.objects.size).toBe(objectsBefore);
    expect(await database.prepare("SELECT count(*) count FROM project_memory_attachment_upload_intents WHERE idempotency_key=?")
      .bind(deniedKey).first("count")).toBe(0);
    await saveProjectMemory(environment, owner, item.context, item.projectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: operationKey(), memory: memory() });
    pulls = 0;
    const stale = new Request(request.url, { method: "POST", headers: request.headers,
      body: new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(jpeg()); controller.close(); } }), duplex: "half" } as RequestInit);
    const staleObjects = bucket.objects.size;
    await expect(uploadProjectMemoryAttachment(environment, owner, item.context, item.projectId, stale)).rejects.toMatchObject({ status: 409 });
    expect(bucket.objects.size).toBe(staleObjects);
    expect(await database.prepare("SELECT count(*) count FROM project_memory_attachment_upload_intents WHERE idempotency_key=?")
      .bind(deniedKey).first("count")).toBe(0);
    const fresh = await fixture();
    await expect(uploadProjectMemoryAttachment(environment, owner, fresh.context, fresh.projectId,
      uploadRequest(fresh, 0, operationKey(), new TextEncoder().encode("<svg><script>alert(1)</script></svg>"), "note.jpg")))
      .rejects.toMatchObject({ status: 415 });
    await expect(uploadProjectMemoryAttachment(environment, owner, fresh.context, fresh.projectId,
      uploadRequest(fresh, 0, operationKey(), jpeg(), "note.png", "image/png"))).rejects.toMatchObject({ status: 415 });
    await expect(uploadProjectMemoryAttachment(environment, owner, fresh.context, fresh.projectId,
      uploadRequest(fresh, 0, operationKey(), jpeg(), "safe\u202Egpj.jpg"))).rejects.toMatchObject({ status: 400 });
  }, TEST_TIMEOUT_MS);

  it("enforces terminal amendment reasons and the atomic pending-upload budget", async () => {
    const terminalItem = await fixture("completed");
    await expect(uploadProjectMemoryAttachment(environment, owner, terminalItem.context, terminalItem.projectId,
      uploadRequest(terminalItem, 0, operationKey(), jpeg()))).rejects.toMatchObject({ status: 409 });
    await expect(uploadProjectMemoryAttachment(environment, owner, terminalItem.context, terminalItem.projectId,
      uploadRequest(terminalItem, 0, operationKey(), jpeg(), "amend.jpg", "image/jpeg", "Post-completion field evidence")))
      .resolves.toMatchObject({ version: 1 });

    const item = await fixture();
    for (let index = 0; index < 5; index += 1) await database.prepare(`INSERT INTO project_memory_attachment_upload_intents
      (actor_id,idempotency_key,request_fingerprint,projection_source_id,project_id,root_record_kind,root_id,attachment_id,object_key,
       display_name,content_type,size_bytes,sha256,expected_context_version,expected_memory_version,status)
      VALUES(?,?,?,?,?,'organization',?,?,?,?, 'image/jpeg',?,?,?,0,'prepared')`)
      .bind(owner.id, `pending_${crypto.randomUUID()}`, "a".repeat(64), source, item.projectId, item.context.root.public_id,
        crypto.randomUUID(), `_ltds/ProjectMemory/${crypto.randomUUID()}/content`, `pending-${index}.jpg`, 1024, "b".repeat(64), item.context.contextVersion).run();
    const puts = bucket.objects.size;
    await expect(uploadProjectMemoryAttachment(environment, owner, item.context, item.projectId,
      uploadRequest(item, 0, operationKey(), jpeg()))).rejects.toMatchObject({ status: 429 });
    expect(bucket.objects.size).toBe(puts);
    await database.prepare(`UPDATE project_memory_attachment_upload_intents SET updated_at=datetime('now','-2 hours')
      WHERE project_id=? AND status='prepared'`).bind(item.projectId).run();
    await expect(uploadProjectMemoryAttachment(environment, owner, item.context, item.projectId,
      uploadRequest(item, 0, operationKey(), jpeg(), "after-recovery.jpg"))).resolves.toMatchObject({ version: 1 });
  }, TEST_TIMEOUT_MS);

  it("schedules ambiguous precommit objects for reference-safe cleanup and never deletes committed bytes", async () => {
    const item = await fixture(), raced = raceDatabase(() => database.prepare("UPDATE pa_organizations SET last_sync_id='attachment-race' WHERE id=?")
      .bind(item.context.root.public_id).run().then(() => undefined));
    await expect(uploadProjectMemoryAttachment({ OPS_DB: raced, DATA_BUCKET: bucket as unknown as R2Bucket }, owner,
      item.context, item.projectId, uploadRequest(item, 0, operationKey(), jpeg()))).rejects.toMatchObject({ status: 409 });
    const orphan = await database.prepare(`SELECT object_key,status FROM project_memory_attachment_upload_intents
      WHERE project_id=?`).bind(item.projectId).first<{ object_key: string; status: string }>();
    expect(orphan?.status).toBe("cleanup_pending"); expect(bucket.objects.has(orphan!.object_key)).toBe(true);
    await cleanupProjectMemoryAttachmentUploads(environment, 10);
    expect(bucket.objects.has(orphan!.object_key)).toBe(false);

    const committedItem = await fixture(), committed = await uploadProjectMemoryAttachment(environment, owner, committedItem.context,
      committedItem.projectId, uploadRequest(committedItem, 0, operationKey(), jpeg()));
    const objectKey = await database.prepare("SELECT object_key FROM project_memory_attachments WHERE id=?")
      .bind(committed.attachment.id).first<string>("object_key");
    await expect(database.prepare(`UPDATE project_memory_attachment_upload_intents SET status='cleanup_pending'
      WHERE attachment_id=?`).bind(committed.attachment.id).run()).rejects.toThrow(/transition|current context/);
    await cleanupProjectMemoryAttachmentUploads(environment, 10);
    expect(bucket.objects.has(objectKey!)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it("rejects oversized chunked input and direct SQL stage, provenance, and intent-state bypasses", async () => {
    const item = await fixture(), request = uploadRequest(item, 0, operationKey(), jpeg());
    const oversized = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(20 * 1024 * 1024)); controller.enqueue(new Uint8Array(6 * 1024 * 1024)); controller.close();
    } });
    await expect(uploadProjectMemoryAttachment(environment, owner, item.context, item.projectId,
      new Request(request.url, { method: "POST", headers: request.headers, body: oversized, duplex: "half" } as RequestInit)))
      .rejects.toMatchObject({ status: 413 });
    await expect(database.prepare(`INSERT INTO project_memory_attachment_upload_intents
      (actor_id,idempotency_key,request_fingerprint,projection_source_id,project_id,root_record_kind,root_id,attachment_id,object_key,
       display_name,content_type,size_bytes,sha256,expected_context_version,expected_memory_version,status,object_etag)
      VALUES(?,?,?,?,?,'organization',?,?,?,?, 'image/jpeg',?,?,?,0,'completed','forged')`).bind(owner.id, operationKey(), "a".repeat(64), source,
        item.projectId, item.context.root.public_id, crypto.randomUUID(), `_ltds/ProjectMemory/${crypto.randomUUID()}/content`, "forged.jpg", 10,
        "b".repeat(64), item.context.contextVersion).run()).rejects.toThrow(/start prepared/);
    await expect(database.prepare(`INSERT INTO project_memory_attachment_events
      (id,projection_source_id,project_id,attachment_id,actor_id,event_kind,result_version,details_json)
      VALUES(?,?,?,?,?,'attachment_added',1,?)`).bind(crypto.randomUUID(), source, item.projectId, crypto.randomUUID(), owner.id,
        JSON.stringify({ schemaVersion: 1, sourceKind: "staff_upload", size: 1, object_key: "secret" })).run()).rejects.toThrow();

    const directKey = operationKey(), directAttachment = crypto.randomUUID(), directEtag = `raw-${crypto.randomUUID()}`;
    await database.batch([
      database.prepare(`INSERT INTO project_memory_attachment_upload_intents
        (actor_id,idempotency_key,request_fingerprint,projection_source_id,project_id,root_record_kind,root_id,attachment_id,object_key,
         display_name,content_type,size_bytes,sha256,expected_context_version,expected_memory_version,status)
        VALUES(?,?,?,?,?,'organization',?,?,?,?, 'image/jpeg',?,?,?,0,'prepared')`)
        .bind(owner.id, directKey, "c".repeat(64), source, item.projectId, item.context.root.public_id, directAttachment,
          `_ltds/ProjectMemory/${directAttachment}/content`, "direct.jpg", jpeg().byteLength, "d".repeat(64), item.context.contextVersion),
      database.prepare(`UPDATE project_memory_attachment_upload_intents SET status='object_written',object_etag=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE actor_id=? AND idempotency_key=?`)
        .bind(directEtag, owner.id, directKey),
    ]);
    const directPrepared = await prepareProject(environment, owner, item.context, item.projectId, "project.memory.manage");
    const directGuard = projectGuard(directPrepared, owner, "project.memory.manage", 0, "project_operational_memory");
    await expect(database.batch([
      guardedFence(database, directPrepared, owner, "project.memory.manage", "memory", 0, 0, 0, directGuard, 1, 0, 0),
      database.prepare(`INSERT INTO project_memory_attachment_write_fences
        (projection_source_id,project_id,actor_id,idempotency_key,attachment_id,root_record_kind,root_id,expected_memory_version,incoming_size_bytes,
         memory_writes,revision_writes,attachment_writes,event_writes,mutation_writes,intent_writes,write_guard)
        VALUES(?,?,?,?,?,'organization',?,0,?,1,1,1,1,1,1,1)`)
        .bind(source, item.projectId, owner.id, directKey, directAttachment, item.context.root.public_id, jpeg().byteLength),
      database.prepare(`UPDATE project_memory_attachment_write_fences SET memory_writes=0
        WHERE projection_source_id=? AND project_id=?`).bind(source, item.projectId),
    ])).rejects.toThrow(/fence transition/);
    expect(await database.prepare("SELECT count(*) count FROM project_memory_attachment_write_fences WHERE project_id=?")
      .bind(item.projectId).first("count")).toBe(0);
    expect(await database.prepare("SELECT count(*) count FROM project_operational_write_fences WHERE project_id=?")
      .bind(item.projectId).first("count")).toBe(0);
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 60_000);
});
