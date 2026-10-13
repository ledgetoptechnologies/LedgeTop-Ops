/**
 * Private, unmounted producer for one short-lived 0124 Project adoption review.
 * The caller supplies an authenticated actor and a deliberate server selection;
 * deployment configuration, native authority, Directory identity, and every PA
 * observation are loaded here. No route, queue, or scheduler imports this file.
 */
import {
  resolveProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2ConnectionEnvironment,
} from "./project-alpha-api-v2-connections";
import {
  readConfiguredProjectAlphaProject,
  validatedProjectAlphaProjectRead,
  type ValidatedProjectAlphaProjectRead,
} from "./project-alpha-project-read-api-v2";
import { readConfiguredProjectAlphaProjectBindingStatus } from "./project-alpha-project-binding-status-api-v2";
import { readConfiguredProjectAlphaProjectInventory, type ProjectAlphaProjectInventory } from "./project-alpha-project-inventory-api-v2";

export type ProjectAlphaProjectAdoptionReviewProducerEnvironment =
  ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
export type ProjectAlphaProjectAdoptionReviewProducerActor = Readonly<{ staffId: string; accessSubject: string }>;
export type ProjectAlphaProjectAdoptionReviewSelection = Readonly<{
  idempotencyKey: string;
  sourceId: string;
  externalProjectId: string;
  projectAlphaPublicId: string;
}>;
export type ProjectAlphaProjectAdoptionReviewProducerOutcome =
  | Readonly<{ status: "reviewed"; reviewItemId: string; requestSha256: string; replayed: boolean }>
  | Readonly<{ status: "rejected"; reason: "invalid_actor" | "invalid_selection" }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "destination" | "authority" | "local_state" |
      "directory" | "relationship" | "remote" | "stale_evidence" }>
  | Readonly<{ status: "conflict"; reason: "idempotency_key" | "request_sha256" }>
  | Readonly<{ status: "uncertain"; reason: "database" | "remote" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_INVENTORY_PAGES = 16;

type Configured = Readonly<{ sourceId: string; baseUrl: string; sourceInstanceId: string; applicationId: string; historyEpochId: string }>;
type Destination = Readonly<{ source_id: string; application_id: string; destination_base_url: string;
  expected_source_instance_id: string; expected_history_epoch_id: string }>;
type ActorState = Readonly<{ admission_version: number; profile_version: number; generation: number; owner: number }>;
type Grant = Readonly<{ effect: "allow" | "deny"; scope_kind: "global" | "business_area" | "division" | "exact_project";
  business_area_id: string | null; division_id: string | null; external_project_id: string | null }>;
type Scope = Readonly<{ scopeKind: "business_area"; businessAreaId: string; divisionId: null }
  | { scopeKind: "division"; businessAreaId: string; divisionId: string }>;
type DirectoryIdentity = Readonly<{ organizationRecordId: string | null; clientRecordId: string | null; scopes: readonly Scope[] }>;
type LocalState = Readonly<{ heads: number; mappings: number; pending: number }>;
type Receipt = Readonly<{
  idempotency_key: string;
  request_sha256: string;
  canonical_request_json: string;
  review_item_id: string;
  source_id: string;
  external_project_id: string;
  project_alpha_public_id: string;
  reviewer_staff_id: string;
  reviewer_access_subject: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  project_alpha_revision: string;
  projection_sha256: string;
  authorization_generation: string;
  canonical_detail_read_json: string;
  canonical_detail_read_sha256: string;
  organization_record_id: string | null;
  organization_project_alpha_public_id: string | null;
  client_record_id: string | null;
  client_project_alpha_public_id: string | null;
  reviewer_admission_version: number;
  reviewer_profile_version: number;
  independent_evidence_sha256: string;
  project_grant_generation: number;
  normalized_scopes_json: string;
  expires_at: string;
}>;
type RemoteEvidence = Readonly<{
  detail: ValidatedProjectAlphaProjectRead;
  binding: Extract<Awaited<ReturnType<typeof readConfiguredProjectAlphaProjectBindingStatus>>, { status: "observed" }>;
  inventory: readonly ProjectAlphaProjectInventory[];
  authorizationGeneration: string;
  independentEvidenceSha256: string;
}>;

function ownData(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every(key => typeof key === "string" && fields.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}
function actor(value: unknown): value is ProjectAlphaProjectAdoptionReviewProducerActor {
  return ownData(value, ["staffId", "accessSubject"])
    && typeof value.staffId === "string" && value.staffId.length >= 1 && value.staffId.length <= 191
    && !/[\u0000-\u001f\u007f]/.test(value.staffId)
    && typeof value.accessSubject === "string" && value.accessSubject.length >= 1 && value.accessSubject.length <= 764
    && !/[\u0000-\u001f\u007f]/.test(value.accessSubject);
}
function selection(value: unknown): value is ProjectAlphaProjectAdoptionReviewSelection {
  return ownData(value, ["idempotencyKey", "sourceId", "externalProjectId", "projectAlphaPublicId"])
    && typeof value.idempotencyKey === "string" && UUID.test(value.idempotencyKey)
    && typeof value.sourceId === "string" && SOURCE_ID.test(value.sourceId)
    && typeof value.externalProjectId === "string" && value.externalProjectId.length >= 1
    && value.externalProjectId.length <= 191 && !/[\u0000-\u001f\u007f]/.test(value.externalProjectId)
    && typeof value.projectAlphaPublicId === "string" && PUBLIC_ID.test(value.projectAlphaPublicId);
}
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function canonical(value: unknown): string {
  function normalize(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item as Record<string, unknown>)
      .sort().map(key => [key, normalize((item as Record<string, unknown>)[key])]));
    return item;
  }
  return JSON.stringify(normalize(value));
}
function stableDetailEvidence(value: unknown): string | null {
  if (!ownData(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed",
    "accepted", "resource", "data"])
    || !ownData(value.resource, ["type", "id", "revision", "projectionSha256"])
    || !ownData(value.data, ["name", "description", "status", "archived", "overdueWarning", "completedAt",
      "archivedAt", "estimatedStart", "estimatedEnd", "clientPublicId", "organizationPublicId"])) return null;
  return canonical({
    apiVersion: value.apiVersion,
    sourceInstanceId: value.sourceInstanceId,
    applicationId: value.applicationId,
    historyEpoch: value.historyEpoch,
    replayed: value.replayed,
    accepted: value.accepted,
    resource: value.resource,
    data: value.data,
  });
}
async function detailEvidenceSha256(value: unknown): Promise<string | null> {
  const stable = stableDetailEvidence(value);
  return stable === null ? null : sha256(stable);
}
async function storedDetailEvidenceSha256(value: Receipt): Promise<string | null> {
  if (await sha256(value.canonical_detail_read_json) !== value.canonical_detail_read_sha256) return null;
  try { return detailEvidenceSha256(JSON.parse(value.canonical_detail_read_json)); }
  catch { return null; }
}
function canonicalRequest(input: ProjectAlphaProjectAdoptionReviewSelection, caller: ProjectAlphaProjectAdoptionReviewProducerActor): string {
  return JSON.stringify({ version: 1, idempotencyKey: input.idempotencyKey, sourceId: input.sourceId,
    externalProjectId: input.externalProjectId, projectAlphaPublicId: input.projectAlphaPublicId,
    reviewer: { staffId: caller.staffId, accessSubject: caller.accessSubject } });
}
function configured(env: ProjectAlphaProjectAdoptionReviewProducerEnvironment, sourceId: string): Configured | null {
  try {
    const value = resolveProjectAlphaApiV2Connection(env, sourceId);
    return value.enabled ? { sourceId: value.sourceId, baseUrl: value.connection.baseUrl,
      sourceInstanceId: value.connection.expectedSourceInstanceId, applicationId: value.connection.expectedApplicationId,
      historyEpochId: value.connection.expectedHistoryEpoch! } : null;
  } catch { return null; }
}
async function destination(db: D1Database, input: ProjectAlphaProjectAdoptionReviewSelection): Promise<Destination | null> {
  return db.prepare(`SELECT source_id,application_id,destination_base_url,expected_source_instance_id,expected_history_epoch_id
    FROM project_alpha_project_destinations WHERE external_project_id=?`).bind(input.externalProjectId).first<Destination>();
}
function exactDestination(value: Destination | null, connection: Configured): boolean {
  return !!value && value.source_id === connection.sourceId && value.application_id === connection.applicationId
    && value.destination_base_url === connection.baseUrl && value.expected_source_instance_id === connection.sourceInstanceId
    && value.expected_history_epoch_id === connection.historyEpochId;
}
async function localState(db: D1Database, input: ProjectAlphaProjectAdoptionReviewSelection, connection: Configured): Promise<LocalState> {
  return (await db.prepare(`SELECT
    (SELECT count(*) FROM operations_shared_projects project WHERE project.external_project_id=?) heads,
    (SELECT count(*) FROM project_alpha_project_mappings mapping WHERE mapping.external_project_id=?
      OR (mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=?
        AND mapping.history_epoch_id=? AND mapping.project_alpha_public_id=?)) mappings,
    (SELECT count(*) FROM project_alpha_project_outbox outbox WHERE outbox.external_project_id=?
      AND outbox.state IN ('pending','leased')) pending`).bind(input.externalProjectId, input.externalProjectId,
    connection.sourceId, connection.sourceInstanceId, connection.applicationId, connection.historyEpochId,
    input.projectAlphaPublicId, input.externalProjectId).first<LocalState>())!;
}
function free(value: LocalState): boolean { return value.heads === 0 && value.mappings === 0 && value.pending === 0; }
async function actorState(db: D1Database, caller: ProjectAlphaProjectAdoptionReviewProducerActor): Promise<ActorState | null> {
  return db.prepare(`SELECT admission.version admission_version,profile.version profile_version,generation.generation,
      EXISTS(SELECT 1 FROM staff_role_assignments assignment WHERE assignment.staff_id=admission.staff_id
        AND assignment.role_id='role-owner' AND assignment.scope='global') owner
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?`)
    .bind(caller.staffId, caller.accessSubject).first<ActorState>();
}
async function grants(db: D1Database, staffId: string): Promise<readonly Grant[]> {
  return (await db.prepare(`SELECT effect,scope_kind,business_area_id,division_id,external_project_id
    FROM native_project_grants WHERE staff_id=? AND capability='project.shared.sync' AND active=1
    ORDER BY effect,scope_kind,ifnull(business_area_id,''),ifnull(division_id,''),ifnull(external_project_id,'')`)
    .bind(staffId).all<Grant>()).results;
}
function applicable(grant: Grant, externalProjectId: string, scope?: Scope): boolean {
  return grant.scope_kind === "global" || grant.scope_kind === "exact_project" && grant.external_project_id === externalProjectId
    || !!scope && grant.scope_kind === "business_area" && grant.business_area_id === scope.businessAreaId
    || !!scope && grant.scope_kind === "division" && grant.division_id === scope.divisionId;
}
function authorized(rows: readonly Grant[], externalProjectId: string, scopes: readonly Scope[]): boolean {
  const applicableScopes: readonly (Scope | undefined)[] = scopes.length ? scopes : [undefined];
  return applicableScopes.every(scope => rows.some(row => row.effect === "allow" && applicable(row, externalProjectId, scope)))
    && !applicableScopes.some(scope => rows.some(row => row.effect === "deny" && applicable(row, externalProjectId, scope)));
}
async function oneMapping(db: D1Database, connection: Configured, kind: "organization" | "client", publicId: string | null): Promise<string | null | undefined> {
  if (publicId === null) return null;
  const result = await db.prepare(`SELECT mapping.external_id FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind=?
    WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND mapping.resource_type=? AND mapping.project_alpha_public_id=? ORDER BY mapping.external_id`)
    .bind(kind, connection.sourceId, connection.sourceInstanceId, connection.applicationId,
      connection.historyEpochId, kind, publicId).all<{ external_id: string }>();
  return result.results.length === 1 ? result.results[0]!.external_id : undefined;
}
async function directoryIdentity(db: D1Database, connection: Configured,
  organizationPublicId: string | null, clientPublicId: string | null): Promise<DirectoryIdentity | null | "relationship"> {
  const [organizationRecordId, clientRecordId] = await Promise.all([
    oneMapping(db, connection, "organization", organizationPublicId),
    oneMapping(db, connection, "client", clientPublicId),
  ]);
  if (organizationRecordId === undefined || clientRecordId === undefined) return null;
  if (organizationRecordId !== null && clientRecordId !== null && !await db.prepare(`SELECT 1 present
    FROM operations_directory_client_organizations WHERE organization_record_id=? AND client_record_id=?`)
    .bind(organizationRecordId, clientRecordId).first("present")) return "relationship";
  const ids = [organizationRecordId, clientRecordId].filter((value): value is string => value !== null);
  const scopeRows = ids.length === 0 ? [] : (await db.prepare(`SELECT scope.scope_kind,scope.business_area_id,scope.division_id,
      area.active area_active,division.active division_active
    FROM native_directory_resource_scopes scope JOIN native_business_areas area ON area.id=scope.business_area_id
    LEFT JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id
    WHERE scope.active=1 AND scope.record_id IN (${ids.map(() => "?").join(",")})
    ORDER BY scope.scope_kind,scope.business_area_id,ifnull(scope.division_id,'')`).bind(...ids).all<{
      scope_kind: "business_area" | "division"; business_area_id: string; division_id: string | null;
      area_active: number; division_active: number | null;
    }>()).results;
  const unique = new Map<string, Scope>();
  for (const row of scopeRows) {
    if (row.area_active !== 1 || row.scope_kind === "division" && (row.division_id === null || row.division_active !== 1)) return null;
    const scope: Scope = row.scope_kind === "business_area"
      ? { scopeKind: "business_area", businessAreaId: row.business_area_id, divisionId: null }
      : { scopeKind: "division", businessAreaId: row.business_area_id, divisionId: row.division_id! };
    unique.set(`${scope.scopeKind}\0${scope.businessAreaId}\0${scope.divisionId ?? ""}`, scope);
  }
  return { organizationRecordId, clientRecordId, scopes: [...unique.values()] };
}
function remoteOutcome(value: { status: string }): ProjectAlphaProjectAdoptionReviewProducerOutcome {
  return value.status === "uncertain" ? { status: "uncertain", reason: "remote" }
    : { status: "blocked", reason: "remote" };
}
async function remoteEvidence(env: ProjectAlphaProjectAdoptionReviewProducerEnvironment,
  input: ProjectAlphaProjectAdoptionReviewSelection, send: typeof fetch): Promise<RemoteEvidence | ProjectAlphaProjectAdoptionReviewProducerOutcome> {
  const [detailOutcome, binding] = await Promise.all([
    readConfiguredProjectAlphaProject(env, input.sourceId, input.projectAlphaPublicId, send),
    readConfiguredProjectAlphaProjectBindingStatus(env, input.sourceId, input.externalProjectId, send),
  ]);
  if (detailOutcome.status !== "read") return remoteOutcome(detailOutcome);
  if (binding.status !== "observed") return remoteOutcome(binding);
  const detail = validatedProjectAlphaProjectRead(detailOutcome);
  if (!detail) return { status: "uncertain", reason: "remote" };
  const resource = detail.response.resource, data = detail.response.data;
  if (binding.response.binding.publicId !== input.projectAlphaPublicId
    || binding.response.resource.revision !== resource.revision
    || binding.response.resource.projectionSha256 !== resource.projectionSha256
    || binding.response.resource.status !== data.status || binding.response.resource.archived !== data.archived)
    return { status: "blocked", reason: "remote" };

  const inventory: ProjectAlphaProjectInventory[] = [];
  let cursor: string | null = null, previous: string | null = null, matches = 0;
  for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
    const outcome = await readConfiguredProjectAlphaProjectInventory(env, input.sourceId, { cursor, limit: 200 }, send);
    if (outcome.status !== "observed") return remoteOutcome(outcome);
    if (outcome.response.authorizationGeneration !== binding.response.authorizationGeneration)
      return { status: "blocked", reason: "remote" };
    for (const item of outcome.response.projects) {
      if (previous !== null && item.externalId <= previous) return { status: "blocked", reason: "remote" };
      previous = item.externalId;
      if (item.externalId === input.externalProjectId || item.publicId === input.projectAlphaPublicId) {
        if (item.externalId !== input.externalProjectId || item.publicId !== input.projectAlphaPublicId)
          return { status: "blocked", reason: "remote" };
        matches += 1;
        if (item.revision !== resource.revision || item.projectionSha256 !== resource.projectionSha256
          || item.status !== data.status || item.archived !== data.archived) return { status: "blocked", reason: "remote" };
      }
    }
    inventory.push(outcome.response);
    if (outcome.response.nextCursor === null) break;
    cursor = outcome.response.nextCursor;
    if (page === MAX_INVENTORY_PAGES - 1) return { status: "blocked", reason: "remote" };
  }
  if (matches !== 1) return { status: "blocked", reason: "remote" };
  const independentEvidenceSha256 = await sha256(canonical({ version: 1,
    binding: { authorizationGeneration: binding.response.authorizationGeneration,
      binding: binding.response.binding, resource: binding.response.resource },
    inventory: inventory.map(page => ({ authorizationGeneration: page.authorizationGeneration,
      projects: page.projects, nextCursor: page.nextCursor })) }));
  return { detail, binding, inventory, authorizationGeneration: binding.response.authorizationGeneration, independentEvidenceSha256 };
}
async function prior(db: D1Database, idempotencyKey: string, requestSha256: string): Promise<Receipt | null> {
  return db.prepare(`SELECT receipt.idempotency_key,receipt.request_sha256,receipt.canonical_request_json,
      receipt.review_item_id,receipt.source_id,receipt.external_project_id,receipt.project_alpha_public_id,
      receipt.reviewer_staff_id,receipt.reviewer_access_subject,review.source_instance_id,review.application_id,
      review.history_epoch_id,review.project_alpha_revision,review.projection_sha256,review.authorization_generation,
      review.canonical_detail_read_json,review.canonical_detail_read_sha256,review.organization_record_id,
      review.organization_project_alpha_public_id,review.client_record_id,review.client_project_alpha_public_id,
      review.reviewer_admission_version,review.reviewer_profile_version,review.independent_evidence_sha256,
      review.project_grant_generation,review.normalized_scopes_json,review.expires_at
    FROM project_alpha_project_adoption_review_producer_receipts receipt
    JOIN project_alpha_project_adoption_review_evidence review ON review.review_item_id=receipt.review_item_id
    WHERE receipt.idempotency_key=? OR receipt.request_sha256=? ORDER BY receipt.created_at,receipt.producer_receipt_id LIMIT 1`)
    .bind(idempotencyKey, requestSha256).first<Receipt>();
}
async function exactReplay(saved: Receipt, input: ProjectAlphaProjectAdoptionReviewSelection,
  caller: ProjectAlphaProjectAdoptionReviewProducerActor, requestJson: string, connection: Configured,
  currentActor: ActorState, directory: DirectoryIdentity, evidence: RemoteEvidence, scopesJson: string): Promise<boolean> {
  const detail = evidence.detail.response;
  const [savedStableDetailSha256, observedStableDetailSha256] = await Promise.all([
    storedDetailEvidenceSha256(saved), detailEvidenceSha256(detail),
  ]);
  return savedStableDetailSha256 !== null && observedStableDetailSha256 !== null
    && savedStableDetailSha256 === observedStableDetailSha256
    && saved.canonical_request_json === requestJson && saved.source_id === input.sourceId
    && saved.external_project_id === input.externalProjectId && saved.project_alpha_public_id === input.projectAlphaPublicId
    && saved.reviewer_staff_id === caller.staffId && saved.reviewer_access_subject === caller.accessSubject
    && saved.source_instance_id === connection.sourceInstanceId && saved.application_id === connection.applicationId
    && saved.history_epoch_id === connection.historyEpochId && saved.project_alpha_revision === detail.resource.revision
    && saved.projection_sha256 === detail.resource.projectionSha256
    && saved.authorization_generation === evidence.authorizationGeneration
    && saved.organization_record_id === directory.organizationRecordId
    && saved.organization_project_alpha_public_id === detail.data.organizationPublicId
    && saved.client_record_id === directory.clientRecordId
    && saved.client_project_alpha_public_id === detail.data.clientPublicId
    && saved.reviewer_admission_version === currentActor.admission_version
    && saved.reviewer_profile_version === currentActor.profile_version
    && saved.independent_evidence_sha256 === evidence.independentEvidenceSha256
    && saved.project_grant_generation === currentActor.generation
    && saved.normalized_scopes_json === scopesJson && Date.parse(saved.expires_at) > Date.now();
}

