/**
 * Private, default-off consumer for immutable Project adoption review evidence.
 * It is intentionally not imported by a route, queue, scheduler, or Worker
 * entrypoint. Browser-controlled input is limited to two UUIDs. Separately
 * authenticated server actor context must exactly identify the stored reviewer;
 * every Project, authority, directory, source, and digest value is loaded from D1.
 *
 * This boundary reserves the reviewed intent only. The unmounted 0128 bridge
 * separately consumes the durable reservation into an atomic bind plan.
 */

export type ProjectAlphaProjectAdoptionReviewConsumerEnvironment = Readonly<{ OPS_DB: D1Database }>;
export type ProjectAlphaProjectAdoptionReviewActor = Readonly<{ staffId: string; accessSubject: string }>;
export type ProjectAlphaProjectAdoptionReviewAction = Readonly<{ reviewItemId: string; idempotencyKey: string }>;
export type ProjectAlphaProjectAdoptionReviewOutcome =
  | Readonly<{ status: "reserved"; reservationId: string; reviewItemId: string; idempotencyKey: string; replayed: boolean }>
  | Readonly<{ status: "rejected"; reason: "invalid_action" | "invalid_actor" }>
  | Readonly<{ status: "blocked"; reason: "caller" | "missing_review" | "invalid_evidence" | "current_state" }>
  | Readonly<{ status: "conflict"; reason: "review_item" | "idempotency_key" }>
  | Readonly<{ status: "uncertain"; reason: "database" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type Review = Readonly<{
  review_item_id: string;
  request_sha256: string;
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  external_project_id: string;
  project_alpha_public_id: string;
  project_alpha_revision: string;
  projection_sha256: string;
  authorization_generation: string;
  canonical_detail_read_json: string;
  canonical_detail_read_sha256: string;
  organization_record_id: string | null;
  organization_project_alpha_public_id: string | null;
  client_record_id: string | null;
  client_project_alpha_public_id: string | null;
  reviewer_staff_id: string;
  reviewer_access_subject: string;
  reviewer_admission_version: number;
  reviewer_profile_version: number;
  reviewer_owner_role_id: string;
  independent_evidence_sha256: string;
  project_grant_generation: number;
  normalized_scopes_json: string;
}>;
type Reservation = Readonly<{
  reservation_id: string;
  review_item_id: string;
  idempotency_key: string;
}>;
type Database = ReturnType<D1Database["withSession"]>;

const REVIEW_COLUMNS = `review_item_id,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,
  external_project_id,project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,
  canonical_detail_read_json,canonical_detail_read_sha256,organization_record_id,organization_project_alpha_public_id,
  client_record_id,client_project_alpha_public_id,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,
  reviewer_profile_version,reviewer_owner_role_id,independent_evidence_sha256,project_grant_generation,normalized_scopes_json`;

// This repeats the migration's reservation-time fences and adds the effective
// allow/deny grant checks omitted from that trigger. Keeping it in the INSERT
// SELECT makes the final decision and reservation one SQLite statement.
const CURRENT_REVIEW = `
  review.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS (SELECT 1 FROM project_alpha_project_destinations destination
    WHERE destination.external_project_id=review.external_project_id AND destination.source_id=review.source_id
      AND destination.application_id=review.application_id AND destination.expected_source_instance_id=review.source_instance_id
      AND destination.expected_history_epoch_id=review.history_epoch_id)
  AND NOT EXISTS (SELECT 1 FROM operations_shared_projects project WHERE project.external_project_id=review.external_project_id)
  AND NOT EXISTS (SELECT 1 FROM project_alpha_project_mappings mapping
    WHERE mapping.external_project_id=review.external_project_id
      OR (mapping.source_id=review.source_id AND mapping.source_instance_id=review.source_instance_id
        AND mapping.application_id=review.application_id AND mapping.history_epoch_id=review.history_epoch_id
        AND mapping.project_alpha_public_id=review.project_alpha_public_id))
  AND NOT EXISTS (SELECT 1 FROM project_alpha_project_outbox outbox
    WHERE outbox.external_project_id=review.external_project_id AND outbox.state IN ('pending','leased'))
  AND EXISTS (SELECT 1 FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=review.reviewer_staff_id AND admission.active=1
      AND admission.bound_access_subject=review.reviewer_access_subject
      AND admission.version=review.reviewer_admission_version AND profile.version=review.reviewer_profile_version
      AND generation.generation=review.project_grant_generation)
  AND EXISTS (SELECT 1 FROM staff_role_assignments assignment
    WHERE assignment.staff_id=review.reviewer_staff_id AND assignment.role_id=review.reviewer_owner_role_id
      AND assignment.scope='global')
  AND NOT EXISTS (SELECT 1 FROM json_each(review.normalized_scopes_json) scope
    WHERE NOT EXISTS (SELECT 1 FROM native_business_areas area
      LEFT JOIN native_business_divisions division
        ON division.id=json_extract(scope.value,'$.divisionId') AND division.business_area_id=area.id AND division.active=1
      WHERE area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1
        AND (json_extract(scope.value,'$.scopeKind')='business_area'
          OR (json_extract(scope.value,'$.scopeKind')='division' AND division.id IS NOT NULL))))
  AND NOT EXISTS (SELECT 1 FROM json_each(review.normalized_scopes_json) scope
    WHERE NOT EXISTS (SELECT 1 FROM native_project_grants grant_row
      WHERE grant_row.staff_id=review.reviewer_staff_id AND grant_row.capability='project.shared.sync'
        AND grant_row.effect='allow' AND grant_row.active=1
        AND (grant_row.scope_kind='global'
          OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=review.external_project_id)
          OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=json_extract(scope.value,'$.businessAreaId'))
          OR (grant_row.scope_kind='division' AND grant_row.division_id=json_extract(scope.value,'$.divisionId')))))
  AND (json_array_length(review.normalized_scopes_json)>0 OR EXISTS (SELECT 1 FROM native_project_grants grant_row
    WHERE grant_row.staff_id=review.reviewer_staff_id AND grant_row.capability='project.shared.sync'
      AND grant_row.effect='allow' AND grant_row.active=1
      AND (grant_row.scope_kind='global'
        OR (grant_row.scope_kind='exact_project' AND grant_row.external_project_id=review.external_project_id))))
  AND NOT EXISTS (SELECT 1 FROM native_project_grants deny
    WHERE deny.staff_id=review.reviewer_staff_id AND deny.capability='project.shared.sync'
      AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global'
        OR (deny.scope_kind='exact_project' AND deny.external_project_id=review.external_project_id)
        OR EXISTS (SELECT 1 FROM json_each(review.normalized_scopes_json) scope
          WHERE (deny.scope_kind='business_area' AND deny.business_area_id=json_extract(scope.value,'$.businessAreaId'))
            OR (deny.scope_kind='division' AND deny.division_id=json_extract(scope.value,'$.divisionId')))))
  AND (review.organization_record_id IS NULL OR (SELECT count(*) FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='organization'
    WHERE mapping.source_id=review.source_id AND mapping.source_instance_id=review.source_instance_id
      AND mapping.application_id=review.application_id AND mapping.history_epoch_id=review.history_epoch_id
      AND mapping.resource_type='organization' AND mapping.external_id=review.organization_record_id
      AND mapping.project_alpha_public_id=review.organization_project_alpha_public_id)=1)
  AND (review.client_record_id IS NULL OR (SELECT count(*) FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind='client'
    WHERE mapping.source_id=review.source_id AND mapping.source_instance_id=review.source_instance_id
      AND mapping.application_id=review.application_id AND mapping.history_epoch_id=review.history_epoch_id
      AND mapping.resource_type='client' AND mapping.external_id=review.client_record_id
      AND mapping.project_alpha_public_id=review.client_project_alpha_public_id)=1)
  AND (review.organization_record_id IS NULL OR review.client_record_id IS NULL OR EXISTS (
    SELECT 1 FROM operations_directory_client_organizations relationship
    WHERE relationship.client_record_id=review.client_record_id
      AND relationship.organization_record_id=review.organization_record_id))`;

function action(value: unknown): value is ProjectAlphaProjectAdoptionReviewAction {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  return keys.length === 2 && keys.every(key => typeof key === "string"
      && ["reviewItemId", "idempotencyKey"].includes(key)
      && Object.getOwnPropertyDescriptor(record, key)?.enumerable === true
      && "value" in Object.getOwnPropertyDescriptor(record, key)!)
    && UUID.test(typeof record.reviewItemId === "string" ? record.reviewItemId : "")
    && UUID.test(typeof record.idempotencyKey === "string" ? record.idempotencyKey : "");
}
function actor(value: unknown): value is ProjectAlphaProjectAdoptionReviewActor {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const record = value as Record<string, unknown>, keys = Reflect.ownKeys(record);
  return keys.length === 2 && keys.every(key => typeof key === "string"
      && ["staffId", "accessSubject"].includes(key)
      && Object.getOwnPropertyDescriptor(record, key)?.enumerable === true
      && "value" in Object.getOwnPropertyDescriptor(record, key)!)
    && typeof record.staffId === "string" && record.staffId.length >= 1 && record.staffId.length <= 191
    && typeof record.accessSubject === "string" && record.accessSubject.length >= 1 && record.accessSubject.length <= 764;
}
async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
async function validEvidence(review: Review): Promise<boolean> {
  if (![review.request_sha256, review.projection_sha256, review.canonical_detail_read_sha256,
    review.independent_evidence_sha256].every(value => SHA256.test(value))
    || [review.request_sha256, review.projection_sha256, review.canonical_detail_read_sha256]
      .includes(review.independent_evidence_sha256)
    || await digest(review.canonical_detail_read_json) !== review.canonical_detail_read_sha256) return false;
  try {
    const detail = JSON.parse(review.canonical_detail_read_json) as Record<string, unknown>;
    if (!exactObject(detail, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "accepted", "resource", "data"])
      || detail.apiVersion !== "2" || detail.sourceInstanceId !== review.source_instance_id
      || detail.applicationId !== review.application_id || detail.historyEpoch !== review.history_epoch_id
      || !exactObject(detail.resource, ["type", "id", "revision", "projectionSha256"])) return false;
    const resource = detail.resource;
    return resource.type === "project" && resource.id === review.project_alpha_public_id
      && resource.revision === review.project_alpha_revision && resource.projectionSha256 === review.projection_sha256;
  } catch { return false; }
}
async function reservation(db: Database, reviewItemId: string, idempotencyKey: string): Promise<Reservation | null> {
  return db.prepare(`SELECT reservation_id,review_item_id,idempotency_key
    FROM project_alpha_project_adoption_review_reservations
    WHERE review_item_id=? OR idempotency_key=? ORDER BY reserved_at,reservation_id LIMIT 1`)
    .bind(reviewItemId, idempotencyKey).first<Reservation>();
}
async function current(db: Database, reviewItemId: string, caller: ProjectAlphaProjectAdoptionReviewActor): Promise<boolean> {
  return !!await db.prepare(`SELECT 1 current FROM project_alpha_project_adoption_review_evidence review
    WHERE review.review_item_id=? AND review.reviewer_staff_id=? AND review.reviewer_access_subject=?
      AND ${CURRENT_REVIEW}`).bind(reviewItemId, caller.staffId, caller.accessSubject).first("current");
}
function replay(value: Reservation, input: ProjectAlphaProjectAdoptionReviewAction): ProjectAlphaProjectAdoptionReviewOutcome {
  if (value.review_item_id !== input.reviewItemId) return { status: "conflict", reason: "idempotency_key" };
  if (value.idempotency_key !== input.idempotencyKey) return { status: "conflict", reason: "review_item" };
  return { status: "reserved", reservationId: value.reservation_id, ...input, replayed: true };
}

