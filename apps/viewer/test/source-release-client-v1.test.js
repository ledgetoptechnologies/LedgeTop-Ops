'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const Contract = require('../server/sourceReleaseContractV1');
const { MAX_RESPONSE_BYTES, SourceReleaseClientV1, boundedJson } = require('../server/sourceReleaseClientV1');

function responseWithChunks(chunks, onCancel = () => {}, close = true) {
  let index = 0;
  return {
    headers: { get: () => null },
    body: new ReadableStream({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else if (close) controller.close();
      },
      cancel() { onCancel(); },
    }),
  };
}

test('source-release response reader parses bounded streamed JSON', async () => {
  const bytes = Buffer.from('{"state":"waiting_policy"}');
  const body = await boundedJson(responseWithChunks([bytes.subarray(0, 5), bytes.subarray(5)]));
  assert.deepEqual(body, { state: 'waiting_policy' });
});

test('source-release response reader cancels before buffering beyond the cap', async () => {
  let cancelled = false;
  const tooLarge = responseWithChunks([new Uint8Array(MAX_RESPONSE_BYTES), new Uint8Array(1)], () => { cancelled = true; }, false);
  await assert.rejects(boundedJson(tooLarge), { code: 'source_release_response_too_large' });
  assert.equal(cancelled, true);
});

test('source-release observation accepts the protocol authority slug', async () => {
  const binding = { coordinatorAuthorityId: 'authority-test', jobId: 'job-test', generation: 1, environment: 'staging' };
  const body = { schemaVersion: 1, protocol: 'ltds-worker-acceptance-observed-ack-v1',
    coordinatorAuthorityId: binding.coordinatorAuthorityId, jobId: binding.jobId, generation: binding.generation,
    observationId: crypto.randomUUID(), requestSha256: 'a'.repeat(64), nodeId: 'node-1', workerId: 'worker-1',
    workerInstanceId: 'instance-1', observedAt: '2026-11-05T12:00:00.000Z' };
  const observation = { ...body, ackSha256: Contract.digest(body) };
  let requestedUrl = null;
  const client = new SourceReleaseClientV1({ origin: 'https://processing.example', bearerToken: 'x'.repeat(48),
    environment: 'staging', fetchImpl: async url => {
      requestedUrl = url;
      return new Response(JSON.stringify(observation), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  assert.deepEqual(await client.acceptanceObservation(binding), observation);
  assert.equal(requestedUrl, 'https://processing.example/ltds/v2/jobs/job-test/source/acceptance-observation');
});
