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
  status: PortalServiceRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PortalBootstrap {
  account: PortalAccount;
  projects: PortalProject[];
  requests: PortalServiceRequest[];
}

export interface CreatePortalServiceRequestInput {
  projectId: string;
  requestType: "flight" | "service";
  title: string;
  details: string;
  location: string | null;
  preferredStartAt: string | null;
}

export type PortalRequest = typeof requestJson;

export async function loadPortalBootstrap(request: PortalRequest = requestJson): Promise<PortalBootstrap> {
  const session = await request<{ account: PortalAccount }>("/api/client/session");
  const [projects, requests] = await Promise.all([
    request<{ projects: PortalProject[] }>("/api/client/projects"),
    request<{ requests: PortalServiceRequest[] }>("/api/client/service-requests"),
  ]);
  return { account: session.account, projects: projects.projects, requests: requests.requests };
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
