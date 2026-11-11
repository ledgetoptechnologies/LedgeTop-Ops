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

test('recovery requests the same attempt through authenticated mutation, never provider restart', () => {
  const calls = [];
  const mutate = (...args) => { calls.push(args); return 'queued'; };
  const diagnostic = { recovery: { kind: 'ingest', available: true } };
  assert.equal(recoverExistingResult(diagnostic, true, 'attempt/one', mutate), 'queued');
  assert.deepEqual(calls, [['/api/v1/attempts/attempt%2Fone/recover-ingest',
    { method: 'POST', body: {} }, 'Existing result recovery queued']]);
  recoverExistingResult(diagnostic, false, 'attempt', mutate);
  recoverExistingResult({ recovery: { kind: 'ingest', available: false } }, true, 'attempt', mutate);
  assert.equal(calls.length, 1);
});

test('workspace uses server diagnostics and the ordinary idempotent authenticated API helper', () => {
  const source = readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8');
  assert.match(source, /canRecoverExistingResult\(diagnostic,can\('viewer\.processing\.write'\)\)/);
  assert.match(source, /button\('recover-existing-result',item\.id,'Recover existing result'/);
  assert.match(source, /recoverExistingResult\(diagnostic,can\('viewer\.processing\.write'\),id,mutate\)/);
  const api = source.split(/\r?\n/).find(line => line.startsWith('async function api('));
  assert.match(api, /Authorization:`Bearer \$\{state\.token\}`/);
  assert.match(api, /Idempotency-Key/);
  assert.match(api, /crypto\.randomUUID\(\)/);
});
