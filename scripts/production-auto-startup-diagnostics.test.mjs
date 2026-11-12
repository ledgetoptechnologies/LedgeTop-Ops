import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatProductionAutoReleaseHold, formatProductionAutoSyncHold, markProductionAutoStartupFailure,
  productionAutoStartupFailure, trackProductionAutoStartupStage, productionAutoOriginalFailureDetails,
  PRODUCTION_AUTO_ORIGINAL_FAILURE_STEPS } from './production-auto-startup-diagnostics.mjs';
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

test('coordination holds report only an exact reviewed refusal code, never data-shaped strings', () => {
  const reasonOf = (error, stage = 'coordination') => { markProductionAutoStartupFailure(error, stage); return productionAutoStartupFailure(error); };
  // Exact reviewed codes thrown by the release modules are reported as-is, from message or code.
  for (const code of ['runtime_predecessor_invalid', 'production_auto_journal_refused_no_retry', 'runtime_cloudflare_release_time_budget_exceeded'])
    assert.deepEqual(reasonOf(Error(code)), { stage: 'coordination', reason: code });
  assert.deepEqual(reasonOf(Object.assign(Error('free text'), { code: 'provider_http_failure' })), { stage: 'coordination', reason: 'provider_http_failure' });
  // The exact-main CI guard has its own stable code.
  assert.deepEqual(reasonOf(Error('Exact successful main CI is required; automatic release held')), { stage: 'coordination', reason: 'exact_main_ci_required' });
  // Code-shaped data never passes, whether it arrives as the message or as error.code.
  for (const leak of ['client_jane_smith', 'bearer_secret_value', 'runtime_predecessor_invalid_x', 'deadbeefcafe1234_x', 'run_43261175765',
    'token is abc_def', 'https://x.test/a_b', 'secret', 'getter']) {
    for (const error of [Error(leak), Object.assign(Error('free text'), { code: leak })]) {
      assert.equal(reasonOf(error).reason, 'unexpected_error', leak);
      assert.ok(!formatProductionAutoReleaseHold(error).includes(leak), leak);
      assert.ok(!formatProductionAutoSyncHold(error).includes(leak), leak);
    }
  }
  // Getter-backed message/code properties are never invoked.
  const trap = Error('x');
  Object.defineProperty(trap, 'code', { get() { throw Error('must not run'); } });
  Object.defineProperty(trap, 'message', { get() { throw Error('must not run'); } });
  assert.equal(reasonOf(trap).reason, 'unexpected_error');
  // Code-only reasons keep needing an explicit code, as before.
  assert.equal(reasonOf(Error('migration_required_pending')).reason, 'unexpected_error');
});

test('an unexpected crash names only its built-in error class', () => {
  const crash = new TypeError("Cannot read properties of undefined (reading 'secret-token-value')");
  markProductionAutoStartupFailure(crash, 'coordination');
  const message = formatProductionAutoReleaseHold(crash);
  assert.match(message, /stage=coordination, reason=unexpected_error, error=TypeError\)/u);
  assert.doesNotMatch(message, /secret-token-value|Cannot read/u);
  const custom = Object.assign(Error('x'), { name: 'ProviderSecretLeakError' });
  markProductionAutoStartupFailure(custom, 'coordination');
  assert.doesNotMatch(formatProductionAutoSyncHold(custom), /ProviderSecretLeakError|error=/u);
});

test('crash classes are found by prototype identity without running any getter', () => {
  let reads = 0;
  class Spoofed extends Error {}
  const spoof = new Spoofed('x');
  Object.defineProperty(spoof, 'name', { get() { reads++; return 'TypeError'; } });
  markProductionAutoStartupFailure(spoof, 'coordination');
  assert.doesNotMatch(formatProductionAutoReleaseHold(spoof), /error=/u, 'a custom class claiming to be TypeError is not reported');
  const inheritedGetter = new RangeError('x');
  Object.defineProperty(RangeError.prototype, 'name', { configurable: true, get() { reads++; return 'RangeError'; } });
  try {
    markProductionAutoStartupFailure(inheritedGetter, 'coordination');
    assert.match(formatProductionAutoReleaseHold(inheritedGetter), /error=RangeError\)/u);
  } finally { Object.defineProperty(RangeError.prototype, 'name', { configurable: true, writable: true, value: 'RangeError' }); }
  assert.equal(reads, 0, 'no own or inherited name getter ran');
});

test('original failure details return only a fixed step and an exact built-in class', () => {
  assert.deepEqual(PRODUCTION_AUTO_ORIGINAL_FAILURE_STEPS, ['old_assets_final_fence','old_assets_schema','old_assets_ci',
    'old_assets_capture','old_assets_predecessor','old_assets_complete_inventory','archive_root_html','merge_asset_ledger']);
  for (const value of [null, undefined, 'TypeError', 7]) assert.deepEqual(productionAutoOriginalFailureDetails(value), {});
  assert.deepEqual(productionAutoOriginalFailureDetails(new TypeError('secret')), { errorType: 'TypeError' });
  assert.deepEqual(productionAutoOriginalFailureDetails(Error('secret')), { errorType: 'Error' });
  assert.deepEqual(productionAutoOriginalFailureDetails(new DOMException('secret', 'AbortError')), { errorType: 'DOMException' });
  assert.deepEqual(productionAutoOriginalFailureDetails({ name: 'TypeError', message: 'x' }), {});
  const marked = new RangeError('secret');
  assert.throws(() => trackProductionAutoStartupStage('merge_asset_ledger', () => { throw marked; }), marked);
  assert.deepEqual(productionAutoOriginalFailureDetails(marked), { step: 'merge_asset_ledger', errorType: 'RangeError' });
  Object.setPrototypeOf(marked, TypeError.prototype);
  assert.equal(productionAutoOriginalFailureDetails(marked).errorType, 'RangeError', 'class captured when first marked');
  const coordination = Error('x'); markProductionAutoStartupFailure(coordination, 'coordination');
  assert.deepEqual(productionAutoOriginalFailureDetails(coordination), { errorType: 'Error' }, 'a non-step stage is not a step');
  let reads = 0;
  const trap = new Proxy({}, { getPrototypeOf() { reads++; throw Error('trap'); }, get() { reads++; return 'TypeError'; } });
  assert.deepEqual(productionAutoOriginalFailureDetails(trap), {});
  assert.equal(reads, 1, 'only the prototype lookup was attempted');
  // A step marker never adds an error= field to an ordinary (non-hold) startup failure for a plain Error.
  const plain = Error('x'); markProductionAutoStartupFailure(plain, 'old_assets_ci');
  assert.equal(formatProductionAutoReleaseHold(plain),
    'Production retained-asset release held (stage=old_assets_ci, reason=unexpected_error); inspect the durable journal and reconcile read-only.');
});
