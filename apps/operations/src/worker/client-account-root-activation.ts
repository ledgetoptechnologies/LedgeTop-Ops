import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "./types";

export interface ClientAccountRootActivationAccount {
  id: string;
  displayName: string;
  status: string;
  projectAlphaClientId: string | null;
  projectAlphaOrganizationId: string | null;
  updatedAt: string;
  activationState: "unlinked" | "linked" | "projection_missing" | "projected";
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
}

function deliveryDatabase(env: Env): D1DatabaseSession {
  return env.DELIVERY_DB.withSession("first-primary");
}

async function workspaceSchemaPresent(db: D1DatabaseSession): Promise<boolean> {
  return (await db.prepare(
    "SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='portal_v2_workspaces'",
  ).first("ok")) !== null;
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
    env.OPS_DB.withSession("first-primary").prepare(`SELECT client.id client_id,client.name client_name,
      client.organization_id,organization.name organization_name
      FROM pa_clients client
      LEFT JOIN pa_organizations organization
        ON organization.id=client.organization_id AND organization.active=1
      WHERE client.active=1
        AND (client.organization_id IS NULL OR organization.id IS NOT NULL)
      ORDER BY lower(COALESCE(organization.name,client.name)),lower(client.name),client.id`)
      .all<SourceRow>(),
  ]);

  const projectedAccountIds = new Set<string>();
  if (schemaPresent) {
    const projected = await db.prepare(
      "SELECT legacy_account_id FROM portal_v2_workspaces WHERE legacy_account_id IS NOT NULL",
    ).all<{ legacy_account_id: string }>();
    for (const row of projected.results) projectedAccountIds.add(row.legacy_account_id);
  }

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
        activationState: projectedAccountIds.has(row.id)
          ? "projected"
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

/**
 * Permanently attaches an existing unrooted legacy account to one concrete PA
 * client. The effective workspace root is the client's active organization,
 * or the client itself when it is standalone. Linking after migration 0121 is
 * deliberately refused because that would leave the v2 projection incomplete.
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
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.projectAlphaClientId))
    throw new HTTPException(400, { message: "Project Alpha client ID is invalid" });
  if (!input.expectedUpdatedAt || input.expectedUpdatedAt.length > 64)
    throw new HTTPException(400, { message: "Expected account version is required" });

  const db = deliveryDatabase(env);
  if (await workspaceSchemaPresent(db))
    throw new HTTPException(409, {
      message: "Workspace migration 0121 is already applied; use a reviewed projection repair instead of late legacy linking",
    });

  const [account, sourceRow] = await Promise.all([
    db.prepare(`SELECT id,display_name,status,project_alpha_client_id,
      project_alpha_organization_id,updated_at FROM client_accounts WHERE id=?`)
      .bind(accountId).first<AccountRow>(),
    env.OPS_DB.withSession("first-primary").prepare(`SELECT client.id client_id,client.name client_name,
      client.organization_id,organization.name organization_name
      FROM pa_clients client
      LEFT JOIN pa_organizations organization
        ON organization.id=client.organization_id AND organization.active=1
      WHERE client.id=? AND client.active=1
        AND (client.organization_id IS NULL OR organization.id IS NOT NULL)`)
      .bind(input.projectAlphaClientId).first<SourceRow>(),
  ]);
  if (!account) throw new HTTPException(404, { message: "Client account not found" });
  if (account.status !== "active")
    throw new HTTPException(409, { message: "Only an active client account can be linked" });
  if (!sourceRow)
    throw new HTTPException(404, { message: "Active Project Alpha client and organization were not found" });
  const source = sourceFromRow(sourceRow);

  const exactCurrentLink = account.project_alpha_client_id === source.clientId
    && account.project_alpha_organization_id === source.organizationId;
  if (exactCurrentLink) return {
    accountId,
    projectAlphaClientId: source.clientId,
    projectAlphaOrganizationId: source.organizationId,
    rootType: source.rootType,
    rootPublicId: source.rootPublicId,
    unchanged: true,
  };
  if (account.project_alpha_client_id || account.project_alpha_organization_id)
    throw new HTTPException(409, {
      message: "This account already has a different Project Alpha root; automatic remapping is prohibited",
    });
  if (account.updated_at !== input.expectedUpdatedAt)
    throw new HTTPException(409, { message: "Client account changed; refresh before linking" });

  const duplicate = source.organizationId
    ? await db.prepare(`SELECT id FROM client_accounts WHERE id<>?
        AND (project_alpha_client_id=? OR project_alpha_organization_id=?) LIMIT 1`)
      .bind(accountId, source.clientId, source.organizationId).first("id")
    : await db.prepare(`SELECT id FROM client_accounts WHERE id<>?
        AND project_alpha_client_id=? LIMIT 1`)
      .bind(accountId, source.clientId).first("id");
  if (duplicate !== null)
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

  return {
    accountId,
    projectAlphaClientId: source.clientId,
    projectAlphaOrganizationId: source.organizationId,
    rootType: source.rootType,
    rootPublicId: source.rootPublicId,
    unchanged: false,
  };
}
