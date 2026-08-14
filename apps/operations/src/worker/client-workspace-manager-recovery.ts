import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "./types";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface ClientWorkspaceRecoveryMember {
  identityId: string;
  email: string | null;
  status: "active" | "suspended" | "revoked";
  source: "project_alpha" | "operations" | "client_invitation" | "legacy";
  manager: boolean;
}

export interface ClientWorkspaceRecoveryWorkspace {
  id: string;
  displayName: string;
  members: ClientWorkspaceRecoveryMember[];
}

export function clientWorkspaceManagerRecoveryEnabled(env: Env): boolean {
  return env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED === "true";
}

function requireEnabled(env: Env): void {
  if (!clientWorkspaceManagerRecoveryEnabled(env))
    throw new HTTPException(404, { message: "Not found" });
}

function db(env: Env): D1Database {
  const database = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return database.withSession?.("first-primary") ?? database;
}

function effectiveWorkspaceCapabilitySql(capability: "workspace.view" | "member.manage"): string {
  return `EXISTS(SELECT 1
    FROM portal_v2_workspace_memberships effective_membership
    JOIN portal_v2_identities effective_identity ON effective_identity.id=effective_membership.identity_id
      AND effective_identity.status='active' AND effective_identity.revoked_at IS NULL
    JOIN portal_v2_entitlements effective_allow
      ON effective_allow.workspace_id=effective_membership.workspace_id
     AND effective_allow.identity_id=effective_membership.identity_id
    WHERE effective_membership.workspace_id=? AND effective_membership.identity_id=?
      AND effective_membership.status='active' AND effective_membership.revoked_at IS NULL
      AND (effective_membership.expires_at IS NULL OR datetime(effective_membership.expires_at)>datetime('now'))
      AND effective_allow.capability='${capability}' AND effective_allow.effect='allow'
      AND effective_allow.scope_type='workspace' AND effective_allow.scope_public_id=effective_membership.workspace_id
      AND effective_allow.status='active' AND effective_allow.revoked_at IS NULL
      AND datetime(effective_allow.valid_from)<=datetime('now')
      AND (effective_allow.expires_at IS NULL OR datetime(effective_allow.expires_at)>datetime('now'))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements effective_deny
        WHERE effective_deny.workspace_id=effective_allow.workspace_id
          AND effective_deny.identity_id=effective_allow.identity_id
          AND effective_deny.capability=effective_allow.capability AND effective_deny.effect='deny'
          AND effective_deny.scope_type='workspace' AND effective_deny.scope_public_id=effective_allow.scope_public_id
          AND effective_deny.status='active' AND effective_deny.revoked_at IS NULL
          AND datetime(effective_deny.valid_from)<=datetime('now')
          AND (effective_deny.expires_at IS NULL OR datetime(effective_deny.expires_at)>datetime('now'))))`;
}

async function hasEffectiveWorkspaceCapability(
  database: D1Database,
  workspaceId: string,
  identityId: string,
  capability: "workspace.view" | "member.manage",
): Promise<boolean> {
  const result = await database.prepare(`SELECT ${effectiveWorkspaceCapabilitySql(capability)} AS authorized`)
    .bind(workspaceId, identityId)
    .first<number>("authorized");
  return result === 1;
}

