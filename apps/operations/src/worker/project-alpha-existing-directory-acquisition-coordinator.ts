import { resolveProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import {
  canonicalProjectAlphaExistingDirectoryBindingCommand,
  sendConfiguredProjectAlphaExistingDirectoryBinding,
  validatedProjectAlphaExistingDirectoryBindingEvidence,
  type ProjectAlphaExistingDirectoryBindingCommand,
} from "./project-alpha-existing-directory-binding-api-v2";
import {
  readConfiguredProjectAlphaDirectoryBindingStatus,
  readConfiguredProjectAlphaDirectoryProfile,
  type ProjectAlphaDirectoryProfileObservation,
  type ProjectAlphaDirectoryReadKind,
} from "./project-alpha-directory-read-api-v2";

export type ProjectAlphaExistingDirectoryAcquisitionEnvironment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
export type ProjectAlphaExistingDirectoryAcquisitionInput = Readonly<{
  reviewId: string;
  commandId: string;
  sourceId: string;
  recordId: string;
  resourceType: ProjectAlphaDirectoryReadKind;
  projectAlphaPublicId: string;
  localRecordVersion: number;
  reviewer: Readonly<{
    staffId: string;
    accessSubject: string;
    admissionVersion: number;
    profileVersion: number;
    grantGeneration: number;
  }>;
}>;
export type ProjectAlphaExistingDirectoryAcquisitionOutcome =
  | Readonly<{ status: "acquired"; reviewReceiptId: string; commandId: string; acquiredReceiptId: string; replayed: boolean }>
  | Readonly<{ status: "uncertain"; reason: "transport" | "database" | "post_read" }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "relationship" | "expired" | "stale_local" | "remote" }>
  | Readonly<{ status: "conflict"; reason: "reservation" | "remote" | "collision" | "evidence" }>
  | Readonly<{ status: "rejected"; reason: "invalid_input" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

type Reservation = Readonly<{
  receipt_id: string; review_id: string; request_sha256: string; record_id: string; source_id: string;
  source_instance_id: string; application_id: string; history_epoch_id: string;
  resource_type: ProjectAlphaDirectoryReadKind; external_id: string; project_alpha_public_id: string;
  project_alpha_revision: string; reviewer_staff_id: string; reviewer_access_subject: string;
  reviewer_admission_version: number; reviewer_profile_version: number; reviewed_local_record_version: number;
  reviewed_at: string; command_id: string; command_request_sha256: string;
}>;
type Authority = Readonly<{ authority_current: number; relationship_current: number; record_current: number; unexpired: number }>;
type ExistingAcquired = Readonly<{ receipt_id: string; command_id: string; review_receipt_id: string }>;

function plain(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every(key => typeof key === "string"
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && "value" in Object.getOwnPropertyDescriptor(value, key)!);
  } catch { return false; }
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  try { return Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }
  catch { return false; }
}
function safeText(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 191 || /\p{C}/u.test(value)) return false;
  try { return new TextEncoder().encode(value).byteLength <= 764; } catch { return false; }
}
function positiveSafe(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1; }
function input(value: unknown): value is ProjectAlphaExistingDirectoryAcquisitionInput {
  return plain(value) && exact(value, ["reviewId", "commandId", "sourceId", "recordId", "resourceType", "projectAlphaPublicId", "localRecordVersion", "reviewer"])
    && UUID.test(value.reviewId as string) && UUID.test(value.commandId as string) && value.reviewId !== value.commandId
    && typeof value.sourceId === "string" && SOURCE_ID.test(value.sourceId) && safeText(value.recordId)
    && (value.resourceType === "client" || value.resourceType === "organization")
    && typeof value.projectAlphaPublicId === "string" && PUBLIC_ID.test(value.projectAlphaPublicId)
    && positiveSafe(value.localRecordVersion) && plain(value.reviewer)
    && exact(value.reviewer, ["staffId", "accessSubject", "admissionVersion", "profileVersion", "grantGeneration"])
    && safeText(value.reviewer.staffId) && safeText(value.reviewer.accessSubject)
    && positiveSafe(value.reviewer.admissionVersion) && positiveSafe(value.reviewer.profileVersion)
    && positiveSafe(value.reviewer.grantGeneration);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonical(value));
  const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(hashed, byte => byte.toString(16).padStart(2, "0")).join("");
}
function now(): string { return new Date().toISOString(); }

