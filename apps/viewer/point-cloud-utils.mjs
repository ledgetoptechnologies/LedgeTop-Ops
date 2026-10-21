const DEFAULT_UTM_PROXIMITY_METERS = 250_000;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * Convert decoded point positions into the viewer's local ODM frame.
 *
 * WebODM's georeferenced LAZ/PLY exports normally contain absolute UTM
 * coordinates, while its mesh/GLB assets are expressed relative to coords.txt's
 * RTC origin. Feeding absolute UTM coordinates into a Float32 WebGL buffer both
 * puts the cloud millions of metres away from the camera and discards local
 * centimetre-scale precision. Some older PLY outputs are already local, so the
 * RTC offset is only applied when the cloud centre is plausibly near that UTM
 * origin.
 */
export function localizePointPositions(source, rtc = {}, options = {}) {
  if (!source || source.length % 3 !== 0) {
    throw new TypeError('Point positions must contain complete XYZ triples');
  }

  const e = finiteNumber(rtc.e);
  const n = finiteNumber(rtc.n);
  const z = finiteNumber(rtc.z);
  const proximity = finiteNumber(options.utmProximityMeters, DEFAULT_UTM_PROXIMITY_METERS);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < source.length; i += 3) {
    const x = finiteNumber(source[i]);
    const y = finiteNumber(source[i + 1]);
    const pointZ = finiteNumber(source[i + 2]);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, pointZ); maxZ = Math.max(maxZ, pointZ);
  }

  const centerX = source.length ? (minX + maxX) / 2 : 0;
  const centerY = source.length ? (minY + maxY) / 2 : 0;
  const hasRtc = Math.abs(e) > 10_000 || Math.abs(n) > 10_000;
  const looksGeoreferenced = hasRtc
    && Math.abs(centerX - e) <= proximity
    && Math.abs(centerY - n) <= proximity;
  const offsetX = looksGeoreferenced ? e : 0;
  const offsetY = looksGeoreferenced ? n : 0;
  const offsetZ = looksGeoreferenced ? z : 0;
  const positions = new Float32Array(source.length);

  for (let i = 0; i < source.length; i += 3) {
    positions[i] = finiteNumber(source[i]) - offsetX;
    positions[i + 1] = finiteNumber(source[i + 1]) - offsetY;
    positions[i + 2] = finiteNumber(source[i + 2]) - offsetZ;
  }

  return {
    positions,
    rebasedFromUtm: looksGeoreferenced,
    sourceBounds: source.length ? {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    } : null,
  };
}

export function hasMeshSource(source) {
  return source === 'tiles' || source === 'glb' || source === 'obj';
}

export function refreshPointGeometryBounds(geometry) {
  if (!geometry
    || typeof geometry.computeBoundingBox !== 'function'
    || typeof geometry.computeBoundingSphere !== 'function') {
    throw new TypeError('Point geometry must support bounding-box and bounding-sphere calculation');
  }
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
