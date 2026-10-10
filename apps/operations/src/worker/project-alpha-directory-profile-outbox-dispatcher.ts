import {
  isProjectAlphaDirectoryCreateCommand,
  isProjectAlphaDirectoryProfileUpdateCommand,
  sendProjectAlphaDirectoryCreate,
  sendProjectAlphaDirectoryProfileUpdate,
  validatedProjectAlphaDirectoryProfileAcknowledgement,
  type ProjectAlphaDirectoryCreateCommand,
  type ProjectAlphaDirectoryProfileKind,
  type ProjectAlphaDirectoryProfileUpdateCommand,
  type ProjectAlphaDirectoryProfileTransportFailure,
} from "./project-alpha-directory-profile-api-v2";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";
import { advances, PROJECT_ALPHA_PROJECT_MAX_INTEGER } from "./project-alpha-project-transport";
import { directoryMaterializationReadSource } from "./project-alpha-directory-materialization-read-source";
import { validateDirectoryCreateRecoveryReservation } from "./project-alpha-directory-create-generation-recovery";

const LEASE_MS = 5 * 60_000;
const MAX_RETRY_MS = 60 * 60_000;
type Environment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database;
  PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED?: string }>;
type Row = Readonly<Record<string, unknown> & {
  command_id: string; source_id: string; application_id: string; resource_type: ProjectAlphaDirectoryProfileKind;
  external_id: string; command_json: string; destination_base_url: string; expected_source_instance_id: string;
  expected_history_epoch_id: string; state: string; attempts: number; next_attempt_at: number; lease_expires_at: number | null;
  intent_id: string; mutation_id: string; record_id: string; record_version: number; source_instance_uuid: string;
  intent_source_id: string; application_uuid: string; destination_origin: string; external_canonical_id: string; desired_payload_json: string;
  intent_history_epoch_id: string; intent_state: string; materialization_command_json: string; origin_snapshot_json: string;
  disposition_json: string; materialization_history_epoch_id: string; audit_actor_id: string; audit_actor_type: string;
  original_verified_access_subject: string; audit_command_json: string; record_kind: string; current_version: number;
  revision_profile_json: string; root_command_id: string; root_command_json: string; recovery_authorization_id: string | null;
}>;
type Actor = Readonly<{ staffId: string; accessSubject: string; admissionVersion: number; selectedGrantId: string;
  loginEmail: string; profileVersion: number; selectedIdentityGrantId: string }>;
type Grant = Readonly<{ id: string; effect: string; scope_kind: string; business_area_id: string | null; division_id: string | null; resource_id: string | null }>;
type Internal = Readonly<{ operation: "create" | "update"; transport: ProjectAlphaDirectoryCreateCommand | ProjectAlphaDirectoryProfileUpdateCommand;
  publicId: string | null; actor: Actor }>;
type RelationshipDependency = Readonly<{
  evidence_kind: "unlinked" | "parent_intent" | "existing_mapping" | "acquired_mapping";
  organization_record_id: string | null; organization_record_version: number | null;
  parent_external_canonical_id: string | null; resolved_parent_public_id: string | null;
  parent_mapping_command_id: string | null; parent_activation_id: string | null; parent_ack_revision: string | null;
  parent_ack_command_json: string | null; parent_ack_outcome_json: string | null;
}>;

export type ProjectAlphaDirectoryProfileOutboxDispatcherOutcome =
  | Readonly<{ status: "acknowledged"; commandId: string; replayed: boolean; publicId: string; revision: string }>
  | Readonly<{ status: "conflict"; reason: "source" | "command" | "remote"; httpStatus?: number; requestId?: string }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "destination" | "not_due" | "in_progress" }>
  | Readonly<{ status: "uncertain"; reason: string; httpStatus?: number; requestId?: string }>;

