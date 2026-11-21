// ODM's `boundary` option takes GeoJSON text in WGS84 lon/lat; WebODM sends a
// FeatureCollection holding one Polygon feature, which is the shape accepted
// here. The polygon must be a small, simple, closed ring: it is rejected,
// never repaired, so a malformed boundary cannot crop away a survey.
export const BOUNDARY_MAX_VERTICES = 200;
export const BOUNDARY_MAX_SPAN_DEGREES = 1;

function segmentsCross(a, b, c, d) {
  const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
}

// Returns null for a valid boundary, otherwise a short reason.
export function boundaryProblem(text) {
  let value;
  try { value = typeof text === 'string' ? JSON.parse(text) : text; } catch { return 'Boundary must be valid JSON.'; }
  if (value?.type !== 'FeatureCollection' || !Array.isArray(value.features) || value.features.length !== 1) return 'Boundary must be a GeoJSON FeatureCollection with one polygon.';
  const geometry = value.features[0]?.type === 'Feature' ? value.features[0].geometry : null;
  if (geometry?.type !== 'Polygon' || !Array.isArray(geometry.coordinates) || geometry.coordinates.length !== 1) return 'Boundary must be a single polygon without holes.';
  const ring = geometry.coordinates[0];
  if (!Array.isArray(ring) || ring.length < 4 || ring.length > BOUNDARY_MAX_VERTICES + 1) return `Boundary needs 3 to ${BOUNDARY_MAX_VERTICES} corners.`;
  if (!ring.every(point => Array.isArray(point) && point.length >= 2 && point.length <= 3 && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 90)) return 'Boundary corners must be longitude/latitude pairs.';
  const first = ring[0], last = ring.at(-1);
  if (first[0] !== last[0] || first[1] !== last[1]) return 'Boundary ring must be closed.';
  const xs = ring.map(point => point[0]), ys = ring.map(point => point[1]);
  if (Math.max(...xs) - Math.min(...xs) > BOUNDARY_MAX_SPAN_DEGREES || Math.max(...ys) - Math.min(...ys) > BOUNDARY_MAX_SPAN_DEGREES) return 'Boundary is larger than a survey area.';
  let area = 0; for (let i = 0; i < ring.length - 1; i++) area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  if (Math.abs(area) < 1e-14) return 'Boundary has no area.';
  const edges = ring.length - 1;
  for (let i = 0; i < edges; i++) for (let j = i + 2; j < edges; j++) {
    if (i === 0 && j === edges - 1) continue;
    if (segmentsCross(ring[i], ring[i + 1], ring[j], ring[j + 1])) return 'Boundary edges must not cross.';
  }
  return null;
}
