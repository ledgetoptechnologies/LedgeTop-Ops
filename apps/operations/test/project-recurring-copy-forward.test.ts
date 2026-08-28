import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { commitRecurringProjectCopy, previewRecurringProjectCopy,
  type PreviewRecurringProjectCopyInput } from "../src/worker/project-recurring-copy-forward";
import { saveProjectMemory, saveProjectOperationalContacts, type ProjectMemorySnapshot } from "../src/worker/project-operational-memory";
import type { ProjectMemorySection } from "../src/worker/project-operational-memory";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const SOURCE = "project-alpha:primary", TIMEOUT = 60_000;
const owner: StaffPrincipal = { id: "staff-beau-koltz", email: "beaukoltz@ledgetopdroneservices.com",
  displayName: "Beau Koltz", accessSubject: "owner", projectAlphaUserId: null };
let runtime: Miniflare, db: D1Database, env: Pick<Env, "OPS_DB">, sequence = 0;
let authorityBefore: unknown;

interface Fixture { context: ClientHubCollectionContext; rootId: string; contactId: string; secondContactId: string;
  sourceProjectId: string; destinationProjectId: string }
const memory = (values: Partial<ProjectMemorySnapshot> = {}): ProjectMemorySnapshot => ({ plan: "", actualOutcome: "",
  deviationsAndReasons: "", observations: "", problems: "", successes: "", recommendations: "", nextTimeRequests: "", ...values });
const key = () => `project_copy_${crypto.randomUUID()}`;

