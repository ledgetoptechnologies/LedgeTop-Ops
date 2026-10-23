import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { verifyNativeStaffCutoverReadiness as verify, readNativeStaffCutoverReadiness as capture,
  nativeStaffReadinessEnvironment, canonicalStaffReadiness, NATIVE_STAFF_PRODUCTION_TARGET as TARGET,
  NATIVE_STAFF_READINESS_QUERIES as QUERIES, NATIVE_STAFF_READINESS_SNAPSHOT_QUERY as QUERY } from "./native-staff-cutover-readiness.mjs";
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
    review: { schemaVersion: 3, sourceCommit, accountId: TARGET.accountId, databaseId: TARGET.databaseId, cohort, controlPlaneStaffIds:[cohort[0].staffId],
      handoff: { cohort:structuredClone(cohort),controlPlaneStaffIds:[cohort[0].staffId] },bootstrapReceipts: [ref],onboardingReceipts:[] },
    observation: { schemaVersion: 1, accountId: TARGET.accountId, databaseId: TARGET.databaseId, observedAt: new Date(now).toISOString(),
      control: { enabled: 1, generation: 3, appliedGeneration: 3, leaseId: null, lastSuccessAt: new Date(now).toISOString(), lastError: null },
      cohort: structuredClone(cohort), bridgeMismatchCount: 0, controlPlaneStaffIds: [cohort[0].staffId],
      bootstrapReceipts: [{ ...ref, canonicalPlanJson, bindingEvidenceJson, valid: 1 }],onboardingReceipts:[] },
  };
}
const options = { sourceCommit, now };

function addOnboarded(f) {
  const row = {staffId:"synthetic-new-admin",email:"new@example.invalid",accessSubject:"access|new-admin",
    displayName:"New Admin",active:true,admissionVersion:1,profileVersion:1};
  const proposal = {memberships:[],directoryGrants:[],managementGrants:[]}, proposalJson=JSON.stringify(proposal),
    proposalSha256=digest(proposalJson),claimEvidenceSha256="b".repeat(64),onboardingId="synthetic-onboarding";
  const createResultJson=JSON.stringify({contractVersion:1,capability:"staff.onboarding.create",onboardingId,
    proposedStaffId:row.staffId,loginEmail:row.email,displayName:row.displayName,expiresAt:new Date(now+60000).toISOString(),
    proposal,proposalSha256,invitationSecretSha256:"c".repeat(64),resultVersion:1});
  const resultJson=JSON.stringify({contractVersion:1,capability:"staff.onboarding.approve",targetOnboardingId:onboardingId,
    proposedStaffId:row.staffId,proposalSha256,claimEvidenceSha256,claimedAccessSubject:row.accessSubject,proposal,resultVersion:3});
  const ref={commandId:"synthetic-approve",resultSha256:digest(resultJson),createCommandId:"synthetic-create",createResultSha256:digest(createResultJson)};
  f.observation.cohort.push(row);
  f.review.onboardingReceipts.push(ref);
  f.observation.onboardingReceipts.push({...ref,resultJson,createResultJson,onboardingId,staffId:row.staffId,email:row.email,
    accessSubject:row.accessSubject,displayName:row.displayName,proposalJson,proposalSha256,claimEvidenceSha256,valid:1});
  return row;
}
const reviewCurrent = f => { f.review.cohort=structuredClone(f.observation.cohort); f.review.controlPlaneStaffIds=[...f.observation.controlPlaneStaffIds]; };

