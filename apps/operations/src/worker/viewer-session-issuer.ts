import {
  type ClientViewerShareAuthorizationV1,
  type ClientViewerShareCreateRequestV1,
  type ClientViewerShareCreateResultV1,
  type ClientViewerShareListRequestV1,
  type ClientViewerShareListResultV1,
  type ClientViewerShareRevokeRequestV1,
  type ClientViewerShareRevokeResultV1,
  type ClientViewerShareResultCodeV1,
  type ClientViewerSessionRequestV1,
  type ClientViewerSessionResultV1,
  ViewerServiceError,
} from "@ltds/shared";
import { z } from "zod";
import type { Env } from "./types";
import { issueViewerSession, type AssociationRow } from "./viewer-integration";
import { hmac, sha256 } from "./crypto";
import { viewerPublicSharesEnabled, viewerServiceClient } from "./viewer-integration";

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
  displayUnits: z.enum(["imperial", "metric"]),
}).strict();

const shareAuthorizationSchema = requestSchema.omit({ idempotencyKey: true, displayUnits: true });
const shareCreateSchema = shareAuthorizationSchema.extend({
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  label: z.string().trim().max(120).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  password: z.string().min(8).max(128).optional(),
  displayUnits: z.enum(["imperial", "metric"]),
}).strict();
const shareRevokeSchema = shareAuthorizationSchema.extend({
  shareId: opaqueId,
  idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
}).strict();

function db(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return candidate.withSession?.("first-primary") ?? candidate;
}

export async function pruneClientViewerShareReceipts(env: Pick<Env, "DELIVERY_DB">): Promise<number> {
  const database = db(env as Env);
  const expired = await database.prepare(`UPDATE client_viewer_share_revocation_receipts SET response_json=NULL WHERE rowid IN (
    SELECT rowid FROM client_viewer_share_revocation_receipts
    WHERE response_json IS NOT NULL AND datetime(created_at)<=datetime('now','-90 days') LIMIT 500
  )`).run();
  // Source-authorization rows are deliberately retained as compact security
  // tombstones. Removing their identity/idempotency uniqueness could permit a
  // lost-response retry to mint a second public share after upstream expiry.
  return expired.meta.changes || 0;
}

