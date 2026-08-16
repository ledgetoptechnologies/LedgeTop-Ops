import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type ClientViewerSessionRequestV1,
  type ClientViewerSessionResultV1,
  ViewerServiceError,
} from "@ltds/shared";
import { z } from "zod";
import type { Env } from "./types";
import { issueViewerSession, type AssociationRow } from "./viewer-integration";

const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const requestSchema = z.object({
  protocolVersion: z.literal(1),
  workspaceId: opaqueId,
  identityId: opaqueId,
  legacyAccountId: opaqueId,
  legacyIdentityId: opaqueId,
  principalIssuer: z.string().min(1).max(512),
  principalSubject: z.string().min(1).max(512),
  projectId: opaqueId,
  associationId: opaqueId,
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

function db(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return candidate.withSession?.("first-primary") ?? candidate;
}

const AUTHORIZED_ASSOCIATION_SQL = `WITH RECURSIVE live AS (
  SELECT association.*,project.project_alpha_project_id live_project_public_id,membership.expires_at membership_expires_at,
    workspace.root_type,COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id
  FROM viewer_model_associations association
  JOIN projects project ON project.id=association.project_id AND project.active=1
    AND project.project_alpha_project_id=association.project_alpha_project_id
    AND project.source_updated_at=association.project_source_version
  JOIN client_project_grants project_grant ON project_grant.project_id=project.id
    AND project_grant.account_id=? AND project_grant.revoked_at IS NULL
  JOIN client_accounts account ON account.id=project_grant.account_id AND account.status='active'
  JOIN portal_v2_identities identity ON identity.id=? AND identity.issuer=? AND identity.subject=?
    AND identity.status='active' AND identity.revoked_at IS NULL
  JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=? AND membership.identity_id=identity.id
    AND membership.status='active' AND membership.revoked_at IS NULL
    AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
  JOIN portal_v2_workspaces workspace ON workspace.id=membership.workspace_id AND workspace.status='active'
    AND workspace.legacy_account_id=account.id
  JOIN client_identity_links legacy_identity ON legacy_identity.id=? AND legacy_identity.account_id=account.id
    AND legacy_identity.revoked_at IS NULL
  JOIN client_account_members member ON member.account_id=account.id AND member.identity_id=legacy_identity.id
    AND member.revoked_at IS NULL
  WHERE association.id=? AND association.project_id=? AND association.state='active'
    AND association.model_status='ready' AND association.revoked_at IS NULL
    AND (member.role='manager' OR EXISTS (
      SELECT 1 FROM client_member_project_grants member_grant
      WHERE member_grant.account_id=account.id AND member_grant.identity_id=legacy_identity.id
        AND member_grant.project_id=project.id AND member_grant.revoked_at IS NULL
    ))
), lineage(entity_type,public_id,parent_public_id,depth) AS (
  SELECT entity.entity_type,entity.public_id,entity.parent_public_id,0
  FROM live
  JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
  JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
    AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
  JOIN portal_v2_directory_entities entity ON entity.workspace_id=checkpoint.workspace_id
    AND entity.generation_id=checkpoint.active_generation_id AND entity.entity_type='project'
    AND entity.public_id=live.live_project_public_id AND entity.active=1
  UNION ALL
  SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1
  FROM lineage
  JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
  JOIN portal_v2_directory_entities parent ON parent.workspace_id=checkpoint.workspace_id
    AND parent.generation_id=checkpoint.active_generation_id AND parent.public_id=lineage.parent_public_id
    AND parent.active=1
  WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<8
), authorized AS (
  SELECT live.*,
    CASE
      WHEN live.membership_expires_at IS NULL THEN (
        SELECT MIN(allowed_expiry.expires_at) FROM portal_v2_entitlements allowed_expiry
        WHERE allowed_expiry.workspace_id=? AND allowed_expiry.identity_id=? AND allowed_expiry.capability='delivery.view'
          AND allowed_expiry.effect='allow' AND allowed_expiry.status='active' AND allowed_expiry.revoked_at IS NULL
          AND datetime(allowed_expiry.valid_from)<=datetime('now') AND allowed_expiry.expires_at IS NOT NULL
          AND datetime(allowed_expiry.expires_at)>datetime('now')
          AND ((allowed_expiry.scope_type='workspace' AND allowed_expiry.scope_public_id=?) OR EXISTS (
            SELECT 1 FROM lineage WHERE lineage.entity_type=allowed_expiry.scope_type AND lineage.public_id=allowed_expiry.scope_public_id
          ))
      )
      WHEN (SELECT MIN(allowed_expiry.expires_at) FROM portal_v2_entitlements allowed_expiry
        WHERE allowed_expiry.workspace_id=? AND allowed_expiry.identity_id=? AND allowed_expiry.capability='delivery.view'
          AND allowed_expiry.effect='allow' AND allowed_expiry.status='active' AND allowed_expiry.revoked_at IS NULL
          AND datetime(allowed_expiry.valid_from)<=datetime('now') AND allowed_expiry.expires_at IS NOT NULL
          AND datetime(allowed_expiry.expires_at)>datetime('now')
          AND ((allowed_expiry.scope_type='workspace' AND allowed_expiry.scope_public_id=?) OR EXISTS (
            SELECT 1 FROM lineage WHERE lineage.entity_type=allowed_expiry.scope_type AND lineage.public_id=allowed_expiry.scope_public_id
          ))) IS NULL THEN live.membership_expires_at
      ELSE MIN(live.membership_expires_at, (SELECT MIN(allowed_expiry.expires_at) FROM portal_v2_entitlements allowed_expiry
        WHERE allowed_expiry.workspace_id=? AND allowed_expiry.identity_id=? AND allowed_expiry.capability='delivery.view'
          AND allowed_expiry.effect='allow' AND allowed_expiry.status='active' AND allowed_expiry.revoked_at IS NULL
          AND datetime(allowed_expiry.valid_from)<=datetime('now') AND allowed_expiry.expires_at IS NOT NULL
          AND datetime(allowed_expiry.expires_at)>datetime('now')
          AND ((allowed_expiry.scope_type='workspace' AND allowed_expiry.scope_public_id=?) OR EXISTS (
            SELECT 1 FROM lineage WHERE lineage.entity_type=allowed_expiry.scope_type AND lineage.public_id=allowed_expiry.scope_public_id
          ))))
    END authorization_expires_at
  FROM live
  WHERE EXISTS (SELECT 1 FROM lineage WHERE lineage.entity_type=live.root_type AND lineage.public_id=live.root_public_id)
    AND EXISTS (
      SELECT 1 FROM portal_v2_entitlements allowed
      WHERE allowed.workspace_id=? AND allowed.identity_id=? AND allowed.capability='delivery.view'
        AND allowed.effect='allow' AND allowed.status='active' AND allowed.revoked_at IS NULL
        AND datetime(allowed.valid_from)<=datetime('now')
        AND (allowed.expires_at IS NULL OR datetime(allowed.expires_at)>datetime('now'))
        AND ((allowed.scope_type='workspace' AND allowed.scope_public_id=?) OR EXISTS (
          SELECT 1 FROM lineage WHERE lineage.entity_type=allowed.scope_type AND lineage.public_id=allowed.scope_public_id
        ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM portal_v2_entitlements denied
      WHERE denied.workspace_id=? AND denied.identity_id=? AND denied.capability='delivery.view'
        AND denied.effect='deny' AND denied.status='active' AND denied.revoked_at IS NULL
        AND datetime(denied.valid_from)<=datetime('now')
        AND (denied.expires_at IS NULL OR datetime(denied.expires_at)>datetime('now'))
        AND ((denied.scope_type='workspace' AND denied.scope_public_id=?) OR EXISTS (
          SELECT 1 FROM lineage WHERE lineage.entity_type=denied.scope_type AND lineage.public_id=denied.scope_public_id
        ))
    )
    AND (?<>'true' OR NOT EXISTS (
      SELECT 1 FROM portal_v2_identity_denials denial
      WHERE denial.identity_id=? AND denial.status='active' AND denial.revoked_at IS NULL
        AND datetime(denial.valid_from)<=datetime('now')
        AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
        AND (denial.scope_type='global'
          OR (denial.scope_type='workspace' AND denial.workspace_id=? AND denial.scope_public_id=?)
          OR (denial.workspace_id=? AND EXISTS (
            SELECT 1 FROM lineage WHERE lineage.entity_type=denial.scope_type AND lineage.public_id=denial.scope_public_id
          )))
    ))
) SELECT * FROM authorized LIMIT 2`;

export async function authorizeClientViewerAssociation(
  env: Env,
  input: ClientViewerSessionRequestV1,
): Promise<AssociationRow | null> {
  if (env.CLIENT_VIEWER_SESSION_ISSUER_ENABLED !== "true" || env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED !== "true")
    return null;
  const result = await db(env).prepare(AUTHORIZED_ASSOCIATION_SQL).bind(
    input.legacyAccountId,
    input.identityId, input.principalIssuer, input.principalSubject,
    input.workspaceId,
    input.legacyIdentityId,
    input.associationId, input.projectId,
    input.workspaceId, input.workspaceId,
    input.workspaceId, input.identityId, input.workspaceId,
    input.workspaceId, input.identityId, input.workspaceId,
    input.workspaceId, input.identityId, input.workspaceId,
    input.workspaceId, input.identityId, input.workspaceId,
    input.workspaceId, input.identityId, input.workspaceId,
    env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED || "false",
    input.identityId, input.workspaceId, input.workspaceId, input.workspaceId,
  ).all<AssociationRow>();
  return result.results.length === 1 ? result.results[0]! : null;
}

function failure(code: Exclude<ClientViewerSessionResultV1, { ok: true }>["code"]): ClientViewerSessionResultV1 {
  return { ok: false, protocolVersion: 1, code };
}

export async function issueClientViewerSession(
  env: Env,
  request: ClientViewerSessionRequestV1,
): Promise<ClientViewerSessionResultV1> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) return failure("invalid_request");
  if (env.CLIENT_VIEWER_SESSION_ISSUER_ENABLED !== "true") return failure("configuration_error");
  try {
    const association = await authorizeClientViewerAssociation(env, parsed.data);
    if (!association) return failure("denied");
    const grant = await issueViewerSession({
      env,
      actorId: parsed.data.identityId,
      audience: "client",
      association,
      idempotencyKey: parsed.data.idempotencyKey,
    });
    return { ok: true, protocolVersion: 1, ...grant };
  } catch (error) {
    if (error instanceof ViewerServiceError) return failure(
      error.code === "not_configured" || error.code === "invalid_configuration"
        ? "configuration_error"
        : error.code === "not_found" ? "not_found" : "temporarily_unavailable",
    );
    return failure("temporarily_unavailable");
  }
}

export class ViewerSessionIssuer extends WorkerEntrypoint<Env> {
  async issueClientViewerSession(request: ClientViewerSessionRequestV1): Promise<ClientViewerSessionResultV1> {
    return issueClientViewerSession(this.env, request);
  }
}
