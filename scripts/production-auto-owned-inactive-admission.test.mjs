import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNED_INACTIVE_CLIENT_POLICY as policy, verifyPinnedOwnedInactiveCustody } from './production-auto-owned-inactive-policy.mjs';
import { readOwnedInactiveSelector, createOwnedInactiveCaptureWitness, ownedInactiveLatestForCapture,
  isOwnedInactiveAdmission, ownedInactiveInitialStateAllowed, ownedInactiveProviderParentAllowed,
  claimOwnedInactiveAdmission, finalizeOwnedInactiveAdmission, verifyOwnedInactivePendingCapture,
  ownedInactiveExpectedAdmissionDigest } from './production-auto-owned-inactive-admission.mjs';
import { ownedInactiveCustodyInput, ownedInactiveNewIdentity, ownedInactiveNewCI } from './test-fixtures/owned-inactive-custody-input.mjs';

const refusal = { message: 'owned_inactive_admission_refused' };
function witness() {
  const identity = ownedInactiveNewIdentity(), ci = ownedInactiveNewCI(identity);
  const custody = verifyPinnedOwnedInactiveCustody(ownedInactiveCustodyInput());
  return { identity, ci, custody, value: createOwnedInactiveCaptureWitness({ custody, identity, ci }) };
}

test('one-off selector is default off and cannot select another Worker or diagnostic', () => {
  for (const value of [undefined, '', 'false'])
    assert.equal(readOwnedInactiveSelector({ PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED: value }, policy.workerName), false);
  assert.equal(readOwnedInactiveSelector({ PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED: 'true' }, policy.workerName), true);
  for (const value of [true, false, 'TRUE', '1', ' true', null])
    assert.throws(() => readOwnedInactiveSelector({ PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED: value }, policy.workerName), refusal);
  for (const workerName of ['ledgetop-ops', 'ledgetop-ops-sync'])
    assert.throws(() => readOwnedInactiveSelector({ PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED: 'true' }, workerName), refusal);
  assert.throws(() => readOwnedInactiveSelector({ PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED: 'true' }, policy.workerName, { diagnostic: true }), refusal);
});

test('genuine old custody produces capture-only recognition, never a mutation admission', () => {
  const { identity, value } = witness();
  assert.equal(ownedInactiveLatestForCapture(value, identity), policy.priorInactiveCandidateVersionId);
  assert.equal(isOwnedInactiveAdmission(value, identity), false);
  assert.equal(ownedInactiveInitialStateAllowed(value, identity, {}), false);
  assert.equal(ownedInactiveProviderParentAllowed(value, identity, {}), false);
  assert.throws(() => claimOwnedInactiveAdmission(value, identity), refusal);
  for (const fake of [{ ...value }, JSON.parse(JSON.stringify(value)), {}])
    assert.throws(() => ownedInactiveLatestForCapture(fake, identity), refusal);
});

test('witness and digest bind exact new source, CI, workflow attempt and target', () => {
  const { identity, ci, custody, value } = witness();
  for (const [key, replacement] of [ ['sourceCommit', 'b'.repeat(40)], ['ciRunId', 101], ['ciRunAttempt', 2],
    ['workflowRunId', 201], ['workflowRunAttempt', 2], ['workerName', 'ledgetop-ops'], ['accountId', '0'.repeat(32)] ]) {
    const changed = { ...identity, [key]: replacement };
    assert.throws(() => ownedInactiveLatestForCapture(value, changed), refusal);
    if (['workerName', 'accountId'].includes(key)) assert.throws(() => ownedInactiveExpectedAdmissionDigest(changed), refusal);
    else assert.notEqual(ownedInactiveExpectedAdmissionDigest(changed), ownedInactiveExpectedAdmissionDigest(identity));
  }
  for (const changed of [{ ...identity, extra: true }, { ...identity, sourceCommit: policy.oldSourceCommit },
    { ...identity, ciRunId: policy.oldCiRunId }, { ...identity, workflowRunId: policy.oldReleaseRunId }])
    assert.throws(() => createOwnedInactiveCaptureWitness({ custody, identity: changed, ci }), refusal);
  for (const changed of [{ ...ci, passed: false }, { ...ci, runId: 101 }, { ...ci, runAttempt: 2 }, { ...ci, sourceCommit: 'b'.repeat(40) }])
    assert.throws(() => createOwnedInactiveCaptureWitness({ custody, identity, ci: changed }), refusal);
  assert.throws(() => createOwnedInactiveCaptureWitness({ custody: { ...custody }, identity, ci }), refusal);
});

test('synthetic bytes never satisfy real C0 hashes or mint an admission', () => {
  const { identity, ci, value } = witness();
  const resources = { script: { etag: 'parent', last_deployed_from: 'wrangler' }, script_runtime: {}, bindings: [] };
  const snapshot = { client: { version: { id: policy.parentVersionId, resources }, modern: { id: policy.parentVersionId, assets: { config: {} } },
    latest: policy.priorInactiveCandidateVersionId,
    latestVersion: { id: policy.priorInactiveCandidateVersionId, resources: { ...resources, script: { etag: 'candidate', last_deployed_from: 'api' } } },
    latestModern: { id: policy.priorInactiveCandidateVersionId, assets: { config: {} }, modules: [
      { name: 'index.js', content_base64: Buffer.from('synthetic').toString('base64') },
      { name: '__ops_release_ledger.json', content_base64: Buffer.from('{}').toString('base64') } ] },
    deployment: { versions: [{ version_id: policy.parentVersionId, percentage: 100 }] } } };
  const baseline = { activeVersionId: policy.parentVersionId, latestVersionId: policy.priorInactiveCandidateVersionId,
    versions: [{ versionId: policy.parentVersionId, percentage: 100 }], controlsSHA256: policy.controlsSha256 };
  assert.throws(() => verifyOwnedInactivePendingCapture(value, identity, snapshot, baseline.controlsSHA256), refusal);
  assert.throws(() => finalizeOwnedInactiveAdmission({ witness: value, identity, ci, snapshot, baseline }), refusal);
  assert.equal(isOwnedInactiveAdmission(value, identity), false);
});