const AUTHORIZED_ASSOCIATION_SQL = (capability: "delivery.view" | "viewer.share.create") => `WITH RECURSIVE live AS (
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
        WHERE allowed_expiry.workspace_id=? AND allowed_expiry.identity_id=? AND allowed_expiry.capability='${capability}'
          AND allowed_expiry.effect='allow' AND allowed_expiry.status='active' AND allowed_expiry.revoked_at IS NULL
          AND datetime(allowed_expiry.valid_from)<=datetime('now') AND allowed_expiry.expires_at IS NOT NULL
          AND datetime(allowed_expiry.expires_at)>datetime('now')
          AND ((allowed_expiry.scope_type='workspace' AND allowed_expiry.scope_public_id=?) OR EXISTS (
            SELECT 1 FROM lineage WHERE lineage.entity_type=allowed_expiry.scope_type AND lineage.public_id=allowed_expiry.scope_public_id
          ))
      )
      WHEN (SELECT MIN(allowed_expiry.expires_at) FROM portal_v2_entitlements allowed_expiry
        WHERE allowed_expiry.workspace_id=? AND allowed_expiry.identity_id=? AND allowed_expiry.capability='${capability}'
          AND allowed_expiry.effect='allow' AND allowed_expiry.status='active' AND allowed_expiry.revoked_at IS NULL
          AND datetime(allowed_expiry.valid_from)<=datetime('now') AND allowed_expiry.expires_at IS NOT NULL
          AND datetime(allowed_expiry.expires_at)>datetime('now')
          AND ((allowed_expiry.scope_type='workspace' AND allowed_expiry.scope_public_id=?) OR EXISTS (
            SELECT 1 FROM lineage WHERE lineage.entity_type=allowed_expiry.scope_type AND lineage.public_id=allowed_expiry.scope_public_id
          ))) IS NULL THEN live.membership_expires_at
      ELSE MIN(live.membership_expires_at, (SELECT MIN(allowed_expiry.expires_at) FROM portal_v2_entitlements allowed_expiry
        WHERE allowed_expiry.workspace_id=? AND allowed_expiry.identity_id=? AND allowed_expiry.capability='${capability}'
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
      WHERE allowed.workspace_id=? AND allowed.identity_id=? AND allowed.capability='${capability}'
        AND allowed.effect='allow' AND allowed.status='active' AND allowed.revoked_at IS NULL
        AND datetime(allowed.valid_from)<=datetime('now')
        AND (allowed.expires_at IS NULL OR datetime(allowed.expires_at)>datetime('now'))
        AND ((allowed.scope_type='workspace' AND allowed.scope_public_id=?) OR EXISTS (
          SELECT 1 FROM lineage WHERE lineage.entity_type=allowed.scope_type AND lineage.public_id=allowed.scope_public_id
        ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM portal_v2_entitlements denied
      WHERE denied.workspace_id=? AND denied.identity_id=? AND denied.capability='${capability}'
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
  capability: "delivery.view" | "viewer.share.create" = "delivery.view",
): Promise<AssociationRow | null> {
  if (env.CLIENT_VIEWER_SESSION_ISSUER_ENABLED !== "true" || env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED !== "true")
    return null;
  const result = await db(env).prepare(AUTHORIZED_ASSOCIATION_SQL(capability)).bind(
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

function shareFailure(code: ClientViewerShareResultCodeV1): {
  ok: false;
  protocolVersion: 1;
  code: ClientViewerShareResultCodeV1;
} {
  return { ok: false, protocolVersion: 1, code };
}

function authorizationRequest(input: ClientViewerShareAuthorizationV1): ClientViewerSessionRequestV1 {
  return { ...input, idempotencyKey: "authorization-check", displayUnits: "imperial" };
}

function minimumExpiry(...values: Array<string | null | undefined>): string | null {
  const dates = values.filter((value): value is string => Boolean(value)).map(value => Date.parse(value));
  return dates.length ? new Date(Math.min(...dates)).toISOString() : null;
}

async function authorizedForClientShare(env: Env, input: ClientViewerShareAuthorizationV1): Promise<{
  association: AssociationRow;
  expiresAt: string | null;
} | null> {
  const request = authorizationRequest(input);
  const [view, share] = await Promise.all([
    authorizeClientViewerAssociation(env, request, "delivery.view"),
    authorizeClientViewerAssociation(env, request, "viewer.share.create"),
  ]);
  if (!view || !share || view.id !== share.id || view.association_version !== share.association_version)
    return null;
  return { association: view, expiresAt: minimumExpiry(view.authorization_expires_at, share.authorization_expires_at) };
}

interface SourceAuthorizationRow {
  id: string;
  authorization_version: number;
  workspace_id: string;
  identity_id: string;
  legacy_account_id: string;
  legacy_identity_id: string;
  principal_issuer: string;
  principal_subject: string;
  project_id: string;
  association_id: string;
  association_version: number;
  viewer_model_id: string;
  viewer_model_version_id: string;
  authorization_expires_at: string | null;
  idempotency_key: string;
  request_fingerprint: string;
  status: "pending" | "active" | "revoked";
  share_id: string | null;
  last_denial_reason: string | null;
  last_denial_at: string | null;
}

function parseStored<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

async function auditClientViewerShare(env: Env, input: {
  actorId: string;
  action: "viewer.client_share.created" | "viewer.client_share.create_replayed" | "viewer.client_share.revoked";
  shareId: string;
  authorizationId: string;
  modelId: string;
}): Promise<void> {
  await env.OPS_DB.prepare(`INSERT INTO audit_events(actor_type,actor_id,action,entity_type,entity_id,details_json)
    VALUES('client',? ,?,'viewer_public_share',?,?)`).bind(
    input.actorId, input.action, input.shareId,
    JSON.stringify({ authorizationId: input.authorizationId, modelId: input.modelId }),
  ).run();
}

async function recordSourceAuthorizationDenial(env: Env, source: SourceAuthorizationRow, reason: string): Promise<void> {
  const updated = await db(env).prepare(`UPDATE client_viewer_source_authorizations SET
    last_denial_reason=?,last_denial_at=datetime('now'),updated_at=datetime('now')
    WHERE id=? AND (last_denial_reason IS NOT ? OR last_denial_at IS NULL OR datetime(last_denial_at)<=datetime('now','-5 minutes'))`)
    .bind(reason, source.id, reason).run();
  if (!updated.meta.changes) return;
  await env.OPS_DB.prepare(`INSERT INTO audit_events(actor_type,actor_id,action,entity_type,entity_id,details_json)
    VALUES('integration','viewer','viewer.client_share.authorization_denied','viewer_source_authorization',?,?)`).bind(
    source.id, JSON.stringify({ reason, shareId: source.share_id, modelId: source.viewer_model_id }),
  ).run();
}

export async function createClientViewerShare(
  env: Env,
  request: ClientViewerShareCreateRequestV1,
): Promise<ClientViewerShareCreateResultV1> {
  const parsed = shareCreateSchema.safeParse(request);
  if (!parsed.success) return shareFailure("invalid_request");
  if (env.CLIENT_VIEWER_SHARES_ENABLED !== "true" || !viewerPublicSharesEnabled(env))
    return shareFailure("configuration_error");
  try {
    const authorization = await authorizedForClientShare(env, parsed.data);
    if (!authorization) return shareFailure("denied");
    const requestedExpiry = parsed.data.expiresAt;
    if (requestedExpiry && Date.parse(requestedExpiry) <= Date.now()) return shareFailure("invalid_request");
    if (authorization.expiresAt && requestedExpiry && Date.parse(requestedExpiry) > Date.parse(authorization.expiresAt))
      return shareFailure("denied");
    const effectiveExpiry = minimumExpiry(requestedExpiry, authorization.expiresAt);
    const fingerprint = await hmac(env.VIEWER_SERVICE_HMAC_SECRET || "", `ltds-client-viewer-share-request:v1\n${JSON.stringify({
      associationId: parsed.data.associationId,
      associationVersion: authorization.association.association_version,
      modelId: authorization.association.viewer_model_id,
      modelVersionId: authorization.association.viewer_model_version_id,
      label: parsed.data.label,
      expiresAt: effectiveExpiry,
      password: parsed.data.password || null,
      displayUnits: parsed.data.displayUnits,
      permissions: { view: true, measure: true, cameras: true, download: false },
    })}`);
    const authorizationId = `client-viewer-${(await sha256(`${parsed.data.identityId}\n${parsed.data.idempotencyKey}`)).slice(0, 40)}`;
    await db(env).prepare(`INSERT OR IGNORE INTO client_viewer_source_authorizations(
      id,workspace_id,identity_id,legacy_account_id,legacy_identity_id,principal_issuer,principal_subject,
      project_id,association_id,association_version,viewer_model_id,viewer_model_version_id,
      authorization_expires_at,idempotency_key,request_fingerprint)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      authorizationId, parsed.data.workspaceId, parsed.data.identityId, parsed.data.legacyAccountId,
      parsed.data.legacyIdentityId, parsed.data.principalIssuer, parsed.data.principalSubject,
      parsed.data.projectId, parsed.data.associationId, authorization.association.association_version,
      authorization.association.viewer_model_id, authorization.association.viewer_model_version_id,
      effectiveExpiry, parsed.data.idempotencyKey, fingerprint,
    ).run();
    const reserved = await db(env).prepare(`SELECT * FROM client_viewer_source_authorizations
      WHERE identity_id=? AND idempotency_key=?`).bind(parsed.data.identityId, parsed.data.idempotencyKey)
      .first<SourceAuthorizationRow>();
    if (!reserved || reserved.request_fingerprint !== fingerprint) return shareFailure("idempotency_conflict");
    const replayed = reserved.status === "active";
    const viewerIdempotencyKey = `client-share-${(await sha256(`create\n${reserved.id}`)).slice(0, 43)}`;
    const creation = await viewerServiceClient(env).createPublicShare({
      modelId: authorization.association.viewer_model_id,
      idempotencyKey: viewerIdempotencyKey,
      createdBy: parsed.data.identityId,
      label: parsed.data.label,
      expiresAt: effectiveExpiry,
      displayUnits: parsed.data.displayUnits,
      ...(parsed.data.password ? { password: parsed.data.password } : {}),
      shareClass: "client",
      sourceAuthorization: {
        type: "client_grant",
        id: reserved.id,
        version: reserved.authorization_version,
        subject: parsed.data.principalSubject,
        expiresAt: effectiveExpiry,
      },
    });
    const result: ClientViewerShareCreateResultV1 = { ok: true, protocolVersion: 1, replayed, creation };
    if (replayed) {
      await auditClientViewerShare(env, {
        actorId: parsed.data.identityId,
        action: "viewer.client_share.create_replayed",
        shareId: creation.share.id,
        authorizationId: reserved.id,
        modelId: authorization.association.viewer_model_id,
      });
      return result;
    }
    const updated = await db(env).prepare(`UPDATE client_viewer_source_authorizations SET
      status='active',share_id=?,updated_at=datetime('now')
      WHERE id=? AND request_fingerprint=? AND status='pending'`).bind(
      creation.share.id, reserved.id, fingerprint,
    ).run();
    if (!updated.meta.changes) {
      const latestShare = await db(env).prepare("SELECT share_id FROM client_viewer_source_authorizations WHERE id=? AND status='active'")
        .bind(reserved.id).first<string>("share_id");
      if (latestShare === creation.share.id) return { ...result, replayed: true };
      return shareFailure("temporarily_unavailable");
    }
    await auditClientViewerShare(env, {
      actorId: parsed.data.identityId,
      action: "viewer.client_share.created",
      shareId: creation.share.id,
      authorizationId: reserved.id,
      modelId: authorization.association.viewer_model_id,
    });
    return result;
  } catch {
    return shareFailure("temporarily_unavailable");
  }
}

