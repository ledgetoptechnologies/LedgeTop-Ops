import { sendNotificationMail, type OutboundMail } from "./mailer";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const MAX_RECIPIENTS = 200;
const MAX_ITEMS = 50;
const MAX_ATTEMPTS = 3;
const DISPATCH_LIMIT = 10;
const TABLES = [
  "portal_authenticated_delivery_notification_policies",
  "portal_authenticated_delivery_notification_policy_mutations",
  "portal_authenticated_delivery_notification_policy_audit",
  "portal_authenticated_delivery_change_batches",
  "portal_authenticated_delivery_change_batch_items",
  "portal_authenticated_delivery_change_object_versions",
  "portal_authenticated_delivery_change_controls",
  "portal_authenticated_delivery_change_audit",
] as const;

export type AuthenticatedDeliveryChangeMode = "off" | "added" | "removed" | "both";
type ChangeKind = "added" | "removed";
type BatchStatus = "pending" | "processing" | "sent" | "cancelled" | "suppressed" | "failed";

interface PolicyAuthority {
  grant_id: string;
  grant_version: number;
  logical_grant_id: string;
  workspace_id: string;
  source_id: string;
  identity_id: string;
  principal_public_id: string;
  principal_source_version: string;
}

interface PolicyRow extends PolicyAuthority {
  access_notice_enabled: number;
  change_mode: AuthenticatedDeliveryChangeMode;
  policy_version: number;
}

interface StageCandidate extends PolicyRow {
  folder_binding_id: string;
  binding_source_version: string;
  owner_scope_type: "organization" | "department" | "client" | "project";
  owner_public_id: string;
  r2_prefix: string;
}

export interface AuthenticatedDeliveryChangeBatchRow extends StageCandidate {
  id: string;
  revision: number;
  status: BatchStatus;
  eligible_at: string;
  added_count: number;
  removed_count: number;
  attempt_count: number;
  sealed_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  dispatch_fingerprint: string | null;
  published_recipient_email: string | null;
}
type BatchRow = AuthenticatedDeliveryChangeBatchRow;

interface ObjectState {
  current_present: number;
  current_object_version: string | null;
  observed_event_at: string;
}

interface BatchItem {
  baseline_present: number;
  current_present: number;
  baseline_object_version: string | null;
  current_object_version: string | null;
}

interface AuthorizedBatch {
  recipient_email: string;
  workspace_name: string;
}

export interface PolicyMutationInput {
  grantId: string;
  identityId: string;
  expectedPolicyVersion: number | null;
  accessNoticeEnabled: boolean;
  changeMode: AuthenticatedDeliveryChangeMode;
  idempotencyKey: string;
}

export interface AuthenticatedDeliveryNotificationDependencies {
  send(env: Env, mail: OutboundMail): Promise<void>;
  beforeFinalAuthorization?(): Promise<void>;
}

const defaultDependencies: AuthenticatedDeliveryNotificationDependencies = { send: sendNotificationMail };

export function authenticatedDeliveryNotificationsEnabled(env: Env): boolean {
  return env.AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED === "true";
}

