'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseGcpInterchange, confirmationToken } = require('../server/gcpImport');

test('generic CSV GCP interchange normalizes EPSG:4326 coordinates and metric elevations', () => {
  const parsed = parseGcpInterchange({
    format: 'generic-csv-v1',
    content: 'point_id,label,latitude,longitude,elevation_m,description\nGCP-01,"North, target",44.5001,-88.1002,243.84,"painted nail"\n',
  });
  assert.equal(parsed.crs, 'EPSG:4326');
  assert.equal(parsed.elevationUnits, 'm');
  assert.match(parsed.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(parsed.points, [{
    externalId: 'GCP-01', label: 'North, target', latitude: 44.5001,
    longitude: -88.1002, elevationM: 243.84, description: 'painted nail',
  }]);
});

test('generic GeoJSON GCP interchange requires 3D Point features', () => {
  const parsed = parseGcpInterchange({
    format: 'generic-geojson-v1',
    content: JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { point_id: 'A', label: 'Target A' },
        geometry: { type: 'Point', coordinates: [-88.1, 44.5, 250] },
      }],
    }),
  });
  assert.equal(parsed.points[0].longitude, -88.1);
  assert.equal(parsed.points[0].elevationM, 250);
  assert.throws(() => parseGcpInterchange({
    format: 'generic-geojson-v1',
    content: JSON.stringify({ type: 'FeatureCollection', features: [{
      type: 'Feature', properties: { point_id: 'A', label: 'A' },
      geometry: { type: 'Point', coordinates: [-88.1, 44.5] },
    }] }),
  }), /3D Point/);
});

test('generic GCP parser rejects guessed vendor schemas, extra columns, duplicate IDs and invalid ranges', () => {
  assert.throws(() => parseGcpInterchange({ format: 'emlid-csv', content: 'Name,Lat,Lon\nA,1,2' }), (error) => error.code === 'unsupported_gcp_format');
  assert.throws(() => parseGcpInterchange({
    format: 'generic-csv-v1',
    content: 'point_id,label,latitude,longitude,elevation_m,unknown\nA,A,44,-88,1,value\n',
  }), /unsupported columns/);
  assert.throws(() => parseGcpInterchange({
    format: 'generic-csv-v1',
    content: 'point_id,label,latitude,longitude,elevation_m\nA,A,44,-88,1\na,B,44,-88,1\n',
  }), /duplicate point_id/);
  assert.throws(() => parseGcpInterchange({
    format: 'generic-csv-v1',
    content: 'point_id,label,latitude,longitude,elevation_m\nA,A,91,-88,1\n',
  }), /latitude/);
});

test('Emlid All-columns preserves exact Name and authoritative projected ftUS provenance', () => {
  const parsed = parseGcpInterchange({ format: 'emlid-all-columns-v1',
    declarations: {},
    content: 'Name,Code,Code description,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,CS name\nltds-1,,,903241.652,549596.746,833.164,Hub,-88.62836667,42.98018648,720.437,NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)\n' });
  assert.equal(parsed.points[0].externalId, 'ltds-1');
  assert.ok(Math.abs(parsed.points[0].easting - (903241.652 * 1200 / 3937)) < 1e-10);
  assert.ok(Math.abs(parsed.points[0].elevationM - (833.164 * 1200 / 3937)) < 1e-10);
  assert.ok(Math.abs(parsed.points[0].ellipsoidalHeightM - (720.437 * 1200 / 3937)) < 1e-10);
  assert.equal(parsed.provenance.coordinateSystem, 'NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)');
  assert.equal(parsed.provenance.linearUnit, 'ftUS');
  assert.match(confirmationToken(parsed), /^[a-f0-9]{64}$/);
  assert.throws(() => parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: {}, content:
    'Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,1,2,3,44,-88,2,CRS one (ftUS) + height (ftUS)\nB,1,2,3,44,-88,2,CRS two (ftUS) + height (ftUS)\n' }), /consistent CS name/);
});

