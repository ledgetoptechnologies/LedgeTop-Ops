import { createCatalogSourceContext } from "@ltds/shared";
import type { Env } from "../types";
import { portalSourceReadableSql } from "../project-alpha-portal-authority";
import type { ClientPortalSession } from "./types";

export const SERVICE_ASSIGNMENT_REQUEST_POLICY_FLAG = "CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED";
export class ServiceAssignmentPolicyUnavailableError extends Error {
  constructor() { super("service-assignment-policy-unavailable"); }
}

export type ServiceAssignmentPolicySubjectType = "organization" | "standalone_client" | "project";

export interface ServiceAssignmentPolicyProof {
  version: 2;
  sourceId: string;
  reviewId: string;
  reviewRevision: number;
  workspaceId: string;
  localProjectId: string | null;
  subjectType: ServiceAssignmentPolicySubjectType;
  subjectPublicId: string;
  generationId: string;
  sourceGeneration: string;
  sourceSequence: number;
  directoryGenerationId: string;
  directorySourceSequence: number;
  evaluatedAt: string;
  expiresAt: string;
}

export type ServiceAssignmentPolicyDecision =
  | { state: "disabled"; proof: null; assignedServiceCount: null }
  | { state: "ready" | "no_services_assigned"; proof: ServiceAssignmentPolicyProof; assignedServiceCount: number }
  | { state: "unavailable"; proof: null; assignedServiceCount: null };

interface TargetRow {
  source_id: string;
  subject_type: ServiceAssignmentPolicySubjectType;
  subject_public_id: string;
  directory_generation_id: string;
  directory_source_sequence: number;
  local_project_id: string | null;
}

interface CheckpointRow {
  active_generation_id: string;
  source_generation: string;
  source_sequence: number;
  review_id: string;
  review_revision: number;
}

function database(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return typeof candidate.withSession === "function" ? candidate.withSession("first-primary") : env.DELIVERY_DB;
}

export function serviceAssignmentRequestPolicyEnabled(env: Env): boolean {
  return env.CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED === "true";
}

function serviceAssignmentRequestPolicyPrerequisitesReady(env: Env): boolean {
  return env.CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED === "true"
    && env.PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED === "true"
    && env.CLIENT_PORTAL_REQUEST_V2_ENABLED === "true"
    && env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED === "true"
    && env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true";
}

function unavailableSchema(error: unknown): boolean {
  return /no such (?:table|column):\s*(?:main\.)?(?:pa_service_assignment_|pa_portal_source_authorit|portal_v2_workspaces|pa_portal_workspace_sources|projects|service_assignment_policy_v2_json)/i
    .test(error instanceof Error ? error.message : String(error));
}

