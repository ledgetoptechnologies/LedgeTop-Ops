import { requestJson, selectClientWorkspaceId, selectedClientWorkspaceId } from "./bulk-download";
import type { DeliveryLocationCollection, ViewerPublicShareCreation, ViewerPublicShareSummary } from "@ltds/shared";
import { loadNativePortalContext, type NativePortalBootstrap } from "./native-portal-api";

export interface PortalCapabilities {
  manageTeam: boolean;
  viewBilling: boolean;
  requestV2: boolean;
  requestAttachments: boolean;
  workspaceHierarchyV2: boolean;
  workspaceMembershipManagement: boolean;
  hierarchyScopedInvitations: boolean;
  invitationEmailDelivery: boolean;
  delegatedShares: boolean;
  viewer: boolean;
  viewerShares: boolean;
  feedback: boolean;
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
  name: string;
  size: number;
  uploadedAt: string;
  contentType: string | null;
  kind: "image" | "video" | "audio" | "pdf" | "text" | "other";
  previewPath: string | null;
  thumbnailPath: string | null;
  downloadPath: string;
}

export interface PortalFolder {
  id: string;
  name: string;
}

export interface PortalFileBreadcrumb {
  id: string | null;
  name: string;
}

export interface PortalFilePage {
  files: PortalFile[];
  folders?: PortalFolder[];
  breadcrumbs?: PortalFileBreadcrumb[];
  folderId?: string | null;
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
  resourceMode?: "legacy";
  account: PortalAccount;
  capabilities: PortalCapabilities;
  projects: PortalProject[];
  requests: PortalServiceRequest[];
  mapboxPublicToken: string | null;
  workspaces?: PortalWorkspace[];
  selectedWorkspaceId?: string | null;
  viewerDisplayUnits: "imperial" | "metric";
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
  requestApi: PortalRequest = requestJson,
  requestedWorkspaceId?: string | null,
  signal?: AbortSignal,
): Promise<PortalBootstrap | NativePortalBootstrap> {
  const request: PortalRequest = (url, init) => requestApi(url, signal ? {...init, signal} : init);
  if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestedWorkspaceId)) throw Object.assign(new Error("Invalid workspace link"), {status: 403});
  type PortalSession = {
    account: PortalAccount;
    capabilities?: Partial<PortalCapabilities>;
    viewerDisplayUnits?: "imperial" | "metric";
  };
  let session = await request<PortalSession>("/api/client/session", { omitWorkspace: true });
  let workspaces: PortalWorkspace[] = [];
  let selectedWorkspaceId: string | null = null;
  if (session.capabilities?.workspaceHierarchyV2 === true) {
    workspaces = await loadPortalWorkspaces(request);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const prior = selectedClientWorkspaceId();
    if (requestedWorkspaceId && !workspaces.some(workspace => workspace.id === requestedWorkspaceId)) throw Object.assign(new Error("This workspace is not available to your account"), {status: 403});
    selectedWorkspaceId = requestedWorkspaceId || (workspaces.some(workspace => workspace.id === prior)
      ? prior
      : workspaces[0]?.id ?? null);
    selectClientWorkspaceId(selectedWorkspaceId);
    if (!selectedWorkspaceId) throw new Error("No authorized client workspace is available");
  } else {
    if (requestedWorkspaceId) throw Object.assign(new Error("This workspace is not available to your account"), {status: 403});
    selectClientWorkspaceId(null);
  }
  const selected = workspaces.find(workspace => workspace.id === selectedWorkspaceId);
  if (selected?.sourceId && selected.sourceId !== "project-alpha:primary" && selected.resourceMode !== "native") throw Object.assign(new Error("This connected workspace is not available in this portal mode"), {status: 403});
  if (selected?.resourceMode === "native") {
    const context = await loadNativePortalContext(selected, request, signal);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return {
      ...context, resourceMode: "native", workspaces, selectedWorkspaceId: selected.id,
      capabilities: {
        directoryRead: context.capabilities.directoryRead, deliveryView: context.capabilities.deliveryView,
        workspaceHierarchyV2: true, manageTeam: false, viewBilling: false, requestV2: false, requestAttachments: false,
        // These three flags only expose the global invitation surface. The
        // selected workspace's /access response remains the authority for
        // whether the signed-in identity may see or change any member data.
        workspaceMembershipManagement: session.capabilities?.workspaceMembershipManagement === true,
        hierarchyScopedInvitations: session.capabilities?.hierarchyScopedInvitations === true,
        invitationEmailDelivery: session.capabilities?.invitationEmailDelivery === true,
        delegatedShares: false, viewer: false, viewerShares: false, feedback: false,
      },
    };
  }
  // Discovery is identity-only. Legacy resources still need their selected account's session.
  if (selectedWorkspaceId) session = await request<PortalSession>("/api/client/session");
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
      hierarchyScopedInvitations: session.capabilities?.hierarchyScopedInvitations === true,
      invitationEmailDelivery: session.capabilities?.invitationEmailDelivery === true,
      delegatedShares: session.capabilities?.delegatedShares === true,
      viewer: session.capabilities?.viewer === true,
      viewerShares: session.capabilities?.viewerShares === true,
      feedback: session.capabilities?.feedback === true,
    },
    projects: projects.projects,
    requests: requests.requests,
    mapboxPublicToken: mapConfig.mapboxPublicToken,
    workspaces,
    selectedWorkspaceId,
    viewerDisplayUnits: session.viewerDisplayUnits === "metric" ? "metric" : "imperial",
  };
}

