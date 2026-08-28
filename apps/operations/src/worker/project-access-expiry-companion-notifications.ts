import { sendNotificationMail, smtpNotificationsEnabled, type OutboundMail } from "./mailer";
import { d1TablesPresent } from "./schema-readiness";
import type { Env } from "./types";

type NoticeEvent = "warning_7d" | "warning_24h" | "expired";
type NoticeStatus = "pending" | "processing" | "sent" | "suppressed" | "failed";
type RecipientRole = "inviter" | "access_creator";

interface CompanionCandidate {
  access_terms_id: string;
  workspace_id: string;
  source_id: string;
  project_public_id: string;
  recipient_role: RecipientRole;
  origin_id: string;
  companion_actor_id: string;
  effective_expires_at: string;
}

interface CompanionRow extends CompanionCandidate {
  id: string;
  event_type: NoticeEvent;
  message_id_key: string;
  status: NoticeStatus;
  attempt_count: number;
  lease_token: string | null;
}

interface AuthorizedCompanion {
  verified_email: string;
}

interface AuthorizationResult {
  authorized: AuthorizedCompanion | null;
  reasonCode: "authority-changed" | "duplicate-recipient" | "recipient-ambiguity" | null;
}

export interface ProjectAccessCompanionNoticeDependencies {
  send: typeof sendNotificationMail;
  /** Test seam for authority/e-mail changes after preflight. */
  beforeFinalAuthorization?: () => Promise<void>;
  /** Test seam for authority/e-mail changes after recipient claim but before
   * the lease-fenced, authoritative send read. */
  afterRecipientClaim?: () => Promise<void>;
  /** Test seam immediately before the final lease/token fence and SMTP send. */
  beforeSendLeaseCheck?: () => Promise<void>;
}

const defaults: ProjectAccessCompanionNoticeDependencies = { send: sendNotificationMail };
const REQUIRED_DELIVERY_TABLES = [
  "portal_project_access_companion_notice_outbox",
  "portal_project_access_companion_notice_audit",
  "portal_project_access_companion_recipient_claims",
  "portal_project_access_companion_recipient_reservations",
  "portal_project_access_terms",
  "portal_project_access_deadlines",
  "portal_v2_invitations",
  "portal_v2_invitation_entitlements",
  "portal_v2_entitlements",
  "portal_v2_authenticated_delivery_grants",
  "portal_v2_authenticated_delivery_grant_recipients",
  "portal_v2_folder_bindings",
  "portal_v2_identity_denials",
] as const;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const CANDIDATE_LIMIT = 100;
const DISPATCH_LIMIT = 20;
const MAX_ATTEMPTS = 3;
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