async function exactTarget(env: Env, session: ClientPortalSession, projectId: string | null): Promise<TargetRow | null> {
  if (!session.workspaceId) return null;
  const db = database(env);
  if (projectId) {
    return db.prepare(`WITH RECURSIVE context AS (
        SELECT workspace.id workspace_id,workspace.project_alpha_source_id source_id,
          workspace.root_type,CASE workspace.root_type WHEN 'organization' THEN workspace.pa_organization_public_id
            ELSE workspace.pa_client_public_id END root_public_id,
          generation.id generation_id,generation.source_sequence
        FROM portal_v2_workspaces workspace
        JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id
          AND owner.projection_source_id=workspace.project_alpha_source_id
        JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
        JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
          AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
          AND generation.status='active' AND generation.complete=1
        WHERE workspace.id=? AND workspace.status='active'
          AND ${portalSourceReadableSql("workspace.project_alpha_source_id")}
      ), lineage(entity_type,public_id,depth) AS (
        SELECT entity.entity_type,entity.public_id,0
        FROM context JOIN portal_v2_directory_entities entity
          ON entity.workspace_id=context.workspace_id AND entity.generation_id=context.generation_id
        JOIN projects project ON project.id=? AND project.active=1
          AND project.project_alpha_source_id=context.source_id AND project.project_alpha_project_id=entity.public_id
        WHERE entity.entity_type='project' AND entity.active=1
        UNION ALL
        SELECT parent.entity_type,parent.public_id,lineage.depth+1
        FROM lineage JOIN context
        JOIN portal_v2_directory_relations relation ON relation.workspace_id=context.workspace_id
          AND relation.generation_id=context.generation_id AND relation.active=1
          AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
        JOIN portal_v2_directory_entities parent ON parent.workspace_id=context.workspace_id
          AND parent.generation_id=context.generation_id AND parent.entity_type=relation.from_type
          AND parent.public_id=relation.from_public_id AND parent.active=1
        WHERE lineage.depth<12
      ) SELECT context.source_id,'project' subject_type,project.project_alpha_project_id subject_public_id,
        context.generation_id directory_generation_id,context.source_sequence directory_source_sequence,
        project.id local_project_id
      FROM context JOIN projects project ON project.id=? AND project.active=1
        AND project.project_alpha_source_id=context.source_id
        AND project.project_alpha_project_id IS NOT NULL
      WHERE EXISTS(SELECT 1 FROM lineage GROUP BY 1
        HAVING COUNT(*)<=64 AND MAX(depth)<12
          AND MAX(CASE WHEN entity_type=context.root_type AND public_id=context.root_public_id THEN 1 ELSE 0 END)=1)`)
      .bind(session.workspaceId, projectId, projectId).first<TargetRow>();
  }
  return db.prepare(`SELECT workspace.project_alpha_source_id source_id,workspace.root_type subject_type,
      CASE workspace.root_type WHEN 'organization' THEN workspace.pa_organization_public_id
        ELSE workspace.pa_client_public_id END subject_public_id,
      generation.id directory_generation_id,generation.source_sequence directory_source_sequence
      ,NULL local_project_id
    FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id
      AND owner.projection_source_id=workspace.project_alpha_source_id
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities entity ON entity.workspace_id=workspace.id AND entity.generation_id=generation.id
      AND entity.entity_type=workspace.root_type AND entity.public_id=CASE workspace.root_type
        WHEN 'organization' THEN workspace.pa_organization_public_id ELSE workspace.pa_client_public_id END AND entity.active=1
    WHERE workspace.id=? AND workspace.status='active'
      AND ${portalSourceReadableSql("workspace.project_alpha_source_id")}
      AND workspace.root_type IN ('organization','standalone_client')
      AND CASE workspace.root_type WHEN 'organization' THEN workspace.pa_organization_public_id
        ELSE workspace.pa_client_public_id END IS NOT NULL`)
    .bind(session.workspaceId).first<TargetRow>();
}

async function activeCheckpoint(env: Env, workspaceId: string, sourceId: string): Promise<CheckpointRow | null> {
  return database(env).prepare(`SELECT checkpoint.active_generation_id,checkpoint.source_generation,checkpoint.source_sequence,
      review.review_id,review.revision review_revision
    FROM pa_service_assignment_checkpoints checkpoint
    JOIN pa_service_assignment_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.source_id=checkpoint.source_id AND generation.status='active' AND generation.complete=1
      AND generation.source_generation=checkpoint.source_generation AND generation.source_sequence<=checkpoint.source_sequence
    JOIN pa_service_assignment_receiver_grants receiver ON receiver.source_id=checkpoint.source_id
      AND receiver.capability='portal.service-assignments.publish' AND receiver.contract_version=1 AND receiver.state='active'
    JOIN pa_service_assignment_receiver_workspaces enrollment ON enrollment.source_id=checkpoint.source_id
      AND enrollment.workspace_id=? AND enrollment.state='active'
    JOIN pa_service_assignment_request_policy_reviews review ON review.source_id=checkpoint.source_id
      AND review.revision=(SELECT MAX(latest.revision) FROM pa_service_assignment_request_policy_reviews latest
        WHERE latest.source_id=checkpoint.source_id)
      AND review.state='enabled'
    JOIN pa_portal_workspace_sources owner ON owner.workspace_id=enrollment.workspace_id
      AND owner.projection_source_id=checkpoint.source_id
    WHERE checkpoint.source_id=? AND ${portalSourceReadableSql("checkpoint.source_id")}`)
    .bind(workspaceId, sourceId).first<CheckpointRow>();
}

