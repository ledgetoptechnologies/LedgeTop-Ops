import { sha256 } from "../security";
import type { Env } from "../types";
import type {
  ClientDelivery,
  ClientPortalInvitation,
  ClientPortalMember,
  ClientPortalRepository,
  ClientPortalSession,
  ClientProject,
  ClientServiceRequest,
  ClientServiceRequestInput,
  ClientServiceRequestType,
  VerifiedClientPrincipal,
} from "./types";

interface ProjectRow {
  id: string;
  external_ref: string | null;
  client_name: string;
  project_name: string;
  can_request_service: number;
}

interface DeliveryRow {
  share_id: string;
  project_id: string;
  public_id: string;
  share_version: number;
  label: string | null;
  expires_at: string | null;
  requires_password: number;
}

interface ServiceRequestRow {
  id: string;
  project_id: string;
  request_type: ClientServiceRequestType;
  title: string;
  details: string;
  location_text: string | null;
  preferred_start_at: string | null;
  service_category: string | null;
  deliverables_text: string | null;
  site_contact_name: string | null;
  site_contact_email: string | null;
  site_contact_phone: string | null;
  desired_completion_at: string | null;
  latitude: number | null;
  longitude: number | null;
  status: ClientServiceRequest["status"];
  created_at: string;
  updated_at: string;
}

interface IdempotentServiceRequestRow extends ServiceRequestRow {
  request_fingerprint: string;
}

interface MemberRow {
  identity_id: string;
  email: string | null;
  role: ClientPortalMember["role"];
  can_view_billing: number;
}

interface InvitationRow {
  id: string;
  email: string;
  project_ids_json: string;
  expires_at: string;
}

function portalDb(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return typeof candidate.withSession === "function" ? candidate.withSession("first-primary") : env.DELIVERY_DB;
}

