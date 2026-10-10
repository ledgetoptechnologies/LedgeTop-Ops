import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { directoryMaterializationReadSource } from "./project-alpha-directory-materialization-read-source";
import { prepareDirectoryCreateGenerationRecovery } from "./project-alpha-directory-create-generation-recovery";
import {
  writeNativeDirectoryProfile,
  readNativeDirectoryDurableRemoteHead,
  type NativeDirectoryClientCreateProfile,
  type NativeDirectoryClientUpdateProfile,
  type NativeDirectoryDestinationAuthority,
  type NativeDirectoryOrganizationProfile,
  type NativeDirectoryProfileKind,
  type NativeDirectoryProfileWrite,
  type NativeDirectoryProfileWriteOutcome,
  type NativeDirectoryScope,
  type NativeDirectoryWriterActor,
} from "./native-directory-profile-writer";
import { readConfiguredProjectAlphaDirectoryInventory } from "./project-alpha-directory-inventory-api-v2";
import { readConfiguredProjectAlphaDirectoryBindingStatus } from "./project-alpha-directory-read-api-v2";
import { persistProjectAlphaDirectoryInventoryPage } from "./project-alpha-v2-sync";
import { listEnabledProjectAlphaApiV2SourceIds, resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { nativeDirectoryOrganizationChoices, type NativeDirectoryOrganizationChoice } from "./native-directory-profile-editor-record";
import { writeNativeDirectoryRelationship, type NativeDirectoryRelationshipWrite } from "./native-directory-relationship-writer";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const NATIVE_DIRECTORY_PROFILE_ROUTE = "/api/client-hub/directory";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,18})$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_BODY_BYTES = 24 * 1024;

const mutationId = z.string().regex(UUID);
const canonicalRecordId = z.string().min(1).max(191).refine(value => !/[\p{C}]/u.test(value)
  && new TextEncoder().encode(value).byteLength <= 764);
const sourceIds = z.array(z.string().regex(SOURCE_ID)).min(1).max(16)
  .refine(values => new Set(values).size === values.length);
const scalar = (maximum: number, required = false) => z.string().max(maximum)
  .refine(value => !/[\p{C}]/u.test(value))
  .refine(value => !required || value.length > 0);
const scope = z.object({ businessAreaId: scalar(191, true), divisionId: scalar(191, true).nullable() }).strict();
const scopes = z.array(scope).min(1).max(64)
  .refine(values => new Set(values.map(value => `${value.businessAreaId}\0${value.divisionId ?? ""}`)).size === values.length);
const organizationProfile = z.object({
  name: scalar(150, true), generalEmail: scalar(255), generalPhone: scalar(50), addressLine1: scalar(255),
  addressLine2: scalar(255), city: scalar(100), state: scalar(100), postalCode: scalar(32), country: scalar(100),
}).strict();
const clientCreateProfile = z.object({
  name: scalar(150, true), email: scalar(255), phone: scalar(50), clientType: z.enum(["unknown", "business", "consumer"]),
  addressLine1: scalar(255), addressLine2: scalar(255), city: scalar(100), state: scalar(2), postalCode: scalar(20), country: scalar(100),
}).strict();
const clientUpdateProfile = clientCreateProfile.omit({ clientType: true });
const relationshipChoice = z.object({ organizationRecordId: canonicalRecordId.nullable(), expectedOrganizationVersion: z.number().int().positive().nullable() })
  .strict().refine(value => (value.organizationRecordId === null) === (value.expectedOrganizationVersion === null));
const organizationCreate = z.object({ mutationId, sourceIds, scopes, profile: organizationProfile }).strict();
const clientCreate = z.object({ mutationId, sourceIds, scopes, profile: clientCreateProfile, relationship: relationshipChoice }).strict();
const createAdmissionIntent = z.discriminatedUnion("kind", [
  organizationCreate.extend({ kind: z.literal("organization") }).strict(),
  clientCreate.extend({ kind: z.literal("client") }).strict(),
]);
const organizationUpdate = z.object({ mutationId, expectedLocalVersion: z.number().int().positive(), profile: organizationProfile }).strict();
const clientUpdate = z.object({ mutationId, expectedLocalVersion: z.number().int().positive(), profile: clientUpdateProfile }).strict();
const relationshipMutation = z.object({ mutationId, expectedRelationshipVersion: z.number().int().positive(), organization: z.object({
  recordId: canonicalRecordId, expectedVersion: z.number().int().positive(),
}).strict().nullable() }).strict();
const relationshipRecoveryMutation = relationshipMutation.extend({
  expectedTerminalCommandIds: z.array(mutationId).min(1).max(16)
    .refine(values => new Set(values).size === values.length),
}).strict();

type StoredDestination = Omit<NativeDirectoryDestinationAuthority, "expectedAuthorizationGeneration">;
type StoredCreateAdmission = {
  id: string; staff_id: string; bound_access_subject: string; record_id: string; record_kind: string;
  scopes_json: string; profile_json: string; destinations_json: string; active: number;
  consumed_mutation_id: string | null; issued_by: string;
};
type CurrentClientRelationship = { organization_record_id: string | null; relationship_version: number;
  client_version: number; organization_version: number | null };
type StoredAdmissionRelationship = { organization_record_id: string | null; organization_record_version: number | null };

export function nativeDirectoryProfileWritesEnabled(env: Pick<Env, "NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED">): boolean {
  return env.NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED === "true";
}

function recordId(kind: NativeDirectoryProfileKind, id: string): string {
  return id;
}

function normalizeProfile(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([field, item]) => {
    const normalized = item.normalize("NFC").trim();
    return [field, field === "email" || field === "generalEmail" ? normalized.toLowerCase() : normalized];
  }));
}

export type NativeDirectoryClientProfileSnapshot = Readonly<{
  version: number;
  profile: NativeDirectoryClientCreateProfile;
}>;

/** Reconstructs the complete client editor snapshot from the current immutable
 * revision and the creation revision that owns the immutable client type. */
export async function readNativeDirectoryClientProfileSnapshot(
  db: D1Database,
  clientRecordId: string,
): Promise<NativeDirectoryClientProfileSnapshot | null> {
  const rows = (await db.withSession("first-primary").prepare(`SELECT record.current_version version,
      current.profile_json currentProfileJson,created.profile_json creationProfileJson
    FROM operations_directory_records record
    JOIN operations_directory_revisions current ON current.record_id=record.record_id
      AND current.version=record.current_version
    JOIN operations_directory_revisions created ON created.record_id=record.record_id AND created.version=1
    WHERE record.record_id=? AND record.record_kind='client'
    LIMIT 2`).bind(clientRecordId).all<{
      version: number; currentProfileJson: string; creationProfileJson: string;
    }>()).results;
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0]!.version) || rows[0]!.version < 1) return null;
  const row = rows[0]!;
  let currentValue: unknown, creationValue: unknown;
  try {
    currentValue = JSON.parse(row.currentProfileJson);
    creationValue = JSON.parse(row.creationProfileJson);
  } catch { return null; }
  const creation = clientCreateProfile.safeParse(creationValue);
  const currentCreate = clientCreateProfile.safeParse(currentValue);
  const currentUpdate = clientUpdateProfile.safeParse(currentValue);
  const current = row.version === 1 ? currentCreate : currentUpdate.success ? currentUpdate : currentCreate;
  if (!creation.success || !current.success) return null;
  const canonicalCreation = normalizeProfile(creation.data);
  const canonicalCurrent = normalizeProfile(current.data);
  if (Object.keys(creation.data).some(field => creation.data[field as keyof typeof creation.data] !== canonicalCreation[field])
    || Object.keys(current.data).some(field => current.data[field as keyof typeof current.data] !== canonicalCurrent[field])) return null;
  if (row.version === 1 && JSON.stringify(current.data) !== JSON.stringify(creation.data)) return null;
  if ("clientType" in current.data && current.data.clientType !== creation.data.clientType) return null;
  return { version: row.version, profile: { ...current.data, clientType: creation.data.clientType } };
}

