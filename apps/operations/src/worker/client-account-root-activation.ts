import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "./types";

export interface ClientAccountRootActivationAccount {
  id: string;
  displayName: string;
  status: string;
  projectAlphaClientId: string | null;
  projectAlphaOrganizationId: string | null;
  updatedAt: string;
  activationState: "unlinked" | "linked" | "projection_missing" | "manual_review" | "projected";
}

export interface ClientAccountRootSource {
  clientId: string;
  clientName: string;
  organizationId: string | null;
  organizationName: string | null;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
}

interface AccountRow {
  id: string;
  display_name: string;
  status: string;
  project_alpha_client_id: string | null;
  project_alpha_organization_id: string | null;
  updated_at: string;
}

interface SourceRow {
  client_id: string;
  client_name: string;
  organization_id: string | null;
  organization_name: string | null;
  client_last_sync_id: string;
  client_updated_at: string;
  organization_last_sync_id: string | null;
  organization_updated_at: string | null;
}

type ProjectionState = "missing" | "partial_or_conflicting" | "complete";

function deliveryDatabase(env: Env): D1DatabaseSession {
  return env.DELIVERY_DB.withSession("first-primary");
}

async function workspaceSchemaPresent(db: D1DatabaseSession): Promise<boolean> {
  return (await db.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='portal_v2_workspaces'",
  ).first("ok")) !== null;
}

async function tablePresent(db: D1DatabaseSession, name: string): Promise<boolean> {
  return (await db.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name=?",
  ).bind(name).first("ok")) !== null;
}

async function workspaceProjectionSchemaComplete(db: D1DatabaseSession): Promise<boolean> {
  const required = [
    "portal_v2_identities",
    "portal_v2_workspaces",
    "portal_v2_workspace_memberships",
    "portal_v2_directory_generations",
    "portal_v2_directory_entities",
    "portal_v2_directory_checkpoints",
    "portal_v2_entitlements",
    "portal_v2_folder_bindings",
  ];
  const present = await Promise.all(required.map(name => tablePresent(db, name)));
  return present.every(Boolean);
}

function sameSourceVersion(left: SourceRow, right: SourceRow): boolean {
  return left.client_id === right.client_id
    && left.client_name === right.client_name
    && left.organization_id === right.organization_id
    && left.organization_name === right.organization_name
    && left.client_last_sync_id === right.client_last_sync_id
    && left.client_updated_at === right.client_updated_at
    && left.organization_last_sync_id === right.organization_last_sync_id
    && left.organization_updated_at === right.organization_updated_at;
}

const SOURCE_SELECT = `SELECT client.id client_id,client.name client_name,
  client.organization_id,organization.name organization_name,
  client.last_sync_id client_last_sync_id,client.updated_at client_updated_at,
  organization.last_sync_id organization_last_sync_id,
  organization.updated_at organization_updated_at
  FROM pa_clients client
  LEFT JOIN pa_organizations organization
    ON organization.id=client.organization_id AND organization.active=1`;

async function activeSource(
  env: Env,
  clientId: string,
): Promise<SourceRow | null> {
  return env.OPS_DB.withSession("first-primary").prepare(`${SOURCE_SELECT}
    WHERE client.id=? AND client.active=1
      AND (client.organization_id IS NULL OR organization.id IS NOT NULL)`)
    .bind(clientId).first<SourceRow>();
}

function sourceFromRow(row: SourceRow): ClientAccountRootSource {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    rootType: row.organization_id ? "organization" : "standalone_client",
    rootPublicId: row.organization_id ?? row.client_id,
  };
}

function projectionIds(accountId: string) {
  return {
    workspaceId: `workspace-${accountId}`,
    generationId: `legacy-generation-${accountId}`,
  };
}

