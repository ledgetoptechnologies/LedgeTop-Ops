// Device proxy (public controller host -> private NAS Logs host): only the device API, its own Access service token,
// header allowlist (no cookies, no staff actor), streamed bodies, size limit, and a clean 503 + Retry-After whenever
// the Logs host cannot answer. Fake upstream fetch only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceProxyEnabled, proxyDeviceRequest } from '../src/worker/device-proxy.mjs';

const env = { LOGS_DEVICE_UPSTREAM_MODE: 'local', LOGS_DEVICE_UPSTREAM_URL: 'https://logs-backend-staging.example.test/',
  LOGS_DEVICE_ACCESS_CLIENT_ID: 'device-proxy.access', LOGS_DEVICE_ACCESS_CLIENT_SECRET: 's'.repeat(32) };
function upstream(respond = () => new Response(JSON.stringify({ stored: true, duplicate: false }), { status: 201, headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'x=1' } })) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => { calls.push({ url: String(url), init, body: init.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : null }); return respond(url, init); } };
}

test('only in local mode, and only the device API', async () => {
  assert.equal(deviceProxyEnabled(env), true);
  assert.equal(deviceProxyEnabled({ ...env, LOGS_DEVICE_UPSTREAM_MODE: undefined }), false);
  const { calls, fetchImpl } = upstream();
  for (const path of ['/health', '/api/v1/decoder/claim', '/internal/v1/logs/rpc/inventory', '/'])
    assert.equal(await proxyDeviceRequest(new Request(`https://logs.example.test${path}`), env, { fetchImpl }), null, path);
  assert.equal(calls.length, 0);
});

test('forwards with its own Access token, the controller address and allowlisted headers only; streams the body', async () => {
  const { calls, fetchImpl } = upstream();
  const body = new Uint8Array([1, 2, 3, 4]);
  const response = await proxyDeviceRequest(new Request('https://logs.example.test/api/v1/device/logs/abc?name=DJIFlightRecord_1.txt', {
    method: 'PUT', body, headers: { Authorization: 'Bearer controller-token-0000000000', 'Content-Length': '4',
      'CF-Connecting-IP': '198.51.100.9', Cookie: 'session=secret', 'X-Ledge-Top-Actor': 'forged-staff', 'X-Other': 'nope' } }), env, { fetchImpl });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { stored: true, duplicate: false });
  assert.equal(response.headers.get('set-cookie'), null, 'upstream cookies are not passed back');
  const [call] = calls;
  assert.equal(call.url, 'https://logs-backend-staging.example.test/api/v1/device/logs/abc?name=DJIFlightRecord_1.txt');
  assert.equal(call.init.redirect, 'manual');
  const h = call.init.headers;
  assert.equal(h.get('CF-Access-Client-Id'), env.LOGS_DEVICE_ACCESS_CLIENT_ID);
  assert.equal(h.get('CF-Access-Client-Secret'), env.LOGS_DEVICE_ACCESS_CLIENT_SECRET);
  assert.equal(h.get('X-Ledge-Top-Client-IP'), '198.51.100.9');
  assert.equal(h.get('Authorization'), 'Bearer controller-token-0000000000');
  for (const dropped of ['Cookie', 'X-Ledge-Top-Actor', 'X-Other']) assert.equal(h.get(dropped), null, dropped);
  assert.deepEqual([...call.body], [1, 2, 3, 4]);
});

test('an upload announcing more than 100 MiB is refused before forwarding', async () => {
  const { calls, fetchImpl } = upstream();
  const response = await proxyDeviceRequest(new Request('https://logs.example.test/api/v1/device/logs/abc', {
    method: 'PUT', headers: { 'Content-Length': String(100 * 1024 * 1024 + 1) } }), env, { fetchImpl });
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test('whenever the Logs host cannot answer, the controller gets 503 + Retry-After (and keeps its queue)', async () => {
  const cases = [
    async () => { throw new Error('tunnel down'); },
    () => new Response(null, { status: 302, headers: { Location: 'https://team.cloudflareaccess.com/login' } }),
    () => new Response('bad gateway', { status: 502 }),
    () => new Response('origin unreachable', { status: 530 }),
  ];
  for (const respond of cases) {
    const response = await proxyDeviceRequest(new Request('https://logs.example.test/api/v1/device/me'), env, { fetchImpl: upstream(respond).fetchImpl });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '300');
    assert.equal((await response.json()).code, 'logs_unavailable');
  }
  // The Logs host's own answers (including refusals) pass through unchanged.
  const refused = await proxyDeviceRequest(new Request('https://logs.example.test/api/v1/device/me'), env,
    { fetchImpl: upstream(() => new Response(JSON.stringify({ code: 'device_unauthenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } })).fetchImpl });
  assert.equal(refused.status, 401);
});

test('incomplete configuration never forwards and never falls back', async () => {
  for (const broken of [{ LOGS_DEVICE_UPSTREAM_URL: 'http://plain.example.test/' }, { LOGS_DEVICE_UPSTREAM_URL: 'https://x.example.test/path' },
    { LOGS_DEVICE_ACCESS_CLIENT_SECRET: '' }, { LOGS_DEVICE_ACCESS_CLIENT_ID: 'x' }]) {
    const { calls, fetchImpl } = upstream();
    const response = await proxyDeviceRequest(new Request('https://logs.example.test/api/v1/device/me'), { ...env, ...broken }, { fetchImpl });
    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
  }
});
