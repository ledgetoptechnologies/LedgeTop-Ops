import { acquireProjectAlphaExistingDirectoryBinding } from "./project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from "./project-alpha-existing-directory-binding-review-consumer";
import { prepareProjectAlphaDirectoryReadAdoptionFinalization } from "./project-alpha-directory-read-adoption-finalizer";
import { applyProjectAlphaDirectoryReadAdoptionLocalProfile } from "./project-alpha-directory-read-adoption-local-profile";
import { readConfiguredProjectAlphaDirectoryProfile, type ProjectAlphaDirectoryProfile, type ProjectAlphaDirectoryReadKind } from "./project-alpha-directory-read-api-v2";
import type { Env } from "./types";

export type ProjectAlphaDirectoryReadAdoptionRuntimeActor = Readonly<{
  staffId: string; accessSubject: string; admissionVersion: number; profileVersion: number; grantGeneration: number;
}>;
export type ProjectAlphaDirectoryReadAdoptionRuntimeInput = Readonly<{
  fieldReviewReceiptId: string; idempotencyKey: string; actor: ProjectAlphaDirectoryReadAdoptionRuntimeActor;
}>;
export type ProjectAlphaDirectoryReadAdoptionRuntimeOutcome =
  | Readonly<{ status: "finalized" | "replayed"; finalizationId: string; activationId: string;
      recordId: string; resourceType: ProjectAlphaDirectoryReadKind; adoptedFields: readonly string[] }>
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "rejected" | "blocked" | "conflict" | "uncertain";
      stage: "prepare" | "local_profile" | "acquire" | "activate"; reason: string }>;

type RuntimeEnv = Pick<Env, "ENVIRONMENT" | "PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED" |
  "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS"> & Readonly<{ PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED?: string }>;
