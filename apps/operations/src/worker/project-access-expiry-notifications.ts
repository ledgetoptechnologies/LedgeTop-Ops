import { sendNotificationMail, smtpNotificationsEnabled, type OutboundMail } from "./mailer";
import {
  dispatchProjectAccessExpiryCompanionNotices,
  reconcileProjectAccessExpiryCompanionNotices,
} from "./project-access-expiry-companion-notifications";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";

type NoticeEvent = "warning_7d" | "warning_24h" | "expired";
type NoticeStatus = "pending" | "processing" | "sent" | "suppressed" | "failed";

interface NoticeCandidate {
  access_terms_id: string;
  workspace_id: string;
  source_id: string;
  project_public_id: string;
  identity_id: string;
  effective_expires_at: string;
}

interface NoticeRow extends NoticeCandidate {
  id: string;
  event_type: NoticeEvent;
  message_id_key: string;
  status: NoticeStatus;
  attempt_count: number;
  lease_token: string | null;
}

interface AuthorizedNotice extends NoticeCandidate {
  verified_email: string;
}

export interface ProjectAccessNoticeDependencies {
  send: typeof sendNotificationMail;
  /** Test seam for a recipient/authority change after preflight but before the
   * authoritative value used for composition and delivery is read. */
  beforeFinalAuthorization?: () => Promise<void>;
}

const defaults: ProjectAccessNoticeDependencies = { send: sendNotificationMail };
const REQUIRED_TABLES = [
  "portal_project_access_notice_outbox",
  "portal_project_access_notice_audit",
  "portal_project_access_terms",
  "portal_project_access_deadlines",
  "portal_v2_entitlements",
  "portal_v2_authenticated_delivery_grants",
  "portal_v2_authenticated_delivery_grant_recipients",
  "portal_v2_identity_denials",
] as const;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const CANDIDATE_LIMIT = 100;
const DISPATCH_LIMIT = 20;
const MAX_ATTEMPTS = 3;

function enabled(env: Env): boolean {
  return env.PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED === "true";
}

