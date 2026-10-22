export function closeZoomDistanceForDiameter(diameter, { cameraNear = 0.05 } = {}) {
  const near = Number(cameraNear);
  const nearFloor = Number.isFinite(near) && near > 0 ? near * 1.5 : 0.075;
  const hardFloor = Math.max(0.08, nearFloor);
  const value = Number(diameter);
  if (!Number.isFinite(value) || value <= 0) return Math.max(hardFloor, 0.08);
  // Scale with the asset while remaining close enough for facade inspection.
  // The upper bound is below the previous fixed 0.4 m limit; the lower bound
  // stays beyond the camera near plane to avoid clipping and inverted dollies.
  return Math.min(0.25, Math.max(hardFloor, value * 0.0001));
}