type Finalization = Readonly<{
  finalization_id: string; idempotency_key: string; request_sha256: string; field_review_receipt_id: string;
  source_id: string; source_instance_id: string; application_id: string; history_epoch_id: string;
  resource_type: ProjectAlphaDirectoryReadKind; record_id: string; project_alpha_public_id: string;
  project_alpha_revision: string; authorization_generation: string; local_record_version: number;
  local_profile_sha256: string; project_alpha_profile_sha256: string; reviewer_staff_id: string;
  reviewer_access_subject: string; reviewer_admission_version: number; reviewer_profile_version: number;
  reviewer_grant_generation: number; adopted_field_count: number; acquisition_review_id: string;
  acquisition_command_id: string; activation_idempotency_key: string;
}>;
type Decision = Readonly<{ field_name: string; decision: string }>;
type LocalReceipt = Readonly<{ adoption_id: string; result_record_version: number; adopted_fields_json: string;
  selected_profile_grant_id: string; expected_local_profile_sha256: string; project_alpha_profile_sha256: string;
  result_profile_sha256: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SUPPORTED = new Set(["name", "email", "phone", "address_line1", "address_line2", "city", "state", "postal_code", "country"]);
function plain(value: unknown): value is Record<string, unknown> {
  try { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}
function valid(value: unknown): value is ProjectAlphaDirectoryReadAdoptionRuntimeInput {
  return plain(value) && Reflect.ownKeys(value).length === 3 && Object.hasOwn(value, "fieldReviewReceiptId")
    && Object.hasOwn(value, "idempotencyKey") && Object.hasOwn(value, "actor")
    && typeof value.fieldReviewReceiptId === "string" && UUID.test(value.fieldReviewReceiptId)
    && typeof value.idempotencyKey === "string" && UUID.test(value.idempotencyKey)
    && plain(value.actor) && Reflect.ownKeys(value.actor).length === 5
    && typeof value.actor.staffId === "string" && value.actor.staffId.length > 0
    && typeof value.actor.accessSubject === "string" && value.actor.accessSubject.length > 0
    && [value.actor.admissionVersion, value.actor.profileVersion, value.actor.grantGeneration]
      .every(item => Number.isSafeInteger(item) && Number(item) >= 1);
}
async function sha(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function loadFinalization(db: D1Database, key: string, receipt: string): Promise<Finalization[]> {
  return (await db.prepare(`SELECT finalization_id,idempotency_key,request_sha256,field_review_receipt_id,
      source_id,source_instance_id,application_id,history_epoch_id,resource_type,record_id,project_alpha_public_id,
      project_alpha_revision,authorization_generation,local_record_version,local_profile_sha256,project_alpha_profile_sha256,
      reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewer_grant_generation,
      adopted_field_count,acquisition_review_id,acquisition_command_id,activation_idempotency_key
    FROM project_alpha_directory_read_adoption_finalizations
    WHERE idempotency_key=? OR field_review_receipt_id=? ORDER BY created_at,finalization_id`).bind(key, receipt).all<Finalization>()).results;
}
async function localReceipt(db: D1Database, finalizationId: string): Promise<LocalReceipt | null> {
  return db.prepare(`SELECT adoption_id,result_record_version,adopted_fields_json,selected_profile_grant_id,
      expected_local_profile_sha256,project_alpha_profile_sha256,result_profile_sha256
    FROM project_alpha_directory_read_adoption_local_profile_receipts WHERE finalization_id=?`).bind(finalizationId).first<LocalReceipt>();
}
async function currentLocalProfile(db: D1Database, recordId: string): Promise<{ version: number; profileSha256: string } | null> {
  const row = await db.prepare(`SELECT record.current_version,revision.profile_json FROM operations_directory_records record
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    WHERE record.record_id=?`).bind(recordId).first<{ current_version: number; profile_json: string }>();
  if (!row) return null;
  let profile: unknown;
  try { profile = JSON.parse(row.profile_json); } catch { return null; }
  return { version: row.current_version, profileSha256: await sha(profile) };
}
async function selectedProfileGrant(db: D1Database, row: Finalization, actor: ProjectAlphaDirectoryReadAdoptionRuntimeActor,
  recordVersion = row.local_record_version): Promise<string | null> {
  return db.prepare(`SELECT grant_row.id FROM native_directory_grants grant_row
    JOIN native_staff_admissions admission ON admission.staff_id=grant_row.staff_id AND admission.active=1
      AND admission.bound_access_subject=? AND admission.version=?
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id AND generation.generation=?
    JOIN operations_directory_records record ON record.record_id=? AND record.record_kind=? AND record.current_version=?
    WHERE grant_row.staff_id=? AND grant_row.permission='directory.profile.edit' AND grant_row.effect='allow' AND grant_row.active=1
      AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='resource' AND grant_row.resource_id=record.record_id)
        OR (grant_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments x WHERE x.record_id=record.record_id AND x.staff_id=? AND x.active=1))
        OR (grant_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes x WHERE x.record_id=record.record_id AND x.active=1 AND x.business_area_id=grant_row.business_area_id))
        OR (grant_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes x WHERE x.record_id=record.record_id AND x.active=1 AND x.division_id=grant_row.division_id)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=grant_row.staff_id AND deny.permission='directory.profile.edit'
        AND deny.effect='deny' AND deny.active=1 AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=record.record_id)
          OR (deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments x WHERE x.record_id=record.record_id AND x.staff_id=? AND x.active=1))
          OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes x WHERE x.record_id=record.record_id AND x.active=1 AND x.business_area_id=deny.business_area_id))
          OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes x WHERE x.record_id=record.record_id AND x.active=1 AND x.division_id=deny.division_id))))
    ORDER BY grant_row.id LIMIT 1`).bind(actor.accessSubject, actor.admissionVersion, actor.profileVersion, actor.grantGeneration,
      row.record_id, row.resource_type, recordVersion, actor.staffId, actor.staffId, actor.staffId)
    .first<string>("id");
}

export type ProjectAlphaDirectoryReadAdoptionRuntimeDependencies = Readonly<{
  prepare: typeof prepareProjectAlphaDirectoryReadAdoptionFinalization;
  readProfile: typeof readConfiguredProjectAlphaDirectoryProfile;
  applyLocalProfile: typeof applyProjectAlphaDirectoryReadAdoptionLocalProfile;
  acquire: typeof acquireProjectAlphaExistingDirectoryBinding;
  activate: typeof activateProjectAlphaExistingDirectoryBinding;
  loadFinalizations: typeof loadFinalization;
  loadDecisions: (db: D1Database, receiptId: string) => Promise<Decision[]>;
  loadLocalReceipt: typeof localReceipt;
  selectProfileGrant: typeof selectedProfileGrant;
  readCurrentLocalProfile: typeof currentLocalProfile;
}>;
async function loadDecisions(db: D1Database, receiptId: string): Promise<Decision[]> {
  return (await db.prepare(`SELECT field_name,decision FROM project_alpha_directory_read_adoption_field_decisions
    WHERE receipt_id=? ORDER BY field_name`).bind(receiptId).all<Decision>()).results;
}
const defaults: ProjectAlphaDirectoryReadAdoptionRuntimeDependencies = Object.freeze({
  prepare: prepareProjectAlphaDirectoryReadAdoptionFinalization,
  readProfile: readConfiguredProjectAlphaDirectoryProfile,
  applyLocalProfile: applyProjectAlphaDirectoryReadAdoptionLocalProfile,
  acquire: acquireProjectAlphaExistingDirectoryBinding,
  activate: activateProjectAlphaExistingDirectoryBinding,
  loadFinalizations: loadFinalization,
  loadDecisions,
  loadLocalReceipt: localReceipt,
  selectProfileGrant: selectedProfileGrant,
  readCurrentLocalProfile: currentLocalProfile,
});

/** Staging-only saga over immutable phase receipts. It creates no portal, Delivery, workspace, folder, or public-link authority. */
export async function finalizeProjectAlphaDirectoryReadAdoption(env: RuntimeEnv, inputValue: unknown,
  overrides: Partial<ProjectAlphaDirectoryReadAdoptionRuntimeDependencies> = {}): Promise<ProjectAlphaDirectoryReadAdoptionRuntimeOutcome> {
  if (env.ENVIRONMENT !== "staging" || env.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED !== "true") return { status: "disabled" };
  if (!valid(inputValue)) return { status: "rejected", stage: "prepare", reason: "invalid_input" };
  const input = inputValue, use = { ...defaults, ...overrides };
  const requestHash = await sha({ fieldReviewReceiptId: input.fieldReviewReceiptId, actor: input.actor });
  let rows = await use.loadFinalizations(env.OPS_DB, input.idempotencyKey, input.fieldReviewReceiptId).catch(() => []);
  if (rows.length > 1) return { status: "conflict", stage: "prepare", reason: "review_already_finalized" };
  if (rows.length === 1 && (rows[0]!.idempotency_key !== input.idempotencyKey || rows[0]!.request_sha256 !== requestHash))
    return { status: "conflict", stage: "prepare", reason: "idempotency_key_reused" };
  if (rows.length === 0) {
    const prepared = await use.prepare(env, input);
    if (prepared.status !== "prepared" && prepared.status !== "replayed") {
      if (prepared.status === "disabled") return prepared;
      return { status: prepared.status, stage: "prepare", reason: "reason" in prepared ? prepared.reason : "storage" };
    }
    rows = await use.loadFinalizations(env.OPS_DB, input.idempotencyKey, input.fieldReviewReceiptId).catch(() => []);
  }
  if (rows.length !== 1) return { status: "blocked", stage: "prepare", reason: "storage" };
  const row = rows[0]!;
  if (row.reviewer_staff_id !== input.actor.staffId || row.reviewer_access_subject !== input.actor.accessSubject
    || row.reviewer_admission_version !== input.actor.admissionVersion || row.reviewer_profile_version !== input.actor.profileVersion
    || row.reviewer_grant_generation !== input.actor.grantGeneration)
    return { status: "blocked", stage: "prepare", reason: "authority" };
  const decisions = await use.loadDecisions(env.OPS_DB, row.field_review_receipt_id).catch(() => []);
  if (decisions.some(item => item.decision === "requires_follow_up")) return { status: "blocked", stage: "prepare", reason: "follow_up" };
  const adopted = decisions.filter(item => item.decision === "adopt_project_alpha").map(item => item.field_name).sort();
  if (adopted.length !== row.adopted_field_count) return { status: "blocked", stage: "prepare", reason: "sealed_review" };
  if (adopted.some(field => !SUPPORTED.has(field))) return { status: "blocked", stage: "local_profile", reason: "unsupported_decision" };

  let recordVersion = row.local_record_version;
  let local = await use.loadLocalReceipt(env.OPS_DB, row.finalization_id).catch(() => null);
  if (adopted.length > 0) {
    if (!local) {
      if (env.PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED !== "true") return { status: "disabled" };
      const remote = await use.readProfile(env as Env, row.source_id, row.resource_type, row.project_alpha_public_id);
      if (remote.status !== "observed" || remote.observation.sourceId !== row.source_id
        || remote.observation.sourceInstanceId !== row.source_instance_id || remote.observation.applicationId !== row.application_id
        || remote.observation.historyEpoch !== row.history_epoch_id || remote.observation.resource.type !== row.resource_type
        || remote.observation.resource.id !== row.project_alpha_public_id || remote.observation.resource.revision !== row.project_alpha_revision
        || remote.observation.authorizationGeneration !== row.authorization_generation
        || await sha(remote.observation.profile) !== row.project_alpha_profile_sha256)
        return { status: "blocked", stage: "local_profile", reason: "stale_source" };
      const grantId = await use.selectProfileGrant(env.OPS_DB, row, input.actor).catch(() => null);
      if (!grantId) return { status: "blocked", stage: "local_profile", reason: "authority" };
      const applied = await use.applyLocalProfile(env, { finalizationId: row.finalization_id, idempotencyKey: row.finalization_id,
        expectedRecordVersion: row.local_record_version, expectedLocalProfileSha256: row.local_profile_sha256,
        projectAlphaProfile: remote.observation.profile, actor: { ...input.actor, selectedProfileGrantId: grantId } });
      if (applied.status !== "applied" && applied.status !== "replayed") {
        if (applied.status === "disabled") return applied;
        return { status: applied.status, stage: "local_profile", reason: "reason" in applied ? applied.reason : "storage" };
      }
      recordVersion = applied.recordVersion;
      local = await use.loadLocalReceipt(env.OPS_DB, row.finalization_id).catch(() => null);
      if (!local) return { status: "blocked", stage: "local_profile", reason: "storage" };
    } else {
      let savedFields: unknown;
      try { savedFields = JSON.parse(local.adopted_fields_json); } catch { savedFields = null; }
      if (local.expected_local_profile_sha256 !== row.local_profile_sha256
        || local.project_alpha_profile_sha256 !== row.project_alpha_profile_sha256
        || JSON.stringify(savedFields) !== JSON.stringify(adopted))
        return { status: "conflict", stage: "local_profile", reason: "receipt" };
      const [grantId, currentLocal] = await Promise.all([
        use.selectProfileGrant(env.OPS_DB, row, input.actor, local.result_record_version).catch(() => null),
        use.readCurrentLocalProfile(env.OPS_DB, row.record_id).catch(() => null),
      ]);
      if (grantId !== local.selected_profile_grant_id) return { status: "blocked", stage: "local_profile", reason: "authority" };
      if (!currentLocal || currentLocal.version !== local.result_record_version
        || currentLocal.profileSha256 !== local.result_profile_sha256)
        return { status: "blocked", stage: "local_profile", reason: "stale_local" };
      recordVersion = local.result_record_version;
    }
  } else if (local) return { status: "conflict", stage: "local_profile", reason: "unexpected_receipt" };

  const acquired = await use.acquire(env, { reviewId: row.acquisition_review_id, commandId: row.acquisition_command_id,
    sourceId: row.source_id, recordId: row.record_id, resourceType: row.resource_type,
    projectAlphaPublicId: row.project_alpha_public_id, expectedProjectAlphaRevision: row.project_alpha_revision,
    expectedAuthorizationGeneration: row.authorization_generation, localRecordVersion: recordVersion, reviewer: input.actor });
  if (acquired.status !== "acquired") return { status: acquired.status, stage: "acquire", reason: acquired.reason };
  const activated = await use.activate(env, { reviewItemId: acquired.reviewReceiptId,
    idempotencyKey: row.activation_idempotency_key }, { staffId: input.actor.staffId, accessSubject: input.actor.accessSubject });
  if (activated.status !== "activated") return { status: activated.status, stage: "activate", reason: activated.reason };
  return { status: acquired.replayed && activated.replayed ? "replayed" : "finalized", finalizationId: row.finalization_id,
    activationId: activated.activationId, recordId: activated.recordId, resourceType: activated.resourceType, adoptedFields: adopted };
}