export async function listClientViewerShares(
  env: Env,
  request: ClientViewerShareListRequestV1,
): Promise<ClientViewerShareListResultV1> {
  const parsed = shareAuthorizationSchema.safeParse(request);
  if (!parsed.success) return shareFailure("invalid_request");
  if (env.CLIENT_VIEWER_SHARES_ENABLED !== "true" || !viewerPublicSharesEnabled(env))
    return shareFailure("configuration_error");
  try {
    if (!await authorizedForClientShare(env, parsed.data)) return shareFailure("denied");
    const rows = await db(env).prepare(`SELECT id,share_id FROM client_viewer_source_authorizations
      WHERE identity_id=? AND association_id=? AND status='active' AND share_id IS NOT NULL`)
      .bind(parsed.data.identityId, parsed.data.associationId).all<{ id: string; share_id: string }>();
    const authorized = new Map(rows.results.map(row => [row.share_id, row.id]));
    const association = await authorizeClientViewerAssociation(env, authorizationRequest(parsed.data));
    if (!association) return shareFailure("denied");
    const shares = (await viewerServiceClient(env).listPublicShares(association.viewer_model_id)).filter(share =>
      share.shareClass === "client" && share.sourceAuthorization?.subject === parsed.data.principalSubject &&
      authorized.get(share.id) === share.sourceAuthorization.id,
    );
    return { ok: true, protocolVersion: 1, shares };
  } catch {
    return shareFailure("temporarily_unavailable");
  }
}