function baselineProjectionCondition(hasGenerationContract: boolean): string {
  const contract = hasGenerationContract
    ? `AND EXISTS (SELECT 1 FROM portal_v2_directory_generation_contracts contract
        WHERE contract.generation_id=e.generation_id AND contract.workspace_id=e.workspace_id
          AND contract.schema_version=2)`
    : "";
  return `EXISTS (SELECT 1 FROM portal_v2_workspaces workspace
      WHERE workspace.id=e.workspace_id AND workspace.legacy_account_id=e.account_id
        AND workspace.root_type=e.root_type
        AND workspace.pa_organization_public_id IS e.organization_id
        AND workspace.pa_client_public_id IS e.standalone_client_id
        AND workspace.status='active')
    AND EXISTS (SELECT 1 FROM portal_v2_directory_generations generation
      WHERE generation.id=e.generation_id AND generation.workspace_id=e.workspace_id
        AND generation.source_generation='legacy-backfill' AND generation.source_sequence=0
        AND generation.status='active' AND generation.complete=1)
    AND NOT EXISTS (SELECT 1 FROM portal_v2_directory_generations generation
      WHERE generation.workspace_id=e.workspace_id AND generation.id<>e.generation_id)
    ${contract}
    AND EXISTS (SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
      WHERE checkpoint.workspace_id=e.workspace_id
        AND checkpoint.active_generation_id=e.generation_id AND checkpoint.source_sequence=0)
    AND EXISTS (SELECT 1 FROM portal_v2_directory_entities entity
      WHERE entity.workspace_id=e.workspace_id AND entity.generation_id=e.generation_id
        AND entity.entity_type=e.root_type AND entity.public_id=e.root_id
        AND entity.parent_public_id IS NULL AND entity.source_version='legacy-backfill'
        AND entity.active=1 AND entity.primary_contact=0 AND entity.safe_metadata_json='{}')
    AND NOT EXISTS (SELECT 1 FROM client_identity_links identity
      LEFT JOIN portal_v2_identities projected ON projected.id=identity.id
      WHERE identity.account_id=e.account_id AND (
        projected.id IS NULL OR projected.issuer<>identity.issuer
        OR projected.subject<>identity.subject
        OR projected.verified_email IS NOT identity.email
        OR projected.status<>CASE WHEN identity.revoked_at IS NULL THEN 'active' ELSE 'revoked' END
        OR projected.revoked_at IS NOT identity.revoked_at))
    AND NOT EXISTS (SELECT 1 FROM client_account_members member
      JOIN client_identity_links identity
        ON identity.id=member.identity_id AND identity.account_id=member.account_id
      LEFT JOIN portal_v2_workspace_memberships projected
        ON projected.id='legacy-membership-' || member.account_id || '-' || member.identity_id
        AND projected.workspace_id=e.workspace_id AND projected.identity_id=member.identity_id
      WHERE member.account_id=e.account_id AND (
        projected.id IS NULL OR projected.source_type<>'legacy'
        OR projected.source_version IS NOT NULL OR projected.expires_at IS NOT NULL
        OR projected.status<>CASE WHEN member.revoked_at IS NULL AND identity.revoked_at IS NULL THEN 'active' ELSE 'revoked' END
        OR projected.revoked_at IS NOT COALESCE(member.revoked_at,identity.revoked_at)))
    AND NOT EXISTS (SELECT 1 FROM portal_v2_workspace_memberships projected
      WHERE projected.workspace_id=e.workspace_id AND NOT EXISTS (
        SELECT 1 FROM client_account_members member
        WHERE member.account_id=e.account_id
          AND projected.id='legacy-membership-' || member.account_id || '-' || member.identity_id
          AND projected.identity_id=member.identity_id))
    AND NOT EXISTS (SELECT 1 FROM client_project_grants grant_record
      JOIN projects project ON project.id=grant_record.project_id
      LEFT JOIN portal_v2_directory_entities entity
        ON entity.workspace_id=e.workspace_id AND entity.generation_id=e.generation_id
        AND entity.entity_type='project' AND entity.public_id=project.project_alpha_project_id
      WHERE grant_record.account_id=e.account_id AND grant_record.revoked_at IS NULL
        AND project.project_alpha_project_id IS NOT NULL
        AND (entity.public_id IS NULL OR entity.parent_public_id<>e.root_id
          OR entity.display_name<>project.project_name OR entity.source_version<>'legacy-backfill'
          OR entity.active<>project.active OR entity.primary_contact<>0 OR entity.safe_metadata_json<>'{}'))
    AND NOT EXISTS (SELECT 1 FROM portal_v2_directory_entities entity
      WHERE entity.workspace_id=e.workspace_id AND entity.generation_id=e.generation_id
        AND NOT (entity.entity_type=e.root_type AND entity.public_id=e.root_id)
        AND NOT (entity.entity_type='project' AND EXISTS (
          SELECT 1 FROM client_project_grants grant_record JOIN projects project
            ON project.id=grant_record.project_id
          WHERE grant_record.account_id=e.account_id AND grant_record.revoked_at IS NULL
            AND project.project_alpha_project_id=entity.public_id)))
    AND NOT EXISTS (SELECT 1 FROM portal_v2_workspace_memberships membership
      LEFT JOIN portal_v2_entitlements entitlement
        ON entitlement.id='legacy-entitlement-' || e.account_id || '-' || membership.identity_id || '-workspace-view'
        AND entitlement.workspace_id=e.workspace_id AND entitlement.identity_id=membership.identity_id
      WHERE membership.workspace_id=e.workspace_id AND membership.source_type='legacy'
        AND (entitlement.id IS NULL OR entitlement.capability<>'workspace.view'
          OR entitlement.effect<>'allow' OR entitlement.scope_type<>'workspace'
          OR entitlement.scope_public_id<>e.workspace_id OR entitlement.source_type<>'legacy'
          OR datetime(entitlement.valid_from)>datetime('now')
          OR entitlement.entitlement_version<>1 OR entitlement.source_version IS NOT NULL
          OR entitlement.expires_at IS NOT NULL OR entitlement.revoked_at IS NOT NULL
          OR entitlement.replaced_by_id IS NOT NULL OR entitlement.status<>membership.status))
    AND NOT EXISTS (SELECT 1 FROM client_account_members member
      JOIN (SELECT 'directory.read' capability UNION ALL SELECT 'member.manage') capability
      LEFT JOIN portal_v2_entitlements entitlement
        ON entitlement.id='legacy-entitlement-' || member.account_id || '-' || member.identity_id || '-' || capability.capability
        AND entitlement.workspace_id=e.workspace_id AND entitlement.identity_id=member.identity_id
      WHERE member.account_id=e.account_id AND member.role='manager'
        AND (entitlement.id IS NULL OR entitlement.capability<>capability.capability
          OR entitlement.effect<>'allow' OR entitlement.scope_type<>'workspace'
          OR entitlement.scope_public_id<>e.workspace_id OR entitlement.source_type<>'legacy'
          OR datetime(entitlement.valid_from)>datetime('now')
          OR entitlement.entitlement_version<>1 OR entitlement.source_version IS NOT NULL
          OR entitlement.expires_at IS NOT NULL OR entitlement.revoked_at IS NOT NULL
          OR entitlement.replaced_by_id IS NOT NULL
          OR entitlement.status<>CASE WHEN member.revoked_at IS NULL THEN 'active' ELSE 'revoked' END))
    AND NOT EXISTS (SELECT 1 FROM client_account_members member
      JOIN client_project_grants grant_record ON grant_record.account_id=member.account_id
      JOIN projects project ON project.id=grant_record.project_id
        AND project.project_alpha_project_id IS NOT NULL
      LEFT JOIN client_member_project_grants member_grant
        ON member_grant.account_id=member.account_id AND member_grant.identity_id=member.identity_id
        AND member_grant.project_id=grant_record.project_id AND member_grant.revoked_at IS NULL
      LEFT JOIN portal_v2_entitlements entitlement
        ON entitlement.id='legacy-entitlement-' || member.account_id || '-' || member.identity_id
          || '-' || project.project_alpha_project_id || '-delivery'
        AND entitlement.workspace_id=e.workspace_id AND entitlement.identity_id=member.identity_id
      WHERE member.account_id=e.account_id AND (member.role='manager' OR member_grant.project_id IS NOT NULL)
        AND (entitlement.id IS NULL OR entitlement.capability<>'delivery.view'
          OR entitlement.effect<>'allow' OR entitlement.scope_type<>'project'
          OR entitlement.scope_public_id<>project.project_alpha_project_id
          OR entitlement.source_type<>'legacy'
          OR datetime(entitlement.valid_from)>datetime('now')
          OR entitlement.entitlement_version<>1 OR entitlement.source_version IS NOT NULL
          OR entitlement.expires_at IS NOT NULL OR entitlement.revoked_at IS NOT NULL
          OR entitlement.replaced_by_id IS NOT NULL
          OR entitlement.status<>CASE WHEN member.revoked_at IS NULL AND grant_record.revoked_at IS NULL THEN 'active' ELSE 'revoked' END))
    AND NOT EXISTS (SELECT 1 FROM client_account_members member
      JOIN client_project_grants grant_record ON grant_record.account_id=member.account_id
      JOIN projects project ON project.id=grant_record.project_id
        AND project.project_alpha_project_id IS NOT NULL
      LEFT JOIN client_member_project_grants member_grant
        ON member_grant.account_id=member.account_id AND member_grant.identity_id=member.identity_id
        AND member_grant.project_id=grant_record.project_id AND member_grant.revoked_at IS NULL
      LEFT JOIN portal_v2_entitlements entitlement
        ON entitlement.id='legacy-entitlement-' || member.account_id || '-' || member.identity_id
          || '-' || project.project_alpha_project_id || '-request'
        AND entitlement.workspace_id=e.workspace_id AND entitlement.identity_id=member.identity_id
      WHERE member.account_id=e.account_id AND (member.role='manager' OR member_grant.project_id IS NOT NULL)
        AND (entitlement.id IS NULL OR entitlement.capability<>'request.create'
          OR entitlement.effect<>'allow' OR entitlement.scope_type<>'project'
          OR entitlement.scope_public_id<>project.project_alpha_project_id
          OR entitlement.source_type<>'legacy'
          OR datetime(entitlement.valid_from)>datetime('now')
          OR entitlement.entitlement_version<>1 OR entitlement.source_version IS NOT NULL
          OR entitlement.expires_at IS NOT NULL OR entitlement.revoked_at IS NOT NULL
          OR entitlement.replaced_by_id IS NOT NULL
          OR entitlement.status<>CASE WHEN member.revoked_at IS NULL AND grant_record.revoked_at IS NULL
            AND grant_record.can_request_service=1 THEN 'active' ELSE 'revoked' END))
    AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements entitlement
      WHERE entitlement.workspace_id=e.workspace_id
        AND NOT EXISTS (SELECT 1 FROM portal_v2_workspace_memberships membership
          WHERE membership.workspace_id=e.workspace_id
            AND entitlement.id='legacy-entitlement-' || e.account_id || '-' || membership.identity_id || '-workspace-view')
        AND NOT EXISTS (SELECT 1 FROM client_account_members member
          JOIN (SELECT 'directory.read' capability UNION ALL SELECT 'member.manage') capabilities
          WHERE member.account_id=e.account_id AND member.role='manager'
            AND entitlement.id='legacy-entitlement-' || member.account_id || '-' || member.identity_id || '-' || capabilities.capability)
        AND NOT EXISTS (SELECT 1 FROM client_account_members member
          JOIN client_project_grants grant_record ON grant_record.account_id=member.account_id
          JOIN projects project ON project.id=grant_record.project_id AND project.project_alpha_project_id IS NOT NULL
          LEFT JOIN client_member_project_grants member_grant
            ON member_grant.account_id=member.account_id AND member_grant.identity_id=member.identity_id
            AND member_grant.project_id=grant_record.project_id AND member_grant.revoked_at IS NULL
          WHERE member.account_id=e.account_id AND (member.role='manager' OR member_grant.project_id IS NOT NULL)
            AND entitlement.id IN (
              'legacy-entitlement-' || member.account_id || '-' || member.identity_id || '-' || project.project_alpha_project_id || '-delivery',
              'legacy-entitlement-' || member.account_id || '-' || member.identity_id || '-' || project.project_alpha_project_id || '-request'
            )))
    AND NOT EXISTS (SELECT 1 FROM client_folder_associations folder
      LEFT JOIN projects project ON project.id=folder.project_id
      LEFT JOIN portal_v2_folder_bindings binding
        ON binding.id='legacy-folder-' || folder.id AND binding.workspace_id=e.workspace_id
      WHERE folder.account_id=e.account_id
        AND (folder.scope_type='client' OR project.project_alpha_project_id IS NOT NULL)
        AND (binding.id IS NULL
          OR binding.owner_scope_type<>CASE WHEN folder.scope_type='project' THEN 'project' ELSE e.root_type END
          OR binding.owner_public_id<>CASE WHEN folder.scope_type='project' THEN project.project_alpha_project_id ELSE e.root_id END
          OR binding.r2_prefix<>folder.r2_prefix OR binding.source_type<>'legacy'
          OR binding.source_version IS NOT NULL
          OR binding.status<>CASE WHEN folder.revoked_at IS NULL THEN 'active' ELSE 'revoked' END
          OR binding.revoked_at IS NOT folder.revoked_at))
    AND NOT EXISTS (SELECT 1 FROM portal_v2_folder_bindings binding
      WHERE binding.workspace_id=e.workspace_id AND NOT EXISTS (
        SELECT 1 FROM client_folder_associations folder LEFT JOIN projects project ON project.id=folder.project_id
        WHERE folder.account_id=e.account_id
          AND (folder.scope_type='client' OR project.project_alpha_project_id IS NOT NULL)
          AND binding.id='legacy-folder-' || folder.id))`;
}