function normalizeScopes(values: readonly NativeDirectoryScope[]): NativeDirectoryScope[] {
  return values.map(value => ({ ...value })).sort((left, right) =>
    `${left.businessAreaId}\0${left.divisionId ?? ""}`.localeCompare(`${right.businessAreaId}\0${right.divisionId ?? ""}`));
}

async function nativeActor(c: AppContext): Promise<Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">> {
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try {
    authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB, {
      enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD,
    });
  } catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
  const principal = c.get("principal"), identity = authenticated.identity;
  if (identity.staffId !== principal.id || identity.email !== principal.email
    || identity.verifiedAccessSubject !== principal.accessSubject)
    throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
  return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject,
    admissionVersion: authenticated.admissionVersion, loginEmail: identity.email, profileVersion: identity.profileVersion };
}

export async function selectGrant(db: D1Database, staffId: string,
  permission: "directory.profile.view" | "directory.profile.edit" | "directory.identity.link" | "directory.enrollment.manage",
  record: string, requestedScopes: readonly NativeDirectoryScope[], creating: boolean): Promise<string | null> {
  const primary = db.withSession("first-primary"), scopeJson = JSON.stringify(requestedScopes);
  const applies = creating ? `(grant.scope_kind='global'
      OR (grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM json_each(?) scope
        WHERE json_extract(scope.value,'$.businessAreaId')=grant.business_area_id))
      OR (grant.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(?) scope
        WHERE json_extract(scope.value,'$.divisionId')=grant.division_id)))`
    : `(grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=?)
      OR (grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
        WHERE assignment.record_id=? AND assignment.staff_id=? AND assignment.active=1))
      OR (grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        WHERE scope.record_id=? AND scope.active=1 AND scope.business_area_id=grant.business_area_id))
      OR (grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
        WHERE scope.record_id=? AND scope.active=1 AND scope.division_id=grant.division_id)))`;
  const denyApplies = creating ? `(deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=?)
      OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM json_each(?) scope
        WHERE json_extract(scope.value,'$.businessAreaId')=deny.business_area_id))
      OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(?) scope
        WHERE json_extract(scope.value,'$.divisionId')=deny.division_id)))`
    : applies.replaceAll("grant.", "deny.");
  const parameters = creating ? [scopeJson, scopeJson] : [record, record, staffId, record, record];
  const denyParameters = creating ? [record, scopeJson, scopeJson] : parameters;
  const row = await primary.prepare(`SELECT grant.id FROM native_directory_grants grant
    WHERE grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1 AND ${applies}
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=grant.staff_id
        AND deny.permission=grant.permission AND deny.effect='deny' AND deny.active=1 AND ${denyApplies})
    ORDER BY CASE grant.scope_kind WHEN 'resource' THEN 1 WHEN 'division' THEN 2 WHEN 'business_area' THEN 3
      WHEN 'assigned' THEN 4 ELSE 5 END,grant.id LIMIT 1`).bind(staffId, permission, ...parameters, ...denyParameters)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function configuredDestination(env: Env, sourceId: string, externalCanonicalId: string): Promise<StoredDestination | null> {
  try {
    const configured = resolveProjectAlphaApiV2Connection(env, sourceId);
    if (!configured.enabled || !listEnabledProjectAlphaApiV2SourceIds(env).includes(sourceId)
      || !configured.connection.expectedHistoryEpoch
      || !UUID.test(configured.connection.expectedHistoryEpoch)) return null;
    return { sourceId, sourceInstanceUUID: configured.connection.expectedSourceInstanceId,
      applicationUUID: configured.connection.expectedApplicationId, historyEpoch: configured.connection.expectedHistoryEpoch,
      origin: configured.connection.baseUrl, externalCanonicalId };
  } catch { return null; }
}

function storedDestination(value: unknown, expectedExternalId: string | null): StoredDestination | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const fields = ["sourceId", "sourceInstanceUUID", "applicationUUID", "historyEpoch", "origin", "externalCanonicalId"];
  if (Object.keys(row).length !== fields.length || !fields.every(field => Object.hasOwn(row, field))
    || typeof row.sourceId !== "string" || !SOURCE_ID.test(row.sourceId)
    || typeof row.sourceInstanceUUID !== "string" || !UUID.test(row.sourceInstanceUUID)
    || typeof row.applicationUUID !== "string" || !UUID.test(row.applicationUUID)
    || typeof row.historyEpoch !== "string" || !UUID.test(row.historyEpoch)
    || typeof row.origin !== "string" || typeof row.externalCanonicalId !== "string"
    || row.externalCanonicalId.length < 1 || row.externalCanonicalId.length > 191
    || (expectedExternalId !== null && row.externalCanonicalId !== expectedExternalId)) return null;
  try { if (new URL(row.origin).origin !== row.origin || !row.origin.startsWith("https://")) return null; }
  catch { return null; }
  return row as StoredDestination;
}

async function liveGeneration(env: Env, destination: StoredDestination): Promise<string | null> {
  const outcome = await readConfiguredProjectAlphaDirectoryInventory(env, destination.sourceId,
    { type: "all", limit: 1 });
  if (outcome.status !== "observed" || outcome.inventory.sourceInstanceId !== destination.sourceInstanceUUID
    || outcome.inventory.applicationId !== destination.applicationUUID
    || outcome.inventory.historyEpoch !== destination.historyEpoch
    || !REVISION.test(outcome.inventory.authorizationGeneration)) return null;
  const persisted = await persistProjectAlphaDirectoryInventoryPage(env.OPS_DB, outcome.inventory, null);
  return persisted.status === "persisted" && persisted.continuationIdentity.authorizationGeneration === outcome.inventory.authorizationGeneration
    ? outcome.inventory.authorizationGeneration : null;
}

