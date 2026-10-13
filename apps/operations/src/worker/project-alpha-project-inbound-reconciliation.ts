import { resolveProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import { readConfiguredProjectAlphaProject, validatedProjectAlphaProjectRead } from "./project-alpha-project-read-api-v2";
import { readConfiguredProjectAlphaProjectBindingStatus } from "./project-alpha-project-binding-status-api-v2";

export type InboundProjectActor = Readonly<{ staffId: string; accessSubject: string }>;
export type InboundProjectSelection = Readonly<{ idempotencyKey: string; sourceId: string; externalProjectId: string }>;
export type InboundProjectDecision = "accept_project_alpha" | "keep_operations" | "requires_follow_up";
export type InboundProjectResolution = Readonly<{ idempotencyKey: string; proposalId: string; decision: InboundProjectDecision }>;
export type InboundProjectEnvironment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;

export type InboundProjectProposalDiffField = "name" | "description" | "status" | "archived"
  | "overdueWarning" | "completedAt" | "archivedAt" | "estimatedStart" | "estimatedEnd"
  | "organizationRecordId" | "clientRecordId" | "scopes";
export type InboundProjectProposalReviewSide = Readonly<{
  revision: string;
  name: string;
  description: string | null;
  status: "not_started" | "active" | "completed" | "cancelled";
  archived: boolean;
  overdueWarning: boolean;
  completedAt: string | null;
  archivedAt: string | null;
  estimatedStart: string | null;
  estimatedEnd: string | null;
  organizationRecordId: string | null;
  clientRecordId: string | null;
  scopes: readonly InboundProjectScope[];
}>;
export type InboundProjectProposalReview = Readonly<{
  proposalId: string;
  sourceId: string;
  externalProjectId: string;
  projectAlphaPublicId: string;
  expectedLocalVersion: number;
  expiresAt: string;
  operations: InboundProjectProposalReviewSide;
  projectAlpha: InboundProjectProposalReviewSide;
  changedFields: readonly InboundProjectProposalDiffField[];
}>;
export type InboundProjectProposalReviewOutcome =
  | Readonly<{ status: "available"; proposal: InboundProjectProposalReview }>
  | Readonly<{ status: "unavailable"; reason: "not_found" | "authority" | "stale_evidence" | "invalid_evidence" | "database" }>;

export type InboundProjectProposalOutcome =
  | Readonly<{ status: "proposed"; proposalId: string; replayed: boolean }>
  | Readonly<{ status: "unchanged" }>
  | Readonly<{ status: "rejected"; reason: "invalid_actor" | "invalid_selection" }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "mapping" | "observation" | "conflict" | "authority" | "directory" | "stale_evidence" | "remote" }>
  | Readonly<{ status: "conflict"; reason: "idempotency_key" }>
  | Readonly<{ status: "uncertain"; reason: "database" | "remote" }>;
