import { isNativeAccessSubject } from "./native-access-subject";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

export type NativeStaffOnboardingApprovalActor = Readonly<{
  staffId: string; verifiedAccessSubject: string; admissionVersion: number; profileVersion: number;
  email: string; verifiedUntil: string;
}>;
export type NativeStaffOnboardingReview = Readonly<{
  onboardingId: string; proposedStaffId: string; state: "claimed"; version: 2;
  loginEmail: string; displayName: string; expiresAt: string; claimedAccessSubject: string;
  claimEvidenceSha256: string; proposalSha256: string;
  proposal: Readonly<{ memberships: readonly unknown[]; directoryGrants: readonly unknown[]; managementGrants: readonly unknown[] }>;
  createdByStaffId: string; reason: string;
}>;
export type NativeStaffOnboardingApprovalReceipt = Readonly<{
  commandId: string; onboardingId: string; proposedStaffId: string; resultVersion: 3;
  state: "approved"; replayed: boolean;
}>;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
  }
  return value as Record<string, unknown>;
}
function email(value: unknown): value is string {
  return typeof value === "string" && value === value.trim().toLowerCase() && value.length >= 3 && value.length <= 254
    && value.indexOf("@") > 0 && !/[\p{C}\s]/u.test(value);
}
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function emptyProposal(value: unknown): value is NativeStaffOnboardingReview["proposal"] {
  if (!record(value, ["memberships", "directoryGrants", "managementGrants"])) return false;
  const row = value as Record<string, unknown>;
  return Array.isArray(row.memberships) && row.memberships.length === 0
    && Array.isArray(row.directoryGrants) && row.directoryGrants.length === 0
    && Array.isArray(row.managementGrants) && row.managementGrants.length === 0;
}
function actor(value: unknown): NativeStaffOnboardingApprovalActor | null {
  const row = record(value, ["staffId", "verifiedAccessSubject", "admissionVersion", "profileVersion", "email", "verifiedUntil"]);
  if (!row || typeof row.staffId !== "string" || !ID.test(row.staffId) || !isNativeAccessSubject(row.verifiedAccessSubject)
    || !Number.isSafeInteger(row.admissionVersion) || Number(row.admissionVersion) < 1
    || !Number.isSafeInteger(row.profileVersion) || Number(row.profileVersion) < 1 || !email(row.email)
    || typeof row.verifiedUntil !== "string" || !Number.isFinite(Date.parse(row.verifiedUntil))
    || Date.parse(row.verifiedUntil) <= Date.now()) return null;
  return row as unknown as NativeStaffOnboardingApprovalActor;
}
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function reviewShape(row: Record<string, unknown>, rawProposal: string): Promise<NativeStaffOnboardingReview> {
  let proposal: unknown;
  try { proposal = JSON.parse(rawProposal); } catch { throw Error(); }
  if (typeof row.onboarding_id !== "string" || !UUID.test(row.onboarding_id)
    || typeof row.proposed_staff_id !== "string" || !ID.test(row.proposed_staff_id)
    || row.state !== "claimed" || row.version !== 2 || !email(row.login_email)
    || typeof row.display_name !== "string" || !row.display_name.trim() || row.display_name !== row.display_name.trim()
    || row.display_name.length > 160 || typeof row.expires_at !== "string" || !Number.isFinite(Date.parse(row.expires_at))
    || typeof row.claimed_access_subject !== "string" || !isNativeAccessSubject(row.claimed_access_subject)
    || typeof row.claim_evidence_sha256 !== "string" || !HEX.test(row.claim_evidence_sha256)
    || typeof row.proposal_sha256 !== "string" || !HEX.test(row.proposal_sha256)
    || typeof row.created_by_staff_id !== "string" || !ID.test(row.created_by_staff_id)
    || typeof row.reason !== "string" || row.reason.length > 500 || !emptyProposal(proposal)
    || await sha256(rawProposal) !== row.proposal_sha256) throw Error();
  return Object.freeze({ onboardingId: row.onboarding_id, proposedStaffId: row.proposed_staff_id,
    state: "claimed", version: 2, loginEmail: row.login_email, displayName: row.display_name,
    expiresAt: row.expires_at, claimedAccessSubject: row.claimed_access_subject,
    claimEvidenceSha256: row.claim_evidence_sha256, proposalSha256: row.proposal_sha256,
    proposal, createdByStaffId: row.created_by_staff_id, reason: row.reason });
}

