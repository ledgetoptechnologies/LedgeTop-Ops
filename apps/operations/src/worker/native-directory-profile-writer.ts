
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_REVISION = "9223372036854775807";
const MAX_DESTINATIONS = 16;
const MAX_SCOPES = 64;

export type NativeDirectoryProfileKind = "organization" | "client";
export type NativeDirectoryOrganizationProfile = Readonly<{
  name: string; generalEmail: string; generalPhone: string; addressLine1: string; addressLine2: string;
  city: string; state: string; postalCode: string; country: string;
}>;
export type NativeDirectoryClientCreateProfile = Readonly<{
  name: string; email: string; phone: string; clientType: "unknown" | "business" | "consumer";
  addressLine1: string; addressLine2: string; city: string; state: string; postalCode: string; country: string;
}>;
export type NativeDirectoryClientUpdateProfile = Omit<NativeDirectoryClientCreateProfile, "clientType">;
export type NativeDirectoryScope = Readonly<{ businessAreaId: string; divisionId: string | null }>;
export type NativeDirectoryClientRelationship = Readonly<{
  organizationRecordId: string | null; expectedRelationshipVersion: number;
}>;
export type NativeDirectoryDestinationAuthority = Readonly<{
  sourceId: string; sourceInstanceUUID: string; applicationUUID: string; historyEpoch: string;
  /** Trusted service observation; HTTP routes must derive this server-side. */
  origin: string; externalCanonicalId: string; expectedAuthorizationGeneration: string;
}>;
export type NativeDirectoryWriterActor = Readonly<{
  staffId: string; accessSubject: string; admissionVersion: number; selectedGrantId: string;
  loginEmail: string; profileVersion: number; selectedIdentityGrantId: string;
}>;
type CommonWrite = Readonly<{
  mutationId: string; recordId: string; actor: NativeDirectoryWriterActor;
  destinations: readonly NativeDirectoryDestinationAuthority[];
}>;
export type NativeDirectoryCreateWrite = CommonWrite & Readonly<{
  operation: "create"; expectedLocalVersion: 0; kind: "organization"; profile: NativeDirectoryOrganizationProfile;
  scopes: readonly NativeDirectoryScope[]; createAdmissionId: string;
}> | CommonWrite & Readonly<{
  operation: "create"; expectedLocalVersion: 0; kind: "client"; profile: NativeDirectoryClientCreateProfile;
  scopes: readonly NativeDirectoryScope[]; createAdmissionId: string; relationship: NativeDirectoryClientRelationship;
}>;
export type NativeDirectoryUpdateWrite = CommonWrite & Readonly<{
  operation: "update"; expectedLocalVersion: number; kind: "organization"; profile: NativeDirectoryOrganizationProfile;
}> | CommonWrite & Readonly<{
  operation: "update"; expectedLocalVersion: number; kind: "client"; profile: NativeDirectoryClientUpdateProfile;
  relationship: NativeDirectoryClientRelationship;
}>;
export type NativeDirectoryProfileWrite = NativeDirectoryCreateWrite | NativeDirectoryUpdateWrite;
export type NativeDirectoryProfileWriteOutcome =
  | Readonly<{ status: "written"; replayed: boolean; mutationId: string; recordId: string; kind: NativeDirectoryProfileKind; version: number; commandIds: readonly string[] }>
  | Readonly<{ status: "rejected" | "blocked" | "conflict"; reason: string }>;
/**
 * An opaque native Directory plan. Only the approved composer can atomically
 * execute it with another writer plan.
 */
type NativeDirectoryProfileWritePlan = Readonly<{ status: "planned";
  outcome: Extract<NativeDirectoryProfileWriteOutcome, { status: "written" }>; statements: readonly D1PreparedStatement[] }>;
type NativeDirectoryProfileWritePlanningResult = NativeDirectoryProfileWriteOutcome | NativeDirectoryProfileWritePlan;

/** These constants deliberately make the only empty-enrollment write a single staging fixture. */
export const STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID = "6d0da70c-f4f5-4b10-8988-6639b8e01531";
export const STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID = "staging-native-empty-enrollment-organization-v1";
export const STAGING_EMPTY_ENROLLMENT_FIXTURE_PROFILE: NativeDirectoryOrganizationProfile = Object.freeze({
  name: "Staging native empty-enrollment fixture", generalEmail: "", generalPhone: "", addressLine1: "",
  addressLine2: "", city: "", state: "", postalCode: "", country: "",
});
export const STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID = `${STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID}:admission`;

type NormalizedWrite = Readonly<{
  operation: "create" | "update"; mutationId: string; recordId: string; kind: NativeDirectoryProfileKind;
  expectedLocalVersion: number; actor: NativeDirectoryWriterActor; profile: Record<string, string>;
  scopes: readonly NativeDirectoryScope[]; destinations: readonly NativeDirectoryDestinationAuthority[];
  createAdmissionId: string | null; relationship: NativeDirectoryClientRelationship | null;
}>;
type DirectoryWriteD1 = Pick<D1Database, "prepare" | "batch">;
type DestinationIdentity = Omit<NativeDirectoryDestinationAuthority, "expectedAuthorizationGeneration">;
type GrantRow = Readonly<{ id: string; effect: string; scope_kind: string; business_area_id: string | null; division_id: string | null; resource_id: string | null }>;