async function admittedCreate(env: Env, actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  kind: NativeDirectoryProfileKind, record: string, profile: Record<string, string>, requestedScopes: readonly NativeDirectoryScope[],
  selectedSources: readonly string[]): Promise<{ createAdmissionId: string; destinations: NativeDirectoryDestinationAuthority[] } | null> {
  const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT id,destinations_json FROM native_directory_create_admissions
    WHERE staff_id=? AND bound_access_subject=? AND record_id=? AND record_kind=? AND active=1
      AND consumed_mutation_id IS NULL AND json(scopes_json)=json(?) AND json(profile_json)=json(?) LIMIT 1`)
    .bind(actor.staffId, actor.accessSubject, record, kind, JSON.stringify(requestedScopes), JSON.stringify(profile))
    .first<{ id: string; destinations_json: string }>();
  let stored: unknown;
  try { stored = row ? JSON.parse(row.destinations_json) : null; } catch { return null; }
  if (!row || !Array.isArray(stored) || stored.length < 1 || stored.length > 16) return null;
  const admitted: StoredDestination[] = [];
  for (const value of stored) {
    const selected = storedDestination(value, record);
    if (!selected) return null;
    admitted.push(selected);
  }
  if (JSON.stringify(admitted.map(value => value.sourceId).sort()) !== JSON.stringify([...selectedSources].sort())) return null;
  const destinations: NativeDirectoryDestinationAuthority[] = [];
  for (const selected of admitted.sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
    const configured = await configuredDestination(env, selected.sourceId, record);
    if (!configured || JSON.stringify(configured) !== JSON.stringify(selected)) return null;
    const expectedAuthorizationGeneration = await liveGeneration(env, selected);
    if (!expectedAuthorizationGeneration) return null;
    destinations.push({ ...selected, expectedAuthorizationGeneration });
  }
  return { createAdmissionId: row.id, destinations };
}

function createAdmissionId(record: string): string {
  return `native-directory-create:${record}`;
}

async function storedCreateAdmission(db: D1Database, record: string): Promise<StoredCreateAdmission | null> {
  return db.withSession("first-primary").prepare(`SELECT id,staff_id,bound_access_subject,record_id,record_kind,
      scopes_json,profile_json,destinations_json,active,consumed_mutation_id,issued_by
    FROM native_directory_create_admissions WHERE record_id=?`).bind(record).first<StoredCreateAdmission>();
}

async function storedAdmissionRelationship(db: D1Database, admissionId: string): Promise<StoredAdmissionRelationship | null> {
  return db.withSession("first-primary").prepare(`SELECT organization_record_id,organization_record_version
    FROM native_directory_create_admission_relationships WHERE create_admission_id=?`).bind(admissionId)
    .first<StoredAdmissionRelationship>();
}

function exactAdmissionRelationship(row: StoredAdmissionRelationship | null,
  relationship: z.infer<typeof relationshipChoice>): boolean {
  return !!row && row.organization_record_id === relationship.organizationRecordId
    && row.organization_record_version === relationship.expectedOrganizationVersion;
}

function exactCreateAdmission(row: StoredCreateAdmission,
  actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  kind: NativeDirectoryProfileKind, record: string, profile: Record<string, string>, requestedScopes: readonly NativeDirectoryScope[],
  selectedSources: readonly string[], expectedDestinations?: readonly StoredDestination[]): boolean {
  let storedProfile: unknown, storedScopes: unknown, storedDestinations: unknown;
  try {
    storedProfile = JSON.parse(row.profile_json); storedScopes = JSON.parse(row.scopes_json);
    storedDestinations = JSON.parse(row.destinations_json);
  } catch { return false; }
  if (!Array.isArray(storedDestinations)) return false;
  const destinations = storedDestinations.map(value => storedDestination(value, record));
  if (destinations.some(value => value === null)) return false;
  const exactSources = JSON.stringify(destinations.map(value => value!.sourceId).sort()) === JSON.stringify([...selectedSources].sort());
  return row.id === createAdmissionId(record) && row.staff_id === actor.staffId
    && row.bound_access_subject === actor.accessSubject && row.record_id === record && row.record_kind === kind
    && row.issued_by === actor.staffId && row.active === 1 && row.consumed_mutation_id === null
    && JSON.stringify(storedProfile) === JSON.stringify(profile)
    && JSON.stringify(storedScopes) === JSON.stringify(requestedScopes) && exactSources
    && (expectedDestinations === undefined
      || JSON.stringify(destinations) === JSON.stringify(expectedDestinations));
}

async function requestedCreateDestinations(env: Env, selectedSources: readonly string[], record: string): Promise<StoredDestination[] | null> {
  const destinations: StoredDestination[] = [];
  for (const sourceId of selectedSources) {
    const destination = await configuredDestination(env, sourceId, record);
    if (!destination) return null;
    destinations.push(destination);
  }
  return destinations;
}

async function updateDestinations(env: Env, kind: NativeDirectoryProfileKind, record: string,
  expectedLocalVersion: number): Promise<NativeDirectoryDestinationAuthority[] | null> {
  const enrollment = await env.OPS_DB.withSession("first-primary").prepare(`SELECT destinations_json FROM native_directory_enrollments WHERE record_id=?`)
    .bind(record).first<{ destinations_json: string }>();
  let values: unknown;
  try { values = enrollment ? JSON.parse(enrollment.destinations_json) : null; } catch { return null; }
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) return null;
  const destinations: NativeDirectoryDestinationAuthority[] = [];
  for (const value of values) {
    const enrolled = storedDestination(value, record);
    if (!enrolled) return null;
    const configured = await configuredDestination(env, enrolled.sourceId, record);
    if (!configured || JSON.stringify(configured) !== JSON.stringify(enrolled)) return null;
    const expectedAuthorizationGeneration = await liveGeneration(env, enrolled);
    if (!expectedAuthorizationGeneration) return null;
    const durable = await readNativeDirectoryDurableRemoteHead(env.OPS_DB, kind, record, expectedLocalVersion, enrolled,
      env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED === "true");
    if (!durable) return null;
    const binding = await readConfiguredProjectAlphaDirectoryBindingStatus(env, enrolled.sourceId, kind,
      durable.externalCanonicalId, durable.projectAlphaPublicId);
    if (binding.status !== "observed"
      || binding.observation.authorizationGeneration !== expectedAuthorizationGeneration
      || binding.observation.resource.revision !== durable.revision) return null;
    destinations.push({ ...enrolled, externalCanonicalId: durable.externalCanonicalId, expectedAuthorizationGeneration });
  }
  return destinations;
}

async function currentClientRelationship(db: D1Database, record: string): Promise<CurrentClientRelationship | null> {
  const row = await db.withSession("first-primary").prepare(`SELECT relationship.organization_record_id,
      relationship.relationship_version,client.current_version client_version,parent.current_version organization_version
    FROM operations_directory_client_organizations relationship
    JOIN operations_directory_records client ON client.record_id=relationship.client_record_id AND client.record_kind='client'
    LEFT JOIN operations_directory_records parent ON parent.record_id=relationship.organization_record_id AND parent.record_kind='organization'
    WHERE relationship.client_record_id=?`).bind(record).first<CurrentClientRelationship>();
  return row && Number.isSafeInteger(row.relationship_version) && row.relationship_version >= 1
    && Number.isSafeInteger(row.client_version) && row.client_version >= 1
    && (row.organization_record_id === null || (canonicalRecordId.safeParse(row.organization_record_id).success
      && Number.isSafeInteger(row.organization_version) && row.organization_version !== null && row.organization_version >= 1)) ? row : null;
}

async function enrollmentSourceIds(env: Env, record: string): Promise<string[] | null> {
  const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT destinations_json
    FROM native_directory_enrollments WHERE record_id=?`).bind(record).first<{ destinations_json: string }>();
  let values: unknown;
  try { values = row ? JSON.parse(row.destinations_json) : null; } catch { return null; }
  if (!Array.isArray(values) || values.length < 1 || values.length > 16) return null;
  const result: string[] = [];
  for (const value of values) {
    const destination = storedDestination(value, record);
    if (!destination) return null;
    const configured = await configuredDestination(env, destination.sourceId, record);
    if (!configured || JSON.stringify(configured) !== JSON.stringify(destination)) return null;
    result.push(destination.sourceId);
  }
  return new Set(result).size === result.length ? result.sort() : null;
}

async function relationshipDeliverySettled(db: D1Database, record: string, relationshipVersion: number,
  destinationCount: number, recoveryEnabled = false): Promise<boolean> {
  if (relationshipVersion === 1) return true;
  const recovery = recoveryEnabled ? ` OR EXISTS(SELECT 1
      FROM project_alpha_directory_validated_recovery_relationship_acknowledgements recovery
      WHERE recovery.predecessor_command_id=normal.command_id AND recovery.client_record_id=normal.client_record_id
        AND recovery.relationship_version=normal.relationship_version AND recovery.source_id=normal.source_id
        AND recovery.source_instance_id=normal.source_instance_id AND recovery.application_id=normal.application_id
        AND recovery.history_epoch_id=normal.history_epoch_id AND recovery.destination_origin=normal.destination_origin
        AND recovery.identity_valid=1)` : "";
  const row = await db.withSession("first-primary").prepare(`SELECT count(*) total,
      sum(CASE WHEN normal.state='acknowledged'${recovery} THEN 1 ELSE 0 END) acknowledged
    FROM project_alpha_directory_relationship_outbox normal WHERE normal.client_record_id=? AND normal.relationship_version=?`)
    .bind(record, relationshipVersion).first<{ total: number; acknowledged: number }>();
  return !!row && row.total === destinationCount && row.acknowledged === destinationCount;
}