function candidateQuery(): string {
  const invitationRecipientDenial = denialSql("recipient_entitlement.identity_id", "terms.workspace_id", "terms.project_public_id");
  const inviterDenial = denialSql("inviter.id", "terms.workspace_id", "terms.project_public_id");
  const grantRecipientDenial = denialSql("recipient.identity_id", "terms.workspace_id", "terms.project_public_id");
  return `SELECT access_terms_id,workspace_id,source_id,project_public_id,recipient_role,origin_id,
      companion_actor_id,effective_expires_at FROM (
    SELECT exact_origins.*,CASE
      WHEN datetime(effective_expires_at)<=datetime(?) THEN 'expired'
      WHEN datetime(effective_expires_at)<=datetime(?) THEN 'warning_24h'
      ELSE 'warning_7d' END desired_event
    FROM (
      SELECT DISTINCT terms.id access_terms_id,terms.workspace_id,terms.source_id,terms.project_public_id,
        'inviter' recipient_role,invitation.id origin_id,invitation.invited_by_identity_id companion_actor_id,
        ${EXPIRY_SQL} effective_expires_at
      FROM portal_project_access_terms terms
      ${PROJECT_SQL}
      JOIN portal_v2_invitation_entitlements invitation_entitlement
        ON invitation_entitlement.access_terms_id=terms.id
      JOIN portal_v2_invitations invitation ON invitation.id=invitation_entitlement.invitation_id
        AND invitation.workspace_id=terms.workspace_id AND invitation.status='accepted'
        AND invitation.revoked_at IS NULL AND invitation.accepted_by_identity_id IS NOT NULL
      JOIN portal_v2_identities inviter ON inviter.id=invitation.invited_by_identity_id
        AND inviter.status='active' AND inviter.revoked_at IS NULL AND inviter.verified_email IS NOT NULL
      JOIN portal_v2_workspace_memberships inviter_membership ON inviter_membership.workspace_id=terms.workspace_id
        AND inviter_membership.identity_id=inviter.id AND inviter_membership.status='active'
        AND inviter_membership.revoked_at IS NULL
        AND (inviter_membership.expires_at IS NULL OR datetime(inviter_membership.expires_at)>datetime('now'))
      WHERE terms.kind='collaborator' AND ${EXPIRY_SQL} IS NOT NULL
        AND ${inviterDenial}
        AND NOT EXISTS(SELECT 1 FROM portal_v2_invitation_entitlements ambiguous
          WHERE ambiguous.access_terms_id=terms.id AND ambiguous.invitation_id<>invitation.id)
        AND EXISTS(SELECT 1 FROM portal_v2_entitlements recipient_entitlement
          JOIN portal_v2_workspace_memberships recipient_membership
            ON recipient_membership.workspace_id=terms.workspace_id
            AND recipient_membership.identity_id=recipient_entitlement.identity_id
            AND recipient_membership.status='active' AND recipient_membership.revoked_at IS NULL
            AND (recipient_membership.expires_at IS NULL OR datetime(recipient_membership.expires_at)>=datetime(${EXPIRY_SQL}))
          JOIN portal_v2_identities recipient_identity ON recipient_identity.id=recipient_entitlement.identity_id
            AND recipient_identity.status='active' AND recipient_identity.revoked_at IS NULL
            AND recipient_identity.verified_email IS NOT NULL
          WHERE recipient_entitlement.access_terms_id=terms.id
            AND recipient_entitlement.workspace_id=terms.workspace_id
            AND recipient_entitlement.identity_id=invitation.accepted_by_identity_id
            AND recipient_entitlement.effect='allow' AND recipient_entitlement.status='active'
            AND recipient_entitlement.revoked_at IS NULL
            AND datetime(recipient_entitlement.valid_from)<=datetime('now')
            AND (recipient_entitlement.expires_at IS NULL OR datetime(recipient_entitlement.expires_at)>=datetime(${EXPIRY_SQL}))
            AND ((recipient_entitlement.scope_type='project' AND recipient_entitlement.scope_public_id=terms.project_public_id)
              OR (recipient_entitlement.capability='workspace.view' AND recipient_entitlement.scope_type='workspace'
                AND recipient_entitlement.scope_public_id=terms.workspace_id))
            AND ${invitationRecipientDenial})
      UNION ALL
      SELECT DISTINCT terms.id access_terms_id,terms.workspace_id,terms.source_id,terms.project_public_id,
        'access_creator' recipient_role,grant_record.id origin_id,grant_record.created_by_staff_id companion_actor_id,
        ${EXPIRY_SQL} effective_expires_at
      FROM portal_project_access_terms terms
      ${PROJECT_SQL}
      JOIN portal_v2_authenticated_delivery_grants grant_record
        ON grant_record.access_terms_id=terms.id AND grant_record.workspace_id=terms.workspace_id
        AND grant_record.audience_type='principal' AND grant_record.status='active'
        AND grant_record.revoked_at IS NULL
        AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>=datetime(${EXPIRY_SQL}))
      JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id
        AND binding.workspace_id=terms.workspace_id AND binding.owner_scope_type='project'
        AND binding.owner_public_id=terms.project_public_id AND binding.status='active'
        AND binding.source_version=grant_record.binding_source_version
      WHERE terms.kind='collaborator' AND ${EXPIRY_SQL} IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants ambiguous
          JOIN portal_v2_folder_bindings ambiguous_binding ON ambiguous_binding.id=ambiguous.folder_binding_id
            AND ambiguous_binding.workspace_id=terms.workspace_id AND ambiguous_binding.owner_scope_type='project'
            AND ambiguous_binding.owner_public_id=terms.project_public_id AND ambiguous_binding.status='active'
            AND ambiguous_binding.source_version=ambiguous.binding_source_version
          WHERE ambiguous.access_terms_id=terms.id AND ambiguous.workspace_id=terms.workspace_id
            AND ambiguous.audience_type='principal' AND ambiguous.status='active' AND ambiguous.revoked_at IS NULL
            AND ambiguous.created_by_staff_id=grant_record.created_by_staff_id AND ambiguous.id<>grant_record.id
            AND (ambiguous.expires_at IS NULL OR datetime(ambiguous.expires_at)>=datetime(${EXPIRY_SQL})))
        AND EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grant_recipients recipient
          JOIN pa_portal_principals principal ON principal.workspace_id=terms.workspace_id
            AND principal.public_id=recipient.principal_public_id AND principal.identity_id=recipient.identity_id
            AND principal.source_version=recipient.principal_source_version AND principal.status='active'
          JOIN portal_v2_workspace_memberships recipient_membership ON recipient_membership.workspace_id=terms.workspace_id
            AND recipient_membership.identity_id=recipient.identity_id AND recipient_membership.status='active'
            AND recipient_membership.revoked_at IS NULL
            AND (recipient_membership.expires_at IS NULL OR datetime(recipient_membership.expires_at)>=datetime(${EXPIRY_SQL}))
          JOIN portal_v2_identities recipient_identity ON recipient_identity.id=recipient.identity_id
            AND recipient_identity.status='active' AND recipient_identity.revoked_at IS NULL
            AND recipient_identity.verified_email IS NOT NULL
          WHERE recipient.grant_id=grant_record.id AND recipient.workspace_id=terms.workspace_id
            AND ${grantRecipientDenial})
    ) exact_origins
    WHERE datetime(effective_expires_at)<=datetime(?)
  ) due_origins
  WHERE NOT EXISTS(SELECT 1 FROM portal_project_access_companion_notice_outbox existing
    WHERE existing.access_terms_id=due_origins.access_terms_id
      AND existing.recipient_role=due_origins.recipient_role AND existing.origin_id=due_origins.origin_id
      AND datetime(existing.effective_expires_at)=datetime(due_origins.effective_expires_at)
      AND existing.event_type=due_origins.desired_event)
    OR EXISTS(SELECT 1 FROM portal_project_access_companion_notice_outbox obsolete
      WHERE obsolete.access_terms_id=due_origins.access_terms_id
        AND obsolete.recipient_role=due_origins.recipient_role AND obsolete.origin_id=due_origins.origin_id
        AND datetime(obsolete.effective_expires_at)=datetime(due_origins.effective_expires_at)
        AND obsolete.status='pending' AND obsolete.event_type<>due_origins.desired_event)
  ORDER BY CASE desired_event WHEN 'warning_24h' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END,
    datetime(effective_expires_at),access_terms_id,recipient_role,origin_id LIMIT ?`;
}

