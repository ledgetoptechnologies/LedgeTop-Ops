'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const p = require('../server/referenceProtocol');
const { CHUNK_BYTES, PREFIX, REQUEST_HEADER, SourceRangeV2Error, SourceRangeV2BrokerCandidate, createSourceRangeV2Handler, canonicalIdentity, requestIdFor } = require('../server/sourceRangeV2Candidate');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now0 = Date.parse('2035-01-01T00:00:00.000Z');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-range-v2-'));
  const file = path.join(root, 'photo.jpg');
  const bytes = options.bytes || Buffer.from('0123456789');
  fs.writeFileSync(file, bytes);
  const manifest = {
    id: 'manifest-1', revision: 1, sha256: '0'.repeat(64), totalBytes: bytes.length, objectCount: 1,
    inputCounts: { images: 1, lidarObjects: 0, points: 0 },
    objects: [{ id: 'photo-1', name: 'photo.jpg', byteSize: bytes.length, sha256: hash(bytes), kind: 'image', mediaType: 'image/jpeg' }],
  };
  manifest.sha256 = p.manifestSha256(manifest);
  const transferRequest = {
    protocol: 'source-range-v2', reservationId: 'reservation-1', generation: 1,
    expiresAt: '2035-01-01T00:30:00.000Z', manifestSha256: manifest.sha256,
    sourceVersion: 'source-rev-1', objectIds: ['photo-1'], chunkBytes: CHUNK_BYTES,
    requestBudget: Math.ceil(bytes.length / CHUNK_BYTES), byteBudget: bytes.length, nonce: 'nonce-1',
    attemptBudget: Math.ceil(bytes.length / CHUNK_BYTES) + 2,
  };
  const job = { jobId: 'job-1', generation: 1, environment: 'staging', manifestSha256: manifest.sha256,
    submission: { manifest }, transferRequest };
  let now = now0;
  const grantTokenKey = crypto.randomBytes(32);
  const dbPath = path.join(root, 'range-v2.sqlite');
  let broker = new SourceRangeV2BrokerCandidate({ databasePath: dbPath, managedRoot: root, grantTokenKey, allowCreate: true, now: () => now, maxGrantTtlMs: 5000 });
  const resolveSource = binding => ({
    jobId: binding.jobId, generation: binding.generation, environment: binding.environment,
    manifestSha256: binding.manifestSha256, sourceVersion: binding.sourceVersion,
    objects: binding.manifest.objects.map(object => ({ id: object.id, path: file, byteSize: object.byteSize, sha256: object.sha256 })),
  });
  function mint(resolver = resolveSource) { return broker.mintGrant({ job, resolveSource: resolver }); }
  function headersForRange(grant, start, overrides = {}) {
    const identity = { environment: 'staging', generation: 1, jobId: 'job-1', manifestSha256: manifest.sha256,
      reservationId: 'reservation-1', sourceVersion: 'source-rev-1' };
    const object = manifest.objects[0];
    const end = Math.min(start + CHUNK_BYTES - 1, object.byteSize - 1), length = end - start + 1;
    const requestId = requestIdFor(canonicalIdentity(identity), { id: object.id, byteSize: object.byteSize, sha256: object.sha256 }, start, length);
    return { objectId: object.id, authorization: `Bearer ${grant.token}`, method: 'GET', range: `bytes=${start}-${end}`,
      ifMatch: `"sha256-${object.sha256}"`, requestId, ...overrides };
  }
  function headers(grant, overrides = {}) { return headersForRange(grant, 0, overrides); }
  t.after(() => { try { broker.close(); } catch {} grantTokenKey.fill(0); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, bytes, manifest, job, transferRequest, dbPath, get broker() { return broker; }, set broker(value) { broker = value; }, resolveSource, mint, headers, headersForRange, setNow(value) { now = value; }, getNow() { return now; }, getGrantTokenKey() { return Buffer.from(grantTokenKey); } };
}

async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

test('Node request ID bytes match the Processing Python v2 vector', () => {
  const identity = { environment: 'staging', generation: 1, jobId: 'job-1', manifestSha256: 'a'.repeat(64), reservationId: 'reservation-1', sourceVersion: 'source-rev-1' };
  const object = { id: 'photo-1', byteSize: 10, sha256: 'b'.repeat(64) };
  const identityJson = '{"environment":"staging","generation":1,"jobId":"job-1","manifestSha256":"' + 'a'.repeat(64) + '","reservationId":"reservation-1","sourceVersion":"source-rev-1"}';
  const requestPayload = '["' + identityJson.replaceAll('"', '\\"') + '","photo-1",10,"' + 'b'.repeat(64) + '",0,10]';
  assert.equal(canonicalIdentity(identity), identityJson);
  assert.equal(JSON.stringify([identityJson, object.id, object.byteSize, object.sha256, 0, 10]), requestPayload);
  assert.equal(requestIdFor(identityJson, object, 0, 10), 'f50514bb8f0a0fd52bb64d1a1ac17922acb49811ea0c0a9d36a5682f239b5819');
});

