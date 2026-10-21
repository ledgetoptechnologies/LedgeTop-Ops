import test from 'node:test';
import assert from 'node:assert/strict';
import { countyReference, countyReferenceRequest, compareCountyResult } from '../scripts/validate-county-stockpile-reference.mjs';

test('County reference preserves exact polygon and source identity without declaring unknown units', () => {
  assert.equal(countyReference.expectedAbsoluteNetVolumeM3, 5647.0534);
  assert.equal(countyReference.ringLonLat.length, 13);
  assert.deepEqual(countyReference.ringLonLat[0], countyReference.ringLonLat.at(-1));
  const map = countyReferenceRequest(), spatial = countyReferenceRequest('spatial3d');
  assert.equal(map.vertices.length, 12);
  assert.deepEqual(map.vertices, spatial.vertices);
  assert.equal(map.source.sha256.length, 64);
  assert.equal(map.sourceVerticalUnit, undefined, 'validation must exercise evidence policy, not bypass it');
  for (const [e, n] of map.vertices) {
    assert.ok(e > 406000 && e < 407000);
    assert.ok(n > 4905000 && n < 4906000);
  }
});

test('reference comparison reports a difference and does not invent an acceptance tolerance', () => {
  const actual = { netM3: -5647.0534, cutM3: 10000 };
  assert.equal(compareCountyResult(actual).differenceM3, 0);
  assert.equal(compareCountyResult(actual).numericalAgreement, 'not-evaluated-no-tolerance-specified');
  assert.equal(compareCountyResult(actual, 0).numericalAgreement, 'within-tolerance');
  assert.equal(compareCountyResult({ netM3: 5648.0534 }, .5).numericalAgreement, 'outside-tolerance');
  assert.throws(() => compareCountyResult(actual, NaN));
  assert.throws(() => compareCountyResult({ netM3: Infinity }));
});
