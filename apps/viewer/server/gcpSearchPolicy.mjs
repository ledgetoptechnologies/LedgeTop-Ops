export const DEFAULT_GCP_SEARCH_MODE = 'radius';
export const DEFAULT_GCP_RADIUS_M = 15.24; // 50 international feet, exactly.
export const MAX_GCP_RADIUS_M = 100000;

function scale(units) {
  if (units === 'imperial') return 0.3048;
  if (units === 'metric') return 1;
  throw new RangeError('Unsupported GCP distance units.');
}

export function gcpRadiusValue(radiusM, units = 'imperial') {
  if (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > MAX_GCP_RADIUS_M)
    throw new RangeError('Invalid GCP search radius.');
  return Number((radiusM / scale(units)).toFixed(6));
}

export function gcpRadiusMeters(value, units = 'imperial') {
  if (!['string', 'number'].includes(typeof value) || typeof value === 'string' && !value.trim())
    throw new RangeError('Enter a positive GCP search radius.');
  const radius = Number(value) * scale(units);
  if (!Number.isFinite(radius) || radius <= 0 || radius > MAX_GCP_RADIUS_M)
    throw new RangeError('GCP search radius must be positive and no more than 100,000 metres.');
  return radius;
}

export function gcpRadiusLabel(units = 'imperial') {
  scale(units);
  return units === 'imperial' ? 'Radius (feet)' : 'Radius (metres)';
}

export function formatGcpDistance(distanceM, units = 'imperial') {
  if (!Number.isFinite(distanceM) || distanceM < 0) return 'Distance unavailable';
  const distance = distanceM / scale(units);
  return `${distance.toFixed(distance < 100 ? 1 : 0)} ${units === 'imperial' ? 'ft' : 'm'}`;
}