export function serviceAssignmentPolicyServiceSql(
  proof: ServiceAssignmentPolicyProof,
  catalogAlias = "catalog",
  currentTime = false,
): { sql: string; bindings: Array<string | number | null> } {
  return {
    sql: `EXISTS (SELECT 1 FROM pa_service_assignments assignment
      WHERE assignment.source_id=${catalogAlias}.source_id
        AND assignment.subject_type=? AND assignment.subject_public_id=?
        AND assignment.service_public_id=${catalogAlias}.public_id
        AND assignment.service_source_version=${catalogAlias}.source_version
        AND assignment.active=1 AND assignment.source_generation=? AND assignment.source_sequence<=?
        AND (assignment.effective_from IS NULL OR datetime(assignment.effective_from)<=datetime(${currentTime ? "'now'" : "?"}))
        AND (assignment.effective_until IS NULL OR datetime(assignment.effective_until)>datetime(${currentTime ? "'now'" : "?"})))`,
    bindings: [proof.subjectType, proof.subjectPublicId, proof.sourceGeneration, proof.sourceSequence,
      ...(currentTime ? [] : [proof.evaluatedAt, proof.evaluatedAt])],
  };
}

export function serviceAssignmentPolicyCheckpointSql(
  proof: ServiceAssignmentPolicyProof,
): { sql: string; bindings: Array<string | number | null> } {
  return {
    sql: `EXISTS (SELECT 1 FROM pa_service_assignment_checkpoints checkpoint
      JOIN pa_service_assignment_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.source_id=checkpoint.source_id AND generation.status='active' AND generation.complete=1
        AND generation.source_generation=checkpoint.source_generation
        AND generation.source_sequence<=checkpoint.source_sequence
      JOIN pa_service_assignment_receiver_grants receiver ON receiver.source_id=checkpoint.source_id
        AND receiver.capability='portal.service-assignments.publish' AND receiver.contract_version=1 AND receiver.state='active'
      JOIN pa_service_assignment_receiver_workspaces enrollment ON enrollment.source_id=checkpoint.source_id
        AND enrollment.workspace_id=? AND enrollment.state='active'
      JOIN pa_service_assignment_request_policy_reviews review ON review.source_id=checkpoint.source_id
        AND review.review_id=? AND review.revision=?
        AND review.revision=(SELECT MAX(latest.revision) FROM pa_service_assignment_request_policy_reviews latest
          WHERE latest.source_id=checkpoint.source_id)
        AND review.state='enabled'
      JOIN pa_portal_workspace_sources owner ON owner.workspace_id=enrollment.workspace_id
        AND owner.projection_source_id=checkpoint.source_id
      JOIN portal_v2_directory_checkpoints directory_checkpoint ON directory_checkpoint.workspace_id=enrollment.workspace_id
        AND directory_checkpoint.active_generation_id=? AND directory_checkpoint.source_sequence=?
      JOIN portal_v2_directory_generations directory_generation ON directory_generation.id=directory_checkpoint.active_generation_id
        AND directory_generation.workspace_id=directory_checkpoint.workspace_id
        AND directory_generation.status='active' AND directory_generation.complete=1
      JOIN portal_v2_directory_entities target ON target.workspace_id=directory_checkpoint.workspace_id
        AND target.generation_id=directory_checkpoint.active_generation_id
        AND target.entity_type=? AND target.public_id=? AND target.active=1
      JOIN portal_v2_workspaces workspace ON workspace.id=enrollment.workspace_id
        AND workspace.status='active' AND workspace.project_alpha_source_id=checkpoint.source_id
      WHERE checkpoint.source_id=? AND ${portalSourceReadableSql("checkpoint.source_id")}
        AND checkpoint.active_generation_id=?
        AND checkpoint.source_generation=? AND checkpoint.source_sequence=?
        AND (
          (target.entity_type IN ('organization','standalone_client')
            AND target.entity_type=workspace.root_type
            AND target.public_id=CASE workspace.root_type WHEN 'organization' THEN workspace.pa_organization_public_id
              ELSE workspace.pa_client_public_id END)
          OR (target.entity_type='project' AND EXISTS(
            WITH RECURSIVE lineage(entity_type,public_id,depth) AS (
              SELECT target.entity_type,target.public_id,0
              UNION
              SELECT parent.entity_type,parent.public_id,lineage.depth+1
              FROM lineage
              JOIN portal_v2_directory_relations relation ON relation.workspace_id=directory_checkpoint.workspace_id
                AND relation.generation_id=directory_checkpoint.active_generation_id AND relation.active=1
                AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
              JOIN portal_v2_directory_entities parent ON parent.workspace_id=relation.workspace_id
                AND parent.generation_id=relation.generation_id AND parent.entity_type=relation.from_type
                AND parent.public_id=relation.from_public_id AND parent.active=1
              WHERE lineage.depth<12
            ) SELECT 1 FROM lineage GROUP BY 1 HAVING COUNT(*)<=64 AND MAX(depth)<12
              AND MAX(CASE WHEN entity_type=workspace.root_type AND public_id=CASE workspace.root_type
                WHEN 'organization' THEN workspace.pa_organization_public_id ELSE workspace.pa_client_public_id END THEN 1 ELSE 0 END)=1
          ))
        ) AND (? IS NULL OR EXISTS(SELECT 1 FROM projects project WHERE project.id=? AND project.active=1
          AND project.project_alpha_source_id=checkpoint.source_id AND project.project_alpha_project_id=target.public_id)))`,
    bindings: [proof.workspaceId, proof.reviewId, proof.reviewRevision,
      proof.directoryGenerationId, proof.directorySourceSequence,
      proof.subjectType, proof.subjectPublicId, proof.sourceId, proof.generationId, proof.sourceGeneration, proof.sourceSequence,
      proof.localProjectId, proof.localProjectId],
  };
}

