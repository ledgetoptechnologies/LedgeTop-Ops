export const PERMISSIONS = [
  "dashboard.view",
  "operations.view",
  "operations.view_all",
  "operations.manage",
  "sops.view",
  "sops.manage",
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

export interface NavigationDestination {
  latitude: number;
  longitude: number;
  label: string;
  coordinateSource:
    | "point"
    | "multipoint_representative"
    | "area_representative"
    | "fallback_point";
  googleMapsUrl: string;
  appleMapsUrl: string;
}

type NavigationGeometry = {
  type: "Point" | "MultiPoint" | "Polygon" | "MultiPolygon";
  coordinates: unknown;
};

function navigationCoordinate(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = Number(value[0]), latitude = Number(value[1]);
  return Number.isFinite(longitude) && Number.isFinite(latitude) &&
    longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
    ? [longitude, latitude]
    : null;
}

function navigationCoordinates(value: unknown, output: [number, number][]): void {
  const point = navigationCoordinate(value);
  if (point) {
    output.push(point);
    return;
  }
  if (Array.isArray(value))
    for (const child of value) navigationCoordinates(child, output);
}

function representativeNavigationPoint(points: [number, number][]): [number, number] | null {
  const unique = [...new Map(points.map(point => [`${point[0]}:${point[1]}`, point])).values()];
  if (!unique.length) return null;
  const latitude = unique.reduce((sum, point) => sum + point[1], 0) / unique.length;
  const longitudeVector = unique.reduce(
    (sum, point) => {
      const radians = point[0] * Math.PI / 180;
      return { x: sum.x + Math.cos(radians), y: sum.y + Math.sin(radians) };
    },
    { x: 0, y: 0 },
  );
  const longitude = Math.abs(longitudeVector.x) < 1e-12 && Math.abs(longitudeVector.y) < 1e-12
    ? unique[0]![0]
    : Math.atan2(longitudeVector.y, longitudeVector.x) * 180 / Math.PI;
  return unique.reduce((closest, candidate) => {
    const longitudeDelta = Math.abs(candidate[0] - longitude);
    const wrappedLongitudeDelta = Math.min(longitudeDelta, 360 - longitudeDelta);
    const distance = wrappedLongitudeDelta ** 2 + (candidate[1] - latitude) ** 2;
    const closestLongitudeDelta = Math.abs(closest[0] - longitude);
    const closestDistance = Math.min(closestLongitudeDelta, 360 - closestLongitudeDelta) ** 2 +
      (closest[1] - latitude) ** 2;
    return distance < closestDistance ? candidate : closest;
  }, unique[0]!);
}

/**
 * Returns a deterministic navigation hint. It is intentionally not a route,
 * road snap, survey centroid, or guarantee that the destination is drivable.
 */
export function buildNavigationDestination(input: {
  geometry?: NavigationGeometry | null;
  latitude?: number | null;
  longitude?: number | null;
  label?: string | null;
}): NavigationDestination | null {
  let point: [number, number] | null = null;
  let coordinateSource: NavigationDestination["coordinateSource"] = "fallback_point";
  const geometry = input.geometry;
  if (geometry?.type === "Point") {
    point = navigationCoordinate(geometry.coordinates);
    coordinateSource = "point";
  } else if (geometry?.type === "MultiPoint") {
    const points: [number, number][] = [];
    navigationCoordinates(geometry.coordinates, points);
    point = representativeNavigationPoint(points);
    coordinateSource = "multipoint_representative";
  } else if (geometry?.type === "Polygon" || geometry?.type === "MultiPolygon") {
    const points: [number, number][] = [];
    navigationCoordinates(geometry.coordinates, points);
    point = representativeNavigationPoint(points);
    coordinateSource = "area_representative";
  }
  if (!point) {
    point = navigationCoordinate([input.longitude, input.latitude]);
    coordinateSource = "fallback_point";
  }
  if (!point) return null;

  const [longitude, latitude] = point;
  const coordinate = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  const label = input.label?.trim().slice(0, 160) || "Job area";
  return {
    latitude,
    longitude,
    label,
    coordinateSource,
    googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinate)}`,
    appleMapsUrl: `https://maps.apple.com/?ll=${encodeURIComponent(coordinate)}&q=${encodeURIComponent(label)}`,
  };
}

export type ServiceRequestNotificationLifecycle =
  | "submitted"
  | "under_review"
  | "accepted_pending_pa_linkage"
  | "accepted_linked"
  | "declined"
  | "cancelled"
  | "completed"
  | "estimate_ready"
  | "client_response_received"
  | "work_area_changed";

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
  changeSummary?: string;
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
  changeSummary?: string | null;
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
    ...(input.changeSummary
      ? { changeSummary: boundedPresentationText(input.changeSummary, "Work area updated", 500) }
      : {}),
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
  "work_area_changed",
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
    (candidate.changeSummary !== undefined && typeof candidate.changeSummary !== "string") ||
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
    changeSummary: candidate.changeSummary,
  });
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  permissions: Permission[];
  divisions: Array<{ id: string; name: string; code: string }>;
}

export const THUMBNAIL_STATES = ["ready", "pending", "failed", "not_applicable"] as const;
export type ThumbnailState = (typeof THUMBNAIL_STATES)[number];

export const THUMBNAIL_FALLBACK_KINDS = [
  "image",
  "video",
  "audio",
  "pdf",
  "archive",
  "document",
  "spreadsheet",
  "unknown",
] as const;
export type ThumbnailFallbackKind = (typeof THUMBNAIL_FALLBACK_KINDS)[number];

