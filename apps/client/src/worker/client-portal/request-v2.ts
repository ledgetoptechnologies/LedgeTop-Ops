import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { sha256 } from "../security";
import type { Env } from "../types";
import type {
  ClientPortalSession,
  ClientServiceCatalogItem,
  ClientServiceDraftMutationResult,
  ClientServiceDraftSelection,
  ClientServiceQuestion,
  ClientServiceRequest,
  ClientServiceRequestCancelResult,
  ClientServiceRequestDraft,
  ClientServiceRequestDraftSummary,
  ClientServiceRequestDraftInput,
  ClientServiceDraftSubmitResult,
} from "./types";
import {
  readServiceAssignmentPolicy,
  changedAssignedServices,
  serializeServiceAssignmentPolicyProof,
  serviceAssignmentPolicyCheckpointSql,
  serviceAssignmentPolicyProofStillCurrent,
  serviceAssignmentPolicyServiceSql,
  serviceAssignmentRequestPolicyEnabled,
  ServiceAssignmentPolicyUnavailableError,
  type ServiceAssignmentPolicyProof,
} from "./service-assignment-policy";
import {
  effectiveWorkspaceRequestMutationGuardSql,
  portalHierarchyV2Enabled,
  readEffectiveWorkspaceRequestProof,
  type EffectiveWorkspaceRequestMutationProof,
} from "./workspace-v2";

const EARTH_RADIUS_METERS = 6_371_008.8;
const SQUARE_METERS_PER_ACRE = 4_046.8564224;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SOURCE_VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const QUESTION_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

interface CatalogRow {
  public_id: string;
  source_version: string;
  name: string;
  summary: string | null;
  category: string;
  display_order: number;
  geometry_requirement: string;
  question_schema_json: string;
}

interface DraftRow {
  id: string;
  project_id: string | null;
  state: "draft" | "submitted";
  version: number;
  draft_json: string;
  area_geojson: string | null;
  area_square_meters: number | null;
  area_acres: number | null;
  submitted_request_id: string | null;
  created_at: string;
  updated_at: string;
}

interface DraftServiceRow {
  service_public_id: string;
  service_source_version: string;
  service_snapshot_json: string;
  answers_json: string;
}

interface DraftSummaryRow {
  id: string;
  project_id: string | null;
  draft_json: string;
  area_acres: number | null;
  service_names_json: string;
  updated_at: string;
}

const sessionJoin = `
  JOIN client_accounts a ON a.id=? AND a.status='active'
    AND (a.project_alpha_source_id IS NULL OR a.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
  JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
  JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL`;

const draftAccess = `AND (
  (d.project_id IS NULL AND (m.role='manager' OR d.created_by_identity_id=i.id)) OR
  (d.project_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM client_project_grants g
    JOIN projects p ON p.id=g.project_id AND p.active=1
      AND (p.project_alpha_source_id IS NULL OR p.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
    WHERE g.account_id=a.id AND g.project_id=d.project_id AND g.revoked_at IS NULL
      AND (m.role='manager' OR EXISTS (
        SELECT 1 FROM client_member_project_grants mg
        WHERE mg.account_id=a.id AND mg.identity_id=i.id AND mg.project_id=d.project_id AND mg.revoked_at IS NULL
      ))
  ))
)`;

const requestMutationAccess = `AND (
  (r.project_id IS NULL AND (m.role='manager' OR r.created_by_identity_id=i.id)) OR
  (r.project_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM client_project_grants g
    JOIN projects p ON p.id=g.project_id AND p.active=1
      AND (p.project_alpha_source_id IS NULL OR p.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
    WHERE g.account_id=a.id AND g.project_id=r.project_id AND g.revoked_at IS NULL
      AND g.can_request_service=1
      AND (m.role='manager' OR EXISTS (
        SELECT 1 FROM client_member_project_grants mg
        WHERE mg.account_id=a.id AND mg.identity_id=i.id AND mg.project_id=r.project_id AND mg.revoked_at IS NULL
      ))
  ))
)`;

function db(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return typeof candidate.withSession === "function" ? candidate.withSession("first-primary") : env.DELIVERY_DB;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result && result.length <= maximum && !/[\u0000-\u001f\u007f]/.test(result) ? result : null;
}

export function sanitizeServiceQuestions(value: unknown): ClientServiceQuestion[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const ids = new Set<string>();
  const questions: ClientServiceQuestion[] = [];
  for (const raw of value) {
    if (!plainObject(raw)) return null;
    const id = safeText(raw.id, 64);
    const label = safeText(raw.label, 160);
    const helpText = raw.helpText === null || raw.helpText === undefined ? null : safeText(raw.helpText, 500);
    const required = raw.required === true;
    if (!id || !QUESTION_ID.test(id) || ids.has(id) || !label || (raw.helpText != null && !helpText)) return null;
    ids.add(id);
    if (raw.type === "text") {
      const maxLength = raw.maxLength === undefined ? 1000 : Number(raw.maxLength);
      if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 2000) return null;
      questions.push({ id, label, type: "text", required, helpText, maxLength });
      continue;
    }
    if (raw.type === "number") {
      const minimum = raw.minimum === null || raw.minimum === undefined ? null : Number(raw.minimum);
      const maximum = raw.maximum === null || raw.maximum === undefined ? null : Number(raw.maximum);
      if ((minimum !== null && !Number.isFinite(minimum)) || (maximum !== null && !Number.isFinite(maximum)) || (minimum !== null && maximum !== null && minimum > maximum)) return null;
      questions.push({ id, label, type: "number", required, helpText, minimum, maximum });
      continue;
    }
    if (raw.type === "boolean") {
      questions.push({ id, label, type: "boolean", required, helpText });
      continue;
    }
    if (raw.type === "select" || raw.type === "multi_select") {
      if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > 50) return null;
      const values = new Set<string>();
      const options: Array<{ value: string; label: string }> = [];
      for (const option of raw.options) {
        if (!plainObject(option)) return null;
        const optionValue = safeText(option.value, 100);
        const optionLabel = safeText(option.label, 160);
        if (!optionValue || !optionLabel || values.has(optionValue)) return null;
        values.add(optionValue);
        options.push({ value: optionValue, label: optionLabel });
      }
      questions.push({ id, label, type: raw.type, required, helpText, options });
      continue;
    }
    return null;
  }
  return questions;
}

export function mapServiceCatalogItem(row: CatalogRow): ClientServiceCatalogItem | null {
  const summary = row.summary === null ? null : safeText(row.summary, 1000);
  const category = safeText(row.category, 100);
  if (!PUBLIC_ID.test(row.public_id) || !safeText(row.source_version, 128) || !safeText(row.name, 160) || (row.summary !== null && !summary) || !category) return null;
  if (!Number.isSafeInteger(row.display_order) || row.display_order < 0 || row.display_order > 1_000_000) return null;
  if (row.geometry_requirement !== "none" && row.geometry_requirement !== "optional" && row.geometry_requirement !== "required") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(row.question_schema_json); } catch { return null; }
  const questions = sanitizeServiceQuestions(parsed);
  if (!questions) return null;
  return {
    publicId: row.public_id,
    sourceVersion: row.source_version,
    name: row.name.trim(),
    summary,
    category,
    displayOrder: row.display_order,
    geometryRequirement: row.geometry_requirement,
    questions,
  };
}