const APPLICABLE = `(grant_row.scope_kind='global'
  OR (grant_row.scope_kind='resource' AND grant_row.resource_id=record.record_id)
  OR (grant_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
    WHERE assignment.record_id=record.record_id AND assignment.staff_id=? AND assignment.active=1))
  OR (grant_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
    WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=grant_row.business_area_id))
  OR (grant_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
    WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=grant_row.division_id)))`;
const APPLICABLE_FINAL = `(grant_row.scope_kind='global'
  OR (grant_row.scope_kind='resource' AND grant_row.resource_id=record.record_id)
  OR (grant_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
    WHERE assignment.record_id=record.record_id AND assignment.staff_id=review.reviewer_staff_id AND assignment.active=1))
  OR (grant_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
    WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=grant_row.business_area_id))
  OR (grant_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
    WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=grant_row.division_id)))`;

async function authority(db: D1Database, selected: ProjectAlphaExistingDirectoryAcquisitionInput,
  identity: Readonly<{ sourceInstanceId: string; applicationId: string; historyEpoch: string }>,
  organizationPublicId: string | null, reviewedAt?: string): Promise<Authority | null> {
  const staff = selected.reviewer.staffId;
  return db.prepare(`SELECT record.current_version=? record_current,
      ${reviewedAt === undefined ? "1" : "(?<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours'))"} unexpired,
      (EXISTS(SELECT 1 FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
        JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
        WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?
          AND admission.version=? AND profile.version=? AND generation.generation=?)
       AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=? AND role.role_id='role-owner' AND role.scope='global')
       AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=? AND grant_row.permission='directory.identity.link'
          AND grant_row.effect='allow' AND grant_row.active=1 AND ${APPLICABLE})
       AND NOT EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=? AND grant_row.permission='directory.identity.link'
          AND grant_row.effect='deny' AND grant_row.active=1 AND ${APPLICABLE})) authority_current,
      (?='organization' OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship
        WHERE relationship.client_record_id=record.record_id AND ((? IS NULL AND relationship.organization_record_id IS NULL)
          OR (? IS NOT NULL AND EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings parent
            WHERE parent.source_id=? AND parent.source_instance_id=? AND parent.application_id=? AND parent.history_epoch_id=?
              AND parent.resource_type='organization' AND parent.external_id=relationship.organization_record_id
              AND parent.project_alpha_public_id=?))))) relationship_current
    FROM operations_directory_records record WHERE record.record_id=? AND record.record_kind=?`)
    .bind(selected.localRecordVersion, ...(reviewedAt === undefined ? [] : [reviewedAt, reviewedAt]),
      staff, selected.reviewer.accessSubject, selected.reviewer.admissionVersion, selected.reviewer.profileVersion,
      selected.reviewer.grantGeneration, staff, staff, staff, staff, staff,
      selected.resourceType, organizationPublicId, organizationPublicId, selected.sourceId, identity.sourceInstanceId,
      identity.applicationId, identity.historyEpoch, organizationPublicId, selected.recordId, selected.resourceType)
    .first<Authority>();
}

async function reservations(db: D1Database, value: ProjectAlphaExistingDirectoryAcquisitionInput): Promise<Reservation[]> {
  const result = await db.prepare(`SELECT review.receipt_id,review.review_id,review.request_sha256,review.record_id,review.source_id,
      review.source_instance_id,review.application_id,review.history_epoch_id,review.resource_type,review.external_id,
      review.project_alpha_public_id,review.project_alpha_revision,review.reviewer_staff_id,review.reviewer_access_subject,
      review.reviewer_admission_version,review.reviewer_profile_version,review.reviewed_local_record_version,review.reviewed_at,
      command.command_id,command.request_sha256 command_request_sha256
    FROM project_alpha_existing_directory_binding_review_evidence review
    JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.review_receipt_id=review.receipt_id
    WHERE review.review_id=? OR command.command_id=? ORDER BY review.created_at,review.receipt_id`)
    .bind(value.reviewId, value.commandId).all<Reservation>();
  return result.results;
}

