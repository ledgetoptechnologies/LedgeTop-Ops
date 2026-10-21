import assert from 'node:assert/strict';
import test from 'node:test';
import { integrateElevationVolume, pointInPolygon } from '../map-volume.mjs';

test('point-in-polygon includes interior points and excludes exterior points', () => {
  const polygon = [[0, 0], [2, 0], [2, 2], [0, 2]];
  assert.equal(pointInPolygon(1, 1, polygon), true);
  assert.equal(pointInPolygon(3, 1, polygon), false);
});

test('volume integration reports cut fill and net against a custom plane', () => {
  const result = integrateElevationVolume({
    values: new Float32Array([12, 8, 11, 9]), width: 2, height: 2,
    bounds: { minE: 0, minN: 0, maxE: 2, maxN: 2 },
    polygon: [[0, 0], [2, 0], [2, 2], [0, 2]], reference: 'custom', customReference: 10,
  });
  assert.equal(result.cutM3, 3);
  assert.equal(result.fillM3, 3);
  assert.equal(result.netM3, 0);
  assert.equal(result.sampleCount, 4);
});

test('lowest and average reference choices are explicit and ignore nodata', () => {
  const common = {
    values: new Float32Array([4, 6, -9999, 10]), width: 2, height: 2,
    bounds: { minE: 0, minN: 0, maxE: 2, maxN: 2 },
    polygon: [[0, 0], [2, 0], [2, 2], [0, 2]], nodata: -9999,
  };
  const lowest = integrateElevationVolume({ ...common, reference: 'lowest' });
  assert.equal(lowest.referenceElevation, 4);
  assert.equal(lowest.cutM3, 8);
  const average = integrateElevationVolume({ ...common, reference: 'average' });
  assert.equal(average.referenceElevation, 20 / 3);
  assert.ok(Math.abs(average.cutM3 - average.fillM3) < 1e-9);
});
