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
const LEGACY_OBJ2TILES_PATCH_SHA256 = '6d5d99ea1d1e36208e44d0456d35cb0d8c68092dfd4a6ad01288bf85bb67322b';
const OUTER_BOUNDED_OBJ2TILES_PATCH_SHA256 = 'fb35e1f99e76d6af99748681b65e08c3e0072da23cb7d61098c4bea1e45e604c';
const RETAINED_FULLRES_OBJ2TILES_PATCH_SHA256 = '98c641e28a7711708a46e8a3bcabb6ceea689b8488b09ae60a5c19868e7d9317';
const OBJ2TILES_PATCH_SHA256 = '7951fcf96132e17ae08ee31a66db37080e0f175b9e2cd9ffafb8692033ed05de';
const OUTER_BOUNDED_LOCKSET_SHA256 = 'b30f6a37f1d3cc542ea10a484672750d93af70d76b57257dce2ff47abab64d98';
const RETAINED_FULLRES_OBJ2TILES_LOCKSET_SHA256 = 'afe3b0c0cb31fa4c3011eb7e25f6a0fe6c5c7d620fb1239f6c36e0ec1df9986b';
const OBJ2TILES_LOCKSET_SHA256 = 'afe3b0c0cb31fa4c3011eb7e25f6a0fe6c5c7d620fb1239f6c36e0ec1df9986b';
const OBJ2TILES_LICENSE_NOTICE_SHA256 = '86768eb4bb03feacad31ba6ec90c003abafdebeb5257a1c3eeb1b4f348530a4e';
const OBJ2TILES_IMAGE_SHARP_VERSION = '3.2.0';

// Freeze historical arguments independently: a future current command must not
// change retained receipts while leaving their recorded command hashes intact.
const OUTER_BOUNDED_CONVERTER = Object.freeze({
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
    patchSha256: OUTER_BOUNDED_OBJ2TILES_PATCH_SHA256,
  }),
});
const CONTROLLED_CONVERTER = Object.freeze({
  ...OUTER_BOUNDED_CONVERTER,
  arguments: Object.freeze([
    '--octree', '--lods', '3', '--divisions', '2',
    '--lod-texture-scale', '0.5',
    '--texture-format', 'Ktx2', '--ktx2-quality', '192',
    '--max-parallelism', '1', '--image-parallelism', '1',
    '--max-texture-size', '0',
    '--local', SOURCE_PLACEHOLDER, OUTPUT_PLACEHOLDER,
  ]),
  fork: Object.freeze({
    sourceVersion: 'v1.6.2', sourceSha256: OBJ2TILES_SOURCE_SHA256,
    patchSha256: OBJ2TILES_PATCH_SHA256,
  }),
});
const OUTER_BOUNDED_SERIAL_RETRY_CONVERTER = Object.freeze({
  ...OUTER_BOUNDED_CONVERTER,
  arguments: Object.freeze(OUTER_BOUNDED_CONVERTER.arguments.map((value, index, arguments_) => (
    arguments_[index - 1] === '--max-parallelism' ? '1' : value
  ))),
  retry: Object.freeze({ reason: 'explicit-resource-pressure', attempt: 1 }),
});
const OUTER_BOUNDED_COMMAND_SHA256 = 'f627b934a2e4abbad04fc85e4689cabc791251eac7f333c4a1575d198f9ee117';
const OUTER_BOUNDED_SERIAL_COMMAND_SHA256 = 'a1a4824dae509fa212736398cecc437275705d6b091a11b0f0f71f8a243a935b';
const LEGACY_FORK_CONTROLLED_CONVERTER = Object.freeze({
  ...OUTER_BOUNDED_CONVERTER,
  fork: Object.freeze({ sourceVersion: 'v1.6.2', sourceSha256: OBJ2TILES_SOURCE_SHA256, patchSha256: LEGACY_OBJ2TILES_PATCH_SHA256 }),
});
const LEGACY_FORK_SERIAL_RETRY_CONVERTER = Object.freeze({
  ...LEGACY_FORK_CONTROLLED_CONVERTER,
  arguments: Object.freeze(LEGACY_FORK_CONTROLLED_CONVERTER.arguments.map((value, index, arguments_) => (
    arguments_[index - 1] === '--max-parallelism' ? '1' : value
  ))),
  retry: Object.freeze({ reason: 'explicit-resource-pressure', attempt: 1 }),
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

function runtimeForkBuildInfo(infoFile = '/opt/obj2tiles/build-info.json', licenseManifestFile = '/opt/obj2tiles/licenses/imagesharp-3.2.0/manifest.json') {
  if (!fs.existsSync(infoFile)) return null;
  let info;
  try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); }
  catch { throw new Error('Obj2Tiles build information is malformed'); }
  const common = info && !Array.isArray(info)
    && info.sourceVersion === 'v1.6.2'
    && info.sourceSha256 === OBJ2TILES_SOURCE_SHA256
    && /^[a-f0-9]{64}$/.test(String(info.binarySha256 || ''));
  const retainedLegacy = common && info.schemaVersion === 1 && info.patchSha256 === LEGACY_OBJ2TILES_PATCH_SHA256;
  const licenseManifestMatches = info?.schemaVersion === 2 && fs.existsSync(licenseManifestFile)
    && crypto.createHash('sha256').update(fs.readFileSync(licenseManifestFile)).digest('hex') === info.licenseNoticeSha256;
  // Retained schema-2 receipts remain readable after a new patch is selected.
  // Generation trust is a separate exact-current-input check below.
  const supportedSchema2 = common
    && info.schemaVersion === 2
    && [OBJ2TILES_PATCH_SHA256, RETAINED_FULLRES_OBJ2TILES_PATCH_SHA256,
      OUTER_BOUNDED_OBJ2TILES_PATCH_SHA256].includes(info.patchSha256)
    && info.imageSharpVersion === OBJ2TILES_IMAGE_SHARP_VERSION
    && info.lockSetSha256 === (info.patchSha256 === OUTER_BOUNDED_OBJ2TILES_PATCH_SHA256
      ? OUTER_BOUNDED_LOCKSET_SHA256 : info.patchSha256 === RETAINED_FULLRES_OBJ2TILES_PATCH_SHA256
        ? RETAINED_FULLRES_OBJ2TILES_LOCKSET_SHA256 : OBJ2TILES_LOCKSET_SHA256)
    && info.licenseNoticeSha256 === OBJ2TILES_LICENSE_NOTICE_SHA256
    && licenseManifestMatches;
  if (!retainedLegacy && !supportedSchema2) {
    throw new Error('Obj2Tiles build information does not match the pinned source, patch, dependency locks, and license notices');
  }
  return Object.freeze({ ...info, binarySha256: info.binarySha256.toLowerCase() });
}