async function relationshipRecoveryCapability(c: AppContext, record: string, relationshipVersion: number,
  enrolledSourceIds: readonly string[], settled: boolean): Promise<{ available: true; status: "needs_review";
    sourceIds: readonly string[] } | null> {
  if (c.env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED !== "true"
    || !c.get("administrator") || settled || enrolledSourceIds.length === 0) return null;
  const placeholders = enrolledSourceIds.map(() => "?").join(",");
  const rows = (await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT DISTINCT source_id
    FROM project_alpha_directory_relationship_outbox
    WHERE client_record_id=? AND relationship_version=? AND action='assign' AND state='terminal'
      AND source_id IN (${placeholders}) AND json_extract(outcome_json,'$.httpStatus')=409
    ORDER BY source_id`).bind(record, relationshipVersion, ...enrolledSourceIds)
    .all<{ source_id: string }>()).results;
  const sourceIds = rows.map(row => row.source_id).filter(sourceId => enrolledSourceIds.includes(sourceId));
  return sourceIds.length > 0 && new Set(sourceIds).size === sourceIds.length
    ? { available: true, status: "needs_review", sourceIds } : null;
}

function writeRelationship(c: AppContext, input: NativeDirectoryRelationshipWrite) {
  return c.env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED === "true"
    ? writeNativeDirectoryRelationship(c.env.OPS_DB, input, true)
    : writeNativeDirectoryRelationship(c.env.OPS_DB, input);
}

function writeProfile(c: AppContext, input: NativeDirectoryProfileWrite) {
  return c.env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED === "true"
    ? writeNativeDirectoryProfile(c.env.OPS_DB, input, true)
    : writeNativeDirectoryProfile(c.env.OPS_DB, input);
}

function sameSources(choice: NativeDirectoryOrganizationChoice, selectedSources: readonly string[]): boolean {
  return selectedSources.length > 0 && new Set(selectedSources).size === selectedSources.length
    && selectedSources.every(sourceId => choice.sourceIds.includes(sourceId));
}

async function selectableOrganization(c: AppContext, actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  recordId: string, expectedVersion: number, selectedSources?: readonly string[]): Promise<NativeDirectoryOrganizationChoice | null> {
  const choice = (await nativeDirectoryOrganizationChoices(c.env)).find(value => value.recordId === recordId
    && value.expectedVersion === expectedVersion && (selectedSources === undefined || sameSources(value, selectedSources)));
  if (!choice) return null;
  for (const permission of ["directory.profile.edit", "directory.identity.link"] as const)
    if (!await selectGrant(c.env.OPS_DB, actor.staffId, permission, recordId, [], false)) return null;
  return choice;
}

async function organizationChoicesForActor(c: AppContext,
  actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  selectedSources?: readonly string[]): Promise<NativeDirectoryOrganizationChoice[]> {
  const result: NativeDirectoryOrganizationChoice[] = [];
  for (const choice of await nativeDirectoryOrganizationChoices(c.env)) {
    if (selectedSources !== undefined && !sameSources(choice, selectedSources)) continue;
    let allowed = true;
    for (const permission of ["directory.profile.edit", "directory.identity.link"] as const)
      if (!await selectGrant(c.env.OPS_DB, actor.staffId, permission, choice.recordId, [], false)) { allowed = false; break; }
    if (allowed) result.push(choice);
  }
  return result;
}

async function publicResult(c: AppContext, outcome: Awaited<ReturnType<typeof writeNativeDirectoryProfile>>) {
  if (outcome.status !== "written") {
    if (outcome.status === "rejected") return c.json({ status: "invalid_request" }, 400);
    if (outcome.status === "conflict") return c.json({ status: "conflict", reason: outcome.reason }, 409);
    return c.json({ status: "conflict", reason: "directory_write_blocked" }, 409);
  }
  const destinations = [] as { sourceId: string; state: "pending" | "acknowledged" | "conflict" }[];
  for (const commandId of outcome.commandIds) {
    const row = await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT source_id,state FROM project_alpha_directory_outbox WHERE command_id=?`)
      .bind(commandId).first<{ source_id: string; state: string }>();
    if (!row) return c.json({ status: "conflict", reason: "destination_state_unavailable" }, 409);
    destinations.push({ sourceId: row.source_id, state: row.state === "acknowledged" ? "acknowledged"
      : row.state === "terminal" || row.state === "dead_letter" ? "conflict" : "pending" });
  }
  if (destinations.some(value => value.state === "conflict"))
    return c.json({ status: "conflict", reason: "destination_conflict", recordId: outcome.recordId,
      kind: outcome.kind, version: outcome.version, destinations }, 409);
  return c.json({ status: destinations.every(value => value.state === "acknowledged") ? "written" : "pending",
    recordId: outcome.recordId, kind: outcome.kind, version: outcome.version, replayed: outcome.replayed, destinations },
  destinations.every(value => value.state === "acknowledged") ? 200 : 202);
}

async function publicRelationshipResult(c: AppContext, outcome: Awaited<ReturnType<typeof writeNativeDirectoryRelationship>>) {
  if (outcome.status !== "written") {
    if (outcome.status === "rejected") return c.json({ status: "invalid_request", reason: outcome.reason }, 400);
    return c.json({ status: "conflict", reason: outcome.reason }, 409);
  }
  const destinations: Array<{ sourceId: string; state: "pending" | "acknowledged" | "conflict" }> = [];
  for (const reservation of outcome.reservations) {
    const state = await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT state
      FROM project_alpha_directory_relationship_outbox WHERE command_id=?`).bind(reservation.commandId)
      .first<string>("state");
    if (!state) return c.json({ status: "conflict", reason: "destination_state_unavailable" }, 409);
    destinations.push({ sourceId: reservation.sourceId, state: state === "acknowledged" ? "acknowledged"
      : state === "terminal" ? "conflict" : "pending" });
  }
  const response = { status: destinations.every(value => value.state === "acknowledged") ? "written" : "pending",
    mutationId: outcome.mutationId, relationshipVersion: outcome.relationshipVersion, replayed: outcome.replayed, destinations };
  return destinations.some(value => value.state === "conflict")
    ? c.json({ ...response, status: "conflict", reason: "destination_conflict" }, 409)
    : c.json(response, response.status === "written" ? 200 : 202);
}

async function relationshipReplay(c: AppContext, actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  clientRecordId: string, input: z.infer<typeof relationshipMutation>,
  expectedTerminalCommandIds: readonly string[] = []): Promise<NativeDirectoryRelationshipWrite | null | "conflict"> {
  const rows = (await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT request_json FROM project_alpha_directory_relationship_outbox
    WHERE mutation_id=? ORDER BY command_id LIMIT 17`).bind(input.mutationId).all<{ request_json: string }>()).results;
  if (!rows.length) return null;
  if (rows.length > 16 || rows.some(row => row.request_json !== rows[0]!.request_json)) return "conflict";
  let replay: NativeDirectoryRelationshipWrite;
  try { replay = JSON.parse(rows[0]!.request_json) as NativeDirectoryRelationshipWrite; } catch { return "conflict"; }
  if (replay.mutationId !== input.mutationId || replay.clientRecordId !== clientRecordId
    || replay.expectedRelationshipVersion !== input.expectedRelationshipVersion
    || replay.organization?.recordId !== input.organization?.recordId
    || replay.organization?.expectedRecordVersion !== input.organization?.expectedVersion
    || replay.actor.staffId !== actor.staffId || replay.actor.accessSubject !== actor.accessSubject
    || replay.actor.email !== actor.loginEmail || replay.actor.admissionVersion !== actor.admissionVersion
    || replay.actor.profileVersion !== actor.profileVersion
    || JSON.stringify([...(replay.supersedeTerminalCommandIds ?? [])].sort())
      !== JSON.stringify([...expectedTerminalCommandIds].sort())) return "conflict";
  return replay;
}

