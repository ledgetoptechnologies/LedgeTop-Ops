import { requestJson } from "./bulk-download";

export interface PortalAccount {
  id: string;
  displayName: string;
}

export interface PortalProject {
  id: string;
  externalRef: string;
  clientName: string;
  projectName: string;
  canRequestService: boolean;
}

export interface PortalDelivery {
  shareId: string;
  publicId: string;
  shareVersion: number;
  label: string | null;
  expiresAt: string | null;
  requiresPassword: boolean;
  handoffPath: string;
}

// This is deliberately the same closed set as client_service_requests.status.
// Translating it in the browser previously made valid server states invisible.
export type PortalServiceRequestStatus = "submitted" | "under_review" | "accepted" | "declined" | "cancelled" | "completed";

export interface PortalServiceRequest {
  id: string;
  projectId: string;
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
  areaGeoJson?: { type: "Polygon"; coordinates: [number, number][][] } | null;
  status: PortalServiceRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PortalBootstrap {
  account: PortalAccount;
  projects: PortalProject[];
  requests: PortalServiceRequest[];
  mapboxPublicToken: string | null;
}

export interface CreatePortalServiceRequestInput {
  projectId: string;
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
  areaGeoJson?: { type: "Polygon"; coordinates: [number, number][][] } | null;
}

export type PortalRequest = typeof requestJson;

export async function loadPortalBootstrap(request: PortalRequest = requestJson): Promise<PortalBootstrap> {
  const session = await request<{ account: PortalAccount }>("/api/client/session");
  const [projects, requests, mapConfig] = await Promise.all([
    request<{ projects: PortalProject[] }>("/api/client/projects"),
    request<{ requests: PortalServiceRequest[] }>("/api/client/service-requests"),
    request<{ mapboxPublicToken: string | null }>("/api/client/map-config"),
  ]);
  return { account: session.account, projects: projects.projects, requests: requests.requests, mapboxPublicToken: mapConfig.mapboxPublicToken };
}

export async function loadPortalDeliveries(projectId: string, request: PortalRequest = requestJson): Promise<PortalDelivery[]> {
  const response = await request<{ deliveries: PortalDelivery[] }>(
    `/api/client/projects/${encodeURIComponent(projectId)}/deliveries`,
  );
  return response.deliveries;
}

export async function createPortalServiceRequest(
  input: CreatePortalServiceRequestInput,
  idempotencyKey: string,
  request: PortalRequest = requestJson,
): Promise<PortalServiceRequest> {
  const response = await request<{ request: PortalServiceRequest }>("/api/client/service-requests", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(input),
  });
  return response.request;
}
