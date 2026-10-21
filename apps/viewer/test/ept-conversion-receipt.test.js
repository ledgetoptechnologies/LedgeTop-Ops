'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalDerivativeInput } = require('../server/derivativeInputSnapshot');
const { hashTree } = require('../server/storageManager');
const { EPT_CONVERTER_COMMAND, EPT_CONVERTER_COMMAND_SHA256, canonicalJson, unitProofSha256,
  createEptConversionReceipt, validateEptConversionReceipt, inspectEptConversionOutput } = require('../server/eptConversionReceipt');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(unit = 'us-ft', factor = 1200 / 3937) {
  const inputAsset = { id: 'native', version_id: 'version', kind: 'pointCloud', root_key: 'models',
    relative_path: 'task/attempt/cloud.laz', byte_size: 100, sha256: 'a'.repeat(64), manifest_sha256: null };
  const inputSnapshot = { ...canonicalDerivativeInput('ept', [{ role: 'point_cloud_source', rootKey: 'models',
    relativePath: inputAsset.relative_path, byteSize: inputAsset.byte_size, sha256: inputAsset.sha256 }]), jobId: 'job' };
  const inputUnitEvidence = { schemaVersion: 1, id: 'proof', modelId: 'model', modelVersionId: 'version',
    assetId: 'native', kind: 'pointCloud', sha256: inputAsset.sha256, manifestSha256: '', byteSize: 100,
    crs: 'EPSG:32616', verticalUnit: unit, verticalFactor: factor, verticalDatum: 'unknown',
    basis: 'server-inspected-explicit-metadata', recordedAt: '2026-09-29T00:00:00.000Z' };
  const manifestFiles = [{ relativePath: 'ept-data/0-0-0-0.laz', byteSize: 7, sha256: 'b'.repeat(64) },
    { relativePath: 'ept.json', byteSize: 10, sha256: 'c'.repeat(64) }].sort((a,b) => a.relativePath.localeCompare(b.relativePath));
  const outputAsset = { versionId: 'version', attemptId: 'attempt', rootKey: 'models',
    relativePath: 'task/attempt/ept-job/ept.json', sha256: 'c'.repeat(64), byteSize: 10,
    manifestSha256: digest(JSON.stringify(manifestFiles)), manifestFiles };
  return { jobId: 'job', attemptId: 'attempt', modelId: 'model', modelVersionId: 'version', taskId: 'task',
    inputAsset, inputSnapshot, inputUnitEvidence, outputAsset,
    converter: { name: 'entwine', version: 'Entwine 3.1.1', executableSha256: 'd'.repeat(64),
      command: [...EPT_CONVERTER_COMMAND], commandSha256: EPT_CONVERTER_COMMAND_SHA256 },
    generationLeaseToken: 'lease-one', createdAt: '2026-09-29T00:00:00.000Z' };
}

test('receipt binds native identity, complete proof, controlled invocation and exact output tree', () => {
  for (const [unit, factor] of [['m', 1], ['ft', .3048], ['us-ft', 1200 / 3937]]) {
    const bindings = fixture(unit, factor), receipt = createEptConversionReceipt(bindings);
    assert.equal(receipt.input.assetId, 'native');
    assert.equal(receipt.inputSnapshotSha256, bindings.inputSnapshot.manifestSha256);
    assert.equal(receipt.inputUnitProof.sha256, unitProofSha256(bindings.inputUnitEvidence));
    assert.equal(receipt.inputUnitProof.verticalFactor, factor);
    assert.equal(receipt.output.totalByteSize, 17);
    assert.equal(validateEptConversionReceipt(receipt, bindings), true);
    const reversed = Object.fromEntries(Object.entries(bindings.inputUnitEvidence).reverse());
    assert.equal(validateEptConversionReceipt(receipt, { ...bindings, inputUnitEvidence: reversed }), true);
    const { converter, ...resume } = bindings;
    assert.equal(validateEptConversionReceipt(receipt, { ...resume, generationLeaseToken: 'new-lease', createdAt: 'different' }), true,
      'reacquisition validates the persisted generation, not a newly fabricated receipt');
  }
});

