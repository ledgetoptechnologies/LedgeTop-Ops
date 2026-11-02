'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const fixture = require('./fixtures/reference-v1.contract.json');
const { ReferenceAcceptanceLedger } = require('../server/referenceAcceptance');
const { createReferenceAcceptanceApi, PATH, referenceAcceptanceJsonBodyType } = require('../server/referenceAcceptanceApi');
const { signServiceRequest } = require('../server/serviceAuth');
let express = null;
try { express = require('express'); } catch {}

const enabledTest = process.platform === 'linux' ? test : test.skip;
const httpIntegrationTest = express && process.platform === 'linux' ? test : test.skip;
const secret = 'synthetic-processing-service-secret-not-a-credential-0001';
const keyId = 'synthetic-processing-v1';
const otherKeyId = 'synthetic-ops-service-v1';
const otherSecret = 'synthetic-ops-service-secret-not-a-credential-0001';
const keys = { [keyId]: secret, [otherKeyId]: otherSecret };

function expectedFromFixture() {
  const resultManifest = fixture.resultManifest;
  return {
    jobId: resultManifest.jobId,
    generation: resultManifest.generation,
    environment: resultManifest.environment,
    inputManifestSha256: fixture.manifestSha256,
    pipelineDigest: resultManifest.pipelineDigest,
    resultManifestSha256: fixture.resultManifestSha256,
    objectIds: resultManifest.objects.map(object => object.id),
  };
}

function reservationBody(receiptId = fixture.acceptance.receiptId) {
  const body = structuredClone({
    inputManifest: fixture.submission.manifest,
    expected: expectedFromFixture(),
    resultManifest: fixture.resultManifest,
    acceptance: fixture.acceptance,
  });
  body.acceptance.receiptId = receiptId;
  return body;
}