/** Reserves one still-current immutable review item. It performs no network I/O and no Project bind. */
export async function reserveProjectAlphaProjectAdoptionReview(
  env: ProjectAlphaProjectAdoptionReviewConsumerEnvironment,
  caller: unknown,
  input: unknown,
): Promise<ProjectAlphaProjectAdoptionReviewOutcome> {
  if (!actor(caller)) return { status: "rejected", reason: "invalid_actor" };
  if (!action(input)) return { status: "rejected", reason: "invalid_action" };
  const db = env.OPS_DB.withSession("first-primary");
  let review: Review | null;
  try {
    review = await db.prepare(`SELECT ${REVIEW_COLUMNS}
      FROM project_alpha_project_adoption_review_evidence WHERE review_item_id=?`)
      .bind(input.reviewItemId).first<Review>();
  } catch { return { status: "uncertain", reason: "database" }; }
  if (!review) return { status: "blocked", reason: "missing_review" };
  if (review.reviewer_staff_id !== caller.staffId || review.reviewer_access_subject !== caller.accessSubject)
    return { status: "blocked", reason: "caller" };
  try { if (!await validEvidence(review)) return { status: "blocked", reason: "invalid_evidence" }; }
  catch { return { status: "uncertain", reason: "database" }; }

  try {
    const previous = await reservation(db, input.reviewItemId, input.idempotencyKey);
    if (previous) {
      const outcome = replay(previous, input);
      if (outcome.status !== "reserved") return outcome;
      return await current(db, input.reviewItemId, caller) ? outcome : { status: "blocked", reason: "current_state" };
    }
    const reservationId = crypto.randomUUID();
    const inserted = await db.prepare(`INSERT INTO project_alpha_project_adoption_review_reservations(
      reservation_id,review_item_id,idempotency_key,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,
      external_project_id,project_alpha_public_id,project_alpha_revision,projection_sha256,authorization_generation,
      canonical_detail_read_sha256,organization_record_id,organization_project_alpha_public_id,client_record_id,
      client_project_alpha_public_id,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,
      reviewer_profile_version,reviewer_owner_role_id,independent_evidence_sha256,project_grant_generation,normalized_scopes_json)
      SELECT ?,review.review_item_id,?,review.request_sha256,review.source_id,review.source_instance_id,review.application_id,
        review.history_epoch_id,review.external_project_id,review.project_alpha_public_id,review.project_alpha_revision,
        review.projection_sha256,review.authorization_generation,review.canonical_detail_read_sha256,
        review.organization_record_id,review.organization_project_alpha_public_id,review.client_record_id,
        review.client_project_alpha_public_id,review.reviewer_staff_id,review.reviewer_access_subject,
        review.reviewer_admission_version,review.reviewer_profile_version,review.reviewer_owner_role_id,
        review.independent_evidence_sha256,review.project_grant_generation,review.normalized_scopes_json
      FROM project_alpha_project_adoption_review_evidence review
      WHERE review.review_item_id=? AND review.reviewer_staff_id=? AND review.reviewer_access_subject=?
        AND ${CURRENT_REVIEW}`)
      .bind(reservationId, input.idempotencyKey, input.reviewItemId, caller.staffId, caller.accessSubject).run();
    if (inserted.meta.changes !== 1) return { status: "blocked", reason: "current_state" };
    const saved = await reservation(db, input.reviewItemId, input.idempotencyKey);
    if (!saved || saved.reservation_id !== reservationId || saved.review_item_id !== input.reviewItemId
      || saved.idempotency_key !== input.idempotencyKey) return { status: "uncertain", reason: "database" };
    return { status: "reserved", reservationId, ...input, replayed: false };
  } catch (error) {
    try {
      const winner = await reservation(db, input.reviewItemId, input.idempotencyKey);
      if (winner) {
        const outcome = replay(winner, input);
        if (outcome.status !== "reserved") return outcome;
        return await current(db, input.reviewItemId, caller) ? outcome : { status: "blocked", reason: "current_state" };
      }
    } catch { return { status: "uncertain", reason: "database" }; }
    const message = error instanceof Error ? error.message : "";
    return /not current and exact|constraint failed/i.test(message)
      ? { status: "blocked", reason: "current_state" }
      : { status: "uncertain", reason: "database" };
  }
}