function validPrincipalPart(value: string): boolean {
  return value.length > 0 && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function mapProject(row: ProjectRow): ClientProject {
  return { id: row.id, externalRef: row.external_ref, clientName: row.client_name, projectName: row.project_name, canRequestService: row.can_request_service === 1 };
}

function mapDelivery(row: DeliveryRow): ClientDelivery {
  return {
    shareId: row.share_id,
    publicId: row.public_id,
    shareVersion: row.share_version,
    label: row.label,
    expiresAt: row.expires_at,
    requiresPassword: row.requires_password === 1,
    handoffPath: `/api/client/projects/${encodeURIComponent(row.project_id ?? "")}/deliveries/${encodeURIComponent(row.share_id)}/handoff`,
  };
}

function mapServiceRequest(row: ServiceRequestRow): ClientServiceRequest {
  return {
    id: row.id,
    projectId: row.project_id,
    requestType: row.request_type,
    title: row.title,
    details: row.details,
    location: row.location_text,
    preferredStartAt: row.preferred_start_at,
    serviceCategory: row.service_category,
    deliverables: row.deliverables_text,
    siteContactName: row.site_contact_name,
    siteContactEmail: row.site_contact_email,
    siteContactPhone: row.site_contact_phone,
    desiredCompletionAt: row.desired_completion_at,
    latitude: row.latitude,
    longitude: row.longitude,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMember(row: MemberRow): ClientPortalMember {
  return { identityId: row.identity_id, email: row.email, role: row.role, canViewBilling: row.can_view_billing === 1 };
}

function mapInvitation(row: InvitationRow): ClientPortalInvitation {
  let projectIds: string[] = [];
  try {
    const parsed = JSON.parse(row.project_ids_json) as unknown;
    if (Array.isArray(parsed) && parsed.every(value => typeof value === "string" && value.length > 0 && value.length <= 128)) projectIds = parsed;
  } catch { /* a malformed legacy row must not expand access */ }
  return { id: row.id, email: row.email, projectIds, expiresAt: row.expires_at };
}

const sessionJoin = `
  JOIN client_accounts a ON a.id=? AND a.status='active'
  JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
  JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL`;

const memberProjectConstraint = `
  AND (m.role='manager' OR EXISTS (
    SELECT 1 FROM client_member_project_grants member_grant
    WHERE member_grant.account_id=a.id AND member_grant.identity_id=i.id
      AND member_grant.project_id=g.project_id AND member_grant.revoked_at IS NULL
  ))`;

const serviceRequestColumns =
  "r.id,r.project_id,r.request_type,r.title,r.details,r.location_text,r.preferred_start_at,r.service_category,r.deliverables_text,r.site_contact_name,r.site_contact_email,r.site_contact_phone,r.desired_completion_at,r.latitude,r.longitude,r.status,r.created_at,r.updated_at";

async function serviceRequestFingerprint(input: ClientServiceRequestInput): Promise<string> {
  const legacyFields = [
    input.projectId,
    input.requestType,
    input.title,
    input.details,
    input.location,
    input.preferredStartAt,
  ];
  // Keep an exact retry of a pre-0101 request replayable. New scope details
  // become part of the identity only when the caller actually supplies one.
  const scope = [input.serviceCategory, input.deliverables, input.siteContactName, input.siteContactEmail, input.siteContactPhone, input.desiredCompletionAt, input.latitude, input.longitude]
    .map(value => value ?? null);
  return sha256(JSON.stringify(scope.every(value => value === null) ? legacyFields : [...legacyFields, ...scope]));
}

async function enqueueRequestNotification(
  env: Env,
  request: ClientServiceRequest,
  recipientKind: "staff_triage" | "client_requester",
  eventType: "request_submitted" | "request_status_changed",
): Promise<void> {
  // Provider dispatch is intentionally absent from this Worker. This records a
  // deduplicated durable intent for a separately configured internal consumer.
  await portalDb(env).prepare(`
    INSERT OR IGNORE INTO client_portal_notification_outbox
      (id,request_id,event_type,status_value,recipient_kind,payload_json)
    VALUES (?,?,?,?,?,?)`)
    .bind(
      crypto.randomUUID(),
      request.id,
      eventType,
      request.status,
      recipientKind,
      JSON.stringify({ projectId: request.projectId, requestType: request.requestType, status: request.status }),
    )
    .run();
}

async function getServiceRequestByIdempotency(
  env: Env,
  session: ClientPortalSession,
  idempotency: string,
): Promise<IdempotentServiceRequestRow | null> {
  return portalDb(env).prepare(`
    SELECT ${serviceRequestColumns},r.request_fingerprint
    FROM client_service_requests r
    ${sessionJoin}
    JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=r.project_id AND g.revoked_at IS NULL
    JOIN projects p ON p.id=g.project_id AND p.active=1
    WHERE r.idempotency_key=? AND r.account_id=a.id ${memberProjectConstraint}`)
    .bind(session.accountId, session.identityId, idempotency)
    .first<IdempotentServiceRequestRow>();
}

export const d1ClientPortalRepository: ClientPortalRepository = {
  async resolveSession(env: Env, principal: VerifiedClientPrincipal): Promise<ClientPortalSession | null> {
    if (!validPrincipalPart(principal.issuer) || !validPrincipalPart(principal.subject)) return null;
    const row = await portalDb(env).prepare(`
      SELECT a.id AS account_id,i.id AS identity_id,a.display_name,m.role,m.can_view_billing
      FROM client_identity_links i
      JOIN client_accounts a ON a.id=i.account_id
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      WHERE i.issuer=? AND i.subject=? AND i.revoked_at IS NULL AND a.status='active'`)
      .bind(principal.issuer, principal.subject)
      .first<{ account_id: string; identity_id: string; display_name: string; role: ClientPortalSession["role"]; can_view_billing: number }>();
    return row ? { accountId: row.account_id, identityId: row.identity_id, displayName: row.display_name, role: row.role, canViewBilling: row.can_view_billing === 1 } : null;
  },

  async listProjects(env: Env, session: ClientPortalSession): Promise<ClientProject[]> {
    const result = await portalDb(env).prepare(`
      SELECT p.id,p.external_ref,p.client_name,p.project_name,g.can_request_service
      FROM client_project_grants g
      ${sessionJoin}
      JOIN projects p ON p.id=g.project_id AND p.active=1
      WHERE g.account_id=a.id AND g.revoked_at IS NULL ${memberProjectConstraint}
      ORDER BY p.client_name COLLATE NOCASE,p.project_name COLLATE NOCASE,p.id`)
      .bind(session.accountId, session.identityId)
      .all<ProjectRow>();
    return result.results.map(mapProject);
  },

  async listDeliveries(env: Env, session: ClientPortalSession, projectId: string): Promise<ClientDelivery[]> {
    const result = await portalDb(env).prepare(`
      SELECT s.id AS share_id,d.project_id,s.public_id,s.share_version,s.label,s.expires_at,
        CASE WHEN s.password_hash IS NULL THEN 0 ELSE 1 END AS requires_password
      FROM client_delivery_grants d
      ${sessionJoin}
      JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=d.project_id AND g.revoked_at IS NULL
      JOIN projects p ON p.id=g.project_id AND p.active=1
      JOIN shares s ON s.id=d.share_id AND s.project_id=d.project_id AND s.share_version=d.share_version
      WHERE d.account_id=a.id AND d.project_id=? AND d.revoked_at IS NULL
        ${memberProjectConstraint}
        AND (d.expires_at IS NULL OR datetime(d.expires_at)>datetime('now'))
        AND s.public_id IS NOT NULL AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))
      ORDER BY s.created_at DESC,s.id DESC`)
      .bind(session.accountId, session.identityId, projectId)
      .all<DeliveryRow>();
    return result.results.map(mapDelivery);
  },

  async getDeliveryHandoff(env: Env, session: ClientPortalSession, projectId: string, shareId: string): Promise<{ publicId: string } | null> {
    const row = await portalDb(env).prepare(`
      SELECT s.public_id
      FROM client_delivery_grants d
      ${sessionJoin}
      JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=d.project_id AND g.revoked_at IS NULL
      JOIN projects p ON p.id=g.project_id AND p.active=1
      JOIN shares s ON s.id=d.share_id AND s.project_id=d.project_id AND s.share_version=d.share_version
      WHERE d.account_id=a.id AND d.project_id=? AND d.share_id=? AND d.revoked_at IS NULL
        ${memberProjectConstraint}
        AND (d.expires_at IS NULL OR datetime(d.expires_at)>datetime('now'))
        AND s.public_id IS NOT NULL AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`)
      .bind(session.accountId, session.identityId, projectId, shareId)
      .first<{ public_id: string }>();
    return row ? { publicId: row.public_id } : null;
  },

  async listServiceRequests(env: Env, session: ClientPortalSession): Promise<ClientServiceRequest[]> {
    const result = await portalDb(env).prepare(`
      SELECT ${serviceRequestColumns}
      FROM client_service_requests r
      ${sessionJoin}
      JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=r.project_id AND g.revoked_at IS NULL
      JOIN projects p ON p.id=g.project_id AND p.active=1
      WHERE r.account_id=a.id
        ${memberProjectConstraint}
      ORDER BY r.created_at DESC,r.id DESC
      LIMIT 100`)
      .bind(session.accountId, session.identityId)
      .all<ServiceRequestRow>();
    return result.results.map(mapServiceRequest);
  },

  async getServiceRequest(env: Env, session: ClientPortalSession, requestId: string): Promise<ClientServiceRequest | null> {
    const row = await portalDb(env).prepare(`
      SELECT ${serviceRequestColumns}
      FROM client_service_requests r
      ${sessionJoin}
      JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=r.project_id AND g.revoked_at IS NULL
      JOIN projects p ON p.id=g.project_id AND p.active=1
      WHERE r.id=? AND r.account_id=a.id ${memberProjectConstraint}`)
      .bind(session.accountId, session.identityId, requestId)
      .first<ServiceRequestRow>();
    return row ? mapServiceRequest(row) : null;
  },

  async createServiceRequest(env: Env, session: ClientPortalSession, input: ClientServiceRequestInput) {
    const requestId = crypto.randomUUID();
    const fingerprint = await serviceRequestFingerprint(input);
    const inserted = await portalDb(env).prepare(`
      INSERT INTO client_service_requests
        (id,account_id,project_id,created_by_identity_id,request_type,title,details,location_text,preferred_start_at,service_category,deliverables_text,site_contact_name,site_contact_email,site_contact_phone,desired_completion_at,latitude,longitude,idempotency_key,request_fingerprint)
      SELECT ?,a.id,g.project_id,i.id,
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      FROM client_accounts a
      JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      JOIN client_project_grants g ON g.account_id=a.id AND g.project_id=? AND g.revoked_at IS NULL AND g.can_request_service=1
      JOIN projects p ON p.id=g.project_id AND p.active=1
      WHERE a.id=? AND a.status='active' ${memberProjectConstraint}
      ON CONFLICT(account_id,idempotency_key) DO NOTHING`)
      .bind(
        requestId,
        input.requestType,
        input.title,
        input.details,
        input.location,
        input.preferredStartAt,
        input.serviceCategory ?? null,
        input.deliverables ?? null,
        input.siteContactName ?? null,
        input.siteContactEmail ?? null,
        input.siteContactPhone ?? null,
        input.desiredCompletionAt ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.idempotencyKey,
        fingerprint,
        session.identityId,
        input.projectId,
        session.accountId,
      )
      .run();

    if (inserted.meta.changes === 1) {
      const request = await this.getServiceRequest(env, session, requestId);
      if (!request) return null;
      await Promise.all([
        enqueueRequestNotification(env, request, "staff_triage", "request_submitted"),
        portalDb(env).prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('client',?,'client.service_request.submitted','client_service_request',?,?)")
          .bind(session.identityId, request.id, JSON.stringify({ accountId: session.accountId, projectId: request.projectId, requestType: request.requestType })).run(),
      ]);
      return { kind: "created" as const, request };
    }

    const existing = await getServiceRequestByIdempotency(env, session, input.idempotencyKey);
    if (!existing) return null;
    if (existing.request_fingerprint !== fingerprint) return { kind: "conflict" as const };
    return { kind: "replayed" as const, request: mapServiceRequest(existing) };
  },

  async listMembers(env: Env, session: ClientPortalSession): Promise<ClientPortalMember[] | null> {
    if (session.role !== "manager") return null;
    const result = await portalDb(env).prepare(`
      SELECT m.identity_id,i.email,m.role,m.can_view_billing
      FROM client_account_members m
      JOIN client_accounts a ON a.id=? AND a.status='active'
      JOIN client_identity_links actor_identity ON actor_identity.id=? AND actor_identity.account_id=a.id AND actor_identity.revoked_at IS NULL
      JOIN client_account_members actor ON actor.account_id=a.id AND actor.identity_id=actor_identity.id AND actor.role='manager' AND actor.revoked_at IS NULL
      JOIN client_identity_links listed_identity ON listed_identity.id=m.identity_id AND listed_identity.account_id=a.id AND listed_identity.revoked_at IS NULL
      LEFT JOIN client_identity_links i ON i.id=listed_identity.id
      WHERE m.account_id=a.id AND m.revoked_at IS NULL
      ORDER BY CASE m.role WHEN 'manager' THEN 0 ELSE 1 END,i.email COLLATE NOCASE,m.identity_id`)
      .bind(session.accountId, session.identityId)
      .all<MemberRow>();
    return result.results.map(mapMember);
  },

  async listInvitations(env: Env, session: ClientPortalSession): Promise<ClientPortalInvitation[] | null> {
    if (session.role !== "manager") return null;
    const result = await portalDb(env).prepare(`
      SELECT invitation.id,invitation.email,invitation.project_ids_json,invitation.expires_at
      FROM client_account_invitations invitation
      ${sessionJoin}
      WHERE invitation.account_id=a.id AND invitation.revoked_at IS NULL AND invitation.accepted_at IS NULL
        AND datetime(invitation.expires_at)>datetime('now')
      ORDER BY invitation.created_at DESC,invitation.id DESC`)
      .bind(session.accountId, session.identityId)
      .all<InvitationRow>();
    return result.results.map(mapInvitation);
  },

  async createInvitation(env: Env, session: ClientPortalSession, input: { email: string; projectIds: string[] }): Promise<ClientPortalInvitation | null> {
    if (session.role !== "manager") return null;
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) return null;
    const projectIds = [...new Set(input.projectIds)].sort();
    if (projectIds.some(projectId => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(projectId))) return null;
    if (projectIds.length > 100) return null;

    // A manager may only select projects already activated by LTDS for this account.
    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => "?").join(",");
      const active = await portalDb(env).prepare(`
        SELECT COUNT(*) AS count FROM client_project_grants g
        ${sessionJoin}
        WHERE g.account_id=a.id AND g.revoked_at IS NULL AND g.project_id IN (${placeholders})`)
        .bind(session.accountId, session.identityId, ...projectIds)
        .first<{ count: number }>();
      if (!active || active.count !== projectIds.length) return null;
    }

    const invitation: ClientPortalInvitation = {
      id: crypto.randomUUID(),
      email,
      projectIds,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const db = portalDb(env);
    const created = await db.prepare(`
      INSERT INTO client_account_invitations
        (id,account_id,email,project_ids_json,expires_at,invited_by_identity_id)
      SELECT ?,a.id,?,?,?,i.id
      FROM client_accounts a
      JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
      JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
      WHERE a.id=? AND m.role='manager'
        AND NOT EXISTS (
          SELECT 1 FROM client_account_invitations pending
          WHERE pending.account_id=a.id AND pending.email=? AND pending.revoked_at IS NULL AND pending.accepted_at IS NULL
        )`)
      .bind(invitation.id, email, JSON.stringify(projectIds), invitation.expiresAt, session.identityId, session.accountId, email)
      .run();
    if (created.meta.changes !== 1) return null;

    await Promise.all([
      db.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('client_manager',?,'client.invitation.created','client_account_invitation',?,?)")
        .bind(session.identityId, invitation.id, JSON.stringify({ accountId: session.accountId, projectCount: projectIds.length })).run(),
      db.prepare("INSERT INTO client_access_sync_outbox (id,account_id,email,action,source_type,source_id) VALUES (?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), session.accountId, email, "provision", "invite", invitation.id).run(),
    ]);
    return invitation;
  },

  async revokeMember(env: Env, session: ClientPortalSession, identityId: string): Promise<boolean> {
    if (session.role !== "manager" || identityId === session.identityId) return false;
    const db = portalDb(env);
    const revoked = await db.prepare(`
      UPDATE client_account_members SET revoked_at=datetime('now'),updated_at=datetime('now')
      WHERE account_id=? AND identity_id=? AND role='member' AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM client_account_members actor
          WHERE actor.account_id=? AND actor.identity_id=? AND actor.role='manager' AND actor.revoked_at IS NULL
        )`)
      .bind(session.accountId, identityId, session.accountId, session.identityId)
      .run();
    if (revoked.meta.changes !== 1) return false;
    // Local membership revocation is authoritative immediately. The outbox is
    // only a later coarse Cloudflare Access eligibility reconciliation.
    await Promise.all([
      db.prepare("UPDATE client_identity_links SET revoked_at=datetime('now') WHERE id=? AND account_id=? AND revoked_at IS NULL")
        .bind(identityId, session.accountId).run(),
      db.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('client_manager',?,'client.member.revoked','client_account_member',?,?)")
        .bind(session.identityId, identityId, JSON.stringify({ accountId: session.accountId })).run(),
      db.prepare(`INSERT INTO client_access_sync_outbox (id,account_id,email,action,source_type,source_id)
        SELECT ?,?,lower(email),'revoke','membership',? FROM client_identity_links
        WHERE id=? AND account_id=? AND email IS NOT NULL`).bind(crypto.randomUUID(), session.accountId, identityId, identityId, session.accountId).run(),
    ]);
    return true;
  },

  async revokeInvitation(env: Env, session: ClientPortalSession, invitationId: string): Promise<boolean> {
    if (session.role !== "manager") return false;
    const db = portalDb(env);
    const revoked = await db.prepare(`
      UPDATE client_account_invitations SET revoked_at=datetime('now')
      WHERE id=? AND account_id=? AND revoked_at IS NULL AND accepted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM client_account_members actor
          WHERE actor.account_id=? AND actor.identity_id=? AND actor.role='manager' AND actor.revoked_at IS NULL
        )`)
      .bind(invitationId, session.accountId, session.accountId, session.identityId)
      .run();
    if (revoked.meta.changes !== 1) return false;
    await db.batch([
      db.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('client_manager',?,'client.invitation.revoked','client_account_invitation',?,?)")
        .bind(session.identityId, invitationId, JSON.stringify({ accountId: session.accountId })),
      db.prepare(`INSERT INTO client_access_sync_outbox (id,account_id,email,action,source_type,source_id)
        SELECT ?,account_id,lower(email),'revoke','invite',id
        FROM client_account_invitations WHERE id=? AND account_id=? AND revoked_at IS NOT NULL`)
        .bind(crypto.randomUUID(), invitationId, session.accountId),
    ]);
    return true;
  },
};
