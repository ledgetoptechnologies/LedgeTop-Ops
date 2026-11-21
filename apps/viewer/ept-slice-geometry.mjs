// Geometry only: coordinates are Potree's projected X=easting, Y=northing,
// Z=elevation. This does not install a clip volume or establish GPU precision.
const AXIS = Object.freeze({ easting: 0, northing: 1, elevation: 2 });

export function eptSliceBox(bounds, { axis = 'elevation', fraction = 0.5, flipped = false } = {}) {
  const index = AXIS[axis], min = bounds?.min, max = bounds?.max;
  if (index === undefined || typeof flipped !== 'boolean' || !Number.isFinite(fraction)
    || !Array.isArray(min) || !Array.isArray(max) || min.length !== 3 || max.length !== 3
    || !min.every(Number.isFinite) || !max.every(Number.isFinite)
    || min.some((v, i) => v > max[i])) throw new Error('A finite EPT extent and slice position are required.');
  const spans = min.map((v, i) => max[i] - v);
  if (!spans.every(Number.isFinite)) throw new Error('EPT extent is too large.');
  const cut = min[index] + spans[index] * Math.max(0, Math.min(1, fraction));
  // Padding applies only to the outer dataset edges, never across the cut.
  // It keeps zero-width bounds and end positions representable as a box.
  const padding = min.map((v, i) => Math.max(1e-6, spans[i] * 1e-9,
    Math.max(Math.abs(v), Math.abs(max[i]), 1) * Number.EPSILON * 32));
  const lower = min.map((v, i) => v - padding[i]);
  const upper = max.map((v, i) => v + padding[i]);
  if (flipped) upper[index] = cut; else lower[index] = cut;
  const size = lower.map((v, i) => upper[i] - v);
  const center = lower.map((v, i) => v + size[i] / 2);
  if (!Number.isFinite(cut) || !size.every(v => Number.isFinite(v) && v > 0)
    || !center.every(Number.isFinite)) throw new Error('EPT slice box cannot be represented.');
  return { axis, fraction: Math.max(0, Math.min(1, fraction)), flipped, cut, min: lower, max: upper, center, size };
}
