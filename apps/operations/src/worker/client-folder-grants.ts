import { HTTPException } from "hono/http-exception";
import { requirePermission } from "./acl";
import { sendAdminAlert } from "./alerts";
import { normalizePrefix, resolveDivisionAssociation } from "./delivery";
import { sendNotificationMail } from "./mailer";
import { auditStatement } from "./request-security";
import { normalizeCrudKey } from "./r2-crud-validation";
import { d1TablesPresent } from "./schema-readiness";
import type { Env, StaffPrincipal } from "./types";

const MAX_ATTEMPTS = 3;
const CLIENT_FOLDER_CHANGE_NOTIFICATION_TABLES = [
  "client_folder_notification_preferences",
  "client_folder_change_notifications",
  "client_portal_notifications",
] as const;

async function clientFolderChangeNotificationsAvailable(env: Env): Promise<boolean> {
  return d1TablesPresent(env.DELIVERY_DB, CLIENT_FOLDER_CHANGE_NOTIFICATION_TABLES);
}

export interface ClientFolderGrantInput {
  accountId: string;
  divisionId: string;
  r2Prefix: string;
  grantId?: string;
  recipientIdentityId?: string | null;
  recipientIdentityIds?: string[];
  notificationMode?: "off" | "added" | "removed" | "both";
}

export type ClientFolderNotificationMode = "off" | "added" | "removed" | "both";

interface GrantRow {
  id: string;
  logical_grant_id: string;
  grant_version: number;
  account_id: string;
  r2_prefix: string;
  division_id: string | null;
}

interface MutationRow extends GrantRow {
  mutation_fingerprint: string;
}

interface ClientAccountMapping {
  id: string;
  project_alpha_client_id: string | null;
  project_alpha_organization_id: string | null;
}

interface AuthoritativeFolderAssociation {
  division_id: string;
  r2_prefix: string;
  project_alpha_client_id: string | null;
  project_alpha_organization_id: string | null;
}

interface AuthoritativeGrantScope {
  divisionId: string;
  ownerType: "client" | "organization";
  ownerId: string;
}

interface NotificationRow {
  id: string;
  logical_grant_id: string;
  grant_version: number;
  association_id: string;
  account_id: string;
  recipient_identity_id: string;
  prior_coverage_json: string;
  attempt_count: number;
}

interface NotificationContext {
  r2_prefix: string;
  account_name: string;
  recipient_email: string;
  project_alpha_client_id: string | null;
  project_alpha_organization_id: string | null;
}

function stableInput(input: ClientFolderGrantInput, prefix: string): string {
  return JSON.stringify({
    accountId: input.accountId,
    divisionId: input.divisionId,
    grantId: input.grantId || null,
    r2Prefix: prefix,
    recipientIdentityId: input.recipientIdentityId || null,
    recipientIdentityIds: [...(input.recipientIdentityIds || [])].sort(),
    notificationMode: input.notificationMode || (input.recipientIdentityId ? "added" : "off"),
  });
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function mutationStatement(env: Env, input: { accountId: string; mutationKey: string; fingerprint: string; grantId: string; version: number; associationId: string }): D1PreparedStatement {
  return env.DELIVERY_DB.prepare(`INSERT INTO client_folder_grant_mutations
    (account_id,mutation_key,mutation_fingerprint,logical_grant_id,grant_version,association_id)
    VALUES (?,?,?,?,?,?)`).bind(input.accountId, input.mutationKey, input.fingerprint, input.grantId, input.version, input.associationId);
}

function notificationStatement(env: Env, input: { grantId: string; version: number; associationId: string; accountId: string; recipientIdentityId?: string | null; priorCoverage: string[] }): D1PreparedStatement | null {
  if (!input.recipientIdentityId) return null;
  return env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO client_folder_grant_notifications
    (id,logical_grant_id,grant_version,association_id,account_id,recipient_identity_id,prior_coverage_json)
    VALUES (?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), input.grantId, input.version, input.associationId, input.accountId, input.recipientIdentityId, JSON.stringify(input.priorCoverage));
}