export function serializeServiceAssignmentPolicyProof(proof: ServiceAssignmentPolicyProof | null): string | null {
  if (!proof) return null;
  return JSON.stringify({
    version: proof.version,
    sourceId: proof.sourceId,
    reviewId: proof.reviewId,
    reviewRevision: proof.reviewRevision,
    workspaceId: proof.workspaceId,
    localProjectId: proof.localProjectId,
    subjectType: proof.subjectType,
    subjectPublicId: proof.subjectPublicId,
    generationId: proof.generationId,
    sourceGeneration: proof.sourceGeneration,
    sourceSequence: proof.sourceSequence,
    directoryGenerationId: proof.directoryGenerationId,
    directorySourceSequence: proof.directorySourceSequence,
    evaluatedAt: proof.evaluatedAt,
    expiresAt: proof.expiresAt,
  });
}

function wellFormedProof(proof: ServiceAssignmentPolicyProof): boolean {
  const evaluatedAt = Date.parse(proof.evaluatedAt);
  const expiresAt = Date.parse(proof.expiresAt);
  let sourceId: string;
  try { sourceId = createCatalogSourceContext(proof.sourceId).sourceId; }
  catch { return false; }
  return proof.version === 2
    && proof.sourceId === sourceId
    && typeof proof.reviewId === "string"
    && proof.reviewId.length >= 1 && proof.reviewId.length <= 128
    && Number.isSafeInteger(proof.reviewRevision) && proof.reviewRevision >= 1
    && proof.workspaceId.length >= 1 && proof.workspaceId.length <= 128
    && proof.subjectPublicId.length >= 1 && proof.subjectPublicId.length <= 128
    && proof.generationId.length >= 1 && proof.generationId.length <= 128
    && proof.sourceGeneration.length >= 1 && proof.sourceGeneration.length <= 128
    && proof.directoryGenerationId.length >= 1 && proof.directoryGenerationId.length <= 128
    && Number.isSafeInteger(proof.sourceSequence) && proof.sourceSequence >= 1
    && Number.isSafeInteger(proof.directorySourceSequence) && proof.directorySourceSequence >= 1
    && (proof.subjectType === "project"
      ? typeof proof.localProjectId === "string" && proof.localProjectId.length >= 1 && proof.localProjectId.length <= 128
      : (proof.subjectType === "organization" || proof.subjectType === "standalone_client")
        && proof.localProjectId === null)
    && Number.isFinite(evaluatedAt) && Number.isFinite(expiresAt)
    && expiresAt > evaluatedAt && expiresAt <= evaluatedAt + 5 * 60_000;
}

