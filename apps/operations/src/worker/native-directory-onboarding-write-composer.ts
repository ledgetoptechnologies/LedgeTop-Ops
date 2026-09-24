import { writeNativeDirectoryProfile, type NativeDirectoryProfileWrite,
  writeNativeOnlyClientOnboardingDecisionProfile,
  type NativeDirectoryProfileWriteOutcome } from "./native-directory-profile-writer";
import { writeNativeDirectoryRelationship, type NativeDirectoryRelationshipWrite,
  type NativeDirectoryRelationshipWriteOutcome } from "./native-directory-relationship-writer";

type WrittenProfile = Extract<NativeDirectoryProfileWriteOutcome, { status: "written" }>;
type WrittenRelationship = Extract<NativeDirectoryRelationshipWriteOutcome, { status: "written" }>;
export type NativeDirectoryOnboardingWriteExecution =
  | Readonly<{ status: "written"; relationship: WrittenRelationship; profile: WrittenProfile }>
  | Readonly<{ status: "blocked"; reason: "atomic_write" }>;

/**
 * Presents a writer with an otherwise-normal first-primary session while
 * retaining its complete batch inside this module. Writers therefore keep a
 * high-level API and cannot hand prepared statements or a raw DB capability to
 * callers merely to participate in the onboarding transaction.
 */
function recordingSession(session: D1DatabaseSession): Readonly<{
  db: D1Database;
  statements: () => readonly D1PreparedStatement[] | null;
}> {
  let recorded: readonly D1PreparedStatement[] | null = null;
  const db = new Proxy(session, { get(target, property) {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => {
      if (recorded !== null) throw new Error("native Directory writer issued multiple batches");
      recorded = [...statements];
      return [];
    };
    const member = target[property as keyof D1DatabaseSession];
    return typeof member === "function" ? member.bind(target) : member;
  } }) as unknown as D1Database;
  return { db, statements: () => recorded };
}

/** Plans both writes against one first-primary handle, then executes one batch. */
export async function planAndExecuteNativeDirectoryOnboardingWrites(db: D1Database,
  relationshipInput: NativeDirectoryRelationshipWrite,
  profileInput: NativeDirectoryProfileWrite): Promise<NativeDirectoryOnboardingWriteExecution |
    NativeDirectoryRelationshipWriteOutcome | NativeDirectoryProfileWriteOutcome> {
  const session = db.withSession("first-primary");
  const relationshipRecording = recordingSession(session);
  const relationship = await writeNativeDirectoryRelationship(relationshipRecording.db, relationshipInput);
  const relationshipStatements = relationshipRecording.statements();
  if (relationship.status !== "written" || relationshipStatements === null) return relationship;
  const profileRecording = recordingSession(session);
  const profile = await writeNativeDirectoryProfile(profileRecording.db, profileInput);
  const profileStatements = profileRecording.statements();
  if (profile.status !== "written" || profileStatements === null) return profile;
  try { await session.batch([...relationshipStatements, ...profileStatements]); }
  catch { return { status: "blocked", reason: "atomic_write" }; }
  return { status: "written", relationship: relationship as WrittenRelationship, profile: profile as WrittenProfile };
}

