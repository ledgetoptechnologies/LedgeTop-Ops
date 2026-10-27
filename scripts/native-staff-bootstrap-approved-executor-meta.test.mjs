import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovedExecutorD1Provider } from './native-staff-bootstrap-approved-executor.mjs';

const accountId = 'a'.repeat(32);
const databaseId = '123e4567-e89b-42d3-a456-426614174000';
const databaseName = 'synthetic-provider-meta-test';
const bearer = 'synthetic-provider-test-token-never-used-outside-fixture';
const response = body => new Response(JSON.stringify(body), { status:200,
  headers:{'content-type':'application/json'} });

function providerFor(queryResult) {
  const config = { target:{ accountId, databaseId, databaseName } };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (init.method === 'GET' && parsed.pathname.endsWith(`/d1/database/${databaseId}`))
      return response({ success:true, result:{ uuid:databaseId, name:databaseName } });
    if (init.method === 'POST' && parsed.pathname.endsWith(`/d1/database/${databaseId}/query`))
      return response({ success:true, result:[queryResult] });
    throw new Error('unexpected synthetic provider request');
  };
  return createApprovedExecutorD1Provider({ config, getBearerToken:() => bearer, fetchImpl });
}

test('approved D1 provider preserves only validated per-statement meta.changes', async () => {
  const provider = providerFor({ success:true, results:[], meta:{ changes:1, duration:0.2, changed_db:true } });
  await provider.assertTarget();
  const [result] = await provider.batch([{ sql:'UPDATE synthetic_table SET enabled=1', params:[] }]);
  assert.deepEqual(result, { success:true, results:[], meta:{ changes:1 } });
});

test('approved D1 provider accepts optional metadata when changes are absent', async () => {
  const provider = providerFor({ success:true, results:[], meta:{ duration:0.2 } });
  await provider.assertTarget();
  const [result] = await provider.batch([{ sql:'SELECT 1', params:[] }]);
  assert.deepEqual(result, { success:true, results:[] });
});

test('approved D1 provider rejects malformed metadata without returning it', async t => {
  for (const [name, meta] of [
    ['null metadata', null], ['array metadata', []], ['string metadata', '1'],
    ['negative change count', { changes:-1 }], ['fractional change count', { changes:1.5 }],
    ['string change count', { changes:'1' }], ['null change count', { changes:null }],
    ['unsafe change count', { changes:Number.MAX_SAFE_INTEGER + 1 }],
  ]) {
    await t.test(name, async () => {
      const provider = providerFor({ success:true, results:[], meta });
      await provider.assertTarget();
      await assert.rejects(provider.batch([{ sql:'UPDATE synthetic_table SET enabled=1', params:[] }]),
        /native_staff_bootstrap_executor_d1_batch_outcome_uncertain/u);
    });
  }
});
