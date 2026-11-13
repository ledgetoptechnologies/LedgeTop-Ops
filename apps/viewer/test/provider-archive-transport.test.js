'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const { downloadProviderArchive } = require('../server/providerArchiveTransport');

// Public synthetic test-only key/certificate; never used for a deployment.
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJe6FPBe5Xv6whFEE
GTAUpYKWhE1bUnv2Cj7kJfL+Nc6hRANCAAQdCwn6Z6XWtyKbVK0u0DrECjdNtnzN
hBqzD3HGfqwjuSmqfNagWVGFSDwaC+88qkCRbXimNYkzWZFcODztQlMO
-----END PRIVATE KEY-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIB1jCCAX2gAwIBAgIUHO1KtCAJXNCW2x/mPcLrNo/P+wowCgYIKoZIzj0EAwIw
MjESMBAGA1UEAwwJbG9jYWxob3N0MRwwGgYDVQQKDBNTeW50aGV0aWMgVGVzdCBP
bmx5MCAXDTI2MTExMzEwNDM0NFoYDzIxMjYxMDIwMTA0MzQ0WjAyMRIwEAYDVQQD
DAlsb2NhbGhvc3QxHDAaBgNVBAoME1N5bnRoZXRpYyBUZXN0IE9ubHkwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAAQdCwn6Z6XWtyKbVK0u0DrECjdNtnzNhBqzD3HG
fqwjuSmqfNagWVGFSDwaC+88qkCRbXimNYkzWZFcODztQlMOo28wbTAdBgNVHQ4E
FgQUek1wGPtlv5B2f25TI+QZ6CY11REwHwYDVR0jBBgwFoAUek1wGPtlv5B2f25T
I+QZ6CY11REwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwCgYIKoZIzj0EAwIDRwAwRAIgYl0B6ScT45QrYWNvK9GX9SXM4m27ceaP
odotZZHafNECIH1bdM3CU9WW3C+LRD784KltkZOxDdrIcQn2wodVo44+
-----END CERTIFICATE-----
`;

async function serverFor(t, handler, secure = false) {
  const server = secure ? https.createServer({ key: KEY, cert: CERT }, handler) : http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `${secure ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}

test('native archive GET preserves bytes through backpressure and Connection: close', async t => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x6d), expected = crypto.createHash('sha256').update(bytes).digest('hex');
  let seen;
  const origin = await serverFor(t, (req, res) => {
    seen = { url: req.url, encoding: req.headers['accept-encoding'], method: req.method };
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length, connection: 'close' }); res.end(bytes);
  });
  const response = await downloadProviderArchive(`${origin}/task/synthetic/download/all.zip?token=synthetic-test-token`);
  await new Promise(resolve => setTimeout(resolve, 60));
  const sha = crypto.createHash('sha256'); let count = 0;
  await pipeline(Readable.fromWeb(response.body), new Writable({ highWaterMark: 1024, write(chunk, _encoding, callback) {
    count += chunk.length; sha.update(chunk); setImmediate(callback);
  } }));
  assert.equal(count, bytes.length); assert.equal(sha.digest('hex'), expected);
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(seen, { url: '/task/synthetic/download/all.zip?token=synthetic-test-token', encoding: 'identity', method: 'GET' });
});

test('an unread 32MiB response pauses the native stream and backpressures the sender', async t => {
  const total = 32 * 1024 * 1024, chunk = Buffer.alloc(64 * 1024, 0x35);
  let written = 0, incoming;
  const request = http.request;
  t.mock.method(http, 'request', (url, options, callback) => request(url, options, response => {
    incoming = response; callback(response);
  }));
  const origin = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'content-length': total, connection: 'close' });
    const write = () => {
      while (written < total) {
        written += chunk.length;
        if (!res.write(chunk)) { res.once('drain', write); return; }
      }
      res.end();
    };
    write();
  });
  const response = await downloadProviderArchive(origin);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(incoming.isPaused(), true, 'unread Web body pauses the native stream');
  assert.ok(incoming.readableLength <= 128 * 1024, `native buffered bytes=${incoming.readableLength}`);
  assert.ok(written < total / 2, `sender must not buffer the entire archive before consumption; wrote=${written}`);
  t.diagnostic(JSON.stringify({ archiveBytes: total, nativeBufferedBytes: incoming.readableLength, senderWrittenBeforeConsumption: written }));
  let received = 0;
  await pipeline(Readable.fromWeb(response.body), new Writable({ highWaterMark: 1024, write(bytes, _encoding, callback) {
    received += bytes.length; setImmediate(callback);
  } }));
  assert.equal(received, total);
});

test('EOF-delimited and chunked complete bodies finish without truncation', async t => {
  for (const mode of ['eof', 'chunked']) {
    const origin = await serverFor(t, (_req, res) => {
      res.useChunkedEncodingByDefault = mode === 'chunked';
      res.writeHead(200, { connection: 'close', 'content-type': 'application/zip' }); res.write('first'); res.end('last');
    });
    const response = await downloadProviderArchive(origin);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await response.text(), 'firstlast');
  }
});

