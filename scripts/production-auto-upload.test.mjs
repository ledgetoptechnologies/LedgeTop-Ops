import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { uploadAssetManifest } from './production-auto-upload.mjs';

const ACCOUNT = 'a'.repeat(32), A = '1'.repeat(32), B = '2'.repeat(32);
const API_TOKEN = 'private-account-token', SESSION = 'aGVhZGVy.c2Vzc2lvbg.c2lnbmF0dXJl';
const COMPLETE = 'aGVhZGVy.Y29tcGxldGU.c2lnbmF0dXJl';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const response = (result, status = 200) => Response.json({ success: true, errors: [], result }, { status });
function fixture({ buckets = [[A], [B]], override, payload } = {}) {
  const bytes = new Map([[A, Buffer.from('old')], [B, Buffer.from('newer')]]), calls = [], intents = [], resolved = [];
  const options = { accountId: ACCOUNT, workerName: 'ledgetop-ops', token: API_TOKEN,
    manifest: { '/old.js': { hash: A, size: 3 }, '/new.js': { hash: B, size: 5 } },
    resolvePayload: async hash => {
      resolved.push(hash);
      if (payload) return payload(hash, bytes.get(hash));
      return { bytes: bytes.get(hash), sha256: digest(bytes.get(hash)), mime: 'text/javascript' };
    },
    recordIntent: async entry => { intents.push(entry); },
    fetchImpl: async (url, init) => {
      const index = calls.length; calls.push({ url, init });
      if (override) return override(index, url, init);
      if (index === 0) return response({ jwt: SESSION, buckets });
      return response({ jwt: index === buckets.length ? COMPLETE : null }, index === buckets.length ? 201 : 200);
    } };
  return { options, calls, intents, resolved, bytes };
}

