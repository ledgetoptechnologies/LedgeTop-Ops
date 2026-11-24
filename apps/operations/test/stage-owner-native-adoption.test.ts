import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { readStageOwnerAdoptionSnapshot as readCurrentStageOwnerAdoptionSnapshot } from "../../../scripts/stage-owner-native-adoption.mjs";
// @ts-expect-error reviewed test-only JavaScript fixture
import { historicalOperations0244Fixture, loadHistoricalStageOwnerAdoption } from "../../../scripts/test-fixtures/historical-operations-0244.mjs";

const historical = historicalOperations0244Fixture();
const {
  STAGE_OWNER_ADOPTION_MIGRATIONS: MIGRATIONS, STAGE_OWNER_ADOPTION_TARGET_STAFF_ID: TARGET, STAGE_PINS,
  assertStageOwnerAdoptionPinsProvisioned, buildStageOwnerAdoptionPlan, executeStageOwnerAdoption, prepareStageOwnerAdoption,
  readStageOwnerAdoptionSnapshot, readStageOwnerAdoptionSourceMigrations, stageOwnerAdoptionConsentEnvelope,
} = loadHistoricalStageOwnerAdoption(historical) as typeof import("../../../scripts/stage-owner-native-adoption.mjs");

// Only the fixed, public Stage tuple is reused as a LOCAL Miniflare namespace.
// Rows, tokens and keys are synthetic; no transport/provider is configured.
const PINS = STAGE_PINS;
const TARGET_DB = Object.freeze({ accountId: PINS.accountId, databaseId: PINS.databaseId });
const OWNER = Object.freeze({ email: "owner@example.test", subject: "access|synthetic-owner", name: "Synthetic Owner" });
const LIVE_TOKEN = "synthetic-live-identity-token";
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value === null || typeof value !== "object" ? JSON.stringify(value)
    : `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(",")}}`;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const consentKey = generateKeyPairSync("ed25519"), otherKey = generateKeyPairSync("ed25519");

let runtime: Miniflare, db: D1Database, serial = 0;
const claims = { staffId: TARGET, email: OWNER.email, accessSubject: OWNER.subject, verifiedUntil: new Date(Date.now() + 60 * 60_000).toISOString() };
const verifyOwnerIdentity = async (token: string) => { if (token !== LIVE_TOKEN) throw new Error("bad token"); return { ...claims }; };
const verifyConsent = async ({ envelopeSha256, proof }: any) =>
  verifyBytes(null, Buffer.from(envelopeSha256, "hex"), consentKey.publicKey, Buffer.from(proof, "base64"));
const submitBatch = async (request: any, target: any) => {
  expect(target).toEqual(TARGET_DB);
  return db.batch(request.batch.map((statement: any) => db.prepare(statement.sql).bind(...statement.params)));
};
const verifiers = { verifyOwnerIdentity, verifyConsent };
const execOptions = { ownerIdentityToken: LIVE_TOKEN, verifyOwnerIdentity, verifyConsent, submitBatch };

async function request(overrides: { issuedAt?: string; expiresAt?: string; key?: any; mutatePlan?: (plan: any) => void;
  mutateEnvelope?: (envelope: any) => void } = {}) {
  const snapshot = await readStageOwnerAdoptionSnapshot(db, TARGET_DB);
  const id = ++serial, approval = { approvalId: `synthetic-approval-${id}`,
    issuedAt: overrides.issuedAt ?? new Date(Date.now() - 60_000).toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString() };
  const commandId = `synthetic-command-${id}`;
  let canonicalPlanJson = buildStageOwnerAdoptionPlan(snapshot, { approvalId: approval.approvalId, commandId });
  if (overrides.mutatePlan) { const plan = JSON.parse(canonicalPlanJson); overrides.mutatePlan(plan); canonicalPlanJson = canonical(plan); }
  const envelope: any = stageOwnerAdoptionConsentEnvelope({ snapshot, canonicalPlanJson, approval, commandId });
  overrides.mutateEnvelope?.(envelope);
  const proof = signBytes(null, Buffer.from(sha(canonical(envelope)), "hex"), (overrides.key ?? consentKey).privateKey).toString("base64");
  return { target: { ...TARGET_DB }, reviewedSnapshot: { snapshotJson: snapshot.snapshotJson, snapshotSha256: snapshot.snapshotSha256 },
    canonicalPlanJson, approval, commandId, ownerIdentityToken: LIVE_TOKEN, consent: { envelope, proof } };
}

