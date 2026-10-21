(function exposePointCloudElevation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudElevation = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function pointCloudElevationFactory() {
  'use strict';
  function validRange(min, max) {
    return typeof min === 'number' && typeof max === 'number'
      && Number.isFinite(min) && Number.isFinite(max) && max - min >= 1e-6
      && Number.isFinite(Math.fround(min)) && Number.isFinite(Math.fround(max))
      && Number.isFinite(Math.fround(max - min)) && Math.fround(max) > Math.fround(min);
  }
  function automaticRange(bounds) {
    const min = bounds?.min?.z, max = bounds?.max?.z;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
    // Flat clouds still need a nonzero shader denominator.
    if (validRange(min, max)) return { min, max };
    const padding = Math.max(0.5, Math.abs(min) * 1e-6, Math.abs(max) * 1e-6);
    return validRange(min - padding, max + padding) ? { min: min - padding, max: max + padding } : null;
  }
  function createElevationRangeController({ getBounds, getMaterials }) {
    let bounds = null, manual = null;
    function apply() {
      const range = manual || bounds;
      if (!range) return;
      for (const material of getMaterials()) {
        // Verified against bundled Potree 1.8.2: the paired setter updates
        // elevationRange uniforms atomically and notifies the renderer.
        // This changes color mapping only, never filtering/clipping.
        material.elevationRange = [range.min, range.max];
      }
    }
    function state() {
      const range = manual || bounds;
      return { available: Boolean(bounds), automatic: !manual,
        bounds: bounds ? { ...bounds } : null, range: range ? { ...range } : null };
    }
    return Object.freeze({
      refresh() { bounds = automaticRange(getBounds()); apply(); return state(); },
      state,
      setRange(min, max) {
        if (!validRange(min, max)) return false;
        manual = { min, max }; apply(); return true;
      },
      reset() { manual = null; bounds = automaticRange(getBounds()); apply(); return state(); },
    });
  }
  return Object.freeze({ validRange, automaticRange, createElevationRangeController });
}));