/**
 * Reads service availability only after the caller has established request
 * authority. Assignments narrow choices; they never create that authority.
 * Parent/child assignments are deliberately ignored: only the selected root or
 * exact selected project can match.
 */
export async function readServiceAssignmentPolicy(
  env: Env,
  session: ClientPortalSession,
  projectId: string | null,
  window?: { evaluatedAt: string; expiresAt: string },
): Promise<ServiceAssignmentPolicyDecision> {
  if (!serviceAssignmentRequestPolicyEnabled(env)) return { state: "disabled", proof: null, assignedServiceCount: null };
  if (!serviceAssignmentRequestPolicyPrerequisitesReady(env)) return { state: "unavailable", proof: null, assignedServiceCount: null };
  try {
    const target = await exactTarget(env, session, projectId);
    if (!target || !target.source_id || !target.subject_public_id) {
      return { state: "unavailable", proof: null, assignedServiceCount: null };
    }
    let sourceId: string;
    try { sourceId = createCatalogSourceContext(target.source_id).sourceId; }
    catch { return { state: "unavailable", proof: null, assignedServiceCount: null }; }
    const checkpoint = await activeCheckpoint(env, session.workspaceId!, sourceId);
    if (!checkpoint) return { state: "unavailable", proof: null, assignedServiceCount: null };
    const now = Date.now();
    const evaluatedAt = window?.evaluatedAt ?? new Date(now).toISOString();
    const requestedExpiresAt = window?.expiresAt ?? new Date(now + 5 * 60_000).toISOString();
    const evaluatedAtMs = Date.parse(evaluatedAt);
    const requestedExpiresAtMs = Date.parse(requestedExpiresAt);
    if (!Number.isFinite(evaluatedAtMs) || !Number.isFinite(requestedExpiresAtMs)
      || evaluatedAtMs > now || requestedExpiresAtMs <= evaluatedAtMs
      || now >= requestedExpiresAtMs || requestedExpiresAtMs > evaluatedAtMs + 5 * 60_000)
      return { state: "unavailable", proof: null, assignedServiceCount: null };
    const boundary = await database(env).prepare(`SELECT MIN(boundary) boundary FROM (
        SELECT effective_from boundary FROM pa_service_assignments WHERE source_id=? AND subject_type=?
          AND subject_public_id=? AND source_generation=? AND source_sequence<=? AND effective_from IS NOT NULL
          AND datetime(effective_from)>datetime(?)
        UNION ALL
        SELECT effective_until boundary FROM pa_service_assignments WHERE source_id=? AND subject_type=?
          AND subject_public_id=? AND source_generation=? AND source_sequence<=? AND effective_until IS NOT NULL
          AND datetime(effective_until)>datetime(?)
      )`).bind(sourceId,target.subject_type,target.subject_public_id,checkpoint.source_generation,
        checkpoint.source_sequence,evaluatedAt,sourceId,target.subject_type,target.subject_public_id,
        checkpoint.source_generation,checkpoint.source_sequence,evaluatedAt).first<string>("boundary");
    const calculatedExpiry = Math.min(evaluatedAtMs + 5 * 60_000,
      boundary && Number.isFinite(Date.parse(boundary)) ? Date.parse(boundary) : Number.POSITIVE_INFINITY);
    const expiresAt = window?.expiresAt ?? new Date(calculatedExpiry).toISOString();
    if (Date.parse(expiresAt) > calculatedExpiry) return { state: "unavailable", proof: null, assignedServiceCount: null };
    const proof: ServiceAssignmentPolicyProof = {
      version: 2,
      sourceId,
      reviewId: checkpoint.review_id,
      reviewRevision: checkpoint.review_revision,
      workspaceId: session.workspaceId!,
      localProjectId: target.local_project_id,
      subjectType: target.subject_type,
      subjectPublicId: target.subject_public_id,
      generationId: checkpoint.active_generation_id,
      sourceGeneration: checkpoint.source_generation,
      sourceSequence: checkpoint.source_sequence,
      directoryGenerationId: target.directory_generation_id,
      directorySourceSequence: target.directory_source_sequence,
      evaluatedAt,
      expiresAt,
    };
    const service = serviceAssignmentPolicyServiceSql(proof);
    const checkpointGuard = serviceAssignmentPolicyCheckpointSql(proof);
    const row = await database(env).prepare(`SELECT COUNT(DISTINCT catalog.public_id) count
      FROM pa_service_catalog_items catalog
      WHERE catalog.source_id=? AND catalog.active=1 AND ${service.sql} AND ${checkpointGuard.sql}`)
      .bind(sourceId, ...service.bindings, ...checkpointGuard.bindings).first<{ count: number }>();
    if (!row || !Number.isSafeInteger(Number(row.count))) return { state: "unavailable", proof: null, assignedServiceCount: null };
    const count = Number(row.count);
    if (!await serviceAssignmentPolicyProofStillCurrent(env, proof)) {
      return { state: "unavailable", proof: null, assignedServiceCount: null };
    }
    return { state: count > 0 ? "ready" : "no_services_assigned", proof, assignedServiceCount: count };
  } catch (error) {
    if (unavailableSchema(error)) return { state: "unavailable", proof: null, assignedServiceCount: null };
    throw error;
  }
}

