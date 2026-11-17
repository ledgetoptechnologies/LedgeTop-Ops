// The temporary raw export: exactly one method, path shape, host and Access identity; everything else 404 before the
// bucket; stored gzip bytes returned unchanged with no Content-Encoding. Synthetic keys, fake bucket, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createExportWorker } from '../src/index.mjs';

const ISSUER = 'https://ledgetoptechnologies.cloudflareaccess.com';
const AUD = 'b'.repeat(64);
const CLIENT = 'logs-export-temp.access';
const HOST = 'logs-export-staging.example.test';
const UUID = '0b6f1c1e-1a2b-4c3d-8e9f-0123456789ab';
const KEY = `telemetry/v1/${UUID}.json.gz`;
const GZ = gzipSync(Buffer.from(JSON.stringify({ points: Array.from({ length: 50 }, (_, i) => [i, i * 2, i * 3]) })));
const md5 = data => createHash('md5').update(data).digest('hex');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] };
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
function jwt({ clientId = CLIENT, aud = AUD, iss = ISSUER, exp = Math.floor(Date.now() / 1000) + 300 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'k1' }), body = b64({ type: 'app', sub: '', common_name: clientId, iss, aud: [aud], iat: now - 5, exp });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}

function setup(overrides = {}) {
  const gets = [];
  const bucket = { async get(key) {
    gets.push(key);
    if (key !== KEY) return null;
    // R2 returns the stored bytes; this object was stored with contentEncoding gzip metadata.
    return { size: GZ.length, etag: md5(GZ), httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
      body: new ReadableStream({ start(c) { c.enqueue(GZ.subarray(0, 10)); c.enqueue(GZ.subarray(10)); c.close(); } }) };
  } };
  const keyFetches = [];
  const worker = createExportWorker({ fetch: async url => { keyFetches.push(String(url)); return Response.json(jwks); } });
  const env = { EXPORT_HOST: HOST, ACCESS_ISSUER: ISSUER, ACCESS_AUDIENCE: AUD, EXPORT_CLIENT_ID: CLIENT, EXPORT_BUCKET: bucket, ...overrides };
  const call = (path = `/${KEY}`, { method = 'GET', host = HOST, assertion = jwt(), body } = {}) =>
    worker.fetch(new Request(`https://${host}${path}`, { method, body, headers: assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {} }), env);
  return { call, gets, keyFetches };
}

test('the stored gzip bytes come back byte-exact, as octet-stream with no Content-Encoding, with source size and ETag', async () => {
  const { call, gets } = setup();
  const response = await call();
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.equals(GZ), 'byte-exact');
  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], 'still gzip');
  assert.equal(response.headers.get('content-encoding'), null, 'never Content-Encoding, even for gzip-stored objects');
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  assert.equal(response.headers.get('content-length'), String(GZ.length));
  assert.equal(response.headers.get('x-source-size'), String(GZ.length));
  assert.equal(response.headers.get('x-source-etag'), md5(GZ));
  assert.equal(md5(bytes), response.headers.get('x-source-etag'), 'the receiver can prove the bytes against the ETag');
  assert.equal(response.headers.get('x-source-content-encoding'), 'gzip');
  assert.deepEqual(gets, [KEY]);
});

test('other methods, paths, query strings and hosts are 404 before any key fetch or bucket read', async () => {
  const { call, gets, keyFetches } = setup();
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])
    assert.equal((await call(`/${KEY}`, { method, body: ['POST', 'PUT', 'PATCH'].includes(method) ? 'x' : undefined })).status, 404, method);
  for (const path of ['/', '/telemetry/v1/', `/telemetry/v1/${UUID}.json`, `/telemetry/v1/${UUID.toUpperCase()}.json.gz`, `/telemetry/v2/${UUID}.json.gz`,
    `/raw/${'a'.repeat(64)}.txt`, `/telemetry/v1/${UUID}.json.gz/x`, `/telemetry/v1/raw-${'a'.repeat(64)}/x.json.gz`, `/telemetry/v1/..%2F${UUID}.json.gz`,
    `/telemetry/v1/${UUID}.json.gz?list=1`, `//telemetry/v1/${UUID}.json.gz`, '/health'])
    assert.equal((await call(path)).status, 404, path);
  assert.equal((await call(`/${KEY}`, { host: 'other.example.test' })).status, 404);
  assert.deepEqual([gets.length, keyFetches.length], [0, 0]);
});

test('identity: missing, wrong audience, wrong issuer, expired or a different service token are all 404, bucket untouched', async () => {
  const { call, gets } = setup();
  for (const assertion of [null, 'not.a.jwt', jwt({ aud: 'c'.repeat(64) }), jwt({ iss: 'https://other.cloudflareaccess.com' }),
    jwt({ exp: Math.floor(Date.now() / 1000) - 1 }), jwt({ clientId: 'staff-proxy.access' })])
    assert.equal((await call(`/${KEY}`, { assertion })).status, 404, String(assertion).slice(0, 20));
  assert.equal(gets.length, 0);
});

test('incomplete configuration is 503 and reads nothing; an unknown object is 404', async () => {
  for (const broken of [{ EXPORT_HOST: undefined }, { ACCESS_ISSUER: undefined }, { ACCESS_ISSUER: 'https://evil.example.test' }, { ACCESS_AUDIENCE: '' }, { EXPORT_CLIENT_ID: 'x' }, { EXPORT_BUCKET: undefined }]) {
    const { call, gets } = setup(broken);
    assert.equal((await call()).status, 503, JSON.stringify(Object.keys(broken)));
    assert.equal(gets.length, 0);
  }
  const { call } = setup();
  assert.equal((await call(`/telemetry/v1/${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}.json.gz`)).status, 404);
});
