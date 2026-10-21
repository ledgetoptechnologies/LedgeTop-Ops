(function pointCloudMeasurementsModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudMeasurements = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function pointCloudMeasurementsFactory() {
  'use strict';

  const METERS_TO_INCHES = 39.37007874015748;

  function formatImperialLength(meters) {
    const totalInches = Number(meters) * METERS_TO_INCHES;
    if (!Number.isFinite(totalInches)) return 'Unavailable';
    const sign = totalInches < 0 ? '-' : '';
    const absolute = Math.abs(totalInches);
    let feet = Math.floor(absolute / 12);
    let inches = Math.round((absolute - feet * 12) * 1000) / 1000;
    if (inches >= 12) {
      feet += 1;
      inches = 0;
    }
    return `${sign}${feet}' ${inches.toFixed(3)}"`;
  }

  function installPotreeMeasurementPrecision(Potree, { displayUnits = 'ft' } = {}) {
    const prototype = Potree?.Measure?.prototype;
    if (displayUnits !== 'ft' || !prototype || typeof prototype.update !== 'function'
      || prototype.__ltdsThousandthInchPrecision) return false;
    const originalUpdate = prototype.update;
    Object.defineProperty(prototype, '__ltdsThousandthInchPrecision', { value: true });
    prototype.update = function updateWithThousandthInchPrecision(...args) {
      const result = originalUpdate.apply(this, args);
      const points = Array.isArray(this.points) ? this.points : [];
      const labels = Array.isArray(this.edgeLabels) ? this.edgeLabels : [];
      for (let index = 0; index < labels.length; index += 1) {
        const nextIndex = index + 1 < points.length ? index + 1 : (this.closed ? 0 : -1);
        const current = points[index]?.position;
        const next = nextIndex >= 0 ? points[nextIndex]?.position : null;
        if (!current || !next || typeof current.distanceTo !== 'function') continue;
        const distance = current.distanceTo(next);
        if (Number.isFinite(distance) && distance >= 0) labels[index]?.setText?.(formatImperialLength(distance));
      }
      if (this.showHeight && this.heightLabel && points.length >= 2) {
        const elevations = points.map(point => Number(point?.position?.z)).filter(Number.isFinite);
        if (elevations.length >= 2) {
          this.heightLabel.setText?.(formatImperialLength(Math.max(...elevations) - Math.min(...elevations)));
        }
      }
      return result;
    };
    return true;
  }

  return { formatImperialLength, installPotreeMeasurementPrecision };
}));
