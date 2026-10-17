import {correspondenceGrantSql} from './portal-directory-correspondence';
import { directoryMaterializationReadSource, projectAlphaDirectoryUnsettledReadSource }
  from "./project-alpha-directory-materialization-read-source";

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
/** An explicit portal actor is never converted into a staff admission. */
export type NativeDirectoryPortalWriterActor = Readonly<{
  kind: "portal"; actorId: string; issuer: string; subject: string; grantId: string; grantRevision: number;
  workspaceId: string; sourceId: string; groupId: string; groupVersion: number; sharedMutationId: string;
  authorityRevision: number; contextVersion: string; verifiedUntil: string;
}>;
type WriterActor = NativeDirectoryWriterActor | NativeDirectoryPortalWriterActor;
type PortalUpdate<T> = T extends NativeDirectoryUpdateWrite ? Omit<T, "actor"> & Readonly<{ actor: NativeDirectoryPortalWriterActor }> : never;
export type NativeDirectoryPortalUpdateWrite = PortalUpdate<NativeDirectoryUpdateWrite>;
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
  expectedLocalVersion: number; actor: WriterActor; profile: Record<string, string>;
  scopes: readonly NativeDirectoryScope[]; destinations: readonly NativeDirectoryDestinationAuthority[];
  createAdmissionId: string | null; relationship: NativeDirectoryClientRelationship | null;
  sharedContactProfile?: Readonly<{ groupId: string; mutationId: string }>;
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
function portalActor(actor: WriterActor): actor is NativeDirectoryPortalWriterActor { return "kind" in actor && actor.kind === "portal"; }
function writerActorId(actor: WriterActor): string { return portalActor(actor) ? actor.actorId : actor.staffId; }
function writerSubject(actor: WriterActor): string { return portalActor(actor) ? actor.subject : actor.accessSubject; }
function identityGrantId(actor: WriterActor): string { return portalActor(actor) ? actor.grantId : actor.selectedIdentityGrantId; }
function validWriterActor(value: unknown, allowPortal: boolean): value is WriterActor {
  if (!plain(value)) return false;
  if (value.kind === "portal") {
    const fields = ["kind", "actorId", "issuer", "subject", "grantId", "grantRevision", "workspaceId", "sourceId", "groupId",
      "groupVersion", "sharedMutationId", "authorityRevision", "contextVersion", "verifiedUntil"];
    return allowPortal && exact(value, fields) && typeof value.grantId === "string" && UUID.test(value.grantId)
      && value.actorId === `portal:${value.grantId}` && boundedText(value.issuer, 512, true) && boundedText(value.subject, 512, true)
      && boundedText(value.workspaceId, 512, true) && typeof value.sourceId === "string" && SOURCE_ID.test(value.sourceId)
      && typeof value.groupId === "string" && UUID.test(value.groupId) && typeof value.sharedMutationId === "string" && UUID.test(value.sharedMutationId)
      && [value.grantRevision, value.groupVersion, value.authorityRevision].every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 1)
      && typeof value.contextVersion === "string" && /^[a-f0-9]{64}$/.test(value.contextVersion)
      && typeof value.verifiedUntil === "string" && Number.isFinite(Date.parse(value.verifiedUntil))
      && Date.parse(value.verifiedUntil) > Date.now() && Date.parse(value.verifiedUntil) <= Date.now() + 60_000;
  }
  return exact(value, ["staffId", "accessSubject", "admissionVersion", "selectedGrantId", "loginEmail", "profileVersion", "selectedIdentityGrantId"])
    && boundedText(value.staffId, 191, true) && boundedText(value.accessSubject, 191, true)
    && boundedText(value.selectedGrantId, 191, true) && typeof value.admissionVersion === "number" && Number.isSafeInteger(value.admissionVersion) && value.admissionVersion >= 1
    && boundedText(value.loginEmail, 254, true) && value.loginEmail === value.loginEmail.trim().toLowerCase()
    && typeof value.profileVersion === "number" && Number.isSafeInteger(value.profileVersion) && value.profileVersion >= 1
    && boundedText(value.selectedIdentityGrantId, 191, true);
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
function destination(value: unknown, recordId: string, operation: "create" | "update"): value is NativeDirectoryDestinationAuthority {
  return plain(value) && exact(value, ["sourceId", "sourceInstanceUUID", "applicationUUID", "historyEpoch", "origin", "externalCanonicalId", "expectedAuthorizationGeneration"])
    && typeof value.sourceId === "string" && SOURCE_ID.test(value.sourceId) && typeof value.sourceInstanceUUID === "string" && UUID.test(value.sourceInstanceUUID)
    && typeof value.applicationUUID === "string" && UUID.test(value.applicationUUID) && typeof value.historyEpoch === "string" && UUID.test(value.historyEpoch)
    && canonicalOrigin(value.origin) && externalId(value.externalCanonicalId)
    && (operation === "update" || value.externalCanonicalId === recordId) && revision(value.expectedAuthorizationGeneration);
}
function normalize(input: NativeDirectoryProfileWrite | NativeDirectoryPortalUpdateWrite, allowEmptyDestinations = false, allowPortal = false): NormalizedWrite | null {
  const normalizedProfile = plain(input.profile) ? Object.fromEntries(Object.entries(input.profile).map(([field, value]) => {
    const normalized = typeof value === "string" ? value.normalize("NFC").trim() : value;
    return [field, (field === "email" || field === "generalEmail") && typeof normalized === "string" ? normalized.toLowerCase() : normalized];
  })) : null;
  if (!plain(input) || !UUID.test(input.mutationId) || !externalId(input.recordId) || (input.kind !== "organization" && input.kind !== "client")
    || (input.operation !== "create" && input.operation !== "update") || !Number.isSafeInteger(input.expectedLocalVersion)
    || input.expectedLocalVersion < 0 || (input.operation === "create") !== (input.expectedLocalVersion === 0)
    || (input.operation === "create" && !boundedText(input.createAdmissionId, 191, true))
    || !validWriterActor(input.actor, allowPortal) || (portalActor(input.actor) && input.operation !== "update")
    || (input.kind === "client" && (!externalId(input.recordId) || !plain(input.relationship)
      || !exact(input.relationship, ["organizationRecordId", "expectedRelationshipVersion"])
      || (input.relationship.organizationRecordId !== null && !externalId(input.relationship.organizationRecordId))
      || !Number.isSafeInteger(input.relationship.expectedRelationshipVersion) || input.relationship.expectedRelationshipVersion < 0
      || (input.operation === "create" ? input.relationship.expectedRelationshipVersion !== 0 : input.relationship.expectedRelationshipVersion < 1)))
    || !profile(normalizedProfile, input.kind, input.operation) || !Array.isArray(input.destinations)
    || input.destinations.length < (allowEmptyDestinations ? 0 : 1) || input.destinations.length > MAX_DESTINATIONS
    || !input.destinations.every(value => destination(value, input.recordId, input.operation))) return null;
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
async function portalWriteAuthority(db: DirectoryWriteD1, write: NormalizedWrite, actor: NativeDirectoryPortalWriterActor): Promise<boolean> {
  if (write.operation !== "update" || !validWriterActor(actor, true)) return false;
  const bridgeColumns = await db.prepare("SELECT COUNT(*) FROM pragma_table_info('shared_profile_portal_grants') WHERE name IN('directory_source_id','correspondence_revision_id')").first<number>("COUNT(*)") === 2;
  const row = await db.prepare(`SELECT 1 ok FROM shared_profile_portal_grants grant_row
    JOIN shared_profile_portal_authority_heads head ON head.workspace_id=grant_row.workspace_id AND head.source_id=grant_row.source_id
    JOIN native_directory_shared_profiles profile ON profile.id=grant_row.group_id
    JOIN native_directory_shared_profile_members member ON member.group_id=profile.id AND member.record_id=?
    JOIN operations_directory_records record ON record.record_id=member.record_id AND record.record_kind=profile.kind
    JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=grant_row.record_id AND mapping.source_id=${bridgeColumns?'COALESCE(grant_row.directory_source_id,grant_row.source_id)':'grant_row.source_id'}
    WHERE ${bridgeColumns?correspondenceGrantSql('grant_row'):'1=1'} AND grant_row.id=? AND grant_row.state='active' AND grant_row.revision=? AND grant_row.issuer=? AND grant_row.subject=?
      AND grant_row.workspace_id=? AND grant_row.source_id=? AND grant_row.group_id=? AND profile.version=? AND profile.kind=?
      AND record.current_version=? AND json(profile.membership_json)=json(grant_row.group_membership_json)
      AND mapping.project_alpha_public_id=grant_row.target_public_id AND mapping.resource_type=grant_row.target_type
      AND mapping.source_instance_id=grant_row.source_instance_id AND mapping.application_id=grant_row.application_id
      AND mapping.history_epoch_id=grant_row.history_epoch_id AND head.state='active' AND head.revision=?`)
    .bind(write.recordId, actor.grantId, actor.grantRevision, actor.issuer, actor.subject, actor.workspaceId, actor.sourceId,
      actor.groupId, actor.groupVersion, write.kind, write.expectedLocalVersion, actor.authorityRevision).first();
  return !!row;
}
async function authority(db: DirectoryWriteD1, write: NormalizedWrite, permission = "directory.profile.edit", selectedGrant?: string): Promise<boolean> {
  if (portalActor(write.actor)) return ["directory.profile.edit", "directory.identity.link"].includes(permission)
    && await portalWriteAuthority(db, write, write.actor);
  const grantId = selectedGrant ?? write.actor.selectedGrantId;
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
    createAdmissionId: write.createAdmissionId, relationship: write.kind === "client" ? write.relationship : null,
    ...(write.sharedContactProfile ? { sharedContactProfile: write.sharedContactProfile } : {}) });
}
type RemoteState = Readonly<{ externalId: string; projectAlphaPublicId: string; revision: string;
  authorizationGeneration: string; mappingKind: "legacy" | "acquired" }>;
