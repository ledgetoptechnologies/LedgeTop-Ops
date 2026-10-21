import { decodeEptLazNode, readLasPointCount } from './ept-lazrs-decoder.mjs';

const BUFFER_KEYS = [
  'position',
  'color',
  'intensity',
  'classification',
  'returnNumber',
  'numberOfReturns',
  'pointSourceId',
  'gpsTime',
  'indices',
];

self.onmessage = async (event) => {
  try {
    const { compressed, nodemin } = event.data || {};
    if (!(compressed instanceof ArrayBuffer) || compressed.byteLength < 227
      || compressed.byteLength > 256 * 1024 * 1024) {
      throw new Error('EPT LAZ node exceeds the decoder contract');
    }
    const headerPointCount = readLasPointCount(compressed);
    if (headerPointCount > 10_000_000) throw new Error('EPT LAZ node exceeds the point-count limit');
    const decoded = await decodeEptLazNode(compressed, nodemin);
    if (decoded.pointCount !== headerPointCount) throw new Error('EPT point count changed during decode');
    const transferables = BUFFER_KEYS.map((key) => decoded[key]);
    postMessage(decoded, transferables);
  } catch {
    // Potree owns the worker and surfaces its error through the point-cloud
    // readiness watchdog. Keep the worker error fixed and identifier-free.
    throw new Error('EPT LAZ-RS decode failed');
  }
};
