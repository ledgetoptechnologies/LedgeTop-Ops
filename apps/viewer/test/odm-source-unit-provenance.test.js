'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { resolveOdmSourceUnitProvenance: resolve, MAX_ARTIFACT_BYTES } = require('../server/odmSourceUnitProvenance');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(change = () => {}) {
  const log = { odmVersion: '3.5.6', images: 2, success: true, startTime: '2026-01-01T00:00:00', endTime: '2026-01-01T00:01:00', totalTime: 60,
    options: { gcp: null, geo: null, align: null, sm_cluster: null, split_image_groups: null, rerun: null, rerun_from: null, rerun_all: false, split: 999999,
      end_with: 'odm_postprocess', gps_z_offset: 0, dsm: true, dtm: true, project_path: '/private/path', secret: 'DO-NOT-EXPOSE' },
    stages: ['dataset','opensfm','odm_georeferencing','odm_dem','odm_postprocess'].map(name => ({ name, messages: [] })),
    processes: [{ command: '/private/process?token=DO-NOT-EXPOSE', exitCode: 0 }] };
  const photos = [{ filename: 'a.jpg', latitude: 43, longitude: -88, altitude: 200 }, { filename: 'b.jpg', latitude: 43, longitude: -88, altitude: 201 }];
  const inputFiles = ['a.jpg', 'b.jpg'].map(relativePath => ({ relativePath, byteSize: 4, sha256: sha(relativePath) }));
  change(log, photos, inputFiles);
  const archiveFiles = [];
  const artifact = (relativePath, data) => {
    const bytes = Buffer.from(data);
    archiveFiles.push({ relativePath, byteSize: bytes.length, sha256: sha(bytes) });
    return { relativePath, bytes };
  };
  const result = { inputFiles, archiveFiles,
    receipt: { operation: 'create', status: 'completed', providerTaskId: 'task-1', completedTaskId: 'task-1', archiveSha256: sha('archive'), inputManifestSha256: sha(JSON.stringify(inputFiles)) },
    log: artifact('log.json', JSON.stringify(log)), photos: artifact('images.json', JSON.stringify(photos)), coords: artifact('odm_georeferencing/coords.txt', 'WGS84 UTM 16N\n100 200\n1 2 200\n3 4 201\n'),
    source: { relativePath: 'odm_dem/dsm.tif', byteSize: 12, sha256: sha('source'), kind: 'dsm', horizontalEpsg: 32616, verticalUnit: null } };
  archiveFiles.push({ ...result.source });
  return result;
}
test('native ODM 3.5.6 resolves bound metre evidence without leaking options, paths or credentials', () => {
  const result = resolve(fixture());
  assert.equal(result.status, 'resolved');
  assert.equal(result.verticalUnit, 'metre');
  assert.equal(result.verticalDatum, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /private|DO-NOT|a\.jpg|task-1/);
});
test('report units do not govern source values; metre offset remains explicit, datum unknown', () => {
  const result = resolve(fixture(log => { log.options.report_units = 'ft'; log.options.gps_z_offset = 2; }));
  assert.equal(result.status, 'resolved'); assert.equal(result.gpsZOffsetMetres, 2);
});

