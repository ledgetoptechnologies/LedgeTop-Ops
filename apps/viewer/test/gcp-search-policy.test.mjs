import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_GCP_SEARCH_MODE, DEFAULT_GCP_RADIUS_M, MAX_GCP_RADIUS_M,
  gcpRadiusMeters, gcpRadiusValue, gcpRadiusLabel, formatGcpDistance } from '../server/gcpSearchPolicy.mjs';

test('GCP suggestions default to a fixed 50-foot radius, also expressed exactly in metres', () => {
  assert.equal(DEFAULT_GCP_SEARCH_MODE, 'radius');
  assert.equal(DEFAULT_GCP_RADIUS_M, 15.24);
  assert.equal(gcpRadiusValue(DEFAULT_GCP_RADIUS_M, 'imperial'), 50);
  assert.equal(gcpRadiusValue(DEFAULT_GCP_RADIUS_M, 'metric'), 15.24);
  assert.equal(gcpRadiusMeters('50', 'imperial'), DEFAULT_GCP_RADIUS_M);
  assert.equal(gcpRadiusMeters('15.24', 'metric'), DEFAULT_GCP_RADIUS_M);
  assert.equal(gcpRadiusLabel('imperial'), 'Radius (feet)');
  assert.equal(gcpRadiusLabel('metric'), 'Radius (metres)');
});

test('custom radius keeps SI authority through imperial and metric display changes', () => {
  const customM = gcpRadiusMeters('125', 'imperial');
  assert.equal(customM, 38.1);
  assert.equal(gcpRadiusValue(customM, 'metric'), 38.1);
  assert.equal(gcpRadiusValue(customM, 'imperial'), 125);
  assert.equal(formatGcpDistance(DEFAULT_GCP_RADIUS_M, 'imperial'), '50.0 ft');
  assert.equal(formatGcpDistance(DEFAULT_GCP_RADIUS_M, 'metric'), '15.2 m');
  assert.equal(formatGcpDistance(null, 'imperial'), 'Distance unavailable');
});

test('invalid and oversized radius values reject instead of changing search scope', () => {
  for (const value of ['', ' ', '0', '-1', 'Infinity', 'NaN', null, true, {}, MAX_GCP_RADIUS_M + 1])
    assert.throws(() => gcpRadiusMeters(value, 'metric'), RangeError);
  assert.throws(() => gcpRadiusMeters('50', 'unknown'), RangeError);
  assert.ok(Math.abs(gcpRadiusMeters('0.1', 'imperial') - 0.03048) < 1e-12);
  assert.equal(gcpRadiusValue(MAX_GCP_RADIUS_M, 'metric'), MAX_GCP_RADIUS_M);
});
