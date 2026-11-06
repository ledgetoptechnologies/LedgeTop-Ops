import test from 'node:test';
import assert from 'node:assert/strict';
import { createStagingInquiryProvider } from './staging-inquiry-provider.mjs';

const account = '846c924bf17bf4f3dd15c97a4c5d1d51';
const worker = 'ledgetop-ops-staging';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const calls = [];
  let rows = [
    { id: id(2), metadata: { created_on: '2026-11-06T00:00:00Z' } },
    { id: id(1), metadata: { created_on: '2026-11-05T00:00:00Z' } },
  ];
  const bindings = [
    { name: 'CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED', type: 'plain_text', text: 'false' },
    { name: 'CLIENT_DELEGATED_SHARE_SIGNER_ENABLED', type: 'plain_text', text: 'false' },
    ...Array.from({ length: 126 }, (_, i) => ({ name: `VAR_${i}`, type: 'plain_text', text: 'x' })),
    { name: 'OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY', type: 'service', service: 'ledgetop-clients-staging', environment: 'production', entrypoint: 'OperationsPortalNativeRecipientAuthorityIngress' },
  ];
  const deployment = { id: id(3), versions: [{ version_id: id(1), percentage: 100 }, { version_id: id(2), percentage: 0 }] };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(new URL(url).hostname, 'api.cloudflare.com');
    assert.equal(url.includes(`/accounts/${account}/`), true);
    assert.equal(init.headers.Authorization, 'Bearer caller-token');
    const path = new URL(url).pathname.replace(`/client/v4/accounts/${account}`, '');
    let result;
    const params = new URL(url).searchParams;
    if (init.method === 'POST' && path === `/workers/scripts/${worker}/versions`) result = { id: id(9) };
    else if (path === `/workers/scripts/${worker}/deployments`) result = { deployments: [deployment] };
    else if (path === `/workers/scripts/${worker}/versions`) {
      const page = Number(params.get('page'));
      const perPage = Number(params.get('per_page'));
      const items = rows.slice((page - 1) * perPage, page * perPage);
      const envelope = { success: true, result: { items }, result_info: { page, per_page: perPage, count: items.length, total_count: rows.length } };
      return new Response(JSON.stringify(envelope), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    else if (path === `/workers/scripts/${worker}/versions/${id(1)}`) result = { id: id(1), resources: { bindings } };
    else if (path === `/workers/scripts/${worker}/versions/${id(2)}`) result = { id: id(2), resources: { bindings } };
    else if (path === `/workers/scripts/${worker}/versions/${id(9)}`) result = { id: id(9), resources: { bindings } };
    else throw new Error(`unexpected ${init.method} ${path}`);
    return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, addCandidate: () => { rows = [{ id: id(9), metadata: { created_on: '2026-11-07T00:00:00Z' } }, ...rows]; },
    setHistory: count => { rows = [rows[0], rows[1], ...Array.from({ length: count - 2 }, (_, i) => ({ id: id(100 + i), metadata: { created_on: new Date(Date.parse('2026-11-04T00:00:00Z') - i * 60_000).toISOString() } }))]; },
    provider: createStagingInquiryProvider({ token: 'caller-token', fetchImpl, now: () => new Date('2026-11-06T12:00:00Z') }) };
}

test('read fence uses fixed target, captures exact version list and maps provider list metadata', async () => {
  const { calls, provider } = fixture();
  const fence = await provider.readFence();
  assert.equal(fence.accountId, account);
  assert.equal(fence.workerName, worker);
  assert.equal(fence.versionList.complete, true);
  assert.deepEqual(fence.versionList.rows[0], { id: id(2), created_on: '2026-11-06T00:00:00Z' });
  assert.equal(fence.pin.latestVersionId, id(2));
  assert.equal(calls.every(call => call.init.method === 'GET'), true);
  assert.equal(calls.every(call => call.url.includes(`/accounts/${account}/workers/scripts/${worker}/`)), true);
});

test('candidate readback allows newest unattached candidate while preserving deployed zero-percent pin', async () => {
  const { calls, addCandidate, provider } = fixture();
  addCandidate();
  const readback = await provider.readCandidate(id(9));
  assert.equal(readback.versionList.rows[0].id, id(9));
  assert.equal(readback.fence.pin.latestVersionId, id(2));
  assert.equal(readback.fence.pinnedZeroPercentVersion.id, id(2));
  assert.equal(readback.candidateVersion.id, id(9));
  assert.equal(calls.filter(call => new URL(call.url).searchParams.has('page')).length, 1);
});

test('version inventory follows bounded multi-page envelope pagination', async () => {
  const { calls, setHistory, provider } = fixture();
  setHistory(236);
  const fence = await provider.readFence();
  assert.equal(fence.versionList.rows.length, 236);
  assert.deepEqual(calls.filter(call => new URL(call.url).searchParams.has('page')).map(call => new URL(call.url).searchParams.get('page')), ['1', '2', '3']);
});

test('version upload performs one strict-path POST and returns raw provider response', async () => {
  const { calls, provider } = fixture();
  const result = await provider.postVersion({ path: `/workers/scripts/${worker}/versions?bindings_inherit=strict`,
    body: Buffer.from('multipart'), contentType: 'multipart/form-data; boundary=synthetic' });
  assert.equal(result.httpStatus, 200);
  assert.match(result.rawResponseBytes.toString(), /"id":"00000000-0000-4000-8000-000000000009"/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/versions?bindings_inherit=strict`);
});

test('invalid account-target credentials and upload routes are refused before fetch', async () => {
  assert.throws(() => createStagingInquiryProvider({ token: '' }), /credential_invalid/);
  const { calls, provider } = fixture();
  await assert.rejects(provider.postVersion({ path: '/workers/scripts/ledgetop-ops/versions?bindings_inherit=strict',
    body: Buffer.from('x'), contentType: 'multipart/form-data; boundary=x' }), /upload_invalid/);
  assert.equal(calls.length, 0);
});

test('uncertain upload transport is surfaced as ambiguous and never retried', async () => {
  let calls = 0;
  const provider = createStagingInquiryProvider({ token: 'caller-token', fetchImpl: async () => { calls++; throw new Error('secret-bearing transport detail'); } });
  await assert.rejects(provider.postVersion({ path: `/workers/scripts/${worker}/versions?bindings_inherit=strict`,
    body: Buffer.from('multipart'), contentType: 'multipart/form-data; boundary=synthetic' }), error => {
    assert.equal(error.message, 'staging_inquiry_provider_request_uncertain');
    return true;
  });
  assert.equal(calls, 1);
});
