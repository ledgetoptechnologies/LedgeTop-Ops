import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { NativeWorkforceTimeRecordConflict, NativeWorkforceTimeRecordDenied,
  recordNativeWorkforceTime, type NativeWorkforceTimeRecordCommand } from "../src/worker/native-workforce-time-record";
import { reviewNativeWorkforceTime, submitNativeWorkforceTime } from "../src/worker/native-workforce-time-transitions";

let runtime: Miniflare;
let db: D1Database;
const auth = (staffId = "actor", version = 1) => Object.freeze({ admissionVersion: version,
  verifiedUntil: "2027-01-01T00:00:00.000Z", identity: Object.freeze({ kind: "native" as const,
    staffId, verifiedAccessSubject: `access|${staffId}`, email: `${staffId}@example.test`,
    displayName: staffId, profileVersion: 1 }) });
const command = (overrides: Partial<NativeWorkforceTimeRecordCommand> = {}): NativeWorkforceTimeRecordCommand => ({
  commandId: "command-one", entryId: "entry-one", beneficiaryStaffId: "actor",
  workDate: "2026-09-22", durationMinutes: 60, context: { kind: "internal", id: null },
  description: "Internal planning", changeReason: "Initial record", ...overrides,
});

async function migrate(name: string) {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

async function grant(id: string, staff: string, capability: string, effect: "allow" | "deny",
  kind: "internal" | "business_area" | "division" | "native_project", project: string | null = null) {
  await db.prepare(`INSERT INTO native_workforce_authority_grants(id,staff_id,capability,effect,scope_kind,
    business_area_id,division_id,native_project_id,granted_by) VALUES(?,?,?,?,?,NULL,NULL,?,?)`)
    .bind(id, staff, capability, effect, kind, project, "actor").run();
}

beforeEach(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await db.exec(`CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,
    active INTEGER,version INTEGER); CREATE TABLE native_business_areas(id TEXT PRIMARY KEY);
    CREATE TABLE native_business_divisions(business_area_id TEXT,id TEXT UNIQUE,PRIMARY KEY(business_area_id,id));
    CREATE TABLE operations_shared_projects(external_project_id TEXT PRIMARY KEY,lifecycle TEXT,scopes_json TEXT);
    INSERT INTO native_staff_admissions VALUES('actor','access|actor',1,1),('beneficiary','access|beneficiary',1,1),
      ('reviewer','access|reviewer',1,1);
    INSERT INTO native_business_areas VALUES('area-one');
    INSERT INTO native_business_divisions VALUES('area-one','division-one');
    INSERT INTO operations_shared_projects VALUES('project-one','active','[{"businessAreaId":"area-one","divisionId":"division-one"}]'),
      ('project-closed','completed','[{"businessAreaId":"area-one","divisionId":"division-one"}]');`.replace(/\s*\n\s*/g, " "));
  for (const name of ["0096_native_workforce_foundation.sql", "0097_native_workforce_authority.sql",
    "0098_native_workforce_time_record_receipts.sql", "0099_native_workforce_time_submit_review_receipts.sql",
    "0108_native_workforce_time_beneficiary_selection.sql"])
    await migrate(name);
});
afterEach(() => runtime.dispose());