async function immediateTerminalPredecessors(env: Env, clientRecordId: string,
  expectedRelationshipVersion: number): Promise<string[] | null> {
  const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT destinations_json
    FROM native_directory_enrollments WHERE record_id=?`).bind(clientRecordId).first<{ destinations_json: string }>();
  let stored: unknown;
  try { stored = row ? JSON.parse(row.destinations_json) : null; } catch { return null; }
  if (!Array.isArray(stored) || stored.length < 1 || stored.length > 16) return null;
  const commandIds: string[] = [];
  for (const value of stored) {
    const destination = storedDestination(value, clientRecordId);
    if (!destination) return null;
    const configured = await configuredDestination(env, destination.sourceId, clientRecordId);
    if (!configured || JSON.stringify(configured) !== JSON.stringify(destination)) return null;
    const predecessor = await env.OPS_DB.withSession("first-primary").prepare(`SELECT command_id,state
      FROM project_alpha_directory_relationship_outbox
      WHERE client_record_id=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
        AND relationship_version<? ORDER BY relationship_version DESC,command_id DESC LIMIT 1`)
      .bind(clientRecordId, destination.sourceId, destination.sourceInstanceUUID, destination.applicationUUID,
        destination.historyEpoch, expectedRelationshipVersion + 1).first<{ command_id: string; state: string }>();
    if (!predecessor || (predecessor.state !== "acknowledged" && predecessor.state !== "terminal")) return null;
    if (predecessor.state === "terminal") commandIds.push(predecessor.command_id);
  }
  return commandIds.length > 0 && new Set(commandIds).size === commandIds.length ? commandIds.sort() : null;
}

async function requireRelationshipGrants(c: AppContext,
  actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">, resources: readonly string[]): Promise<void> {
  for (const resource of new Set(resources)) for (const permission of ["directory.profile.edit", "directory.identity.link"] as const)
    if (!await selectGrant(c.env.OPS_DB, actor.staffId, permission, resource, [], false))
      throw new HTTPException(403, { message: "Directory relationship permission required" });
}

async function mutateRelationship(c: AppContext) {
  const input = await parsed(c.req.raw, relationshipMutation);
  if (c.req.header("Idempotency-Key") !== input.mutationId)
    throw new HTTPException(400, { message: "Idempotency-Key must match mutationId" });
  const checkedRecordId = canonicalRecordId.safeParse(c.req.param("recordId"));
  if (!checkedRecordId.success) throw new HTTPException(404, { message: "Directory record not found" });
  const clientRecordId = checkedRecordId.data;
  const actor = await nativeActor(c), replay = await relationshipReplay(c, actor, clientRecordId, input);
  if (replay === "conflict") return c.json({ status: "conflict", reason: "idempotency_body_conflict" }, 409);
  if (replay) {
    await requireRelationshipGrants(c, actor, [clientRecordId, ...(replay.previousOrganization ? [replay.previousOrganization.recordId] : []),
      ...(replay.organization ? [replay.organization.recordId] : [])]);
    return publicRelationshipResult(c, await writeRelationship(c, replay));
  }
  const current = await currentClientRelationship(c.env.OPS_DB, clientRecordId);
  if (!current || current.relationship_version !== input.expectedRelationshipVersion)
    return c.json({ status: "conflict", reason: "stale_relationship" }, 409);
  const resources = [clientRecordId, ...(current.organization_record_id ? [current.organization_record_id] : []),
    ...(input.organization ? [input.organization.recordId] : [])];
  await requireRelationshipGrants(c, actor, resources);
  if (input.organization && !await selectableOrganization(c, actor, input.organization.recordId, input.organization.expectedVersion))
    return c.json({ status: "conflict", reason: "organization_relationship_unavailable" }, 409);
  const previousOrganization = current.organization_record_id ? { recordId: current.organization_record_id,
    expectedRecordVersion: current.organization_version! } : null;
  const organization = input.organization ? { recordId: input.organization.recordId,
    expectedRecordVersion: input.organization.expectedVersion } : null;
  if (previousOrganization?.recordId === organization?.recordId)
    return c.json({ status: "invalid_request", reason: "no_change" }, 400);
  return publicRelationshipResult(c, await writeRelationship(c, {
    mutationId: input.mutationId, clientRecordId, expectedRelationshipVersion: input.expectedRelationshipVersion,
    expectedClientRecordVersion: current.client_version, previousOrganization, organization,
    actor: { staffId: actor.staffId, accessSubject: actor.accessSubject, email: actor.loginEmail,
      admissionVersion: actor.admissionVersion, profileVersion: actor.profileVersion },
  }));
}

async function recoverRelationship(c: AppContext) {
  if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator authority required" });
  const input = await parsed(c.req.raw, relationshipRecoveryMutation);
  if (c.req.header("Idempotency-Key") !== input.mutationId)
    throw new HTTPException(400, { message: "Idempotency-Key must match mutationId" });
  const checkedRecordId = canonicalRecordId.safeParse(c.req.param("recordId"));
  if (!checkedRecordId.success) throw new HTTPException(404, { message: "Directory record not found" });
  const clientRecordId = checkedRecordId.data, actor = await nativeActor(c);
  const replay = await relationshipReplay(c, actor, clientRecordId, input, input.expectedTerminalCommandIds);
  if (replay === "conflict") return c.json({ status: "conflict", reason: "idempotency_body_conflict" }, 409);
  if (replay) {
    await requireRelationshipGrants(c, actor, [clientRecordId, ...(replay.previousOrganization ? [replay.previousOrganization.recordId] : []),
      ...(replay.organization ? [replay.organization.recordId] : [])]);
    return publicRelationshipResult(c, await writeRelationship(c, replay));
  }
  const current = await currentClientRelationship(c.env.OPS_DB, clientRecordId);
  if (!current || current.relationship_version !== input.expectedRelationshipVersion)
    return c.json({ status: "conflict", reason: "stale_relationship" }, 409);
  const terminalCommandIds = await immediateTerminalPredecessors(c.env, clientRecordId, input.expectedRelationshipVersion);
  if (!terminalCommandIds || JSON.stringify(terminalCommandIds) !== JSON.stringify([...input.expectedTerminalCommandIds].sort()))
    return c.json({ status: "conflict", reason: "terminal_predecessor" }, 409);
  const resources = [clientRecordId, ...(current.organization_record_id ? [current.organization_record_id] : []),
    ...(input.organization ? [input.organization.recordId] : [])];
  await requireRelationshipGrants(c, actor, resources);
  if (input.organization && !await selectableOrganization(c, actor, input.organization.recordId, input.organization.expectedVersion))
    return c.json({ status: "conflict", reason: "organization_relationship_unavailable" }, 409);
  const previousOrganization = current.organization_record_id ? { recordId: current.organization_record_id,
    expectedRecordVersion: current.organization_version! } : null;
  const organization = input.organization ? { recordId: input.organization.recordId,
    expectedRecordVersion: input.organization.expectedVersion } : null;
  if (previousOrganization?.recordId === organization?.recordId)
    return c.json({ status: "invalid_request", reason: "no_change" }, 400);
  return publicRelationshipResult(c, await writeRelationship(c, {
    mutationId: input.mutationId, clientRecordId, expectedRelationshipVersion: input.expectedRelationshipVersion,
    expectedClientRecordVersion: current.client_version, previousOrganization, organization,
    supersedeTerminalCommandIds: terminalCommandIds,
    actor: { staffId: actor.staffId, accessSubject: actor.accessSubject, email: actor.loginEmail,
      admissionVersion: actor.admissionVersion, profileVersion: actor.profileVersion },
  }));
}

async function committedReplay(env: Env, actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">,
  input: { operation: "create" | "update"; mutationId: string; recordId: string; kind: NativeDirectoryProfileKind;
    expectedLocalVersion: number; profile: Record<string, string>; scopes?: readonly NativeDirectoryScope[]; sourceIds?: readonly string[];
    createRelationship?: z.infer<typeof relationshipChoice> },
): Promise<NativeDirectoryProfileWriteOutcome | null> {
  const primary = env.OPS_DB.withSession("first-primary");
  const row = await primary.prepare(`SELECT audit.command_json,audit.actor_id,audit.original_verified_access_subject,
      revision.record_id,revision.version,record.record_kind FROM operations_directory_audit audit
    JOIN operations_directory_revisions revision ON revision.mutation_id=audit.mutation_id
    JOIN operations_directory_records record ON record.record_id=revision.record_id WHERE audit.mutation_id=?`)
    .bind(input.mutationId).first<Record<string, unknown>>();
  if (!row) return null;
  let command: Record<string, unknown> | null = null;
  try { const value = JSON.parse(String(row.command_json)); command = value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { command = null; }
  const destinations = command && Array.isArray(command.destinations) ? command.destinations as Record<string, unknown>[] : [];
  const exactSources = input.sourceIds === undefined || JSON.stringify(destinations.map(value => value.sourceId).sort()) === JSON.stringify([...input.sourceIds].sort());
  const exactScopes = input.operation === "update" || JSON.stringify(command?.scopes) === JSON.stringify(input.scopes);
  let exactRelationship = true;
  if (input.operation === "create" && input.kind === "client") {
    const commandRelationship = command?.relationship, admissionId = command?.createAdmissionId;
    exactRelationship = !!input.createRelationship && typeof admissionId === "string"
      && JSON.stringify(commandRelationship) === JSON.stringify({ organizationRecordId: input.createRelationship.organizationRecordId,
        expectedRelationshipVersion: 0 })
      && exactAdmissionRelationship(await storedAdmissionRelationship(env.OPS_DB, admissionId), input.createRelationship);
  }
  if (!command || row.actor_id !== actor.staffId || row.original_verified_access_subject !== actor.accessSubject
    || row.record_id !== input.recordId || row.record_kind !== input.kind || command.operation !== input.operation
    || command.mutationId !== input.mutationId || command.expectedLocalVersion !== input.expectedLocalVersion
    || JSON.stringify(command.fields) !== JSON.stringify(input.profile) || !exactScopes || !exactSources || !exactRelationship
    || typeof row.version !== "number" || !Number.isSafeInteger(row.version))
    return { status: "conflict", reason: "idempotency_body_conflict" };
  const materializationSource = await directoryMaterializationReadSource(env.OPS_DB);
  const materializations = await primary.prepare(`SELECT materialization.command_id FROM ${materializationSource} materialization
    JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
    WHERE intent.mutation_id=? ORDER BY intent.intent_id LIMIT 17`).bind(input.mutationId).all<{ command_id: string }>();
  if (materializations.results.length < 1 || materializations.results.length > 16)
    return { status: "blocked", reason: "replay_destination_state" };
  return { status: "written", replayed: true, mutationId: input.mutationId, recordId: input.recordId,
    kind: input.kind, version: row.version, commandIds: materializations.results.map(value => value.command_id) };
}

async function actorWithGrants(c: AppContext, kind: NativeDirectoryProfileKind, record: string,
  requestedScopes: readonly NativeDirectoryScope[], creating: boolean,
  actor: Omit<NativeDirectoryWriterActor, "selectedGrantId" | "selectedIdentityGrantId">): Promise<NativeDirectoryWriterActor> {
  const selectedGrantId = await selectGrant(c.env.OPS_DB, actor.staffId, "directory.profile.edit", record, requestedScopes, creating);
  if (!selectedGrantId) throw new HTTPException(403, { message: "Directory profile edit permission required" });
  const selectedIdentityGrantId = kind === "client"
    ? await selectGrant(c.env.OPS_DB, actor.staffId, "directory.identity.link", record, requestedScopes, creating) : selectedGrantId;
  if (!selectedIdentityGrantId) throw new HTTPException(403, { message: "Directory identity-link permission required" });
  return { ...actor, selectedGrantId, selectedIdentityGrantId };
}

async function parsed<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const result = schema.safeParse(await readBoundedJson(request, MAX_BODY_BYTES, "Directory profile"));
  if (!result.success) throw new HTTPException(400, { message: "Directory profile request is invalid" });
  return result.data;
}

async function prepareCreateAdmission(c: AppContext) {
  const input = await parsed(c.req.raw, createAdmissionIntent);
  if (c.req.header("Idempotency-Key") !== input.mutationId)
    throw new HTTPException(400, { message: "Idempotency-Key must match mutationId" });
  const record = recordId(input.kind, input.mutationId);
  const actor = await nativeActor(c), profile = normalizeProfile(input.profile);
  const requestedScopes = normalizeScopes(input.scopes), selectedSources = [...input.sourceIds].sort();
  await actorWithGrants(c, input.kind, record, requestedScopes, true, actor);
  if (!await selectGrant(c.env.OPS_DB, actor.staffId, "directory.enrollment.manage", record, requestedScopes, true))
    throw new HTTPException(403, { message: "Directory enrollment-management permission required" });

  const relationship = input.kind === "client" ? input.relationship : null;
  if (relationship && relationship.organizationRecordId !== null && !await selectableOrganization(c, actor,
    relationship.organizationRecordId, relationship.expectedOrganizationVersion!, selectedSources))
    return c.json({ status: "conflict", reason: "organization_relationship_unavailable" }, 409);

  const existing = await storedCreateAdmission(c.env.OPS_DB, record);
  if (existing && !exactCreateAdmission(existing, actor, input.kind, record, profile, requestedScopes, selectedSources))
    return c.json({ status: "conflict", reason: "idempotency_body_conflict" }, 409);
  if (existing && relationship && !exactAdmissionRelationship(
    await storedAdmissionRelationship(c.env.OPS_DB, existing.id), relationship))
    return c.json({ status: "conflict", reason: "idempotency_body_conflict" }, 409);
  const destinations = await requestedCreateDestinations(c.env, selectedSources, record);
  if (!destinations) return c.json({ status: "conflict", reason: "source_authority_unavailable" }, 409);
  if (existing) return exactCreateAdmission(existing, actor, input.kind, record, profile, requestedScopes, selectedSources, destinations)
    ? c.json({ status: "prepared" })
    : c.json({ status: "conflict", reason: "create_admission_unavailable" }, 409);
  try {
    const primary = c.env.OPS_DB.withSession("first-primary"), admission = primary.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(createAdmissionId(record), actor.staffId, actor.accessSubject,
      record, input.kind, JSON.stringify(requestedScopes), JSON.stringify(profile), JSON.stringify(destinations), actor.staffId);
    if (relationship) await primary.batch([admission, primary.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version)
      VALUES(?,?,?,?) ON CONFLICT DO NOTHING`).bind(createAdmissionId(record), record,
        relationship.organizationRecordId, relationship.expectedOrganizationVersion)]);
    else await admission.run();
  } catch { /* The exact read below distinguishes a concurrent replay from unavailable admission state. */ }
  const prepared = await storedCreateAdmission(c.env.OPS_DB, record);
  const preparedRelationship = relationship ? await storedAdmissionRelationship(c.env.OPS_DB, createAdmissionId(record)) : null;
  return prepared && exactCreateAdmission(prepared, actor, input.kind, record, profile, requestedScopes, selectedSources, destinations)
    && (!relationship || exactAdmissionRelationship(preparedRelationship, relationship))
    ? c.json({ status: "prepared" })
    : c.json({ status: "conflict", reason: "create_admission_unavailable" }, 409);
}