test('premature Content-Length end rejects the body rather than reporting success', async t => {
  const origin = await serverFor(t, (_req, res) => {
    res.writeHead(200, { 'content-length': '100', connection: 'close' }); res.end('short');
  });
  const response = await downloadProviderArchive(origin);
  await assert.rejects(response.arrayBuffer(), error => ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code));
});

test('unterminated chunked response rejects rather than accepting the received prefix', async t => {
  const server = net.createServer(socket => socket.once('data', () => socket.end(
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nshort\r\n')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await downloadProviderArchive(`http://127.0.0.1:${server.address().port}`);
  await assert.rejects(response.arrayBuffer(), error => ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code));
});

test('redirect is refused without forwarding provider credentials', async t => {
  let destinationCalls = 0;
  const destination = await serverFor(t, (_req, res) => { destinationCalls++; res.end('wrong'); });
  const origin = await serverFor(t, (_req, res) => { res.writeHead(302, { location: `${destination}/capture` }); res.end(); });
  await assert.rejects(downloadProviderArchive(`${origin}/?token=synthetic-secret`), { code: 'provider_request_failed', status: 302 });
  assert.equal(destinationCalls, 0);
});

test('caller abort before headers and during a body preserves its reason', async t => {
  const reason = Object.assign(new Error('synthetic lease lost'), { code: 'lease_lost' });
  const before = new AbortController(); before.abort(reason);
  assert.throws(() => downloadProviderArchive('http://127.0.0.1:1', { signal: before.signal }), error => error === reason);
  const origin = await serverFor(t, (_req, res) => { res.writeHead(200); res.write('partial'); });
  const during = new AbortController(), response = await downloadProviderArchive(origin, { signal: during.signal });
  during.abort(reason);
  await assert.rejects(response.text(), error => error === reason);
});

test('headers and total body deadlines destroy the transfer and reject', async t => {
  const noHeaders = await serverFor(t, () => {});
  await assert.rejects(downloadProviderArchive(noHeaders, { timeoutMs: 1000, headersTimeoutMs: 20 }), { code: 'ETIMEDOUT' });
  const body = await serverFor(t, (_req, res) => { res.writeHead(200); res.write('partial'); });
  const response = await downloadProviderArchive(body, { timeoutMs: 30, headersTimeoutMs: 1000 });
  await assert.rejects(response.text(), { code: 'ETIMEDOUT' });
});

test('response cancellation closes its owned socket', async t => {
  let peerClosed;
  const closed = new Promise(resolve => { peerClosed = resolve; });
  const origin = await serverFor(t, (req, res) => { req.socket.once('close', peerClosed); res.writeHead(200); res.write('partial'); });
  const response = await downloadProviderArchive(origin); await response.body.cancel(); await closed;
});

test('HTTP errors retain status and unexpected content encoding is refused', async t => {
  for (const code of [404, 503]) {
    const origin = await serverFor(t, (_req, res) => { res.writeHead(code); res.end('no archive'); });
    await assert.rejects(downloadProviderArchive(origin), { code: code === 404 ? 'provider_task_not_found' : 'provider_request_failed', status: code });
  }
  const encoded = await serverFor(t, (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end('encoded'); });
  await assert.rejects(downloadProviderArchive(encoded), { code: 'provider_archive_encoding_unsupported' });
});

test('synchronous native request failure rejects with its original error', async t => {
  const failure = Object.assign(new Error('synthetic request construction failure'), { code: 'ERR_SYNTHETIC_REQUEST' });
  t.mock.method(http, 'request', () => { throw failure; });
  await assert.rejects(downloadProviderArchive('http://127.0.0.1'), error => error === failure);
});

test('TLS rejects an untrusted certificate and honors configured extra CA without bypass', async t => {
  const origin = await serverFor(t, (_req, res) => { res.end('trusted synthetic archive'); }, true);
  await assert.rejects(downloadProviderArchive(origin), error => ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error.code));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-archive-ca-')); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const ca = path.join(temp, 'synthetic-ca.pem'); fs.writeFileSync(ca, CERT);
  const helper = path.resolve(__dirname, '../server/providerArchiveTransport.js');
  const script = 'const {downloadProviderArchive}=require(process.argv[1]);downloadProviderArchive(process.argv[2]).then(r=>r.text()).then(x=>{if(x!=="trusted synthetic archive")process.exitCode=2;}).catch(()=>{process.exitCode=3;});';
  const child = spawn(process.execPath, ['-e', script, helper, origin], { env: { ...process.env, NODE_EXTRA_CA_CERTS: ca }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const deadline = setTimeout(() => child.kill(), 5000); t.after(() => clearTimeout(deadline));
  const exit = await new Promise(resolve => child.once('exit', resolve)); clearTimeout(deadline); assert.equal(exit, 0);
});
