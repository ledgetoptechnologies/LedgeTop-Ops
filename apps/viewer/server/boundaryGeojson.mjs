// ODM's `boundary` option takes GeoJSON text in WGS84 lon/lat; WebODM sends a
// FeatureCollection holding one Polygon feature, which is the shape accepted
// here. The polygon must be a small, simple, closed ring: it is rejected,
// never repaired, so a malformed boundary cannot crop away a survey.
export const BOUNDARY_MAX_VERTICES = 200;
export const BOUNDARY_MAX_SPAN_DEGREES = 1;

const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
const within = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
// Any shared point, including touching endpoints and collinear overlap.
function segmentsMeet(a, b, c, d) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (o1 === 0 && within(a, b, c)) || (o2 === 0 && within(a, b, d)) || (o3 === 0 && within(c, d, a)) || (o4 === 0 && within(c, d, b));
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
  const corners = ring.slice(0, -1), edges = corners.length;
  if (new Set(corners.map(point => `${point[0]},${point[1]}`)).size !== edges) return 'Boundary corners must not repeat.';
  // Neighbouring edges may continue straight on, but must not fold back
  // over each other.
  for (let i = 0; i < edges; i++) {
    const before = corners[(i + edges - 1) % edges], at = corners[i], after = corners[(i + 1) % edges];
    if (orient(before, at, after) === 0 && (before[0] - at[0]) * (after[0] - at[0]) + (before[1] - at[1]) * (after[1] - at[1]) > 0) return 'Boundary edges must not overlap.';
  }
  // Non-neighbouring edges must not cross, touch or overlap.
  for (let i = 0; i < edges; i++) for (let j = i + 2; j < edges; j++) {
    if (i === 0 && j === edges - 1) continue;
    if (segmentsMeet(corners[i], corners[(i + 1) % edges], corners[j], corners[(j + 1) % edges])) return 'Boundary edges must not cross or touch.';
  }
  return null;
}
