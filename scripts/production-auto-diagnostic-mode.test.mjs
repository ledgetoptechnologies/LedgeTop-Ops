import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_AUTO_RUNTIME_MODES, runProductionAutoRelease } from './production-auto-runtime.mjs';
import { createReadonlyDiagnosticSink, guardReadonlyDiagnosticRuntime } from './production-auto-readonly-guard.mjs';
import { productionAutoStartupFailure } from './production-auto-startup-diagnostics.mjs';
import { coordinateProductionAutoRelease } from './production-auto-coordinate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHA = 'b'.repeat(40);
const ON = Object.freeze({ PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'true', PRODUCTION_AUTO_RELEASE_ENABLED: 'false' });
const stubs = (record = {}) => ({
  recipientLoader: () => ({}),
  triggerReader: env => { record.triggerEnv = env; return { sourceCommit: SHA, runId: 7, runAttempt: 1 }; },
  sourceReader: () => SHA,
});
const STEPS = ['capture', 'sourceFence', 'ciGate', 'build', 'readLedger', 'readOldAssets', 'upload', 'candidateReadback',
  'stageZero', 'verifyAssets', 'activate', 'readDeployment', 'recordIntent', 'receipt'];
/** An adapter whose every step fails and records that it was reached. */
function fakeFactory(record) {
  return options => {
    record.options = options;
    return { adapter: Object.fromEntries(STEPS.map(name => [name, async () => { (record.calls ??= []).push(name); throw Error('fixture_stop'); }])) };
  };
}
const failureOf = async promise => { try { await promise; return 'resolved'; } catch (error) { return productionAutoStartupFailure(error); } };
/** A real workflow_run event file (the runtime's own trigger reader validates it). */
function eventFile(sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-event-')), file = path.join(dir, 'event.json');
  fs.writeFileSync(file, JSON.stringify({ workflow_run: { name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'completed',
    conclusion: 'success', head_branch: 'main', repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' },
    head_repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' }, id: 42, run_attempt: 1, head_sha: sha } }));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('there are exactly two modes and release is the default', () => {
  assert.deepEqual(PRODUCTION_AUTO_RUNTIME_MODES, ['release', 'readonly_diagnostic']);
});

test('release mode is unchanged: its own gate only, it refuses a diagnostic sink, and its transport is not wrapped', async () => {
  for (const env of [{ PRODUCTION_AUTO_RELEASE_ENABLED: 'false', PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'true' }, {}])
    await assert.rejects(runProductionAutoRelease({ workerName: 'ledgetop-clients', env, ...stubs() }), /production_auto_release_disabled/u);
  const record = {};
  await assert.rejects(runProductionAutoRelease({ workerName: 'ledgetop-clients', env: { PRODUCTION_AUTO_RELEASE_ENABLED: 'true' },
    diagnostic: createReadonlyDiagnosticSink(), ...stubs(record) }), /runtime_mode_refused/u);
  assert.equal(record.triggerEnv, undefined, 'refused at the gate, before the trigger is read');
  const rec = {}, fetchImpl = async () => new Response('{}');
  await failureOf(runProductionAutoRelease({ workerName: 'ledgetop-clients', env: { PRODUCTION_AUTO_RELEASE_ENABLED: 'true' }, fetchImpl,
    ...stubs(rec), runtimeFactory: fakeFactory(rec) }));
  assert.equal(rec.options.fetchImpl, fetchImpl);
  assert.deepEqual(rec.calls, ['sourceFence', 'receipt'], 'release mode: the held receipt reaches the real adapter');
});

test('readonly_diagnostic has its own gate: opt-in on, global release exactly OFF, Client lane, a valid sink', async () => {
  for (const [why, overrides] of [
    ['release on', { env: { ...ON, PRODUCTION_AUTO_RELEASE_ENABLED: 'true' } }],
    ['release unset', { env: { PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'true' } }],
    ['release empty', { env: { ...ON, PRODUCTION_AUTO_RELEASE_ENABLED: '' } }],
    ['opt-in off', { env: { PRODUCTION_AUTO_RELEASE_ENABLED: 'false' } }],
    ['opt-in other case', { env: { ...ON, PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'TRUE' } }],
    ['ops lane', { workerName: 'ledgetop-ops' }],
  ]) {
    const failure = await failureOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: ON,
      diagnostic: createReadonlyDiagnosticSink(), ...overrides }));
    assert.deepEqual([failure.stage, failure.reason], ['gate', 'production_auto_diagnostic_refused'], why);
  }
  for (const [why, overrides] of [['no sink', { diagnostic: null }], ['bad sink', { diagnostic: { refused: [] } }], ['unknown mode', { mode: 'dry_run' }]]) {
    const failure = await failureOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: ON,
      diagnostic: createReadonlyDiagnosticSink(), ...overrides }));
    assert.deepEqual([failure.stage, failure.reason], ['gate', 'runtime_mode_refused'], why);
  }
});

test('readonly_diagnostic refuses every caller-injected transport, factory, recipient, trigger or source reader before invoking any of them', async () => {
  const names = ['fetchImpl', 'runtimeFactory', 'recipientLoader', 'triggerReader', 'sourceReader'];
  for (const name of names) {
    const invoked = [];
    const spy = label => (...args) => { invoked.push(label); return label === 'fetchImpl' ? Promise.resolve(new Response('{}')) : {}; };
    const failure = await failureOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: ON,
      diagnostic: createReadonlyDiagnosticSink(), [name]: spy(name) }));
    assert.deepEqual([failure.stage, failure.reason], ['gate', 'runtime_diagnostic_injection_refused'], name);
    assert.deepEqual(invoked, [], `${name} was never called`);
  }
  // All injected at once, including on an otherwise refused gate: still nothing is invoked.
  const invoked = [];
  const all = Object.fromEntries(names.map(name => [name, () => { invoked.push(name); return {}; }]));
  for (const env of [ON, { ...ON, PRODUCTION_AUTO_RELEASE_ENABLED: 'true' }])
    await failureOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env, diagnostic: createReadonlyDiagnosticSink(), ...all }));
  assert.deepEqual(invoked, []);
});

