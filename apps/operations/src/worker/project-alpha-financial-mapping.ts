import type { Env } from "./types";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { selectorFromTrustedFinancialMapping, type TrustedFinancialMapping } from "./project-alpha-financial-transport";
import { externalId as validProjectExternalId } from "./project-alpha-project-transport";

export type NativeFinancialTarget =
  | Readonly<{ kind: "organization" | "client"; recordId: string; sourceId?: string }>
  | Readonly<{ kind: "project"; externalProjectId: string; sourceId?: string }>;

type MappingRow = {
  source_id: string; source_instance_id: string; application_id: string; history_epoch_id: string;
  external_id: string; project_alpha_public_id: string; resource_revision: string;
  projection_sha256: string; authorization_generation: string;
};

const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const LOCAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;

function currentConfiguredRow(env: Pick<Env, "PROJECT_ALPHA_API_V2_CONNECTIONS">, row: MappingRow): boolean {
  try {
    const configured = resolveProjectAlphaApiV2Connection(env, row.source_id);
    return configured.enabled
      && configured.connection.expectedSourceInstanceId === row.source_instance_id
      && configured.connection.expectedApplicationId === row.application_id
      && configured.connection.expectedHistoryEpoch === row.history_epoch_id;
  } catch { return false; }
}

function trusted(row: MappingRow, kind: NativeFinancialTarget["kind"]): TrustedFinancialMapping | null {
  const mapping: TrustedFinancialMapping = Object.freeze({ sourceId: row.source_id, kind,
    externalId: row.external_id, publicId: row.project_alpha_public_id, revision: row.resource_revision,
    projectionSha256: row.projection_sha256, authorizationGeneration: row.authorization_generation });
  return selectorFromTrustedFinancialMapping(mapping) ? mapping : null;
}

/** Unrouted server-only bridge from a native identity to PA's exact selector.
 * The caller supplies a native record/project key, never a PA external/public
 * identity. Omitted sourceId is accepted only when exactly one currently
 * configured source proves the complete tuple. */
