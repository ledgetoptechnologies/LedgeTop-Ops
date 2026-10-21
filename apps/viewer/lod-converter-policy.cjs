'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const SOURCE_PLACEHOLDER = '<source.obj>';
const OUTPUT_PLACEHOLDER = '<output>';
const LEGACY_CONTROLLED_CONVERTER = Object.freeze({
  name: 'OpenDroneMap/Obj2Tiles',
  version: '1.6.2',
  arguments: Object.freeze([
    '--octree', '--lods', '3', '--divisions', '2',
    '--lod-texture-scale', '0.5',
    '--local', SOURCE_PLACEHOLDER, OUTPUT_PLACEHOLDER,
  ]),
});
const LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256 = '7d82c354b3d65985e602454c0bcc204fe8e75d8efc1826b76a5681d85c34f681';

const LEGACY_KTX2_CONVERTER = Object.freeze({
  name: 'OpenDroneMap/Obj2Tiles',
  version: '1.6.2',
  arguments: Object.freeze([
    '--octree', '--lods', '3', '--divisions', '2',
    '--lod-texture-scale', '0.5',
    '--texture-format', 'Ktx2',
    '--ktx2-quality', '192',
    '--local', SOURCE_PLACEHOLDER, OUTPUT_PLACEHOLDER,
  ]),
});
const LEGACY_KTX2_CONVERTER_COMMAND_SHA256 = '8d0931aa44aae76b48832212cd6c649b73e9b9843d5d5f07462f167d0e8d5752';

const OBJ2TILES_SOURCE_SHA256 = '79093e12f6eab2cfcd522aebe670892c5d8874e160956b84f3e55c77b94ac0b5';
const OBJ2TILES_PATCH_SHA256 = '6d5d99ea1d1e36208e44d0456d35cb0d8c68092dfd4a6ad01288bf85bb67322b';

const CONTROLLED_CONVERTER = Object.freeze({
  name: 'OpenDroneMap/Obj2Tiles',
  version: '1.6.2',
  arguments: Object.freeze([
    '--octree', '--lods', '3', '--divisions', '2',
    '--lod-texture-scale', '0.5',
    '--texture-format', 'Ktx2',
    '--ktx2-quality', '192',
    '--max-parallelism', '2',
    '--image-parallelism', '1',
    '--local', SOURCE_PLACEHOLDER, OUTPUT_PLACEHOLDER,
  ]),
  fork: Object.freeze({
    sourceVersion: 'v1.6.2',
    sourceSha256: OBJ2TILES_SOURCE_SHA256,
    patchSha256: OBJ2TILES_PATCH_SHA256,
  }),
});
const SERIAL_RETRY_CONVERTER = Object.freeze({
  ...CONTROLLED_CONVERTER,
  arguments: Object.freeze(CONTROLLED_CONVERTER.arguments.map((value, index, arguments_) => (
    arguments_[index - 1] === '--max-parallelism' ? '1' : value
  ))),
  retry: Object.freeze({ reason: 'explicit-resource-pressure', attempt: 1 }),
});

const OFFICIAL_CONVERTER_BINARY_SHA256 = Object.freeze([
  '40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274',
  'c54dbcbe953640f2aa0e7c2568709108a97063dac492781c9560a5042e46d9b1',
]);

// Provenance v4 permits only a very small, evidence-gated numerical gray zone.
// Keep these values in the shared CJS policy so the ESM auditor and CommonJS
// server validator cannot silently drift apart.
const CONTROLLED_SURFACE_AUDIT_POLICY_V4 = Object.freeze({
  revision: 'ltds-controlled-surface-policy-v4',
  accumulationMethod: 'neumaier-compensated-f64-forward-reverse',
  numericalAgreementLimit: 1e-12,
  normalAreaRelativeDeltaLimit: 1e-5,
  grayAreaRelativeDeltaLimit: 1.2e-5,
  graySpatialToleranceFraction: 0.5,
  grayNormalizedSecondMomentDeltaLimit: 1e-5,
  grayMaximumReversedNormalFraction: 0.005,
  normalNormalizedSecondMomentDeltaLimit: 2e-5,
  normalMaximumReversedNormalFraction: 0.01,
});