export async function authenticatedDeliveryChangeNotificationsReady(env: Env): Promise<boolean> {
  return d1TablesPresent(env.DELIVERY_DB, TABLES);
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function cleanVersion(value: string | undefined | null): string | null {
  const result = value?.replace(/^"|"$/g, "").trim();
  return result ? result.slice(0, 512) : null;
}

function validEventAt(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function modeIncludes(mode: AuthenticatedDeliveryChangeMode, kind: ChangeKind): boolean {
  return mode === "both" || mode === kind;
}

/** Staff-only service primitive. Route authorization remains the caller's
 * responsibility; the exact actor is part of the replay key and immutable
 * audit. An absent row means disabled, so migration never opts anyone in. */
export async function saveAuthenticatedDeliveryNotificationPolicy(
  env: Env,
  actorStaffId: string,
  input: PolicyMutationInput,
): Promise<PolicyRow> {
  if (!authenticatedDeliveryNotificationsEnabled(env)) throw new Error("authenticated-delivery-notifications-disabled");
  if (!(await authenticatedDeliveryChangeNotificationsReady(env))) throw new Error("authenticated-delivery-notifications-schema-unavailable");
  if (!actorStaffId || !/^[A-Za-z0-9_-]{1,128}$/.test(input.grantId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.identityId)
    || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)
    || input.expectedPolicyVersion !== null && (!Number.isSafeInteger(input.expectedPolicyVersion) || input.expectedPolicyVersion < 1))
    throw new Error("authenticated-delivery-notification-policy-invalid");
  const mode = input.accessNoticeEnabled ? input.changeMode : "off";
  if (!(["off", "added", "removed", "both"] as const).includes(mode))
    throw new Error("authenticated-delivery-notification-policy-invalid");
  if (input.accessNoticeEnabled && mode === "off")
    throw new Error("authenticated-delivery-notification-policy-invalid");
  const fingerprint = await sha256(JSON.stringify([input.grantId, input.identityId, input.expectedPolicyVersion,
    input.accessNoticeEnabled, mode]));
  const db = env.DELIVERY_DB.withSession("first-primary");
  const replay = await db.prepare(`SELECT request_fingerprint,grant_id,identity_id,result_policy_version,
      result_access_notice_enabled,result_change_mode FROM portal_authenticated_delivery_notification_policy_mutations
      WHERE actor_staff_id=? AND idempotency_key=?`).bind(actorStaffId, input.idempotencyKey)
    .first<{request_fingerprint:string;grant_id:string;identity_id:string;result_policy_version:number;
      result_access_notice_enabled:number;result_change_mode:AuthenticatedDeliveryChangeMode}>();
  if (replay) {
    if (replay.request_fingerprint !== fingerprint) throw new Error("authenticated-delivery-notification-policy-idempotency-conflict");
    const row = await db.prepare(`SELECT * FROM portal_authenticated_delivery_notification_policies
      WHERE grant_id=? AND identity_id=?`).bind(replay.grant_id,replay.identity_id).first<PolicyRow>();
    if (!row) throw new Error("authenticated-delivery-notification-policy-replay-unavailable");
    return {...row,policy_version:replay.result_policy_version,access_notice_enabled:replay.result_access_notice_enabled,
      change_mode:replay.result_change_mode};
  }
  const existing = await db.prepare(`SELECT * FROM portal_authenticated_delivery_notification_policies
    WHERE grant_id=? AND identity_id=?`).bind(input.grantId,input.identityId).first<PolicyRow>();
  const authority = !input.accessNoticeEnabled && existing ? existing : await db.prepare(`SELECT grant_record.id grant_id,grant_record.grant_version,grant_record.logical_grant_id,
      grant_record.workspace_id,workspace.project_alpha_source_id source_id,recipient.identity_id,
      recipient.principal_public_id,recipient.principal_source_version
    FROM portal_v2_authenticated_delivery_grants grant_record
    JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=grant_record.id
      AND recipient.workspace_id=grant_record.workspace_id AND recipient.identity_id=?
    JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id
    JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id
      AND binding.workspace_id=grant_record.workspace_id AND binding.source_version=grant_record.binding_source_version
      AND binding.status='active' AND binding.revoked_at IS NULL
    WHERE grant_record.id=? AND grant_record.audience_type='principal' AND grant_record.status='active'
      AND grant_record.revoked_at IS NULL AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
      AND workspace.status='active' AND workspace.project_alpha_source_id='project-alpha:primary' LIMIT 1`)
    .bind(input.identityId,input.grantId).first<PolicyAuthority>();
  if (!authority) throw new Error("authenticated-delivery-notification-policy-grant-unavailable");
  if ((existing?.policy_version ?? null) !== input.expectedPolicyVersion)
    throw new Error("authenticated-delivery-notification-policy-version-conflict");
  const resultVersion = (existing?.policy_version ?? 0) + 1;
  const auditId = crypto.randomUUID();
  if (existing) {
    const updated = await db.batch([
      db.prepare(`UPDATE portal_authenticated_delivery_notification_policies SET access_notice_enabled=?,change_mode=?,
        policy_version=policy_version+1,updated_by_staff_id=?,updated_at=${NOW}
        WHERE grant_id=? AND identity_id=? AND policy_version=?`).bind(input.accessNoticeEnabled?1:0,mode,actorStaffId,
          input.grantId,input.identityId,input.expectedPolicyVersion),
      db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policy_mutations
        (actor_staff_id,idempotency_key,request_fingerprint,grant_id,identity_id,expected_policy_version,result_policy_version,
          result_access_notice_enabled,result_change_mode) SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1`).bind(actorStaffId,input.idempotencyKey,
          fingerprint,input.grantId,input.identityId,input.expectedPolicyVersion,resultVersion,input.accessNoticeEnabled?1:0,mode),
      db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policy_audit
        (id,grant_id,grant_version,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
          policy_version,access_notice_enabled,change_mode,action,actor_staff_id,request_fingerprint)
        SELECT ?,grant_id,grant_version,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
          policy_version,access_notice_enabled,change_mode,'policy.updated',?,?
        FROM portal_authenticated_delivery_notification_policies WHERE grant_id=? AND identity_id=? AND policy_version=? AND changes()=1`)
        .bind(auditId,actorStaffId,fingerprint,input.grantId,input.identityId,resultVersion),
    ]);
    if (updated.some(result => Number(result.meta.changes) !== 1))
      throw new Error("authenticated-delivery-notification-policy-version-conflict");
  } else {
    await db.batch([
      db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policies
        (grant_id,grant_version,logical_grant_id,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
          access_notice_enabled,change_mode,policy_version,updated_by_staff_id) VALUES(?,?,?,?,?,?,?,?,?,?,1,?)`)
        .bind(authority.grant_id,authority.grant_version,authority.logical_grant_id,authority.workspace_id,authority.source_id,
          authority.identity_id,authority.principal_public_id,authority.principal_source_version,input.accessNoticeEnabled?1:0,mode,actorStaffId),
      db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policy_mutations
        (actor_staff_id,idempotency_key,request_fingerprint,grant_id,identity_id,expected_policy_version,result_policy_version,
          result_access_notice_enabled,result_change_mode) VALUES(?,?,?,?,?,NULL,1,?,?)`).bind(actorStaffId,input.idempotencyKey,
          fingerprint,input.grantId,input.identityId,input.accessNoticeEnabled?1:0,mode),
      db.prepare(`INSERT INTO portal_authenticated_delivery_notification_policy_audit
        (id,grant_id,grant_version,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
          policy_version,access_notice_enabled,change_mode,action,actor_staff_id,request_fingerprint)
        SELECT ?,grant_id,grant_version,workspace_id,source_id,identity_id,principal_public_id,principal_source_version,
          policy_version,access_notice_enabled,change_mode,'policy.created',?,?
        FROM portal_authenticated_delivery_notification_policies WHERE grant_id=? AND identity_id=? AND policy_version=1`)
        .bind(auditId,actorStaffId,fingerprint,input.grantId,input.identityId),
    ]);
  }
  const result = await db.prepare(`SELECT * FROM portal_authenticated_delivery_notification_policies
    WHERE grant_id=? AND identity_id=? AND policy_version=?`).bind(input.grantId,input.identityId,resultVersion).first<PolicyRow>();
  if (!result) throw new Error("authenticated-delivery-notification-policy-write-conflict");
  return result;
}

