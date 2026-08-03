import { HTTPException } from "hono/http-exception";
import { requirePermission } from "./acl";
import { sendAdminAlert } from "./alerts";
import { sendNotificationMail } from "./mailer";
import { auditStatement } from "./request-security";
import { normalizeCrudKey } from "./r2-crud-validation";
import type { Env, StaffPrincipal } from "./types";

const MAX_ATTEMPTS = 3;

export interface ClientFolderGrantInput {
  accountId: string;
  divisionId: string;
  r2Prefix: string;
  grantId?: string;
  recipientIdentityId?: string | null;
}

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
}

function stableInput(input: ClientFolderGrantInput, prefix: string): string {
  return JSON.stringify({
    accountId: input.accountId,
    divisionId: input.divisionId,
    grantId: input.grantId || null,
    r2Prefix: prefix,
    recipientIdentityId: input.recipientIdentityId || null,
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
    WHERE a.id=? AND a.status='active' AND a.project_alpha_client_id IS NOT NULL`).bind(identityId, accountId).first<{ ok: number }>();
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

export async function createClientFolderGrant(env: Env, request: Request, principal: StaffPrincipal, input: ClientFolderGrantInput, mutationKey: string) {
  if (!env.DELIVERY_DB) throw new Error("delivery-db-binding-required");
  if (mutationKey.length < 16 || mutationKey.length > 128)
    throw new HTTPException(400, { message: "Idempotency-Key must contain 16-128 characters" });
  const prefix = normalizeCrudKey(input.r2Prefix, true);
  await requirePermission(env, principal, "delivery.share.create", { divisionId: input.divisionId }, true);
  const mutationFingerprint = await fingerprint(stableInput(input, prefix));
  const replay = await mutationReplay(env, input.accountId, mutationKey, mutationFingerprint);
  if (replay) return { ...mapGrant(replay), idempotentReplay: true, unchanged: false };

  const account = await env.DELIVERY_DB.withSession("first-primary").prepare(
    "SELECT id FROM client_accounts WHERE id=? AND status='active' AND project_alpha_client_id IS NOT NULL",
  ).bind(input.accountId).first<{ id: string }>();
  if (!account) throw new HTTPException(404, { message: "Active client workspace not found" });
  if (input.recipientIdentityId && !(await activeRecipient(env, input.accountId, input.recipientIdentityId)))
    throw new HTTPException(409, { message: "Notification recipient is not an active member of this client workspace" });

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
        AND revoked_at IS NULL AND logical_grant_id IS NOT NULL
        AND substr(?,1,length(r2_prefix))=r2_prefix
      ORDER BY length(r2_prefix) LIMIT 1`).bind(input.accountId, prefix).first<GrantRow>();
    if (covered) {
      await db.batch([
        mutationStatement(env, { accountId: input.accountId, mutationKey, fingerprint: mutationFingerprint, grantId: covered.logical_grant_id, version: covered.grant_version, associationId: covered.id }),
      ]);
      return { ...mapGrant(covered), idempotentReplay: false, unchanged: true };
    }
  }

  if (previous?.r2_prefix === prefix && previous.division_id === input.divisionId) {
    await db.batch([
      mutationStatement(env, { accountId: input.accountId, mutationKey, fingerprint: mutationFingerprint, grantId: previous.logical_grant_id, version: previous.grant_version, associationId: previous.id }),
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
  const notification = exposesNewScope ? notificationStatement(env, {
    grantId,
    version,
    associationId,
    accountId: input.accountId,
    recipientIdentityId: input.recipientIdentityId,
    priorCoverage,
  }) : null;
  const statements: D1PreparedStatement[] = [];
  if (previous) statements.push(db.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now'),superseded_by_id=? WHERE id=? AND revoked_at IS NULL").bind(associationId, previous.id));
  statements.push(
    db.prepare(`INSERT INTO client_folder_associations
      (id,scope_type,project_id,account_id,r2_prefix,created_by,logical_grant_id,grant_version,division_id)
      VALUES (?,'client',NULL,?,?,?,?,?,?)`).bind(associationId, input.accountId, prefix, principal.id, grantId, version, input.divisionId),
    mutationStatement(env, { accountId: input.accountId, mutationKey, fingerprint: mutationFingerprint, grantId, version, associationId }),
    db.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('staff',?,'client.folder.granted','client_folder_grant',?,?)")
      .bind(principal.id, grantId, JSON.stringify({ accountId: input.accountId, associationId, version, r2Prefix: prefix, previousAssociationId: previous?.id || null })),
  );
  if (notification) statements.push(notification);
  try {
    const results = await db.batch(statements);
    if (previous && !results[0]?.meta.changes)
      throw new HTTPException(409, { message: "Client folder grant changed; refresh and try again" });
  } catch (error) {
    const racedReplay = await mutationReplay(env, input.accountId, mutationKey, mutationFingerprint);
    if (racedReplay) return { ...mapGrant(racedReplay), idempotentReplay: true, unchanged: false };
    throw error;
  }
  await env.OPS_DB.batch([await auditStatement(env, request, principal, "client.folder.granted", "client_folder_grant", grantId, input.divisionId, { accountId: input.accountId, associationId, version, r2Prefix: prefix })]);
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
  await requirePermission(env, principal, "delivery.share.revoke", { divisionId: row.division_id }, true);
  const result = await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL").bind(row.id),
    env.DELIVERY_DB.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('staff',?,'client.folder.revoked','client_folder_grant',?,?)")
      .bind(principal.id, grantId, JSON.stringify({ accountId: row.account_id, associationId: row.id, version: row.grant_version, r2Prefix: row.r2_prefix })),
  ]);
  if (!result[0]?.meta.changes) throw new HTTPException(404, { message: "Active client folder grant not found" });
  await env.OPS_DB.batch([await auditStatement(env, request, principal, "client.folder.revoked", "client_folder_grant", grantId, row.division_id, { accountId: row.account_id, associationId: row.id, version: row.grant_version, r2Prefix: row.r2_prefix })]);
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
    const context = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT association.r2_prefix,a.display_name account_name,i.email recipient_email
      FROM client_folder_associations association
      JOIN client_accounts a ON a.id=association.account_id AND a.status='active' AND a.project_alpha_client_id IS NOT NULL
      JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL AND i.email IS NOT NULL
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      WHERE association.id=? AND association.logical_grant_id=? AND association.grant_version=?
        AND association.account_id=? AND association.scope_type='client' AND association.project_id IS NULL
        AND association.revoked_at IS NULL AND association.superseded_by_id IS NULL`)
      .bind(row.recipient_identity_id, row.association_id, row.logical_grant_id, row.grant_version, row.account_id).first<NotificationContext>();
    if (!context) { await suppress(env, row, "grant-or-recipient-no-longer-authorized"); continue; }
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
