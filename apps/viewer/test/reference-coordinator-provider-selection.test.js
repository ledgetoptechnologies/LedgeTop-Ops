'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isReferenceCoordinatorProvider, isReferenceResultReady, processSubmit } = require('../server/processingWorker');

test('reference result readiness follows awaiting_acceptance and completed phases',()=>{
  assert.equal(isReferenceResultReady({status:'succeeded',phase:'awaiting_acceptance'}),true);
  assert.equal(isReferenceResultReady({status:'succeeded',phase:'completed'}),true);
  assert.equal(isReferenceResultReady({status:'running',phase:'awaiting_acceptance'}),true);
  assert.equal(isReferenceResultReady({status:'running',phase:'processing'}),false);
  assert.equal(isReferenceResultReady({status:'queued',phase:'awaiting_acceptance'}),false);
  assert.equal(isReferenceResultReady({status:'failed',phase:'completed'}),false);
});

test('only the explicitly configured Processing coordinator provider selects source intake', () => {
  const sourceIntake = { enabled: true, providerId: 'processing-coordinator-staging' };
  assert.equal(isReferenceCoordinatorProvider({ id: 'nodeodm-main', type: 'nodeodm' }, sourceIntake), false);
  assert.equal(isReferenceCoordinatorProvider({ id: 'cluster-main', type: 'clusterodm' }, sourceIntake), false);
  assert.equal(isReferenceCoordinatorProvider({ id: 'processing-coordinator-staging', type: 'nodeodm' }, sourceIntake), true);
  assert.equal(isReferenceCoordinatorProvider({ id: 'processing-coordinator-staging' }, { ...sourceIntake, enabled: false }), true);
});

test('a selected coordinator fails closed before constructing the direct NodeODM adapter', async () => {
  const provider = { id: 'processing-coordinator-staging', type: 'nodeodm' };
  const processing = {
    getAttempt: () => ({ id: 'attempt-1', taskId: 'task-1', datasetId: 'dataset-1', providerId: provider.id,
      errorCode: null, submissionPhase: 'new' }),
    getAttemptSubmission: () => null,
    getTask: () => ({ id: 'task-1', datasetId: 'dataset-1' }),
    getDataset: () => ({ id: 'dataset-1', files: [] }),
    getProvider: () => provider,
    transitionAttemptForJob: () => ({ id: 'attempt-1' }),
  };
  let adapters = 0;
  await assert.rejects(processSubmit({ id: 'job-1', attempt_id: 'attempt-1', lease_owner: 'worker-1' }, {
    processing, config: { referenceSourceIntake: { enabled: true, providerId: provider.id } },
    storage: {}, providerCredentials: {}, adapterFactory: () => { adapters++; throw new Error('must not construct'); },
  }), { code: 'source_intake_runtime_unavailable' });
  assert.equal(adapters, 0);
});