function stagingCandidatesSql(): string {
  return `SELECT policy.*,grant_record.folder_binding_id,grant_record.binding_source_version,
      binding.owner_scope_type,binding.owner_public_id,binding.r2_prefix
    FROM portal_authenticated_delivery_notification_policies policy
    JOIN portal_v2_authenticated_delivery_grants grant_record ON grant_record.id=policy.grant_id
      AND grant_record.grant_version=policy.grant_version AND grant_record.logical_grant_id=policy.logical_grant_id
      AND grant_record.workspace_id=policy.workspace_id AND grant_record.audience_type='principal'
      AND grant_record.audience_public_id=policy.principal_public_id
      AND grant_record.audience_source_version=policy.principal_source_version
      AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
    JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=grant_record.id
      AND recipient.workspace_id=policy.workspace_id AND recipient.identity_id=policy.identity_id
      AND recipient.principal_public_id=policy.principal_public_id
      AND recipient.principal_source_version=policy.principal_source_version
    JOIN portal_v2_workspaces workspace ON workspace.id=policy.workspace_id AND workspace.project_alpha_source_id=policy.source_id
      AND workspace.status='active'
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id=policy.source_id
    JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=policy.workspace_id
      AND binding.source_version=grant_record.binding_source_version AND binding.status='active' AND binding.revoked_at IS NULL
    WHERE policy.access_notice_enabled=1 AND policy.change_mode IN (?2,'both')
      AND datetime(policy.created_at)<=datetime(?3) AND datetime(grant_record.created_at)<=datetime(?3)
      AND substr(?1,1,length(binding.r2_prefix))=binding.r2_prefix
    ORDER BY policy.identity_id,length(binding.r2_prefix) DESC,policy.grant_id LIMIT ?4`;
}

/** Called only by the shared R2 consumer after its authoritative HEAD/index
 * transition. It never runs from browser completion or an upload route. */
