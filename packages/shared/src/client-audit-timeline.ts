export const CLIENT_AUDIT_TIMELINE_CATEGORIES = [
  "project", "request", "feedback", "access", "delivery", "notification",
] as const;
export type ClientAuditTimelineCategory = (typeof CLIENT_AUDIT_TIMELINE_CATEGORIES)[number];

export const CLIENT_AUDIT_TIMELINE_ACTORS = [
  "staff", "client", "system", "integration", "public", "source",
] as const;
export type ClientAuditTimelineActorType = (typeof CLIENT_AUDIT_TIMELINE_ACTORS)[number];

export const CLIENT_AUDIT_TIMELINE_RESULTS = [
  "succeeded", "failed", "denied", "informational",
] as const;
export type ClientAuditTimelineResult = (typeof CLIENT_AUDIT_TIMELINE_RESULTS)[number];

export type ClientAuditTimelineCoverageReason =
  | "permission_required"
  | "unsupported_source"
  | "not_applicable"
  | "not_collected"
  | null;

export interface ClientAuditTimelineCoverage {
  available: boolean;
  reason: ClientAuditTimelineCoverageReason;
  /** Present for append-only adapters whose truthful coverage begins after rollout. */
  collectedSince?: string | null;
}

export const CLIENT_AUDIT_TIMELINE_PROJECT_ADAPTERS = [
  "source_record_activity", "operational_project_activity", "organization_contact_activity",
] as const;
export type ClientAuditTimelineProjectAdapter = (typeof CLIENT_AUDIT_TIMELINE_PROJECT_ADAPTERS)[number];

export const CLIENT_AUDIT_TIMELINE_ACCESS_ADAPTERS = [
  "workspace_membership", "workspace_invitation_request", "workspace_peer_administrator",
  "portal_identity_denial", "authenticated_delivery_grant", "delegated_client_share",
  "viewer_client_grant", "project_access",
] as const;
export type ClientAuditTimelineAccessAdapter = (typeof CLIENT_AUDIT_TIMELINE_ACCESS_ADAPTERS)[number];

export const CLIENT_AUDIT_TIMELINE_NOTIFICATION_ADAPTERS = [
  "delivery_share_notification", "project_access_collaborator_notice", "project_access_companion_notice",
] as const;
export type ClientAuditTimelineNotificationAdapter = (typeof CLIENT_AUDIT_TIMELINE_NOTIFICATION_ADAPTERS)[number];

export interface ClientAuditTimelineItem {
  /** Namespaced, opaque event key. It is not a storage key or authorization handle. */
  id: string;
  sourceId: string;
  producer: "project_alpha" | "operations" | "service_requests" | "portal_access" | "client_delivery" | "client_feedback";
  producerEventId: string;
  category: ClientAuditTimelineCategory;
  action: string;
  actor: { type: ClientAuditTimelineActorType; label: string } | null;
  resource: { type: string; id?: string; label: string; detailPath?: string };
  result: ClientAuditTimelineResult;
  occurredAt: string;
}

export interface ClientAuditTimelineFilters {
  category: "all" | ClientAuditTimelineCategory;
  actorType: "all" | ClientAuditTimelineActorType;
  result: "all" | ClientAuditTimelineResult;
  from: string | null;
  to: string | null;
}

export interface ClientAuditTimelinePage {
  canonicalRoot: { sourceId: string; rootNamespace: string; kind: string; publicId: string };
  projectId: string | null;
  contextVersion: string;
  refreshedAt: string;
  asOf: string;
  coverage: Record<ClientAuditTimelineCategory, ClientAuditTimelineCoverage>;
  projectCoverage: Record<ClientAuditTimelineProjectAdapter, ClientAuditTimelineCoverage>;
  accessCoverage: Record<ClientAuditTimelineAccessAdapter, ClientAuditTimelineCoverage>;
  notificationCoverage: Record<ClientAuditTimelineNotificationAdapter, ClientAuditTimelineCoverage>;
  filters: ClientAuditTimelineFilters;
  items: ClientAuditTimelineItem[];
  page: { nextCursor: string | null; hasMore: boolean; returned: number; limit: number };
}