function projectionExpectedCte(): string {
  return `WITH expected(account_id,workspace_id,generation_id,root_type,root_id,organization_id,standalone_client_id)
    AS (VALUES (?,?,?,?,?,?,?))`;
}

function projectionBindings(accountId: string, source: ClientAccountRootSource): unknown[] {
  const { workspaceId, generationId } = projectionIds(accountId);
  return [accountId, workspaceId, generationId, source.rootType, source.rootPublicId,
    source.organizationId, source.organizationId === null ? source.clientId : null];
}

async function baselineProjectionComplete(
  db: D1DatabaseSession,
  accountId: string,
  source: ClientAccountRootSource,
  hasGenerationContract: boolean,
): Promise<boolean> {
  const complete = await db.prepare(`${projectionExpectedCte()}
    SELECT CASE WHEN ${baselineProjectionCondition(hasGenerationContract)} THEN 1 ELSE 0 END complete
    FROM expected e`).bind(...projectionBindings(accountId, source)).first<number>("complete");
  return complete === 1;
}

async function authoritativeProjectionComplete(
  db: D1DatabaseSession,
  accountId: string,
  source: ClientAccountRootSource,
  hasGenerationContract: boolean,
): Promise<boolean> {
  if (!hasGenerationContract) return false;
  const complete = await db.prepare(`${projectionExpectedCte()}
    SELECT CASE WHEN
      EXISTS (SELECT 1 FROM portal_v2_workspaces workspace
        WHERE workspace.id=e.workspace_id AND workspace.legacy_account_id=e.account_id
          AND workspace.root_type=e.root_type
          AND workspace.pa_organization_public_id IS e.organization_id
          AND workspace.pa_client_public_id IS e.standalone_client_id
          AND workspace.status='active')
      AND EXISTS (
        SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
        JOIN portal_v2_directory_generations generation
          ON generation.id=checkpoint.active_generation_id
          AND generation.workspace_id=checkpoint.workspace_id
          AND generation.source_sequence=checkpoint.source_sequence
        JOIN portal_v2_directory_generation_contracts contract
          ON contract.generation_id=generation.id AND contract.workspace_id=generation.workspace_id
        JOIN portal_v2_directory_entities root_entity
          ON root_entity.workspace_id=generation.workspace_id
          AND root_entity.generation_id=generation.id
          AND root_entity.entity_type=e.root_type AND root_entity.public_id=e.root_id
        WHERE checkpoint.workspace_id=e.workspace_id AND checkpoint.source_sequence>0
          AND generation.status='active' AND generation.complete=1
          AND contract.schema_version IN (2,3)
          AND root_entity.parent_public_id IS NULL AND root_entity.active=1
      ) THEN 1 ELSE 0 END complete
    FROM expected e`).bind(...projectionBindings(accountId, source)).first<number>("complete");
  return complete === 1;
}