describe("native workforce time record atomic D1 command", () => {
  it("records self/internal once and exactly replays the immutable receipt", async () => {
    await grant("allow", "actor", "time.record.self", "allow", "internal");
    const first = await recordNativeWorkforceTime(db, auth(), command());
    const replay = await recordNativeWorkforceTime(db, auth(), command());
    expect(first.replayed).toBe(false); expect(replay.replayed).toBe(true);
    expect(await db.prepare("SELECT count(*) count FROM native_workforce_time_entries").first("count")).toBe(1);
    expect(await db.prepare("SELECT count(*) count FROM native_workforce_commands").first("count")).toBe(1);
  });

  it("denies absent authority and scoped deny without partial ledger rows", async () => {
    await expect(recordNativeWorkforceTime(db, auth(), command())).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
    await grant("allow", "actor", "time.record.self", "allow", "internal");
    await grant("deny", "actor", "time.record.self", "deny", "internal");
    await expect(recordNativeWorkforceTime(db, auth(), command())).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
    expect(await db.prepare("SELECT count(*) count FROM native_workforce_time_entries").first("count")).toBe(0);
  });

  it("requires the exact current subject and admission version inside the write batch", async () => {
    await grant("allow", "actor", "time.record.self", "allow", "internal");
    await expect(recordNativeWorkforceTime(db, auth("actor", 2), command())).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
    await db.prepare("UPDATE native_staff_admissions SET active=0,version=2 WHERE staff_id='actor'").run();
    await expect(recordNativeWorkforceTime(db, auth(), command())).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
  });

  it("records only an active exact native project and respects exact-project deny", async () => {
    await grant("project-allow", "actor", "time.record.self", "allow", "native_project", "project-one");
    const project = command({ context: { kind: "native_project", id: "project-one" } });
    await expect(recordNativeWorkforceTime(db, auth(), project)).resolves.toMatchObject({ entryId: "entry-one" });
    await grant("closed-allow", "actor", "time.record.self", "allow", "native_project", "project-closed");
    await expect(recordNativeWorkforceTime(db, auth(), command({ commandId: "closed-command", entryId: "closed-entry",
      context: { kind: "native_project", id: "project-closed" } }))).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
    await grant("project-deny", "actor", "time.record.self", "deny", "native_project", "project-one");
    await expect(recordNativeWorkforceTime(db, auth(), command({ commandId: "deny-command", entryId: "deny-entry",
      context: { kind: "native_project", id: "project-one" } }))).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
  });

  it("requires both on-behalf capability and exact beneficiary selection with deny precedence", async () => {
    await grant("on-behalf", "actor", "time.record.on_behalf", "allow", "internal");
    const behalf = command({ beneficiaryStaffId: "beneficiary" });
    await expect(recordNativeWorkforceTime(db, auth(), behalf)).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
    await db.prepare(`INSERT INTO native_workforce_time_beneficiary_selection_delegations
      (id,actor_staff_id,beneficiary_staff_id,effect,granted_by) VALUES('select','actor','beneficiary','allow','actor')`).run();
    await expect(recordNativeWorkforceTime(db, auth(), behalf)).resolves.toMatchObject({ beneficiaryStaffId: "beneficiary" });
    await db.prepare(`INSERT INTO native_workforce_time_beneficiary_selection_delegations
      (id,actor_staff_id,beneficiary_staff_id,effect,granted_by) VALUES('select-deny','actor','beneficiary','deny','actor')`).run();
    await expect(recordNativeWorkforceTime(db, auth(), command({ commandId: "behalf-deny", entryId: "behalf-deny" ,
      beneficiaryStaffId: "beneficiary" }))).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
  });

  it("treats reused command or entry identity with a different request as conflict", async () => {
    await grant("allow", "actor", "time.record.self", "allow", "internal");
    await recordNativeWorkforceTime(db, auth(), command());
    await expect(recordNativeWorkforceTime(db, auth(), command({ durationMinutes: 61 })))
      .rejects.toBeInstanceOf(NativeWorkforceTimeRecordConflict);
    await expect(recordNativeWorkforceTime(db, auth(), command({ commandId: "other-command" })))
      .rejects.toBeInstanceOf(NativeWorkforceTimeRecordConflict);
  });

  it("denies replay and collision recovery after the applicable allow is revoked", async () => {
    await grant("allow", "actor", "time.record.self", "allow", "internal");
    await recordNativeWorkforceTime(db, auth(), command());
    await db.prepare("UPDATE native_workforce_authority_grants SET active=0,version=2 WHERE id='allow'").run();
    await expect(recordNativeWorkforceTime(db, auth(), command()))
      .rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
    await expect(recordNativeWorkforceTime(db, auth(), command({ durationMinutes: 61 })))
      .rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
  });

  it("denies replay when a matching deny is added after the original success", async () => {
    await grant("allow", "actor", "time.record.self", "allow", "internal");
    await recordNativeWorkforceTime(db, auth(), command());
    await grant("late-deny", "actor", "time.record.self", "deny", "internal");
    await expect(recordNativeWorkforceTime(db, auth(), command()))
      .rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
  });

  it("denies on-behalf replay after the beneficiary selection is revoked", async () => {
    await grant("on-behalf", "actor", "time.record.on_behalf", "allow", "internal");
    await db.prepare(`INSERT INTO native_workforce_time_beneficiary_selection_delegations
      (id,actor_staff_id,beneficiary_staff_id,effect,granted_by) VALUES('select','actor','beneficiary','allow','actor')`).run();
    const behalf = command({ beneficiaryStaffId: "beneficiary" });
    await recordNativeWorkforceTime(db, auth(), behalf);
    await db.prepare(`UPDATE native_workforce_time_beneficiary_selection_delegations
      SET active=0,version=2 WHERE id='select'`).run();
    await expect(recordNativeWorkforceTime(db, auth(), behalf))
      .rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
  });

  it("lets only the beneficiary attest and exactly replay submission", async () => {
    await grant("record", "actor", "time.record.self", "allow", "internal");
    await grant("submit", "actor", "time.submit", "allow", "internal");
    await recordNativeWorkforceTime(db, auth(), command());
    const input = { commandId: "submit-one", entryId: "entry-one", expectedRevision: 1 };
    await expect(submitNativeWorkforceTime(db, auth(), input)).resolves.toMatchObject({ action: "submitted", replayed: false });
    await expect(submitNativeWorkforceTime(db, auth(), input)).resolves.toMatchObject({ replayed: true });
    expect(await db.prepare("SELECT workflow_status FROM native_workforce_time_entries WHERE entry_id='entry-one'").first("workflow_status"))
      .toBe("submitted");
    await db.prepare("UPDATE native_workforce_authority_grants SET active=0,version=2 WHERE id='submit'").run();
    await expect(submitNativeWorkforceTime(db, auth(), { ...input, expectedRevision: 2 }))
      .rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
  });

  it("does not let an on-behalf recorder attest for the beneficiary", async () => {
    await grant("record", "actor", "time.record.on_behalf", "allow", "internal");
    await grant("submit", "actor", "time.submit", "allow", "internal");
    await db.prepare(`INSERT INTO native_workforce_time_beneficiary_selection_delegations
      (id,actor_staff_id,beneficiary_staff_id,effect,granted_by) VALUES('select','actor','beneficiary','allow','actor')`).run();
    await recordNativeWorkforceTime(db, auth(), command({ beneficiaryStaffId: "beneficiary" }));
    await expect(submitNativeWorkforceTime(db, auth(),
      { commandId: "submit-one", entryId: "entry-one", expectedRevision: 1 }))
      .rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
  });

  it("requires an independently authorized reviewer and approve/return is idempotent", async () => {
    await grant("record", "actor", "time.record.self", "allow", "internal");
    await grant("submit", "actor", "time.submit", "allow", "internal");
    await grant("review", "reviewer", "time.review", "allow", "internal");
    await recordNativeWorkforceTime(db, auth(), command());
    const submission = { commandId: "submit-one", entryId: "entry-one", expectedRevision: 1 };
    await submitNativeWorkforceTime(db, auth(), submission);
    const review = { commandId: "review-command", reviewId: "review-one", entryId: "entry-one",
      expectedRevision: 1, decision: "approved" as const, reason: "Verified by manager" };
    await expect(reviewNativeWorkforceTime(db, auth("actor"), review)).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
    await expect(reviewNativeWorkforceTime(db, auth("reviewer"), review)).resolves.toMatchObject({ action: "approved", replayed: false });
    await expect(reviewNativeWorkforceTime(db, auth("reviewer"), review)).resolves.toMatchObject({ replayed: true });
    await expect(submitNativeWorkforceTime(db, auth(), submission)).resolves.toMatchObject({ action: "submitted", replayed: true });
  });

  it("applies review deny precedence and revocation-fences replay", async () => {
    await grant("record", "actor", "time.record.self", "allow", "internal");
    await grant("submit", "actor", "time.submit", "allow", "internal");
    await grant("review", "reviewer", "time.review", "allow", "internal");
    await recordNativeWorkforceTime(db, auth(), command());
    await submitNativeWorkforceTime(db, auth(), { commandId: "submit-one", entryId: "entry-one", expectedRevision: 1 });
    await grant("review-deny", "reviewer", "time.review", "deny", "internal");
    const review = { commandId: "review-command", reviewId: "review-one", entryId: "entry-one",
      expectedRevision: 1, decision: "returned" as const, reason: "Needs correction" };
    await expect(reviewNativeWorkforceTime(db, auth("reviewer"), review)).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
    await db.prepare("UPDATE native_workforce_authority_grants SET active=0,version=2 WHERE id='review-deny'").run();
    await reviewNativeWorkforceTime(db, auth("reviewer"), review);
    await db.prepare("UPDATE native_workforce_authority_grants SET active=0,version=2 WHERE id='review'").run();
    await expect(reviewNativeWorkforceTime(db, auth("reviewer"), review)).rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
    await expect(reviewNativeWorkforceTime(db, auth("reviewer"), { ...review, reason: "Changed reason" }))
      .rejects.toBeInstanceOf(NativeWorkforceTimeRecordDenied);
  });
});
