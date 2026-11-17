// The logs host's public surface, checked without a runtime: anything outside the contract is 404 before
// authentication, body reads or database access. The env here has no database at all, so any path that
// reached the device or database code would throw instead of returning 404.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRequest } from '../src/worker/device-routes.mjs';

const untouchable = new Proxy({}, { get(_, key) { throw new Error(`env.${String(key)} was read`); } });
const call = (method, path, init = {}) => handlePublicRequest(new Request(`https://logs.example.test${path}`, { method, ...init }), untouchable);

test('/health answers GET only', async () => {
  const ok = await call('GET', '/health');
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { service: 'ledge-top-logs', ok: true });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal((await call(method, '/health')).status, 404, method);
  assert.equal((await call('GET', '/health/x')).status, 404);
});

test('unknown device paths and methods are 404 before any authentication or database access', async () => {
  const cases = [
    ['GET', '/api/v1/device/'], ['GET', '/api/v1/device/admin'], ['DELETE', '/api/v1/device/me'], ['POST', '/api/v1/device/me'],
    ['GET', '/api/v1/device/sign-in'], ['PUT', '/api/v1/device/sign-in'], ['GET', '/api/v1/device/sign-in/not-a-uuid'],
    ['DELETE', `/api/v1/device/sign-in/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`],
    ['GET', `/api/v1/device/logs/${'a'.repeat(64)}`], ['PUT', '/api/v1/device/logs/short'], ['PUT', `/api/v1/device/logs/${'A'.repeat(64)}`],
    ['GET', '/api/v1/device/have'], ['GET', '/api/v1/device/sign-out'], ['OPTIONS', '/api/v1/device/me'],
  ];
  for (const [method, path] of cases) {
    const response = await call(method, path, { headers: { Authorization: 'Bearer not-checked' } });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

test('everything outside /health and the device API is 404', async () => {
  for (const path of ['/', '/api', '/api/v1', '/api/v1/flights', '/api/v1/devices/me', '/login', '/.env']) assert.equal((await call('GET', path)).status, 404, path);
  assert.equal((await call('POST', '/', { body: 'x' })).status, 404);
});

test('allowlisted device routes do reach the device code (here: refused without a database binding)', async () => {
  // With no env at all the allowlisted route gets past the contract check and fails inside, not with 404.
  const response = await call('GET', '/api/v1/device/me');
  assert.notEqual(response.status, 404);
});