export async function serviceAssignmentPolicyProofStillCurrent(
  env: Env,
  proof: ServiceAssignmentPolicyProof,
): Promise<boolean> {
  if (!serviceAssignmentRequestPolicyPrerequisitesReady(env) || !wellFormedProof(proof)
    || Date.now() >= Date.parse(proof.expiresAt)) return false;
  const guard = serviceAssignmentPolicyCheckpointSql(proof);
  try {
    return await database(env).prepare(`SELECT 1 current WHERE ${guard.sql}`).bind(...guard.bindings).first<number>("current") === 1;
  } catch (error) {
    if (unavailableSchema(error)) return false;
    throw error;
  }
}

export async function changedAssignedServices(
  env: Env,
  proof: ServiceAssignmentPolicyProof | null,
  services: ReadonlyArray<{ publicId: string; sourceVersion: string }>,
): Promise<string[]> {
  if (!proof) return serviceAssignmentRequestPolicyEnabled(env) ? services.map(service => service.publicId) : [];
  if (!await serviceAssignmentPolicyProofStillCurrent(env, proof)) return services.map(service => service.publicId);
  const changed: string[] = [];
  const serviceGuard = serviceAssignmentPolicyServiceSql(proof, "catalog");
  for (const service of services) {
    const row = await database(env).prepare(`SELECT 1 available FROM pa_service_catalog_items catalog
      WHERE catalog.source_id=? AND catalog.public_id=? AND catalog.source_version=? AND catalog.active=1
        AND ${serviceGuard.sql}`)
      .bind(proof.sourceId, service.publicId, service.sourceVersion, ...serviceGuard.bindings).first<number>("available");
    if (row !== 1) changed.push(service.publicId);
  }
  return changed;
}
