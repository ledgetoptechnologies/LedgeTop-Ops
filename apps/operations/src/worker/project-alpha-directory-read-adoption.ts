import {
  readConfiguredProjectAlphaDirectoryBindingStatus,
  readConfiguredProjectAlphaDirectoryProfile,
  type ProjectAlphaDirectoryBindingStatusOutcome,
  type ProjectAlphaDirectoryProfileReadOutcome,
  type ProjectAlphaDirectoryReadKind,
} from "./project-alpha-directory-read-api-v2";
import type { Env } from "./types";

const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;

export type ProjectAlphaDirectoryReadAdoptionActor = Readonly<{
  staffId: string;
  accessSubject: string;
  admissionVersion: number;
  profileVersion: number;
}>;

export type ProjectAlphaDirectoryReadAdoptionInput = Readonly<{
  sourceId: string;
  resourceType: ProjectAlphaDirectoryReadKind;
  recordId: string;
  expectedLocalRecordVersion: number;
  projectAlphaPublicId: string;
  idempotencyKey: string;
  actor: ProjectAlphaDirectoryReadAdoptionActor;
}>;

export type ProjectAlphaDirectoryReadAdoptionOutcome =
  | Readonly<{ status: "reserved" | "replayed"; reviewId: string; claimId: string; state: "inactive" }>
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "rejected"; reason: "invalid_input" }>
  | Readonly<{ status: "blocked"; reason: "selection_not_current" | "pa_read" | "pa_identity_changed" | "storage" }>
  | Readonly<{ status: "conflict"; reason: "idempotency_key_reused" | "identity_reserved" }>;

type Observation = Readonly<{
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  request_id: string;
  resource_revision: string;
  authorization_generation: string;
  page_sha256: string;
  external_id: string;
}>;

type Existing = Readonly<{
  review_id: string;
  claim_id: string;
  request_sha256: string;
  state: "inactive";
}>;

export type ProjectAlphaDirectoryReadAdoptionDependencies = Readonly<{
  readProfile: typeof readConfiguredProjectAlphaDirectoryProfile;
  readBinding: typeof readConfiguredProjectAlphaDirectoryBindingStatus;
}>;

const defaultDependencies: ProjectAlphaDirectoryReadAdoptionDependencies = Object.freeze({
  readProfile: readConfiguredProjectAlphaDirectoryProfile,
  readBinding: readConfiguredProjectAlphaDirectoryBindingStatus,
});

function safeId(value: unknown, max = 191): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > max || /\p{C}/u.test(value)) return false;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value; }
  catch { return false; }
}

