import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { registerCrmSyntheticImportRoutes } from "../src/worker/crm-synthetic-import";
import type { Env, StaffPrincipal } from "../src/worker/types";

const owner: StaffPrincipal = { id: "crm-owner", email: "owner@example.test", displayName: "Synthetic Owner", accessSubject: "owner", projectAlphaUserId: null };
const admin: StaffPrincipal = { id: "crm-admin", email: "admin@example.test", displayName: "Synthetic Admin", accessSubject: "admin", projectAlphaUserId: null };
const operator: StaffPrincipal = { id: "crm-operator", email: "operator@example.test", displayName: "Synthetic Operator", accessSubject: "operator", projectAlphaUserId: null };
const key = (suffix: string) => `crm-fixture-key-${suffix}-0001`;
let runtime: Miniflare;
let db: D1Database;
let currentActor = owner;
let app: Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
const env = {} as Env;

function fixture(): { contacts: any[]; contact_log: any[]; followups: any[]; interactions: any[]; status_history: any[];
  reviewedMappings: []; schema: string; fixtureOnly: boolean; sourceSystem: string } {
  return {
    schema: "ops.crm.synthetic-import.v1", fixtureOnly: true, sourceSystem: "hermes-crm-fixture",
    contacts: [
      { id: 101, company_name: "Fixture Prospect", contact_name: "Example Contact", email: "prospect@example.invalid",
        has_website: -1, status: "Research", contact_type: "Business", outreach_paused: true, skip_auto_research: false,
        manual_contact_date: "2026-10-01", last_contacted_date: null },
      { id: 102, company_name: "Fixture School", email: null, has_website: 0, status: "Unclassified Legacy Status",
        contact_type: "School", sport: "Football", outreach_paused: false, skip_auto_research: false },
    ],
    contact_log: [
      { id: 201, contact_id: 101, log_date: "2026-10-02", log_type: "draft_created", source: "gmail", account: "ltds",
        external_draft_id: "fixture-draft-1", external_message_id: null, external_thread_id: null, occurred_at: null, outcome: "draft" },
      { id: 202, contact_id: 101, log_date: "2026-10-03", log_type: "phone_call", source: "manual", account: null,
        idempotency_key: "fixture-call-1", occurred_at: null, direction: "outbound", outcome: "voicemail" },
      { id: 203, contact_id: 101, log_date: "2026-10-04", log_type: "email_received", source: "gmail", account: "ltt",
        external_message_id: "fixture-msg-1", external_draft_id: null, external_thread_id: null,
        occurred_at: "2026-10-04T14:00:00Z", outcome: "reply" },
    ],
    followups: [
      { id: 301, contact_id: 101, action_kind: "draft_review", source: "gmail", origin_event_id: 201,
        responsibility: "us", completed: false, completed_at: null },
      { id: 302, contact_id: 102, method: "Phone", notes: "Fixture historical callback; preserve without automatic completion",
        source: null, origin_event_id: null, completed: false, completed_at: null },
    ],
    interactions: [{ id: 201, contact_id: 101, interaction_date: "2026-10-03", type: "Call",
      notes: "Separate legacy interaction, not automatically merged with contact_log" }],
    status_history: [{ id: 401, contact_id: 101, old_status: "New", new_status: "Research",
      changed_at: "2026-10-01T12:00:00Z", changed_by: "fixture-operator" }],
    reviewedMappings: [],
  };
}

async function sendImport(payload: ReturnType<typeof fixture> = fixture(), idempotencyKey = key("initial")) {
  return app.request("/api/admin/crm/synthetic/import", {
    method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(payload),
  }, env);
}