function exactReservation(row: Reservation, value: ProjectAlphaExistingDirectoryAcquisitionInput,
  identity: Readonly<{ sourceInstanceId: string; applicationId: string; historyEpoch: string }>, command: ProjectAlphaExistingDirectoryBindingCommand,
  requestSha256: string): boolean {
  return row.review_id === value.reviewId && row.command_id === value.commandId && row.record_id === value.recordId
    && row.source_id === value.sourceId && row.source_instance_id === identity.sourceInstanceId
    && row.application_id === identity.applicationId && row.history_epoch_id === identity.historyEpoch
    && row.resource_type === value.resourceType && row.external_id === value.recordId
    && row.project_alpha_public_id === value.projectAlphaPublicId && row.project_alpha_revision === command.expectedRevision
    && row.reviewer_staff_id === value.reviewer.staffId && row.reviewer_access_subject === value.reviewer.accessSubject
    && row.reviewer_admission_version === value.reviewer.admissionVersion
    && row.reviewer_profile_version === value.reviewer.profileVersion
    && row.reviewed_local_record_version === value.localRecordVersion
    && row.request_sha256 === requestSha256 && row.command_request_sha256 === requestSha256;
}

async function acquired(db: D1Database, commandId: string): Promise<ExistingAcquired | null> {
  return db.prepare(`SELECT acquired.receipt_id,acquired.command_id,command.review_receipt_id
    FROM project_alpha_existing_directory_binding_acquired_mapping_receipts acquired
    JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.command_id=acquired.command_id
    JOIN project_alpha_acquired_canonical_mappings mapping ON mapping.receipt_id=acquired.receipt_id
    JOIN project_alpha_acquired_native_owner_claims claim ON claim.receipt_id=acquired.receipt_id
    JOIN project_alpha_acquired_mapping_activation activation ON activation.receipt_id=acquired.receipt_id
    WHERE acquired.command_id=? AND mapping.activation_state='inactive' AND activation.state='inactive'`)
    .bind(commandId).first<ExistingAcquired>();
}

async function latestState(db: D1Database, commandId: string): Promise<Readonly<{ state_version: number; state: string }> | null> {
  return db.prepare(`SELECT state_version,state FROM project_alpha_existing_directory_binding_acquisition_events
    WHERE command_id=? ORDER BY state_version DESC LIMIT 1`).bind(commandId).first();
}