function plain(value: unknown): value is Record<string, unknown> {
  try { return !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  try { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }
  catch { return false; }
}
function boundedText(value: unknown, maximum: number, nonempty = false): value is string {
  if (typeof value !== "string" || (nonempty && value.length === 0) || Array.from(value).length > maximum || /\p{C}/u.test(value)) return false;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value; }
  catch { return false; }
}
function revision(value: unknown): value is string {
  return typeof value === "string" && REVISION.test(value) && (value.length < MAX_REVISION.length || value <= MAX_REVISION);
}
function externalId(value: unknown): value is string {
  return boundedText(value, 191, true) && new TextEncoder().encode(value).byteLength <= 764;
}
function profile(value: unknown, kind: NativeDirectoryProfileKind, operation: "create" | "update"): value is Record<string, string> {
  const fields = kind === "organization"
    ? ["name", "generalEmail", "generalPhone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"]
    : operation === "create"
      ? ["name", "email", "phone", "clientType", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"]
      : ["name", "email", "phone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"];
  if (!plain(value) || !exact(value, fields)) return false;
  for (const field of fields) {
    const maximum = field === "name" ? 150 : field === "state" ? (kind === "client" ? 2 : 100) : field === "postalCode" ? (kind === "client" ? 20 : 32)
      : field === "clientType" ? 8 : field === "email" || field === "generalEmail" ? 255
        : field === "phone" || field === "generalPhone" ? 50 : field === "city" || field === "country" ? 100 : 255;
    if (!boundedText(value[field], maximum, field === "name")) return false;
  }
  if (kind === "client" && operation === "create" && !["unknown", "business", "consumer"].includes(String(value.clientType))) return false;
  const email = String(kind === "client" ? value.email : value.generalEmail);
  return email === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function canonicalOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const parsed = new URL(value); return parsed.protocol === "https:" && parsed.origin === value; }
  catch { return false; }
}
function destination(value: unknown, recordId: string): value is NativeDirectoryDestinationAuthority {
  return plain(value) && exact(value, ["sourceId", "sourceInstanceUUID", "applicationUUID", "historyEpoch", "origin", "externalCanonicalId", "expectedAuthorizationGeneration"])
    && typeof value.sourceId === "string" && SOURCE_ID.test(value.sourceId) && typeof value.sourceInstanceUUID === "string" && UUID.test(value.sourceInstanceUUID)
    && typeof value.applicationUUID === "string" && UUID.test(value.applicationUUID) && typeof value.historyEpoch === "string" && UUID.test(value.historyEpoch)
    && canonicalOrigin(value.origin) && value.externalCanonicalId === recordId && revision(value.expectedAuthorizationGeneration);
}
function normalize(input: NativeDirectoryProfileWrite, allowEmptyDestinations = false): NormalizedWrite | null {
  const normalizedProfile = plain(input.profile) ? Object.fromEntries(Object.entries(input.profile).map(([field, value]) => {
    const normalized = typeof value === "string" ? value.normalize("NFC").trim() : value;
    return [field, (field === "email" || field === "generalEmail") && typeof normalized === "string" ? normalized.toLowerCase() : normalized];
  })) : null;
  if (!plain(input) || !UUID.test(input.mutationId) || !externalId(input.recordId) || (input.kind !== "organization" && input.kind !== "client")
    || (input.operation !== "create" && input.operation !== "update") || !Number.isSafeInteger(input.expectedLocalVersion)
    || input.expectedLocalVersion < 0 || (input.operation === "create") !== (input.expectedLocalVersion === 0)
    || (input.operation === "create" && !boundedText(input.createAdmissionId, 191, true))
    || !plain(input.actor) || !exact(input.actor, ["staffId", "accessSubject", "admissionVersion", "selectedGrantId", "loginEmail", "profileVersion", "selectedIdentityGrantId"])
    || !boundedText(input.actor.staffId, 191, true) || !boundedText(input.actor.accessSubject, 191, true)
    || !boundedText(input.actor.selectedGrantId, 191, true) || !Number.isSafeInteger(input.actor.admissionVersion) || input.actor.admissionVersion < 1
    || !boundedText(input.actor.loginEmail, 254, true) || input.actor.loginEmail !== input.actor.loginEmail.trim().toLowerCase()
    || !Number.isSafeInteger(input.actor.profileVersion) || input.actor.profileVersion < 1 || !boundedText(input.actor.selectedIdentityGrantId, 191, true)
    || (input.kind === "client" && (!externalId(input.recordId) || !plain(input.relationship)
      || !exact(input.relationship, ["organizationRecordId", "expectedRelationshipVersion"])
      || (input.relationship.organizationRecordId !== null && !externalId(input.relationship.organizationRecordId))
      || !Number.isSafeInteger(input.relationship.expectedRelationshipVersion) || input.relationship.expectedRelationshipVersion < 0
      || (input.operation === "create" ? input.relationship.expectedRelationshipVersion !== 0 : input.relationship.expectedRelationshipVersion < 1)))
    || !profile(normalizedProfile, input.kind, input.operation) || !Array.isArray(input.destinations)
    || input.destinations.length < (allowEmptyDestinations ? 0 : 1) || input.destinations.length > MAX_DESTINATIONS
    || !input.destinations.every(value => destination(value, input.recordId))) return null;
  const scopes = input.operation === "create" ? input.scopes : [];
  if (!Array.isArray(scopes) || scopes.length < (input.operation === "create" ? 1 : 0) || scopes.length > MAX_SCOPES
    || !scopes.every(value => plain(value) && exact(value, ["businessAreaId", "divisionId"])
      && boundedText(value.businessAreaId, 191, true) && (value.divisionId === null || boundedText(value.divisionId, 191, true)))) return null;
  const normalizedScopes = scopes.map(value => ({ businessAreaId: value.businessAreaId, divisionId: value.divisionId }))
    .sort((left, right) => `${left.businessAreaId}\0${left.divisionId ?? ""}`.localeCompare(`${right.businessAreaId}\0${right.divisionId ?? ""}`));
  const normalizedDestinations = input.destinations.map(value => ({ ...value })).sort((left, right) => destinationKey(left).localeCompare(destinationKey(right)));
  if (new Set(normalizedScopes.map(value => `${value.businessAreaId}\0${value.divisionId ?? ""}`)).size !== normalizedScopes.length
    || new Set(normalizedDestinations.map(destinationKey)).size !== normalizedDestinations.length) return null;
  return { operation: input.operation, mutationId: input.mutationId, recordId: input.recordId, kind: input.kind,
    expectedLocalVersion: input.expectedLocalVersion, actor: { ...input.actor }, profile: normalizedProfile, scopes: normalizedScopes,
    destinations: normalizedDestinations, createAdmissionId: input.operation === "create" ? input.createAdmissionId : null,
    relationship: input.kind === "client" ? { ...input.relationship } : null };
}
function destinationKey(value: Pick<NativeDirectoryDestinationAuthority, "sourceId" | "sourceInstanceUUID" | "applicationUUID">): string {
  return `${value.sourceId}\0${value.sourceInstanceUUID}\0${value.applicationUUID}`;
}
function identity(value: NativeDirectoryDestinationAuthority): DestinationIdentity {
  return { sourceId: value.sourceId, sourceInstanceUUID: value.sourceInstanceUUID, applicationUUID: value.applicationUUID,
    historyEpoch: value.historyEpoch, origin: value.origin, externalCanonicalId: value.externalCanonicalId };
}
async function deterministicUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function commandId(mutationId: string, destinationValue: NativeDirectoryDestinationAuthority): Promise<string> {
  return deterministicUuid(`${mutationId}\0${destinationKey(destinationValue)}`);
}
function applies(grant: GrantRow, write: NormalizedWrite, scopes: readonly NativeDirectoryScope[], assigned: boolean): boolean {
  return grant.scope_kind === "global" || (write.operation === "update" && grant.scope_kind === "resource" && grant.resource_id === write.recordId)
    || (write.operation === "update" && grant.scope_kind === "assigned" && assigned)
    || (grant.scope_kind === "business_area" && scopes.some(scope => scope.businessAreaId === grant.business_area_id))
    || (grant.scope_kind === "division" && scopes.some(scope => scope.divisionId === grant.division_id));
}
async function authority(db: DirectoryWriteD1, write: NormalizedWrite, permission = "directory.profile.edit", grantId = write.actor.selectedGrantId): Promise<boolean> {
  const selected = await db.prepare(`SELECT grant.id,grant.effect,grant.scope_kind,grant.business_area_id,grant.division_id,grant.resource_id
    FROM native_directory_grants grant JOIN native_staff_admissions admission ON admission.staff_id=grant.staff_id
    JOIN staff_users actor ON actor.id=grant.staff_id JOIN native_staff_profiles profile ON profile.staff_id=grant.staff_id
    WHERE grant.id=? AND grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1
      AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND actor.status='active' AND actor.access_subject=? AND profile.login_email=? AND profile.version=?`).bind(grantId, write.actor.staffId, permission,
      write.actor.accessSubject, write.actor.admissionVersion, write.actor.accessSubject, write.actor.loginEmail, write.actor.profileVersion).first<GrantRow>();
  if (!selected) return false;
  const scopes = write.operation === "create" ? write.scopes : (await db.prepare(`SELECT business_area_id businessAreaId,division_id divisionId
    FROM native_directory_resource_scopes WHERE record_id=? AND active=1`).bind(write.recordId).all<NativeDirectoryScope>()).results;
  const assigned = write.operation === "update" && !!await db.prepare(`SELECT 1 ok FROM native_directory_assignments WHERE record_id=? AND staff_id=? AND active=1`)
    .bind(write.recordId, write.actor.staffId).first();
  if (!applies(selected, write, scopes, assigned)) return false;
  const denies = (await db.prepare(`SELECT id,effect,scope_kind,business_area_id,division_id,resource_id FROM native_directory_grants
    WHERE staff_id=? AND permission=? AND effect='deny' AND active=1`).bind(write.actor.staffId, permission).all<GrantRow>()).results;
  return !denies.some(deny => applies(deny, write, scopes, assigned));
}
function auditCommand(write: NormalizedWrite): string {
  return JSON.stringify({ operation: write.operation, mutationId: write.mutationId, resourceType: write.kind, recordId: write.recordId,
    expectedLocalVersion: write.expectedLocalVersion, actor: write.actor, fields: write.profile,
    scopes: write.operation === "create" ? write.scopes : null, destinations: write.destinations,
    createAdmissionId: write.createAdmissionId, relationship: write.kind === "client" ? write.relationship : null });
}
type RemoteState = Readonly<{ projectAlphaPublicId: string; revision: string; authorizationGeneration: string }>;
type RelationshipState = Readonly<{
  organizationRecordId: string | null; organizationRecordVersion: number | null;
  relationshipVersion: number; relationshipMutationId: string;
}>;
type RelationshipEvidence = Readonly<{
  evidenceKind: "unlinked" | "parent_intent" | "existing_mapping" | "acquired_mapping";
  parentPublicId: string | null; parentIntentId: string | null; parentMappingCommandId: string | null;
  parentActivationId: string | null; parentAckRevision: string | null; parentAckCommandJson: string | null;
  parentAckOutcomeJson: string | null;
}>;

