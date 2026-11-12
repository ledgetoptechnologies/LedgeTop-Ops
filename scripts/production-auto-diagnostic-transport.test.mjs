// The read-only diagnostic transport through the REAL canonical-v4 production path: the real release adapter factory,
// the real native pacer and the real installed-schema-preservation session constructor. Only globalThis.fetch (the
// network) is replaced, the same way the preservation tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProductionAutoReleaseAdapter } from './production-auto-runtime.mjs';
import { createReadonlyDiagnosticSink, guardReadonlyDiagnosticRuntime } from './production-auto-readonly-guard.mjs';
import { createProductionAutoCloudflarePacer, isNativeProductionCloudflareTransport } from './production-auto-cloudflare-pacer.mjs';
import { PROFILE as V4_PROFILE } from './production-deploy.mjs';
import {
  LEDGER_SQL, SCHEMA_SQL, PRODUCTION_DATABASES, createInstalledSchemaPreservationSession, readInstalledSchemaPreservationMetadata,
} from './production-auto-migration-profile/installed-schema-preservation-v1/installed-schema-preservation.mjs';

const ACCOUNT = '846c924bf17bf4f3dd15c97a4c5d1d51';
const SOURCE_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8',
  windowsHide: true, timeout: 5_000, maxBuffer: 1024 }).trim();
