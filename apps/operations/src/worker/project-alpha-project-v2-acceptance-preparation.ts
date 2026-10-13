import { resolveProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import { readConfiguredProjectAlphaProjectBindingStatus } from "./project-alpha-project-binding-status-api-v2";
import { readConfiguredProjectAlphaProjectInventory } from "./project-alpha-project-inventory-api-v2";
import { readConfiguredProjectAlphaProject } from "./project-alpha-project-read-api-v2";
import type { ProjectAlphaProjectProfile, ProjectAlphaProjectRelationProof } from "./project-alpha-project-transport";

export type ProjectAcceptanceScope = Readonly<
  { scopeKind: "business_area"; businessAreaId: string; divisionId: null }
  | { scopeKind: "division"; businessAreaId: string; divisionId: string }
>;
export type ProjectAcceptancePreparationActor = Readonly<{
  staffId: string; accessSubject: string; email: string; admissionVersion: number; profileVersion: number;
  scopes: readonly ProjectAcceptanceScope[];
}>;
export type ProjectAcceptanceCreatePreparationRequest = Readonly<{
  operation: "create"; sourceId: string; expectedApplicationId: string; externalProjectId: string;
  organizationRecordId: string; clientRecordId: string | null; actor: ProjectAcceptancePreparationActor;
}>;
export type ProjectAcceptanceUpdatePreparationRequest = Readonly<{
  operation: "update"; sourceId: string; expectedApplicationId: string; externalProjectId: string;
  actor: ProjectAcceptancePreparationActor;
}>;
export type ProjectAcceptancePreparationRequest = ProjectAcceptanceCreatePreparationRequest | ProjectAcceptanceUpdatePreparationRequest;

export type ProjectAcceptanceCreatePreparation = Readonly<{
  operation: "create"; sourceId: string; expectedApplicationId: string; externalProjectId: string;
  expectedAuthorizationGeneration: string;
  local: Readonly<{ expectedLocalVersion: 0; expectedLocalProjectionSha256: null }>;
  directory: Readonly<{ organizationRecordId: string; clientRecordId: string | null }>;
  organization: ProjectAlphaProjectRelationProof; client: ProjectAlphaProjectRelationProof | null;
  scopes: readonly ProjectAcceptanceScope[];
}>;
export type ProjectAcceptanceUpdatePreparation = Readonly<{
  operation: "update"; sourceId: string; expectedApplicationId: string; externalProjectId: string;
  expectedAuthorizationGeneration: string; expectedPublicId: string; expectedRevision: string;
  expectedProjectionSha256: string; project: ProjectAlphaProjectProfile;
  local: Readonly<{ expectedLocalVersion: number; expectedLocalProjectionSha256: string }>;
  scopes: readonly ProjectAcceptanceScope[];
}>;
export type ProjectAcceptancePreparationOutcome =
  | Readonly<{ status: "prepared"; preparation: ProjectAcceptanceCreatePreparation | ProjectAcceptanceUpdatePreparation }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "directory" | "stale" | "remote" | "invalid_request" }>;

type Environment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
type Database = Pick<D1Database, "prepare">;
type Connection = Readonly<{ sourceId: string; sourceInstanceId: string; applicationId: string; historyEpochId: string }>;
type ActorState = Readonly<{ admission_version: number; profile_version: number; email: string; generation: number }>;
type Grant = Readonly<{ effect: "allow" | "deny"; scope_kind: "global" | "business_area" | "division" | "exact_project"; business_area_id: string | null; division_id: string | null; external_project_id: string | null }>;
type DirectoryRow = Readonly<{ external_id: string; project_alpha_public_id: string; resource_revision: string; projection_sha256: string }>;
type Head = Readonly<{ current_version: number; canonical_projection_sha256: string | null; organization_record_id: string | null; client_record_id: string | null; source_id: string | null; source_instance_id: string | null; application_id: string | null; history_epoch_id: string | null }>;
type Mapping = Readonly<{ source_id: string; source_instance_id: string; application_id: string; history_epoch_id: string; project_alpha_public_id: string }>;

export type ProjectAcceptancePreparationReaders = Readonly<{
  inventory: typeof readConfiguredProjectAlphaProjectInventory;
  bindingStatus: typeof readConfiguredProjectAlphaProjectBindingStatus;
  project: typeof readConfiguredProjectAlphaProject;
}>;
const defaultReaders: ProjectAcceptancePreparationReaders = Object.freeze({
  inventory: readConfiguredProjectAlphaProjectInventory,
  bindingStatus: readConfiguredProjectAlphaProjectBindingStatus,
  project: readConfiguredProjectAlphaProject,
});
const SHA256 = /^[0-9a-f]{64}$/;
const EXTERNAL = /^.{1,191}$/u;

