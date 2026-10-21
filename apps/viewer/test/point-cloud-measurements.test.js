'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  formatImperialLength,
  installPotreeMeasurementPrecision,
} = require('../public/pointcloud-measurements.js');

test('point-cloud imperial distances display thousandths of an inch', () => {
  assert.equal(formatImperialLength(1), `3' 3.370"`);
  assert.equal(formatImperialLength(0.0000254), `0' 0.001"`);
  assert.equal(formatImperialLength(-0.3048), `-1' 0.000"`);
});

test('Potree edge and height labels are rewritten from meter geometry without rounding to whole units', () => {
  class Measure {
    update() { this.originalUpdates = (this.originalUpdates || 0) + 1; }
  }
  const Potree = { Measure };
  assert.equal(installPotreeMeasurementPrecision(Potree, { displayUnits: 'ft' }), true);
  assert.equal(installPotreeMeasurementPrecision(Potree, { displayUnits: 'ft' }), false, 'patch is idempotent');
  const labels = [{ setText(value) { this.value = value; } }, { setText(value) { this.value = value; } }];
  const heightLabel = { setText(value) { this.value = value; } };
  const measure = new Measure();
  measure.points = [
    { position: { x: 0, y: 0, z: 0, distanceTo: () => 1 } },
    { position: { x: 1, y: 0, z: 0, distanceTo: () => 2 } },
  ];
  measure.edgeLabels = labels;
  measure.heightLabel = heightLabel;
  measure.showHeight = true;
  measure.update();
  assert.equal(measure.originalUpdates, 1);
  assert.equal(labels[0].value, `3' 3.370"`);
  assert.equal(heightLabel.value, `0' 0.000"`);
});