export async function listClientWorkspaceManagerRecovery(env: Env): Promise<{ workspaces: ClientWorkspaceRecoveryWorkspace[] }> {
  requireEnabled(env);
  const rows = await db(env).prepare(`SELECT workspace.id workspace_id,workspace.display_name,
    membership.identity_id,identity.verified_email,membership.status,membership.source_type,
    EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
      WHERE entitlement.workspace_id=membership.workspace_id AND entitlement.identity_id=membership.identity_id
        AND entitlement.capability='member.manage' AND entitlement.effect='allow'
        AND entitlement.scope_type='workspace' AND entitlement.scope_public_id=membership.workspace_id
        AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now')
        AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
        AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements denied
          WHERE denied.workspace_id=entitlement.workspace_id AND denied.identity_id=entitlement.identity_id
            AND denied.capability='member.manage' AND denied.effect='deny'
            AND denied.scope_type='workspace' AND denied.scope_public_id=entitlement.workspace_id
            AND denied.status='active' AND denied.revoked_at IS NULL
            AND datetime(denied.valid_from)<=datetime('now')
            AND (denied.expires_at IS NULL OR datetime(denied.expires_at)>datetime('now')))) manager
    FROM portal_v2_workspaces workspace
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id
    JOIN portal_v2_identities identity ON identity.id=membership.identity_id
    WHERE workspace.status='active' AND workspace.legacy_account_id IS NOT NULL
      AND membership.status IN ('active','suspended') AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      AND identity.status='active' AND identity.revoked_at IS NULL
    ORDER BY workspace.display_name COLLATE NOCASE,lower(identity.verified_email),membership.identity_id LIMIT 501`)
    .all<{ workspace_id: string; display_name: string; identity_id: string; verified_email: string | null;
      status: ClientWorkspaceRecoveryMember["status"]; source_type: ClientWorkspaceRecoveryMember["source"]; manager: number }>();
  if (rows.results.length > 500) throw new HTTPException(503, { message: "Too many client workspace members to review safely" });
  const workspaces = new Map<string, ClientWorkspaceRecoveryWorkspace>();
  for (const row of rows.results) {
    const workspace = workspaces.get(row.workspace_id) ?? { id: row.workspace_id, displayName: row.display_name, members: [] };
    workspace.members.push({ identityId: row.identity_id, email: row.verified_email, status: row.status,
      source: row.source_type, manager: row.manager === 1 });
    workspaces.set(row.workspace_id, workspace);
  }
  return { workspaces: [...workspaces.values()] };
}

export interface TransferClientWorkspaceManagerInput {
  targetIdentityId: string;
  previousManagerIdentityId?: string;
  suspendPrevious?: boolean;
}