function connection(env: Environment, input: ProjectAcceptancePreparationRequest): Connection | null {
  try {
    const selected = resolveProjectAlphaApiV2Connection(env, input.sourceId);
    if (!selected.enabled || selected.connection.expectedApplicationId !== input.expectedApplicationId || !selected.connection.expectedHistoryEpoch) return null;
    return { sourceId: selected.sourceId, sourceInstanceId: selected.connection.expectedSourceInstanceId,
      applicationId: selected.connection.expectedApplicationId, historyEpochId: selected.connection.expectedHistoryEpoch };
  } catch { return null; }
}
function validScope(scope: ProjectAcceptanceScope): boolean {
  return !!scope && typeof scope.businessAreaId === "string" && scope.businessAreaId.length > 0
    && (scope.scopeKind === "business_area" ? scope.divisionId === null
      : scope.scopeKind === "division" && typeof scope.divisionId === "string" && scope.divisionId.length > 0);
}
function validRequest(input: ProjectAcceptancePreparationRequest): boolean {
  return EXTERNAL.test(input.externalProjectId) && EXTERNAL.test(input.actor.staffId) && input.actor.accessSubject.length > 0
    && input.actor.email.length >= 3 && Number.isSafeInteger(input.actor.admissionVersion) && input.actor.admissionVersion > 0
    && Number.isSafeInteger(input.actor.profileVersion) && input.actor.profileVersion > 0
    && input.actor.scopes.length <= 128 && input.actor.scopes.every(validScope)
    && (input.operation === "update" || EXTERNAL.test(input.organizationRecordId)
      && (input.clientRecordId === null || EXTERNAL.test(input.clientRecordId)));
}
function authorized(grants: readonly Grant[], scopes: readonly ProjectAcceptanceScope[], externalProjectId: string): boolean {
  const applies = (grant: Grant, scope: ProjectAcceptanceScope) => grant.scope_kind === "global"
    || grant.scope_kind === "exact_project" && grant.external_project_id === externalProjectId
    || grant.scope_kind === "business_area" && grant.business_area_id === scope.businessAreaId
    || grant.scope_kind === "division" && scope.scopeKind === "division" && grant.business_area_id === scope.businessAreaId && grant.division_id === scope.divisionId;
  if (scopes.length === 0) return grants.some(g => g.effect === "allow" && g.scope_kind === "global")
    && !grants.some(g => g.effect === "deny" && (g.scope_kind === "global" || g.scope_kind === "exact_project" && g.external_project_id === externalProjectId));
  return scopes.every(scope => grants.some(g => g.effect === "allow" && applies(g, scope))
    && !grants.some(g => g.effect === "deny" && applies(g, scope)));
}
async function authority(db: Database, input: ProjectAcceptancePreparationRequest): Promise<string | null> {
  const state = await db.prepare(`SELECT admission.version admission_version,profile.version profile_version,profile.login_email email,generation.generation
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?`)
    .bind(input.actor.staffId, input.actor.accessSubject).first<ActorState>();
  if (!state || state.admission_version !== input.actor.admissionVersion || state.profile_version !== input.actor.profileVersion || state.email !== input.actor.email) return null;
  const rows = await db.prepare(`SELECT effect,scope_kind,business_area_id,division_id,external_project_id FROM native_project_grants
    WHERE staff_id=? AND capability='project.shared.sync' AND active=1`).bind(input.actor.staffId).all<Grant>();
  return authorized(rows.results, input.actor.scopes, input.externalProjectId) ? String(state.generation) : null;
}
async function directoryRow(db: Database, c: Connection, kind: "organization" | "client", recordId: string): Promise<DirectoryRow | null> {
  const rows = await db.prepare(`SELECT mapping.external_id,mapping.project_alpha_public_id,observation.resource_revision,observation.projection_sha256
    FROM operations_directory_records record JOIN project_alpha_active_directory_mappings mapping ON mapping.record_id=record.record_id
    JOIN project_alpha_api_v2_directory_observations_current observation
      ON observation.source_id=mapping.source_id AND observation.source_instance_id=mapping.source_instance_id
      AND observation.application_id=mapping.application_id AND observation.history_epoch_id=mapping.history_epoch_id
      AND observation.resource_type=mapping.resource_type AND observation.project_alpha_public_id=mapping.project_alpha_public_id
    WHERE record.record_id=? AND record.record_kind=? AND mapping.source_id=? AND mapping.source_instance_id=?
      AND mapping.application_id=? AND mapping.history_epoch_id=? AND mapping.resource_type=?
      AND observation.present=1 AND observation.has_conflict=0 AND observation.binding_external_id=mapping.external_id
      AND observation.binding_status='active' AND observation.binding_resource_revision=observation.resource_revision LIMIT 2`)
    .bind(recordId, kind, c.sourceId, c.sourceInstanceId, c.applicationId, c.historyEpochId, kind).all<DirectoryRow>();
  return rows.results.length === 1 ? rows.results[0]! : null;
}
type Relationship = Readonly<{ client_record_id: string; organization_record_id: string; relationship_version: number }>;
async function relationship(db: Database, client: string, organization: string): Promise<Relationship | null> {
  const rows = await db.prepare(`SELECT client_record_id,organization_record_id,relationship_version FROM operations_directory_client_organizations
    WHERE client_record_id=? AND organization_record_id=? LIMIT 2`).bind(client, organization).all();
  if (rows.results.length !== 1) return null;
  const row = rows.results[0] as Relationship;
  return Number.isSafeInteger(row.relationship_version) && row.relationship_version > 0 ? row : null;
}
async function reserved(db: Database, externalId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT
    (SELECT count(*) FROM project_alpha_project_destinations WHERE external_project_id=?)
    +(SELECT count(*) FROM project_alpha_project_outbox WHERE external_project_id=?) occupied`)
    .bind(externalId, externalId).first<number>("occupied");
  return row !== null && row > 0;
}
async function state(db: Database, externalId: string): Promise<Readonly<{ exact: boolean; head: Head | null; mapping: Mapping | null }>> {
  const [heads, mappings] = await Promise.all([
    db.prepare(`SELECT current_version,canonical_projection_sha256,organization_record_id,client_record_id,source_id,source_instance_id,application_id,history_epoch_id
      FROM operations_shared_projects WHERE external_project_id=? LIMIT 2`).bind(externalId).all<Head>(),
    db.prepare(`SELECT source_id,source_instance_id,application_id,history_epoch_id,project_alpha_public_id
      FROM project_alpha_project_mappings WHERE external_project_id=? LIMIT 2`).bind(externalId).all<Mapping>(),
  ]);
  return { exact: heads.results.length <= 1 && mappings.results.length <= 1,
    head: heads.results.length === 1 ? heads.results[0]! : null, mapping: mappings.results.length === 1 ? mappings.results[0]! : null };
}
function same(value: unknown, other: unknown): boolean { return JSON.stringify(value) === JSON.stringify(other); }
function exactIdentity(c: Connection, value: Mapping | Head): boolean {
  return value.source_id === c.sourceId && value.source_instance_id === c.sourceInstanceId
    && value.application_id === c.applicationId && value.history_epoch_id === c.historyEpochId;
}

export async function prepareProjectAlphaProjectV2Acceptance(
  env: Environment, input: ProjectAcceptancePreparationRequest, readers: ProjectAcceptancePreparationReaders = defaultReaders,
): Promise<ProjectAcceptancePreparationOutcome> {
  if (!validRequest(input)) return { status: "blocked", reason: "invalid_request" };
  const selected = connection(env, input); if (!selected) return { status: "blocked", reason: "configuration" };
  const db = env.OPS_DB.withSession("first-primary");
  const localGeneration = await authority(db, input); if (localGeneration === null) return { status: "blocked", reason: "authority" };
  const before = await state(db, input.externalProjectId);
  if (input.operation === "create") {
    if (!before.exact || before.head || before.mapping || await reserved(db, input.externalProjectId)) return { status: "blocked", reason: "stale" };
    const organization = await directoryRow(db, selected, "organization", input.organizationRecordId);
    const client = input.clientRecordId === null ? null : await directoryRow(db, selected, "client", input.clientRecordId);
    const relationshipBefore = input.clientRecordId === null ? null : await relationship(db, input.clientRecordId, input.organizationRecordId);
    if (!organization || input.clientRecordId !== null && (!client || !relationshipBefore))
      return { status: "blocked", reason: "directory" };
    const directoryBefore = { organization, client };
    const inventory = await readers.inventory(env, input.sourceId, { limit: 1 });
    if (inventory.status !== "observed") return { status: "blocked", reason: "remote" };
    const [after, organizationAfter, clientAfter, currentGeneration] = await Promise.all([
      state(db, input.externalProjectId), directoryRow(db, selected, "organization", input.organizationRecordId),
      input.clientRecordId === null ? Promise.resolve(null) : directoryRow(db, selected, "client", input.clientRecordId), authority(db, input),
    ]);
    const relationshipAfter = input.clientRecordId === null ? null : await relationship(db, input.clientRecordId, input.organizationRecordId);
    if (!after.exact || after.head || after.mapping || await reserved(db, input.externalProjectId) || !same(relationshipBefore, relationshipAfter)
      || !same(directoryBefore, { organization: organizationAfter, client: clientAfter }) || currentGeneration !== localGeneration)
      return { status: "blocked", reason: "stale" };
    const relation = (row: DirectoryRow): ProjectAlphaProjectRelationProof => ({ externalId: row.external_id,
      expectedPublicId: row.project_alpha_public_id, expectedRevision: row.resource_revision, expectedProjectionSha256: row.projection_sha256 });
    const preparation: ProjectAcceptanceCreatePreparation = { operation: "create", sourceId: input.sourceId,
      expectedApplicationId: input.expectedApplicationId, externalProjectId: input.externalProjectId,
      expectedAuthorizationGeneration: inventory.response.authorizationGeneration,
      local: { expectedLocalVersion: 0, expectedLocalProjectionSha256: null },
      directory: { organizationRecordId: input.organizationRecordId, clientRecordId: input.clientRecordId },
      organization: relation(organization), client: client ? relation(client) : null,
      scopes: input.actor.scopes };
    return { status: "prepared", preparation: Object.freeze(preparation) };
  }
  if (!before.exact || !before.head || !before.mapping || !exactIdentity(selected, before.head) || !exactIdentity(selected, before.mapping)
    || !Number.isSafeInteger(before.head.current_version) || before.head.current_version < 1
    || !before.head.canonical_projection_sha256 || !SHA256.test(before.head.canonical_projection_sha256)
    || before.head.organization_record_id === null) return { status: "blocked", reason: "stale" };
  const organization = await directoryRow(db, selected, "organization", before.head.organization_record_id);
  const client = before.head.client_record_id === null ? null : await directoryRow(db, selected, "client", before.head.client_record_id);
  const relationshipBefore = before.head.client_record_id === null ? null : await relationship(db, before.head.client_record_id, before.head.organization_record_id);
  if (!organization || before.head.client_record_id !== null && (!client || !relationshipBefore))
    return { status: "blocked", reason: "directory" };
  const first = await readers.bindingStatus(env, input.sourceId, input.externalProjectId);
  if (first.status !== "observed" || first.response.binding.publicId !== before.mapping.project_alpha_public_id || first.response.resource.archived)
    return { status: "blocked", reason: "remote" };
  const read = await readers.project(env, input.sourceId, before.mapping.project_alpha_public_id);
  const second = await readers.bindingStatus(env, input.sourceId, input.externalProjectId);
  if (read.status !== "read" || second.status !== "observed" || !same(first.response.binding, second.response.binding)
    || !same(first.response.resource, second.response.resource) || first.response.authorizationGeneration !== second.response.authorizationGeneration
    || read.response.resource.revision !== first.response.resource.revision || read.response.resource.projectionSha256 !== first.response.resource.projectionSha256
    || read.response.data.organizationPublicId !== organization.project_alpha_public_id
    || read.response.data.clientPublicId !== (client?.project_alpha_public_id ?? null)) return { status: "blocked", reason: "remote" };
  const [after, organizationAfter, clientAfter, currentGeneration] = await Promise.all([
    state(db, input.externalProjectId), directoryRow(db, selected, "organization", before.head.organization_record_id),
    before.head.client_record_id === null ? Promise.resolve(null) : directoryRow(db, selected, "client", before.head.client_record_id), authority(db, input),
  ]);
  const relationshipAfter = before.head.client_record_id === null ? null : await relationship(db, before.head.client_record_id, before.head.organization_record_id);
  if (!same(before, after) || !same(relationshipBefore, relationshipAfter) || !same({ organization, client }, { organization: organizationAfter, client: clientAfter }) || currentGeneration !== localGeneration)
    return { status: "blocked", reason: "stale" };
  return { status: "prepared", preparation: Object.freeze({ operation: "update", sourceId: input.sourceId,
    expectedApplicationId: input.expectedApplicationId, externalProjectId: input.externalProjectId,
    expectedAuthorizationGeneration: second.response.authorizationGeneration, expectedPublicId: before.mapping.project_alpha_public_id,
    expectedRevision: second.response.resource.revision, expectedProjectionSha256: second.response.resource.projectionSha256,
    project: { name: read.response.data.name, description: read.response.data.description,
      estimatedStart: read.response.data.estimatedStart, estimatedEnd: read.response.data.estimatedEnd },
    local: { expectedLocalVersion: before.head.current_version, expectedLocalProjectionSha256: before.head.canonical_projection_sha256 },
    scopes: input.actor.scopes }) };
}