async function authoritySnapshot() {
  const tables = ["staff_users", "staff_role_assignments", "staff_permission_overrides", "pa_application_entitlements",
    "viewer_processing_notification_outbox", "pa_connectors", "pa_clients", "pa_projects"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return result;
}

async function fixture(options: { sourceStatus?: string; destinationStatus?: string; sourceActive?: number;
  destinationActive?: number; sourceId?: string; rootId?: string } = {}): Promise<Fixture> {
  const n = ++sequence, source = options.sourceId ?? SOURCE, rootId = options.rootId ?? `copy-org-${n}`,
    contactId = `copy-contact-${n}`, secondContactId = `copy-contact-two-${n}`,
    sourceProjectId = `copy-source-project-${n}`, destinationProjectId = `copy-destination-project-${n}`;
  for (const [kind, value] of [["organization", rootId], ["client", contactId], ["client", secondContactId],
    ["project", sourceProjectId], ["project", destinationProjectId]]) {
    await db.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
      VALUES(?,?,?,?)`).bind(source, kind, value, value).run();
  }
  await db.batch([
    db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,1,'{}',?,?)")
      .bind(rootId, `Copy Organization ${n}`, `root-sync-${n}`, source),
    db.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,'{}',?,?)")
      .bind(contactId, `Contact ${n}`, rootId, `contact-sync-${n}`, source),
    db.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,'{}',?,?)")
      .bind(secondContactId, `Second ${n}`, rootId, `second-sync-${n}`, source),
    db.prepare("INSERT INTO pa_projects(id,organization_id,name,status,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,?,?,'{}',?,?)")
      .bind(sourceProjectId, rootId, `Prior ${n}`, options.sourceStatus ?? "completed", options.sourceActive ?? 1, `source-sync-${n}`, source),
    db.prepare("INSERT INTO pa_projects(id,organization_id,name,status,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,?,?,'{}',?,?)")
      .bind(destinationProjectId, rootId, `Next ${n}`, options.destinationStatus ?? "not_started", options.destinationActive ?? 1,
        `destination-sync-${n}`, source),
  ]);
  return { rootId, contactId, secondContactId, sourceProjectId, destinationProjectId,
    context: { root: { source_id: source as `project-alpha:${string}`, root_namespace: "business", kind: "organization", public_id: rootId,
      pa_public_id: rootId, mapping_status: "mapped", display_name: `Copy Organization ${n}`, source_name: "Project Alpha",
      sort_name: `copy organization ${n}`, status: "active", portal_status: "none", workspace_id: null,
      legacy_account_id: null, account_count: 0, project_count: 2, request_count: 0, contact_count: 2,
      meaningful_activity_at: null, source_version: `root-sync-${n}`, indexed_at: "2026-08-28T00:00:00.000Z", scan_generation: 1 },
      access: { directory: true, requests: false, delivery: false, viewer: false }, contextVersion: "c".repeat(43),
      canonicalRoot: { sourceId: source, rootNamespace: "business", kind: "organization", publicId: rootId } } };
}

async function seedSource(item: Fixture, options: { sourceInstructions?: string; sourcePlan?: string; destinationInstructions?: string;
  destinationPlan?: string; sourcePreferredContactMethod?: "email" | "phone" | "text" | null;
  destinationPreferredContactMethod?: "email" | "phone" | "text" | null } = {}) {
  let sourceContacts = 0, destinationContacts = 0, sourceMemory = 0, destinationMemory = 0;
  if (options.sourceInstructions !== undefined) {
    await saveProjectOperationalContacts(env, owner, item.context, item.sourceProjectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: key(), assignments: [{ contactId: item.contactId, role: "project_contact",
        preferredContactMethod: options.sourcePreferredContactMethod === undefined ? "email" : options.sourcePreferredContactMethod,
        instructions: options.sourceInstructions }] }); sourceContacts = 1;
  }
  if (options.destinationInstructions !== undefined) {
    await saveProjectOperationalContacts(env, owner, item.context, item.destinationProjectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: key(), assignments: [{ contactId: item.contactId, role: "project_contact",
        preferredContactMethod: options.destinationPreferredContactMethod === undefined ? "phone" : options.destinationPreferredContactMethod,
        instructions: options.destinationInstructions }, { contactId: item.secondContactId,
        role: "site_contact", preferredContactMethod: "phone", instructions: "Destination only" }] }); destinationContacts = 1;
  }
  if (options.sourcePlan !== undefined) {
    await saveProjectMemory(env, owner, item.context, item.sourceProjectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: key(), memory: memory({ plan: options.sourcePlan, observations: "Source observation" }),
      amendmentReason: "Seed completed source memory" }); sourceMemory = 1;
  }
  if (options.destinationPlan !== undefined) {
    await saveProjectMemory(env, owner, item.context, item.destinationProjectId, { expectedContextVersion: item.context.contextVersion,
      expectedVersion: 0, idempotencyKey: key(), memory: memory({ plan: options.destinationPlan, successes: "Destination success" }) }); destinationMemory = 1;
  }
  return { sourceContacts, destinationContacts, sourceMemory, destinationMemory };
}

function request(item: Fixture, state: Awaited<ReturnType<typeof seedSource>>, overrides: Partial<PreviewRecurringProjectCopyInput> = {}): PreviewRecurringProjectCopyInput {
  return { expectedContextVersion: item.context.contextVersion, sourceProjectId: item.sourceProjectId,
    destinationProjectId: item.destinationProjectId, selectedContactRoles: ["project_contact"],
    selectedMemorySections: ["plan", "observations"], conflictPolicy: "keep_destination",
    expected: { sourceProjectRevision: item.context.root.source_version!.replace("root", "source"),
      destinationProjectRevision: item.context.root.source_version!.replace("root", "destination"),
      sourceContactsVersion: state.sourceContacts, destinationContactsVersion: state.destinationContacts,
      sourceMemoryVersion: state.sourceMemory, destinationMemoryVersion: state.destinationMemory }, ...overrides };
}

function racingDatabase(action: () => Promise<void>): D1Database {
  const raw = db, statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>(); let fired = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => { const proxy = new Proxy(statement, { get(target, property) {
    if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } }); statements.set(proxy, statement); return proxy; };
  const proxy = new Proxy(raw, { get(target, property) {
    if (property === "withSession") return () => proxy;
    if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
    if (property === "batch") return async <T>(values: D1PreparedStatement[]) => {
      if (!fired) { fired = true; await action(); }
      return target.batch<T>(values.map(value => statements.get(value) ?? value));
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } }) as D1Database;
  return proxy;
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
    script: "export default {fetch(){return new Response('copy')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database; env = { OPS_DB: db };
  const directory = new URL("../migrations/", import.meta.url);
  for (const filename of readdirSync(directory).filter(name => name.endsWith(".sql") && name < "0043_").sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(filename, directory), "utf8")).map(sql => db.prepare(sql)));
  const populated = await fixture();
  authorityBefore = await authoritySnapshot();
  for (const name of ["0043_project_operational_memory.sql", "0044_project_operational_copy_forward.sql"])
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
  expect(populated.rootId).toBeTruthy();
}, 120_000);
afterAll(async () => { await runtime?.dispose(); });

describe("recurring project operational copy-forward", () => {
  it("migrates populated D1 without inferring records or changing authority", async () => {
    expect(await authoritySnapshot()).toEqual(authorityBefore);
    expect(await db.prepare("SELECT count(*) count FROM project_operational_copy_receipts").first("count")).toBe(0);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, TIMEOUT);

  it("previews deterministically and atomically copies only selected additive values", async () => {
    const item = await fixture(), state = await seedSource(item, { sourceInstructions: "Source instruction", sourcePlan: "Source plan",
      destinationInstructions: "Destination instruction", destinationPlan: "Destination plan" });
    const input = request(item, state), first = await previewRecurringProjectCopy(env, owner, item.context, input),
      second = await previewRecurringProjectCopy(env, owner, item.context, input);
    expect(second).toEqual(first);
    expect(first.changes).toMatchObject({ contactsChanged: false, memoryChanged: true, copiedContacts: 0,
      contactConflicts: 1, memoryConflicts: ["plan"], copiedMemorySections: ["observations"] });
    const idempotencyKey = key(), before = await authoritySnapshot();
    const saved = await commitRecurringProjectCopy(env, owner, item.context, { ...input,
      previewFingerprint: first.fingerprint, idempotencyKey });
    expect(saved.replayed).toBe(false);
    expect((await commitRecurringProjectCopy(env, owner, item.context, { ...input,
      previewFingerprint: first.fingerprint, idempotencyKey })).replayed).toBe(true);
    const destinationMemory = JSON.parse((await db.prepare("SELECT snapshot_json FROM project_operational_memory WHERE project_id=?")
      .bind(item.destinationProjectId).first<string>("snapshot_json"))!);
    expect(destinationMemory).toMatchObject({ plan: "Destination plan", observations: "Source observation", successes: "Destination success" });
    expect(await authoritySnapshot()).toEqual(before);
    const receipt = await db.prepare("SELECT * FROM project_operational_copy_receipts WHERE destination_project_id=?")
      .bind(item.destinationProjectId).first<Record<string, unknown>>();
    expect(JSON.stringify(receipt)).not.toContain("Source plan");
    await expect(db.prepare("UPDATE project_operational_copy_receipts SET copied_contact_count=9 WHERE destination_project_id=?")
      .bind(item.destinationProjectId).run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM project_operational_copy_receipts WHERE destination_project_id=?")
      .bind(item.destinationProjectId).run()).rejects.toThrow(/immutable/);
  }, TIMEOUT);

  it("replaces conflicts only when explicitly selected and preserves destination-only data", async () => {
    const item = await fixture(), state = await seedSource(item, { sourceInstructions: "Use source", sourcePlan: "Use source plan",
      destinationInstructions: "Keep me unless replaced", destinationPlan: "Keep plan unless replaced" });
    const input = request(item, state, { conflictPolicy: "replace_source" });
    const preview = await previewRecurringProjectCopy(env, owner, item.context, input);
    await commitRecurringProjectCopy(env, owner, item.context, { ...input, previewFingerprint: preview.fingerprint, idempotencyKey: key() });
    const contacts = (await db.prepare(`SELECT contact_id,role,instructions FROM project_operational_contact_assignments
      WHERE project_id=? ORDER BY sort_order`).bind(item.destinationProjectId).all()).results;
    expect(contacts).toEqual([{ contact_id: item.contactId, role: "project_contact", instructions: "Use source" },
      { contact_id: item.secondContactId, role: "site_contact", instructions: "Destination only" }]);
    expect(JSON.parse((await db.prepare("SELECT snapshot_json FROM project_operational_memory WHERE project_id=?")
      .bind(item.destinationProjectId).first<string>("snapshot_json"))!)).toMatchObject({ plan: "Use source plan", successes: "Destination success" });
  }, TIMEOUT);

  it("preserves populated destination contact fields when the explicit replacement source field is empty", async () => {
    const nullMethod = await fixture(), nullState = await seedSource(nullMethod, { sourceInstructions: "Use source instructions",
      sourcePreferredContactMethod: null, destinationInstructions: "Old destination instructions" });
    const nullInput = request(nullMethod, nullState, { selectedMemorySections: [], conflictPolicy: "replace_source" }),
      nullPreview = await previewRecurringProjectCopy(env, owner, nullMethod.context, nullInput);
    await commitRecurringProjectCopy(env, owner, nullMethod.context, { ...nullInput,
      previewFingerprint: nullPreview.fingerprint, idempotencyKey: key() });
    expect(await db.prepare(`SELECT preferred_contact_method,instructions FROM project_operational_contact_assignments
      WHERE project_id=? AND contact_id=? AND role='project_contact'`).bind(nullMethod.destinationProjectId, nullMethod.contactId).first())
      .toEqual({ preferred_contact_method: "phone", instructions: "Use source instructions" });

    const blankInstructions = await fixture(), blankState = await seedSource(blankInstructions, { sourceInstructions: "   ",
      sourcePreferredContactMethod: "email", destinationInstructions: "Keep destination instructions" });
    const blankInput = request(blankInstructions, blankState, { selectedMemorySections: [], conflictPolicy: "replace_source" }),
      blankPreview = await previewRecurringProjectCopy(env, owner, blankInstructions.context, blankInput);
    await commitRecurringProjectCopy(env, owner, blankInstructions.context, { ...blankInput,
      previewFingerprint: blankPreview.fingerprint, idempotencyKey: key() });
    expect(await db.prepare(`SELECT preferred_contact_method,instructions FROM project_operational_contact_assignments
      WHERE project_id=? AND contact_id=? AND role='project_contact'`).bind(blankInstructions.destinationProjectId, blankInstructions.contactId).first())
      .toEqual({ preferred_contact_method: "email", instructions: "Keep destination instructions" });
  }, TIMEOUT);

  it("never lets an empty source clear a destination and records an identical no-op", async () => {
    const item = await fixture(), state = await seedSource(item, { destinationInstructions: "Stay", destinationPlan: "Stay" });
    const input = request(item, state), preview = await previewRecurringProjectCopy(env, owner, item.context, input);
    expect(preview.changes).toMatchObject({ contactsChanged: false, memoryChanged: false, copiedContacts: 0, copiedMemorySections: [] });
    const saved = await commitRecurringProjectCopy(env, owner, item.context, { ...input,
      previewFingerprint: preview.fingerprint, idempotencyKey: key() });
    expect(saved.destination).toMatchObject({ contactsVersionAfter: 1, memoryVersionAfter: 1 });
  }, TIMEOUT);

  it("fails closed when a no-op destination overlay advances immediately before the atomic batch", async () => {
    const contact = await fixture(), contactState = await seedSource(contact, { sourceInstructions: "Same",
      sourcePreferredContactMethod: "email", destinationInstructions: "Same", destinationPreferredContactMethod: "email" });
    const contactInput = request(contact, contactState, { selectedMemorySections: [] }),
      contactPreview = await previewRecurringProjectCopy(env, owner, contact.context, contactInput), contactKey = key();
    expect(contactPreview.changes.contactsChanged).toBe(false);
    const contactRace = racingDatabase(async () => {
      await saveProjectOperationalContacts(env, owner, contact.context, contact.destinationProjectId, {
        expectedContextVersion: contact.context.contextVersion, expectedVersion: 1, idempotencyKey: key(), assignments: [
          { contactId: contact.contactId, role: "project_contact", preferredContactMethod: "email", instructions: "Same" },
          { contactId: contact.secondContactId, role: "site_contact", preferredContactMethod: "phone", instructions: "Destination only" },
        ] });
    });
    await expect(commitRecurringProjectCopy({ OPS_DB: contactRace }, owner, contact.context, { ...contactInput,
      previewFingerprint: contactPreview.fingerprint, idempotencyKey: contactKey })).rejects.toMatchObject({ status: 409 });
    expect(await db.prepare("SELECT count(*) count FROM project_operational_copy_receipts WHERE actor_id=? AND idempotency_key=?")
      .bind(owner.id, contactKey).first("count")).toBe(0);

    const memoryItem = await fixture(), memoryState = await seedSource(memoryItem, { sourcePlan: "Same plan", destinationPlan: "Same plan" });
    const memoryInput = request(memoryItem, memoryState, { selectedContactRoles: [], selectedMemorySections: ["plan"] }),
      memoryPreview = await previewRecurringProjectCopy(env, owner, memoryItem.context, memoryInput), memoryKey = key();
    expect(memoryPreview.changes.memoryChanged).toBe(false);
    const memoryRace = racingDatabase(async () => {
      await saveProjectMemory(env, owner, memoryItem.context, memoryItem.destinationProjectId, {
        expectedContextVersion: memoryItem.context.contextVersion, expectedVersion: 1, idempotencyKey: key(),
        memory: memory({ plan: "Same plan", successes: "Destination success", recommendations: "Concurrent update" }) });
    });
    await expect(commitRecurringProjectCopy({ OPS_DB: memoryRace }, owner, memoryItem.context, { ...memoryInput,
      previewFingerprint: memoryPreview.fingerprint, idempotencyKey: memoryKey })).rejects.toMatchObject({ status: 409 });
    expect(await db.prepare("SELECT count(*) count FROM project_operational_copy_receipts WHERE actor_id=? AND idempotency_key=?")
      .bind(owner.id, memoryKey).first("count")).toBe(0);
  }, TIMEOUT);

  it("fails closed for self-copy, wrong roots/sources, inactive and terminal destinations", async () => {
    const item = await fixture(), state = await seedSource(item, { sourcePlan: "Plan" }), base = request(item, state);
    await expect(previewRecurringProjectCopy(env, owner, item.context, { ...base, destinationProjectId: item.sourceProjectId }))
      .rejects.toMatchObject({ status: 400 });
    await expect(previewRecurringProjectCopy(env, owner, item.context, { ...base, expectedContextVersion: "x".repeat(43) }))
      .rejects.toMatchObject({ status: 409 });
    for (const options of [{ rootId: `other-root-${sequence}` }, { sourceId: `project-alpha:other-${sequence}` },
      { destinationStatus: "completed" }, { destinationActive: 0 }, { sourceActive: 0 }]) {
      const other = await fixture(options), otherState = options.sourceId || options.rootId || options.destinationActive === 0 || options.sourceActive === 0
        ? { sourceContacts: 0, destinationContacts: 0, sourceMemory: 0, destinationMemory: 0 }
        : await seedSource(other, { sourcePlan: "Other" });
      await expect(previewRecurringProjectCopy(env, owner, item.context, { ...request(other, otherState),
        expectedContextVersion: item.context.contextVersion })).rejects.toBeTruthy();
    }
  }, TIMEOUT);

  it("requires each selected purpose permission and honors explicit denies", async () => {
    const item = await fixture(), state = await seedSource(item, { sourceInstructions: "Copy", sourcePlan: "Plan" }), base = request(item, state);
    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,scope,effect,scope_key,created_by)
      VALUES(?,?,?,?,?,?,?)`).bind(`deny-copy-${sequence}`, owner.id, "project.memory.manage", "global", "deny", "global", owner.id).run();
    await expect(previewRecurringProjectCopy(env, owner, item.context, base)).rejects.toMatchObject({ status: 403 });
    const contactsOnly = { ...base, selectedMemorySections: [] as ProjectMemorySection[] };
    await expect(previewRecurringProjectCopy(env, owner, item.context, contactsOnly)).resolves.toBeTruthy();
    await db.prepare("DELETE FROM staff_permission_overrides WHERE id=?").bind(`deny-copy-${sequence}`).run();
  }, TIMEOUT);

  it("rejects stale previews, project races, and selected contact movement", async () => {
    const stale = await fixture(), staleState = await seedSource(stale, { sourcePlan: "Plan" }), staleInput = request(stale, staleState),
      stalePreview = await previewRecurringProjectCopy(env, owner, stale.context, staleInput);
    await saveProjectMemory(env, owner, stale.context, stale.destinationProjectId, { expectedContextVersion: stale.context.contextVersion,
      expectedVersion: 0, idempotencyKey: key(), memory: memory({ recommendations: "New" }) });
    await expect(commitRecurringProjectCopy(env, owner, stale.context, { ...staleInput,
      previewFingerprint: stalePreview.fingerprint, idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });

    const moved = await fixture(), movedState = await seedSource(moved, { sourceInstructions: "Move" }), movedInput = request(moved, movedState,
      { selectedMemorySections: [] }), movedPreview = await previewRecurringProjectCopy(env, owner, moved.context, movedInput);
    await db.prepare("UPDATE pa_clients SET organization_id=NULL,last_sync_id=last_sync_id||'-moved' WHERE id=?")
      .bind(moved.contactId).run();
    await expect(commitRecurringProjectCopy(env, owner, moved.context, { ...movedInput,
      previewFingerprint: movedPreview.fingerprint, idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });

    const raced = await fixture(), racedState = await seedSource(raced, { sourcePlan: "Race" }), racedInput = request(raced, racedState,
      { selectedContactRoles: [] }), racedPreview = await previewRecurringProjectCopy(env, owner, raced.context, racedInput);
    const racingDb = racingDatabase(async () => { await db.prepare("UPDATE pa_projects SET last_sync_id=last_sync_id||'-race' WHERE id=?")
      .bind(raced.destinationProjectId).run(); });
    await expect(commitRecurringProjectCopy({ OPS_DB: racingDb }, owner, raced.context, { ...racedInput,
      previewFingerprint: racedPreview.fingerprint, idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });
  }, TIMEOUT);

  it("rolls back both overlays when the final receipt cannot be written and rejects key reuse", async () => {
    const item = await fixture(), state = await seedSource(item, { sourceInstructions: "Atomic", sourcePlan: "Atomic" }), input = request(item, state),
      preview = await previewRecurringProjectCopy(env, owner, item.context, input), idempotencyKey = key();
    await db.prepare(`CREATE TRIGGER test_copy_receipt_abort BEFORE INSERT ON project_operational_copy_receipts
      BEGIN SELECT RAISE(ABORT,'forced receipt failure'); END`).run();
    await expect(commitRecurringProjectCopy(env, owner, item.context, { ...input,
      previewFingerprint: preview.fingerprint, idempotencyKey })).rejects.toBeTruthy();
    await db.prepare("DROP TRIGGER test_copy_receipt_abort").run();
    expect(await db.prepare("SELECT count(*) count FROM project_operational_contact_sets WHERE project_id=?")
      .bind(item.destinationProjectId).first("count")).toBe(0);
    expect(await db.prepare("SELECT count(*) count FROM project_operational_memory WHERE project_id=?")
      .bind(item.destinationProjectId).first("count")).toBe(0);
    await commitRecurringProjectCopy(env, owner, item.context, { ...input, previewFingerprint: preview.fingerprint, idempotencyKey });
    await expect(commitRecurringProjectCopy(env, owner, item.context, { ...input, conflictPolicy: "replace_source",
      previewFingerprint: preview.fingerprint, idempotencyKey })).rejects.toMatchObject({ status: 409 });
  }, TIMEOUT);

  it("binds idempotent replay to the receipt's original exact canonical root", async () => {
    const item = await fixture(), state = await seedSource(item, { sourcePlan: "Copy once" }), input = request(item, state,
      { selectedContactRoles: [] }), preview = await previewRecurringProjectCopy(env, owner, item.context, input), idempotencyKey = key();
    await commitRecurringProjectCopy(env, owner, item.context, { ...input, previewFingerprint: preview.fingerprint, idempotencyKey });
    const reassignedRoot = `copy-reassigned-org-${sequence}`;
    await db.batch([
      db.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id)
        VALUES(?,?,?,?)`).bind(SOURCE, "organization", reassignedRoot, reassignedRoot),
      db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,1,'{}',?,?)")
        .bind(reassignedRoot, "Reassigned Organization", `reassigned-sync-${sequence}`, SOURCE),
      db.prepare("UPDATE pa_projects SET organization_id=? WHERE id IN (?,?)")
        .bind(reassignedRoot, item.sourceProjectId, item.destinationProjectId),
    ]);
    const reassignedContext: ClientHubCollectionContext = { ...item.context, root: { ...item.context.root,
      public_id: reassignedRoot, pa_public_id: reassignedRoot, display_name: "Reassigned Organization",
      source_version: `reassigned-sync-${sequence}` }, canonicalRoot: { ...item.context.canonicalRoot, publicId: reassignedRoot } };
    await expect(commitRecurringProjectCopy(env, owner, reassignedContext, { ...input,
      previewFingerprint: preview.fingerprint, idempotencyKey })).rejects.toMatchObject({ status: 409 });
  }, TIMEOUT);
});