export async function recordAuthenticatedDeliveryObjectChange(
  env: Env,
  key: string,
  present: boolean,
  objectVersion: string | null | undefined,
  eventAt: string,
): Promise<number> {
  if (!authenticatedDeliveryNotificationsEnabled(env)) return 0;
  if (!(await authenticatedDeliveryChangeNotificationsReady(env))) throw new Error("authenticated-delivery-notifications-schema-unavailable");
  if (!key || !validEventAt(eventAt)) return 0;
  const version = cleanVersion(objectVersion);
  if (present && !version) return 0;
  const kind: ChangeKind = present ? "added" : "removed";
  const db = env.DELIVERY_DB.withSession("first-primary");
  const rows = await db.prepare(stagingCandidatesSql()).bind(key,kind,eventAt,MAX_RECIPIENTS+1).all<StageCandidate>();
  if (rows.results.length > MAX_RECIPIENTS) throw new Error("authenticated-delivery-notification-recipient-capacity");
  const selected: StageCandidate[] = [];
  for (const identity of new Set(rows.results.map(row => row.identity_id))) {
    const candidates = rows.results.filter(row => row.identity_id === identity);
    const maximum = Math.max(...candidates.map(row => row.r2_prefix.length));
    const longest = candidates.filter(row => row.r2_prefix.length === maximum);
    // Equal longest authority is ambiguous even if its presentation happens
    // to match. Suppress rather than choosing by row order.
    if (longest.length === 1) selected.push(longest[0]!);
  }
  const fingerprint = await sha256(`authenticated-delivery-object:v1:${key}`);
  let staged = 0;
  for (const candidate of selected) {
    if (!modeIncludes(candidate.change_mode,kind)) continue;
    const state = await db.prepare(`SELECT current_present,current_object_version,observed_event_at
      FROM portal_authenticated_delivery_change_object_versions WHERE grant_id=? AND grant_version=?
        AND identity_id=? AND object_fingerprint=?`).bind(candidate.grant_id,candidate.grant_version,candidate.identity_id,fingerprint).first<ObjectState>();
    if (state && Date.parse(eventAt) < Date.parse(state.observed_event_at)) continue;
    if (state && state.current_present === (present?1:0) && state.current_object_version === version) continue;

    let open = await db.prepare(`SELECT batch.*,COUNT(item.object_fingerprint) item_count
      FROM portal_authenticated_delivery_change_batches batch LEFT JOIN portal_authenticated_delivery_change_batch_items item ON item.batch_id=batch.id
      WHERE batch.grant_id=? AND batch.grant_version=? AND batch.identity_id=? AND batch.policy_version=?
        AND batch.status='pending' AND batch.sealed_at IS NULL
      GROUP BY batch.id LIMIT 1`).bind(candidate.grant_id,candidate.grant_version,candidate.identity_id,candidate.policy_version)
      .first<BatchRow & {item_count:number}>();
    let existingItem: BatchItem | null = null;
    if (open) existingItem = await db.prepare(`SELECT baseline_present,current_present,baseline_object_version,current_object_version
      FROM portal_authenticated_delivery_change_batch_items WHERE batch_id=? AND object_fingerprint=?`)
      .bind(open.id,fingerprint).first<BatchItem>();
    if (open && !existingItem && Number(open.item_count) >= MAX_ITEMS) {
      await db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET sealed_at=${NOW},revision=revision+1,updated_at=${NOW}
        WHERE id=? AND status='pending' AND sealed_at IS NULL`).bind(open.id).run();
      open = null;
    }
    if (!open) {
      const batchId = crypto.randomUUID();
      await db.prepare(`INSERT INTO portal_authenticated_delivery_change_batches
        (id,grant_id,grant_version,logical_grant_id,workspace_id,source_id,folder_binding_id,binding_source_version,
          owner_scope_type,owner_public_id,r2_prefix,identity_id,principal_public_id,principal_source_version,policy_version)
        SELECT ?,policy.grant_id,policy.grant_version,policy.logical_grant_id,policy.workspace_id,policy.source_id,
          grant_record.folder_binding_id,grant_record.binding_source_version,binding.owner_scope_type,binding.owner_public_id,binding.r2_prefix,
          policy.identity_id,policy.principal_public_id,policy.principal_source_version,policy.policy_version
        FROM portal_authenticated_delivery_notification_policies policy
        JOIN portal_v2_authenticated_delivery_grants grant_record ON grant_record.id=policy.grant_id AND grant_record.grant_version=policy.grant_version
          AND grant_record.status='active' AND grant_record.revoked_at IS NULL
        JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=policy.workspace_id
          AND binding.status='active' AND binding.revoked_at IS NULL AND binding.source_version=grant_record.binding_source_version
        WHERE policy.grant_id=? AND policy.identity_id=? AND policy.policy_version=? AND policy.access_notice_enabled=1
          AND policy.change_mode IN (?,'both') AND substr(?,1,length(binding.r2_prefix))=binding.r2_prefix`)
        .bind(batchId,candidate.grant_id,candidate.identity_id,candidate.policy_version,kind,key).run();
      open = await db.prepare(`SELECT batch.*,0 item_count FROM portal_authenticated_delivery_change_batches batch
        WHERE id=?`).bind(batchId).first<BatchRow & {item_count:number}>();
      if (!open) continue;
    }
    const token = crypto.randomUUID();
    const baselinePresent = existingItem?.baseline_present ?? (present ? 0 : 1);
    const baselineVersion = existingItem?.baseline_object_version ?? (present ? null : (state?.current_object_version ?? version));
    const stagedAuditId = await sha256(`authenticated-delivery-change-audit:v1:${open.id}:batch.staged:${token}`);
    await db.batch([
      db.prepare(`INSERT INTO portal_authenticated_delivery_change_batch_items
        (batch_id,object_fingerprint,r2_key,baseline_present,current_present,baseline_object_version,current_object_version,event_token)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,object_fingerprint) DO UPDATE SET
          current_present=excluded.current_present,current_object_version=excluded.current_object_version,
          event_token=excluded.event_token,updated_at=${NOW}
        WHERE portal_authenticated_delivery_change_batch_items.current_present<>excluded.current_present
          OR portal_authenticated_delivery_change_batch_items.current_object_version IS NOT excluded.current_object_version`)
        .bind(open.id,fingerprint,key,baselinePresent,present?1:0,baselineVersion,version,token),
      db.prepare(`INSERT INTO portal_authenticated_delivery_change_object_versions
        (grant_id,grant_version,identity_id,object_fingerprint,r2_key,current_present,current_object_version,observed_event_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(grant_id,grant_version,identity_id,object_fingerprint) DO UPDATE SET
          r2_key=excluded.r2_key,current_present=excluded.current_present,current_object_version=excluded.current_object_version,
          observed_event_at=excluded.observed_event_at,updated_at=${NOW}
        WHERE datetime(excluded.observed_event_at)>=datetime(portal_authenticated_delivery_change_object_versions.observed_event_at)`)
        .bind(candidate.grant_id,candidate.grant_version,candidate.identity_id,fingerprint,key,present?1:0,version,eventAt),
      db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET revision=revision+1,
        added_count=(SELECT count(*) FROM portal_authenticated_delivery_change_batch_items item WHERE item.batch_id=id AND item.baseline_present=0 AND item.current_present=1),
        removed_count=(SELECT count(*) FROM portal_authenticated_delivery_change_batch_items item WHERE item.batch_id=id AND item.baseline_present=1 AND item.current_present=0),
        eligible_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),updated_at=${NOW}
        WHERE id=? AND status='pending' AND sealed_at IS NULL
          AND EXISTS(SELECT 1 FROM portal_authenticated_delivery_change_batch_items item WHERE item.batch_id=id AND item.event_token=?)`)
        .bind(open.id,token),
      db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET status='cancelled',sealed_at=${NOW},
        revision=revision+1,last_error='net-change-empty',updated_at=${NOW}
        WHERE id=? AND status='pending' AND sealed_at IS NULL AND added_count=0 AND removed_count=0`).bind(open.id),
      db.prepare(`INSERT OR IGNORE INTO portal_authenticated_delivery_change_audit
        (id,batch_id,action,attempt_count,reason_code) SELECT ?,id,'batch.staged',attempt_count,NULL
        FROM portal_authenticated_delivery_change_batches WHERE id=?
          AND EXISTS(SELECT 1 FROM portal_authenticated_delivery_change_batch_items item WHERE item.batch_id=id AND item.event_token=?)`)
        .bind(stagedAuditId,open.id,token),
    ]);
    const changed = await db.prepare(`SELECT 1 ok FROM portal_authenticated_delivery_change_batch_items
      WHERE batch_id=? AND object_fingerprint=? AND event_token=?`).bind(open.id,fingerprint,token).first("ok");
    if (changed !== null) staged++;
  }
  return staged;
}

function accessTermsSql(grant = "grant_record"): string {
  return `(${grant}.access_terms_id IS NULL OR EXISTS(SELECT 1 FROM portal_project_access_terms terms
    LEFT JOIN portal_project_access_deadlines deadline ON deadline.access_terms_id=terms.id
    WHERE terms.id=${grant}.access_terms_id AND terms.workspace_id=${grant}.workspace_id
      AND EXISTS(SELECT 1 FROM lineage term_project WHERE term_project.entity_type='project'
        AND term_project.public_id=terms.project_public_id)
      AND ((terms.mode='until_revoked') OR (terms.mode='specific_date' AND datetime(terms.expires_at)>datetime('now'))
        OR (terms.mode='project_end' AND ((deadline.access_terms_id IS NOT NULL AND datetime(deadline.deadline_at)>datetime('now'))
          OR (deadline.access_terms_id IS NULL AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle lifecycle
            WHERE lifecycle.workspace_id=terms.workspace_id AND lifecycle.source_id=terms.source_id
              AND lifecycle.project_public_id=terms.project_public_id AND lifecycle.lifecycle_status='active')))))))`;
}

function authoritySql(relationsEnabled = false): string {
  return `WITH RECURSIVE lineage(entity_type,public_id,parent_public_id,depth) AS (
      SELECT owner.entity_type,owner.public_id,owner.parent_public_id,0
      FROM portal_v2_directory_entities owner
      WHERE owner.workspace_id=batch.workspace_id AND owner.generation_id=checkpoint.active_generation_id
        AND owner.entity_type=batch.owner_scope_type AND owner.public_id=batch.owner_public_id
        AND owner.active=1 AND owner.source_version=binding.source_version
      UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1 FROM lineage
      JOIN portal_v2_directory_entities parent ON parent.workspace_id=batch.workspace_id
        AND parent.generation_id=checkpoint.active_generation_id AND parent.public_id=lineage.parent_public_id AND parent.active=1
      WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<12
      ${relationsEnabled ? `UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1 FROM lineage
      JOIN portal_v2_directory_relations relation ON relation.workspace_id=batch.workspace_id
        AND relation.generation_id=checkpoint.active_generation_id AND relation.to_type=lineage.entity_type
        AND relation.to_public_id=lineage.public_id AND relation.relation_type='contains' AND relation.active=1
      JOIN portal_v2_directory_entities parent ON parent.workspace_id=relation.workspace_id
        AND parent.generation_id=relation.generation_id AND parent.entity_type=relation.from_type
        AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE lineage.depth<12` : ""}
    ) SELECT identity.verified_email recipient_email,workspace.display_name workspace_name
    FROM portal_authenticated_delivery_change_batches batch
    JOIN portal_authenticated_delivery_notification_policies policy ON policy.grant_id=batch.grant_id AND policy.identity_id=batch.identity_id
      AND policy.grant_version=batch.grant_version AND policy.logical_grant_id=batch.logical_grant_id
      AND policy.workspace_id=batch.workspace_id AND policy.source_id=batch.source_id
      AND policy.principal_public_id=batch.principal_public_id AND policy.principal_source_version=batch.principal_source_version
      AND policy.policy_version=batch.policy_version AND policy.access_notice_enabled=1 AND policy.change_mode<>'off'
    JOIN portal_v2_authenticated_delivery_grants grant_record ON grant_record.id=batch.grant_id
      AND grant_record.grant_version=batch.grant_version AND grant_record.logical_grant_id=batch.logical_grant_id
      AND grant_record.workspace_id=batch.workspace_id AND grant_record.folder_binding_id=batch.folder_binding_id
      AND grant_record.binding_source_version=batch.binding_source_version AND grant_record.audience_type='principal'
      AND grant_record.audience_public_id=batch.principal_public_id AND grant_record.audience_source_version=batch.principal_source_version
      AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
    JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=batch.grant_id
      AND recipient.workspace_id=batch.workspace_id AND recipient.identity_id=batch.identity_id
      AND recipient.principal_public_id=batch.principal_public_id AND recipient.principal_source_version=batch.principal_source_version
    JOIN portal_v2_workspaces workspace ON workspace.id=batch.workspace_id AND workspace.project_alpha_source_id=batch.source_id
      AND workspace.status='active'
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id=batch.source_id
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_folder_bindings binding ON binding.id=batch.folder_binding_id AND binding.workspace_id=batch.workspace_id
      AND binding.source_version=batch.binding_source_version AND binding.owner_scope_type=batch.owner_scope_type
      AND binding.owner_public_id=batch.owner_public_id AND binding.r2_prefix=batch.r2_prefix
      AND binding.status='active' AND binding.revoked_at IS NULL
    JOIN pa_portal_principals principal ON principal.workspace_id=batch.workspace_id AND principal.public_id=batch.principal_public_id
      AND principal.identity_id=batch.identity_id AND principal.source_version=batch.principal_source_version AND principal.status='active'
    JOIN portal_v2_identities identity ON identity.id=batch.identity_id AND identity.status='active'
      AND identity.revoked_at IS NULL AND identity.verified_email IS NOT NULL
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=batch.workspace_id AND membership.identity_id=batch.identity_id
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    WHERE batch.id=? AND ${accessTermsSql()}
      AND (batch.added_count=0 OR policy.change_mode IN ('added','both'))
      AND (batch.removed_count=0 OR policy.change_mode IN ('removed','both'))
      AND batch.added_count+batch.removed_count>0
      AND EXISTS(SELECT 1 FROM lineage WHERE entity_type=batch.owner_scope_type AND public_id=batch.owner_public_id)
      AND EXISTS(SELECT 1 FROM portal_v2_entitlements allow_record WHERE allow_record.workspace_id=batch.workspace_id
        AND allow_record.identity_id=batch.identity_id AND allow_record.capability='delivery.view' AND allow_record.effect='allow'
        AND allow_record.status='active' AND allow_record.revoked_at IS NULL AND datetime(allow_record.valid_from)<=datetime('now')
        AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
        AND (allow_record.access_terms_id IS NULL OR EXISTS(SELECT 1 FROM lineage allow_term_project
          JOIN portal_project_access_terms allow_terms ON allow_terms.id=allow_record.access_terms_id
            AND allow_terms.workspace_id=batch.workspace_id AND allow_terms.project_public_id=allow_term_project.public_id
          LEFT JOIN portal_project_access_deadlines allow_deadline ON allow_deadline.access_terms_id=allow_terms.id
          WHERE allow_term_project.entity_type='project' AND (allow_terms.mode='until_revoked'
            OR allow_terms.mode='specific_date' AND datetime(allow_terms.expires_at)>datetime('now')
            OR allow_terms.mode='project_end' AND (allow_deadline.access_terms_id IS NOT NULL
              AND datetime(allow_deadline.deadline_at)>datetime('now') OR allow_deadline.access_terms_id IS NULL
              AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle allow_lifecycle
                WHERE allow_lifecycle.workspace_id=allow_terms.workspace_id AND allow_lifecycle.source_id=allow_terms.source_id
                  AND allow_lifecycle.project_public_id=allow_terms.project_public_id AND allow_lifecycle.lifecycle_status='active')))))
        AND (allow_record.scope_type='workspace' AND allow_record.scope_public_id=batch.workspace_id
          OR allow_record.scope_type='folder' AND allow_record.scope_public_id=batch.folder_binding_id
          OR EXISTS(SELECT 1 FROM lineage WHERE entity_type=allow_record.scope_type AND public_id=allow_record.scope_public_id)))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny_record WHERE deny_record.workspace_id=batch.workspace_id
        AND deny_record.identity_id=batch.identity_id AND deny_record.capability='delivery.view' AND deny_record.effect='deny'
        AND deny_record.status='active' AND deny_record.revoked_at IS NULL AND datetime(deny_record.valid_from)<=datetime('now')
        AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))
        AND (deny_record.scope_type='workspace' AND deny_record.scope_public_id=batch.workspace_id
          OR deny_record.scope_type='folder' AND deny_record.scope_public_id=batch.folder_binding_id
          OR EXISTS(SELECT 1 FROM lineage WHERE entity_type=deny_record.scope_type AND public_id=deny_record.scope_public_id)))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial WHERE denial.identity_id=batch.identity_id
        AND denial.status='active' AND denial.revoked_at IS NULL AND datetime(denial.valid_from)<=datetime('now')
        AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
        AND (denial.scope_type='global' OR denial.workspace_id=batch.workspace_id AND
          (denial.scope_type='workspace' AND denial.scope_public_id=batch.workspace_id
            OR denial.scope_type='folder' AND denial.scope_public_id=batch.folder_binding_id
            OR EXISTS(SELECT 1 FROM lineage WHERE entity_type=denial.scope_type AND public_id=denial.scope_public_id))))
      AND NOT EXISTS(SELECT 1 FROM portal_authenticated_delivery_notification_policies other_policy
        JOIN portal_v2_authenticated_delivery_grants other_grant ON other_grant.id=other_policy.grant_id
          AND other_grant.grant_version=other_policy.grant_version AND other_grant.logical_grant_id=other_policy.logical_grant_id
          AND other_grant.workspace_id=other_policy.workspace_id AND other_grant.audience_type='principal'
          AND other_grant.audience_public_id=other_policy.principal_public_id
          AND other_grant.audience_source_version=other_policy.principal_source_version
          AND other_grant.status='active' AND other_grant.revoked_at IS NULL
          AND (other_grant.expires_at IS NULL OR datetime(other_grant.expires_at)>datetime('now'))
        JOIN portal_v2_authenticated_delivery_grant_recipients other_recipient ON other_recipient.grant_id=other_grant.id
          AND other_recipient.workspace_id=other_policy.workspace_id AND other_recipient.identity_id=other_policy.identity_id
          AND other_recipient.principal_public_id=other_policy.principal_public_id
          AND other_recipient.principal_source_version=other_policy.principal_source_version
        JOIN portal_v2_folder_bindings other_binding ON other_binding.id=other_grant.folder_binding_id
          AND other_binding.workspace_id=other_policy.workspace_id AND other_binding.source_version=other_grant.binding_source_version
          AND other_binding.status='active' AND other_binding.revoked_at IS NULL
        WHERE other_policy.workspace_id=batch.workspace_id AND other_policy.identity_id=batch.identity_id
          AND other_policy.access_notice_enabled=1 AND other_policy.grant_id<>batch.grant_id
          AND substr((SELECT r2_key FROM portal_authenticated_delivery_change_batch_items WHERE batch_id=batch.id LIMIT 1),1,length(other_binding.r2_prefix))=other_binding.r2_prefix
          AND length(other_binding.r2_prefix)>=length(batch.r2_prefix))
    LIMIT 1`;
}

export async function authorizeAuthenticatedDeliveryChangeBatch(env: Env, batch: BatchRow): Promise<AuthorizedBatch | null> {
  const authorized = await env.DELIVERY_DB.withSession("first-primary")
    .prepare(authoritySql(env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true")).bind(batch.id).first<AuthorizedBatch>();
  if (!authorized) return null;
  const items = await env.DELIVERY_DB.prepare(`SELECT r2_key,current_present,current_object_version
    FROM portal_authenticated_delivery_change_batch_items WHERE batch_id=? ORDER BY object_fingerprint LIMIT 51`)
    .bind(batch.id).all<{r2_key:string;current_present:number;current_object_version:string|null}>();
  if (!items.results.length || items.results.length > MAX_ITEMS) return null;
  for (const item of items.results) {
    if (!item.r2_key.startsWith(batch.r2_prefix)) return null;
    const indexed = await env.DELIVERY_DB.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(item.r2_key).first<{etag:string}>();
    if (item.current_present) {
      if (!indexed || cleanVersion(indexed.etag) !== cleanVersion(item.current_object_version)) return null;
      const bucket = (env as Env & {DATA_BUCKET?: R2Bucket}).DATA_BUCKET;
      if (bucket) {
        const head = await bucket.head(item.r2_key);
        if (!head || cleanVersion(head.httpEtag) !== cleanVersion(item.current_object_version)) return null;
      }
    } else if (indexed || await (env as Env & {DATA_BUCKET?:R2Bucket}).DATA_BUCKET?.head(item.r2_key)) return null;
  }
  return authorized;
}

const authorizeBatch = authorizeAuthenticatedDeliveryChangeBatch;

function batchMail(env: Env, batch: BatchRow, authorization: AuthorizedBatch): OutboundMail | null {
  try {
    const base = new URL(env.DELIVERY_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return null;
    const portal = new URL("/portal/deliveries",base);
    portal.searchParams.set("workspace",batch.workspace_id);
    const parts = [batch.added_count ? `${batch.added_count} added` : "",batch.removed_count ? `${batch.removed_count} removed` : ""].filter(Boolean).join(" and ");
    const text = `${parts} in ${authorization.workspace_name}. Sign in to review current delivery access: ${portal.href}`;
    const escapedWorkspace = authorization.workspace_name.replace(/[&<>"']/g, character => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
    })[character]!);
    return {to:authorization.recipient_email,fromName:"Client delivery",subject:"Files changed in your client delivery",
      text,html:`<p>${parts} in ${escapedWorkspace}.</p><p><a href="${portal.href}">Review current delivery access</a></p>`,
      messageIdKey:`authenticated-delivery-change:${batch.id}`};
  } catch { return null; }
}

async function auditId(batch: BatchRow, action: string, reason: string | null): Promise<string> {
  return sha256(`authenticated-delivery-change-audit:v1:${batch.id}:${action}:${batch.attempt_count}:${reason ?? ""}`);
}

async function finish(env: Env, batch: BatchRow, token: string, status: Exclude<BatchStatus,"processing">, reason: string | null): Promise<boolean> {
  const action = status === "sent" ? "batch.sent" : status === "suppressed" ? "batch.suppressed"
    : status === "failed" ? "batch.failed" : status === "cancelled" ? "batch.cancelled" : "batch.retry";
  const id = await auditId(batch,action,reason);
  const result = await env.DELIVERY_DB.withSession("first-primary").batch([
    env.DELIVERY_DB.prepare(`UPDATE portal_authenticated_delivery_change_batches SET status=?,revision=revision+1,
      lease_token=NULL,lease_expires_at=NULL,last_error=?,delivered_at=CASE WHEN ?='sent' THEN ${NOW} ELSE delivered_at END,
      eligible_at=CASE WHEN ?='pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') ELSE eligible_at END,updated_at=${NOW}
      WHERE id=? AND status='processing' AND lease_token=?`).bind(status,reason,status,status,batch.id,token),
    env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO portal_authenticated_delivery_change_audit
      (id,batch_id,action,attempt_count,reason_code) SELECT ?,id,?,attempt_count,?
      FROM portal_authenticated_delivery_change_batches WHERE id=? AND changes()=1`).bind(id,action,reason,batch.id),
  ]);
  return Number(result[0]?.meta.changes) === 1;
}