export async function resolveTrustedNativeFinancialMapping(
  env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">,
  target: NativeFinancialTarget,
): Promise<TrustedFinancialMapping | null> {
  const nativeId = target.kind === "project" ? target.externalProjectId : target.recordId;
  if ((target.kind === "project" ? !validProjectExternalId(nativeId) : !LOCAL_ID.test(nativeId))
    || target.sourceId !== undefined && !SOURCE.test(target.sourceId)) return null;
  const sourceClause = target.sourceId === undefined ? "" : " AND mapping.source_id=?";
  const values = target.sourceId === undefined ? [nativeId] : [nativeId, target.sourceId];
  let rows: MappingRow[];
  try {
    if (target.kind !== "project") {
      rows = (await env.OPS_DB.withSession("first-primary").prepare(`SELECT mapping.source_id,mapping.source_instance_id,
        mapping.application_id,mapping.history_epoch_id,mapping.external_id,mapping.project_alpha_public_id,
        observation.resource_revision,observation.projection_sha256,(SELECT generation.authorization_generation
          FROM project_alpha_api_v2_inventory_receipts generation WHERE generation.source_id=mapping.source_id
            AND generation.source_instance_id=mapping.source_instance_id AND generation.application_id=mapping.application_id
            AND generation.history_epoch_id=mapping.history_epoch_id
          ORDER BY length(generation.authorization_generation) DESC,generation.authorization_generation DESC LIMIT 1) authorization_generation
        FROM project_alpha_active_directory_mappings mapping
        JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=mapping.resource_type
        JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
        JOIN project_alpha_api_v2_directory_observations_current observation
          ON observation.source_id=mapping.source_id AND observation.source_instance_id=mapping.source_instance_id
         AND observation.application_id=mapping.application_id AND observation.history_epoch_id=mapping.history_epoch_id
         AND observation.resource_type=mapping.resource_type AND observation.project_alpha_public_id=mapping.project_alpha_public_id
        JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id
         AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id
         AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='directory'
         AND receipt.request_id=observation.request_id
        WHERE mapping.record_id=?${sourceClause} AND mapping.resource_type=?
          AND observation.present=1 AND observation.last_action='upsert' AND observation.has_conflict=0
          AND observation.binding_status='active' AND observation.binding_external_id=mapping.external_id
          AND observation.binding_resource_revision=observation.resource_revision
          AND json_valid(revision.profile_json)
          AND NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
            WHERE conflict.source_id=mapping.source_id AND conflict.source_instance_id=mapping.source_instance_id
              AND conflict.application_id=mapping.application_id AND conflict.history_epoch_id=mapping.history_epoch_id
              AND (conflict.resource_type='source' OR conflict.inventory_kind='directory'
                AND conflict.resource_type=mapping.resource_type AND (conflict.project_alpha_public_id=mapping.project_alpha_public_id
                  OR conflict.external_id=mapping.external_id)))
          AND (SELECT count(*) FROM project_alpha_active_directory_mappings candidate
            WHERE candidate.source_id=mapping.source_id AND candidate.source_instance_id=mapping.source_instance_id
              AND candidate.application_id=mapping.application_id AND candidate.history_epoch_id=mapping.history_epoch_id
              AND candidate.resource_type=mapping.resource_type AND (candidate.record_id=mapping.record_id
                OR candidate.external_id=mapping.external_id OR candidate.project_alpha_public_id=mapping.project_alpha_public_id))=1
        ORDER BY mapping.source_id LIMIT 3`).bind(...values, target.kind).all<MappingRow>()).results;
    } else {
      rows = (await env.OPS_DB.withSession("first-primary").prepare(`SELECT mapping.source_id,mapping.source_instance_id,
        mapping.application_id,mapping.history_epoch_id,mapping.external_project_id external_id,
        mapping.project_alpha_public_id,project.pa_revision resource_revision,
        project.canonical_projection_sha256 projection_sha256,(SELECT generation.authorization_generation
          FROM project_alpha_api_v2_inventory_receipts generation WHERE generation.source_id=mapping.source_id
            AND generation.source_instance_id=mapping.source_instance_id AND generation.application_id=mapping.application_id
            AND generation.history_epoch_id=mapping.history_epoch_id
          ORDER BY length(generation.authorization_generation) DESC,generation.authorization_generation DESC LIMIT 1) authorization_generation
        FROM project_alpha_project_mappings mapping
        JOIN operations_shared_projects project ON project.external_project_id=mapping.external_project_id
         AND project.source_id=mapping.source_id AND project.source_instance_id=mapping.source_instance_id
         AND project.application_id=mapping.application_id AND project.history_epoch_id=mapping.history_epoch_id
         AND project.project_alpha_public_id=mapping.project_alpha_public_id
        JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
         AND revision.version=project.current_version
        JOIN project_alpha_api_v2_project_observations_current observation
         ON observation.source_id=mapping.source_id AND observation.source_instance_id=mapping.source_instance_id
         AND observation.application_id=mapping.application_id AND observation.history_epoch_id=mapping.history_epoch_id
         AND observation.external_project_id=mapping.external_project_id
         AND observation.project_alpha_public_id=mapping.project_alpha_public_id
        JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id
         AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id
         AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='project'
         AND receipt.request_id=observation.request_id
        WHERE mapping.external_project_id=?${sourceClause} AND observation.archived=project.archived
          AND observation.has_conflict=0 AND observation.resource_revision=project.pa_revision
          AND observation.projection_sha256=project.canonical_projection_sha256
          AND json_valid(revision.read_json)
          AND json_extract(revision.read_json,'$.resource.id')=mapping.project_alpha_public_id
          AND json_extract(revision.read_json,'$.resource.revision')=project.pa_revision
          AND json_extract(revision.read_json,'$.resource.projectionSha256')=project.canonical_projection_sha256
          AND (EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_activation_receipts activation
            WHERE activation.external_project_id=project.external_project_id
              AND activation.resulting_local_version=project.current_version)
            OR revision.inbound_resolution_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM project_alpha_project_inbound_resolution_receipts inbound
              WHERE inbound.resolution_id=revision.inbound_resolution_id AND inbound.decision='accept_project_alpha'
                AND inbound.resulting_local_version=project.current_version
                AND EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_activation_receipts prior_activation
                  WHERE prior_activation.external_project_id=project.external_project_id
                    AND prior_activation.resulting_local_version<=inbound.prior_local_version)))
          AND NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
            WHERE conflict.source_id=mapping.source_id AND conflict.source_instance_id=mapping.source_instance_id
              AND conflict.application_id=mapping.application_id AND conflict.history_epoch_id=mapping.history_epoch_id
              AND (conflict.resource_type='source' OR conflict.inventory_kind='project'
                AND (conflict.project_alpha_public_id=mapping.project_alpha_public_id OR conflict.external_id=mapping.external_project_id)))
          AND (SELECT count(*) FROM project_alpha_project_mappings candidate
            WHERE candidate.source_id=mapping.source_id AND candidate.source_instance_id=mapping.source_instance_id
              AND candidate.application_id=mapping.application_id AND candidate.history_epoch_id=mapping.history_epoch_id
              AND (candidate.external_project_id=mapping.external_project_id
                OR candidate.project_alpha_public_id=mapping.project_alpha_public_id))=1
        ORDER BY mapping.source_id LIMIT 3`).bind(...values).all<MappingRow>()).results;
    }
  } catch { return null; }
  const candidates = rows.filter(row => currentConfiguredRow(env, row)).map(row => trusted(row, target.kind)).filter((row): row is TrustedFinancialMapping => row !== null);
  return candidates.length === 1 ? candidates[0]! : null;
}
