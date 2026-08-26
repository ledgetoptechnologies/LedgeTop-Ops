import { sendAdminAlert } from "./alerts";
import { normalizePrefix } from "./delivery";
import { sendNotificationMail } from "./mailer";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";

const MAX_ATTEMPTS = 3;
const MAX_RECIPIENTS = 200;
const TABLES = ["client_folder_notification_batches", "client_folder_notification_batch_items",
  "client_folder_notification_object_state", "client_folder_notification_preferences", "client_portal_notifications"] as const;
type Mode = "off" | "added" | "removed" | "both";
export interface ClientFolderNotificationBatchIdentity {
  id: string;
  account_id: string;
  logical_grant_id: string;
  recipient_identity_id: string;
  association_id: string;
}
interface Batch extends ClientFolderNotificationBatchIdentity {
  revision: number;
  attempt_count: number;
  lease_token: string | null;
  dispatch_fingerprint: string | null;
}
interface Recipient {
  account_id: string;
  logical_grant_id: string;
  recipient_identity_id: string;
  association_id: string;
  mode: Mode;
}
interface ScopeRow {
  account_name: string;
  recipient_email: string | null;
  r2_prefix: string;
  project_alpha_client_id: string | null;
  project_alpha_organization_id: string | null;
}
export interface ClientFolderNotificationBatchScope {
  divisionId: string;
  accountName: string;
  recipientEmail: string | null;
  prefix: string;
}

export async function clientFolderNotificationBatchesAvailable(env: Env): Promise<boolean> {
  return d1TablesPresent(env.DELIVERY_DB, TABLES);
}

/** Preserve the existing legacy grant authority (project client before org).
 * Return only distinct longest-prefix owners, not the entire folder table. */
async function authoritativeScope(env: Env, row: ScopeRow): Promise<ClientFolderNotificationBatchScope | null> {
  const prefix = normalizePrefix(row.r2_prefix);
  if (prefix.length > 1000) return null;
  const ancestors: string[] = [];
  let ancestor = "";
  for (const part of prefix.split("/").filter(Boolean)) {
    ancestor += `${part}/`;
    ancestors.push(ancestor, ancestor.slice(0, -1));
  }
  const result = await env.OPS_DB.withSession("first-primary").prepare(`WITH matching AS (
      SELECT pf.division_id,pf.r2_prefix,p.client_id project_alpha_client_id,p.organization_id project_alpha_organization_id,
        length(rtrim(pf.r2_prefix,'/')||'/') prefix_length
      FROM project_folders pf JOIN pa_projects p ON p.id=pf.project_id
      WHERE p.active=1 AND pf.r2_prefix IN (SELECT value FROM json_each(?1))
    ) SELECT DISTINCT division_id,
      CASE WHEN project_alpha_client_id IS NOT NULL AND project_alpha_client_id<>'' THEN 'client' ELSE 'organization' END owner_type,
      CASE WHEN project_alpha_client_id IS NOT NULL AND project_alpha_client_id<>'' THEN project_alpha_client_id ELSE project_alpha_organization_id END owner_id
    FROM matching WHERE prefix_length=(SELECT MAX(prefix_length) FROM matching) LIMIT 2`)
    .bind(JSON.stringify(ancestors)).all<{ division_id: string; owner_type: "client" | "organization"; owner_id: string | null }>();
  if (result.results.length !== 1) return null;
  const owner = result.results[0]!;
  if (!owner.division_id || !owner.owner_id || owner.owner_id !== (owner.owner_type === "client"
    ? row.project_alpha_client_id : row.project_alpha_organization_id)) return null;
  return { divisionId: owner.division_id, accountName: row.account_name, recipientEmail: row.recipient_email, prefix };
}

/** History visibility is not send authorization. Revoked grants/recipients can
 * still be reviewed by staff with current permission over the same owner. */
