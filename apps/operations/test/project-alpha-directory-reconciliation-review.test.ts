import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { acquireProjectAlphaDirectoryReconciliationFinding,
  listProjectAlphaDirectoryReconciliationFindings,
  type ProjectAlphaDirectoryReconciliationReviewEnvironment } from "../src/worker/project-alpha-directory-reconciliation-review";

const sourceA = "project-alpha:a", sourceB = "project-alpha:b";
const sourceInstanceA = "10000000-0000-4000-8000-000000000001";
const applicationA = "10000000-0000-4000-8000-000000000002";
const epochA = "10000000-0000-4000-8000-000000000003";
const sourceInstanceB = "20000000-0000-4000-8000-000000000001";
const applicationB = "20000000-0000-4000-8000-000000000002";
const epochB = "20000000-0000-4000-8000-000000000003";
const recordId = "native-record";
const reviewer = { staffId: "staff-admin", accessSubject: "access|admin",
  admissionVersion: 3, profileVersion: 4, grantGeneration: 5 };

let runtime: Miniflare, db: D1Database, sequence = 0;
function uuid(): string { return `30000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`; }
function publicId(value: number): string { return value.toString(16).padStart(32, "0"); }
function splitSql(sql: string): string[] {
  const statements: string[] = []; let current = "", trigger = false;
  for (const line of sql.split(/\r?\n/u)) {
    if (!current && /^\s*--/u.test(line)) continue;
    if (/^\s*CREATE\s+TRIGGER\b/iu.test(line)) trigger = true;
    current += `${line}\n`;
    if ((!trigger && /;\s*$/u.test(line)) || (trigger && /^\s*END;\s*$/iu.test(line))) {
      statements.push(current.trim()); current = ""; trigger = false;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}
async function apply(sql: string): Promise<void> { for (const statement of splitSql(sql)) await db.prepare(statement).run(); }
function identity(sourceId: string) {
  return sourceId === sourceA
    ? { sourceInstanceId: sourceInstanceA, applicationId: applicationA, historyEpoch: epochA }
    : { sourceInstanceId: sourceInstanceB, applicationId: applicationB, historyEpoch: epochB };
}
function env(): ProjectAlphaDirectoryReconciliationReviewEnvironment {
  return { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
    [sourceA]: { sourceId: sourceA, enabled: true, baseUrl: "https://a.example.test", apiKey: "private-a",
      sourceInstanceId: sourceInstanceA, applicationId: applicationA, historyEpoch: epochA },
    [sourceB]: { sourceId: sourceB, enabled: true, baseUrl: "https://b.example.test", apiKey: "private-b",
      sourceInstanceId: sourceInstanceB, applicationId: applicationB, historyEpoch: epochB },
  } }) };
}