async function auditId(outboxId: string, action: string, attempt: number, reason: string | null): Promise<string> {
  return sha256(`project-access-companion-notice-audit:v1:${outboxId}:${action}:${attempt}:${reason ?? ""}`);
}

async function suppressObsolete(db: D1DatabaseSession, candidate: CompanionCandidate, desired: NoticeEvent): Promise<number> {
  const rows = await db.prepare(`SELECT id,attempt_count FROM portal_project_access_companion_notice_outbox
    WHERE access_terms_id=? AND recipient_role=? AND origin_id=? AND effective_expires_at=?
      AND status='pending' AND event_type<>? ORDER BY created_at,id LIMIT 3`)
    .bind(candidate.access_terms_id,candidate.recipient_role,candidate.origin_id,candidate.effective_expires_at,desired)
    .all<{id:string;attempt_count:number}>();
  let suppressed = 0;
  for (const row of rows.results) {
    const audit = await auditId(row.id,"notice.suppressed",row.attempt_count,"obsolete-window");
    const result = await db.batch([
      db.prepare(`UPDATE portal_project_access_companion_notice_outbox SET status='suppressed',suppressed_at=${NOW},
        error_code='obsolete-window',updated_at=${NOW} WHERE id=? AND status='pending'`).bind(row.id),
      db.prepare(`INSERT OR IGNORE INTO portal_project_access_companion_notice_audit
        (id,outbox_id,workspace_id,project_public_id,recipient_role,event_type,action,attempt_count,reason_code)
        SELECT ?,id,workspace_id,project_public_id,recipient_role,event_type,'notice.suppressed',attempt_count,'obsolete-window'
        FROM portal_project_access_companion_notice_outbox WHERE id=? AND changes()=1`).bind(audit,row.id),
    ]);
    suppressed += Number(result[0]?.meta.changes) === 1 ? 1 : 0;
  }
  return suppressed;
}

async function activeStaffEmail(env: Env, staffId: string): Promise<string | null> {
  const row = await env.OPS_DB.withSession("first-primary").prepare(
    "SELECT email FROM staff_users WHERE id=? AND status='active' AND length(trim(email)) BETWEEN 3 AND 320 LIMIT 1",
  ).bind(staffId).first<{email:string}>();
  return row?.email ?? null;
}