export type NativeDirectoryDurableRemoteHead = Readonly<{
  projectAlphaPublicId: string; externalCanonicalId: string; revision: string;
}>;
type RelationshipState = Readonly<{
  organizationRecordId: string | null; organizationRecordVersion: number | null;
  relationshipVersion: number; relationshipMutationId: string;
}>;
type RelationshipEvidence = Readonly<{
  evidenceKind: "unlinked" | "parent_intent" | "existing_mapping" | "acquired_mapping";
  parentExternalCanonicalId: string | null;
  parentPublicId: string | null; parentIntentId: string | null; parentMappingCommandId: string | null;
  parentActivationId: string | null; parentAckRevision: string | null; parentAckCommandJson: string | null;
  parentAckOutcomeJson: string | null;
}>;
type StagedOrganization = Readonly<{ recordId: string; version: 1; mutationId: string;
  destinations: readonly NativeDirectoryDestinationAuthority[] }>;

async function linkedRelationshipEvidence(db: DirectoryWriteD1, relationship: RelationshipState,
  destinationValue: NativeDirectoryDestinationAuthority,
  stagedOrganization: StagedOrganization | null = null): Promise<RelationshipEvidence | null> {
  if (relationship.organizationRecordId === null || relationship.organizationRecordVersion === null) return {
    evidenceKind: "unlinked", parentExternalCanonicalId: null, parentPublicId: null, parentIntentId: null, parentMappingCommandId: null,
    parentActivationId: null, parentAckRevision: null, parentAckCommandJson: null, parentAckOutcomeJson: null,
  };
  const parentId = relationship.organizationRecordId, parentVersion = relationship.organizationRecordVersion;
  if (stagedOrganization?.recordId === parentId && stagedOrganization.version === parentVersion) {
    const index = stagedOrganization.destinations.findIndex(value => destinationKey(value) === destinationKey(destinationValue)
      && value.historyEpoch === destinationValue.historyEpoch && value.origin === destinationValue.origin
      && value.externalCanonicalId === parentId
      && value.expectedAuthorizationGeneration === destinationValue.expectedAuthorizationGeneration);
    return index < 0 ? null : {
      evidenceKind: "parent_intent", parentExternalCanonicalId: parentId, parentPublicId: null,
      parentIntentId: `${stagedOrganization.mutationId}:intent:${index}`, parentMappingCommandId: null,
      parentActivationId: null, parentAckRevision: null, parentAckCommandJson: null, parentAckOutcomeJson: null,
    };
  }
  const activeRows = (await db.prepare(`SELECT mapping.external_id parentExternalCanonicalId,
      mapping.project_alpha_public_id parentPublicId,mapping.mapping_kind mappingKind,mapping.provenance_id provenanceId
    FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records parent ON parent.record_id=mapping.record_id AND parent.record_kind='organization'
      AND parent.current_version=?
    JOIN operations_directory_revisions revision ON revision.record_id=parent.record_id AND revision.version=parent.current_version
    JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=parent.record_id
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.resource_type='organization' AND mapping.record_id=?
      AND EXISTS(SELECT 1 FROM json_each(enrollment.destinations_json) enrolled
        WHERE json_extract(enrolled.value,'$.sourceId')=mapping.source_id
          AND json_extract(enrolled.value,'$.sourceInstanceUUID')=mapping.source_instance_id
          AND json_extract(enrolled.value,'$.applicationUUID')=mapping.application_id
          AND json_extract(enrolled.value,'$.historyEpoch')=mapping.history_epoch_id
          AND json_extract(enrolled.value,'$.origin')=?
          AND (json_extract(enrolled.value,'$.externalCanonicalId')=mapping.external_id
            OR (mapping.mapping_kind='acquired'
              AND json_extract(enrolled.value,'$.externalCanonicalId')=mapping.record_id)))
    LIMIT 2`).bind(parentVersion, destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, parentId, destinationValue.origin)
    .all<{ parentExternalCanonicalId: string; parentPublicId: string; mappingKind: string; provenanceId: string }>()).results;
  if (activeRows.length !== 1 || !externalId(activeRows[0]!.parentExternalCanonicalId)
    || !/^[0-9a-f]{32}$/.test(activeRows[0]!.parentPublicId)) return null;
  const active = activeRows[0]!;
  if (active.mappingKind === "acquired") {
    const activation = await db.prepare(`SELECT activation_id parentActivationId,project_alpha_revision parentAckRevision
      FROM project_alpha_existing_directory_binding_activation_receipts
      WHERE activation_id=? AND record_id=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
        AND resource_type='organization' AND external_id=? AND project_alpha_public_id=?`)
      .bind(active.provenanceId, parentId, destinationValue.sourceId, destinationValue.sourceInstanceUUID,
        destinationValue.applicationUUID, destinationValue.historyEpoch, active.parentExternalCanonicalId, active.parentPublicId)
      .first<{ parentActivationId: string; parentAckRevision: string }>();
    return activation && revision(activation.parentAckRevision) ? {
      evidenceKind: "acquired_mapping", parentExternalCanonicalId: active.parentExternalCanonicalId,
      parentPublicId: active.parentPublicId, parentIntentId: null,
      parentMappingCommandId: null, parentActivationId: activation.parentActivationId,
      parentAckRevision: activation.parentAckRevision, parentAckCommandJson: null, parentAckOutcomeJson: null,
    } : null;
  }
  if (active.mappingKind !== "legacy") return null;
  const materializationReadSource = await directoryMaterializationReadSource(db as D1Database);
  const parentIntents = (await db.prepare(`SELECT intent.intent_id parentIntentId,mapping.project_alpha_public_id parentPublicId
    FROM operations_directory_intents intent
    JOIN ${materializationReadSource} materialization ON materialization.intent_id=intent.intent_id
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
      AND mapping.project_alpha_public_id=json_extract(outbox.outcome_json,'$.response.result.resource.publicId')
    WHERE intent.record_id=? AND intent.record_version=? AND intent.state='acknowledged'
      AND intent.source_id=? AND intent.source_instance_uuid=? AND intent.application_uuid=?
      AND intent.expected_history_epoch_id=? AND intent.destination_origin=? AND intent.external_canonical_id=?
      AND mapping.project_alpha_public_id=?
      AND materialization.command_json=outbox.command_json
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND (SELECT count(*) FROM json_each(outbox.outcome_json))=2
      AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response'))=6
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=intent.expected_history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=intent.application_uuid
      AND json_type(outbox.outcome_json,'$.response.requestId')='text'
      AND length(json_extract(outbox.outcome_json,'$.response.requestId'))=36
      AND json_type(outbox.outcome_json,'$.response.replayed') IN ('true','false')
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=mapping.project_alpha_public_id
      AND json_type(outbox.outcome_json,'$.response.result.authorizationGeneration')='text'
      AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') GLOB '[0-9]*'
      AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') NOT GLOB '*[^0-9]*'
      AND (json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')='0'
        OR substr(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'),1,1)<>'0')
      AND length(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'))<=19
      AND (length(json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration'))<19
        OR json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')<='9223372036854775807')
      AND ((SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=2
          AND json_type(outbox.outcome_json,'$.response.result.data') IS NULL
          AND json_extract(outbox.command_json,'$.operation')='create'
          AND outbox.resource_type='organization'
        OR (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=3
          AND json_type(outbox.outcome_json,'$.response.result.data')='object'
          AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.data'))=1
          AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=
            json_extract(outbox.outcome_json,'$.response.result.resource.publicId'))
      AND CASE json_extract(outbox.command_json,'$.operation')
        WHEN 'create' THEN
          (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.resource'))=4
          AND json_extract(outbox.command_json,'$.expectedRevision')='0'
          AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=intent.external_canonical_id
          AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')='1'
          AND json_type(outbox.command_json,'$.expectedAuthorizationGeneration')='text'
          AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') GLOB '[0-9]*'
          AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') NOT GLOB '*[^0-9]*'
          AND (json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')='0'
            OR substr(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'),1,1)<>'0')
          AND length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))<=19
          AND (length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))<19
            OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<='9223372036854775807')
          AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<>'9223372036854775807'
          AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')=
            CAST(CAST(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') AS INTEGER)+1 AS TEXT)
        WHEN 'update' THEN
          (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.resource'))=3
          AND json_extract(outbox.command_json,'$.expectedProjectAlphaPublicId')=?
          AND json_type(outbox.command_json,'$.expectedAuthorizationGeneration')='text'
          AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') GLOB '[0-9]*'
          AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') NOT GLOB '*[^0-9]*'
          AND (json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')='0'
            OR substr(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'),1,1)<>'0')
          AND length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))<=19
          AND (length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))<19
            OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<='9223372036854775807')
          AND json_type(outbox.command_json,'$.expectedRevision')='text'
          AND json_extract(outbox.command_json,'$.expectedRevision') GLOB '[1-9]*'
          AND json_extract(outbox.command_json,'$.expectedRevision') NOT GLOB '*[^0-9]*'
          AND length(json_extract(outbox.command_json,'$.expectedRevision'))<=19
          AND (length(json_extract(outbox.command_json,'$.expectedRevision'))<19
            OR json_extract(outbox.command_json,'$.expectedRevision')<='9223372036854775807')
          AND json_type(outbox.outcome_json,'$.response.result.resource.revision')='text'
          AND json_extract(outbox.outcome_json,'$.response.result.resource.revision') GLOB '[1-9]*'
          AND json_extract(outbox.outcome_json,'$.response.result.resource.revision') NOT GLOB '*[^0-9]*'
          AND length(json_extract(outbox.outcome_json,'$.response.result.resource.revision'))<=19
          AND (length(json_extract(outbox.outcome_json,'$.response.result.resource.revision'))<19
            OR json_extract(outbox.outcome_json,'$.response.result.resource.revision')<='9223372036854775807')
          AND (length(json_extract(outbox.outcome_json,'$.response.result.resource.revision'))>
              length(json_extract(outbox.command_json,'$.expectedRevision'))
            OR (length(json_extract(outbox.outcome_json,'$.response.result.resource.revision'))=
                length(json_extract(outbox.command_json,'$.expectedRevision'))
              AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')>=
                json_extract(outbox.command_json,'$.expectedRevision')))
          AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')=
            json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')
        ELSE 0 END
    LIMIT 2`).bind(parentId, parentVersion, destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, destinationValue.origin,
      active.parentExternalCanonicalId, active.parentPublicId, active.parentPublicId)
    .all<{ parentIntentId: string; parentPublicId: string }>()).results;
  if (parentIntents.length === 1) return {
    evidenceKind: "parent_intent", parentExternalCanonicalId: active.parentExternalCanonicalId,
    parentPublicId: parentIntents[0]!.parentPublicId,
    parentIntentId: parentIntents[0]!.parentIntentId, parentMappingCommandId: null, parentActivationId: null,
    parentAckRevision: null, parentAckCommandJson: null, parentAckOutcomeJson: null,
  };
  if (parentIntents.length > 1) return null;
  const legacy = await db.prepare(`SELECT mapping.command_id parentMappingCommandId,mapping.project_alpha_public_id parentPublicId,
      json_extract(outbox.outcome_json,'$.response.result.resource.revision') parentAckRevision,
      outbox.command_json parentAckCommandJson,outbox.outcome_json parentAckOutcomeJson
    FROM project_alpha_directory_mappings mapping
    JOIN ${materializationReadSource} materialization ON materialization.command_id=mapping.command_id
    JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
      AND intent.record_id=? AND intent.record_version=? AND intent.state='acknowledged'
      AND intent.source_id=mapping.source_id AND intent.source_instance_uuid=mapping.source_instance_id
      AND intent.application_uuid=mapping.application_id AND intent.expected_history_epoch_id=mapping.history_epoch_id
      AND intent.destination_origin=? AND intent.external_canonical_id=mapping.external_id
    JOIN project_alpha_directory_outbox outbox ON outbox.command_id=mapping.command_id
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.resource_type='organization' AND mapping.external_id=? AND mapping.project_alpha_public_id=?
      AND outbox.state='acknowledged' AND outbox.source_id=mapping.source_id
      AND outbox.expected_source_instance_id=mapping.source_instance_id AND outbox.application_id=mapping.application_id
      AND outbox.expected_history_epoch_id=mapping.history_epoch_id AND outbox.destination_base_url=?
      AND outbox.resource_type='organization' AND outbox.external_id=mapping.external_id
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND (SELECT count(*) FROM json_each(outbox.outcome_json))=2
      AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response'))=6
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=mapping.history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=mapping.source_instance_id
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=mapping.application_id
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=mapping.external_id
      AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.resource'))=4
      AND json_extract(outbox.command_json,'$.operation')='create'
      AND json_type(outbox.command_json,'$.expectedAuthorizationGeneration')='text'
      AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') GLOB '[0-9]*'
      AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') NOT GLOB '*[^0-9]*'
      AND (json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')='0'
        OR substr(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'),1,1)<>'0')
      AND length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))<=19
      AND (length(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration'))<19
        OR json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<='9223372036854775807')
      AND json_extract(outbox.command_json,'$.expectedAuthorizationGeneration')<>'9223372036854775807'
      AND json_type(outbox.outcome_json,'$.response.result.authorizationGeneration')='text'
      AND json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration')=
        CAST(CAST(json_extract(outbox.command_json,'$.expectedAuthorizationGeneration') AS INTEGER)+1 AS TEXT)
      AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=mapping.project_alpha_public_id
      AND ((SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=2
          AND json_type(outbox.outcome_json,'$.response.result.data') IS NULL
          AND json_extract(outbox.command_json,'$.operation')='create'
          AND outbox.resource_type='organization'
        OR (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result'))=3
          AND json_type(outbox.outcome_json,'$.response.result.data')='object'
          AND (SELECT count(*) FROM json_each(outbox.outcome_json,'$.response.result.data'))=1
          AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=
            json_extract(outbox.outcome_json,'$.response.result.resource.publicId'))`)
    .bind(parentId, parentVersion, destinationValue.origin,
      destinationValue.sourceId, destinationValue.sourceInstanceUUID, destinationValue.applicationUUID,
      destinationValue.historyEpoch, active.parentExternalCanonicalId, active.parentPublicId, destinationValue.origin)
    .first<{ parentMappingCommandId: string; parentPublicId: string; parentAckRevision: string;
      parentAckCommandJson: string; parentAckOutcomeJson: string }>();
  return legacy && revision(legacy.parentAckRevision) ? {
    evidenceKind: "existing_mapping", parentExternalCanonicalId: active.parentExternalCanonicalId,
    parentPublicId: legacy.parentPublicId, parentIntentId: null,
    parentMappingCommandId: legacy.parentMappingCommandId, parentActivationId: null,
    parentAckRevision: legacy.parentAckRevision, parentAckCommandJson: legacy.parentAckCommandJson,
    parentAckOutcomeJson: legacy.parentAckOutcomeJson,
  } : null;
}
async function updateRemoteState(db: DirectoryWriteD1,
  write: Pick<NormalizedWrite, "kind" | "recordId" | "expectedLocalVersion">,
  destinationValue: DestinationIdentity & Readonly<{ expectedAuthorizationGeneration?: string }>,
  allowAcquiredEnrollmentCoordinate = false,
  _relationshipRecoveryEnabled = false,
): Promise<RemoteState | null> {
  // A durable ACK proves the exact remote identity and revision, but its
  // authorization generation is historical: PA advances that application-wide
  // generation for unrelated records. Update routes replace it with the fresh
  // inventory/binding generation they just verified; PA still CAS-checks that
  // generation on dispatch. Callers that omit it retain the durable generation.
  // Keep the compatibility argument for callers compiled against the bounded
  // recovery window. It no longer controls reads of already-validated history;
  // recovery review/authorization/dispatch remains gated at its mutation routes.
  const activeRows = (await db.prepare(`SELECT external_id externalId,project_alpha_public_id projectAlphaPublicId,
      mapping_kind mappingKind,provenance_id provenanceId
    FROM project_alpha_active_directory_mappings WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      AND resource_type=? AND record_id=?`).bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, write.recordId)
    .all<Record<string, unknown>>()).results;
  if (activeRows.length !== 1) return null;
  const active = activeRows[0]!;
  if (!externalId(active.externalId) || typeof active.projectAlphaPublicId !== "string"
    || !/^[0-9a-f]{32}$/.test(active.projectAlphaPublicId)
    || (active.mappingKind !== "legacy" && active.mappingKind !== "acquired")) return null;
  const exactExternalCoordinate = destinationValue.externalCanonicalId === active.externalId;
  const acquiredEnrollmentCoordinate = allowAcquiredEnrollmentCoordinate && active.mappingKind === "acquired"
    && destinationValue.externalCanonicalId === write.recordId;
  if (!exactExternalCoordinate && !acquiredEnrollmentCoordinate) return null;
  const unsettledReadSource = await projectAlphaDirectoryUnsettledReadSource(db as D1Database);
  const pending = await db.prepare(`SELECT 1 present FROM ${unsettledReadSource} WHERE source_id=? AND expected_source_instance_id=?
    AND application_id=? AND expected_history_epoch_id=? AND resource_type=? AND external_id=? AND state<>'acknowledged' LIMIT 1`)
    .bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID, destinationValue.applicationUUID,
      destinationValue.historyEpoch, write.kind, active.externalId).first();
  if (pending) return null;
  if (active.mappingKind === "acquired") {
    // An acquired mapping is never copied into the legacy mapping table. After
    // its first native profile update, the exact acknowledged writer intent is
    // the newest revision/generation proof for the next update.
    const materializationReadSource = await directoryMaterializationReadSource(db as D1Database);
    const delivered = await db.prepare(`SELECT
        json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision,
        json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') authorizationGeneration
      FROM operations_directory_intents intent
      JOIN ${materializationReadSource} materialization ON materialization.intent_id=intent.intent_id
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
        destinationValue.origin, active.externalId, write.kind, active.projectAlphaPublicId, write.kind, active.projectAlphaPublicId)
      .first<Record<string, unknown>>();
    if (delivered) return revision(delivered.revision) && revision(delivered.authorizationGeneration)
      ? { externalId: active.externalId, projectAlphaPublicId: active.projectAlphaPublicId,
          revision: delivered.revision,
          authorizationGeneration: destinationValue.expectedAuthorizationGeneration ?? delivered.authorizationGeneration,
          mappingKind: "acquired" } : null;
    const refreshed = await db.prepare(`SELECT live_revision revision,authorization_generation authorizationGeneration
      FROM project_alpha_existing_directory_binding_revision_refresh_receipts WHERE record_id=? AND source_id=?
        AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND resource_type=? AND external_id=?
        AND project_alpha_public_id=? AND local_record_version=? ORDER BY received_at DESC,receipt_id DESC LIMIT 1`).bind(write.recordId, destinationValue.sourceId,
        destinationValue.sourceInstanceUUID, destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, active.externalId,
        active.projectAlphaPublicId, write.expectedLocalVersion).first<Record<string, unknown>>();
    if (refreshed) return revision(refreshed.revision) && revision(refreshed.authorizationGeneration)
      ? { externalId: active.externalId, projectAlphaPublicId: active.projectAlphaPublicId,
          revision: refreshed.revision,
          authorizationGeneration: destinationValue.expectedAuthorizationGeneration ?? refreshed.authorizationGeneration,
          mappingKind: "acquired" } : null;
    const activated = await db.prepare(`SELECT project_alpha_revision revision FROM project_alpha_existing_directory_binding_activation_receipts
      WHERE activation_id=? AND record_id=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
        AND resource_type=? AND external_id=? AND project_alpha_public_id=? AND local_record_version=?`)
      .bind(active.provenanceId, write.recordId, destinationValue.sourceId, destinationValue.sourceInstanceUUID,
        destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, active.externalId,
        active.projectAlphaPublicId, write.expectedLocalVersion)
      .first<Record<string, unknown>>();
    return activated && revision(activated.revision)
      ? { externalId: active.externalId, projectAlphaPublicId: active.projectAlphaPublicId,
          revision: activated.revision, authorizationGeneration: destinationValue.expectedAuthorizationGeneration ?? "",
          mappingKind: "acquired" } : null;
  }
  const profileRows = (await db.prepare(`WITH evidence AS (SELECT mapping.project_alpha_public_id projectAlphaPublicId,
      json_extract(outbox.outcome_json,'$.response.result.resource.revision') revision,
      json_extract(outbox.outcome_json,'$.response.result.authorizationGeneration') authorizationGeneration
    FROM project_alpha_directory_mappings mapping JOIN project_alpha_directory_outbox outbox
      ON outbox.source_id=mapping.source_id AND outbox.expected_source_instance_id=mapping.source_instance_id
      AND outbox.application_id=mapping.application_id AND outbox.expected_history_epoch_id=mapping.history_epoch_id
      AND outbox.resource_type=mapping.resource_type AND outbox.external_id=mapping.external_id
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.resource_type=? AND mapping.external_id=? AND outbox.state='acknowledged')
    SELECT projectAlphaPublicId,revision,authorizationGeneration,
      MAX(CASE WHEN projectAlphaPublicId<>? OR typeof(revision)<>'text' OR (revision<>'0' AND revision NOT GLOB '[1-9]*') OR revision GLOB '*[^0-9]*'
        OR length(revision)>19 OR (length(revision)=19 AND revision>'9223372036854775807')
        OR typeof(authorizationGeneration)<>'text' OR (authorizationGeneration<>'0' AND authorizationGeneration NOT GLOB '[1-9]*')
        OR authorizationGeneration GLOB '*[^0-9]*' OR length(authorizationGeneration)>19
        OR (length(authorizationGeneration)=19 AND authorizationGeneration>'9223372036854775807') THEN 1 ELSE 0 END) OVER () invalidEvidence
    FROM evidence GROUP BY projectAlphaPublicId,revision,authorizationGeneration
    ORDER BY invalidEvidence DESC,length(revision) DESC,revision DESC LIMIT 3`).bind(destinationValue.sourceId, destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID, destinationValue.historyEpoch, write.kind, active.externalId,
      active.projectAlphaPublicId).all<Record<string, unknown>>()).results;
  const hasRecoveryRelationshipEvidence = !!await db.prepare(`SELECT 1 present FROM sqlite_schema
    WHERE type='view' AND name='project_alpha_directory_validated_recovery_relationship_acknowledgements'`).first("present");
  const relationshipSource = hasRecoveryRelationshipEvidence ? `SELECT ack.client_public_id projectAlphaPublicId,ack.revision,
      json_extract(recovery.outcome_json,'$.response.result.authorizationGeneration') authorizationGeneration
    FROM project_alpha_directory_validated_recovery_relationship_acknowledgements ack
    JOIN project_alpha_directory_relationship_recovery_outbox recovery ON recovery.command_id=ack.command_id
    JOIN project_alpha_directory_relationship_outbox predecessor ON predecessor.command_id=ack.predecessor_command_id
    JOIN operations_directory_client_organization_history history ON history.client_record_id=ack.client_record_id
      AND history.relationship_version=ack.relationship_version AND history.mutation_id=predecessor.mutation_id
    WHERE ack.client_record_id=? AND history.client_record_version=? AND ack.source_id=?
      AND ack.source_instance_id=? AND ack.application_id=? AND ack.history_epoch_id=?
      AND ack.destination_origin=? AND ack.identity_valid=1
    UNION ALL ` : "";
  const relationshipRows = write.kind === "client" ? (await db.prepare(`WITH evidence AS (${relationshipSource}SELECT
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
      AND json_extract(outbox.outcome_json,'$.response.result.organizationPublicId') IS outbox.organization_public_id)
    SELECT projectAlphaPublicId,revision,authorizationGeneration,
      MAX(CASE WHEN projectAlphaPublicId<>? OR typeof(revision)<>'text' OR (revision<>'0' AND revision NOT GLOB '[1-9]*') OR revision GLOB '*[^0-9]*'
        OR length(revision)>19 OR (length(revision)=19 AND revision>'9223372036854775807')
        OR typeof(authorizationGeneration)<>'text' OR (authorizationGeneration<>'0' AND authorizationGeneration NOT GLOB '[1-9]*')
        OR authorizationGeneration GLOB '*[^0-9]*' OR length(authorizationGeneration)>19
        OR (length(authorizationGeneration)=19 AND authorizationGeneration>'9223372036854775807') THEN 1 ELSE 0 END) OVER () invalidEvidence
    FROM evidence GROUP BY projectAlphaPublicId,revision,authorizationGeneration
    ORDER BY invalidEvidence DESC,length(revision) DESC,revision DESC LIMIT 3`)
    .bind(...(hasRecoveryRelationshipEvidence ? [write.recordId,write.expectedLocalVersion,destinationValue.sourceId,
      destinationValue.sourceInstanceUUID,destinationValue.applicationUUID,destinationValue.historyEpoch,destinationValue.origin] : []),
      write.recordId,write.expectedLocalVersion,destinationValue.sourceId,destinationValue.sourceInstanceUUID,
      destinationValue.applicationUUID,destinationValue.historyEpoch,destinationValue.origin,
      active.projectAlphaPublicId).all<Record<string, unknown>>()).results : [];
  const heads = [...profileRows,...relationshipRows];
  if (!heads.length) return null;
  if (heads.some(value => value.invalidEvidence === 1 || value.projectAlphaPublicId !== active.projectAlphaPublicId
    || !revision(value.revision) || !revision(value.authorizationGeneration))) return null;
  const maximum = heads.reduce((left, right) => {
    const leftRevision = left.revision as string, rightRevision = right.revision as string;
    return leftRevision.length > rightRevision.length
      || (leftRevision.length === rightRevision.length && leftRevision >= rightRevision) ? left : right;
  });
  const tied = heads.filter(value => value.revision === maximum.revision);
  // PA may acknowledge a no-op profile command at the same resource revision
  // after its application-wide generation advanced. Identity/revision is the
  // durable head; the authenticated route supplies the current generation.
  if (new Set(tied.map(value => `${value.projectAlphaPublicId}\0${value.revision}`)).size !== 1) return null;
  return { externalId: active.externalId, projectAlphaPublicId: maximum.projectAlphaPublicId as string,
    revision: maximum.revision as string,
    authorizationGeneration: destinationValue.expectedAuthorizationGeneration ?? maximum.authorizationGeneration as string,
    mappingKind: "legacy" };
}

/** Resolves only durable/local acknowledgement evidence for an existing PA
 * record. HTTP routes independently bind the returned revision to a fresh,
 * authenticated PA read before issuing an update. */
export async function readNativeDirectoryDurableRemoteHead(db: DirectoryWriteD1,
  kind: NativeDirectoryProfileKind, recordId: string, expectedLocalVersion: number,
  destinationValue: DestinationIdentity, relationshipRecoveryEnabled = false,
): Promise<NativeDirectoryDurableRemoteHead | null> {
  const state = await updateRemoteState(db, { kind, recordId, expectedLocalVersion }, destinationValue, true,
    relationshipRecoveryEnabled);
  return state ? { projectAlphaPublicId: state.projectAlphaPublicId,
    externalCanonicalId: state.externalId, revision: state.revision } : null;
}

/**
 * Persists a canonical native Directory profile mutation and reserves its PA
 * outbox work. It performs no HTTP work. Every client write carries an exact
 * relationship assertion and pins each intent to unlinked, parent-intent,
 * legacy-mapping, or acquired-mapping evidence. Relationship fields remain
 * transport-only and never enter the canonical profile revision.
 */
async function planNativeDirectoryProfileWriteInternal(db: DirectoryWriteD1, input: NativeDirectoryProfileWrite | NativeDirectoryPortalUpdateWrite,
  allowEmptyDestinations = false, stagedOnboardingDecisionId: string | null = null,
  stagedOrganization: StagedOrganization | null = null,
  relationshipRecoveryEnabled = false,
  sharedContext?: Readonly<{ groupId: string; mutationId: string; identitySafeContactProfile: boolean; allowPortal: boolean }>): Promise<NativeDirectoryProfileWritePlanningResult> {
  const normalized = normalize(input, allowEmptyDestinations, sharedContext?.allowPortal === true);
  if (!normalized) return { status: "rejected", reason: "invalid_write" };
  const write: NormalizedWrite = sharedContext?.identitySafeContactProfile && normalized.kind === "client"
    ? { ...normalized, sharedContactProfile: { groupId: sharedContext.groupId, mutationId: sharedContext.mutationId } } : normalized;
  const currentPortalActor = portalActor(write.actor) ? write.actor : null;
  const staffActor = portalActor(write.actor) ? null : write.actor, isPortal = currentPortalActor !== null;
  if (currentPortalActor && (write.operation !== "update" || !sharedContext?.allowPortal
    || sharedContext.groupId !== currentPortalActor.groupId || sharedContext.mutationId !== currentPortalActor.sharedMutationId
    || (write.kind === "client" && !sharedContext.identitySafeContactProfile))) return { status: "rejected", reason: "invalid_portal_write" };
  const actorId = writerActorId(write.actor), actorSubject = writerSubject(write.actor);
  const fenceTable = isPortal ? "operations_directory_portal_write_fences" : "operations_directory_write_fences";
  const auditJson = auditCommand(write);
  const replay = await db.prepare(`SELECT audit.command_json,audit.actor_id,audit.original_verified_access_subject,revision.record_id,
      revision.version,record.record_kind FROM operations_directory_audit audit
    JOIN operations_directory_revisions revision ON revision.mutation_id=audit.mutation_id
    JOIN operations_directory_records record ON record.record_id=revision.record_id WHERE audit.mutation_id=?`).bind(write.mutationId)
    .first<Record<string, unknown>>();
  if (replay) {
    if (replay.command_json !== auditJson || replay.actor_id !== actorId || replay.original_verified_access_subject !== actorSubject
      || replay.record_id !== write.recordId || replay.record_kind !== write.kind || typeof replay.version !== "number")
      return { status: "conflict", reason: "idempotency_body_conflict" };
    if (stagedOnboardingDecisionId !== null && (!await authority(db, write)
      || !await authority(db, write, "directory.identity.link", identityGrantId(write.actor))))
      return { status: "blocked", reason: "native_directory_authority" };
    const ids = await Promise.all(write.destinations.map(value => commandId(write.mutationId, value)));
    return { status: "written", replayed: true, mutationId: write.mutationId, recordId: write.recordId, kind: write.kind, version: replay.version, commandIds: ids };
  }
  const record = await db.prepare(`SELECT record_kind,current_version FROM operations_directory_records WHERE record_id=?`).bind(write.recordId).first<{ record_kind: string; current_version: number }>();
  if (write.operation === "create" ? !!record : !record || record.record_kind !== write.kind || record.current_version !== write.expectedLocalVersion)
    return { status: "conflict", reason: write.operation === "create" ? "record_exists" : "stale_local_version" };
  if (!await authority(db, write)) return { status: "blocked", reason: "native_directory_authority" };
  const scopesJson = JSON.stringify(write.scopes), profileJson = JSON.stringify(write.profile);
  const stagedAdmission = write.operation === "create" && stagedOnboardingDecisionId !== null
    && write.createAdmissionId === `client-onboarding:${stagedOnboardingDecisionId}:${write.kind}`;
  if (write.operation === "create" && !stagedAdmission && !await db.prepare(`SELECT 1 ok FROM native_directory_create_admissions
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
      actorId, actorSubject, write.recordId, write.kind, scopesJson, profileJson,
      JSON.stringify(write.destinations.map(identity)), write.kind, write.createAdmissionId, write.recordId,
      write.relationship?.organizationRecordId ?? null).first("ok"))
    return { status: "blocked", reason: "create_admission" };
  let relationshipState: RelationshipState | null = null;
  if (write.kind === "client") {
    if (!await authority(db, write, "directory.identity.link", identityGrantId(write.actor)))
      return { status: "blocked", reason: "native_directory_identity_authority" };
    if (write.operation === "create") {
      const organizationRecordId = write.relationship!.organizationRecordId;
      let organizationRecordVersion: number | null = null;
      if (organizationRecordId !== null) {
        if (stagedOrganization?.recordId === organizationRecordId && stagedOrganization.version === 1) {
          organizationRecordVersion = stagedOrganization.version;
        } else {
          const parent = await db.prepare(`SELECT record.current_version version FROM operations_directory_records record
            JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
            JOIN effective_native_directory_enrollments enrollment ON enrollment.record_id=record.record_id
            WHERE record.record_id=? AND record.record_kind='organization'`).bind(organizationRecordId).first<{ version: number }>();
          if (!parent || !Number.isSafeInteger(parent.version) || parent.version < 1)
            return { status: "blocked", reason: "client_relationship_parent_state" };
          organizationRecordVersion = parent.version;
        }
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
        LEFT JOIN effective_native_directory_enrollments parent_enrollment ON parent_enrollment.record_id=parent.record_id
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
    const enrollment = await db.prepare(`SELECT destinations_json FROM effective_native_directory_enrollments WHERE record_id=?`).bind(write.recordId).first<{ destinations_json: string }>();
    try { enrolled = enrollment ? JSON.parse(enrollment.destinations_json) as DestinationIdentity[] : []; } catch { enrolled = []; }
    const decisionScopedLocalUpdate = stagedOnboardingDecisionId !== null && write.destinations.length === 0;
    if (!Array.isArray(enrolled) || enrolled.length !== write.destinations.length
      || (enrolled.length < 1 && !decisionScopedLocalUpdate) || enrolled.length > 16)
      return { status: "blocked", reason: "enrollment_drift" };
    for (const value of write.destinations) {
      const snapshot = enrolled.find(item => destinationKey(item) === destinationKey(value));
      if (!snapshot || snapshot.historyEpoch !== value.historyEpoch || snapshot.origin !== value.origin)
        return { status: "blocked", reason: "enrollment_drift" };
      const state = await updateRemoteState(db, write, value, false, relationshipRecoveryEnabled);
      if (!state) return { status: "blocked", reason: "mapping_or_delivery_state" };
      // The immutable enrollment keeps the original Ops identity. Only a
      // currently active acquired mapping may resolve that snapshot to a
      // distinct PA external ID; legacy mappings still require exact equality.
      if (snapshot.externalCanonicalId !== value.externalCanonicalId
        && !(state.mappingKind === "acquired" && snapshot.externalCanonicalId === write.recordId))
        return { status: "blocked", reason: "enrollment_drift" };
      remote.set(destinationKey(value), state);
    }
  }
  const relationshipEvidence = new Map<string, RelationshipEvidence>();
  if (relationshipState) {
    for (const value of write.destinations) {
      const evidence = await linkedRelationshipEvidence(db, relationshipState, value, stagedOrganization);
      if (!evidence) return { status: "blocked", reason: "client_relationship_evidence" };
      relationshipEvidence.set(destinationKey(value), evidence);
    }
  }
  const nextVersion = write.expectedLocalVersion + 1, destinationsJson = JSON.stringify(enrolled);
  const commandIds = await Promise.all(write.destinations.map(value => commandId(write.mutationId, value)));
  const statements: D1PreparedStatement[] = [];
  statements.push(db.prepare(`INSERT INTO ${fenceTable}
    (mutation_id,operation_kind,actor_id,bound_access_subject,actor_admission_version,permission,record_id,record_kind,expected_version,
      create_admission_id,selected_grant_id,scopes_json,profile_json,command_json,destinations_json,intent_writes)
    VALUES(?,?,?,?,?,'directory.profile.edit',?,?,?,?,?,?,?,?,?,?)`).bind(write.mutationId, write.operation, actorId,
      actorSubject, (staffActor?.admissionVersion ?? 0), write.recordId, write.kind, write.expectedLocalVersion,
      write.createAdmissionId, (currentPortalActor?.grantId ?? staffActor!.selectedGrantId), scopesJson, profileJson, auditJson, destinationsJson, write.destinations.length));
  statements.push(write.operation === "create"
    ? db.prepare(`INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,?,1)`).bind(write.recordId, write.kind)
    : db.prepare(`UPDATE operations_directory_records SET current_version=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE record_id=? AND current_version=?`)
      .bind(nextVersion, write.recordId, write.expectedLocalVersion));
  statements.push(db.prepare(`INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,?,?,?)`).bind(write.recordId, nextVersion, write.mutationId, profileJson));
  statements.push(db.prepare(`INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json,original_verified_access_subject)
    VALUES(?,?,?,?,?,?,?,?)`).bind(`${write.mutationId}:audit`, write.mutationId, write.recordId, nextVersion, isPortal ? "system" : "staff", actorId, auditJson, actorSubject));
  const materializations: D1PreparedStatement[] = [];
  write.destinations.forEach((value, index) => {
    const intentId = `${write.mutationId}:intent:${index}`, state = remote.get(destinationKey(value));
    const evidence = relationshipEvidence.get(destinationKey(value));
    const externalCanonicalId = state?.externalId ?? value.externalCanonicalId;
    const fields = write.kind === "client" ? { ...write.profile, organizationPublicId: evidence?.parentPublicId ?? null } : write.profile;
    const materialized = write.operation === "create"
      ? { operation: "create", commandId: commandIds[index], resourceType: write.kind, externalId: write.recordId, expectedRevision: "0",
          expectedAuthorizationGeneration: value.expectedAuthorizationGeneration, fields, scopes: write.scopes }
      : { operation: "update", commandId: commandIds[index], resourceType: write.kind, externalId: state!.externalId,
          expectedProjectAlphaPublicId: state!.projectAlphaPublicId, expectedRevision: state!.revision,
          expectedAuthorizationGeneration: state!.authorizationGeneration, fields };
    const disposition = { kind: write.operation === "create" ? "authorized_create" : "existing", ...identity(value), externalCanonicalId,
      ...(state ? { projectAlphaPublicId: state.projectAlphaPublicId, projectAlphaRevision: state.revision } : {}) };
    statements.push(db.prepare(`INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,
      application_uuid,destination_origin,external_canonical_id,desired_payload_json,expected_history_epoch_id,state)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'waiting')`).bind(intentId, write.mutationId, write.recordId, nextVersion, value.sourceId,
      value.sourceInstanceUUID, value.applicationUUID, value.origin, externalCanonicalId, profileJson, value.historyEpoch));
    if (evidence?.evidenceKind !== "parent_intent" || evidence.parentPublicId !== null) {
      materializations.push(db.prepare(`UPDATE operations_directory_intents SET state='ready' WHERE intent_id=? AND state='waiting'`).bind(intentId));
      materializations.push(db.prepare(`INSERT INTO operations_directory_materializations(intent_id,command_id,command_json,origin_snapshot_json,disposition_json,next_attempt_at,history_epoch_id)
        VALUES(?,?,?,?,?,?,?)`).bind(intentId, commandIds[index], JSON.stringify(materialized),
        JSON.stringify({ actorId: actorId, authorityRevision: String(nextVersion), actorSubject: actorSubject }),
        JSON.stringify(disposition), Date.now(), value.historyEpoch));
    }
  });
  if (write.kind === "client") {
    if (write.operation === "create") {
      const verifiedUntil = new Date(Date.now() + 60_000).toISOString();
      statements.push(db.prepare(`INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,
        expected_relationship_version,previous_organization_record_id,organization_record_id,client_record_version,
        previous_organization_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,
        actor_admission_version,actor_profile_version,verified_until) VALUES(?,?,0,NULL,?,1,NULL,?,?,?,?,?,?,?)`)
        .bind(relationshipState!.relationshipMutationId, write.recordId, relationshipState!.organizationRecordId,
          relationshipState!.organizationRecordVersion, actorId, actorSubject, staffActor!.loginEmail,
          (staffActor?.admissionVersion ?? 0), staffActor!.profileVersion, verifiedUntil));
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
          evidence.parentExternalCanonicalId, evidence.evidenceKind, evidence.parentIntentId, evidence.parentMappingCommandId,
          evidence.parentActivationId, evidence.evidenceKind === "parent_intent" ? null : evidence.parentPublicId, evidence.parentAckRevision,
          evidence.parentAckCommandJson, evidence.parentAckOutcomeJson));
    });
  }
  statements.push(...materializations);
  statements.push(db.prepare(`DELETE FROM ${fenceTable} WHERE mutation_id=?`).bind(write.mutationId));
  return { status: "planned", outcome: { status: "written", replayed: false,
    mutationId: write.mutationId, recordId: write.recordId, kind: write.kind, version: nextVersion, commandIds }, statements };
}