async function recognizedProjectionComplete(
  db: D1DatabaseSession,
  accountId: string,
  source: ClientAccountRootSource,
  hasGenerationContract: boolean,
): Promise<boolean> {
  return await baselineProjectionComplete(db, accountId, source, hasGenerationContract)
    || await authoritativeProjectionComplete(db, accountId, source, hasGenerationContract);
}

async function projectionState(
  db: D1DatabaseSession,
  accountId: string,
  source: ClientAccountRootSource,
  hasGenerationContract: boolean,
): Promise<ProjectionState> {
  const { workspaceId } = projectionIds(accountId);
  const rows = await db.prepare(`SELECT id,legacy_account_id,root_type,
      pa_organization_public_id,pa_client_public_id
    FROM portal_v2_workspaces
    WHERE id=? OR legacy_account_id=?
      OR (? IS NOT NULL AND pa_organization_public_id=?)
      OR pa_client_public_id=?
      OR (? IS NOT NULL AND pa_client_public_id=?)`)
    .bind(workspaceId, accountId, source.organizationId, source.organizationId,
      source.clientId,
      source.organizationId === null ? source.clientId : null,
      source.organizationId === null ? source.clientId : null)
    .all<{ id: string; legacy_account_id: string | null; root_type: string;
      pa_organization_public_id: string | null; pa_client_public_id: string | null }>();
  if (!rows.results.length) return "missing";
  if (rows.results.length !== 1) return "partial_or_conflicting";
  const row = rows.results[0];
  if (!row) return "partial_or_conflicting";
  if (row.id !== workspaceId || row.legacy_account_id !== accountId
    || row.root_type !== source.rootType
    || row.pa_organization_public_id !== source.organizationId
    || row.pa_client_public_id !== (source.organizationId === null ? source.clientId : null))
    return "partial_or_conflicting";
  return await recognizedProjectionComplete(db, accountId, source, hasGenerationContract)
    ? "complete"
    : "partial_or_conflicting";
}