export async function produceProjectAlphaProjectAdoptionReview(
  env: ProjectAlphaProjectAdoptionReviewProducerEnvironment,
  callerValue: unknown,
  selectionValue: unknown,
  send: typeof fetch = fetch,
): Promise<ProjectAlphaProjectAdoptionReviewProducerOutcome> {
  if (!actor(callerValue)) return { status: "rejected", reason: "invalid_actor" };
  if (!selection(selectionValue)) return { status: "rejected", reason: "invalid_selection" };
  const caller = callerValue, input = selectionValue, connection = configured(env, input.sourceId);
  if (!connection) return { status: "blocked", reason: "configuration" };
  const requestJson = canonicalRequest(input, caller), requestSha256 = await sha256(requestJson);
  try {
    const existing = await prior(env.OPS_DB, input.idempotencyKey, requestSha256);
    if (existing?.idempotency_key === input.idempotencyKey && existing.request_sha256 !== requestSha256)
      return { status: "conflict", reason: "idempotency_key" };
    if (existing && existing.idempotency_key !== input.idempotencyKey && existing.request_sha256 === requestSha256)
      return { status: "conflict", reason: "request_sha256" };
  } catch { return { status: "uncertain", reason: "database" }; }
  let configuredDestination: Destination | null, initialLocal: LocalState, currentActor: ActorState | null;
  try {
    [configuredDestination, initialLocal, currentActor] = await Promise.all([
      destination(env.OPS_DB, input), localState(env.OPS_DB, input, connection), actorState(env.OPS_DB, caller),
    ]);
  } catch { return { status: "uncertain", reason: "database" }; }
  if (!exactDestination(configuredDestination, connection)) return { status: "blocked", reason: "destination" };
  if (!free(initialLocal)) return { status: "blocked", reason: "local_state" };
  if (!currentActor || currentActor.owner !== 1) return { status: "blocked", reason: "authority" };

  const observed = await remoteEvidence(env, input, send).catch((): ProjectAlphaProjectAdoptionReviewProducerOutcome => ({ status: "uncertain", reason: "remote" }));
  if (!("detail" in observed)) return observed;
  let directory: DirectoryIdentity | null | "relationship", liveGrants: readonly Grant[];
  try {
    [directory, liveGrants] = await Promise.all([
      directoryIdentity(env.OPS_DB, connection, observed.detail.response.data.organizationPublicId,
        observed.detail.response.data.clientPublicId),
      grants(env.OPS_DB, caller.staffId),
    ]);
  } catch { return { status: "uncertain", reason: "database" }; }
  if (directory === "relationship") return { status: "blocked", reason: "relationship" };
  if (!directory) return { status: "blocked", reason: "directory" };
  if (!authorized(liveGrants, input.externalProjectId, directory.scopes)) return { status: "blocked", reason: "authority" };
  const scopesJson = JSON.stringify(directory.scopes);
  if ([requestSha256, observed.detail.responseSha256, observed.detail.response.resource.projectionSha256]
    .includes(observed.independentEvidenceSha256)) return { status: "uncertain", reason: "remote" };

  try {
    const [finalDestination, finalLocal, finalActor, finalDirectory, finalGrants] = await Promise.all([
      destination(env.OPS_DB, input), localState(env.OPS_DB, input, connection), actorState(env.OPS_DB, caller),
      directoryIdentity(env.OPS_DB, connection, observed.detail.response.data.organizationPublicId,
        observed.detail.response.data.clientPublicId), grants(env.OPS_DB, caller.staffId),
    ]);
    if (!exactDestination(finalDestination, connection)) return { status: "blocked", reason: "destination" };
    if (!free(finalLocal)) return { status: "blocked", reason: "local_state" };
    if (!finalActor || finalActor.owner !== 1 || JSON.stringify(finalActor) !== JSON.stringify(currentActor)
      || !authorized(finalGrants, input.externalProjectId, directory.scopes)) return { status: "blocked", reason: "authority" };
    if (finalDirectory === "relationship") return { status: "blocked", reason: "relationship" };
    if (!finalDirectory || JSON.stringify(finalDirectory) !== JSON.stringify(directory)) return { status: "blocked", reason: "directory" };
    const saved = await prior(env.OPS_DB, input.idempotencyKey, requestSha256);
    if (saved) {
      if (saved.idempotency_key !== input.idempotencyKey) return { status: "conflict", reason: "request_sha256" };
      if (saved.request_sha256 !== requestSha256) return { status: "conflict", reason: "idempotency_key" };
      return await exactReplay(saved, input, caller, requestJson, connection, finalActor, directory, observed, scopesJson)
        ? { status: "reviewed", reviewItemId: saved.review_item_id, requestSha256, replayed: true }
        : { status: "blocked", reason: "stale_evidence" };
    }

    const reviewItemId = crypto.randomUUID(), producerReceiptId = crypto.randomUUID();
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_adoption_review_evidence(
        review_item_id,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,
        external_project_id,project_alpha_public_id,project_alpha_revision,projection_sha256,
        authorization_generation,canonical_detail_read_json,canonical_detail_read_sha256,
        organization_record_id,organization_project_alpha_public_id,client_record_id,client_project_alpha_public_id,
        reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,
        reviewer_owner_role_id,independent_evidence_sha256,project_grant_generation,normalized_scopes_json,
        reviewed_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'role-owner',?,?,?,
          strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'))`).bind(
        reviewItemId, requestSha256, connection.sourceId, connection.sourceInstanceId, connection.applicationId,
        connection.historyEpochId, input.externalProjectId, input.projectAlphaPublicId,
        observed.detail.response.resource.revision, observed.detail.response.resource.projectionSha256,
        observed.authorizationGeneration, observed.detail.responseJson, observed.detail.responseSha256,
        directory.organizationRecordId, observed.detail.response.data.organizationPublicId,
        directory.clientRecordId, observed.detail.response.data.clientPublicId, caller.staffId, caller.accessSubject,
        finalActor.admission_version, finalActor.profile_version, observed.independentEvidenceSha256,
        finalActor.generation, scopesJson),
      env.OPS_DB.prepare(`INSERT INTO project_alpha_project_adoption_review_producer_receipts(
        producer_receipt_id,idempotency_key,request_sha256,canonical_request_json,review_item_id,source_id,
        external_project_id,project_alpha_public_id,reviewer_staff_id,reviewer_access_subject)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(producerReceiptId, input.idempotencyKey, requestSha256, requestJson,
        reviewItemId, input.sourceId, input.externalProjectId, input.projectAlphaPublicId, caller.staffId, caller.accessSubject),
    ]);
    const inserted = await prior(env.OPS_DB, input.idempotencyKey, requestSha256);
    if (!inserted || inserted.review_item_id !== reviewItemId || !await exactReplay(inserted, input, caller, requestJson,
      connection, finalActor, directory, observed, scopesJson)) return { status: "uncertain", reason: "database" };
    return { status: "reviewed", reviewItemId, requestSha256, replayed: false };
  } catch (error) {
    try {
      const winner = await prior(env.OPS_DB, input.idempotencyKey, requestSha256);
      if (winner) {
        if (winner.idempotency_key !== input.idempotencyKey) return { status: "conflict", reason: "request_sha256" };
        if (winner.request_sha256 !== requestSha256) return { status: "conflict", reason: "idempotency_key" };
        return await exactReplay(winner, input, caller, requestJson, connection, currentActor, directory, observed, scopesJson)
          ? { status: "reviewed", reviewItemId: winner.review_item_id, requestSha256, replayed: true }
          : { status: "blocked", reason: "stale_evidence" };
      }
    } catch { return { status: "uncertain", reason: "database" }; }
    const message = error instanceof Error ? error.message : "";
    return /current authority|not exact|constraint failed|SQLITE_CONSTRAINT|UNIQUE constraint/i.test(message)
      ? { status: "blocked", reason: "stale_evidence" }
      : { status: "uncertain", reason: "database" };
  }
}
