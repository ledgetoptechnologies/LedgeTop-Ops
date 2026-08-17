import type { ViewerDisplayUnits } from "@ltds/shared";

export type GcpInterchangeFormat = "generic-csv-v1" | "generic-geojson-v1";
export const MAX_GCP_IMPORT_BYTES = 2 * 1024 * 1024;

export function validateGcpImportSize(byteSize: number): string | null {
  return Number.isSafeInteger(byteSize) && byteSize >= 0 && byteSize <= MAX_GCP_IMPORT_BYTES
    ? null
    : "GCP interchange files must be 2 MiB or smaller.";
}

export interface ViewerGcpSet {
  id: string;
  datasetId: string;
  displayName: string;
  sourceFormat: GcpInterchangeFormat;
  sourceFileId: string | null;
  sourceFilename: string | null;
  sourceSha256: string;
  crs: "EPSG:4326";
  elevationUnits: "m";
  pointCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ViewerGcpPoint {
  id: string;
  setId: string;
  externalId: string;
  label: string;
  latitude: number;
  longitude: number;
  elevationM: number;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ViewerGcpImage {
  id: string;
  datasetId: string;
  relativePath: string;
  mimeType: string;
  capturedAt: string | null;
  latitude: number;
  longitude: number;
  altitudeM: number | null;
  width: number | null;
  height: number | null;
  distanceM: number | null;
}

export interface ViewerGcpCorrespondence {
  id: string;
  taskId: string;
  pointId: string;
  imageFileId: string;
  pixelX: number;
  pixelY: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function formatGcpElevation(meters: number, units: ViewerDisplayUnits): string {
  return units === "imperial"
    ? `${(meters * 3.280839895).toFixed(2)} ft`
    : `${meters.toFixed(2)} m`;
}

export function formatGcpDistance(meters: number | null, units: ViewerDisplayUnits): string {
  if (meters == null) return "Distance unavailable";
  if (units === "metric") return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
  const feet = meters * 3.280839895;
  return meters < 1609.344 ? `${Math.round(feet)} ft` : `${(meters / 1609.344).toFixed(2)} mi`;
}
