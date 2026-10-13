import { writeNativeDirectoryProfile, type NativeDirectoryProfileWrite,
  writeNativeOnlyClientOnboardingDecisionProfile, writeNativeOnlyOnboardingDecisionProfile,
  type NativeDirectoryDestinationAuthority, type NativeDirectoryProfileWriteOutcome } from "./native-directory-profile-writer";
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
  organizationProfile?: NativeDirectoryProfileWrite;
  enrollmentSourceIds?: readonly string[];
  relationship: Readonly<{ mode: "change" | "preserve"; expectedVersion: number; mutationId: string }>;
}>;
export type NativeOnlyClientOnboardingDestination = Omit<NativeDirectoryDestinationAuthority, "externalCanonicalId">;
export type NativeOnlyClientOnboardingDestinationResolver =
  (sourceIds: readonly string[]) => Promise<readonly NativeOnlyClientOnboardingDestination[]>;
export type NativeOnlyClientOnboardingApprovalOutcome = Readonly<{
  status: "written"; replayed: boolean; decisionId: string; invitationId: string; submissionId: string;
  clientRecordId: string; clientRecordVersion: number; organizationRecordId: string | null;
  organizationRecordVersion: number | null; relationshipVersion: number;
}> | Readonly<{ status: "rejected" | "blocked" | "conflict"; reason: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_DESTINATIONS = 16;
function sourceIds(value: readonly string[] | undefined): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DESTINATIONS || !value.every(item => typeof item === "string" && SOURCE_ID.test(item))) return null;
  const canonical = [...value].sort();
  return new Set(canonical).size === canonical.length && canonical.every((item,index) => item === value[index]) ? canonical : null;
}
function destinationIdentity(value: NativeDirectoryDestinationAuthority): Omit<NativeDirectoryDestinationAuthority,"expectedAuthorizationGeneration"> {
  return { sourceId:value.sourceId,sourceInstanceUUID:value.sourceInstanceUUID,applicationUUID:value.applicationUUID,
    historyEpoch:value.historyEpoch,origin:value.origin,externalCanonicalId:value.externalCanonicalId };
}
function destinationsFromAudit(value: unknown): readonly NativeDirectoryDestinationAuthority[] | null {
  try { const parsed=JSON.parse(String(value)) as Record<string,unknown>;
    return Array.isArray(parsed.destinations) ? parsed.destinations as NativeDirectoryDestinationAuthority[] : null;
  } catch { return null; }
}
async function deterministicUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function approvalReceipt(input: NativeOnlyClientOnboardingApproval, version: number, relationshipVersion: number): string {
  const organization = input.organizationProfile;
  return JSON.stringify({ decisionId: input.decisionId, outcome: "approved", invitationId: input.invitationId,
    submissionId: input.submissionId, clientRecordId: input.profile.recordId, clientRecordVersion: version,
    organizationRecordId: organization?.recordId ?? null,
    organizationRecordVersion: organization ? organization.expectedLocalVersion + 1 : null, relationshipVersion });
}
function savedApprovalReceipt(value: unknown): Omit<Extract<NativeOnlyClientOnboardingApprovalOutcome,
  { status: "written" }>, "status" | "replayed"> | null {
  try {
    const parsed=JSON.parse(String(value)) as Record<string,unknown>;
    if (Object.keys(parsed).length!==9 || parsed.outcome!=="approved" || typeof parsed.decisionId!=="string"
      || typeof parsed.invitationId!=="string" || typeof parsed.submissionId!=="string"
      || typeof parsed.clientRecordId!=="string" || !Number.isSafeInteger(parsed.clientRecordVersion)
      || !Number.isSafeInteger(parsed.relationshipVersion)
      || !((parsed.organizationRecordId===null && parsed.organizationRecordVersion===null)
        || (typeof parsed.organizationRecordId==="string" && Number.isSafeInteger(parsed.organizationRecordVersion)))) return null;
    return { decisionId:parsed.decisionId,invitationId:parsed.invitationId,submissionId:parsed.submissionId,
      clientRecordId:parsed.clientRecordId,clientRecordVersion:parsed.clientRecordVersion as number,
      organizationRecordId:parsed.organizationRecordId as string | null,
      organizationRecordVersion:parsed.organizationRecordVersion as number | null,
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
  input: NativeOnlyClientOnboardingApproval,
  resolveDestinations?: NativeOnlyClientOnboardingDestinationResolver): Promise<NativeOnlyClientOnboardingApprovalOutcome> {
  let profile = input.profile;
  let organization = input.organizationProfile;
  const selectedSourceIds = sourceIds(input.enrollmentSourceIds);
  if (!UUID.test(input.decisionId) || !UUID.test(input.invitationId) || !UUID.test(input.submissionId)
    || !SHA.test(input.fieldsSha256) || !SHA.test(input.requestSha256) || profile.kind !== "client"
    || profile.destinations.length !== 0 || selectedSourceIds === null || input.reason.length < 1 || input.reason.length > 1024
    || !Number.isSafeInteger(input.relationship.expectedVersion) || input.relationship.expectedVersion < 0
    || !UUID.test(input.relationship.mutationId)) return { status: "rejected", reason: "invalid_approval" };
  const actor = profile.actor;
  if (organization && (organization.kind !== "organization" || organization.operation !== "create"
    || organization.destinations.length !== 0 || organization.expectedLocalVersion !== 0
    || profile.operation !== "create" || organization.recordId === profile.recordId
    || organization.mutationId === profile.mutationId
    || organization.createAdmissionId === profile.createAdmissionId
    || organization.actor.staffId !== actor.staffId || organization.actor.accessSubject !== actor.accessSubject
    || organization.actor.admissionVersion !== actor.admissionVersion
    || organization.actor.profileVersion !== actor.profileVersion
    || JSON.stringify(organization.scopes) !== JSON.stringify(input.scopes)))
    return { status: "rejected", reason: "invalid_organization_plan" };
  const expectedRelationshipMutation = profile.operation === "create"
    ? await deterministicUuid(`${profile.mutationId}\0client-relationship\0${organization?.recordId ?? "unlinked"}`) : input.relationship.mutationId;
  if ((profile.operation === "create" && (input.relationship.mode !== "change" || input.relationship.expectedVersion !== 0
      || profile.relationship.organizationRecordId !== (organization?.recordId ?? null)
      || profile.relationship.expectedRelationshipVersion !== 0
      || expectedRelationshipMutation !== input.relationship.mutationId))
    || (profile.operation === "update" && (input.relationship.mode !== "preserve"
      || profile.relationship.expectedRelationshipVersion !== input.relationship.expectedVersion)))
    return { status: "rejected", reason: "invalid_relationship_plan" };
  const session = db.withSession("first-primary");
  const saved = await session.prepare(`SELECT request_sha256,reviewer_staff_id,client_record_id,client_record_version,
      organization_record_id,relationship_version,receipt_json FROM client_onboarding_decisions WHERE decision_id=? AND submission_id=?`)
    .bind(input.decisionId,input.submissionId).first<Record<string, unknown>>();
  if (saved) {
    if (saved.request_sha256 !== input.requestSha256 || saved.reviewer_staff_id !== actor.staffId
      || saved.client_record_id !== profile.recordId || saved.organization_record_id !== (organization?.recordId ?? null))
      return { status: "conflict", reason: "idempotency_body_conflict" };
    if (organization) {
      const savedOrganization = await session.prepare("SELECT command_json FROM operations_directory_audit WHERE mutation_id=?")
        .bind(organization.mutationId).first<{command_json:string}>();
      const destinations = destinationsFromAudit(savedOrganization?.command_json);
      if (!destinations) return {status:"blocked",reason:"invalid_saved_receipt"};
      organization={...organization,destinations};
      const organizationAuthority = await writeNativeOnlyOnboardingDecisionProfile(session,input.decisionId,organization);
      if (organizationAuthority.status !== "written") return { status: organizationAuthority.status,
        reason: "reason" in organizationAuthority ? organizationAuthority.reason : "current_reviewer_authority" };
    }
    const savedClient = await session.prepare("SELECT command_json FROM operations_directory_audit WHERE mutation_id=?")
      .bind(profile.mutationId).first<{command_json:string}>();
    const replayDestinations=destinationsFromAudit(savedClient?.command_json);
    if (!replayDestinations) return {status:"blocked",reason:"invalid_saved_receipt"};
    profile={...profile,destinations:replayDestinations};
    const replayAuthority = await writeNativeOnlyClientOnboardingDecisionProfile(session,input.decisionId,profile);
    if (replayAuthority.status !== "written") return { status: replayAuthority.status,
      reason: "reason" in replayAuthority ? replayAuthority.reason : "current_reviewer_authority" };
    const receipt=savedApprovalReceipt(saved.receipt_json);
    if (!receipt || receipt.decisionId!==input.decisionId || receipt.submissionId!==input.submissionId
      || receipt.clientRecordId!==profile.recordId) return { status:"blocked",reason:"invalid_saved_receipt" };
    return { status: "written", replayed: true, ...receipt };
  }
  if (selectedSourceIds.length > 0) {
    if (!resolveDestinations) return {status:"blocked",reason:"destination_resolution"};
    let resolved: readonly NativeOnlyClientOnboardingDestination[];
    try { resolved=await resolveDestinations(selectedSourceIds); } catch { return {status:"blocked",reason:"destination_resolution"}; }
    if (!Array.isArray(resolved) || resolved.length !== selectedSourceIds.length
      || resolved.some((value,index) => !value || value.sourceId !== selectedSourceIds[index]))
      return {status:"blocked",reason:"destination_resolution"};
    profile={...profile,destinations:resolved.map(value=>({...value,externalCanonicalId:profile.recordId}))};
    if (organization) organization={...organization,
      destinations:resolved.map(value=>({...value,externalCanonicalId:organization!.recordId}))};
  }
  let organizationStatements: readonly D1PreparedStatement[] = [];
  if (organization) {
    const organizationRecording = recordingSession(session);
    const plannedOrganization = await writeNativeOnlyOnboardingDecisionProfile(organizationRecording.db,input.decisionId,organization);
    organizationStatements = organizationRecording.statements() ?? [];
    if (plannedOrganization.status !== "written" || organizationStatements.length === 0)
      return { status: plannedOrganization.status === "written" ? "blocked" : plannedOrganization.status,
        reason: plannedOrganization.status === "written" ? "opaque_plan" : plannedOrganization.reason };
  }
  const recording = recordingSession(session);
  const planned = organization
    ? await writeNativeOnlyOnboardingDecisionProfile(recording.db,input.decisionId,profile,
      { recordId: organization.recordId, version: 1, mutationId: organization.mutationId,
        destinations: organization.destinations })
    : await writeNativeOnlyClientOnboardingDecisionProfile(recording.db,input.decisionId,profile);
  const profileStatements = recording.statements();
  if (planned.status !== "written" || profileStatements === null)
    return { status: planned.status === "written" ? "blocked" : planned.status,
      reason: planned.status === "written" ? "opaque_plan" : planned.reason };
  const clientVersion = profile.expectedLocalVersion + 1;
  const relationshipVersion = input.relationship.expectedVersion + (input.relationship.mode === "change" ? 1 : 0);
  const scopesJson = JSON.stringify(input.scopes), profileJson = JSON.stringify(profile.profile),
    organizationProfileJson = organization ? JSON.stringify(organization.profile) : null, reviewed = input.reviewedFieldsJson;
  const clientDestinationsJson=JSON.stringify(profile.destinations.map(destinationIdentity));
  const organizationDestinationsJson=organization ? JSON.stringify(organization.destinations.map(destinationIdentity)) : null;
  const receipt = approvalReceipt(input,clientVersion,relationshipVersion);
  const fence = session.prepare(`INSERT INTO client_onboarding_decision_fences
    (decision_id,invitation_id,submission_id,fields_sha256,expected_invitation_version,request_sha256,outcome,
     reviewer_staff_id,reviewer_subject,reviewer_email,reviewer_admission_version,reviewer_profile_version,verified_until,reason,
     reviewed_fields_json,scopes_json,client_target_kind,client_record_id,client_expected_version,client_mutation_id,client_audit_id,
     client_create_admission_id,client_profile_json,client_destinations_json,relationship_mutation_id,relationship_mode,
     relationship_expected_version,relationship_previous_organization_record_id,relationship_previous_organization_record_version,
     organization_target_kind,organization_record_id,organization_expected_version,organization_mutation_id,
     organization_audit_id,organization_create_admission_id,organization_profile_json,organization_destinations_json)
    VALUES(?,?,?,?,2,?,'approved',
      ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
      NULL,NULL,?,?,?,?,?,?,?,?)`)
    .bind(input.decisionId,input.invitationId,input.submissionId,input.fieldsSha256,input.requestSha256,actor.staffId,
      actor.accessSubject,actor.loginEmail,actor.admissionVersion,actor.profileVersion,input.verifiedUntil,input.reason,reviewed,
      scopesJson,profile.operation === "create" ? "new" : "existing",profile.recordId,profile.expectedLocalVersion,
      profile.mutationId,`${profile.mutationId}:audit`,profile.operation === "create" ? profile.createAdmissionId : null,
      profileJson,clientDestinationsJson,input.relationship.mutationId,input.relationship.mode,input.relationship.expectedVersion,
      organization ? "new" : null,organization?.recordId ?? null,organization?.expectedLocalVersion ?? null,
      organization?.mutationId ?? null,organization ? `${organization.mutationId}:audit` : null,
      organization?.operation === "create" ? organization.createAdmissionId : null,organizationProfileJson,organizationDestinationsJson);
  const clientAdmissionStatements: D1PreparedStatement[] = [];
  if (profile.operation === "create") {
    clientAdmissionStatements.push(session.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,'client',?,?,?,?)`).bind(profile.createAdmissionId,actor.staffId,actor.accessSubject,
      profile.recordId,scopesJson,profileJson,clientDestinationsJson,actor.staffId));
    clientAdmissionStatements.push(session.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version)
      VALUES(?,?,?,?)`).bind(profile.createAdmissionId,profile.recordId,organization?.recordId ?? null,
        organization ? 1 : null));
  }
  const organizationAdmissionStatements = organization?.operation === "create" ? [session.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,'organization',?,?,?,?)`).bind(organization.createAdmissionId,actor.staffId,
      actor.accessSubject,organization.recordId,scopesJson,organizationProfileJson,organizationDestinationsJson,actor.staffId)] : [];
  const decision = session.prepare(`INSERT INTO client_onboarding_decisions
    (decision_id,invitation_id,submission_id,fields_sha256,request_sha256,outcome,reviewer_staff_id,reviewer_subject,
     reviewer_email,original_admission_version,original_profile_version,reason,reviewed_fields_json,client_record_id,
     client_record_version,organization_record_id,organization_record_version,relationship_version,receipt_json)
     VALUES(?,?,?,?,?,'approved',?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.decisionId,input.invitationId,input.submissionId,
      input.fieldsSha256,input.requestSha256,actor.staffId,actor.accessSubject,actor.loginEmail,actor.admissionVersion,
      actor.profileVersion,input.reason,reviewed,profile.recordId,clientVersion,organization?.recordId ?? null,
      organization ? 1 : null,relationshipVersion,receipt);
  try { await session.batch([fence,...organizationAdmissionStatements,...organizationStatements,
    ...clientAdmissionStatements,...profileStatements,decision,
    session.prepare("DELETE FROM client_onboarding_decision_fences WHERE decision_id=?").bind(input.decisionId)]); }
  catch { return { status: "blocked", reason: "authority_or_atomic_write" }; }
  return { status: "written", replayed: false, decisionId: input.decisionId, invitationId: input.invitationId,
    submissionId: input.submissionId, clientRecordId: profile.recordId, clientRecordVersion: clientVersion,
    organizationRecordId: organization?.recordId ?? null, organizationRecordVersion: organization ? 1 : null,
    relationshipVersion };
}