async function create(c: AppContext, kind: NativeDirectoryProfileKind) {
  const input = kind === "organization" ? await parsed(c.req.raw, organizationCreate) : await parsed(c.req.raw, clientCreate);
  if (c.req.header("Idempotency-Key") !== input.mutationId)
    throw new HTTPException(400, { message: "Idempotency-Key must match mutationId" });
  const localRecordId = recordId(kind, input.mutationId);
  const baseActor = await nativeActor(c), normalizedProfile = normalizeProfile(input.profile), normalizedScopeValues = normalizeScopes(input.scopes);
  const relationship = kind === "client" ? (input as z.infer<typeof clientCreate>).relationship : null;
  const replay = await committedReplay(c.env, baseActor, { operation: "create", mutationId: input.mutationId,
    recordId: localRecordId, expectedLocalVersion: 0, kind, profile: normalizedProfile,
    scopes: normalizedScopeValues, sourceIds: input.sourceIds, ...(relationship ? { createRelationship: relationship } : {}) });
  if (replay) return publicResult(c, replay);
  const actor = await actorWithGrants(c, kind, localRecordId, normalizedScopeValues, true, baseActor);
  if (!await selectGrant(c.env.OPS_DB, baseActor.staffId, "directory.enrollment.manage",
    localRecordId, normalizedScopeValues, true))
    throw new HTTPException(403, { message: "Directory enrollment-management permission required" });
  const admitted = await admittedCreate(c.env, baseActor, kind, localRecordId, normalizedProfile, normalizedScopeValues, input.sourceIds);
  if (!admitted) return c.json({ status: "conflict", reason: "create_admission_unavailable" }, 409);
  if (relationship && !exactAdmissionRelationship(await storedAdmissionRelationship(c.env.OPS_DB, admitted.createAdmissionId), relationship))
    return c.json({ status: "conflict", reason: "create_admission_unavailable" }, 409);
  if (relationship && relationship.organizationRecordId !== null && !await selectableOrganization(c, baseActor,
    relationship.organizationRecordId, relationship.expectedOrganizationVersion!, input.sourceIds))
    return c.json({ status: "conflict", reason: "organization_relationship_unavailable" }, 409);
  const common = { operation: "create" as const, mutationId: input.mutationId, recordId: localRecordId,
    expectedLocalVersion: 0 as const, scopes: normalizedScopeValues, destinations: admitted.destinations,
    createAdmissionId: admitted.createAdmissionId, actor };
  const write: NativeDirectoryProfileWrite = kind === "client"
    ? { ...common, kind: "client", profile: normalizedProfile as NativeDirectoryClientCreateProfile,
        relationship: { organizationRecordId: relationship!.organizationRecordId, expectedRelationshipVersion: 0 } }
    : { ...common, kind: "organization", profile: normalizedProfile as NativeDirectoryOrganizationProfile };
  return publicResult(c, await writeProfile(c, write));
}