async function activeRecipient(env: Env, accountId: string, identityId: string): Promise<boolean> {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT 1 ok
    FROM client_accounts a
    JOIN client_identity_links i ON i.account_id=a.id AND i.id=? AND i.revoked_at IS NULL AND i.email IS NOT NULL
    JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
    WHERE a.id=? AND a.status='active' AND (a.project_alpha_client_id IS NOT NULL OR a.project_alpha_organization_id IS NOT NULL)`).bind(identityId, accountId).first<{ ok: number }>();
  return Boolean(row?.ok);
}

async function mutationReplay(env: Env, accountId: string, mutationKey: string, expectedFingerprint: string): Promise<MutationRow | null> {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT m.mutation_fingerprint,a.id,a.logical_grant_id,a.grant_version,a.account_id,a.r2_prefix,a.division_id
    FROM client_folder_grant_mutations m JOIN client_folder_associations a ON a.id=m.association_id
    WHERE m.account_id=? AND m.mutation_key=?`).bind(accountId, mutationKey).first<MutationRow>();
  if (!row) return null;
  if (row.mutation_fingerprint !== expectedFingerprint)
    throw new HTTPException(409, { message: "Idempotency-Key was already used for a different folder grant" });
  return row;
}

async function authoritativeFolderGrantScope(env: Env, prefix: string, account?: ClientAccountMapping): Promise<AuthoritativeGrantScope> {
  const associations = await env.OPS_DB.withSession("first-primary").prepare(`SELECT pf.division_id,pf.r2_prefix,
      p.client_id project_alpha_client_id,p.organization_id project_alpha_organization_id
    FROM project_folders pf JOIN pa_projects p ON p.id=pf.project_id
    WHERE p.active=1 ORDER BY length(pf.r2_prefix) DESC`).all<AuthoritativeFolderAssociation>();
  const matches = associations.results
    .map(row => ({ row, prefix: normalizePrefix(row.r2_prefix) }))
    .filter(candidate => prefix.startsWith(candidate.prefix));
  if (!matches.length) throw new HTTPException(404, { message: "Folder not found" });

  const longestLength = Math.max(...matches.map(candidate => candidate.prefix.length));
  const authoritative = matches.filter(candidate => candidate.prefix.length === longestLength);
  const divisionId = resolveDivisionAssociation(prefix, authoritative.map(candidate => candidate.row));
  if (!divisionId) throw new HTTPException(404, { message: "Folder not found" });

  const owners = new Set(authoritative.map(({ row }) => row.project_alpha_client_id
    ? `client:${row.project_alpha_client_id}`
    : row.project_alpha_organization_id
      ? `organization:${row.project_alpha_organization_id}`
      : "unmapped"));
  if (owners.size !== 1 || owners.has("unmapped"))
    throw new HTTPException(409, { message: "Folder is associated with multiple clients and requires review" });
  const owner = [...owners][0];
  if (!owner) throw new HTTPException(404, { message: "Folder not found" });
  const [ownerType, ownerId] = owner.split(":") as ["client" | "organization", string];
  if (account) {
    const accountOwner = Boolean(account.project_alpha_client_id && owner === `client:${account.project_alpha_client_id}`)
      || Boolean(account.project_alpha_organization_id && owner === `organization:${account.project_alpha_organization_id}`);
    if (!accountOwner) throw new HTTPException(404, { message: "Folder not found" });
  }
  return { divisionId, ownerType, ownerId };
}

