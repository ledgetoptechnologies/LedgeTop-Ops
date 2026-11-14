'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const policy = require('../lod-converter-policy.cjs');
const digest = value => crypto.createHash('sha256').update(policy.stable(value)).digest('hex');

test('retained converter contracts still describe their exact recorded command hashes', () => {
  for (const { converter, commandSha256 } of policy.ACCEPTED_CONTROLLED_CONVERTER_CONTRACTS) {
    assert.equal(digest(converter), commandSha256);
  }
  assert.equal(digest(policy.LEGACY_FORK_CONTROLLED_CONVERTER),
    '0280b96902e3614f4facd89e3d617c4a0cd86bf814c35a034b94a65d7c6842f0');
  assert.equal(digest(policy.LEGACY_FORK_SERIAL_RETRY_CONVERTER),
    '2adcf63c0508c0d6a6b82445f77f3ea7de053af611b16f55a61bb3e280abb47b');
  assert.equal(digest(policy.OUTER_BOUNDED_CONVERTER),
    'f627b934a2e4abbad04fc85e4689cabc791251eac7f333c4a1575d198f9ee117');
  assert.equal(digest(policy.OUTER_BOUNDED_SERIAL_RETRY_CONVERTER),
    'a1a4824dae509fa212736398cecc437275705d6b091a11b0f0f71f8a243a935b');
});

test('retained schema2 metadata remains readable after selection of a different current patch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'converter-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = path.resolve(__dirname, '../third_party/imagesharp/3.2.0/manifest.json');
  const info = {
    schemaVersion: 2, sourceVersion: 'v1.6.2',
    sourceSha256: policy.OBJ2TILES_SOURCE_SHA256,
    patchSha256: policy.OUTER_BOUNDED_OBJ2TILES_PATCH_SHA256,
    imageSharpVersion: policy.OBJ2TILES_IMAGE_SHARP_VERSION,
    lockSetSha256: policy.OUTER_BOUNDED_LOCKSET_SHA256,
    licenseNoticeSha256: policy.OBJ2TILES_LICENSE_NOTICE_SHA256,
    binarySha256: 'a68fd91118342b106e521d064a11066611aadf089b79e67a16503fac082bb155',
  };
  const file = path.join(root, 'build-info.json');
  fs.writeFileSync(file, JSON.stringify(info));
  const currentPatch = 'c'.repeat(64);
  const source = fs.readFileSync(path.resolve(__dirname, '../lod-converter-policy.cjs'), 'utf8')
    .replace(/const OBJ2TILES_PATCH_SHA256 = '[a-f0-9]{64}';/,
      `const OBJ2TILES_PATCH_SHA256 = '${currentPatch}';`);
  // This VM represents a different future policy. Its eager default lookup
  // must not read the host's current converter metadata; explicit fixture and
  // license-manifest paths below still use the real filesystem.
  const fixtureFs = {
    ...fs,
    existsSync(filePath) {
      if (filePath === '/opt/obj2tiles/build-info.json') return false;
      return fs.existsSync(filePath);
    },
  };
  const context = {
    require: name => name === 'node:fs' ? fixtureFs : require(name),
    module: { exports: {} },
  };
  vm.runInNewContext(source, context);
  const future = context.module.exports;
  assert.equal(future.OBJ2TILES_PATCH_SHA256, currentPatch);
  assert.equal(future.runtimeForkBuildInfo(file, manifest).binarySha256, info.binarySha256);
  assert.equal(future.currentControlledConverterBinarySha256(info).length, 0,
    'retained metadata must never grant current generation trust');
  info.patchSha256 = 'd'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(info));
  assert.throws(() => future.runtimeForkBuildInfo(file, manifest), /does not match/);
});

test('generation trust requires exact current build inputs, not schema2 plus any binary hash', () => {
  const current = {
    schemaVersion: 2, sourceVersion: 'v1.6.2',
    sourceSha256: policy.OBJ2TILES_SOURCE_SHA256,
    patchSha256: policy.OBJ2TILES_PATCH_SHA256,
    imageSharpVersion: policy.OBJ2TILES_IMAGE_SHARP_VERSION,
    lockSetSha256: policy.OBJ2TILES_LOCKSET_SHA256,
    licenseNoticeSha256: policy.OBJ2TILES_LICENSE_NOTICE_SHA256,
    binarySha256: 'b'.repeat(64),
  };
  assert.deepEqual(policy.currentControlledConverterBinarySha256(current), [current.binarySha256]);
  assert.deepEqual(policy.currentControlledConverterBinarySha256({ schemaVersion: 2, binarySha256: current.binarySha256 }), []);
  for (const key of Object.keys(current)) {
    const invalid = { ...current, [key]: key === 'schemaVersion' ? 1 : 'unqualified' };
    assert.deepEqual(policy.currentControlledConverterBinarySha256(invalid), [], key);
  }
});

test('new full-resolution command binds serial execution and uncapped source density to the new patch', () => {
  const args = policy.obj2TilesArguments('source.obj', 'output');
  assert.equal(args[args.indexOf('--max-texture-size') + 1], '0');
  assert.equal(args[args.indexOf('--max-parallelism') + 1], '1');
  assert.equal(args[args.indexOf('--image-parallelism') + 1], '1');
  assert.equal(policy.CONTROLLED_CONVERTER.fork.patchSha256, policy.OBJ2TILES_PATCH_SHA256);
  assert.notEqual(policy.OBJ2TILES_PATCH_SHA256, policy.OUTER_BOUNDED_OBJ2TILES_PATCH_SHA256);
  assert.notEqual(policy.CONTROLLED_CONVERTER_COMMAND_SHA256, policy.OUTER_BOUNDED_COMMAND_SHA256);
  assert.ok(policy.ACCEPTED_CONTROLLED_CONVERTER_COMMAND_SHA256.includes(policy.OUTER_BOUNDED_SERIAL_COMMAND_SHA256));
});

test('current fingerprints reject every historical binary while retained receipts stay readable', () => {
  for (const binary of policy.HISTORICAL_CONTROLLED_CONVERTER_BINARY_SHA256) {
    assert.equal(policy.acceptedConverterBinaryCommand(policy.CONTROLLED_CONVERTER_COMMAND_SHA256, binary), false);
    assert.equal(policy.acceptedConverterBinaryCommand(policy.SERIAL_RETRY_CONVERTER_COMMAND_SHA256, binary), false);
  }
  const historical = 'a68fd91118342b106e521d064a11066611aadf089b79e67a16503fac082bb155';
  assert.equal(policy.acceptedConverterBinaryCommand(policy.OUTER_BOUNDED_COMMAND_SHA256, historical), true);
  assert.equal(policy.acceptedConverterBinaryCommand(policy.OUTER_BOUNDED_SERIAL_COMMAND_SHA256, historical), true);
  assert.equal(policy.acceptedConverterBinaryCommand('f'.repeat(64), historical), false);
});