async function completeRun(sourceId: string, count: number,
  fence = identity(sourceId), resourceType: "client" | "organization" = "organization"):
  Promise<{ runId: string; findings: string[]; publics: string[] }> {
  const runId = uuid(), at = "2026-09-22T12:00:00.000Z";
  await db.prepare(`INSERT INTO project_alpha_directory_reconciliation_runs(run_id,source_id,status,
    source_instance_id,application_id,history_epoch_id,authorization_generation,started_at)
    VALUES(?,?,'running',?,?,?,'7',?)`).bind(runId, sourceId, fence.sourceInstanceId,
      fence.applicationId, fence.historyEpoch, at).run();
  await db.prepare(`INSERT INTO project_alpha_directory_reconciliation_checkpoints(source_id,active_run_id,
    complete_run_id,updated_at) VALUES(?,?,NULL,?) ON CONFLICT(source_id) DO UPDATE SET active_run_id=excluded.active_run_id,
    cursor=NULL,pages_observed=0,items_observed=0,updated_at=excluded.updated_at`).bind(sourceId, runId, at).run();
  const findings: string[] = [], publics: string[] = [];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const findingId = uuid(), remotePublicId = publicId(sequence + ordinal + 1);
    findings.push(findingId); publics.push(remotePublicId);
    await db.prepare(`INSERT INTO project_alpha_directory_reconciliation_observations(run_id,ordinal,resource_type,
      public_id,revision,present,last_action,projection_sha256,binding_external_id,binding_status,
      binding_resource_revision,profile_json,observed_at) VALUES(?,?,?,?,'9',1,'upsert',?,?,'active','9',?,?)`)
      .bind(runId, ordinal, resourceType, remotePublicId, "a".repeat(64), `remote-${ordinal}`,
        JSON.stringify({ email: "secret@example.test", name: "Secret Name" }), at).run();
    await db.prepare(`INSERT INTO project_alpha_directory_reconciliation_findings(finding_id,run_id,source_id,
      classification,resource_type,remote_public_id,details_json,created_at)
      VALUES(?,?,?,'extra_remote',?,?,?,?)`).bind(findingId, runId, sourceId, resourceType, remotePublicId,
        JSON.stringify({ apiKey: "private-secret", profile: { email: "secret@example.test" } }), at).run();
  }
  await db.prepare(`UPDATE project_alpha_directory_reconciliation_runs SET status='complete',pages_observed=1,
    items_observed=?,completed_at=? WHERE run_id=?`).bind(count, at, runId).run();
  await db.prepare(`UPDATE project_alpha_directory_reconciliation_checkpoints SET active_run_id=NULL,
    complete_run_id=?,pages_observed=1,items_observed=?,source_instance_id=?,application_id=?,history_epoch_id=?,
    authorization_generation='7',updated_at=? WHERE source_id=? AND active_run_id=?`)
    .bind(runId, count, fence.sourceInstanceId, fence.applicationId, fence.historyEpoch, at, sourceId, runId).run();
  return { runId, findings, publics };
}

function observed(sourceId: string, remotePublicId: string, overrides: Record<string, string> = {}) {
  const fence = identity(sourceId);
  return { status: "observed" as const, observation: { sourceId,
    sourceInstanceId: overrides.sourceInstanceId ?? fence.sourceInstanceId,
    applicationId: overrides.applicationId ?? fence.applicationId,
    historyEpoch: overrides.historyEpoch ?? fence.historyEpoch,
    authorizationGeneration: overrides.authorizationGeneration ?? "7",
    resource: { type: (overrides.resourceType ?? "organization") as "client" | "organization",
      id: remotePublicId, revision: overrides.revision ?? "9" },
    profile: { name: "Remote", email: null, phone: null,
      address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null } },
    requestId: uuid() } };
}

beforeEach(async () => {
  sequence = 0;
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB");
  await apply(`
    CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER);
    CREATE TABLE project_alpha_existing_directory_binding_review_evidence(
      receipt_id TEXT,record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,project_alpha_revision TEXT,review_id TEXT,
      reviewer_staff_id TEXT,reviewer_access_subject TEXT,reviewer_admission_version INTEGER,
      reviewer_profile_version INTEGER,reviewed_local_record_version INTEGER);
    CREATE TABLE project_alpha_existing_directory_binding_acquired_mapping_receipts(
      receipt_id TEXT,command_id TEXT,record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,
      history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,project_alpha_revision TEXT);
    CREATE TABLE Delivery(id TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE delivery_public_links(id TEXT PRIMARY KEY,value TEXT);
    INSERT INTO Delivery VALUES('delivery-one','preserve');
    INSERT INTO delivery_public_links VALUES('link-one','preserve');
  `);
  await apply(readFileSync(new URL("../migrations/0136_project_alpha_directory_reconciliation.sql", import.meta.url), "utf8"));
  await apply(readFileSync(new URL("../migrations/0138_project_alpha_directory_reconciliation_review.sql", import.meta.url), "utf8"));
});
afterEach(async () => runtime.dispose());

