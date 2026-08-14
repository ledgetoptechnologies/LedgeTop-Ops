import { requestJson, selectClientWorkspaceId, selectedClientWorkspaceId } from "./bulk-download";
import type { DeliveryLocationCollection } from "@ltds/shared";

export interface PortalCapabilities {
  manageTeam: boolean;
  viewBilling: boolean;
  requestV2: boolean;
  requestAttachments: boolean;
  workspaceHierarchyV2: boolean;
  workspaceMembershipManagement: boolean;
  invitationEmailDelivery: boolean;
  delegatedShares: boolean;
}

export interface PortalAccount {
  id: string;
  displayName: string;
  email?: string | null;
  phone?: string | null;
}

export interface PortalProject {
  id: string;
  externalRef: string;
  clientName: string;
  projectName: string;
  canRequestService: boolean;
  status: string | null;
  summary: string | null;
  siteAddress: string | null;
  serviceAddress: string | null;
  projectContactName: string | null;
  projectContactEmail: string | null;
  projectContactPhone: string | null;
  nextMilestone: string | null;
  lastUpdateAt: string | null;
}

export interface PortalFile {
  id: string;
  key: string;
  name: string;
  size: number;
  uploadedAt: string;
  contentType: string | null;
  previewPath: string | null;
  downloadPath: string;
}

export interface PortalFilePage {
  files: PortalFile[];
  prefix: string;
  cursor: string | null;
}

export type PortalServiceRequestStatus =
  | "submitted"
  | "under_review"
  | "accepted_pending_pa_linkage"
  | "accepted_linked"
  | "declined"
  | "cancelled"
  | "completed";