const APPROVAL_SCOPE = `EXISTS(SELECT 1 FROM native_staff_management_delegations allow_row
  WHERE allow_row.actor_staff_id=a.staff_id AND allow_row.contract_version=1
    AND allow_row.capability='staff.onboarding.approve' AND allow_row.effect='allow'
    AND allow_row.scope_kind='global' AND allow_row.active=1)
  AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations deny_row
    WHERE deny_row.actor_staff_id=a.staff_id AND deny_row.contract_version=1
      AND deny_row.capability='staff.onboarding.approve' AND deny_row.effect='deny' AND deny_row.active=1
      AND (deny_row.scope_kind='global' OR (deny_row.scope_kind='exact_staff' AND deny_row.target_staff_id=p.proposed_staff_id)))`;

/** Reads the exact claimed version and approved empty-ACL proposal for an authorized reviewer. */
export async function readNativeStaffOnboardingReview(database: D1Database, onboardingId: unknown,
  rawActor: unknown): Promise<NativeStaffOnboardingReview> {
  try {
    const current = actor(rawActor);
    if (!current || typeof onboardingId !== "string" || !UUID.test(onboardingId)) throw Error();
    const row = await database.withSession("first-primary").prepare(`SELECT p.onboarding_id,p.proposed_staff_id,p.state,p.version,
      p.login_email,p.display_name,p.expires_at,p.claimed_access_subject,p.claim_evidence_sha256,p.proposal_sha256,
      p.proposal_json,p.created_by_staff_id,p.reason FROM native_staff_pending_onboarding p
      JOIN native_staff_admissions a ON a.staff_id=? AND a.active=1 AND a.version=?
        AND a.bound_access_subject=? AND a.bound_access_subject<>p.claimed_access_subject
      JOIN native_staff_profiles profile ON profile.staff_id=a.staff_id AND profile.version=? AND profile.login_email=?
      JOIN staff_users staff ON staff.id=a.staff_id AND staff.email=profile.login_email COLLATE BINARY
        AND staff.access_subject=a.bound_access_subject AND staff.status='active'
      WHERE p.onboarding_id=? AND p.state='claimed' AND p.version=2
        AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND json_array_length(p.proposal_json,'$.memberships')=0
        AND json_array_length(p.proposal_json,'$.directoryGrants')=0
        AND json_array_length(p.proposal_json,'$.managementGrants')=0
        AND ${APPROVAL_SCOPE}`)
      .bind(current.staffId, current.admissionVersion, current.verifiedAccessSubject,
        current.profileVersion, current.email, onboardingId).first<Record<string, unknown>>();
    if (!row || typeof row.proposal_json !== "string" || Date.parse(current.verifiedUntil) <= Date.now()) throw Error();
    return await reviewShape(row, row.proposal_json);
  } catch { throw new Error("native_staff_onboarding_approval_denied"); }
}

function approvalInput(value: unknown) {
  const row = record(value, ["commandId", "onboardingId", "expectedVersion", "proposalSha256", "claimEvidenceSha256", "reason"]);
  if (!row || typeof row.commandId !== "string" || !UUID.test(row.commandId)
    || typeof row.onboardingId !== "string" || !UUID.test(row.onboardingId) || row.expectedVersion !== 2
    || typeof row.proposalSha256 !== "string" || !HEX.test(row.proposalSha256)
    || typeof row.claimEvidenceSha256 !== "string" || !HEX.test(row.claimEvidenceSha256)
    || typeof row.reason !== "string" || row.reason !== row.reason.trim() || !row.reason || row.reason.length > 500
    || /\p{C}/u.test(row.reason)) throw new Error("native_staff_onboarding_approval_denied");
  return row as { commandId: string; onboardingId: string; expectedVersion: 2; proposalSha256: string;
    claimEvidenceSha256: string; reason: string };
}