export async function reconcileProjectAccessExpiryCompanionNotices(
  env: Env,
  nowMs = Date.now(),
): Promise<{staged:number;suppressed:number}> {
  if (!enabled(env)) return { staged: 0, suppressed: 0 };
  if (!(await d1TablesPresent(env.DELIVERY_DB,[...REQUIRED_DELIVERY_TABLES]))
    || !(await d1TablesPresent(env.OPS_DB,["staff_users"]))) {
    throw new Error("project-access-companion-notice-schema-unavailable");
  }
  const db = env.DELIVERY_DB.withSession("first-primary");
  const denylist = env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? "true" : "false";
  const now = new Date(nowMs).toISOString();
  const in24Hours = new Date(nowMs+24*60*60_000).toISOString();
  const in7Days = new Date(nowMs+7*24*60*60_000).toISOString();
  const candidates = await db.prepare(candidateQuery())
    .bind(now,in24Hours,denylist,denylist,denylist,in7Days,CANDIDATE_LIMIT).all<CompanionCandidate>();
  let staged = 0, suppressed = 0;
  for (const candidate of candidates.results) {
    const event = desiredEvent(candidate.effective_expires_at,nowMs);
    if (!event) continue;
    if (candidate.recipient_role === "access_creator" && !await activeStaffEmail(env,candidate.companion_actor_id)) continue;
    suppressed += await suppressObsolete(db,candidate,event);
    const id = await sha256(`project-access-companion-notice:v1:${candidate.access_terms_id}:${candidate.recipient_role}:${candidate.origin_id}:${event}:${candidate.effective_expires_at}`);
    const stageAudit = await auditId(id,"notice.staged",0,null);
    const result = await db.batch([
      db.prepare(`INSERT OR IGNORE INTO portal_project_access_companion_notice_outbox
        (id,access_terms_id,workspace_id,source_id,project_public_id,recipient_role,origin_id,companion_actor_id,
          event_type,effective_expires_at,message_id_key) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id,candidate.access_terms_id,candidate.workspace_id,candidate.source_id,candidate.project_public_id,
          candidate.recipient_role,candidate.origin_id,candidate.companion_actor_id,event,candidate.effective_expires_at,
          `project-access-companion:${id}`),
      db.prepare(`INSERT OR IGNORE INTO portal_project_access_companion_notice_audit
        (id,outbox_id,workspace_id,project_public_id,recipient_role,event_type,action,attempt_count)
        SELECT ?,id,workspace_id,project_public_id,recipient_role,event_type,'notice.staged',0
        FROM portal_project_access_companion_notice_outbox WHERE id=? AND changes()=1`).bind(stageAudit,id),
    ]);
    staged += Number(result[0]?.meta.changes) === 1 ? 1 : 0;
  }
  return { staged, suppressed };
}

function collaboratorAuthorityExistsSql(identity: string): string {
  return `(EXISTS(SELECT 1 FROM portal_v2_entitlements e
      JOIN portal_v2_workspace_memberships m ON m.workspace_id=terms.workspace_id AND m.identity_id=e.identity_id
        AND m.status='active' AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR datetime(m.expires_at)>=datetime(${EXPIRY_SQL}))
      JOIN portal_v2_identities i ON i.id=e.identity_id AND i.status='active' AND i.revoked_at IS NULL
        AND i.verified_email IS NOT NULL
      WHERE e.access_terms_id=terms.id AND e.workspace_id=terms.workspace_id AND e.identity_id=${identity}
        AND e.effect='allow' AND e.status='active' AND e.revoked_at IS NULL
        AND datetime(e.valid_from)<=datetime('now')
        AND (e.expires_at IS NULL OR datetime(e.expires_at)>=datetime(${EXPIRY_SQL}))
        AND ((e.scope_type='project' AND e.scope_public_id=terms.project_public_id)
          OR (e.capability='workspace.view' AND e.scope_type='workspace' AND e.scope_public_id=terms.workspace_id)))
    OR EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants g
      JOIN portal_v2_authenticated_delivery_grant_recipients r ON r.grant_id=g.id AND r.workspace_id=terms.workspace_id
        AND r.identity_id=${identity}
      JOIN pa_portal_principals p ON p.workspace_id=terms.workspace_id AND p.public_id=r.principal_public_id
        AND p.identity_id=r.identity_id AND p.source_version=r.principal_source_version AND p.status='active'
      JOIN portal_v2_workspace_memberships m ON m.workspace_id=terms.workspace_id AND m.identity_id=r.identity_id
        AND m.status='active' AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR datetime(m.expires_at)>=datetime(${EXPIRY_SQL}))
      JOIN portal_v2_identities i ON i.id=r.identity_id AND i.status='active' AND i.revoked_at IS NULL
        AND i.verified_email IS NOT NULL
      WHERE g.access_terms_id=terms.id AND g.workspace_id=terms.workspace_id AND g.audience_type='principal'
        AND g.status='active' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR datetime(g.expires_at)>=datetime(${EXPIRY_SQL}))))`;
}

async function inviterAuthorization(env: Env, row: CompanionRow): Promise<AuthorizationResult> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const authority = collaboratorAuthorityExistsSql("recipient_identity.id");
  const inviterDenial = denialSql("inviter.id","terms.workspace_id","terms.project_public_id");
  const recipientDenial = denialSql("recipient_identity.id","terms.workspace_id","terms.project_public_id");
  const inviter = await db.prepare(`SELECT inviter.verified_email
    FROM portal_project_access_terms terms
    ${PROJECT_SQL}
    JOIN portal_v2_invitation_entitlements ie ON ie.access_terms_id=terms.id AND ie.invitation_id=?
    JOIN portal_v2_invitations invitation ON invitation.id=ie.invitation_id AND invitation.workspace_id=terms.workspace_id
      AND invitation.status='accepted' AND invitation.revoked_at IS NULL
      AND invitation.invited_by_identity_id=? AND invitation.accepted_by_identity_id IS NOT NULL
    JOIN portal_v2_identities inviter ON inviter.id=invitation.invited_by_identity_id
      AND inviter.status='active' AND inviter.revoked_at IS NULL AND inviter.verified_email IS NOT NULL
    JOIN portal_v2_workspace_memberships inviter_membership ON inviter_membership.workspace_id=terms.workspace_id
      AND inviter_membership.identity_id=inviter.id AND inviter_membership.status='active'
      AND inviter_membership.revoked_at IS NULL
      AND (inviter_membership.expires_at IS NULL OR datetime(inviter_membership.expires_at)>datetime('now'))
    WHERE terms.id=? AND terms.workspace_id=? AND terms.source_id=? AND terms.project_public_id=?
      AND terms.kind='collaborator' AND datetime(${EXPIRY_SQL})=datetime(?)
      AND ${inviterDenial}
      AND NOT EXISTS(SELECT 1 FROM portal_v2_invitation_entitlements ambiguous
        WHERE ambiguous.access_terms_id=terms.id AND ambiguous.invitation_id<>invitation.id)
      AND EXISTS(SELECT 1 FROM portal_v2_identities recipient_identity
        WHERE recipient_identity.id=invitation.accepted_by_identity_id AND ${authority} AND ${recipientDenial})
    LIMIT 1`).bind(row.origin_id,row.companion_actor_id,row.access_terms_id,row.workspace_id,row.source_id,
      row.project_public_id,row.effective_expires_at,
      env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? "true" : "false",
      env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? "true" : "false").first<{verified_email:string}>();
  if (!inviter) return {authorized:null,reasonCode:"authority-changed"};
  const duplicate = await currentCollaboratorHasEmail(env,row,inviter.verified_email);
  return duplicate
    ? {authorized:null,reasonCode:"duplicate-recipient"}
    : {authorized:{verified_email:inviter.verified_email},reasonCode:null};
}

async function grantOriginIsAuthorized(env: Env, row: CompanionRow): Promise<boolean> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const recipientDenial = denialSql("identity.id","terms.workspace_id","terms.project_public_id");
  return Boolean(await db.prepare(`SELECT 1 ok FROM portal_project_access_terms terms
    ${PROJECT_SQL}
    JOIN portal_v2_authenticated_delivery_grants grant_record ON grant_record.id=?
      AND grant_record.access_terms_id=terms.id AND grant_record.workspace_id=terms.workspace_id
      AND grant_record.created_by_staff_id=? AND grant_record.audience_type='principal'
      AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>=datetime(${EXPIRY_SQL}))
    JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id
      AND binding.workspace_id=terms.workspace_id AND binding.owner_scope_type='project'
      AND binding.owner_public_id=terms.project_public_id AND binding.status='active'
      AND binding.source_version=grant_record.binding_source_version
    JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=grant_record.id
      AND recipient.workspace_id=terms.workspace_id
    JOIN pa_portal_principals principal ON principal.workspace_id=terms.workspace_id
      AND principal.public_id=recipient.principal_public_id AND principal.identity_id=recipient.identity_id
      AND principal.source_version=recipient.principal_source_version AND principal.status='active'
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=terms.workspace_id
      AND membership.identity_id=recipient.identity_id AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>=datetime(${EXPIRY_SQL}))
    JOIN portal_v2_identities identity ON identity.id=recipient.identity_id AND identity.status='active'
      AND identity.revoked_at IS NULL AND identity.verified_email IS NOT NULL
    WHERE terms.id=? AND terms.workspace_id=? AND terms.source_id=? AND terms.project_public_id=?
      AND terms.kind='collaborator' AND datetime(${EXPIRY_SQL})=datetime(?)
      AND NOT EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants ambiguous
        JOIN portal_v2_folder_bindings ambiguous_binding ON ambiguous_binding.id=ambiguous.folder_binding_id
          AND ambiguous_binding.workspace_id=terms.workspace_id AND ambiguous_binding.owner_scope_type='project'
          AND ambiguous_binding.owner_public_id=terms.project_public_id AND ambiguous_binding.status='active'
          AND ambiguous_binding.source_version=ambiguous.binding_source_version
        WHERE ambiguous.access_terms_id=terms.id AND ambiguous.workspace_id=terms.workspace_id
          AND ambiguous.audience_type='principal' AND ambiguous.status='active' AND ambiguous.revoked_at IS NULL
          AND ambiguous.created_by_staff_id=grant_record.created_by_staff_id AND ambiguous.id<>grant_record.id
          AND (ambiguous.expires_at IS NULL OR datetime(ambiguous.expires_at)>=datetime(${EXPIRY_SQL})))
      AND ${recipientDenial}
    LIMIT 1`).bind(row.origin_id,row.companion_actor_id,row.access_terms_id,row.workspace_id,row.source_id,
      row.project_public_id,row.effective_expires_at,
      env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? "true" : "false").first());
}

async function currentCollaboratorHasEmail(env: Env, row: CompanionRow, email: string): Promise<boolean> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const denial = denialSql("identity.id","terms.workspace_id","terms.project_public_id");
  return Boolean(await db.prepare(`SELECT 1 ok FROM portal_project_access_terms terms
    ${PROJECT_SQL}
    JOIN portal_v2_identities identity ON lower(trim(identity.verified_email))=lower(trim(?))
      AND identity.status='active' AND identity.revoked_at IS NULL
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=terms.workspace_id
      AND membership.identity_id=identity.id AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>=datetime(${EXPIRY_SQL}))
    WHERE terms.id=? AND terms.workspace_id=? AND terms.source_id=? AND terms.project_public_id=?
      AND datetime(${EXPIRY_SQL})=datetime(?) AND ${denial}
      AND ${collaboratorAuthorityExistsSql("identity.id")} LIMIT 1`)
    .bind(email,row.access_terms_id,row.workspace_id,row.source_id,row.project_public_id,row.effective_expires_at,
      env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true" ? "true" : "false").first());
}

async function authorizeCompanion(env: Env, row: CompanionRow): Promise<AuthorizationResult> {
  if (desiredEvent(row.effective_expires_at,Date.now()) !== row.event_type) {
    return {authorized:null,reasonCode:"authority-changed"};
  }
  if (row.recipient_role === "inviter") return inviterAuthorization(env,row);
  if (!await grantOriginIsAuthorized(env,row)) return {authorized:null,reasonCode:"authority-changed"};
  const email = await activeStaffEmail(env,row.companion_actor_id);
  if (!email) return {authorized:null,reasonCode:"authority-changed"};
  if (await currentCollaboratorHasEmail(env,row,email)) return {authorized:null,reasonCode:"duplicate-recipient"};
  return {authorized:{verified_email:email},reasonCode:null};
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function companionOrder(row: CompanionRow): string {
  return `${row.recipient_role === "inviter" ? "0" : "1"}:${row.origin_id}:${row.companion_actor_id}:${row.id}`;
}

interface RecipientReservation {
  claimId: string;
  emailHash: string;
}

async function reserveCompanionRecipient(
  env: Env,
  row: CompanionRow,
  verifiedEmail: string,
  token: string,
): Promise<{status:"winner";reservation:RecipientReservation}|{status:"duplicate"|"deferred"|"ambiguous"}> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const contenders = await db.prepare(`SELECT * FROM portal_project_access_companion_notice_outbox
    WHERE access_terms_id=? AND event_type=? AND datetime(effective_expires_at)=datetime(?)
      AND status IN ('pending','processing','sent')
    ORDER BY recipient_role,origin_id,companion_actor_id,id LIMIT ?`)
    .bind(row.access_terms_id,row.event_type,row.effective_expires_at,CANDIDATE_LIMIT+1).all<CompanionRow>();
  if (contenders.results.length>CANDIDATE_LIMIT) return {status:"ambiguous"};
  const target = normalizedEmail(verifiedEmail);
  const sameRecipient:CompanionRow[]=[];
  for (const contender of contenders.results) {
    const authorization = contender.id===row.id
      ? {authorized:{verified_email:verifiedEmail}}
      : await authorizeCompanion(env,contender);
    if (authorization.authorized
      && normalizedEmail(authorization.authorized.verified_email)===target) sameRecipient.push(contender);
  }
  sameRecipient.sort((left,right)=>companionOrder(left).localeCompare(companionOrder(right)));
  if (sameRecipient[0]?.id!==row.id) {
    const emailHash = await sha256(target);
    const finalClaim = await db.prepare(`SELECT winner_outbox_id FROM portal_project_access_companion_recipient_claims
      WHERE access_terms_id=? AND event_type=? AND datetime(effective_expires_at)=datetime(?) AND recipient_email_hash=?`)
      .bind(row.access_terms_id,row.event_type,row.effective_expires_at,emailHash).first<{winner_outbox_id:string}>();
    return {status:finalClaim ? "duplicate" : "deferred"};
  }
  const emailHash = await sha256(target);
  const claimId = await sha256(`project-access-companion-recipient:v1:${row.access_terms_id}:${row.event_type}:${row.effective_expires_at}:${emailHash}`);
  const claim = await db.prepare(`SELECT winner_outbox_id FROM portal_project_access_companion_recipient_claims
    WHERE access_terms_id=? AND event_type=? AND datetime(effective_expires_at)=datetime(?) AND recipient_email_hash=?`)
    .bind(row.access_terms_id,row.event_type,row.effective_expires_at,emailHash).first<{winner_outbox_id:string}>();
  if (claim?.winner_outbox_id!==undefined && claim.winner_outbox_id!==row.id) return {status:"duplicate"};
  // A durable final claim means this same outbox may safely replace its stale
  // transport reservation on retry; another outbox still cannot take it.
  if (claim?.winner_outbox_id===row.id) await db.prepare(`DELETE FROM portal_project_access_companion_recipient_reservations
    WHERE id=? AND winner_outbox_id=?`).bind(claimId,row.id).run();
  await db.prepare(`INSERT INTO portal_project_access_companion_recipient_reservations
    (id,access_terms_id,event_type,effective_expires_at,recipient_email_hash,winner_outbox_id,lease_token,lease_expires_at)
    VALUES(?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'))
    ON CONFLICT(id) DO UPDATE SET winner_outbox_id=excluded.winner_outbox_id,
      lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at,updated_at=${NOW}
    WHERE portal_project_access_companion_recipient_reservations.lease_expires_at<=${NOW}
      OR (portal_project_access_companion_recipient_reservations.winner_outbox_id=excluded.winner_outbox_id
        AND portal_project_access_companion_recipient_reservations.lease_token=excluded.lease_token)`)
    .bind(claimId,row.access_terms_id,row.event_type,row.effective_expires_at,emailHash,row.id,token).run();
  const reservation = await db.prepare(`SELECT 1 ok FROM portal_project_access_companion_recipient_reservations
    WHERE id=? AND winner_outbox_id=? AND lease_token=? AND lease_expires_at>${NOW}`)
    .bind(claimId,row.id,token).first();
  return reservation ? {status:"winner",reservation:{claimId,emailHash}} : {status:"deferred"};
}

async function releaseRecipientReservation(env: Env, row: CompanionRow, token: string,
  reservation: RecipientReservation | null): Promise<void> {
  if (!reservation) return;
  await env.DELIVERY_DB.withSession("first-primary").prepare(
    `DELETE FROM portal_project_access_companion_recipient_reservations
      WHERE id=? AND winner_outbox_id=? AND lease_token=?`,
  ).bind(reservation.claimId,row.id,token).run();
}

async function finalizeRecipientClaim(env: Env, row: CompanionRow, token: string,
  reservation: RecipientReservation): Promise<boolean> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  await db.prepare(`INSERT OR IGNORE INTO portal_project_access_companion_recipient_claims
    (id,access_terms_id,event_type,effective_expires_at,recipient_email_hash,winner_outbox_id)
    SELECT ?,?,?,?,reservation.recipient_email_hash,reservation.winner_outbox_id
    FROM portal_project_access_companion_recipient_reservations reservation
    JOIN portal_project_access_companion_notice_outbox notice
      ON notice.id=reservation.winner_outbox_id
    WHERE reservation.id=? AND reservation.winner_outbox_id=? AND reservation.lease_token=?
      AND reservation.lease_expires_at>${NOW}
      AND reservation.recipient_email_hash=?
      AND notice.id=? AND notice.status='processing' AND notice.lease_token=?
      AND notice.lease_expires_at>${NOW}`)
    .bind(reservation.claimId,row.access_terms_id,row.event_type,row.effective_expires_at,
      reservation.claimId,row.id,token,reservation.emailHash,row.id,token).run();
  const claim = await db.prepare(`SELECT winner_outbox_id FROM portal_project_access_companion_recipient_claims
    WHERE id=? AND access_terms_id=? AND event_type=? AND datetime(effective_expires_at)=datetime(?)
      AND recipient_email_hash=?`).bind(reservation.claimId,row.access_terms_id,row.event_type,
      row.effective_expires_at,reservation.emailHash).first<{winner_outbox_id:string}>();
  return claim?.winner_outbox_id===row.id;
}

async function ownsLiveSendFence(env: Env, row: CompanionRow, token: string,
  reservation: RecipientReservation): Promise<boolean> {
  return Boolean(await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT 1 ok
    FROM portal_project_access_companion_notice_outbox notice
    JOIN portal_project_access_companion_recipient_claims claim ON claim.id=?
      AND claim.winner_outbox_id=notice.id
    JOIN portal_project_access_companion_recipient_reservations reservation ON reservation.id=claim.id
      AND reservation.winner_outbox_id=notice.id AND reservation.lease_token=?
      AND reservation.lease_expires_at>${NOW}
    WHERE notice.id=? AND notice.status='processing' AND notice.lease_token=?
      AND notice.lease_expires_at>${NOW}`).bind(reservation.claimId,token,row.id,token).first());
}