async function linkedRelationshipEvidence(db: DirectoryWriteD1, relationship: RelationshipState,
  destinationValue: NativeDirectoryDestinationAuthority): Promise<RelationshipEvidence | null> {
  if (relationship.organizationRecordId === null || relationship.organizationRecordVersion === null) return {
    evidenceKind: "unlinked", parentPublicId: null, parentIntentId: null, parentMappingCommandId: null,
    parentActivationId: null, parentAckRevision: null, parentAckCommandJson: null, parentAckOutcomeJson: null,
  };
  const parentId = relationship.organizationRecordId, parentVersion = relationship.organizationRecordVersion;
  const activeRows = (await db.prepare(`SELECT mapping.project_alpha_public_id parentPublicId,mapping.mapping_kind mappingKind,
      mapping.provenance_id provenanceId
    FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records parent ON parent.record_id=mapping.external_id AND parent.record_kind='organization'
      AND parent.current_version=?
    JOIN operations_directory_revisions revision ON revision.record_id=parent.record_id AND revision.version=parent.current_version
    JOIN native_directory_enrollments enrollment ON enrollment.record_id=parent.record_id
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.resource_type='organization' AND mapping.external_id=?
      AND EXISTS(SELECT 1 FROM json_each(enrollment.destinations_json) enrolled
        WHERE json_extract(enrolled.value,'$.sourceId')=mapping.source_id
          AND json_extract(enrolled.value,'$.sourceInstanceUUID')=mapping.source_instance_id
          AND json_extract(enrolled.value,'$.applicationUUID')=mapping.application_id
          AND json_extract(enrolled.value,'$.historyEpoch')=mapping.history_epoch_id
          AND json_extract(enrolled.value,'$.origin')=?
          AND json_extract(enrolled.value,'$.externalCanonicalId')=mapping.external_id)
    LIMIT 2`).bind(parentVersion, destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, parentId, destinationValue.origin)
    .all<{ parentPublicId: string; mappingKind: string; provenanceId: string }>()).results;
  if (activeRows.length !== 1 || !/^[0-9a-f]{32}$/.test(activeRows[0]!.parentPublicId)) return null;
  const active = activeRows[0]!;
  if (active.mappingKind === "acquired") {
    const activation = await db.prepare(`SELECT activation_id parentActivationId,project_alpha_revision parentAckRevision
      FROM project_alpha_existing_directory_binding_activation_receipts
      WHERE activation_id=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
        AND resource_type='organization' AND external_id=? AND project_alpha_public_id=?`)
      .bind(active.provenanceId, destinationValue.sourceId, destinationValue.sourceInstanceUUID,
        destinationValue.applicationUUID, destinationValue.historyEpoch, parentId, active.parentPublicId)
      .first<{ parentActivationId: string; parentAckRevision: string }>();
    return activation && revision(activation.parentAckRevision) ? {
      evidenceKind: "acquired_mapping", parentPublicId: active.parentPublicId, parentIntentId: null,
      parentMappingCommandId: null, parentActivationId: activation.parentActivationId,
      parentAckRevision: activation.parentAckRevision, parentAckCommandJson: null, parentAckOutcomeJson: null,
    } : null;
  }
  if (active.mappingKind !== "legacy") return null;
  const parentIntents = (await db.prepare(`SELECT intent.intent_id parentIntentId,mapping.project_alpha_public_id parentPublicId
    FROM operations_directory_intents intent
    JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
      AND materialization.history_epoch_id=intent.expected_history_epoch_id
    JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
      AND outbox.state='acknowledged' AND outbox.source_id=intent.source_id
      AND outbox.expected_source_instance_id=intent.source_instance_uuid AND outbox.application_id=intent.application_uuid
      AND outbox.expected_history_epoch_id=intent.expected_history_epoch_id AND outbox.destination_base_url=intent.destination_origin
      AND outbox.resource_type='organization' AND outbox.external_id=intent.external_canonical_id
    JOIN project_alpha_directory_mappings mapping ON mapping.source_id=intent.source_id
      AND mapping.source_instance_id=intent.source_instance_uuid AND mapping.application_id=intent.application_uuid
      AND mapping.history_epoch_id=intent.expected_history_epoch_id AND mapping.resource_type='organization'
      AND mapping.external_id=intent.external_canonical_id
      AND mapping.project_alpha_public_id=json_extract(outbox.outcome_json,'$.response.result.data.publicId')
    WHERE intent.record_id=? AND intent.record_version=? AND intent.state='acknowledged'
      AND intent.source_id=? AND intent.source_instance_uuid=? AND intent.application_uuid=?
      AND intent.expected_history_epoch_id=? AND intent.destination_origin=? AND intent.external_canonical_id=?
      AND mapping.project_alpha_public_id=?
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=intent.expected_history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=intent.application_uuid
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=intent.external_canonical_id
    LIMIT 2`).bind(parentId, parentVersion, destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, destinationValue.origin, parentId, active.parentPublicId)
    .all<{ parentIntentId: string; parentPublicId: string }>()).results;
  if (parentIntents.length === 1) return {
    evidenceKind: "parent_intent", parentPublicId: parentIntents[0]!.parentPublicId,
    parentIntentId: parentIntents[0]!.parentIntentId, parentMappingCommandId: null, parentActivationId: null,
    parentAckRevision: null, parentAckCommandJson: null, parentAckOutcomeJson: null,
  };
  if (parentIntents.length > 1) return null;
  const legacy = await db.prepare(`SELECT mapping.command_id parentMappingCommandId,mapping.project_alpha_public_id parentPublicId,
      json_extract(outbox.outcome_json,'$.response.result.resource.revision') parentAckRevision,
      outbox.command_json parentAckCommandJson,outbox.outcome_json parentAckOutcomeJson
    FROM project_alpha_directory_mappings mapping JOIN project_alpha_directory_outbox outbox ON outbox.command_id=mapping.command_id
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.resource_type='organization' AND mapping.external_id=? AND mapping.project_alpha_public_id=?
      AND outbox.state='acknowledged' AND outbox.source_id=mapping.source_id
      AND outbox.expected_source_instance_id=mapping.source_instance_id AND outbox.application_id=mapping.application_id
      AND outbox.expected_history_epoch_id=mapping.history_epoch_id AND outbox.destination_base_url=?
      AND outbox.resource_type='organization' AND outbox.external_id=mapping.external_id
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=mapping.history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=mapping.source_instance_id
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=mapping.application_id
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=mapping.external_id
      AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=mapping.project_alpha_public_id`)
    .bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID, destinationValue.applicationUUID,
      destinationValue.historyEpoch, parentId, active.parentPublicId, destinationValue.origin)
    .first<{ parentMappingCommandId: string; parentPublicId: string; parentAckRevision: string;
      parentAckCommandJson: string; parentAckOutcomeJson: string }>();
  return legacy && revision(legacy.parentAckRevision) ? {
    evidenceKind: "existing_mapping", parentPublicId: legacy.parentPublicId, parentIntentId: null,
    parentMappingCommandId: legacy.parentMappingCommandId, parentActivationId: null,
    parentAckRevision: legacy.parentAckRevision, parentAckCommandJson: legacy.parentAckCommandJson,
    parentAckOutcomeJson: legacy.parentAckOutcomeJson,
  } : null;
}
async function updateRemoteState(db: DirectoryWriteD1, write: NormalizedWrite, destinationValue: NativeDirectoryDestinationAuthority): Promise<RemoteState | null> {
  const pending = await db.prepare(`SELECT 1 present FROM project_alpha_directory_outbox WHERE source_id=? AND expected_source_instance_id=?
    AND application_id=? AND expected_history_epoch_id=? AND resource_type=? AND external_id=? AND state<>'acknowledged' LIMIT 1`)
    .bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID, destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, write.recordId).first();
  if (pending) return null;
  const active = await db.prepare(`SELECT project_alpha_public_id projectAlphaPublicId,mapping_kind mappingKind,provenance_id provenanceId
    FROM project_alpha_active_directory_mappings WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      AND resource_type=? AND external_id=?`).bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, write.recordId).first<Record<string, unknown>>();
  if (!active || typeof active.projectAlphaPublicId !== "string" || !/^[0-9a-f]{32}$/.test(active.projectAlphaPublicId)) return null;
  if (active.mappingKind === "acquired") {
    // An acquired mapping is never copied into the legacy mapping table. After
    // its first native profile update, the exact acknowledged writer intent is
    // the newest revision/generation proof for the next update.
    const delivered = await db.prepare(`SELECT
        json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision,
        json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') authorizationGeneration
      FROM operations_directory_intents intent
      JOIN operations_directory_materializations materialization ON materialization.intent_id=intent.intent_id
      JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
      WHERE intent.record_id=? AND intent.record_version=? AND intent.state='acknowledged'
        AND intent.source_id=? AND intent.source_instance_uuid=? AND intent.application_uuid=?
        AND intent.expected_history_epoch_id=? AND intent.destination_origin=? AND intent.external_canonical_id=?
        AND outbox.state='acknowledged' AND outbox.source_id=intent.source_id
        AND outbox.expected_source_instance_id=intent.source_instance_uuid AND outbox.application_id=intent.application_uuid
        AND outbox.expected_history_epoch_id=intent.expected_history_epoch_id AND outbox.destination_base_url=intent.destination_origin
        AND outbox.resource_type=? AND outbox.external_id=intent.external_canonical_id
        AND json_extract(outbox.command_json,'$.operation')='update'
        AND json_extract(outbox.command_json,'$.expectedProjectAlphaPublicId')=?
        AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
        AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid
        AND json_extract(outbox.outcome_json,'$.response.applicationId')=intent.application_uuid
        AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=intent.expected_history_epoch_id
        AND json_extract(outbox.outcome_json,'$.response.result.resource.type')=?
        AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=?
      ORDER BY outbox.created_at DESC,outbox.command_id DESC LIMIT 1`).bind(write.recordId, write.expectedLocalVersion,
        destinationValue.sourceId, destinationValue.sourceInstanceUUID, destinationValue.applicationUUID, destinationValue.historyEpoch,
        destinationValue.origin, write.recordId, write.kind, active.projectAlphaPublicId, write.kind, active.projectAlphaPublicId)
      .first<Record<string, unknown>>();
    if (delivered) return revision(delivered.revision) && revision(delivered.authorizationGeneration)
      && delivered.authorizationGeneration === destinationValue.expectedAuthorizationGeneration
      ? { projectAlphaPublicId: active.projectAlphaPublicId, revision: delivered.revision, authorizationGeneration: delivered.authorizationGeneration } : null;
    const refreshed = await db.prepare(`SELECT live_revision revision,authorization_generation authorizationGeneration
      FROM project_alpha_existing_directory_binding_revision_refresh_receipts WHERE record_id=? AND source_id=?
        AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type=? AND external_id=?
        AND project_alpha_public_id=? AND local_record_version=? ORDER BY received_at DESC,receipt_id DESC LIMIT 1`).bind(write.recordId, destinationValue.sourceId,
        destinationValue.sourceInstanceUUID, destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, write.recordId,
        active.projectAlphaPublicId, write.expectedLocalVersion).first<Record<string, unknown>>();
    if (refreshed) return revision(refreshed.revision) && refreshed.authorizationGeneration === destinationValue.expectedAuthorizationGeneration
      ? { projectAlphaPublicId: active.projectAlphaPublicId, revision: refreshed.revision, authorizationGeneration: destinationValue.expectedAuthorizationGeneration } : null;
    const activated = await db.prepare(`SELECT project_alpha_revision revision FROM project_alpha_existing_directory_binding_activation_receipts
      WHERE activation_id=? AND record_id=? AND local_record_version=?`).bind(active.provenanceId, write.recordId, write.expectedLocalVersion)
      .first<Record<string, unknown>>();
    return activated && revision(activated.revision)
      ? { projectAlphaPublicId: active.projectAlphaPublicId, revision: activated.revision, authorizationGeneration: destinationValue.expectedAuthorizationGeneration } : null;
  }
  const row = await db.prepare(`SELECT mapping.project_alpha_public_id projectAlphaPublicId,
      json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision,
      json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') authorizationGeneration
    FROM project_alpha_directory_mappings mapping JOIN project_alpha_directory_outbox outbox
      ON outbox.source_id=mapping.source_id AND outbox.expected_source_instance_id=mapping.source_instance_id
      AND outbox.application_id=mapping.application_id AND outbox.expected_history_epoch_id=mapping.history_epoch_id
      AND outbox.resource_type=mapping.resource_type AND outbox.external_id=mapping.external_id
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.resource_type=? AND mapping.external_id=? AND outbox.state='acknowledged'
    ORDER BY outbox.created_at DESC,outbox.command_id DESC LIMIT 1`).bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, write.recordId).first<Record<string, unknown>>();
  if (row && row.projectAlphaPublicId === active.projectAlphaPublicId
    && revision(row.revision) && revision(row.authorizationGeneration) && row.authorizationGeneration === destinationValue.expectedAuthorizationGeneration
    ) return { projectAlphaPublicId: row.projectAlphaPublicId, revision: row.revision, authorizationGeneration: row.authorizationGeneration };
  if (write.kind !== "client") return null;
  const relationship = await db.prepare(`SELECT
      json_extract(outbox.outcome_json,'$.response.result.client.publicId') projectAlphaPublicId,
      json_extract(outbox.outcome_json,'$.response.result.client.revision') revision,
      json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') authorizationGeneration
    FROM project_alpha_directory_relationship_outbox outbox
    JOIN operations_directory_client_organization_history history ON history.client_record_id=outbox.client_record_id
      AND history.relationship_version=outbox.relationship_version
    WHERE outbox.client_record_id=? AND history.client_record_version=? AND outbox.source_id=?
      AND outbox.source_instance_id=? AND outbox.application_id=? AND outbox.history_epoch_id=?
      AND outbox.destination_origin=? AND outbox.state='acknowledged'
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=outbox.source_instance_id
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=outbox.application_id
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=outbox.history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.result.action')=outbox.action
      AND json_extract(outbox.outcome_json,'$.response.result.client.publicId')=outbox.client_public_id
      AND json_extract(outbox.outcome_json,'$.response.result.organizationPublicId') IS outbox.organization_public_id
    ORDER BY length(json_extract(outbox.outcome_json,'$.response.result.client.revision')) DESC,
      json_extract(outbox.outcome_json,'$.response.result.client.revision') DESC LIMIT 1`)
    .bind(write.recordId,write.expectedLocalVersion,destinationValue.sourceId,destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID,destinationValue.historyEpoch,destinationValue.origin).first<Record<string, unknown>>();
  return relationship && relationship.projectAlphaPublicId === active.projectAlphaPublicId
    && revision(relationship.revision) && revision(relationship.authorizationGeneration)
    && relationship.authorizationGeneration === destinationValue.expectedAuthorizationGeneration
    ? { projectAlphaPublicId: relationship.projectAlphaPublicId, revision: relationship.revision,
      authorizationGeneration: relationship.authorizationGeneration } : null;
}

