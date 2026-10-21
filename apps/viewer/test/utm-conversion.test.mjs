import assert from 'node:assert/strict';
import test from 'node:test';

import { createUtmProjection, normalizeUtmHemisphere } from '../utm-conversion.mjs';

test('southern UTM projection adds and removes false northing numerically', () => {
  const projection = createUtmProjection({ zoneLon0Deg: 153, hemisphere: 'S' });
  const [easting, northing] = projection.latLonToUtm(-33.8688, 151.2093);

  // EPSG:32756 reference for central Sydney (metre-level tolerance covers
  // the series approximation without weakening the hemisphere assertion).
  assert.ok(Math.abs(easting - 334368.63) < 1, `unexpected easting ${easting}`);
  assert.ok(Math.abs(northing - 6250948.35) < 1, `unexpected northing ${northing}`);
  assert.ok(northing > 6_000_000, 'southern coordinate includes UTM false northing');

  const [latitude, longitude] = projection.utmToLatLon(easting, northing);
  assert.ok(Math.abs(latitude - (-33.8688)) < 1e-7, `unexpected latitude ${latitude}`);
  assert.ok(Math.abs(longitude - 151.2093) < 1e-7, `unexpected longitude ${longitude}`);
});

test('hemisphere is explicit and northern behavior remains unchanged', () => {
  const north = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
  const south = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'south' });
  const [, northernEquator] = north.latLonToUtm(0, -87);
  const [, southernEquator] = south.latLonToUtm(0, -87);
  assert.ok(Math.abs(northernEquator) < 1e-8);
  assert.ok(Math.abs(southernEquator - 10_000_000) < 1e-8);
  assert.equal(normalizeUtmHemisphere('s'), 'S');
  assert.equal(normalizeUtmHemisphere(undefined), 'N');
});
