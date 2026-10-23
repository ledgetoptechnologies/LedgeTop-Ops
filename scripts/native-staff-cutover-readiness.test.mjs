import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { verifyNativeStaffCutoverReadiness as verify, readNativeStaffCutoverReadiness as capture,
  nativeStaffReadinessEnvironment, canonicalStaffReadiness, NATIVE_STAFF_PRODUCTION_TARGET as TARGET, NATIVE_STAFF_READINESS_SNAPSHOT_QUERY as QUERY } from "./native-staff-cutover-readiness.mjs";
const now = Date.parse("2026-10-23T03:00:00Z"), sourceCommit = "a".repeat(40), digest = s => createHash("sha256").update(s).digest("hex");
function fixture() {
  const cohort = [{ staffId: "synthetic-admin", email: "synthetic@example.invalid", accessSubject: "access|synthetic",
    displayName: "Synthetic Admin", active: true, admissionVersion: 4, profileVersion: 2 }];
  const cohortSha256 = digest(canonicalStaffReadiness(cohort));
  const canonicalPlanJson = JSON.stringify({ kind: "operations-native-staff-cutover-v1", cohortSha256, controlPlaneStaffIds: [cohort[0].staffId] });
  const bindingEvidenceJson = JSON.stringify({ kind: "operations-native-staff-binding-review-v1", cohortSha256,
    operatorStaffId: cohort[0].staffId, operatorSubject: cohort[0].accessSubject });
  const ref = { approvalId: "synthetic-maintenance-approval", commandId: "synthetic-bootstrap-command",
    canonicalPlanSha256: digest(canonicalPlanJson), bindingEvidenceSha256: digest(bindingEvidenceJson),
    operatorStaffId: cohort[0].staffId, operatorSubject: cohort[0].accessSubject };
  return {
    review: { schemaVersion: 1, sourceCommit, accountId: TARGET.accountId, databaseId: TARGET.databaseId, cohort, bootstrapReceipts: [ref] },
    observation: { schemaVersion: 1, accountId: TARGET.accountId, databaseId: TARGET.databaseId, observedAt: new Date(now).toISOString(),
      control: { enabled: 1, generation: 3, appliedGeneration: 3, leaseId: null, lastSuccessAt: new Date(now).toISOString(), lastError: null },
      cohort: structuredClone(cohort), bridgeMismatchCount: 0, controlPlaneStaffIds: [cohort[0].staffId],
      bootstrapReceipts: [{ ...ref, canonicalPlanJson, bindingEvidenceJson, valid: 1 }] },
  };
}
const options = { sourceCommit, now };
test("accepts only exact reviewed identity/control-plane/bootstrap evidence and emits no identities", () => {
  const f = fixture(), result = verify(f.review, f.observation, options);
  assert.equal(result.staffCount, 1); assert.equal(result.generation, 3); assert.ok(Object.isFrozen(result));
  assert.doesNotMatch(JSON.stringify(result), /synthetic@example|access\|synthetic|canonicalPlanJson/u);
});
const changes = {
  "wrong source": f => { f.review.sourceCommit = "b".repeat(40); },
  "wrong target": f => { f.observation.databaseId = "00000000-0000-4000-8000-000000000000"; },
  "stale observation": f => { f.observation.observedAt = new Date(now - 60001).toISOString(); },
  "future observation": f => { f.observation.observedAt = new Date(now + 1).toISOString(); },
  "disabled handoff": f => { f.observation.control.enabled = 0; },
  "pending remote reconciliation": f => { f.observation.control.appliedGeneration = 2; },
  "degraded already-applied group": f => { f.observation.control.lastError = "reconciliation-pending"; },
  "in-flight lease": f => { f.observation.control.leaseId = "synthetic-lease"; },
  "no successful group readback": f => { f.observation.control.lastSuccessAt = null; },
  "stale successful group readback": f => { f.observation.control.lastSuccessAt = new Date(now - 60001).toISOString(); },
  "mismatched legacy/native bridge": f => { f.observation.bridgeMismatchCount = 1; },
  "changed exact identity": f => { f.observation.cohort[0].accessSubject = "different"; },
  "changed admission version": f => { f.observation.cohort[0].admissionVersion++; },
  "changed profile version": f => { f.observation.cohort[0].profileVersion++; },
  "extra admitted employee": f => { f.observation.cohort.push({ ...f.observation.cohort[0], staffId: "other", email: "other@example.invalid", accessSubject: "other" }); },
  "missing complete native control plane": f => { f.observation.controlPlaneStaffIds = []; },
  "unknown control plane identity": f => { f.observation.controlPlaneStaffIds = ["unknown"]; },
  "missing reviewed bootstrap reference": f => { f.review.bootstrapReceipts = []; },
  "missing durable receipt": f => { f.observation.bootstrapReceipts = []; },
  "revoked/invalid approval": f => { f.observation.bootstrapReceipts[0].valid = 0; },
  "tampered approved plan": f => { f.observation.bootstrapReceipts[0].canonicalPlanJson = "{}"; },
  "tampered identity evidence": f => { f.observation.bootstrapReceipts[0].bindingEvidenceJson = "{}"; },
  "self-reported approvalboolean": f => { f.review.approved = true; },
};
for (const [name, change] of Object.entries(changes)) test(`refuses ${name}`, () => {
  const f = fixture(); change(f); assert.throws(() => verify(f.review, f.observation, options), /native_staff_cutover_not_ready/u);
});
test("read-only preflight uses exactly one finite SELECT and deletes only its own temporary config", async () => {
  const f = fixture(); let config, calls = 0;
  const read = async args => {
    calls++; assert.equal(args[0], "d1"); assert.equal(args[1], "execute"); assert.equal(args[2], TARGET.databaseId);
    assert.equal(args[3], "--remote"); assert.equal(args[6], "--command"); assert.equal(args[7], QUERY); assert.equal(args[8], "--json");
    config = args[5]; const parsed = JSON.parse(await readFile(config, "utf8")); assert.equal(parsed.account_id, TARGET.accountId);
    const { schemaVersion, accountId, databaseId, observedAt, ...selected } = f.observation;
    selected.cohort = selected.cohort.map(row => ({ ...row, active: row.active ? 1 : 0 }));
    return JSON.stringify([{ success: true, results: [{ readiness_snapshot: JSON.stringify(selected) }] }]);
  };
  const result = await capture({ review: f.review, sourceCommit, read, now: () => now });
  assert.equal(result.staffCount, 1); assert.equal(calls, 1); await assert.rejects(access(config));
});
test("reader refusal performs no remote mutation and ignores no failed/oversized query result", async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(capture({ review: f.review, sourceCommit, now: () => now, read: async () => { calls++; return [{ success: false, results: [] }]; } }));
  assert.equal(calls, 1);
  await assert.rejects(capture({ review: { ...f.review, accountId: "wrong" }, sourceCommit, read: async () => { throw Error("must not read"); } }));
});
test("query contains no mutation, caller SQL interpolation, credentials, recovery or migration command", () => {
  assert.match(QUERY, /^SELECT json_object/u);
  assert.doesNotMatch(QUERY, /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|PRAGMA|CREATE|BEGIN|COMMIT)\b/iu);
});
test("standalone reader refuses missing conventional token/account before any child/login and strips overrides", async () => {
  const f = fixture();
  await assert.rejects(capture({ review: f.review, sourceCommit, env: {} }), /noninteractive_environment_required/u);
  const base = { CLOUDFLARE_ACCOUNT_ID: TARGET.accountId, CLOUDFLARE_API_TOKEN: "synthetic-test-token-not-a-real-secret" };
  const e = nativeStaffReadinessEnvironment({ ...base, WRANGLER_LOG: "debug", WRANGLER_API_BASE_URL: "https://evil.invalid", ANOTHER_SECRET: "not-carried" });
  assert.equal(e.CI, "true"); assert.equal(e.WRANGLER_WRITE_LOGS, "false"); assert.equal(e.WRANGLER_SEND_METRICS, "false");
  assert.equal(e.WRANGLER_LOG, "error"); assert.equal(e.ANOTHER_SECRET, undefined); assert.equal(e.WRANGLER_API_BASE_URL, undefined);
  for (const key of ["HTTP_PROXY", "https_proxy", "ALL_PROXY", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"])
    assert.throws(() => nativeStaffReadinessEnvironment({ ...base, [key]: "unsafe-override" }), /noninteractive_environment_required/u);
});
test("a correctly hashed directory-only maintenance receipt cannot authorize staff cutover", () => {
  const f = fixture(), plan = JSON.stringify({ kind:"directory-authority-maintenance",cohortSha256:"a".repeat(64) });
  f.observation.bootstrapReceipts[0].canonicalPlanJson = plan;
  f.observation.bootstrapReceipts[0].canonicalPlanSha256 = digest(plan);
  f.review.bootstrapReceipts[0].canonicalPlanSha256 = digest(plan);
  assert.throws(() => verify(f.review,f.observation,options),/staff_cutover_review_purpose_invalid/u);
});
test("raw SQL activity values must be exact bits before conversion", async () => {
  const f = fixture(), { schemaVersion,accountId,databaseId,observedAt,...selected } = f.observation;
  selected.cohort[0].active = 2;
  await assert.rejects(capture({review:f.review,sourceCommit,now:()=>now,read:async()=>[
    {success:true,results:[{readiness_snapshot:JSON.stringify(selected)}]}] }),/cohort_active_invalid/u);
});