export async function controlAuthenticatedDeliveryChangeBatch(env: Env, actorStaffId: string, input: {
  batchId: string; action: "send-now" | "cancel"; expectedRevision: number; idempotencyKey: string;
},includeReplay=false): Promise<{status:"pending"|"cancelled";revision:number;replayed?:boolean}> {
  if (!authenticatedDeliveryNotificationsEnabled(env)) throw new Error("authenticated-delivery-notifications-disabled");
  if (!(await authenticatedDeliveryChangeNotificationsReady(env))) throw new Error("authenticated-delivery-notifications-schema-unavailable");
  if (!actorStaffId || !/^[A-Za-z0-9_-]{1,128}$/.test(input.batchId)
    || !["send-now","cancel"].includes(input.action) || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision >= Number.MAX_SAFE_INTEGER)
    throw new Error("authenticated-delivery-notification-control-invalid");
  const fingerprint = await sha256(JSON.stringify([input.batchId,input.action,input.expectedRevision]));
  const db = env.DELIVERY_DB.withSession("first-primary");
  const replay = await db.prepare(`SELECT request_fingerprint,result_status,result_revision FROM portal_authenticated_delivery_change_controls
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(actorStaffId,input.idempotencyKey)
    .first<{request_fingerprint:string;result_status:"pending"|"cancelled";result_revision:number}>();
  if (replay) {
    if (replay.request_fingerprint !== fingerprint) throw new Error("authenticated-delivery-notification-control-idempotency-conflict");
    return {...(includeReplay?{replayed:true}:{}),status:replay.result_status,revision:replay.result_revision};
  }
  const status = input.action === "cancel" ? "cancelled" : "pending";
  const revision = input.expectedRevision + 1;
  const auditAction = input.action === "cancel" ? "batch.cancelled" : "batch.send_now";
  const audit = await sha256(`authenticated-delivery-change-audit:v1:${input.batchId}:${auditAction}:${actorStaffId}:${input.idempotencyKey}`);
  const result = await db.batch([
    db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET status=?,revision=revision+1,
      sealed_at=CASE WHEN ?='cancelled' THEN ${NOW} ELSE sealed_at END,
      eligible_at=CASE WHEN ?='pending' THEN ${NOW} ELSE eligible_at END,
      last_error=CASE WHEN ?='cancelled' THEN 'staff-cancelled' ELSE last_error END,updated_at=${NOW}
      WHERE id=? AND status='pending' AND revision=?`).bind(status,status,status,status,input.batchId,input.expectedRevision),
    db.prepare(`INSERT INTO portal_authenticated_delivery_change_controls
      (actor_staff_id,idempotency_key,request_fingerprint,batch_id,action,expected_revision,result_revision,result_status)
      SELECT ?,?,?,?,?,?,?,? WHERE changes()=1`).bind(actorStaffId,input.idempotencyKey,fingerprint,input.batchId,input.action,
        input.expectedRevision,revision,status),
    db.prepare(`INSERT OR IGNORE INTO portal_authenticated_delivery_change_audit
      (id,batch_id,action,attempt_count,reason_code) SELECT ?,id,?,attempt_count,?
      FROM portal_authenticated_delivery_change_batches WHERE id=? AND changes()=1`)
      .bind(audit,auditAction,input.action === "cancel" ? "staff-cancelled" : null,input.batchId),
  ]);
  if (Number(result[0]?.meta.changes) !== 1 || Number(result[1]?.meta.changes) !== 1)
    throw new Error("authenticated-delivery-notification-control-conflict");
  return {...(includeReplay?{replayed:false}:{}),status,revision};
}

