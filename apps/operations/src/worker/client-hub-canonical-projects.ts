import type { ClientHubCollectionContext } from "./client-hub-collections";
import { clientHubActiveDirectoryIdentities, clientHubActiveDirectoryIdentitySql,
  hasClientHubActiveDirectoryMappings } from "./client-hub-source";
import { clientHubBusinessProjectOwnership } from "./client-hub-business-projects";
import type { ClientHubBusinessProjectPolicy } from "./client-hub-project-policy";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import type { Env } from "./types";

export interface CanonicalBusinessProjectRow extends Record<string, unknown> {
  id: string;
  origin: "canonical";
  external_project_id: string;
  name: string;
  status: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: null;
  manager_user_id: null;
  manager_name: null;
  overdue_warning: number;
  __created: string;
  __sort_id: string;
  __origin: "canonical";
}

/**
 * Exact, read-only canonical projection proof. Inventory observations are not
 * the source of display data: the activated head, unique project mapping,
 * immutable v2 revision, current directory root, and conflict-free evidence
 * must all agree. An observation is optional, but if present it must agree.
 */
export async function canonicalBusinessProjectPredicate(env: Env, context: ClientHubCollectionContext,
  policy: ClientHubBusinessProjectPolicy,
): Promise<{ sql: string; values: unknown[] } | null> {
  if (!await hasClientHubActiveDirectoryMappings(env.OPS_DB)) return null;
  const relations = await env.OPS_DB.prepare(`SELECT name,type FROM sqlite_master WHERE name IN (
    'operations_shared_projects','operations_shared_project_revisions','project_alpha_project_mappings',
    'project_alpha_project_v2_canonical_activation_receipts','project_alpha_api_v2_inventory_conflicts',
    'project_alpha_api_v2_project_observations_current')`).all<{ name: string; type: string }>();
  if (relations.results.length !== 6) return null;
  const root = context.root;
  if (!root.pa_internal_id || !root.pa_public_id || !root.public_id) return null;
  const activeIdentities = await clientHubActiveDirectoryIdentities(env);
  const currentRootIdentity = clientHubActiveDirectoryIdentitySql("current_root_mapping", activeIdentities ?? []);
  const owner = clientHubBusinessProjectOwnership(context);
  const rootOwner = root.kind === "organization"
    ? `(s.organization_record_id=? OR (s.organization_record_id IS NULL AND s.client_record_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM operations_directory_client_organizations relation
        JOIN operations_directory_records client_record ON client_record.record_id=relation.client_record_id
          AND client_record.record_kind='client'
        WHERE relation.client_record_id=s.client_record_id AND relation.organization_record_id=?)))`
    : `(s.organization_record_id IS NULL AND s.client_record_id=? AND EXISTS (
        SELECT 1 FROM operations_directory_client_organizations relation
        WHERE relation.client_record_id=s.client_record_id AND relation.organization_record_id IS NULL))`;
  const rootValues = root.kind === "organization" ? [root.public_id, root.public_id] : [root.public_id];
  const exactRevision = `json_valid(revision.read_json)
    AND json_extract(revision.read_json,'$.apiVersion')='2'
    AND json_extract(revision.read_json,'$.sourceInstanceId')=s.source_instance_id
    AND json_extract(revision.read_json,'$.applicationId')=s.application_id
    AND json_extract(revision.read_json,'$.historyEpoch')=s.history_epoch_id
    AND json_extract(revision.read_json,'$.resource.type')='project'
    AND json_extract(revision.read_json,'$.resource.id')=s.project_alpha_public_id
    AND json_extract(revision.read_json,'$.resource.revision')=s.pa_revision
    AND json_extract(revision.read_json,'$.resource.projectionSha256')=s.canonical_projection_sha256
    AND json_extract(revision.read_json,'$.data.name')=s.name
    AND json_extract(revision.read_json,'$.data.status')=s.lifecycle
    AND json_extract(revision.read_json,'$.data.description') IS s.description
    AND json_extract(revision.read_json,'$.data.estimatedStart') IS s.planned_start
    AND json_extract(revision.read_json,'$.data.estimatedEnd') IS s.planned_end
    AND json_extract(revision.read_json,'$.data.overdueWarning')=(s.overdue_warning=1)
    AND json_extract(revision.read_json,'$.data.archived')=(s.archived=1)
    AND json_extract(revision.read_json,'$.data.completedAt') IS s.completed_at
    AND json_extract(revision.read_json,'$.data.archivedAt') IS s.archived_at
    AND (s.organization_record_id IS NULL OR s.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations project_relationship
      WHERE project_relationship.client_record_id=s.client_record_id
        AND project_relationship.organization_record_id=s.organization_record_id))`;
  const noConflicts = `NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
    WHERE conflict.source_id=s.source_id AND conflict.source_instance_id=s.source_instance_id
      AND conflict.application_id=s.application_id AND conflict.history_epoch_id=s.history_epoch_id
      AND conflict.inventory_kind='project'
      AND (conflict.project_alpha_public_id=s.project_alpha_public_id OR conflict.external_id=s.external_project_id))`;
  const observations = `NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_project_observations_current observation
    WHERE observation.source_id=s.source_id AND observation.source_instance_id=s.source_instance_id
      AND observation.application_id=s.application_id AND observation.history_epoch_id=s.history_epoch_id
      AND (observation.project_alpha_public_id=s.project_alpha_public_id OR observation.external_project_id=s.external_project_id)
      AND (observation.has_conflict<>0 OR observation.external_project_id<>s.external_project_id
        OR observation.project_alpha_public_id<>s.project_alpha_public_id
        OR observation.resource_revision<>s.pa_revision
        OR observation.projection_sha256<>s.canonical_projection_sha256
        OR observation.lifecycle_status<>s.lifecycle OR observation.archived<>(s.archived=1)))`;
  const paVisibility = policy.canViewUnprojectedCanonical ? "1=1" : `EXISTS (
    SELECT 1 FROM pa_projects p
    LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
    WHERE p.projection_source_id=s.source_id
      AND json_valid(p.payload_json) AND json_type(p.payload_json,'$.public_id')='text'
      AND json_extract(p.payload_json,'$.public_id')=s.project_alpha_public_id
      AND length(json_extract(p.payload_json,'$.public_id'))=32
      AND json_extract(p.payload_json,'$.public_id') NOT GLOB '*[^0-9a-f]*'
      AND (SELECT count(*) FROM pa_projects same_project
        WHERE same_project.projection_source_id=p.projection_source_id AND json_valid(same_project.payload_json)
          AND json_extract(same_project.payload_json,'$.public_id')=s.project_alpha_public_id)=1
      AND ${projectAlphaReadVisibleSql("p.projection_source_id")}
      AND (${owner.sql}) AND (${policy.filter.sql}))`;
  return {
    sql: `s.source_id=? AND s.source_instance_id IS NOT NULL AND s.application_id IS NOT NULL
      AND s.history_epoch_id IS NOT NULL AND s.project_alpha_public_id IS NOT NULL AND s.pa_revision IS NOT NULL
      AND s.canonical_projection_sha256 IS NOT NULL AND s.archived=0
      AND EXISTS (SELECT 1 FROM project_alpha_project_mappings project_mapping
        WHERE project_mapping.external_project_id=s.external_project_id AND project_mapping.source_id=s.source_id
          AND project_mapping.source_instance_id=s.source_instance_id AND project_mapping.application_id=s.application_id
          AND project_mapping.history_epoch_id=s.history_epoch_id
          AND project_mapping.project_alpha_public_id=s.project_alpha_public_id)
      AND EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings current_root_mapping
        WHERE ${currentRootIdentity} AND current_root_mapping.source_id=s.source_id
          AND current_root_mapping.source_instance_id=s.source_instance_id
          AND current_root_mapping.application_id=s.application_id
          AND current_root_mapping.history_epoch_id=s.history_epoch_id
          AND current_root_mapping.resource_type=? AND current_root_mapping.record_id=?
          AND current_root_mapping.external_id=? AND current_root_mapping.project_alpha_public_id=?)
      AND (SELECT count(*) FROM project_alpha_project_mappings unique_project_mapping
        WHERE unique_project_mapping.source_id=s.source_id AND unique_project_mapping.source_instance_id=s.source_instance_id
          AND unique_project_mapping.application_id=s.application_id AND unique_project_mapping.history_epoch_id=s.history_epoch_id
          AND (unique_project_mapping.external_project_id=s.external_project_id
            OR unique_project_mapping.project_alpha_public_id=s.project_alpha_public_id))=1
      AND EXISTS (SELECT 1 FROM operations_shared_project_revisions revision
        WHERE revision.external_project_id=s.external_project_id AND revision.version=s.current_version
          AND revision.v2_settlement_id IS NOT NULL AND revision.pa_revision IS NULL
          AND revision.refresh_command_id IS NULL AND ${exactRevision})
      AND EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_activation_receipts activation
        WHERE activation.external_project_id=s.external_project_id
          AND activation.resulting_local_version=s.current_version
          AND activation.organization_record_id IS s.organization_record_id
          AND activation.client_record_id IS s.client_record_id)
      AND ${noConflicts} AND ${observations}
      AND ${rootOwner}
      AND ${projectAlphaReadVisibleSql("s.source_id")} AND (${paVisibility})`,
    values: [context.root.source_id, root.kind === "organization" ? "organization" : "client",
      root.public_id, root.pa_internal_id, root.pa_public_id, ...rootValues,
      ...(policy.canViewUnprojectedCanonical ? [] : [...owner.values, ...policy.filter.values])],
  };
}