const runtimeForkInfo = runtimeForkBuildInfo();
const HISTORICAL_FORK_CONVERTER_BINARY_SHA256 = Object.freeze([
  '3577688939806dabdf1f4620cc05debe6e178180a99bf0308f4b8483b8a36725',
  // Actual installed staging399 binary, independently read on 2026-11-13.
  'a68fd91118342b106e521d064a11066611aadf089b79e67a16503fac082bb155',
]);
const HISTORICAL_CONTROLLED_CONVERTER_BINARY_SHA256 = Object.freeze([
  ...OFFICIAL_CONVERTER_BINARY_SHA256,
  ...HISTORICAL_FORK_CONVERTER_BINARY_SHA256,
]);
function currentControlledConverterBinarySha256(info) {
  const current = info?.schemaVersion === 2
    && info.sourceVersion === 'v1.6.2'
    && info.sourceSha256 === OBJ2TILES_SOURCE_SHA256
    && info.patchSha256 === OBJ2TILES_PATCH_SHA256
    && info.imageSharpVersion === OBJ2TILES_IMAGE_SHARP_VERSION
    && info.lockSetSha256 === OBJ2TILES_LOCKSET_SHA256
    && info.licenseNoticeSha256 === OBJ2TILES_LICENSE_NOTICE_SHA256
    && /^[a-f0-9]{64}$/.test(String(info.binarySha256 || ''));
  return Object.freeze(current
    ? [info.binarySha256.toLowerCase()]
    : []);
}
// Only the schema-2 ImageSharp 3.2.0 fork can generate current controlled
// provenance. Schema-1 and upstream binaries remain readable for historical
// receipts but cannot be relabeled as output from the current converter.
const CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256 = currentControlledConverterBinarySha256(runtimeForkInfo);
const CONTROLLED_CONVERTER_BINARY_SHA256 = Object.freeze([
  ...HISTORICAL_CONTROLLED_CONVERTER_BINARY_SHA256,
  ...CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256,
]);