export interface PortalViewerModel {
  associationId: string;
  title: string;
  provider: string;
  modelId: string;
  modelVersionId: string;
  updatedAt: string;
  canShare: boolean;
}

export type PortalViewerShare = ViewerPublicShareSummary;
export type PortalViewerShareCreation = ViewerPublicShareCreation & { replayed: boolean };

export interface PortalViewerSession {
  grant: string;
  grantExpiresAt: string;
  sessionTtlSeconds: number;
  redeemUrl: string;
  embedUrl: string;
}

export async function loadPortalViewerModels(
  projectId: string,
  request: PortalRequest = requestJson,
): Promise<PortalViewerModel[]> {
  return (await request<{ models: PortalViewerModel[] }>(
    `/api/client/projects/${encodeURIComponent(projectId)}/models`,
  )).models;
}

export async function createPortalViewerSession(
  projectId: string,
  associationId: string,
  idempotency: string,
  displayUnits: "imperial" | "metric" = "imperial",
  request: PortalRequest = requestJson,
): Promise<PortalViewerSession> {
  return request<PortalViewerSession>(
    `/api/client/projects/${encodeURIComponent(projectId)}/models/${encodeURIComponent(associationId)}/session`,
    { method: "POST", headers: { "Idempotency-Key": idempotency }, body: JSON.stringify({ displayUnits }) },
  );
}

export async function updatePortalViewerUnits(
  displayUnits: "imperial" | "metric",
  request: PortalRequest = requestJson,
): Promise<{ displayUnits: "imperial" | "metric" }> {
  return request("/api/client/viewer/preferences", { method: "PATCH", body: JSON.stringify({ displayUnits }) });
}

export async function loadPortalViewerShares(
  projectId: string,
  associationId: string,
  request: PortalRequest = requestJson,
): Promise<PortalViewerShare[]> {
  return (await request<{ shares: PortalViewerShare[] }>(
    `/api/client/projects/${encodeURIComponent(projectId)}/models/${encodeURIComponent(associationId)}/shares`,
  )).shares;
}

export async function createPortalViewerShare(
  projectId: string,
  associationId: string,
  input: { label: string | null; expiresAt: string | null; password?: string; displayUnits: "imperial" | "metric" },
  idempotency: string,
  request: PortalRequest = requestJson,
): Promise<PortalViewerShareCreation> {
  return request(
    `/api/client/projects/${encodeURIComponent(projectId)}/models/${encodeURIComponent(associationId)}/shares`,
    { method: "POST", headers: { "Idempotency-Key": idempotency }, body: JSON.stringify(input) },
  );
}

