import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatProductionAutoReleaseHold, formatProductionAutoSyncHold, markProductionAutoStartupFailure,
  productionAutoStartupFailure, trackProductionAutoStartupStage } from './production-auto-startup-diagnostics.mjs';
import { createProductionAutoReleaseAdapter,readProductionAutoTriggerRun } from './production-auto-runtime.mjs';
import { PROFILE } from './production-deploy.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

test('startup stage tracking preserves the original error object and allowlisted guard code', () => {
  const error = Error('production_auto_release_disabled');
  assert.throws(() => trackProductionAutoStartupStage('gate', () => { throw error; }), value => value === error);
  assert.deepEqual(productionAutoStartupFailure(error), { stage: 'gate', reason: 'production_auto_release_disabled' });
});

test('unknown errors are reduced to fixed diagnostic values without exposing message contents', () => {
  const error = Error('provider response contained secret-token-value');
  markProductionAutoStartupFailure(error, 'coordination');
  const message = formatProductionAutoReleaseHold(error);
  assert.match(message, /stage=coordination, reason=unexpected_error/u);
  assert.doesNotMatch(message, /secret-token-value|provider response/u);
});

test('source checkout constants map to a fixed safe reason', () => {
  const error = Error('Deployment source checkout differs');
  markProductionAutoStartupFailure(error, 'source');
  assert.deepEqual(productionAutoStartupFailure(error), { stage: 'source', reason: 'source_checkout_mismatch' });
});

test('only boolean checks with fixed stage-specific names are retained', () => {
  const unknownKey = Error('unknown key');
  markProductionAutoStartupFailure(unknownKey, 'adapter', { cloudflareTokenShape: false, secretValue: true });
  assert.deepEqual(productionAutoStartupFailure(unknownKey), { stage: 'adapter', reason: 'unexpected_error' });

  const getter = Error('getter');
  const withGetter = { accountIdMatches: true };
  Object.defineProperty(withGetter, 'githubTokenShape', { enumerable: true, get() { throw Error('must not run'); } });
  markProductionAutoStartupFailure(getter, 'adapter', withGetter);
  assert.deepEqual(productionAutoStartupFailure(getter), { stage: 'adapter', reason: 'unexpected_error' });

  const nonBoolean = Error('non boolean');
  markProductionAutoStartupFailure(nonBoolean, 'trigger_shape', { name: true, path: 'private-path' });
  assert.deepEqual(productionAutoStartupFailure(nonBoolean), { stage: 'trigger_shape', reason: 'unexpected_error' });

  const valid = Error('valid');
  markProductionAutoStartupFailure(valid, 'adapter', { accountIdMatches: true, cloudflareTokenShape: false });
  assert.equal(formatProductionAutoReleaseHold(valid),
    'Production retained-asset release held (stage=adapter, reason=unexpected_error, checks=accountIdMatches=true,cloudflareTokenShape=false); inspect the durable journal and reconcile read-only.');
});

test('trigger JSON and run-shape failures retain fixed diagnostic substages', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-startup-event-'));
  const file = path.join(directory, 'event.json');
  const env = { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: file };
  try {
    fs.writeFileSync(file, '{invalid', { flag: 'wx' });
    assert.throws(() => readProductionAutoTriggerRun(env), error => {
      assert.equal(error.message, 'runtime_trigger_event_invalid');
      assert.deepEqual(productionAutoStartupFailure(error), { stage: 'trigger_json', reason: 'runtime_trigger_event_invalid' });
      return true;
    });
    fs.writeFileSync(file, JSON.stringify({ workflow_run: {} }));
    assert.throws(() => readProductionAutoTriggerRun(env), error => {
      assert.deepEqual(productionAutoStartupFailure(error), { stage: 'trigger_shape', reason: 'runtime_trigger_event_invalid',
        checks: { name: false, path: false, event: false, status: false, conclusion: false, branch: false,
          repo: false, headRepo: false, id: false, attempt: false, sha: false } });
      return true;
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('missing trigger path reports the fixed environment substage', () => {
  assert.throws(() => readProductionAutoTriggerRun({ GITHUB_EVENT_NAME: 'workflow_run' }), error => {
    assert.equal(error.message, 'runtime_trigger_event_missing');
    assert.deepEqual(productionAutoStartupFailure(error), { stage: 'trigger_env', reason: 'runtime_trigger_event_missing' });
    return true;
  });
});

test('credential-shape failure emits only the fixed synthetic token check booleans', () => {
  const errorPredicate = error => {
    assert.equal(error.message, 'runtime_credentials_or_run_identity_missing');
    assert.deepEqual(productionAutoStartupFailure(error), { stage: 'adapter', reason: 'runtime_credentials_or_run_identity_missing',
      checks: { accountIdMatches: true, cloudflareTokenShape: false, githubTokenShape: true, workflowRunId: true, workflowAttempt: true } });
    const message = formatProductionAutoReleaseHold(error);
    assert.doesNotMatch(message, /synthetic-token|g{32}/u);
    return true;
  };
  assert.throws(() => createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients', sourceCommit: 'a'.repeat(40),
    triggerRun: { sourceCommit: 'a'.repeat(40), runId: 1, runAttempt: 1 },
    env: { CLOUDFLARE_ACCOUNT_ID: NATIVE_STAFF_PRODUCTION_TARGET.accountId, CLOUDFLARE_API_TOKEN: 'synthetic-token!',
      GITHUB_TOKEN: 'g'.repeat(32), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' },
    fetchImpl: async () => { throw Error('must not make provider requests'); }, profile: PROFILE }), errorPredicate);
});

test('retained-asset and sync CLI formatters preserve recognized migration holds', () => {
  const error = Object.assign(Error('migration_required_pending'), { code: 'migration_required_pending' });
  markProductionAutoStartupFailure(error, 'coordination');
  assert.equal(formatProductionAutoReleaseHold(error),
    'Production retained-asset release held (stage=coordination, reason=migration_required_pending); inspect the durable journal and reconcile read-only.');
  assert.equal(formatProductionAutoSyncHold(error),
    'Ops Sync automatic backend release held (stage=coordination, reason=migration_required_pending); inspect the durable journal and reconcile read-only.');
});

test('untracked errors format as unknown and never echo provider-controlled fields', () => {
  const error = Object.assign(Error('raw provider secret'), { code: 'provider-secret-code' });
  assert.equal(formatProductionAutoSyncHold(error),
    'Ops Sync automatic backend release held (stage=unknown, reason=unexpected_error); inspect the durable journal and reconcile read-only.');
});