export interface PortalAcceptedQuote {
  documentNumber: string | null;
  status: string;
  total: number | null;
  currency: string | null;
  verifiedAt: string;
}
export interface PortalOperationalEstimate {
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

export type PortalAreaGeoJson = {
  type: "Polygon";
  coordinates: [number, number][][];
};
export type PortalPoi = {
  longitude: number;
  latitude: number;
  label?: string | null;
};

export interface PortalServiceRequest {
  id: string;
  projectId: string | null;
  parentRequestId?: string | null;
  requestType: "flight" | "service";
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
  areaGeoJson?: PortalAreaGeoJson | null;
  poiPoints?: PortalPoi[];
  workAreaRevision?: {
    revisionNumber: number;
    changeSummary: string;
    updatedAt: string;
  } | null;
  acceptedQuote?: PortalAcceptedQuote | null;
  operationalEstimate?: PortalOperationalEstimate | null;
  status: PortalServiceRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PortalBootstrap {
  account: PortalAccount;
  capabilities: PortalCapabilities;
  projects: PortalProject[];
  requests: PortalServiceRequest[];
  mapboxPublicToken: string | null;
  workspaces?: PortalWorkspace[];
  selectedWorkspaceId?: string | null;
}

export interface PortalNotification {
  id: string;
  eventType: "files_added" | "files_removed" | "request_status" | "request_reply" | "estimate_ready" | "request_completed" | "work_area_changed";
  title: string;
  body: string;
  actionPath: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface PortalNotificationPage {
  notifications: PortalNotification[];
  unreadCount: number;
  cursor: string | null;
}

export interface PortalServiceRequestInput {
  projectId: string | null;
  parentRequestId?: string | null;
  requestType: "flight" | "service";
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
  areaGeoJson?: PortalAreaGeoJson | null;
  poiPoints?: PortalPoi[];
}

export type PortalRequest = typeof requestJson;

export async function loadPortalBootstrap(
  request: PortalRequest = requestJson,
): Promise<PortalBootstrap> {
  const session = await request<{
    account: PortalAccount;
    capabilities?: Partial<PortalCapabilities>;
  }>("/api/client/session");
  let workspaces: PortalWorkspace[] = [];
  let selectedWorkspaceId: string | null = null;
  if (session.capabilities?.workspaceHierarchyV2 === true) {
    workspaces = await loadPortalWorkspaces(request);
    const prior = selectedClientWorkspaceId();
    selectedWorkspaceId = workspaces.some(workspace => workspace.id === prior)
      ? prior
      : workspaces[0]?.id ?? null;
    selectClientWorkspaceId(selectedWorkspaceId);
    if (!selectedWorkspaceId) throw new Error("No authorized client workspace is available");
  }
  const [projects, requests, mapConfig] = await Promise.all([
    request<{ projects: PortalProject[] }>("/api/client/projects"),
    request<{ requests: PortalServiceRequest[] }>(
      "/api/client/service-requests",
    ),
    request<{ mapboxPublicToken: string | null }>("/api/client/map-config"),
  ]);
  return {
    account: session.account,
    capabilities: {
      manageTeam: session.capabilities?.manageTeam === true,
      viewBilling: session.capabilities?.viewBilling === true,
      requestV2: session.capabilities?.requestV2 === true,
      requestAttachments: session.capabilities?.requestAttachments === true,
      workspaceHierarchyV2: session.capabilities?.workspaceHierarchyV2 === true,
      workspaceMembershipManagement: session.capabilities?.workspaceMembershipManagement === true,
      invitationEmailDelivery: session.capabilities?.invitationEmailDelivery === true,
      delegatedShares: session.capabilities?.delegatedShares === true,
    },
    projects: projects.projects,
    requests: requests.requests,
    mapboxPublicToken: mapConfig.mapboxPublicToken,
    workspaces,
    selectedWorkspaceId,
  };
}

export function setPortalWorkspaceSelection(workspaceId: string | null): void {
  selectClientWorkspaceId(workspaceId);
}

export async function loadPortalProjectFiles(
  projectId: string,
  cursor: string | null = null,
  request: PortalRequest = requestJson,
): Promise<PortalFilePage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request<PortalFilePage>(
    `/api/client/projects/${encodeURIComponent(projectId)}/files${query}`,
  );
}

export async function loadPortalPastDeliveries(
  cursor: string | null = null,
  request: PortalRequest = requestJson,
): Promise<PortalFilePage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request<PortalFilePage>(`/api/client/past-deliveries${query}`);
}

export async function loadPortalProjectFileLocations(
  projectId: string,
  request: PortalRequest = requestJson,
): Promise<DeliveryLocationCollection> {
  return request<DeliveryLocationCollection>(
    `/api/client/projects/${encodeURIComponent(projectId)}/file-locations`,
  );
}

export async function loadPortalPastDeliveryLocations(
  request: PortalRequest = requestJson,
): Promise<DeliveryLocationCollection> {
  return request<DeliveryLocationCollection>("/api/client/past-delivery-locations");
}

export interface PortalWorkspace { id: string; rootType: "organization" | "standalone_client"; rootPublicId: string; displayName: string }
export interface PortalWorkspaceEntry { type: string; publicId: string; parentPublicId: string | null; displayName: string; sourceVersion: string }
export interface PortalWorkspaceMember { identityId: string; email: string | null; status: "active" | "suspended" | "revoked"; manager: boolean; source: string }
export interface PortalWorkspaceInvitation { id: string; email: string; status: "pending" | "accepted" | "revoked" | "expired"; scope: { type: "project" | "workspace"; publicId: string | null }; capabilities: string[]; expiresAt: string }
export interface PortalDelegatedShareTarget {
  delegationId: string;
  folderTargetId: string;
  displayName: string;
  maximumLinkLifetimeSeconds: number;
  requirePassword: boolean;
  delegationExpiresAt: string;
}
export interface PortalDelegatedShare {
  id: string;
  publicId: string;
  path: string;
  label: string | null;
  status: "pending_signer" | "active" | "failed" | "revoked" | "expired";
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}
export interface PortalDelegatedShareCreated {
  id: string;
  publicId: string;
  path: string;
  shareUrl: string;
  label: string | null;
  status: "active";
  passwordProtected: boolean;
  expiresAt: string;
  createdAt: string;
}

export async function loadPortalWorkspaces(request: PortalRequest = requestJson): Promise<PortalWorkspace[]> {
  return (await request<{ workspaces: PortalWorkspace[] }>("/api/client/v2/workspaces")).workspaces;
}

export async function loadPortalWorkspaceHierarchy(workspaceId: string, request: PortalRequest = requestJson): Promise<PortalWorkspaceEntry[]> {
  return (await request<{ entries: PortalWorkspaceEntry[] }>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/hierarchy`)).entries;
}

export async function loadPortalWorkspaceAccess(workspaceId: string, request: PortalRequest = requestJson): Promise<{ members: PortalWorkspaceMember[]; invitations: PortalWorkspaceInvitation[] }> {
  return request(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/access`);
}

export async function invitePortalWorkspaceMember(workspaceId: string, input: { email: string; projectPublicId?: string; organizationWide?: boolean; confirmOrganizationWide?: boolean; capabilities: Array<"delivery.view" | "request.create"> }, request: PortalRequest = requestJson): Promise<void> {
  await request(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/invitations`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(input),
  });
}

export async function revokePortalWorkspaceInvitation(workspaceId: string, invitationId: string, request: PortalRequest = requestJson): Promise<void> {
  await request(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });
}

export async function suspendPortalWorkspaceMember(workspaceId: string, identityId: string, request: PortalRequest = requestJson): Promise<void> {
  await request(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(identityId)}`, { method: "DELETE" });
}

export async function loadPortalDelegatedShareTargets(workspaceId: string, request: PortalRequest = requestJson): Promise<PortalDelegatedShareTarget[]> {
  return (await request<{ targets: PortalDelegatedShareTarget[] }>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/delegated-share-targets`)).targets;
}

export async function loadPortalDelegatedShares(workspaceId: string, request: PortalRequest = requestJson): Promise<PortalDelegatedShare[]> {
  return (await request<{ shares: PortalDelegatedShare[] }>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/delegated-shares`)).shares;
}