export async function readClientFolderNotificationBatchScope(env: Env, batch: ClientFolderNotificationBatchIdentity): Promise<ClientFolderNotificationBatchScope | null> {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT a.display_name account_name,
      CASE WHEN i.revoked_at IS NULL AND EXISTS(SELECT 1 FROM client_account_members m
        WHERE m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL) THEN i.email ELSE NULL END recipient_email,
      association.r2_prefix,a.project_alpha_client_id,a.project_alpha_organization_id
    FROM client_folder_associations association JOIN client_accounts a ON a.id=association.account_id
    LEFT JOIN client_identity_links i ON i.id=? AND i.account_id=a.id
    WHERE association.id=? AND association.logical_grant_id=? AND association.account_id=?
      AND association.scope_type='client' AND association.project_id IS NULL`)
    .bind(batch.recipient_identity_id, batch.association_id, batch.logical_grant_id, batch.account_id).first<ScopeRow>();
  return row ? authoritativeScope(env, row) : null;
}

export async function authorizeClientFolderNotificationBatch(env: Env, batch: ClientFolderNotificationBatchIdentity): Promise<(ClientFolderNotificationBatchScope & { recipientEmail: string; mode: Mode }) | null> {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT a.display_name account_name,i.email recipient_email,
      association.r2_prefix,a.project_alpha_client_id,a.project_alpha_organization_id,preference.mode
    FROM client_folder_associations association JOIN client_accounts a ON a.id=association.account_id AND a.status='active'
    JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL AND i.email IS NOT NULL
    JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
    JOIN client_folder_notification_preferences preference ON preference.account_id=a.id
      AND preference.logical_grant_id=association.logical_grant_id AND preference.recipient_identity_id=i.id AND preference.mode<>'off'
    WHERE association.id=? AND association.logical_grant_id=? AND association.account_id=?
      AND association.scope_type='client' AND association.project_id IS NULL
      AND association.revoked_at IS NULL AND association.superseded_by_id IS NULL`)
    .bind(batch.recipient_identity_id, batch.association_id, batch.logical_grant_id, batch.account_id).first<ScopeRow & { mode: Mode }>();
  if (!row?.recipient_email) return null;
  const scope = await authoritativeScope(env, row);
  return scope ? { ...scope, recipientEmail: row.recipient_email, mode: row.mode } : null;
}

async function fingerprint(key: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`client-folder-object:${key}`));
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
}

const countsSql = `added_count=(SELECT COUNT(*) FROM client_folder_notification_batch_items i WHERE i.batch_id=client_folder_notification_batches.id AND i.baseline_present=0 AND i.current_present=1),
  removed_count=(SELECT COUNT(*) FROM client_folder_notification_batch_items i WHERE i.batch_id=client_folder_notification_batches.id AND i.baseline_present=1 AND i.current_present=0)`;

/** Adopt only unclaimed/expired legacy rows in a bounded atomic batch. The
 * legacy sender is not run after this capability becomes available. An expired
 * lease retains the pre-existing at-least-once SMTP ambiguity. */