function transportReady(env: Env): boolean {
  return smtpNotificationsEnabled(env)
    && Boolean(env.SMTP_HOST && env.SMTP_USERNAME && env.SMTP_PASSWORD && env.SMTP_FROM);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function desiredEvent(expiresAt: string, nowMs: number): NoticeEvent | null {
  const remaining = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "expired";
  if (remaining <= 24 * 60 * 60_000) return "warning_24h";
  if (remaining <= 7 * 24 * 60 * 60_000) return "warning_7d";
  return null;
}

function denialSql(identity: string, workspace: string, project: string): string {
  return `NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial
    WHERE ?='true' AND denial.identity_id=${identity} AND denial.status='active'
      AND datetime(denial.valid_from)<=datetime('now')
      AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
      AND (denial.scope_type='global'
        OR (denial.workspace_id=${workspace} AND (
          (denial.scope_type='workspace' AND denial.scope_public_id=${workspace})
          OR (denial.scope_type='project' AND denial.scope_public_id=${project})))))`;
}

const EXPIRY_SQL = "CASE WHEN terms.mode='specific_date' THEN terms.expires_at ELSE deadline.deadline_at END";
const PROJECT_SQL = `JOIN portal_v2_workspaces workspace ON workspace.id=terms.workspace_id
    AND workspace.project_alpha_source_id=terms.source_id AND workspace.status='active'
  JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id
    AND source.projection_source_id=terms.source_id
  JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
  JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
    AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
  JOIN portal_v2_directory_entities project ON project.workspace_id=workspace.id
    AND project.generation_id=generation.id AND project.entity_type='project'
    AND project.public_id=terms.project_public_id AND project.active=1
  LEFT JOIN portal_project_access_deadlines deadline ON deadline.access_terms_id=terms.id`;

function candidateQuery(): string {
  const entitlementDenial = denialSql("entitlement.identity_id", "terms.workspace_id", "terms.project_public_id");
  const grantDenial = denialSql("recipient.identity_id", "terms.workspace_id", "terms.project_public_id");
  return `SELECT access_terms_id,workspace_id,source_id,project_public_id,identity_id,effective_expires_at FROM (
    SELECT exact_authorities.*,
      CASE
        WHEN datetime(effective_expires_at)<=datetime(?) THEN 'expired'
        WHEN datetime(effective_expires_at)<=datetime(?) THEN 'warning_24h'
        ELSE 'warning_7d'
      END desired_event
    FROM (
    SELECT DISTINCT terms.id access_terms_id,terms.workspace_id,terms.source_id,terms.project_public_id,
      entitlement.identity_id,${EXPIRY_SQL} effective_expires_at
    FROM portal_project_access_terms terms
    ${PROJECT_SQL}
    JOIN portal_v2_entitlements entitlement ON entitlement.access_terms_id=terms.id
      AND entitlement.workspace_id=terms.workspace_id AND entitlement.effect='allow'
      AND entitlement.status='active' AND entitlement.revoked_at IS NULL
      AND datetime(entitlement.valid_from)<=datetime('now')
      AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>=datetime(${EXPIRY_SQL}))
      AND ((entitlement.scope_type='project' AND entitlement.scope_public_id=terms.project_public_id)
        OR (entitlement.capability='workspace.view' AND entitlement.scope_type='workspace'
          AND entitlement.scope_public_id=terms.workspace_id))
    JOIN portal_v2_workspace_memberships identity ON identity.workspace_id=terms.workspace_id
      AND identity.identity_id=entitlement.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
      AND (identity.expires_at IS NULL OR datetime(identity.expires_at)>=datetime(${EXPIRY_SQL}))
    JOIN portal_v2_identities identity_record ON identity_record.id=identity.identity_id
      AND identity_record.status='active' AND identity_record.revoked_at IS NULL
      AND identity_record.verified_email IS NOT NULL
    WHERE terms.kind='collaborator' AND ${EXPIRY_SQL} IS NOT NULL AND ${entitlementDenial}
    UNION
    SELECT DISTINCT terms.id access_terms_id,terms.workspace_id,terms.source_id,terms.project_public_id,
      recipient.identity_id,${EXPIRY_SQL} effective_expires_at
    FROM portal_project_access_terms terms
    ${PROJECT_SQL}
    JOIN portal_v2_authenticated_delivery_grants grant_record ON grant_record.access_terms_id=terms.id
      AND grant_record.workspace_id=terms.workspace_id AND grant_record.audience_type='principal'
      AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>=datetime(${EXPIRY_SQL}))
    JOIN portal_v2_authenticated_delivery_grant_recipients recipient
      ON recipient.grant_id=grant_record.id AND recipient.workspace_id=terms.workspace_id
    JOIN pa_portal_principals principal ON principal.workspace_id=terms.workspace_id
      AND principal.public_id=recipient.principal_public_id AND principal.identity_id=recipient.identity_id
      AND principal.source_version=recipient.principal_source_version AND principal.status='active'
    JOIN portal_v2_workspace_memberships identity ON identity.workspace_id=terms.workspace_id
      AND identity.identity_id=recipient.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
      AND (identity.expires_at IS NULL OR datetime(identity.expires_at)>=datetime(${EXPIRY_SQL}))
    JOIN portal_v2_identities identity_record ON identity_record.id=identity.identity_id
      AND identity_record.status='active' AND identity_record.revoked_at IS NULL
      AND identity_record.verified_email IS NOT NULL
    WHERE terms.kind='collaborator' AND ${EXPIRY_SQL} IS NOT NULL AND ${grantDenial}
    ) exact_authorities
    WHERE datetime(effective_expires_at)<=datetime(?)
  ) due_authorities
  WHERE NOT EXISTS(SELECT 1 FROM portal_project_access_notice_outbox existing
      WHERE existing.access_terms_id=due_authorities.access_terms_id
        AND existing.identity_id=due_authorities.identity_id
        AND datetime(existing.effective_expires_at)=datetime(due_authorities.effective_expires_at)
        AND existing.event_type=due_authorities.desired_event)
    OR EXISTS(SELECT 1 FROM portal_project_access_notice_outbox obsolete
      WHERE obsolete.access_terms_id=due_authorities.access_terms_id
        AND obsolete.identity_id=due_authorities.identity_id
        AND datetime(obsolete.effective_expires_at)=datetime(due_authorities.effective_expires_at)
        AND obsolete.status='pending' AND obsolete.event_type<>due_authorities.desired_event)
  ORDER BY CASE desired_event WHEN 'warning_24h' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END,
    CASE WHEN desired_event='expired' THEN datetime(effective_expires_at) END DESC,
    datetime(effective_expires_at),access_terms_id,identity_id
  LIMIT ?`;
}

async function auditId(outboxId: string, action: string, attempt: number, reason: string | null): Promise<string> {
  return sha256(`project-access-notice-audit:v1:${outboxId}:${action}:${attempt}:${reason ?? ""}`);
}

async function suppressObsolete(db: D1DatabaseSession, candidate: NoticeCandidate, desired: NoticeEvent): Promise<number> {
  const rows = await db.prepare(`SELECT id,event_type,attempt_count FROM portal_project_access_notice_outbox
    WHERE access_terms_id=? AND identity_id=? AND effective_expires_at=? AND status='pending' AND event_type<>?
    ORDER BY created_at,id LIMIT 3`).bind(candidate.access_terms_id,candidate.identity_id,candidate.effective_expires_at,desired)
    .all<{id:string;event_type:NoticeEvent;attempt_count:number}>();
  let suppressed = 0;
  for (const row of rows.results) {
    const audit = await auditId(row.id,"notice.suppressed",row.attempt_count,"obsolete-window");
    const result = await db.batch([
      db.prepare(`UPDATE portal_project_access_notice_outbox SET status='suppressed',suppressed_at=${NOW},
        error_code='obsolete-window',updated_at=${NOW} WHERE id=? AND status='pending'`).bind(row.id),
      db.prepare(`INSERT OR IGNORE INTO portal_project_access_notice_audit
        (id,outbox_id,workspace_id,project_public_id,identity_id,event_type,action,attempt_count,reason_code)
        SELECT ?,id,workspace_id,project_public_id,identity_id,event_type,'notice.suppressed',attempt_count,'obsolete-window'
        FROM portal_project_access_notice_outbox WHERE id=? AND status='suppressed'`).bind(audit,row.id),
    ]);
    suppressed += Number(result[0]?.meta.changes) === 1 ? 1 : 0;
  }
  return suppressed;
}

export async function reconcileProjectAccessExpiryNotices(env: Env, nowMs = Date.now()): Promise<{staged:number;suppressed:number}> {
  if (!enabled(env)) return { staged: 0, suppressed: 0 };
  if (!(await d1TablesPresent(env.DELIVERY_DB,[...REQUIRED_TABLES]))) throw new Error("project-access-notice-schema-unavailable");
  const db = env.DELIVERY_DB.withSession("first-primary");
  const denylist = env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? "true" : "false";
  const now = new Date(nowMs).toISOString();
  const in24Hours = new Date(nowMs+24*60*60_000).toISOString();
  const in7Days = new Date(nowMs+7*24*60*60_000).toISOString();
  const candidates = await db.prepare(candidateQuery()).bind(now,in24Hours,denylist,denylist,in7Days,CANDIDATE_LIMIT)
    .all<NoticeCandidate>();
  let staged = 0, suppressed = 0;
  for (const candidate of candidates.results) {
    const event = desiredEvent(candidate.effective_expires_at,nowMs);
    if (!event) continue;
    suppressed += await suppressObsolete(db,candidate,event);
    const id = await sha256(`project-access-notice:v1:${candidate.access_terms_id}:${candidate.identity_id}:${event}:${candidate.effective_expires_at}`);
    const stageAudit = await auditId(id,"notice.staged",0,null);
    const result = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO portal_project_access_notice_outbox
        (id,access_terms_id,workspace_id,source_id,project_public_id,identity_id,event_type,effective_expires_at,message_id_key)
        VALUES(?,?,?,?,?,?,?,?,?)`).bind(id,candidate.access_terms_id,candidate.workspace_id,candidate.source_id,
          candidate.project_public_id,candidate.identity_id,event,candidate.effective_expires_at,`project-access:${id}`),
      db.prepare(`INSERT OR IGNORE INTO portal_project_access_notice_audit
        (id,outbox_id,workspace_id,project_public_id,identity_id,event_type,action,attempt_count)
        SELECT ?,id,workspace_id,project_public_id,identity_id,event_type,'notice.staged',0
        FROM portal_project_access_notice_outbox WHERE id=? AND changes()=1`).bind(stageAudit,id),
    ]);
    staged += Number(result[0]?.meta.changes) === 1 ? 1 : 0;
  }
  return { staged, suppressed };
}

async function authorizeNotice(env: Env, row: NoticeRow): Promise<AuthorizedNotice | null> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const denylist = env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? "true" : "false";
  const phase = desiredEvent(row.effective_expires_at,Date.now());
  if (phase !== row.event_type) return null;
  const denial = denialSql("identity_record.id","terms.workspace_id","terms.project_public_id");
  return db.prepare(`SELECT terms.id access_terms_id,terms.workspace_id,terms.source_id,terms.project_public_id,
      identity_record.id identity_id,identity_record.verified_email,${EXPIRY_SQL} effective_expires_at
    FROM portal_project_access_terms terms
    ${PROJECT_SQL}
    JOIN portal_v2_identities identity_record ON identity_record.id=? AND identity_record.status='active'
      AND identity_record.revoked_at IS NULL AND identity_record.verified_email IS NOT NULL
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=terms.workspace_id
      AND membership.identity_id=identity_record.id AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>=datetime(${EXPIRY_SQL}))
    WHERE terms.id=? AND terms.workspace_id=? AND terms.source_id=? AND terms.project_public_id=?
      AND terms.kind='collaborator' AND datetime(${EXPIRY_SQL})=datetime(?) AND ${denial}
      AND (EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
        WHERE entitlement.access_terms_id=terms.id AND entitlement.workspace_id=terms.workspace_id
          AND entitlement.identity_id=identity_record.id AND entitlement.effect='allow'
          AND entitlement.status='active' AND entitlement.revoked_at IS NULL
          AND datetime(entitlement.valid_from)<=datetime('now')
          AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>=datetime(${EXPIRY_SQL}))
          AND ((entitlement.scope_type='project' AND entitlement.scope_public_id=terms.project_public_id)
            OR (entitlement.capability='workspace.view' AND entitlement.scope_type='workspace'
              AND entitlement.scope_public_id=terms.workspace_id)))
        OR EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants grant_record
          JOIN portal_v2_authenticated_delivery_grant_recipients recipient
            ON recipient.grant_id=grant_record.id AND recipient.workspace_id=terms.workspace_id
            AND recipient.identity_id=identity_record.id
          JOIN pa_portal_principals principal ON principal.workspace_id=terms.workspace_id
            AND principal.public_id=recipient.principal_public_id AND principal.identity_id=recipient.identity_id
            AND principal.source_version=recipient.principal_source_version AND principal.status='active'
          WHERE grant_record.access_terms_id=terms.id AND grant_record.workspace_id=terms.workspace_id
            AND grant_record.audience_type='principal' AND grant_record.status='active' AND grant_record.revoked_at IS NULL
            AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>=datetime(${EXPIRY_SQL}))))
    LIMIT 1`).bind(row.identity_id,row.access_terms_id,row.workspace_id,row.source_id,row.project_public_id,
      row.effective_expires_at,denylist).first<AuthorizedNotice>();
}

function noticeMail(env: Env, row: NoticeRow, authorized: AuthorizedNotice): OutboundMail | null {
  try {
    const base = new URL(env.DELIVERY_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return null;
    const action = new URL("/portal",base).href;
    const presentation = row.event_type === "warning_7d"
      ? {subject:"Project collaboration access expires in seven days",body:"One of your project collaboration access terms expires within seven days."}
      : row.event_type === "warning_24h"
        ? {subject:"Project collaboration access expires within 24 hours",body:"One of your project collaboration access terms expires within 24 hours."}
        : {subject:"Project collaboration access expired",body:"One of your project collaboration access terms has expired."};
    return {to:authorized.verified_email,fromName:"Client portal",subject:presentation.subject,
      text:`${presentation.body} Sign in to review your current project access: ${action}`,
      html:`<p>${presentation.body}</p><p><a href="${action}">Sign in to review your current project access</a></p>`,
      messageIdKey:row.message_id_key};
  } catch { return null; }
}

async function finish(env: Env, row: NoticeRow, token: string, status: Exclude<NoticeStatus,"processing">,
  code: string | null): Promise<boolean> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const action = status === "sent" ? "notice.sent" : status === "suppressed" ? "notice.suppressed"
    : status === "failed" ? "notice.failed" : "notice.retry_scheduled";
  const audit = await auditId(row.id,action,row.attempt_count,code);
  const result = await db.batch([
    db.prepare(`UPDATE portal_project_access_notice_outbox SET status=?,error_code=?,lease_token=NULL,lease_expires_at=NULL,
      delivered_at=CASE WHEN ?='sent' THEN ${NOW} ELSE delivered_at END,
      suppressed_at=CASE WHEN ?='suppressed' THEN ${NOW} ELSE suppressed_at END,
      next_attempt_at=CASE WHEN ?='pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') ELSE next_attempt_at END,
      updated_at=${NOW} WHERE id=? AND status='processing' AND lease_token=?`).bind(status,code,status,status,status,row.id,token),
    db.prepare(`INSERT OR IGNORE INTO portal_project_access_notice_audit
      (id,outbox_id,workspace_id,project_public_id,identity_id,event_type,action,attempt_count,reason_code)
      SELECT ?,id,workspace_id,project_public_id,identity_id,event_type,?,attempt_count,?
      FROM portal_project_access_notice_outbox WHERE id=? AND changes()=1`).bind(audit,action,code,row.id),
  ]);
  return Number(result[0]?.meta.changes) === 1;
}

export async function dispatchProjectAccessExpiryNotices(env: Env, dependencies: ProjectAccessNoticeDependencies = defaults): Promise<number> {
  if (!enabled(env)) return 0;
  if (!(await d1TablesPresent(env.DELIVERY_DB,[...REQUIRED_TABLES]))) throw new Error("project-access-notice-schema-unavailable");
  const db = env.DELIVERY_DB.withSession("first-primary");
  const exhausted = await db.prepare(`SELECT * FROM portal_project_access_notice_outbox
    WHERE status='processing' AND attempt_count>=? AND lease_expires_at<=${NOW}
    ORDER BY lease_expires_at,id LIMIT ?`).bind(MAX_ATTEMPTS,DISPATCH_LIMIT).all<NoticeRow>();
  for (const row of exhausted.results) await finish(env,row,row.lease_token!,"failed","lease-expired");
  const candidates = await db.prepare(`SELECT * FROM portal_project_access_notice_outbox
    WHERE attempt_count<? AND ((status='pending' AND next_attempt_at<=${NOW})
      OR (status='processing' AND lease_expires_at<=${NOW}))
    ORDER BY next_attempt_at,id LIMIT ?`).bind(MAX_ATTEMPTS,DISPATCH_LIMIT).all<NoticeRow>();
  let processed = 0;
  for (const candidate of candidates.results) {
    const token = crypto.randomUUID();
    const claimed = await db.prepare(`UPDATE portal_project_access_notice_outbox
      SET status='processing',attempt_count=attempt_count+1,lease_token=?,
        lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),updated_at=${NOW}
      WHERE id=? AND attempt_count=? AND attempt_count<? AND ((status='pending' AND next_attempt_at<=${NOW})
        OR (status='processing' AND lease_expires_at<=${NOW}))`).bind(token,candidate.id,candidate.attempt_count,MAX_ATTEMPTS).run();
    if (Number(claimed.meta.changes) !== 1) continue;
    processed++;
    const row = {...candidate,status:"processing" as const,attempt_count:candidate.attempt_count+1,lease_token:token};
    try {
      if (!transportReady(env)) { await finish(env,row,token,"suppressed","mail-disabled"); continue; }
      if (!await authorizeNotice(env,row)) { await finish(env,row,token,"suppressed","authority-changed"); continue; }
      await dependencies.beforeFinalAuthorization?.();
      // The final authority read supplies the recipient used for composition
      // and delivery. Never send using metadata captured by the preflight read.
      const authorized = await authorizeNotice(env,row);
      if (!authorized) { await finish(env,row,token,"suppressed","authority-changed"); continue; }
      const mail = noticeMail(env,row,authorized);
      if (!mail) { await finish(env,row,token,"suppressed","mail-configuration-invalid"); continue; }
      const liveLease = await db.prepare(`SELECT 1 ok FROM portal_project_access_notice_outbox
        WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>${NOW}`).bind(row.id,token).first();
      if (!liveLease) continue;
      await dependencies.send(env,mail);
      await finish(env,row,token,"sent",null);
    } catch {
      await finish(env,row,token,row.attempt_count>=MAX_ATTEMPTS?"failed":"pending","delivery-attempt-failed");
    }
  }
  return processed;
}

/** Scheduled entry point. Reconciliation and dispatch are both bounded and
 * remain completely inert unless the deployment flag is exactly `true`. */
export async function processProjectAccessExpiryNotifications(env: Env): Promise<{enabled:boolean;staged:number;suppressed:number;processed:number}> {
  if (!enabled(env)) return {enabled:false,staged:0,suppressed:0,processed:0};
  const reconciliation = await reconcileProjectAccessExpiryNotices(env);
  const companionReconciliation = await reconcileProjectAccessExpiryCompanionNotices(env);
  const processed = await dispatchProjectAccessExpiryNotices(env)
    + await dispatchProjectAccessExpiryCompanionNotices(env);
  return {
    enabled:true,
    staged:reconciliation.staged+companionReconciliation.staged,
    suppressed:reconciliation.suppressed+companionReconciliation.suppressed,
    processed,
  };
}