/**
 * Returns a coarse, non-sensitive icon category. The result never includes the
 * file name and is safe to map to a client-bundled SVG after the caller has
 * received an authorized manifest.
 */
export function thumbnailFallbackKindForFile(
  fileName: string,
  mediaKind: "image" | "video" | "audio" | "pdf" | "text" | "other",
): ThumbnailFallbackKind {
  if (mediaKind === "image" || mediaKind === "video" || mediaKind === "audio" || mediaKind === "pdf") return mediaKind;
  const leaf = fileName.replace(/\\/g, "/").split("/").pop() || "";
  const extension = leaf.includes(".") ? leaf.slice(leaf.lastIndexOf(".") + 1).toLowerCase() : "";
  if (["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz"].includes(extension)) return "archive";
  if (["csv", "xls", "xlsx", "ods"].includes(extension)) return "spreadsheet";
  if (["doc", "docx", "odt", "rtf", "txt", "md", "json"].includes(extension) || mediaKind === "text") return "document";
  return "unknown";
}

export interface DeliveryItem {
  id: string;
  name: string;
  kind: "folder" | "image" | "video" | "audio" | "pdf" | "text" | "other";
  size: number | null;
  uploadedAt: string | null;
  /** Present only for a ready real thumbnail; never aliases an original. */
  thumbnailUrl?: string;
  thumbnailState?: ThumbnailState;
  thumbnailFallbackKind?: ThumbnailFallbackKind;
  previewUrl?: string;
  sourceUrl?: string;
  downloadUrl?: string;
  streamUrl?: string | null;
  previewStatus?: "ready" | "processing" | "unavailable";
  displayName?: string;
}

export interface DeliveryLocationPoint {
  latitude: number;
  longitude: number;
  /** Multiple images can share the same recorded position. */
  imageCount: number;
  /** Operations may attach an opaque, authorization-bound representative. */
  assetRef?: string;
}

export interface DeliveryLocationCollection {
  points: DeliveryLocationPoint[];
  imageCount: number;
  truncated: boolean;
}

export const MOVED_SOURCE_MARKER = "ltds-moved-source-v1" as const;

/** A zero-byte CAS marker left at a moved R2 key instead of an unsafe delete. */
export function isMovedSourceMarker(object: { customMetadata?: Record<string, string> }): boolean {
  return object.customMetadata?.ltdsMoveMarker === MOVED_SOURCE_MARKER;
}

/**
 * Aggregates authorized, version-checked asset rows without carrying asset or
 * storage identifiers across the API boundary.
 */
export function aggregateDeliveryLocations(
  rows: ReadonlyArray<{ latitude: number; longitude: number; assetRef?: string }>,
  maximumImages = 500,
): DeliveryLocationCollection {
  const limit = Number.isSafeInteger(maximumImages) && maximumImages > 0 ? maximumImages : 500;
  const selected = rows.slice(0, limit);
  const grouped = new Map<string, DeliveryLocationPoint>();
  let imageCount = 0;
  for (const row of selected) {
    if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude) ||
      row.latitude < -90 || row.latitude > 90 || row.longitude < -180 || row.longitude > 180) continue;
    imageCount += 1;
    const latitude = Number(row.latitude.toFixed(6));
    const longitude = Number(row.longitude.toFixed(6));
    const key = `${latitude}:${longitude}`;
    const existing = grouped.get(key);
    if (existing) existing.imageCount += 1;
    else grouped.set(key, {
      latitude,
      longitude,
      imageCount: 1,
      ...(row.assetRef ? { assetRef: row.assetRef } : {}),
    });
  }
  return { points: [...grouped.values()], imageCount, truncated: rows.length > limit };
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

/**
 * Serializable, versioned contract for the private Client -> Operations
 * service binding. Storage prefixes and Operations secrets are deliberately
 * absent. Operations independently resolves and reauthorizes every opaque ID.
 */
export interface ClientDelegatedShareSignerRequestV1 {
  protocolVersion: 1;
  workspaceId: string;
  delegationId: string;
  expectedDelegationVersion: number;
  createdByIdentityId: string;
  entitlementId: string;
  expectedEntitlementVersion: number;
  folderBindingId: string;
  expectedBindingSourceVersion: string;
  folderTargetId: string;
  label: string | null;
  expiresAt: string;
  accessCode?: string;
  idempotencyKey: string;
}

export interface ClientDelegatedShareSignerSuccessV1 {
  ok: true;
  protocolVersion: 1;
  receiptId: string;
  replayed: boolean;
  share: {
    id: string;
    publicId: string;
    /** Client links use a namespace distinct from staff `/s/` links. */
    path: string;
    /** The bearer is only present as a URL fragment, never as a standalone field. */
    shareUrl: string;
    label: string | null;
    status: "active";
    passwordProtected: boolean;
    expiresAt: string;
    createdAt: string;
  };
}

export interface ClientDelegatedShareSignerFailureV1 {
  ok: false;
  protocolVersion: 1;
  code: "invalid_request" | "denied" | "idempotency_conflict" | "configuration_error";
}

export type ClientDelegatedShareSignerResultV1 =
  | ClientDelegatedShareSignerSuccessV1
  | ClientDelegatedShareSignerFailureV1;

export interface ClientDelegatedShareSignerBinding {
  createClientDelegatedShare(
    request: ClientDelegatedShareSignerRequestV1,
  ): Promise<ClientDelegatedShareSignerResultV1>;
}