async function snapshotAuthority() {
  return {
    staff: (await db.prepare("SELECT id,email,display_name,status FROM staff_users ORDER BY id").all()).results,
    roles: (await db.prepare("SELECT staff_id,role_id,scope FROM staff_role_assignments ORDER BY staff_id").all()).results,
    overrides: (await db.prepare("SELECT staff_id,permission_key,effect,scope FROM staff_permission_overrides ORDER BY staff_id").all()).results,
    clients: (await db.prepare("SELECT id,name FROM pa_clients ORDER BY id").all()).results,
    accounts: (await db.prepare("SELECT id FROM client_accounts ORDER BY id").all()).results,
    grants: (await db.prepare("SELECT id FROM portal_grants ORDER BY id").all()).results,
  };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
    script: "export default { fetch(){ return new Response('crm fixture test') } }", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  env.OPS_DB = db;
  env.CRM_SYNTHETIC_IMPORT_ENABLED = "true";
  env.ENVIRONMENT = "test";
  await db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active');
    CREATE TABLE permissions(key TEXT PRIMARY KEY,description TEXT NOT NULL);
    CREATE TABLE role_permissions(role_id TEXT NOT NULL,permission_key TEXT NOT NULL,PRIMARY KEY(role_id,permission_key));
    CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
    CREATE TABLE local_staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT NOT NULL,role_id TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT,scope_key TEXT);
    CREATE TABLE staff_permission_overrides(id TEXT PRIMARY KEY,staff_id TEXT NOT NULL,permission_key TEXT NOT NULL,effect TEXT NOT NULL,scope TEXT NOT NULL,division_id TEXT);
    CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE client_accounts(id TEXT PRIMARY KEY);
    CREATE TABLE portal_grants(id TEXT PRIMARY KEY);
    INSERT INTO staff_users VALUES('crm-owner','owner@example.test','Synthetic Owner','active');
    INSERT INTO staff_users VALUES('crm-admin','admin@example.test','Synthetic Admin','active');
    INSERT INTO staff_users VALUES('crm-operator','operator@example.test','Synthetic Operator','active');
    INSERT INTO staff_role_assignments VALUES('role-owner','crm-owner','role-owner','global',NULL);
    INSERT INTO staff_role_assignments VALUES('role-admin','crm-admin','role-admin','global',NULL);
    INSERT INTO staff_role_assignments VALUES('role-operator','crm-operator','role-operator','global',NULL);
    INSERT INTO pa_clients VALUES('existing-pa-client','No CRM mapping');
  `);
  const migration = readFileSync(new URL("../migrations/0232_crm_synthetic_owner_import.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(migration).map(sql => db.prepare(sql)));
  app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", currentActor); c.set("administrator", false); await next(); });
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: "unexpected" }, 500));
  registerCrmSyntheticImportRoutes(app);
});

afterAll(async () => { await runtime?.dispose(); });

describe("owner-only synthetic Hermes CRM import/read contract", () => {
  it("bounds streamed imports even when Content-Length understates the body", async () => {
    let chunksSent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksSent += 1;
        if (chunksSent === 1) controller.enqueue(new Uint8Array(256 * 1024).fill(0x20));
        else if (chunksSent === 2) controller.enqueue(new Uint8Array([0x20]));
        else controller.close();
      },
    });
    const request = new Request("https://ops.test/api/admin/crm/synthetic/import", {
      method: "POST",
      headers: { "content-type": "application/json", "Content-Length": "1", "Idempotency-Key": key("oversized-stream") },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const response = await app.fetch(request, env);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "crm_body_too_large" });
  });

  it("seeds the dedicated permission for global Owner only", async () => {
    expect((await db.prepare("SELECT role_id,permission_key FROM role_permissions WHERE permission_key='crm.import.manage'").all()).results)
      .toEqual([{ role_id: "role-owner", permission_key: "crm.import.manage" }]);
  });

  it("rolls back source rows across tables and the batch receipt after a later insert fails", async () => {
    await db.exec("CREATE TRIGGER crm_test_reject_followup BEFORE INSERT ON crm_followups BEGIN SELECT RAISE(ABORT,'fixture_atomic_failure'); END");
    try {
      const response = await sendImport(fixture(), key("atomic"));
      expect(response.status).toBe(503);
      expect(await db.prepare("SELECT COUNT(*) n FROM crm_contacts").first("n")).toBe(0);
      expect(await db.prepare("SELECT COUNT(*) n FROM crm_contact_logs").first("n")).toBe(0);
      expect(await db.prepare("SELECT COUNT(*) n FROM crm_followups").first("n")).toBe(0);
      expect(await db.prepare("SELECT COUNT(*) n FROM crm_interactions").first("n")).toBe(0);
      expect(await db.prepare("SELECT COUNT(*) n FROM crm_status_history").first("n")).toBe(0);
      expect(await db.prepare("SELECT COUNT(*) n FROM crm_import_batches WHERE idempotency_key=?").bind(key("atomic")).first("n")).toBe(0);
    } finally {
      await db.exec("DROP TRIGGER IF EXISTS crm_test_reject_followup");
    }
  });

  it("imports all five source tables without merging IDs, converting drafts, or creating authority", async () => {
    currentActor = owner;
    const before = await snapshotAuthority();
    const response = await sendImport();
    expect(response.status).toBe(201);
    const receipt = await response.json() as any;
    expect(receipt).toMatchObject({ sourceSystem: "hermes-crm-fixture", inputCounts: {
      contacts: 2, contact_log: 3, followups: 2, interactions: 1, status_history: 1,
    }, insertedCounts: { contacts: 2, contact_log: 3, followups: 2, interactions: 1, status_history: 1 } });
    expect(JSON.stringify(receipt)).not.toContain("example.invalid");
    const persistedReceipt = await db.prepare("SELECT receipt_json FROM crm_import_batches WHERE id=?").bind(receipt.batchId).first<string>("receipt_json");
    expect(persistedReceipt).not.toContain("example.invalid");
    expect(await snapshotAuthority()).toEqual(before);
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_contacts").first("n")).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_contact_logs").first("n")).toBe(3);
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_followups").first("n")).toBe(2);
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_interactions").first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_status_history").first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_import_batches WHERE state='committed'").first("n")).toBe(1);
    expect(await db.prepare("SELECT source_record_id FROM crm_contacts WHERE source_record_id=101").first("source_record_id")).toBe(101);
    expect(await db.prepare("SELECT source_record_id FROM crm_contact_logs WHERE source_record_id=201").first("source_record_id")).toBe(201);
    expect(await db.prepare("SELECT source_record_id FROM crm_interactions WHERE source_record_id=201").first("source_record_id")).toBe(201);
    expect(await db.prepare("SELECT external_thread_id,occurred_at,outcome FROM crm_contact_logs WHERE source_record_id=201").first())
      .toEqual({ external_thread_id: null, occurred_at: null, outcome: "draft" });
    expect(await db.prepare("SELECT follow_up_date,completed_at,completed FROM crm_followups WHERE source_record_id=302").first())
      .toEqual({ follow_up_date: null, completed_at: null, completed: 0 });
    expect(await db.prepare("SELECT status FROM crm_contacts WHERE source_record_id=102").first("status")).toBe("Unclassified Legacy Status");
    expect(await db.prepare("SELECT outreach_paused,skip_auto_research FROM crm_contacts WHERE source_record_id=101").first())
      .toEqual({ outreach_paused: 1, skip_auto_research: 0 });
    const indexes = (await db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name IN('crm_contact_logs','crm_followups') AND sql IS NOT NULL ORDER BY name").all<any>()).results;
    expect(indexes.map(row => row.sql).filter((sql: string) => sql.includes("UNIQUE")).map((sql: string) => sql.replace(/\s+/g, " ").toLowerCase())).toEqual([
      "create unique index crm_contact_logs_gmail_draft_identity on crm_contact_logs(account,external_draft_id,log_type,contact_id) where source='gmail' and account is not null and external_draft_id is not null",
      "create unique index crm_contact_logs_gmail_message_identity on crm_contact_logs(account,external_message_id,log_type,contact_id) where source='gmail' and account is not null and external_message_id is not null",
      "create unique index crm_contact_logs_manual_idempotency on crm_contact_logs(contact_id,idempotency_key) where source='manual' and idempotency_key is not null",
      "create unique index crm_followups_event_action_identity on crm_followups(origin_event_id,action_kind) where origin_event_id is not null",
    ]);
  });

  it("preserves contact date-only cache evidence without promoting it to a log or follow-up", async () => {
    const contact = await db.prepare("SELECT manual_contact_date,legacy_cache_evidence_json FROM crm_contacts WHERE source_record_id=101").first<any>();
    expect(contact).toEqual({ manual_contact_date: "2026-10-01", legacy_cache_evidence_json: JSON.stringify({ last_contacted_date: null }) });
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_followups WHERE source_record_id=101").first("n")).toBe(0);
  });

  it("rejects rows that are not in the checked-in synthetic fixture digest allowlist", async () => {
    const nullableLink = {
      schema: "ops.crm.synthetic-import.v1", fixtureOnly: true, sourceSystem: "hermes-crm-fixture",
      contacts: [], contact_log: [{ id: 501, contact_id: null, log_date: "2026-10-05", log_type: "legacy_note" }],
      followups: [], interactions: [], status_history: [], reviewedMappings: [],
    } as ReturnType<typeof fixture>;
    expect((await sendImport(nullableLink, key("nullable-link"))).status).toBe(400);
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_contact_logs WHERE source_record_id=501").first("n")).toBe(0);

    const mismatched = fixture();
    mismatched.followups.push({ id: 303, contact_id: 102, origin_event_id: 201, action_kind: "review_draft", completed: false });
    expect((await sendImport(mismatched, key("origin-mismatch"))).status).toBe(400);
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_followups WHERE source_record_id=303").first("n")).toBe(0);
  });

  it("retains only the four source partial uniqueness rules", async () => {
    const duplicateDraft = {
      schema: "ops.crm.synthetic-import.v1", fixtureOnly: true, sourceSystem: "hermes-crm-fixture",
      contacts: [], contact_log: [
        { id: 601, contact_id: 101, log_date: "2026-10-06", log_type: "draft_created", source: "gmail", account: "ltds", external_draft_id: "same-draft" },
        { id: 602, contact_id: 101, log_date: "2026-10-06", log_type: "draft_created", source: "gmail", account: "ltds", external_draft_id: "same-draft" },
      ], followups: [], interactions: [], status_history: [], reviewedMappings: [],
    } as ReturnType<typeof fixture>;
    expect((await sendImport(duplicateDraft, key("partial-unique"))).status).toBe(400);
    expect(await db.prepare("SELECT COUNT(*) n FROM crm_contact_logs WHERE source_record_id IN(601,602)").first("n")).toBe(0);
    const manualDuplicateKey = {
      schema: "ops.crm.synthetic-import.v1", fixtureOnly: true, sourceSystem: "hermes-crm-fixture",
      contacts: [], contact_log: [{ id: 603, contact_id: 101, log_date: "2026-10-06", log_type: "phone_call", source: "manual", idempotency_key: "fixture-call-1" }],
      followups: [], interactions: [], status_history: [], reviewedMappings: [],
    } as ReturnType<typeof fixture>;
    expect((await sendImport(manualDuplicateKey, key("manual-partial-unique"))).status).toBe(400);
  });

  it("replays identical keys and rejects changed bodies without weakening idempotency", async () => {
    const original = await sendImport();
    const originalReceipt = await original.json();
    const replay = await sendImport();
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.json()).toEqual(originalReceipt);

    const changed = fixture();
    changed.contact_log = []; changed.followups = []; changed.interactions = []; changed.status_history = [];
    expect((await sendImport(changed)).status).toBe(409);
    const unapprovedContent = fixture(); unapprovedContent.contacts[0]!.notes = "changed";
    expect((await sendImport(unapprovedContent, key("unapproved-content"))).status).toBe(400);
    const otherKey = await sendImport(fixture(), key("same-source-rows"));
    expect(otherKey.status).toBe(201);
    expect((await otherKey.json() as any).insertedCounts).toEqual({ contacts: 0, contact_log: 0, followups: 0, interactions: 0, status_history: 0 });
    const modified = fixture(); modified.contacts[0]!.status = "Changed without review";
    expect((await sendImport(modified, key("row-conflict"))).status).toBe(400);
    expect(await db.prepare("SELECT status FROM crm_contacts WHERE source_record_id=101").first("status")).toBe("Research");
  });

  it("denies admin, operator, owner with deny, and disabled or production gates", async () => {
    currentActor = admin;
    expect((await sendImport(fixture(), key("admin-denied"))).status).toBe(403);
    expect((await app.request("/api/admin/crm/synthetic/contacts", {}, env)).status).toBe(403);
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('crm-admin-allow','crm-admin','crm.import.manage','allow','global',NULL)").run();
    expect((await sendImport(fixture(), key("admin-override-denied"))).status).toBe(403);
    await db.prepare("DELETE FROM staff_permission_overrides WHERE id='crm-admin-allow'").run();
    currentActor = operator;
    expect((await app.request("/api/admin/crm/synthetic/contacts", {}, env)).status).toBe(403);
    currentActor = owner;
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('crm-owner-deny','crm-owner','crm.import.manage','deny','global',NULL)").run();
    expect((await sendImport(fixture(), key("owner-denied"))).status).toBe(403);
    expect((await app.request("/api/admin/crm/synthetic/contacts", {}, env)).status).toBe(403);
    await db.prepare("DELETE FROM staff_permission_overrides WHERE id='crm-owner-deny'").run();
    env.ENVIRONMENT = "production";
    expect((await sendImport(fixture(), key("production-off"))).status).toBe(404);
    env.ENVIRONMENT = "test";
    env.CRM_SYNTHETIC_IMPORT_ENABLED = undefined;
    expect((await app.request("/api/admin/crm/synthetic/contacts", {}, env)).status).toBe(404);
  });

  it("returns only committed source-qualified rows to the Owner with no caching", async () => {
    env.CRM_SYNTHETIC_IMPORT_ENABLED = "true";
    currentActor = owner;
    const response = await app.request("/api/admin/crm/synthetic/contact-log?contact_id=101&limit=10", {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as any;
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toMatchObject({ source_system: "hermes-crm-fixture", source_table: "contact_log", source_record_id: 201, external_thread_id: null });
    expect(body.items.some((item: any) => item.source_record_id === 203 && item.external_thread_id === null)).toBe(true);
    expect(body.items[0]).not.toHaveProperty("source_sha256");
    expect((await app.request("/api/admin/crm/synthetic/contacts?after=101&limit=1", {}, env)).status).toBe(200);
    const globalRead = await app.request("/api/admin/crm/synthetic/followups?limit=10", {}, env);
    expect(globalRead.status).toBe(200);
    expect((await globalRead.json() as any).items.map((item: any) => item.source_record_id)).toEqual([301, 302]);
    const globalPage = await app.request("/api/admin/crm/synthetic/contact-log?limit=1&after=201", {}, env);
    expect(globalPage.status).toBe(200);
    expect((await globalPage.json() as any).items.map((item: any) => item.source_record_id)).toEqual([202]);
    const nextPage = await app.request("/api/admin/crm/synthetic/contact-log?contact_id=101&limit=1&after=201", {}, env);
    expect(nextPage.status).toBe(200);
    expect((await nextPage.json() as any).items.map((item: any) => item.source_record_id)).toEqual([202]);
  });
});
