import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  createProductionOps0226CloudflareProvider,
} from './production-ops-staff-login-0226-cloudflare-provider.mjs';
import {
  PRODUCTION_OPS_0226_TARGET, PRODUCTION_OPS_0226_PRE_READ_QUERY, PRODUCTION_OPS_0226_POST_READ_QUERY,
} from './production-ops-staff-login-0226-once.mjs';

const migration = fs.readFileSync(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url), 'utf8');
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/production-ops-0226-wrangler-wire-statements.json', import.meta.url), 'utf8'));
const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'content-type': 'application/json' },
});
const validMetadata = { success: true, result: { uuid: PRODUCTION_OPS_0226_TARGET.databaseId, name: 'ltds-ops' } };

test('provider is pinned to the production database and requires live metadata verification before SQL', async () => {
  let calls = 0;
  const provider = createProductionOps0226CloudflareProvider({ getBearerToken: async () => 'synthetic-token-'.padEnd(32, 'x'),
    fetchImpl: async url => { calls++; assert.match(String(url), /\/accounts\/846c924bf17bf4f3dd15c97a4c5d1d51\/d1\/database\/6ebf7514-d306-4615-ae56-ad869c874dbd/u); return response(validMetadata); } });
  await assert.rejects(provider.readSnapshot({ target: PRODUCTION_OPS_0226_TARGET, phase: 'immediate-prewrite', query: PRODUCTION_OPS_0226_PRE_READ_QUERY }), /target_not_verified/u);
  await assert.rejects(provider.assertTarget({ ...PRODUCTION_OPS_0226_TARGET, databaseId: '78b34173-b168-4e3d-9832-bb9d245cc6b8' }), /target_mismatch/u);
  assert.equal(calls, 0);
  assert.deepEqual(await provider.assertTarget(), { databaseId: PRODUCTION_OPS_0226_TARGET.databaseId, name: 'ltds-ops' });
  assert.equal(calls, 1);
});

test('read snapshot uses only the pinned read query and preserves primary/read-only metadata requirements', async () => {
  const dbSnapshot = { ledger: [], schema: [], schemaColumns: {}, protectedRows: {}, authorityDigestExcludedColumns: {} };
  const provider = createProductionOps0226CloudflareProvider({ getBearerToken: async () => 'synthetic-token-'.padEnd(32, 'x'),
    fetchImpl: async (_url, init) => {
      if (init.method === 'GET') return response(validMetadata);
      const body = JSON.parse(init.body);
      assert.equal(body.sql, PRODUCTION_OPS_0226_PRE_READ_QUERY);
      return response({ success: true, result: [{ success: true, results: [{ production_ops_0226_snapshot: JSON.stringify(dbSnapshot) }],
        meta: { rows_written: 0, changed_db: false, served_by_primary: true } }] });
    }, now: () => Date.parse('2026-11-02T18:00:00.000Z') });
  await provider.assertTarget();
  const snapshot = await provider.readSnapshot({ target: PRODUCTION_OPS_0226_TARGET, phase: 'immediate-prewrite', query: PRODUCTION_OPS_0226_PRE_READ_QUERY });
  assert.equal(snapshot.target.databaseId, PRODUCTION_OPS_0226_TARGET.databaseId);
  assert.equal(snapshot.observedAt, '2026-11-02T18:00:00.000Z');
  await assert.rejects(provider.readSnapshot({ target: PRODUCTION_OPS_0226_TARGET, phase: 'postwrite', query: PRODUCTION_OPS_0226_PRE_READ_QUERY }), /read_query_invalid/u);
  assert.equal(PRODUCTION_OPS_0226_POST_READ_QUERY.includes("'loginState'"), true);
});

test('exact migration is one REST batch request, without assuming transactionality or retrying', async () => {
  const requests = [];
  const provider = createProductionOps0226CloudflareProvider({ getBearerToken: async () => 'synthetic-token-'.padEnd(32, 'x'),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (init.method === 'GET') return response(validMetadata);
      const body = JSON.parse(init.body);
      assert.equal(Array.isArray(body.batch), true);
      return response({ success: true, result: body.batch.map((_item, index) => ({ success: true, results: [],
        ...(index === body.batch.length - 1 ? { meta: { changes: 1 } } : {}) })) });
    } });
  await provider.assertTarget();
  assert.deepEqual(await provider.applyExactMigration({ target: PRODUCTION_OPS_0226_TARGET, name: '0226_staff_login_bindings.sql',
    sha256: 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5', sql: migration, appendLedger: true }),
  { applied: true, statements: 25 });
  assert.equal(requests.length, 2);
  const batch = JSON.parse(requests[1].init.body).batch;
  assert.equal(batch.length, 25);
  assert.deepEqual(batch.slice(0, 24).map(item => item.sql), fixture.statements);
  assert.deepEqual(batch[24], { sql: 'INSERT INTO d1_migrations(name) VALUES (?)', params: ['0226_staff_login_bindings.sql'] });
  assert.match(requests[1].url, /\/query$/u);
});

test('migration refuses changed SQL and does not retry ambiguous transport failure', async () => {
  let mutationCalls = 0;
  const provider = createProductionOps0226CloudflareProvider({ getBearerToken: async () => 'synthetic-token-'.padEnd(32, 'x'),
    fetchImpl: async (_url, init) => {
      if (init.method === 'GET') return response(validMetadata);
      mutationCalls++;
      throw new Error('synthetic transport loss');
    } });
  await provider.assertTarget();
  await assert.rejects(provider.applyExactMigration({ target: PRODUCTION_OPS_0226_TARGET, name: '0226_staff_login_bindings.sql',
    sha256: 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5', sql: `${migration}\n`, appendLedger: true }), /migration_pin_mismatch/u);
  await assert.rejects(provider.applyExactMigration({ target: PRODUCTION_OPS_0226_TARGET, name: '0226_staff_login_bindings.sql',
    sha256: 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5', sql: migration, appendLedger: true }), /request_uncertain_no_retry/u);
  assert.equal(mutationCalls, 1);
});

test('partial REST batch results are ambiguous and are never retried', async () => {
  let mutationCalls = 0;
  const provider = createProductionOps0226CloudflareProvider({ getBearerToken: async () => 'synthetic-token-'.padEnd(32, 'x'),
    fetchImpl: async (_url, init) => {
      if (init.method === 'GET') return response(validMetadata);
      mutationCalls++;
      const batch = JSON.parse(init.body).batch;
      return response({ success: true, result: batch.map((_item, index) => ({ success: index < 3,
        results: [], ...(index === 2 ? { meta: { changes: 1 } } : {}) })) });
    } });
  await provider.assertTarget();
  await assert.rejects(provider.applyExactMigration({ target: PRODUCTION_OPS_0226_TARGET, name: '0226_staff_login_bindings.sql',
    sha256: 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5', sql: migration, appendLedger: true }),
  /batch_outcome_uncertain_no_retry/u);
  assert.equal(mutationCalls, 1);
});
