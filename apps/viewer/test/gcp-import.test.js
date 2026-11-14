'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseGcpInterchange, confirmationToken } = require('../server/gcpImport');

test('generic CSV rejects empty or whitespace coordinates and elevations instead of importing zero', () => {
  const header = 'point_id,label,latitude,longitude,elevation_m\n';
  for (const column of [2, 3, 4]) {
    for (const missing of ['', '   ']) {
      const row = ['A', 'A', '44', '-88', '250'];
      row[column] = missing;
      assert.throws(() => parseGcpInterchange({ format: 'generic-csv-v1',
        content: header + row.join(',') + '\n' }),
      error => error.code === 'invalid_gcp_input', `column ${column}, missing ${JSON.stringify(missing)}`);
    }
  }
});

test('Emlid CSV rejects missing values in every required numeric column', () => {
  const header = 'Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\n';
  for (const column of [1, 2, 3, 4, 5, 6]) {
    for (const missing of ['', '   ']) {
      const row = ['A', '500000', '4900000', '250', '44', '-88', '220', 'Projected CRS (m) + vertical height (m)'];
      row[column] = missing;
      assert.throws(() => parseGcpInterchange({ format: 'emlid-all-columns-v1',
        content: header + row.join(',') + '\n' }),
      error => error.code === 'invalid_gcp_input', `column ${column}, missing ${JSON.stringify(missing)}`);
    }
  }
});

test('GeoJSON rejects array-shaped coordinate values instead of coercing them to numbers', () => {
  for (const column of [0, 1, 2]) {
    for (const malformed of [[], [0]]) {
      const coordinates = [-88, 44, 250];
      coordinates[column] = malformed;
      assert.throws(() => parseGcpInterchange({ format: 'generic-geojson-v1',
        content: JSON.stringify({ type: 'FeatureCollection', features: [{
          type: 'Feature', properties: { point_id: 'A', label: 'A' },
          geometry: { type: 'Point', coordinates },
        }] }) }), error => error.code === 'invalid_gcp_input');
    }
  }
});

test('numeric zero remains valid in generic CSV, GeoJSON and Emlid inputs', () => {
  const inputs = [
    { format: 'generic-csv-v1', content: 'point_id,label,latitude,longitude,elevation_m\nZ,Z, 0 ,0,0\n' },
    { format: 'generic-geojson-v1', content: JSON.stringify({ type: 'FeatureCollection', features: [{
      type: 'Feature', properties: { point_id: 'Z', label: 'Z' },
      geometry: { type: 'Point', coordinates: [0, 0, 0] },
    }] }) },
    { format: 'emlid-all-columns-v1', content:
      'Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nZ,0,0,0,0,0,0,Projected CRS (m) + vertical height (m)\n' },
  ];
  for (const input of inputs) {
    const point = parseGcpInterchange(input).points[0];
    assert.equal(point.latitude, 0);
    assert.equal(point.longitude, 0);
    assert.equal(point.elevationM, 0);
    if (input.format === 'emlid-all-columns-v1') {
      assert.equal(point.easting, 0);
      assert.equal(point.northing, 0);
      assert.equal(point.ellipsoidalHeightM, 0);
    }
  }
});

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