function repository() {
  const seen = new Set();
  return {
    consumeServiceNonce(id, nonce) {
      const key = `${id}\n${nonce}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    pruneAuthState() {},
  };
}

function startRouteHarness({ ledger, repo = repository() }) {
  const routes = [];
  const middlewares = [];
  const router = {
    use(handler) { middlewares.push(handler); },
    put(route, handler) { routes.push({ method: 'PUT', route, handler }); },
    post(route, handler) { routes.push({ method: 'POST', route, handler }); },
    get(route, handler) { routes.push({ method: 'GET', route, handler }); },
  };
  createReferenceAcceptanceApi({
    repository: repo, ledger, serviceKeyId: keyId, serviceAuthKeys: keys,
    environment: 'staging', chunkBytes: 1024, routerFactory: () => router,
  });

  function routeFor(method, opts) {
    return routes.find(({ method: verb, route }) => {
      if (verb !== method) return false;
      if (opts.objectId) return route.endsWith('/:objectId');
      if (method === 'POST') return route.endsWith('/:receiptId/commit');
      return route.endsWith('/:receiptId');
    });
  }

  return {
    async request(method, receiptId, body, { objectId, offset = 0, signingKeyId = keyId, badSignature = false, rawBodyOverride } = {}) {
      const pathname = objectId
        ? `${PATH}/${encodeURIComponent(receiptId)}/objects/${encodeURIComponent(objectId)}?offset=${offset}`
        : method === 'POST' ? `${PATH}/${encodeURIComponent(receiptId)}/commit` : `${PATH}/${encodeURIComponent(receiptId)}`;
      const isBinary = Boolean(objectId);
      const rawBody = rawBodyOverride !== undefined
        ? rawBodyOverride
        : method === 'PUT' && !isBinary ? JSON.stringify(body)
          : isBinary ? Buffer.from(body || Buffer.alloc(0)) : '';
      const signingSecret = keys[signingKeyId];
      const signedHeaders = signServiceRequest({ secret: signingSecret, keyId: signingKeyId, method, path: pathname, body: rawBody });
      const headers = Object.fromEntries(Object.entries(signedHeaders).map(([name, value]) => [name.toLowerCase(), value]));
      if (badSignature) headers['x-ltds-signature'] = 'invalid-signature';
      if (isBinary) {
        headers['content-length'] = String(rawBody.length);
        headers['content-type'] = 'application/octet-stream';
      }
      const req = {
        method, originalUrl: pathname, headers, rawBody: isBinary ? undefined : Buffer.from(rawBody),
        params: { receiptId, ...(objectId ? { objectId } : {}) },
        query: { ...(objectId ? { offset: String(offset) } : {}) },
        body: isBinary ? undefined : body,
        get(name) { return headers[name.toLowerCase()]; },
        ...(isBinary ? { async *[Symbol.asyncIterator]() { if (rawBody.length) yield rawBody; } } : {}),
      };
      const selected = routeFor(method, { objectId });
      assert.ok(selected, `missing ${method} route for ${pathname}`);
      return new Promise(resolve => {
        const res = {
          statusCode: 200, headers: {},
          setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
          status(code) { this.statusCode = code; return this; },
          json(value) { resolve({ status: this.statusCode, body: value, headers: this.headers }); return this; },
        };
        const runHandler = () => selected.handler(req, res);
        const runMiddleware = index => index >= middlewares.length
          ? runHandler()
          : middlewares[index](req, res, () => runMiddleware(index + 1));
        if (isBinary) {
          // The streaming endpoint authenticates against the signed body digest
          // itself before it consumes the request stream.
          middlewares[0](req, res, runHandler);
        } else runMiddleware(0);
      });
    },
  };
}

function signHeaders(method, requestPath, body, contentType) {
  const signed = signServiceRequest({ secret, keyId, method, path: requestPath, body });
  return {
    ...signed,
    'Content-Type': contentType,
    'Content-Length': String(body.length),
  };
}

function tempStorage(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-reference-acceptance-'));
  const root = path.join(parent, 'accepted');
  fs.mkdirSync(root);
  const databasePath = path.join(parent, 'acceptance.sqlite');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root, managedRoot: root, databasePath };
}

httpIntegrationTest('real Express middleware preserves binary streams and the signed digest gates file writes', async t => {
  const storage = tempStorage(t);
  const ledger = new ReferenceAcceptanceLedger(storage);
  const repo = repository();
  const app = express();
  app.use(express.json({
    type: referenceAcceptanceJsonBodyType,
    verify(req, _res, bytes) { req.rawBody = Buffer.from(bytes); },
  }));
  app.use(createReferenceAcceptanceApi({ repository: repo, ledger, serviceKeyId: keyId, serviceAuthKeys: keys, environment: 'staging', chunkBytes: 1024 }));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); ledger.close(); });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const reservationPath = `${PATH}/${fixture.acceptance.receiptId}`;
  const reservation = Buffer.from(JSON.stringify(reservationBody()));
  const reserved = await fetch(base + reservationPath, { method: 'PUT', headers: signHeaders('PUT', reservationPath, reservation, 'application/json'), body: reservation });
  assert.equal(reserved.status, 202);

  const objectPath = `${PATH}/${fixture.acceptance.receiptId}/objects/result-1?offset=0`;
  const bytes = Buffer.from('abc');
  const invalidMediaType = await fetch(base + objectPath, { method: 'PUT', headers: signHeaders('PUT', objectPath, bytes, 'application/json'), body: bytes });
  assert.equal(invalidMediaType.status, 415);
  await invalidMediaType.json();
  for (const variantPath of [
    `${PATH.toUpperCase()}/${fixture.acceptance.receiptId}/objects/result-1`,
    `${PATH}/${fixture.acceptance.receiptId}/objects/result-1/`,
  ]) {
    const variant = await fetch(base + variantPath, {
      method: 'PUT', headers: signHeaders('PUT', variantPath, bytes, 'application/json'), body: bytes,
    });
    assert.equal(variant.status, 415);
    await variant.json();
  }

  const forgedBytes = Buffer.from('abd');
  const signedForExpected = signHeaders('PUT', objectPath, bytes, 'application/octet-stream');
  const mismatch = await fetch(base + objectPath, { method: 'PUT', headers: signedForExpected, body: forgedBytes });
  assert.equal(mismatch.status, 409);
  await mismatch.json();
  assert.equal((await apiGet()).body.objects[0].receivedBytes, 0);

  const uploaded = await fetch(base + objectPath, { method: 'PUT', headers: signHeaders('PUT', objectPath, bytes, 'application/octet-stream'), body: bytes });
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).complete, true);
  const committedPath = `${PATH}/${fixture.acceptance.receiptId}/commit`;
  const committed = await fetch(base + committedPath, { method: 'POST', headers: signHeaders('POST', committedPath, Buffer.alloc(0), 'application/json') });
  assert.equal(committed.status, 201);
  assert.equal(fs.readFileSync(path.join(storage.root, 'receipt-1', 'result-1.bin'), 'utf8'), 'abc');

  async function apiGet() {
    const headers = signServiceRequest({ secret, keyId, method: 'GET', path: reservationPath, body: Buffer.alloc(0) });
    const response = await fetch(base + reservationPath, { headers });
    return { status: response.status, body: await response.json() };
  }
});

async function reserve(api, receiptId = fixture.acceptance.receiptId) {
  return api.request('PUT', receiptId, reservationBody(receiptId));
}

async function upload(api, bytes, offset = 0) {
  return api.request('PUT', fixture.acceptance.receiptId, Buffer.from(bytes), { objectId: 'result-1', offset });
}

test('route requires a valid dedicated processing service identity', async () => {
  const api = startRouteHarness({ ledger: { reserveTransfer() {}, stageObjectChunk() {}, commitTransfer() {}, getVerified() { return null; }, getTransfer() { return null; } } });
  const invalid = await api.request('GET', fixture.acceptance.receiptId, undefined, { badSignature: true });
  assert.equal(invalid.status, 401);
  const otherTrustedService = await api.request('GET', fixture.acceptance.receiptId, undefined, { signingKeyId: otherKeyId });
  assert.equal(otherTrustedService.status, 403);
});

test('route rejects a mismatched source manifest before creating a transfer reservation', async () => {
  let calls = 0;
  const api = startRouteHarness({ ledger: { reserveTransfer() { calls++; }, stageObjectChunk() {}, commitTransfer() {}, getVerified() { return null; }, getTransfer() { return null; } } });
  const body = reservationBody();
  body.inputManifest.revision++;
  const response = await api.request('PUT', fixture.acceptance.receiptId, body);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'DIGEST_MISMATCH');
  assert.equal(calls, 0);
});

enabledTest('metadata alone cannot ACK; chunk transfer resumes and replays safely across restart', async t => {
  const storage = tempStorage(t);
  let ledger = new ReferenceAcceptanceLedger(storage);
  let api = startRouteHarness({ ledger });
  t.after(() => ledger.close());

  const reserved = await reserve(api);
  assert.equal(reserved.status, 202);
  assert.equal(reserved.body.state, 'receiving');
  assert.equal(reserved.body.objects[0].receivedBytes, 0);
  const premature = await api.request('POST', fixture.acceptance.receiptId);
  assert.equal(premature.status, 409);
  assert.equal(premature.body.code, 'TRANSFER_INCOMPLETE');
  assert.equal(ledger.get(fixture.acceptance.receiptId), null);

  const first = await upload(api, 'a', 0);
  assert.equal(first.status, 200);
  assert.equal(first.body.receivedBytes, 1);
  assert.equal(first.body.complete, false);
  ledger.close();

  ledger = new ReferenceAcceptanceLedger(storage);
  api = startRouteHarness({ ledger });
  const statusAfterRestart = await api.request('GET', fixture.acceptance.receiptId);
  assert.equal(statusAfterRestart.status, 202);
  assert.equal(statusAfterRestart.body.objects[0].receivedBytes, 1);
  const replayedChunk = await upload(api, 'a', 0);
  assert.equal(replayedChunk.status, 200);
  assert.equal(replayedChunk.body.receivedBytes, 1);
  assert.equal(replayedChunk.body.replayed, true);

  const remainder = await upload(api, 'bc', 1);
  assert.equal(remainder.status, 200);
  assert.equal(remainder.body.complete, true);
  const accepted = await api.request('POST', fixture.acceptance.receiptId);
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.state, 'accepted');
  assert.deepEqual(accepted.body.acceptedObjectIds, ['result-1']);
  assert.equal(accepted.body.fullyAccepted, false);
  const replay = await api.request('POST', fixture.acceptance.receiptId);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, accepted.body);
  const status = await api.request('GET', fixture.acceptance.receiptId);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, accepted.body);
  assert.equal(fs.readFileSync(path.join(storage.root, 'receipt-1', 'result-1.bin'), 'utf8'), 'abc');
});

enabledTest('reservation quota is atomic and prevents retaining more than the configured accepted-copy budget', async t => {
  const storage = tempStorage(t);
  const ledger = new ReferenceAcceptanceLedger({ ...storage, maxManagedBytes: 2 });
  const api = startRouteHarness({ ledger });
  t.after(() => ledger.close());
  const response = await reserve(api);
  assert.equal(response.status, 507);
  assert.equal(response.body.code, 'STORAGE_QUOTA_EXCEEDED');
  assert.equal(ledger.getTransfer(fixture.acceptance.receiptId), null);
});

enabledTest('concurrent worker threads serialize separate SQLite reservations against one durable byte budget', async t => {
  const workers = [];
  // Register worker cleanup before tempStorage's removal hook so both FIFO and
  // LIFO hook runners terminate SQLite users before deleting their files.
  t.after(async () => {
    await Promise.all(workers.map(async ({ worker }) => {
      if (worker.threadId !== -1) await worker.terminate().catch(() => {});
    }));
  });
  const storage = tempStorage(t);
  const initialized = new ReferenceAcceptanceLedger({ ...storage, maxManagedBytes: 3 });
  initialized.close();
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workerScript = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { ReferenceAcceptanceLedger } = require(workerData.modulePath);
    const ledger = new ReferenceAcceptanceLedger({
      ...workerData.storage,
      maxManagedBytes: 3,
      failpoint(name) {
        if (name !== 'beforeTransferReservationTransaction') return;
        parentPort.postMessage({ ready: true });
        const wait = Atomics.wait(new Int32Array(workerData.gate), 0, 0, 10000);
        if (wait === 'timed-out') throw new Error('concurrent_reservation_barrier_timeout');
      },
    });
    parentPort.postMessage({ connected: true });
    parentPort.once('message', () => {
      try {
        ledger.reserveTransfer(workerData.reservation);
        parentPort.postMessage({ outcome: 'reserved' });
      } catch (error) {
        parentPort.postMessage({ outcome: error.code || 'unexpected_error' });
      } finally {
        ledger.close();
      }
    });
  `;
  const startWorker = receiptId => {
    const worker = new Worker(workerScript, {
      eval: true,
      workerData: {
        modulePath: path.resolve(__dirname, '../server/referenceAcceptance.js'),
        storage,
        gate,
        reservation: reservationBody(receiptId),
      },
    });
    let connectedResolve;
    let connectedReject;
    let readyResolve;
    let readyReject;
    let outcomeResolve;
    let outcomeReject;
    let exitResolve;
    let exitReject;
    const connected = new Promise((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const outcome = new Promise((resolve, reject) => { outcomeResolve = resolve; outcomeReject = reject; });
    const exit = new Promise((resolve, reject) => { exitResolve = resolve; exitReject = reject; });
    for (const pending of [connected, ready, outcome, exit]) pending.catch(() => {});
    worker.on('message', message => {
      if (message.connected) connectedResolve();
      if (message.ready) readyResolve();
      if (message.outcome) outcomeResolve(message.outcome);
    });
    worker.on('error', error => { connectedReject(error); readyReject(error); outcomeReject(error); exitReject(error); });
    worker.on('exit', code => {
      if (code === 0) exitResolve();
      else { const error = new Error(`reservation_worker_exit_${code}`); connectedReject(error); readyReject(error); outcomeReject(error); exitReject(error); }
    });
    return { worker, connected, ready, outcome, exit };
  };
  const first = startWorker('receipt-a'); workers.push(first); await first.connected;
  const second = startWorker('receipt-b'); workers.push(second); await second.connected;
  first.worker.postMessage('reserve'); second.worker.postMessage('reserve');
  await Promise.all(workers.map(item => item.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0, 2);
  const outcomes = await Promise.all(workers.map(item => item.outcome));
  await Promise.all(workers.map(item => item.exit));
  assert.deepEqual(outcomes.sort(), ['STORAGE_QUOTA_EXCEEDED', 'reserved']);
  const ledger = new ReferenceAcceptanceLedger({ ...storage, maxManagedBytes: 3 });
  try {
    assert.equal(ledger.db.prepare('SELECT COALESCE(SUM(expected_bytes),0) AS bytes FROM transfer_objects').get().bytes, 3);
  } finally { ledger.close(); }
});

enabledTest('startup refuses bytes in the managed root that are not tracked by the acceptance ledger', async t => {
  const storage = tempStorage(t);
  const ledger = new ReferenceAcceptanceLedger(storage);
  ledger.close();
  fs.writeFileSync(path.join(storage.root, 'untracked.bin'), 'outside-ledger-bytes');
  assert.throws(() => new ReferenceAcceptanceLedger(storage), error => error.code === 'UNMANAGED_STORAGE_CONTENT');
});

enabledTest('a signed but incorrect full object is retained in quarantine and holds its receipt without ACK', async t => {
  const storage = tempStorage(t);
  const ledger = new ReferenceAcceptanceLedger(storage);
  const api = startRouteHarness({ ledger });
  t.after(() => ledger.close());
  assert.equal((await reserve(api)).status, 202);
  const response = await upload(api, 'bad', 0);
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'STORAGE_DIGEST_MISMATCH');
  assert.equal(ledger.get(fixture.acceptance.receiptId), null);
  assert.equal(fs.readFileSync(path.join(storage.root, 'receipt-1', 'result-1.partial'), 'utf8'), 'bad');
  const status = await api.request('GET', fixture.acceptance.receiptId);
  assert.equal(status.status, 202);
  assert.equal(status.body.state, 'held');
  assert.equal(status.body.objects[0].state, 'held');
  assert.equal(status.body.objects[0].receivedBytes, 0);
  assert.equal(fs.readdirSync(path.join(storage.root, 'receipt-1')).filter(name => name.includes('.rejected.')).length, 1);
  const commit = await api.request('POST', fixture.acceptance.receiptId);
  assert.equal(commit.status, 409);
  assert.equal(commit.body.code, 'TRANSFER_INCOMPLETE');
});

enabledTest('durable held state survives a crash before invalid bytes are renamed to quarantine', async t => {
  const storage = tempStorage(t);
  let failOnce = true;
  let ledger = new ReferenceAcceptanceLedger({ ...storage, failpoint(name) {
    if (name === 'beforeTransferQuarantineRename' && failOnce) { failOnce = false; throw new Error('synthetic crash boundary'); }
  } });
  let api = startRouteHarness({ ledger });
  t.after(() => ledger.close());
  assert.equal((await reserve(api)).status, 202);
  assert.equal((await upload(api, 'bad')).status, 409);
  assert.equal((await api.request('GET', fixture.acceptance.receiptId)).status, 503);
  ledger.close();

  ledger = new ReferenceAcceptanceLedger(storage);
  api = startRouteHarness({ ledger });
  const recovered = await api.request('GET', fixture.acceptance.receiptId);
  assert.equal(recovered.status, 202);
  assert.equal(recovered.body.state, 'held');
  assert.equal(recovered.body.objects[0].state, 'held');
  assert.equal(fs.readFileSync(path.join(storage.root, 'receipt-1', 'result-1.partial'), 'utf8'), 'bad');
  assert.equal((await upload(api, 'abc')).status, 409);
  assert.equal(ledger.get(fixture.acceptance.receiptId), null);
});

enabledTest('status recovers a crash after hard-link publication but before partial unlink', async t => {
  const storage = tempStorage(t);
  let failOnce = true;
  let ledger = new ReferenceAcceptanceLedger({ ...storage, failpoint(name) {
    if (name === 'afterTransferLinkBeforeUnlink' && failOnce) { failOnce = false; throw new Error('synthetic crash boundary'); }
  } });
  let api = startRouteHarness({ ledger });
  t.after(() => ledger.close());
  assert.equal((await reserve(api)).status, 202);
  const lost = await upload(api, 'abc');
  assert.equal(lost.status, 503);
  const directory = path.join(storage.root, 'receipt-1');
  assert.equal(fs.statSync(path.join(directory, 'result-1.partial')).ino, fs.statSync(path.join(directory, 'result-1.bin')).ino);
  ledger.close();

  ledger = new ReferenceAcceptanceLedger(storage);
  api = startRouteHarness({ ledger });
  const recovered = await api.request('GET', fixture.acceptance.receiptId);
  assert.equal(recovered.status, 202);
  assert.equal(recovered.body.objects[0].state, 'complete');
  assert.equal(fs.existsSync(path.join(directory, 'result-1.partial')), false);
  assert.equal(fs.readFileSync(path.join(directory, 'result-1.bin'), 'utf8'), 'abc');
  const commit = await api.request('POST', fixture.acceptance.receiptId);
  assert.equal(commit.status, 201);
});

enabledTest('lost response after receipt commit recovers by authenticated status after restart', async t => {
  const storage = tempStorage(t);
  let failOnce = true;
  let ledger = new ReferenceAcceptanceLedger({ ...storage, failpoint(name) {
    if (name === 'afterLedgerCommit' && failOnce) { failOnce = false; throw new Error('synthetic response loss'); }
  } });
  let api = startRouteHarness({ ledger });
  assert.equal((await reserve(api)).status, 202);
  assert.equal((await upload(api, 'abc')).status, 200);
  const lost = await api.request('POST', fixture.acceptance.receiptId);
  assert.equal(lost.status, 503);
  ledger.close();

  ledger = new ReferenceAcceptanceLedger(storage);
  api = startRouteHarness({ ledger });
  t.after(() => ledger.close());
  const status = await api.request('GET', fixture.acceptance.receiptId);
  assert.equal(status.status, 200);
  assert.equal(status.body.state, 'accepted');
  assert.equal(fs.readFileSync(path.join(storage.root, 'receipt-1', 'result-1.bin'), 'utf8'), 'abc');
});

enabledTest('status after restart refuses a corrupted accepted copy and does not delete it', async t => {
  const storage = tempStorage(t);
  let ledger = new ReferenceAcceptanceLedger(storage);
  let api = startRouteHarness({ ledger });
  assert.equal((await reserve(api)).status, 202);
  assert.equal((await upload(api, 'abc')).status, 200);
  assert.equal((await api.request('POST', fixture.acceptance.receiptId)).status, 201);
  ledger.close();
  const file = path.join(storage.root, 'receipt-1', 'result-1.bin');
  fs.writeFileSync(file, 'xyz');

  ledger = new ReferenceAcceptanceLedger(storage);
  api = startRouteHarness({ ledger });
  t.after(() => ledger.close());
  const status = await api.request('GET', fixture.acceptance.receiptId);
  assert.equal(status.status, 409);
  assert.equal(status.body.code, 'STORAGE_DIGEST_MISMATCH');
  assert.equal(fs.readFileSync(file, 'utf8'), 'xyz');
});