export async function dispatchAuthenticatedDeliveryChangeNotifications(
  env: Env,
  dependencies: AuthenticatedDeliveryNotificationDependencies = defaultDependencies,
): Promise<number> {
  if (!authenticatedDeliveryNotificationsEnabled(env)) return 0;
  if (!(await authenticatedDeliveryChangeNotificationsReady(env))) throw new Error("authenticated-delivery-notifications-schema-unavailable");
  const db = env.DELIVERY_DB.withSession("first-primary");
  const exhausted = await db.prepare(`SELECT * FROM portal_authenticated_delivery_change_batches
    WHERE attempt_count>=? AND ((status='processing' AND lease_expires_at<=${NOW}) OR status='pending')
    ORDER BY id LIMIT ?`).bind(MAX_ATTEMPTS,DISPATCH_LIMIT).all<BatchRow>();
  for (const batch of exhausted.results) {
    const id = await auditId(batch,"batch.failed","attempts-exhausted");
    await db.batch([
      db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET status='failed',revision=revision+1,
        lease_token=NULL,lease_expires_at=NULL,last_error='attempts-exhausted',updated_at=${NOW}
        WHERE id=? AND revision=? AND attempt_count>=? AND ((status='processing' AND lease_expires_at<=${NOW}) OR status='pending')`)
        .bind(batch.id,batch.revision,MAX_ATTEMPTS),
      db.prepare(`INSERT OR IGNORE INTO portal_authenticated_delivery_change_audit
        (id,batch_id,action,attempt_count,reason_code) SELECT ?,id,'batch.failed',attempt_count,'attempts-exhausted'
        FROM portal_authenticated_delivery_change_batches WHERE id=? AND changes()=1`).bind(id,batch.id),
    ]);
  }
  const candidates = await db.prepare(`SELECT * FROM portal_authenticated_delivery_change_batches
    WHERE attempt_count<? AND ((status='pending' AND eligible_at<=${NOW}) OR (status='processing' AND lease_expires_at<=${NOW}))
    ORDER BY eligible_at,id LIMIT ?`).bind(MAX_ATTEMPTS,DISPATCH_LIMIT).all<BatchRow>();
  let processed = 0;
  for (const candidate of candidates.results) {
    const token = crypto.randomUUID();
    const claimAudit = await sha256(`authenticated-delivery-change-audit:v1:${candidate.id}:batch.claimed:${candidate.attempt_count+1}`);
    const claimed = await db.batch([
      db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET status='processing',revision=revision+1,
        attempt_count=attempt_count+1,sealed_at=COALESCE(sealed_at,${NOW}),lease_token=?,
        lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 minutes'),updated_at=${NOW}
        WHERE id=? AND revision=? AND attempt_count<? AND ((status='pending' AND eligible_at<=${NOW})
          OR (status='processing' AND lease_expires_at<=${NOW}))`).bind(token,candidate.id,candidate.revision,MAX_ATTEMPTS),
      db.prepare(`INSERT OR IGNORE INTO portal_authenticated_delivery_change_audit
        (id,batch_id,action,attempt_count,reason_code) SELECT ?,id,'batch.claimed',attempt_count,NULL
        FROM portal_authenticated_delivery_change_batches WHERE id=? AND changes()=1`).bind(claimAudit,candidate.id),
    ]);
    if (Number(claimed[0]?.meta.changes) !== 1) continue;
    processed++;
    const batch = {...candidate,status:"processing" as const,revision:candidate.revision+1,
      attempt_count:candidate.attempt_count+1,lease_token:token};
    try {
      let authorized = await authorizeBatch(env,batch);
      if (!authorized) { await finish(env,batch,token,"suppressed","authority-changed"); continue; }
      await dependencies.beforeFinalAuthorization?.();
      authorized = await authorizeBatch(env,batch);
      if (!authorized) { await finish(env,batch,token,"suppressed","authority-changed"); continue; }
      const mail = batchMail(env,batch,authorized);
      if (!mail) { await finish(env,batch,token,"suppressed","mail-configuration-invalid"); continue; }
      // Revision changes across a retry; sealed content and provider identity
      // do not. Keep the retry fingerprint stable across lease ownership.
      const dispatchFingerprint = await sha256(JSON.stringify([batch.id,batch.added_count,batch.removed_count,mail]));
      if (batch.dispatch_fingerprint && batch.dispatch_fingerprint !== dispatchFingerprint) {
        await finish(env,batch,token,"suppressed","publication-context-changed"); continue;
      }
      const published = await db.prepare(`UPDATE portal_authenticated_delivery_change_batches SET
        dispatch_fingerprint=COALESCE(dispatch_fingerprint,?),published_recipient_email=COALESCE(published_recipient_email,?),
        published_at=COALESCE(published_at,${NOW}),updated_at=${NOW}
        WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>${NOW}
          AND (dispatch_fingerprint IS NULL OR dispatch_fingerprint=?)`)
        .bind(dispatchFingerprint,authorized.recipient_email,batch.id,token,dispatchFingerprint).run();
      if (Number(published.meta.changes) !== 1) { await finish(env,batch,token,"suppressed","authority-changed"); continue; }
      // Recheck after publication as well. Send-now/cancel or a grant/deny
      // change that wins this boundary suppresses mail instead of racing it.
      const final = await authorizeBatch(env,batch);
      if (!final || final.recipient_email !== authorized.recipient_email) {
        await finish(env,batch,token,"suppressed","authority-changed"); continue;
      }
      const liveLease = await db.prepare(`SELECT 1 ok FROM portal_authenticated_delivery_change_batches
        WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>${NOW}`).bind(batch.id,token).first("ok");
      if (liveLease === null) continue;
      await dependencies.send(env,mail);
      await finish(env,batch,token,"sent",null);
    } catch {
      await finish(env,batch,token,batch.attempt_count>=MAX_ATTEMPTS?"failed":"pending","delivery-attempt-failed");
    }
  }
  return processed;
}

export async function processAuthenticatedDeliveryChangeNotifications(env: Env): Promise<number> {
  return dispatchAuthenticatedDeliveryChangeNotifications(env);
}
