import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { boundedReport, diagnosticPreconditions, runDiagnostic, PROBE_OUTPUT_LIMIT, PROBE_REFUSAL_LIMIT } from './production-auto-diagnostic-run.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-run-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const base = Object.freeze({ ...process.env, PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'true', PRODUCTION_AUTO_RELEASE_ENABLED: 'false',
  PRODUCTION_AUTO_WORKER: 'ledgetop-clients', GITHUB_EVENT_NAME: 'workflow_run', PRODUCTION_AUTO_PROBE_CHECKOUT: dir });
const fixture = (name, source) => { const file = path.join(dir, name); fs.writeFileSync(file, source); return file; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function gone(pid, ms = 5000) { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (!alive(pid)) return true; return !alive(pid); }

test('preconditions: opt-in on, global release exactly OFF, Client lane, workflow_run, absolute checkout; never substituted', () => {
  assert.equal(diagnosticPreconditions(base), null);
  for (const [key, value, reason] of [
    ['PRODUCTION_AUTO_DIAGNOSTIC_ENABLED', undefined, 'diagnostic_opt_in_off'], ['PRODUCTION_AUTO_DIAGNOSTIC_ENABLED', 'TRUE', 'diagnostic_opt_in_off'],
    ['PRODUCTION_AUTO_RELEASE_ENABLED', 'true', 'global_release_not_off'], ['PRODUCTION_AUTO_RELEASE_ENABLED', undefined, 'global_release_not_off'],
    ['PRODUCTION_AUTO_RELEASE_ENABLED', '', 'global_release_not_off'], ['PRODUCTION_AUTO_WORKER', 'ledgetop-ops', 'lane'],
    ['GITHUB_EVENT_NAME', 'workflow_dispatch', 'event'], ['PRODUCTION_AUTO_PROBE_CHECKOUT', 'relative/dir', 'checkout'],
  ]) assert.equal(diagnosticPreconditions({ ...base, [key]: value }), reason, `${key}=${value}`);
});

test('a refused environment never starts a process', async () => {
  let spawned = 0;
  const result = await runDiagnostic({ env: { ...base, PRODUCTION_AUTO_RELEASE_ENABLED: 'true' }, spawnImpl: () => { spawned++; } });
  assert.equal(spawned, 0);
  assert.equal(result.exitCode, 2);
  assert.deepEqual(JSON.parse(result.line), { status: 'refused', reason: 'global_release_not_off' });
});

test('the child gets the environment unchanged (no gate substitution) and its fixed-vocabulary errorType is preserved', async () => {
  const probe = fixture('probe-held.mjs', `console.log(JSON.stringify({ status: 'held_before_first_write', stage: 'coordination', reason: 'unexpected_error',
    errorType: 'TypeError', checks: { name: true, sha: false }, gate: process.env.PRODUCTION_AUTO_RELEASE_ENABLED, readStepsEntered: ['sourceFence'],
    readStepsCompleted: [], failedReadStep: 'sourceFence', blockedSteps: {}, receiptsSkipped: 1, refusedRequests: [] })); process.exitCode = 1;`);
  const result = await runDiagnostic({ env: base, probePath: probe });
  const report = JSON.parse(result.line);
  assert.equal(result.exitCode, 0, 'a hold is a diagnosis');
  assert.equal(report.reason, 'unexpected_error');
  assert.equal(report.errorType, 'TypeError');
  assert.deepEqual(report.checks, { name: true, sha: false });
  assert.equal(report.gate, undefined, 'unlisted fields are dropped');
  const echo = fixture('probe-echo.mjs', `console.log(JSON.stringify({ status: 'held_before_first_write', stage: process.env.PRODUCTION_AUTO_RELEASE_ENABLED === 'false' ? 'gate_value_false' : 'gate_value_changed' }));`);
  assert.equal(JSON.parse((await runDiagnostic({ env: base, probePath: echo })).line).stage, 'gate_value_false');
});

test('on the deadline the whole process tree is killed and reaped: the probe and a grandchild it started are gone', async () => {
  const pids = path.join(dir, 'pids.json');
  const probe = fixture('probe-hang.mjs', `import { spawn } from 'node:child_process'; import fs from 'node:fs';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ probe: process.pid, grandchild: grandchild.pid }));
    setInterval(() => {}, 1000);`);
  const started = Date.now();
  const result = await runDiagnostic({ env: base, probePath: probe, timeoutMs: 1500 });
  assert.ok(Date.now() - started < 15_000, 'returned promptly after the deadline');
  assert.equal(result.exitCode, 3);
  assert.deepEqual(JSON.parse(result.line), { status: 'timeout', reaped: true });
  const { probe: probePid, grandchild } = JSON.parse(fs.readFileSync(pids, 'utf8'));
  assert.ok(await gone(probePid), 'probe process is gone');
  assert.ok(await gone(grandchild), 'grandchild (e.g. npm/build) is gone, not left running');
});

const held = `console.log(JSON.stringify({ status: 'held_before_first_write', stage: 'source', reason: 'runtime_trigger_source_mismatch' }));`;
test('POSIX: a probe that exits normally but leaves a descendant has its group killed and confirmed gone before the diagnosis is reported',
  { skip: process.platform === 'win32' ? 'needs POSIX process groups (Linux runner)' : false }, async () => {
    const pids = path.join(dir, 'leftover.json');
    const probe = fixture('probe-leftover.mjs', `import { spawn } from 'node:child_process'; import fs from 'node:fs';
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      descendant.unref();
      fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ descendant: descendant.pid }));
      ${held}`);
    const result = await runDiagnostic({ env: base, probePath: probe });
    const report = JSON.parse(result.line);
    assert.equal(result.exitCode, 0);
    assert.equal(report.cleanup, 'leftover_reaped');
    assert.ok(await gone(JSON.parse(fs.readFileSync(pids, 'utf8')).descendant), 'the descendant is gone');
  });

test('a leftover group that will not die fails the run as cleanup_failed instead of reporting a diagnosis', async () => {
  const kills = [];
  const control = { posix: true, alive: () => true, killTree: pid => kills.push(pid) };
  const probe = fixture('probe-normal.mjs', held);
  const result = await runDiagnostic({ env: base, probePath: probe, control, reapWaitMs: 200 });
  assert.equal(result.exitCode, 3);
  assert.deepEqual(JSON.parse(result.line), { status: 'cleanup_failed', reaped: false });
  assert.ok(kills.length >= 1, 'the group was killed before waiting');
});

test('a leftover group that dies after the kill is reported as leftover_reaped with the diagnosis', async () => {
  let killed = false;
  const control = { posix: true, alive: () => !killed, killTree: () => { killed = true; } };
  const result = await runDiagnostic({ env: base, probePath: fixture('probe-normal2.mjs', held), control, reapWaitMs: 500 });
  assert.equal(result.exitCode, 0);
  assert.deepEqual([JSON.parse(result.line).stage, JSON.parse(result.line).cleanup], ['source', 'leftover_reaped']);
  // No leftover: no cleanup field, nothing killed.
  let kills = 0;
  const clean = await runDiagnostic({ env: base, probePath: fixture('probe-normal3.mjs', held), control: { posix: true, alive: () => false, killTree: () => { kills++; } } });
  assert.equal(JSON.parse(clean.line).cleanup, undefined);
  assert.equal(kills, 0);
});

test('output past the limit stops and reaps the child; nothing it printed is reported', async () => {
  const probe = fixture('probe-flood.mjs', `process.stdout.write('x'.repeat(${PROBE_OUTPUT_LIMIT * 2})); setInterval(() => {}, 1000);`);
  const result = await runDiagnostic({ env: base, probePath: probe, timeoutMs: 20_000 });
  assert.equal(result.exitCode, 3);
  assert.deepEqual(JSON.parse(result.line), { status: 'output_limit', reaped: true });
});

test('unparseable probe output is a fixed probe_error, with no output text', async () => {
  const probe = fixture('probe-garbage.mjs', `console.log('secret https://host/path?token=abc');`);
  const result = await runDiagnostic({ env: base, probePath: probe });
  assert.equal(result.exitCode, 3);
  assert.deepEqual(JSON.parse(result.line), { status: 'probe_error', spawned: true });
});

test('the report keeps only label-shaped fixed fields, caps lists and stays within the output limit', () => {
  const line = boundedReport({ status: 'held_before_first_write', reason: 'release_held', cause: 'https://leak.example/x?y=1', class: 'TypeError', extra: 'dropped',
    readStepsEntered: Array(40).fill('build'), blockedSteps: { readOldAssets: 1, 'bad key/path': 2 }, checks: { ok: true, 'bad key': true, leak: 'text' },
    refusedRequests: Array(500).fill({ method: 'POST', category: 'refused_cloudflare_write', url: 'https://leak' }) });
  const report = JSON.parse(line);
  assert.equal(report.cause, 'unlabelled');
  assert.equal(report.class, undefined, 'only the upstream field name errorType is carried');
  assert.equal(report.extra, undefined);
  assert.deepEqual(report.checks, { ok: true });
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
    // Hash the exact blob Git stores (what a Linux runner checks out), not this machine's working copy, whose line
    // endings may differ. Stage a changed file before running this test.
    const bytes = execFileSync('git', ['show', `:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    assert.match(workflow, new RegExp(`${name}: ${createHash('sha256').update(bytes).digest('hex')}\\n`, 'u'), `${name} must equal ${file}`);
  }
});