const env = Object.freeze({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'x'.repeat(40), GITHUB_TOKEN: 'g'.repeat(40),
  GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' });
const d1Rows = sql => sql === LEDGER_SQL ? [{ name: '0001_fixture.sql', id: 1 }]
  : [{ type: 'table', name: 'fixture', tbl_name: 'fixture', sql: 'CREATE TABLE fixture(id TEXT)' }];
const d1Response = body => new Response(JSON.stringify({ success: true, result: [{ success: true, results: d1Rows(JSON.parse(body).sql),
  meta: { changes: 0, changed_db: false } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

test('the read-only pacer keeps the native brand, so the production schema session accepts it, and its D1 reads pass the guard', async t => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { sent.push({ url: String(url), sql: JSON.parse(init.body).sql }); return d1Response(init.body); });
  const refused = [];
  const pacer = createProductionAutoCloudflarePacer({ accountId: ACCOUNT, readonlyRefusals: refused });
  assert.equal(pacer.readonly, true);
  assert.equal(isNativeProductionCloudflareTransport(pacer.fetchImpl, ACCOUNT), true, 'still the branded native transport');
  const evidence = await readInstalledSchemaPreservationMetadata({ token: 'x'.repeat(32), fetchImpl: pacer.fetchImpl });
  assert.equal(evidence.readOnly, true);
  assert.deepEqual(sent.map(row => row.sql), [LEDGER_SQL, SCHEMA_SQL, LEDGER_SQL, SCHEMA_SQL], 'both databases, both pinned reads');
  assert.deepEqual(sent.map(row => row.url.split('/d1/database/')[1].split('/')[0]),
    [PRODUCTION_DATABASES.operations, PRODUCTION_DATABASES.operations, PRODUCTION_DATABASES.client, PRODUCTION_DATABASES.client]);
  assert.deepEqual(refused, []);
});

test('the read-only pacer refuses unpinned reads, writes and other SQL before sending, through the same branded transport', async t => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async url => { sent.push(String(url)); return new Response('{}'); });
  const refused = [];
  const { fetchImpl } = createProductionAutoCloudflarePacer({ accountId: ACCOUNT, readonlyRefusals: refused });
  const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
  await assert.rejects(fetchImpl(`${base}/workers/scripts/ledgetop-clients/secrets`), /probe_refused_non_read_request/u);
  await assert.rejects(fetchImpl(`${base}/d1/database/${PRODUCTION_DATABASES.client}/query`,
    { method: 'POST', body: JSON.stringify({ sql: 'DELETE FROM d1_migrations', params: [] }) }), /probe_refused_non_read_request/u);
  await assert.rejects(fetchImpl('https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/git/refs', { method: 'POST', body: '{}' }),
    /probe_refused_non_read_request/u);
  assert.deepEqual(sent, [], 'nothing refused was sent');
  assert.deepEqual(refused.map(row => row.category), ['refused_cloudflare_other_target', 'refused_d1_unreviewed_sql', 'refused_github_write']);
});

test('the production trust gate is unchanged: a read-only pacer over a non-native transport is not branded and is rejected', async () => {
  let calls = 0;
  const pacer = createProductionAutoCloudflarePacer({ accountId: ACCOUNT, readonlyRefusals: [], fetchImpl: async () => { calls++; return new Response('{}'); } });
  assert.equal(isNativeProductionCloudflareTransport(pacer.fetchImpl, ACCOUNT), false);
  await assert.rejects(createInstalledSchemaPreservationSession({ sourceCommit: SOURCE_COMMIT, canonicalV4Profile: V4_PROFILE, selectedApp: 'client',
    token: 'x'.repeat(32), fetchImpl: pacer.fetchImpl }), /preservation_production_transport_untrusted/u);
  assert.equal(calls, 0);
});

test('the REAL release adapter in diagnostic wiring reaches the canonical-v4 schema session with a trusted transport (no untrusted refusal)', async t => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => { sent.push({ url: String(url), method: init.method ?? 'GET' }); throw new Error('network_stop_for_test'); });
  const sink = createReadonlyDiagnosticSink();
  const runtime = guardReadonlyDiagnosticRuntime({ fetchImpl: globalThis.fetch, runtimeFactory: createProductionAutoReleaseAdapter, sink })
    .runtimeFactory({ workerName: 'ledgetop-clients', sourceCommit: SOURCE_COMMIT, triggerRun: { sourceCommit: SOURCE_COMMIT, runId: 42, runAttempt: 1 },
      env, recipientLoader: () => ({}) });
  try {
    assert.equal(runtime.readonlyTransport, true);
    // sourceFence -> checkMigrations -> createInstalledSchemaPreservationSession (canonical v4) -> its first capture read.
    await assert.rejects(runtime.adapter.sourceFence({ sourceCommit: SOURCE_COMMIT }), error => {
      assert.doesNotMatch(String(error?.message), /preservation_production_transport_untrusted|runtime_diagnostic_transport_refused/u);
      return true;
    });
    assert.ok(sent.length >= 1, 'the production session sent its first read through the guarded native transport');
    assert.match(sent[0].url, new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/workers/scripts/ledgetop-[a-z-]+/deployments\\?per_page=1$`, 'u'));
    assert.equal(sent[0].method, 'GET');
    assert.deepEqual(sink.refused, [], 'no probe refusal occurred, so no hold could be probe-induced');
    assert.deepEqual(sink.counts.entered, ['sourceFence']);
  } finally { runtime.close?.(); }
});

test('the real adapter refuses a diagnostic sink without the native transport, and the wiring refuses a factory without a read-only transport', async () => {
  assert.throws(() => createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients', sourceCommit: SOURCE_COMMIT,
    triggerRun: { sourceCommit: SOURCE_COMMIT, runId: 42, runAttempt: 1 }, env, recipientLoader: () => ({}),
    fetchImpl: async () => new Response('{}'), readonlyRefusals: [] }), /runtime_diagnostic_transport_refused/u);
  const wiring = guardReadonlyDiagnosticRuntime({ fetchImpl: globalThis.fetch, runtimeFactory: () => ({ adapter: {} }), sink: createReadonlyDiagnosticSink() });
  assert.throws(() => wiring.runtimeFactory({}), /runtime_diagnostic_transport_refused/u);
  // Release mode (no sink) is unchanged: no read-only transport is reported.
  const plain = createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients', sourceCommit: SOURCE_COMMIT,
    triggerRun: { sourceCommit: SOURCE_COMMIT, runId: 42, runAttempt: 1 }, env, recipientLoader: () => ({}) });
  try { assert.equal(plain.readonlyTransport, false); } finally { plain.close?.(); }
});
