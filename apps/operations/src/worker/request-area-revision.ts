export interface StaffRequestArea {
  type: "Polygon";
  coordinates: [number, number][][];
}

export interface StaffRequestPoi {
  longitude: number;
  latitude: number;
  label: string | null;
}

export interface StaffRequestWorkArea {
  areaGeoJson: StaffRequestArea | null;
  poiPoints: StaffRequestPoi[];
}

const MAX_AREA_BYTES = 12 * 1024;
const MAX_VERTICES = 64;
const MAX_SPAN_DEGREES = 20;
const MAX_POIS = 20;

function samePoint(left: [number, number], right: [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: [number, number], b: [number, number], point: [number, number]): boolean {
  return Math.min(a[0], b[0]) <= point[0] && point[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= point[1] && point[1] <= Math.max(a[1], b[1]);
}

function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const abC = orientation(a, b, c), abD = orientation(a, b, d),
    cdA = orientation(c, d, a), cdB = orientation(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
      ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return (abC === 0 && onSegment(a, b, c)) ||
    (abD === 0 && onSegment(a, b, d)) ||
    (cdA === 0 && onSegment(c, d, a)) ||
    (cdB === 0 && onSegment(c, d, b));
}

function polygonArea(points: [number, number][]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const point = points[index]!, next = points[index + 1]!;
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  return Math.abs(twiceArea) / 2;
}

export function validateStaffRequestArea(value: unknown): StaffRequestArea | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid area");
  const candidate = value as { type?: unknown; coordinates?: unknown };
  if (candidate.type !== "Polygon" || !Array.isArray(candidate.coordinates) || candidate.coordinates.length !== 1)
    throw new Error("invalid area");
  const ring = candidate.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > MAX_VERTICES + 1)
    throw new Error("invalid area");
  const points: [number, number][] = ring.map(point => {
    if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))
      throw new Error("invalid area");
    const longitude = Number(point[0]), latitude = Number(point[1]);
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)
      throw new Error("invalid area");
    return [longitude, latitude];
  });
  if (!samePoint(points[0]!, points.at(-1)!)) throw new Error("invalid area");
  const vertices = points.slice(0, -1), longitudes = vertices.map(point => point[0]),
    latitudes = vertices.map(point => point[1]);
  if (Math.max(...longitudes) - Math.min(...longitudes) > MAX_SPAN_DEGREES ||
      Math.max(...latitudes) - Math.min(...latitudes) > MAX_SPAN_DEGREES ||
      polygonArea(points) <= 0.00000001) throw new Error("invalid area");
  for (let left = 0; left < vertices.length; left += 1) {
    const nextLeft = (left + 1) % vertices.length;
    for (let right = left + 1; right < vertices.length; right += 1) {
      const nextRight = (right + 1) % vertices.length;
      if (left === right || nextLeft === right || nextRight === left) continue;
      if (segmentsIntersect(vertices[left]!, vertices[nextLeft]!, vertices[right]!, vertices[nextRight]!))
        throw new Error("invalid area");
    }
  }
  const area: StaffRequestArea = { type: "Polygon", coordinates: [points] };
  if (new TextEncoder().encode(JSON.stringify(area)).byteLength > MAX_AREA_BYTES)
    throw new Error("invalid area");
  return area;
}

export function validateStaffRequestPois(value: unknown): StaffRequestPoi[] {
  if (!Array.isArray(value) || value.length > MAX_POIS) throw new Error("invalid points");
  return value.map(point => {
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new Error("invalid points");
    const candidate = point as { longitude?: unknown; latitude?: unknown; label?: unknown };
    const longitude = Number(candidate.longitude), latitude = Number(candidate.latitude);
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        !Number.isFinite(latitude) || latitude < -90 || latitude > 90)
      throw new Error("invalid points");
    if (candidate.label !== null && candidate.label !== undefined &&
        (typeof candidate.label !== "string" || !candidate.label.trim() || candidate.label.trim().length > 100))
      throw new Error("invalid points");
    return { longitude, latitude, label: typeof candidate.label === "string" ? candidate.label.trim() : null };
  });
}

export function parseStoredWorkArea(areaGeoJson: string | null, poiPointsJson: string | null): StaffRequestWorkArea {
  return {
    areaGeoJson: validateStaffRequestArea(areaGeoJson ? JSON.parse(areaGeoJson) : null),
    poiPoints: validateStaffRequestPois(poiPointsJson ? JSON.parse(poiPointsJson) : []),
  };
}

export function summarizeWorkAreaChange(previous: StaffRequestWorkArea, next: StaffRequestWorkArea): string {
  const changes: string[] = [];
  if (JSON.stringify(previous.areaGeoJson) !== JSON.stringify(next.areaGeoJson))
    changes.push(next.areaGeoJson ? (previous.areaGeoJson ? "service-area boundary adjusted" : "service-area boundary added") : "service-area boundary removed");
  const difference = next.poiPoints.length - previous.poiPoints.length;
  if (difference > 0) changes.push(`${difference} point${difference === 1 ? "" : "s"} added`);
  else if (difference < 0) changes.push(`${Math.abs(difference)} point${difference === -1 ? "" : "s"} removed`);
  else if (JSON.stringify(previous.poiPoints) !== JSON.stringify(next.poiPoints)) changes.push("points of interest adjusted");
  return changes.length ? changes.join("; ") : "work-area geometry reviewed without a coordinate change";
}