describe("administrator reconciliation review service", () => {
  it("keyset-pages a 47/7 two-source feed without profile fields, secrets, or public-link writes", async () => {
    await completeRun(sourceA, 27); await completeRun(sourceB, 27);
    const first = await listProjectAlphaDirectoryReconciliationFindings(env(), { sourceIds: [sourceB, sourceA], limit: 47 });
    expect(first?.items).toHaveLength(47); expect(first?.nextCursor).toBeTruthy();
    const second = await listProjectAlphaDirectoryReconciliationFindings(env(), {
      sourceIds: [sourceA, sourceB], limit: 47, cursor: first!.nextCursor!,
    });
    expect(second?.items).toHaveLength(7); expect(second?.nextCursor).toBeNull();
    const serialized = JSON.stringify([first, second]);
    expect(serialized).not.toMatch(/secret@example|Secret Name|private-secret|profile_json|details_json|apiKey/i);
    expect(await db.prepare("SELECT * FROM Delivery").all()).toMatchObject({ results: [{ id: "delivery-one", value: "preserve" }] });
    expect(await db.prepare("SELECT * FROM delivery_public_links").all())
      .toMatchObject({ results: [{ id: "link-one", value: "preserve" }] });
  });

  it("excludes superseded complete snapshots and rejects malformed bounds", async () => {
    const stale = await completeRun(sourceA, 1);
    const current = await completeRun(sourceA, 1);
    const page = await listProjectAlphaDirectoryReconciliationFindings(env(), { sourceIds: [sourceA], limit: 10 });
    expect(page?.items.map(item => item.findingId)).toEqual(current.findings);
    expect(page?.items.map(item => item.findingId)).not.toContain(stale.findings[0]);
    await expect(listProjectAlphaDirectoryReconciliationFindings(env(), { sourceIds: [sourceA], limit: 51 })).resolves.toBeNull();
    await expect(listProjectAlphaDirectoryReconciliationFindings(env(), { sourceIds: [sourceA], limit: 1, cursor: "bad" }))
      .resolves.toBeNull();
    await completeRun(sourceB, 2);
    const sourceBPage = await listProjectAlphaDirectoryReconciliationFindings(env(), { sourceIds: [sourceB], limit: 1 });
    expect(sourceBPage?.nextCursor).toBeTruthy();
    await expect(listProjectAlphaDirectoryReconciliationFindings(env(), {
      sourceIds: [sourceA], limit: 1, cursor: sourceBPage?.nextCursor ?? "",
    })).resolves.toBeNull();
  });

  it("derives PA identity from the current finding, rechecks every fence, and replays exactly", async () => {
    const selected = await completeRun(sourceA, 1);
    await db.prepare("INSERT INTO operations_directory_records VALUES(?,?,?)").bind(recordId, "organization", 2).run();
    const readProfile = vi.fn(async () => observed(sourceA, selected.publics[0]!));
    const acquire = vi.fn(async (_env, input: Record<string, unknown>) => {
      expect(input).toMatchObject({ sourceId: sourceA, recordId, resourceType: "organization",
        projectAlphaPublicId: selected.publics[0], localRecordVersion: 2 });
      return { status: "acquired" as const, reviewReceiptId: "r", commandId: String(input.commandId),
        acquiredReceiptId: uuid(), replayed: false };
    });
    const input = { findingId: selected.findings[0]!, recordId, expectedRecordVersion: 2, idempotencyKey: uuid() };
    const first = await acquireProjectAlphaDirectoryReconciliationFinding(env(), input, reviewer,
      { readProfile: readProfile as never, acquire: acquire as never, uuid, now: () => "2026-09-22T12:00:00.000Z" });
    expect(first).toMatchObject({ status: "acquired", replayed: false });
    expect(JSON.stringify(first)).not.toMatch(/Remote|email|profile|private/i);
    const replay = await acquireProjectAlphaDirectoryReconciliationFinding(env(), input, reviewer,
      { readProfile: readProfile as never, acquire: acquire as never, uuid });
    expect(replay).toMatchObject({ status: "acquired", replayed: true, acquiredReceiptId: first.status === "acquired" ? first.acquiredReceiptId : "" });
    expect(readProfile).toHaveBeenCalledTimes(1); expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("allows one native record in two PA sources but rejects same-source collisions and retargeted replay", async () => {
    const a = await completeRun(sourceA, 2), b = await completeRun(sourceB, 1);
    await db.prepare("INSERT INTO operations_directory_records VALUES(?,?,?)").bind(recordId, "organization", 1).run();
    const acquire = vi.fn(async () => ({ status: "acquired" as const, reviewReceiptId: uuid(), commandId: uuid(),
      acquiredReceiptId: uuid(), replayed: false }));
    const run = (findingId: string, sourceId: string, remote: string, idempotencyKey = uuid()) =>
      acquireProjectAlphaDirectoryReconciliationFinding(env(), { findingId, recordId, expectedRecordVersion: 1, idempotencyKey }, reviewer,
        { readProfile: (async () => observed(sourceId, remote)) as never, acquire: acquire as never, uuid });
    await expect(run(a.findings[0]!, sourceA, a.publics[0]!)).resolves.toMatchObject({ status: "acquired" });
    await expect(run(b.findings[0]!, sourceB, b.publics[0]!)).resolves.toMatchObject({ status: "acquired" });
    await expect(run(a.findings[1]!, sourceA, a.publics[1]!)).resolves.toEqual({ status: "conflict", reason: "reservation" });
    await expect(run(a.findings[0]!, sourceA, a.publics[0]!, uuid())).resolves
      .toEqual({ status: "conflict", reason: "reservation" });
    const rotated = await completeRun(sourceA, 1, { sourceInstanceId: sourceInstanceA,
      applicationId: "10000000-0000-4000-8000-000000000099", historyEpoch: "10000000-0000-4000-8000-000000000098" });
    await expect(acquireProjectAlphaDirectoryReconciliationFinding(env(), {
      findingId: rotated.findings[0]!, recordId, expectedRecordVersion: 1, idempotencyKey: uuid(),
    }, reviewer, {
      readProfile: (async () => observed(sourceA, rotated.publics[0]!, {
        applicationId: "10000000-0000-4000-8000-000000000099", historyEpoch: "10000000-0000-4000-8000-000000000098",
      })) as never, acquire: acquire as never, uuid,
    })).resolves.toEqual({ status: "conflict", reason: "reservation" });
    await db.prepare("UPDATE operations_directory_records SET record_kind='client',current_version=2 WHERE record_id=?")
      .bind(recordId).run();
    const crossKind = await completeRun(sourceA, 1, identity(sourceA), "client");
    await expect(acquireProjectAlphaDirectoryReconciliationFinding(env(), {
      findingId: crossKind.findings[0]!, recordId, expectedRecordVersion: 2, idempotencyKey: uuid(),
    }, reviewer, {
      readProfile: (async () => observed(sourceA, crossKind.publics[0]!, { resourceType: "client" })) as never,
      acquire: acquire as never, uuid,
    })).resolves.toEqual({ status: "conflict", reason: "reservation" });
  });

  it("fails closed on generation or current-run changes and retries uncertain remote reads with one reservation", async () => {
    const selected = await completeRun(sourceA, 1);
    await db.prepare("INSERT INTO operations_directory_records VALUES(?,?,?)").bind(recordId, "organization", 1).run();
    const input = { findingId: selected.findings[0]!, recordId, expectedRecordVersion: 1, idempotencyKey: uuid() };
    const acquire = vi.fn();
    await expect(acquireProjectAlphaDirectoryReconciliationFinding(env(), input, reviewer, {
      readProfile: (async () => observed(sourceA, selected.publics[0]!, { authorizationGeneration: "8" })) as never,
      acquire, uuid,
    })).resolves.toEqual({ status: "blocked", reason: "stale_snapshot" });
    expect(acquire).not.toHaveBeenCalled();
    const count = await db.prepare("SELECT COUNT(*) count FROM project_alpha_directory_reconciliation_actions").first<{ count: number }>();
    expect(count?.count).toBe(1);
    await completeRun(sourceA, 1);
    await expect(acquireProjectAlphaDirectoryReconciliationFinding(env(), input, reviewer, {
      readProfile: (async () => observed(sourceA, selected.publics[0]!)) as never, acquire, uuid,
    })).resolves.toEqual({ status: "blocked", reason: "stale_snapshot" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it("preserves the same reservation across uncertain acquisition retries", async () => {
    const selected = await completeRun(sourceB, 1);
    await db.prepare("INSERT INTO operations_directory_records VALUES(?,?,?)").bind(recordId, "organization", 4).run();
    const input = { findingId: selected.findings[0]!, recordId, expectedRecordVersion: 4, idempotencyKey: uuid() };
    const acquire = vi.fn()
      .mockResolvedValueOnce({ status: "uncertain", reason: "transport" })
      .mockResolvedValueOnce({ status: "acquired", reviewReceiptId: uuid(), commandId: uuid(), acquiredReceiptId: uuid(), replayed: true });
    const options = { readProfile: (async () => observed(sourceB, selected.publics[0]!)) as never, acquire: acquire as never, uuid };
    await expect(acquireProjectAlphaDirectoryReconciliationFinding(env(), input, reviewer, options))
      .resolves.toEqual({ status: "uncertain", reason: "acquisition" });
    await expect(acquireProjectAlphaDirectoryReconciliationFinding(env(), input, reviewer, options))
      .resolves.toMatchObject({ status: "acquired" });
    const rows = await db.prepare("SELECT action_id,review_id,command_id FROM project_alpha_directory_reconciliation_actions").all();
    expect(rows.results).toHaveLength(1);
    expect(acquire.mock.calls[0]?.[1]).toMatchObject({ reviewId: rows.results[0]?.review_id, commandId: rows.results[0]?.command_id });
    expect(acquire.mock.calls[1]?.[1]).toMatchObject({ reviewId: rows.results[0]?.review_id, commandId: rows.results[0]?.command_id });
    expect(await db.prepare("SELECT * FROM Delivery").all()).toMatchObject({ results: [{ id: "delivery-one", value: "preserve" }] });
    expect(await db.prepare("SELECT * FROM delivery_public_links").all())
      .toMatchObject({ results: [{ id: "link-one", value: "preserve" }] });
  });

  it("reports a durable acquisition outcome as resolved even when the finding update is interrupted", async () => {
    const selected = await completeRun(sourceA, 1);
    await db.prepare("INSERT INTO operations_directory_records VALUES(?,?,?)").bind(recordId, "organization", 1).run();
    await db.prepare(`CREATE TRIGGER test_interrupt_finding_review BEFORE UPDATE ON
      project_alpha_directory_reconciliation_findings BEGIN SELECT RAISE(ABORT,'interrupted'); END`).run();
    const input = { findingId: selected.findings[0]!, recordId, expectedRecordVersion: 1, idempotencyKey: uuid() };
    await expect(acquireProjectAlphaDirectoryReconciliationFinding(env(), input, reviewer, {
      readProfile: (async () => observed(sourceA, selected.publics[0]!)) as never,
      acquire: (async () => ({ status: "acquired", reviewReceiptId: uuid(), commandId: uuid(),
        acquiredReceiptId: uuid(), replayed: false })) as never, uuid,
    })).resolves.toMatchObject({ status: "acquired" });
    expect(await db.prepare(`SELECT review_state reviewState FROM project_alpha_directory_reconciliation_findings
      WHERE finding_id=?`).bind(selected.findings[0]).first()).toEqual({ reviewState: "open" });
    const page = await listProjectAlphaDirectoryReconciliationFindings(env(), { sourceIds: [sourceA], limit: 10 });
    expect(page?.items[0]?.reviewState).toBe("resolved");
  });
});
