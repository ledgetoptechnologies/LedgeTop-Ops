export const MARK_GEOMETRY_MAX_VERTICES = 500;

const round = value => Math.round(value * 1e8) / 1e8;

function position(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return null;
  const [lon, lat] = value;
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;
  // Heights live in elevationNavd88M; a third GeoJSON value is never trusted as one.
  return [round(lon), round(lat)];
}

export function validateGeometry(geometry) {
  if ((!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) || Object.keys(geometry).some(key => !['type', 'coordinates'].includes(key))) return null;
  const { type, coordinates } = geometry;
  if (type === 'Point') {
    const point = position(coordinates);
    return point && { type, coordinates: point };
  }
  if (type === 'LineString') {
    if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > MARK_GEOMETRY_MAX_VERTICES) return null;
    const line = coordinates.map(position);
    return line.every(Boolean) ? { type, coordinates: line } : null;
  }
  if (type === 'Polygon') {
    // One outer ring. Holes are not part of the markup tool.
    if (!Array.isArray(coordinates) || coordinates.length !== 1 || !Array.isArray(coordinates[0])) return null;
    const ring = coordinates[0].map(position);
    if (!ring.every(Boolean)) return null;
    const [first] = ring, last = ring[ring.length - 1];
    if (ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring.pop();
    if (ring.length < 3 || ring.length > MARK_GEOMETRY_MAX_VERTICES) return null;
    return { type, coordinates: [[...ring, [...ring[0]]]] };
  }
  return null;
}
