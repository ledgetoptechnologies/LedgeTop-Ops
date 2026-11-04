'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { createPreparedSubmissionMtlsTransport } = require('../server/preparedSubmissionMtlsTransport');

const fixtures = path.join(__dirname, 'fixtures', 'prepared-submission-mtls');
const read = name => fs.readFileSync(path.join(fixtures, name));
const authorityId = '11111111-1111-4111-8111-111111111111';
const submissionId = '22222222-2222-4222-8222-222222222222';
const basePath = `/ltds/prepared/v3/submissions/${submissionId}`;

function startServer(t, handler) {
  const server = https.createServer({
    key: read('server.key.pem'),
    cert: read('server.cert.pem'),
    ca: read('test.ca.pem'),
    requestCert: true,
    rejectUnauthorized: true,
  }, handler);
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(`https://127.0.0.1:${server.address().port}`);
    });
  });
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return listening;
}

function makeTransport(origin, overrides = {}) {
  return createPreparedSubmissionMtlsTransport({
    origin,
    authorityId,
    bearerToken: 'synthetic-viewer-mtls-test-token-0001',
    serverCa: read('test.ca.pem'),
    clientCertificate: read('client.cert.pem'),
    clientPrivateKey: read('client.key.pem'),
    timeoutMs: 1000,
    ...overrides,
  });
}

function options({ method = 'GET', body, signal } = {}) {
  return {
    method,
    ...(body == null ? {} : { body }),
    headers: {
      Authorization: 'Bearer synthetic-viewer-mtls-test-token-0001',
      'X-LTDS-Expected-Coordinator-Authority': authorityId,
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    redirect: 'error', cache: 'no-store', credentials: 'omit',
    ...(signal ? { signal } : {}),
  };
}

test('prepared transport uses the pinned server CA and presents its own client identity', async t => {
  const origin = await startServer(t, (req, res) => {
    assert.equal(req.socket.authorized, true);
    assert.equal(req.socket.getPeerCertificate().subject.CN, 'viewer-staging-test-identity');
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/ltds/prepared/v3/submissions');
    assert.equal(req.headers.authorization, 'Bearer synthetic-viewer-mtls-test-token-0001');
    assert.equal(req.headers['x-ltds-expected-coordinator-authority'], authorityId);
    assert.equal(req.headers.cookie, undefined);
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      assert.equal(body, '{"submissionId":"22222222-2222-4222-8222-222222222222"}');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{"status":"prepared"}');
    });
  });
  const transport = makeTransport(origin);
  t.after(() => transport.close());
  const response = await transport.fetchImpl(`${origin}/ltds/prepared/v3/submissions`, options({
    method: 'POST', body: `{"submissionId":"${submissionId}"}`,
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { status: 'prepared' });
});

test('prepared transport rejects an untrusted server CA and an untrusted client certificate', async t => {
  const origin = await startServer(t, (_req, res) => res.end('{"unexpected":true}'));
  const wrongServer = makeTransport(origin, { serverCa: read('rogue.ca.pem') });
  t.after(() => wrongServer.close());
  await assert.rejects(wrongServer.fetchImpl(`${origin}${basePath}`, options()), { code: 'prepared_submission_transport_uncertain' });

  const wrongClient = makeTransport(origin, {
    clientCertificate: read('rogue-client.cert.pem'),
    clientPrivateKey: read('rogue-client.key.pem'),
  });
  t.after(() => wrongClient.close());
  await assert.rejects(wrongClient.fetchImpl(`${origin}${basePath}`, options()), { code: 'prepared_submission_transport_uncertain' });
});

test('prepared transport refuses redirects without following the Location', async t => {
  let requests = 0;
  const origin = await startServer(t, (_req, res) => {
    requests++;
    res.writeHead(302, { Location: 'https://redirect.invalid/private' });
    res.end();
  });
  const transport = makeTransport(origin);
  t.after(() => transport.close());
  await assert.rejects(transport.fetchImpl(`${origin}${basePath}`, options()), { code: 'prepared_submission_redirect_rejected' });
  assert.equal(requests, 1);
});

test('prepared transport bounds response bytes and request duration', async t => {
  const origin = await startServer(t, (req, res) => {
    if (req.url.endsWith('/activate')) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('x'.repeat(1025));
  });
  const bounded = makeTransport(origin, { maxResponseBytes: 1024 });
  t.after(() => bounded.close());
  await assert.rejects(bounded.fetchImpl(`${origin}${basePath}`, options()), { code: 'prepared_submission_response_too_large' });

  const timeoutOrigin = await startServer(t, (_req, _res) => {});
  const timed = makeTransport(timeoutOrigin, { timeoutMs: 100 });
  t.after(() => timed.close());
  await assert.rejects(timed.fetchImpl(`${timeoutOrigin}${basePath}`, options()), { code: 'prepared_submission_transport_uncertain' });
});

test('prepared transport rejects alternate origins, arbitrary paths, and use after close', async t => {
  const origin = await startServer(t, (_req, res) => res.end('{}'));
  const transport = makeTransport(origin);
  t.after(() => transport.close());
  await assert.rejects(transport.fetchImpl('https://elsewhere.invalid/ltds/prepared/v3/submissions', options()), { code: 'prepared_submission_request_target_rejected' });
  await assert.rejects(transport.fetchImpl(`${origin}/admin`, options()), { code: 'prepared_submission_request_target_rejected' });
  await assert.rejects(transport.fetchImpl(`${origin}/ltds/prepared/v3/submissions?redirect=1`, options({ method: 'POST', body: '{}' })), { code: 'prepared_submission_request_target_rejected' });
  await assert.rejects(transport.fetchImpl(`${origin}/ltds/prepared/v3/submissions`, options()), { code: 'prepared_submission_request_method_rejected' });
  await assert.rejects(transport.fetchImpl(`${origin}${basePath}`, options({ method: 'POST', body: '{}' })), { code: 'prepared_submission_request_method_rejected' });
  await assert.rejects(transport.fetchImpl(`${origin}${basePath}/activate`, options()), { code: 'prepared_submission_request_target_rejected' });
  const activation = await transport.fetchImpl(`${origin}${basePath}/activation`, options({ method: 'POST', body: '{}' }));
  assert.equal(activation.status, 200);
  transport.close();
  await assert.rejects(transport.fetchImpl(`${origin}${basePath}`, options()), { code: 'prepared_submission_transport_closed' });
});