async function update(c: AppContext, kind: NativeDirectoryProfileKind) {
  const input = kind === "organization" ? await parsed(c.req.raw, organizationUpdate) : await parsed(c.req.raw, clientUpdate);
  if (c.req.header("Idempotency-Key") !== input.mutationId)
    throw new HTTPException(400, { message: "Idempotency-Key must match mutationId" });
  const checkedRecordId = canonicalRecordId.safeParse(c.req.param("recordId"));
  if (!checkedRecordId.success) throw new HTTPException(404, { message: "Directory record not found" });
  const localRecordId = checkedRecordId.data;
  const baseActor = await nativeActor(c), normalizedProfile = normalizeProfile(input.profile);
  const replay = await committedReplay(c.env, baseActor, { operation: "update", mutationId: input.mutationId,
    recordId: localRecordId, expectedLocalVersion: input.expectedLocalVersion, kind, profile: normalizedProfile });
  if (replay) return publicResult(c, replay);
  const actor = await actorWithGrants(c, kind, localRecordId, [], false, baseActor);
  const currentRelationship = kind === "client" ? await currentClientRelationship(c.env.OPS_DB, localRecordId) : null;
  const relationship = currentRelationship ? { organizationRecordId: currentRelationship.organization_record_id,
    expectedRelationshipVersion: currentRelationship.relationship_version } : null;
  if (kind === "client" && !relationship)
    return c.json({ status: "conflict", reason: "relationship_state_unavailable" }, 409);
  const enrolledSources = kind === "client" ? await enrollmentSourceIds(c.env, localRecordId) : null;
  if (kind === "client" && (!enrolledSources || !await relationshipDeliverySettled(c.env.OPS_DB, localRecordId,
    currentRelationship!.relationship_version, enrolledSources.length,
    c.env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED === "true")))
    return c.json({ status: "conflict", reason: "relationship_delivery_pending" }, 409);
  const destinations = await updateDestinations(c.env, kind, localRecordId, input.expectedLocalVersion);
  if (!destinations) return c.json({ status: "conflict", reason: "source_authority_unavailable" }, 409);
  const common = { operation: "update" as const, mutationId: input.mutationId, recordId: localRecordId,
    expectedLocalVersion: input.expectedLocalVersion, destinations, actor };
  const write: NativeDirectoryProfileWrite = kind === "client"
    ? { ...common, kind: "client", profile: normalizedProfile as NativeDirectoryClientUpdateProfile, relationship: relationship! }
    : { ...common, kind: "organization", profile: normalizedProfile as NativeDirectoryOrganizationProfile };
  return publicResult(c, await writeProfile(c, write));
}

/** Server-owned choices for a create intent.  These are advisory UI choices;
 * the admission and write paths still re-check every selected value. */
async function createOptions(c: AppContext) {
  const kind: NativeDirectoryProfileKind = c.req.query("kind") === "client" ? "client" : "organization";
  const actor = await nativeActor(c), permissions = kind === "client"
    ? ["directory.profile.edit", "directory.enrollment.manage", "directory.identity.link"] as const
    : ["directory.profile.edit", "directory.enrollment.manage"] as const;
  const [areas, divisions, grants] = await Promise.all([
    c.env.OPS_DB.withSession("first-primary").prepare("SELECT id,name FROM native_business_areas WHERE active=1 ORDER BY name,id").all<{ id: string; name: string }>(),
    c.env.OPS_DB.withSession("first-primary").prepare("SELECT id,business_area_id businessAreaId,name FROM native_business_divisions WHERE active=1 ORDER BY name,id").all<{ id: string; businessAreaId: string; name: string }>(),
    c.env.OPS_DB.withSession("first-primary").prepare(`SELECT permission,effect,scope_kind,business_area_id businessAreaId,division_id divisionId
      FROM native_directory_grants WHERE staff_id=? AND active=1 AND permission IN (${permissions.map(() => "?").join(",")})`)
      .bind(actor.staffId, ...permissions).all<{ permission: string; effect: "allow" | "deny"; scope_kind: string; businessAreaId: string | null; divisionId: string | null }>(),
  ]);
  const effective = (permission: string, businessAreaId: string, divisionId: string | null) => {
    const matches = (grant: { scope_kind: string; businessAreaId: string | null; divisionId: string | null }) => grant.scope_kind === "global"
      || (grant.scope_kind === "business_area" && grant.businessAreaId === businessAreaId)
      || (divisionId !== null && grant.scope_kind === "division" && grant.divisionId === divisionId);
    const current = grants.results.filter(grant => grant.permission === permission && matches(grant));
    return current.some(grant => grant.effect === "allow") && !current.some(grant => grant.effect === "deny");
  };
  const allowed = (area: string, division: string | null) => permissions.every(permission => effective(permission, area, division));
  const scopes = areas.results.flatMap(area => {
    const divisionsForArea = divisions.results.filter(division => division.businessAreaId === area.id && allowed(area.id, division.id))
      .map(division => ({ id: division.id, name: division.name }));
    return allowed(area.id, null) || divisionsForArea.length ? [{ id: area.id, name: area.name, divisions: divisionsForArea }] : [];
  });
  const sources: Array<{ id: string; name: string }> = [];
  for (const sourceId of listEnabledProjectAlphaApiV2SourceIds(c.env))
    if (SOURCE_ID.test(sourceId) && await configuredDestination(c.env, sourceId, "create-options"))
      sources.push({ id: sourceId, name: `Project Alpha (${sourceId.slice("project-alpha:".length)})` });
  const organizations = kind === "client" ? (await organizationChoicesForActor(c, actor))
    .map(choice => ({ recordId: choice.recordId, expectedVersion: choice.expectedVersion, name: choice.name,
      sourceIds: choice.sourceIds })) : [];
  return c.json({ kind, scopes, sources, organizations });
}

