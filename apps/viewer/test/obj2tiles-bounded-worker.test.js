'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const {
  CONTROLLED_CONVERTER_BINARY_SHA256,
  CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256,
  HISTORICAL_CONTROLLED_CONVERTER_BINARY_SHA256,
  OBJ2TILES_PATCH_SHA256,
  LEGACY_OBJ2TILES_PATCH_SHA256,
  OBJ2TILES_LOCKSET_SHA256,
  OBJ2TILES_LICENSE_NOTICE_SHA256,
  OBJ2TILES_IMAGE_SHARP_VERSION,
  OBJ2TILES_SOURCE_SHA256,
  currentControlledConverterBinarySha256,
  runtimeForkBuildInfo,
  verifyCurrentConverterBinary,
} = require('../lod-converter-policy.cjs');
const {
  obj2TilesDiagnostics,
  run,
  runObj2TilesWithResourceRetry,
} = require('../server/derivativeWorker');

const root = path.resolve(__dirname, '..');

test('checked-out converter lock and notice bytes match the pinned build inputs', () => {
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const locks = path.join(root, 'third_party', 'obj2tiles', 'locks');
  const sums = path.join(locks, 'SHA256SUMS');
  assert.equal(digest(sums), OBJ2TILES_LOCKSET_SHA256);
  for (const line of fs.readFileSync(sums, 'utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line);
    assert.ok(match, 'valid pinned checksum entry');
    assert.equal(digest(path.join(locks, match[2])), match[1], match[2]);
  }
  const notices = path.join(root, 'third_party', 'imagesharp', '3.2.0');
  const manifest = path.join(notices, 'manifest.json');
  assert.equal(digest(manifest), OBJ2TILES_LICENSE_NOTICE_SHA256);
  for (const entry of JSON.parse(fs.readFileSync(manifest, 'utf8')).files) {
    assert.equal(digest(path.join(notices, entry.path)), entry.sha256, entry.path);
  }
});

test('Obj2Tiles source and fork patch are pinned fail-closed at image build and attested in CI', () => {
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const workflow = fs.readFileSync(path.resolve(root, '../../.github/workflows/publish-viewer.yml'), 'utf8');
  const patchBytes = fs.readFileSync(path.join(root, 'third_party', 'obj2tiles', 'v1.6.2-bounded-concurrency.patch'));
  assert.equal(crypto.createHash('sha256').update(patchBytes).digest('hex'), OBJ2TILES_PATCH_SHA256);
  assert.match(docker, new RegExp(`OBJ2TILES_SOURCE_SHA256=${OBJ2TILES_SOURCE_SHA256}`));
  assert.match(docker, new RegExp(`OBJ2TILES_PATCH_SHA256=${OBJ2TILES_PATCH_SHA256}`));
  assert.match(docker, /FROM mcr\.microsoft\.com\/dotnet\/sdk:10\.0\.203-noble@sha256:8a90a473da5205a16979de99d2fc20975e922c68304f5c79d564e666dc3982fc AS obj2tiles/);
  assert.match(docker, /sha256sum -c -[\s\S]*git apply --check \/tmp\/obj2tiles\.patch[\s\S]*git apply \/tmp\/obj2tiles\.patch/);
  assert.match(docker, /build-info\.json/);
  assert.doesNotMatch(docker, /PublishTrimmed=true/);
  const runtime = docker.slice(docker.indexOf('FROM node:24-bookworm-slim AS runtime'));
  assert.doesNotMatch(runtime, /curl|wget|dotnet publish/);
  assert.match(workflow, new RegExp(`EXPECTED_OBJ2TILES_SOURCE_SHA256: "${OBJ2TILES_SOURCE_SHA256}"`));
  assert.match(workflow, new RegExp(`EXPECTED_OBJ2TILES_PATCH_SHA256: "${OBJ2TILES_PATCH_SHA256}"`));
  assert.match(workflow, /build-info\.json[\s\S]*binarySha256!==binary/);
});

test('runtime fork trust rejects build metadata that is not bound to the pinned inputs', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obj2tiles-build-info-'));
  const file = path.join(directory, 'build-info.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const valid = {
    schemaVersion: 1,
    sourceVersion: 'v1.6.2',
    sourceSha256: OBJ2TILES_SOURCE_SHA256,
    patchSha256: LEGACY_OBJ2TILES_PATCH_SHA256,
    binarySha256: 'a'.repeat(64),
  };
  fs.writeFileSync(file, JSON.stringify(valid));
  assert.deepEqual(runtimeForkBuildInfo(file), valid);
  assert.deepEqual(currentControlledConverterBinarySha256(valid), [], 'schema-1 build metadata remains historical-only');
  fs.writeFileSync(file, JSON.stringify({ ...valid, patchSha256: 'b'.repeat(64) }));
  assert.throws(() => runtimeForkBuildInfo(file), /does not match the pinned source, patch, dependency locks, and license notices/);
  fs.writeFileSync(file, '{');
  assert.throws(() => runtimeForkBuildInfo(file), /malformed/);
});

