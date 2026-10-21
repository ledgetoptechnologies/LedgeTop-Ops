'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MAX_STATS_BYTES, parseBounds, parseCrs, parseOdmCoordinateOrigin, readOdmTaskMetadata } = require('../server/odmTaskMetadata');

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-metadata-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  fs.mkdirSync(path.join(value, 'odm_report'), { recursive: true });
  fs.mkdirSync(path.join(value, 'odm_georeferencing'), { recursive: true });
  return value;
}

test('reads authoritative WebODM-compatible statistics and projected CRS', (t) => {
  const directory = root(t);
  fs.writeFileSync(path.join(directory, 'odm_report', 'stats.json'), JSON.stringify({
    point_cloud_statistics: { dense: true, stats: { statistic: [{ count: 428498832 }] } },
    reconstruction_statistics: { reconstructed_points_count: 1234 },
    odm_processing_statistics: { average_gsd: 0.3048 },
    processing_statistics: { area: 115092.96, start_date: '2026-08-04T22:00:00Z', end_date: '2026-08-06T06:45:44Z' },
  }));
  fs.writeFileSync(path.join(directory, 'odm_georeferencing', 'proj.txt'), '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs');
  const value = readOdmTaskMetadata(directory);
  assert.ok(Math.abs(value.processingMetrics.averageGsdM - 0.003048) < 1e-12);
  assert.equal(value.processingMetrics.surveyedAreaM2, 115092.96);
  assert.equal(value.pointCount, 428498832);
  assert.equal(value.processingMetrics.reconstructedPointCount, 428498832);
  assert.equal(value.georef.crs, 'WGS 84 / UTM zone 16N');
});

test('falls back to sparse reconstruction count and ignores malformed optional metadata', (t) => {
  const directory = root(t);
  fs.writeFileSync(path.join(directory, 'odm_report', 'stats.json'), JSON.stringify({
    point_cloud_statistics: { dense: false },
    reconstruction_statistics: { reconstructed_points_count: 8123 },
  }));
  assert.equal(readOdmTaskMetadata(directory).pointCount, 8123);
  fs.writeFileSync(path.join(directory, 'odm_report', 'stats.json'), '{bad json');
  assert.deepEqual(readOdmTaskMetadata(directory), { processingMetrics: {}, georef: {}, pointCount: null });
  fs.writeFileSync(path.join(directory, 'odm_report', 'stats.json'), Buffer.alloc(MAX_STATS_BYTES + 1));
  assert.deepEqual(readOdmTaskMetadata(directory), { processingMetrics: {}, georef: {}, pointCount: null });
});

test('CRS parser preserves bounded source projection and handles southern UTM', () => {
  assert.deepEqual(parseCrs('+proj=utm +zone=55 +south +ellps=WGS84 +units=m'), {
    crs: 'WGS 84 / UTM zone 55S',
    proj: '+proj=utm +zone=55 +south +ellps=WGS84 +units=m',
    utmZone: 55,
    hemisphere: 'S',
    utmZoneLon0Deg: 147,
  });
  assert.equal(parseCrs('EPSG:32616').epsg, 32616);
  assert.equal(parseCrs('EPSG:32616').utmZone, 16);
});

test('reads WebODM two-value model origin and native bounds from the imported church format', (t) => {
  const directory = root(t);
  fs.writeFileSync(path.join(directory, 'odm_georeferencing', 'proj.txt'), '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs +type=crs');
  fs.writeFileSync(path.join(directory, 'odm_georeferencing', 'odm_georeferencing_model_geo.txt'), 'WGS84 UTM 16N\n435932 4897211\n');
  fs.writeFileSync(path.join(directory, 'odm_georeferencing', 'odm_georeferenced_model.summary.json'), JSON.stringify({
    summary: { bounds: { minx: 435895.3, miny: 4897159.221, minz: 211.914, maxx: 435976.627, maxy: 4897266.836, maxz: 258.005 } },
  }));
  const value = readOdmTaskMetadata(directory);
  assert.deepEqual(value.georef.rtc, { e: 435932, n: 4897211, z: 0 });
  assert.equal(value.georef.utmZone, 16);
  assert.equal(value.georef.hemisphere, 'N');
  assert.ok(Math.abs(value.georef.bboxCenter.x - 3.9635) < 1e-9);
  assert.ok(Math.abs(value.georef.bboxCenter.y - 2.0285) < 1e-9);
  assert.ok(Math.abs(value.georef.bboxCenter.z - 234.9595) < 1e-9);
});

test('falls back to a bounded coords prefix in assets layouts and rejects conflicting CRS metadata', (t) => {
  const directory = root(t), assets = path.join(directory, 'assets', 'odm_georeferencing');
  fs.rmSync(path.join(directory, 'odm_georeferencing'), { recursive: true });
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'proj.txt'), '+proj=utm +zone=16 +datum=WGS84');
  fs.writeFileSync(path.join(assets, 'coords.txt'), `WGS84 UTM 16N\n435932 4897211 7.5\n${'camera 1 2 3\n'.repeat(1000)}`);
  assert.deepEqual(readOdmTaskMetadata(directory).georef.rtc, { e: 435932, n: 4897211, z: 7.5 });
  fs.writeFileSync(path.join(assets, 'proj.txt'), '+proj=utm +zone=17 +datum=WGS84');
  assert.equal(readOdmTaskMetadata(directory).georef.rtc, undefined);
});

test('coordinate origin parser fails closed on malformed or implausible origins', () => {
  assert.deepEqual(parseOdmCoordinateOrigin('WGS84 UTM 16N\n435932 4897211'), {
    utmZone: 16, hemisphere: 'N', utmZoneLon0Deg: -87, rtc: { e: 435932, n: 4897211, z: 0 },
  });
  assert.equal(parseOdmCoordinateOrigin('WGS84 UTM 61N\n1 2'), null);
  assert.equal(parseOdmCoordinateOrigin('WGS84 UTM 16N\nInfinity 2'), null);
  assert.equal(parseOdmCoordinateOrigin('WGS84 UTM 16N\n1 2 3 4'), null);
  assert.equal(parseBounds({ minx: null, miny: 0, minz: 0, maxx: 1, maxy: 1, maxz: 1 }), null);
});