async function activeRecipients(env: Env, accountId: string, identityIds: string[]): Promise<string[]> {
  const unique = [...new Set(identityIds)];
  if (!unique.length) return [];
  const placeholders = unique.map(() => "?").join(",");
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT i.id
    FROM client_identity_links i JOIN client_accounts a ON a.id=i.account_id AND a.status='active'
    JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
    WHERE a.id=? AND i.revoked_at IS NULL AND i.email IS NOT NULL AND i.id IN (${placeholders})`)
    .bind(accountId, ...unique).all<{ id: string }>();
  if (rows.results.length !== unique.length) throw new HTTPException(409, { message: "Every notification recipient must be an active member of this client workspace" });
  return unique;
}

function preferenceStatements(env: Env, input: { grantId: string; accountId: string; mode: ClientFolderNotificationMode; recipientIds: string[]; actorId: string }): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    env.DELIVERY_DB.prepare("DELETE FROM client_folder_notification_preferences WHERE logical_grant_id=? AND account_id=?").bind(input.grantId, input.accountId),
  ];
  if (input.mode !== "off") for (const identityId of input.recipientIds) statements.push(env.DELIVERY_DB.prepare(`INSERT INTO client_folder_notification_preferences
    (logical_grant_id,account_id,recipient_identity_id,mode,updated_by) VALUES (?,?,?,?,?)`)
    .bind(input.grantId, input.accountId, identityId, input.mode, input.actorId));
  return statements;
}

export async function findClientFolderGrantTargets(
  env: Env,
  principal: StaffPrincipal,
  input: { divisionId: string; r2Prefix: string; query: string },
) {
  if (!env.DELIVERY_DB) throw new Error("delivery-db-binding-required");
  const prefix = normalizeCrudKey(input.r2Prefix, true);
  const scope = await authoritativeFolderGrantScope(env, prefix);
  if (input.divisionId && scope.divisionId !== input.divisionId)
    throw new HTTPException(409, { message: "Folder division does not match the authoritative association" });
  await requirePermission(env, principal, "delivery.share.create", { divisionId: scope.divisionId }, true);
  const query = input.query.trim();
  if (query.length < 2) return { accounts: [] };
  const ownerColumn = scope.ownerType === "client" ? "project_alpha_client_id" : "project_alpha_organization_id";
  const accounts = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,display_name
    FROM client_accounts WHERE status='active' AND ${ownerColumn}=? AND display_name LIKE ? ESCAPE '\\'
    ORDER BY display_name COLLATE NOCASE LIMIT 20`)
    .bind(scope.ownerId, `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`).all<{ id: string; display_name: string }>();
  const result = [];
  for (const account of accounts.results) {
    const [members, grant] = await Promise.all([
      env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT i.id identity_id,i.email,m.role
        FROM client_identity_links i JOIN client_account_members m ON m.account_id=i.account_id AND m.identity_id=i.id
        WHERE i.account_id=? AND i.revoked_at IS NULL AND m.revoked_at IS NULL AND i.email IS NOT NULL
        ORDER BY CASE m.role WHEN 'manager' THEN 0 ELSE 1 END,lower(i.email)`).bind(account.id).all<{ identity_id: string; email: string; role: string }>(),
      env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,logical_grant_id,grant_version
        FROM client_folder_associations WHERE account_id=? AND scope_type='client' AND project_id IS NULL
          AND r2_prefix=? AND revoked_at IS NULL ORDER BY grant_version DESC LIMIT 1`).bind(account.id, prefix)
        .first<{ id: string; logical_grant_id: string; grant_version: number }>(),
    ]);
    let preferences: Array<{ recipient_identity_id: string; mode: ClientFolderNotificationMode }> = [];
    if (grant) preferences = (await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT recipient_identity_id,mode
      FROM client_folder_notification_preferences WHERE logical_grant_id=? AND account_id=? AND mode<>'off'`)
      .bind(grant.logical_grant_id, account.id).all<{ recipient_identity_id: string; mode: ClientFolderNotificationMode }>()).results;
    result.push({
      id: account.id,
      displayName: account.display_name,
      members: members.results.map(member => ({ identityId: member.identity_id, email: member.email, role: member.role })),
      grant: grant ? { id: grant.id, grantId: grant.logical_grant_id, version: grant.grant_version, preferences } : null,
    });
  }
  return { accounts: result, divisionId: scope.divisionId };
}

export async function createClientFolderGrant(env: Env, request: Request, principal: StaffPrincipal, input: ClientFolderGrantInput, mutationKey: string) {
  if (!env.DELIVERY_DB) throw new Error("delivery-db-binding-required");
  if (mutationKey.length < 16 || mutationKey.length > 128)
    throw new HTTPException(400, { message: "Idempotency-Key must contain 16-128 characters" });
  const prefix = normalizeCrudKey(input.r2Prefix, true);
  const account = await env.DELIVERY_DB.withSession("first-primary").prepare(
    "SELECT id,project_alpha_client_id,project_alpha_organization_id FROM client_accounts WHERE id=? AND status='active' AND (project_alpha_client_id IS NOT NULL OR project_alpha_organization_id IS NOT NULL)",
  ).bind(input.accountId).first<ClientAccountMapping>();
  if (!account) throw new HTTPException(404, { message: "Active client workspace not found" });
  const { divisionId } = await authoritativeFolderGrantScope(env, prefix, account);
  if (input.divisionId !== divisionId)
    throw new HTTPException(409, { message: "Folder division does not match the authoritative association" });
  await requirePermission(env, principal, "delivery.share.create", { divisionId }, true);
  const mutationFingerprint = await fingerprint(stableInput({ ...input, divisionId }, prefix));
  const replay = await mutationReplay(env, input.accountId, mutationKey, mutationFingerprint);
  if (replay) return { ...mapGrant(replay), idempotentReplay: true, unchanged: false };

  const notificationMode = input.notificationMode || (input.recipientIdentityId ? "added" : "off");
  const recipientIds = await activeRecipients(env, input.accountId, input.recipientIdentityIds || (input.recipientIdentityId ? [input.recipientIdentityId] : []));
  if (notificationMode !== "off" && !recipientIds.length)
    throw new HTTPException(400, { message: "Select at least one notification recipient" });

  const db = env.DELIVERY_DB.withSession("first-primary");
  let previous: GrantRow | null = null;
  if (input.grantId) {
    previous = await db.prepare(`SELECT id,logical_grant_id,grant_version,account_id,r2_prefix,division_id
      FROM client_folder_associations WHERE logical_grant_id=? AND account_id=? AND scope_type='client'
        AND project_id IS NULL AND revoked_at IS NULL`).bind(input.grantId, input.accountId).first<GrantRow>();
    if (!previous) throw new HTTPException(404, { message: "Active client folder grant not found" });
  }

  if (!previous) {
    const covered = await db.prepare(`SELECT id,logical_grant_id,grant_version,account_id,r2_prefix,division_id
      FROM client_folder_associations WHERE account_id=? AND scope_type='client' AND project_id IS NULL
        AND revoked_at IS NULL AND logical_grant_id IS NOT NULL AND division_id=?
        AND substr(?,1,length(r2_prefix))=r2_prefix
      ORDER BY length(r2_prefix) LIMIT 1`).bind(input.accountId, divisionId, prefix).first<GrantRow>();
    if (covered) {
      await db.batch([
        mutationStatement(env, { accountId: input.accountId, mutationKey, fingerprint: mutationFingerprint, grantId: covered.logical_grant_id, version: covered.grant_version, associationId: covered.id }),
        ...preferenceStatements(env, { grantId: covered.logical_grant_id, accountId: input.accountId, mode: notificationMode, recipientIds, actorId: principal.id }),
      ]);
      return { ...mapGrant(covered), idempotentReplay: false, unchanged: true };
    }
  }

  if (previous?.r2_prefix === prefix && previous.division_id === divisionId) {
    await db.batch([
      mutationStatement(env, { accountId: input.accountId, mutationKey, fingerprint: mutationFingerprint, grantId: previous.logical_grant_id, version: previous.grant_version, associationId: previous.id }),
      ...preferenceStatements(env, { grantId: previous.logical_grant_id, accountId: input.accountId, mode: notificationMode, recipientIds, actorId: principal.id }),
    ]);
    return { ...mapGrant(previous), idempotentReplay: false, unchanged: true };
  }

  const associationId = crypto.randomUUID();
  const grantId = previous?.logical_grant_id || crypto.randomUUID();
  const version = (previous?.grant_version || 0) + 1;
  const priorCoverageRows = await db.prepare(`SELECT r2_prefix FROM client_folder_associations
    WHERE account_id=? AND scope_type='client' AND project_id IS NULL AND revoked_at IS NULL
    ORDER BY length(r2_prefix),r2_prefix`).bind(input.accountId).all<{ r2_prefix: string }>();
  const priorCoverage = [...new Set(priorCoverageRows.results.map(row => row.r2_prefix))];
  const exposesNewScope = !priorCoverage.some(covered => prefix.startsWith(covered));
  const notifications = exposesNewScope ? recipientIds
    .map(recipientIdentityId => notificationStatement(env, { grantId, version, associationId, accountId: input.accountId, recipientIdentityId, priorCoverage }))
    .filter((statement): statement is D1PreparedStatement => Boolean(statement)) : [];
  const statements: D1PreparedStatement[] = [];
  if (previous) statements.push(db.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now'),superseded_by_id=? WHERE id=? AND revoked_at IS NULL").bind(associationId, previous.id));
  statements.push(
    db.prepare(`INSERT INTO client_folder_associations
      (id,scope_type,project_id,account_id,r2_prefix,created_by,logical_grant_id,grant_version,division_id)
      VALUES (?,'client',NULL,?,?,?,?,?,?)`).bind(associationId, input.accountId, prefix, principal.id, grantId, version, divisionId),
    mutationStatement(env, { accountId: input.accountId, mutationKey, fingerprint: mutationFingerprint, grantId, version, associationId }),
    db.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('staff',?,'client.folder.granted','client_folder_grant',?,?)")
      .bind(principal.id, grantId, JSON.stringify({ accountId: input.accountId, associationId, version, r2Prefix: prefix, previousAssociationId: previous?.id || null, notificationMode, recipientCount: recipientIds.length })),
    ...preferenceStatements(env, { grantId, accountId: input.accountId, mode: notificationMode, recipientIds, actorId: principal.id }),
  );
  statements.push(...notifications);
  try {
    const results = await db.batch(statements);
    if (previous && !results[0]?.meta.changes)
      throw new HTTPException(409, { message: "Client folder grant changed; refresh and try again" });
  } catch (error) {
    const racedReplay = await mutationReplay(env, input.accountId, mutationKey, mutationFingerprint);
    if (racedReplay) return { ...mapGrant(racedReplay), idempotentReplay: true, unchanged: false };
    throw error;
  }
  await env.OPS_DB.batch([await auditStatement(env, request, principal, "client.folder.granted", "client_folder_grant", grantId, divisionId, { accountId: input.accountId, associationId, version, r2Prefix: prefix })]);
  return { id: associationId, grantId, version, accountId: input.accountId, r2Prefix: prefix, idempotentReplay: false, unchanged: false };
}

function mapGrant(row: GrantRow) {
  return { id: row.id, grantId: row.logical_grant_id, version: row.grant_version, accountId: row.account_id, r2Prefix: row.r2_prefix };
}

export async function revokeClientFolderGrant(env: Env, request: Request, principal: StaffPrincipal, accountId: string, grantId: string): Promise<void> {
  if (!env.DELIVERY_DB) throw new Error("delivery-db-binding-required");
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,logical_grant_id,grant_version,account_id,r2_prefix,division_id
    FROM client_folder_associations WHERE logical_grant_id=? AND account_id=? AND scope_type='client' AND project_id IS NULL AND revoked_at IS NULL`).bind(grantId, accountId).first<GrantRow>();
  if (!row) throw new HTTPException(404, { message: "Active client folder grant not found" });
  const account = await env.DELIVERY_DB.withSession("first-primary").prepare(
    "SELECT id,project_alpha_client_id,project_alpha_organization_id FROM client_accounts WHERE id=? AND (project_alpha_client_id IS NOT NULL OR project_alpha_organization_id IS NOT NULL)",
  ).bind(accountId).first<ClientAccountMapping>();
  if (!account) throw new HTTPException(404, { message: "Active client folder grant not found" });
  const { divisionId } = await authoritativeFolderGrantScope(env, row.r2_prefix, account);
  await requirePermission(env, principal, "delivery.share.revoke", { divisionId }, true);
  const result = await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL").bind(row.id),
    env.DELIVERY_DB.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('staff',?,'client.folder.revoked','client_folder_grant',?,?)")
      .bind(principal.id, grantId, JSON.stringify({ accountId: row.account_id, associationId: row.id, version: row.grant_version, r2Prefix: row.r2_prefix })),
  ]);
  if (!result[0]?.meta.changes) throw new HTTPException(404, { message: "Active client folder grant not found" });
  await env.OPS_DB.batch([await auditStatement(env, request, principal, "client.folder.revoked", "client_folder_grant", grantId, divisionId, { accountId: row.account_id, associationId: row.id, version: row.grant_version, r2Prefix: row.r2_prefix, storedDivisionId: row.division_id })]);
}