/** Read the immutable, canonical profile revision for the editor.  This is a
 * separate native-authority read: Client Hub projections are intentionally
 * not used as an edit snapshot because they can lag a queued write. */
async function profile(c: AppContext, kind: NativeDirectoryProfileKind) {
  const checkedRecordId = canonicalRecordId.safeParse(c.req.param("recordId"));
  if (!checkedRecordId.success) throw new HTTPException(404, { message: "Directory record not found" });
  const record = checkedRecordId.data;
  const actor = await nativeActor(c);
  if (!await selectGrant(c.env.OPS_DB, actor.staffId, "directory.profile.view", record, [], false))
    throw new HTTPException(403, { message: "Directory profile view permission required" });
  let current: { version: number; profile: Record<string, string> };
  if (kind === "client") {
    const snapshot = await readNativeDirectoryClientProfileSnapshot(c.env.OPS_DB, record);
    if (!snapshot) throw new HTTPException(409, { message: "Directory profile is unavailable" });
    current = snapshot;
  } else {
    const stored = await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT record.current_version version,revision.profile_json
      FROM operations_directory_records record JOIN operations_directory_revisions revision
        ON revision.record_id=record.record_id AND revision.version=record.current_version
      WHERE record.record_id=? AND record.record_kind=?`).bind(record, kind).first<{ version: number; profile_json: string }>();
    if (!stored || !Number.isSafeInteger(stored.version) || stored.version < 1) throw new HTTPException(404, { message: "Directory record not found" });
    let parsedProfile: unknown;
    try { parsedProfile = JSON.parse(stored.profile_json); } catch { throw new HTTPException(409, { message: "Directory profile is unavailable" }); }
    const checkedProfile = organizationProfile.safeParse(parsedProfile);
    if (!checkedProfile.success) throw new HTTPException(409, { message: "Directory profile is unavailable" });
    current = { version: stored.version, profile: checkedProfile.data };
  }
  const scopeRows = (await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT business_area_id businessAreaId,division_id divisionId
    FROM native_directory_resource_scopes WHERE record_id=? AND active=1
    ORDER BY business_area_id,coalesce(division_id,'')`).bind(record).all<{ businessAreaId: string; divisionId: string | null }>()).results;
  const currentScopes = scopes.safeParse(scopeRows);
  if (!currentScopes.success) throw new HTTPException(409, { message: "Directory profile is unavailable" });
  if (kind === "organization") return c.json({ recordId: record, kind, version: current.version,
    profile: normalizeProfile(current.profile), scopes: currentScopes.data, editing: { available: true, reason: null } });
  const relationship = await currentClientRelationship(c.env.OPS_DB, record), sourceIds = await enrollmentSourceIds(c.env, record);
  const representable = relationship && sourceIds ? (await nativeDirectoryOrganizationChoices(c.env))
    .filter(choice => sameSources(choice, sourceIds)) : [];
  const choices = relationship && sourceIds ? await organizationChoicesForActor(c, actor, sourceIds) : [];
  const selected = relationship?.organization_record_id ? representable.find(choice => choice.recordId === relationship.organization_record_id
    && choice.expectedVersion === relationship.organization_version) : null;
  const settled = relationship && sourceIds ? await relationshipDeliverySettled(c.env.OPS_DB, record,
    relationship.relationship_version, sourceIds.length,
    c.env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED === "true") : false;
  const recovery = relationship && sourceIds ? await relationshipRecoveryCapability(c, record,
    relationship.relationship_version, sourceIds, settled) : null;
  const available = !!relationship && !!sourceIds && settled && (relationship.organization_record_id === null || !!selected);
  const relationshipAuthorized = !!relationship && await Promise.all(
    (["directory.profile.edit", "directory.identity.link"] as const)
      .map(permission => selectGrant(c.env.OPS_DB, actor.staffId, permission, record, [], false)))
    .then(grants => grants.every(Boolean));
  return c.json({ recordId: record, kind, version: current.version, profile: normalizeProfile(current.profile),
    scopes: currentScopes.data, linkage: relationship?.organization_record_id ? "linked" : relationship ? "standalone" : "unavailable",
    relationship: relationship ? { version: relationship.relationship_version,
      organization: selected ? { recordId: selected.recordId, expectedVersion: selected.expectedVersion, name: selected.name } : null,
      organizations: choices.map(choice => ({ recordId: choice.recordId, expectedVersion: choice.expectedVersion, name: choice.name })),
      ...(recovery ? { recovery } : {}),
      editing: available && relationshipAuthorized ? { available: true, reason: null }
        : { available: false, reason: !relationshipAuthorized ? "relationship_permission_required"
          : relationship && !settled ? "relationship_delivery_pending" : "relationship_state_unavailable" } } : null,
    editing: available ? { available: true, reason: null } : { available: false,
      reason: relationship && !settled ? "relationship_delivery_pending" : "relationship_state_unavailable" } });
}

async function recoverCreateGeneration(c: AppContext) {
  const enabled = c.env as Env & { PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED?: string };
  if (enabled.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED !== "true")
    throw new HTTPException(404, { message: "Not found" });
  if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator authority required" });
  const input = await parsed(c.req.raw, z.object({ authorizationId: z.string().regex(UUID),
    predecessorCommandId: z.string().regex(UUID), successorCommandId: z.string().regex(UUID),
    sourceId: z.string().regex(SOURCE_ID), reason: z.string().trim().min(1).max(500) }).strict());
  if (c.req.header("Idempotency-Key") !== input.authorizationId)
    throw new HTTPException(400, { message: "Idempotency-Key must match authorizationId" });
  const actor = await nativeActor(c);
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try {
    authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB,
      { enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD });
  } catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
  if (authenticated.identity.staffId !== actor.staffId
    || authenticated.identity.verifiedAccessSubject !== actor.accessSubject
    || authenticated.admissionVersion !== actor.admissionVersion)
    throw new HTTPException(403, { message: "Native staff authority changed" });
  const result = await prepareDirectoryCreateGenerationRecovery(enabled, input,
    { staffId: actor.staffId, accessSubject: actor.accessSubject, email: actor.loginEmail,
      admissionVersion: actor.admissionVersion, profileVersion: actor.profileVersion,
      verifiedUntil: authenticated.verifiedUntil });
  return c.json(result, result.status === "prepared" ? 200 : result.status === "conflict" ? 409
    : result.status === "uncertain" ? 503 : 403);
}

/** Mounted under the shared authenticated /api mutation middleware, which
 * supplies staff authentication plus same-origin and CSRF enforcement. This
 * profile routes derive native Directory and PA authority. Explicit recovery
 * reads fresh PA inventory but never sends a resource mutation directly. */
export function registerNativeDirectoryProfileRoutes(app: App): void {
  app.use(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/*`, async (c, next) => {
    if (!nativeDirectoryProfileWritesEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.post(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/create-admissions`, prepareCreateAdmission);
  app.post(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/create-generation-recovery`, recoverCreateGeneration);
  app.post(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/organizations`, c => create(c, "organization"));
  app.post(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/standalone-clients`, c => create(c, "client"));
  app.get(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/create-options`, createOptions);
  app.get(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/:kind/:recordId`, c => {
    const kind = c.req.param("kind");
    if (kind === "organizations") return profile(c, "organization");
    if (kind === "standalone-clients") return profile(c, "client");
    throw new HTTPException(404, { message: "Directory record not found" });
  });
  app.patch(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/:kind/:recordId`, c => {
    const kind = c.req.param("kind");
    if (kind === "organizations") return update(c, "organization");
    if (kind === "standalone-clients") return update(c, "client");
    throw new HTTPException(404, { message: "Directory record not found" });
  });
  app.post(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/standalone-clients/:recordId/relationship`, mutateRelationship);
  app.post(`${NATIVE_DIRECTORY_PROFILE_ROUTE}/standalone-clients/:recordId/relationship-recovery`, recoverRelationship);
}