test('Emlid metric projected systems remain metric and ambiguous units require confirmation', () => {
  const header = 'Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\n';
  const metric = parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: {},
    content: `${header}M-1,500000,4900000,250,44,-88,220,Projected CRS (m) + vertical height (m)\n` });
  assert.equal(metric.points[0].easting, 500000);
  assert.equal(metric.points[0].northing, 4900000);
  assert.equal(metric.points[0].elevationM, 250);
  assert.equal(metric.points[0].ellipsoidalHeightM, 220);
  assert.equal(metric.provenance.linearUnit, 'm');
  assert.throws(() => parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: {},
    content: `${header}M-1,500000,4900000,250,44,-88,220,Projected CRS\n` }), /preview and confirm/);
  const confirmed = parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: { linearUnit: 'm' },
    content: `${header}M-1,500000,4900000,250,44,-88,220,Projected CRS\n` });
  assert.equal(confirmed.provenance.linearUnit, 'm');
});

test('blank survey numbers reject instead of becoming zero while explicit zeros remain valid', () => {
  for (const column of ['latitude', 'longitude', 'elevation_m']) {
    const header = ['point_id', 'label', 'latitude', 'longitude', 'elevation_m'];
    for (const blank of ['', '   ', '\t']) {
      const values = ['A', 'Target', '0', '0', '0']; values[header.indexOf(column)] = blank;
      assert.throws(() => parseGcpInterchange({ format: 'generic-csv-v1', content: `${header.join(',')}\n${values.join(',')}\n` }),
        error => error.code === 'invalid_gcp_input' && error.message.includes(column));
    }
  }
  const zero = parseGcpInterchange({ format: 'generic-csv-v1', content: 'point_id,label,latitude,longitude,elevation_m\nA,Target,0,0,0\n' });
  assert.equal(zero.points[0].latitude, 0); assert.equal(zero.points[0].longitude, 0); assert.equal(zero.points[0].elevationM, 0);
  for (const value of ['', ' ', [], false, null]) {
    assert.throws(() => parseGcpInterchange({ format: 'generic-geojson-v1', content: JSON.stringify({ type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { point_id: 'A', label: 'Target' }, geometry: { type: 'Point', coordinates: [0, value, 0] } }] }) }),
    { code: 'invalid_gcp_input' });
  }
});

test('single explicit Emlid unit marker cannot be overridden by conflicting declarations', () => {
  const header = 'Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\n';
  for (const [unit, conflicting] of [['ftUS', 'm'], ['m', 'ftUS']]) {
    const content = `${header}A,1,2,3,44,-88,2,Projected CRS (${unit})\n`;
    assert.throws(() => parseGcpInterchange({ format: 'emlid-all-columns-v1', content, declarations: { linearUnit: conflicting } }), /does not match/);
    assert.throws(() => parseGcpInterchange({ format: 'emlid-all-columns-v1', content }), /preview and confirm/);
    const confirmed = parseGcpInterchange({ format: 'emlid-all-columns-v1', content, declarations: { linearUnit: unit } });
    assert.equal(confirmed.provenance.linearUnit, unit);
    assert.ok(Math.abs(confirmed.points[0].elevationM - 3 * (unit === 'ftUS' ? 1200 / 3937 : 1)) < 1e-12);
  }
  for (const field of ['Easting', 'Northing', 'Elevation', 'Latitude', 'Longitude', 'Ellipsoidal height']) {
    const columns = header.trim().split(','), row = ['A', '1', '2', '3', '44', '-88', '2', 'Projected CRS (m) + height (m)'];
    row[columns.indexOf(field)] = ' ';
    assert.throws(() => parseGcpInterchange({ format: 'emlid-all-columns-v1', content: `${header}${row.join(',')}\n` }), { code: 'invalid_gcp_input' });
  }
});