export async function transferClientWorkspaceManager(
  env: Env,
  principal: StaffPrincipal,
  workspaceId: string,
  input: TransferClientWorkspaceManagerInput,
): Promise<{ transferred: true }> {
  requireEnabled(env);
  if (!OPAQUE_ID.test(workspaceId) || !OPAQUE_ID.test(input.targetIdentityId)
    || (input.previousManagerIdentityId !== undefined && !OPAQUE_ID.test(input.previousManagerIdentityId)))
    throw new HTTPException(400, { message: "Workspace manager selection is invalid" });
  if (input.previousManagerIdentityId === input.targetIdentityId)
    throw new HTTPException(400, { message: "Choose a different replacement manager" });
  const database = db(env);
  const target = await database.prepare(`SELECT membership.status,membership.source_type,
    EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
      WHERE entitlement.workspace_id=membership.workspace_id AND entitlement.identity_id=membership.identity_id
        AND entitlement.capability='member.manage' AND entitlement.effect='allow'
        AND entitlement.scope_type='workspace' AND entitlement.scope_public_id=membership.workspace_id
        AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now')
        AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
        AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements denied
          WHERE denied.workspace_id=entitlement.workspace_id AND denied.identity_id=entitlement.identity_id
            AND denied.capability='member.manage' AND denied.effect='deny'
            AND denied.scope_type='workspace' AND denied.scope_public_id=entitlement.workspace_id
            AND denied.status='active' AND denied.revoked_at IS NULL
            AND datetime(denied.valid_from)<=datetime('now')
            AND (denied.expires_at IS NULL OR datetime(denied.expires_at)>datetime('now')))) manager
    FROM portal_v2_workspaces workspace
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id
    JOIN portal_v2_identities identity ON identity.id=membership.identity_id
      AND identity.status='active' AND identity.revoked_at IS NULL
    WHERE workspace.id=? AND workspace.status='active' AND workspace.legacy_account_id IS NOT NULL
      AND membership.identity_id=? AND membership.status IN ('active','suspended')
      AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))`)
    .bind(workspaceId, input.targetIdentityId)
    .first<{ status: "active" | "suspended"; source_type: ClientWorkspaceRecoveryMember["source"]; manager: number }>();
  if (!target) throw new HTTPException(404, { message: "Replacement workspace member not found" });
  if (target.source_type === "project_alpha" && (target.status !== "active" || target.manager !== 1))
    throw new HTTPException(409, { message: "Project Alpha-managed manager authority must be changed in Project Alpha" });

  let previous: { status: string; source_type: ClientWorkspaceRecoveryMember["source"]; manager: number } | null = null;
  if (input.previousManagerIdentityId) {
    previous = await database.prepare(`SELECT membership.status,membership.source_type,
      EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
        WHERE entitlement.workspace_id=membership.workspace_id AND entitlement.identity_id=membership.identity_id
          AND entitlement.capability='member.manage' AND entitlement.effect='allow'
          AND entitlement.scope_type='workspace' AND entitlement.scope_public_id=membership.workspace_id
          AND entitlement.status='active' AND entitlement.revoked_at IS NULL
          AND datetime(entitlement.valid_from)<=datetime('now')
          AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
          AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements denied
            WHERE denied.workspace_id=entitlement.workspace_id AND denied.identity_id=entitlement.identity_id
              AND denied.capability='member.manage' AND denied.effect='deny'
              AND denied.scope_type='workspace' AND denied.scope_public_id=entitlement.workspace_id
              AND denied.status='active' AND denied.revoked_at IS NULL
              AND datetime(denied.valid_from)<=datetime('now')
              AND (denied.expires_at IS NULL OR datetime(denied.expires_at)>datetime('now')))) manager
      FROM portal_v2_workspace_memberships membership
      JOIN portal_v2_identities identity ON identity.id=membership.identity_id
        AND identity.status='active' AND identity.revoked_at IS NULL
      WHERE membership.workspace_id=? AND membership.identity_id=?
        AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))`)
      .bind(workspaceId, input.previousManagerIdentityId)
      .first<{ status: string; source_type: ClientWorkspaceRecoveryMember["source"]; manager: number }>();
    if (!previous || previous.status !== "active" || previous.manager !== 1)
      throw new HTTPException(409, { message: "The outgoing person is not an active workspace manager" });
    if (input.suspendPrevious === true && previous.source_type === "project_alpha")
      throw new HTTPException(409, { message: "Project Alpha-managed access must be removed in Project Alpha" });
  }

  const statements: D1PreparedStatement[] = [];
  if (target.source_type !== "project_alpha") {
    const targetEligibility = `EXISTS(SELECT 1
      FROM portal_v2_workspaces eligible_workspace
      JOIN portal_v2_workspace_memberships eligible_membership
        ON eligible_membership.workspace_id=eligible_workspace.id
      JOIN portal_v2_identities eligible_identity ON eligible_identity.id=eligible_membership.identity_id
      WHERE eligible_workspace.id=? AND eligible_workspace.status='active'
        AND eligible_workspace.legacy_account_id IS NOT NULL
        AND eligible_membership.identity_id=?
        AND eligible_membership.source_type<>'project_alpha'
        AND eligible_membership.status IN ('active','suspended')
        AND eligible_membership.revoked_at IS NULL
        AND (eligible_membership.expires_at IS NULL OR datetime(eligible_membership.expires_at)>datetime('now'))
        AND eligible_identity.status='active' AND eligible_identity.revoked_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny
          WHERE deny.workspace_id=eligible_workspace.id AND deny.identity_id=eligible_membership.identity_id
            AND deny.capability IN ('workspace.view','member.manage') AND deny.effect='deny'
            AND deny.scope_type='workspace' AND deny.scope_public_id=eligible_workspace.id
            AND deny.status='active' AND deny.revoked_at IS NULL
            AND datetime(deny.valid_from)<=datetime('now')
            AND (deny.expires_at IS NULL OR datetime(deny.expires_at)>datetime('now'))))`;
    statements.push(database.prepare(`UPDATE portal_v2_workspace_memberships AS target_membership
      SET status='active',revoked_at=NULL,updated_at=datetime('now')
      WHERE target_membership.workspace_id=? AND target_membership.identity_id=?
        AND ${targetEligibility}`)
      .bind(workspaceId, input.targetIdentityId, workspaceId, input.targetIdentityId));
    for (const capability of ["workspace.view", "member.manage"] as const) {
      statements.push(database.prepare(`INSERT INTO portal_v2_entitlements
        (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,
          entitlement_version,source_type,status)
        SELECT ?,?,?,?,'allow','workspace',?,
          COALESCE((SELECT MAX(existing.entitlement_version)+1 FROM portal_v2_entitlements existing
            WHERE existing.workspace_id=? AND existing.identity_id=? AND existing.capability=?
              AND existing.effect='allow' AND existing.scope_type='workspace' AND existing.scope_public_id=?),1),
          'operations','active'
        WHERE ${targetEligibility}
          AND NOT ${effectiveWorkspaceCapabilitySql(capability)}`)
        .bind(
          crypto.randomUUID(), workspaceId, input.targetIdentityId, capability, workspaceId,
          workspaceId, input.targetIdentityId, capability, workspaceId,
          workspaceId, input.targetIdentityId,
          workspaceId, input.targetIdentityId,
        ));
    }
  }
  if (input.previousManagerIdentityId && input.suspendPrevious === true) {
    const targetIsEffective = `${effectiveWorkspaceCapabilitySql("workspace.view")}
      AND ${effectiveWorkspaceCapabilitySql("member.manage")}`;
    statements.push(
      database.prepare(`UPDATE portal_v2_workspace_memberships AS outgoing
        SET status='suspended',updated_at=datetime('now')
        WHERE outgoing.workspace_id=? AND outgoing.identity_id=? AND outgoing.status='active'
          AND outgoing.source_type<>'project_alpha' AND outgoing.revoked_at IS NULL
          AND (outgoing.expires_at IS NULL OR datetime(outgoing.expires_at)>datetime('now'))
          AND ${targetIsEffective}`)
        .bind(
          workspaceId, input.previousManagerIdentityId,
          workspaceId, input.targetIdentityId,
          workspaceId, input.targetIdentityId,
        ),
      database.prepare(`UPDATE portal_v2_entitlements AS outgoing_entitlement SET status='suspended'
        WHERE outgoing_entitlement.workspace_id=? AND outgoing_entitlement.identity_id=?
          AND outgoing_entitlement.status='active'
          AND EXISTS(SELECT 1 FROM portal_v2_workspace_memberships outgoing
            WHERE outgoing.workspace_id=outgoing_entitlement.workspace_id
              AND outgoing.identity_id=outgoing_entitlement.identity_id AND outgoing.status='suspended')
          AND ${targetIsEffective}`)
        .bind(
          workspaceId, input.previousManagerIdentityId,
          workspaceId, input.targetIdentityId,
          workspaceId, input.targetIdentityId,
        ),
      database.prepare(`INSERT INTO portal_v2_membership_audit
        (id,workspace_id,action,subject_identity_id,details_json)
        SELECT ?,?,'membership.suspended',?,?
        WHERE EXISTS(SELECT 1 FROM portal_v2_workspace_memberships outgoing
          WHERE outgoing.workspace_id=? AND outgoing.identity_id=? AND outgoing.status='suspended')
          AND ${targetIsEffective}`)
        .bind(
          crypto.randomUUID(), workspaceId, input.previousManagerIdentityId,
          JSON.stringify({ staffActorId: principal.id, reason: "manager_transfer" }),
          workspaceId, input.previousManagerIdentityId,
          workspaceId, input.targetIdentityId,
          workspaceId, input.targetIdentityId,
        ),
    );
  }
  const targetIsEffective = `${effectiveWorkspaceCapabilitySql("workspace.view")}
    AND ${effectiveWorkspaceCapabilitySql("member.manage")}`;
  statements.push(database.prepare(`INSERT INTO portal_v2_membership_audit
    (id,workspace_id,action,subject_identity_id,details_json)
    SELECT ?,?,'manager.transferred',?,?
    WHERE ${targetIsEffective}
      ${input.previousManagerIdentityId && input.suspendPrevious === true ? `AND EXISTS(
        SELECT 1 FROM portal_v2_workspace_memberships outgoing
        WHERE outgoing.workspace_id=? AND outgoing.identity_id=? AND outgoing.status='suspended')` : ""}`)
    .bind(
      crypto.randomUUID(), workspaceId, input.targetIdentityId, JSON.stringify({
        staffActorId: principal.id,
        previousManagerIdentityId: input.previousManagerIdentityId ?? null,
        previousManagerSuspended: input.suspendPrevious === true,
      }),
      workspaceId, input.targetIdentityId,
      workspaceId, input.targetIdentityId,
      ...(input.previousManagerIdentityId && input.suspendPrevious === true
        ? [workspaceId, input.previousManagerIdentityId]
        : []),
    ));
  await database.batch(statements);
  const targetEffective = await hasEffectiveWorkspaceCapability(
    database, workspaceId, input.targetIdentityId, "workspace.view",
  ) && await hasEffectiveWorkspaceCapability(
    database, workspaceId, input.targetIdentityId, "member.manage",
  );
  if (!targetEffective)
    throw new HTTPException(409, { message: "The replacement manager is no longer eligible" });
  if (input.previousManagerIdentityId && input.suspendPrevious === true) {
    const previousStatus = await database.prepare(`SELECT status FROM portal_v2_workspace_memberships
      WHERE workspace_id=? AND identity_id=?`).bind(workspaceId, input.previousManagerIdentityId).first("status");
    if (previousStatus !== "suspended")
      throw new HTTPException(409, { message: "The outgoing manager changed before the transfer completed" });
  }
  return { transferred: true };
}