test("same cohort and generation cannot reuse review after current administrator set changes", () => {
  const f=fixture(), replacement=addOnboarded(f);reviewCurrent(f);
  const initial=verify(f.review,f.observation,options);
  f.observation.controlPlaneStaffIds=[replacement.staffId];
  assert.throws(()=>verify(f.review,f.observation,options),/reviewed_control_plane_changed/u);
  reviewCurrent(f);const updated=verify(f.review,f.observation,options);
  assert.equal(initial.cohortSha256,updated.cohortSha256);assert.equal(initial.generation,updated.generation);
  assert.notEqual(initial.controlPlaneSha256,updated.controlPlaneSha256);
});
test("current administrator set hashing ignores order but refuses duplicates and inactive or missing reviewed IDs", () => {
  const f=fixture(), replacement=addOnboarded(f);
  f.observation.controlPlaneStaffIds.push(replacement.staffId);reviewCurrent(f);
  const initial=verify(f.review,f.observation,options);
  f.observation.controlPlaneStaffIds.reverse();
  assert.equal(verify(f.review,f.observation,options).controlPlaneSha256,initial.controlPlaneSha256);
  for(const ids of [[replacement.staffId,replacement.staffId],[],["unknown"]]) {
    const bad=structuredClone(f);bad.review.controlPlaneStaffIds=ids;
    assert.throws(()=>verify(bad.review,bad.observation,options),/review_control_plane_invalid/u);
  }
  const old=structuredClone(f);old.review.schemaVersion=2;delete old.review.controlPlaneStaffIds;
  assert.throws(()=>verify(old.review,old.observation,options),/review_target_invalid/u);
  const inactive=structuredClone(f);inactive.review.cohort[0].active=false;inactive.observation.cohort[0].active=false;
  inactive.observation.controlPlaneStaffIds=[replacement.staffId];
  assert.throws(()=>verify(inactive.review,inactive.observation,options),/review_control_plane_invalid/u);
});

test("a newly reviewed profile edit retains original immutable handoff provenance", () => {
  const f=fixture(); f.observation.cohort[0].displayName="Updated Name";f.observation.cohort[0].profileVersion++;
  reviewCurrent(f);assert.equal(verify(f.review,f.observation,options).staffCount,1);
});
test("a newly reviewed disable/re-enable version advance retains handoff provenance", () => {
  const f=fixture();f.observation.cohort[0].admissionVersion+=2;reviewCurrent(f);
  assert.equal(verify(f.review,f.observation,options).staffCount,1);
});
test("new staff require explicitly reviewed immutable create and approval identity provenance", () => {
  const f=fixture();addOnboarded(f);reviewCurrent(f);
  assert.equal(verify(f.review,f.observation,options).staffCount,2);
  f.review.onboardingReceipts=[];assert.throws(()=>verify(f.review,f.observation,options),/staff_binding_provenance_missing/u);
});
test("reviewed administrator succession can retire the historical bootstrap operator", () => {
  const f=fixture(),replacement=addOnboarded(f);
  f.observation.cohort[0].active=false;f.observation.cohort[0].admissionVersion++;
  f.observation.controlPlaneStaffIds=[replacement.staffId];reviewCurrent(f);
  assert.equal(verify(f.review,f.observation,options).staffCount,2);
});
test("handoff snapshot tampering cannot be hidden by a freshly reviewed current cohort", () => {
  const f=fixture();f.review.handoff.cohort[0].displayName="Forged historical name";
  assert.throws(()=>verify(f.review,f.observation,options),/staff_cutover_review_purpose_invalid/u);
});
test("reviewing a changed existing subject or email cannot substitute for identity-recovery evidence", () => {
  for(const field of ["email","accessSubject"]) {
    const f=fixture();f.observation.cohort[0][field]=field==="email"?"changed@example.invalid":"access|changed";reviewCurrent(f);
    assert.throws(()=>verify(f.review,f.observation,options),/historical_binding_changed_or_missing/u);
  }
});
test("unreviewed current lifecycle changes still refuse before historical provenance is considered", () => {
  const f=fixture();f.observation.cohort[0].displayName="Unreviewed Edit";f.observation.cohort[0].profileVersion++;
  assert.throws(()=>verify(f.review,f.observation,options),/reviewed_cohort_changed/u);
});
for(const [name,change] of Object.entries({
  "pending approval alone":p=>{p.valid=0;},
  "tampered approval result":p=>{p.resultJson="{}";},
  "tampered creation result":p=>{p.createResultJson="{}";},
  "tampered proposal":p=>{p.proposalJson="{}";},
  "unproven claimed subject":p=>{p.accessSubject="access|forged";},
  "unproven login email":p=>{p.email="forged@example.invalid";},
  "wrong approval linkage":p=>{p.commandId="other-command";},
})) test(`new binding refuses ${name}`,()=>{
  const f=fixture();addOnboarded(f);reviewCurrent(f);change(f.observation.onboardingReceipts[0]);
  assert.throws(()=>verify(f.review,f.observation,options),/native_staff_cutover_not_ready/u);
});