function plain(value: unknown): value is Record<string, unknown> {
  try { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  try { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
  catch { return false; }
}
function origin(value: unknown): string | null { try { return typeof value === "string" ? new URL(value).origin : null; } catch { return null; } }
function parse(value: string): Record<string, unknown> | null { try { const result = JSON.parse(value); return plain(result) ? result : null; } catch { return null; } }
function acceptedUpdateRevision(command: unknown, revision: unknown): boolean {
  if (!plain(command) || typeof command.expectedRevision !== "string"
    || typeof revision !== "string") return false;
  const canonical = (value: string): boolean => /^[1-9][0-9]{0,18}$/.test(value)
    && (value.length < PROJECT_ALPHA_PROJECT_MAX_INTEGER.length || value <= PROJECT_ALPHA_PROJECT_MAX_INTEGER);
  return canonical(command.expectedRevision) && canonical(revision) && advances(revision, command.expectedRevision);
}
function actor(value: unknown): Actor | null {
  if (!plain(value) || !exact(value, ["staffId", "accessSubject", "admissionVersion", "selectedGrantId", "loginEmail", "profileVersion", "selectedIdentityGrantId"])
    || typeof value.staffId !== "string" || typeof value.accessSubject !== "string" || typeof value.selectedGrantId !== "string"
    || typeof value.loginEmail !== "string" || typeof value.selectedIdentityGrantId !== "string"
    || !Number.isSafeInteger(value.admissionVersion) || !Number.isSafeInteger(value.profileVersion)) return null;
  return value as Actor;
}
function sameDestination(row: Row, connection: ProjectAlphaApiV2Connection): boolean {
  return row.application_id === connection.expectedApplicationId && row.expected_source_instance_id === connection.expectedSourceInstanceId
    && row.expected_history_epoch_id === connection.expectedHistoryEpoch && origin(row.destination_base_url) === origin(connection.baseUrl);
}
function applies(grant: Grant, recordId: string, scopes: readonly { business_area_id: string; division_id: string | null }[], assigned: boolean): boolean {
  return grant.scope_kind === "global" || (grant.scope_kind === "resource" && grant.resource_id === recordId)
    || (grant.scope_kind === "assigned" && assigned) || (grant.scope_kind === "business_area" && scopes.some(scope => scope.business_area_id === grant.business_area_id))
    || (grant.scope_kind === "division" && scopes.some(scope => scope.division_id === grant.division_id));
}
async function permitted(db: D1Database, row: Row, value: Actor, permission: "directory.profile.edit" | "directory.identity.link", selectedGrantId: string): Promise<boolean> {
  const selected = await db.prepare(`SELECT grant.id,grant.effect,grant.scope_kind,grant.business_area_id,grant.division_id,grant.resource_id
    FROM native_directory_grants grant JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id JOIN staff_users staff ON staff.id=grant.staff_id
    WHERE grant.id=? AND grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1
      AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.login_email=? AND profile.version=? AND staff.status='active' AND staff.access_subject=?`)
    .bind(selectedGrantId, value.staffId, permission, value.accessSubject, value.admissionVersion,
      value.loginEmail, value.profileVersion, value.accessSubject).first<Grant>();
  if (!selected) return false;
  const scopes = (await db.prepare(`SELECT business_area_id,division_id FROM native_directory_resource_scopes
    WHERE record_id=? AND active=1`).bind(row.record_id).all<{ business_area_id: string; division_id: string | null }>()).results;
  const assigned = !!await db.prepare(`SELECT 1 ok FROM native_directory_assignments WHERE record_id=? AND staff_id=? AND active=1`)
    .bind(row.record_id, value.staffId).first("ok");
  if (!applies(selected, row.record_id, scopes, assigned)) return false;
  const denies = (await db.prepare(`SELECT id,effect,scope_kind,business_area_id,division_id,resource_id FROM native_directory_grants
    WHERE staff_id=? AND permission=? AND effect='deny' AND active=1`).bind(value.staffId, permission).all<Grant>()).results;
  return !denies.some(deny => applies(deny, row.record_id, scopes, assigned));
}
async function onboardingEnrollmentPermitted(db: D1Database, row: Row, value: Actor, createAdmissionId: string): Promise<boolean> {
  if (!await db.prepare(`SELECT 1 ok FROM native_directory_create_admissions WHERE id=? AND staff_id=?
    AND bound_access_subject=? AND record_id=? AND record_kind=? AND active=0 AND consumed_mutation_id=?`)
    .bind(createAdmissionId,value.staffId,value.accessSubject,row.record_id,row.record_kind,row.mutation_id).first("ok")) return false;
  const scopes = (await db.prepare(`SELECT business_area_id,division_id FROM native_directory_resource_scopes
    WHERE record_id=? AND active=1`).bind(row.record_id).all<{ business_area_id: string; division_id: string | null }>()).results;
  const assigned = !!await db.prepare(`SELECT 1 ok FROM native_directory_assignments WHERE record_id=? AND staff_id=? AND active=1`)
    .bind(row.record_id, value.staffId).first("ok");
  const grants = (await db.prepare(`SELECT grant.id,grant.effect,grant.scope_kind,grant.business_area_id,grant.division_id,grant.resource_id
    FROM native_directory_grants grant JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id JOIN staff_users staff ON staff.id=grant.staff_id
    WHERE grant.staff_id=? AND grant.permission='directory.enrollment.manage' AND grant.active=1
      AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.login_email=? AND profile.version=? AND staff.status='active' AND staff.access_subject=?`)
    .bind(value.staffId,value.accessSubject,value.admissionVersion,value.loginEmail,value.profileVersion,value.accessSubject).all<Grant>()).results;
  return grants.some(grant => grant.effect === "allow" && applies(grant,row.record_id,scopes,assigned))
    && !grants.some(grant => grant.effect === "deny" && applies(grant,row.record_id,scopes,assigned));
}
type ActiveMapping = Readonly<{ record_id: string; external_id: string; project_alpha_public_id: string;
  mapping_kind: string; provenance_id: string }>;
async function activeMapping(db: D1Database, row: Row): Promise<ActiveMapping | null> {
  const columns = await db.prepare("PRAGMA table_info('project_alpha_active_directory_mappings')").all<{ name: string }>();
  const hasNativeRecordId = columns.results.some(column => column.name === "record_id");
  if (hasNativeRecordId) {
    return db.prepare(`SELECT record_id,external_id,project_alpha_public_id,mapping_kind,provenance_id
      FROM project_alpha_active_directory_mappings
      WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type=? AND external_id=?`)
      .bind(row.source_id, row.expected_source_instance_id, row.application_id, row.expected_history_epoch_id,
        row.resource_type, row.external_id).first<ActiveMapping>();
  }
  // Before the acquired-identity migration, the mapping view has no separate
  // Ops record_id: the legacy contract used external_id for both identities.
  // Keep that exact-ID behavior during the migration window; never infer a
  // differing acquired identity from this older schema.
  const legacy = await db.prepare(`SELECT external_id,project_alpha_public_id,mapping_kind,provenance_id
      FROM project_alpha_active_directory_mappings
      WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type=? AND external_id=?`)
    .bind(row.source_id, row.expected_source_instance_id, row.application_id, row.expected_history_epoch_id,
      row.resource_type, row.external_id).first<Omit<ActiveMapping, "record_id">>();
  return legacy ? { ...legacy, record_id: legacy.external_id } : null;
}
type AcquiredUpdateContext = Readonly<{ record_id: string; external_id: string; source_id: string;
  expected_source_instance_id: string; application_id: string; expected_history_epoch_id: string;
  resource_type: ProjectAlphaDirectoryProfileKind; destination_base_url: string; record_version: number }>;
async function acquiredMappingRevisionMatches(db: D1Database, row: AcquiredUpdateContext, mapping: ActiveMapping, command: Record<string, unknown>): Promise<boolean> {
  const materializationSource = await directoryMaterializationReadSource(db);
  if (mapping.mapping_kind !== "acquired" || mapping.record_id !== row.record_id || mapping.external_id !== row.external_id
    || typeof mapping.provenance_id !== "string" || typeof command.expectedRevision !== "string"
    || typeof command.expectedAuthorizationGeneration !== "string"
    || command.expectedProjectAlphaPublicId !== mapping.project_alpha_public_id) return false;
  type Version = { revision: unknown; authorization_generation: unknown };
  const authoritative = (values: Version[]): Version | null => {
    const bounded=(value:unknown,zero=false):value is string=>typeof value==="string"
      &&(zero?/^(?:0|[1-9][0-9]{0,18})$/:/^[1-9][0-9]{0,18}$/).test(value)
      && (value.length<PROJECT_ALPHA_PROJECT_MAX_INTEGER.length||value<=PROJECT_ALPHA_PROJECT_MAX_INTEGER);
    if (!values.length || values.some(value => !bounded(value.revision) || !bounded(value.authorization_generation,true))) return null;
    const canonicalValues=values as {revision:string;authorization_generation:string}[];
    const maximum=canonicalValues.reduce((left,right)=>left.length>right.revision.length
      ||(left.length===right.revision.length&&left>right.revision)?left:right.revision,canonicalValues[0]!.revision);
    const heads=new Map(canonicalValues.filter(value=>value.revision===maximum)
      .map(value=>[`${value.revision}\0${value.authorization_generation}`,value]));
    return heads.size===1?heads.values().next().value??null:null;
  };
  const delivered = (await db.prepare(`SELECT json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision,
        json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') authorization_generation
      FROM operations_directory_intents intent
      JOIN operations_directory_records record ON record.record_id=intent.record_id
      JOIN ${materializationSource} materialization ON materialization.intent_id=intent.intent_id
        AND materialization.history_epoch_id=intent.expected_history_epoch_id
      JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
        AND outbox.state='acknowledged' AND outbox.command_json=materialization.command_json
        AND outbox.source_id=intent.source_id AND outbox.expected_source_instance_id=intent.source_instance_uuid
        AND outbox.application_id=intent.application_uuid AND outbox.expected_history_epoch_id=intent.expected_history_epoch_id
        AND outbox.destination_base_url=intent.destination_origin AND outbox.resource_type=record.record_kind
        AND outbox.external_id=intent.external_canonical_id
      WHERE intent.record_id=? AND intent.record_version=? AND intent.state='acknowledged'
        AND intent.source_id=? AND intent.source_instance_uuid=? AND intent.application_uuid=?
        AND intent.expected_history_epoch_id=? AND intent.destination_origin=? AND intent.external_canonical_id=?
        AND json_extract(materialization.command_json,'$.operation')='update'
        AND json_extract(materialization.command_json,'$.expectedProjectAlphaPublicId')=?
        AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
        AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid
        AND json_extract(outbox.outcome_json,'$.response.applicationId')=intent.application_uuid
        AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=intent.expected_history_epoch_id
        AND json_extract(outbox.outcome_json,'$.response.result.resource.type')=record.record_kind
        AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=?`)
    .bind(row.record_id,row.record_version-1,row.source_id,row.expected_source_instance_id,row.application_id,
      row.expected_history_epoch_id,row.destination_base_url,row.external_id,mapping.project_alpha_public_id,mapping.project_alpha_public_id)
    .all<Version>()).results;
  const refreshed = (await db.prepare(`SELECT refresh.live_revision revision,refresh.authorization_generation
      FROM project_alpha_existing_directory_binding_revision_refresh_receipts refresh
      JOIN project_alpha_existing_directory_binding_activation_receipts activation ON activation.activation_id=?
      JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=refresh.native_owner_claim_id
        AND claim.receipt_id=activation.acquired_receipt_id AND claim.record_id=refresh.record_id AND claim.source_id=refresh.source_id
        AND claim.source_instance_id=refresh.source_instance_id AND claim.application_id=refresh.application_id
        AND claim.history_epoch_id=refresh.history_epoch_id AND claim.resource_type=refresh.resource_type
        AND claim.external_id=refresh.external_id AND claim.project_alpha_public_id=refresh.project_alpha_public_id
        AND activation.record_id=refresh.record_id AND activation.local_record_version=refresh.local_record_version
        AND activation.source_id=refresh.source_id AND activation.source_instance_id=refresh.source_instance_id
        AND activation.application_id=refresh.application_id AND activation.history_epoch_id=refresh.history_epoch_id
        AND activation.resource_type=refresh.resource_type AND activation.external_id=refresh.external_id
        AND activation.project_alpha_public_id=refresh.project_alpha_public_id
      WHERE refresh.record_id=? AND refresh.local_record_version=? AND refresh.source_id=?
        AND refresh.source_instance_id=? AND refresh.application_id=? AND refresh.history_epoch_id=?
        AND refresh.resource_type=? AND refresh.external_id=? AND refresh.project_alpha_public_id=?
        AND NOT EXISTS(SELECT 1 FROM project_alpha_existing_directory_binding_revision_refresh_commands successor
          WHERE successor.predecessor_refresh_receipt_id=refresh.receipt_id)`)
    .bind(mapping.provenance_id,row.record_id,row.record_version-1,row.source_id,row.expected_source_instance_id,
      row.application_id,row.expected_history_epoch_id,row.resource_type,row.external_id,mapping.project_alpha_public_id).all<Version>()).results;
  const refreshCommands=await db.prepare(`SELECT count(*) count
      FROM project_alpha_existing_directory_binding_revision_refresh_commands command
      JOIN project_alpha_existing_directory_binding_activation_receipts activation ON activation.activation_id=?
      JOIN project_alpha_acquired_native_owner_claims claim ON claim.claim_id=command.native_owner_claim_id
        AND claim.receipt_id=activation.acquired_receipt_id
      WHERE command.record_id=? AND command.expected_local_record_version=? AND command.source_id=?
        AND command.source_instance_id=? AND command.application_id=? AND command.history_epoch_id=?
        AND command.resource_type=? AND command.external_id=? AND command.project_alpha_public_id=?`)
    .bind(mapping.provenance_id,row.record_id,row.record_version-1,row.source_id,row.expected_source_instance_id,
      row.application_id,row.expected_history_epoch_id,row.resource_type,row.external_id,mapping.project_alpha_public_id).first<number>("count");
  if((refreshCommands??0)>0&&refreshed.length!==1)return false;
  const activated = (await db.prepare(`SELECT activation.project_alpha_revision revision,
        activation.result_authorization_generation authorization_generation
      FROM project_alpha_existing_directory_binding_activation_receipts activation
      WHERE activation.activation_id=? AND activation.record_id=? AND activation.local_record_version=?
        AND activation.source_id=? AND activation.source_instance_id=? AND activation.application_id=?
        AND activation.history_epoch_id=? AND activation.resource_type=? AND activation.external_id=?
        AND activation.project_alpha_public_id=?`)
    .bind(mapping.provenance_id, row.record_id, row.record_version - 1,
      row.source_id, row.expected_source_instance_id, row.application_id, row.expected_history_epoch_id,
      row.resource_type, row.external_id, mapping.project_alpha_public_id).all<Version>()).results;
  const selected = authoritative([...activated,...refreshed,...delivered]);
  return selected?.revision === command.expectedRevision
    && selected.authorization_generation === command.expectedAuthorizationGeneration;
}
/** Verifies the prior PA state for one acquired mapping before an update is sent. */
export async function acquiredDirectoryMappingUpdateEvidence(db: D1Database, context: AcquiredUpdateContext,
  expectedRevision: string, expectedAuthorizationGeneration: string, expectedPublicId: string): Promise<boolean> {
  const mappings = (await db.prepare(`SELECT record_id,external_id,project_alpha_public_id,mapping_kind,provenance_id
    FROM project_alpha_active_directory_mappings WHERE source_id=? AND source_instance_id=? AND application_id=?
      AND history_epoch_id=? AND resource_type=? AND external_id=?`)
    .bind(context.source_id, context.expected_source_instance_id, context.application_id,
      context.expected_history_epoch_id, context.resource_type, context.external_id).all<ActiveMapping>()).results;
  if (mappings.length !== 1) return false;
  return acquiredMappingRevisionMatches(db, context, mappings[0]!, { expectedRevision,
    expectedAuthorizationGeneration, expectedProjectAlphaPublicId: expectedPublicId });
}
async function relationshipDependency(db: D1Database, row: Row): Promise<RelationshipDependency | null> {
  const dependencies = (await db.prepare(`SELECT dependency.evidence_kind,dependency.organization_record_id,
      dependency.organization_record_version,dependency.parent_external_canonical_id,resolved.resolved_parent_public_id,
      dependency.parent_mapping_command_id,dependency.parent_activation_id,dependency.parent_ack_revision,
      dependency.parent_ack_command_json,dependency.parent_ack_outcome_json
    FROM operations_directory_intent_relationship_dependencies dependency
    JOIN operations_directory_intent_relationship_resolved resolved ON resolved.intent_id=dependency.intent_id
    WHERE dependency.intent_id=? AND dependency.client_record_id=? AND dependency.client_record_version=?
      AND dependency.source_id=? AND dependency.source_instance_uuid=? AND dependency.application_uuid=?
      AND dependency.history_epoch_id=? AND dependency.destination_origin=?
    LIMIT 2`).bind(row.intent_id, row.record_id, row.record_version, row.source_id, row.expected_source_instance_id,
      row.application_id, row.expected_history_epoch_id, row.destination_base_url).all<RelationshipDependency>()).results;
  if (dependencies.length !== 1) return null;
  const dependency = dependencies[0]!;
  if (dependency.evidence_kind === "unlinked") return dependency.parent_external_canonical_id === null
    && dependency.organization_record_id === null && dependency.organization_record_version === null
    && dependency.resolved_parent_public_id === null && dependency.parent_mapping_command_id === null
    && dependency.parent_activation_id === null && dependency.parent_ack_revision === null
    && dependency.parent_ack_command_json === null && dependency.parent_ack_outcome_json === null ? dependency : null;
  if (typeof dependency.parent_external_canonical_id !== "string" || !dependency.parent_external_canonical_id
    || typeof dependency.organization_record_id !== "string"
    || typeof dependency.organization_record_version !== "number" || !Number.isSafeInteger(dependency.organization_record_version)
    || dependency.organization_record_version < 1 || typeof dependency.resolved_parent_public_id !== "string"
    || !/^[0-9a-f]{32}$/.test(dependency.resolved_parent_public_id)) return null;
  if (dependency.evidence_kind === "parent_intent")
    return dependency.organization_record_id === dependency.parent_external_canonical_id
      && dependency.parent_mapping_command_id === null && dependency.parent_activation_id === null
      && dependency.parent_ack_revision === null && dependency.parent_ack_command_json === null
      && dependency.parent_ack_outcome_json === null ? dependency : null;
  if (dependency.evidence_kind === "existing_mapping") {
    if (dependency.organization_record_id !== dependency.parent_external_canonical_id
      || typeof dependency.parent_mapping_command_id !== "string" || typeof dependency.parent_ack_revision !== "string"
      || !/^[1-9][0-9]{0,18}$/.test(dependency.parent_ack_revision) || dependency.parent_activation_id !== null
      || typeof dependency.parent_ack_command_json !== "string" || typeof dependency.parent_ack_outcome_json !== "string") return null;
    const exact = await db.prepare(`SELECT 1 present
      FROM project_alpha_directory_mappings mapping
      JOIN project_alpha_directory_outbox outbox ON outbox.command_id=mapping.command_id
      WHERE mapping.command_id=? AND mapping.source_id=? AND mapping.source_instance_id=?
        AND mapping.application_id=? AND mapping.history_epoch_id=? AND mapping.resource_type='organization'
        AND mapping.external_id=? AND mapping.project_alpha_public_id=?
        AND outbox.state='acknowledged' AND outbox.command_json IS ? AND outbox.outcome_json IS ?
        AND outbox.source_id=? AND outbox.expected_source_instance_id=? AND outbox.application_id=?
        AND outbox.expected_history_epoch_id=? AND outbox.destination_base_url=?
        AND outbox.resource_type='organization' AND outbox.external_id=?
        AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
        AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=?
        AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=?
        AND json_extract(outbox.outcome_json,'$.response.applicationId')=?
        AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
        AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=?
        AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')=?
        AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=?
        AND ((SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=2
            AND json_type(outbox.outcome_json,'$.response.result.data') IS NULL
            AND json_extract(outbox.command_json,'$.operation')='create'
            AND outbox.resource_type='organization'
          OR (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=3
            AND json_type(outbox.outcome_json,'$.response.result.data')='object'
            AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.data'))=1
            AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=
              json_extract(outbox.outcome_json,'$.response.result.resource.publicId'))`)
      .bind(dependency.parent_mapping_command_id, row.source_id, row.expected_source_instance_id, row.application_id,
        row.expected_history_epoch_id, dependency.parent_external_canonical_id, dependency.resolved_parent_public_id,
        dependency.parent_ack_command_json, dependency.parent_ack_outcome_json, row.source_id, row.expected_source_instance_id,
        row.application_id, row.expected_history_epoch_id, row.destination_base_url, dependency.parent_external_canonical_id,
        row.expected_history_epoch_id, row.expected_source_instance_id, row.application_id, dependency.parent_external_canonical_id,
        dependency.parent_ack_revision, dependency.resolved_parent_public_id).first();
    return exact ? dependency : null;
  }
  if (dependency.evidence_kind !== "acquired_mapping") return null;
  if (typeof dependency.parent_activation_id !== "string" || typeof dependency.parent_ack_revision !== "string"
    || !/^[1-9][0-9]{0,18}$/.test(dependency.parent_ack_revision)) return null;
  const active = await db.prepare(`SELECT 1 present
    FROM project_alpha_active_directory_mappings mapping
    JOIN project_alpha_existing_directory_binding_activation_receipts activation
      ON activation.activation_id=mapping.provenance_id AND mapping.mapping_kind='acquired'
      AND activation.activation_id=? AND activation.record_id=mapping.record_id
      AND activation.source_id=mapping.source_id AND activation.source_instance_id=mapping.source_instance_id
      AND activation.application_id=mapping.application_id AND activation.history_epoch_id=mapping.history_epoch_id
      AND activation.resource_type=mapping.resource_type AND activation.external_id=mapping.external_id
      AND activation.project_alpha_public_id=mapping.project_alpha_public_id
    WHERE mapping.record_id=? AND mapping.resource_type='organization' AND mapping.source_id=?
      AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.external_id=? AND mapping.project_alpha_public_id=?
      AND activation.record_id=? AND activation.source_id=? AND activation.source_instance_id=?
      AND activation.application_id=? AND activation.history_epoch_id=? AND activation.resource_type='organization'
      AND activation.external_id=? AND activation.project_alpha_public_id=? AND activation.project_alpha_revision=?`)
    .bind(dependency.parent_activation_id, dependency.organization_record_id, row.source_id, row.expected_source_instance_id,
      row.application_id, row.expected_history_epoch_id, dependency.parent_external_canonical_id,
      dependency.resolved_parent_public_id, dependency.organization_record_id, row.source_id,
      row.expected_source_instance_id, row.application_id, row.expected_history_epoch_id,
      dependency.parent_external_canonical_id, dependency.resolved_parent_public_id, dependency.parent_ack_revision).first();
  return active ? dependency : null;
}
async function currentParentRevision(db: D1Database, row: Row, dependency: RelationshipDependency): Promise<string | null> {
  const materializationSource = await directoryMaterializationReadSource(db);
  if (dependency.organization_record_id === null || dependency.organization_record_version === null
    || dependency.resolved_parent_public_id === null) return null;
  if (dependency.evidence_kind === "acquired_mapping") {
    const candidates = (await db.prepare(`SELECT revision FROM (
        SELECT activation.project_alpha_revision revision
        FROM project_alpha_existing_directory_binding_activation_receipts activation
        WHERE activation.activation_id=? AND activation.record_id=? AND activation.local_record_version=?
          AND activation.source_id=? AND activation.source_instance_id=? AND activation.application_id=?
          AND activation.history_epoch_id=? AND activation.resource_type='organization'
          AND activation.external_id=? AND activation.project_alpha_public_id=?
        UNION ALL
        SELECT json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision
        FROM operations_directory_intents intent
        JOIN ${materializationSource} materialization ON materialization.intent_id=intent.intent_id
          AND materialization.history_epoch_id=intent.expected_history_epoch_id
        JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
          AND outbox.state='acknowledged' AND outbox.command_json=materialization.command_json
          AND outbox.source_id=intent.source_id AND outbox.expected_source_instance_id=intent.source_instance_uuid
          AND outbox.application_id=intent.application_uuid AND outbox.expected_history_epoch_id=intent.expected_history_epoch_id
          AND outbox.destination_base_url=intent.destination_origin AND outbox.resource_type='organization'
          AND outbox.external_id=intent.external_canonical_id
        JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id
          AND audit.record_id=intent.record_id AND audit.record_version=intent.record_version
          AND audit.actor_type='staff' AND json_extract(audit.command_json,'$.operation')='update'
        WHERE intent.record_id=? AND intent.record_version=? AND intent.state='acknowledged'
          AND intent.source_id=? AND intent.source_instance_uuid=? AND intent.application_uuid=?
          AND intent.expected_history_epoch_id=? AND intent.destination_origin=?
          AND intent.external_canonical_id=? AND json_extract(outbox.command_json,'$.operation')='update'
          AND json_extract(outbox.command_json,'$.resourceType')='organization'
          AND json_extract(outbox.command_json,'$.externalId')=intent.external_canonical_id
          AND json_extract(outbox.command_json,'$.expectedProjectAlphaPublicId')=?
          AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
          AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid
          AND json_extract(outbox.outcome_json,'$.response.applicationId')=intent.application_uuid
          AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=intent.expected_history_epoch_id
          AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
          AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=?
          AND json_extract(outbox.outcome_json,'$.response.result.resource.revision') IS NOT NULL
      ) WHERE revision IS NOT NULL LIMIT 2`).bind(dependency.parent_activation_id, dependency.organization_record_id,
      dependency.organization_record_version, row.source_id, row.expected_source_instance_id, row.application_id,
      row.expected_history_epoch_id, dependency.parent_external_canonical_id, dependency.resolved_parent_public_id,
      dependency.organization_record_id, dependency.organization_record_version, row.source_id,
      row.expected_source_instance_id, row.application_id, row.expected_history_epoch_id,
      row.destination_base_url, dependency.parent_external_canonical_id, dependency.resolved_parent_public_id,
      dependency.resolved_parent_public_id).all<{ revision: string }>()).results;
    return candidates.length === 1 && /^[1-9][0-9]{0,18}$/.test(candidates[0]!.revision) ? candidates[0]!.revision : null;
  }
  const candidates = (await db.prepare(`SELECT DISTINCT revision FROM (
      SELECT json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision
      FROM operations_directory_intents intent
      JOIN ${materializationSource} materialization ON materialization.intent_id=intent.intent_id
        AND materialization.history_epoch_id=intent.expected_history_epoch_id
      JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
        AND outbox.state='acknowledged' AND outbox.source_id=intent.source_id
        AND outbox.expected_source_instance_id=intent.source_instance_uuid AND outbox.application_id=intent.application_uuid
        AND outbox.expected_history_epoch_id=intent.expected_history_epoch_id AND outbox.destination_base_url=intent.destination_origin
        AND outbox.resource_type='organization' AND outbox.external_id=intent.external_canonical_id
      WHERE intent.record_id=? AND intent.record_version=? AND intent.state='acknowledged'
        AND intent.source_id=? AND intent.source_instance_uuid=? AND intent.application_uuid=?
        AND intent.expected_history_epoch_id=? AND intent.destination_origin=? AND intent.external_canonical_id=?
        AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
        AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid
        AND json_extract(outbox.outcome_json,'$.response.applicationId')=intent.application_uuid
        AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=intent.expected_history_epoch_id
        AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
        AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=?
      UNION ALL
      SELECT live_revision revision FROM project_alpha_existing_directory_binding_revision_refresh_receipts
      WHERE record_id=? AND local_record_version=? AND source_id=? AND source_instance_id=? AND application_id=?
        AND history_epoch_id=? AND resource_type='organization' AND external_id=?
        AND project_alpha_public_id=?
      UNION ALL
      SELECT project_alpha_revision revision FROM project_alpha_existing_directory_binding_activation_receipts
      WHERE record_id=? AND local_record_version=? AND source_id=? AND source_instance_id=? AND application_id=?
        AND history_epoch_id=? AND resource_type='organization' AND external_id=?
        AND project_alpha_public_id=?) WHERE revision IS NOT NULL LIMIT 2`).bind(
      dependency.organization_record_id, dependency.organization_record_version, row.source_id, row.expected_source_instance_id,
      row.application_id, row.expected_history_epoch_id, row.destination_base_url, dependency.parent_external_canonical_id,
      dependency.resolved_parent_public_id,
      dependency.organization_record_id, dependency.organization_record_version, row.source_id, row.expected_source_instance_id,
      row.application_id, row.expected_history_epoch_id, dependency.parent_external_canonical_id,
      dependency.resolved_parent_public_id,
      dependency.organization_record_id, dependency.organization_record_version, row.source_id, row.expected_source_instance_id,
      row.application_id, row.expected_history_epoch_id, dependency.parent_external_canonical_id,
      dependency.resolved_parent_public_id).all<{ revision: string }>()).results;
  return candidates.length === 1 && /^[1-9][0-9]{0,18}$/.test(candidates[0]!.revision) ? candidates[0]!.revision : null;
}
async function exactReservation(db: D1Database, row: Row, connection: ProjectAlphaApiV2Connection): Promise<Internal | "destination" | "command" | "authority"> {
  if (!sameDestination(row, connection)) return "destination";
  if (row.intent_state !== "materialized" || row.command_json !== row.materialization_command_json
    || row.external_id !== row.external_canonical_id || row.record_kind !== row.resource_type || row.current_version !== row.record_version
    || row.intent_source_id !== row.source_id || row.source_instance_uuid !== row.expected_source_instance_id
    || row.application_uuid !== row.application_id || row.destination_origin !== row.destination_base_url
    || row.intent_history_epoch_id !== row.expected_history_epoch_id || row.materialization_history_epoch_id !== row.expected_history_epoch_id
    || row.audit_actor_type !== "staff") return "command";
  const command = parse(row.command_json), audit = parse(row.audit_command_json), snapshot = parse(row.origin_snapshot_json), disposition = parse(row.disposition_json);
  if (!command || !audit || !snapshot || !disposition || typeof audit.actor === "undefined") return "command";
  const originalActor = actor(audit.actor); if (!originalActor) return "command";
  const recovery = row.recovery_authorization_id === null ? null : await validateDirectoryCreateRecoveryReservation(db,
    row.command_id, { staffId: originalActor.staffId, accessSubject: originalActor.accessSubject,
      email: originalActor.loginEmail, admissionVersion: originalActor.admissionVersion, profileVersion: originalActor.profileVersion });
  if (row.recovery_authorization_id !== null && (!recovery || recovery.authorizationId !== row.recovery_authorization_id
    || recovery.rootCommandId !== row.root_command_id || recovery.rootCommandJson !== row.root_command_json)) return "authority";
  const rootCommand = recovery ? parse(recovery.rootCommandJson) : command;
  if (!rootCommand) return "command";
  if (row.audit_actor_id !== originalActor.staffId || row.original_verified_access_subject !== originalActor.accessSubject
    || snapshot.actorId !== originalActor.staffId || snapshot.actorSubject !== originalActor.accessSubject
    || snapshot.authorityRevision !== String(row.record_version) || audit.mutationId !== row.mutation_id || audit.recordId !== row.record_id
    || audit.resourceType !== row.record_kind || audit.expectedLocalVersion !== row.record_version - 1
    || JSON.stringify(audit.fields) !== row.revision_profile_json || disposition.sourceId !== row.source_id
    || disposition.sourceInstanceUUID !== row.expected_source_instance_id || disposition.applicationUUID !== row.application_id
    || disposition.historyEpoch !== row.expected_history_epoch_id || disposition.origin !== row.destination_base_url
    || disposition.externalCanonicalId !== row.external_id) return "command";
  if (!Array.isArray(audit.destinations) || !audit.destinations.some(value => plain(value)
    && value.sourceId === row.source_id && value.sourceInstanceUUID === row.expected_source_instance_id
    && value.applicationUUID === row.application_id && value.historyEpoch === row.expected_history_epoch_id
    && value.origin === row.destination_base_url && value.externalCanonicalId === row.external_id
    && value.expectedAuthorizationGeneration === rootCommand.expectedAuthorizationGeneration)) return "command";
  if (!await permitted(db, row, originalActor, "directory.profile.edit", recovery?.profileGrantId ?? originalActor.selectedGrantId)
    || (row.resource_type === "client" && !await permitted(db, row, originalActor, "directory.identity.link", recovery?.identityGrantId ?? originalActor.selectedIdentityGrantId))
    || (audit.operation === "create" && typeof audit.createAdmissionId === "string"
      && audit.createAdmissionId.startsWith("client-onboarding:")
      && !await onboardingEnrollmentPermitted(db,row,originalActor,audit.createAdmissionId))) return "authority";
  const mapping = await activeMapping(db, row);
  if (command.operation === "create") {
    if (row.record_id !== row.external_id || row.record_id !== row.external_canonical_id || mapping
      || disposition.kind !== "authorized_create" || command.commandId !== row.command_id || command.resourceType !== row.resource_type
      || command.externalId !== row.external_id || command.expectedRevision !== "0" || command.fields === undefined) return "command";
    if (row.resource_type === "organization") {
      const transport = { commandId: row.command_id, externalId: row.external_id,
        expectedAuthorizationGeneration: command.expectedAuthorizationGeneration, profile: command.fields };
      return typeof command.expectedAuthorizationGeneration === "string" && isProjectAlphaDirectoryCreateCommand("organization", transport)
        ? { operation: "create", transport, publicId: null, actor: originalActor } : "command";
    }
    if (!plain(command.fields)) return "command";
    const commandFields = command.fields as Record<string, unknown>;
    const dependency = await relationshipDependency(db, row);
    if (!dependency || commandFields.organizationPublicId !== dependency.resolved_parent_public_id) return "command";
    const profile = { ...commandFields }; delete profile.organizationPublicId;
    const parentRevision = dependency.evidence_kind === "unlinked" ? null : await currentParentRevision(db, row, dependency);
    if (dependency.evidence_kind !== "unlinked" && !parentRevision) return "command";
    const transport = { commandId: row.command_id, externalId: row.external_id,
      expectedAuthorizationGeneration: command.expectedAuthorizationGeneration, profile,
      organization: dependency.evidence_kind === "unlinked" ? null
        : { externalId: dependency.parent_external_canonical_id!, expectedRevision: parentRevision! } };
    return typeof command.expectedAuthorizationGeneration === "string" && isProjectAlphaDirectoryCreateCommand("client", transport)
      ? { operation: "create", transport, publicId: null, actor: originalActor } : "command";
  }
  if (command.operation !== "update" || disposition.kind !== "existing" || !mapping || command.commandId !== row.command_id
    || command.resourceType !== row.resource_type || command.externalId !== row.external_id
    || mapping.record_id !== row.record_id || mapping.external_id !== row.external_id
    || (mapping.mapping_kind === "legacy" && row.record_id !== row.external_id)
    || (mapping.mapping_kind !== "legacy" && mapping.mapping_kind !== "acquired")
    || command.expectedProjectAlphaPublicId !== mapping.project_alpha_public_id || disposition.projectAlphaPublicId !== mapping.project_alpha_public_id
    || command.expectedRevision !== disposition.projectAlphaRevision || command.fields === undefined) return "command";
  if (mapping.mapping_kind === "acquired" && !await acquiredMappingRevisionMatches(db, row, mapping, command)) return "command";
  if (!plain(command.fields)) return "command";
  const fields = { ...command.fields };
  if (row.resource_type === "client") {
    if (!Object.hasOwn(fields, "organizationPublicId")) return "command";
    const dependency = await relationshipDependency(db, row);
    if (!dependency || fields.organizationPublicId !== dependency.resolved_parent_public_id) return "command";
    delete fields.organizationPublicId;
  }
  const transport = { commandId: row.command_id, expectedRevision: command.expectedRevision,
    expectedAuthorizationGeneration: command.expectedAuthorizationGeneration, profile: fields };
  return typeof command.expectedRevision === "string" && typeof command.expectedAuthorizationGeneration === "string"
    && isProjectAlphaDirectoryProfileUpdateCommand(row.resource_type, transport)
    ? { operation: "update", transport, publicId: mapping.project_alpha_public_id, actor: originalActor } : "command";
}
async function row(db: D1Database, commandId: string): Promise<Row | null> {
  const materializationSource = await directoryMaterializationReadSource(db);
  const current = await materializationRow(db, commandId, materializationSource, false);
  if (current || materializationSource === "operations_directory_materializations") return current;
  // Recovery changes the effective command, not the immutable outcome of its
  // predecessor. Historical replay may read settled original rows only; it
  // must never make a superseded pending/leased command dispatchable again.
  return materializationRow(db, commandId, "operations_directory_materializations", true);
}
async function materializationRow(db: D1Database, commandId: string,
  materializationSource: Awaited<ReturnType<typeof directoryMaterializationReadSource>>, settledOnly: boolean): Promise<Row | null> {
  const rootColumns = materializationSource === "operations_directory_effective_materializations"
    ? "materialization.root_command_id,materialization.root_command_json,materialization.recovery_authorization_id"
    : "materialization.command_id root_command_id,materialization.command_json root_command_json,NULL recovery_authorization_id";
  return db.prepare(`SELECT outbox.*,intent.intent_id,intent.mutation_id,intent.record_id,intent.record_version,intent.source_id intent_source_id,intent.source_instance_uuid,
      intent.application_uuid,intent.destination_origin,intent.external_canonical_id,intent.desired_payload_json,
      intent.expected_history_epoch_id intent_history_epoch_id,intent.state intent_state,
      materialization.command_json materialization_command_json,materialization.origin_snapshot_json,
      materialization.disposition_json,materialization.history_epoch_id materialization_history_epoch_id,
      audit.actor_id audit_actor_id,audit.actor_type audit_actor_type,audit.original_verified_access_subject,
      audit.command_json audit_command_json,record.record_kind,record.current_version,revision.profile_json revision_profile_json,${rootColumns}
    FROM project_alpha_directory_outbox outbox JOIN ${materializationSource} materialization ON materialization.command_id=outbox.command_id
    JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
    JOIN operations_directory_audit audit ON audit.mutation_id=intent.mutation_id AND audit.record_id=intent.record_id AND audit.record_version=intent.record_version
    JOIN operations_directory_records record ON record.record_id=intent.record_id
    JOIN operations_directory_revisions revision ON revision.record_id=intent.record_id AND revision.version=intent.record_version AND revision.mutation_id=intent.mutation_id
    WHERE outbox.command_id=?${settledOnly ? " AND outbox.state IN ('terminal','acknowledged')" : ""}`).bind(commandId).first<Row>();
}
function replay(value: Row): ProjectAlphaDirectoryProfileOutboxDispatcherOutcome | null {
  if (value.state !== "acknowledged" && value.state !== "terminal") return null;
  const outcome = value.outcome_json && typeof value.outcome_json === "string" ? parse(value.outcome_json) : null;
  if (value.state === "terminal") return { status: "conflict", reason: "remote",
    ...(typeof outcome?.httpStatus === "number" ? { httpStatus: outcome.httpStatus } : {}),
    ...(typeof outcome?.requestId === "string" ? { requestId: outcome.requestId } : {}) };
  const response = outcome && plain(outcome.response) && plain(outcome.response.result) && plain(outcome.response.result.resource)
    ? outcome.response.result.resource : null;
  const command = parse(value.command_json);
  return response && typeof response.publicId === "string" && typeof response.revision === "string"
    && (command?.operation !== "update" || acceptedUpdateRevision(command, response.revision))
    ? { status: "acknowledged", commandId: value.command_id, replayed: true, publicId: response.publicId, revision: response.revision } : { status: "uncertain", reason: "evidence" };
}
async function release(db: D1Database, value: Row, token: string, now: number, reason: string): Promise<void> {
  const delay = Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(12, Math.max(0, value.attempts)));
  await db.prepare(`UPDATE project_alpha_directory_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=?,
    outcome_json=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`)
    .bind(now + delay, value.command_id, token, now).run();
  void reason;
}
function diagnostic(failure: ProjectAlphaDirectoryProfileTransportFailure): { httpStatus?: number; requestId?: string } {
  return { ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}), ...(failure.requestId ? { requestId: failure.requestId } : {}) };
}

