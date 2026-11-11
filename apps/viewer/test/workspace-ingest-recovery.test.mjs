import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canRecoverExistingResult, recoverExistingResult } from '../workspace-ingest-recovery.mjs';

test('existing result recovery requires the server candidate and write permission', () => {
  const eligible = { recovery: { kind: 'ingest', available: true, remainingRequests: 1 } };
  assert.equal(canRecoverExistingResult(eligible, true), true);
  for (const diagnostic of [null, {}, { recovery: { kind: 'ingest', available: false } },
    { recovery: { kind: 'other', available: true } }, { ...eligible, loading: true },
    { ...eligible, error: 'unavailable' }]) {
    assert.equal(canRecoverExistingResult(diagnostic, true), false);
  }
  assert.equal(canRecoverExistingResult(eligible, false), false);
});

test('recovery requests the same attempt and invalidates stale eligibility after acceptance', async () => {
  const calls = [];
  const mutate = (...args) => { calls.push(args); return 'queued'; };
  const diagnostic = { recovery: { kind: 'ingest', available: true } };
  let refreshed = 0;
  assert.equal(await recoverExistingResult(diagnostic, true, 'attempt/one', mutate, () => { refreshed++; }), 'queued');
  assert.deepEqual(calls, [['/api/v1/attempts/attempt%2Fone/recover-ingest',
    { method: 'POST', body: {} }, 'Existing result recovery queued']]);
  assert.equal(refreshed, 1);
  assert.equal(canRecoverExistingResult(diagnostic, true), false);
  await recoverExistingResult(diagnostic, true, 'attempt/one', mutate);
  await recoverExistingResult(diagnostic, false, 'attempt', mutate);
  await recoverExistingResult({ recovery: { kind: 'ingest', available: false } }, true, 'attempt', mutate);
  assert.equal(calls.length, 1);
});

test('failed mutation does not claim success or clear server eligibility', async () => {
  const diagnostic = { recovery: { kind: 'ingest', available: true } };
  let refreshed = false;
  const result = await recoverExistingResult(diagnostic, true, 'attempt', async () => undefined,
    () => { refreshed = true; });
  assert.equal(result, undefined);
  assert.equal(refreshed, false);
  assert.equal(canRecoverExistingResult(diagnostic, true), true);
});

test('workspace uses server diagnostics and the ordinary idempotent authenticated API helper', () => {
  const source = readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8');
  assert.match(source, /canRecoverExistingResult\(diagnostic,can\('viewer\.processing\.write'\)\)/);
  assert.match(source, /button\('recover-existing-result',item\.id,'Recover existing result'/);
  assert.match(source, /recoverExistingResult\(diagnostic,can\('viewer\.processing\.write'\),id,mutate,/);
  assert.match(source, /delete detail\.attemptDiagnostics\[id\]/);
  assert.match(source, /loadTaskAttemptDiagnostics\(taskId,id\)/);
  assert.match(source, /delete state\.diagnosticDetails\[id\]/);
  assert.match(source, /loadGlobalAttemptDiagnostics\(id\)/);
  assert.match(source, /detail\.attemptDiagnostics\?\.\[attemptId\]!==pending/);
  assert.match(source, /state\.diagnosticDetails\[attemptId\]!==pending/);
  const api = source.split(/\r?\n/).find(line => line.startsWith('async function api('));
  assert.match(api, /Authorization:`Bearer \$\{state\.token\}`/);
  assert.match(api, /Idempotency-Key/);
  assert.match(api, /crypto\.randomUUID\(\)/);
});