export async function createPortalDelegatedShare(
  workspaceId: string,
  input: { delegationId: string; folderTargetId: string; label: string | null; expiresAt: string; accessCode?: string },
  request: PortalRequest = requestJson,
): Promise<PortalDelegatedShareCreated> {
  const response = await request<{ share: PortalDelegatedShareCreated }>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/delegated-shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(input),
  });
  return response.share;
}

export async function revokePortalDelegatedShare(workspaceId: string, shareId: string, request: PortalRequest = requestJson): Promise<void> {
  await request(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/delegated-shares/${encodeURIComponent(shareId)}`, {
    method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() },
  });
}

export type PortalServiceQuestion =
  | { id: string; label: string; type: "text"; required: boolean; helpText: string | null; maxLength: number }
  | { id: string; label: string; type: "number"; required: boolean; helpText: string | null; minimum: number | null; maximum: number | null }
  | { id: string; label: string; type: "boolean"; required: boolean; helpText: string | null }
  | { id: string; label: string; type: "select" | "multi_select"; required: boolean; helpText: string | null; options: Array<{ value: string; label: string }> };

export interface PortalServiceCatalogItem {
  publicId: string;
  sourceVersion: string;
  name: string;
  summary: string | null;
  category: string;
  displayOrder: number;
  geometryRequirement: "none" | "optional" | "required";
  questions: PortalServiceQuestion[];
}

export interface PortalServiceDraftInput {
  projectId: string | null;
  requestType: "flight" | "service";
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
  areaGeoJson: PortalAreaGeoJson | null;
  poiPoints: Array<{ longitude: number; latitude: number; label: string | null }>;
  services: Array<{ publicId: string; answers: Record<string, unknown> }>;
}

export interface PortalServiceDraft extends Omit<PortalServiceDraftInput, "services"> {
  id: string;
  state: "draft" | "submitted";
  version: number;
  areaSquareMeters: number | null;
  areaAcres: number | null;
  services: Array<PortalServiceCatalogItem & { answers: Record<string, unknown> }>;
  submittedRequestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PortalPricingHint =
  | { kind: "starting_at"; currency: string; startingAtMinor: number; disclaimer: string; basisVersion: string; validUntil: string }
  | { kind: "typical_range"; currency: string; minimumMinor: number; maximumMinor: number; disclaimer: string; basisVersion: string; validUntil: string };

export type PortalRequestAttachmentStatus = "uploading" | "quarantined" | "scanning" | "accepted" | "rejected" | "aborted" | "expired";
export interface PortalRequestAttachment { id: string; name: string; contentType: string; size: number; status: PortalRequestAttachmentStatus }
export interface PortalRequestAttachmentPart { partNumber: number; etag: string; size: number }
export interface PortalRequestAttachmentUpload extends PortalRequestAttachment {
  attachmentId: string;
  partSize: number;
  completedParts: PortalRequestAttachmentPart[];
  resumed?: boolean;
}
export interface PortalRequestAttachmentTicket {
  url: string; expiresAt: string; method: "PUT"; partNumber: number;
  contentLength: number; contentType: string; headers: Record<string, string>;
}

export async function loadPortalNotifications(
  cursor: string | null = null,
  request: PortalRequest = requestJson,
): Promise<PortalNotificationPage> {
  return request<PortalNotificationPage>(`/api/client/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
}

export async function updatePortalNotification(
  notificationId: string,
  action: "read" | "dismiss",
  request: PortalRequest = requestJson,
): Promise<void> {
  await request(`/api/client/notifications/${encodeURIComponent(notificationId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

export async function createPortalServiceRequest(
  input: PortalServiceRequestInput,
  idempotencyKey: string,
  request: PortalRequest = requestJson,
): Promise<PortalServiceRequest> {
  const response = await request<{ request: PortalServiceRequest }>(
    "/api/client/service-requests",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    },
  );
  return response.request;
}

export async function loadPortalServiceCatalog(
  request: PortalRequest = requestJson,
): Promise<PortalServiceCatalogItem[]> {
  const response = await request<{ services: PortalServiceCatalogItem[] }>("/api/client/service-catalog");
  return response.services;
}

export async function createPortalServiceDraft(
  input: PortalServiceDraftInput,
  idempotencyKey: string,
  request: PortalRequest = requestJson,
): Promise<PortalServiceDraft> {
  const response = await request<{ draft: PortalServiceDraft }>("/api/client/service-request-drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
  return response.draft;
}

export async function savePortalServiceDraft(
  draftId: string,
  expectedVersion: number,
  input: PortalServiceDraftInput,
  idempotencyKey: string,
  request: PortalRequest = requestJson,
): Promise<PortalServiceDraft> {
  const response = await request<{ draft: PortalServiceDraft }>(`/api/client/service-request-drafts/${encodeURIComponent(draftId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "If-Match": String(expectedVersion) },
    body: JSON.stringify(input),
  });
  return response.draft;
}

export async function loadPortalPricingHint(
  draftId: string,
  request: PortalRequest = requestJson,
): Promise<PortalPricingHint | null> {
  const response = await request<{ available: boolean; hint: PortalPricingHint | null }>(`/api/client/service-request-drafts/${encodeURIComponent(draftId)}/pricing-hint`);
  return response.available ? response.hint : null;
}

export async function submitPortalServiceDraft(
  draftId: string,
  expectedVersion: number,
  idempotencyKey: string,
  request: PortalRequest = requestJson,
): Promise<PortalServiceRequest> {
  const response = await request<{ request: PortalServiceRequest }>(`/api/client/service-request-drafts/${encodeURIComponent(draftId)}/submit`, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey, "If-Match": String(expectedVersion) },
  });
  return response.request;
}

