import { isNativeAccessSubject } from "./native-access-subject";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

export type NativeStaffOnboardingCancelActor = Readonly<{
  staffId: string; verifiedAccessSubject: string; admissionVersion: number; profileVersion: number;
  email: string; verifiedUntil: string;
}>;
export type NativeStaffOnboardingCancelReceipt = Readonly<{
  commandId: string; onboardingId: string; resultVersion: 2 | 3;
  state: "cancelled"; replayed: boolean;
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
function actor(value: unknown): NativeStaffOnboardingCancelActor | null {
  const row = record(value, ["staffId", "verifiedAccessSubject", "admissionVersion", "profileVersion", "email", "verifiedUntil"]);
  if (!row || typeof row.staffId !== "string" || !ID.test(row.staffId) || !isNativeAccessSubject(row.verifiedAccessSubject)
    || !Number.isSafeInteger(row.admissionVersion) || Number(row.admissionVersion) < 1
    || !Number.isSafeInteger(row.profileVersion) || Number(row.profileVersion) < 1 || !email(row.email)
    || typeof row.verifiedUntil !== "string" || !Number.isFinite(Date.parse(row.verifiedUntil))
    || Date.parse(row.verifiedUntil) <= Date.now()) return null;
  return row as unknown as NativeStaffOnboardingCancelActor;
}
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function input(value: unknown) {
  const row = record(value, ["commandId", "onboardingId", "expectedVersion", "reason"]);
  if (!row || typeof row.commandId !== "string" || !UUID.test(row.commandId)
    || typeof row.onboardingId !== "string" || !UUID.test(row.onboardingId)
    || row.expectedVersion !== 1 && row.expectedVersion !== 2 || typeof row.reason !== "string"
    || row.reason !== row.reason.trim() || !row.reason || row.reason.length > 500 || /\p{C}/u.test(row.reason))
    throw new Error("native_staff_onboarding_cancel_denied");
  return { commandId: row.commandId, onboardingId: row.onboardingId,
    expectedVersion: row.expectedVersion as 1 | 2, reason: row.reason };
}

const ACTOR_AUTHORITY = `EXISTS(SELECT 1 FROM native_staff_management_delegations allow_row
  WHERE allow_row.actor_staff_id=a.staff_id AND allow_row.contract_version=1
    AND allow_row.capability='staff.onboarding.cancel' AND allow_row.effect='allow'
    AND allow_row.scope_kind='global' AND allow_row.active=1)
  AND NOT EXISTS(SELECT 1 FROM native_staff_management_delegations deny_row
    WHERE deny_row.actor_staff_id=a.staff_id AND deny_row.contract_version=1
      AND deny_row.capability='staff.onboarding.cancel' AND deny_row.effect='deny' AND deny_row.active=1
      AND (deny_row.scope_kind='global' OR (deny_row.scope_kind='exact_staff' AND deny_row.target_staff_id=p.proposed_staff_id)))`;

/** Cancels pending/claimed invitations through the existing 0072 atomic fence. */
export async function cancelNativeStaffOnboarding(database: D1Database, rawInput: unknown,
  rawActor: unknown): Promise<NativeStaffOnboardingCancelReceipt> {
  try {
    const current = actor(rawActor), command = input(rawInput);
    if (!current) throw Error();
    const db = database.withSession("first-primary");
    const canonicalActor = { staffId: current.staffId, verifiedAccessSubject: current.verifiedAccessSubject,
      admissionVersion: current.admissionVersion, profileVersion: current.profileVersion };
    const requestHash = await sha256(JSON.stringify(["native-staff-onboarding-cancel-v1", command, canonicalActor]));
    const identityQuery = `JOIN native_staff_admissions a ON a.staff_id=? AND a.active=1 AND a.version=?
        AND a.bound_access_subject=?
      JOIN native_staff_profiles profile ON profile.staff_id=a.staff_id AND profile.version=? AND profile.login_email=?
      JOIN staff_users staff ON staff.id=a.staff_id AND staff.email=profile.login_email COLLATE BINARY
        AND staff.access_subject=a.bound_access_subject AND staff.status='active'`;
    const replay = await db.prepare(`SELECT p.onboarding_id,p.proposed_staff_id,p.proposal_sha256,p.claim_evidence_sha256,
        p.version,p.state,c.result_json,c.result_sha256
      FROM native_staff_management_commands c JOIN native_staff_pending_onboarding p
        ON p.onboarding_id=c.target_onboarding_id AND p.proposed_staff_id=c.target_proposed_staff_id
      ${identityQuery}
      WHERE c.command_id=? AND c.request_sha256=? AND c.capability='staff.onboarding.cancel'
        AND c.actor_staff_id=? AND c.actor_access_subject=? AND c.target_kind='onboarding'
        AND c.target_onboarding_id=? AND c.expected_version=? AND c.result_version=c.expected_version+1
        AND p.state='cancelled' AND p.version=c.result_version
        AND json_extract(c.result_json,'$.proposalSha256')=p.proposal_sha256
        AND ((p.claim_evidence_sha256 IS NULL AND json_type(c.result_json,'$.claimEvidenceSha256')='null')
          OR (p.claim_evidence_sha256 IS NOT NULL AND json_extract(c.result_json,'$.claimEvidenceSha256')=p.claim_evidence_sha256))
        AND ${ACTOR_AUTHORITY}`)
      .bind(current.staffId, current.admissionVersion, current.verifiedAccessSubject, current.profileVersion, current.email,
        command.commandId, requestHash, current.staffId, current.verifiedAccessSubject, command.onboardingId,
        command.expectedVersion).first<Record<string, unknown>>();
    if (replay) {
      if (replay.onboarding_id !== command.onboardingId || replay.state !== "cancelled"
        || replay.version !== command.expectedVersion + 1 || typeof replay.proposed_staff_id !== "string"
        || typeof replay.proposal_sha256 !== "string" || !HEX.test(replay.proposal_sha256)
        || typeof replay.result_json !== "string" || typeof replay.result_sha256 !== "string"
        || await sha256(replay.result_json) !== replay.result_sha256) throw Error();
      const receipt = JSON.parse(replay.result_json) as Record<string, unknown>;
      if (receipt.contractVersion !== 1 || receipt.capability !== "staff.onboarding.cancel"
        || receipt.targetOnboardingId !== command.onboardingId || receipt.targetProposedStaffId !== replay.proposed_staff_id
        || receipt.proposalSha256 !== replay.proposal_sha256
        || receipt.claimEvidenceSha256 !== replay.claim_evidence_sha256 || receipt.resultVersion !== replay.version
        || Object.keys(receipt).length !== 7) throw Error();
      return Object.freeze({ commandId: command.commandId, onboardingId: command.onboardingId,
        resultVersion: replay.version as 2 | 3, state: "cancelled", replayed: true });
    }

    const pending = await db.prepare(`SELECT p.onboarding_id,p.proposed_staff_id,p.state,p.version,p.proposal_json,p.proposal_sha256,
        p.claim_evidence_sha256 FROM native_staff_pending_onboarding p ${identityQuery}
      WHERE p.onboarding_id=? AND p.state IN ('pending','claimed') AND p.version=? AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND ${ACTOR_AUTHORITY}`)
      .bind(current.staffId, current.admissionVersion, current.verifiedAccessSubject, current.profileVersion, current.email,
        command.onboardingId, command.expectedVersion).first<Record<string, unknown>>();
    if (!pending || typeof pending.onboarding_id !== "string" || typeof pending.proposed_staff_id !== "string"
      || !ID.test(pending.proposed_staff_id) || typeof pending.proposal_json !== "string"
      || typeof pending.proposal_sha256 !== "string" || !HEX.test(pending.proposal_sha256)
      || await sha256(pending.proposal_json) !== pending.proposal_sha256
      || pending.claim_evidence_sha256 !== null && (typeof pending.claim_evidence_sha256 !== "string" || !HEX.test(pending.claim_evidence_sha256))
      || Date.parse(current.verifiedUntil) <= Date.now()) throw Error();
    try { JSON.parse(pending.proposal_json); } catch { throw Error(); }
    const resultJson = JSON.stringify({ contractVersion: 1, capability: "staff.onboarding.cancel",
      targetOnboardingId: pending.onboarding_id, targetProposedStaffId: pending.proposed_staff_id,
      proposalSha256: pending.proposal_sha256, claimEvidenceSha256: pending.claim_evidence_sha256, resultVersion: command.expectedVersion + 1 });
    const resultSha256 = await sha256(resultJson);
    const verifiedUntilMs = Date.parse(current.verifiedUntil);
    const fence = db.prepare(`INSERT INTO native_staff_management_fences(target_kind,target_onboarding_id,target_proposed_staff_id,
      command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
      expected_version,result_version,reason,display_name,result_json,result_sha256,mutation_writes)
      SELECT 'onboarding',?,?,?, ?,1,'staff.onboarding.cancel',?,?,NULL,?,?,?,NULL,?,?,1
      WHERE EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles profile ON profile.staff_id=a.staff_id
        JOIN staff_users staff ON staff.id=a.staff_id WHERE a.staff_id=? AND a.active=1 AND a.version=?
          AND a.bound_access_subject=? AND profile.version=? AND profile.login_email=?
          AND staff.email=profile.login_email COLLATE BINARY AND staff.access_subject=a.bound_access_subject
          AND staff.status='active' AND ? > CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))`)
      .bind(pending.onboarding_id, pending.proposed_staff_id, command.commandId, requestHash, current.staffId,
        current.verifiedAccessSubject, command.expectedVersion, command.expectedVersion + 1, command.reason, resultJson, resultSha256,
        current.staffId, current.admissionVersion, current.verifiedAccessSubject, current.profileVersion, current.email, verifiedUntilMs);
    const cancel = db.prepare(`UPDATE native_staff_pending_onboarding SET state='cancelled',version=version+1,
      terminal_by_staff_id=?,terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE onboarding_id=? AND proposed_staff_id=? AND state IN ('pending','claimed') AND version=?
        AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(current.staffId, pending.onboarding_id, pending.proposed_staff_id, command.expectedVersion);
    const consume = db.prepare(`UPDATE native_staff_management_fences SET mutation_writes=0 WHERE command_id=? AND mutation_writes=1`)
      .bind(command.commandId);
    const receipt = db.prepare(`INSERT INTO native_staff_management_commands(target_kind,target_onboarding_id,target_proposed_staff_id,
      command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
      expected_version,result_version,reason,display_name,result_json,result_sha256)
      VALUES('onboarding',?,?,?,?,1,'staff.onboarding.cancel',?,?,NULL,?,?,?,NULL,?,?)`)
      .bind(pending.onboarding_id, pending.proposed_staff_id, command.commandId, requestHash, current.staffId,
        current.verifiedAccessSubject, command.expectedVersion, command.expectedVersion + 1, command.reason, resultJson, resultSha256);
    const results: unknown = await db.batch([fence, cancel, consume, receipt]);
    if (!Array.isArray(results) || results.length !== 4 || results.some(result => !plain(result) || result.success !== true)) throw Error();
    return Object.freeze({ commandId: command.commandId, onboardingId: pending.onboarding_id,
      resultVersion: (command.expectedVersion + 1) as 2 | 3, state: "cancelled", replayed: false });
  } catch { throw new Error("native_staff_onboarding_cancel_denied"); }
}

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
