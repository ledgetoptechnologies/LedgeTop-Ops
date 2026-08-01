import { requestJson } from "./bulk-download";

export interface PortalCapabilities {
  manageTeam: boolean;
  viewBilling: boolean;
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
    },
    projects: projects.projects,
    requests: requests.requests,
    mapboxPublicToken: mapConfig.mapboxPublicToken,
  };
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