export type NativeOnlyClientOnboardingApproval = Readonly<{
  decisionId: string; invitationId: string; submissionId: string; fieldsSha256: string; requestSha256: string;
  reason: string; reviewedFieldsJson: string; scopes: readonly Readonly<{ businessAreaId: string; divisionId: string | null }>[];
  verifiedUntil: string; profile: NativeDirectoryProfileWrite;
  relationship: Readonly<{ mode: "change" | "preserve"; expectedVersion: number; mutationId: string }>;
}>;
export type NativeOnlyClientOnboardingApprovalOutcome = Readonly<{
  status: "written"; replayed: boolean; decisionId: string; invitationId: string; submissionId: string;
  clientRecordId: string; clientRecordVersion: number; relationshipVersion: number;
}> | Readonly<{ status: "rejected" | "blocked" | "conflict"; reason: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
async function deterministicUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function approvalReceipt(input: NativeOnlyClientOnboardingApproval, version: number, relationshipVersion: number): string {
  return JSON.stringify({ decisionId: input.decisionId, outcome: "approved", invitationId: input.invitationId,
    submissionId: input.submissionId, clientRecordId: input.profile.recordId, clientRecordVersion: version,
    organizationRecordId: null, organizationRecordVersion: null, relationshipVersion });
}
function savedApprovalReceipt(value: unknown): Omit<Extract<NativeOnlyClientOnboardingApprovalOutcome,
  { status: "written" }>, "status" | "replayed"> | null {
  try {
    const parsed=JSON.parse(String(value)) as Record<string,unknown>;
    if (Object.keys(parsed).length!==9 || parsed.outcome!=="approved" || typeof parsed.decisionId!=="string"
      || typeof parsed.invitationId!=="string" || typeof parsed.submissionId!=="string"
      || typeof parsed.clientRecordId!=="string" || !Number.isSafeInteger(parsed.clientRecordVersion)
      || !Number.isSafeInteger(parsed.relationshipVersion) || parsed.organizationRecordId!==null
      || parsed.organizationRecordVersion!==null) return null;
    return { decisionId:parsed.decisionId,invitationId:parsed.invitationId,submissionId:parsed.submissionId,
      clientRecordId:parsed.clientRecordId,clientRecordVersion:parsed.clientRecordVersion as number,
      relationshipVersion:parsed.relationshipVersion as number };
  } catch { return null; }
}

/**
 * Private 0083 composer for a native-only person/client approval.  It supports
 * a new explicitly-unlinked client or an existing client whose current parent
 * relationship is preserved.  Organization creation/link changes intentionally
 * remain outside this smallest staged-state prerequisite.
 */
export async function approveNativeOnlyClientOnboarding(db: D1Database,
  input: NativeOnlyClientOnboardingApproval): Promise<NativeOnlyClientOnboardingApprovalOutcome> {
  const profile = input.profile;
  if (!UUID.test(input.decisionId) || !UUID.test(input.invitationId) || !UUID.test(input.submissionId)
    || !SHA.test(input.fieldsSha256) || !SHA.test(input.requestSha256) || profile.kind !== "client"
    || profile.destinations.length !== 0 || input.reason.length < 1 || input.reason.length > 1024
    || !Number.isSafeInteger(input.relationship.expectedVersion) || input.relationship.expectedVersion < 0
    || !UUID.test(input.relationship.mutationId)) return { status: "rejected", reason: "invalid_approval" };
  const actor = profile.actor;
  const expectedRelationshipMutation = profile.operation === "create"
    ? await deterministicUuid(`${profile.mutationId}\0client-relationship\0unlinked`) : input.relationship.mutationId;
  if ((profile.operation === "create" && (input.relationship.mode !== "change" || input.relationship.expectedVersion !== 0
      || profile.relationship.organizationRecordId !== null || profile.relationship.expectedRelationshipVersion !== 0
      || expectedRelationshipMutation !== input.relationship.mutationId))
    || (profile.operation === "update" && (input.relationship.mode !== "preserve"
      || profile.relationship.expectedRelationshipVersion !== input.relationship.expectedVersion)))
    return { status: "rejected", reason: "invalid_relationship_plan" };
  const session = db.withSession("first-primary");
  const saved = await session.prepare(`SELECT request_sha256,reviewer_staff_id,client_record_id,client_record_version,
      relationship_version,receipt_json FROM client_onboarding_decisions WHERE decision_id=? AND submission_id=?`)
    .bind(input.decisionId,input.submissionId).first<Record<string, unknown>>();
  if (saved) {
    if (saved.request_sha256 !== input.requestSha256 || saved.reviewer_staff_id !== actor.staffId
      || saved.client_record_id !== profile.recordId) return { status: "conflict", reason: "idempotency_body_conflict" };
    const replayAuthority = await writeNativeOnlyClientOnboardingDecisionProfile(session,input.decisionId,profile);
    if (replayAuthority.status !== "written") return { status: replayAuthority.status,
      reason: "reason" in replayAuthority ? replayAuthority.reason : "current_reviewer_authority" };
    const receipt=savedApprovalReceipt(saved.receipt_json);
    if (!receipt || receipt.decisionId!==input.decisionId || receipt.submissionId!==input.submissionId
      || receipt.clientRecordId!==profile.recordId) return { status:"blocked",reason:"invalid_saved_receipt" };
    return { status: "written", replayed: true, ...receipt };
  }
  const recording = recordingSession(session);
  const planned = await writeNativeOnlyClientOnboardingDecisionProfile(recording.db,input.decisionId,profile);
  const profileStatements = recording.statements();
  if (planned.status !== "written" || profileStatements === null)
    return { status: planned.status === "written" ? "blocked" : planned.status,
      reason: planned.status === "written" ? "opaque_plan" : planned.reason };
  const clientVersion = profile.expectedLocalVersion + 1;
  const relationshipVersion = input.relationship.expectedVersion + (input.relationship.mode === "change" ? 1 : 0);
  const scopesJson = JSON.stringify(input.scopes), profileJson = JSON.stringify(profile.profile), reviewed = input.reviewedFieldsJson;
  const receipt = approvalReceipt(input,clientVersion,relationshipVersion);
  const fence = session.prepare(`INSERT INTO client_onboarding_decision_fences
    (decision_id,invitation_id,submission_id,fields_sha256,expected_invitation_version,request_sha256,outcome,
     reviewer_staff_id,reviewer_subject,reviewer_email,reviewer_admission_version,reviewer_profile_version,verified_until,reason,
     reviewed_fields_json,scopes_json,client_target_kind,client_record_id,client_expected_version,client_mutation_id,client_audit_id,
     client_create_admission_id,client_profile_json,client_destinations_json,relationship_mutation_id,relationship_mode,
     relationship_expected_version,relationship_previous_organization_record_id,relationship_previous_organization_record_version)
    VALUES(?,?,?,?,2,?,'approved',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'[]',?,?,?,NULL,NULL)`)
    .bind(input.decisionId,input.invitationId,input.submissionId,input.fieldsSha256,input.requestSha256,actor.staffId,
      actor.accessSubject,actor.loginEmail,actor.admissionVersion,actor.profileVersion,input.verifiedUntil,input.reason,reviewed,
      scopesJson,profile.operation === "create" ? "new" : "existing",profile.recordId,profile.expectedLocalVersion,
      profile.mutationId,`${profile.mutationId}:audit`,profile.operation === "create" ? profile.createAdmissionId : null,
      profileJson,input.relationship.mutationId,input.relationship.mode,input.relationship.expectedVersion);
  const admissionStatements: D1PreparedStatement[] = [];
  if (profile.operation === "create") {
    admissionStatements.push(session.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,'client',?,?, '[]',?)`).bind(profile.createAdmissionId,actor.staffId,actor.accessSubject,
      profile.recordId,scopesJson,profileJson,actor.staffId));
    admissionStatements.push(session.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version)
      VALUES(?,?,NULL,NULL)`).bind(profile.createAdmissionId,profile.recordId));
  }
  const decision = session.prepare(`INSERT INTO client_onboarding_decisions
    (decision_id,invitation_id,submission_id,fields_sha256,request_sha256,outcome,reviewer_staff_id,reviewer_subject,
     reviewer_email,original_admission_version,original_profile_version,reason,reviewed_fields_json,client_record_id,
     client_record_version,organization_record_id,organization_record_version,relationship_version,receipt_json)
    VALUES(?,?,?,?,?,'approved',?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)`).bind(input.decisionId,input.invitationId,input.submissionId,
      input.fieldsSha256,input.requestSha256,actor.staffId,actor.accessSubject,actor.loginEmail,actor.admissionVersion,
      actor.profileVersion,input.reason,reviewed,profile.recordId,clientVersion,relationshipVersion,receipt);
  try { await session.batch([fence,...admissionStatements,...profileStatements,decision,
    session.prepare("DELETE FROM client_onboarding_decision_fences WHERE decision_id=?").bind(input.decisionId)]); }
  catch { return { status: "blocked", reason: "authority_or_atomic_write" }; }
  return { status: "written", replayed: false, decisionId: input.decisionId, invitationId: input.invitationId,
    submissionId: input.submissionId, clientRecordId: profile.recordId, clientRecordVersion: clientVersion, relationshipVersion };
}