function companionMail(env: Env, row: CompanionRow, authorized: AuthorizedCompanion): OutboundMail | null {
  try {
    const base = new URL(row.recipient_role === "access_creator" ? env.PUBLIC_BASE_URL : env.DELIVERY_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return null;
    const action = new URL(row.recipient_role === "access_creator" ? "/clients" : "/portal",base).href;
    const time = row.event_type === "warning_7d" ? "in seven days"
      : row.event_type === "warning_24h" ? "within 24 hours" : "now";
    const subject = row.event_type === "expired"
      ? "Project collaborator access expired"
      : `Project collaborator access expires ${time}`;
    const actorLabel = row.recipient_role === "inviter" ? "you invited" : "you created";
    const body = row.event_type === "expired"
      ? `Project collaboration access ${actorLabel} has expired.`
      : `Project collaboration access ${actorLabel} expires ${time}.`;
    return {to:authorized.verified_email,fromName:"Client portal",subject,
      text:`${body} Review current access: ${action}`,
      html:`<p>${body}</p><p><a href="${action}">Review current access</a></p>`,
      messageIdKey:row.message_id_key};
  } catch { return null; }
}

async function finish(env: Env, row: CompanionRow, token: string, status: Exclude<NoticeStatus,"processing">,
  code: string | null): Promise<boolean> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const action = status === "sent" ? "notice.sent" : status === "suppressed" ? "notice.suppressed"
    : status === "failed" ? "notice.failed" : "notice.retry_scheduled";
  const audit = await auditId(row.id,action,row.attempt_count,code);
  const result = await db.batch([
    db.prepare(`UPDATE portal_project_access_companion_notice_outbox SET status=?,error_code=?,lease_token=NULL,lease_expires_at=NULL,
      delivered_at=CASE WHEN ?='sent' THEN ${NOW} ELSE delivered_at END,
      suppressed_at=CASE WHEN ?='suppressed' THEN ${NOW} ELSE suppressed_at END,
      next_attempt_at=CASE WHEN ?='pending' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') ELSE next_attempt_at END,
      updated_at=${NOW} WHERE id=? AND status='processing' AND lease_token=?`).bind(status,code,status,status,status,row.id,token),
    db.prepare(`INSERT OR IGNORE INTO portal_project_access_companion_notice_audit
      (id,outbox_id,workspace_id,project_public_id,recipient_role,event_type,action,attempt_count,reason_code)
      SELECT ?,id,workspace_id,project_public_id,recipient_role,event_type,?,attempt_count,?
      FROM portal_project_access_companion_notice_outbox WHERE id=? AND changes()=1`).bind(audit,action,code,row.id),
  ]);
  return Number(result[0]?.meta.changes) === 1;
}