export async function adoptLegacyClientFolderNotifications(env: Env, key?: string): Promise<number> {
  const limit = key ? MAX_RECIPIENTS : 50;
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,account_id,logical_grant_id,recipient_identity_id,
      association_id,object_fingerprint,r2_key,baseline_present,current_present,attempt_count
    FROM client_folder_change_notifications WHERE (status='pending' OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))
      ${key ? "AND r2_key=?" : ""} ORDER BY created_at,id LIMIT ?`)
    .bind(...(key ? [key, limit + 1] : [limit])).all<Recipient & { id: string; object_fingerprint: string; r2_key: string; baseline_present: number; current_present: number; attempt_count: number }>();
  if (key && rows.results.length > limit) throw new Error("folder-notification-adoption-fanout-limit");
  if (!rows.results.length) return 0;
  const targets = JSON.stringify(rows.results.map(row => ({ id: row.id, batch_id: crypto.randomUUID() })));
  const token = crypto.randomUUID();
  // Re-read old rows inside the atomic transaction, not the stale selection.
  const cte = `WITH targets AS (SELECT old.*,json_extract(candidate.value,'$.batch_id') batch_id
    FROM json_each(?1) candidate JOIN client_folder_change_notifications old ON old.id=json_extract(candidate.value,'$.id')
    WHERE old.status='pending' OR (old.status='processing' AND datetime(old.lease_expires_at)<=datetime('now')))`;
  const unseen = `NOT EXISTS(SELECT 1 FROM client_folder_notification_object_state s WHERE s.account_id=t.account_id
    AND s.logical_grant_id=t.logical_grant_id AND s.recipient_identity_id=t.recipient_identity_id AND s.object_fingerprint=t.object_fingerprint)`;
  const live = `EXISTS(SELECT 1 FROM client_folder_associations a WHERE a.id=t.association_id AND a.account_id=t.account_id
    AND a.logical_grant_id=t.logical_grant_id AND a.scope_type='client' AND a.project_id IS NULL AND a.revoked_at IS NULL AND a.superseded_by_id IS NULL)`;
  const result = await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare(`${cte} UPDATE client_folder_notification_batches AS b SET status='suppressed',revision=revision+1,
      sealed_at=datetime('now'),last_error='grant-version-replaced',updated_at=datetime('now')
      WHERE b.status='pending' AND b.sealed_at IS NULL AND EXISTS(SELECT 1 FROM targets t WHERE t.account_id=b.account_id
        AND t.logical_grant_id=b.logical_grant_id AND t.recipient_identity_id=b.recipient_identity_id AND t.association_id<>b.association_id AND ${live})`)
      .bind(targets),
    env.DELIVERY_DB.prepare(`${cte} INSERT INTO client_folder_notification_batches(id,account_id,logical_grant_id,recipient_identity_id,association_id)
      SELECT t.batch_id,t.account_id,t.logical_grant_id,t.recipient_identity_id,t.association_id FROM targets t WHERE ${unseen} AND ${live}
      ON CONFLICT(account_id,logical_grant_id,recipient_identity_id) WHERE status='pending' AND sealed_at IS NULL DO NOTHING`).bind(targets),
    env.DELIVERY_DB.prepare(`${cte} INSERT INTO client_folder_notification_batch_items(batch_id,object_fingerprint,r2_key,baseline_present,current_present,event_token)
      SELECT b.id,t.object_fingerprint,t.r2_key,t.baseline_present,t.current_present,?2 FROM targets t
      JOIN client_folder_notification_batches b ON b.account_id=t.account_id AND b.logical_grant_id=t.logical_grant_id
        AND b.recipient_identity_id=t.recipient_identity_id AND b.association_id=t.association_id
      WHERE b.status='pending' AND b.sealed_at IS NULL AND ${unseen} AND ${live}
      ON CONFLICT(batch_id,object_fingerprint) DO NOTHING`).bind(targets, token),
    env.DELIVERY_DB.prepare(`${cte} UPDATE client_folder_notification_batches SET revision=revision+1,${countsSql},
      attempt_count=MAX(attempt_count,COALESCE((SELECT MAX(t.attempt_count) FROM targets t WHERE t.account_id=client_folder_notification_batches.account_id
        AND t.logical_grant_id=client_folder_notification_batches.logical_grant_id AND t.recipient_identity_id=client_folder_notification_batches.recipient_identity_id),0)),
      eligible_at=datetime('now','+5 minutes'),updated_at=datetime('now') WHERE status='pending' AND sealed_at IS NULL
        AND id IN (SELECT batch_id FROM client_folder_notification_batch_items WHERE event_token=?2)`).bind(targets, token),
    env.DELIVERY_DB.prepare(`${cte} INSERT INTO client_folder_notification_object_state(account_id,logical_grant_id,recipient_identity_id,object_fingerprint,current_present)
      SELECT account_id,logical_grant_id,recipient_identity_id,object_fingerprint,current_present FROM targets WHERE 1
      ON CONFLICT(account_id,logical_grant_id,recipient_identity_id,object_fingerprint) DO NOTHING`).bind(targets),
    env.DELIVERY_DB.prepare(`${cte} UPDATE client_folder_change_notifications SET status='suppressed',lease_expires_at=NULL,
      last_error='adopted-by-folder-notification-batches',updated_at=datetime('now') WHERE id IN (SELECT id FROM targets)`).bind(targets),
  ]);
  return Number(result[5]?.meta.changes || 0);
}

export async function recordClientFolderBatchChange(env: Env, key: string, present: boolean): Promise<number> {
  await adoptLegacyClientFolderNotifications(env, key);
  // Include opposite events for added-only/removed-only subscriptions: they
  // still cancel an existing net change or reset the observed state.
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT association.id association_id,
      association.account_id,association.logical_grant_id,preference.recipient_identity_id,preference.mode
    FROM client_folder_associations association JOIN client_folder_notification_preferences preference
      ON preference.logical_grant_id=association.logical_grant_id AND preference.account_id=association.account_id
    WHERE association.scope_type='client' AND association.project_id IS NULL AND association.revoked_at IS NULL
      AND association.superseded_by_id IS NULL AND association.logical_grant_id IS NOT NULL AND preference.mode<>'off'
      AND substr(?,1,length(association.r2_prefix))=association.r2_prefix
    ORDER BY association.account_id,association.logical_grant_id,preference.recipient_identity_id LIMIT ?`)
    .bind(key, MAX_RECIPIENTS + 1).all<Recipient>();
  if (rows.results.length > MAX_RECIPIENTS) throw new Error("folder-notification-recipient-fanout-limit");
  if (!rows.results.length) return 0;
  const hash = await fingerprint(key);
  const state = present ? 1 : 0, wanted = present ? "added" : "removed", token = crypto.randomUUID();
  const targets = JSON.stringify(rows.results.map(row => ({ ...row, batch_id: crypto.randomUUID() })));
  const cte = `WITH targets AS (SELECT json_extract(value,'$.account_id') account_id,
    json_extract(value,'$.logical_grant_id') logical_grant_id,json_extract(value,'$.recipient_identity_id') recipient_identity_id,
    json_extract(value,'$.association_id') association_id,json_extract(value,'$.batch_id') batch_id FROM json_each(?1))`;
  const live = `EXISTS(SELECT 1 FROM client_folder_associations a JOIN client_folder_notification_preferences p
    ON p.account_id=a.account_id AND p.logical_grant_id=a.logical_grant_id WHERE a.id=t.association_id
      AND a.account_id=t.account_id AND a.logical_grant_id=t.logical_grant_id AND a.scope_type='client' AND a.project_id IS NULL
      AND a.revoked_at IS NULL AND a.superseded_by_id IS NULL AND substr(?4,1,length(a.r2_prefix))=a.r2_prefix
      AND p.recipient_identity_id=t.recipient_identity_id AND p.mode<>'off')`;
  const different = `NOT EXISTS(SELECT 1 FROM client_folder_notification_object_state s WHERE s.account_id=t.account_id
    AND s.logical_grant_id=t.logical_grant_id AND s.recipient_identity_id=t.recipient_identity_id AND s.object_fingerprint=?2 AND s.current_present=?3)
    AND NOT EXISTS(SELECT 1 FROM client_folder_change_notifications old WHERE old.account_id=t.account_id AND old.logical_grant_id=t.logical_grant_id
      AND old.recipient_identity_id=t.recipient_identity_id AND old.object_fingerprint=?2 AND old.current_present=?3
      AND old.status='processing' AND datetime(old.lease_expires_at)>datetime('now'))`;
  const subscribed = `EXISTS(SELECT 1 FROM client_folder_notification_preferences p WHERE p.account_id=t.account_id
    AND p.logical_grant_id=t.logical_grant_id AND p.recipient_identity_id=t.recipient_identity_id AND p.mode IN (?5,'both'))`;
  // A fixed-size transaction, independent of the recipient count. event_token
  // identifies only item changes in this transaction, so duplicate events do
  // not bump unrelated recipients' revisions or grace windows.
  const results = await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare(`${cte} INSERT INTO client_folder_notification_object_state(account_id,logical_grant_id,recipient_identity_id,object_fingerprint,current_present)
      SELECT old.account_id,old.logical_grant_id,old.recipient_identity_id,old.object_fingerprint,old.current_present
      FROM targets t JOIN client_folder_change_notifications old ON old.id=(SELECT latest.id FROM client_folder_change_notifications latest
        WHERE latest.account_id=t.account_id AND latest.logical_grant_id=t.logical_grant_id AND latest.recipient_identity_id=t.recipient_identity_id
          AND latest.object_fingerprint=?2 AND latest.status IN ('sent','cancelled','suppressed','failed') ORDER BY latest.updated_at DESC,latest.id DESC LIMIT 1)
      WHERE NOT EXISTS(SELECT 1 FROM client_folder_change_notifications active WHERE active.account_id=t.account_id
        AND active.logical_grant_id=t.logical_grant_id AND active.recipient_identity_id=t.recipient_identity_id AND active.object_fingerprint=?2
        AND active.status IN ('pending','processing'))
      ON CONFLICT(account_id,logical_grant_id,recipient_identity_id,object_fingerprint) DO NOTHING`).bind(targets, hash),
    env.DELIVERY_DB.prepare(`${cte} UPDATE client_folder_notification_batches AS b SET status='suppressed',revision=revision+1,
      sealed_at=datetime('now'),last_error='grant-version-replaced',updated_at=datetime('now')
      WHERE b.status='pending' AND b.sealed_at IS NULL AND EXISTS(SELECT 1 FROM targets t WHERE t.account_id=b.account_id
        AND t.logical_grant_id=b.logical_grant_id AND t.recipient_identity_id=b.recipient_identity_id AND t.association_id<>b.association_id AND ${live})`)
      .bind(targets, null, null, key),
    env.DELIVERY_DB.prepare(`${cte} INSERT INTO client_folder_notification_batches(id,account_id,logical_grant_id,recipient_identity_id,association_id)
      SELECT t.batch_id,t.account_id,t.logical_grant_id,t.recipient_identity_id,t.association_id FROM targets t WHERE ${live} AND ${different} AND ${subscribed}
      ON CONFLICT(account_id,logical_grant_id,recipient_identity_id) WHERE status='pending' AND sealed_at IS NULL DO NOTHING`)
      .bind(targets, hash, state, key, wanted),
    env.DELIVERY_DB.prepare(`${cte} INSERT INTO client_folder_notification_batch_items(batch_id,object_fingerprint,r2_key,baseline_present,current_present,event_token)
      SELECT b.id,?2,?4,1-?3,?3,?6 FROM targets t JOIN client_folder_notification_batches b ON b.account_id=t.account_id
        AND b.logical_grant_id=t.logical_grant_id AND b.recipient_identity_id=t.recipient_identity_id AND b.association_id=t.association_id
      WHERE b.status='pending' AND b.sealed_at IS NULL AND ${live} AND ${different}
        AND (${subscribed} OR EXISTS(SELECT 1 FROM client_folder_notification_batch_items i WHERE i.batch_id=b.id AND i.object_fingerprint=?2))
      ON CONFLICT(batch_id,object_fingerprint) DO UPDATE SET current_present=excluded.current_present,event_token=excluded.event_token,updated_at=datetime('now')
        WHERE client_folder_notification_batch_items.current_present<>excluded.current_present`).bind(targets, hash, state, key, wanted, token),
    env.DELIVERY_DB.prepare(`UPDATE client_folder_notification_batches SET revision=revision+1,${countsSql},eligible_at=datetime('now','+5 minutes'),updated_at=datetime('now')
      WHERE status='pending' AND sealed_at IS NULL AND id IN (SELECT batch_id FROM client_folder_notification_batch_items WHERE event_token=?)`).bind(token),
    env.DELIVERY_DB.prepare(`UPDATE client_folder_notification_batches SET status='cancelled',revision=revision+1,sealed_at=datetime('now'),
      last_error='net-changes-cancelled',updated_at=datetime('now') WHERE status='pending' AND sealed_at IS NULL AND added_count=0 AND removed_count=0
        AND id IN (SELECT batch_id FROM client_folder_notification_batch_items WHERE event_token=?)`).bind(token),
    env.DELIVERY_DB.prepare(`${cte} INSERT INTO client_folder_notification_object_state(account_id,logical_grant_id,recipient_identity_id,object_fingerprint,current_present)
      SELECT t.account_id,t.logical_grant_id,t.recipient_identity_id,?2,?3 FROM targets t WHERE ${live} AND ${different}
      ON CONFLICT(account_id,logical_grant_id,recipient_identity_id,object_fingerprint) DO UPDATE SET current_present=excluded.current_present,updated_at=datetime('now')
        WHERE client_folder_notification_object_state.current_present<>excluded.current_present`).bind(targets, hash, state, key),
  ]);
  return Number(results[3]?.meta.changes || 0);
}

