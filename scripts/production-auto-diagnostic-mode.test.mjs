import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTION_AUTO_RUNTIME_MODES, runProductionAutoRelease } from './production-auto-runtime.mjs';
import { createReadonlyDiagnosticSink } from './production-auto-readonly-guard.mjs';
import { productionAutoStartupFailure } from './production-auto-startup-diagnostics.mjs';

const SHA = 'b'.repeat(40);
const ON = Object.freeze({ PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'true', PRODUCTION_AUTO_RELEASE_ENABLED: 'false' });
const stubs = (record = {}) => ({
  recipientLoader: () => ({}),
  triggerReader: env => { record.triggerEnv = env; return { sourceCommit: SHA, runId: 7, runAttempt: 1 }; },
  sourceReader: () => SHA,
});
/** An adapter whose first coordinator step fails, so the coordinator stops there; it records what reached it. */
function fakeFactory(record) {
  return options => {
    record.options = options;
    const adapter = Object.fromEntries(['capture', 'sourceFence', 'ciGate', 'build', 'readLedger', 'readOldAssets', 'upload', 'candidateReadback',
      'stageZero', 'verifyAssets', 'activate', 'readDeployment', 'recordIntent', 'receipt']
      .map(name => [name, async () => { (record.calls ??= []).push(name); throw Error('fixture_stop'); }]));
    return { adapter };
  };
}
const stageOf = async promise => { try { await promise; return 'resolved'; } catch (error) { return productionAutoStartupFailure(error); } };

test('there are exactly two modes and release is the default', () => {
  assert.deepEqual(PRODUCTION_AUTO_RUNTIME_MODES, ['release', 'readonly_diagnostic']);
});

test('release mode is unchanged: its own gate only, and it refuses a diagnostic sink', async () => {
  for (const env of [{ PRODUCTION_AUTO_RELEASE_ENABLED: 'false', PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'true' }, {}])
    await assert.rejects(runProductionAutoRelease({ workerName: 'ledgetop-clients', env, ...stubs() }), /production_auto_release_disabled/u);
  const record = {};
  await assert.rejects(runProductionAutoRelease({ workerName: 'ledgetop-clients', env: { PRODUCTION_AUTO_RELEASE_ENABLED: 'true' },
    diagnostic: createReadonlyDiagnosticSink(), ...stubs(record) }), /runtime_mode_refused/u);
  assert.equal(record.triggerEnv, undefined, 'refused at the gate, before the trigger is read');
  // With the release gate on, release mode gets the caller's own transport and adapter, unwrapped.
  const rec = {}, fetchImpl = async () => new Response('{}');
  await stageOf(runProductionAutoRelease({ workerName: 'ledgetop-clients', env: { PRODUCTION_AUTO_RELEASE_ENABLED: 'true' }, fetchImpl,
    ...stubs(rec), runtimeFactory: fakeFactory(rec) }));
  assert.equal(rec.options.fetchImpl, fetchImpl);
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
    const record = {};
    await assert.rejects(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: ON,
      diagnostic: createReadonlyDiagnosticSink(), ...stubs(record), ...overrides }), /production_auto_diagnostic_refused/u, why);
    assert.equal(record.triggerEnv, undefined, `${why}: refused before the trigger is read`);
  }
  for (const [why, overrides] of [['no sink', { diagnostic: null }], ['bad sink', { diagnostic: { refused: [] } }], ['unknown mode', { mode: 'dry_run' }]])
    await assert.rejects(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: ON,
      diagnostic: createReadonlyDiagnosticSink(), ...stubs(), ...overrides }), /runtime_mode_refused/u, why);
});

test('readonly_diagnostic never substitutes the release gate and runs the same trigger and source fences', async () => {
  const record = {};
  await stageOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: ON,
    diagnostic: createReadonlyDiagnosticSink(), ...stubs(record), runtimeFactory: fakeFactory(record) }));
  assert.equal(record.triggerEnv.PRODUCTION_AUTO_RELEASE_ENABLED, 'false');
  assert.equal(record.options.env.PRODUCTION_AUTO_RELEASE_ENABLED, 'false');
  assert.equal(record.options.sourceCommit, SHA);
  const mismatch = await stageOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: ON,
    diagnostic: createReadonlyDiagnosticSink(), ...stubs(), sourceReader: () => 'c'.repeat(40), runtimeFactory: fakeFactory({}) }));
  assert.equal(mismatch.stage, 'source', 'the trigger/source fence still applies');
});

test('the runtime wraps the transport before the factory sees it: writes and unpinned targets are refused, never sent', async () => {
  const record = {}, sent = [], sink = createReadonlyDiagnosticSink();
  const fetchImpl = async (input, init) => { sent.push({ url: String(input), redirect: init?.redirect }); return new Response('{}'); };
  await stageOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: ON, diagnostic: sink, fetchImpl,
    ...stubs(record), runtimeFactory: fakeFactory(record) }));
  const transport = record.options.fetchImpl;
  assert.notEqual(transport, fetchImpl);
  const account = 'https://api.cloudflare.com/client/v4/accounts/846c924bf17bf4f3dd15c97a4c5d1d51';
  await assert.rejects(transport(`${account}/workers/scripts/ledgetop-clients`, { method: 'PUT', body: 'x' }), /probe_refused_non_read_request/u);
  await assert.rejects(transport('https://example.com/x'), /probe_refused_non_read_request/u);
  await transport(`${account}/workers/scripts/ledgetop-clients/settings`);
  assert.deepEqual(sent, [{ url: `${account}/workers/scripts/ledgetop-clients/settings`, redirect: 'error' }]);
  assert.deepEqual(sink.refused, [{ method: 'PUT', category: 'refused_cloudflare_write' }, { method: 'GET', category: 'refused_other_host' }]);
});

test('the runtime wraps the adapter the factory returns: steps are recorded by fixed name and the coordinator sees the wrapper', async () => {
  const record = {}, sink = createReadonlyDiagnosticSink();
  await stageOf(runProductionAutoRelease({ mode: 'readonly_diagnostic', workerName: 'ledgetop-clients', env: ON, diagnostic: sink,
    ...stubs(record), runtimeFactory: fakeFactory(record) }));
  assert.deepEqual(sink.counts.entered, ['sourceFence'], 'the coordinator called the guarded adapter');
  assert.deepEqual(sink.counts.completed, []);
  assert.deepEqual(record.calls, ['sourceFence'], 'the held receipt never reached the real adapter');
  assert.ok(sink.counts.receiptsSkipped >= 1, 'the coordinator\'s held receipt became a counted no-op');
  // Release mode with the same factory is not wrapped: the coordinator's held receipt reaches the real adapter.
  const plain = {};
  await stageOf(runProductionAutoRelease({ workerName: 'ledgetop-clients', env: { PRODUCTION_AUTO_RELEASE_ENABLED: 'true' }, ...stubs(plain),
    runtimeFactory: fakeFactory(plain) }));
  assert.deepEqual(plain.calls, ['sourceFence', 'receipt']);
});