/**
 * Persists a canonical native Directory profile mutation and reserves its PA
 * outbox work. It performs no HTTP work. Every client write carries an exact
 * relationship assertion and pins each intent to unlinked, parent-intent,
 * legacy-mapping, or acquired-mapping evidence. Relationship fields remain
 * transport-only and never enter the canonical profile revision.
 */
async function planNativeDirectoryProfileWriteInternal(db: DirectoryWriteD1, input: NativeDirectoryProfileWrite,
  allowEmptyDestinations = false): Promise<NativeDirectoryProfileWritePlanningResult> {
  const write = normalize(input, allowEmptyDestinations); if (!write) return { status: "rejected", reason: "invalid_write" };
  const auditJson = auditCommand(write);
  const replay = await db.prepare(`SELECT audit.command_json,audit.actor_id,audit.original_verified_access_subject,revision.record_id,
      revision.version,record.record_kind FROM operations_directory_audit audit
    JOIN operations_directory_revisions revision ON revision.mutation_id=audit.mutation_id
    JOIN operations_directory_records record ON record.record_id=revision.record_id WHERE audit.mutation_id=?`).bind(write.mutationId)
    .first<Record<string, unknown>>();
  if (replay) {
    if (replay.command_json !== auditJson || replay.actor_id !== write.actor.staffId || replay.original_verified_access_subject !== write.actor.accessSubject
      || replay.record_id !== write.recordId || replay.record_kind !== write.kind || typeof replay.version !== "number")
      return { status: "conflict", reason: "idempotency_body_conflict" };
    const ids = await Promise.all(write.destinations.map(value => commandId(write.mutationId, value)));
    return { status: "written", replayed: true, mutationId: write.mutationId, recordId: write.recordId, kind: write.kind, version: replay.version, commandIds: ids };
  }
  const record = await db.prepare(`SELECT record_kind,current_version FROM operations_directory_records WHERE record_id=?`).bind(write.recordId).first<{ record_kind: string; current_version: number }>();
  if (write.operation === "create" ? !!record : !record || record.record_kind !== write.kind || record.current_version !== write.expectedLocalVersion)
    return { status: "conflict", reason: write.operation === "create" ? "record_exists" : "stale_local_version" };
  if (!await authority(db, write)) return { status: "blocked", reason: "native_directory_authority" };
  const scopesJson = JSON.stringify(write.scopes), profileJson = JSON.stringify(write.profile);
  if (write.operation === "create" && !await db.prepare(`SELECT 1 ok FROM native_directory_create_admissions
    WHERE id=? AND staff_id=? AND bound_access_subject=? AND record_id=? AND record_kind=? AND active=1
      AND consumed_mutation_id IS NULL AND consumed_at IS NULL AND json(scopes_json)=json(?)
      AND json(profile_json)=json(?) AND json(destinations_json)=json(?)
      AND (?<>'client' OR EXISTS(SELECT 1 FROM native_directory_create_admission_relationships relationship
        WHERE relationship.create_admission_id=? AND relationship.client_record_id=?
          AND relationship.organization_record_id IS ?
          AND (relationship.organization_record_id IS NULL OR EXISTS(
            SELECT 1 FROM operations_directory_records organization
            WHERE organization.record_id=relationship.organization_record_id AND organization.record_kind='organization'
              AND organization.current_version=relationship.organization_record_version))))`).bind(write.createAdmissionId,
      write.actor.staffId, write.actor.accessSubject, write.recordId, write.kind, scopesJson, profileJson,
      JSON.stringify(write.destinations.map(identity)), write.kind, write.createAdmissionId, write.recordId,
      write.relationship?.organizationRecordId ?? null).first("ok"))
    return { status: "blocked", reason: "create_admission" };
  let relationshipState: RelationshipState | null = null;
  if (write.kind === "client") {
    if (!await authority(db, write, "directory.identity.link", write.actor.selectedIdentityGrantId))
      return { status: "blocked", reason: "native_directory_identity_authority" };
    if (write.operation === "create") {
      const organizationRecordId = write.relationship!.organizationRecordId;
      let organizationRecordVersion: number | null = null;
      if (organizationRecordId !== null) {
        const parent = await db.prepare(`SELECT record.current_version version FROM operations_directory_records record
          JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
          JOIN native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
          WHERE record.record_id=? AND record.record_kind='organization'`).bind(organizationRecordId).first<{ version: number }>();
        if (!parent || !Number.isSafeInteger(parent.version) || parent.version < 1)
          return { status: "blocked", reason: "client_relationship_parent_state" };
        organizationRecordVersion = parent.version;
      }
      relationshipState = { organizationRecordId, organizationRecordVersion, relationshipVersion: 1,
        relationshipMutationId: await deterministicUuid(`${write.mutationId}\0client-relationship\0${organizationRecordId ?? "unlinked"}`) };
    } else {
      const relationship = await db.prepare(`SELECT relation.organization_record_id,relation.relationship_version,history.mutation_id,
          parent.current_version organization_record_version
        FROM operations_directory_client_organizations relation JOIN operations_directory_client_organization_history history
          ON history.client_record_id=relation.client_record_id AND history.relationship_version=relation.relationship_version
        LEFT JOIN operations_directory_records parent ON parent.record_id=relation.organization_record_id AND parent.record_kind='organization'
        LEFT JOIN operations_directory_revisions parent_revision ON parent_revision.record_id=parent.record_id AND parent_revision.version=parent.current_version
        LEFT JOIN native_directory_enrollments parent_enrollment ON parent_enrollment.record_id=parent.record_id
        WHERE relation.client_record_id=?`).bind(write.recordId)
        .first<{ organization_record_id: string | null; relationship_version: number; mutation_id: string; organization_record_version: number | null }>();
      if (!relationship) return { status: "blocked", reason: "client_relationship_missing" };
      if (relationship.organization_record_id !== write.relationship!.organizationRecordId
        || relationship.relationship_version !== write.relationship!.expectedRelationshipVersion
        || (relationship.organization_record_id !== null && (!Number.isSafeInteger(relationship.organization_record_version)
          || relationship.organization_record_version === null || relationship.organization_record_version < 1)))
        return { status: "blocked", reason: "client_relationship_mismatch" };
      relationshipState = { organizationRecordId: relationship.organization_record_id,
        organizationRecordVersion: relationship.organization_record_version,
        relationshipVersion: relationship.relationship_version, relationshipMutationId: relationship.mutation_id };
    }
  }
  let enrolled: readonly DestinationIdentity[] = write.destinations.map(identity);
  const remote = new Map<string, RemoteState>();
  if (write.operation === "update") {
    const enrollment = await db.prepare(`SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?`).bind(write.recordId).first<{ destinations_json: string }>();
    try { enrolled = enrollment ? JSON.parse(enrollment.destinations_json) as DestinationIdentity[] : []; } catch { enrolled = []; }
    const requested = write.destinations.map(identity);
    if (JSON.stringify(enrolled) !== JSON.stringify(requested)) return { status: "blocked", reason: "enrollment_drift" };
    for (const value of write.destinations) { const state = await updateRemoteState(db, write, value); if (!state) return { status: "blocked", reason: "mapping_or_delivery_state" }; remote.set(destinationKey(value), state); }
  }
  const relationshipEvidence = new Map<string, RelationshipEvidence>();
  if (relationshipState) {
    for (const value of write.destinations) {
      const evidence = await linkedRelationshipEvidence(db, relationshipState, value);
      if (!evidence) return { status: "blocked", reason: "client_relationship_evidence" };
      relationshipEvidence.set(destinationKey(value), evidence);
    }
  }
  const nextVersion = write.expectedLocalVersion + 1, destinationsJson = JSON.stringify(enrolled);
  const commandIds = await Promise.all(write.destinations.map(value => commandId(write.mutationId, value)));
  const statements: D1PreparedStatement[] = [];
  statements.push(db.prepare(`INSERT INTO operations_directory_write_fences
    (mutation_id,operation_kind,actor_id,bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,
      create_admission_id,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes)
    VALUES(?,?,?,?,?,'directory.profile.edit',?,?,?,?,?,?,?,?,?,?)`).bind(write.mutationId, write.operation, write.actor.staffId,
      write.actor.accessSubject, write.actor.admissionVersion, write.recordId, write.kind, write.expectedLocalVersion,
      write.createAdmissionId, write.actor.selectedGrantId, scopesJson, profileJson, auditJson, destinationsJson, write.destinations.length));
  statements.push(write.operation === "create"
    ? db.prepare(`INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,?,1)`).bind(write.recordId, write.kind)
    : db.prepare(`UPDATE operations_directory_records SET current_version=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE record_id=? AND current_version=?`)
      .bind(nextVersion, write.recordId, write.expectedLocalVersion));
  statements.push(db.prepare(`INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,?,?,?)`).bind(write.recordId, nextVersion, write.mutationId, profileJson));
  statements.push(db.prepare(`INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json,original_verified_access_subject)
    VALUES(?,?,?,?, 'staff',?,?,?)`).bind(`${write.mutationId}:audit`, write.mutationId, write.recordId, nextVersion, write.actor.staffId, auditJson, write.actor.accessSubject));
  const materializations: D1PreparedStatement[] = [];
  write.destinations.forEach((value, index) => {
    const intentId = `${write.mutationId}:intent:${index}`, state = remote.get(destinationKey(value));
    const evidence = relationshipEvidence.get(destinationKey(value));
    const fields = write.kind === "client" ? { ...write.profile, organizationPublicId: evidence?.parentPublicId ?? null } : write.profile;
    const materialized = write.operation === "create"
      ? { operation: "create", commandId: commandIds[index], resourceType: write.kind, externalId: write.recordId, expectedRevision: "0",
          expectedAuthorizationGeneration: value.expectedAuthorizationGeneration, fields, scopes: write.scopes }
      : { operation: "update", commandId: commandIds[index], resourceType: write.kind, externalId: write.recordId,
          expectedProjectAlphaPublicId: state!.projectAlphaPublicId, expectedRevision: state!.revision,
          expectedAuthorizationGeneration: state!.authorizationGeneration, fields };
    const disposition = { kind: write.operation === "create" ? "authorized_create" : "existing", ...identity(value),
      ...(state ? { projectAlphaPublicId: state.projectAlphaPublicId, projectAlphaRevision: state.revision } : {}) };
    statements.push(db.prepare(`INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,
      application_uuid,destination_origin,external_canonical_id,desired_payload_json,expected_history_epoch_id,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'waiting')`).bind(intentId, write.mutationId, write.recordId, nextVersion, value.sourceId,
      value.sourceInstanceUUID, value.applicationUUID, value.origin, value.externalCanonicalId, profileJson, value.historyEpoch));
    materializations.push(db.prepare(`UPDATE operations_directory_intents SET state='ready' WHERE intent_id=? AND state='waiting'`).bind(intentId));
    materializations.push(db.prepare(`INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,disposition_json,next_attempt_at,history_epoch_id)
      VALUES(?,?,?,?,?,?,?)`).bind(intentId, commandIds[index], JSON.stringify(materialized),
      JSON.stringify({ actorId: write.actor.staffId, authorityRevision: String(nextVersion), actorSubject: write.actor.accessSubject }),
      JSON.stringify(disposition), Date.now(), value.historyEpoch));
  });
  if (write.kind === "client") {
    if (write.operation === "create") {
      const verifiedUntil = new Date(Date.now() + 60_000).toISOString();
      statements.push(db.prepare(`INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,
        expected_relationship_version,previous_organization_record_id,organization_record_id,client_record_version,
        previous_organization_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,
        actor_admission_version,actor_profile_version,verified_until) VALUES(?,?,0,NULL,?,1,NULL,?,?,?,?,?,?,?)`)
        .bind(relationshipState!.relationshipMutationId, write.recordId, relationshipState!.organizationRecordId,
          relationshipState!.organizationRecordVersion, write.actor.staffId, write.actor.accessSubject, write.actor.loginEmail,
          write.actor.admissionVersion, write.actor.profileVersion, verifiedUntil));
      statements.push(db.prepare(`INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version)
        VALUES(?,?,1)`).bind(write.recordId, relationshipState!.organizationRecordId));
      statements.push(db.prepare(`DELETE FROM operations_directory_relationship_write_fences WHERE mutation_id=?`).bind(relationshipState!.relationshipMutationId));
    }
    write.destinations.forEach((value, index) => {
      const evidence = relationshipEvidence.get(destinationKey(value))!;
      statements.push(db.prepare(`INSERT INTO operations_directory_intent_relationship_dependencies(
        intent_id,client_record_id,client_record_version,relationship_version,relationship_mutation_id,organization_record_id,
        organization_record_version,source_id,source_instance_uuid,application_uuid,history_epoch_id,destination_origin,
        parent_external_canonical_id,evidence_kind,parent_intent_id,parent_mapping_command_id,parent_activation_id,parent_public_id,
        parent_ack_revision,parent_ack_command_json,parent_ack_outcome_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(`${write.mutationId}:intent:${index}`, write.recordId, nextVersion, relationshipState!.relationshipVersion,
          relationshipState!.relationshipMutationId, relationshipState!.organizationRecordId, relationshipState!.organizationRecordVersion,
          value.sourceId, value.sourceInstanceUUID, value.applicationUUID, value.historyEpoch, value.origin,
          relationshipState!.organizationRecordId, evidence.evidenceKind, evidence.parentIntentId, evidence.parentMappingCommandId,
          evidence.parentActivationId, evidence.evidenceKind === "parent_intent" ? null : evidence.parentPublicId, evidence.parentAckRevision,
          evidence.parentAckCommandJson, evidence.parentAckOutcomeJson));
    });
  }
  statements.push(...materializations);
  statements.push(db.prepare(`DELETE FROM operations_directory_write_fences WHERE mutation_id=?`).bind(write.mutationId));
  return { status: "planned", outcome: { status: "written", replayed: false,
    mutationId: write.mutationId, recordId: write.recordId, kind: write.kind, version: nextVersion, commandIds }, statements };
}

/** Trusted composition hook: validates and prepares only this writer's canonical statements. */
export async function stageNativeDirectoryProfileWrite(db: DirectoryWriteD1, input: NativeDirectoryProfileWrite,
  stage: (statements: readonly D1PreparedStatement[]) => void): Promise<NativeDirectoryProfileWriteOutcome> {
  const planned = await planNativeDirectoryProfileWriteInternal(db, input);
  if (planned.status !== "planned") return planned;
  stage(planned.statements);
  return planned.outcome;
}

async function executeNativeDirectoryProfileWrite(db: D1Database, input: NativeDirectoryProfileWrite,
  allowEmptyDestinations = false): Promise<NativeDirectoryProfileWriteOutcome> {
  const planned = await planNativeDirectoryProfileWriteInternal(db, input, allowEmptyDestinations);
  if (planned.status !== "planned") return planned;
  try { await db.batch([...planned.statements]); }
  catch { return { status: "blocked", reason: "authority_or_atomic_write" }; }
  return planned.outcome;
}

/** Normal profile routes always require PA destinations. */
export async function writeNativeDirectoryProfile(db: D1Database, input: NativeDirectoryProfileWrite): Promise<NativeDirectoryProfileWriteOutcome> {
  return executeNativeDirectoryProfileWrite(db, input);
}

/**
 * The sole exception to the normal non-empty enrollment rule. Its caller is a
 * staging-gated route; this function also fixes every mutable fixture value so
 * another route cannot repurpose the exception for a source-less record.
 */
export async function writeStagingEmptyEnrollmentOrganizationFixture(db: D1Database,
  input: NativeDirectoryCreateWrite): Promise<NativeDirectoryProfileWriteOutcome> {
  if (input.operation !== "create" || input.kind !== "organization"
    || input.mutationId !== STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID
    || input.recordId !== STAGING_EMPTY_ENROLLMENT_FIXTURE_RECORD_ID
    || input.createAdmissionId !== STAGING_EMPTY_ENROLLMENT_FIXTURE_ADMISSION_ID
    || input.expectedLocalVersion !== 0 || input.destinations.length !== 0
    || JSON.stringify(input.profile) !== JSON.stringify(STAGING_EMPTY_ENROLLMENT_FIXTURE_PROFILE)
    || input.scopes.length !== 1 || input.scopes[0]!.divisionId !== null)
    return { status: "rejected", reason: "invalid_staging_fixture" };
  return executeNativeDirectoryProfileWrite(db, input, true);
}