test('receipt uses storage hashTree manifest encoding including ordering', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ept-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'ept-data'));
  fs.writeFileSync(path.join(root, 'ept.json'), '{}');
  fs.writeFileSync(path.join(root, 'ept-data', '0-0-0-0.bin'), 'xyz');
  const tree = await hashTree(root), manifest = tree.files.find(file => file.relativePath === 'ept.json');
  const bindings = fixture();
  Object.assign(bindings.outputAsset, { sha256: manifest.sha256, byteSize: manifest.byteSize,
    manifestSha256: tree.manifestSha256, manifestFiles: [...tree.files].reverse() });
  const receipt = createEptConversionReceipt(bindings);
  assert.equal(receipt.output.manifestSha256, tree.manifestSha256);
  assert.equal(receipt.output.totalByteSize, 5);
});

test('substitution of input asset, snapshot, accepted proof or output fails replay', () => {
  const bindings = fixture(), receipt = createEptConversionReceipt(bindings);
  const mutations = [
    value => { value.inputAsset.id = 'other'; },
    value => { value.inputAsset.version_id = 'other'; },
    value => { value.inputAsset.relative_path = 'other.laz'; },
    value => { value.inputAsset.sha256 = 'e'.repeat(64); },
    value => { value.inputAsset.byte_size += 1; },
    value => { value.inputAsset.manifest_sha256 = 'e'.repeat(64); },
    value => { value.inputSnapshot.jobId = 'other'; },
    value => { value.inputSnapshot.manifestSha256 = 'e'.repeat(64); },
    value => { value.inputSnapshot.totalByteSize += 1; },
    value => { value.inputSnapshot.files[0].sha256 = 'e'.repeat(64); },
    value => { value.inputUnitEvidence.id = 'new-proof'; },
    value => { value.inputUnitEvidence.recordedAt = '2026-09-30T00:00:00.000Z'; },
    value => { value.inputUnitEvidence.producerProof = { engine: 'changed' }; },
    value => { value.inputUnitEvidence.verticalFactor = 1; },
    value => { value.inputUnitEvidence.basis = 'administrator-reviewed-source'; },
    value => { value.outputAsset.relativePath = 'other/ept.json'; },
    value => { value.outputAsset.manifestFiles[0].sha256 = 'e'.repeat(64); },
    value => { value.outputAsset.manifestFiles.push({ ...value.outputAsset.manifestFiles[0] }); },
    value => { value.outputAsset.manifestSha256 = 'e'.repeat(64); },
    value => { value.outputAsset.sha256 = 'e'.repeat(64); },
    value => { value.outputAsset.byteSize += 1; },
  ];
  for (const mutate of mutations) {
    const changed = clone(bindings); mutate(changed);
    assert.equal(validateEptConversionReceipt(receipt, changed), false, mutate.toString());
  }
  for (const key of ['jobId', 'attemptId', 'modelId', 'modelVersionId', 'taskId']) {
    assert.equal(validateEptConversionReceipt(receipt, { ...bindings, [key]: 'other' }), false, key);
  }
});

test('converter identity and invocation cannot be omitted or replaced', () => {
  const bindings = fixture(), receipt = createEptConversionReceipt(bindings);
  for (const mutation of [{ name: 'other' }, { executableSha256: null }, { version: '' },
    { command: ['build', '-i', '$INPUT', '-o', '$OUTPUT', '--reprojection', 'EPSG:4326'] },
    { commandSha256: 'f'.repeat(64) }]) {
    assert.throws(() => createEptConversionReceipt({ ...bindings, converter: { ...bindings.converter, ...mutation } }),
      { code: 'ept_conversion_receipt_invalid' });
  }
  assert.equal(validateEptConversionReceipt(receipt, { ...bindings,
    converter: { ...bindings.converter, executableSha256: 'f'.repeat(64) } }), false);
  assert.equal(validateEptConversionReceipt({ ...receipt, arbitraryAssertion: true }, bindings), false);
  assert.equal(validateEptConversionReceipt(null, bindings), false);
});

test('complete proof digest is stable by key order and sensitive to nested producer details', () => {
  const a = { id: 'proof', producer: { archive: 'a', command: ['run', 'x'] } };
  const b = { producer: { command: ['run', 'x'], archive: 'a' }, id: 'proof' };
  assert.equal(unitProofSha256(a), unitProofSha256(b));
  b.producer.archive = 'b';
  assert.notEqual(unitProofSha256(a), unitProofSha256(b));
  for (const bad of [undefined, NaN, Infinity, { unsupported: undefined }]) {
    assert.throws(() => canonicalJson(bad), { code: 'ept_conversion_receipt_invalid' });
  }
});

