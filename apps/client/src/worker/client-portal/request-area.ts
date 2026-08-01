export interface RequestArea {
  type: "Polygon";
  coordinates: [number, number][][];
}

const MAX_AREA_BYTES = 12 * 1024;
const MAX_VERTICES = 64;
const MAX_SPAN_DEGREES = 20;

function samePoint(left: [number, number], right: [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: [number, number], b: [number, number], point: [number, number]): boolean {
  return Math.min(a[0], b[0]) <= point[0] && point[0] <= Math.max(a[0], b[0])
    && Math.min(a[1], b[1]) <= point[1] && point[1] <= Math.max(a[1], b[1]);
}

function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))) return true;
  return (abC === 0 && onSegment(a, b, c)) || (abD === 0 && onSegment(a, b, d))
    || (cdA === 0 && onSegment(c, d, a)) || (cdB === 0 && onSegment(c, d, b));
}

function polygonArea(points: [number, number][]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const point = points[index]!;
    const next = points[index + 1]!;
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  return Math.abs(twiceArea) / 2;
}

/**
 * Accept only a deliberately small, single-ring GeoJSON polygon. This keeps
 * client-provided geometry useful for scoping without turning the request
 * endpoint into general-purpose GIS storage.
 */
export function validateRequestArea(value: unknown): RequestArea | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid area");
  const candidate = value as { type?: unknown; coordinates?: unknown };
  if (candidate.type !== "Polygon" || !Array.isArray(candidate.coordinates) || candidate.coordinates.length !== 1) throw new Error("invalid area");
  const ring = candidate.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > MAX_VERTICES + 1) throw new Error("invalid area");

  const points: [number, number][] = ring.map(point => {
    if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) throw new Error("invalid area");
    const longitude = Number(point[0]);
    const latitude = Number(point[1]);
    if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) throw new Error("invalid area");
    return [longitude, latitude];
  });
  if (!samePoint(points[0]!, points.at(-1)!)) throw new Error("invalid area");

  const vertices = points.slice(0, -1);
  const longitudes = vertices.map(point => point[0]);
  const latitudes = vertices.map(point => point[1]);
  if (Math.max(...longitudes) - Math.min(...longitudes) > MAX_SPAN_DEGREES || Math.max(...latitudes) - Math.min(...latitudes) > MAX_SPAN_DEGREES || polygonArea(points) <= 0.00000001) throw new Error("invalid area");
  for (let left = 0; left < vertices.length; left += 1) {
    const nextLeft = (left + 1) % vertices.length;
    for (let right = left + 1; right < vertices.length; right += 1) {
      const nextRight = (right + 1) % vertices.length;
      if (left === right || nextLeft === right || nextRight === left) continue;
      if (segmentsIntersect(vertices[left]!, vertices[nextLeft]!, vertices[right]!, vertices[nextRight]!)) throw new Error("invalid area");
    }
  }
  const area: RequestArea = { type: "Polygon", coordinates: [points] };
  if (new TextEncoder().encode(JSON.stringify(area)).byteLength > MAX_AREA_BYTES) throw new Error("invalid area");
  return area;
}
