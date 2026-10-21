import { LAZRsLoader } from '@loaders.gl/las';

function finiteOrigin(value) {
  if (!Array.isArray(value) || value.length !== 3 || value.some((item) => !Number.isFinite(Number(item)))) {
    throw new Error('EPT node origin is invalid');
  }
  return value.map(Number);
}

function rangeOf(values) {
  if (!values?.length) return [0, 0];
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    minimum = Math.min(minimum, Number(value));
    maximum = Math.max(maximum, Number(value));
  }
  return [minimum, maximum];
}

export function readLasPointCount(compressed) {
  if (!(compressed instanceof ArrayBuffer) || compressed.byteLength < 111) {
    throw new Error('LAS header is incomplete');
  }
  const signature = String.fromCharCode(...new Uint8Array(compressed, 0, 4));
  if (signature !== 'LASF') throw new Error('LAS signature is invalid');
  const view = new DataView(compressed);
  const headerSize = view.getUint16(94, true);
  const legacyCount = view.getUint32(107, true);
  if (headerSize >= 375 && compressed.byteLength >= 255) {
    const extendedCount = view.getBigUint64(247, true);
    if (extendedCount > 0n) {
      if (extendedCount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('LAS point count is unsafe');
      return Number(extendedCount);
    }
  }
  if (legacyCount < 1) throw new Error('LAS point count is missing');
  return legacyCount;
}

export async function decodeEptLazNode(compressed, nodemin) {
  if (!(compressed instanceof ArrayBuffer)) throw new TypeError('EPT node payload must be an ArrayBuffer');
  const origin = finiteOrigin(nodemin);
  const mesh = await LAZRsLoader.parse(compressed, {
    las: { shape: 'mesh', fp64: true, skip: 1, colorDepth: 8 },
  });
  const sourcePositions = mesh?.attributes?.POSITION?.value;
  const pointCount = Number(mesh?.header?.vertexCount);
  if (!sourcePositions || !Number.isSafeInteger(pointCount) || pointCount < 1
    || sourcePositions.length !== pointCount * 3) {
    throw new Error('LAZ-RS returned an invalid EPT point buffer');
  }

  const positions = new Float32Array(pointCount * 3);
  const colors = new Uint8Array(pointCount * 4);
  const intensities = new Float32Array(pointCount);
  const classifications = new Uint8Array(pointCount);
  const returnNumbers = new Uint8Array(pointCount);
  const numberOfReturns = new Uint8Array(pointCount);
  const pointSourceIds = new Uint16Array(pointCount);
  const gpsTime = new Float32Array(pointCount);
  const indices = new Uint32Array(pointCount);
  const sourceColors = mesh.attributes.COLOR_0?.value || null;
  const sourceIntensities = mesh.attributes.intensity?.value || null;
  const sourceClassifications = mesh.attributes.classification?.value || null;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const mean = [0, 0, 0];

  for (let index = 0; index < pointCount; index += 1) {
    indices[index] = index;
    for (let axis = 0; axis < 3; axis += 1) {
      const relative = Number(sourcePositions[index * 3 + axis]) - origin[axis];
      if (!Number.isFinite(relative)) throw new Error('LAZ-RS returned a non-finite EPT coordinate');
      positions[index * 3 + axis] = relative;
      minimum[axis] = Math.min(minimum[axis], relative);
      maximum[axis] = Math.max(maximum[axis], relative);
      mean[axis] += relative / pointCount;
    }
    const colorOffset = index * 4;
    colors[colorOffset] = sourceColors?.[colorOffset] ?? 255;
    colors[colorOffset + 1] = sourceColors?.[colorOffset + 1] ?? 255;
    colors[colorOffset + 2] = sourceColors?.[colorOffset + 2] ?? 255;
    colors[colorOffset + 3] = sourceColors?.[colorOffset + 3] ?? 255;
    intensities[index] = Number(sourceIntensities?.[index] ?? 0);
    classifications[index] = Number(sourceClassifications?.[index] ?? 0);
  }

  return {
    pointCount,
    position: positions.buffer,
    color: colors.buffer,
    intensity: intensities.buffer,
    classification: classifications.buffer,
    returnNumber: returnNumbers.buffer,
    numberOfReturns: numberOfReturns.buffer,
    pointSourceId: pointSourceIds.buffer,
    gpsTime: gpsTime.buffer,
    indices: indices.buffer,
    mean,
    tightBoundingBox: { min: minimum, max: maximum },
    gpsMeta: { offset: 0, range: 0 },
    ranges: {
      intensity: rangeOf(intensities),
      classification: rangeOf(classifications),
      'return number': [0, 0],
      'number of returns': [0, 0],
      'source id': [0, 0],
      'gps-time': [0, 0],
    },
  };
}