async function verifyCurrentConverterBinary(filePath, trustedSha256 = CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256) {
  if (!Array.isArray(trustedSha256) || trustedSha256.length === 0) {
    throw new Error('current ImageSharp 3.2.0 Obj2Tiles build information is unavailable');
  }
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  const digest = hash.digest('hex');
  if (!trustedSha256.includes(digest)) {
    throw new Error('Obj2Tiles binary is not the current ImageSharp 3.2.0 converter');
  }
  return digest;
}
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
  '0280b96902e3614f4facd89e3d617c4a0cd86bf814c35a034b94a65d7c6842f0',
  '2adcf63c0508c0d6a6b82445f77f3ea7de053af611b16f55a61bb3e280abb47b',
  ...(CONTROLLED_CONVERTER_COMMAND_SHA256 === OUTER_BOUNDED_COMMAND_SHA256 ? []
    : [OUTER_BOUNDED_COMMAND_SHA256, OUTER_BOUNDED_SERIAL_COMMAND_SHA256]),
  CONTROLLED_CONVERTER_COMMAND_SHA256,
  SERIAL_RETRY_CONVERTER_COMMAND_SHA256,
]);
const ACCEPTED_CONTROLLED_CONVERTER_CONTRACTS = Object.freeze([
  Object.freeze({ converter: LEGACY_CONTROLLED_CONVERTER, commandSha256: LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256 }),
  Object.freeze({ converter: LEGACY_KTX2_CONVERTER, commandSha256: LEGACY_KTX2_CONVERTER_COMMAND_SHA256 }),
  Object.freeze({ converter: LEGACY_FORK_CONTROLLED_CONVERTER, commandSha256: '0280b96902e3614f4facd89e3d617c4a0cd86bf814c35a034b94a65d7c6842f0' }),
  Object.freeze({ converter: LEGACY_FORK_SERIAL_RETRY_CONVERTER, commandSha256: '2adcf63c0508c0d6a6b82445f77f3ea7de053af611b16f55a61bb3e280abb47b' }),
  ...(CONTROLLED_CONVERTER_COMMAND_SHA256 === OUTER_BOUNDED_COMMAND_SHA256 ? [] : [
    Object.freeze({ converter: OUTER_BOUNDED_CONVERTER, commandSha256: OUTER_BOUNDED_COMMAND_SHA256 }),
    Object.freeze({ converter: OUTER_BOUNDED_SERIAL_RETRY_CONVERTER, commandSha256: OUTER_BOUNDED_SERIAL_COMMAND_SHA256 }),
  ]),
  Object.freeze({ converter: CONTROLLED_CONVERTER, commandSha256: CONTROLLED_CONVERTER_COMMAND_SHA256 }),
  Object.freeze({ converter: SERIAL_RETRY_CONVERTER, commandSha256: SERIAL_RETRY_CONVERTER_COMMAND_SHA256 }),
]);

// Retained commands remain readable, but an older executable must never be
// relabeled as the new bounded-atlas generation profile.
function acceptedConverterBinaryCommand(commandSha256, binarySha256) {
  const command = String(commandSha256 || '').toLowerCase();
  const binary = String(binarySha256 || '').toLowerCase();
  if (!ACCEPTED_CONTROLLED_CONVERTER_COMMAND_SHA256.includes(command)) return false;
  const current = command === CONTROLLED_CONVERTER_COMMAND_SHA256
    || command === SERIAL_RETRY_CONVERTER_COMMAND_SHA256;
  return (current ? CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256
    : HISTORICAL_CONTROLLED_CONVERTER_BINARY_SHA256).includes(binary);
}

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
  acceptedConverterBinaryCommand,
  CONTROLLED_CONVERTER,
  CONTROLLED_CONVERTER_BINARY_SHA256,
  CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256,
  HISTORICAL_CONTROLLED_CONVERTER_BINARY_SHA256,
  currentControlledConverterBinarySha256,
  CONTROLLED_CONVERTER_COMMAND_SHA256,
  CONTROLLED_SURFACE_AUDIT_POLICY_V4,
  LEGACY_CONTROLLED_CONVERTER,
  LEGACY_CONTROLLED_CONVERTER_COMMAND_SHA256,
  LEGACY_KTX2_CONVERTER,
  LEGACY_KTX2_CONVERTER_COMMAND_SHA256,
  OBJ2TILES_PATCH_SHA256,
  RETAINED_FULLRES_OBJ2TILES_PATCH_SHA256,
  RETAINED_FULLRES_OBJ2TILES_LOCKSET_SHA256,
  OUTER_BOUNDED_OBJ2TILES_PATCH_SHA256,
  OUTER_BOUNDED_CONVERTER,
  OUTER_BOUNDED_SERIAL_RETRY_CONVERTER,
  OUTER_BOUNDED_COMMAND_SHA256,
  OUTER_BOUNDED_SERIAL_COMMAND_SHA256,
  LEGACY_OBJ2TILES_PATCH_SHA256,
  OBJ2TILES_LOCKSET_SHA256,
  OUTER_BOUNDED_LOCKSET_SHA256,
  OBJ2TILES_LICENSE_NOTICE_SHA256,
  OBJ2TILES_IMAGE_SHARP_VERSION,
  HISTORICAL_FORK_CONVERTER_BINARY_SHA256,
  LEGACY_FORK_CONTROLLED_CONVERTER,
  LEGACY_FORK_SERIAL_RETRY_CONVERTER,
  OBJ2TILES_SOURCE_SHA256,
  OFFICIAL_CONVERTER_BINARY_SHA256,
  SERIAL_RETRY_CONVERTER,
  SERIAL_RETRY_CONVERTER_COMMAND_SHA256,
  obj2TilesArguments,
  runtimeForkBuildInfo,
  verifyCurrentConverterBinary,
  stable,
};
