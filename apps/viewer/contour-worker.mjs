// Off-main-thread contour tracing. Input and output buffers are transferred.
import { buildContours } from './contours.mjs';
import { createUtmProjection } from './utm-conversion.mjs';

export function computeContourMessage(data) {
  const features = buildContours(data);
  let projection = null;
  if (data.projection) projection = createUtmProjection(data.projection);
  const out = features.map(f => {
    if (!projection) return f;
    // Leaflet wants [lat, lng]; keep a parallel lat/lng array for the map.
    const ll = new Float64Array(f.coords.length);
    for (let i = 0; i < f.coords.length; i += 2) {
      const [lat, lng] = projection.utmToLatLon(f.coords[i], f.coords[i + 1]);
      ll[i] = lat; ll[i + 1] = lng;
    }
    return { ...f, latLng: ll };
  });
  return out;
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (event) => {
    const { id, ...data } = event.data || {};
    try {
      const features = computeContourMessage(data);
      const transfer = [];
      for (const f of features) { transfer.push(f.coords.buffer); if (f.latLng) transfer.push(f.latLng.buffer); }
      self.postMessage({ id, features }, transfer);
    } catch (error) {
      self.postMessage({ id, error: String(error?.message || error), code: error?.code || null });
    }
  };
}