export async function revokePortalViewerShare(
  projectId: string,
  associationId: string,
  shareId: string,
  idempotency: string,
  request: PortalRequest = requestJson,
): Promise<void> {
  await request(
    `/api/client/projects/${encodeURIComponent(projectId)}/models/${encodeURIComponent(associationId)}/shares/${encodeURIComponent(shareId)}`,
    { method: "DELETE", headers: { "Idempotency-Key": idempotency } },
  );
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

export async function loadPortalProjectFolderFiles(
  projectId: string,
  folder: string | null,
  cursor: string | null = null,
  signal?: AbortSignal,
  request: PortalRequest = requestJson,
): Promise<PortalFilePage> {
  const params = new URLSearchParams();
  if (folder) params.set("folder", folder);
  if (cursor) params.set("cursor", cursor);
  const query = params.size ? `?${params.toString()}` : "";
  return request<PortalFilePage>(
    `/api/client/projects/${encodeURIComponent(projectId)}/files${query}`,
    signal ? { signal } : undefined,
  );
}

export async function loadPortalPastDeliveries(
  cursor: string | null = null,
  request: PortalRequest = requestJson,
  signal?: AbortSignal,
): Promise<PortalFilePage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request<PortalFilePage>(`/api/client/past-deliveries${query}`, signal ? { signal } : undefined);
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

export interface PortalWorkspace { id: string; rootType: "organization" | "standalone_client"; rootPublicId: string; displayName: string; resourceMode?: "native"; sourceId?: string }
export type PortalHierarchyScopeType = "organization" | "department" | "client" | "project";
export interface PortalWorkspaceEntry { type: PortalHierarchyScopeType | "standalone_client" | "contact"; publicId: string; parentPublicId: string | null; displayName: string; sourceVersion: string }
export interface PortalWorkspaceMember { identityId: string; email: string | null; status: "active" | "suspended" | "revoked"; manager: boolean; source: string; managerVersion?: number; canChangeManager?: boolean }
export interface PortalProjectAccessTermsInput { kind: "customer" | "collaborator"; mode: "specific_date" | "project_end" | "until_revoked"; expiresAt: string | null }
export interface PortalProjectAccessTerms extends PortalProjectAccessTermsInput { id: string; effectiveExpiresAt: string | null; completionPending: boolean; expired: boolean }
export interface PortalWorkspaceInvitation { id: string; email: string; status: "pending" | "accepted" | "revoked" | "expired"; scope: { type: PortalHierarchyScopeType | "workspace"; publicId: string | null }; capabilities: string[]; expiresAt: string; accessTerms: PortalProjectAccessTerms | null }
export interface PortalInviteScope { type: PortalHierarchyScopeType; publicId: string; displayName: string; capabilities: Array<"delivery.view" | "request.create">; projectEndSupported: boolean }
export interface PortalWorkspaceAccess { sourceId: string; sourceName: string; workspaceName: string; members: PortalWorkspaceMember[]; invitations: PortalWorkspaceInvitation[]; invitationPolicy: { mode: "allowed" | "disabled" | "require_approval"; version: number }; projectAccessTermsSupported: boolean; projectAccessOptions: Array<{ projectPublicId: string; projectEndSupported: boolean }>; canManageMembers: boolean; inviteScopes: PortalInviteScope[]; invitationRequestsSupported: boolean; addressBookAvailable?: boolean; canManageAddressBook?: boolean; peerAdminManagement?: boolean }
export interface PortalWorkspaceInvitationInput { email: string; projectPublicId?: string; targetScope?: { type: PortalHierarchyScopeType; publicId: string }; organizationWide?: boolean; confirmOrganizationWide?: boolean; capabilities: Array<"delivery.view" | "request.create">; accessTerms?: PortalProjectAccessTermsInput; expectedInvitationPolicyVersion?: number; addressContact?: {id: string; expectedVersion: number} }
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

export async function loadPortalWorkspaces(request: PortalRequest = requestJson, signal?: AbortSignal): Promise<PortalWorkspace[]> {
  const result = signal ? await request<{workspaces: PortalWorkspace[]}>("/api/client/v2/workspaces", {signal}) : await request<{workspaces: PortalWorkspace[]}>("/api/client/v2/workspaces");
  return result.workspaces;
}

export async function loadPortalWorkspaceHierarchy(workspaceId: string, request: PortalRequest = requestJson, signal?: AbortSignal): Promise<PortalWorkspaceEntry[]> {
  const url = `/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/hierarchy`;
  const result = signal ? await request<{entries: PortalWorkspaceEntry[]}>(url, {signal}) : await request<{entries: PortalWorkspaceEntry[]}>(url);
  return result.entries;
}

export async function loadPortalWorkspaceAccess(workspaceId: string, request: PortalRequest = requestJson, signal?: AbortSignal): Promise<PortalWorkspaceAccess> {
  const url = `/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/access`;
  return signal ? request(url, {signal}) : request(url);
}

export async function invitePortalWorkspaceMember(workspaceId: string, input: PortalWorkspaceInvitationInput, request: PortalRequest = requestJson, options?: { idempotencyKey: string; signal?: AbortSignal }): Promise<{outcome: "created" | "replayed" | "approval_requested" | "approval_replayed"; request?: unknown; deliveryQueued?: boolean}> {
  return request(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/invitations`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": options?.idempotencyKey ?? crypto.randomUUID() }, body: JSON.stringify(input), ...(options?.signal ? {signal: options.signal} : {}),
  });
}

export async function revokePortalWorkspaceInvitation(workspaceId: string, invitationId: string, request: PortalRequest = requestJson, signal?: AbortSignal): Promise<void> {
  await request(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE", ...(signal ? {signal} : {}) });
}

export async function suspendPortalWorkspaceMember(workspaceId: string, identityId: string, request: PortalRequest = requestJson, signal?: AbortSignal): Promise<void> {
  await request(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(identityId)}`, { method: "DELETE", ...(signal ? {signal} : {}) });
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

export async function changePortalWorkspacePeerAdministrator(workspaceId:string,identityId:string,input:{manager:boolean;expectedVersion:number},
  request:PortalRequest=requestJson,options?:{idempotencyKey:string;signal?:AbortSignal}):Promise<{outcome:"created"|"replayed";manager:boolean;version:number}>{
  return request(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(identityId)}/manager`,{
    method:"PUT",headers:{"Content-Type":"application/json","Idempotency-Key":options?.idempotencyKey??crypto.randomUUID()},body:JSON.stringify(input),
    ...(options?.signal?{signal:options.signal}:{})
  });
}

export type PortalRequestReadinessReason = "ready" | "legacy_access_unavailable" | "request_not_permitted" | "project_unavailable" | "catalog_unavailable" | "request_unavailable" | "no_services_assigned" | "service_assignments_unavailable";
export interface PortalRequestReadiness {
  mode: "catalog" | "legacy";
  workspaceId: string | null;
  target: { kind: "root" | "project"; projectId: string | null };
  canStartRequest: boolean;
  reason: PortalRequestReadinessReason;
  root: { canStartRequest: boolean; reason: PortalRequestReadinessReason };
  projectRequestsSupported: boolean;
  refreshedAt: string;
}

export async function loadPortalRequestReadiness(projectId: string | null, signal?: AbortSignal, request: PortalRequest = requestJson): Promise<PortalRequestReadiness> {
  const result = await request<PortalRequestReadiness>(`/api/client/request-readiness${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { signal });
  const reasons: PortalRequestReadinessReason[] = ["ready", "legacy_access_unavailable", "request_not_permitted", "project_unavailable", "catalog_unavailable", "request_unavailable", "no_services_assigned", "service_assignments_unavailable"];
  if (!result || !["catalog", "legacy"].includes(result.mode) || typeof result.canStartRequest !== "boolean"
    || !reasons.includes(result.reason) || !result.root || typeof result.root.canStartRequest !== "boolean" || !reasons.includes(result.root.reason)
    || typeof result.projectRequestsSupported !== "boolean" || !(result.workspaceId === null || typeof result.workspaceId === "string")
    || result.target?.kind !== (projectId ? "project" : "root") || result.target.projectId !== projectId
    || typeof result.refreshedAt !== "string" || !Number.isFinite(Date.parse(result.refreshedAt))) throw new Error("Request availability could not be verified.");
  return result;
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
  services: Array<{ publicId: string; sourceVersion: string; answers: Record<string, unknown> }>;
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

export interface PortalServiceDraftSummary {
  id: string;
  projectId: string | null;
  title: string;
  serviceNames: string[];
  areaAcres: number | null;
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
  projectId: string | null,
  request: PortalRequest = requestJson,
  signal?: AbortSignal,
): Promise<PortalServiceCatalogItem[]> {
  const target = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const response = await request<{ services: PortalServiceCatalogItem[] }>(`/api/client/service-catalog${target}`, { signal });
  return response.services;
}

export interface PortalServiceCatalogPage {
  services: PortalServiceCatalogItem[];
  nextCursor: string | null;
  complete: boolean;
  source: { generation: string; sequence: number } | null;
  assignment?: {
    sourceId: string;
    generation: string;
    sequence: number;
    subjectType: "organization" | "standalone_client" | "project";
    subjectPublicId: string;
  };
  legacy?: boolean;
}
export async function loadPortalServiceCatalogPage(projectId: string | null, cursor: string | null, signal?: AbortSignal, request: PortalRequest = requestJson): Promise<PortalServiceCatalogPage> {
  let response: PortalServiceCatalogPage;
  const parameters = new URLSearchParams();
  if (projectId) parameters.set("projectId", projectId);
  if (cursor) parameters.set("cursor", cursor);
  const query = parameters.size ? `?${parameters.toString()}` : "";
  try {
    response = await request<PortalServiceCatalogPage>(`/api/client/service-catalog/page${query}`, { signal });
  } catch (caught) {
    const failure = caught as { status?: number; body?: { code?: string } };
    if (!cursor && failure.status === 503 && failure.body?.code === "catalog_not_ready") {
      return { services: await loadPortalServiceCatalog(projectId, request, signal), nextCursor: null, complete: false, source: null, legacy: true };
    }
    throw caught;
  }
  const assignment = response?.assignment;
  if (!response || !Array.isArray(response.services) || typeof response.complete !== "boolean"
    || !(response.nextCursor === null || typeof response.nextCursor === "string" && response.nextCursor.length > 0)
    || response.complete !== (response.nextCursor === null) || !response.source || typeof response.source.generation !== "string"
    || !Number.isSafeInteger(response.source.sequence) || response.source.sequence < 0
    || assignment !== undefined && (!assignment || typeof assignment.sourceId !== "string" || !assignment.sourceId
      || typeof assignment.generation !== "string" || !assignment.generation
      || !Number.isSafeInteger(assignment.sequence) || assignment.sequence < 0
      || !["organization", "standalone_client", "project"].includes(assignment.subjectType)
      || typeof assignment.subjectPublicId !== "string" || !assignment.subjectPublicId)) throw new Error("Service library records could not be verified.");
  return response;
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

export async function loadPortalServiceDrafts(
  request: PortalRequest = requestJson,
): Promise<PortalServiceDraftSummary[]> {
  const response = await request<{ drafts: PortalServiceDraftSummary[] }>("/api/client/service-request-drafts");
  return response.drafts;
}

export async function loadPortalServiceDraft(
  draftId: string,
  request: PortalRequest = requestJson,
  signal?: AbortSignal,
): Promise<PortalServiceDraft> {
  const response = await request<{ draft: PortalServiceDraft }>(`/api/client/service-request-drafts/${encodeURIComponent(draftId)}`, { signal });
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
  signal?: AbortSignal,
): Promise<PortalPricingHint | null> {
  const response = await request<{ available: boolean; hint: PortalPricingHint | null }>(
    `/api/client/service-request-drafts/${encodeURIComponent(draftId)}/pricing-hint`,
    { signal },
  );
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