export function validateServiceAnswers(questions: ClientServiceQuestion[], value: unknown, allowIncomplete = false): Record<string, unknown> | null {
  if (!plainObject(value) || Object.keys(value).length > questions.length) return null;
  const allowed = new Map(questions.map(question => [question.id, question]));
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const question = allowed.get(key);
    if (!question) return null;
    const answer = value[key];
    if (answer === null || answer === "" || (Array.isArray(answer) && answer.length === 0)) continue;
    if (question.type === "text") {
      if (typeof answer !== "string" || answer.length > question.maxLength || /[\u0000\u007f]/.test(answer)) return null;
      normalized[key] = answer;
    } else if (question.type === "number") {
      if (typeof answer !== "number" || !Number.isFinite(answer) || (question.minimum !== null && answer < question.minimum) || (question.maximum !== null && answer > question.maximum)) return null;
      normalized[key] = answer;
    } else if (question.type === "boolean") {
      if (typeof answer !== "boolean") return null;
      normalized[key] = answer;
    } else {
      const options = new Set(question.options.map(option => option.value));
      if (question.type === "select") {
        if (typeof answer !== "string" || !options.has(answer)) return null;
        normalized[key] = answer;
      } else {
        if (!Array.isArray(answer) || answer.length > 20 || !answer.every(item => typeof item === "string" && options.has(item)) || new Set(answer).size !== answer.length) return null;
        normalized[key] = [...answer].sort();
      }
    }
  }
  if (!allowIncomplete && questions.some(question => question.required && normalized[question.id] === undefined)) return null;
  return normalized;
}

/** Spherical area derived only from the already validated Mapbox polygon. */
export function calculateRequestAreaSquareMeters(area: ClientServiceRequestDraftInput["areaGeoJson"]): number | null {
  if (!area) return null;
  const ring = area.coordinates[0]!;
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [longitude1, latitude1] = ring[index]!;
    const [longitude2, latitude2] = ring[index + 1]!;
    const deltaLongitude = (longitude2 - longitude1) * Math.PI / 180;
    sum += deltaLongitude * (2 + Math.sin(latitude1 * Math.PI / 180) + Math.sin(latitude2 * Math.PI / 180));
  }
  return Math.abs(sum * EARTH_RADIUS_METERS * EARTH_RADIUS_METERS / 2);
}

function requestFields(input: ClientServiceRequestDraftInput): Omit<ClientServiceRequestDraftInput, "areaGeoJson" | "services"> {
  const { areaGeoJson: _area, services: _services, ...fields } = input;
  return fields;
}

type SelectionResolution =
  | { kind: "resolved"; services: ClientServiceDraftSelection[] }
  | { kind: "catalog_changed"; servicePublicIds: string[] }
  | { kind: "invalid" };

type RequestPolicyResolution =
  | { kind: "ready"; proof: ServiceAssignmentPolicyProof | null }
  | { kind: "service_assignments_changed"; servicePublicIds: string[] };

type RequestAuthorityResolution =
  | { kind: "ready"; proof: EffectiveWorkspaceRequestMutationProof | null }
  | { kind: "unavailable" };

async function resolveRequestAuthority(
  env: Env,
  session: ClientPortalSession,
  projectId: string | null,
): Promise<RequestAuthorityResolution> {
  // Compatibility is deliberately unchanged while hierarchy-v2 is off. Once
  // it is on, retained legacy rows cannot substitute for the selected
  // workspace, verified actor, exact target, or current request.create rule.
  if (!portalHierarchyV2Enabled(env)) return { kind: "ready", proof: null };
  if (!session.workspaceId || !session.principalIssuer || !session.principalSubject)
    return { kind: "unavailable" };
  const current = await readEffectiveWorkspaceRequestProof(env, {
    issuer: session.principalIssuer,
    subject: session.principalSubject,
    email: session.principalEmail ?? "",
  }, session.workspaceId, projectId);
  if (!current || current.workspace.workspaceId !== session.workspaceId
    || current.workspace.identityId !== current.mutationProof.identityId
    || current.workspace.legacyAccountId !== session.accountId
    || current.workspace.legacyIdentityId !== session.identityId
    || (projectId === null ? !current.rootAllowed : !current.projectAllowed))
    return { kind: "unavailable" };
  return { kind: "ready", proof: current.mutationProof };
}

function reviewedRequestAuthorityGuard(proof: EffectiveWorkspaceRequestMutationProof | null) {
  return proof ? effectiveWorkspaceRequestMutationGuardSql(proof) : { sql: "1=1", bindings: [] as unknown[] };
}

async function resolveRequestPolicy(env: Env, session: ClientPortalSession, projectId: string | null,
  services: ReadonlyArray<{ publicId: string; sourceVersion: string }> = []): Promise<RequestPolicyResolution> {
  if (!serviceAssignmentRequestPolicyEnabled(env)) return { kind: "ready", proof: null };
  const decision = await readServiceAssignmentPolicy(env, session, projectId);
  if (decision.state !== "ready") return { kind: "service_assignments_changed", servicePublicIds: services.map(service => service.publicId) };
  const changed = await changedAssignedServices(env, decision.proof, services);
  return changed.length ? { kind: "service_assignments_changed", servicePublicIds: changed }
    : { kind: "ready", proof: decision.proof };
}

async function resolveSelections(env: Env, input: ClientServiceRequestDraftInput): Promise<SelectionResolution> {
  if (input.services.length > 10 || new Set(input.services.map(service => service.publicId)).size !== input.services.length)
    return { kind: "invalid" };
  const selected: ClientServiceDraftSelection[] = [];
  const changed: string[] = [];
  for (const inputService of input.services) {
    if (!PUBLIC_ID.test(inputService.publicId) || !SOURCE_VERSION.test(inputService.sourceVersion))
      return { kind: "invalid" };
    const row = await db(env).prepare(`SELECT public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json FROM pa_service_catalog_items WHERE source_id=? AND public_id=? AND active=1`).bind(PRIMARY_ALPHA_SOURCE_ID, inputService.publicId).first<CatalogRow>();
    const catalog = row ? mapServiceCatalogItem(row) : null;
    if (!catalog || catalog.sourceVersion !== inputService.sourceVersion) {
      changed.push(inputService.publicId);
      continue;
    }
    const answers = validateServiceAnswers(catalog.questions, inputService.answers, true);
    if (!answers) return { kind: "invalid" };
    selected.push({ ...catalog, answers });
  }
  return changed.length
    ? { kind: "catalog_changed", servicePublicIds: changed }
    : { kind: "resolved", services: selected };
}