export type InboundProjectResolutionOutcome =
  | Readonly<{ status: "resolved"; resolutionId: string; decision: InboundProjectDecision;
      syncStatus: "synchronized" | "divergent"; resultingVersion: number; replayed: boolean }>
  | Readonly<{ status: "rejected"; reason: "invalid_actor" | "invalid_resolution" }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "authority" | "directory" | "stale_evidence" | "remote" }>
  | Readonly<{ status: "conflict"; reason: "idempotency_key" | "already_resolved" }>
  | Readonly<{ status: "uncertain"; reason: "database" | "remote" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
type Head = Readonly<{ external_project_id: string; source_id: string; source_instance_id: string; application_id: string;
  history_epoch_id: string; project_alpha_public_id: string; pa_revision: string; current_version: number;
  canonical_projection_sha256: string; name: string; description: string | null; lifecycle: string; archived: number;
  overdue_warning: number; completed_at: string | null; archived_at: string | null; planned_start: string | null;
  planned_end: string | null; organization_record_id: string | null; client_record_id: string | null; scopes_json: string }>;
type ActorState = Readonly<{ admission_version: number; profile_version: number; generation: number }>;
type Observation = Readonly<{ request_id: string; authorization_generation: string; resource_revision: string;
  projection_sha256: string; external_project_id: string; project_alpha_public_id: string; has_conflict: number }>;
export type InboundProjectGrant = Readonly<{ effect: "allow" | "deny"; scope_kind: "global" | "business_area" | "division" | "exact_project";
  business_area_id: string | null; division_id: string | null; external_project_id: string | null }>;
export type InboundProjectScope = Readonly<{ scopeKind: "business_area"; businessAreaId: string; divisionId: null }>
  | Readonly<{ scopeKind: "division"; businessAreaId: string; divisionId: string }>;
type Proposal = Readonly<{ proposal_id: string; idempotency_key: string; request_sha256: string; source_id: string;
  source_instance_id: string; application_id: string; history_epoch_id: string; external_project_id: string;
  project_alpha_public_id: string; expected_local_version: number; expected_local_projection_sha256: string;
  observed_request_id: string; observed_authorization_generation: string; observed_remote_revision: string;
  observed_remote_projection_sha256: string; local_snapshot_json: string; remote_snapshot_json: string;
  remote_snapshot_sha256: string; target_organization_record_id: string | null; target_client_record_id: string | null;
  reviewer_staff_id: string; reviewer_access_subject: string; reviewer_admission_version: number;
  reviewer_profile_version: number; project_grant_generation: number; normalized_scopes_json: string; expires_at: string }>;
type ResolutionReceipt = Readonly<{ resolution_id: string; decision: InboundProjectDecision; resulting_local_version: number;
  proposal_id: string; idempotency_key: string; request_sha256: string }>;
type ReviewProposal = Pick<Proposal, "proposal_id" | "source_id" | "source_instance_id" | "application_id"
  | "history_epoch_id" | "external_project_id" | "project_alpha_public_id" | "expected_local_version"
  | "expected_local_projection_sha256" | "observed_remote_revision" | "observed_remote_projection_sha256"
  | "local_snapshot_json" | "remote_snapshot_json" | "remote_snapshot_sha256" | "target_organization_record_id"
  | "target_client_record_id" | "reviewer_staff_id" | "reviewer_access_subject" | "reviewer_admission_version"
  | "reviewer_profile_version" | "project_grant_generation" | "normalized_scopes_json" | "expires_at">;

function exactObject(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key));
}
function validActor(value: unknown): value is InboundProjectActor {
  return exactObject(value, ["staffId", "accessSubject"])
    && typeof value.staffId === "string" && value.staffId.length > 0 && value.staffId.length <= 191
    && typeof value.accessSubject === "string" && value.accessSubject.length > 0 && value.accessSubject.length <= 764;
}
function validSelection(value: unknown): value is InboundProjectSelection {
  return exactObject(value, ["idempotencyKey", "sourceId", "externalProjectId"])
    && typeof value.idempotencyKey === "string" && UUID.test(value.idempotencyKey)
    && typeof value.sourceId === "string" && SOURCE.test(value.sourceId)
    && typeof value.externalProjectId === "string" && value.externalProjectId.length > 0 && value.externalProjectId.length <= 191;
}
function validResolution(value: unknown): value is InboundProjectResolution {
  return exactObject(value, ["idempotencyKey", "proposalId", "decision"])
    && typeof value.idempotencyKey === "string" && UUID.test(value.idempotencyKey)
    && typeof value.proposalId === "string" && UUID.test(value.proposalId)
    && ["accept_project_alpha", "keep_operations", "requires_follow_up"].includes(value.decision as string);
}
function validRecordId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 191 && !/\p{C}/u.test(value);
}
function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function validPublicId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}
function validDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(value);
}
function validTimestamp(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^(?:[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z|[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{6})?)$/.test(value)) return false;
  const normalized = value.includes(" ")
    ? `${value.replace(" ", "T").replace(/\.(\d{3})\d{3}$/, ".$1").replace(/(?<!\.\d{3})$/, ".000")}Z`
    : value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z");
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === normalized;
}
function validDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
function validStatus(value: unknown): value is InboundProjectProposalReviewSide["status"] {
  return value === "not_started" || value === "active" || value === "completed" || value === "cancelled";
}
function validName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 150 && !/\p{C}/u.test(value);
}
function validDescription(value: unknown): value is string | null {
  return value === null || typeof value === "string" && Array.from(value).length <= 10_000 && !/\p{C}/u.test(value);
}
function parseScopes(value: unknown): readonly InboundProjectScope[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const parsed: InboundProjectScope[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (exactObject(item, ["scopeKind", "businessAreaId", "divisionId"])
      && item.scopeKind === "business_area" && validRecordId(item.businessAreaId) && item.divisionId === null) {
      const key = `business_area\0${item.businessAreaId}\0`;
      if (seen.has(key)) return null;
      seen.add(key);
      parsed.push({ scopeKind: "business_area", businessAreaId: item.businessAreaId, divisionId: null });
      continue;
    }
    if (exactObject(item, ["scopeKind", "businessAreaId", "divisionId"])
      && item.scopeKind === "division" && validRecordId(item.businessAreaId) && validRecordId(item.divisionId)) {
      const key = `division\0${item.businessAreaId}\0${item.divisionId}`;
      if (seen.has(key)) return null;
      seen.add(key);
      parsed.push({ scopeKind: "division", businessAreaId: item.businessAreaId, divisionId: item.divisionId });
      continue;
    }
    return null;
  }
  return parsed;
}
function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
}
function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort()
      .map(key => [key, normalize((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(normalize(value));
}
async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function connection(env: InboundProjectEnvironment, sourceId: string) {
  try { const result = resolveProjectAlphaApiV2Connection(env, sourceId); return result.enabled ? result.connection : null; }
  catch { return null; }
}
async function head(db: D1Database, externalId: string): Promise<Head | null> {
  return db.prepare(`SELECT external_project_id,source_id,source_instance_id,application_id,history_epoch_id,
    project_alpha_public_id,pa_revision,current_version,canonical_projection_sha256,name,description,lifecycle,
    archived,overdue_warning,completed_at,archived_at,planned_start,planned_end,organization_record_id,
    client_record_id,scopes_json FROM operations_shared_projects WHERE external_project_id=?`).bind(externalId).first<Head>();
}
async function actorState(db: D1Database, actor: InboundProjectActor): Promise<ActorState | null> {
  return db.prepare(`SELECT admission.version admission_version,profile.version profile_version,generation.generation
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?`)
    .bind(actor.staffId, actor.accessSubject).first<ActorState>();
}
async function grants(db: D1Database, staffId: string): Promise<readonly InboundProjectGrant[]> {
  return (await db.prepare(`SELECT effect,scope_kind,business_area_id,division_id,external_project_id
    FROM native_project_grants WHERE staff_id=? AND capability='project.shared.sync' AND active=1
    ORDER BY effect,scope_kind,ifnull(business_area_id,''),ifnull(division_id,''),ifnull(external_project_id,'')`)
    .bind(staffId).all<InboundProjectGrant>()).results;
}
function applies(grant: InboundProjectGrant, externalId: string, scope?: InboundProjectScope): boolean {
  return grant.scope_kind === "global" || grant.scope_kind === "exact_project" && grant.external_project_id === externalId
    || !!scope && grant.scope_kind === "business_area" && grant.business_area_id === scope.businessAreaId
    || !!scope && grant.scope_kind === "division" && grant.business_area_id === scope.businessAreaId
      && grant.division_id === scope.divisionId;
}
export function isProjectInboundAuthorized(rows: readonly InboundProjectGrant[], externalId: string,
  scopes: readonly InboundProjectScope[]): boolean {
  const set: readonly (InboundProjectScope | undefined)[] = scopes.length ? scopes : [undefined];
  return set.every(scope => rows.some(row => row.effect === "allow" && applies(row, externalId, scope)))
    && !set.some(scope => rows.some(row => row.effect === "deny" && applies(row, externalId, scope)));
}
export function safeProjectInboundDecision(requested: InboundProjectDecision,
  current: Readonly<{ organizationRecordId: string | null; clientRecordId: string | null }>,
  target: Readonly<{ organizationRecordId: string | null; clientRecordId: string | null }>): InboundProjectDecision {
  // The current outbound project API cannot represent every inbound field, and
  // its compare-and-swap contract is tied to the local projection hash. Until
  // a complete divergence-aware writeback exists, keeping Operations is a
  // review disposition only—not proof that Project Alpha has converged.
  if (requested === "keep_operations") return "requires_follow_up";
  return requested === "accept_project_alpha"
    && (current.organizationRecordId !== target.organizationRecordId || current.clientRecordId !== target.clientRecordId)
    ? "requires_follow_up" : requested;
}
async function directory(db: D1Database, head: Head, organizationPublicId: string | null, clientPublicId: string | null) {
  async function one(kind: "organization" | "client", publicId: string | null) {
    if (publicId === null) return null;
    const rows = await db.prepare(`SELECT mapping.record_id FROM project_alpha_active_directory_mappings mapping
      JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=?
      WHERE mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
        AND mapping.resource_type=? AND mapping.project_alpha_public_id=? ORDER BY mapping.record_id`).bind(kind, head.source_id,
      head.source_instance_id, head.application_id, head.history_epoch_id, kind, publicId).all<{ record_id: string }>();
    return rows.results.length === 1 ? rows.results[0]!.record_id : undefined;
  }
  const [organizationRecordId, clientRecordId] = await Promise.all([one("organization", organizationPublicId), one("client", clientPublicId)]);
  if (organizationRecordId === undefined || clientRecordId === undefined) return null;
  if (organizationRecordId && clientRecordId && !await db.prepare(`SELECT 1 ok FROM operations_directory_client_organizations
    WHERE organization_record_id=? AND client_record_id=?`).bind(organizationRecordId, clientRecordId).first("ok")) return null;
  const ids = [organizationRecordId, clientRecordId].filter((id): id is string => !!id);
  const rows = ids.length ? (await db.prepare(`SELECT scope.scope_kind,scope.business_area_id,scope.division_id,
      area.active area_active,division.active division_active FROM native_directory_resource_scopes scope
      JOIN native_business_areas area ON area.id=scope.business_area_id
      LEFT JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id
      WHERE scope.active=1 AND scope.record_id IN (${ids.map(() => "?").join(",")})
      ORDER BY scope.scope_kind,scope.business_area_id,ifnull(scope.division_id,'')`).bind(...ids).all<{
        scope_kind: "business_area" | "division"; business_area_id: string; division_id: string | null;
        area_active: number; division_active: number | null } >()).results : [];
  const unique = new Map<string, InboundProjectScope>();
  for (const row of rows) {
    if (row.area_active !== 1 || row.scope_kind === "division" && (row.division_id === null || row.division_active !== 1)) return null;
    const scope: InboundProjectScope = row.scope_kind === "business_area"
      ? { scopeKind: "business_area", businessAreaId: row.business_area_id, divisionId: null }
      : { scopeKind: "division", businessAreaId: row.business_area_id, divisionId: row.division_id! };
    unique.set(`${scope.scopeKind}\0${scope.businessAreaId}\0${scope.divisionId ?? ""}`, scope);
  }
  return { organizationRecordId, clientRecordId, scopes: [...unique.values()] };
}
async function observation(db: D1Database, value: Head): Promise<Observation | null> {
  const rows = await db.prepare(`SELECT observation.request_id,receipt.authorization_generation,
      observation.resource_revision,observation.projection_sha256,observation.external_project_id,
      observation.project_alpha_public_id,observation.has_conflict
    FROM project_alpha_api_v2_project_observations_current observation
    JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id
      AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id
      AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='project'
      AND receipt.request_id=observation.request_id
    WHERE observation.source_id=? AND observation.source_instance_id=? AND observation.application_id=?
      AND observation.history_epoch_id=? AND observation.external_project_id=?
      AND observation.project_alpha_public_id=?`).bind(value.source_id, value.source_instance_id, value.application_id,
      value.history_epoch_id, value.external_project_id, value.project_alpha_public_id).all<Observation>();
  return rows.results.length === 1 ? rows.results[0]! : null;
}
function localSnapshot(value: Head): string { return canonical(value); }
async function remote(env: InboundProjectEnvironment, value: Head, fetcher: typeof fetch) {
  const [read, binding] = await Promise.all([
    readConfiguredProjectAlphaProject(env, value.source_id, value.project_alpha_public_id, fetcher),
    readConfiguredProjectAlphaProjectBindingStatus(env, value.source_id, value.external_project_id, fetcher),
  ]);
  if (read.status !== "read" || (binding.status !== "observed" && binding.status !== "binding_stale")) return null;
  const evidence = validatedProjectAlphaProjectRead(read); if (!evidence) return null;
  const response = binding.response;
  if (response.binding.externalId !== value.external_project_id || response.binding.publicId !== value.project_alpha_public_id
    || response.resource.revision !== evidence.response.resource.revision
    || response.resource.projectionSha256 !== evidence.response.resource.projectionSha256) return null;
  return { evidence, authorizationGeneration: response.authorizationGeneration };
}
async function proposalByKey(db: D1Database, key: string): Promise<Proposal | null> {
  return db.prepare(`SELECT * FROM project_alpha_project_inbound_proposals WHERE idempotency_key=?`).bind(key).first<Proposal>();
}
async function receiptByProposal(db: D1Database, proposalId: string): Promise<ResolutionReceipt | null> {
  return db.prepare(`SELECT receipt.resolution_id,receipt.proposal_id,receipt.decision,receipt.resulting_local_version,
      authorization.idempotency_key,authorization.request_sha256
    FROM project_alpha_project_inbound_resolution_receipts receipt
    JOIN project_alpha_project_inbound_resolution_authorizations authorization ON authorization.resolution_id=receipt.resolution_id
    WHERE receipt.proposal_id=?`).bind(proposalId).first<ResolutionReceipt>();
}
async function receiptByResolutionKey(db: D1Database, idempotencyKey: string): Promise<ResolutionReceipt | null> {
  return db.prepare(`SELECT receipt.resolution_id,receipt.proposal_id,receipt.decision,receipt.resulting_local_version,
      authorization.idempotency_key,authorization.request_sha256
    FROM project_alpha_project_inbound_resolution_authorizations authorization
    JOIN project_alpha_project_inbound_resolution_receipts receipt ON receipt.resolution_id=authorization.resolution_id
    WHERE authorization.idempotency_key=?`).bind(idempotencyKey).first<ResolutionReceipt>();
}

function validReviewProposal(value: unknown): value is ReviewProposal {
  const fields = ["proposal_id", "source_id", "source_instance_id", "application_id", "history_epoch_id",
    "external_project_id", "project_alpha_public_id", "expected_local_version", "expected_local_projection_sha256",
    "observed_remote_revision", "observed_remote_projection_sha256", "local_snapshot_json", "remote_snapshot_json",
    "remote_snapshot_sha256", "target_organization_record_id", "target_client_record_id", "reviewer_staff_id",
    "reviewer_access_subject", "reviewer_admission_version", "reviewer_profile_version", "project_grant_generation",
    "normalized_scopes_json", "expires_at"] as const;
  if (!exactObject(value, fields)) return false;
  return typeof value.proposal_id === "string" && UUID.test(value.proposal_id)
    && typeof value.source_id === "string" && SOURCE.test(value.source_id)
    && typeof value.source_instance_id === "string" && UUID.test(value.source_instance_id)
    && typeof value.application_id === "string" && UUID.test(value.application_id)
    && typeof value.history_epoch_id === "string" && UUID.test(value.history_epoch_id)
    && validRecordId(value.external_project_id) && validPublicId(value.project_alpha_public_id)
    && Number.isSafeInteger(value.expected_local_version) && (value.expected_local_version as number) >= 1
    && validHash(value.expected_local_projection_sha256) && validDecimal(value.observed_remote_revision)
    && validHash(value.observed_remote_projection_sha256)
    && typeof value.local_snapshot_json === "string" && typeof value.remote_snapshot_json === "string"
    && validHash(value.remote_snapshot_sha256)
    && (value.target_organization_record_id === null || validRecordId(value.target_organization_record_id))
    && (value.target_client_record_id === null || validRecordId(value.target_client_record_id))
    && typeof value.reviewer_staff_id === "string" && value.reviewer_staff_id.length > 0 && value.reviewer_staff_id.length <= 191
    && typeof value.reviewer_access_subject === "string" && value.reviewer_access_subject.length > 0
    && value.reviewer_access_subject.length <= 764
    && Number.isSafeInteger(value.reviewer_admission_version) && (value.reviewer_admission_version as number) >= 1
    && Number.isSafeInteger(value.reviewer_profile_version) && (value.reviewer_profile_version as number) >= 1
    && Number.isSafeInteger(value.project_grant_generation) && (value.project_grant_generation as number) >= 1
    && typeof value.normalized_scopes_json === "string"
    && typeof value.expires_at === "string" && value.expires_at.length === 24 && validTimestamp(value.expires_at);
}

function parsedLocalSnapshot(value: unknown, proposal: ReviewProposal): { side: InboundProjectProposalReviewSide; raw: Head } | null {
  const fields = ["external_project_id", "source_id", "source_instance_id", "application_id", "history_epoch_id",
    "project_alpha_public_id", "pa_revision", "current_version", "canonical_projection_sha256", "name", "description",
    "lifecycle", "archived", "overdue_warning", "completed_at", "archived_at", "planned_start", "planned_end",
    "organization_record_id", "client_record_id", "scopes_json"] as const;
  if (!exactObject(value, fields) || !validRecordId(value.external_project_id)
    || typeof value.source_id !== "string" || !SOURCE.test(value.source_id)
    || typeof value.source_instance_id !== "string" || !UUID.test(value.source_instance_id)
    || typeof value.application_id !== "string" || !UUID.test(value.application_id)
    || typeof value.history_epoch_id !== "string" || !UUID.test(value.history_epoch_id)
    || !validPublicId(value.project_alpha_public_id) || !validDecimal(value.pa_revision)
    || !Number.isSafeInteger(value.current_version) || (value.current_version as number) < 1
    || !validHash(value.canonical_projection_sha256) || !validName(value.name) || !validDescription(value.description)
    || !validStatus(value.lifecycle) || (value.archived !== 0 && value.archived !== 1)
    || (value.overdue_warning !== 0 && value.overdue_warning !== 1) || !validTimestamp(value.completed_at)
    || !validTimestamp(value.archived_at) || !validDate(value.planned_start) || !validDate(value.planned_end)
    || value.planned_start !== null && value.planned_end !== null && value.planned_start > value.planned_end
    || (value.organization_record_id !== null && !validRecordId(value.organization_record_id))
    || (value.client_record_id !== null && !validRecordId(value.client_record_id))
    || typeof value.scopes_json !== "string") return null;
  const scopes = parseScopes(parseJson(value.scopes_json));
  if (!scopes || canonical(scopes) !== value.scopes_json
    || value.external_project_id !== proposal.external_project_id || value.source_id !== proposal.source_id
    || value.source_instance_id !== proposal.source_instance_id || value.application_id !== proposal.application_id
    || value.history_epoch_id !== proposal.history_epoch_id || value.project_alpha_public_id !== proposal.project_alpha_public_id
    || value.current_version !== proposal.expected_local_version
    || value.canonical_projection_sha256 !== proposal.expected_local_projection_sha256) return null;
  const raw = value as unknown as Head;
  return { raw, side: {
    revision: value.pa_revision as string,
    name: value.name as string,
    description: value.description as string | null,
    status: value.lifecycle as InboundProjectProposalReviewSide["status"],
    archived: value.archived === 1,
    overdueWarning: value.overdue_warning === 1,
    completedAt: value.completed_at as string | null,
    archivedAt: value.archived_at as string | null,
    estimatedStart: value.planned_start as string | null,
    estimatedEnd: value.planned_end as string | null,
    organizationRecordId: value.organization_record_id as string | null,
    clientRecordId: value.client_record_id as string | null,
    scopes,
  } };
}

function parsedRemoteSnapshot(value: unknown, proposal: ReviewProposal,
  scopes: readonly InboundProjectScope[]): InboundProjectProposalReviewSide | null {
  if (!exactObject(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed",
    "accepted", "resource", "data"]) || value.apiVersion !== "2" || value.sourceInstanceId !== proposal.source_instance_id
    || value.applicationId !== proposal.application_id || value.historyEpoch !== proposal.history_epoch_id
    || typeof value.requestId !== "string" || !UUID.test(value.requestId) || value.replayed !== false || value.accepted !== true
    || !exactObject(value.resource, ["type", "id", "revision", "projectionSha256"])
    || value.resource.type !== "project" || value.resource.id !== proposal.project_alpha_public_id
    || !validDecimal(value.resource.revision) || value.resource.revision !== proposal.observed_remote_revision
    || !validHash(value.resource.projectionSha256)
    || value.resource.projectionSha256 !== proposal.observed_remote_projection_sha256
    || !exactObject(value.data, ["name", "description", "status", "archived", "overdueWarning", "completedAt", "archivedAt",
      "estimatedStart", "estimatedEnd", "clientPublicId", "organizationPublicId"])) return null;
  const data = value.data;
  if (!validName(data.name) || !validDescription(data.description) || !validStatus(data.status)
    || typeof data.archived !== "boolean" || typeof data.overdueWarning !== "boolean"
    || !validTimestamp(data.completedAt) || !validTimestamp(data.archivedAt)
    || !validDate(data.estimatedStart) || !validDate(data.estimatedEnd)
    || data.estimatedStart !== null && data.estimatedEnd !== null && data.estimatedStart > data.estimatedEnd
    || (data.status === "completed") !== (data.completedAt !== null) || data.archived !== (data.archivedAt !== null)
    || (data.clientPublicId !== null && !validPublicId(data.clientPublicId))
    || (data.organizationPublicId !== null && !validPublicId(data.organizationPublicId))) return null;
  return {
    revision: value.resource.revision,
    name: data.name,
    description: data.description,
    status: data.status,
    archived: data.archived,
    overdueWarning: data.overdueWarning,
    completedAt: data.completedAt,
    archivedAt: data.archivedAt,
    estimatedStart: data.estimatedStart,
    estimatedEnd: data.estimatedEnd,
    organizationRecordId: proposal.target_organization_record_id,
    clientRecordId: proposal.target_client_record_id,
    scopes,
  };
}

function changedFields(operations: InboundProjectProposalReviewSide,
  projectAlpha: InboundProjectProposalReviewSide): readonly InboundProjectProposalDiffField[] {
  const fields: readonly InboundProjectProposalDiffField[] = ["name", "description", "status", "archived", "overdueWarning",
    "completedAt", "archivedAt", "estimatedStart", "estimatedEnd", "organizationRecordId", "clientRecordId", "scopes"];
  return fields.filter(field => canonical(operations[field]) !== canonical(projectAlpha[field]));
}

/**
 * Reads immutable proposal evidence for its original reviewer only. Raw PA
 * envelopes, request identifiers, authority generations, and stored JSON are
 * never returned to the transport.
 */
export async function readProjectAlphaInboundProjectProposal(env: InboundProjectEnvironment, actor: InboundProjectActor,
  proposalId: string): Promise<InboundProjectProposalReviewOutcome> {
  if (!validActor(actor) || !UUID.test(proposalId)) return { status: "unavailable", reason: "not_found" };
  try {
    const proposal = await env.OPS_DB.prepare(`SELECT proposal_id,source_id,source_instance_id,application_id,
      history_epoch_id,external_project_id,project_alpha_public_id,expected_local_version,
      expected_local_projection_sha256,observed_remote_revision,observed_remote_projection_sha256,
      local_snapshot_json,remote_snapshot_json,remote_snapshot_sha256,target_organization_record_id,
      target_client_record_id,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,
      reviewer_profile_version,project_grant_generation,normalized_scopes_json,expires_at
      FROM project_alpha_project_inbound_proposals WHERE proposal_id=?`).bind(proposalId).first<ReviewProposal>();
    if (!proposal) return { status: "unavailable", reason: "not_found" };
    if (!validReviewProposal(proposal)) return { status: "unavailable", reason: "invalid_evidence" };
    if (proposal.reviewer_staff_id !== actor.staffId || proposal.reviewer_access_subject !== actor.accessSubject)
      return { status: "unavailable", reason: "authority" };
    if (proposal.expires_at <= new Date().toISOString()) return { status: "unavailable", reason: "stale_evidence" };
    const scopes = parseScopes(parseJson(proposal.normalized_scopes_json));
    if (!scopes || canonical(scopes) !== proposal.normalized_scopes_json)
      return { status: "unavailable", reason: "invalid_evidence" };
    const local = parsedLocalSnapshot(parseJson(proposal.local_snapshot_json), proposal);
    const remoteJson = parseJson(proposal.remote_snapshot_json);
    if (!local || canonical(local.raw) !== proposal.local_snapshot_json
      || await sha256(proposal.remote_snapshot_json) !== proposal.remote_snapshot_sha256)
      return { status: "unavailable", reason: "invalid_evidence" };
    const projectAlpha = parsedRemoteSnapshot(remoteJson, proposal, scopes);
    if (!projectAlpha) return { status: "unavailable", reason: "invalid_evidence" };
    const [currentActor, liveGrants, exactMapping, currentHead] = await Promise.all([
      actorState(env.OPS_DB, actor), grants(env.OPS_DB, actor.staffId),
      env.OPS_DB.prepare(`SELECT count(*) count FROM project_alpha_project_mappings WHERE external_project_id=?
        AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND project_alpha_public_id=?`)
        .bind(proposal.external_project_id, proposal.source_id, proposal.source_instance_id, proposal.application_id,
          proposal.history_epoch_id, proposal.project_alpha_public_id).first<number>("count"),
      head(env.OPS_DB, proposal.external_project_id),
    ]);
    if (!currentActor || currentActor.admission_version !== proposal.reviewer_admission_version
      || currentActor.profile_version !== proposal.reviewer_profile_version
      || currentActor.generation !== proposal.project_grant_generation || exactMapping !== 1
      || !isProjectInboundAuthorized(liveGrants, proposal.external_project_id, scopes))
      return { status: "unavailable", reason: "authority" };
    if (!currentHead || localSnapshot(currentHead) !== proposal.local_snapshot_json)
      return { status: "unavailable", reason: "stale_evidence" };
    return { status: "available", proposal: {
      proposalId: proposal.proposal_id,
      sourceId: proposal.source_id,
      externalProjectId: proposal.external_project_id,
      projectAlphaPublicId: proposal.project_alpha_public_id,
      expectedLocalVersion: proposal.expected_local_version,
      expiresAt: proposal.expires_at,
      operations: local.side,
      projectAlpha,
      changedFields: changedFields(local.side, projectAlpha),
    } };
  } catch {
    return { status: "unavailable", reason: "database" };
  }
}

export async function proposeProjectAlphaInboundProjectEdit(env: InboundProjectEnvironment, actor: InboundProjectActor,
  input: InboundProjectSelection, fetcher: typeof fetch = fetch): Promise<InboundProjectProposalOutcome> {
  if (!validActor(actor)) return { status: "rejected", reason: "invalid_actor" };
  if (!validSelection(input)) return { status: "rejected", reason: "invalid_selection" };
  const requestSha = await sha256(canonical({ version: 1, actor, input }));
  try {
    const replay = await proposalByKey(env.OPS_DB, input.idempotencyKey);
    if (replay) return replay.request_sha256 === requestSha ? { status: "proposed", proposalId: replay.proposal_id, replayed: true }
      : { status: "conflict", reason: "idempotency_key" };
    const configured = connection(env, input.sourceId); if (!configured) return { status: "blocked", reason: "configuration" };
    const local = await head(env.OPS_DB, input.externalProjectId);
    if (!local || local.source_id !== input.sourceId || local.source_instance_id !== configured.expectedSourceInstanceId
      || local.application_id !== configured.expectedApplicationId || local.history_epoch_id !== configured.expectedHistoryEpoch)
      return { status: "blocked", reason: "mapping" };
    const [mapped, observed, currentActor, liveGrants] = await Promise.all([
      env.OPS_DB.prepare(`SELECT count(*) count FROM project_alpha_project_mappings WHERE external_project_id=?
        AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND project_alpha_public_id=?`)
        .bind(local.external_project_id, local.source_id, local.source_instance_id, local.application_id,
          local.history_epoch_id, local.project_alpha_public_id).first<number>("count"),
      observation(env.OPS_DB, local), actorState(env.OPS_DB, actor), grants(env.OPS_DB, actor.staffId),
    ]);
    if (mapped !== 1) return { status: "blocked", reason: "mapping" };
    if (!observed) return { status: "blocked", reason: "observation" };
    if (observed.has_conflict !== 0) return { status: "blocked", reason: "conflict" };
    if (observed.resource_revision === local.pa_revision && observed.projection_sha256 === local.canonical_projection_sha256)
      return { status: "unchanged" };
    if (!currentActor) return { status: "blocked", reason: "authority" };
    const currentRemote = await remote(env, local, fetcher); if (!currentRemote) return { status: "blocked", reason: "remote" };
    if (currentRemote.evidence.response.resource.revision !== observed.resource_revision
      || currentRemote.evidence.response.resource.projectionSha256 !== observed.projection_sha256
      || currentRemote.authorizationGeneration !== observed.authorization_generation) return { status: "blocked", reason: "stale_evidence" };
    const target = await directory(env.OPS_DB, local, currentRemote.evidence.response.data.organizationPublicId,
      currentRemote.evidence.response.data.clientPublicId);
    if (!target) return { status: "blocked", reason: "directory" };
    if (!isProjectInboundAuthorized(liveGrants, local.external_project_id, target.scopes)) return { status: "blocked", reason: "authority" };
    const proposalId = crypto.randomUUID(), scopesJson = canonical(target.scopes);
    await env.OPS_DB.prepare(`INSERT INTO project_alpha_project_inbound_proposals(
      proposal_id,idempotency_key,request_sha256,source_id,source_instance_id,application_id,history_epoch_id,
      external_project_id,project_alpha_public_id,expected_local_version,expected_local_projection_sha256,
      observed_request_id,observed_authorization_generation,observed_remote_revision,observed_remote_projection_sha256,
      local_snapshot_json,remote_snapshot_json,remote_snapshot_sha256,target_organization_record_id,target_client_record_id,
      reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,
      project_grant_generation,normalized_scopes_json,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'))`).bind(
      proposalId, input.idempotencyKey, requestSha, local.source_id, local.source_instance_id, local.application_id,
      local.history_epoch_id, local.external_project_id, local.project_alpha_public_id, local.current_version,
      local.canonical_projection_sha256, observed.request_id, observed.authorization_generation, observed.resource_revision,
      observed.projection_sha256, localSnapshot(local), currentRemote.evidence.responseJson,
      currentRemote.evidence.responseSha256, target.organizationRecordId, target.clientRecordId, actor.staffId,
      actor.accessSubject, currentActor.admission_version, currentActor.profile_version, currentActor.generation, scopesJson).run();
    return { status: "proposed", proposalId, replayed: false };
  } catch {
    const winner = await proposalByKey(env.OPS_DB, input.idempotencyKey).catch(() => null);
    return winner?.request_sha256 === requestSha ? { status: "proposed", proposalId: winner.proposal_id, replayed: true }
      : winner ? { status: "conflict", reason: "idempotency_key" } : { status: "uncertain", reason: "database" };
  }
}

export async function resolveProjectAlphaInboundProjectEdit(env: InboundProjectEnvironment, actor: InboundProjectActor,
  input: InboundProjectResolution, fetcher: typeof fetch = fetch): Promise<InboundProjectResolutionOutcome> {
  if (!validActor(actor)) return { status: "rejected", reason: "invalid_actor" };
  if (!validResolution(input)) return { status: "rejected", reason: "invalid_resolution" };
  const requestSha = await sha256(canonical({ version: 1, actor, input }));
  try {
    const keyed = await receiptByResolutionKey(env.OPS_DB, input.idempotencyKey);
    if (keyed) return keyed.proposal_id === input.proposalId && keyed.request_sha256 === requestSha
      ? { status: "resolved", resolutionId: keyed.resolution_id, decision: keyed.decision,
        syncStatus: keyed.decision === "accept_project_alpha" ? "synchronized" : "divergent",
        resultingVersion: keyed.resulting_local_version, replayed: true }
      : { status: "conflict", reason: "idempotency_key" };
    const prior = await receiptByProposal(env.OPS_DB, input.proposalId);
    if (prior) return { status: "conflict", reason: "already_resolved" };
    const proposal = await env.OPS_DB.prepare(`SELECT * FROM project_alpha_project_inbound_proposals WHERE proposal_id=?`)
      .bind(input.proposalId).first<Proposal>();
    if (!proposal || proposal.expires_at <= new Date().toISOString()) return { status: "blocked", reason: "stale_evidence" };
    const configured = connection(env, proposal.source_id); if (!configured) return { status: "blocked", reason: "configuration" };
    const local = await head(env.OPS_DB, proposal.external_project_id);
    if (!local || local.current_version !== proposal.expected_local_version
      || local.canonical_projection_sha256 !== proposal.expected_local_projection_sha256
      || localSnapshot(local) !== proposal.local_snapshot_json) return { status: "blocked", reason: "stale_evidence" };
    const [currentActor, liveGrants, exactMapping] = await Promise.all([
      actorState(env.OPS_DB, actor), grants(env.OPS_DB, actor.staffId),
      env.OPS_DB.prepare(`SELECT count(*) count FROM project_alpha_project_mappings WHERE external_project_id=?
        AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND project_alpha_public_id=?`)
        .bind(proposal.external_project_id, proposal.source_id, proposal.source_instance_id, proposal.application_id,
          proposal.history_epoch_id, proposal.project_alpha_public_id).first<number>("count"),
    ]);
    if (!currentActor || currentActor.admission_version !== proposal.reviewer_admission_version
      || currentActor.profile_version !== proposal.reviewer_profile_version
      || currentActor.generation !== proposal.project_grant_generation || actor.staffId !== proposal.reviewer_staff_id
      || actor.accessSubject !== proposal.reviewer_access_subject || exactMapping !== 1) return { status: "blocked", reason: "authority" };
    const finalRemote = await remote(env, local, fetcher); if (!finalRemote) return { status: "blocked", reason: "remote" };
    if (finalRemote.evidence.responseJson !== proposal.remote_snapshot_json
      || finalRemote.evidence.responseSha256 !== proposal.remote_snapshot_sha256
      || finalRemote.evidence.response.resource.revision !== proposal.observed_remote_revision
      || finalRemote.evidence.response.resource.projectionSha256 !== proposal.observed_remote_projection_sha256
      || finalRemote.authorizationGeneration !== proposal.observed_authorization_generation)
      return { status: "blocked", reason: "stale_evidence" };
    const target = await directory(env.OPS_DB, local, finalRemote.evidence.response.data.organizationPublicId,
      finalRemote.evidence.response.data.clientPublicId);
    if (!target || target.organizationRecordId !== proposal.target_organization_record_id
      || target.clientRecordId !== proposal.target_client_record_id
      || canonical(target.scopes) !== proposal.normalized_scopes_json) return { status: "blocked", reason: "directory" };
    if (!isProjectInboundAuthorized(liveGrants, local.external_project_id, target.scopes)) return { status: "blocked", reason: "authority" };
    const decision = safeProjectInboundDecision(input.decision,
      { organizationRecordId: local.organization_record_id, clientRecordId: local.client_record_id }, target);
    const resolutionId = crypto.randomUUID(), resultingVersion = decision === "accept_project_alpha"
      ? local.current_version + 1 : local.current_version;
    const statements: D1PreparedStatement[] = [env.OPS_DB.prepare(`INSERT INTO project_alpha_project_inbound_resolution_authorizations(
      resolution_id,proposal_id,idempotency_key,request_sha256,decision,final_remote_snapshot_json,
      final_remote_snapshot_sha256,final_remote_revision,final_remote_projection_sha256,final_authorization_generation,
      target_organization_record_id,target_client_record_id,reviewer_staff_id,reviewer_access_subject,
      reviewer_admission_version,reviewer_profile_version,project_grant_generation,normalized_scopes_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(resolutionId, proposal.proposal_id, input.idempotencyKey,
      requestSha, decision, finalRemote.evidence.responseJson, finalRemote.evidence.responseSha256,
      finalRemote.evidence.response.resource.revision, finalRemote.evidence.response.resource.projectionSha256,
      finalRemote.authorizationGeneration, target.organizationRecordId, target.clientRecordId, actor.staffId,
      actor.accessSubject, currentActor.admission_version, currentActor.profile_version, currentActor.generation,
      canonical(target.scopes))];
    if (decision === "accept_project_alpha") statements.push(
      env.OPS_DB.prepare(`UPDATE operations_shared_projects SET pa_revision=?,current_version=current_version+1,
        canonical_projection_sha256=?,name=?,description=?,lifecycle=?,archived=?,overdue_warning=?,completed_at=?,
        archived_at=?,planned_start=?,planned_end=?,organization_record_id=?,client_record_id=?,scopes_json=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE external_project_id=?`).bind(
        finalRemote.evidence.response.resource.revision, finalRemote.evidence.response.resource.projectionSha256,
        finalRemote.evidence.response.data.name, finalRemote.evidence.response.data.description,
        finalRemote.evidence.response.data.status, finalRemote.evidence.response.data.archived ? 1 : 0,
        finalRemote.evidence.response.data.overdueWarning ? 1 : 0, finalRemote.evidence.response.data.completedAt,
        finalRemote.evidence.response.data.archivedAt, finalRemote.evidence.response.data.estimatedStart,
        finalRemote.evidence.response.data.estimatedEnd, target.organizationRecordId, target.clientRecordId,
        canonical(target.scopes), local.external_project_id),
      env.OPS_DB.prepare(`INSERT INTO operations_shared_project_revisions(external_project_id,version,pa_revision,
        read_json,refresh_command_id,v2_settlement_id,inbound_resolution_id) VALUES(?,?,NULL,?,NULL,NULL,?)`)
        .bind(local.external_project_id, resultingVersion, finalRemote.evidence.responseJson, resolutionId));
    statements.push(env.OPS_DB.prepare(`INSERT INTO project_alpha_project_inbound_resolution_receipts(
      resolution_id,proposal_id,decision,prior_local_version,resulting_local_version) VALUES(?,?,?,?,?)`)
      .bind(resolutionId, proposal.proposal_id, decision, local.current_version, resultingVersion));
    await env.OPS_DB.batch(statements);
    return { status: "resolved", resolutionId, decision,
      syncStatus: decision === "accept_project_alpha" ? "synchronized" : "divergent",
      resultingVersion, replayed: false };
  } catch {
    const keyed = await receiptByResolutionKey(env.OPS_DB, input.idempotencyKey).catch(() => null);
    if (keyed) return keyed.proposal_id === input.proposalId && keyed.request_sha256 === requestSha
      ? { status: "resolved", resolutionId: keyed.resolution_id, decision: keyed.decision,
        syncStatus: keyed.decision === "accept_project_alpha" ? "synchronized" : "divergent",
        resultingVersion: keyed.resulting_local_version, replayed: true }
      : { status: "conflict", reason: "idempotency_key" };
    const winner = await receiptByProposal(env.OPS_DB, input.proposalId).catch(() => null);
    return winner ? { status: "conflict", reason: "already_resolved" }
      : { status: "uncertain", reason: "database" };
  }
}
