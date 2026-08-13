import type { Env } from "../types";
import type { DeliveryLocationCollection } from "@ltds/shared";

export interface VerifiedClientPrincipal {
  issuer: string;
  subject: string;
  email: string;
}

export interface ClientPortalSession {
  accountId: string;
  identityId: string;
  displayName: string;
  role: "manager" | "member";
  canViewBilling: boolean;
}

export interface ClientPortalMember {
  identityId: string;
  email: string | null;
  role: "manager" | "member";
  canViewBilling: boolean;
}

export interface ClientPortalInvitation {
  id: string;
  email: string;
  projectIds: string[];
  expiresAt: string;
}

export interface ClientPortalNotification {
  id: string;
  eventType: "files_added" | "files_removed" | "request_status" | "request_reply" | "estimate_ready" | "request_completed";
  title: string;
  body: string;
  actionPath: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ClientProject {
  id: string;
  externalRef: string | null;
  clientName: string;
  projectName: string;
  canRequestService: boolean;
  status?: string | null;
  summary?: string | null;
  siteAddress?: string | null;
  serviceAddress?: string | null;
  projectContactName?: string | null;
  projectContactEmail?: string | null;
  projectContactPhone?: string | null;
  nextMilestone?: string | null;
  lastUpdateAt?: string | null;
}

export interface ClientPortalFile {
  id: string;
  key: string;
  name: string;
  size: number;
  uploadedAt: string;
  contentType: string | null;
  previewPath: string | null;
  downloadPath: string;
}

export interface ClientFilePage {
  files: ClientPortalFile[];
  prefix: string;
  cursor: string | null;
}

export interface ClientDelivery {
  shareId: string;
  publicId: string;
  shareVersion: number;
  label: string | null;
  expiresAt: string | null;
  requiresPassword: boolean;
  /** An authenticated portal handoff, never a replacement for the public-share contract. */
  handoffPath: string;
}

export type ClientServiceRequestType = "flight" | "service";

export interface ClientServiceRequestInput {
  idempotencyKey: string;
  expectedUpdatedAt?: string;
  projectId: string | null;
  parentRequestId?: string | null;
  requestType: ClientServiceRequestType;
  title: string;
  details: string;
  location: string | null;
  preferredStartAt: string | null;
  serviceCategory?: string | null;
  deliverables?: string | null;
  siteContactName?: string | null;
  siteContactEmail?: string | null;
  siteContactPhone?: string | null;
  desiredCompletionAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  areaGeoJson?: { type: "Polygon"; coordinates: [number, number][][] } | null;
  poiPoints?: Array<{ longitude: number; latitude: number; label?: string | null }>;
}

export interface ClientAcceptedQuote {
  documentNumber: string | null;
  status: string;
  total: number | null;
  currency: string | null;
  verifiedAt: string;
}

export interface ClientOperationalEstimate {
  id: string;
  version: number;
  scope: string;
  amount: number | null;
  currency: string | null;
  status: "draft" | "ready" | "accepted" | "change_requested";
  proposedFields: Record<string, unknown> | null;
  clientResponseNote: string | null;
  updatedAt: string;
}

export interface ClientServiceRequest {
  id: string;
  projectId: string | null;
  parentRequestId?: string | null;
  requestType: ClientServiceRequestType;
  title: string;
  details: string;
  location: string | null;
  preferredStartAt: string | null;
  serviceCategory: string | null;
  deliverables: string | null;
  siteContactName: string | null;
  siteContactEmail: string | null;
  siteContactPhone: string | null;
  desiredCompletionAt: string | null;
  latitude: number | null;
  longitude: number | null;
  areaGeoJson?: { type: "Polygon"; coordinates: [number, number][][] } | null;
  poiPoints?: Array<{ longitude: number; latitude: number; label: string | null }>;
  status: "submitted" | "under_review" | "accepted_pending_pa_linkage" | "accepted_linked" | "declined" | "cancelled" | "completed";
  acceptedQuote?: ClientAcceptedQuote | null;
  operationalEstimate?: ClientOperationalEstimate | null;
  createdAt: string;
  updatedAt: string;
}

export type ClientServiceRequestCreateResult =
  | { kind: "created" | "replayed"; request: ClientServiceRequest }
  | { kind: "conflict" };

export type ResolveClientPrincipal = (request: Request, env: Env) => Promise<VerifiedClientPrincipal | null>;

export interface ClientPortalRepository {
  resolveSession(env: Env, principal: VerifiedClientPrincipal): Promise<ClientPortalSession | null>;
  listProjects(env: Env, session: ClientPortalSession): Promise<ClientProject[]>;
  getProject(env: Env, session: ClientPortalSession, projectId: string): Promise<ClientProject | null>;
  listProjectFiles(env: Env, session: ClientPortalSession, projectId: string, cursor?: string | null): Promise<ClientFilePage | null>;
  listPastDeliveries(env: Env, session: ClientPortalSession, cursor?: string | null): Promise<ClientFilePage>;
  listProjectFileLocations(env: Env, session: ClientPortalSession, projectId: string): Promise<DeliveryLocationCollection | null>;
  listPastDeliveryLocations(env: Env, session: ClientPortalSession): Promise<DeliveryLocationCollection>;
  getAuthorizedFile(env: Env, session: ClientPortalSession, fileId: string, projectId?: string | null): Promise<ClientPortalFile | null>;
  listDeliveries(env: Env, session: ClientPortalSession, projectId: string): Promise<ClientDelivery[]>;
  getDeliveryHandoff(env: Env, session: ClientPortalSession, projectId: string, shareId: string): Promise<{ publicId: string } | null>;
  listNotifications(env: Env, session: ClientPortalSession, cursor?: string | null): Promise<{ notifications: ClientPortalNotification[]; unreadCount: number; cursor: string | null }>;
  updateNotification(env: Env, session: ClientPortalSession, notificationId: string, action: "read" | "dismiss"): Promise<boolean>;
  listServiceRequests(env: Env, session: ClientPortalSession): Promise<ClientServiceRequest[]>;
  getServiceRequest(env: Env, session: ClientPortalSession, requestId: string): Promise<ClientServiceRequest | null>;
  createServiceRequest(env: Env, session: ClientPortalSession, input: ClientServiceRequestInput): Promise<ClientServiceRequestCreateResult | null>;
  updateServiceRequest(env: Env, session: ClientPortalSession, requestId: string, input: ClientServiceRequestInput): Promise<ClientServiceRequest | null>;
  createChangeRequest(env: Env, session: ClientPortalSession, parentRequestId: string, input: ClientServiceRequestInput): Promise<ClientServiceRequestCreateResult | null>;
  respondToOperationalEstimate?(env: Env, session: ClientPortalSession, requestId: string, estimateId: string, response: "accept" | "request_change", note: string | null, mutationKey: string): Promise<ClientServiceRequest | null>;
  listMembers(env: Env, session: ClientPortalSession): Promise<ClientPortalMember[] | null>;
  listInvitations(env: Env, session: ClientPortalSession): Promise<ClientPortalInvitation[] | null>;
  createInvitation(env: Env, session: ClientPortalSession, input: { email: string; projectIds: string[] }): Promise<ClientPortalInvitation | null>;
  revokeMember(env: Env, session: ClientPortalSession, identityId: string): Promise<boolean>;
  revokeInvitation(env: Env, session: ClientPortalSession, invitationId: string): Promise<boolean>;
}
