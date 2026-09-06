import { sha256 } from "../security";
import type { Env } from "../types";
import type {
  ClientPortalSession,
  ClientServiceCatalogItem,
  ClientServiceDraftMutationResult,
  ClientServiceDraftSelection,
  ClientServiceRequest,
  ClientServiceRequestCancelResult,
  ClientServiceRequestDraft,
  ClientServiceRequestDraftInput,
  ClientServiceRequestDraftSummary,
  ClientServiceDraftSubmitResult,
  ClientServiceDraftSubmitBlockReason,
} from "./types";
import {
  calculateRequestAreaSquareMeters,
  mapServiceCatalogItem,
  validateServiceAnswers,
} from "./request-v2";
import {
  ensureNativeRequestStorage,
  nativeRequestMutationGuardSql,
  resolveNativeRequestAuthority,
  type NativeRequestAuthorityProof,
} from "./native-request-authority";
import {
  changedAssignedServices,
  readServiceAssignmentPolicy,
  serializeServiceAssignmentPolicyProof,
  serviceAssignmentPolicyCheckpointSql,
  serviceAssignmentPolicyProofStillCurrent,
  serviceAssignmentPolicyServiceSql,
  serviceAssignmentRequestPolicyEnabled,
  ServiceAssignmentPolicyUnavailableError,
  type ServiceAssignmentPolicyProof,
} from "./service-assignment-policy";

const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SOURCE_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SQUARE_METERS_PER_ACRE = 4_046.8564224;

interface CatalogRow {
  public_id: string; source_version: string; name: string; summary: string | null;
  category: string; display_order: number; geometry_requirement: string; question_schema_json: string;
}
interface StoredDraftRow {
  id: string; state: "draft" | "submitted"; version: number; draft_json: string; area_geojson: string | null;
  area_square_meters: number | null; area_acres: number | null; submitted_request_id: string | null;
  created_at: string; updated_at: string; portal_project_public_id: string | null; catalog_source_id: string;
}
interface StoredServiceRow {
  service_public_id: string; service_source_version: string; service_snapshot_json: string; answers_json: string;
}