export async function revokeClientViewerShare(
  env: Env,
  request: ClientViewerShareRevokeRequestV1,
): Promise<ClientViewerShareRevokeResultV1> {
  const parsed = shareRevokeSchema.safeParse(request);
  if (!parsed.success) return shareFailure("invalid_request");
  if (env.CLIENT_VIEWER_SHARES_ENABLED !== "true" || !viewerPublicSharesEnabled(env))
    return shareFailure("configuration_error");
  try {
    const prior = await db(env).prepare(`SELECT share_id,response_json FROM client_viewer_share_revocation_receipts
      WHERE identity_id=? AND idempotency_key=?`).bind(parsed.data.identityId, parsed.data.idempotencyKey)
      .first<{ share_id: string; response_json: string | null }>();
    if (prior) {
      if (prior.share_id !== parsed.data.shareId) return shareFailure("idempotency_conflict");
      const replay = parseStored<ClientViewerShareRevokeResultV1>(prior.response_json);
      if (replay?.ok) return { ...replay, replayed: true };
    }
    const source = await db(env).prepare(`SELECT * FROM client_viewer_source_authorizations
      WHERE share_id=? AND identity_id=? AND workspace_id=? AND association_id=? AND principal_subject=?`)
      .bind(parsed.data.shareId, parsed.data.identityId, parsed.data.workspaceId, parsed.data.associationId, parsed.data.principalSubject)
      .first<SourceAuthorizationRow>();
    if (!source) return shareFailure("not_found");
    const share = await viewerServiceClient(env).revokePublicShare({
      shareId: parsed.data.shareId,
      idempotencyKey: `client-share-revoke-${(await sha256(`revoke\n${parsed.data.identityId}\n${parsed.data.shareId}\n${parsed.data.idempotencyKey}`)).slice(0, 43)}`,
      reason: "client_owner_revoked",
    });
    const result: ClientViewerShareRevokeResultV1 = { ok: true, protocolVersion: 1, replayed: Boolean(prior), share };
    await db(env).batch([
      db(env).prepare(`UPDATE client_viewer_source_authorizations SET status='revoked',revoked_at=datetime('now'),updated_at=datetime('now')
        WHERE id=?`).bind(source.id),
      db(env).prepare(`INSERT INTO client_viewer_share_revocation_receipts(identity_id,idempotency_key,share_id,response_json)
        VALUES(?,?,?,?) ON CONFLICT(identity_id,idempotency_key) DO UPDATE SET response_json=excluded.response_json
        WHERE client_viewer_share_revocation_receipts.share_id=excluded.share_id`)
        .bind(parsed.data.identityId, parsed.data.idempotencyKey, parsed.data.shareId, JSON.stringify(result)),
    ]);
    await auditClientViewerShare(env, {
      actorId: parsed.data.identityId,
      action: "viewer.client_share.revoked",
      shareId: parsed.data.shareId,
      authorizationId: source.id,
      modelId: source.viewer_model_id,
    });
    return result;
  } catch {
    return shareFailure("temporarily_unavailable");
  }
}

