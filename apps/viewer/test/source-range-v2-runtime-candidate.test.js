'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createSourceRangeV2RuntimeCandidate, sourceRangeV2Middleware } = require('../server/sourceRangeV2RuntimeCandidate');
const { PREFIX } = require('../server/sourceRangeV2Candidate');
const { parseTrustedProxyAddresses } = require('../server/proxyGate');

test('runtime remains absent and creates no source state while disabled', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-range-v2-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createSourceRangeV2RuntimeCandidate({
    config: { processingSourceRangeV2Enabled: false },
  });
  assert.equal(runtime, null);
  assert.equal(fs.existsSync(path.join(root, 'source-range-v2')), false);
});

test('enabled runtime creates a durable private subdirectory and mounts only the range route', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-range-v2-runtime-'));
  const dataDir = path.join(root, 'data'), datasetsMount = path.join(root, 'datasets');
  fs.mkdirSync(dataDir); fs.mkdirSync(datasetsMount);
  let runtime;
  t.after(() => { try { runtime?.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  runtime = createSourceRangeV2RuntimeCandidate({
    config: { processingSourceRangeV2Enabled: true, processingPlatformEnabled: true,
      production: false, dataDir, datasetsMount },
    database: { prepare() { throw new Error('the resolver must not run before a grant is minted'); } },
    storage: { resolve() { throw new Error('the resolver must not run before a grant is minted'); } },
  });
  const privateDir = path.join(dataDir, 'source-range-v2');
  const stat = fs.statSync(privateDir);
  assert.equal(stat.isDirectory(), true);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0);

  const middleware = sourceRangeV2Middleware(runtime.handler);
  const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const route = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}object-1`);
  assert.equal(route.status, 503); // Plain HTTP is rejected before broker access.
  const unrelated = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  assert.equal(unrelated.status, 404);
});

test('production runtime refuses a missing trusted proxy identity before opening state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-range-v2-runtime-'));
  const dataDir = path.join(root, 'data'), datasetsMount = path.join(root, 'datasets');
  fs.mkdirSync(dataDir); fs.mkdirSync(datasetsMount);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => createSourceRangeV2RuntimeCandidate({
    config: { processingSourceRangeV2Enabled: true, processingPlatformEnabled: true,
      production: true, dataDir, datasetsMount, trustedProxyAllowlist: { entries: [] },
      proxySharedSecret: '', trustProxyHops: 1 },
    database: { prepare() {} }, storage: { resolve() {} },
  }), { code: 'SOURCE_RANGE_TRANSPORT_CONFIGURATION_INVALID' });
  assert.equal(fs.existsSync(path.join(dataDir, 'source-range-v2')), false);
});

test('production range requests require trusted HTTPS, proxy source and the proxy secret', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-range-v2-runtime-'));
  const dataDir = path.join(root, 'data'), datasetsMount = path.join(root, 'datasets');
  fs.mkdirSync(dataDir); fs.mkdirSync(datasetsMount);
  const secret = 'source-range-proxy-secret-000000000000000000';
  let runtime;
  t.after(() => { try { runtime?.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  runtime = createSourceRangeV2RuntimeCandidate({
    config: { processingSourceRangeV2Enabled: true, processingPlatformEnabled: true,
      production: true, dataDir, datasetsMount, trustedProxyAllowlist: parseTrustedProxyAddresses('127.0.0.1'),
      proxySharedSecret: secret, trustProxyHops: 1 },
    database: { prepare() { throw new Error('range auth must fail before source resolution'); } },
    storage: { resolve() { throw new Error('range auth must fail before source resolution'); } },
  });
  const request = ({ secure = true, remoteAddress = '127.0.0.1', suppliedSecret = secret } = {}) => ({
    url: `${PREFIX}object-1`, method: 'GET', secure,
    socket: { remoteAddress }, headers: { authorization: `Bearer ${'x'.repeat(43)}` },
    get(name) { return name === 'X-Viewer-Proxy-Secret' ? suppliedSecret : undefined; },
  });
  const response = () => ({ statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    removeHeader(k) { delete this.headers[k.toLowerCase()]; }, end(body) { this.body = body; } });
  for (const input of [{ secure: false }, { remoteAddress: '192.0.2.1' }, { suppliedSecret: 'wrong' }]) {
    const res = response();
    assert.equal(await runtime.handler(request(input), res), true);
    assert.equal(res.statusCode, 503);
  }
  const res = response();
  assert.equal(await runtime.handler(request(), res), true);
  assert.equal(res.statusCode, 401); // Transport passed; absent bearer fails at broker authorization.
});