async function markUncertain(db: D1Database, commandId: string, requestSha256: string): Promise<void> {
  const state = await latestState(db, commandId);
  if (state?.state !== "pending") return;
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events
    (command_id,state_version,transition_id,request_sha256,state,occurred_at) VALUES(?,?,?,?, 'uncertain',?)`)
    .bind(commandId, state.state_version + 1, crypto.randomUUID(), requestSha256, now()).run();
}

function sameProfile(before: ProjectAlphaDirectoryProfileObservation, after: ProjectAlphaDirectoryProfileObservation): boolean {
  return before.sourceId === after.sourceId && before.sourceInstanceId === after.sourceInstanceId
    && before.applicationId === after.applicationId && before.historyEpoch === after.historyEpoch
    && before.resource.type === after.resource.type && before.resource.id === after.resource.id
    && before.resource.revision === after.resource.revision && canonical(before.profile) === canonical(after.profile);
}

export async function acquireProjectAlphaExistingDirectoryBinding(
  env: ProjectAlphaExistingDirectoryAcquisitionEnvironment,
  inputValue: unknown,
  send: typeof fetch = fetch,
): Promise<ProjectAlphaExistingDirectoryAcquisitionOutcome> {
  if (!input(inputValue)) return { status: "rejected", reason: "invalid_input" };
  const selected = inputValue;
  let configured: ReturnType<typeof resolveProjectAlphaApiV2Connection>;
  try { configured = resolveProjectAlphaApiV2Connection(env, selected.sourceId); }
  catch { return { status: "blocked", reason: "configuration" }; }
  if (!configured.enabled) return { status: "blocked", reason: "configuration" };
  const identity = { sourceInstanceId: configured.connection.expectedSourceInstanceId,
    applicationId: configured.connection.expectedApplicationId, historyEpoch: configured.connection.expectedHistoryEpoch! };

  try {
    const prior = await acquired(env.OPS_DB, selected.commandId);
    if (prior) return { status: "acquired", reviewReceiptId: prior.review_receipt_id, commandId: prior.command_id,
      acquiredReceiptId: prior.receipt_id, replayed: true };
  } catch { return { status: "uncertain", reason: "database" }; }

  const preRead = await readConfiguredProjectAlphaDirectoryProfile(env, selected.sourceId, selected.resourceType,
    selected.projectAlphaPublicId, send);
  if (preRead.status !== "observed") return preRead.status === "uncertain"
    ? { status: "uncertain", reason: "transport" } : { status: "blocked", reason: "remote" };
  const pre = preRead.observation;
  const parent = selected.resourceType === "client" ? pre.profile.organizationPublicId ?? null : null;
  const command: ProjectAlphaExistingDirectoryBindingCommand = Object.freeze({ commandId: selected.commandId,
    externalId: selected.recordId, expectedPublicId: selected.projectAlphaPublicId, expectedRevision: pre.resource.revision });
  const commandCanonical = canonicalProjectAlphaExistingDirectoryBindingCommand(command);
  if (!commandCanonical) return { status: "rejected", reason: "invalid_input" };
  const requestSha256 = await digest(commandCanonical.body);

  let current: Authority | null;
  try { current = await authority(env.OPS_DB, selected, identity, parent); }
  catch { return { status: "uncertain", reason: "database" }; }
  if (!current?.record_current) return { status: "blocked", reason: "stale_local" };
  if (!current.authority_current) return { status: "blocked", reason: "authority" };
  if (!current.relationship_current) return { status: "blocked", reason: "relationship" };

  let reservation: Reservation;
  try {
    const existing = await reservations(env.OPS_DB, selected);
    if (existing.length > 1) return { status: "conflict", reason: "reservation" };
    if (existing.length === 1) {
      reservation = existing[0]!;
      if (!exactReservation(reservation, selected, identity, command, requestSha256))
        return { status: "conflict", reason: "reservation" };
      const renewed = await authority(env.OPS_DB, selected, identity, parent, reservation.reviewed_at);
      if (!renewed?.unexpired) return { status: "blocked", reason: "expired" };
      if (!renewed.record_current) return { status: "blocked", reason: "stale_local" };
      if (!renewed.authority_current) return { status: "blocked", reason: "authority" };
      if (!renewed.relationship_current) return { status: "blocked", reason: "relationship" };
    } else {
      const receiptId = crypto.randomUUID(), reviewedAt = now(), reviewHash = await digest(pre);
      await env.OPS_DB.batch([
        env.OPS_DB.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(
          receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
          resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,
          reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,
          reviewer_profile_version,reviewed_at,reviewed_local_record_version)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,record.current_version FROM operations_directory_records record
          WHERE record.record_id=? AND record.record_kind=? AND record.current_version=?`)
          .bind(receiptId, requestSha256, selected.recordId, selected.sourceId, identity.sourceInstanceId,
            identity.applicationId, identity.historyEpoch, selected.resourceType, selected.recordId,
            selected.projectAlphaPublicId, command.expectedRevision, selected.reviewId, reviewHash,
            selected.reviewer.staffId, selected.reviewer.accessSubject, selected.reviewer.admissionVersion,
            selected.reviewer.profileVersion, reviewedAt, selected.recordId, selected.resourceType, selected.localRecordVersion),
        env.OPS_DB.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(
          command_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
          resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(selected.commandId, requestSha256, selected.recordId, selected.sourceId,
            identity.sourceInstanceId, identity.applicationId, identity.historyEpoch, selected.resourceType,
            selected.recordId, selected.projectAlphaPublicId, command.expectedRevision, receiptId),
        env.OPS_DB.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(
          command_id,state_version,transition_id,request_sha256,state,occurred_at) VALUES(?,1,?,?,'pending',?)`)
          .bind(selected.commandId, crypto.randomUUID(), requestSha256, reviewedAt),
      ]);
      const rows = await reservations(env.OPS_DB, selected);
      if (rows.length !== 1 || !exactReservation(rows[0]!, selected, identity, command, requestSha256))
        return { status: "conflict", reason: "reservation" };
      reservation = rows[0]!;
    }
  } catch { return { status: "conflict", reason: "reservation" }; }

  const stateBefore = await latestState(env.OPS_DB, selected.commandId).catch(() => null);
  let acquisitionEvidence = await env.OPS_DB.prepare(`SELECT destination_origin,pa_request_id,pa_replayed,response_sha256
    FROM project_alpha_existing_directory_binding_acquisition_response_receipts WHERE command_id=?`)
    .bind(selected.commandId).first<{ destination_origin: string; pa_request_id: string; pa_replayed: number; response_sha256: string }>()
    .catch(() => null);
  if (!acquisitionEvidence || stateBefore?.state !== "acknowledged") {
    const outcome = await sendConfiguredProjectAlphaExistingDirectoryBinding(env, selected.sourceId, selected.resourceType, command, send);
    if (outcome.status !== "acknowledged") {
      try { await markUncertain(env.OPS_DB, selected.commandId, requestSha256); } catch { return { status: "uncertain", reason: "database" }; }
      return outcome.status === "conflict" ? { status: "conflict", reason: "remote" }
        : outcome.status === "blocked" || outcome.status === "rejected" ? { status: "blocked", reason: "remote" }
          : { status: "uncertain", reason: "transport" };
    }
    const evidence = validatedProjectAlphaExistingDirectoryBindingEvidence(outcome);
    if (!evidence || evidence.requestSha256 !== requestSha256) return { status: "conflict", reason: "evidence" };
    try {
      const latest = await latestState(env.OPS_DB, selected.commandId);
      if (!latest || (latest.state !== "pending" && latest.state !== "uncertain"))
        return { status: "conflict", reason: "reservation" };
      await env.OPS_DB.batch([
        env.OPS_DB.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(
          command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
          project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(selected.commandId, identity.sourceInstanceId, identity.applicationId,
            identity.historyEpoch, selected.resourceType, selected.recordId, selected.projectAlphaPublicId,
            command.expectedRevision, evidence.destinationOrigin, evidence.response.requestId,
            evidence.response.replayed ? 1 : 0, evidence.responseSha256),
        env.OPS_DB.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(
          command_id,state_version,transition_id,request_sha256,state,occurred_at) VALUES(?,?,?,?, 'acknowledged',?)`)
          .bind(selected.commandId, latest.state_version + 1, crypto.randomUUID(), requestSha256, now()),
      ]);
      acquisitionEvidence = { destination_origin: evidence.destinationOrigin, pa_request_id: evidence.response.requestId,
        pa_replayed: evidence.response.replayed ? 1 : 0, response_sha256: evidence.responseSha256 };
    } catch {
      const saved = await env.OPS_DB.prepare(`SELECT destination_origin,pa_request_id,pa_replayed,response_sha256
        FROM project_alpha_existing_directory_binding_acquisition_response_receipts WHERE command_id=?`)
        .bind(selected.commandId).first<typeof acquisitionEvidence>().catch(() => null);
      if (!saved) return { status: "uncertain", reason: "database" };
      acquisitionEvidence = saved;
    }
  }

  const [profileAfter, bindingAfter] = await Promise.all([
    readConfiguredProjectAlphaDirectoryProfile(env, selected.sourceId, selected.resourceType, selected.projectAlphaPublicId, send),
    readConfiguredProjectAlphaDirectoryBindingStatus(env, selected.sourceId, selected.resourceType, selected.recordId,
      selected.projectAlphaPublicId, send),
  ]);
  if (profileAfter.status !== "observed" || bindingAfter.status !== "observed") return { status: "uncertain", reason: "post_read" };
  if (!sameProfile(pre, profileAfter.observation)
    || bindingAfter.observation.resource.revision !== command.expectedRevision
    || profileAfter.observation.authorizationGeneration !== bindingAfter.observation.authorizationGeneration)
    return { status: "conflict", reason: "evidence" };
  const postParent = selected.resourceType === "client" ? profileAfter.observation.profile.organizationPublicId ?? null : null;
  if (postParent !== parent) return { status: "conflict", reason: "evidence" };

  const finalAuthority = await authority(env.OPS_DB, selected, identity, postParent, reservation.reviewed_at).catch(() => null);
  if (!finalAuthority?.unexpired) return { status: "blocked", reason: "expired" };
  if (!finalAuthority.record_current) return { status: "blocked", reason: "stale_local" };
  if (!finalAuthority.authority_current) return { status: "blocked", reason: "authority" };
  if (!finalAuthority.relationship_current) return { status: "blocked", reason: "relationship" };

  const acquiredReceiptId = crypto.randomUUID(), claimId = crypto.randomUUID(), nativeOwnerEpochId = crypto.randomUUID();
  const profileHash = await digest(profileAfter.observation), bindingHash = await digest(bindingAfter.observation);
  try {
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(
        receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,
        resource_type,external_id,project_alpha_public_id,project_alpha_revision,acquisition_evidence_sha256,
        profile_evidence_sha256,binding_status_evidence_sha256,acquired_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM project_alpha_existing_directory_binding_review_evidence review
        JOIN operations_directory_records record ON record.record_id=review.record_id AND record.record_kind=review.resource_type
        JOIN native_staff_admissions admission ON admission.staff_id=review.reviewer_staff_id AND admission.active=1
          AND admission.bound_access_subject=review.reviewer_access_subject AND admission.version=review.reviewer_admission_version
        JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=review.reviewer_profile_version
        JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation=?
        WHERE review.receipt_id=? AND record.current_version=review.reviewed_local_record_version
          AND review.reviewed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND review.reviewed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours')
          AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=review.reviewer_staff_id AND role.role_id='role-owner' AND role.scope='global')
          AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=review.reviewer_staff_id
            AND grant_row.permission='directory.identity.link' AND grant_row.effect='allow' AND grant_row.active=1 AND ${APPLICABLE_FINAL})
          AND NOT EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=review.reviewer_staff_id
            AND grant_row.permission='directory.identity.link' AND grant_row.effect='deny' AND grant_row.active=1 AND ${APPLICABLE_FINAL})
          AND (review.resource_type='organization' OR EXISTS(SELECT 1 FROM operations_directory_client_organizations relationship
            WHERE relationship.client_record_id=review.record_id AND ((? IS NULL AND relationship.organization_record_id IS NULL)
              OR (? IS NOT NULL AND EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings parent
                WHERE parent.source_id=review.source_id AND parent.source_instance_id=review.source_instance_id
                  AND parent.application_id=review.application_id AND parent.history_epoch_id=review.history_epoch_id
                  AND parent.resource_type='organization' AND parent.external_id=relationship.organization_record_id
                  AND parent.project_alpha_public_id=?)))))`)
        .bind(acquiredReceiptId, requestSha256, selected.commandId, selected.recordId, selected.sourceId,
          identity.sourceInstanceId, identity.applicationId, identity.historyEpoch, selected.resourceType, selected.recordId,
          selected.projectAlphaPublicId, command.expectedRevision, acquisitionEvidence!.response_sha256, profileHash, bindingHash,
          now(), selected.reviewer.grantGeneration, reservation.receipt_id, postParent, postParent, postParent),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(receipt_id,record_id,source_id,
        source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,
        native_owner_epoch_id,activation_state) VALUES(?,?,?,?,?,?,?,?,?,NULL,'inactive')`)
        .bind(acquiredReceiptId, selected.recordId, selected.sourceId, identity.sourceInstanceId, identity.applicationId,
          identity.historyEpoch, selected.resourceType, selected.recordId, selected.projectAlphaPublicId),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(claim_id,receipt_id,native_owner_epoch_id,
        record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
        project_alpha_public_id,expected_local_record_version,actor_id,request_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(claimId, acquiredReceiptId, nativeOwnerEpochId, selected.recordId, selected.sourceId, identity.sourceInstanceId,
          identity.applicationId, identity.historyEpoch, selected.resourceType, selected.recordId,
          selected.projectAlphaPublicId, selected.localRecordVersion, selected.reviewer.staffId, requestSha256),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_acquired_mapping_activation(receipt_id,state) VALUES(?,'inactive')`)
        .bind(acquiredReceiptId),
    ]);
  } catch {
    const saved = await acquired(env.OPS_DB, selected.commandId).catch(() => null);
    if (saved) return { status: "acquired", reviewReceiptId: saved.review_receipt_id, commandId: saved.command_id,
      acquiredReceiptId: saved.receipt_id, replayed: true };
    return { status: "conflict", reason: "collision" };
  }
  return { status: "acquired", reviewReceiptId: reservation.receipt_id, commandId: selected.commandId,
    acquiredReceiptId, replayed: false };
}