export async function introspectClientViewerSourceAuthorization(env: Env, input: {
  authorizationId: string;
  authorizationVersion: number;
  subject: string;
  modelId: string;
  shareId: string;
}): Promise<{ active: boolean; authorizationId: string; authorizationVersion: number; subject: string; modelId: string; expiresAt: string | null }> {
  const inactive = { active: false, authorizationId: input.authorizationId, authorizationVersion: input.authorizationVersion,
    subject: input.subject, modelId: input.modelId, expiresAt: null };
  if (env.CLIENT_VIEWER_SHARES_ENABLED !== "true" || !viewerPublicSharesEnabled(env)) return inactive;
  const source = await db(env).prepare(`SELECT * FROM client_viewer_source_authorizations
    WHERE id=? AND authorization_version=? AND principal_subject=? AND viewer_model_id=? AND share_id=?
      AND status='active' AND revoked_at IS NULL`).bind(
    input.authorizationId, input.authorizationVersion, input.subject, input.modelId, input.shareId,
  ).first<SourceAuthorizationRow>();
  if (!source) return inactive;
  if (source.authorization_expires_at && Date.parse(source.authorization_expires_at) <= Date.now()) {
    await recordSourceAuthorizationDenial(env, source, "source_expired");
    return inactive;
  }
  const live = await authorizedForClientShare(env, {
    protocolVersion: 1,
    workspaceId: source.workspace_id,
    identityId: source.identity_id,
    legacyAccountId: source.legacy_account_id,
    legacyIdentityId: source.legacy_identity_id,
    principalIssuer: source.principal_issuer,
    principalSubject: source.principal_subject,
    projectId: source.project_id,
    associationId: source.association_id,
  });
  if (!live) {
    await recordSourceAuthorizationDenial(env, source, "live_authorization_denied");
    return inactive;
  }
  if (live.association.association_version !== source.association_version ||
    live.association.viewer_model_id !== source.viewer_model_id ||
    live.association.viewer_model_version_id !== source.viewer_model_version_id) {
    await recordSourceAuthorizationDenial(env, source, "association_version_mismatch");
    return inactive;
  }
  const expiresAt = minimumExpiry(source.authorization_expires_at, live.expiresAt);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await recordSourceAuthorizationDenial(env, source, "live_authorization_expired");
    return inactive;
  }
  return { ...inactive, active: true, expiresAt };
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
      displayUnits: parsed.data.displayUnits,
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
