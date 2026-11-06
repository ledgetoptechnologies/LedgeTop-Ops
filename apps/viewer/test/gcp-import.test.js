'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseGcpInterchange, confirmationToken, detectGcpCsvFormat } = require('../server/gcpImport');

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
  assert.equal(parsed.crs, 'EPSG:6318');
  assert.equal(parsed.provenance.horizontalCrs, 'EPSG:6318');
  assert.equal(parsed.provenance.verticalDatum, 'NAVD88(GEOID18) height');
  assert.ok(Math.abs(parsed.points[0].easting - (903241.652 * 1200 / 3937)) < 1e-10);
  assert.ok(Math.abs(parsed.points[0].elevationM - (833.164 * 1200 / 3937)) < 1e-10);
  assert.ok(Math.abs(parsed.points[0].ellipsoidalHeightM - (720.437 * 1200 / 3937)) < 1e-10);
  assert.equal(parsed.provenance.coordinateSystem, 'NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)');
  assert.equal(parsed.provenance.linearUnit, 'ftUS');
  assert.match(confirmationToken(parsed), /^[a-f0-9]{64}$/);
  assert.throws(() => parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: {}, content:
    'Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,1,2,3,44,-88,2,CRS one (ftUS) + height (ftUS)\nB,1,2,3,44,-88,2,CRS two (ftUS) + height (ftUS)\n' }), /consistent CS name/);
  assert.throws(() => parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: { verticalDatum: 'Ellipsoidal height' }, content:
    'Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,1,2,3,44,-88,2,NAD83(2011) / Projected (m) + NAVD88(GEOID18) height (m)\n' }), /declared verticalDatum does not match/);
});

test('automatic CSV format detection accepts only complete supported schemas',()=>{
  const emlid='Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nCP-1,1,2,3,44,-88,2,NAD83(2011) / Projected (m) + NAVD88 height (m)\n';
  const generic='point_id,label,latitude,longitude,elevation_m\nA,A,44,-88,1\n';
  assert.equal(detectGcpCsvFormat(emlid),'emlid-all-columns-v1');
  assert.equal(detectGcpCsvFormat(`\uFEFF${generic}`),'generic-csv-v1');
  assert.equal(detectGcpCsvFormat('date,temperature\n2026-01-01,12\n'),null);
  assert.equal(detectGcpCsvFormat('Name,Latitude,Longitude\nCP-1,44,-88\n'),null);
});

test('Emlid and generic numeric blanks are rejected instead of becoming zero coordinates', () => {
  const emlidHeaders = ['Name', 'Easting', 'Northing', 'Elevation', 'Latitude', 'Longitude', 'Ellipsoidal height', 'CS name'];
  const emlidValues = ['CP-1', '500000', '4900000', '250', '44', '-88', '220', 'NAD83(2011) / Projected CRS (m) + NAVD88 height (m)'];
  for (const header of ['Easting', 'Northing', 'Elevation', 'Latitude', 'Longitude', 'Ellipsoidal height']) {
    const values = [...emlidValues];
    values[emlidHeaders.indexOf(header)] = '';
    assert.throws(() => parseGcpInterchange({
      format: 'emlid-all-columns-v1',
      content: `${emlidHeaders.join(',')}\n${values.join(',')}\n`,
    }), /is required/, `blank ${header} must be rejected`);
  }
  for (const header of ['latitude', 'longitude', 'elevation_m']) {
    const values = { latitude: '44', longitude: '-88', elevation_m: '250' };
    values[header] = '';
    assert.throws(() => parseGcpInterchange({
      format: 'generic-csv-v1',
      content: `point_id,label,latitude,longitude,elevation_m\nA,A,${values.latitude},${values.longitude},${values.elevation_m}\n`,
    }), /is required/, `blank ${header} must be rejected`);
  }
});

test('Emlid metric projected systems remain metric and ambiguous units require confirmation', () => {
  const header = 'Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\n';
  const metric = parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: {},
    content: `${header}M-1,500000,4900000,250,44,-88,220,NAD83(2011) / Projected CRS (m) + NAVD88 height (m)\n` });
  assert.equal(metric.points[0].easting, 500000);
  assert.equal(metric.points[0].northing, 4900000);
  assert.equal(metric.points[0].elevationM, 250);
  assert.equal(metric.points[0].ellipsoidalHeightM, 220);
  assert.equal(metric.provenance.linearUnit, 'm');
  assert.equal(metric.provenance.verticalDatum, 'NAVD88 height');
  assert.throws(() => parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: {},
    content: `${header}M-1,500000,4900000,250,44,-88,220,NAD83(2011) / Projected CRS\n` }), /preview and confirm/);
  const confirmed = parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: { linearUnit: 'm' },
    content: `${header}M-1,500000,4900000,250,44,-88,220,NAD83(2011) / Projected CRS\n` });
  assert.equal(confirmed.provenance.linearUnit, 'm');
});

test('bare NAVD88 datum names remain explicit and never fall through to horizontal-only export', () => {
  const parsed = parseGcpInterchange({ format: 'emlid-all-columns-v1', declarations: { linearUnit: 'm' }, content:
    'Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,500000,4900000,250,44,-88,220,NAD83(2011) / Projected CRS (m) + NAVD88\n' });
  assert.equal(parsed.provenance.verticalDatum, 'NAVD88');
});
