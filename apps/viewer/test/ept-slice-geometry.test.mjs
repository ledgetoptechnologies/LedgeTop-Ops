import test from 'node:test';
import assert from 'node:assert/strict';
import { eptSliceBox } from '../ept-slice-geometry.mjs';

const bounds = { min: [600000, 4500000, -20], max: [600100, 4500200, 80] };
const inside = (box, point) => point.every((v, i) => v >= box.min[i] && v <= box.max[i]);

for (const [axis, index] of [['easting', 0], ['northing', 1], ['elevation', 2]]) {
  test(`${axis} uses projected XYZ and preserves the intended side`, () => {
    for (const flipped of [false, true]) {
      const box = eptSliceBox(bounds, { axis, fraction: 0.25, flipped });
      assert.equal(box.cut, bounds.min[index] + (bounds.max[index] - bounds.min[index]) * 0.25);
      const point = box.center.slice();
      point[index] = box.cut + (flipped ? -1 : 1); assert.equal(inside(box, point), true);
      point[index] = box.cut + (flipped ? 1 : -1); assert.equal(inside(box, point), false);
      point[index] = box.cut; assert.equal(inside(box, point), true);
      assert.equal(flipped ? box.max[index] : box.min[index], box.cut);
    }
  });
}

test('endpoints, clamped positions and flat extents remain finite without extending the cut', () => {
  const flat = { min: [600000, 4500000, 10], max: [600000, 4500100, 10] };
  for (const fraction of [-1, 0, 1, 2]) for (const flipped of [false, true]) {
    const box = eptSliceBox(flat, { axis: 'elevation', fraction, flipped });
    assert.equal(box.cut, 10); assert.ok(box.size.every(v => Number.isFinite(v) && v > 0));
    assert.equal(flipped ? box.max[2] : box.min[2], 10);
  }
});

test('invalid extents and settings fail closed', () => {
  for (const input of [null, { min: [0, 1, 2], max: [0, 0, 2] }, { min: [0, 0, NaN], max: [1, 1, 1] }])
    assert.throws(() => eptSliceBox(input));
  assert.throws(() => eptSliceBox(bounds, { axis: 'x' }));
  assert.throws(() => eptSliceBox(bounds, { fraction: Infinity }));
  assert.throws(() => eptSliceBox(bounds, { flipped: 'false' }));
});
