import type { Env } from "../types";

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

export interface ClientProject {
  id: string;
  externalRef: string | null;
  clientName: string;
  projectName: string;
  canRequestService: boolean;
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
  projectId: string;
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
}

export interface ClientServiceRequest {
  id: string;
  projectId: string;
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
  status: "submitted" | "under_review" | "accepted" | "declined" | "cancelled" | "completed";
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
  listDeliveries(env: Env, session: ClientPortalSession, projectId: string): Promise<ClientDelivery[]>;
  getDeliveryHandoff(env: Env, session: ClientPortalSession, projectId: string, shareId: string): Promise<{ publicId: string } | null>;
  listServiceRequests(env: Env, session: ClientPortalSession): Promise<ClientServiceRequest[]>;
  getServiceRequest(env: Env, session: ClientPortalSession, requestId: string): Promise<ClientServiceRequest | null>;
  createServiceRequest(env: Env, session: ClientPortalSession, input: ClientServiceRequestInput): Promise<ClientServiceRequestCreateResult | null>;
  listMembers(env: Env, session: ClientPortalSession): Promise<ClientPortalMember[] | null>;
  listInvitations(env: Env, session: ClientPortalSession): Promise<ClientPortalInvitation[] | null>;
  createInvitation(env: Env, session: ClientPortalSession, input: { email: string; projectIds: string[] }): Promise<ClientPortalInvitation | null>;
  revokeMember(env: Env, session: ClientPortalSession, identityId: string): Promise<boolean>;
  revokeInvitation(env: Env, session: ClientPortalSession, invitationId: string): Promise<boolean>;
}