test('minted grant exactly matches the Python client envelope and resolver source identity', async t => {
  const f = fixture(t), grant = await f.mint();
  assert.deepEqual(Object.keys(grant).sort(), ['protocol','reservationId','generation','expiresAt','manifestSha256','sourceVersion','jobId','environment','objectIds','nonce','token','chunkBytes','requestBudget','byteBudget','attemptBudget'].sort());
  assert.equal(grant.protocol, 'source-range-v2'); assert.equal(grant.sourceVersion, f.transferRequest.sourceVersion);
  assert.equal(grant.expiresAt, '2035-01-01T00:00:05.000Z'); assert.equal(grant.token.length, 43);
  const wrongResolver = binding => ({ ...f.resolveSource(binding), sourceVersion: 'other-version' });
  await assert.rejects(f.mint(wrongResolver), { code: 'SOURCE_BINDING_MISMATCH' });
});

test('HTTPS handler returns canonical 206 headers and exact bytes', async t => {
  const f = fixture(t), grant = await f.mint(), broker = f.broker;
  const handler = createSourceRangeV2Handler({ broker, enabled: true, isProtectedTransport: () => true });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.statusCode = 404; res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = f.headers(grant);
  const response = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}photo-1`, { headers: {
    Authorization: request.authorization, Range: request.range, 'If-Match': request.ifMatch, [REQUEST_HEADER]: request.requestId,
  } });
  assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 0-9/10');
  assert.equal(response.headers.get('content-length'), '10'); assert.equal(response.headers.get('etag'), request.ifMatch);
  assert.equal(response.headers.get(REQUEST_HEADER), request.requestId); assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
});

test('HTTP route rejects missing or malformed range identity headers and wrong methods', async t => {
  const f = fixture(t), grant = await f.mint(), handler = createSourceRangeV2Handler({ broker: f.broker, enabled: true, isProtectedTransport: () => true });
  const server = http.createServer(async (req, res) => { await handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}${PREFIX}photo-1`, h = f.headers(grant);
  const headers = { Authorization: h.authorization, Range: h.range, 'If-Match': h.ifMatch, [REQUEST_HEADER]: h.requestId };
  const request = extra => fetch(base, { headers: { ...headers, ...extra } });
  assert.equal((await fetch(base, { method: 'POST', headers: { Authorization: h.authorization } })).status, 405);
  assert.equal((await fetch(base + '?path=ignored', { headers: { Authorization: h.authorization } })).status, 400);
  const missingRequestId = { ...headers }; delete missingRequestId[REQUEST_HEADER];
  assert.equal((await fetch(base, { headers: missingRequestId })).status, 400);
  const badValidator = await request({ 'If-Match': '"wrong"' });
  assert.equal(badValidator.status, 409); assert.equal(badValidator.headers.get('etag'), null); assert.equal(badValidator.headers.get(REQUEST_HEADER), null);
  assert.equal((await request({ Range: 'bytes=0-' })).status, 416);
});

