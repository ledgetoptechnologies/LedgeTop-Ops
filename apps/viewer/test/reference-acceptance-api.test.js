'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const fixture = require('./fixtures/reference-v1.contract.json');
const crossLanguageReceipt = require('./fixtures/viewer-accepted-copy-receipt-v1.json');
const protocol = require('../server/referenceProtocol');
const { ReferenceAcceptanceLedger } = require('../server/referenceAcceptance');
const { createReferenceAcceptanceApi, PATH, TREEDAR_PATH, referenceAcceptanceJsonBodyType } = require('../server/referenceAcceptanceApi');
const { createViewerReceiptSigner, verifyViewerReceipt } = require('../server/referenceReceipt');
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
const receiptKeyPair = crypto.generateKeyPairSync('ed25519');
const receiptSigner = createViewerReceiptSigner({
  issuerId: 'viewer-acceptance', keyId: 'viewer-test-2026',
  privateKeyPem: receiptKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
const trustedReceiptKeys = { 'viewer-test-2026': receiptKeyPair.publicKey.export({ type: 'spki', format: 'pem' }) };

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

function treeDarReservation(receiptId = 'treedar-receipt', { combined = false } = {}) {
  const roles = [
    'ground_model', 'canopy_height', 'canopy_height_unfiltered', 'crown_labels',
    'crowns', 'tree_table', 'tree_features', 'run_summary', 'report', 'preview',
    'area_map_preview', 'engine_manifest', 'area_labels', 'tree_areas',
  ];
  if (combined) roles.push('odm_archive', 'report');
  const objects = roles.map((role, index) => {
    const id = `${combined && role === 'report' && index === roles.length - 1 ? 'odm' : 'td'}-${role}-${index}`;
    const bytes = Buffer.from(`synthetic:${id}`);
    return { id, role, byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes };
  });
  const resultManifest = {
    protocol: protocol.TREEDAR_RESULT_PROTOCOL,
    schemaVersion: 2,
    jobId: fixture.resultManifest.jobId,
    generation: fixture.resultManifest.generation,
    environment: fixture.resultManifest.environment,
    pipelineDigest: fixture.resultManifest.pipelineDigest,
    engineVersions: combined ? { odm: 'odm-synthetic-1', treedar: 'treedar-synthetic-1' } : { treedar: 'treedar-synthetic-1' },
    objects: objects.map(({ id, role, byteSize, sha256 }) => ({ id, role, byteSize, sha256 })),
    resultManifestSha256: '0'.repeat(64),
  };
  resultManifest.resultManifestSha256 = protocol.resultManifestSha256(resultManifest);
  const expected = {
    ...expectedFromFixture(),
    resultManifestSha256: resultManifest.resultManifestSha256,
    objectIds: resultManifest.objects.map(object => object.id),
  };
  const acceptance = structuredClone(fixture.acceptance);
  acceptance.receiptId = receiptId;
  acceptance.storageReceiptId = `storage-${receiptId}`;
  acceptance.resultManifestSha256 = resultManifest.resultManifestSha256;
  acceptance.acceptedObjectIds = [...expected.objectIds];
  return {
    body: { inputManifest: fixture.submission.manifest, expected, resultManifest, acceptance },
    objects,
  };
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
    receiptSigner, environment: 'staging', chunkBytes: 1024, routerFactory: () => router,
  });

  function routeFor(method, opts, pathPrefix) {
    return routes.find(({ method: verb, route }) => {
      if (verb !== method || !route.startsWith(`${pathPrefix}/`)) return false;
      if (opts.objectId) return route.endsWith('/:objectId');
      if (method === 'POST') return route.endsWith('/:receiptId/commit');
      return route.endsWith('/:receiptId');
    });
  }

  return {
    async request(method, receiptId, body, { objectId, offset = 0, pathPrefix = PATH, signingKeyId = keyId, badSignature = false, rawBodyOverride } = {}) {
      const pathname = objectId
        ? `${pathPrefix}/${encodeURIComponent(receiptId)}/objects/${encodeURIComponent(objectId)}?offset=${offset}`
        : method === 'POST' ? `${pathPrefix}/${encodeURIComponent(receiptId)}/commit` : `${pathPrefix}/${encodeURIComponent(receiptId)}`;
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
      const selected = routeFor(method, { objectId }, pathPrefix);
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
  app.use(createReferenceAcceptanceApi({ repository: repo, ledger, serviceKeyId: keyId, serviceAuthKeys: keys, receiptSigner, environment: 'staging', chunkBytes: 1024 }));
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
  const committedBody = await committed.json();
  assert.equal(verifyViewerReceipt(committedBody.viewerReceipt, trustedReceiptKeys), true);
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

test('TreeDar v2 accepts only the private combined/TreeDar result schema and full closure', async () => {
  assert.deepEqual(protocol.TREEDAR_PRODUCER_ROLES, [
    'ground_model', 'canopy_height', 'canopy_height_unfiltered', 'crown_labels', 'area_labels',
    'orthophoto_point_colour', 'crowns', 'tree_table', 'tree_features', 'tree_areas',
    'lasting_tree_ids', 'area_types_template', 'labels', 'quality_report', 'run_summary',
    'preview', 'area_map_preview', 'tree_type_predictions', 'classifier_report',
    'final_test_predictions', 'report',
  ]);
  const reservations = [];
  const ledger = {
    reserveTransfer(payload) {
      reservations.push(payload);
      return { receiptId: payload.acceptance.receiptId, state: 'receiving', expected: payload.expected,
        acceptance: payload.acceptance, objects: payload.expected.objectIds.map(objectId => ({
          objectId, expectedBytes: payload.resultManifest.objects.find(object => object.id === objectId).byteSize,
          expectedSha256: payload.resultManifest.objects.find(object => object.id === objectId).sha256,
          receivedBytes: 0, state: 'pending',
        })) };
    },
    stageObjectChunk() {}, commitTransfer() {}, getVerified() { return null; }, getTransfer() { return null; },
  };
  const api = startRouteHarness({ ledger });
  const combined = treeDarReservation('treedar-combined', { combined: true });
  const accepted = await api.request('PUT', 'treedar-combined', combined.body, { pathPrefix: TREEDAR_PATH });
  assert.equal(accepted.status, 202);
  assert.equal(reservations.length, 1);
  assert.deepEqual(reservations[0].resultManifest.engineVersions, { odm: 'odm-synthetic-1', treedar: 'treedar-synthetic-1' });
  assert.equal(reservations[0].resultManifest.objects.filter(object => object.role === 'report').length, 2);
  assert.deepEqual(accepted.body.acceptedObjectIds, combined.body.expected.objectIds);

  const partial = treeDarReservation('treedar-partial');
  partial.body.acceptance.acceptedObjectIds.pop();
  const rejectedPartial = await api.request('PUT', 'treedar-partial', partial.body, { pathPrefix: TREEDAR_PATH });
  assert.equal(rejectedPartial.status, 409);
  assert.equal(rejectedPartial.body.code, 'INVALID_ACCEPTED_CLOSURE');

  const unknownRole = treeDarReservation('treedar-unknown-role');
  unknownRole.body.resultManifest.objects[12].role = 'arbitrary_file';
  unknownRole.body.resultManifest.resultManifestSha256 = protocol.resultManifestSha256(unknownRole.body.resultManifest);
  unknownRole.body.expected.resultManifestSha256 = unknownRole.body.resultManifest.resultManifestSha256;
  unknownRole.body.acceptance.resultManifestSha256 = unknownRole.body.resultManifest.resultManifestSha256;
  const rejectedRole = await api.request('PUT', 'treedar-unknown-role', unknownRole.body, { pathPrefix: TREEDAR_PATH });
  assert.equal(rejectedRole.status, 400);
  assert.equal(rejectedRole.body.code, 'INVALID_PROTOCOL');
  assert.equal(reservations.length, 1);

  const wrongPath = await api.request('PUT', 'treedar-path-isolated', treeDarReservation('treedar-path-isolated').body);
  assert.equal(wrongPath.status, 400);
  assert.equal(wrongPath.body.code, 'INVALID_PROTOCOL');
  assert.equal(reservations.length, 1);
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
  assert.equal(verifyViewerReceipt(accepted.body.viewerReceipt, trustedReceiptKeys), true);
  assert.notEqual(accepted.body.viewerReceipt.receiptId, fixture.acceptance.receiptId);
  assert.notEqual(accepted.body.viewerReceipt.storageReceiptId, fixture.acceptance.storageReceiptId);
  assert.equal(accepted.body.viewerReceipt.issuerId, 'viewer-acceptance');
  assert.deepEqual(accepted.body.viewerReceipt.objects, [{ id: 'result-1', byteSize: 3, sha256: crypto.createHash('sha256').update('abc').digest('hex') }]);
  const replay = await api.request('POST', fixture.acceptance.receiptId);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, accepted.body);
  const status = await api.request('GET', fixture.acceptance.receiptId);
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, accepted.body);
  assert.equal(verifyViewerReceipt(status.body.viewerReceipt, trustedReceiptKeys), true);
  assert.equal(fs.readFileSync(path.join(storage.root, 'receipt-1', 'result-1.bin'), 'utf8'), 'abc');
});

enabledTest('TreeDar v2 combined result resumes across restart and returns the same full-closure receipt on replay', async t => {
  const storage = tempStorage(t);
  let ledger = new ReferenceAcceptanceLedger(storage);
  let api = startRouteHarness({ ledger });
  t.after(() => { try { ledger.close(); } catch {} });
  const receiptId = 'treedar-combined-restart';
  const prepared = treeDarReservation(receiptId, { combined: true });
  const reserved = await api.request('PUT', receiptId, prepared.body, { pathPrefix: TREEDAR_PATH });
  assert.equal(reserved.status, 202);
  assert.equal(reserved.body.state, 'receiving');
  assert.equal(reserved.body.objects.length, prepared.objects.length);

  const firstObject = prepared.objects[0];
  const firstCut = Math.min(5, firstObject.bytes.length - 1);
  const partial = await api.request('PUT', receiptId, firstObject.bytes.subarray(0, firstCut), {
    pathPrefix: TREEDAR_PATH, objectId: firstObject.id, offset: 0,
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.receivedBytes, firstCut);
  ledger.close();

  ledger = new ReferenceAcceptanceLedger(storage);
  api = startRouteHarness({ ledger });
  const replayedReservation = await api.request('PUT', receiptId, prepared.body, { pathPrefix: TREEDAR_PATH });
  assert.equal(replayedReservation.status, 202);
  const resumed = await api.request('GET', receiptId, undefined, { pathPrefix: TREEDAR_PATH });
  assert.equal(resumed.status, 202);
  assert.equal(resumed.body.objects.find(object => object.objectId === firstObject.id).receivedBytes, firstCut);
  const wrongProtocolPath = await api.request('GET', receiptId);
  assert.equal(wrongProtocolPath.status, 404);

  const remainder = await api.request('PUT', receiptId, firstObject.bytes.subarray(firstCut), {
    pathPrefix: TREEDAR_PATH, objectId: firstObject.id, offset: firstCut,
  });
  assert.equal(remainder.status, 200);
  assert.equal(remainder.body.complete, true);
  for (const object of prepared.objects.slice(1)) {
    const uploaded = await api.request('PUT', receiptId, object.bytes, {
      pathPrefix: TREEDAR_PATH, objectId: object.id, offset: 0,
    });
    assert.equal(uploaded.status, 200);
    assert.equal(uploaded.body.complete, true);
  }

  const committed = await api.request('POST', receiptId, undefined, { pathPrefix: TREEDAR_PATH });
  assert.equal(committed.status, 201);
  assert.equal(committed.body.fullyAccepted, true);
  assert.deepEqual(committed.body.acceptedObjectIds, prepared.body.expected.objectIds);
  assert.equal(verifyViewerReceipt(committed.body.viewerReceipt, trustedReceiptKeys), true);
  assert.deepEqual(committed.body.viewerReceipt.acceptedObjectIds, [...prepared.body.expected.objectIds].sort());
  for (const object of prepared.objects) {
    assert.deepEqual(fs.readFileSync(path.join(storage.root, receiptId, `${object.id}.bin`)), object.bytes);
  }

  const statusReplay = await api.request('GET', receiptId, undefined, { pathPrefix: TREEDAR_PATH });
  assert.equal(statusReplay.status, 200);
  assert.deepEqual(statusReplay.body.acceptance, committed.body.acceptance);
  assert.deepEqual(statusReplay.body.viewerReceipt, committed.body.viewerReceipt);
  const commitReplay = await api.request('POST', receiptId, undefined, { pathPrefix: TREEDAR_PATH });
  assert.equal(commitReplay.status, 200);
  assert.deepEqual(commitReplay.body.viewerReceipt, committed.body.viewerReceipt);
});

enabledTest('TreeDar v2 applies the durable byte quota and rejects tampered object bytes', async t => {
  const quotaStorage = tempStorage(t);
  const quotaLedger = new ReferenceAcceptanceLedger({ ...quotaStorage, maxManagedBytes: 1 });
  t.after(() => { try { quotaLedger.close(); } catch {} });
  const quotaApi = startRouteHarness({ ledger: quotaLedger });
  const overQuota = treeDarReservation('treedar-over-quota');
  const quotaResponse = await quotaApi.request('PUT', 'treedar-over-quota', overQuota.body, { pathPrefix: TREEDAR_PATH });
  assert.equal(quotaResponse.status, 507);
  assert.equal(quotaResponse.body.code, 'STORAGE_QUOTA_EXCEEDED');
  assert.equal(quotaLedger.getTransfer('treedar-over-quota'), null);

  const storage = tempStorage(t);
  const ledger = new ReferenceAcceptanceLedger(storage);
  t.after(() => { try { ledger.close(); } catch {} });
  const api = startRouteHarness({ ledger });
  const receiptId = 'treedar-tamper';
  const prepared = treeDarReservation(receiptId);
  assert.equal((await api.request('PUT', receiptId, prepared.body, { pathPrefix: TREEDAR_PATH })).status, 202);
  const object = prepared.objects[0];
  const tampered = Buffer.alloc(object.bytes.length, 0x78);
  const rejected = await api.request('PUT', receiptId, tampered, {
    pathPrefix: TREEDAR_PATH, objectId: object.id, offset: 0,
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'STORAGE_DIGEST_MISMATCH');
  const held = await api.request('GET', receiptId, undefined, { pathPrefix: TREEDAR_PATH });
  assert.equal(held.status, 202);
  assert.equal(held.body.state, 'held');
  const commit = await api.request('POST', receiptId, undefined, { pathPrefix: TREEDAR_PATH });
  assert.equal(commit.status, 409);
  assert.equal(commit.body.code, 'TRANSFER_INCOMPLETE');
  assert.equal(ledger.get(receiptId), null);
});

test('Viewer acceptance receipt is independently signed and rejects tampering or an unknown key', () => {
  const receiptSigner = createViewerReceiptSigner({
    issuerId: 'viewer-acceptance', keyId: 'viewer-test-2026',
    privateKeyPem: receiptKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const expected = expectedFromFixture();
  const receipt = receiptSigner({ expected, resultManifest: fixture.resultManifest, acceptedObjectIds: ['result-1'] });
  assert.equal(verifyViewerReceipt(receipt, trustedReceiptKeys), true);
  assert.equal(verifyViewerReceipt({ ...receipt, generation: receipt.generation + 1 }, trustedReceiptKeys), false);
  assert.equal(verifyViewerReceipt(receipt, {}), false);
});

test('Viewer verifies the cross-language signed accepted-copy receipt vector', () => {
  const receipt = crossLanguageReceipt.receipt;
  assert.equal(receipt.protocol, 'ltds-viewer-accepted-copy-v1');
  assert.equal(receipt.issuerId, crossLanguageReceipt.issuerId);
  assert.equal(receipt.keyId, crossLanguageReceipt.keyId);
  assert.equal(verifyViewerReceipt(receipt, { [crossLanguageReceipt.keyId]: crossLanguageReceipt.publicKeyPem }), true);
  assert.equal(verifyViewerReceipt({ ...receipt, resultManifestSha256: '0'.repeat(64) }, { [crossLanguageReceipt.keyId]: crossLanguageReceipt.publicKeyPem }), false);
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