test("fixed onboarding SELECT reads exact create/approve linkage and refuses an unapproved or mismatched row",async()=>{
  // Reader-adapter fixture only. These simplified tables deliberately do not
  // reproduce authorization triggers or purport to execute staff onboarding.
  const {DatabaseSync}=await import("node:sqlite"),db=new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE native_staff_pending_onboarding(onboarding_id,proposed_staff_id,login_email,claimed_access_subject,
      display_name,proposal_json,proposal_sha256,claim_evidence_sha256,state,version,contract_version,terminal_by_staff_id,
      claimed_at,expires_at,terminal_at,created_by_staff_id,created_by_subject,approval_command_id);
      CREATE TABLE native_staff_management_commands(command_id,result_sha256,result_json,contract_version,authority_domain,
      target_kind,target_staff_id,target_proposed_staff_id,target_onboarding_id,expected_version,result_version,actor_staff_id,
      actor_access_subject,executed_at,capability);`);
    const f=fixture();addOnboarded(f);reviewCurrent(f);
    const proof=f.observation.onboardingReceipts[0],original=f.review.handoff.cohort[0];
    const insert=(table,row)=>db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
    insert("native_staff_pending_onboarding",{onboarding_id:proof.onboardingId,proposed_staff_id:proof.staffId,login_email:proof.email,
      claimed_access_subject:proof.accessSubject,display_name:proof.displayName,proposal_json:proof.proposalJson,
      proposal_sha256:proof.proposalSha256,claim_evidence_sha256:proof.claimEvidenceSha256,state:"approved",version:3,contract_version:1,
      terminal_by_staff_id:original.staffId,claimed_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60000).toISOString(),
      terminal_at:new Date(now).toISOString(),created_by_staff_id:original.staffId,created_by_subject:original.accessSubject,
      approval_command_id:proof.commandId});
    const common={contract_version:1,authority_domain:"staff_admin",target_kind:"onboarding",target_staff_id:null,
      target_proposed_staff_id:proof.staffId,target_onboarding_id:proof.onboardingId,actor_staff_id:original.staffId,
      actor_access_subject:original.accessSubject};
    insert("native_staff_management_commands",{...common,command_id:proof.createCommandId,result_sha256:proof.createResultSha256,
      result_json:proof.createResultJson,expected_version:0,result_version:1,executed_at:new Date(now-2000).toISOString(),capability:"staff.onboarding.create"});
    insert("native_staff_management_commands",{...common,command_id:proof.commandId,result_sha256:proof.resultSha256,
      result_json:proof.resultJson,expected_version:2,result_version:3,executed_at:new Date(now).toISOString(),capability:"staff.onboarding.approve"});
    const select=()=>db.prepare(QUERIES.onboarding).all().map(row=>({...row}));
    f.observation.onboardingReceipts=select();assert.equal(f.observation.onboardingReceipts[0].valid,1);
    assert.equal(verify(f.review,f.observation,options).staffCount,2);
    db.exec("UPDATE native_staff_pending_onboarding SET state='claimed'");
    f.observation.onboardingReceipts=select();assert.equal(f.observation.onboardingReceipts[0].valid,0);
    assert.throws(()=>verify(f.review,f.observation,options),/onboarding_proof_invalid/u);
    db.exec("UPDATE native_staff_pending_onboarding SET state='approved'; UPDATE native_staff_management_commands SET expected_version=1 WHERE capability='staff.onboarding.approve'");
    f.observation.onboardingReceipts=select();assert.equal(f.observation.onboardingReceipts[0].valid,0);
    assert.throws(()=>verify(f.review,f.observation,options),/onboarding_proof_invalid/u);
  } finally { db.close(); }
});
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
  // Capability data includes 'staff.onboarding.create'; inspect SQL tokens,
  // not single-quoted data values. The query remains one fixed SELECT.
  assert.doesNotMatch(QUERY.replace(/'(?:''|[^'])*'/gu,"''"), /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|PRAGMA|CREATE|BEGIN|COMMIT)\b/iu);
  assert.doesNotMatch(QUERY, /;|--|\/\*/u);
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
