import type { Env } from "../types";
import type { CatalogSourceContext, DeliveryLocationCollection } from "@ltds/shared";

export interface VerifiedClientPrincipal {
  issuer: string;
  subject: string;
  email: string;
}

export interface ClientPortalSession {
  accountId: string;
  identityId: string;
  /** Server-only portal-v2 context used for live authenticated delivery grants. */
  workspaceId?: string;
  principalIssuer?: string;
  principalSubject?: string;
  principalEmail?: string;
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
  eventType: "files_added" | "files_removed" | "request_status" | "request_reply" | "estimate_ready" | "request_completed" | "work_area_changed";
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
  name: string;
  size: number;
  uploadedAt: string;
  contentType: string | null;
  kind: "image" | "video" | "audio" | "pdf" | "text" | "other";
  previewPath: string | null;
  thumbnailPath: string | null;
  downloadPath: string;
}

export interface AuthorizedClientPortalFile extends ClientPortalFile {
  storageKey: string;
}

export interface ClientPortalFolder {
  id: string;
  name: string;
}

export interface ClientPortalBreadcrumb {
  id: string | null;
  name: string;
}

export interface ClientFilePage {
  files: ClientPortalFile[];
  folders?: ClientPortalFolder[];
  breadcrumbs?: ClientPortalBreadcrumb[];
  folderId?: string | null;
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

export type ClientServiceQuestion =
  | { id: string; label: string; type: "text"; required: boolean; helpText: string | null; maxLength: number }
  | { id: string; label: string; type: "number"; required: boolean; helpText: string | null; minimum: number | null; maximum: number | null }
  | { id: string; label: string; type: "boolean"; required: boolean; helpText: string | null }
  | { id: string; label: string; type: "select" | "multi_select"; required: boolean; helpText: string | null; options: Array<{ value: string; label: string }> };

export interface ClientServiceCatalogItem {
  publicId: string;
  sourceVersion: string;
  name: string;
  summary: string | null;
  category: string;
  displayOrder: number;
  geometryRequirement: "none" | "optional" | "required";
  questions: ClientServiceQuestion[];
}

export interface ClientServiceCatalogPage {
  services: ClientServiceCatalogItem[];
  nextCursor: string | null;
  complete: boolean;
  source: { generation: string; sequence: number };
  assignment?: {
    sourceId: string;
    generation: string;
    sequence: number;
    subjectType: "organization" | "standalone_client" | "project";
    subjectPublicId: string;
  };
}

export interface ClientServiceCatalogPageInput {
  cursor?: string;
  limit?: number;
  /** Local project ID resolved to an exact source-owned public target server-side. */
  projectId?: string | null;
}

export interface ClientServiceDraftSelectionInput {
  publicId: string;
  /** The exact catalog version the client reviewed for this selection. */
  sourceVersion: string;
  answers: Record<string, unknown>;
}

export interface ClientServiceRequestDraftInput {
  projectId: string | null;
  requestType: ClientServiceRequestType;
  title: string;
  details: string;
  location: string | null;
  preferredStartAt: string | null;
  deliverables: string | null;
  siteContactName: string | null;
  siteContactEmail: string | null;
  siteContactPhone: string | null;
  desiredCompletionAt: string | null;
  latitude: number | null;
  longitude: number | null;
  areaGeoJson: { type: "Polygon"; coordinates: [number, number][][] } | null;
  poiPoints: Array<{ longitude: number; latitude: number; label: string | null }>;
  services: ClientServiceDraftSelectionInput[];
}

export interface ClientServiceDraftSelection {
  publicId: string;
  sourceVersion: string;
  name: string;
  summary: string | null;
  category: string;
  displayOrder: number;
  geometryRequirement: "none" | "optional" | "required";
  questions: ClientServiceQuestion[];
  answers: Record<string, unknown>;
}

export interface ClientServiceRequestDraft extends Omit<ClientServiceRequestDraftInput, "services"> {
  id: string;
  state: "draft" | "submitted";
  version: number;
  areaSquareMeters: number | null;
  areaAcres: number | null;
  services: ClientServiceDraftSelection[];
  submittedRequestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientServiceRequestDraftSummary {
  id: string;
  projectId: string | null;
  title: string;
  serviceNames: string[];
  areaAcres: number | null;
  updatedAt: string;
}

export type ClientRequestAttachmentStatus =
  | "uploading"
  | "quarantined"
  | "scanning"
  | "accepted"
  | "rejected"
  | "aborted"
  | "expired";

export interface ClientRequestAttachment {
  id: string;
  name: string;
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif" | "application/pdf";
  size: number;
  status: ClientRequestAttachmentStatus;
  downloadPath?: string;
}

export type ClientServiceDraftMutationResult =
  | { kind: "created" | "updated" | "replayed"; draft: ClientServiceRequestDraft }
  | { kind: "conflict" }
  | { kind: "catalog_changed"; servicePublicIds: string[] }
  | { kind: "service_assignments_changed"; servicePublicIds: string[] };

export type ClientServiceDraftSubmitBlockReason =
  | "request_fields_incomplete"
  | "answers_incomplete"
  | "geometry_required"
  | "catalog_changed"
  | "service_assignments_changed"
  | "attachments_pending"
  | "attachments_rejected"
  | "attachments_expired";

export type ClientServiceDraftSubmitResult =
  | { kind: "submitted" | "replayed"; request: ClientServiceRequest }
  | { kind: "conflict" }
  | {
    kind: "incomplete";
    reason: ClientServiceDraftSubmitBlockReason;
    servicePublicIds?: string[];
    attachmentCount?: number;
  };

export interface ClientPricingHint {
  kind: "starting_at" | "typical_range";
  currency: string;
  startingAtMinor?: number;
  minimumMinor?: number;
  maximumMinor?: number;
  disclaimer: string;
  basisVersion: string;
  validUntil: string;
}

export interface ClientPricingHintInput {
  /** Server-only provenance from the saved draft, never a browser selector. */
  catalogSource: CatalogSourceContext;
  services: ClientServiceDraftSelection[];
  areaSquareMeters: number | null;
  areaAcres: number | null;
  authorizationContext: {
    /** Server-only provenance from the authorized native workspace/project. */
    sourceId: string;
    workspaceRoot: {
      type: "organization" | "standalone_client";
      publicId: string;
    };
    projectPublicId: string;
  };
}

export type ClientPricingHintProvider = (input: ClientPricingHintInput, env: Env) => Promise<ClientPricingHint | null>;

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
  workAreaRevision?: {
    revisionNumber: number;
    changeSummary: string;
    updatedAt: string;
  } | null;
  status: "submitted" | "under_review" | "accepted_pending_pa_linkage" | "accepted_linked" | "declined" | "cancelled" | "completed";
  acceptedQuote?: ClientAcceptedQuote | null;
  operationalEstimate?: ClientOperationalEstimate | null;
  createdAt: string;
  updatedAt: string;
}

export type ClientServiceRequestCreateResult =
  | { kind: "created" | "replayed"; request: ClientServiceRequest }
  | { kind: "conflict" };

export type ClientServiceRequestCancelResult =
  | { kind: "cancelled" | "replayed"; request: ClientServiceRequest }
  | {
      kind: "conflict";
      reason:
        | "idempotency_key_reused"
        | "status_not_cancellable"
        | "reconciliation_required"
        | "catalog_changed"
        | "service_assignments_changed";
    };

export type ResolveClientPrincipal = (request: Request, env: Env) => Promise<VerifiedClientPrincipal | null>;

export interface ClientPortalRepository {
  resolveSession(env: Env, principal: VerifiedClientPrincipal): Promise<ClientPortalSession | null>;
  listProjects(env: Env, session: ClientPortalSession): Promise<ClientProject[]>;
  getProject(env: Env, session: ClientPortalSession, projectId: string): Promise<ClientProject | null>;
  listProjectFiles(env: Env, session: ClientPortalSession, projectId: string, cursor?: string | null, folderId?: string | null): Promise<ClientFilePage | null>;
  listPastDeliveries(env: Env, session: ClientPortalSession, cursor?: string | null): Promise<ClientFilePage>;
  listProjectFileLocations(env: Env, session: ClientPortalSession, projectId: string): Promise<DeliveryLocationCollection | null>;
  listPastDeliveryLocations(env: Env, session: ClientPortalSession): Promise<DeliveryLocationCollection>;
  getAuthorizedFile(env: Env, session: ClientPortalSession, fileId: string, projectId?: string | null): Promise<AuthorizedClientPortalFile | null>;
  listDeliveries(env: Env, session: ClientPortalSession, projectId: string): Promise<ClientDelivery[]>;
  getDeliveryHandoff(env: Env, session: ClientPortalSession, projectId: string, shareId: string): Promise<{ publicId: string } | null>;
  listNotifications(env: Env, session: ClientPortalSession, cursor?: string | null): Promise<{ notifications: ClientPortalNotification[]; unreadCount: number; cursor: string | null }>;
  updateNotification(env: Env, session: ClientPortalSession, notificationId: string, action: "read" | "dismiss"): Promise<boolean>;
  listServiceRequests(env: Env, session: ClientPortalSession): Promise<ClientServiceRequest[]>;
  getServiceRequest(env: Env, session: ClientPortalSession, requestId: string): Promise<ClientServiceRequest | null>;
  createServiceRequest(env: Env, session: ClientPortalSession, input: ClientServiceRequestInput): Promise<ClientServiceRequestCreateResult | null>;
  updateServiceRequest(env: Env, session: ClientPortalSession, requestId: string, input: ClientServiceRequestInput): Promise<ClientServiceRequest | null>;
  createChangeRequest(env: Env, session: ClientPortalSession, parentRequestId: string, input: ClientServiceRequestInput): Promise<ClientServiceRequestCreateResult | null>;
  listServiceCatalog?(env: Env, session: ClientPortalSession, input?: { projectId?: string | null }): Promise<ClientServiceCatalogItem[]>;
  listServiceCatalogPage?(env: Env, session: ClientPortalSession, input: ClientServiceCatalogPageInput): Promise<ClientServiceCatalogPage>;
  listServiceRequestDrafts?(env: Env, session: ClientPortalSession): Promise<ClientServiceRequestDraftSummary[]>;
  getServiceRequestDraft?(env: Env, session: ClientPortalSession, draftId: string): Promise<ClientServiceRequestDraft | null>;
  createServiceRequestDraft?(env: Env, session: ClientPortalSession, input: ClientServiceRequestDraftInput, mutationKey: string): Promise<ClientServiceDraftMutationResult | null>;
  saveServiceRequestDraft?(env: Env, session: ClientPortalSession, draftId: string, expectedVersion: number, input: ClientServiceRequestDraftInput, mutationKey: string): Promise<ClientServiceDraftMutationResult | null>;
  submitServiceRequestDraft?(env: Env, session: ClientPortalSession, draftId: string, expectedVersion: number, mutationKey: string): Promise<ClientServiceDraftSubmitResult | null>;
  respondToOperationalEstimate?(env: Env, session: ClientPortalSession, requestId: string, estimateId: string, response: "accept" | "request_change", note: string | null, mutationKey: string): Promise<ClientServiceRequest | null>;
  listMembers(env: Env, session: ClientPortalSession): Promise<ClientPortalMember[] | null>;
  listInvitations(env: Env, session: ClientPortalSession): Promise<ClientPortalInvitation[] | null>;
  createInvitation(env: Env, session: ClientPortalSession, input: { email: string; projectIds: string[] }): Promise<ClientPortalInvitation | null>;
  revokeMember(env: Env, session: ClientPortalSession, identityId: string): Promise<boolean>;
  revokeInvitation(env: Env, session: ClientPortalSession, invitationId: string): Promise<boolean>;
}