/** Materializes one empty-ACL Operations identity behind the 0074 atomic fence and current 0232 approver authority. */
export async function approveNativeStaffOnboarding(database: D1Database, rawInput: unknown,
  rawActor: unknown): Promise<NativeStaffOnboardingApprovalReceipt> {
  try {
    const current = actor(rawActor), input = approvalInput(rawInput);
    if (!current) throw Error();
    const canonicalActor = { staffId: current.staffId, verifiedAccessSubject: current.verifiedAccessSubject,
      admissionVersion: current.admissionVersion, profileVersion: current.profileVersion };
    const requestHash = await sha256(JSON.stringify(["native-staff-onboarding-approve-v1", input, canonicalActor]));
    const db = database.withSession("first-primary");
    const replay = await db.prepare(`SELECT c.target_onboarding_id,c.target_proposed_staff_id,c.request_sha256,c.result_version,
        p.state,p.version,p.approval_command_id FROM native_staff_management_commands c
      JOIN native_staff_pending_onboarding p ON p.onboarding_id=c.target_onboarding_id AND p.proposed_staff_id=c.target_proposed_staff_id
      JOIN native_staff_admissions a ON a.staff_id=? AND a.active=1 AND a.version=? AND a.bound_access_subject=?
      JOIN native_staff_profiles profile ON profile.staff_id=a.staff_id AND profile.version=? AND profile.login_email=?
      JOIN staff_users staff ON staff.id=a.staff_id AND staff.email=profile.login_email COLLATE BINARY
        AND staff.access_subject=a.bound_access_subject AND staff.status='active'
      WHERE c.command_id=? AND c.request_sha256=? AND c.capability='staff.onboarding.approve'
        AND c.actor_staff_id=? AND c.actor_access_subject=? AND c.target_kind='onboarding'
        AND c.target_onboarding_id=? AND c.expected_version=2 AND c.result_version=3
        AND json_extract(c.result_json,'$.proposalSha256')=?
        AND json_extract(c.result_json,'$.claimEvidenceSha256')=?
        AND p.state='approved' AND p.version=3 AND p.approval_command_id=c.command_id
        AND p.claim_evidence_sha256=? AND p.proposal_sha256=? AND p.claimed_access_subject<>a.bound_access_subject
        AND ${APPROVAL_SCOPE}`)
      .bind(current.staffId, current.admissionVersion, current.verifiedAccessSubject, current.profileVersion,
        current.email, input.commandId, requestHash, current.staffId, current.verifiedAccessSubject,
        input.onboardingId, input.proposalSha256, input.claimEvidenceSha256,
        input.claimEvidenceSha256, input.proposalSha256)
      .first<Record<string, unknown>>();
    if (replay) {
      if (replay.target_onboarding_id !== input.onboardingId || typeof replay.target_proposed_staff_id !== "string"
        || !ID.test(replay.target_proposed_staff_id) || replay.request_sha256 !== requestHash || replay.result_version !== 3
        || replay.state !== "approved" || replay.version !== 3 || replay.approval_command_id !== input.commandId)
        throw Error();
      return Object.freeze({ commandId: input.commandId, onboardingId: input.onboardingId,
        proposedStaffId: replay.target_proposed_staff_id, resultVersion: 3, state: "approved", replayed: true });
    }
    const review = await readNativeStaffOnboardingReview(database, input.onboardingId, current);
    if (review.proposalSha256 !== input.proposalSha256 || review.claimEvidenceSha256 !== input.claimEvidenceSha256
      || review.version !== input.expectedVersion || current.staffId === review.proposedStaffId
      || Date.parse(current.verifiedUntil) <= Date.now()) throw Error();
    const resultJson = JSON.stringify({ contractVersion: 1, capability: "staff.onboarding.approve",
      targetOnboardingId: review.onboardingId, proposedStaffId: review.proposedStaffId,
      proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256,
      claimedAccessSubject: review.claimedAccessSubject, proposal: review.proposal, resultVersion: 3 });
    const resultSha256 = await sha256(resultJson);

    const fence = db.prepare(`INSERT INTO native_staff_management_fences(target_kind,target_onboarding_id,target_proposed_staff_id,
      command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
      expected_version,result_version,reason,display_name,result_json,result_sha256,mutation_writes)
      SELECT 'onboarding',?,?,?,?,1,'staff.onboarding.approve',?,?,NULL,2,3,?,NULL,?,?,1
      WHERE EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles profile ON profile.staff_id=a.staff_id
        JOIN staff_users staff ON staff.id=a.staff_id WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=?
          AND a.version=? AND profile.version=? AND profile.login_email=? AND staff.email=profile.login_email COLLATE BINARY
          AND staff.access_subject=a.bound_access_subject AND staff.status='active'
          AND ? > CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))`)
      .bind(review.onboardingId, review.proposedStaffId, input.commandId, requestHash, current.staffId,
        current.verifiedAccessSubject, input.reason, resultJson, resultSha256, current.staffId,
        current.verifiedAccessSubject, current.admissionVersion, current.profileVersion, current.email, Date.parse(current.verifiedUntil));
    const bridge = db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,project_alpha_user_id,status,provisioning_source,sync_protected)
      SELECT p.proposed_staff_id,p.login_email,p.display_name,p.claimed_access_subject,NULL,'active','local',1
      FROM native_staff_pending_onboarding p JOIN native_staff_management_fences f
        ON f.command_id=? AND f.target_onboarding_id=p.onboarding_id AND f.target_proposed_staff_id=p.proposed_staff_id
      WHERE p.state='claimed' AND p.version=2`).bind(input.commandId);
    const admission = db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      SELECT p.proposed_staff_id,p.claimed_access_subject,1,f.actor_staff_id
      FROM native_staff_pending_onboarding p JOIN native_staff_management_fences f
        ON f.command_id=? AND f.target_onboarding_id=p.onboarding_id AND f.target_proposed_staff_id=p.proposed_staff_id
      WHERE p.state='claimed' AND p.version=2`).bind(input.commandId);
    const profile = db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      SELECT p.proposed_staff_id,p.login_email,p.display_name FROM native_staff_pending_onboarding p
      JOIN native_staff_management_fences f ON f.command_id=? AND f.target_onboarding_id=p.onboarding_id
        AND f.target_proposed_staff_id=p.proposed_staff_id WHERE p.state='claimed' AND p.version=2`).bind(input.commandId);
    const consumeFence = db.prepare(`UPDATE native_staff_management_fences SET mutation_writes=0 WHERE command_id=? AND mutation_writes=1`)
      .bind(input.commandId);
    const receipt = db.prepare(`INSERT INTO native_staff_management_commands(target_kind,target_onboarding_id,target_proposed_staff_id,
      command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
      expected_version,result_version,reason,display_name,result_json,result_sha256)
      VALUES('onboarding',?,?,?,?,1,'staff.onboarding.approve',?,?,NULL,2,3,?,NULL,?,?)`)
      .bind(review.onboardingId, review.proposedStaffId, input.commandId, requestHash, current.staffId,
        current.verifiedAccessSubject, input.reason, resultJson, resultSha256);
    const results: unknown = await db.batch([fence, bridge, admission, profile, consumeFence, receipt]);
    if (!Array.isArray(results) || results.length !== 6 || results.some(result => !plain(result) || result.success !== true)) throw Error();
    return Object.freeze({ commandId: input.commandId, onboardingId: review.onboardingId,
      proposedStaffId: review.proposedStaffId, resultVersion: 3, state: "approved", replayed: false });
  } catch { throw new Error("native_staff_onboarding_approval_denied"); }
}