test('ImageSharp build metadata binds the dependency locks and preserved license notices', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obj2tiles-imagesharp-build-info-'));
  const file = path.join(directory, 'build-info.json');
  const licenseManifestFile = path.join(directory, 'license-manifest.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, 'third_party', 'imagesharp', '3.2.0', 'manifest.json'), licenseManifestFile);
  const current = {
    schemaVersion: 2,
    sourceVersion: 'v1.6.2',
    sourceSha256: OBJ2TILES_SOURCE_SHA256,
    patchSha256: OBJ2TILES_PATCH_SHA256,
    imageSharpVersion: OBJ2TILES_IMAGE_SHARP_VERSION,
    lockSetSha256: OBJ2TILES_LOCKSET_SHA256,
    licenseNoticeSha256: OBJ2TILES_LICENSE_NOTICE_SHA256,
    binarySha256: 'b'.repeat(64),
  };
  fs.writeFileSync(file, JSON.stringify(current));
  assert.deepEqual(runtimeForkBuildInfo(file, licenseManifestFile), current);
  assert.deepEqual(currentControlledConverterBinarySha256(current), ['b'.repeat(64)]);
  fs.writeFileSync(licenseManifestFile, 'tampered');
  assert.throws(() => runtimeForkBuildInfo(file, licenseManifestFile), /dependency locks, and license notices/);
});

test('historical binaries remain receipt-readable but cannot enter the current generation allowlist', () => {
  assert.deepEqual(CONTROLLED_CONVERTER_BINARY_SHA256, [
    ...HISTORICAL_CONTROLLED_CONVERTER_BINARY_SHA256,
    ...CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256,
  ]);
  assert.ok(HISTORICAL_CONTROLLED_CONVERTER_BINARY_SHA256.includes(
    '3577688939806dabdf1f4620cc05debe6e178180a99bf0308f4b8483b8a36725',
  ));
  assert.ok(!CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256.includes(
    '3577688939806dabdf1f4620cc05debe6e178180a99bf0308f4b8483b8a36725',
  ));
});
test('fork patch bounds all outer tile work at two and ImageSharp work at one', () => {
  const source = fs.readFileSync(path.join(root, 'third_party', 'obj2tiles', 'v1.6.2-bounded-concurrency.patch'), 'utf8');
  assert.match(source, /Default\.MaxDegreeOfParallelism = opts\.ImageParallelism/);
  assert.match(source, /Default = 2[\s\S]*public int MaxParallelism/);
  assert.match(source, /Default = 1[\s\S]*public int ImageParallelism/);
  assert.match(source, /Process LODs sequentially so their bounded tile writers cannot multiply concurrency/);
  assert.match(source, /MaxDegreeOfParallelism = maxParallelism,[\s\S]*TaskScheduler = TaskScheduler\.Default/);
  assert.doesNotMatch(source, /b3dm_parallel_retry|ConvertFiles\(filesToConvert, gltfOptions, 1\)/);
  assert.match(source, /RuntimeDiagnostics\.Write\("pipeline_failure", ex\)/);
});