test('release mode keeps its injection behaviour and order: the recipient loader runs, then its own gate', async () => {
  const order = [];
  await failureOf(runProductionAutoRelease({ workerName: 'ledgetop-clients', env: {}, recipientLoader: () => { order.push('recipient'); return {}; },
    triggerReader: () => { order.push('trigger'); } }));
  assert.deepEqual(order, ['recipient'], 'release mode: recipient first, then held at its gate before the trigger');
});

test('with only the built-in defaults, the authentic trigger and real git source fences run unchanged and the gate value is not substituted', async () => {
  // No workflow_run event: the real trigger reader holds it.
  const missing = await failureOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: { ...ON },
    diagnostic: createReadonlyDiagnosticSink() }));
  assert.equal(missing.stage, 'trigger_env');
  // A valid CI event for a commit this checkout is not (or a dirty checkout): the real source fence holds it.
  const event = eventFile('c'.repeat(40));
  try {
    const env = { ...process.env, ...ON, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: event.file };
    for (const key of Object.keys(env)) if (/^GIT_/u.test(key)) delete env[key];
    const sink = createReadonlyDiagnosticSink();
    const failure = await failureOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env, diagnostic: sink }));
    assert.equal(failure.stage, 'source');
    assert.equal(env.PRODUCTION_AUTO_RELEASE_ENABLED, 'false');
    assert.deepEqual(sink.refused, [], 'nothing reached the network before the source fence');
  } finally { event.cleanup(); }
});

test('the runtime-owned wiring guards the transport before the factory sees it: writes and unpinned targets are never sent', async () => {
  const record = {}, sent = [], sink = createReadonlyDiagnosticSink();
  const fetchImpl = async (input, init) => { sent.push({ url: String(input), redirect: init?.redirect }); return new Response('{}'); };
  const wiring = guardReadonlyDiagnosticRuntime({ fetchImpl, runtimeFactory: fakeFactory(record), sink });
  assert.ok(Object.isFrozen(wiring));
  wiring.runtimeFactory({ fetchImpl: async () => { throw Error('a caller-supplied transport must be replaced'); } });
  const transport = record.options.fetchImpl;
  assert.equal(transport, wiring.fetchImpl, 'the factory always receives the guarded transport');
  const account = 'https://api.cloudflare.com/client/v4/accounts/846c924bf17bf4f3dd15c97a4c5d1d51';
  await assert.rejects(transport(`${account}/workers/scripts/ledgetop-clients`, { method: 'PUT', body: 'x' }), /probe_refused_non_read_request/u);
  await assert.rejects(transport('https://example.com/x'), /probe_refused_non_read_request/u);
  await transport(`${account}/workers/scripts/ledgetop-clients/settings`);
  assert.deepEqual(sent, [{ url: `${account}/workers/scripts/ledgetop-clients/settings`, redirect: 'error' }]);
  assert.deepEqual(sink.refused, [{ method: 'PUT', category: 'refused_cloudflare_write' }, { method: 'GET', category: 'refused_other_host' }]);
});

test('the runtime-owned wiring guards the adapter: the real coordinator sees the frozen wrapper and its held receipt is a no-op', async () => {
  const record = {}, sink = createReadonlyDiagnosticSink();
  const runtime = guardReadonlyDiagnosticRuntime({ fetchImpl: async () => new Response('{}'), runtimeFactory: fakeFactory(record), sink }).runtimeFactory({});
  assert.ok(Object.isFrozen(runtime) && Object.isFrozen(runtime.adapter));
  await assert.rejects(coordinateProductionAutoRelease({ accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', workerName: 'ledgetop-clients', sourceCommit: SHA,
    adapter: runtime.adapter }));
  assert.deepEqual(sink.counts.entered, ['sourceFence']);
  assert.deepEqual(record.calls, ['sourceFence'], 'the held receipt never reached the real adapter');
  assert.ok(sink.counts.receiptsSkipped >= 1);
});

test('the runtime uses the guarded wiring in diagnostic mode and passes it the caller-free defaults', () => {
  const source = fs.readFileSync(path.join(here, 'production-auto-runtime.mjs'), 'utf8').replace(/\r\n/gu, '\n');
  assert.match(source, /const wiring = readonly \? guardReadonlyDiagnosticRuntime\(\{ fetchImpl, runtimeFactory, sink: diagnostic \}\) : \{ fetchImpl, runtimeFactory \};/u);
  assert.match(source, /wiring\.runtimeFactory\(\{ workerName, sourceCommit, triggerRun, env, fetchImpl: wiring\.fetchImpl,/u);
  assert.match(source, /need\(fetchImpl === globalThis\.fetch && runtimeFactory === createProductionAutoReleaseAdapter && recipientLoader === loadPinnedProductionAutoRecipient\n\s+&& triggerReader === readProductionAutoTriggerRun && sourceReader === deploymentSourceCommit, 'runtime_diagnostic_injection_refused'\);/u);
  assert.doesNotMatch(source, /PRODUCTION_AUTO_RELEASE_ENABLED: 'true'/u, 'no gate substitution anywhere in the runtime');
});