export async function dispatchProjectAccessExpiryCompanionNotices(
  env: Env,
  dependencies: ProjectAccessCompanionNoticeDependencies = defaults,
): Promise<number> {
  if (!enabled(env)) return 0;
  if (!(await d1TablesPresent(env.DELIVERY_DB,[...REQUIRED_DELIVERY_TABLES]))
    || !(await d1TablesPresent(env.OPS_DB,["staff_users"]))) {
    throw new Error("project-access-companion-notice-schema-unavailable");
  }
  const db = env.DELIVERY_DB.withSession("first-primary");
  const exhausted = await db.prepare(`SELECT * FROM portal_project_access_companion_notice_outbox
    WHERE status='processing' AND attempt_count>=? AND lease_expires_at<=${NOW}
    ORDER BY lease_expires_at,id LIMIT ?`).bind(MAX_ATTEMPTS,DISPATCH_LIMIT).all<CompanionRow>();
  for (const row of exhausted.results) await finish(env,row,row.lease_token!,"failed","lease-expired");
  const candidates = await db.prepare(`SELECT * FROM portal_project_access_companion_notice_outbox
    WHERE attempt_count<? AND ((status='pending' AND next_attempt_at<=${NOW})
      OR (status='processing' AND lease_expires_at<=${NOW}))
    ORDER BY CASE recipient_role WHEN 'inviter' THEN 0 ELSE 1 END,next_attempt_at,
      origin_id,companion_actor_id,id LIMIT ?`).bind(MAX_ATTEMPTS,DISPATCH_LIMIT).all<CompanionRow>();
  let processed = 0;
  for (const candidate of candidates.results) {
    const token = crypto.randomUUID();
    const claimed = await db.prepare(`UPDATE portal_project_access_companion_notice_outbox
      SET status='processing',attempt_count=attempt_count+1,lease_token=?,
        lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes'),updated_at=${NOW}
      WHERE id=? AND attempt_count=? AND attempt_count<? AND ((status='pending' AND next_attempt_at<=${NOW})
        OR (status='processing' AND lease_expires_at<=${NOW}))`)
      .bind(token,candidate.id,candidate.attempt_count,MAX_ATTEMPTS).run();
    if (Number(claimed.meta.changes) !== 1) continue;
    processed++;
    const row = {...candidate,status:"processing" as const,attempt_count:candidate.attempt_count+1,lease_token:token};
    let reservation:RecipientReservation|null=null;
    let finalizedClaim=false;
    try {
      if (!transportReady(env)) { await finish(env,row,token,"suppressed","mail-disabled"); continue; }
      const preflight = await authorizeCompanion(env,row);
      if (!preflight.authorized) { await finish(env,row,token,"suppressed",preflight.reasonCode); continue; }
      await dependencies.beforeFinalAuthorization?.();
      const final = await authorizeCompanion(env,row);
      if (!final.authorized) { await finish(env,row,token,"suppressed",final.reasonCode); continue; }
      let claimedEmail = normalizedEmail(final.authorized.verified_email);
      const recipientClaim = await reserveCompanionRecipient(env,row,claimedEmail,token);
      if (recipientClaim.status!=="winner") {
        await finish(env,row,token,recipientClaim.status==="deferred" ? "pending" : "suppressed",
          recipientClaim.status==="ambiguous" ? "recipient-ambiguity" : recipientClaim.status==="duplicate"
            ? "duplicate-recipient" : "recipient-reservation-busy");
        continue;
      }
      reservation=recipientClaim.reservation;
      await dependencies.afterRecipientClaim?.();
      let liveLease = await db.prepare(`SELECT 1 ok FROM portal_project_access_companion_notice_outbox
        WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>${NOW}`).bind(row.id,token).first();
      if (!liveLease) continue;
      let sendAuthorization = await authorizeCompanion(env,row);
      if (!sendAuthorization.authorized) {
        await finish(env,row,token,"suppressed",sendAuthorization.reasonCode);
        continue;
      }
      const currentEmail = normalizedEmail(sendAuthorization.authorized.verified_email);
      if (currentEmail!==claimedEmail) {
        await releaseRecipientReservation(env,row,token,reservation);
        reservation=null;
        const replacementClaim = await reserveCompanionRecipient(env,row,currentEmail,token);
        if (replacementClaim.status!=="winner") {
          await finish(env,row,token,replacementClaim.status==="deferred" ? "pending" : "suppressed",
            replacementClaim.status==="ambiguous" ? "recipient-ambiguity" : replacementClaim.status==="duplicate"
              ? "duplicate-recipient" : "recipient-reservation-busy");
          continue;
        }
        reservation=replacementClaim.reservation;
        claimedEmail=currentEmail;
        liveLease = await db.prepare(`SELECT 1 ok FROM portal_project_access_companion_notice_outbox
          WHERE id=? AND status='processing' AND lease_token=? AND lease_expires_at>${NOW}`).bind(row.id,token).first();
        if (!liveLease) continue;
        sendAuthorization = await authorizeCompanion(env,row);
        if (!sendAuthorization.authorized) {
          await finish(env,row,token,"suppressed",sendAuthorization.reasonCode);
          continue;
        }
      }
      if (normalizedEmail(sendAuthorization.authorized.verified_email)!==claimedEmail) {
        await finish(env,row,token,"suppressed","authority-changed");
        continue;
      }
      if (!reservation) { await finish(env,row,token,"pending","recipient-reservation-busy"); continue; }
      await dependencies.beforeSendLeaseCheck?.();
      const finalSendAuthorization = await authorizeCompanion(env,row);
      if (!finalSendAuthorization.authorized) {
        await finish(env,row,token,"suppressed",finalSendAuthorization.reasonCode);
        continue;
      }
      const finalEmail = normalizedEmail(finalSendAuthorization.authorized.verified_email);
      if (await sha256(finalEmail)!==reservation.emailHash) {
        await finish(env,row,token,"suppressed","authority-changed");
        continue;
      }
      finalizedClaim=await finalizeRecipientClaim(env,row,token,reservation);
      if (!finalizedClaim) { await finish(env,row,token,"suppressed","duplicate-recipient"); continue; }
      const mail = companionMail(env,row,finalSendAuthorization.authorized);
      if (!mail) { await finish(env,row,token,"suppressed","mail-configuration-invalid"); continue; }
      if (!await ownsLiveSendFence(env,row,token,reservation)) continue;
      await dependencies.send(env,mail);
      await finish(env,row,token,"sent",null);
    } catch {
      await finish(env,row,token,row.attempt_count>=MAX_ATTEMPTS?"failed":"pending","delivery-attempt-failed");
    } finally {
      if (!finalizedClaim) await releaseRecipientReservation(env,row,token,reservation);
    }
  }
  return processed;
}