test('already serial conversion preserves pressure evidence without repeating or clearing it', async () => {
  const calls = [];
  let clears = 0;
  const pressure = Object.assign(new Error('TaskSchedulerException'), { resourcePressure: true });
  const runCommand = async (_bin, args) => {
    calls.push(args);
    if (calls.length === 1) throw pressure;
    return { resourcePressure: false };
  };
  await assert.rejects(runObj2TilesWithResourceRetry({
    bin: 'converter', source: 'source.obj', output: 'token.incomplete',
    deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
    verifyConverterBinary: async () => 'b'.repeat(64),
    clearIncomplete: () => { clears += 1; }, runCommand,
  }), error => {
    assert.equal(error, pressure);
    assert.equal(error.serialRetryAttempted, false);
    assert.equal(error.resourcePressureEvidence.resourcePressure, true);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--max-parallelism') + 1], '1');
  assert.equal(clears, 0);

  let semanticCalls = 0;
  await assert.rejects(runObj2TilesWithResourceRetry({
    bin: 'converter', source: 'source.obj', output: 'token.incomplete',
    deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
    verifyConverterBinary: async () => 'b'.repeat(64),
    clearIncomplete: () => { throw new Error('must not clear'); },
    runCommand: async () => { semanticCalls += 1; throw new Error('invalid OBJ material'); },
  }), /invalid OBJ material/);
  assert.equal(semanticCalls, 1);

  const cancelled = new AbortController();
  let cancelledCalls = 0;
  let cancelledClears = 0;
  await assert.rejects(runObj2TilesWithResourceRetry({
    bin: 'converter', source: 'source.obj', output: 'token.incomplete',
    deadlineAt: Date.now() + 60_000, signal: cancelled.signal,
    verifyConverterBinary: async () => 'b'.repeat(64),
    clearIncomplete: () => { cancelledClears += 1; },
    runCommand: async () => { cancelledCalls += 1; cancelled.abort(new Error('lease lost')); throw pressure; },
  }), /TaskSchedulerException/);
  assert.equal(cancelledCalls, 1);
  assert.equal(cancelledClears, 0);

  let successfulCalls = 0;
  const success = await runObj2TilesWithResourceRetry({
    bin: 'converter', source: 'source.obj', output: 'token.incomplete',
    deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
    verifyConverterBinary: async () => 'b'.repeat(64),
    clearIncomplete: () => { throw new Error('successful conversion must not clear evidence'); },
    runCommand: async () => {
      successfulCalls += 1;
      return { resourcePressure: false };
    },
  });
  assert.equal(successfulCalls, 1);
  assert.equal(success.serialRetry, false);
});

test('converter trust is checked before any child process can run', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-obj2tiles-'));
  const binaryPath = path.join(directory, 'obj2tiles');
  const oldBinary = Buffer.from('historical ImageSharp 3.1.12 Obj2Tiles binary');
  const currentBinary = Buffer.from('current ImageSharp 3.2.0 Obj2Tiles binary');
  fs.writeFileSync(binaryPath, oldBinary);
  const currentDigest = crypto.createHash('sha256').update(currentBinary).digest('hex');
  let childRuns = 0;
  try {
    await assert.rejects(runObj2TilesWithResourceRetry({
      bin: binaryPath, source: 'source.obj', output: 'token.incomplete',
      deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
      verifyConverterBinary: (file) => verifyCurrentConverterBinary(file, [currentDigest]),
      clearIncomplete: () => {},
      runCommand: async () => { childRuns += 1; return {}; },
    }), /not the current ImageSharp 3\.2\.0 converter/);
    assert.equal(childRuns, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('converter diagnostics are structured, bounded, and captured by the process runner', async () => {
  const diagnostic = { schemaVersion: 1, resourcePressure: true, eventName: 'pipeline_failure', secret: 'C:\\private\\asset.obj' };
  const parsed = obj2TilesDiagnostics(`noise\nOBJ2TILES_DIAGNOSTIC ${JSON.stringify(diagnostic)}\n`);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].resourcePressure, true);
  assert.notEqual(parsed[0].secret, diagnostic.secret);

  const childCode = `process.stderr.write('OBJ2TILES_DIAGNOSTIC '+JSON.stringify(${JSON.stringify({ schemaVersion: 1, resourcePressure: true, eventName: 'test' })})+'\\n')`;
  const result = await run(process.execPath, ['-e', childCode], { timeoutMs: 10_000 });
  assert.equal(result.resourcePressure, true);
  assert.equal(result.converterDiagnostics[0].eventName, 'test');
});