async function executeNativeDirectoryProfileWrite(db: DirectoryWriteD1, input: NativeDirectoryProfileWrite,
  allowEmptyDestinations = false, stagedOnboardingDecisionId: string | null = null,
  stagedOrganization: StagedOrganization | null = null,
  relationshipRecoveryEnabled = false): Promise<NativeDirectoryProfileWriteOutcome> {
  const planned = await planNativeDirectoryProfileWriteInternal(db, input, allowEmptyDestinations,
    stagedOnboardingDecisionId, stagedOrganization, relationshipRecoveryEnabled);
  if (planned.status !== "planned") return planned;
  try { await db.batch([...planned.statements]); }
  catch { return { status: "blocked", reason: "authority_or_atomic_write" }; }
  return planned.outcome;
}

/** Normal profile routes always require PA destinations. */
export async function writeNativeDirectoryProfile(db: D1Database, input: NativeDirectoryProfileWrite,
  relationshipRecoveryEnabled = false): Promise<NativeDirectoryProfileWriteOutcome> {
  return executeNativeDirectoryProfileWrite(db, input, false, null, null, relationshipRecoveryEnabled);
}

export type NativeDirectorySharedProfileWrite = Readonly<{
  groupId: string; mutationId: string; expectedVersion: number; requestSha256: string;
  profile: Record<string, string>; writes: readonly NativeDirectoryUpdateWrite[]; identitySafeContactProfile?: boolean;
}>;
export type NativeDirectorySharedProfileWriteOutcome =
  | Readonly<{ status: "written"; replayed: boolean; version: number }>
  | Readonly<{ status: "blocked" | "conflict" | "rejected"; reason: string }>;