function canonicalStatusFilter(filter: "all" | "current" | "completed" | "cancelled"): string {
  return filter === "current" ? " AND s.lifecycle IN ('not_started','active')"
    : filter === "completed" ? " AND s.lifecycle='completed'"
      : filter === "cancelled" ? " AND s.lifecycle='cancelled'" : "";
}

export async function listCanonicalClientHubProjects(env: Env, context: ClientHubCollectionContext,
  policy: ClientHubBusinessProjectPolicy, options: { limit: number; after?: [string, string]; filter: "all" | "current" | "completed" | "cancelled" }): Promise<CanonicalBusinessProjectRow[]> {
  const proof = await canonicalBusinessProjectPredicate(env, context, policy);
  if (!proof) return [];
  const status = canonicalStatusFilter(options.filter);
  const after = options.after ? " AND (COALESCE(s.created_at,''),'shared:'||s.external_project_id)<(?,?)" : "";
  const statement = env.OPS_DB.withSession("first-primary").prepare(`SELECT s.external_project_id id,'canonical' origin,
    s.external_project_id,s.name,s.lifecycle status,s.description,s.planned_start start_date,s.planned_end end_date,
    NULL created_at,NULL manager_user_id,NULL manager_name,s.overdue_warning,
    COALESCE(s.created_at,'') __created,'shared:'||s.external_project_id __sort_id,'canonical' __origin
    FROM operations_shared_projects s WHERE ${proof.sql}${status}${after}
    ORDER BY COALESCE(s.created_at,'') DESC,('shared:'||s.external_project_id) DESC LIMIT ?`);
  return (await statement.bind(...proof.values, ...(options.after ?? []), options.limit).all<CanonicalBusinessProjectRow>()).results;
}

export async function recheckCanonicalClientHubProjects(env: Env, context: ClientHubCollectionContext,
  policy: ClientHubBusinessProjectPolicy, externalIds: string[], filter: "all" | "current" | "completed" | "cancelled"): Promise<boolean> {
  if (!externalIds.length) return true;
  const proof = await canonicalBusinessProjectPredicate(env, context, policy);
  if (!proof) return false;
  const count = await env.OPS_DB.withSession("first-primary").prepare(`SELECT count(*) count FROM operations_shared_projects s
    WHERE ${proof.sql}${canonicalStatusFilter(filter)} AND s.external_project_id IN (${externalIds.map(() => "?").join(",")})`)
    .bind(...proof.values, ...externalIds).first<number>("count");
  return count === externalIds.length;
}

export function canonicalProjectSortDate(value: string | null): string {
  if (!value || value.length > 64 || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return "";
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}