/**
 * Read-only activation preflight. The UI uses this to make the one-time
 * legacy-account linkage explicit before migration 0121 creates its shadow
 * workspace. It never guesses a Project Alpha identity from a name or email.
 */
export async function listClientAccountRootActivation(env: Env): Promise<{
  workspaceMigrationApplied: boolean;
  accounts: ClientAccountRootActivationAccount[];
  sources: ClientAccountRootSource[];
}> {
  const db = deliveryDatabase(env);
  const [schemaPresent, accountsResult, sourceResult] = await Promise.all([
    workspaceSchemaPresent(db),
    db.prepare(`SELECT id,display_name,status,project_alpha_client_id,
      project_alpha_organization_id,updated_at
      FROM client_accounts ORDER BY lower(display_name),id`).all<AccountRow>(),
    env.OPS_DB.withSession("first-primary").prepare(`${SOURCE_SELECT}
      WHERE client.active=1
        AND (client.organization_id IS NULL OR organization.id IS NOT NULL)
      ORDER BY lower(COALESCE(organization.name,client.name)),lower(client.name),client.id`)
      .all<SourceRow>(),
  ]);

  const generationContractsPresent = schemaPresent
    ? await tablePresent(db, "portal_v2_directory_generation_contracts")
    : false;
  const projectionSchemaComplete = schemaPresent
    ? await workspaceProjectionSchemaComplete(db)
    : false;
  const projectionStates = new Map<string, ProjectionState>();
  if (schemaPresent) {
    const workspaces = await db.prepare(
      "SELECT id,legacy_account_id FROM portal_v2_workspaces",
    ).all<{ id: string; legacy_account_id: string | null }>();
    for (const account of accountsResult.results) {
      if (workspaces.results.some(workspace => workspace.id === `workspace-${account.id}`
        || workspace.legacy_account_id === account.id))
        projectionStates.set(account.id, "partial_or_conflicting");
    }
  }
  if (schemaPresent) await Promise.all(accountsResult.results.map(async (row) => {
    if (!row.project_alpha_client_id) return;
    const sourceRow = sourceResult.results.find(source => source.client_id === row.project_alpha_client_id);
    if (!sourceRow || row.project_alpha_organization_id !== sourceRow.organization_id) {
      projectionStates.set(row.id, "partial_or_conflicting");
      return;
    }
    projectionStates.set(row.id, projectionSchemaComplete
      ? await projectionState(db, row.id, sourceFromRow(sourceRow), generationContractsPresent)
      : "partial_or_conflicting");
  }));

  return {
    workspaceMigrationApplied: schemaPresent,
    accounts: accountsResult.results.map((row) => {
      const linked = Boolean(row.project_alpha_client_id || row.project_alpha_organization_id);
      return {
        id: row.id,
        displayName: row.display_name,
        status: row.status,
        projectAlphaClientId: row.project_alpha_client_id,
        projectAlphaOrganizationId: row.project_alpha_organization_id,
        updatedAt: row.updated_at,
        activationState: projectionStates.get(row.id) === "complete"
          ? "projected"
          : projectionStates.get(row.id) === "partial_or_conflicting"
            ? "manual_review"
          : linked && schemaPresent
            ? "projection_missing"
            : linked
              ? "linked"
              : "unlinked",
      };
    }),
    sources: sourceResult.results.map(sourceFromRow),
  };
}

function activationResult(
  accountId: string,
  source: ClientAccountRootSource,
  unchanged: boolean,
) {
  return {
    accountId,
    projectAlphaClientId: source.clientId,
    projectAlphaOrganizationId: source.organizationId,
    rootType: source.rootType,
    rootPublicId: source.rootPublicId,
    unchanged,
  };
}

async function duplicateLegacyRoot(
  db: D1DatabaseSession,
  accountId: string,
  source: ClientAccountRootSource,
): Promise<boolean> {
  const duplicate = source.organizationId
    ? await db.prepare(`SELECT id FROM client_accounts WHERE id<>?
        AND (project_alpha_client_id=? OR project_alpha_organization_id=?) LIMIT 1`)
      .bind(accountId, source.clientId, source.organizationId).first("id")
    : await db.prepare(`SELECT id FROM client_accounts WHERE id<>?
        AND project_alpha_client_id=? LIMIT 1`)
      .bind(accountId, source.clientId).first("id");
  return duplicate !== null;
}

