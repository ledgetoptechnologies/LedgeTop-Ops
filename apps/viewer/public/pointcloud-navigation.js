(function pointCloudNavigationModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudNavigation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPointCloudNavigation() {
  const POINT_PICK_WINDOW = 11;
  const NAVIGATION_POLICY = Object.freeze({
    orbitTurnsPerViewport: 0.55,
    wheelBase: 0.9,
    wheelDeltaUnit: 100,
    inertiaDecay: 5.5,
    inertiaStopSpeed: 0.02,
    panMinimumStep: 50,
    panDistanceMultiplier: 2,
    overviewDistanceRatio: 0.75,
    overviewBoundsPaddingRatio: 0.02,
    minZoomDistance: 0.1,
    maxZoomDistance: 100000,
  });

  function positiveFinite(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function orbitRadiansForPixels(pixelDelta, viewportHeight, gainScale = 1) {
    const delta = Number(pixelDelta);
    if (!Number.isFinite(delta)) return 0;
    const height = positiveFinite(viewportHeight, 800);
    const gain = positiveFinite(gainScale, 1);
    return -(delta / height) * Math.PI * 2 * NAVIGATION_POLICY.orbitTurnsPerViewport * gain;
  }

  function wheelZoomScale(deltaY) {
    const delta = Number(deltaY);
    if (!Number.isFinite(delta)) return 1;
    return Math.pow(NAVIGATION_POLICY.wheelBase, -delta / NAVIGATION_POLICY.wheelDeltaUnit);
  }

  function worldUnitsPerPixel(distance, fovDegrees, viewportHeight) {
    const depth = positiveFinite(distance, 0);
    const fov = positiveFinite(fovDegrees, 60);
    const height = positiveFinite(viewportHeight, 800);
    if (depth <= 0) return 0;
    return 2 * depth * Math.tan(fov * Math.PI / 360) / height;
  }

  function maxPanStep(referenceDistance) {
    const distance = Math.max(0, Number(referenceDistance) || 0);
    return Math.max(
      NAVIGATION_POLICY.panMinimumStep,
      distance * NAVIGATION_POLICY.panDistanceMultiplier,
    );
  }

  function clampZoomDistance(distance) {
    const parsed = Number(distance);
    if (!Number.isFinite(parsed)) return NAVIGATION_POLICY.minZoomDistance;
    return Math.max(
      NAVIGATION_POLICY.minZoomDistance,
      Math.min(NAVIGATION_POLICY.maxZoomDistance, parsed),
    );
  }

  function radiusAfterDolly(radius, displacementAlongView) {
    // Potree derives its target from position + direction * radius. Preserve
    // the focal plane as position moves, including an off-center wheel ray.
    const previous = positiveFinite(radius, NAVIGATION_POLICY.minZoomDistance);
    const displacement = Number(displacementAlongView);
    return clampZoomDistance(previous - (Number.isFinite(displacement) ? displacement : 0));
  }

  function isPlausibleAnchorDistance(hitDistance, referenceDistance) {
    if (!Number.isFinite(hitDistance) || !Number.isFinite(referenceDistance)
      || hitDistance < 0 || referenceDistance <= 0) return false;
    const behindAllowance = Math.max(5, referenceDistance * 0.35);
    return hitDistance <= referenceDistance + behindAllowance;
  }

  function finitePoint(value) {
    return value && [value.x, value.y, value.z].every(Number.isFinite);
  }

  function canUseOverviewAnchor({ point, bounds, referenceDistance, cloudDiameter } = {}) {
    if (!finitePoint(point) || !finitePoint(bounds?.min) || !finitePoint(bounds?.max)) return false;
    const distance = Number(referenceDistance);
    const diameter = Number(cloudDiameter);
    if (!Number.isFinite(distance) || !Number.isFinite(diameter) || distance <= 0 || diameter <= 0
      || distance < diameter * NAVIGATION_POLICY.overviewDistanceRatio) return false;
    const padding = diameter * NAVIGATION_POLICY.overviewBoundsPaddingRatio;
    return point.x >= Math.min(bounds.min.x, bounds.max.x) - padding
      && point.x <= Math.max(bounds.min.x, bounds.max.x) + padding
      && point.y >= Math.min(bounds.min.y, bounds.max.y) - padding
      && point.y <= Math.max(bounds.min.y, bounds.max.y) + padding
      && point.z >= Math.min(bounds.min.z, bounds.max.z) - padding
      && point.z <= Math.max(bounds.min.z, bounds.max.z) + padding;
  }

  return Object.freeze({
    POINT_PICK_WINDOW,
    NAVIGATION_POLICY,
    orbitRadiansForPixels,
    wheelZoomScale,
    worldUnitsPerPixel,
    maxPanStep,
    clampZoomDistance,
    radiusAfterDolly,
    isPlausibleAnchorDistance,
    canUseOverviewAnchor,
  });
}));