async function nativeCounts() {
  return db.prepare(`SELECT (SELECT count(*) FROM native_staff_admissions WHERE staff_id=?1) a,
    (SELECT count(*) FROM native_staff_profiles WHERE staff_id=?1) p,
    (SELECT count(*) FROM native_staff_bootstrap_approvals WHERE approved_operator_staff_id=?1) ap,
    (SELECT count(*) FROM native_staff_bootstrap_receipts WHERE operator_staff_id=?1) r`).bind(TARGET).first<any>();
}
const none = { a: 0, p: 0, ap: 0, r: 0 };

// Each full-state snapshot/CAS pass over the full pinned schema is slow
// on local Windows Miniflare; this bounds test time only, not production.
describe("Stage owner native adoption (fixed-purpose, synthetic)", { timeout: 300_000 }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default {fetch(){return new Response('ok')}}", d1Databases: { OPS_DB: PINS.databaseId } });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    for (const name of historical.source.names) {
      await db.batch(splitD1MigrationStatements(readFileSync(path.join(historical.migrations, name), "utf8")).map(sql => db.prepare(sql)));
      await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name).run();
    }
    await db.batch([
      // 0002 seeds the owner row; replace its identity fields with synthetic values.
      db.prepare("UPDATE staff_users SET email=?,display_name=?,access_subject=? WHERE id=?").bind(OWNER.email, OWNER.name, OWNER.subject, TARGET),
      db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES('staff-other','other@example.test','Other','access|other')"),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES('staff-other','access|other',1,'staff-other')"),
    ]);
  }, 600_000);
  afterAll(async () => {
    try { await runtime?.dispose(); }
    finally { historical.cleanup(); }
  });

  it("admits the pinned 0244 source and refuses the current 0247/0248 source", async () => {
    const source = readStageOwnerAdoptionSourceMigrations();
    expect(source.names.length).toBe(MIGRATIONS.count);
    expect(source.names.at(-1)).toBe(MIGRATIONS.last);
    expect(source.namesSha256).toBe(MIGRATIONS.namesSha256);
    expect(source.contentsSha256).toBe(MIGRATIONS.contentsSha256);
    await expect(readCurrentStageOwnerAdoptionSnapshot(db, TARGET_DB)).rejects.toThrow("source_migration_chain_changed");
  });

  it("ships only the Merger-verified Stage tuple and refuses placeholder or mismatched targets", async () => {
    expect(STAGE_PINS).toEqual({ environment: "staging", accountId: "df3f376bae6ee621f50cf972ebcc9484",
      databaseId: "a58ea102-f04d-417a-bfd1-b0654cfeb503" });
    expect(assertStageOwnerAdoptionPinsProvisioned()).toBe(STAGE_PINS);
    // The tuple pins target selection; Miniflare remains wholly local and synthetic.
    expect((await readStageOwnerAdoptionSnapshot(db, TARGET_DB)).accountId).toBe(STAGE_PINS.accountId);
    const productionPins = { ...PINS, accountId: "846c924bf17bf4f3dd15c97a4c5d1d51" };
    expect(() => assertStageOwnerAdoptionPinsProvisioned(productionPins)).toThrow("stage_pins_unprovisioned");
    await expect(prepareStageOwnerAdoption(await request(), { ...verifiers, pins: productionPins } as any)).rejects.toThrow("stage_pins_override_forbidden");
    expect(() => assertStageOwnerAdoptionPinsProvisioned({ ...PINS, accountId: "0".repeat(32) })).toThrow("stage_pins_unprovisioned");
    expect(() => assertStageOwnerAdoptionPinsProvisioned({ ...PINS, databaseId: "00000000-0000-0000-0000-000000000000" })).toThrow("stage_pins_unprovisioned");
    expect(() => assertStageOwnerAdoptionPinsProvisioned({ ...PINS, environment: "production" })).toThrow("stage_pins_unprovisioned");
    await expect(readStageOwnerAdoptionSnapshot(db, { ...TARGET_DB, databaseId: "22222222-2222-4222-8222-222222222222" }))
      .rejects.toThrow("target_database_mismatch");
  });

  it("refuses when the database ledger differs from the pinned chain", async () => {
    await db.prepare("INSERT INTO d1_migrations(name) VALUES('9999_unreviewed.sql')").run();
    try { await expect(readStageOwnerAdoptionSnapshot(db, TARGET_DB)).rejects.toThrow("database_migration_ledger_mismatch"); }
    finally { await db.prepare("DELETE FROM d1_migrations WHERE name='9999_unreviewed.sql'").run(); }
  });

  it("requires real injected verifiers and never treats their absence as consent", async () => {
    const input = await request();
    await expect(prepareStageOwnerAdoption(input, { verifyConsent } as any)).rejects.toThrow("owner_identity_verifier_unprovisioned");
    await expect(prepareStageOwnerAdoption(input, { verifyOwnerIdentity } as any)).rejects.toThrow("consent_verifier_unprovisioned");
  });

  it("accepts only the fixed two-row, no-grant plan for the fixed target", async () => {
    for (const mutatePlan of [
      (plan: any) => plan.grants.push({ table: "native_directory_grants" }),
      (plan: any) => plan.rows.push({ table: "native_staff_management_delegations", row: { id: "x" } }),
      (plan: any) => { plan.rows[1].row.login_email = "attacker@example.test"; },
      (plan: any) => { plan.rows[0].row.bound_access_subject = "access|attacker"; },
      (plan: any) => { plan.targetStaffId = "staff-other"; },
      (plan: any) => { plan.databaseId = "22222222-2222-4222-8222-222222222222"; },
      (plan: any) => { plan.kind = "operations-native-staff-bootstrap-install-v1"; },
    ]) await expect(prepareStageOwnerAdoption(await request({ mutatePlan }), verifiers)).rejects.toThrow("plan_not_fixed_purpose");
  });

  it("binds live identity to the current staff ID, email and subject", async () => {
    const input = await request();
    for (const wrong of [{ ...claims, staffId: "staff-other" }, { ...claims, email: "other@example.test" },
      { ...claims, accessSubject: "access|other" }, { ...claims, extra: true }]) {
      await expect(prepareStageOwnerAdoption(input, { ...verifiers, verifyOwnerIdentity: async () => wrong }))
        .rejects.toThrow("owner_identity_mismatch");
    }
    await expect(prepareStageOwnerAdoption({ ...input, ownerIdentityToken: "forged" }, verifiers)).rejects.toThrow("owner_identity_unverified");
  });

  it("binds consent to the exact target, purpose, account, database, schema, plan and command", async () => {
    for (const mutateEnvelope of [
      (envelope: any) => { envelope.purpose = "something-else"; },
      (envelope: any) => { envelope.schemaSha256 = "0".repeat(64); },
      (envelope: any) => { envelope.canonicalPlanSha256 = "0".repeat(64); },
      (envelope: any) => { envelope.commandId = "other-command"; },
      (envelope: any) => { envelope.accountId = "b".repeat(32); },
    ]) await expect(prepareStageOwnerAdoption(await request({ mutateEnvelope }), verifiers)).rejects.toThrow("consent_envelope_mismatch");
    await expect(prepareStageOwnerAdoption(await request({ key: otherKey }), verifiers)).rejects.toThrow("consent_untrusted");
  });

  it("refuses expired, not-yet-valid and over-long approval windows", async () => {
    const past = await request({ issuedAt: new Date(Date.now() - 20 * 60_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await expect(prepareStageOwnerAdoption(past, verifiers)).rejects.toThrow("approval_expired_or_not_yet_valid");
    const long = await request({ expiresAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString() });
    await expect(prepareStageOwnerAdoption(long, verifiers)).rejects.toThrow("approval_window_invalid");
    const prepared = await prepareStageOwnerAdoption(await request(), verifiers);
    await expect(executeStageOwnerAdoption(db, prepared, { ...execOptions, now: () => Date.now() + 60 * 60_000 }))
      .rejects.toThrow("approval_expired_or_not_yet_valid");
    expect(await nativeCounts()).toEqual(none);
  });

  it("does not retain the identity token and needs a fresh live one at execution", async () => {
    const prepared = await prepareStageOwnerAdoption(await request(), verifiers);
    expect(JSON.stringify(prepared)).not.toContain(LIVE_TOKEN);
    await expect(executeStageOwnerAdoption(db, prepared, { ...execOptions, ownerIdentityToken: undefined }))
      .rejects.toThrow("owner_identity_token_required");
    await expect(executeStageOwnerAdoption(db, { ...prepared } as any, execOptions)).rejects.toThrow("prepared_artifact_invalid");
    expect(await nativeCounts()).toEqual(none);
  });

  it("CAS refuses status, email, subject and ACL drift after review", async () => {
    const drifts: [string, string, string][] = [
      ["UPDATE staff_users SET status='inactive' WHERE id=?", "UPDATE staff_users SET status='active' WHERE id=?", "snapshot_changed_rows"],
      ["UPDATE staff_users SET email='changed@example.test' WHERE id=?", `UPDATE staff_users SET email='${OWNER.email}' WHERE id=?`, "snapshot_changed_rows"],
      ["UPDATE staff_users SET access_subject='access|changed' WHERE id=?", `UPDATE staff_users SET access_subject='${OWNER.subject}' WHERE id=?`, "snapshot_changed_rows"],
      ["INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by) VALUES('synthetic-acl-drift',?,'role-operator','global',NULL,'global','staff-other')",
        "DELETE FROM staff_role_assignments WHERE id='synthetic-acl-drift' AND staff_id=?", "snapshot_changed_rows"],
    ];
    for (const [change, restore, code] of drifts) {
      const prepared = await prepareStageOwnerAdoption(await request(), verifiers);
      await db.prepare(change).bind(TARGET).run();
      try { await expect(executeStageOwnerAdoption(db, prepared, execOptions)).rejects.toThrow(code); }
      finally { await db.prepare(restore).bind(TARGET).run(); }
      expect(await nativeCounts()).toEqual(none);
    }
  });

  it("rolls back the whole batch when a later write fails, and the SQL gate enforces the window", async () => {
    const prepared = await prepareStageOwnerAdoption(await request(), verifiers);
    // Unguarded concurrent change: another staff profile claims the owner's login email.
    await db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES('staff-other',?,'Other')").bind(OWNER.email).run();
    try { await expect(executeStageOwnerAdoption(db, prepared, execOptions)).rejects.toThrow("atomic_batch_refused"); }
    finally { await db.prepare("DELETE FROM native_staff_profiles WHERE staff_id='staff-other'").run(); }
    expect(await nativeCounts()).toEqual(none);
    // JS clock is told the window is open; D1's own clock is not, so the gated approval insert aborts.
    const issuedAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const future = await prepareStageOwnerAdoption(await request({ issuedAt, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() }),
      { ...verifiers, now: () => Date.parse(issuedAt) });
    await expect(executeStageOwnerAdoption(db, future, { ...execOptions, now: () => Date.parse(issuedAt) })).rejects.toThrow("atomic_batch_refused");
    expect(await nativeCounts()).toEqual(none);
  });

  it("D1 refuses an expired verified JWT even when the injected JS clock still considers it live", async () => {
    const jsNow = Date.now() - 2 * 60_000;
    const jwtDeadline = new Date(Date.now() - 60_000).toISOString();
    const identity = async () => ({ ...claims, verifiedUntil: jwtDeadline });
    const input = await request({ issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    const prepared = await prepareStageOwnerAdoption(input, { ...verifiers, verifyOwnerIdentity: identity, now: () => jsNow });
    await expect(executeStageOwnerAdoption(db, prepared, { ...execOptions, verifyOwnerIdentity: identity, now: () => jsNow }))
      .rejects.toThrow("atomic_batch_refused");
    expect(await nativeCounts()).toEqual(none);
  });

  it("rolls back all writes when the final receipt's verified-expiry gate closes", async () => {
    const prepared = await prepareStageOwnerAdoption(await request(), verifiers);
    const lateReceipt = async (request: any, target: any) => {
      const final = request.batch.at(-1);
      expect(final.sql).toContain("julianday(?)>julianday('now')");
      // Fault-inject expiry only at the final DB gate: approval and identity inserts run first.
      final.params[2] = new Date(Date.now() - 60_000).toISOString();
      return submitBatch(request, target);
    };
    await expect(executeStageOwnerAdoption(db, prepared, { ...execOptions, submitBatch: lateReceipt }))
      .rejects.toThrow("atomic_batch_refused");
    expect(await nativeCounts()).toEqual(none);
  });

  it("installs exactly two identity rows plus immutable approval and receipt, tolerating last_seen_at refresh", async () => {
    const before = await db.prepare("SELECT count(*) n FROM native_directory_grants").first<any>();
    const prepared = await prepareStageOwnerAdoption(await request(), verifiers);
    await db.prepare("UPDATE staff_users SET last_seen_at=datetime('now') WHERE id=?").bind(TARGET).run();
    const result = await executeStageOwnerAdoption(db, prepared, execOptions);
    expect(result).toMatchObject({ targetStaffId: TARGET, insertedRowCount: 2, grantCount: 0 });
    expect(await nativeCounts()).toEqual({ a: 1, p: 1, ap: 1, r: 1 });
    expect(await db.prepare("SELECT bound_access_subject,active,admitted_by FROM native_staff_admissions WHERE staff_id=?").bind(TARGET).first())
      .toEqual({ bound_access_subject: OWNER.subject, active: 1, admitted_by: TARGET });
    expect(await db.prepare("SELECT login_email,display_name,version FROM native_staff_profiles WHERE staff_id=?").bind(TARGET).first())
      .toEqual({ login_email: OWNER.email, display_name: OWNER.name, version: 1 });
    expect(await db.prepare("SELECT count(*) n FROM native_directory_grants").first<any>()).toEqual(before);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_management_delegations WHERE actor_staff_id=?").bind(TARGET).first<any>()).toEqual({ n: 0 });
    await expect(db.prepare("DELETE FROM native_staff_bootstrap_receipts WHERE operator_staff_id=?").bind(TARGET).run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM native_staff_admissions WHERE staff_id=?").bind(TARGET).run()).rejects.toThrow();

    // Replay of the same prepared artifact, and any fresh attempt, are refused.
    await expect(executeStageOwnerAdoption(db, prepared, execOptions)).rejects.toThrow("snapshot_changed");
    await expect(readStageOwnerAdoptionSnapshot(db, TARGET_DB)).rejects.toThrow("target_already_native_or_identity_taken");
    expect(await nativeCounts()).toEqual({ a: 1, p: 1, ap: 1, r: 1 });
  });
});
