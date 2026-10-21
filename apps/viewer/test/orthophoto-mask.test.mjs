import test from 'node:test';
import assert from 'node:assert/strict';
import { isRgbNoData, maskedRgbBilinear, parseFiniteGdalNoData } from '../orthophoto-mask.mjs';

test('GDAL nodata is enabled only by a complete finite metadata value', () => {
  assert.equal(parseFiniteGdalNoData('0\0'), 0);
  assert.equal(parseFiniteGdalNoData('-9999'), -9999);
  for (const value of [undefined, null, '', 'NaN', '0 trailing', Infinity]) {
    assert.equal(Number.isNaN(parseFiniteGdalNoData(value)), true, String(value));
  }
  assert.equal(isRgbNoData(0, 0, 0, Number.NaN), false, 'generic black is not inferred as nodata');
  assert.equal(isRgbNoData(0, 0, 0, 0), true);
  assert.equal(isRgbNoData(0, 1, 0, 0), false);
});

test('warped RGB sampling masks only authoritative nodata neighbors and renormalizes color', () => {
  const r = Uint8Array.from([0, 100, 100, 100]);
  const g = Uint8Array.from([0, 50, 50, 50]);
  const b = Uint8Array.from([0, 25, 25, 25]);
  const masked = maskedRgbBilinear(r, g, b, [0, 1, 2, 3], [0.25, 0.25, 0.25, 0.25], 0);
  assert.deepEqual(masked, { r: 100, g: 50, b: 25, a: 191 });
  const unmasked = maskedRgbBilinear(r, g, b, [0, 1, 2, 3], [0.25, 0.25, 0.25, 0.25], Number.NaN);
  assert.deepEqual(unmasked, { r: 75, g: 37.5, b: 18.75, a: 255 });
});