function runtimeForkBuildInfo(infoFile = '/opt/obj2tiles/build-info.json') {
  if (!fs.existsSync(infoFile)) return null;
  let info;
  try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); }
  catch { throw new Error('Obj2Tiles build information is malformed'); }
  if (!info || Array.isArray(info)
    || info.schemaVersion !== 1
    || info.sourceVersion !== 'v1.6.2'
    || info.sourceSha256 !== OBJ2TILES_SOURCE_SHA256
    || info.patchSha256 !== OBJ2TILES_PATCH_SHA256
    || !/^[a-f0-9]{64}$/.test(String(info.binarySha256 || ''))) {
    throw new Error('Obj2Tiles build information does not match the pinned source and patch contract');
  }
  return Object.freeze({ ...info, binarySha256: info.binarySha256.toLowerCase() });
}

const runtimeForkInfo = runtimeForkBuildInfo();
const CONTROLLED_CONVERTER_BINARY_SHA256 = Object.freeze([
  ...OFFICIAL_CONVERTER_BINARY_SHA256,
  ...(runtimeForkInfo ? [runtimeForkInfo.binarySha256] : []),
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const CONTROLLED_CONVERTER_COMMAND_SHA256 = crypto
  .createHash('sha256')
  .update(stable(CONTROLLED_CONVERTER))
  .digest('hex');
const SERIAL_RETRY_CONVERTER_COMMAND_SHA256 = crypto
  .createHash('sha256')
  .update(stable(SERIAL_RETRY_CONVERTER))
  .digest('hex');
const ACCEPTED_CONTROLLED_CONVERTER_COMMAND_SHA256 = Object.freeze([
  LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256,
  LEGACY_KTX2_CONVERTER_COMMAND_SHA256,
  CONTROLLED_CONVERTER_COMMAND_SHA256,
  SERIAL_RETRY_CONVERTER_COMMAND_SHA256,
]);
const ACCEPTED_CONTROLLED_CONVERTER_CONTRACTS = Object.freeze([
  Object.freeze({
    converter: LEGACY_CONTROLLED_CONVERTER,
    commandSha256: LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256,
  }),
  Object.freeze({
    converter: LEGACY_KTX2_CONVERTER,
    commandSha256: LEGACY_KTX2_CONVERTER_COMMAND_SHA256,
  }),
  Object.freeze({
    converter: CONTROLLED_CONVERTER,
    commandSha256: CONTROLLED_CONVERTER_COMMAND_SHA256,
  }),
  Object.freeze({
    converter: SERIAL_RETRY_CONVERTER,
    commandSha256: SERIAL_RETRY_CONVERTER_COMMAND_SHA256,
  }),
]);

function obj2TilesArguments(source, output, { serialRetry = false } = {}) {
  const converter = serialRetry ? SERIAL_RETRY_CONVERTER : CONTROLLED_CONVERTER;
  return converter.arguments.map((argument) => {
    if (argument === SOURCE_PLACEHOLDER) return source;
    if (argument === OUTPUT_PLACEHOLDER) return output;
    return argument;
  });
}

module.exports = {
  ACCEPTED_CONTROLLED_CONVERTER_COMMAND_SHA256,
  ACCEPTED_CONTROLLED_CONVERTER_CONTRACTS,
  CONTROLLED_CONVERTER,
  CONTROLLED_CONVERTER_BINARY_SHA256,
  CONTROLLED_CONVERTER_COMMAND_SHA256,
  CONTROLLED_SURFACE_AUDIT_POLICY_V4,
  LEGACY_CONTROLLED_CONVERTER,
  LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256,
  LEGACY_KTX2_CONVERTER,
  LEGACY_KTX2_CONVERTER_COMMAND_SHA256,
  OBJ2TILES_PATCH_SHA256,
  OBJ2TILES_SOURCE_SHA256,
  OFFICIAL_CONVERTER_BINARY_SHA256,
  SERIAL_RETRY_CONVERTER,
  SERIAL_RETRY_CONVERTER_COMMAND_SHA256,
  obj2TilesArguments,
  runtimeForkBuildInfo,
  stable,
};
