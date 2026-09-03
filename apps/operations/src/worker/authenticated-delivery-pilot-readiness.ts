import { authenticatedDeliveryChangeNotificationsReady, authenticatedDeliveryNotificationsEnabled } from "./authenticated-delivery-change-notifications";
import { projectAccessAuthorityMutationsEnabled } from "./project-access-mutation-gate";
import type { Env } from "./types";

const REQUIRED_TABLES = [
  "portal_v2_workspaces",
  "portal_v2_directory_generations",
  "portal_v2_directory_entities",
  "portal_v2_directory_checkpoints",
  "pa_portal_workspace_sources",
  "pa_portal_projection_generations",
  "pa_portal_projection_checkpoints",
  "portal_v2_folder_bindings",
  "portal_v2_authenticated_delivery_grants",
  "portal_v2_authenticated_delivery_grant_recipients",
  "portal_v2_authenticated_delivery_grant_mutations",
  "portal_v2_authenticated_delivery_grant_audit",
  "portal_primary_staff_bindings",
  "portal_primary_staff_binding_mutations",
  "portal_primary_staff_binding_audit",
  "portal_primary_staff_binding_write_fences",
  "portal_project_access_terms",
  "portal_project_access_deadlines",
  "portal_project_access_current_lifecycle",
  "portal_workspace_invitation_policies",
  "portal_project_invitation_fences",
  "portal_project_access_write_fences",
  "portal_project_access_authority_history_state",
  "portal_project_access_authority_events",
] as const;

export type AuthenticatedDeliveryReadinessReason =
  | "hierarchy_disabled"
  | "grants_disabled"
  | "authority_mutations_disabled"
  | "schema_unavailable"
  | "primary_projection_unavailable"
  | "unreceipted_bindings"
  | "notifications_disabled"
  | "notification_schema_unavailable"
  | "readiness_check_unavailable";

export interface AuthenticatedDeliveryPilotReadiness {
  /** Whether staff mutation controls may safely be shown. */
  enabled: boolean;
  /** Whether the complete closed pilot, including staged notifications, is ready. */
  pilotReady: boolean;
  reasons: AuthenticatedDeliveryReadinessReason[];
  checks: {
    flags: { hierarchy: boolean; grants: boolean; authorityMutations: boolean; notifications: boolean };
    schema: { ready: boolean };
    primaryProjection: { ready: boolean; activeWorkspaceCount: number | null };
    bindings: { unreceiptedActiveCount: number | null };
    notifications: { ready: boolean };
  };
}

function database(env: Env): D1Database {
  const value = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return value.withSession?.("first-primary") ?? value;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Read-only, identifier-free deployment preflight. This intentionally fails
 * closed: session callers may advertise grant mutation controls only when the
 * signed primary projection and every authority/migration prerequisite agree.
 */
export async function authenticatedDeliveryPilotReadiness(env: Env): Promise<AuthenticatedDeliveryPilotReadiness> {
  const flags = {
    hierarchy: env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED === "true",
    grants: env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED === "true",
    authorityMutations: projectAccessAuthorityMutationsEnabled(env),
    notifications: authenticatedDeliveryNotificationsEnabled(env),
  };
  const reasons: AuthenticatedDeliveryReadinessReason[] = [];
  if (!flags.hierarchy) reasons.push("hierarchy_disabled");
  if (!flags.grants) reasons.push("grants_disabled");
  if (!flags.authorityMutations) reasons.push("authority_mutations_disabled");

  let schemaReady = false;
  let projectionCount: number | null = null;
  let unreceiptedCount: number | null = null;
  let notificationsReady = false;
  try {
    const db = database(env);
    const schema = await db.prepare(`SELECT count(*) n FROM sqlite_master
      WHERE type IN('table','view') AND name IN(SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(REQUIRED_TABLES)).first<{ n: number }>();
    schemaReady = count(schema?.n) === REQUIRED_TABLES.length;
    if (!schemaReady) reasons.push("schema_unavailable");
    if (schemaReady) {
      const projection = await db.prepare(`SELECT count(*) n FROM (
        SELECT workspace.id
        FROM portal_v2_workspaces workspace
        JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id
          AND source.projection_source_id='project-alpha:primary'
        JOIN portal_v2_directory_checkpoints directory_checkpoint ON directory_checkpoint.workspace_id=workspace.id
        JOIN portal_v2_directory_generations directory_generation
          ON directory_generation.id=directory_checkpoint.active_generation_id
          AND directory_generation.workspace_id=workspace.id AND directory_generation.status='active' AND directory_generation.complete=1
        JOIN pa_portal_projection_checkpoints projection_checkpoint ON projection_checkpoint.workspace_id=workspace.id
          AND projection_checkpoint.source_sequence=directory_checkpoint.source_sequence
        JOIN pa_portal_projection_generations projection_generation
          ON projection_generation.id=projection_checkpoint.snapshot_generation_id
          AND projection_generation.workspace_id=workspace.id
          AND projection_generation.projection_source_id='project-alpha:primary'
          AND projection_generation.status='active' AND projection_generation.complete=1
        WHERE workspace.project_alpha_source_id='project-alpha:primary'
          AND workspace.legacy_account_id IS NULL AND workspace.status='active'
        LIMIT 101
      )`).first<{ n: number }>();
      projectionCount = Math.min(count(projection?.n), 101);
      if (projectionCount === 0) reasons.push("primary_projection_unavailable");

      const unreceipted = await db.prepare(`SELECT count(*) n FROM (
        SELECT binding.id
        FROM portal_v2_folder_bindings binding
        JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
        LEFT JOIN portal_primary_staff_bindings receipt
          ON receipt.binding_id=binding.id AND receipt.workspace_id=binding.workspace_id
          AND receipt.source_id='project-alpha:primary' AND receipt.state='active'
        WHERE binding.source_type='operations' AND binding.status='active' AND binding.revoked_at IS NULL
          AND workspace.project_alpha_source_id='project-alpha:primary' AND workspace.status='active'
          AND receipt.binding_id IS NULL
        LIMIT 101
      )`).first<{ n: number }>();
      unreceiptedCount = Math.min(count(unreceipted?.n), 101);
      if (unreceiptedCount > 0) reasons.push("unreceipted_bindings");
    }
    notificationsReady = flags.notifications && await authenticatedDeliveryChangeNotificationsReady(env);
    if (!flags.notifications) reasons.push("notifications_disabled");
    else if (!notificationsReady) reasons.push("notification_schema_unavailable");
  } catch {
    if (!reasons.includes("readiness_check_unavailable")) reasons.push("readiness_check_unavailable");
  }

  const mutationBlockers: AuthenticatedDeliveryReadinessReason[] = [
    "hierarchy_disabled", "grants_disabled", "authority_mutations_disabled", "schema_unavailable",
    "primary_projection_unavailable", "unreceipted_bindings", "readiness_check_unavailable",
  ];
  const enabled = !reasons.some(reason => mutationBlockers.includes(reason));
  return {
    enabled,
    pilotReady: enabled && notificationsReady,
    reasons,
    checks: {
      flags,
      schema: { ready: schemaReady },
      primaryProjection: { ready: (projectionCount ?? 0) > 0, activeWorkspaceCount: projectionCount },
      bindings: { unreceiptedActiveCount: unreceiptedCount },
      notifications: { ready: notificationsReady },
    },
  };
}