function serializeDraft(input: ClientServiceRequestDraftInput, services: ClientServiceDraftSelection[], id: string, version: number, state: "draft" | "submitted", timestamps: { createdAt: string; updatedAt: string }, submittedRequestId: string | null): ClientServiceRequestDraft {
  const areaSquareMeters = calculateRequestAreaSquareMeters(input.areaGeoJson);
  return {
    id, state, version, ...requestFields(input), areaGeoJson: input.areaGeoJson,
    areaSquareMeters,
    areaAcres: areaSquareMeters === null ? null : areaSquareMeters / SQUARE_METERS_PER_ACRE,
    services, submittedRequestId, createdAt: timestamps.createdAt, updatedAt: timestamps.updatedAt,
  };
}

async function loadDraft(env: Env, session: ClientPortalSession, draftId: string): Promise<ClientServiceRequestDraft | null> {
  const row = await db(env).prepare(`SELECT d.id,d.project_id,d.state,d.version,d.draft_json,d.area_geojson,d.area_square_meters,d.area_acres,d.submitted_request_id,d.created_at,d.updated_at
    FROM client_service_request_drafts d ${sessionJoin}
    WHERE d.id=? AND d.account_id=a.id AND d.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}' ${draftAccess}`)
    .bind(session.accountId, session.identityId, draftId).first<DraftRow>();
  if (!row) return null;
  let fields: Omit<ClientServiceRequestDraftInput, "areaGeoJson" | "services">;
  let areaGeoJson: ClientServiceRequestDraftInput["areaGeoJson"] = null;
  try {
    fields = JSON.parse(row.draft_json) as typeof fields;
    areaGeoJson = row.area_geojson ? JSON.parse(row.area_geojson) as typeof areaGeoJson : null;
  } catch { return null; }
  const serviceRows = await db(env).prepare(`SELECT service_public_id,service_source_version,service_snapshot_json,answers_json FROM client_service_request_draft_services WHERE draft_id=? AND service_source_id=? ORDER BY ordinal`).bind(draftId, PRIMARY_ALPHA_SOURCE_ID).all<DraftServiceRow>();
  const services: ClientServiceDraftSelection[] = [];
  try {
    for (const serviceRow of serviceRows.results) {
      const snapshot = JSON.parse(serviceRow.service_snapshot_json) as Omit<ClientServiceDraftSelection, "answers">;
      const answers = JSON.parse(serviceRow.answers_json) as Record<string, unknown>;
      const category = safeText(snapshot.category, 100) ?? "Uncategorized";
      const displayOrder = Number.isSafeInteger(snapshot.displayOrder) && snapshot.displayOrder >= 0 && snapshot.displayOrder <= 1_000_000 ? snapshot.displayOrder : 0;
      const geometryRequirement = snapshot.geometryRequirement === "none" || snapshot.geometryRequirement === "required" ? snapshot.geometryRequirement : "optional";
      services.push({ ...snapshot, publicId: serviceRow.service_public_id, sourceVersion: serviceRow.service_source_version, category, displayOrder, geometryRequirement, answers });
    }
  } catch { return null; }
  return {
    id: row.id, state: row.state, version: row.version, ...fields!, areaGeoJson,
    areaSquareMeters: row.area_square_meters, areaAcres: row.area_acres, services,
    submittedRequestId: row.submitted_request_id, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function listServiceRequestDrafts(
  env: Env,
  session: ClientPortalSession,
): Promise<ClientServiceRequestDraftSummary[]> {
  const rows = await db(env).prepare(`SELECT d.id,d.project_id,d.draft_json,d.area_acres,d.updated_at,
      COALESCE((SELECT json_group_array(json_extract(service.service_snapshot_json,'$.name'))
        FROM client_service_request_draft_services service WHERE service.draft_id=d.id AND service.service_source_id=d.catalog_source_id),'[]') service_names_json
    FROM client_service_request_drafts d ${sessionJoin}
    WHERE d.account_id=a.id AND d.state='draft' AND d.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}' ${draftAccess}
    ORDER BY d.updated_at DESC,d.id DESC LIMIT 20`)
    .bind(session.accountId, session.identityId)
    .all<DraftSummaryRow>();
  const summaries: ClientServiceRequestDraftSummary[] = [];
  for (const row of rows.results) {
    try {
      const fields = JSON.parse(row.draft_json) as { title?: unknown };
      const names = JSON.parse(row.service_names_json) as unknown;
      if (!Array.isArray(names) || names.length > 10 || !names.every(name => typeof name === "string" && name.length <= 160)) continue;
      summaries.push({
        id: row.id,
        projectId: row.project_id,
        title: safeText(fields.title, 160) ?? "Untitled request",
        serviceNames: names,
        areaAcres: row.area_acres,
        updatedAt: row.updated_at,
      });
    } catch {
      // A malformed legacy draft is omitted instead of breaking the whole list.
    }
  }
  return summaries;
}

function serviceSnapshot(service: ClientServiceDraftSelection): string {
  return JSON.stringify({
    publicId: service.publicId,
    sourceVersion: service.sourceVersion,
    name: service.name,
    summary: service.summary,
    category: service.category,
    displayOrder: service.displayOrder,
    geometryRequirement: service.geometryRequirement,
    questions: service.questions,
  });
}

// At most ten reviewed selections enter this predicate. The indexed lookup is
// part of the first write in each atomic batch, not just an earlier catalog read.
const reviewedCatalogGuard = `NOT EXISTS (
  SELECT 1 FROM json_each(?) reviewed
  WHERE NOT EXISTS (
    SELECT 1 FROM pa_service_catalog_items current
    WHERE current.source_id='${PRIMARY_ALPHA_SOURCE_ID}'
      AND current.public_id=json_extract(reviewed.value,'$.publicId')
      AND current.source_version=json_extract(reviewed.value,'$.sourceVersion')
      AND current.active=1
  )
)`;

function reviewedCatalogVersions(services: ReadonlyArray<{ publicId: string; sourceVersion: string }>): string {
  return JSON.stringify(services.map(({ publicId, sourceVersion }) => ({ publicId, sourceVersion })));
}

async function currentAssignmentConflict(
  env: Env,
  proof: ServiceAssignmentPolicyProof | null,
  services: ReadonlyArray<{ publicId: string; sourceVersion: string }>,
): Promise<string[] | null> {
  if (!serviceAssignmentRequestPolicyEnabled(env)) return null;
  if (!proof || !await serviceAssignmentPolicyProofStillCurrent(env, proof))
    return services.map(service => service.publicId);
  const changed = await changedAssignedServices(env, proof, services);
  return changed.length ? changed : null;
}

function reviewedServiceAssignmentGuard(
  proof: ServiceAssignmentPolicyProof | null,
  services: ReadonlyArray<{ publicId: string; sourceVersion: string }>,
) {
  if (!proof) return { sql: "1=1", bindings: [] as unknown[] };
  const checkpoint = serviceAssignmentPolicyCheckpointSql(proof);
  const assignment = serviceAssignmentPolicyServiceSql(proof, "catalog", true);
  return {
    sql: `${checkpoint.sql} AND NOT EXISTS (
      SELECT 1 FROM json_each(?) reviewed WHERE NOT EXISTS (
        SELECT 1 FROM pa_service_catalog_items catalog
        WHERE catalog.source_id=? AND catalog.public_id=json_extract(reviewed.value,'$.publicId')
          AND catalog.source_version=json_extract(reviewed.value,'$.sourceVersion') AND catalog.active=1
          AND ${assignment.sql}
      )
    )`,
    bindings: [
      ...checkpoint.bindings,
      reviewedCatalogVersions(services),
      proof.sourceId,
      ...assignment.bindings,
    ] as unknown[],
  };
}

export async function listServiceCatalog(env: Env, session?: ClientPortalSession, projectId: string | null = null): Promise<ClientServiceCatalogItem[]> {
  let assignmentGuard: ReturnType<typeof serviceAssignmentPolicyServiceSql> | null = null;
  if (serviceAssignmentRequestPolicyEnabled(env)) {
    if (!session) throw new ServiceAssignmentPolicyUnavailableError();
    const assignment = await readServiceAssignmentPolicy(env, session, projectId);
    if (assignment.state === "unavailable" || assignment.state === "disabled") throw new ServiceAssignmentPolicyUnavailableError();
    assignmentGuard = serviceAssignmentPolicyServiceSql(assignment.proof);
  }
  const result = await db(env).prepare(`SELECT public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json
    FROM pa_service_catalog_items catalog WHERE source_id=? AND active=1${assignmentGuard ? ` AND ${assignmentGuard.sql}` : ""}
    ORDER BY category COLLATE NOCASE,display_order,name COLLATE NOCASE,public_id LIMIT 500`)
    .bind(PRIMARY_ALPHA_SOURCE_ID,...(assignmentGuard?.bindings ?? [])).all<CatalogRow>();
  return result.results.map(mapServiceCatalogItem).filter((item): item is ClientServiceCatalogItem => item !== null);
}

export async function getServiceRequestDraft(env: Env, session: ClientPortalSession, draftId: string): Promise<ClientServiceRequestDraft | null> {
  return loadDraft(env, session, draftId);
}

export async function createServiceRequestDraft(env: Env, session: ClientPortalSession, input: ClientServiceRequestDraftInput, mutationKey: string): Promise<ClientServiceDraftMutationResult | null> {
  const fingerprint = await sha256(JSON.stringify(input));
  const existing = await db(env).prepare(`SELECT id,create_fingerprint FROM client_service_request_drafts WHERE account_id=? AND create_idempotency_key=? AND catalog_source_id=?`).bind(session.accountId, mutationKey, PRIMARY_ALPHA_SOURCE_ID).first<{ id: string; create_fingerprint: string }>();
  if (existing) {
    if (existing.create_fingerprint !== fingerprint) return { kind: "conflict" };
    const draft = await loadDraft(env, session, existing.id);
    return draft ? { kind: "replayed", draft } : null;
  }
  const policy = await resolveRequestPolicy(env, session, input.projectId, input.services);
  if (policy.kind === "service_assignments_changed") return policy;
  const authority = await resolveRequestAuthority(env, session, input.projectId);
  if (authority.kind === "unavailable") return null;
  const resolution = await resolveSelections(env, input);
  if (resolution.kind === "invalid") return null;
  if (resolution.kind === "catalog_changed") return resolution;
  const services = resolution.services;
  const id = crypto.randomUUID();
  const areaSquareMeters = calculateRequestAreaSquareMeters(input.areaGeoJson);
  const database = db(env);
  const assignmentGuard = reviewedServiceAssignmentGuard(policy.proof, services);
  const authorityGuard = reviewedRequestAuthorityGuard(authority.proof);
  const insert = database.prepare(`INSERT INTO client_service_request_drafts
    (id,account_id,project_id,created_by_identity_id,draft_json,area_geojson,area_square_meters,area_acres,create_idempotency_key,create_fingerprint,last_mutation_key,catalog_source_id,service_assignment_policy_v2_json)
    SELECT ?,a.id,?,i.id,?,?,?,?,?,?,?,'${PRIMARY_ALPHA_SOURCE_ID}',?
    FROM client_accounts a
    JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
    JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
    WHERE a.id=? AND a.status='active' AND (a.project_alpha_source_id IS NULL OR a.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}') AND (? IS NULL OR EXISTS (
      SELECT 1 FROM client_project_grants g JOIN projects p ON p.id=g.project_id AND p.active=1
        AND (p.project_alpha_source_id IS NULL OR p.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
      WHERE g.account_id=a.id AND g.project_id=? AND g.revoked_at IS NULL AND g.can_request_service=1
        AND (m.role='manager' OR EXISTS (SELECT 1 FROM client_member_project_grants mg WHERE mg.account_id=a.id AND mg.identity_id=i.id AND mg.project_id=g.project_id AND mg.revoked_at IS NULL))
    )) AND ${reviewedCatalogGuard} AND ${assignmentGuard.sql} AND ${authorityGuard.sql}`).bind(id, input.projectId, JSON.stringify(requestFields(input)), input.areaGeoJson ? JSON.stringify(input.areaGeoJson) : null, areaSquareMeters, areaSquareMeters === null ? null : areaSquareMeters / SQUARE_METERS_PER_ACRE, mutationKey, fingerprint, mutationKey,
      serializeServiceAssignmentPolicyProof(policy.proof),session.identityId, session.accountId, input.projectId, input.projectId,
      reviewedCatalogVersions(services),...assignmentGuard.bindings,...authorityGuard.bindings);
  const statements = [insert, ...services.map((service, ordinal) => database.prepare(`INSERT INTO client_service_request_draft_services(draft_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,service_source_id)
    SELECT ?,?,?,?,?,?,'${PRIMARY_ALPHA_SOURCE_ID}' WHERE EXISTS (SELECT 1 FROM client_service_request_drafts WHERE id=? AND last_mutation_key=? AND catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}')`).bind(id, ordinal, service.publicId, service.sourceVersion, serviceSnapshot(service), JSON.stringify(service.answers), id, mutationKey))];
  try {
    const results = await database.batch(statements);
    if (!results[0]?.meta.changes) {
      const changed = await changedCatalogServices(env, services);
      if (changed.length) return { kind: "catalog_changed", servicePublicIds: changed };
      const assigned = await currentAssignmentConflict(env, policy.proof, services);
      return assigned ? { kind: "service_assignments_changed", servicePublicIds: assigned } : null;
    }
  } catch {
    const raced = await db(env).prepare(`SELECT id,create_fingerprint FROM client_service_request_drafts WHERE account_id=? AND create_idempotency_key=? AND catalog_source_id=?`).bind(session.accountId, mutationKey, PRIMARY_ALPHA_SOURCE_ID).first<{ id: string; create_fingerprint: string }>();
    if (!raced || raced.create_fingerprint !== fingerprint) return raced ? { kind: "conflict" } : null;
    const replay = await loadDraft(env, session, raced.id);
    return replay ? { kind: "replayed", draft: replay } : null;
  }
  const draft = await loadDraft(env, session, id);
  return draft ? { kind: "created", draft } : null;
}

export async function saveServiceRequestDraft(env: Env, session: ClientPortalSession, draftId: string, expectedVersion: number, input: ClientServiceRequestDraftInput, mutationKey: string): Promise<ClientServiceDraftMutationResult | null> {
  // Parent provenance fences even empty drafts and replay lookups. It is not
  // inferred from selected services, and never comes from browser input.
  if (!await loadDraft(env, session, draftId)) return null;
  const fingerprint = await sha256(JSON.stringify(input));
  const replay = await db(env).prepare(`SELECT mutation_fingerprint FROM client_service_request_draft_mutations mutation JOIN client_service_request_drafts d ON d.id=mutation.draft_id WHERE draft_id=? AND mutation_key=? AND d.account_id=? AND d.catalog_source_id=?`).bind(draftId, mutationKey, session.accountId, PRIMARY_ALPHA_SOURCE_ID).first<{ mutation_fingerprint: string }>();
  if (replay) {
    if (replay.mutation_fingerprint !== fingerprint) return { kind: "conflict" };
    const draft = await loadDraft(env, session, draftId);
    return draft ? { kind: "replayed", draft } : null;
  }
  const policy = await resolveRequestPolicy(env, session, input.projectId, input.services);
  if (policy.kind === "service_assignments_changed") return policy;
  const authority = await resolveRequestAuthority(env, session, input.projectId);
  if (authority.kind === "unavailable") return null;
  const resolution = await resolveSelections(env, input);
  if (resolution.kind === "invalid") return null;
  if (resolution.kind === "catalog_changed") return resolution;
  const services = resolution.services;
  const areaSquareMeters = calculateRequestAreaSquareMeters(input.areaGeoJson);
  const database = db(env);
  const assignmentGuard = reviewedServiceAssignmentGuard(policy.proof, services);
  const authorityGuard = reviewedRequestAuthorityGuard(authority.proof);
  const update = database.prepare(`UPDATE client_service_request_drafts AS d SET project_id=?,draft_json=?,area_geojson=?,area_square_meters=?,area_acres=?,service_assignment_policy_v2_json=?,version=version+1,last_mutation_key=?,updated_at=strftime('%Y-%m-%d %H:%M:%f','now')
    WHERE d.id=? AND d.account_id=? AND d.state='draft' AND d.version=? AND d.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}'
      AND EXISTS (SELECT 1 FROM client_accounts a
        JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
        JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
        WHERE a.id=d.account_id AND a.status='active' AND (a.project_alpha_source_id IS NULL OR a.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}') AND (? IS NULL OR EXISTS (
          SELECT 1 FROM client_project_grants g JOIN projects p ON p.id=g.project_id AND p.active=1
            AND (p.project_alpha_source_id IS NULL OR p.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
          WHERE g.account_id=a.id AND g.project_id=? AND g.revoked_at IS NULL AND g.can_request_service=1
            AND (m.role='manager' OR EXISTS (SELECT 1 FROM client_member_project_grants mg WHERE mg.account_id=a.id AND mg.identity_id=i.id AND mg.project_id=g.project_id AND mg.revoked_at IS NULL))
        ))) AND ${reviewedCatalogGuard} AND ${assignmentGuard.sql} AND ${authorityGuard.sql}`)
    .bind(input.projectId, JSON.stringify(requestFields(input)), input.areaGeoJson ? JSON.stringify(input.areaGeoJson) : null, areaSquareMeters, areaSquareMeters === null ? null : areaSquareMeters / SQUARE_METERS_PER_ACRE,
      serializeServiceAssignmentPolicyProof(policy.proof),mutationKey, draftId, session.accountId, expectedVersion,
      session.identityId, input.projectId, input.projectId, reviewedCatalogVersions(services),
      ...assignmentGuard.bindings,...authorityGuard.bindings);
  const statements = [
    update,
    database.prepare(`DELETE FROM client_service_request_draft_services WHERE draft_id=? AND service_source_id='${PRIMARY_ALPHA_SOURCE_ID}' AND EXISTS (SELECT 1 FROM client_service_request_drafts WHERE id=? AND last_mutation_key=? AND catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}')`).bind(draftId, draftId, mutationKey),
    ...services.map((service, ordinal) => database.prepare(`INSERT INTO client_service_request_draft_services(draft_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,service_source_id)
      SELECT ?,?,?,?,?,?,'${PRIMARY_ALPHA_SOURCE_ID}' WHERE EXISTS (SELECT 1 FROM client_service_request_drafts WHERE id=? AND last_mutation_key=? AND catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}')`).bind(draftId, ordinal, service.publicId, service.sourceVersion, serviceSnapshot(service), JSON.stringify(service.answers), draftId, mutationKey)),
    database.prepare(`INSERT INTO client_service_request_draft_mutations(draft_id,mutation_key,mutation_fingerprint,resulting_version,result_snapshot_json)
      SELECT ?,?,?,version,json_object('version',version) FROM client_service_request_drafts WHERE id=? AND last_mutation_key=? AND catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}'`).bind(draftId, mutationKey, fingerprint, draftId, mutationKey),
  ];
  try {
    const results = await database.batch(statements);
    if (!results[0]?.meta.changes) {
      const changed = await changedCatalogServices(env, services);
      if (changed.length) return { kind: "catalog_changed", servicePublicIds: changed };
      const assigned = await currentAssignmentConflict(env, policy.proof, services);
      return assigned ? { kind: "service_assignments_changed", servicePublicIds: assigned } : { kind: "conflict" };
    }
  } catch { return { kind: "conflict" }; }
  const draft = await loadDraft(env, session, draftId);
  return draft ? { kind: "updated", draft } : null;
}

function incompleteAnswerServices(draft: ClientServiceRequestDraft): string[] {
  if (!draft.services.length) return [];
  return draft.services
    .filter(service => validateServiceAnswers(service.questions, service.answers) === null)
    .map(service => service.publicId);
}

async function changedCatalogServices(env: Env, services: ReadonlyArray<{ publicId: string; sourceVersion: string }>): Promise<string[]> {
  const changed: string[] = [];
  for (const service of services) {
    const current = await db(env).prepare(`SELECT source_version FROM pa_service_catalog_items WHERE source_id=? AND public_id=? AND active=1`).bind(PRIMARY_ALPHA_SOURCE_ID, service.publicId).first<{ source_version: string }>();
    if (!current || current.source_version !== service.sourceVersion) changed.push(service.publicId);
  }
  return changed;
}

async function attachmentSubmissionBlock(
  env: Env,
  draftId: string,
): Promise<{ reason: "attachments_pending" | "attachments_rejected" | "attachments_expired"; attachmentCount: number } | null> {
  const rows = await db(env).prepare(`SELECT status,COUNT(*) count FROM client_service_request_attachments
    WHERE draft_id=? AND status NOT IN ('accepted','aborted')
      AND EXISTS (SELECT 1 FROM client_service_request_drafts draft WHERE draft.id=draft_id AND draft.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}') GROUP BY status`)
    .bind(draftId).all<{ status: string; count: number }>();
  const counts = new Map(rows.results.map(row => [row.status, Number(row.count)]));
  const rejected = counts.get("rejected") ?? 0;
  if (rejected > 0) return { reason: "attachments_rejected", attachmentCount: rejected };
  const expired = counts.get("expired") ?? 0;
  if (expired > 0) return { reason: "attachments_expired", attachmentCount: expired };
  const pending = [...counts.entries()].reduce((total, [status, count]) =>
    status === "rejected" || status === "expired" ? total : total + count, 0);
  return pending > 0 ? { reason: "attachments_pending", attachmentCount: pending } : null;
}

function legacyRequestFromRow(row: Record<string, unknown>): ClientServiceRequest {
  return {
    id: String(row.id), projectId: row.project_id as string | null, requestType: row.request_type as "flight" | "service",
    title: String(row.title), details: String(row.details), location: row.location_text as string | null,
    preferredStartAt: row.preferred_start_at as string | null, serviceCategory: row.service_category as string | null,
    deliverables: row.deliverables_text as string | null, siteContactName: row.site_contact_name as string | null,
    siteContactEmail: row.site_contact_email as string | null, siteContactPhone: row.site_contact_phone as string | null,
    desiredCompletionAt: row.desired_completion_at as string | null, latitude: row.latitude as number | null,
    longitude: row.longitude as number | null, areaGeoJson: row.area_geojson ? JSON.parse(String(row.area_geojson)) : null,
    poiPoints: row.poi_points_json ? JSON.parse(String(row.poi_points_json)) : [], status: row.status as ClientServiceRequest["status"],
    acceptedQuote: null, operationalEstimate: null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

async function loadSubmittedRequest(env: Env, session: ClientPortalSession, requestId: string): Promise<ClientServiceRequest | null> {
  const row = await db(env).prepare(`SELECT r.* FROM client_service_requests r ${sessionJoin} WHERE r.id=? AND r.account_id=a.id AND r.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}'`).bind(session.accountId, session.identityId, requestId).first<Record<string, unknown>>();
  return row ? legacyRequestFromRow(row) : null;
}

interface CancellableRequestRow {
  project_id: string | null;
  status: ClientServiceRequest["status"];
  title: string;
}

interface RequestMutationReplayRow {
  action: string;
  mutation_fingerprint: string | null;
  snapshot_json: string;
}

const cancellableStatuses = new Set<ClientServiceRequest["status"]>([
  "submitted",
  "under_review",
  "accepted_pending_pa_linkage",
]);

async function loadCancellationTarget(
  env: Env,
  session: ClientPortalSession,
  requestId: string,
): Promise<CancellableRequestRow | null> {
  return db(env).prepare(`SELECT r.project_id,r.status,r.title
    FROM client_service_requests r ${sessionJoin}
    WHERE r.id=? AND r.account_id=a.id AND r.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}'
      ${requestMutationAccess}`)
    .bind(session.accountId, session.identityId, requestId)
    .first<CancellableRequestRow>();
}

async function loadCancellationReplay(
  env: Env,
  session: ClientPortalSession,
  requestId: string,
  mutationKey: string,
): Promise<RequestMutationReplayRow | null> {
  return db(env).prepare(`SELECT revision.action,revision.mutation_fingerprint,revision.snapshot_json
    FROM request_revisions revision
    JOIN client_service_requests r ON r.id=revision.request_id
    ${sessionJoin}
    WHERE revision.request_id=? AND revision.mutation_key=? AND r.account_id=a.id
      AND r.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}' ${requestMutationAccess}`)
    .bind(session.accountId, session.identityId, requestId, mutationKey)
    .first<RequestMutationReplayRow>();
}

function isCancellationReplay(row: RequestMutationReplayRow, fingerprint: string): boolean {
  if (row.action !== "status_changed" || row.mutation_fingerprint !== fingerprint) return false;
  try {
    const snapshot = JSON.parse(row.snapshot_json) as { status?: unknown };
    return snapshot.status === "cancelled";
  } catch {
    return false;
  }
}

async function cancellationPaDraftConflict(
  env: Env,
  requestId: string,
): Promise<"reconciliation_required" | "status_not_cancellable" | null> {
  const row = await db(env).prepare(`SELECT
      EXISTS(SELECT 1 FROM request_pa_draft_quote_commands command
        WHERE command.request_id=?) command_exists,
      EXISTS(SELECT 1 FROM request_pa_draft_quote_commands command
        WHERE command.request_id=? AND NOT EXISTS(
          SELECT 1 FROM request_pa_draft_quote_receipts receipt WHERE receipt.command_id=command.id
        )) unresolved_command,
      EXISTS(SELECT 1 FROM request_pa_draft_quote_receipts receipt
        WHERE receipt.request_id=?) receipt_exists`)
    .bind(requestId, requestId, requestId)
    .first<{ command_exists: number; unresolved_command: number; receipt_exists: number }>();
  if (row?.unresolved_command) return "reconciliation_required";
  if (row?.command_exists || row?.receipt_exists) return "status_not_cancellable";
  return null;
}

/**
 * Cancels only pre-work client requests. Catalog, assignment, source, identity,
 * workspace and exact target authority are all re-read, then fenced again in
 * the first statement of the atomic batch. Existing terminal/linked work is
 * deliberately immutable through this client mutation.
 */
export async function cancelServiceRequest(
  env: Env,
  session: ClientPortalSession,
  requestId: string,
  mutationKey: string,
): Promise<ClientServiceRequestCancelResult | null> {
  const target = await loadCancellationTarget(env, session, requestId);
  if (!target) return null;
  const fingerprint = await sha256(JSON.stringify({ action: "cancel", requestId, version: 1 }));
  const existing = await loadCancellationReplay(env, session, requestId, mutationKey);
  if (existing) {
    if (!isCancellationReplay(existing, fingerprint))
      return { kind: "conflict", reason: "idempotency_key_reused" };
    const request = await loadSubmittedRequest(env, session, requestId);
    return request?.status === "cancelled" ? { kind: "replayed", request } : null;
  }
  if (!cancellableStatuses.has(target.status))
    return { kind: "conflict", reason: "status_not_cancellable" };
  const paDraftConflict = await cancellationPaDraftConflict(env, requestId);
  if (paDraftConflict) return { kind: "conflict", reason: paDraftConflict };

  const serviceRows = await db(env).prepare(`SELECT service_public_id publicId,service_source_version sourceVersion
    FROM client_service_request_services
    WHERE request_id=? AND service_source_id='${PRIMARY_ALPHA_SOURCE_ID}' ORDER BY ordinal`)
    .bind(requestId).all<{ publicId: string; sourceVersion: string }>();
  const services = serviceRows.results;
  const changed = await changedCatalogServices(env, services);
  if (changed.length) return { kind: "conflict", reason: "catalog_changed" };
  const policy = await resolveRequestPolicy(env, session, target.project_id, services);
  if (policy.kind === "service_assignments_changed")
    return { kind: "conflict", reason: "service_assignments_changed" };
  const authority = await resolveRequestAuthority(env, session, target.project_id);
  if (authority.kind === "unavailable") return null;

  const revisionId = crypto.randomUUID();
  const database = db(env);
  const assignmentGuard = reviewedServiceAssignmentGuard(policy.proof, services);
  const authorityGuard = reviewedRequestAuthorityGuard(authority.proof);
  const revision = database.prepare(`INSERT INTO request_revisions
      (id,request_id,revision_number,author_type,author_id,action,snapshot_json,mutation_key,mutation_fingerprint)
    SELECT ?,r.id,COALESCE((SELECT MAX(existing.revision_number)+1 FROM request_revisions existing WHERE existing.request_id=r.id),1),
      'client',?,'status_changed',json_object('title',r.title,'projectId',r.project_id,'previousStatus',r.status,
        'status','cancelled','catalogSourceId',r.catalog_source_id),?,?
    FROM client_service_requests r ${sessionJoin}
    WHERE r.id=? AND r.account_id=a.id AND r.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}'
      AND r.status IN ('submitted','under_review','accepted_pending_pa_linkage') ${requestMutationAccess}
      AND NOT EXISTS(SELECT 1 FROM request_pa_draft_quote_commands command WHERE command.request_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM request_pa_draft_quote_receipts receipt WHERE receipt.request_id=r.id)
      AND ${reviewedCatalogGuard} AND ${assignmentGuard.sql} AND ${authorityGuard.sql}`)
    .bind(revisionId, session.identityId, mutationKey, fingerprint,
      session.accountId, session.identityId, requestId, reviewedCatalogVersions(services),
      ...assignmentGuard.bindings, ...authorityGuard.bindings);
  const statements = [
    revision,
    database.prepare(`UPDATE client_service_requests SET status='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}'
        AND status IN ('submitted','under_review','accepted_pending_pa_linkage')
        AND EXISTS (SELECT 1 FROM request_revisions WHERE id=? AND request_id=client_service_requests.id)`)
      .bind(requestId, revisionId),
    database.prepare(`INSERT INTO client_portal_notification_outbox
      (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
      SELECT ?,r.id,'request_status_changed','cancelled','staff_triage',
        'request_status_changed:cancelled:staff_triage',json_object('title',r.title,'projectId',r.project_id,
          'previousStatus',json_extract(revision.snapshot_json,'$.previousStatus'))
      FROM client_service_requests r
      JOIN request_revisions revision ON revision.id=? AND revision.request_id=r.id
      WHERE r.id=? AND r.status='cancelled'`)
      .bind(crypto.randomUUID(), revisionId, requestId),
    database.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
      SELECT 'client',?,'client.service_request.cancelled','client_service_request',r.id,
        json_object('accountId',?,'projectId',r.project_id,
          'previousStatus',json_extract(revision.snapshot_json,'$.previousStatus'),'catalogSourceId',r.catalog_source_id)
      FROM client_service_requests r
      JOIN request_revisions revision ON revision.id=? AND revision.request_id=r.id
      WHERE r.id=? AND r.status='cancelled'`)
      .bind(session.identityId, session.accountId, revisionId, requestId),
  ];
  try {
    const results = await database.batch(statements);
    if (!results[0]?.meta.changes) {
      const racedPaDraft = await cancellationPaDraftConflict(env, requestId);
      if (racedPaDraft) return { kind: "conflict", reason: racedPaDraft };
      const catalogConflict = await changedCatalogServices(env, services);
      if (catalogConflict.length) return { kind: "conflict", reason: "catalog_changed" };
      const assignmentConflict = await currentAssignmentConflict(env, policy.proof, services);
      if (assignmentConflict) return { kind: "conflict", reason: "service_assignments_changed" };
      const currentAuthority = await resolveRequestAuthority(env, session, target.project_id);
      if (currentAuthority.kind === "unavailable") return null;
      const current = await loadCancellationTarget(env, session, requestId);
      return current ? { kind: "conflict", reason: "status_not_cancellable" } : null;
    }
  } catch {
    const raced = await loadCancellationReplay(env, session, requestId, mutationKey);
    if (!raced || !isCancellationReplay(raced, fingerprint))
      return raced ? { kind: "conflict", reason: "idempotency_key_reused" } : null;
    const replay = await loadSubmittedRequest(env, session, requestId);
    return replay?.status === "cancelled" ? { kind: "replayed", request: replay } : null;
  }
  const request = await loadSubmittedRequest(env, session, requestId);
  return request?.status === "cancelled" ? { kind: "cancelled", request } : null;
}

export async function submitServiceRequestDraft(env: Env, session: ClientPortalSession, draftId: string, expectedVersion: number, mutationKey: string): Promise<ClientServiceDraftSubmitResult | null> {
  const draft = await loadDraft(env, session, draftId);
  if (!draft) return null;
  const fingerprint = await sha256(JSON.stringify({ draftId, version: expectedVersion }));
  if (draft.state === "submitted") {
    const metadata = await db(env).prepare(`SELECT submit_idempotency_key,submit_fingerprint,submitted_request_id FROM client_service_request_drafts WHERE id=? AND catalog_source_id=?`).bind(draftId, PRIMARY_ALPHA_SOURCE_ID).first<{ submit_idempotency_key: string; submit_fingerprint: string; submitted_request_id: string }>();
    if (!metadata || metadata.submit_idempotency_key !== mutationKey || metadata.submit_fingerprint !== fingerprint) return { kind: "conflict" };
    const request = await loadSubmittedRequest(env, session, metadata.submitted_request_id);
    return request ? { kind: "replayed", request } : null;
  }
  if (draft.version !== expectedVersion) return { kind: "conflict" };
  if (!draft.title.trim() || !draft.details.trim())
    return { kind: "incomplete", reason: "request_fields_incomplete" };
  if (!draft.services.length)
    return { kind: "incomplete", reason: "answers_incomplete", servicePublicIds: [] };
  const incompleteAnswers = incompleteAnswerServices(draft);
  if (incompleteAnswers.length)
    return { kind: "incomplete", reason: "answers_incomplete", servicePublicIds: incompleteAnswers };
  const missingGeometry = draft.services
    .filter(service => service.geometryRequirement === "required" && draft.areaGeoJson === null)
    .map(service => service.publicId);
  if (missingGeometry.length)
    return { kind: "incomplete", reason: "geometry_required", servicePublicIds: missingGeometry };
  const changedServices = await changedCatalogServices(env, draft.services);
  if (changedServices.length)
    return { kind: "incomplete", reason: "catalog_changed", servicePublicIds: changedServices };
  const policy = await resolveRequestPolicy(env, session, draft.projectId, draft.services);
  if (policy.kind === "service_assignments_changed")
    return { kind: "incomplete", reason: "service_assignments_changed", servicePublicIds: policy.servicePublicIds };
  const authority = await resolveRequestAuthority(env, session, draft.projectId);
  if (authority.kind === "unavailable") return { kind: "conflict" };
  const attachmentBlock = await attachmentSubmissionBlock(env, draftId);
  if (attachmentBlock) return { kind: "incomplete", ...attachmentBlock };
  const requestId = crypto.randomUUID();
  const serviceCategory = draft.services.length === 1 ? draft.services[0]!.name.slice(0, 100) : `Multiple services (${draft.services.length})`;
  const requestFingerprint = await sha256(JSON.stringify(draft));
  const database = db(env);
  const assignmentGuard = reviewedServiceAssignmentGuard(policy.proof, draft.services);
  const authorityGuard = reviewedRequestAuthorityGuard(authority.proof);
  const insert = database.prepare(`INSERT INTO client_service_requests
    (id,account_id,project_id,parent_request_id,created_by_identity_id,request_type,title,details,location_text,preferred_start_at,service_category,deliverables_text,site_contact_name,site_contact_email,site_contact_phone,desired_completion_at,latitude,longitude,area_geojson,poi_points_json,idempotency_key,request_fingerprint,catalog_source_id,service_assignment_policy_v2_json)
    SELECT ?,d.account_id,d.project_id,NULL,d.created_by_identity_id,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,d.catalog_source_id,?
    FROM client_service_request_drafts d
    JOIN client_accounts a ON a.id=d.account_id AND a.status='active'
      AND (a.project_alpha_source_id IS NULL OR a.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
    JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
    JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
    WHERE d.id=? AND d.account_id=? AND d.state='draft' AND d.version=? AND d.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}'
      AND ((d.project_id IS NULL AND (m.role='manager' OR d.created_by_identity_id=i.id)) OR EXISTS (
        SELECT 1 FROM client_project_grants g JOIN projects p ON p.id=g.project_id AND p.active=1
          AND (p.project_alpha_source_id IS NULL OR p.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
        WHERE g.account_id=a.id AND g.project_id=d.project_id AND g.revoked_at IS NULL AND g.can_request_service=1
          AND (m.role='manager' OR EXISTS (SELECT 1 FROM client_member_project_grants mg WHERE mg.account_id=a.id AND mg.identity_id=i.id AND mg.project_id=g.project_id AND mg.revoked_at IS NULL))
      )) AND ${reviewedCatalogGuard} AND ${assignmentGuard.sql} AND ${authorityGuard.sql}`)
    .bind(requestId, draft.requestType, draft.title, draft.details, draft.location, draft.preferredStartAt, serviceCategory, draft.deliverables, draft.siteContactName, draft.siteContactEmail, draft.siteContactPhone, draft.desiredCompletionAt, draft.latitude, draft.longitude, draft.areaGeoJson ? JSON.stringify(draft.areaGeoJson) : null, draft.poiPoints.length ? JSON.stringify(draft.poiPoints) : null, mutationKey, requestFingerprint,
      serializeServiceAssignmentPolicyProof(policy.proof),session.identityId, draftId, session.accountId, expectedVersion,
      reviewedCatalogVersions(draft.services),...assignmentGuard.bindings,...authorityGuard.bindings);
  const snapshot = JSON.stringify({ ...draft, status: "submitted" });
  const statements = [
    insert,
    ...draft.services.map((service, ordinal) => database.prepare(`INSERT INTO client_service_request_services(request_id,ordinal,service_public_id,service_source_version,service_snapshot_json,answers_json,service_source_id)
      SELECT ?,?,?,?,?,?,'${PRIMARY_ALPHA_SOURCE_ID}' WHERE EXISTS (SELECT 1 FROM client_service_requests WHERE id=? AND catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}')`).bind(requestId, ordinal, service.publicId, service.sourceVersion, serviceSnapshot(service), JSON.stringify(service.answers), requestId)),
    database.prepare(`INSERT INTO request_revisions(id,request_id,revision_number,author_type,author_id,action,snapshot_json)
      SELECT ?,?,1,'client',?,'submitted',? WHERE EXISTS (SELECT 1 FROM client_service_requests WHERE id=?)`).bind(crypto.randomUUID(), requestId, session.identityId, snapshot, requestId),
    database.prepare(`INSERT INTO client_portal_notification_outbox(id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
      SELECT ?,?,'request_submitted','submitted','staff_triage','request_submitted:submitted:staff_triage',json_object('title',?,'projectId',?,'serviceCount',?,'areaSquareMeters',?) WHERE EXISTS (SELECT 1 FROM client_service_requests WHERE id=?)`).bind(crypto.randomUUID(), requestId, draft.title, draft.projectId, draft.services.length, draft.areaSquareMeters, requestId),
    database.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
      SELECT 'client',?,'client.service_request.submitted','client_service_request',?,json_object('accountId',?,'draftId',?,'serviceCount',?) WHERE EXISTS (SELECT 1 FROM client_service_requests WHERE id=?)`).bind(session.identityId, requestId, session.accountId, draftId, draft.services.length, requestId),
    database.prepare(`UPDATE client_service_request_drafts SET state='submitted',submitted_request_id=?,submit_idempotency_key=?,submit_fingerprint=?,service_assignment_policy_v2_json=?,submitted_at=datetime('now'),updated_at=datetime('now'),last_mutation_key=? WHERE id=? AND state='draft' AND version=? AND catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}' AND EXISTS (SELECT 1 FROM client_service_requests WHERE id=? AND catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}')`).bind(requestId, mutationKey, fingerprint, serializeServiceAssignmentPolicyProof(policy.proof),mutationKey, draftId, expectedVersion, requestId),
  ];
  try {
    const results = await database.batch(statements);
    if (!results[0]?.meta.changes) {
      const changed = await changedCatalogServices(env, draft.services);
      if (changed.length) return { kind: "incomplete", reason: "catalog_changed", servicePublicIds: changed };
      const assigned = await currentAssignmentConflict(env, policy.proof, draft.services);
      return assigned
        ? { kind: "incomplete", reason: "service_assignments_changed", servicePublicIds: assigned }
        : { kind: "conflict" };
    }
  } catch { return { kind: "conflict" }; }
  const request = await loadSubmittedRequest(env, session, requestId);
  return request ? { kind: "submitted", request } : null;
}
