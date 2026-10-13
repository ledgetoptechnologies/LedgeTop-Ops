import {
  readConfiguredProjectAlphaDirectoryBindingStatus,
  readConfiguredProjectAlphaDirectoryProfile,
  type ProjectAlphaDirectoryReadKind,
} from "./project-alpha-directory-read-api-v2";
import type { Env } from "./types";

export type ProjectAlphaDirectoryReadAdoptionFinalizationActor = Readonly<{
  staffId: string;
  accessSubject: string;
  admissionVersion: number;
  profileVersion: number;
  grantGeneration: number;
}>;

export type ProjectAlphaDirectoryReadAdoptionFinalizationInput = Readonly<{
  fieldReviewReceiptId: string;
  idempotencyKey: string;
  actor: ProjectAlphaDirectoryReadAdoptionFinalizationActor;
}>;

export type ProjectAlphaDirectoryReadAdoptionFinalizationOutcome =
  | Readonly<{
      status: "prepared" | "replayed";
      finalizationId: string;
      fieldReviewReceiptId: string;
      acquisitionReviewId: string;
      acquisitionCommandId: string;
      activationIdempotencyKey: string;
      rebindRequired: boolean;
      adoptedFieldCount: number;
      state: "prepared";
    }>
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "rejected"; reason: "invalid_input" }>
  | Readonly<{ status: "blocked"; reason: "sealed_review" | "follow_up" | "stale_local" | "authority" | "source" | "remote" | "collision" | "storage" }>
  | Readonly<{ status: "conflict"; reason: "idempotency_key_reused" | "review_already_finalized" }>;

export type ProjectAlphaDirectoryReadAdoptionFinalizationDependencies = Readonly<{
  readProfile: typeof readConfiguredProjectAlphaDirectoryProfile;
  readBinding: typeof readConfiguredProjectAlphaDirectoryBindingStatus;
  uuid: () => string;
  now: () => string;
}>;