/** Both canonical member revisions and their PA intents commit with one shared
 * revision. Existing source identity, relationship and staff authority guards
 * remain in force for each private plan. No prepared statements escape. */
export async function writeNativeDirectorySharedProfiles(db: D1Database, input: NativeDirectorySharedProfileWrite,
  relationshipRecoveryEnabled = false): Promise<NativeDirectorySharedProfileWriteOutcome> {
  const writes = [...input.writes].sort((a, b) => a.recordId.localeCompare(b.recordId));
  if (writes.length < 1 || writes.length > 2 || new Set(writes.map(w => w.recordId)).size !== writes.length
    || writes.some(w => w.kind !== writes[0]!.kind || w.operation !== "update"
      || JSON.stringify(w.profile) !== JSON.stringify(input.profile)
      || w.actor.staffId !== writes[0]!.actor.staffId || w.actor.accessSubject !== writes[0]!.actor.accessSubject)
    || !/^[a-f0-9]{64}$/.test(input.requestSha256)) return { status: "rejected", reason: "shared_write_shape" };
  const session = db.withSession("first-primary");
  for (const write of writes) {
    const checked = normalize(write);
    if (!checked || !await authority(session, checked)
      || (checked.kind === "client" && !await authority(session, checked, "directory.identity.link", identityGrantId(checked.actor))))
      return { status: "blocked", reason: "shared_member_authority" };
  }
  const prior = await session.prepare(`SELECT request_sha256,expected_version,actor_id FROM native_directory_shared_profile_commands
    WHERE mutation_id=? AND group_id=?`).bind(input.mutationId, input.groupId)
    .first<{ request_sha256: string; expected_version: number; actor_id: string }>();
  if (prior) return prior.request_sha256 === input.requestSha256 && prior.expected_version === input.expectedVersion
    && prior.actor_id === writes[0]!.actor.staffId
    ? { status: "written", replayed: true, version: prior.expected_version + 1 }
    : { status: "conflict", reason: "idempotency_body_conflict" };
  const group = await session.prepare("SELECT kind,version,membership_json,profile_json FROM native_directory_shared_profiles WHERE id=?")
    .bind(input.groupId).first<{ kind: string; version: number; membership_json: string; profile_json: string }>();
  if (!group || group.version !== input.expectedVersion || group.kind !== writes[0]!.kind
    || group.membership_json !== JSON.stringify(writes.map(w => w.recordId)))
    return { status: "conflict", reason: "shared_profile_changed" };
  // PA's current profile command reconciles client login eligibility from the
  // contact email. Preserve identity/access until PA advertises a neutral path.
  if (group.kind === "client" && input.identitySafeContactProfile !== true && JSON.parse(group.profile_json).email !== input.profile.email)
    return { status: "blocked", reason: "client_contact_email_change_requires_identity_safe_pa" };
  const plans: NativeDirectoryProfileWritePlan[] = [];
  for (const write of writes) {
    const plan = await planNativeDirectoryProfileWriteInternal(session, write, false, null, null, relationshipRecoveryEnabled,
      { groupId: input.groupId, mutationId: input.mutationId, identitySafeContactProfile: input.identitySafeContactProfile === true, allowPortal: false });
    if (plan.status !== "planned") return plan.status === "written"
      ? { status: "conflict", reason: "shared_member_replay_without_group" } : plan;
    plans.push(plan);
  }
  const profileJson = JSON.stringify(input.profile), membersJson = JSON.stringify(writes.map(w => ({
    recordId: w.recordId, version: w.expectedLocalVersion, mutationId: w.mutationId })));
  try { await session.batch([
    session.prepare(`INSERT INTO native_directory_shared_profile_commands
      (mutation_id,group_id,expected_version,request_sha256,profile_json,members_json,actor_id,identity_safe_contact_profile) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(input.mutationId, input.groupId, input.expectedVersion, input.requestSha256, profileJson, membersJson, writes[0]!.actor.staffId,
        input.identitySafeContactProfile === true ? 1 : 0),
    session.prepare("UPDATE native_directory_shared_profiles SET version=version+1,profile_json=? WHERE id=? AND version=?")
      .bind(profileJson, input.groupId, input.expectedVersion),
    session.prepare("INSERT INTO native_directory_shared_profile_revisions(group_id,version,mutation_id,profile_json) VALUES(?,?,?,?)")
      .bind(input.groupId, input.expectedVersion + 1, input.mutationId, profileJson),
    ...plans.flatMap(p => [...p.statements]),
  ]); } catch { return { status: "blocked", reason: "shared_authority_or_atomic_write" }; }
  return { status: "written", replayed: false, version: input.expectedVersion + 1 };
}

/** Private portal composer. The verified portal fence and every member revision
 * are committed in the same transaction; portal actors never acquire staff grants. */
export async function writeNativeDirectorySharedPortalProfiles(db: D1Database, input: Readonly<{
  groupId: string; mutationId: string; expectedVersion: number; requestSha256: string;
  profile: Record<string, string>; writes: readonly NativeDirectoryPortalUpdateWrite[];
  authorityFence: D1PreparedStatement;
}>, relationshipRecoveryEnabled = false): Promise<NativeDirectorySharedProfileWriteOutcome> {
  const writes = [...input.writes].sort((a,b) => a.recordId.localeCompare(b.recordId));
  const first = writes[0];
  if (!UUID.test(input.groupId) || !UUID.test(input.mutationId) || !first || writes.length > 2
    || new Set(writes.map(w => w.recordId)).size !== writes.length || !/^[a-f0-9]{64}$/.test(input.requestSha256)
    || writes.some(w => w.kind !== first.kind || JSON.stringify(w.profile) !== JSON.stringify(input.profile)
      || JSON.stringify(w.actor) !== JSON.stringify(first.actor) || w.actor.groupId !== input.groupId
      || w.actor.sharedMutationId !== input.mutationId || w.actor.groupVersion !== input.expectedVersion))
    return {status:"rejected",reason:"shared_portal_write_shape"};
  const session=db.withSession("first-primary");
  const group=await session.prepare("SELECT kind,version,membership_json FROM native_directory_shared_profiles WHERE id=?")
    .bind(input.groupId).first<{kind:string;version:number;membership_json:string}>();
  if (!group || group.version!==input.expectedVersion || group.kind!==first.kind
    || group.membership_json!==JSON.stringify(writes.map(w=>w.recordId)))
    return {status:"conflict",reason:"shared_profile_changed"};
  const plans: NativeDirectoryProfileWritePlan[]=[];
  for(const write of writes){
    const plan=await planNativeDirectoryProfileWriteInternal(session,write,false,null,null,relationshipRecoveryEnabled,
      {groupId:input.groupId,mutationId:input.mutationId,identitySafeContactProfile:write.kind==="client",allowPortal:true});
    if(plan.status!=="planned")return plan.status==="written"
      ? {status:"conflict",reason:"shared_member_replay_without_group"}:plan;
    plans.push(plan);
  }
  const profileJson=JSON.stringify(input.profile),membersJson=JSON.stringify(writes.map(w=>({recordId:w.recordId,version:w.expectedLocalVersion,mutationId:w.mutationId})));
  try{await session.batch([
    input.authorityFence,
    session.prepare(`INSERT INTO native_directory_shared_profile_commands
      (mutation_id,group_id,expected_version,request_sha256,profile_json,members_json,actor_kind,actor_id,identity_safe_contact_profile)
      VALUES(?,?,?,?,?,?,'portal',?,?)`).bind(input.mutationId,input.groupId,input.expectedVersion,input.requestSha256,
        profileJson,membersJson,first.actor.actorId,first.kind==="client"?1:0),
    session.prepare("UPDATE native_directory_shared_profiles SET version=version+1,profile_json=? WHERE id=? AND version=?")
      .bind(profileJson,input.groupId,input.expectedVersion),
    session.prepare("INSERT INTO native_directory_shared_profile_revisions(group_id,version,mutation_id,profile_json) VALUES(?,?,?,?)")
      .bind(input.groupId,input.expectedVersion+1,input.mutationId,profileJson),
    ...plans.flatMap(p=>[...p.statements]),
    session.prepare(`INSERT INTO shared_profile_portal_audit(operation_id,grant_id,workspace_id,action,actor_kind,actor_id,detail_json)
      VALUES(?,?,?,'profile.updated','portal',?,?)`).bind(input.mutationId,first.actor.grantId,first.actor.workspaceId,
        first.actor.actorId,JSON.stringify({issuer:first.actor.issuer,subject:first.actor.subject,groupId:input.groupId,
          version:input.expectedVersion+1,requestSha256:input.requestSha256})),
  ]);}catch{return{status:"blocked",reason:"shared_portal_authority_or_atomic_write"};}
  return{status:"written",replayed:false,version:input.expectedVersion+1};
}

/**
 * Narrow planning policy for the private onboarding-decision composer.  This
 * is not a general source-less Directory write: the immutable decision id is
 * part of every new-record admission identity, and no destination may be
 * smuggled through this path.  The composer still has to establish the 0083
 * decision fence and exact admission in the same batch; without those rows the
 * database guards reject execution.
 */
export async function writeNativeOnlyClientOnboardingDecisionProfile(db: DirectoryWriteD1,
  decisionId: string, input: NativeDirectoryProfileWrite): Promise<NativeDirectoryProfileWriteOutcome> {
  if (!UUID.test(decisionId) || input.kind !== "client"
    || (input.operation === "create" && input.createAdmissionId !== `client-onboarding:${decisionId}:client`))
    return { status: "rejected", reason: "invalid_onboarding_decision_write" };
  return executeNativeDirectoryProfileWrite(db, input, true, decisionId);
}

/** Private organization-aware variant. A staged parent is accepted only for the
 * matching client in the same immutable onboarding decision transaction. */
export async function writeNativeOnlyOnboardingDecisionProfile(db: DirectoryWriteD1,
  decisionId: string, input: NativeDirectoryProfileWrite,
  stagedOrganization: StagedOrganization | null = null): Promise<NativeDirectoryProfileWriteOutcome> {
  if (!UUID.test(decisionId)
    || (input.operation === "create" && input.createAdmissionId !== `client-onboarding:${decisionId}:${input.kind}`)
    || (stagedOrganization !== null && (input.kind !== "client" || input.operation !== "create"
      || input.relationship.organizationRecordId !== stagedOrganization.recordId)))
    return { status: "rejected", reason: "invalid_onboarding_decision_write" };
  return executeNativeDirectoryProfileWrite(db, input, true, decisionId, stagedOrganization);
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
