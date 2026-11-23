import assert from 'node:assert/strict';
import test from 'node:test';
import { elevationForDisplay, elevationToMetres, formatDms, formatUtm, parseCoordinateInput, projectUtmZone } from '../viewer-mark-coordinates.mjs';
import { createUtmProjection } from '../utm-conversion.mjs';

const georef = { epsg: 32616, utmZoneLon0Deg: -87, hemisphere: 'N' };
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} vs ${expected}`);

test('decimal degrees in common spellings', () => {
  for (const text of ['43.0535, -87.9028', '43.0535 -87.9028', '43.0535N 87.9028W', 'N43.0535 W87.9028', '87.9028W, 43.0535N', '43.0535° N, 87.9028° W']) {
    const parsed = parseCoordinateInput(text);
    assert.equal(parsed.ok, true, text);
    assert.equal(parsed.format, 'DD', text);
    near(parsed.latitude, 43.0535);
    near(parsed.longitude, -87.9028);
  }
});

test('degrees minutes seconds and degrees decimal minutes', () => {
  const expectedLat = 43 + 3 / 60 + 12.5 / 3600, expectedLon = -(87 + 54 / 60 + 10 / 3600);
  for (const text of [`43°03'12.5"N 87°54'10"W`, '43 3 12.5 N 87 54 10 W', '43 3 12.5, -87 54 10', 'N 43 03 12.5 W 87 54 10', '43 3 12.5 -87 54 10']) {
    const parsed = parseCoordinateInput(text);
    assert.equal(parsed.ok, true, text);
    assert.equal(parsed.format, 'DMS', text);
    near(parsed.latitude, expectedLat);
    near(parsed.longitude, expectedLon);
  }
  const ddm = parseCoordinateInput(`43°3.5'N 87°54.25'W`);
  near(ddm.latitude, 43 + 3.5 / 60);
  near(ddm.longitude, -(87 + 54.25 / 60));
  assert.equal(formatDms(43 + 3 / 60 + 12.5 / 3600, -(87 + 54 / 60 + 10 / 3600)), `43°03'12.50"N 87°54'10.00"W`);
});

test('UTM uses the project zone unless a zone is typed', () => {
  const [lat, lon] = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' }).utmToLatLon(412345.6, 4767890.1);
  for (const text of ['412345.6 4767890.1', '412345.6mE 4767890.1mN', 'E 412345.6 N 4767890.1', '16T 412345.6 4767890.1', '16 412345.6, 4767890.1']) {
    const parsed = parseCoordinateInput(text, { georef });
    assert.equal(parsed.ok, true, text);
    assert.equal(parsed.format, 'UTM', text);
    near(parsed.latitude, lat);
    near(parsed.longitude, lon);
  }
  const other = parseCoordinateInput('15T 500000 4767000', { georef });
  near(other.longitude, -93, 1e-6);
  const south = parseCoordinateInput('33H 500000 6200000', { georef });
  assert.ok(south.latitude < 0, 'band letters C-M are southern');
  assert.equal(parseCoordinateInput('412345 4767890').ok, false, 'no zone anywhere');
  assert.match(formatUtm(lat, lon, georef), /^16N 412345\.60 E 4767890\.10 N$/);
  assert.deepEqual(projectUtmZone(georef), { zone: 16, hemisphere: 'N' });
});

test('bad input explains itself', () => {
  for (const text of ['', '91, 10', '10, 181', '43 61 0 N 87 0 0 W', 'hello', '43N 44N', '43.5 3 0 N 87 0 0 W', 'N43 -87 W']) {
    const parsed = parseCoordinateInput(text, { georef });
    assert.equal(parsed.ok, false, text);
    assert.equal(typeof parsed.error, 'string');
  }
});

test('NAVD88 elevation converts between display units and stored metres', () => {
  near(elevationToMetres('820.21', 'imperial'), 250.0, 1e-3);
  assert.equal(elevationToMetres('250', 'metric'), 250);
  assert.equal(elevationToMetres('', 'metric'), null);
  assert.ok(Number.isNaN(elevationToMetres('abc', 'metric')));
  assert.equal(elevationForDisplay(250, 'imperial'), '820.21');
  assert.equal(elevationForDisplay(null, 'metric'), '');
});