const dependencies: ProjectAlphaDirectoryReadAdoptionFinalizationDependencies = Object.freeze({
  readProfile: readConfiguredProjectAlphaDirectoryProfile,
  readBinding: readConfiguredProjectAlphaDirectoryBindingStatus,
  uuid: () => crypto.randomUUID(),
  now: () => new Date().toISOString(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Receipt = Readonly<{
  receipt_id: string; review_id: string; claim_id: string;
  source_id: string; source_instance_id: string; application_id: string; history_epoch_id: string;
  resource_type: ProjectAlphaDirectoryReadKind; record_id: string; external_id: string;
  project_alpha_public_id: string; project_alpha_revision: string; authorization_generation: string;
  local_record_version: number; local_profile_sha256: string; project_alpha_profile_sha256: string;
  reviewer_staff_id: string; reviewer_access_subject: string; reviewer_admission_version: number;
  reviewer_profile_version: number; decision_count: number; profile_json: string;
}>;

type Saved = Readonly<{
  finalization_id: string; idempotency_key: string; request_sha256: string; field_review_receipt_id: string;
  acquisition_review_id: string; acquisition_command_id: string; activation_idempotency_key: string;
  rebind_required: number; adopted_field_count: number; state: "prepared";
}>;

type Decision = Readonly<{ field_name: string; decision: "unchanged" | "retain_local" | "adopt_project_alpha" | "requires_follow_up" }>;

function plain(value: unknown): value is Record<string, unknown> {
  try { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try { return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
  catch { return false; }
}

function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1; }

function valid(input: unknown): input is ProjectAlphaDirectoryReadAdoptionFinalizationInput {
  return plain(input) && exact(input, ["fieldReviewReceiptId", "idempotencyKey", "actor"])
    && typeof input.fieldReviewReceiptId === "string" && UUID.test(input.fieldReviewReceiptId)
    && typeof input.idempotencyKey === "string" && UUID.test(input.idempotencyKey)
    && plain(input.actor) && exact(input.actor, ["staffId", "accessSubject", "admissionVersion", "profileVersion", "grantGeneration"])
    && typeof input.actor.staffId === "string" && input.actor.staffId.length > 0 && input.actor.staffId.length <= 191
    && typeof input.actor.accessSubject === "string" && input.actor.accessSubject.length > 0 && input.actor.accessSubject.length <= 191
    && positive(input.actor.admissionVersion) && positive(input.actor.profileVersion) && positive(input.actor.grantGeneration);
}

async function sha(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function receipt(db: D1Database, id: string): Promise<Receipt | null> {
  return db.prepare(`SELECT receipt.receipt_id,receipt.review_id,receipt.claim_id,receipt.source_id,
      receipt.source_instance_id,receipt.application_id,receipt.history_epoch_id,receipt.resource_type,
      receipt.record_id,receipt.external_id,receipt.project_alpha_public_id,receipt.project_alpha_revision,
      receipt.authorization_generation,receipt.local_record_version,receipt.local_profile_sha256,
      receipt.project_alpha_profile_sha256,receipt.reviewer_staff_id,receipt.reviewer_access_subject,
      receipt.reviewer_admission_version,receipt.reviewer_profile_version,receipt.decision_count,revision.profile_json
    FROM project_alpha_directory_read_adoption_field_review_receipts receipt
    JOIN project_alpha_directory_read_adoption_field_review_audit audit ON audit.receipt_id=receipt.receipt_id
      AND audit.actor_staff_id=receipt.reviewer_staff_id
    JOIN project_alpha_directory_read_adoption_claims claim ON claim.claim_id=receipt.claim_id
      AND claim.review_id=receipt.review_id AND claim.state='inactive'
    JOIN operations_directory_records record ON record.record_id=receipt.record_id
      AND record.record_kind=receipt.resource_type AND record.current_version=receipt.local_record_version
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    WHERE receipt.receipt_id=?`).bind(id).first<Receipt>();
}

async function decisions(db: D1Database, id: string): Promise<Decision[]> {
  return (await db.prepare(`SELECT field_name,decision FROM project_alpha_directory_read_adoption_field_decisions
    WHERE receipt_id=? ORDER BY field_name`).bind(id).all<Decision>()).results;
}

async function saved(db: D1Database, idempotencyKey: string, receiptId: string): Promise<Saved[]> {
  return (await db.prepare(`SELECT finalization_id,idempotency_key,request_sha256,field_review_receipt_id,
      acquisition_review_id,acquisition_command_id,activation_idempotency_key,rebind_required,adopted_field_count,state
    FROM project_alpha_directory_read_adoption_finalizations
    WHERE idempotency_key=? OR field_review_receipt_id=? ORDER BY created_at,finalization_id`)
    .bind(idempotencyKey, receiptId).all<Saved>()).results;
}

const APPLICABLE = `(grant_row.scope_kind='global'
  OR (grant_row.scope_kind='resource' AND grant_row.resource_id=record.record_id)
  OR (grant_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
    WHERE assignment.record_id=record.record_id AND assignment.staff_id=? AND assignment.active=1))
  OR (grant_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
    WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.business_area_id=grant_row.business_area_id))
  OR (grant_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
    WHERE scope.record_id=record.record_id AND scope.active=1 AND scope.division_id=grant_row.division_id)))`;

async function permission(db: D1Database, selected: Receipt,
  actor: ProjectAlphaDirectoryReadAdoptionFinalizationActor, permissionName: "directory.identity.link" | "directory.profile.edit"): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 allowed FROM operations_directory_records record
    JOIN native_staff_admissions admission ON admission.staff_id=? AND admission.active=1
      AND admission.bound_access_subject=? AND admission.version=?
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation=?
    WHERE record.record_id=? AND record.record_kind=? AND record.current_version=?
      AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=admission.staff_id
        AND grant_row.permission=? AND grant_row.effect='allow' AND grant_row.active=1 AND ${APPLICABLE})
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=admission.staff_id
        AND grant_row.permission=? AND grant_row.effect='deny' AND grant_row.active=1 AND ${APPLICABLE})`)
    .bind(actor.staffId, actor.accessSubject, actor.admissionVersion, actor.profileVersion, actor.grantGeneration,
      selected.record_id, selected.resource_type, selected.local_record_version,
      permissionName, actor.staffId, permissionName, actor.staffId).first<{ allowed: number }>();
  return row?.allowed === 1;
}

async function currentObservation(db: D1Database, selected: Receipt): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 current FROM project_alpha_api_v2_directory_observations_current observation
    WHERE observation.source_id=? AND observation.source_instance_id=? AND observation.application_id=?
      AND observation.history_epoch_id=? AND observation.resource_type=?
      AND observation.project_alpha_public_id=? AND observation.resource_revision=?
      AND observation.binding_external_id=? AND observation.binding_status='active'
      AND observation.binding_resource_revision=? AND observation.present=1 AND observation.last_action='upsert'
      AND observation.has_conflict=0
      AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
        WHERE conflict.source_id=observation.source_id AND conflict.inventory_kind='directory'
          AND (conflict.resource_type='source' OR (conflict.source_instance_id=observation.source_instance_id
            AND conflict.application_id=observation.application_id AND conflict.history_epoch_id=observation.history_epoch_id
            AND conflict.resource_type=observation.resource_type
            AND (conflict.project_alpha_public_id=observation.project_alpha_public_id
              OR conflict.external_id=observation.binding_external_id))))`)
    .bind(selected.source_id, selected.source_instance_id, selected.application_id, selected.history_epoch_id,
      selected.resource_type, selected.project_alpha_public_id, selected.project_alpha_revision,
      selected.external_id, selected.project_alpha_revision).first<{ current: number }>();
  return row?.current === 1;
}

async function collision(db: D1Database, selected: Receipt): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 collision WHERE EXISTS(SELECT 1 FROM project_alpha_directory_mappings mapping
      WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.resource_type=?
        AND (mapping.external_id IN (?,?) OR mapping.project_alpha_public_id=?))
    OR EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping
      WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.resource_type=?
        AND (mapping.record_id=? OR mapping.external_id IN (?,?) OR mapping.project_alpha_public_id=?))`)
    .bind(selected.source_id, selected.source_instance_id, selected.application_id, selected.resource_type,
      selected.record_id, selected.external_id, selected.project_alpha_public_id,
      selected.source_id, selected.source_instance_id, selected.application_id, selected.resource_type,
      selected.record_id, selected.record_id, selected.external_id, selected.project_alpha_public_id)
    .first<{ collision: number }>();
  return row?.collision === 1;
}

function result(row: Saved, replayed: boolean): Extract<ProjectAlphaDirectoryReadAdoptionFinalizationOutcome, { status: "prepared" | "replayed" }> {
  return { status: replayed ? "replayed" : "prepared", finalizationId: row.finalization_id,
    fieldReviewReceiptId: row.field_review_receipt_id, acquisitionReviewId: row.acquisition_review_id,
    acquisitionCommandId: row.acquisition_command_id, activationIdempotencyKey: row.activation_idempotency_key,
    rebindRequired: row.rebind_required === 1, adoptedFieldCount: row.adopted_field_count, state: "prepared" };
}

/**
 * Consumes one sealed field-review receipt into an append-only preparation for
 * the guarded acquisition/rebind path.  It performs no PA mutation and writes
 * no canonical mapping, portal grant, Delivery record, or public link.
 */
export async function prepareProjectAlphaDirectoryReadAdoptionFinalization(
  env: Pick<Env, "ENVIRONMENT" | "PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED" | "OPS_DB">,
  inputValue: unknown,
  overrides: Partial<ProjectAlphaDirectoryReadAdoptionFinalizationDependencies> = {},
): Promise<ProjectAlphaDirectoryReadAdoptionFinalizationOutcome> {
  if (env.ENVIRONMENT !== "staging" || env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED !== "true") return { status: "disabled" };
  if (!valid(inputValue)) return { status: "rejected", reason: "invalid_input" };
  const input = inputValue;
  const use = { ...dependencies, ...overrides };
  const selected = await receipt(env.OPS_DB, input.fieldReviewReceiptId).catch(() => null);
  if (!selected) return { status: "blocked", reason: "sealed_review" };
  if (selected.reviewer_staff_id !== input.actor.staffId || selected.reviewer_access_subject !== input.actor.accessSubject
    || selected.reviewer_admission_version !== input.actor.admissionVersion
    || selected.reviewer_profile_version !== input.actor.profileVersion) return { status: "blocked", reason: "authority" };

  const fieldDecisions = await decisions(env.OPS_DB, selected.receipt_id).catch(() => []);
  if (fieldDecisions.length !== selected.decision_count) return { status: "blocked", reason: "sealed_review" };
  if (fieldDecisions.some(value => value.decision === "requires_follow_up")) return { status: "blocked", reason: "follow_up" };
  const adoptedFieldCount = fieldDecisions.filter(value => value.decision === "adopt_project_alpha").length;

  let parsedLocal: unknown;
  try { parsedLocal = JSON.parse(selected.profile_json); }
  catch { return { status: "blocked", reason: "stale_local" }; }
  if (await sha(parsedLocal) !== selected.local_profile_sha256) return { status: "blocked", reason: "stale_local" };
  if (!await permission(env.OPS_DB, selected, input.actor, "directory.identity.link").catch(() => false)
    || (adoptedFieldCount > 0 && !await permission(env.OPS_DB, selected, input.actor, "directory.profile.edit").catch(() => false)))
    return { status: "blocked", reason: "authority" };
  if (!await currentObservation(env.OPS_DB, selected).catch(() => false)) return { status: "blocked", reason: "source" };
  if (await collision(env.OPS_DB, selected).catch(() => true)) return { status: "blocked", reason: "collision" };

  const [profileRead, bindingRead] = await Promise.all([
    use.readProfile(env as Env, selected.source_id, selected.resource_type, selected.project_alpha_public_id),
    use.readBinding(env as Env, selected.source_id, selected.resource_type, selected.external_id, selected.project_alpha_public_id),
  ]);
  if (profileRead.status !== "observed" || bindingRead.status !== "observed") return { status: "blocked", reason: "remote" };
  const profile = profileRead.observation, binding = bindingRead.observation;
  if (profile.sourceId !== selected.source_id || profile.sourceInstanceId !== selected.source_instance_id
    || profile.applicationId !== selected.application_id || profile.historyEpoch !== selected.history_epoch_id
    || profile.resource.type !== selected.resource_type || profile.resource.id !== selected.project_alpha_public_id
    || profile.resource.revision !== selected.project_alpha_revision
    || profile.authorizationGeneration !== selected.authorization_generation
    || await sha(profile.profile) !== selected.project_alpha_profile_sha256
    || binding.sourceId !== selected.source_id || binding.sourceInstanceId !== selected.source_instance_id
    || binding.applicationId !== selected.application_id || binding.historyEpoch !== selected.history_epoch_id
    || binding.binding.type !== selected.resource_type || binding.binding.externalId !== selected.external_id
    || binding.binding.publicId !== selected.project_alpha_public_id
    || binding.resource.revision !== selected.project_alpha_revision || binding.resource.present !== true
    || binding.authorizationGeneration !== selected.authorization_generation) return { status: "blocked", reason: "remote" };

  const requestSha256 = await sha({ fieldReviewReceiptId: input.fieldReviewReceiptId, actor: input.actor });
  const existing = await saved(env.OPS_DB, input.idempotencyKey, input.fieldReviewReceiptId).catch(() => []);
  if (existing.length > 1) return { status: "conflict", reason: "review_already_finalized" };
  if (existing.length === 1) {
    const prior = existing[0]!;
    if (prior.idempotency_key !== input.idempotencyKey) return { status: "conflict", reason: "review_already_finalized" };
    if (prior.request_sha256 !== requestSha256 || prior.field_review_receipt_id !== input.fieldReviewReceiptId)
      return { status: "conflict", reason: "idempotency_key_reused" };
    return result(prior, true);
  }

  const ids = { finalization: use.uuid(), review: use.uuid(), command: use.uuid(), activation: use.uuid(), event: use.uuid() };
  if (Object.values(ids).some(value => !UUID.test(value)) || new Set(Object.values(ids)).size !== Object.values(ids).length)
    return { status: "blocked", reason: "storage" };
  const at = use.now();
  try {
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_finalizations(
        finalization_id,idempotency_key,request_sha256,field_review_receipt_id,review_id,claim_id,
        source_id,source_instance_id,application_id,history_epoch_id,resource_type,record_id,reviewed_external_id,
        target_external_id,acquisition_external_id,acquisition_identity_mode,project_alpha_public_id,project_alpha_revision,authorization_generation,local_record_version,
        local_profile_sha256,project_alpha_profile_sha256,reviewer_staff_id,reviewer_access_subject,
        reviewer_admission_version,reviewer_profile_version,reviewer_grant_generation,adopted_field_count,rebind_required,
        acquisition_review_id,acquisition_command_id,activation_idempotency_key,state,prepared_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?)`).bind(
        ids.finalization, input.idempotencyKey, requestSha256, selected.receipt_id, selected.review_id, selected.claim_id,
        selected.source_id, selected.source_instance_id, selected.application_id, selected.history_epoch_id,
        selected.resource_type, selected.record_id, selected.external_id, selected.record_id,
        selected.external_id, "preserve_reviewed",
        selected.project_alpha_public_id, selected.project_alpha_revision, selected.authorization_generation,
        selected.local_record_version, selected.local_profile_sha256, selected.project_alpha_profile_sha256,
        input.actor.staffId, input.actor.accessSubject, input.actor.admissionVersion, input.actor.profileVersion,
        input.actor.grantGeneration, adoptedFieldCount, selected.external_id === selected.record_id ? 0 : 1,
        ids.review, ids.command, ids.activation, at),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_read_adoption_finalization_events(
        finalization_id,state_version,event_id,state,occurred_at) VALUES(?,1,?,'prepared',?)`)
        .bind(ids.finalization, ids.event, at),
    ]);
  } catch {
    const concurrent = await saved(env.OPS_DB, input.idempotencyKey, input.fieldReviewReceiptId).catch(() => []);
    if (concurrent.length === 1 && concurrent[0]!.idempotency_key === input.idempotencyKey
      && concurrent[0]!.request_sha256 === requestSha256) return result(concurrent[0]!, true);
    if (concurrent.some(row => row.idempotency_key === input.idempotencyKey))
      return { status: "conflict", reason: "idempotency_key_reused" };
    if (concurrent.length > 0) return { status: "conflict", reason: "review_already_finalized" };
    return { status: "blocked", reason: "storage" };
  }
  const inserted = (await saved(env.OPS_DB, input.idempotencyKey, input.fieldReviewReceiptId))[0];
  return inserted ? result(inserted, false) : { status: "blocked", reason: "storage" };
}