test('default-off handler stays unavailable and does not touch broker', async t => {
  let calls = 0;
  const handler = createSourceRangeV2Handler({ broker: { readAuthorizedRange: async () => { calls++; } } });
  const server = http.createServer(async (req, res) => { await handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}photo-1`);
  assert.equal(response.status, 404); assert.equal(calls, 0);
});

test('grant rejects unauthorized bearer and expired lease grant', async t => {
  const f = fixture(t), grant = await f.mint();
  await assert.rejects(f.broker.readAuthorizedRange(f.headers(grant, { authorization: 'Bearer ' + 'x'.repeat(43) })), { code: 'UNAUTHORIZED' });
  f.setNow(Date.parse(grant.expiresAt) + 1);
  await assert.rejects(f.broker.readAuthorizedRange(f.headers(grant)), { code: 'UNAUTHORIZED' });
});

test('only fixed 8 MiB aligned ranges and digest If-Match are accepted', async t => {
  const f = fixture(t), grant = await f.mint(), headers = f.headers(grant);
  await assert.rejects(f.broker.readAuthorizedRange({ ...headers, range: 'bytes=1-9' }), { code: 'INVALID_RANGE' });
  await assert.rejects(f.broker.readAuthorizedRange({ ...headers, range: 'bytes=0-8' }), { code: 'INVALID_RANGE' });
  await assert.rejects(f.broker.readAuthorizedRange({ ...headers, ifMatch: '"other"' }), { code: 'SOURCE_CHANGED' });
  await assert.rejects(f.broker.readAuthorizedRange({ ...headers, requestId: '0'.repeat(64) }), { code: 'INVALID_REQUEST_ID' });
  const badJob = { ...f.job, transferRequest: { ...f.transferRequest, chunkBytes: 1024 } };
  await assert.rejects(f.broker.mintGrant({ job: badJob, resolveSource: f.resolveSource }), { code: 'INVALID_TRANSFER_REQUEST' });
});

test('exact bearer grant survives broker restart before outbox persistence and charges attempts once', async t => {
  const f = fixture(t), first = await f.mint();
  const response1 = await f.broker.readAuthorizedRange(f.headers(first));
  response1.body.destroy(); // Lost response after the server durably recorded the attempt.
  f.broker.close();
  f.broker = new SourceRangeV2BrokerCandidate({ databasePath: f.dbPath, managedRoot: f.root, grantTokenKey: f.getGrantTokenKey(), now: f.getNow, maxGrantTtlMs: 5000 });
  const second = await f.mint();
  assert.deepEqual(second, first);
  const retry = await f.broker.readAuthorizedRange(f.headers(second));
  assert.deepEqual(await collect(retry.body), f.bytes);
  const usage = f.broker.db.prepare('SELECT requests_used,bytes_used,attempts_used FROM source_range_usage').get();
  assert.deepEqual({ ...usage }, { requests_used: 1, bytes_used: 10, attempts_used: 2 });
  const third = await f.broker.readAuthorizedRange(f.headers(second)); third.body.destroy();
  await assert.rejects(f.broker.readAuthorizedRange(f.headers(second)), { code: 'TRANSFER_LIMIT' });
  assert.deepEqual({ ...f.broker.db.prepare('SELECT requests_used,bytes_used,attempts_used FROM source_range_usage').get() }, { requests_used: 1, bytes_used: 10, attempts_used: 3 });
});

test('each range reads only its requested bytes instead of rehashing the entire source object', async t => {
  const bytes = Buffer.alloc(CHUNK_BYTES * 2 + 37, 0x61), f = fixture(t, { bytes }), grant = await f.mint();
  const originalOpen = fsp.open;
  let bytesRead = 0;
  fsp.open = async (...args) => {
    const handle = await originalOpen(...args), read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    };
    return handle;
  };
  try {
    for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
      const response = await f.broker.readAuthorizedRange(f.headersForRange(grant, start));
      await collect(response.body);
    }
  } finally {
    fsp.open = originalOpen;
  }
  assert.equal(bytesRead, bytes.length);
});

test('grant mint rejects same-size source corruption before issuing the manifest digest ETag', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, Buffer.from('abcdefghij'));
  await assert.rejects(f.mint(), { code: 'SOURCE_CHANGED' });
  assert.equal(f.broker.db.prepare('SELECT COUNT(*) AS n FROM source_range_grants').get().n, 0);
  assert.equal(f.broker.db.prepare('SELECT COUNT(*) AS n FROM source_range_objects').get().n, 0);
});

test('a verified object is not rehashed for a repeated grant with the same pinned file identity', async t => {
  const f = fixture(t), originalOpen = fsp.open;
  let bytesRead = 0;
  fsp.open = async (...args) => {
    const handle = await originalOpen(...args), read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await read(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    };
    return handle;
  };
  try {
    const first = await f.mint(), firstRead = bytesRead;
    assert.equal(firstRead, f.bytes.length);
    const second = await f.mint();
    assert.deepEqual(second, first);
    assert.equal(bytesRead, firstRead);
  } finally {
    fsp.open = originalOpen;
  }
});

test('expired grant rotates to a unique unrecoverable bearer without reviving the old token', async t => {
  const f = fixture(t), first = await f.mint();
  f.setNow(Date.parse(first.expiresAt) + 1);
  const second = await f.mint();
  assert.notEqual(second.token, first.token);
  await assert.rejects(f.broker.readAuthorizedRange(f.headers(first)), { code: 'UNAUTHORIZED' });
  const response = await f.broker.readAuthorizedRange(f.headers(second));
  assert.deepEqual(await collect(response.body), f.bytes);
});

test('grant key rotation is refused until the active broker grant expires', async t => {
  const f = fixture(t), first = await f.mint();
  f.broker.close();
  const rotatedKey = crypto.randomBytes(32);
  assert.throws(() => new SourceRangeV2BrokerCandidate({ databasePath: f.dbPath, managedRoot: f.root,
    grantTokenKey: rotatedKey, now: f.getNow, maxGrantTtlMs: 5000 }), { code: 'GRANT_TOKEN_KEY_ROTATION_BLOCKED' });
  f.setNow(Date.parse(first.expiresAt) + 1);
  f.broker = new SourceRangeV2BrokerCandidate({ databasePath: f.dbPath, managedRoot: f.root,
    grantTokenKey: rotatedKey, now: f.getNow, maxGrantTtlMs: 5000 });
  rotatedKey.fill(0);
  const second = await f.mint();
  assert.notEqual(second.token, first.token);
  await assert.rejects(f.broker.readAuthorizedRange(f.headers(first)), { code: 'UNAUTHORIZED' });
  const response = await f.broker.readAuthorizedRange(f.headers(second));
  assert.deepEqual(await collect(response.body), f.bytes);
});

test('unique request budget below manifest minimum is rejected before grant creation', async t => {
  const f = fixture(t), underBudget = { ...f.job, transferRequest: { ...f.transferRequest, requestBudget: 0 } };
  await assert.rejects(f.broker.mintGrant({ job: underBudget, resolveSource: f.resolveSource }), { code: 'INVALID_TRANSFER_REQUEST' });
});

test('changed source bytes fail closed before a range response', async t => {
  const f = fixture(t), grant = await f.mint();
  fs.writeFileSync(f.file, 'abcdefghij');
  await assert.rejects(f.broker.readAuthorizedRange(f.headers(grant)), { code: 'SOURCE_CHANGED' });
  assert.equal(f.broker.db.prepare('SELECT attempts_used FROM source_range_usage').get().attempts_used, 1);
});

test('source object paths must be supplied by resolver and remain beneath managed root', async t => {
  const f = fixture(t), outside = path.join(os.tmpdir(), 'outside-source-range-v2'); fs.writeFileSync(outside, '0123456789');
  t.after(() => fs.rmSync(outside, { force: true }));
  const resolver = binding => ({ ...f.resolveSource(binding), objects: [{ id: 'photo-1', path: outside, byteSize: 10, sha256: f.manifest.objects[0].sha256 }] });
  await assert.rejects(f.mint(resolver), { code: 'UNSAFE_SOURCE' });
});

test('protected transport is required and request ID is echoed only on successful reads', async t => {
  const f = fixture(t), grant = await f.mint(), handler = createSourceRangeV2Handler({ broker: f.broker, enabled: true, isProtectedTransport: () => false });
  const server = http.createServer(async (req, res) => { await handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const headers = f.headers(grant), response = await fetch(`http://127.0.0.1:${server.address().port}${PREFIX}photo-1`, { headers: {
    Authorization: headers.authorization, Range: headers.range, 'If-Match': headers.ifMatch, [REQUEST_HEADER]: headers.requestId,
  } });
  assert.equal(response.status, 503); assert.equal(response.headers.get(REQUEST_HEADER), null);
});

test('changing the reservation identity cannot reuse old cumulative budgets', async t => {
  const f = fixture(t), grant = await f.mint();
  const changed = { ...f.job, transferRequest: { ...f.transferRequest, nonce: 'nonce-2' } };
  await assert.rejects(f.broker.mintGrant({ job: changed, resolveSource: f.resolveSource }), { code: 'TRANSFER_BINDING_CONFLICT' });
  assert.equal(f.broker.db.prepare('SELECT COUNT(*) AS n FROM source_range_grants').get().n, 1);
  assert.equal(grant.protocol, 'source-range-v2');
});

test('restart rejects inconsistent durable counters instead of resetting them', async t => {
  const f = fixture(t);
  await f.mint();
  f.broker.db.prepare('UPDATE source_range_usage SET requests_used=1 WHERE identity_key=?').run(f.broker.db.prepare('SELECT identity_key FROM source_range_usage').get().identity_key);
  f.broker.close();
  assert.throws(() => new SourceRangeV2BrokerCandidate({ databasePath: f.dbPath, managedRoot: f.root, now: f.getNow }), { code: 'TRANSFER_ACCOUNTING_UNAVAILABLE' });
});