test('verified ODM metre proof is bound in full and cannot accept contradictory factors', async () => {
  const bindings = fixture('m', 1);
  Object.assign(bindings.inputUnitEvidence, { basis: 'verified-odm-source', producerProof: {
    contract: 'odm-3.5.6-native-gps-metres-v1', engine: 'ODM', engineVersion: '3.5.6', gpsZOffsetMetres: 0,
    ...Object.fromEntries(['archiveSha256', 'inputManifestSha256', 'logSha256', 'coordsSha256', 'photosSha256'].map(key => [key, 'f'.repeat(64)])),
  } });
  delete bindings.inputUnitEvidence.verticalFactor;
  const receipt = createEptConversionReceipt(bindings);
  assert.equal(receipt.inputUnitProof.verticalFactor, 1);
  assert.equal(validateEptConversionReceipt(receipt, bindings), true);
  assert.equal((await inspectEptConversionOutput({ srs: { horizontal: 32616 } }, bindings.inputUnitEvidence)).verticalFactor, 1);
  const changed = clone(bindings);
  changed.inputUnitEvidence.producerProof.archiveSha256 = 'a'.repeat(64);
  assert.equal(validateEptConversionReceipt(receipt, changed), false);
  changed.inputUnitEvidence.verticalFactor = .3048;
  assert.throws(() => createEptConversionReceipt(changed), { code: 'ept_conversion_receipt_invalid' });
});

const horizontal = 'PROJCS["WGS84 UTM16N",GEOGCS["WGS84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-87],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]';
const compound = (unit = 'metre', factor = 1) => `COMPD_CS["Survey",${horizontal},VERT_CS["Survey height",VERT_DATUM["Survey datum",2005],UNIT["${unit}",${factor}],AXIS["Height",UP]]]`;

test('horizontal-only output inherits original foot factor; encoded units must agree', async () => {
  for (const [unit, factor, encoded] of [['m', 1, 'metre'], ['ft', .3048, 'foot'], ['us-ft', 1200 / 3937, 'US survey foot']]) {
    const proof = fixture(unit, factor).inputUnitEvidence;
    const missing = await inspectEptConversionOutput({ srs: { horizontal: 32616 } }, proof);
    assert.equal(missing.verticalFactor, factor);
    assert.equal(missing.encodedVerticalUnits, false);
    assert.equal((await inspectEptConversionOutput({ srs: { wkt: compound(encoded, factor) } }, proof)).encodedVerticalUnits, true);
    await assert.rejects(inspectEptConversionOutput({ srs: { wkt: compound('foot', .3048) } },
      fixture('m', 1).inputUnitEvidence), { code: 'measurement_source_vertical_units_conflict' });
  }
});

test('inheritance never bypasses CRS mismatch, unsupported vertical ID or malformed units', async () => {
  const proof = fixture().inputUnitEvidence;
  for (const [srs, code] of [
    [{ horizontal: 32617 }, 'measurement_source_crs_mismatch'],
    [{ horizontal: 32616, vertical: 5703 }, 'measurement_source_vertical_units_unsupported'],
    [{ horizontal: 32616, vertical: null }, 'measurement_source_vertical_metadata_invalid'],
    [{ wkt: compound('yard', .9144) }, 'measurement_source_vertical_units_unsupported'],
    [{ wkt: compound().replace('AXIS["Height",UP]', 'AXIS["Height",DOWN]') }, 'measurement_source_vertical_metadata_invalid'],
    [{ horizontal: 32616, wkt: compound().replace('UNIT["metre",1],AXIS["Height",UP]', 'AXIS["Height",UP]') }, 'measurement_source_vertical_metadata_invalid'],
  ]) await assert.rejects(inspectEptConversionOutput({ srs }, proof), { code });
  await assert.rejects(inspectEptConversionOutput({ srs: { horizontal: 32616 } }, { ...proof, basis: 'imported-assertion' }),
    { code: 'ept_conversion_receipt_invalid' });
});