test('only official bounded POSTs; account credential only registers, session JWT uploads exact base64 bytes', async () => {
  const f = fixture(), value = await uploadAssetManifest(f.options);
  assert.deepEqual(value, { completionToken: COMPLETE, includedHashes: [A, B], uploadedHashes: [A, B] });
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/ledgetop-ops/assets-upload-session`);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${API_TOKEN}`);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { manifest: f.options.manifest });
  for (const [index, hash] of [A, B].entries()) {
    const { url, init } = f.calls[index + 1];
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/assets/upload?base64=true`);
    assert.equal(init.headers.Authorization, `Bearer ${SESSION}`);
    assert.equal(Object.hasOwn(init.headers, 'Content-Type'), false);
    const entries = [...init.body.entries()]; assert.equal(entries.length, 1);
    assert.equal(entries[0][0], hash); assert.equal(entries[0][1].name, hash);
    assert.equal(entries[0][1].type, 'text/javascript');
    assert.equal(await entries[0][1].text(), f.bytes.get(hash).toString('base64'));
  }
  for (const call of f.calls) { assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error'); assert.ok(call.init.signal instanceof AbortSignal); }
  assert.deepEqual(f.intents.map(i => i.phase), ['asset-session', 'asset-bucket', 'asset-bucket']);
  assert.ok(!JSON.stringify(f.intents).includes(API_TOKEN) && !JSON.stringify(f.intents).includes(SESSION));
});

test('empty provider buckets return the exact completion token without payload reads or file upload', async () => {
  const f = fixture({ buckets: [], override: () => response({ jwt: COMPLETE, buckets: [] }) });
  assert.deepEqual(await uploadAssetManifest(f.options), { completionToken: COMPLETE, includedHashes: [A, B], uploadedHashes: [] });
  assert.equal(f.calls.length, 1); assert.equal(f.resolved.length, 0);
});

test('already present hashes are included but never resolved or retransmitted', async () => {
  const f = fixture({ buckets: [[B]] });
  assert.deepEqual((await uploadAssetManifest(f.options)).uploadedHashes, [B]);
  assert.deepEqual(f.resolved, [B]);
});

test('duplicate manifest aliases may reuse one hash, but differing sizes are refused before IO', async () => {
  const f = fixture({ buckets: [] });
  f.options.manifest['/alias.js'] = { hash: A, size: 3 };
  assert.deepEqual((await uploadAssetManifest(f.options)).includedHashes, [A, B]);
  f.options.manifest['/alias.js'].size = 9;
  const calls = f.calls.length;
  await assert.rejects(uploadAssetManifest(f.options), /inconsistent sizes/); assert.equal(f.calls.length, calls);
});

for (const buckets of [[[A, A]], [[A], [A]], [['f'.repeat(32)]], [[]], 'not-an-array']) {
  test(`invalid provider buckets refuse all file transmission: ${JSON.stringify(buckets)}`, async () => {
    const f = fixture({ buckets }); await assert.rejects(uploadAssetManifest(f.options), /bucket|session/);
    assert.equal(f.calls.length, 1); assert.equal(f.resolved.length, 0);
  });
}

for (const kind of ['missing-old', 'wrong-size', 'wrong-sha', 'invalid-mime']) {
  test(`all requested bytes verified before any file transmission: ${kind}`, async () => {
    const f = fixture({ payload: (hash, bytes) => {
      if (hash === A) return { bytes, sha256: digest(bytes), mime: 'text/javascript' };
      if (kind === 'missing-old') throw new Error(`${API_TOKEN} ${SESSION} private-path`);
      return { bytes: kind === 'wrong-size' ? Buffer.from('x') : bytes,
        sha256: kind === 'wrong-sha' ? '0'.repeat(64) : digest(bytes),
        mime: kind === 'invalid-mime' ? 'text/javascript\r\nBad: secret' : 'text/javascript' };
    } });
    await assert.rejects(uploadAssetManifest(f.options), error => {
      assert.ok(!String(error).includes(API_TOKEN) && !String(error).includes(SESSION) && !String(error).includes('private-path')); return true;
    });
    assert.equal(f.calls.length, 1); assert.deepEqual(f.resolved, [A, B]);
  });
}

test('resolver buffers are copied before later resolver calls can mutate them', async () => {
  const f = fixture(), original = f.options.resolvePayload;
  f.options.resolvePayload = async hash => { if (hash === B) f.bytes.get(A).fill(0); return original(hash); };
  await uploadAssetManifest(f.options);
  assert.equal(await f.calls[1].init.body.get(A).text(), Buffer.from('old').toString('base64'));
});

test('intent rejection, including replay, prevents its mutation and does not leak callback errors', async () => {
  const f = fixture();
  f.options.recordIntent = async () => { throw new Error(`${API_TOKEN} replay`); };
  await assert.rejects(uploadAssetManifest(f.options), error => !String(error).includes(API_TOKEN));
  assert.equal(f.calls.length, 0);
  const seen = new Set();
  f.options.recordIntent = async entry => { const key = JSON.stringify(entry); if (seen.has(key)) throw new Error('replay'); seen.add(key); };
  await uploadAssetManifest(f.options); const count = f.calls.length;
  await assert.rejects(uploadAssetManifest(f.options), /intent/); assert.equal(f.calls.length, count);
});

test('a bucket intent failure cannot send that bucket', async () => {
  const f = fixture(); f.options.recordIntent = async entry => { if (entry.phase === 'asset-bucket') throw new Error('held'); };
  await assert.rejects(uploadAssetManifest(f.options), /intent/); assert.equal(f.calls.length, 1);
});

for (const kind of ['transport', 'http', 'redirect', 'api-error']) {
  test(`uncertain/rejected ${kind} request is never retried and raw errors never surface`, async () => {
    const f = fixture({ override: () => {
      if (kind === 'transport') throw new Error(`${API_TOKEN} ${SESSION}`);
      if (kind === 'redirect') return new Response(API_TOKEN, { status: 302, headers: { Location: 'https://untrusted.invalid' } });
      if (kind === 'http') return new Response(API_TOKEN, { status: 500 });
      return Response.json({ success: false, errors: [{ message: API_TOKEN }], result: {} });
    } });
    await assert.rejects(uploadAssetManifest(f.options), error => !String(error).includes(API_TOKEN) && !String(error).includes(SESSION));
    assert.equal(f.calls.length, 1);
  });
}

test('body response byte limit and stalled read deadline cancel without retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const f = fixture({ override: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  const pending = assert.rejects(uploadAssetManifest(f.options), /uncertain/);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(30_000);
  await pending; assert.equal(f.calls.length, 1); assert.equal(cancelled, true);
  const large = fixture({ override: () => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } }) });
  await assert.rejects(uploadAssetManifest(large.options), /uncertain/); assert.equal(large.calls.length, 1);
});

test('a header deadline does not retry and discards a response arriving after expiry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish, cancelled = false;
  const f = fixture({ override: () => new Promise(resolve => { finish = resolve; }) });
  const pending = assert.rejects(uploadAssetManifest(f.options), /uncertain/);
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(30_000);
  await pending; assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.signal.aborted, true);
  finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});

test('streamed oversized response cancels even without a content-length header', async () => {
  let cancelled = false;
  const f = fixture({ override: () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  })) });
  await assert.rejects(uploadAssetManifest(f.options), /uncertain/);
  assert.equal(f.calls.length, 1); assert.equal(cancelled, true);
});

for (const result of [response({ jwt: null }, 201), response({ jwt: COMPLETE }, 200), response({ jwt: COMPLETE }, 201)]) {
  test(`completion acknowledgement enforces all buckets and final201: ${result.status}/${result.headers.get('content-type')}`, async () => {
    const f = fixture({ override: index => index === 0 ? response({ jwt: SESSION, buckets: [[A], [B]] }) : result.clone() });
    await assert.rejects(uploadAssetManifest(f.options), /completion|completed/);
    assert.ok(f.calls.length <= 3);
  });
}

test('malformed JWT and target/path injection are refused without leaking secrets', async () => {
  const f = fixture({ override: () => response({ jwt: 'unsigned-stub', buckets: [] }) });
  await assert.rejects(uploadAssetManifest(f.options), /session/); assert.equal(f.calls.length, 1);
  for (const change of [{ accountId: `${ACCOUNT}/evil` }, { workerName: 'unreviewed' }, { token: 'secret\r\nBad: x' },
    { manifest: { '/../secret': { hash: A, size: 3 } } }, { manifest: { '/A.js': { hash: A, size: 3 }, '/a.js': { hash: A, size: 3 } } }]) {
    const g = fixture(); Object.assign(g.options, change);
    await assert.rejects(uploadAssetManifest(g.options)); assert.equal(g.calls.length, 0);
  }
});
