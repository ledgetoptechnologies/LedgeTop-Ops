export const PERMISSIONS = [
  "dashboard.view",
  "operations.view",
  "operations.manage",
  "projects.view",
  "tasks.view",
  "tasks.create",
  "tasks.update",
  "airspace.view",
  "delivery.browse",
  "delivery.rename",
  "delivery.delete",
  "delivery.share.create",
  "delivery.share.revoke",
  "delivery.share.audit",
  "team.view",
  "team.manage",
  "roles.manage",
  "integrations.manage",
  "audit.view",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type PermissionScope = "global" | "division" | "assigned" | "own";
export type OperationStatus = "draft" | "scheduled" | "ready" | "blocked" | "in_progress" | "completed" | "cancelled";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";

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