function attachmentPath(draftId: string, attachmentId?: string): string {
  const base = `/api/client/service-request-drafts/${encodeURIComponent(draftId)}/attachments`;
  return attachmentId ? `${base}/${encodeURIComponent(attachmentId)}` : base;
}

export async function listPortalRequestAttachments(draftId: string, request: PortalRequest = requestJson): Promise<PortalRequestAttachment[]> {
  return (await request<{ attachments: PortalRequestAttachment[] }>(attachmentPath(draftId))).attachments;
}

export async function initializePortalRequestAttachment(draftId: string, input: { clientUploadId: string; name: string; contentType: string; size: number }, request: PortalRequest = requestJson): Promise<PortalRequestAttachmentUpload> {
  return request<PortalRequestAttachmentUpload>(attachmentPath(draftId), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
}

export async function requestPortalAttachmentPartTicket(draftId: string, attachmentId: string, partNumber: number, request: PortalRequest = requestJson): Promise<PortalRequestAttachmentTicket> {
  return request<PortalRequestAttachmentTicket>(`${attachmentPath(draftId, attachmentId)}/part-ticket`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ partNumber }) });
}

export function uploadPortalAttachmentPart(ticket: PortalRequestAttachmentTicket, body: Blob, onProgress: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", ticket.url, true);
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(ticket.headers)) {
      if (name.toLowerCase() !== "content-length") xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = event => onProgress(event.loaded);
    xhr.onerror = () => reject(new Error("The direct upload connection failed."));
    xhr.onabort = () => reject(new Error("The direct upload was cancelled."));
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`The storage upload failed (${xhr.status}).`));
      const etag = xhr.getResponseHeader("ETag")?.trim();
      if (!etag) return reject(new Error("Storage did not return the required ETag. Check the R2 CORS exposeHeaders setting."));
      resolve(etag);
    };
    xhr.send(body);
  });
}