async function suppress(env: Env, row: Batch, reason: string): Promise<void> {
  await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare(`UPDATE client_folder_notification_batches SET status='suppressed',revision=revision+1,
      last_error=?,lease_token=NULL,lease_expires_at=NULL,updated_at=datetime('now')
      WHERE id=? AND status='processing' AND lease_token=?`).bind(reason, row.id, row.lease_token),
    lifecycleAudit(env, row.id, "suppressed", { reason }),
  ]);
}

function lifecycleAudit(env: Env, id: string, action: "sent" | "suppressed" | "retry" | "failed", details: Record<string, string | number>): D1PreparedStatement {
  return env.DELIVERY_DB.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
    SELECT 'system','client-folder-notification-batches',?,'client_folder_notification_batch',?,? WHERE changes()=1`)
    .bind(`delivery.notification.${action}`, id, JSON.stringify(details));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export async function processClientFolderNotificationBatches(env: Env): Promise<number> {
  await adoptLegacyClientFolderNotifications(env);
  // A crash on the final attempt must not leave an expired processing badge
  // forever. Pending adopted rows may also have already used their old budget.
  await env.DELIVERY_DB.prepare(`UPDATE client_folder_notification_batches SET status='failed',revision=revision+1,
    sealed_at=COALESCE(sealed_at,datetime('now')),lease_token=NULL,lease_expires_at=NULL,last_error='attempts-exhausted',updated_at=datetime('now')
    WHERE id IN (SELECT id FROM client_folder_notification_batches WHERE attempt_count>=?
      AND (status='pending' OR (status='processing' AND datetime(lease_expires_at)<=datetime('now'))) LIMIT 50)`)
    .bind(MAX_ATTEMPTS).run();
  let processed = 0;
  // Bound work independently of queue depth; the scheduler continues next run.
  for (let turn = 0; turn < 20; turn += 1) {
    const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,account_id,logical_grant_id,
        recipient_identity_id,association_id,revision,attempt_count,lease_token,dispatch_fingerprint
      FROM client_folder_notification_batches WHERE attempt_count<? AND
        ((status='pending' AND datetime(eligible_at)<=datetime('now')) OR
         (status='processing' AND datetime(lease_expires_at)<=datetime('now')))
      ORDER BY eligible_at,id LIMIT 1`).bind(MAX_ATTEMPTS).first<Batch>();
    if (!row) break;
    const token = crypto.randomUUID();
    const claim = await env.DELIVERY_DB.prepare(`UPDATE client_folder_notification_batches
      SET status='processing',revision=revision+1,attempt_count=attempt_count+1,sealed_at=COALESCE(sealed_at,datetime('now')),
        lease_token=?,lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now')
      WHERE id=? AND revision=? AND attempt_count<? AND
        ((status='pending' AND datetime(eligible_at)<=datetime('now')) OR
         (status='processing' AND datetime(lease_expires_at)<=datetime('now')))`)
      .bind(token, row.id, row.revision, MAX_ATTEMPTS).run();
    if (!claim.meta.changes) continue;
    row.lease_token = token;
    processed += 1;
    try {
      const context = await authorizeClientFolderNotificationBatch(env, row);
      if (!context) { await suppress(env, row, "grant-or-recipient-no-longer-authorized"); continue; }
      const counts = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT
          COALESCE(SUM(CASE WHEN i.baseline_present=0 AND i.current_present=1 AND f.r2_key IS NOT NULL AND ? IN ('added','both') THEN 1 ELSE 0 END),0) added,
          COALESCE(SUM(CASE WHEN i.baseline_present=1 AND i.current_present=0 AND f.r2_key IS NULL AND ? IN ('removed','both') THEN 1 ELSE 0 END),0) removed
        FROM client_folder_notification_batch_items i LEFT JOIN file_index f ON f.r2_key=i.r2_key
        WHERE i.batch_id=? AND substr(i.r2_key,1,length(?))=?`)
        .bind(context.mode, context.mode, row.id, context.prefix, context.prefix).first<{ added: number; removed: number }>();
      if (!counts || counts.added + counts.removed === 0) { await suppress(env, row, "no-current-net-changes"); continue; }
      // Recheck authority after the item read. This is not a distributed
      // transaction with SMTP; access may still change after provider acceptance.
      const current = await authorizeClientFolderNotificationBatch(env, row);
      if (!current || JSON.stringify(current) !== JSON.stringify(context)) { await suppress(env, row, "authorization-changed-before-dispatch"); continue; }
      const title = counts.added && counts.removed ? "Your delivery files changed" : counts.added ? "New files available" : "Files removed";
      const body = `${counts.added} ${counts.added === 1 ? "file added" : "files added"}; ${counts.removed} ${counts.removed === 1 ? "file removed" : "files removed"} in your client workspace.`;
      const actionPath = "/portal/deliveries";
      const link = new URL(actionPath, env.DELIVERY_BASE_URL).toString();
      const mail = { to: current.recipientEmail, fromName: "LTDS Client Portal", subject: `${title} — ${current.accountName}`,
        text: `${body}\n\nOpen client deliveries: ${link}`, html: `<p>${escapeHtml(body)}</p><p><a href="${escapeHtml(link)}">Open client deliveries</a></p>`, messageIdKey: row.id };
      const dispatchFingerprint = await fingerprint(JSON.stringify({ context: current, counts, mail }));
      if (row.dispatch_fingerprint && row.dispatch_fingerprint !== dispatchFingerprint) {
        await suppress(env, row, "published-summary-no-longer-current"); continue;
      }
      const publication = await env.DELIVERY_DB.batch([
        env.DELIVERY_DB.prepare(`UPDATE client_folder_notification_batches SET added_count=?,removed_count=?,
          dispatch_fingerprint=COALESCE(dispatch_fingerprint,?),published_at=COALESCE(published_at,datetime('now')),updated_at=datetime('now')
          WHERE id=? AND status='processing' AND lease_token=? AND datetime(lease_expires_at)>datetime('now')
            AND (dispatch_fingerprint IS NULL OR dispatch_fingerprint=?)`)
          .bind(counts.added, counts.removed, dispatchFingerprint, row.id, token, dispatchFingerprint),
        env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO client_portal_notifications
          (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path)
          SELECT ?,account_id,recipient_identity_id,?,'folder_grant',logical_grant_id,?,?,?,?
          FROM client_folder_notification_batches WHERE id=? AND status='processing' AND lease_token=? AND datetime(lease_expires_at)>datetime('now') AND dispatch_fingerprint=?`)
          .bind(crypto.randomUUID(), counts.added ? "files_added" : "files_removed", `folder-batch:${row.id}`, title, body, actionPath, row.id, token, dispatchFingerprint),
      ]);
      if (!publication[0]?.meta.changes) continue;
      // Use the existing SMTP/Cloudflare mailer; never route source media here.
      await sendNotificationMail(env, mail);
      await env.DELIVERY_DB.batch([
        env.DELIVERY_DB.prepare(`UPDATE client_folder_notification_batches SET status='sent',revision=revision+1,delivered_at=datetime('now'),
          lease_token=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=datetime('now') WHERE id=? AND status='processing' AND lease_token=?`)
          .bind(row.id, token),
        lifecycleAudit(env, row.id, "sent", { added: counts.added, removed: counts.removed, attempt: row.attempt_count + 1 }),
      ]);
    } catch {
      const attempt = row.attempt_count + 1;
      const terminal = attempt >= MAX_ATTEMPTS;
      // Do not persist transport exceptions containing recipient addresses.
      const reason = "notification-dispatch-failed";
      const failed = await env.DELIVERY_DB.batch([
        env.DELIVERY_DB.prepare(`UPDATE client_folder_notification_batches SET status=?,revision=revision+1,
          eligible_at=datetime('now',?),lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=datetime('now')
          WHERE id=? AND status='processing' AND lease_token=?`)
          .bind(terminal ? "failed" : "pending", `+${2 ** attempt * 5} minutes`, reason, row.id, token),
        lifecycleAudit(env, row.id, terminal ? "failed" : "retry", { attempt, reason }),
      ]);
      if (terminal && failed[0]?.meta.changes) await sendAdminAlert(env, "Client workspace notification failed", `Batch ${row.id} exhausted its delivery attempts.`);
    }
  }
  return processed;
}
