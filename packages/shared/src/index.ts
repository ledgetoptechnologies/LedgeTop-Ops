export const PERMISSIONS = [
  "dashboard.view",
  "operations.view",
  "operations.view_all",
  "operations.manage",
  "projects.view",
  "tasks.view",
  "tasks.create",
  "tasks.update",
  "airspace.view",
  "delivery.browse",
  "delivery.rename",
  "delivery.delete",
  "delivery.files.create",
  "delivery.files.copy",
  "delivery.files.move",
  "delivery.files.upload",
  "delivery.files.batch",
  "delivery.files.restore",
  "delivery.share.create",
  "delivery.share.revoke",
  "delivery.share.audit",
  "file_requests.view",
  "file_requests.create",
  "file_requests.manage",
  "team.view",
  "team.manage",
  "roles.manage",
  "integrations.manage",
  "audit.view",
  "administration.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type PermissionScope = "global" | "division" | "assigned" | "own";
export type OperationStatus = "draft" | "scheduled" | "ready" | "blocked" | "in_progress" | "completed" | "cancelled";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

export type ServiceRequestNotificationLifecycle =
  | "submitted"
  | "under_review"
  | "accepted_pending_pa_linkage"
  | "accepted_linked"
  | "declined"
  | "cancelled"
  | "completed"
  | "estimate_ready"
  | "client_response_received";

export interface ServiceRequestNotificationSnapshot {
  presentationVersion: 1;
  title: string;
  projectContext: {
    kind: "existing_project" | "new_or_one_off";
    label: string;
  };
  scopeLabel: string;
  locationLabel: string;
  lifecycle: ServiceRequestNotificationLifecycle;
  action: "review_in_operations" | "open_client_portal";
}

function boundedPresentationText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : fallback;
}

export function serviceRequestLocationLabel(
  label: string | null | undefined,
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): string {
  const selected = boundedPresentationText(label, "", 240);
  if (selected) return selected;
  if (Number.isFinite(latitude) && Number.isFinite(longitude))
    return `Near ${Number(latitude).toFixed(4)}, ${Number(longitude).toFixed(4)}`;
  return "Location not specified";
}

export function buildServiceRequestNotificationSnapshot(input: {
  title: string;
  projectId?: string | null;
  projectName?: string | null;
  serviceCategory?: string | null;
  locationLabel?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  lifecycle: ServiceRequestNotificationLifecycle;
  action: ServiceRequestNotificationSnapshot["action"];
}): ServiceRequestNotificationSnapshot {
  const existingProject = Boolean(input.projectId);
  return {
    presentationVersion: 1,
    title: boundedPresentationText(input.title, "Service request", 160),
    projectContext: existingProject
      ? {
          kind: "existing_project",
          label: boundedPresentationText(input.projectName, "Existing project", 240),
        }
      : { kind: "new_or_one_off", label: "New or one-off service" },
    scopeLabel: boundedPresentationText(input.serviceCategory, "General service", 100),
    locationLabel: serviceRequestLocationLabel(
      input.locationLabel,
      input.latitude,
      input.longitude,
    ),
    lifecycle: input.lifecycle,
    action: input.action,
  };
}

const serviceRequestNotificationLifecycles = new Set<ServiceRequestNotificationLifecycle>([
  "submitted",
  "under_review",
  "accepted_pending_pa_linkage",
  "accepted_linked",
  "declined",
  "cancelled",
  "completed",
  "estimate_ready",
  "client_response_received",
]);

export function parseServiceRequestNotificationSnapshot(
  value: unknown,
): ServiceRequestNotificationSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ServiceRequestNotificationSnapshot>;
  if (
    candidate.presentationVersion !== 1 ||
    typeof candidate.title !== "string" ||
    !candidate.projectContext ||
    typeof candidate.projectContext !== "object" ||
    !["existing_project", "new_or_one_off"].includes(candidate.projectContext.kind) ||
    typeof candidate.projectContext.label !== "string" ||
    typeof candidate.scopeLabel !== "string" ||
    typeof candidate.locationLabel !== "string" ||
    !serviceRequestNotificationLifecycles.has(candidate.lifecycle as ServiceRequestNotificationLifecycle) ||
    !["review_in_operations", "open_client_portal"].includes(candidate.action as string)
  )
    return null;
  return buildServiceRequestNotificationSnapshot({
    title: candidate.title,
    projectId: candidate.projectContext.kind === "existing_project" ? "snapshot-project" : null,
    projectName: candidate.projectContext.label,
    serviceCategory: candidate.scopeLabel,
    locationLabel: candidate.locationLabel,
    lifecycle: candidate.lifecycle as ServiceRequestNotificationLifecycle,
    action: candidate.action as ServiceRequestNotificationSnapshot["action"],
  });
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  permissions: Permission[];
  divisions: Array<{ id: string; name: string; code: string }>;
}

export interface DeliveryItem {
  id: string;
  name: string;
  kind: "folder" | "image" | "video" | "audio" | "pdf" | "text" | "other";
  size: number | null;
  uploadedAt: string | null;
  thumbnailUrl?: string;
  previewUrl?: string;
  sourceUrl?: string;
  downloadUrl?: string;
  streamUrl?: string | null;
  previewStatus?: "ready" | "processing" | "unavailable";
  displayName?: string;
}

export interface DeliveryManifest {
  share: {
    publicId: string;
    label: string | null;
    clientName: string;
    projectName: string;
    expiresAt: string | null;
  };
  folder: { id: string; name: string; breadcrumbs: Array<{ id: string; name: string }> };
  items: DeliveryItem[];
  nextCursor: string | null;
  capabilities?: {
    cloudTransfer?: {
      dropbox: boolean;
      googleDrive: boolean;
      googlePicker: boolean;
    };
  };
}

export const BRAND = {
  name: "Ledge Top Drone Services",
  shortName: "LTDS",
  logoUrl: "https://ledgetopdroneservices.com/images/DroneLogo01.webp",
  orange: "#ee5007",
} as const;

export function hasPermission(permissions: readonly string[], permission: Permission): boolean {
  return permissions.includes(permission);
}