function renderClientFolderGrant(accountName: string, actionUrl: string) {
  const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  return {
    subject: `New files shared with ${accountName}`,
    text: `New files are available in your authenticated LTDS client workspace.\n\nOpen client deliveries: ${actionUrl}`,
    html: `<p>New files are available in your authenticated LTDS client workspace.</p><p><a href="${escape(actionUrl)}">Open client deliveries</a></p>`,
  };
}

async function suppress(env: Env, row: NotificationRow, reason: string): Promise<void> {
  await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare("UPDATE client_folder_grant_notifications SET status='suppressed',lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing'").bind(reason, row.id),
    env.DELIVERY_DB.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('system','client-folder-notifications','client.folder.notification.suppressed','client_folder_grant',?,?)")
      .bind(row.logical_grant_id, JSON.stringify({ notificationId: row.id, version: row.grant_version, reason })),
  ]);
}

async function hasNewVisibleContent(env: Env, input: { prefix: string; priorCoverageJson: string; accountId: string; associationId: string }): Promise<boolean> {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT 1 ok FROM file_index f
    WHERE substr(f.r2_key,1,length(?))=?
      AND instr('/'||lower(f.r2_key),'/_ltds/')=0
      AND instr('/'||lower(f.r2_key),'/.previews/')=0
      AND instr('/'||lower(f.r2_key),'/dump/')=0
      AND NOT EXISTS (SELECT 1 FROM json_each(?) covered
        WHERE covered.type='text' AND substr(f.r2_key,1,length(covered.value))=covered.value)
      AND NOT EXISTS (SELECT 1 FROM client_folder_associations other
        WHERE other.account_id=? AND other.scope_type='client' AND other.project_id IS NULL
          AND other.revoked_at IS NULL AND other.id<>?
          AND substr(f.r2_key,1,length(other.r2_prefix))=other.r2_prefix)
    LIMIT 1`).bind(input.prefix, input.prefix, input.priorCoverageJson, input.accountId, input.associationId).first<{ ok: number }>();
  return Boolean(row?.ok);
}

export async function processClientFolderGrantNotifications(env: Env): Promise<number> {
  if (!env.DELIVERY_DB) throw new Error("delivery-db-binding-required");
  let processed = 0;
  for (; processed < 25; processed += 1) {
    const row = await env.DELIVERY_DB.prepare(`SELECT id,logical_grant_id,grant_version,association_id,account_id,recipient_identity_id,prior_coverage_json,attempt_count
      FROM client_folder_grant_notifications
      WHERE ((status='pending' AND datetime(next_attempt_at)<=datetime('now')) OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))
        AND attempt_count<? ORDER BY created_at LIMIT 1`).bind(MAX_ATTEMPTS).first<NotificationRow>();
    if (!row) break;
    const claimed = await env.DELIVERY_DB.prepare(`UPDATE client_folder_grant_notifications
      SET status='processing',attempt_count=attempt_count+1,lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now')
      WHERE id=? AND attempt_count<? AND ((status='pending' AND datetime(next_attempt_at)<=datetime('now')) OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))`)
      .bind(row.id, MAX_ATTEMPTS).run();
    if (!claimed.meta.changes) { processed -= 1; continue; }
    const attempt = row.attempt_count + 1;
    const context = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT association.r2_prefix,a.display_name account_name,i.email recipient_email,
        a.project_alpha_client_id,a.project_alpha_organization_id
      FROM client_folder_associations association
      JOIN client_accounts a ON a.id=association.account_id AND a.status='active'
        AND (a.project_alpha_client_id IS NOT NULL OR a.project_alpha_organization_id IS NOT NULL)
      JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL AND i.email IS NOT NULL
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      WHERE association.id=? AND association.logical_grant_id=? AND association.grant_version=?
        AND association.account_id=? AND association.scope_type='client' AND association.project_id IS NULL
        AND association.revoked_at IS NULL AND association.superseded_by_id IS NULL`)
      .bind(row.recipient_identity_id, row.association_id, row.logical_grant_id, row.grant_version, row.account_id).first<NotificationContext>();
    if (!context) { await suppress(env, row, "grant-or-recipient-no-longer-authorized"); continue; }
    try {
      await authoritativeFolderGrantScope(env, context.r2_prefix, {
        id: row.account_id,
        project_alpha_client_id: context.project_alpha_client_id,
        project_alpha_organization_id: context.project_alpha_organization_id,
      });
    } catch {
      await suppress(env, row, "authoritative-folder-owner-changed");
      continue;
    }
    if (!(await hasNewVisibleContent(env, { prefix: context.r2_prefix, priorCoverageJson: row.prior_coverage_json, accountId: row.account_id, associationId: row.association_id }))) { await suppress(env, row, "no-new-visible-content"); continue; }
    try {
      const actionUrl = new URL("/portal/deliveries", env.DELIVERY_BASE_URL).toString();
      const rendered = renderClientFolderGrant(context.account_name, actionUrl);
      await sendNotificationMail(env, { to: context.recipient_email, fromName: "LTDS Client Portal", subject: rendered.subject, text: rendered.text, html: rendered.html, messageIdKey: row.id });
      await env.DELIVERY_DB.batch([
        env.DELIVERY_DB.prepare("UPDATE client_folder_grant_notifications SET status='sent',delivered_at=datetime('now'),lease_expires_at=NULL,updated_at=datetime('now') WHERE id=? AND status='processing'").bind(row.id),
        env.DELIVERY_DB.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('system','client-folder-notifications','client.folder.notification.sent','client_folder_grant',?,?)")
          .bind(row.logical_grant_id, JSON.stringify({ notificationId: row.id, version: row.grant_version, attempt })),
      ]);
    } catch (error) {
      const message = (error instanceof Error ? error.message : "email-send-failed").slice(0, 240);
      const terminal = attempt >= MAX_ATTEMPTS;
      await env.DELIVERY_DB.prepare("UPDATE client_folder_grant_notifications SET status=?,next_attempt_at=datetime('now',?),lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing'")
        .bind(terminal ? "failed" : "pending", terminal ? "+0 seconds" : `+${2 ** attempt * 5} minutes`, message, row.id).run();
      if (terminal) await sendAdminAlert(env, "Client folder grant notification failed", `Notification ${row.id} for grant ${row.logical_grant_id}: ${message}`);
    }
  }
  return processed;
}

