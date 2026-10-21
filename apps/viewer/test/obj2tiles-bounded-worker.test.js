'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const {
  OBJ2TILES_PATCH_SHA256,
  OBJ2TILES_SOURCE_SHA256,
  runtimeForkBuildInfo,
} = require('../lod-converter-policy.cjs');
const {
  obj2TilesDiagnostics,
  run,
  runObj2TilesWithResourceRetry,
} = require('../server/derivativeWorker');

const root = path.resolve(__dirname, '..');

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
    patchSha256: OBJ2TILES_PATCH_SHA256,
    binarySha256: 'a'.repeat(64),
  };
  fs.writeFileSync(file, JSON.stringify(valid));
  assert.deepEqual(runtimeForkBuildInfo(file), valid);
  fs.writeFileSync(file, JSON.stringify({ ...valid, patchSha256: 'b'.repeat(64) }));
  assert.throws(() => runtimeForkBuildInfo(file), /does not match the pinned source and patch contract/);
  fs.writeFileSync(file, '{');
  assert.throws(() => runtimeForkBuildInfo(file), /malformed/);
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

test('whole conversion retries exactly once at one worker only for explicit resource pressure', async () => {
  const calls = [];
  let clears = 0;
  const pressure = Object.assign(new Error('TaskSchedulerException'), { resourcePressure: true });
  const runCommand = async (_bin, args) => {
    calls.push(args);
    if (calls.length === 1) throw pressure;
    return { resourcePressure: false };
  };
  const result = await runObj2TilesWithResourceRetry({
    bin: 'converter', source: 'source.obj', output: 'token.incomplete',
    deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
    clearIncomplete: () => { clears += 1; }, runCommand,
  });
  assert.equal(result.serialRetry, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][calls[0].indexOf('--max-parallelism') + 1], '2');
  assert.equal(calls[1][calls[1].indexOf('--max-parallelism') + 1], '1');
  assert.equal(clears, 1);

  let semanticCalls = 0;
  await assert.rejects(runObj2TilesWithResourceRetry({
    bin: 'converter', source: 'source.obj', output: 'token.incomplete',
    deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
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
    clearIncomplete: () => { cancelledClears += 1; },
    runCommand: async () => { cancelledCalls += 1; cancelled.abort(new Error('lease lost')); throw pressure; },
  }), /TaskSchedulerException/);
  assert.equal(cancelledCalls, 1);
  assert.equal(cancelledClears, 0);

  let pressureCalls = 0;
  await assert.rejects(runObj2TilesWithResourceRetry({
    bin: 'converter', source: 'source.obj', output: 'token.incomplete',
    deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
    clearIncomplete: () => {},
    runCommand: async () => {
      pressureCalls += 1;
      if (pressureCalls === 1) throw pressure;
      throw new Error('semantic failure during serial retry');
    },
  }), (error) => {
    assert.match(error.message, /semantic failure/);
    assert.equal(error.serialRetryAttempted, true);
    assert.equal(error.resourcePressureEvidence.resourcePressure, true);
    return true;
  });
  assert.equal(pressureCalls, 2);
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