function validInput(input: ProjectAlphaDirectoryReadAdoptionInput): boolean {
  return !!input && typeof input === "object" && !Array.isArray(input)
    && SOURCE_ID.test(input.sourceId)
    && (input.resourceType === "client" || input.resourceType === "organization")
    && safeId(input.recordId)
    && Number.isInteger(input.expectedLocalRecordVersion) && input.expectedLocalRecordVersion >= 1
    && PUBLIC_ID.test(input.projectAlphaPublicId)
    && UUID.test(input.idempotencyKey)
    && !!input.actor && typeof input.actor === "object" && !Array.isArray(input.actor)
    && safeId(input.actor.staffId) && safeId(input.actor.accessSubject)
    && Number.isInteger(input.actor.admissionVersion) && input.actor.admissionVersion >= 1
    && Number.isInteger(input.actor.profileVersion) && input.actor.profileVersion >= 1;
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function existing(db: D1Database, key: string): Promise<Existing | null> {
  return db.prepare(`SELECT review.review_id,claim.claim_id,review.request_sha256,claim.state
    FROM project_alpha_directory_read_adoption_reviews review
    JOIN project_alpha_directory_read_adoption_claims claim ON claim.review_id=review.review_id
    WHERE review.idempotency_key=?`).bind(key).first<Existing>();
}

function replay(current: Existing | null, requestSha256: string): ProjectAlphaDirectoryReadAdoptionOutcome | null {
  if (!current) return null;
  if (current.request_sha256 !== requestSha256) return { status: "conflict", reason: "idempotency_key_reused" };
  return { status: "replayed", reviewId: current.review_id, claimId: current.claim_id, state: "inactive" };
}

async function eligibleObservation(db: D1Database, input: ProjectAlphaDirectoryReadAdoptionInput): Promise<Observation | null> {
  return db.prepare(`SELECT observation.source_instance_id,observation.application_id,observation.history_epoch_id,
      observation.request_id,observation.resource_revision,receipt.authorization_generation,receipt.page_sha256,
      observation.binding_external_id AS external_id
    FROM project_alpha_api_v2_directory_observations_current observation
    JOIN project_alpha_api_v2_inventory_receipts receipt
      ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
     AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
     AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
    JOIN operations_directory_records record ON record.record_id=? AND record.record_kind=? AND record.current_version=?
    JOIN native_staff_admissions admission ON admission.staff_id=? AND admission.active=1
      AND admission.bound_access_subject=? AND admission.version=?
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=?
    WHERE observation.source_id=? AND observation.resource_type=?
      AND observation.project_alpha_public_id=? AND observation.present=1 AND observation.last_action='upsert'
      AND observation.binding_external_id IS NOT NULL AND observation.binding_status='active'
      AND observation.binding_resource_revision=observation.resource_revision AND observation.has_conflict=0
      AND EXISTS(SELECT 1 FROM native_directory_grants allow_row
        WHERE allow_row.staff_id=admission.staff_id AND allow_row.permission='directory.identity.link'
          AND allow_row.effect='allow' AND allow_row.active=1
          AND (allow_row.scope_kind='global'
            OR (allow_row.scope_kind='resource' AND allow_row.resource_id=record.record_id)
            OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=record.record_id AND assignment.staff_id=admission.staff_id AND assignment.active=1))
            OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
            OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row
        WHERE deny_row.staff_id=admission.staff_id AND deny_row.permission='directory.identity.link'
          AND deny_row.effect='deny' AND deny_row.active=1
          AND (deny_row.scope_kind='global'
            OR (deny_row.scope_kind='resource' AND deny_row.resource_id=record.record_id)
            OR (deny_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
              WHERE assignment.record_id=record.record_id AND assignment.staff_id=admission.staff_id AND assignment.active=1))
            OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=deny_row.business_area_id))
            OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=deny_row.division_id))))
      AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_mappings mapping
        WHERE mapping.source_id=observation.source_id AND mapping.source_instance_id=observation.source_instance_id
          AND mapping.application_id=observation.application_id AND mapping.resource_type=observation.resource_type
          AND (mapping.external_id=record.record_id OR mapping.external_id=observation.binding_external_id
            OR mapping.project_alpha_public_id=observation.project_alpha_public_id))
      AND NOT EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping
        WHERE mapping.source_id=observation.source_id AND mapping.source_instance_id=observation.source_instance_id
          AND mapping.application_id=observation.application_id AND mapping.resource_type=observation.resource_type
          AND (mapping.record_id=record.record_id OR mapping.external_id=observation.binding_external_id
            OR mapping.project_alpha_public_id=observation.project_alpha_public_id))
      AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
        WHERE conflict.source_id=observation.source_id AND conflict.inventory_kind='directory'
          AND conflict.resource_type='source')
      AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
        WHERE conflict.source_id=observation.source_id
          AND conflict.source_instance_id=observation.source_instance_id
          AND conflict.application_id=observation.application_id
          AND conflict.history_epoch_id=observation.history_epoch_id
          AND conflict.inventory_kind='directory' AND conflict.resource_type=observation.resource_type
          AND (conflict.project_alpha_public_id=observation.project_alpha_public_id
            OR conflict.external_id=observation.binding_external_id))
      AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_read_adoption_reviews review
        WHERE review.source_id=observation.source_id AND review.source_instance_id=observation.source_instance_id
          AND review.application_id=observation.application_id AND review.resource_type=observation.resource_type
          AND (review.record_id=record.record_id OR review.external_id=observation.binding_external_id
            OR review.project_alpha_public_id=observation.project_alpha_public_id))
    LIMIT 1`).bind(
      input.recordId, input.resourceType, input.expectedLocalRecordVersion,
      input.actor.staffId, input.actor.accessSubject, input.actor.admissionVersion, input.actor.profileVersion,
      input.sourceId, input.resourceType, input.projectAlphaPublicId,
    ).first<Observation>();
}

/**
 * Reserves one explicit, already-bound local/PA pair. It performs GET-only PA
 * verification and writes only immutable inactive review/claim evidence.
 */
export async function reserveProjectAlphaDirectoryReadAdoption(
  env: Env,
  input: ProjectAlphaDirectoryReadAdoptionInput,
  dependencies: ProjectAlphaDirectoryReadAdoptionDependencies = defaultDependencies,
): Promise<ProjectAlphaDirectoryReadAdoptionOutcome> {
  if (env.ENVIRONMENT !== "staging" || env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED !== "true")
    return { status: "disabled" };
  if (!validInput(input)) return { status: "rejected", reason: "invalid_input" };

  const requestSha256 = await digest({
    sourceId: input.sourceId, resourceType: input.resourceType, recordId: input.recordId,
    expectedLocalRecordVersion: input.expectedLocalRecordVersion,
    projectAlphaPublicId: input.projectAlphaPublicId,
    actor: input.actor,
  });
  const prior = replay(await existing(env.OPS_DB, input.idempotencyKey), requestSha256);
  if (prior) return prior;

  const observation = await eligibleObservation(env.OPS_DB, input);
  if (!observation) return { status: "blocked", reason: "selection_not_current" };

  const [profileRead, bindingRead] = await Promise.all([
    dependencies.readProfile(env, input.sourceId, input.resourceType, input.projectAlphaPublicId),
    dependencies.readBinding(env, input.sourceId, input.resourceType, observation.external_id, input.projectAlphaPublicId),
  ]);
  if (profileRead.status !== "observed" || bindingRead.status !== "observed")
    return { status: "blocked", reason: "pa_read" };
  const profile = profileRead.observation, binding = bindingRead.observation;
  if (profile.sourceInstanceId !== observation.source_instance_id
    || profile.applicationId !== observation.application_id
    || profile.historyEpoch !== observation.history_epoch_id
    || profile.resource.type !== input.resourceType
    || profile.resource.id !== input.projectAlphaPublicId
    || profile.resource.revision !== observation.resource_revision
    || profile.authorizationGeneration !== observation.authorization_generation
    || binding.sourceInstanceId !== observation.source_instance_id
    || binding.applicationId !== observation.application_id
    || binding.historyEpoch !== observation.history_epoch_id
    || binding.binding.type !== input.resourceType
    || binding.binding.externalId !== observation.external_id
    || binding.binding.publicId !== input.projectAlphaPublicId
    || binding.resource.revision !== observation.resource_revision
    || binding.authorizationGeneration !== observation.authorization_generation)
    return { status: "blocked", reason: "pa_identity_changed" };

  const profileEvidenceSha256 = await digest(profile);
  const bindingEvidenceSha256 = await digest(binding);
  const reviewId = crypto.randomUUID(), claimId = crypto.randomUUID();
  let nativeOwnerEpochId = crypto.randomUUID();
  while (nativeOwnerEpochId === observation.history_epoch_id) nativeOwnerEpochId = crypto.randomUUID();
  const reviewedAt = new Date().toISOString();
  try {
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_reviews(
        review_id,idempotency_key,request_sha256,record_id,expected_local_record_version,
        source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
        project_alpha_public_id,project_alpha_revision,authorization_generation,inventory_request_id,
        inventory_page_sha256,profile_request_id,profile_evidence_sha256,binding_request_id,
        binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,
        reviewer_profile_version,reviewed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        reviewId, input.idempotencyKey, requestSha256, input.recordId, input.expectedLocalRecordVersion,
        input.sourceId, observation.source_instance_id, observation.application_id, observation.history_epoch_id,
        input.resourceType, observation.external_id, input.projectAlphaPublicId, observation.resource_revision,
        observation.authorization_generation, observation.request_id, observation.page_sha256,
        profile.requestId, profileEvidenceSha256, binding.requestId, bindingEvidenceSha256,
        input.actor.staffId, input.actor.accessSubject, input.actor.admissionVersion,
        input.actor.profileVersion, reviewedAt,
      ),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_claims(
        claim_id,review_id,native_owner_epoch_id,record_id,expected_local_record_version,
        source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
        project_alpha_public_id,reviewer_staff_id,request_sha256,state
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'inactive')`).bind(
        claimId, reviewId, nativeOwnerEpochId, input.recordId, input.expectedLocalRecordVersion,
        input.sourceId, observation.source_instance_id, observation.application_id, observation.history_epoch_id,
        input.resourceType, observation.external_id, input.projectAlphaPublicId, input.actor.staffId, requestSha256,
      ),
    ]);
    return { status: "reserved", reviewId, claimId, state: "inactive" };
  } catch {
    const concurrent = replay(await existing(env.OPS_DB, input.idempotencyKey), requestSha256);
    if (concurrent) return concurrent;
    const collision = await env.OPS_DB.prepare(`SELECT 1 AS found
      FROM project_alpha_directory_read_adoption_reviews
      WHERE source_id=? AND source_instance_id=? AND application_id=? AND resource_type=?
        AND (record_id=? OR external_id=? OR project_alpha_public_id=?) LIMIT 1`).bind(
      input.sourceId, observation.source_instance_id, observation.application_id, input.resourceType,
      input.recordId, observation.external_id, input.projectAlphaPublicId,
    ).first<number>("found");
    return collision ? { status: "conflict", reason: "identity_reserved" }
      : { status: "blocked", reason: "storage" };
  }
}