function postMigrationProjectionStatements(
  db: D1DatabaseSession,
  principal: StaffPrincipal,
  account: AccountRow,
  sourceRow: SourceRow,
  expectedUpdatedAt: string,
  activatedAt: string,
  hasGenerationContract: boolean,
  repairExistingLink: boolean,
): D1PreparedStatement[] {
  const source = sourceFromRow(sourceRow);
  const { workspaceId, generationId } = projectionIds(account.id);
  const details = JSON.stringify({
    projectAlphaClientId: source.clientId,
    projectAlphaOrganizationId: source.organizationId,
    workspaceRootType: source.rootType,
    workspaceRootPublicId: source.rootPublicId,
    postMigrationProjection: true,
    projectionRepair: repairExistingLink,
    projectAlphaClientSyncId: sourceRow.client_last_sync_id,
    projectAlphaClientUpdatedAt: sourceRow.client_updated_at,
    projectAlphaOrganizationSyncId: sourceRow.organization_last_sync_id,
    projectAlphaOrganizationUpdatedAt: sourceRow.organization_updated_at,
  });
  const statements: D1PreparedStatement[] = [];
  statements.push(repairExistingLink
    ? db.prepare(`UPDATE client_accounts SET updated_at=?
        WHERE id=? AND status='active' AND updated_at=?
          AND project_alpha_client_id=? AND project_alpha_organization_id IS ?`)
      .bind(activatedAt, account.id, expectedUpdatedAt, source.clientId, source.organizationId)
    : db.prepare(`UPDATE client_accounts SET project_alpha_client_id=?,
        project_alpha_organization_id=?,updated_at=?
        WHERE id=? AND status='active' AND updated_at=?
          AND project_alpha_client_id IS NULL AND project_alpha_organization_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM client_accounts other WHERE other.id<>client_accounts.id
              AND (other.project_alpha_client_id=?
                OR (? IS NOT NULL AND other.project_alpha_organization_id=?))
          )`)
      .bind(source.clientId, source.organizationId, activatedAt, account.id,
        expectedUpdatedAt, source.clientId, source.organizationId, source.organizationId));
  // This statement always attempts one audit insert. A lost CAS deliberately
  // produces a NOT NULL violation so D1 rolls the entire batch back.
  statements.push(db.prepare(`INSERT INTO audit_log
      (actor_type,actor_id,action,entity_type,entity_id,details_json)
    SELECT CASE WHEN updated_at=? AND project_alpha_client_id=?
        AND project_alpha_organization_id IS ? THEN 'staff' ELSE NULL END,
      ?,?,?,?,?
    FROM client_accounts WHERE id=?`)
    .bind(activatedAt, source.clientId, source.organizationId, principal.id,
      repairExistingLink
        ? "client.account.project_alpha_projection_repaired"
        : "client.account.project_alpha_root_linked",
      "client_account", account.id, details, account.id));
  statements.push(db.prepare(`INSERT INTO portal_v2_identities
      (id,issuer,subject,verified_email,status,revoked_at,created_at,updated_at)
    SELECT identity.id,identity.issuer,identity.subject,identity.email,
      CASE WHEN identity.revoked_at IS NULL THEN 'active' ELSE 'revoked' END,
      identity.revoked_at,identity.created_at,COALESCE(identity.last_seen_at,identity.created_at)
    FROM client_identity_links identity
    WHERE identity.account_id=? AND NOT EXISTS (
      SELECT 1 FROM portal_v2_identities projected WHERE projected.id=identity.id
    )`).bind(account.id));
  statements.push(db.prepare(`INSERT INTO portal_v2_workspaces
      (id,root_type,pa_organization_public_id,pa_client_public_id,legacy_account_id,
        display_name,status,created_at,updated_at)
    SELECT ?,?,?,?,?,display_name,status,created_at,updated_at
    FROM client_accounts WHERE id=? AND status='active'
      AND project_alpha_client_id=? AND project_alpha_organization_id IS ?`)
    .bind(workspaceId, source.rootType, source.organizationId,
      source.organizationId === null ? source.clientId : null, account.id,
      account.id, source.clientId, source.organizationId));
  statements.push(db.prepare(`INSERT INTO portal_v2_workspace_memberships
      (id,workspace_id,identity_id,source_type,status,revoked_at,created_at,updated_at)
    SELECT 'legacy-membership-' || member.account_id || '-' || member.identity_id,
      ?,member.identity_id,'legacy',
      CASE WHEN member.revoked_at IS NULL AND identity.revoked_at IS NULL THEN 'active' ELSE 'revoked' END,
      COALESCE(member.revoked_at,identity.revoked_at),member.created_at,member.updated_at
    FROM client_account_members member JOIN client_identity_links identity
      ON identity.id=member.identity_id AND identity.account_id=member.account_id
    WHERE member.account_id=?`).bind(workspaceId, account.id));
  statements.push(db.prepare(`INSERT INTO portal_v2_directory_generations
      (id,workspace_id,source_generation,source_sequence,status,complete,activated_at)
    VALUES (?,?,'legacy-backfill',0,'active',1,?)`)
    .bind(generationId, workspaceId, activatedAt));
  if (hasGenerationContract) statements.push(db.prepare(`INSERT INTO portal_v2_directory_generation_contracts
      (generation_id,workspace_id,schema_version) VALUES (?,?,2)`)
    .bind(generationId, workspaceId));
  statements.push(db.prepare(`INSERT INTO portal_v2_directory_entities
      (workspace_id,generation_id,entity_type,public_id,parent_public_id,
        display_name,source_version,active)
    SELECT ?,?,?,?,?,display_name,'legacy-backfill',1 FROM client_accounts WHERE id=?`)
    .bind(workspaceId, generationId, source.rootType, source.rootPublicId, null, account.id));
  statements.push(db.prepare(`INSERT INTO portal_v2_directory_entities
      (workspace_id,generation_id,entity_type,public_id,parent_public_id,
        display_name,source_version,active)
    SELECT ?,?,'project',project.project_alpha_project_id,?,project.project_name,
      'legacy-backfill',project.active
    FROM client_project_grants grant_record JOIN projects project ON project.id=grant_record.project_id
    WHERE grant_record.account_id=? AND grant_record.revoked_at IS NULL
      AND project.project_alpha_project_id IS NOT NULL`)
    .bind(workspaceId, generationId, source.rootPublicId, account.id));
  statements.push(db.prepare(`INSERT INTO portal_v2_directory_checkpoints
      (workspace_id,active_generation_id,source_sequence,updated_at) VALUES (?,?,0,?)`)
    .bind(workspaceId, generationId, activatedAt));
  statements.push(db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
    SELECT 'legacy-entitlement-' || ? || '-' || membership.identity_id || '-workspace-view',
      ?,membership.identity_id,'workspace.view','allow','workspace',?,'legacy',membership.status
    FROM portal_v2_workspace_memberships membership WHERE membership.workspace_id=?`)
    .bind(account.id, workspaceId, workspaceId, workspaceId));
  statements.push(db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
    SELECT 'legacy-entitlement-' || member.account_id || '-' || member.identity_id || '-' || capabilities.capability,
      ?,member.identity_id,capabilities.capability,'allow','workspace',?,'legacy',
      CASE WHEN member.revoked_at IS NULL THEN 'active' ELSE 'revoked' END
    FROM client_account_members member
    JOIN (SELECT 'directory.read' capability UNION ALL SELECT 'member.manage') capabilities
    WHERE member.account_id=? AND member.role='manager'`)
    .bind(workspaceId, workspaceId, account.id));
  statements.push(db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
    SELECT 'legacy-entitlement-' || member.account_id || '-' || member.identity_id || '-'
        || project.project_alpha_project_id || '-delivery',
      ?,member.identity_id,'delivery.view','allow','project',project.project_alpha_project_id,'legacy',
      CASE WHEN member.revoked_at IS NULL AND grant_record.revoked_at IS NULL THEN 'active' ELSE 'revoked' END
    FROM client_account_members member
    JOIN client_project_grants grant_record ON grant_record.account_id=member.account_id
    JOIN projects project ON project.id=grant_record.project_id AND project.project_alpha_project_id IS NOT NULL
    LEFT JOIN client_member_project_grants member_grant
      ON member_grant.account_id=member.account_id AND member_grant.identity_id=member.identity_id
      AND member_grant.project_id=grant_record.project_id AND member_grant.revoked_at IS NULL
    WHERE member.account_id=? AND (member.role='manager' OR member_grant.project_id IS NOT NULL)`)
    .bind(workspaceId, account.id));
  statements.push(db.prepare(`INSERT INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
    SELECT 'legacy-entitlement-' || member.account_id || '-' || member.identity_id || '-'
        || project.project_alpha_project_id || '-request',
      ?,member.identity_id,'request.create','allow','project',project.project_alpha_project_id,'legacy',
      CASE WHEN member.revoked_at IS NULL AND grant_record.revoked_at IS NULL
        AND grant_record.can_request_service=1 THEN 'active' ELSE 'revoked' END
    FROM client_account_members member
    JOIN client_project_grants grant_record ON grant_record.account_id=member.account_id
    JOIN projects project ON project.id=grant_record.project_id AND project.project_alpha_project_id IS NOT NULL
    LEFT JOIN client_member_project_grants member_grant
      ON member_grant.account_id=member.account_id AND member_grant.identity_id=member.identity_id
      AND member_grant.project_id=grant_record.project_id AND member_grant.revoked_at IS NULL
    WHERE member.account_id=? AND (member.role='manager' OR member_grant.project_id IS NOT NULL)`)
    .bind(workspaceId, account.id));
  statements.push(db.prepare(`INSERT INTO portal_v2_folder_bindings
      (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,status,revoked_at,created_at)
    SELECT 'legacy-folder-' || folder.id,?,
      CASE WHEN folder.scope_type='project' THEN 'project' ELSE ? END,
      CASE WHEN folder.scope_type='project' THEN project.project_alpha_project_id ELSE ? END,
      folder.r2_prefix,'legacy',CASE WHEN folder.revoked_at IS NULL THEN 'active' ELSE 'revoked' END,
      folder.revoked_at,folder.created_at
    FROM client_folder_associations folder LEFT JOIN projects project ON project.id=folder.project_id
    WHERE folder.account_id=?
      AND (folder.scope_type='client' OR project.project_alpha_project_id IS NOT NULL)`)
    .bind(workspaceId, source.rootType, source.rootPublicId, account.id));
  // The guard inserts no row when the complete legacy postcondition holds. If
  // any source-derived row is missing or mismatched, NULL violates actor_type
  // and rolls every statement (including the account link and audit) back.
  statements.push(db.prepare(`${projectionExpectedCte()}
    INSERT INTO audit_log(actor_type,action)
    SELECT NULL,'client.account.project_alpha_projection_incomplete' FROM expected e
    WHERE NOT (${baselineProjectionCondition(hasGenerationContract)})`)
    .bind(...projectionBindings(account.id, source)));
  return statements;
}

/**
 * Permanently attaches an existing unrooted legacy account to one concrete PA
 * client. The effective workspace root is the client's active organization,
 * or the client itself when it is standalone. Before migration 0121 this only
 * links the legacy account. After 0121 it atomically creates the exact legacy
 * workspace projection as well; partial/conflicting projections stay blocked.
 */
export async function activateClientAccountRoot(
  env: Env,
  principal: StaffPrincipal,
  accountId: string,
  input: { projectAlphaClientId: string; expectedUpdatedAt: string },
): Promise<{
  accountId: string;
  projectAlphaClientId: string;
  projectAlphaOrganizationId: string | null;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
  unchanged: boolean;
}> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(accountId))
    throw new HTTPException(400, { message: "Client account ID is invalid" });
  if (`workspace-${accountId}`.length > 128)
    throw new HTTPException(400, { message: "Client account ID cannot produce a valid workspace ID" });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.projectAlphaClientId))
    throw new HTTPException(400, { message: "Project Alpha client ID is invalid" });
  if (!input.expectedUpdatedAt || input.expectedUpdatedAt.length > 64)
    throw new HTTPException(400, { message: "Expected account version is required" });

  const db = deliveryDatabase(env);
  const [schemaPresent, account, sourceRow] = await Promise.all([
    workspaceSchemaPresent(db),
    db.prepare(`SELECT id,display_name,status,project_alpha_client_id,
      project_alpha_organization_id,updated_at FROM client_accounts WHERE id=?`)
      .bind(accountId).first<AccountRow>(),
    activeSource(env, input.projectAlphaClientId),
  ]);
  if (!account) throw new HTTPException(404, { message: "Client account not found" });
  if (account.status !== "active")
    throw new HTTPException(409, { message: "Only an active client account can be linked" });
  if (!sourceRow)
    throw new HTTPException(404, { message: "Active Project Alpha client and organization were not found" });
  const source = sourceFromRow(sourceRow);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source.rootPublicId))
    throw new HTTPException(409, { message: "Project Alpha root public ID is not valid for a workspace" });

  const exactCurrentLink = account.project_alpha_client_id === source.clientId
    && account.project_alpha_organization_id === source.organizationId;
  if (account.project_alpha_client_id || account.project_alpha_organization_id)
    if (!exactCurrentLink) throw new HTTPException(409, {
        message: "This account already has a different Project Alpha root; automatic remapping is prohibited",
      });

  if (schemaPresent) {
    if (!await workspaceProjectionSchemaComplete(db))
      throw new HTTPException(409, {
        message: "The workspace migration is incomplete; finish or restore the migration before activation",
      });
    const hasGenerationContract = await tablePresent(db, "portal_v2_directory_generation_contracts");
    const currentProjectionState = await projectionState(db, accountId, source, hasGenerationContract);
    if (exactCurrentLink && currentProjectionState === "complete")
      return activationResult(accountId, source, true);
    if (currentProjectionState !== "missing")
      throw new HTTPException(409, {
        message: "The workspace projection is partial or conflicts with this root; automatic repair is prohibited",
      });
    if (account.updated_at !== input.expectedUpdatedAt)
      throw new HTTPException(409, { message: "Client account changed; refresh before linking" });
    if (await duplicateLegacyRoot(db, accountId, source))
      throw new HTTPException(409, {
        message: "That Project Alpha client or organization is already assigned to another account",
      });

    // The PA catalog and Client projection live in different D1 databases and
    // cannot share a transaction. Pin the authoritative source version, then
    // re-read immediately before the Delivery-side atomic batch.
    const currentSourceRow = await activeSource(env, input.projectAlphaClientId);
    if (!currentSourceRow || !sameSourceVersion(sourceRow, currentSourceRow))
      throw new HTTPException(409, {
        message: "Project Alpha changed while activation was being prepared; refresh and retry",
      });
    const activatedAt = new Date().toISOString();
    try {
      const batchResult = await db.batch(postMigrationProjectionStatements(
        db,
        principal,
        account,
        currentSourceRow,
        input.expectedUpdatedAt,
        activatedAt,
        hasGenerationContract,
        exactCurrentLink,
      ));
      if (batchResult[0]?.meta.changes !== 1 || batchResult[1]?.meta.changes !== 1)
        throw new Error("Client account activation did not satisfy its atomic write guards");
    } catch (error) {
      // A concurrent identical activation is an exact replay. Every other
      // constraint/CAS/audit failure stays closed and cannot leave partial rows
      // because D1 batch execution is transactional.
      const replayAccount = await db.prepare(`SELECT id,display_name,status,project_alpha_client_id,
        project_alpha_organization_id,updated_at FROM client_accounts WHERE id=?`)
        .bind(accountId).first<AccountRow>();
      const replayComplete = replayAccount?.project_alpha_client_id === source.clientId
        && replayAccount.project_alpha_organization_id === source.organizationId
        && await recognizedProjectionComplete(db, accountId, source, hasGenerationContract);
      if (replayComplete) return activationResult(accountId, source, true);
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(409, {
        message: "Client account changed or the complete workspace projection could not be created",
        cause: error,
      });
    }
    return activationResult(accountId, source, false);
  }

  // Preserve the pre-0121 path exactly: an exact linked root replays without
  // requiring the original optimistic version, while any mutation still uses
  // the account timestamp and legacy uniqueness guards.
  if (exactCurrentLink) return activationResult(accountId, source, true);
  if (account.updated_at !== input.expectedUpdatedAt)
    throw new HTTPException(409, { message: "Client account changed; refresh before linking" });

  if (await duplicateLegacyRoot(db, accountId, source))
    throw new HTTPException(409, { message: "That Project Alpha client or organization is already assigned to another account" });

  const activatedAt = new Date().toISOString();
  const details = JSON.stringify({
    projectAlphaClientId: source.clientId,
    projectAlphaOrganizationId: source.organizationId,
    workspaceRootType: source.rootType,
    workspaceRootPublicId: source.rootPublicId,
    preMigrationActivation: true,
  });
  const result = await db.batch([
    db.prepare(`UPDATE client_accounts SET project_alpha_client_id=?,
      project_alpha_organization_id=?,updated_at=?
      WHERE id=? AND status='active' AND updated_at=?
        AND project_alpha_client_id IS NULL AND project_alpha_organization_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM client_accounts other WHERE other.id<>client_accounts.id
            AND (other.project_alpha_client_id=? OR (? IS NOT NULL AND other.project_alpha_organization_id=?))
        )`)
      .bind(source.clientId, source.organizationId, activatedAt, accountId,
        input.expectedUpdatedAt, source.clientId, source.organizationId, source.organizationId),
    db.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
      SELECT 'staff',?,'client.account.project_alpha_root_linked','client_account',?,?
      FROM client_accounts WHERE id=? AND updated_at=?
        AND project_alpha_client_id=?
        AND project_alpha_organization_id IS ?`)
      .bind(principal.id, accountId, details, accountId, activatedAt,
        source.clientId, source.organizationId),
  ]);
  if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1)
    throw new HTTPException(409, { message: "Client account changed or the Project Alpha root is no longer unique" });

  return activationResult(accountId, source, false);
}