/** Dispatches at most one already-materialized writer command. The bounded
 * native Directory scheduler invokes this only through its guarded drain. */
export async function dispatchProjectAlphaDirectoryProfileOutboxCommand(env: Environment, sourceId: string, commandId: string,
  send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryProfileOutboxDispatcherOutcome> {
  const initial = await row(env.OPS_DB, commandId);
  if (!initial) return { status: "blocked", reason: "in_progress" };
  if (initial.source_id !== sourceId) return { status: "conflict", reason: "source" };
  const done = replay(initial); if (done) return done;
  if (initial.recovery_authorization_id !== null && env.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED !== "true")
    return { status: "blocked", reason: "authority" };
  const selected = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, async connection => {
    const checked = await exactReservation(env.OPS_DB, initial, connection);
    if (typeof checked === "string") return { phase: "invalid" as const, reason: checked };
    const now = Date.now();
    if (initial.state === "pending" && initial.next_attempt_at > now) return { phase: "blocked" as const, reason: "not_due" as const };
    if (initial.state === "leased" && (initial.lease_expires_at === null || initial.lease_expires_at > now)) return { phase: "blocked" as const, reason: "in_progress" as const };
    if (initial.state !== "pending" && initial.state !== "leased") return { phase: "blocked" as const, reason: "in_progress" as const };
    const token = crypto.randomUUID();
    const claim = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=attempts+1,lease_token=?,lease_expires_at=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND command_json=? AND
      ((state='pending' AND next_attempt_at<=?) OR (state='leased' AND lease_expires_at<=?))`)
      .bind(token, now + LEASE_MS, initial.command_id, initial.command_json, now, now).run();
    if (claim.meta.changes !== 1) return { phase: "blocked" as const, reason: "in_progress" as const };
    const leased = await row(env.OPS_DB, commandId);
    if (!leased) return { phase: "invalid" as const, reason: "command" as const };
    const current = await exactReservation(env.OPS_DB, leased, connection);
    if (typeof current === "string") {
      await release(env.OPS_DB, leased, token, Date.now(), "pre_send_validation");
      return { phase: "invalid" as const, reason: current };
    }
    const outcome = current.operation === "create"
      ? await sendProjectAlphaDirectoryCreate(connection, leased.resource_type, current.transport as ProjectAlphaDirectoryCreateCommand, send)
      : await sendProjectAlphaDirectoryProfileUpdate(connection, leased.resource_type, current.publicId!, current.transport as ProjectAlphaDirectoryProfileUpdateCommand, send);
    if (outcome.status !== "acknowledged") {
      if (outcome.status === "conflict") {
        const saved = JSON.stringify({ directoryProfileDispatcher: "conflict", reason: outcome.reason, ...diagnostic(outcome) });
        const settled = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_outbox SET state='terminal',outcome_json=?,lease_token=NULL,lease_expires_at=NULL,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`)
          .bind(saved, leased.command_id, token, Date.now()).run();
        return settled.meta.changes === 1 ? { phase: "conflict" as const, details: diagnostic(outcome) } : { phase: "uncertain" as const, reason: "lost_lease" };
      }
      await release(env.OPS_DB, leased, token, Date.now(), outcome.reason);
      const preflight = outcome.reason === "preflight" ? outcome.preflight : undefined;
      return { phase: "uncertain" as const,
        reason: preflight && preflight.status !== "verified" ? `preflight:${preflight.status}:${preflight.reason}` : outcome.reason,
        details: diagnostic(outcome) };
    }
    const evidence = validatedProjectAlphaDirectoryProfileAcknowledgement(outcome);
    if (!evidence || JSON.stringify(evidence.command) !== JSON.stringify(current.transport) || origin(evidence.destinationOrigin) !== origin(leased.destination_base_url)) {
      await release(env.OPS_DB, leased, token, Date.now(), "evidence");
      return { phase: "uncertain" as const, reason: "evidence" };
    }
    const after = await exactReservation(env.OPS_DB, leased, connection);
    if (typeof after === "string") {
      await release(env.OPS_DB, leased, token, Date.now(), "post_send_validation");
      return { phase: "invalid" as const, reason: after };
    }
    const response = evidence.response, resource = response.result.resource;
    if (current.operation === "update" && !acceptedUpdateRevision(evidence.command, resource.revision)) {
      await release(env.OPS_DB, leased, token, Date.now(), "revision");
      return { phase: "uncertain" as const, reason: "evidence" };
    }
    // Relationship evidence predates the profile transport and resolves the
    // canonical ID from result.data.publicId. Preserve the validated wire
    // response while adding that durable compatibility projection locally.
    const persistedResponse = { ...response, result: { ...response.result, data: { publicId: resource.publicId } } };
    const outcomeJson = JSON.stringify({ status: "acknowledged", response: persistedResponse });
    const statements: D1PreparedStatement[] = [];
    if (current.operation === "create") statements.push(env.OPS_DB.prepare(`INSERT INTO project_alpha_directory_mappings(
      source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
      SELECT source_id,resource_type,external_id,?,expected_source_instance_id,application_id,expected_history_epoch_id,command_id
      FROM project_alpha_directory_outbox WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`)
      .bind(resource.publicId, leased.command_id, token, Date.now()));
    statements.push(env.OPS_DB.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='leased' AND lease_token=? AND lease_expires_at>?`)
      .bind(outcomeJson, leased.command_id, token, Date.now()));
    statements.push(env.OPS_DB.prepare(`UPDATE operations_directory_intents SET state='acknowledged' WHERE intent_id=? AND state='materialized'
      AND EXISTS(SELECT 1 FROM project_alpha_directory_outbox WHERE command_id=? AND state='acknowledged' AND outcome_json=?)`)
      .bind(leased.intent_id, leased.command_id, outcomeJson));
    try {
      const settled = await env.OPS_DB.batch(statements);
      if (settled.some(result => result.meta.changes !== 1)) return { phase: "uncertain" as const, reason: "lost_lease" };
    } catch { return { phase: "uncertain" as const, reason: "database" }; }
    return { phase: "acknowledged" as const, publicId: resource.publicId, revision: resource.revision, replayed: response.replayed };
  });
  if (selected.status !== "enabled") return { status: "blocked", reason: "configuration" };
  const result = selected.value;
  if (result.phase === "acknowledged") return { status: "acknowledged", commandId, publicId: result.publicId, revision: result.revision, replayed: result.replayed };
  if (result.phase === "conflict") return { status: "conflict", reason: "remote", ...result.details };
  if (result.phase === "uncertain") return { status: "uncertain", reason: result.reason, ...(result.details ?? {}) };
  if (result.phase === "blocked") return { status: "blocked", reason: result.reason };
  return result.reason === "destination" ? { status: "blocked", reason: "destination" }
    : result.reason === "authority" ? { status: "blocked", reason: "authority" } : { status: "conflict", reason: "command" };
}