export async function checkpointPortalAttachmentPart(draftId: string, attachmentId: string, part: PortalRequestAttachmentPart, request: PortalRequest = requestJson): Promise<PortalRequestAttachmentPart> {
  return request<PortalRequestAttachmentPart>(`${attachmentPath(draftId, attachmentId)}/parts/${part.partNumber}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etag: part.etag, size: part.size }) });
}

export async function completePortalRequestAttachment(draftId: string, attachmentId: string, parts: PortalRequestAttachmentPart[], request: PortalRequest = requestJson): Promise<{ status: PortalRequestAttachmentStatus }> {
  return request(`${attachmentPath(draftId, attachmentId)}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts: parts.map(({ partNumber, etag }) => ({ partNumber, etag })) }) });
}

export async function loadPortalRequestAttachment(draftId: string, attachmentId: string, request: PortalRequest = requestJson): Promise<PortalRequestAttachmentUpload> {
  return request<PortalRequestAttachmentUpload>(attachmentPath(draftId, attachmentId));
}

export async function removePortalRequestAttachment(draftId: string, attachmentId: string, request: PortalRequest = requestJson): Promise<void> {
  await request(attachmentPath(draftId, attachmentId), { method: "DELETE" });
}

export async function updatePortalServiceRequest(
  requestId: string,
  input: PortalServiceRequestInput,
  expectedUpdatedAt: string,
  idempotencyKey: string,
  request: PortalRequest = requestJson,
): Promise<PortalServiceRequest> {
  const response = await request<{ request: PortalServiceRequest }>(
    `/api/client/service-requests/${encodeURIComponent(requestId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedUpdatedAt,
      },
      body: JSON.stringify(input),
    },
  );
  return response.request;
}

export async function createPortalChangeRequest(
  parentRequestId: string,
  input: PortalServiceRequestInput,
  idempotencyKey: string,
  request: PortalRequest = requestJson,
): Promise<PortalServiceRequest> {
  const response = await request<{ request: PortalServiceRequest }>(
    `/api/client/service-requests/${encodeURIComponent(parentRequestId)}/change-request`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ ...input, parentRequestId }),
    },
  );
  return response.request;
}

export async function respondToPortalEstimate(
  requestId: string,
  estimateId: string,
  response: "accept" | "request_change",
  note: string | null,
  idempotencyKey: string,
  request: PortalRequest = requestJson,
): Promise<PortalServiceRequest> {
  const value = await request<{ request: PortalServiceRequest }>(
    `/api/client/service-requests/${encodeURIComponent(requestId)}/estimate-response`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ estimateId, response, note }),
    },
  );
  return value.request;
}