function database(env: Env) {
  return env.DELIVERY_DB.withSession?.("first-primary") ?? env.DELIVERY_DB;
}
function requestFields(input: ClientServiceRequestDraftInput): Omit<ClientServiceRequestDraftInput, "areaGeoJson" | "services"> {
  const { areaGeoJson: _area, services: _services, ...fields } = input;
  return fields;
}
function serviceSnapshot(service: ClientServiceDraftSelection): string {
  const { answers: _answers, ...snapshot } = service;
  return JSON.stringify(snapshot);
}
function mapStoredService(row: StoredServiceRow): ClientServiceDraftSelection | null {
  try {
    const snapshot = JSON.parse(row.service_snapshot_json) as Omit<ClientServiceDraftSelection, "answers">;
    const answers = JSON.parse(row.answers_json) as Record<string, unknown>;
    return { ...snapshot, publicId: row.service_public_id, sourceVersion: row.service_source_version, answers };
  } catch { return null; }
}
function mapRequest(row: Record<string, unknown>): ClientServiceRequest {
  return {
    id: String(row.id), projectId: row.portal_project_public_id as string | null,
    requestType: row.request_type as "flight" | "service", title: String(row.title), details: String(row.details),
    location: row.location_text as string | null, preferredStartAt: row.preferred_start_at as string | null,
    serviceCategory: row.service_category as string | null, deliverables: row.deliverables_text as string | null,
    siteContactName: row.site_contact_name as string | null, siteContactEmail: row.site_contact_email as string | null,
    siteContactPhone: row.site_contact_phone as string | null, desiredCompletionAt: row.desired_completion_at as string | null,
    latitude: row.latitude as number | null, longitude: row.longitude as number | null,
    areaGeoJson: row.area_geojson ? JSON.parse(String(row.area_geojson)) : null,
    poiPoints: row.poi_points_json ? JSON.parse(String(row.poi_points_json)) : [],
    status: row.status as ClientServiceRequest["status"], ...(row.project_alpha_draft_created === 1 ? { projectAlphaDraftCreated: true } : {}), acceptedQuote: null, operationalEstimate: null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

const nativeCurrentDraftReceiptColumn = `EXISTS(SELECT 1 FROM request_pa_draft_quote_receipts receipt
  WHERE receipt.request_id=request.id AND receipt.source_id=request.catalog_source_id
    AND receipt.scope_stale_at IS NULL
    AND receipt.request_revision=COALESCE((SELECT MAX(revision.revision_number)
      FROM request_revisions revision WHERE revision.request_id=request.id),0)
    AND receipt.area_revision=COALESCE((SELECT MAX(area.revision_number)
      FROM client_service_request_area_revisions area WHERE area.request_id=request.id),0)) project_alpha_draft_created`;

function missingDraftReceiptSchema(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:request_pa_draft_quote_receipts|client_service_request_area_revisions)\b/i.test(message) ||
    /no such column:\s*(?:receipt\.)?(?:scope_stale_at|source_id)\b/i.test(message);
}

async function selections(
  env: Env, sourceId: string, input: ClientServiceRequestDraftInput,
): Promise<{ kind: "resolved"; services: ClientServiceDraftSelection[] }
  | { kind: "catalog_changed"; servicePublicIds: string[] }
  | { kind: "invalid"; reason: "selection" | "answers"; servicePublicIds?: string[] }> {
  if (input.services.length > 10 || new Set(input.services.map(item => item.publicId)).size !== input.services.length)
    return { kind: "invalid", reason: "selection" };
  const resolved: ClientServiceDraftSelection[] = [];
  const changed: string[] = [];
  for (const selected of input.services) {
    if (!PUBLIC_ID.test(selected.publicId) || !SOURCE_VERSION.test(selected.sourceVersion))
      return { kind: "invalid", reason: "selection" };
    const row = await database(env).prepare(`SELECT public_id,source_version,name,summary,category,display_order,
      geometry_requirement,question_schema_json FROM pa_service_catalog_items
      WHERE source_id=? AND public_id=? AND active=1`).bind(sourceId, selected.publicId).first<CatalogRow>();
    const item = row ? mapServiceCatalogItem(row) : null;
    if (!item || item.sourceVersion !== selected.sourceVersion) { changed.push(selected.publicId); continue; }
    const answers = validateServiceAnswers(item.questions, selected.answers, true);
    if (!answers) return { kind: "invalid", reason: "answers", servicePublicIds: [selected.publicId] };
    resolved.push({ ...item, answers });
  }
  return changed.length ? { kind: "catalog_changed", servicePublicIds: changed }
    : { kind: "resolved", services: resolved };
}

export async function validateNativeDirectServiceRequest(
  env: Env,
  session: ClientPortalSession,
  input: ClientServiceRequestDraftInput,
): Promise<{
  kind: "ready";
} | {
  kind: "blocked";
  reason: ClientServiceDraftSubmitBlockReason;
  servicePublicIds?: string[];
} | null> {
  const authority = await resolveNativeRequestAuthority(env, session, input.projectId);
  if (!authority) return null;
  if (!input.title.trim() || !input.details.trim())
    return { kind: "blocked", reason: "request_fields_incomplete" };
  const assignment = await policy(env, session, input.projectId, input.services);
  if (assignment.kind !== "ready") return {
    kind: "blocked",
    reason: assignment.kind,
    servicePublicIds: assignment.servicePublicIds,
  };
  const resolved = await selections(env, authority.sourceId, input);
  if (resolved.kind === "catalog_changed") return {
    kind: "blocked",
    reason: resolved.kind,
    servicePublicIds: resolved.servicePublicIds,
  };
  if (resolved.kind === "invalid") return resolved.reason === "answers" ? {
    kind: "blocked",
    reason: "answers_incomplete",
    servicePublicIds: resolved.servicePublicIds,
  } : null;
  const incomplete = resolved.services
    .filter(service => validateServiceAnswers(service.questions, service.answers) === null)
    .map(service => service.publicId);
  if (incomplete.length) return {
    kind: "blocked",
    reason: "answers_incomplete",
    servicePublicIds: incomplete,
  };
  const geometry = resolved.services
    .filter(service => service.geometryRequirement === "required" && input.areaGeoJson === null)
    .map(service => service.publicId);
  return geometry.length
    ? { kind: "blocked", reason: "geometry_required", servicePublicIds: geometry }
    : { kind: "ready" };
}

async function catalogChanges(env: Env, sourceId: string, services: ReadonlyArray<{ publicId: string; sourceVersion: string }>) {
  const changed: string[] = [];
  for (const service of services) {
    const row = await database(env).prepare(`SELECT source_version FROM pa_service_catalog_items
      WHERE source_id=? AND public_id=? AND active=1`).bind(sourceId, service.publicId)
      .first<{ source_version: string }>();
    if (!row || row.source_version !== service.sourceVersion) changed.push(service.publicId);
  }
  return changed;
}

async function policy(
  env: Env, session: ClientPortalSession, projectPublicId: string | null,
  services: ReadonlyArray<{ publicId: string; sourceVersion: string }>,
): Promise<{ kind: "ready"; proof: ServiceAssignmentPolicyProof | null }
  | { kind: "service_assignments_changed"; servicePublicIds: string[] }> {
  if (!serviceAssignmentRequestPolicyEnabled(env)) return { kind: "ready", proof: null };
  const decision = await readServiceAssignmentPolicy(env, session, projectPublicId);
  if (decision.state !== "ready") return { kind: "service_assignments_changed", servicePublicIds: services.map(row => row.publicId) };
  const changed = await changedAssignedServices(env, decision.proof, services);
  return changed.length ? { kind: "service_assignments_changed", servicePublicIds: changed }
    : { kind: "ready", proof: decision.proof };
}

function assignmentGuard(proof: ServiceAssignmentPolicyProof | null, services: ReadonlyArray<{ publicId: string; sourceVersion: string }>) {
  if (!proof) return { sql: "1=1", bindings: [] as unknown[] };
  const checkpoint = serviceAssignmentPolicyCheckpointSql(proof);
  const service = serviceAssignmentPolicyServiceSql(proof, "catalog", true);
  return { sql: `${checkpoint.sql} AND NOT EXISTS(SELECT 1 FROM json_each(?) reviewed WHERE NOT EXISTS(
    SELECT 1 FROM pa_service_catalog_items catalog WHERE catalog.source_id=?
      AND catalog.public_id=json_extract(reviewed.value,'$.publicId')
      AND catalog.source_version=json_extract(reviewed.value,'$.sourceVersion')
      AND catalog.active=1 AND ${service.sql}))`, bindings: [
      ...checkpoint.bindings, JSON.stringify(services.map(row => ({ publicId: row.publicId, sourceVersion: row.sourceVersion }))),
      proof.sourceId, ...service.bindings,
    ] as unknown[] };
}

async function stillAssigned(env: Env, proof: ServiceAssignmentPolicyProof | null,
  services: ReadonlyArray<{ publicId: string; sourceVersion: string }>): Promise<boolean> {
  if (!serviceAssignmentRequestPolicyEnabled(env)) return true;
  return !!proof && await serviceAssignmentPolicyProofStillCurrent(env, proof)
    && (await changedAssignedServices(env, proof, services)).length === 0;
}

async function draftOwner(env: Env, session: ClientPortalSession, draftId: string): Promise<{
  row: StoredDraftRow; proof: NativeRequestAuthorityProof;
} | null> {
  if (!session.workspaceId || !session.nativePortalIdentityId || !session.nativeSourceId) return null;
  const row = await database(env).prepare(`SELECT id,state,version,draft_json,area_geojson,area_square_meters,area_acres,
      submitted_request_id,created_at,updated_at,portal_project_public_id,catalog_source_id
    FROM client_service_request_drafts WHERE id=? AND portal_workspace_id=? AND portal_identity_id=?
      AND catalog_source_id=?`).bind(draftId, session.workspaceId, session.nativePortalIdentityId, session.nativeSourceId)
    .first<StoredDraftRow>();
  if (!row) return null;
  const proof = await resolveNativeRequestAuthority(env, session, row.portal_project_public_id);
  return proof && proof.sourceId === row.catalog_source_id ? { row, proof } : null;
}

async function loadNativeDraft(env: Env, session: ClientPortalSession, draftId: string): Promise<ClientServiceRequestDraft | null> {
  const owner = await draftOwner(env, session, draftId);
  if (!owner) return null;
  const services = await database(env).prepare(`SELECT service_public_id,service_source_version,service_snapshot_json,answers_json
    FROM client_service_request_draft_services WHERE draft_id=? AND service_source_id=? ORDER BY ordinal`)
    .bind(draftId, owner.proof.sourceId).all<StoredServiceRow>();
  const mapped = services.results.map(mapStoredService);
  if (mapped.some(item => !item)) return null;
  try {
    const fields = JSON.parse(owner.row.draft_json) as Omit<ClientServiceRequestDraftInput, "areaGeoJson" | "services">;
    return {
      id: owner.row.id, state: owner.row.state, version: owner.row.version, ...fields,
      projectId: owner.row.portal_project_public_id,
      areaGeoJson: owner.row.area_geojson ? JSON.parse(owner.row.area_geojson) : null,
      areaSquareMeters: owner.row.area_square_meters, areaAcres: owner.row.area_acres,
      services: mapped as ClientServiceDraftSelection[], submittedRequestId: owner.row.submitted_request_id,
      createdAt: owner.row.created_at, updatedAt: owner.row.updated_at,
    };
  } catch { return null; }
}

export async function listNativeServiceCatalog(env: Env, session: ClientPortalSession, projectPublicId: string | null) {
  const authority = await resolveNativeRequestAuthority(env, session, projectPublicId);
  if (!authority) return [];
  let guard: ReturnType<typeof serviceAssignmentPolicyServiceSql> | null = null;
  if (serviceAssignmentRequestPolicyEnabled(env)) {
    const decision = await readServiceAssignmentPolicy(env, session, projectPublicId);
    if (decision.state !== "ready") throw new ServiceAssignmentPolicyUnavailableError();
    guard = serviceAssignmentPolicyServiceSql(decision.proof);
  }
  const rows = await database(env).prepare(`SELECT public_id,source_version,name,summary,category,display_order,
    geometry_requirement,question_schema_json FROM pa_service_catalog_items catalog
    WHERE source_id=? AND active=1${guard ? ` AND ${guard.sql}` : ""}
    ORDER BY category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id LIMIT 500`)
    .bind(authority.sourceId, ...(guard?.bindings ?? [])).all<CatalogRow>();
  return rows.results.map(mapServiceCatalogItem).filter((item): item is ClientServiceCatalogItem => item !== null);
}

export async function listNativeServiceRequestDrafts(env: Env, session: ClientPortalSession): Promise<ClientServiceRequestDraftSummary[]> {
  const root = await resolveNativeRequestAuthority(env, session, null);
  if (!root || !session.workspaceId || !session.nativePortalIdentityId) return [];
  const rows = await database(env).prepare(`SELECT d.id,d.portal_project_public_id,d.draft_json,d.area_acres,d.updated_at,
      COALESCE((SELECT json_group_array(json_extract(service.service_snapshot_json,'$.name'))
        FROM client_service_request_draft_services service
        WHERE service.draft_id=d.id AND service.service_source_id=d.catalog_source_id),'[]') service_names_json
    FROM client_service_request_drafts d WHERE d.portal_workspace_id=? AND d.portal_identity_id=?
      AND d.catalog_source_id=? AND d.state='draft' ORDER BY d.updated_at DESC,d.id DESC LIMIT 20`)
    .bind(session.workspaceId, session.nativePortalIdentityId, root.sourceId)
    .all<{ id: string; portal_project_public_id: string | null; draft_json: string; area_acres: number | null; service_names_json: string; updated_at: string }>();
  const result: ClientServiceRequestDraftSummary[] = [];
  for (const row of rows.results) try {
    const fields = JSON.parse(row.draft_json) as { title?: unknown };
    const names = JSON.parse(row.service_names_json) as unknown;
    if (Array.isArray(names) && names.every(name => typeof name === "string")) result.push({
      id: row.id, projectId: row.portal_project_public_id,
      title: typeof fields.title === "string" && fields.title.trim() ? fields.title.trim() : "Untitled request",
      serviceNames: names, areaAcres: row.area_acres, updatedAt: row.updated_at,
    });
  } catch { /* omit malformed storage */ }
  return result;
}

export const getNativeServiceRequestDraft = loadNativeDraft;

export async function createNativeServiceRequestDraft(env: Env, session: ClientPortalSession,
  input: ClientServiceRequestDraftInput, mutationKey: string): Promise<ClientServiceDraftMutationResult | null> {
  const authority = await resolveNativeRequestAuthority(env, session, input.projectId);
  if (!authority) return null;
  const owner = await ensureNativeRequestStorage(env, authority, session.displayName);
  if (!owner) return null;
  const fingerprint = await sha256(JSON.stringify(input));
  const existing = await database(env).prepare(`SELECT id,create_fingerprint FROM client_service_request_drafts
    WHERE account_id=? AND create_idempotency_key=? AND catalog_source_id=? AND portal_workspace_id=?`)
    .bind(owner.accountId, mutationKey, authority.sourceId, authority.workspaceId)
    .first<{ id: string; create_fingerprint: string }>();
  if (existing) {
    if (existing.create_fingerprint !== fingerprint) return { kind: "conflict" };
    const draft = await loadNativeDraft(env, session, existing.id);
    return draft ? { kind: "replayed", draft } : null;
  }
  const assignment = await policy(env, session, input.projectId, input.services);
  if (assignment.kind !== "ready") return assignment;
  const resolved = await selections(env, authority.sourceId, input);
  if (resolved.kind !== "resolved") return resolved.kind === "invalid" ? null : resolved;
  const area = calculateRequestAreaSquareMeters(input.areaGeoJson);
  const id = crypto.randomUUID();
  const authorityGuard = nativeRequestMutationGuardSql(authority);
  const assignedGuard = assignmentGuard(assignment.proof, resolved.services);
  const reviewed = JSON.stringify(resolved.services.map(row => ({ publicId: row.publicId, sourceVersion: row.sourceVersion })));
  const db = database(env);
  const insert = db.prepare(`INSERT INTO client_service_request_drafts
    (id,account_id,project_id,created_by_identity_id,draft_json,area_geojson,area_square_meters,area_acres,
     create_idempotency_key,create_fingerprint,last_mutation_key,catalog_source_id,service_assignment_policy_v2_json,
     portal_workspace_id,portal_identity_id,portal_project_public_id)
    SELECT ?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${authorityGuard.sql}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) reviewed WHERE NOT EXISTS(
        SELECT 1 FROM pa_service_catalog_items catalog WHERE catalog.source_id=?
          AND catalog.public_id=json_extract(reviewed.value,'$.publicId')
          AND catalog.source_version=json_extract(reviewed.value,'$.sourceVersion') AND catalog.active=1))
      AND ${assignedGuard.sql}`)
    .bind(id, owner.accountId, owner.storageIdentityId, JSON.stringify(requestFields(input)),
      input.areaGeoJson ? JSON.stringify(input.areaGeoJson) : null, area, area === null ? null : area / SQUARE_METERS_PER_ACRE,
      mutationKey, fingerprint, mutationKey, authority.sourceId, serializeServiceAssignmentPolicyProof(assignment.proof),
      authority.workspaceId, authority.identityId, authority.projectPublicId,
      ...authorityGuard.bindings, reviewed, authority.sourceId, ...assignedGuard.bindings);
  const statements = [insert, ...resolved.services.map((service, ordinal) => db.prepare(`INSERT INTO client_service_request_draft_services
    (draft_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,service_source_id)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM client_service_request_drafts
      WHERE id=? AND catalog_source_id=? AND portal_workspace_id=? AND last_mutation_key=?)`)
    .bind(id, ordinal, service.publicId, service.sourceVersion, serviceSnapshot(service), JSON.stringify(service.answers), authority.sourceId,
      id, authority.sourceId, authority.workspaceId, mutationKey))];
  try {
    const result = await db.batch(statements);
    if (!result[0]?.meta.changes) {
      const changed = await catalogChanges(env, authority.sourceId, resolved.services);
      if (changed.length) return { kind: "catalog_changed", servicePublicIds: changed };
      return await stillAssigned(env, assignment.proof, resolved.services) ? null
        : { kind: "service_assignments_changed", servicePublicIds: resolved.services.map(row => row.publicId) };
    }
  } catch {
    const raced = await db.prepare(`SELECT id,create_fingerprint FROM client_service_request_drafts
      WHERE account_id=? AND create_idempotency_key=? AND catalog_source_id=? AND portal_workspace_id=?`)
      .bind(owner.accountId, mutationKey, authority.sourceId, authority.workspaceId)
      .first<{ id: string; create_fingerprint: string }>();
    if (!raced || raced.create_fingerprint !== fingerprint) return raced ? { kind: "conflict" } : null;
    const replay = await loadNativeDraft(env, session, raced.id);
    return replay ? { kind: "replayed", draft: replay } : null;
  }
  const draft = await loadNativeDraft(env, session, id);
  return draft ? { kind: "created", draft } : null;
}

export async function saveNativeServiceRequestDraft(env: Env, session: ClientPortalSession, draftId: string,
  expectedVersion: number, input: ClientServiceRequestDraftInput, mutationKey: string): Promise<ClientServiceDraftMutationResult | null> {
  const current = await draftOwner(env, session, draftId);
  if (!current) return null;
  const authority = await resolveNativeRequestAuthority(env, session, input.projectId);
  if (!authority || authority.sourceId !== current.proof.sourceId || authority.workspaceId !== current.proof.workspaceId
    || authority.identityId !== current.proof.identityId) return null;
  const fingerprint = await sha256(JSON.stringify(input));
  const replay = await database(env).prepare(`SELECT mutation.mutation_fingerprint
    FROM client_service_request_draft_mutations mutation
    JOIN client_service_request_drafts draft ON draft.id=mutation.draft_id
    WHERE mutation.draft_id=? AND mutation.mutation_key=? AND draft.portal_workspace_id=?
      AND draft.portal_identity_id=? AND draft.catalog_source_id=?`)
    .bind(draftId, mutationKey, authority.workspaceId, authority.identityId, authority.sourceId)
    .first<{ mutation_fingerprint: string }>();
  if (replay) {
    if (replay.mutation_fingerprint !== fingerprint) return { kind: "conflict" };
    const draft = await loadNativeDraft(env, session, draftId);
    return draft ? { kind: "replayed", draft } : null;
  }
  const assigned = await policy(env, session, input.projectId, input.services);
  if (assigned.kind !== "ready") return assigned;
  const resolved = await selections(env, authority.sourceId, input);
  if (resolved.kind !== "resolved") return resolved.kind === "invalid" ? null : resolved;
  const area = calculateRequestAreaSquareMeters(input.areaGeoJson);
  const authorityGuard = nativeRequestMutationGuardSql(authority);
  const serviceGuard = assignmentGuard(assigned.proof, resolved.services);
  const reviewed = JSON.stringify(resolved.services.map(row => ({ publicId: row.publicId, sourceVersion: row.sourceVersion })));
  const db = database(env);
  const update = db.prepare(`UPDATE client_service_request_drafts AS draft SET draft_json=?,area_geojson=?,area_square_meters=?,area_acres=?,
      portal_project_public_id=?,service_assignment_policy_v2_json=?,version=version+1,last_mutation_key=?,updated_at=strftime('%Y-%m-%d %H:%M:%f','now')
    WHERE draft.id=? AND draft.state='draft' AND draft.version=? AND draft.portal_workspace_id=?
      AND draft.portal_identity_id=? AND draft.catalog_source_id=? AND ${authorityGuard.sql}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) reviewed WHERE NOT EXISTS(
        SELECT 1 FROM pa_service_catalog_items catalog WHERE catalog.source_id=?
          AND catalog.public_id=json_extract(reviewed.value,'$.publicId')
          AND catalog.source_version=json_extract(reviewed.value,'$.sourceVersion') AND catalog.active=1))
      AND ${serviceGuard.sql}`)
    .bind(JSON.stringify(requestFields(input)), input.areaGeoJson ? JSON.stringify(input.areaGeoJson) : null,
      area, area === null ? null : area / SQUARE_METERS_PER_ACRE, authority.projectPublicId,
      serializeServiceAssignmentPolicyProof(assigned.proof), mutationKey, draftId, expectedVersion,
      authority.workspaceId, authority.identityId, authority.sourceId, ...authorityGuard.bindings,
      reviewed, authority.sourceId, ...serviceGuard.bindings);
  const statements = [
    update,
    db.prepare(`DELETE FROM client_service_request_draft_services WHERE draft_id=? AND service_source_id=?
      AND EXISTS(SELECT 1 FROM client_service_request_drafts WHERE id=? AND last_mutation_key=?
        AND portal_workspace_id=? AND catalog_source_id=?)`)
      .bind(draftId, authority.sourceId, draftId, mutationKey, authority.workspaceId, authority.sourceId),
    ...resolved.services.map((service, ordinal) => db.prepare(`INSERT INTO client_service_request_draft_services
      (draft_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,service_source_id)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM client_service_request_drafts
        WHERE id=? AND last_mutation_key=? AND portal_workspace_id=? AND catalog_source_id=?)`)
      .bind(draftId, ordinal, service.publicId, service.sourceVersion, serviceSnapshot(service), JSON.stringify(service.answers),
        authority.sourceId, draftId, mutationKey, authority.workspaceId, authority.sourceId)),
    db.prepare(`INSERT INTO client_service_request_draft_mutations
      (draft_id,mutation_key,mutation_fingerprint,resulting_version,result_snapshot_json)
      SELECT ?,?,?,version,json_object('version',version) FROM client_service_request_drafts
      WHERE id=? AND last_mutation_key=? AND portal_workspace_id=? AND catalog_source_id=?`)
      .bind(draftId, mutationKey, fingerprint, draftId, mutationKey, authority.workspaceId, authority.sourceId),
  ];
  try {
    const result = await db.batch(statements);
    if (!result[0]?.meta.changes) return { kind: "conflict" };
  } catch { return { kind: "conflict" }; }
  const draft = await loadNativeDraft(env, session, draftId);
  return draft ? { kind: "updated", draft } : null;
}

async function attachmentBlock(env: Env, draftId: string, sourceId: string) {
  const rows = await database(env).prepare(`SELECT attachment.status,COUNT(*) count
    FROM client_service_request_attachments attachment
    JOIN client_service_request_drafts draft ON draft.id=attachment.draft_id
      AND draft.catalog_source_id=? WHERE attachment.draft_id=?
      AND attachment.status NOT IN ('accepted','aborted') GROUP BY attachment.status`)
    .bind(sourceId, draftId).all<{ status: string; count: number }>();
  const counts = new Map(rows.results.map(row => [row.status, Number(row.count)]));
  const rejected = counts.get("rejected") ?? 0;
  if (rejected) return { reason: "attachments_rejected" as const, attachmentCount: rejected };
  const expired = counts.get("expired") ?? 0;
  if (expired) return { reason: "attachments_expired" as const, attachmentCount: expired };
  const pending = [...counts.entries()].reduce((sum, [status, count]) => status === "rejected" || status === "expired" ? sum : sum + count, 0);
  return pending ? { reason: "attachments_pending" as const, attachmentCount: pending } : null;
}

async function loadNativeRequest(env: Env, session: ClientPortalSession, requestId: string): Promise<ClientServiceRequest | null> {
  if (!session.workspaceId || !session.nativePortalIdentityId || !session.nativeSourceId) return null;
  let row: Record<string, unknown> | null;
  try {
    row = await database(env).prepare(`SELECT request.*,${nativeCurrentDraftReceiptColumn} FROM client_service_requests request
      WHERE request.id=? AND request.portal_workspace_id=? AND request.portal_identity_id=? AND request.catalog_source_id=?`)
      .bind(requestId, session.workspaceId, session.nativePortalIdentityId, session.nativeSourceId)
      .first<Record<string, unknown>>();
  } catch (error) {
    if (!missingDraftReceiptSchema(error)) throw error;
    row = await database(env).prepare(`SELECT * FROM client_service_requests
      WHERE id=? AND portal_workspace_id=? AND portal_identity_id=? AND catalog_source_id=?`)
      .bind(requestId, session.workspaceId, session.nativePortalIdentityId, session.nativeSourceId)
      .first<Record<string, unknown>>();
  }
  if (!row) return null;
  const proof = await resolveNativeRequestAuthority(env, session, row.portal_project_public_id as string | null);
  return proof && proof.sourceId === row.catalog_source_id ? mapRequest(row) : null;
}

export async function submitNativeServiceRequestDraft(env: Env, session: ClientPortalSession, draftId: string,
  expectedVersion: number, mutationKey: string): Promise<ClientServiceDraftSubmitResult | null> {
  const draft = await loadNativeDraft(env, session, draftId);
  if (!draft) return null;
  const owner = await draftOwner(env, session, draftId);
  if (!owner) return null;
  const fingerprint = await sha256(JSON.stringify({ draftId, version: expectedVersion }));
  if (draft.state === "submitted") {
    const metadata = await database(env).prepare(`SELECT submit_idempotency_key,submit_fingerprint,submitted_request_id
      FROM client_service_request_drafts WHERE id=? AND portal_workspace_id=? AND portal_identity_id=? AND catalog_source_id=?`)
      .bind(draftId, owner.proof.workspaceId, owner.proof.identityId, owner.proof.sourceId)
      .first<{ submit_idempotency_key: string; submit_fingerprint: string; submitted_request_id: string }>();
    if (!metadata || metadata.submit_idempotency_key !== mutationKey || metadata.submit_fingerprint !== fingerprint)
      return { kind: "conflict" };
    const request = await loadNativeRequest(env, session, metadata.submitted_request_id);
    return request ? { kind: "replayed", request } : null;
  }
  if (draft.version !== expectedVersion) return { kind: "conflict" };
  if (!draft.title.trim() || !draft.details.trim()) return { kind: "incomplete", reason: "request_fields_incomplete" };
  if (!draft.services.length) return { kind: "incomplete", reason: "answers_incomplete", servicePublicIds: [] };
  const incomplete = draft.services.filter(service => validateServiceAnswers(service.questions, service.answers) === null)
    .map(service => service.publicId);
  if (incomplete.length) return { kind: "incomplete", reason: "answers_incomplete", servicePublicIds: incomplete };
  const geometry = draft.services.filter(service => service.geometryRequirement === "required" && draft.areaGeoJson === null)
    .map(service => service.publicId);
  if (geometry.length) return { kind: "incomplete", reason: "geometry_required", servicePublicIds: geometry };
  const changed = await catalogChanges(env, owner.proof.sourceId, draft.services);
  if (changed.length) return { kind: "incomplete", reason: "catalog_changed", servicePublicIds: changed };
  const assigned = await policy(env, session, draft.projectId, draft.services);
  if (assigned.kind !== "ready") return { kind: "incomplete", reason: "service_assignments_changed", servicePublicIds: assigned.servicePublicIds };
  const blocked = await attachmentBlock(env, draftId, owner.proof.sourceId);
  if (blocked) return { kind: "incomplete", ...blocked };
  const authorityGuard = nativeRequestMutationGuardSql(owner.proof);
  const serviceGuard = assignmentGuard(assigned.proof, draft.services);
  const reviewed = JSON.stringify(draft.services.map(row => ({ publicId: row.publicId, sourceVersion: row.sourceVersion })));
  const requestId = crypto.randomUUID();
  const requestFingerprint = await sha256(JSON.stringify(draft));
  const serviceCategory = draft.services.length === 1 ? draft.services[0]!.name.slice(0, 100) : `Multiple services (${draft.services.length})`;
  const db = database(env);
  const insert = db.prepare(`INSERT INTO client_service_requests
    (id,account_id,project_id,parent_request_id,created_by_identity_id,request_type,title,details,location_text,
     preferred_start_at,service_category,deliverables_text,site_contact_name,site_contact_email,site_contact_phone,
     desired_completion_at,latitude,longitude,area_geojson,poi_points_json,idempotency_key,request_fingerprint,
     catalog_source_id,service_assignment_policy_v2_json,portal_workspace_id,portal_identity_id,portal_project_public_id)
    SELECT ?,draft.account_id,NULL,NULL,draft.created_by_identity_id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,draft.catalog_source_id,?,
      draft.portal_workspace_id,draft.portal_identity_id,draft.portal_project_public_id
    FROM client_service_request_drafts draft WHERE draft.id=? AND draft.state='draft' AND draft.version=?
      AND draft.portal_workspace_id=? AND draft.portal_identity_id=? AND draft.catalog_source_id=?
      AND ${authorityGuard.sql}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) reviewed WHERE NOT EXISTS(
        SELECT 1 FROM pa_service_catalog_items catalog WHERE catalog.source_id=?
          AND catalog.public_id=json_extract(reviewed.value,'$.publicId')
          AND catalog.source_version=json_extract(reviewed.value,'$.sourceVersion') AND catalog.active=1))
      AND ${serviceGuard.sql}`)
    .bind(requestId, draft.requestType, draft.title, draft.details, draft.location, draft.preferredStartAt,
      serviceCategory, draft.deliverables, draft.siteContactName, draft.siteContactEmail, draft.siteContactPhone,
      draft.desiredCompletionAt, draft.latitude, draft.longitude, draft.areaGeoJson ? JSON.stringify(draft.areaGeoJson) : null,
      draft.poiPoints.length ? JSON.stringify(draft.poiPoints) : null, mutationKey, requestFingerprint,
      serializeServiceAssignmentPolicyProof(assigned.proof), draftId, expectedVersion, owner.proof.workspaceId,
      owner.proof.identityId, owner.proof.sourceId, ...authorityGuard.bindings, reviewed, owner.proof.sourceId,
      ...serviceGuard.bindings);
  const snapshot = JSON.stringify({ ...draft, status: "submitted", catalogSourceId: owner.proof.sourceId });
  const statements = [
    insert,
    ...draft.services.map((service, ordinal) => db.prepare(`INSERT INTO client_service_request_services
      (request_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,service_source_id)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM client_service_requests
        WHERE id=? AND catalog_source_id=? AND portal_workspace_id=? AND portal_identity_id=?)`)
      .bind(requestId, ordinal, service.publicId, service.sourceVersion, serviceSnapshot(service), JSON.stringify(service.answers),
        owner.proof.sourceId, requestId, owner.proof.sourceId, owner.proof.workspaceId, owner.proof.identityId)),
    db.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
      SELECT ?,?,1,'client',?,'submitted',? WHERE EXISTS(SELECT 1 FROM client_service_requests WHERE id=?)`)
      .bind(crypto.randomUUID(), requestId, owner.proof.identityId, snapshot, requestId),
    db.prepare(`INSERT INTO client_portal_notification_outbox
      (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
      SELECT ?,?,'request_submitted','submitted','staff_triage','request_submitted:submitted:staff_triage',
        json_object('title',?,'projectId',?,'serviceCount',?,'areaSquareMeters',?,'catalogSourceId',?)
      WHERE EXISTS(SELECT 1 FROM client_service_requests WHERE id=?)`)
      .bind(crypto.randomUUID(), requestId, draft.title, draft.projectId, draft.services.length, draft.areaSquareMeters,
        owner.proof.sourceId, requestId),
    db.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
      SELECT 'client',?,'client.service_request.submitted','client_service_request',?,
        json_object('workspaceId',?,'projectPublicId',?,'draftId',?,'serviceCount',?,'catalogSourceId',?)
      WHERE EXISTS(SELECT 1 FROM client_service_requests WHERE id=?)`)
      .bind(owner.proof.identityId, requestId, owner.proof.workspaceId, owner.proof.projectPublicId, draftId,
        draft.services.length, owner.proof.sourceId, requestId),
    db.prepare(`UPDATE client_service_request_drafts SET state='submitted',submitted_request_id=?,submit_idempotency_key=?,
      submit_fingerprint=?,service_assignment_policy_v2_json=?,submitted_at=datetime('now'),updated_at=datetime('now'),last_mutation_key=?
      WHERE id=? AND state='draft' AND version=? AND portal_workspace_id=? AND portal_identity_id=? AND catalog_source_id=?
        AND EXISTS(SELECT 1 FROM client_service_requests WHERE id=? AND catalog_source_id=?
          AND portal_workspace_id=? AND portal_identity_id=?)`)
      .bind(requestId, mutationKey, fingerprint, serializeServiceAssignmentPolicyProof(assigned.proof), mutationKey,
        draftId, expectedVersion, owner.proof.workspaceId, owner.proof.identityId, owner.proof.sourceId,
        requestId, owner.proof.sourceId, owner.proof.workspaceId, owner.proof.identityId),
  ];
  try {
    const results = await db.batch(statements);
    if (!results[0]?.meta.changes) return { kind: "conflict" };
  } catch { return { kind: "conflict" }; }
  const request = await loadNativeRequest(env, session, requestId);
  return request ? { kind: "submitted", request } : null;
}

export async function cancelNativeServiceRequest(env: Env, session: ClientPortalSession, requestId: string,
  mutationKey: string): Promise<ClientServiceRequestCancelResult | null> {
  if (!session.workspaceId || !session.nativePortalIdentityId || !session.nativeSourceId) return null;
  const row = await database(env).prepare(`SELECT id,portal_project_public_id,status,title FROM client_service_requests
    WHERE id=? AND portal_workspace_id=? AND portal_identity_id=? AND catalog_source_id=?`)
    .bind(requestId, session.workspaceId, session.nativePortalIdentityId, session.nativeSourceId)
    .first<{ id: string; portal_project_public_id: string | null; status: ClientServiceRequest["status"]; title: string }>();
  if (!row) return null;
  const proof = await resolveNativeRequestAuthority(env, session, row.portal_project_public_id);
  if (!proof || proof.sourceId !== session.nativeSourceId) return null;
  const fingerprint = await sha256(JSON.stringify({ action: "cancel", requestId, version: 1 }));
  const replay = await database(env).prepare(`SELECT revision.action,revision.mutation_fingerprint,revision.snapshot_json
    FROM request_revisions revision JOIN client_service_requests request ON request.id=revision.request_id
    WHERE revision.request_id=? AND revision.mutation_key=? AND request.portal_workspace_id=?
      AND request.portal_identity_id=? AND request.catalog_source_id=?`)
    .bind(requestId, mutationKey, proof.workspaceId, proof.identityId, proof.sourceId)
    .first<{ action: string; mutation_fingerprint: string | null; snapshot_json: string }>();
  if (replay) {
    let valid = replay.action === "status_changed" && replay.mutation_fingerprint === fingerprint;
    try { valid = valid && JSON.parse(replay.snapshot_json).status === "cancelled"; } catch { valid = false; }
    if (!valid) return { kind: "conflict", reason: "idempotency_key_reused" };
    const request = await loadNativeRequest(env, session, requestId);
    return request?.status === "cancelled" ? { kind: "replayed", request } : null;
  }
  if (!["submitted", "under_review", "accepted_pending_pa_linkage"].includes(row.status))
    return { kind: "conflict", reason: "status_not_cancellable" };
  const pa = await database(env).prepare(`SELECT
      EXISTS(SELECT 1 FROM request_pa_draft_quote_commands command WHERE command.request_id=?
        AND NOT EXISTS(SELECT 1 FROM request_pa_draft_quote_receipts receipt WHERE receipt.command_id=command.id)) unresolved,
      EXISTS(SELECT 1 FROM request_pa_draft_quote_commands WHERE request_id=? ) commands,
      EXISTS(SELECT 1 FROM request_pa_draft_quote_receipts WHERE request_id=? ) receipts`)
    .bind(requestId, requestId, requestId).first<{ unresolved: number; commands: number; receipts: number }>();
  if (pa?.unresolved) return { kind: "conflict", reason: "reconciliation_required" };
  if (pa?.commands || pa?.receipts) return { kind: "conflict", reason: "status_not_cancellable" };
  const services = (await database(env).prepare(`SELECT service_public_id publicId,service_source_version sourceVersion
    FROM client_service_request_services WHERE request_id=? AND service_source_id=? ORDER BY ordinal`)
    .bind(requestId, proof.sourceId).all<{ publicId: string; sourceVersion: string }>()).results;
  if ((await catalogChanges(env, proof.sourceId, services)).length)
    return { kind: "conflict", reason: "catalog_changed" };
  const assigned = await policy(env, session, row.portal_project_public_id, services);
  if (assigned.kind !== "ready") return { kind: "conflict", reason: "service_assignments_changed" };
  const authorityGuard = nativeRequestMutationGuardSql(proof);
  const serviceGuard = assignmentGuard(assigned.proof, services);
  const reviewed = JSON.stringify(services);
  const revisionId = crypto.randomUUID();
  const db = database(env);
  const revision = db.prepare(`INSERT INTO request_revisions
      (id,request_id,revision_number,author_type,author_id,action,snapshot_json,mutation_key,mutation_fingerprint)
    SELECT ?,request.id,COALESCE((SELECT MAX(existing.revision_number)+1 FROM request_revisions existing
      WHERE existing.request_id=request.id),1),'client',?,'status_changed',
      json_object('title',request.title,'projectId',request.portal_project_public_id,'previousStatus',request.status,
        'status','cancelled','catalogSourceId',request.catalog_source_id),?,?
    FROM client_service_requests request WHERE request.id=? AND request.portal_workspace_id=?
      AND request.portal_identity_id=? AND request.catalog_source_id=?
      AND request.status IN ('submitted','under_review','accepted_pending_pa_linkage')
      AND NOT EXISTS(SELECT 1 FROM request_pa_draft_quote_commands command WHERE command.request_id=request.id)
      AND NOT EXISTS(SELECT 1 FROM request_pa_draft_quote_receipts receipt WHERE receipt.request_id=request.id)
      AND ${authorityGuard.sql}
      AND NOT EXISTS(SELECT 1 FROM json_each(?) reviewed WHERE NOT EXISTS(
        SELECT 1 FROM pa_service_catalog_items catalog WHERE catalog.source_id=?
          AND catalog.public_id=json_extract(reviewed.value,'$.publicId')
          AND catalog.source_version=json_extract(reviewed.value,'$.sourceVersion') AND catalog.active=1))
      AND ${serviceGuard.sql}`)
    .bind(revisionId, proof.identityId, mutationKey, fingerprint, requestId, proof.workspaceId, proof.identityId,
      proof.sourceId, ...authorityGuard.bindings, reviewed, proof.sourceId, ...serviceGuard.bindings);
  try {
    const result = await db.batch([
      revision,
      db.prepare(`UPDATE client_service_requests SET status='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND catalog_source_id=? AND portal_workspace_id=? AND portal_identity_id=?
          AND EXISTS(SELECT 1 FROM request_revisions WHERE id=? AND request_id=client_service_requests.id)`)
        .bind(requestId, proof.sourceId, proof.workspaceId, proof.identityId, revisionId),
      db.prepare(`INSERT INTO client_portal_notification_outbox
        (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
        SELECT ?,request.id,'request_status_changed','cancelled','staff_triage',
          'request_status_changed:cancelled:staff_triage',json_object('title',request.title,
            'projectId',request.portal_project_public_id,'catalogSourceId',request.catalog_source_id)
        FROM client_service_requests request WHERE request.id=? AND request.status='cancelled'
          AND EXISTS(SELECT 1 FROM request_revisions WHERE id=? AND request_id=request.id)`)
        .bind(crypto.randomUUID(), requestId, revisionId),
      db.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
        SELECT 'client',?,'client.service_request.cancelled','client_service_request',request.id,
          json_object('workspaceId',request.portal_workspace_id,'projectPublicId',request.portal_project_public_id,
            'catalogSourceId',request.catalog_source_id)
        FROM client_service_requests request WHERE request.id=? AND request.status='cancelled'
          AND EXISTS(SELECT 1 FROM request_revisions WHERE id=? AND request_id=request.id)`)
        .bind(proof.identityId, requestId, revisionId),
    ]);
    if (!result[0]?.meta.changes) return { kind: "conflict", reason: "status_not_cancellable" };
  } catch { return { kind: "conflict", reason: "idempotency_key_reused" }; }
  const request = await loadNativeRequest(env, session, requestId);
  return request?.status === "cancelled" ? { kind: "cancelled", request } : null;
}

export async function listNativeServiceRequests(env: Env, session: ClientPortalSession): Promise<ClientServiceRequest[]> {
  const root = await resolveNativeRequestAuthority(env, session, null);
  if (!root) return [];
  let rows: D1Result<Record<string, unknown>>;
  try {
    rows = await database(env).prepare(`SELECT request.*,${nativeCurrentDraftReceiptColumn} FROM client_service_requests request
      WHERE request.portal_workspace_id=? AND request.portal_identity_id=? AND request.catalog_source_id=?
      ORDER BY request.created_at DESC,request.id DESC LIMIT 100`).bind(root.workspaceId, root.identityId, root.sourceId)
      .all<Record<string, unknown>>();
  } catch (error) {
    if (!missingDraftReceiptSchema(error)) throw error;
    rows = await database(env).prepare(`SELECT * FROM client_service_requests
      WHERE portal_workspace_id=? AND portal_identity_id=? AND catalog_source_id=?
      ORDER BY created_at DESC,id DESC LIMIT 100`).bind(root.workspaceId, root.identityId, root.sourceId)
      .all<Record<string, unknown>>();
  }
  const result: ClientServiceRequest[] = [];
  for (const row of rows.results) {
    const proof = await resolveNativeRequestAuthority(env, session, row.portal_project_public_id as string | null);
    if (proof?.sourceId === root.sourceId) result.push(mapRequest(row));
  }
  return result;
}

export const getNativeServiceRequest = loadNativeRequest;