async function objectFingerprint(key: string): Promise<string> {
  return fingerprint(`client-folder-object:${key}`);
}

/** Record only an authorization-relative net change. Source bytes never pass
 * through this path; the R2 event consumer has already verified object state. */
export async function recordClientFolderFileChange(env: Env, key: string, present: boolean): Promise<number> {
  if (!env.DELIVERY_DB) throw new Error("delivery-db-binding-required");
  if (!(await clientFolderChangeNotificationsAvailable(env))) return 0;
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT association.id association_id,
      association.logical_grant_id,association.account_id,preference.recipient_identity_id
    FROM client_folder_associations association
    JOIN client_folder_notification_preferences preference
      ON preference.logical_grant_id=association.logical_grant_id AND preference.account_id=association.account_id
    WHERE association.scope_type='client' AND association.project_id IS NULL AND association.revoked_at IS NULL
      AND association.logical_grant_id IS NOT NULL AND substr(?,1,length(association.r2_prefix))=association.r2_prefix
      AND preference.mode IN (?, 'both')`)
    .bind(key, present ? "added" : "removed").all<{ association_id: string; logical_grant_id: string; account_id: string; recipient_identity_id: string }>();
  if (!rows.results.length) return 0;
  const keyFingerprint = await objectFingerprint(key);
  for (const row of rows.results) {
    const baseline = present ? 0 : 1;
    await env.DELIVERY_DB.prepare(`INSERT INTO client_folder_change_notifications
      (id,logical_grant_id,association_id,account_id,recipient_identity_id,object_fingerprint,r2_key,baseline_present,current_present,status)
      VALUES (?,?,?,?,?,?,?,?,?,'pending')
      ON CONFLICT(logical_grant_id,recipient_identity_id,object_fingerprint) WHERE status IN ('pending','cancelled','processing')
      DO UPDATE SET association_id=excluded.association_id,r2_key=excluded.r2_key,current_present=excluded.current_present,
        status=CASE WHEN client_folder_change_notifications.baseline_present=excluded.current_present THEN 'cancelled' ELSE 'pending' END,
        attempt_count=0,next_attempt_at=datetime('now','+5 minutes'),lease_expires_at=NULL,last_error=NULL,updated_at=datetime('now')`)
      .bind(crypto.randomUUID(), row.logical_grant_id, row.association_id, row.account_id, row.recipient_identity_id, keyFingerprint, key, baseline, present ? 1 : 0).run();
  }
  return rows.results.length;
}

interface FolderChangeRow {
  id: string;
  logical_grant_id: string;
  account_id: string;
  recipient_identity_id: string;
  r2_key: string;
  current_present: number;
  attempt_count: number;
}

export async function processClientFolderChangeNotifications(env: Env): Promise<number> {
  if (!env.DELIVERY_DB) throw new Error("delivery-db-binding-required");
  if (!(await clientFolderChangeNotificationsAvailable(env))) return 0;
  let processed = 0;
  for (; processed < 50; processed += 1) {
    const row = await env.DELIVERY_DB.prepare(`SELECT id,logical_grant_id,account_id,recipient_identity_id,r2_key,current_present,attempt_count
      FROM client_folder_change_notifications
      WHERE ((status='pending' AND datetime(next_attempt_at)<=datetime('now')) OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))
        AND attempt_count<? ORDER BY created_at LIMIT 1`).bind(MAX_ATTEMPTS).first<FolderChangeRow>();
    if (!row) break;
    const claimed = await env.DELIVERY_DB.prepare(`UPDATE client_folder_change_notifications SET status='processing',attempt_count=attempt_count+1,
      lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now') WHERE id=? AND attempt_count<?
      AND ((status='pending' AND datetime(next_attempt_at)<=datetime('now')) OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))`)
      .bind(row.id, MAX_ATTEMPTS).run();
    if (!claimed.meta.changes) { processed -= 1; continue; }
    const context = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT a.display_name account_name,i.email recipient_email,
        preference.mode,association.r2_prefix,a.project_alpha_client_id,a.project_alpha_organization_id,
        EXISTS(SELECT 1 FROM file_index f WHERE f.r2_key=?) object_present
      FROM client_folder_associations association
      JOIN client_folder_notification_preferences preference
        ON preference.logical_grant_id=association.logical_grant_id AND preference.account_id=association.account_id
        AND preference.recipient_identity_id=? AND preference.mode<>'off'
      JOIN client_accounts a ON a.id=association.account_id AND a.status='active'
        AND (a.project_alpha_client_id IS NOT NULL OR a.project_alpha_organization_id IS NOT NULL)
      JOIN client_identity_links i ON i.id=preference.recipient_identity_id AND i.account_id=a.id AND i.revoked_at IS NULL AND i.email IS NOT NULL
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      WHERE association.logical_grant_id=? AND association.account_id=? AND association.scope_type='client'
        AND association.project_id IS NULL AND association.revoked_at IS NULL AND substr(?,1,length(association.r2_prefix))=association.r2_prefix
      LIMIT 1`).bind(row.r2_key, row.recipient_identity_id, row.logical_grant_id, row.account_id, row.r2_key)
      .first<{ account_name: string; recipient_email: string; mode: ClientFolderNotificationMode; r2_prefix: string; object_present: number; project_alpha_client_id: string | null; project_alpha_organization_id: string | null }>();
    const wanted = row.current_present === 1 ? "added" : "removed";
    if (!context || ![wanted, "both"].includes(context.mode) || Boolean(context.object_present) !== Boolean(row.current_present)) {
      await env.DELIVERY_DB.prepare("UPDATE client_folder_change_notifications SET status='suppressed',lease_expires_at=NULL,last_error='authorization-or-object-state-changed',updated_at=datetime('now') WHERE id=? AND status='processing'").bind(row.id).run();
      continue;
    }
    try {
      await authoritativeFolderGrantScope(env, context.r2_prefix, {
        id: row.account_id,
        project_alpha_client_id: context.project_alpha_client_id,
        project_alpha_organization_id: context.project_alpha_organization_id,
      });
    } catch {
      await env.DELIVERY_DB.prepare("UPDATE client_folder_change_notifications SET status='suppressed',lease_expires_at=NULL,last_error='authoritative-folder-owner-changed',updated_at=datetime('now') WHERE id=? AND status='processing'").bind(row.id).run();
      continue;
    }
    const title = wanted === "added" ? "New files available" : "Files removed";
    const body = wanted === "added" ? "Files were added to your LTDS client workspace." : "Files were removed from your LTDS client workspace.";
    const actionPath = "/portal/deliveries";
    try {
      const rendered = {
        subject: `${title} — ${context.account_name}`,
        text: `${body}\n\nOpen client deliveries: ${new URL(actionPath, env.DELIVERY_BASE_URL).toString()}`,
        html: `<p>${body}</p><p><a href="${new URL(actionPath, env.DELIVERY_BASE_URL).toString()}">Open client deliveries</a></p>`,
      };
      await env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), row.account_id, row.recipient_identity_id,
          wanted === "added" ? "files_added" : "files_removed", "folder_grant", row.logical_grant_id, `folder-change:${row.id}`, title, body, actionPath).run();
      await sendNotificationMail(env, { to: context.recipient_email, fromName: "LTDS Client Portal", ...rendered, messageIdKey: row.id });
      await env.DELIVERY_DB.batch([
        env.DELIVERY_DB.prepare("UPDATE client_folder_change_notifications SET status='sent',delivered_at=datetime('now'),lease_expires_at=NULL,updated_at=datetime('now') WHERE id=? AND status='processing'").bind(row.id),
      ]);
    } catch (error) {
      const attempt = row.attempt_count + 1;
      const terminal = attempt >= MAX_ATTEMPTS;
      const message = (error instanceof Error ? error.message : "email-send-failed").slice(0, 240);
      await env.DELIVERY_DB.prepare("UPDATE client_folder_change_notifications SET status=?,next_attempt_at=datetime('now',?),lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=? AND status='processing'")
        .bind(terminal ? "failed" : "pending", terminal ? "+0 seconds" : `+${2 ** attempt * 5} minutes`, message, row.id).run();
      if (terminal) await sendAdminAlert(env, "Client workspace notification failed", `Notification ${row.id}: ${message}`);
    }
  }
  return processed;
}