test('empty archive marker files do not imply empty source photos', () => {
  const data = fixture(); data.archiveFiles.push({ relativePath: 'opensfm/empty-marker', byteSize: 0, sha256: sha('') });
  assert.equal(resolve(data).status, 'resolved');
  assert.equal(resolve(fixture((_log, _photos, files) => { files[0].byteSize = 0; })).status, 'unknown');
});
test('unknown versions and ODX never borrow this contract', () => {
  for (const mutate of [log => { log.odmVersion = '3.5.7'; }, log => { log.engine = 'ODX'; log.version = '3.5.6'; }, log => { delete log.odmVersion; }]) {
    assert.equal(resolve(fixture(mutate)).reason, 'unaudited_engine_version');
  }
});
test('missing, failed, partial and reused pipelines fail closed', () => {
  const cases = [log => { log.success = false; }, log => { log.processes[0].exitCode = 1; }, log => { log.error = {}; }, log => { log.stages.pop(); },
    log => { log.options.rerun_from = ['odm_dem','odm_postprocess']; }, log => { log.options.rerun_all = true; }, log => { delete log.options.geo; },
    log => { log.options.sm_cluster = true; }, log => { log.options.split = 1; }, log => { log.options.gcp = '/private/gcp.txt'; },
    log => { log.options.geo = '/private/geo.txt'; }, log => { log.options.align = '/private/model.laz'; },
    log => { log.stages[0].messages.push({ message: 'Coordinates file already exist: /private/coords.txt', type: 'info' }); },
    log => { log.stages[0].messages.push({ message: 'Not georeferenced, using ungeoreferenced point cloud...', type: 'warning' }); }];
  for (const mutate of cases) assert.equal(resolve(fixture(mutate)).status, 'unknown');
});
test('ancillary files and submodels are denied despite empty executed options', () => {
  for (const relativePath of ['gcp_list.txt','geo.txt','align.laz','odm_georeferencing/alignment_matrix.json','submodels/a/log.json']) {
    const data = fixture(); data.archiveFiles.push({ relativePath, sha256: sha('x'), byteSize: 1 });
    assert.equal(resolve(data).reason, 'custom_or_split_pipeline');
  }
});
test('native images and GPS required; input identity immutable', () => {
  assert.equal(resolve(fixture((log, photos) => { photos[0].altitude = null; })).reason, 'missing_native_gps');
  assert.equal(resolve(fixture((log, photos) => { photos[0].altitude = 300; })).reason, 'native_altitude_mismatch');
  const data = fixture(); data.inputFiles[0].relativePath = 'geo.txt';
  assert.equal(resolve(data).reason, 'input_manifest_changed');
  assert.equal(resolve(fixture((log, photos, files) => { files[0].relativePath = 'geo.txt'; })).reason, 'non_native_image_inputs');
});
test('result receipt, source hash/CRS/units and artifact digests must match', () => {
  for (const mutate of [data => { data.receipt.operation = 'restart'; }, data => { data.receipt.completedTaskId = 'different'; },
    data => { data.source.sha256 = sha('different'); }, data => { data.source.horizontalEpsg = 32615; }, data => { data.source.verticalUnit = 'foot'; },
    data => { data.log.bytes[0] = 32; }, data => { data.coords.bytes[0] = 32; }]) {
    const data = fixture(); mutate(data); assert.equal(resolve(data).status, 'unknown');
  }
});
test('ambiguous logs rejected; identical copies accepted', () => {
  const data = fixture(); const logEntry = data.archiveFiles.find(row => row.relativePath === 'log.json');
  data.archiveFiles.push({ ...logEntry, relativePath: 'assets/log.json' });
  assert.equal(resolve(data).status, 'resolved');
  data.archiveFiles.at(-1).sha256 = sha('other log');
  assert.equal(resolve(data).reason, 'ambiguous_producer_logs');
});
test('bounded parsing, malformed data and unsafe duplicate paths never throw or echo input', () => {
  const big = fixture(); big.log.bytes = Buffer.alloc(MAX_ARTIFACT_BYTES + 1); assert.equal(resolve(big).status, 'unknown');
  for (const value of [null, {}, { receipt: { providerTaskId: '/private/DO-NOT-EXPOSE' } }]) assert.equal(resolve(value).status, 'unknown');
  const bad = fixture(); bad.archiveFiles.push({ ...bad.archiveFiles[0], relativePath: 'LOG.JSON' }); assert.equal(resolve(bad).reason, 'invalid_inventory');
  const malformed = fixture(); malformed.log.bytes.fill(32); malformed.archiveFiles[0].sha256 = sha(malformed.log.bytes);
  assert.deepEqual(resolve(malformed), { status: 'unknown', reason: 'malformed_evidence' });
});
