import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createFeedbackRecord, readFeedbackRecord, transitionFeedbackRecord,
  type FeedbackWriteAuthorization, type FeedbackWriteGuard,
} from "../src/worker/client-portal/feedback-store";

describe("feedback durable lifecycle on migrated D1", { timeout: 30_000 }, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let sequence = 0;
  const key = () => `feedback-test-operation-${++sequence}`;
  const guard: FeedbackWriteGuard = {
    sql: "EXISTS (SELECT 1 FROM client_accounts WHERE id=? AND status='active')", bindings: ["feedback-account"],
  };
  const authorization = (): FeedbackWriteAuthorization => ({
    context: { accountId: "feedback-account", identityId: "feedback-author", workspaceId: null,
      workspaceIdentityId: null, issuer: "https://issuer.test", subject: "feedback-author" },
    target: { kind: "project", projectId: "feedback-project", associationId: null, relativePath: null,
      storageKey: null, label: "North site", projectName: "North site",
      sourceOwner: { account: { projectAlphaClientId: "pa-client", projectAlphaOrganizationId: null },
        project: { projectAlphaProjectId: "pa-project", sourceUpdatedAt: "2026-08-25T00:00:00Z" },
        workspace: null, association: null, file: null } },
    guard,
  });
  const count = async (table: string, feedbackId?: string) => Number(await db.prepare(`SELECT COUNT(*) n FROM ${table}${feedbackId ? " WHERE feedback_id=?" : ""}`)
    .bind(...(feedbackId ? [feedbackId] : [])).first("n"));
  const create = (message = "Please capture the east side next time.") => createFeedbackRecord(db, authorization(), message, key());

  async function migrate(name: string) {
    const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
      .replace(/\r\n/g, "\n").replace(/^\s*--.*$/gm, "");
    if (/CREATE\s+TRIGGER\b/i.test(sql)) {
      await db.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
    } else {
      const statements = sql.split(/;\s*(?:\n|$)/).map(statement => statement.trim())
        .filter(statement => statement && !/^PRAGMA\s+foreign_keys\s*=\s*ON$/i.test(statement));
      if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
    }
  }
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-16", modules: true,
      script: "export default { fetch() { return new Response('test'); } };", d1Databases: { DELIVERY_DB: "feedback-store" } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const migrations = readdirSync(fileURLToPath(new URL("../migrations/", import.meta.url))).filter(name => name.endsWith(".sql")).sort();
    for (const migration of migrations.filter(name => name < "0155_client_feedback.sql")) await migrate(migration);
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id) VALUES ('feedback-account','Feedback client','active','pa-client')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES ('feedback-author','feedback-account','https://issuer.test','feedback-author','author@example.test')"),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES ('feedback-account','feedback-author','manager')"),
      db.prepare("INSERT INTO projects(id,project_alpha_project_id,client_name,project_name,r2_prefix) VALUES ('feedback-project','pa-project','Feedback client','North site','clients/feedback/north/')"),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES ('feedback-account','feedback-project',1)"),
      db.prepare("INSERT INTO client_service_requests(id,account_id,project_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,status) VALUES ('feedback-existing-request','feedback-account','feedback-project','feedback-author','service','Existing request','Preserve existing workflow','feedback-legacy-request','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','submitted')"),
      db.prepare("INSERT INTO client_portal_notification_outbox(id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json) VALUES ('feedback-existing-outbox','feedback-existing-request','request_submitted','submitted','staff_triage','feedback-existing-notice','{}')"),
    ]);
    await migrate("0155_client_feedback.sql");
    for (const migration of migrations.filter(name => name > "0155_client_feedback.sql")) await migrate(migration);
    await db.exec(`CREATE TABLE feedback_test_failure (kind TEXT);
      CREATE TRIGGER feedback_test_audit_failure BEFORE INSERT ON audit_log
        WHEN NEW.entity_type='client_feedback' AND EXISTS (SELECT 1 FROM feedback_test_failure WHERE kind='audit')
        BEGIN SELECT RAISE(ABORT,'injected feedback audit failure'); END;
      CREATE TRIGGER feedback_test_outbox_failure BEFORE INSERT ON client_feedback_notification_outbox
        WHEN EXISTS (SELECT 1 FROM feedback_test_failure WHERE kind='outbox')
        BEGIN SELECT RAISE(ABORT,'injected feedback outbox failure'); END;`.replace(/\s*\n\s*/g, " "));
  }, 60_000);
  afterAll(async () => runtime?.dispose());
  beforeEach(async () => {
    await db.batch([db.prepare("DELETE FROM feedback_test_failure"), db.prepare("UPDATE client_accounts SET status='active' WHERE id='feedback-account'")]);
  });

  it("preserves populated grants and legacy pending mail without manufacturing feedback or notifications", async () => {
    expect(await db.prepare("SELECT details FROM client_service_requests WHERE id='feedback-existing-request'").first("details")).toBe("Preserve existing workflow");
    expect(await db.prepare("SELECT status FROM client_portal_notification_outbox WHERE id='feedback-existing-outbox'").first("status")).toBe("pending");
    expect(await db.prepare("SELECT revoked_at FROM client_project_grants WHERE account_id='feedback-account'").first()).toEqual({ revoked_at: null });
    expect(await count("client_feedback")).toBe(0);
    expect(await count("client_feedback_notifications")).toBe(0);
    expect(await count("client_feedback_notification_outbox")).toBe(0);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("creates one immutable submission and event with content-free audit", async () => {
    const { record, replayed } = await create();
    expect(replayed).toBe(false);
    expect(record).toMatchObject({ status: "new", revision: 1, completionNote: null });
    expect(await count("client_feedback_events",record.id)).toBe(1);
    expect(await count("client_feedback_notifications",record.id)).toBe(0);
    const audit = await db.prepare("SELECT action,details_json FROM audit_log WHERE entity_type='client_feedback' AND entity_id=?").bind(record.id).first<{ action: string; details_json: string }>();
    expect(audit?.action).toBe("client.feedback.created");
    expect(audit?.details_json).not.toContain(record.message);
    await expect(db.prepare("UPDATE client_feedback SET message='changed' WHERE id=?").bind(record.id).run()).rejects.toThrow();
  });
  it("replays an uncertain submission but rejects reuse with different text", async () => {
    const mutationKey = key(), first = await createFeedbackRecord(db,authorization(),"Same request",mutationKey);
    expect(await createFeedbackRecord(db,authorization(),"Same request",mutationKey)).toMatchObject({ record: { id: first.record.id }, replayed: true });
    await expect(createFeedbackRecord(db,authorization(),"Changed request",mutationKey)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await count("client_feedback_events",first.record.id)).toBe(1);
  });
  it("collapses concurrent duplicate submissions into one durable record", async () => {
    const mutationKey = key();
    const results = await Promise.all([createFeedbackRecord(db,authorization(),"Double click",mutationKey),createFeedbackRecord(db,authorization(),"Double click",mutationKey)]);
    expect(results[0].record.id).toBe(results[1].record.id);
    expect(results.filter(result => !result.replayed)).toHaveLength(1);
    expect(await count("client_feedback_events",results[0].record.id)).toBe(1);
  });
  it("separates author idempotency by selected workspace", async () => {
    const mutationKey = key(), a = authorization(), b = authorization();
    a.context = { ...a.context, workspaceId: "workspace-a", workspaceIdentityId: "native-author" };
    b.context = { ...b.context, workspaceId: "workspace-b", workspaceIdentityId: "native-author" };
    const first = await createFeedbackRecord(db,a,"Workspace A",mutationKey), second = await createFeedbackRecord(db,b,"Workspace B",mutationKey);
    expect(first.record.id).not.toBe(second.record.id);
  });
  it("requires current authority even on idempotent replay", async () => {
    const mutationKey = key();
    await createFeedbackRecord(db,authorization(),"Saved request",mutationKey);
    await db.prepare("UPDATE client_accounts SET status='suspended' WHERE id='feedback-account'").run();
    await expect(createFeedbackRecord(db,authorization(),"Saved request",mutationKey)).rejects.toMatchObject({ code: "changed" });
  });
  it("fences a revocation between preflight and the transaction without leaving an event", async () => {
    const before = await count("client_feedback");
    const racing = { prepare: db.prepare.bind(db), batch: async <T>(statements: D1PreparedStatement[]) => {
      await db.prepare("UPDATE client_accounts SET status='suspended' WHERE id='feedback-account'").run();
      return db.batch<T>(statements);
    } };
    await expect(createFeedbackRecord(racing,authorization(),"Revoked during submit",key())).rejects.toMatchObject({ code: "changed" });
    expect(await count("client_feedback")).toBe(before);
  });
  it("rolls creation back when the same-transaction audit fails", async () => {
    const before = await count("client_feedback"), events = await count("client_feedback_events");
    await db.prepare("INSERT INTO feedback_test_failure VALUES ('audit')").run();
    await expect(create()).rejects.toThrow("injected feedback audit failure");
    expect(await count("client_feedback")).toBe(before);
    expect(await count("client_feedback_events")).toBe(events);
  });
  it("moves New through In Progress to Done, creating a single creator notice and mail job", async () => {
    const { record } = await create();
    const working = await transitionFeedbackRecord(db,record,"staff-one",{ expectedRevision: 1,status: "in_progress",note: null },key(),guard);
    expect(working.record).toMatchObject({ status: "in_progress",revision: 2,completedAt: null });
    expect(await count("client_feedback_notifications",record.id)).toBe(0);
    const done = await transitionFeedbackRecord(db,working.record,"staff-one",{ expectedRevision: 2,status: "done",note: "Included in next year's plan." },key(),guard);
    expect(done.record).toMatchObject({ status: "done",revision: 3,completionNote: "Included in next year's plan." });
    expect(await count("client_feedback_events",record.id)).toBe(3);
    expect(await count("client_feedback_notifications",record.id)).toBe(1);
    expect(await db.prepare(`SELECT notice.recipient_identity_id,outbox.status,outbox.attempt_count
      FROM client_feedback_notifications notice JOIN client_feedback_notification_outbox outbox ON outbox.notification_id=notice.id
      WHERE notice.feedback_id=?`).bind(record.id).first()).toEqual({ recipient_identity_id: "feedback-author", status: "pending", attempt_count: 0 });
  });
  it("allows acknowledgment directly to Done without requiring an invented work phase", async () => {
    const { record } = await create();
    const done = await transitionFeedbackRecord(db,record,"staff-one",{ expectedRevision: 1,status: "done",note: null },key(),guard);
    expect(done.record).toMatchObject({ status: "done",revision: 2,completionNote: null });
    expect(await count("client_feedback_events",record.id)).toBe(2);
  });
  it("replays completion once and rejects a changed completion note using that key", async () => {
    const { record } = await create(), mutationKey = key(), input = { expectedRevision: 1,status: "done" as const,note: "Acknowledged" };
    const first = await transitionFeedbackRecord(db,record,"staff-one",input,mutationKey,guard);
    expect(await transitionFeedbackRecord(db,first.record,"staff-one",input,mutationKey,guard)).toMatchObject({ appliedRevision: 2,replayed: true });
    await expect(transitionFeedbackRecord(db,first.record,"staff-one",{ ...input,note: "Other note" },mutationKey,guard)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await count("client_feedback_notifications",record.id)).toBe(1);
  });
  it("permits only one of two competing transitions at the same revision", async () => {
    const { record } = await create();
    const results = await Promise.allSettled([
      transitionFeedbackRecord(db,record,"staff-one",{ expectedRevision: 1,status: "in_progress",note: null },key(),guard),
      transitionFeedbackRecord(db,record,"staff-two",{ expectedRevision: 1,status: "done",note: "Handled" },key(),guard),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await count("client_feedback_events",record.id)).toBe(2);
    expect((await readFeedbackRecord(db,record.id))?.revision).toBe(2);
  });
  it.each(["audit", "outbox"])("rolls completion and its receipt back if %s persistence fails", async failure => {
    const { record } = await create(), mutationKey = key();
    await db.prepare("INSERT INTO feedback_test_failure VALUES (?)").bind(failure).run();
    await expect(transitionFeedbackRecord(db,record,"staff-one",{ expectedRevision: 1,status: "done",note: null },mutationKey,guard)).rejects.toThrow(`injected feedback ${failure} failure`);
    expect(await readFeedbackRecord(db,record.id)).toMatchObject({ status: "new",revision: 1 });
    expect(await count("client_feedback_events",record.id)).toBe(1);
    expect(await count("client_feedback_notifications",record.id)).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) n FROM client_feedback_mutations WHERE mutation_key=?").bind(mutationKey).first("n")).toBe(0);
  });
  it("makes lifecycle history immutable and rejects reopening Done", async () => {
    const { record } = await create(), done = await transitionFeedbackRecord(db,record,"staff-one",{ expectedRevision: 1,status: "done",note: null },key(),guard);
    await expect(transitionFeedbackRecord(db,done.record,"staff-one",{ expectedRevision: 2,status: "in_progress",note: null },key(),guard)).rejects.toMatchObject({ code: "changed" });
    await expect(db.prepare("DELETE FROM client_feedback_events WHERE feedback_id=?").bind(record.id).run()).rejects.toThrow("feedback events are immutable");
    await expect(db.prepare("UPDATE client_feedback_events SET note='rewritten' WHERE feedback_id=?").bind(record.id).run()).rejects.toThrow("feedback events are immutable");
  });
  it("does not delete file feedback when the source index entry is removed", async () => {
    const auth = authorization();
    auth.target = { ...auth.target,kind: "file",associationId: "exact-association",storageKey: "clients/feedback/removed.jpg",label: "removed.jpg",
      sourceOwner: { ...auth.target.sourceOwner,association: { prefix: "clients/feedback/" },file: { etag: "source-version",size: 123,uploadedAt: "2026-08-25T00:00:00Z" } } };
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES (?,?,123,?,'image/jpeg','image')")
      .bind(auth.target.storageKey,"source-version","2026-08-25T00:00:00Z").run();
    const created = await createFeedbackRecord(db,auth,"Historical media feedback",key());
    await db.prepare("DELETE FROM file_index WHERE r2_key=?").bind(auth.target.storageKey).run();
    expect(await readFeedbackRecord(db,created.record.id)).toMatchObject({ message: "Historical media feedback",target: { storageKey: auth.target.storageKey } });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("rejects malformed or oversized text before any durable write", async () => {
    const before = await count("client_feedback");
    for (const message of ["", " ", "x".repeat(5001), "hidden\u0000control"]) await expect(createFeedbackRecord(db,authorization(),message,key())).rejects.toMatchObject({ code: "invalid" });
    expect(await count("client_feedback")).toBe(before);
  });
  it("uses bounded status and author indexes for progression", async () => {
    const statusPlan = await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM client_feedback WHERE status=? ORDER BY created_at,id LIMIT 26").bind("new").all();
    const authorPlan = await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM client_feedback WHERE scope_key=? AND principal_issuer=? AND principal_subject=? ORDER BY created_at DESC,id DESC LIMIT 26")
      .bind("account:feedback-account","https://issuer.test","feedback-author").all();
    expect(JSON.stringify(statusPlan.results)).toContain("idx_client_feedback_status");
    expect(JSON.stringify(authorPlan.results)).toContain("idx_client_feedback_author");
    expect(JSON.stringify(statusPlan.results)).not.toContain("TEMP B-TREE");
    expect(JSON.stringify(authorPlan.results)).not.toContain("TEMP B-TREE");
  });
  it.each([
    { where: "", values: [], index: "idx_client_feedback_chronological" },
    { where: "WHERE account_id=?", values: ["feedback-account"], index: "idx_client_feedback_account_chronological" },
    { where: "WHERE account_id=? AND status=?", values: ["feedback-account", "new"], index: "idx_client_feedback_account_status" },
  ])("pages staff history through $index without sorting the entire feedback table", async ({ where, values, index }) => {
    const first = await db.prepare(`EXPLAIN QUERY PLAN SELECT id,created_at FROM client_feedback ${where} ORDER BY created_at,id LIMIT 51`)
      .bind(...values).all();
    const next = await db.prepare(`EXPLAIN QUERY PLAN SELECT id,created_at FROM client_feedback ${where} ${where ? "AND" : "WHERE"} (created_at,id)>(?,?) ORDER BY created_at,id LIMIT 51`)
      .bind(...values,"2026-08-25T00:00:00.000Z","feedback-cursor").all();
    for (const plan of [first,next]) {
      expect(JSON.stringify(plan.results)).toContain(index);
      expect(JSON.stringify(plan.results)).not.toContain("TEMP B-TREE");
    }
  });
});
