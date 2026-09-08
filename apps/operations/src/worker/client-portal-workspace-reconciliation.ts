import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import {
  clientPortalWorkspaceReconciliationEnabled,
  reconcilePrimaryClientPortalWorkspaces,
  type PrimaryClientPortalReconciliationResult,
} from "./client-account-root-activation";
import { validatedUniquePublicIdExpression } from "./client-hub-source";
import type { Env } from "./types";

export interface SourcePortalWorkspaceReconciliation {
  sourceId: string;
  mode: "legacy_primary" | "signed_projection";
  enabled: boolean;
  /** Active exact-source business roots inspected. */
  scanned: number;
  /** Existing authoritative portal workspaces, never inferred records. */
  projected: number;
  /** Active roots awaiting a signed Project Alpha portal snapshot. */
  pending: number;
  /** Existing roots under an administrator revoke policy. */
  revoked: number;
  /** No-write reconciliation result for already authoritative workspaces. */
  unchanged: number;
  /** Kept only for the legacy primary account-repair compatibility path. */
  legacy?: PrimaryClientPortalReconciliationResult;
}

export interface ClientPortalWorkspaceReconciliationResult {
  enabled: boolean;
  sources: SourcePortalWorkspaceReconciliation[];
}

interface ConnectorRow { source_id: string; }
interface NativeCounts { scanned: number; projected: number; revoked: number; }

function validSourceId(value: string): boolean {
  return /^project-alpha:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

async function sourcesToReconcile(env: Env, requested?: string): Promise<string[]> {
  const db = env.OPS_DB.withSession("first-primary");
  if (requested !== undefined) {
    if (!validSourceId(requested)) return [];
    if (requested === PRIMARY_ALPHA_SOURCE_ID) return [requested];
    try {
      const row = await db.prepare(`SELECT source_id FROM pa_connectors
        WHERE source_id=? AND state='active' AND read_visible=1`).bind(requested).first<ConnectorRow>();
      return row ? [row.source_id] : [];
    } catch (error) {
      // Older Operations databases predate registered connectors. They cannot
      // safely reconcile a non-primary source, so treat it as unavailable.
      if (error instanceof Error && /no such table: pa_connectors/i.test(error.message)) return [];
      throw error;
    }
  }
  try {
    const rows = await db.prepare(`SELECT source_id FROM pa_connectors
      WHERE state='active' AND read_visible=1 ORDER BY source_id`).all<ConnectorRow>();
    return [...new Set([PRIMARY_ALPHA_SOURCE_ID, ...rows.results.map(row => row.source_id)])];
  } catch (error) {
    if (error instanceof Error && /no such table: pa_connectors/i.test(error.message)) {
      return [PRIMARY_ALPHA_SOURCE_ID];
    }
    throw error;
  }
}

/**
 * This is deliberately a readiness reconciliation, not a second portal
 * producer. Operations does not possess an external source's signed snapshot
 * or source-workspace ID, so it must not fabricate an LTT workspace from
 * business names, emails, or an Ops-only UUID. It instead confirms the exact
 * producer-owned workspace and reports an absent snapshot as pending.
 */
async function nativeCounts(env: Env, sourceId: string): Promise<NativeCounts> {
  const organizationPublicId = validatedUniquePublicIdExpression("pa_organizations", "organization");
  const clientPublicId = validatedUniquePublicIdExpression("pa_clients", "client");
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`WITH roots(root_type,root_public_id) AS (
      SELECT 'organization',${organizationPublicId} FROM pa_organizations organization
        WHERE organization.projection_source_id=? AND organization.active=1
          AND ${organizationPublicId} IS NOT NULL
      UNION ALL
      SELECT 'standalone_client',${clientPublicId} FROM pa_clients client
        WHERE client.projection_source_id=? AND client.active=1 AND client.organization_id IS NULL
          AND ${clientPublicId} IS NOT NULL
    ) SELECT count(*) scanned,
      COALESCE(sum(CASE WHEN EXISTS(
        SELECT 1 FROM portal_v2_workspaces workspace
        JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id
          AND owner.projection_source_id=workspace.project_alpha_source_id
        WHERE workspace.project_alpha_source_id=? AND workspace.status='active'
          AND workspace.root_type=roots.root_type
          AND CASE roots.root_type WHEN 'organization' THEN workspace.pa_organization_public_id
            ELSE workspace.pa_client_public_id END=roots.root_public_id
      ) THEN 1 ELSE 0 END),0) projected,
      COALESCE(sum(CASE WHEN EXISTS(
        SELECT 1 FROM portal_v2_root_access_policies policy WHERE policy.projection_source_id=?
          AND policy.root_type=roots.root_type AND policy.root_public_id=roots.root_public_id
          AND policy.state='revoked'
      ) THEN 1 ELSE 0 END),0) revoked
    FROM roots`).bind(sourceId, sourceId, sourceId, sourceId).first<NativeCounts>();
  return { scanned: Number(row?.scanned ?? 0), projected: Number(row?.projected ?? 0), revoked: Number(row?.revoked ?? 0) };
}

export async function reconcileClientPortalWorkspaces(env: Env, requestedSourceId?: string): Promise<ClientPortalWorkspaceReconciliationResult> {
  if (!clientPortalWorkspaceReconciliationEnabled(env)) return { enabled: false, sources: [] };
  const sources: SourcePortalWorkspaceReconciliation[] = [];
  for (const sourceId of await sourcesToReconcile(env, requestedSourceId)) {
    if (sourceId === PRIMARY_ALPHA_SOURCE_ID) {
      const legacy = await reconcilePrimaryClientPortalWorkspaces(env);
      sources.push({ sourceId, mode: "legacy_primary", enabled: legacy.enabled,
        scanned: legacy.scanned, projected: legacy.projected,
        pending: Math.max(0, legacy.eligible - legacy.projected - legacy.unchanged),
        revoked: 0, unchanged: legacy.unchanged, legacy });
      continue;
    }
    const counts = await nativeCounts(env, sourceId);
    sources.push({ sourceId, mode: "signed_projection", enabled: true,
      scanned: counts.scanned, projected: counts.projected,
      pending: counts.scanned - counts.projected, revoked: counts.revoked,
      unchanged: counts.projected });
  }
  return { enabled: true, sources };
}
