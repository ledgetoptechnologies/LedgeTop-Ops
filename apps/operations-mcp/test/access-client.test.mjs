import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessClient, AccessClientError, loadConfig } from '../src/access-client.mjs';

const jwt = exp => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.c2ln`;
const token = jwt(Math.floor(Date.now() / 1000) + 3600);
const csrf = 'a'.repeat(64);
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const config = allowWrites => loadConfig({ LTDS_MCP_ALLOW_WRITES: allowWrites ? 'true' : 'false' });

test('config is fail closed and requires HTTPS origin and bounded label', () => {
  assert.equal(loadConfig({}).origin, 'https://ops.ledgetopdroneservices.com');
  for (const origin of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?x=1', 'https://example.com/#x', 'https://example.com\\api', 'https://example.com/a/..', 'https://example.com?', 'https://example.com#']) {
    assert.throws(() => loadConfig({ LTDS_OPS_ORIGIN: origin }), /HTTPS origin/);
  }
  for (const allow of ['TRUE', '1', ' true ']) assert.equal(loadConfig({ LTDS_MCP_ALLOW_WRITES: allow }).allowWrites, false);
  assert.throws(() => loadConfig({ LTDS_MCP_AGENT_ID: 'bad\nlabel' }), /label/);
  assert.throws(() => loadConfig({ LTDS_MCP_AGENT_ID: 'a'.repeat(65) }), /label/);
});

test('disabled writes stop before auth and network; only exact preview POST is exempt', async () => {
  let calls = 0;
  const client = new AccessClient(config(false), { getToken: () => { calls++; return token; }, fetch: async () => { calls++; return json({ csrfToken: csrf }); } });
  for (const [path, method] of [['/api/clients', 'POST'], ['/api/delivery/authenticated-grants/preview?x=1', 'POST'], ['/api/delivery/authenticated-grants/preview', 'DELETE']]) {
    await assert.rejects(client.request(path, { method }), /writes are disabled/);
  }
  assert.equal(calls, 0);
  await client.request('/api/delivery/authenticated-grants/preview', { method: 'POST', body: {} });
  assert.equal(calls, 3);
});

test('rejects traversal, encoded separators, fragments, and external destinations before auth', async () => {
  let calls = 0;
  const client = new AccessClient(config(false), { getToken: () => { calls++; return token; } });
  for (const path of ['https://evil.test/api/a', '//evil.test/api/a', '/api/../admin', '/api/%2e%2e/admin', '/api/a%2fb', '/api/%252e%252e/admin', '/api/a\\b', '/api/a#x', '/api/a%3fb']) {
    await assert.rejects(client.request(path), /Invalid Operations API path/);
  }
  assert.equal(calls, 0);
});

test('session returns only sanitized identity and local connection settings', async () => {
  const client = new AccessClient(config(false), { getToken: () => token, fetch: async () => json({
    user: { id: 'staff-1', email: 'owner@example.com', displayName: token, secret: 'secret', permissions: { browse: true, accessToken: token } }, csrfToken: csrf, mapboxPublicToken: 'nope',
    capabilities: { financeSummary: { enabled: true, secret: 'nope' }, description: token }
  }) });
  assert.deepEqual(await client.session(), { user: { id: 'staff-1', email: 'owner@example.com', displayName: '[redacted]', permissions: { browse: true } }, capabilities: { financeSummary: { enabled: true }, description: '[redacted]' }, agentId: 'local-agent', allowWrites: false });
});

test('safe client diagnostics use AccessClientError without surfacing arbitrary provider errors', async () => {
  assert.throws(() => loadConfig({ LTDS_OPS_ORIGIN: 'http://example.com' }), error => error instanceof AccessClientError && error.name === 'AccessClientError');
  const readonly = new AccessClient(config(false));
  await assert.rejects(readonly.request('/api/clients', { method: 'POST' }), AccessClientError);
  const offline = new AccessClient(config(false), { getToken: () => token, fetch: () => { throw new Error(token); } });
  await assert.rejects(offline.request('/api/clients'), error => error instanceof AccessClientError && error.name === 'AccessClientError' && !error.message.includes(token));
});

test('every mutation obtains fresh CSRF and sends correct auth, Origin, and idempotency', async () => {
  const calls = [];
  let sessions = 0;
  const client = new AccessClient(config(true), { getToken: () => token, fetch: async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/api/session') ? json({ csrfToken: `${++sessions}`.repeat(64) }) : json({ success: true, csrfToken: csrf, nested: { authorization: token }, description: token });
  } });
  const result = await client.request('/api/clients', { method: 'POST', body: { name: 'Client' }, idempotencyKey: 'create-1' });
  await client.request('/api/clients/1', { method: 'PATCH', body: {} });
  assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/api/session', '/api/clients', '/api/session', '/api/clients/1']);
  assert.equal(calls[1].init.headers['X-CSRF-Token'], '1'.repeat(64));
  assert.equal(calls[3].init.headers['X-CSRF-Token'], '2'.repeat(64));
  assert.equal(calls[1].init.headers.Origin, config(true).origin);
  assert.equal(calls[1].init.headers['Cf-Access-Token'], token);
  assert.equal(calls[1].init.headers['Idempotency-Key'], 'create-1');
  assert.equal(calls[1].init.redirect, 'error');
  assert.ok(calls[1].init.signal instanceof AbortSignal);
  assert.deepEqual(result, { success: true, nested: {}, description: '[redacted]' });
});

test('missing and expired token fail before network without leaking token or provider error', async () => {
  for (const value of ['secret-output', jwt(1), '']) {
    const client = new AccessClient(config(false), { getToken: () => value, fetch: () => { throw new Error('network should not run'); } });
    await assert.rejects(client.session(), error => error.message.includes('session unavailable') && !error.message.includes(value || 'secret-output'));
  }
  const client = new AccessClient(config(false), { getToken: () => { throw new Error(token); } });
  await assert.rejects(client.session(), error => !String(error).includes(token));
});

test('does not expose raw server errors, fetch errors, HTML, invalid JSON, or redirects', async () => {
  const responses = [
    () => new Response(`secret ${token}`, { status: 403 }),
    () => { throw new Error(`network ${token}`); },
    () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response(`not-json ${token}`, { headers: { 'content-type': 'application/json' } }),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
  ];
  for (const fetch of responses) {
    const client = new AccessClient(config(false), { getToken: () => token, fetch });
    await assert.rejects(client.request('/api/clients'), error => !String(error).includes(token) && !String(error).includes('<html>') && !String(error).includes('not-json'));
  }
});

test('caps streamed responses without trusting Content-Length', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(600_000)); }, cancel() { cancelled = true; } });
  const client = new AccessClient(config(false), { getToken: () => token, fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(client.request('/api/clients'), /size limit/);
  assert.equal(cancelled, true);
});

test('rejects invalid bodies and idempotency headers before authentication', async () => {
  let calls = 0;
  const client = new AccessClient(config(true), { getToken: () => { calls++; return token; } });
  await assert.rejects(client.request('/api/clients', { method: 'GET', body: {} }), /cannot have a body/);
  await assert.rejects(client.request('/api/clients', { method: 'POST', body: {}, idempotencyKey: 'x\r\ninjected' }), /idempotency/);
  await assert.rejects(client.request('/api/clients', { method: 'POST', body: { huge: 'x'.repeat(1024 * 1024) } }), /size limit/);
  const circular = {}; circular.self = circular;
  await assert.rejects(client.request('/api/clients', { method: 'POST', body: circular }), /must be JSON/);
  assert.equal(calls, 0);
});
