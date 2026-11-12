import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { boundedReport, diagnosticEnvironment, runDiagnostic, PROBE_OUTPUT_LIMIT, PROBE_REFUSAL_LIMIT } from './production-auto-diagnostic-run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = Object.freeze({ PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'true', PRODUCTION_AUTO_RELEASE_ENABLED: 'false',
  PRODUCTION_AUTO_WORKER: 'ledgetop-clients', GITHUB_EVENT_NAME: 'workflow_run', PRODUCTION_AUTO_PROBE_CHECKOUT: '/w' });

test('runs only with the diagnostic opt-in on, the global release exactly OFF, the Client lane and workflow_run', () => {
  const probeEnv = diagnosticEnvironment(base);
  assert.equal(probeEnv.PRODUCTION_AUTO_RELEASE_ENABLED, 'true', 'gate substituted in the probe env copy only');
  assert.equal(base.PRODUCTION_AUTO_RELEASE_ENABLED, 'false', 'caller env untouched');
  assert.ok(Object.isFrozen(probeEnv));
  for (const [key, value, reason] of [
    ['PRODUCTION_AUTO_DIAGNOSTIC_ENABLED', undefined, 'diagnostic_opt_in_off'], ['PRODUCTION_AUTO_DIAGNOSTIC_ENABLED', 'TRUE', 'diagnostic_opt_in_off'],
    ['PRODUCTION_AUTO_RELEASE_ENABLED', 'true', 'global_release_not_off'], ['PRODUCTION_AUTO_RELEASE_ENABLED', undefined, 'global_release_not_off'],
    ['PRODUCTION_AUTO_RELEASE_ENABLED', '', 'global_release_not_off'], ['PRODUCTION_AUTO_WORKER', 'ledgetop-ops', 'lane'],
    ['GITHUB_EVENT_NAME', 'workflow_dispatch', 'event'], ['PRODUCTION_AUTO_PROBE_CHECKOUT', '', 'checkout'],
  ]) assert.throws(() => diagnosticEnvironment({ ...base, [key]: value }), new RegExp(`diagnostic_refused: ${reason}$`, 'u'), `${key}=${value}`);
});

test('a refused environment never calls the probe', async () => {
  let called = 0;
  const result = await runDiagnostic({ env: { ...base, PRODUCTION_AUTO_RELEASE_ENABLED: 'true' }, probe: async () => { called++; } });
  assert.equal(called, 0);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.line), { status: 'refused', reason: 'global_release_not_off' });
});

test('the probe gets the substituted env; held and boundary outcomes are diagnoses (exit 0), others are not', async () => {
  let seen;
  const held = await runDiagnostic({ env: base, probe: async ({ env }) => { seen = env; return { status: 'held_before_first_write', stage: 'coordination',
    reason: 'release_held', phase: 'build', cause: 'runtime_build_failed', readStepsEntered: ['sourceFence', 'ciGate', 'build'],
    readStepsCompleted: ['sourceFence', 'ciGate'], failedReadStep: 'build', blockedSteps: {}, receiptsSkipped: 0, refusedRequests: [] }; } });
  assert.equal(seen.PRODUCTION_AUTO_RELEASE_ENABLED, 'true');
  assert.equal(held.exitCode, 0);
  assert.equal(JSON.parse(held.line).cause, 'runtime_build_failed');
  assert.equal(JSON.parse(held.line).failedReadStep, 'build');
  assert.equal((await runDiagnostic({ env: base, probe: async () => ({ status: 'reached_first_write_boundary', blockedSteps: { readOldAssets: 1 } }) })).exitCode, 0);
  assert.equal((await runDiagnostic({ env: base, probe: async () => ({ status: 'unexpected_completion' }) })).exitCode, 1);
  const thrown = await runDiagnostic({ env: base, probe: async () => { throw new Error('secret https://host/path?token=abc'); } });
  assert.equal(thrown.exitCode, 3);
  assert.deepEqual(JSON.parse(thrown.line), { status: 'probe_error' }, 'no error text leaks');
});

test('a hung probe is bounded by the timeout', async () => {
  const result = await runDiagnostic({ env: base, probe: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(result.exitCode, 3);
  assert.deepEqual(JSON.parse(result.line), { status: 'timeout' });
});

test('the report keeps only label-shaped fixed fields, caps lists and stays within the output limit', () => {
  const line = boundedReport({ status: 'held_before_first_write', reason: 'release_held', cause: 'https://leak.example/x?y=1', extra: 'dropped',
    readStepsEntered: Array(40).fill('build'), blockedSteps: { readOldAssets: 1, 'bad key/path': 2 },
    refusedRequests: Array(500).fill({ method: 'POST', category: 'refused_cloudflare_write', url: 'https://leak' }) });
  const report = JSON.parse(line);
  assert.equal(report.cause, 'unlabelled');
  assert.equal(report.extra, undefined);
  assert.equal(report.readStepsEntered.length, 16);
  assert.deepEqual(report.blockedSteps, { readOldAssets: 1 });
  assert.equal(report.refusedRequestCount, 500);
  assert.equal(report.refusedRequests.length, PROBE_REFUSAL_LIMIT);
  assert.deepEqual(Object.keys(report.refusedRequests[0]).sort(), ['category', 'method']);
  assert.ok(Buffer.byteLength(line) <= PROBE_OUTPUT_LIMIT);
  assert.ok(!line.includes('leak'));
  assert.equal(JSON.parse(boundedReport({ status: 'something new' })).status, 'unlabelled');
});

test('the workflow pins the exact committed bytes of the probe and this runner', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/production-auto-diagnostic.yml'), 'utf8');
  for (const [name, file] of [['PROBE_SHA256', 'scripts/production-auto-readonly-probe.mjs'], ['RUNNER_SHA256', 'scripts/production-auto-diagnostic-run.mjs']]) {
    // Hash the bytes Git checks out on the runner (LF), not a possibly CRLF Windows working copy.
    const bytes = Buffer.from(fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/gu, '\n'));
    assert.match(workflow, new RegExp(`${name}: ${createHash('sha256').update(bytes).digest('hex')}\\n`, 'u'), `${name} must equal ${file}`);
  }
});
