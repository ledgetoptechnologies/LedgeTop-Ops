// Device proxy (public controller host -> private NAS Logs host): only the device API, its own Access service token,
// header allowlist (no cookies, no staff actor), streamed bodies, size limit, and a clean 503 + Retry-After whenever
// the Logs host cannot answer. Fake upstream fetch only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceHostAllowed, deviceProxyEnabled, proxyDeviceRequest } from '../src/worker/device-proxy.mjs';
import { registerHooks } from 'node:module';

// The Worker entry imports cloudflare:workers; give it a minimal stand-in so the real fetch handler can run here.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
  return next(specifier, context);
} });
const { default: worker } = await import('../src/worker/index.mjs');

const env = { LOGS_DEVICE_UPSTREAM_MODE: 'local', LOGS_DEVICE_UPSTREAM_URL: 'https://logs-backend-staging.example.test/',
  LOGS_DEVICE_ACCESS_CLIENT_ID: 'device-proxy.access', LOGS_DEVICE_ACCESS_CLIENT_SECRET: 's'.repeat(32),
  LOGS_DEVICE_PUBLIC_HOSTS: 'logs.example.test' };
const SHA = 'a'.repeat(64);
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
  // Under the device prefix, only the exact method + path contract is forwarded; the rest is 404 here.
  for (const [method, path] of [['GET', '/api/v1/device/'], ['GET', '/api/v1/device/admin'], ['DELETE', '/api/v1/device/me'],
    ['GET', `/api/v1/device/logs/${SHA}`], ['PUT', '/api/v1/device/logs/short'], ['PUT', `/api/v1/device/logs/${'A'.repeat(64)}`],
    ['GET', '/api/v1/device/sign-in'], ['GET', '/api/v1/device/sign-in/not-a-uuid'], ['OPTIONS', '/api/v1/device/me']]) {
    const response = await proxyDeviceRequest(new Request(`https://logs.example.test${path}`, { method, headers: { Authorization: 'Bearer x' } }), env, { fetchImpl });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
});

test('forwards with its own Access token, the controller address and allowlisted headers only; streams the body', async () => {
  const { calls, fetchImpl } = upstream();
  const body = new Uint8Array([1, 2, 3, 4]);
  const response = await proxyDeviceRequest(new Request(`https://logs.example.test/api/v1/device/logs/${SHA}?name=DJIFlightRecord_1.txt`, {
    method: 'PUT', body, headers: { Authorization: 'Bearer controller-token-0000000000', 'Content-Length': '4',
      'CF-Connecting-IP': '198.51.100.9', Cookie: 'session=secret', 'X-Ledge-Top-Actor': 'forged-staff', 'X-Other': 'nope' } }), env, { fetchImpl });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { stored: true, duplicate: false });
  assert.equal(response.headers.get('set-cookie'), null, 'upstream cookies are not passed back');
  const [call] = calls;
  assert.equal(call.url, `https://logs-backend-staging.example.test/api/v1/device/logs/${SHA}?name=DJIFlightRecord_1.txt`);
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
  const response = await proxyDeviceRequest(new Request(`https://logs.example.test/api/v1/device/logs/${SHA}`, {
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
    // Access rejecting this proxy's service token: a 401 that is not the Logs host's JSON.
    () => new Response('<html>Forbidden</html>', { status: 401, headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{"error":"unauthorized"}', { status: 401 }),
    // The Logs host's own machine-auth denial (code-less JSON 404) means this proxy was not admitted.
    () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    // An edge 500 page, a JSON 2xx imposter and an unbounded error body.
    () => new Response('<html>error</html>', { status: 500, headers: { 'Content-Type': 'text/html' } }),
    () => new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    () => new Response('x'.repeat(70 * 1024), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    () => new Response('[1]', { status: 400, headers: { 'Content-Type': 'application/json' } }),
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
  assert.deepEqual(await refused.json(), { code: 'device_unauthenticated' });
  const internal = await proxyDeviceRequest(new Request('https://logs.example.test/api/v1/device/me'), env,
    { fetchImpl: upstream(() => new Response(JSON.stringify({ error: 'x', code: 'internal_error' }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } })).fetchImpl });
  assert.equal(internal.status, 500);
  assert.equal((await internal.json()).code, 'internal_error');
});

test('local mode answers only on the exact public device hostnames, health included; no fetch otherwise', async () => {
  assert.equal(deviceHostAllowed(new Request('https://LOGS.example.test/api/v1/device/me'), env), true);
  assert.equal(deviceHostAllowed(new Request('https://logs.example.test.evil.test/'), env), false);
  assert.equal(deviceHostAllowed(new Request('https://logs.example.test/'), { ...env, LOGS_DEVICE_PUBLIC_HOSTS: '' }), false);
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); };
  try {
    for (const url of ['https://other.workers.dev/health', 'https://other.workers.dev/api/v1/device/me', 'https://alias.example.test/api/v1/device/sign-in']) {
      const response = await worker.fetch(new Request(url, { method: url.endsWith('sign-in') ? 'POST' : 'GET' }), env);
      assert.equal(response.status, 404, url);
    }
    for (const hosts of [undefined, '']) {
      const response = await worker.fetch(new Request('https://logs.example.test/health'), { ...env, LOGS_DEVICE_PUBLIC_HOSTS: hosts });
      assert.equal(response.status, 404, 'no configured host allows nothing');
    }
    assert.equal(fetched, 0);
    assert.equal((await worker.fetch(new Request('https://logs.example.test/health'), env)).status, 200);
    assert.equal((await worker.fetch(new Request('https://logs.example.test/health', { method: 'POST', body: 'x' }), env)).status, 404, 'health is GET only');
    assert.equal((await worker.fetch(new Request('https://logs.example.test/api/v1/device/admin'), env)).status, 404);
    assert.equal((await worker.fetch(new Request('https://logs.example.test/internal/v1/logs/rpc/inventory', { method: 'POST' }), env)).status, 404);
    // Default (cloud) mode is unchanged: no host gate.
    assert.equal((await worker.fetch(new Request('https://other.workers.dev/health'), {})).status, 200);
  } finally { globalThis.fetch = original; }
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
