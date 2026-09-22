import {
  resolveProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2ConnectionEnvironment,
} from "./project-alpha-api-v2-connections";

/**
 * Private, default-off consumer for an already acquired Directory binding.
 * It is deliberately not imported by a route, queue, scheduler, or Worker
 * entrypoint. The future browser action is restricted to two UUIDs; source,
 * identity, revision, evidence, authority, and relationship data come only
 * from deployment configuration and immutable D1 rows.
 */
export type ProjectAlphaExistingDirectoryBindingConsumerEnvironment =
  ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;

export type ProjectAlphaExistingDirectoryBindingAction = Readonly<{
  reviewItemId: string;
  idempotencyKey: string;
}>;

export type ProjectAlphaExistingDirectoryBindingOutcome =
  | Readonly<{ status: "activated"; activationId: string; reviewItemId: string; idempotencyKey: string;
    recordId: string; resourceType: "organization" | "client"; replayed: boolean }>
  | Readonly<{ status: "rejected"; reason: "invalid_action" }>
  | Readonly<{ status: "blocked"; reason: "missing_review" | "source" | "expired" | "authority" |
    "stale_evidence" | "collision" | "relationship" }>
  | Readonly<{ status: "conflict"; reason: "review_item" | "idempotency_key" }>
  | Readonly<{ status: "uncertain"; reason: "database" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Review = Readonly<{
  receipt_id: string;
  request_sha256: string;
  record_id: string;
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  resource_type: "organization" | "client";
  external_id: string;
  project_alpha_public_id: string;
  project_alpha_revision: string;
  reviewed_binding_evidence_sha256: string;
  reviewer_staff_id: string;
  reviewer_access_subject: string;
  reviewer_admission_version: number;
  reviewer_profile_version: number;
  reviewed_at: string;
  reviewed_local_record_version: number | null;
}>;

type Chain = Review & Readonly<{
  command_id: string;
  command_request_sha256: string;
  response_source_instance_id: string;
  response_application_id: string;
  response_history_epoch_id: string;
  response_resource_type: string;
  response_external_id: string;
  response_project_alpha_public_id: string;
  response_project_alpha_revision: string;
  response_sha256: string;
  acquired_receipt_id: string;
  acquired_request_sha256: string;
  acquisition_evidence_sha256: string;
  profile_evidence_sha256: string;
  binding_status_evidence_sha256: string;
  mapping_record_id: string;
  mapping_source_id: string;
  mapping_source_instance_id: string;
  mapping_application_id: string;
  mapping_history_epoch_id: string;
  mapping_resource_type: string;
  mapping_external_id: string;
  mapping_project_alpha_public_id: string;
  mapping_native_owner_epoch_id: string | null;
  mapping_activation_state: string;
  claim_id: string;
  claim_record_id: string;
  claim_source_id: string;
  claim_source_instance_id: string;
  claim_application_id: string;
  claim_history_epoch_id: string;
  claim_resource_type: string;
  claim_external_id: string;
  claim_project_alpha_public_id: string;
  claim_expected_local_record_version: number;
  claim_actor_id: string;
  claim_request_sha256: string;
  dormant_state: string;
}>;

type Activation = Readonly<{
  activation_id: string;
  review_receipt_id: string;
  idempotency_key: string;
  record_id: string;
  resource_type: "organization" | "client";
}>;

type Current = Readonly<{
  unexpired: number;
  record_current: number;
  authority_current: number;
  collision_free: number;
  relationship_current: number;
  grant_generation: number | null;
}>;

function exactAction(value: unknown): value is ProjectAlphaExistingDirectoryBindingAction {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    const fields = Reflect.ownKeys(value);
    if (fields.length !== 2 || fields.some(field => typeof field !== "string"
      || !["reviewItemId", "idempotencyKey"].includes(field))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const review = descriptors.reviewItemId, key = descriptors.idempotencyKey;
    return review?.enumerable === true && "value" in review && typeof review.value === "string" && UUID.test(review.value)
      && key?.enumerable === true && "value" in key && typeof key.value === "string" && UUID.test(key.value);
  } catch { return false; }
}

async function prior(db: D1Database, reviewItemId: string, idempotencyKey: string): Promise<Activation | null> {
  return db.prepare(`SELECT activation_id,review_receipt_id,idempotency_key,record_id,resource_type
    FROM project_alpha_existing_directory_binding_activation_receipts
    WHERE review_receipt_id=? OR idempotency_key=? ORDER BY activated_at,activation_id LIMIT 1`)
    .bind(reviewItemId, idempotencyKey).first<Activation>();
}

function replay(value: Activation, input: ProjectAlphaExistingDirectoryBindingAction): ProjectAlphaExistingDirectoryBindingOutcome {
  if (value.review_receipt_id !== input.reviewItemId) return { status: "conflict", reason: "idempotency_key" };
  if (value.idempotency_key !== input.idempotencyKey) return { status: "conflict", reason: "review_item" };
  return { status: "activated", activationId: value.activation_id, reviewItemId: value.review_receipt_id,
    idempotencyKey: value.idempotency_key, recordId: value.record_id, resourceType: value.resource_type, replayed: true };
}

async function review(db: D1Database, reviewItemId: string): Promise<Review | null> {
  return db.prepare(`SELECT receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,
      history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,
      reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,
      reviewer_admission_version,reviewer_profile_version,reviewed_at,reviewed_local_record_version
    FROM project_alpha_existing_directory_binding_review_evidence WHERE receipt_id=?`)
    .bind(reviewItemId).first<Review>();
}

async function chain(db: D1Database, reviewItemId: string): Promise<Chain | null> {
  return db.prepare(`SELECT review.receipt_id,review.request_sha256,review.record_id,review.source_id,
      review.source_instance_id,review.application_id,review.history_epoch_id,review.resource_type,
      review.external_id,review.project_alpha_public_id,review.project_alpha_revision,
      review.reviewed_binding_evidence_sha256,review.reviewer_staff_id,review.reviewer_access_subject,
      review.reviewer_admission_version,review.reviewer_profile_version,review.reviewed_at,
      review.reviewed_local_record_version,command.command_id,command.request_sha256 command_request_sha256,
      response.source_instance_id response_source_instance_id,response.application_id response_application_id,
      response.history_epoch_id response_history_epoch_id,response.resource_type response_resource_type,
      response.external_id response_external_id,response.project_alpha_public_id response_project_alpha_public_id,
      response.project_alpha_revision response_project_alpha_revision,response.response_sha256,
      acquired.receipt_id acquired_receipt_id,acquired.request_sha256 acquired_request_sha256,
      acquired.acquisition_evidence_sha256,acquired.profile_evidence_sha256,
      acquired.binding_status_evidence_sha256,mapping.record_id mapping_record_id,
      mapping.source_id mapping_source_id,mapping.source_instance_id mapping_source_instance_id,
      mapping.application_id mapping_application_id,mapping.history_epoch_id mapping_history_epoch_id,
      mapping.resource_type mapping_resource_type,mapping.external_id mapping_external_id,
      mapping.project_alpha_public_id mapping_project_alpha_public_id,
      mapping.native_owner_epoch_id mapping_native_owner_epoch_id,mapping.activation_state mapping_activation_state,
      claim.claim_id,claim.record_id claim_record_id,claim.source_id claim_source_id,
      claim.source_instance_id claim_source_instance_id,claim.application_id claim_application_id,
      claim.history_epoch_id claim_history_epoch_id,claim.resource_type claim_resource_type,
      claim.external_id claim_external_id,claim.project_alpha_public_id claim_project_alpha_public_id,
      claim.expected_local_record_version claim_expected_local_record_version,claim.actor_id claim_actor_id,
      claim.request_sha256 claim_request_sha256,dormant.state dormant_state
    FROM project_alpha_existing_directory_binding_review_evidence review
    JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.review_receipt_id=review.receipt_id
    JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=command.command_id
    JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.command_id=command.command_id
    JOIN project_alpha_acquired_canonical_mappings mapping ON mapping.receipt_id=acquired.receipt_id
    JOIN project_alpha_acquired_native_owner_claims claim ON claim.receipt_id=mapping.receipt_id
    JOIN project_alpha_acquired_mapping_activation dormant ON dormant.receipt_id=mapping.receipt_id
    WHERE review.receipt_id=?`).bind(reviewItemId).first<Chain>();
}

function sameIdentity(source: Review, value: Record<string, unknown>, prefix: string): boolean {
  return value[`${prefix}record_id`] === source.record_id && value[`${prefix}source_id`] === source.source_id
    && value[`${prefix}source_instance_id`] === source.source_instance_id
    && value[`${prefix}application_id`] === source.application_id
    && value[`${prefix}history_epoch_id`] === source.history_epoch_id
    && value[`${prefix}resource_type`] === source.resource_type
    && value[`${prefix}external_id`] === source.external_id
    && value[`${prefix}project_alpha_public_id`] === source.project_alpha_public_id;
}

function exactChain(value: Chain): boolean {
  const hashes = [value.request_sha256, value.reviewed_binding_evidence_sha256, value.response_sha256,
    value.acquisition_evidence_sha256, value.profile_evidence_sha256, value.binding_status_evidence_sha256];
  return hashes.every(hash => SHA256.test(hash))
    && value.reviewed_local_record_version !== null && Number.isSafeInteger(value.reviewed_local_record_version)
    && value.reviewed_local_record_version >= 1
    && value.command_request_sha256 === value.request_sha256
    && value.acquired_request_sha256 === value.request_sha256
    && value.claim_request_sha256 === value.request_sha256
    && value.response_sha256 === value.acquisition_evidence_sha256
    && new Set([value.reviewed_binding_evidence_sha256,value.acquisition_evidence_sha256,
      value.profile_evidence_sha256,value.binding_status_evidence_sha256]).size === 4
    && value.response_source_instance_id === value.source_instance_id
    && value.response_application_id === value.application_id
    && value.response_history_epoch_id === value.history_epoch_id
    && value.response_resource_type === value.resource_type
    && value.response_external_id === value.external_id
    && value.response_project_alpha_public_id === value.project_alpha_public_id
    && value.response_project_alpha_revision === value.project_alpha_revision
    && sameIdentity(value, value, "mapping_") && sameIdentity(value, value, "claim_")
    && value.claim_expected_local_record_version === value.reviewed_local_record_version
    && value.claim_actor_id === value.reviewer_staff_id
    && value.mapping_native_owner_epoch_id === null && value.mapping_activation_state === "inactive"
    && value.dormant_state === "inactive";
}

const APPLICABLE = `(grant_row.scope_kind='global'
  OR (grant_row.scope_kind='resource' AND grant_row.resource_id=review.record_id)
  OR (grant_row.scope_kind='assigned' AND EXISTS (SELECT 1 FROM native_directory_assignments assignment
    WHERE assignment.record_id=review.record_id AND assignment.staff_id=review.reviewer_staff_id AND assignment.active=1))
  OR (grant_row.scope_kind='business_area' AND EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
    WHERE scope.record_id=review.record_id AND scope.active=1 AND scope.business_area_id=grant_row.business_area_id))
  OR (grant_row.scope_kind='division' AND EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
    WHERE scope.record_id=review.record_id AND scope.active=1 AND scope.division_id=grant_row.division_id)))`;

async function current(db: D1Database, value: Review): Promise<Current | null> {
  return db.prepare(`SELECT
      (review.reviewed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND review.reviewed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours')) unexpired,
      EXISTS (SELECT 1 FROM operations_directory_records record WHERE record.record_id=review.record_id
        AND record.record_kind=review.resource_type AND record.current_version=review.reviewed_local_record_version) record_current,
      (EXISTS (SELECT 1 FROM native_staff_admissions admission
          JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
          JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
          WHERE admission.staff_id=review.reviewer_staff_id AND admission.active=1
            AND admission.bound_access_subject=review.reviewer_access_subject
            AND admission.version=review.reviewer_admission_version AND profile.version=review.reviewer_profile_version)
        AND EXISTS (SELECT 1 FROM staff_role_assignments assignment WHERE assignment.staff_id=review.reviewer_staff_id
          AND assignment.role_id='role-owner' AND assignment.scope='global')
        AND EXISTS (SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=review.reviewer_staff_id
          AND grant_row.permission='directory.identity.link' AND grant_row.effect='allow' AND grant_row.active=1 AND ${APPLICABLE})
        AND NOT EXISTS (SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=review.reviewer_staff_id
          AND grant_row.permission='directory.identity.link' AND grant_row.effect='deny' AND grant_row.active=1 AND ${APPLICABLE})) authority_current,
      NOT EXISTS (SELECT 1 FROM project_alpha_directory_mappings legacy WHERE legacy.source_id=review.source_id
        AND legacy.source_instance_id=review.source_instance_id AND legacy.application_id=review.application_id
        AND legacy.resource_type=review.resource_type
        AND (legacy.external_id=review.external_id OR legacy.project_alpha_public_id=review.project_alpha_public_id)) collision_free,
      (review.resource_type='organization' OR EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship
        WHERE relationship.client_record_id=review.record_id AND (relationship.organization_record_id IS NULL
          OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings parent
            JOIN operations_directory_records parent_record ON parent_record.record_id=parent.external_id AND parent_record.record_kind='organization'
            WHERE parent.source_id=review.source_id AND parent.source_instance_id=review.source_instance_id
              AND parent.application_id=review.application_id AND parent.history_epoch_id=review.history_epoch_id
              AND parent.resource_type='organization' AND parent.external_id=relationship.organization_record_id)
          OR EXISTS (SELECT 1 FROM project_alpha_existing_directory_binding_activation_receipts parent
            WHERE parent.source_id=review.source_id AND parent.source_instance_id=review.source_instance_id
              AND parent.application_id=review.application_id AND parent.history_epoch_id=review.history_epoch_id
              AND parent.resource_type='organization' AND parent.record_id=relationship.organization_record_id)))) relationship_current,
      (SELECT generation FROM native_directory_grant_generations WHERE staff_id=review.reviewer_staff_id) grant_generation
    FROM project_alpha_existing_directory_binding_review_evidence review WHERE review.receipt_id=?`)
    .bind(value.receipt_id).first<Current>();
}

function blocked(value: Current | null): ProjectAlphaExistingDirectoryBindingOutcome {
  if (!value || !value.unexpired) return { status: "blocked", reason: "expired" };
  if (!value.record_current) return { status: "blocked", reason: "stale_evidence" };
  if (!value.authority_current || value.grant_generation === null) return { status: "blocked", reason: "authority" };
  if (!value.collision_free) return { status: "blocked", reason: "collision" };
  if (!value.relationship_current) return { status: "blocked", reason: "relationship" };
  return { status: "blocked", reason: "stale_evidence" };
}

/** Activates exactly one current immutable review chain without network I/O. */
export async function activateProjectAlphaExistingDirectoryBinding(
  env: ProjectAlphaExistingDirectoryBindingConsumerEnvironment,
  inputValue: unknown,
): Promise<ProjectAlphaExistingDirectoryBindingOutcome> {
  if (!exactAction(inputValue)) return { status: "rejected", reason: "invalid_action" };
  const input = inputValue;
  try {
    const saved = await prior(env.OPS_DB, input.reviewItemId, input.idempotencyKey);
    if (saved) return replay(saved, input);
  } catch { return { status: "uncertain", reason: "database" }; }

  let evidence: Review;
  let acquired: Chain;
  try {
    const [foundReview, foundChain] = await Promise.all([
      review(env.OPS_DB, input.reviewItemId), chain(env.OPS_DB, input.reviewItemId),
    ]);
    if (!foundReview) return { status: "blocked", reason: "missing_review" };
    evidence = foundReview;
    if (!foundChain || !exactChain(foundChain)) return { status: "blocked", reason: "stale_evidence" };
    acquired = foundChain;
  } catch { return { status: "uncertain", reason: "database" }; }

  try {
    const configured = resolveProjectAlphaApiV2Connection(env, evidence.source_id);
    if (!configured.enabled || configured.connection.expectedSourceInstanceId !== evidence.source_instance_id
      || configured.connection.expectedApplicationId !== evidence.application_id
      || configured.connection.expectedHistoryEpoch !== evidence.history_epoch_id) return { status: "blocked", reason: "source" };
  } catch { return { status: "blocked", reason: "source" }; }

  let before: Current | null;
  try { before = await current(env.OPS_DB, evidence); }
  catch { return { status: "uncertain", reason: "database" }; }
  if (!before?.unexpired || !before.record_current || !before.authority_current
    || !before.collision_free || !before.relationship_current || before.grant_generation === null) return blocked(before);

  const activationId = crypto.randomUUID();
  try {
    const inserted = await env.OPS_DB.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(
      activation_id,review_receipt_id,idempotency_key,acquired_receipt_id,native_owner_claim_id,
      record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
      project_alpha_public_id,project_alpha_revision,local_record_version,request_sha256,
      acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256,
      activated_by_staff_id,directory_grant_generation)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      activationId, input.reviewItemId, input.idempotencyKey, acquired.acquired_receipt_id, acquired.claim_id,
      evidence.record_id, evidence.source_id, evidence.source_instance_id, evidence.application_id,
      evidence.history_epoch_id, evidence.resource_type, evidence.external_id, evidence.project_alpha_public_id,
      evidence.project_alpha_revision, evidence.reviewed_local_record_version, evidence.request_sha256,
      acquired.acquisition_evidence_sha256, acquired.profile_evidence_sha256,
      acquired.binding_status_evidence_sha256, evidence.reviewer_staff_id, before.grant_generation).run();
    if (inserted.meta.changes !== 1) return { status: "uncertain", reason: "database" };
    const saved = await prior(env.OPS_DB, input.reviewItemId, input.idempotencyKey);
    if (!saved || saved.activation_id !== activationId) return { status: "uncertain", reason: "database" };
    return { status: "activated", activationId, reviewItemId: input.reviewItemId,
      idempotencyKey: input.idempotencyKey, recordId: evidence.record_id,
      resourceType: evidence.resource_type, replayed: false };
  } catch {
    try {
      const winner = await prior(env.OPS_DB, input.reviewItemId, input.idempotencyKey);
      if (winner) return replay(winner, input);
      return blocked(await current(env.OPS_DB, evidence));
    } catch { return { status: "uncertain", reason: "database" }; }
  }
}
