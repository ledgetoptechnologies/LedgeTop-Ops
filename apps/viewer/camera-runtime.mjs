const MAX_PHOTO_KEY_BYTES = 1024;

function finiteTriplet(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const triplet = value.slice(0, 3);
  return triplet.every((item) => typeof item === 'number' && Number.isFinite(item)) ? triplet : null;
}

// Photo keys are capability-scoped lookup keys, not filesystem paths. Nested
// paths are allowed because some WebODM exports retain an images/ prefix, but
// traversal, absolute paths and ambiguous separators are rejected.
export function normalizeCameraPhotoKey(value) {
  if (typeof value !== 'string' || !value || new TextEncoder().encode(value).byteLength > MAX_PHOTO_KEY_BYTES) return null;
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return null;
  const segments = value.split('/');
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return /\.jpe?g$/i.test(value) ? value : null;
}

function projectedCoordinates(coordinates, latLonToProjected) {
  const point = finiteTriplet(coordinates);
  if (!point) return null;
  const [x, y, altitude] = point;
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90 && typeof latLonToProjected === 'function') {
    const converted = latLonToProjected(y, x);
    const easting = Array.isArray(converted) ? Number(converted[0]) : Number(converted?.e);
    const northing = Array.isArray(converted) ? Number(converted[1]) : Number(converted?.n);
    return Number.isFinite(easting) && Number.isFinite(northing) ? [easting, northing, altitude] : null;
  }
  return point;
}

export function normalizeCameraFeature(feature, { latLonToProjected } = {}) {
  if (!feature || feature.type !== 'Feature' || typeof feature !== 'object') return null;
  const properties = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const translation = finiteTriplet(properties.translation)
    || (feature.geometry?.type === 'Point'
      ? projectedCoordinates(feature.geometry.coordinates, latLonToProjected)
      : null);
  if (!translation) return null;

  return {
    ...feature,
    properties: {
      ...properties,
      translation,
      rotation: finiteTriplet(properties.rotation) || [0, 0, 0],
      photoKey: normalizeCameraPhotoKey(properties.filename),
    },
  };
}

export function normalizeCameraFeatureCollection(document, options = {}) {
  if (!document || document.type !== 'FeatureCollection' || !Array.isArray(document.features)) return [];
  const normalized = [];
  for (const feature of document.features) {
    const value = normalizeCameraFeature(feature, options);
    if (value) normalized.push(value);
  }
  return normalized;
}

export function cameraFeatureMapPosition(feature, { projectedToLatLon } = {}) {
  const coordinates = feature?.geometry?.type === 'Point'
    ? finiteTriplet(feature.geometry.coordinates)
    : null;
  if (coordinates && Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 90) {
    return [coordinates[1], coordinates[0]];
  }
  const translation = finiteTriplet(feature?.properties?.translation);
  if (!translation || typeof projectedToLatLon !== 'function') return null;
  const converted = projectedToLatLon(translation[0], translation[1]);
  const latitude = Array.isArray(converted) ? Number(converted[0]) : Number(converted?.lat);
  const longitude = Array.isArray(converted) ? Number(converted[1]) : Number(converted?.lon ?? converted?.lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? [latitude, longitude]
    : null;
}

export function cameraFeatureImageUpBearing(feature) {
  const rotation = finiteTriplet(feature?.properties?.rotation);
  if (!rotation) return 0;
  const angle = Math.hypot(rotation[0], rotation[1], rotation[2]);
  if (angle <= 1e-12) return 180;
  // The 3D viewers apply the inverse WebODM angle-axis vector. Apply that
  // same rotation to local -Y: OpenSfM camera +Y is image-down.
  const kx = -rotation[0] / angle;
  const ky = -rotation[1] / angle;
  const kz = -rotation[2] / angle;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const east = kz * sine - kx * ky * (1 - cosine);
  const north = -cosine - ky * ky * (1 - cosine);
  if (Math.hypot(east, north) <= 1e-9) return 0;
  const degrees = Math.atan2(east, north) * 180 / Math.PI;
  return (degrees + 360) % 360;
}

export { MAX_PHOTO_KEY_BYTES };
