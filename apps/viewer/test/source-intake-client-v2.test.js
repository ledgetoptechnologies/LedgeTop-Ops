'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { MAX_COMPLETION_RESPONSE_BYTES, SourceIntakeClientV2, acknowledgedObjects, validateCompletionReceipt, validateReceivingBinding } = require('../server/sourceIntakeClientV2');
const { canonicalizeJcs } = require('../server/preparedSubmissionOutbox');
const crypto = require('node:crypto');

const attemptId = '9160ed62-e5e6-4319-b213-fce0b3c5602e';
const taskId = 'c957e280-108b-48a9-9c51-c6480a5ff567';
const providerTaskId = '184af684-99d1-45c2-a910-80a9c36eb786';
const manifest = { sha256: 'a'.repeat(64) };
const derivedManifest = { sha256: 'b'.repeat(64) };
const sourceAttestation = { proof: { pipelineDigest: 'c'.repeat(64) } };
const request = { schemaVersion: 2, submissionId: attemptId, viewerTaskId: taskId, providerTaskId,
  manifest, sourceManifest: manifest, derivedManifest, sourceAttestation };

function receivingBinding() {
  return {
    jobId: providerTaskId, attemptId, providerTaskId, generation: 2, environment: 'staging',
    manifestSha256: manifest.sha256, pipelineManifestSha256: manifest.sha256,
    sourceManifestSha256: manifest.sha256, derivedManifestSha256: derivedManifest.sha256,
    pipelineDigest: sourceAttestation.proof.pipelineDigest, status: 'queued', phase: 'source_receiving',
    sourceState: 'receiving', derivedState: 'receiving', sourceReceipt: null, derivedReceipt: null,
    sourceReceiptSha256: null, derivedReceiptSha256: null,
  };
}

test('V2 metadata response is strictly bound to the exact prepared attempt and manifests', () => {
  assert.deepEqual(validateReceivingBinding(receivingBinding(), request, { environment: 'staging' }), receivingBinding());
  for (const [key, value] of [['providerTaskId', attemptId], ['generation', 0], ['sourceReceipt', {}], ['environment', 'production']]) {
    const changed = { ...receivingBinding(), [key]: value };
    assert.throws(() => validateReceivingBinding(changed, request, { environment: 'staging' }), { code: 'source_intake_binding_mismatch' });
  }
});

test('V2 capabilities are checked against the deployment and complete acceptance gates', async () => {
  const capabilities = { protocol: 'ltds-reference-v1', schemaVersion: 1, environment: 'staging',
    capabilityFingerprint: 'a'.repeat(64), limits: { metadataBytes: 4 * 1024 * 1024, objects: 10_000, integer: Number.MAX_SAFE_INTEGER },
    engines: { odm: { available: true, optionsFingerprint: 'b'.repeat(64) },
      treedar: { available: false, admissionVersion: 'treedar-lidar-v1' },
      gaussian_splat: { available: false, enabled: false } },
    sourceIntake: { enabled: true, maxObjects: 10_000 }, viewerAcceptance: { enabled: true } };
  const client = new SourceIntakeClientV2({ origin: 'https://processing.example', bearerToken: 'test-only',
    environment: 'staging', outbox: {}, fetchImpl: async () => new Response(JSON.stringify(capabilities), { status: 200 }) });
  assert.equal((await client.getCapabilities()).capabilities.capabilityFingerprint, 'a'.repeat(64));
  const unavailable = new SourceIntakeClientV2({ origin: 'https://processing.example', bearerToken: 'test-only',
    environment: 'staging', outbox: {}, fetchImpl: async () => new Response(JSON.stringify({ ...capabilities,
      sourceIntake: { enabled: false } }), { status: 200 }) });
  await assert.rejects(unavailable.getCapabilities(), { code: 'source_intake_unavailable' });
  const wrongEnvironment = new SourceIntakeClientV2({ origin: 'https://processing.example', bearerToken: 'test-only',
    environment: 'production', outbox: {}, fetchImpl: async () => new Response(JSON.stringify(capabilities), { status: 200 }) });
  await assert.rejects(wrongEnvironment.getCapabilities(), { code: 'source_intake_unavailable' });
});

test('V2 metadata is posted once from immutable outbox bytes and binding is persisted before upload', async () => {
  const exactBody = canonicalizeJcs(request).toString('utf8');
  let posts = 0;
  let accepted = null;
  const saved = { viewerAttemptId: attemptId, sourceIntakeCanonical: exactBody,
    envelopeCanonical: JSON.stringify({ submission: { capabilityFingerprint: 'a'.repeat(64) } }),
    sourceIntakeSha256: crypto.createHash('sha256').update(exactBody).digest('hex'),
    coordinatorAuthorityId: 'coordinator-staging', state: 'prepared' };
  let current = saved;
  const outbox = {
    assertCurrentLease: () => current,
    acceptSourceIntakeBinding: (id, response, options) => {
      accepted = { id, response, options };
      current = { ...saved, state: 'accepted', remoteBinding: {
        protocol: 'ltds-viewer-source-intake-binding-v2', coordinatorAuthorityId: saved.coordinatorAuthorityId,
        jobId: response.jobId, attemptId: response.attemptId, providerTaskId: response.providerTaskId,
        generation: response.generation, environment: response.environment,
        manifestSha256: response.manifestSha256, pipelineManifestSha256: response.pipelineManifestSha256,
        sourceManifestSha256: response.sourceManifestSha256, derivedManifestSha256: response.derivedManifestSha256,
        pipelineDigest: response.pipelineDigest, requestSha256: saved.sourceIntakeSha256,
      } };
      return current;
    },
  };
  const client = new SourceIntakeClientV2({
    origin: 'https://processing.example', bearerToken: 'test-only', environment: 'staging', outbox,
    fetchImpl: async (url, init) => {
      if (url.endsWith(`/ltds/v2/jobs/by-submission/${attemptId}`)) {
        assert.equal(init.method, 'GET');
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      posts++;
      assert.equal(url, 'https://processing.example/ltds/v2/jobs');
      assert.equal(init.method, 'POST');
      assert.equal(init.body, exactBody);
      return new Response(JSON.stringify(receivingBinding()), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  const result = await client.createOrReplay({ ...saved, localJobId: 'local-job-1' }, { localJobId: 'local-job-1', owner: 'worker-1', capabilityFingerprint: 'a'.repeat(64) });
  assert.deepEqual(result, current.remoteBinding);
  assert.equal(posts, 1);
  assert.equal(accepted.id, attemptId);
  assert.equal(accepted.response.generation, 2);
  const replay = await client.createOrReplay({ ...current, localJobId: 'local-job-1' }, { localJobId: 'local-job-1', owner: 'worker-1' });
  assert.deepEqual(replay, current.remoteBinding);
  assert.equal(posts, 1, 'accepted replay reuses the persisted binding without another POST');
});

test('V2 source objects stream with manifest-bound length and digest headers', async () => {
  const chunks = [];
  const client = new SourceIntakeClientV2({
    origin: 'https://processing.example', bearerToken: 'test-only', environment: 'staging', outbox: {},
    fetchImpl: async (url, init) => {
      assert.equal(url, `https://processing.example/ltds/v2/jobs/${providerTaskId}/source/object-1?generation=3`);
      assert.equal(init.headers['Content-Length'], '5');
      assert.equal(init.headers['Content-SHA256'], 'e'.repeat(64));
      assert.equal(init.headers['Content-Type'], 'application/octet-stream');
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk));
      return new Response(null, { status: 201 });
    },
  });
  const result = await client.uploadObject({
    jobId: providerTaskId, generation: 3, object: { id: 'object-1', byteSize: 5, sha256: 'e'.repeat(64) },
    openStream: async () => Readable.from([Buffer.from('hello')]),
  });
  assert.deepEqual(result, { objectId: 'object-1', status: 201 });
  assert.equal(Buffer.concat(chunks).toString(), 'hello');
});

test('V2 closure uploads GCP-derived bytes after raw inputs and completes only after every ACK', async () => {
  const sourceBytes = Buffer.from('raw-photo'), derivedContent = Buffer.from('GCP 1 2 3\n');
  const sourceObject = { id: 'source-1', name: 'photo.jpg', byteSize: sourceBytes.length,
    sha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'), sourceType: 'raw_input',
    retentionClass: 'release_after_acceptance', retentionHoldId: null };
  const derivedObject = { id: `gcp_${attemptId}`, name: 'gcp_list.txt', byteSize: derivedContent.length,
    sha256: crypto.createHash('sha256').update(derivedContent).digest('hex'), snapshotAttemptId: attemptId,
    snapshotContentSha256: crypto.createHash('sha256').update(derivedContent).digest('hex'),
    snapshotEvidenceSha256: 'f'.repeat(64), sourceType: 'attempt_derived_gcp_list', retentionHoldId: null,
    retentionClass: 'release_after_acceptance' };
  const manifests = { sourceManifestSha256: 'a'.repeat(64), derivedManifestSha256: 'b'.repeat(64), pipelineManifestSha256: 'c'.repeat(64),
    sourceManifest: { sha256: 'a'.repeat(64), objects: [sourceObject] },
    derivedManifest: { sha256: 'b'.repeat(64), objects: [derivedObject] } };
  const binding = { jobId: providerTaskId, attemptId, providerTaskId, generation: 2, environment: 'staging', pipelineDigest: 'd'.repeat(64) };
  const sourceReceipt = { schemaVersion: 2, receiptType: 'source_retention', receiptId: '50d76636-9aac-45c5-b9d6-7f531145c9ed',
    storageReceiptId: '079522fb-c47e-4e93-9791-7b8d6953e098', jobId: providerTaskId, attemptId, generation: 2,
    environment: 'staging', pipelineManifestSha256: manifests.pipelineManifestSha256, sourceManifestSha256: manifests.sourceManifestSha256,
    pipelineDigest: binding.pipelineDigest, objects: [{ id: sourceObject.id, byteSize: sourceObject.byteSize, sha256: sourceObject.sha256,
      sourceType: sourceObject.sourceType, retentionClass: sourceObject.retentionClass, retentionHoldId: sourceObject.retentionHoldId }],
    retainedAt: '2026-11-04T20:00:00.000Z', retentionGuarantee: 'until_explicit_source_release_v1' };
  const derivedReceipt = { schemaVersion: 1, receiptType: 'attempt_derived_input', receiptId: 'e2b1d069-3d5c-4d74-9e8a-11399348e389',
    jobId: providerTaskId, attemptId, generation: 2, environment: 'staging', derivedManifestSha256: manifests.derivedManifestSha256,
    objects: [{ id: derivedObject.id, name: derivedObject.name, byteSize: derivedObject.byteSize, sha256: derivedObject.sha256,
      snapshotAttemptId: derivedObject.snapshotAttemptId, snapshotContentSha256: derivedObject.snapshotContentSha256,
      snapshotEvidenceSha256: derivedObject.snapshotEvidenceSha256, sourceType: derivedObject.sourceType,
      retentionHoldId: null, retentionClass: derivedObject.retentionClass }], retainedAt: '2026-11-04T20:00:00.000Z' };
  const digest = (value) => crypto.createHash('sha256').update(canonicalizeJcs(value)).digest('hex');
  const responseBody = { ...binding, status: 'queued', phase: 'queued', sourceState: 'retained', derivedState: 'retained',
    pipelineManifestSha256: manifests.pipelineManifestSha256, sourceManifestSha256: manifests.sourceManifestSha256,
    derivedManifestSha256: manifests.derivedManifestSha256, sourceReceipt, derivedReceipt,
    sourceReceiptSha256: digest(sourceReceipt), derivedReceiptSha256: digest(derivedReceipt),
    sourceObjectReceipts: [{ objectId: sourceObject.id, objectKind: 'source', byteSize: sourceObject.byteSize,
      sha256: sourceObject.sha256, generation: 2, manifestSha256: manifests.sourceManifestSha256 }],
    derivedObjectReceipts: [{ objectId: derivedObject.id, objectKind: 'derived', byteSize: derivedObject.byteSize,
      sha256: derivedObject.sha256, generation: 2, manifestSha256: manifests.derivedManifestSha256 }] };
  const restartStatus = { ...binding, manifestSha256: manifests.pipelineManifestSha256,
    sourceManifestSha256: manifests.sourceManifestSha256, derivedManifestSha256: manifests.derivedManifestSha256,
    sourceObjectReceipts: [{ objectId: sourceObject.id, objectKind: 'source', byteSize: sourceObject.byteSize,
      sha256: sourceObject.sha256, generation: binding.generation, manifestSha256: manifests.sourceManifestSha256 }],
    derivedObjectReceipts: [] };
  const events = [];
  const client = new SourceIntakeClientV2({ origin: 'https://processing.example', bearerToken: 'test-only', environment: 'staging',
    outbox: { persistSourceIntakeCompletion: (_id, record) => ({ state: 'stored', record }) },
    fetchImpl: async (url, init) => {
      if (init.method === 'GET') { events.push('status'); return new Response(JSON.stringify(restartStatus), { status: 200 }); }
      if (init.method === 'PUT') {
        for await (const _chunk of init.body) { /* consume the bounded stream */ }
        events.push(url.includes('gcp_') ? 'derived' : 'source');
        return new Response(null, { status: 201 });
      }
      events.push('complete');
      return new Response(JSON.stringify(responseBody), { status: 201 });
    },
  });
  const result = await client.uploadClosure({ binding, manifests, derivedBytes: new Map([[derivedObject.id, derivedContent]]),
    openSourceStream: async (object) => Readable.from([sourceBytes]), localJobId: 'local-job', owner: 'worker' });
  assert.deepEqual(events, ['status', 'derived', 'complete']);
  assert.equal(result.state, 'stored');
  assert.equal(result.record.sourceReceipt.objects.length, 1);
});

test('V2 restart status acknowledgements must exactly match attempt, generation and manifest objects', () => {
  const sourceObject = { id: 'source-1', byteSize: 4, sha256: 'a'.repeat(64) };
  const manifests = { sourceManifestSha256: 'b'.repeat(64), derivedManifestSha256: 'c'.repeat(64),
    pipelineManifestSha256: 'd'.repeat(64), sourceManifest: { objects: [sourceObject] }, derivedManifest: { objects: [] } };
  const binding = { jobId: providerTaskId, attemptId, providerTaskId, generation: 3, environment: 'staging' };
  const status = { ...binding, manifestSha256: manifests.pipelineManifestSha256,
    sourceManifestSha256: manifests.sourceManifestSha256, derivedManifestSha256: manifests.derivedManifestSha256,
    sourceObjectReceipts: [{ objectId: sourceObject.id, objectKind: 'source', byteSize: 4, sha256: sourceObject.sha256,
      generation: 3, manifestSha256: manifests.sourceManifestSha256 }], derivedObjectReceipts: [] };
  assert.deepEqual(acknowledgedObjects(status, binding, manifests), new Set(['source-1']));
  assert.throws(() => acknowledgedObjects({ ...status, generation: 2 }, binding, manifests),
    { code: 'source_intake_status_binding_mismatch' });
  assert.throws(() => acknowledgedObjects({ ...status, sourceObjectReceipts: [{ ...status.sourceObjectReceipts[0], sha256: 'e'.repeat(64) }] }, binding, manifests),
    { code: 'source_intake_status_receipt_mismatch' });
});

test('source completion verifies both custody receipts and the permanent GCP hold inventory', () => {
  const sourceObject = { id: 'source-1', name: 'gcp.csv', byteSize: 3, sha256: 'e'.repeat(64), sourceType: 'gcp_source_csv',
    retentionClass: 'permanent_viewer_hold', retentionHoldId: 'source-1' };
  const manifests = {
    pipelineManifestSha256: 'a'.repeat(64),
    sourceManifestSha256: 'b'.repeat(64),
    derivedManifestSha256: 'c'.repeat(64),
    sourceManifest: { objects: [sourceObject] },
    derivedManifest: { objects: [] },
  };
  const binding = { jobId: providerTaskId, attemptId, providerTaskId, generation: 4, environment: 'staging', pipelineDigest: 'd'.repeat(64) };
  const sourceReceipt = { schemaVersion: 2, receiptType: 'source_retention', receiptId: '50d76636-9aac-45c5-b9d6-7f531145c9ed',
    storageReceiptId: '079522fb-c47e-4e93-9791-7b8d6953e098', jobId: providerTaskId, attemptId, generation: 4,
    environment: 'staging', pipelineManifestSha256: manifests.pipelineManifestSha256, sourceManifestSha256: manifests.sourceManifestSha256,
    pipelineDigest: binding.pipelineDigest, objects: [{ id: sourceObject.id, byteSize: sourceObject.byteSize, sha256: sourceObject.sha256,
      sourceType: sourceObject.sourceType, retentionClass: sourceObject.retentionClass, retentionHoldId: sourceObject.retentionHoldId }],
    retainedAt: '2026-11-04T20:00:00.000Z', retentionGuarantee: 'until_explicit_source_release_v1' };
  const derivedReceipt = { schemaVersion: 1, receiptType: 'attempt_derived_input', receiptId: 'e2b1d069-3d5c-4d74-9e8a-11399348e389',
    jobId: providerTaskId, attemptId, generation: 4, environment: 'staging', derivedManifestSha256: manifests.derivedManifestSha256,
    objects: [], retainedAt: '2026-11-04T20:00:00.000Z' };
  const digest = (value) => crypto.createHash('sha256').update(canonicalizeJcs(value)).digest('hex');
  const completed = { ...binding, status: 'queued', phase: 'queued', sourceState: 'retained', derivedState: 'retained',
    pipelineManifestSha256: manifests.pipelineManifestSha256, sourceManifestSha256: manifests.sourceManifestSha256,
    derivedManifestSha256: manifests.derivedManifestSha256, sourceReceipt, derivedReceipt,
    sourceObjectReceipts: [{ objectId: 'source-1', objectKind: 'source', byteSize: 3, sha256: 'e'.repeat(64),
      generation: 4, manifestSha256: manifests.sourceManifestSha256 }], derivedObjectReceipts: [],
    sourceReceiptSha256: digest(sourceReceipt), derivedReceiptSha256: digest(derivedReceipt) };
  assert.equal(validateCompletionReceipt(completed, binding, manifests), completed);
  assert.throws(() => validateCompletionReceipt({ ...completed, sourceReceipt: { ...sourceReceipt, objects: [] } }, binding, manifests),
    { code: 'source_intake_receipt_binding_mismatch' });
  assert.throws(() => validateCompletionReceipt({ ...completed, derivedReceiptSha256: '0'.repeat(64) }, binding, manifests),
    { code: 'source_intake_receipt_binding_mismatch' });
});

test('bounded completion validation and compact persistence support a 10,000-object source closure', async () => {
  const sourceObjects = Array.from({ length: 10_000 }, (_, index) => ({ id: `photo-${String(index).padStart(5, '0')}`,
    name: `photo-${String(index).padStart(5, '0')}.jpg`, byteSize: 1_000_000, sha256: 'e'.repeat(64),
    sourceType: 'raw_input', retentionClass: 'release_after_acceptance', retentionHoldId: null }));
  const manifests = { pipelineManifestSha256: 'a'.repeat(64), sourceManifestSha256: 'b'.repeat(64),
    derivedManifestSha256: 'c'.repeat(64), sourceManifest: { objects: sourceObjects }, derivedManifest: { objects: [] } };
  const binding = { jobId: providerTaskId, attemptId, providerTaskId, generation: 7, environment: 'staging', pipelineDigest: 'd'.repeat(64) };
  const sourceReceipt = { schemaVersion: 2, receiptType: 'source_retention', receiptId: '50d76636-9aac-45c5-b9d6-7f531145c9ed',
    storageReceiptId: '079522fb-c47e-4e93-9791-7b8d6953e098', jobId: providerTaskId, attemptId, generation: 7,
    environment: 'staging', pipelineManifestSha256: manifests.pipelineManifestSha256, sourceManifestSha256: manifests.sourceManifestSha256,
    pipelineDigest: binding.pipelineDigest, objects: sourceObjects.map(({ id, byteSize, sha256, sourceType, retentionClass, retentionHoldId }) =>
      ({ id, byteSize, sha256, sourceType, retentionClass, retentionHoldId })), retainedAt: '2026-11-04T20:00:00.000Z',
    retentionGuarantee: 'until_explicit_source_release_v1' };
  const derivedReceipt = { schemaVersion: 1, receiptType: 'attempt_derived_input', receiptId: 'e2b1d069-3d5c-4d74-9e8a-11399348e389',
    jobId: providerTaskId, attemptId, generation: 7, environment: 'staging', derivedManifestSha256: manifests.derivedManifestSha256,
    objects: [], retainedAt: '2026-11-04T20:00:00.000Z' };
  const digest = (value) => crypto.createHash('sha256').update(canonicalizeJcs(value)).digest('hex');
  const completed = { ...binding, status: 'queued', phase: 'queued', sourceState: 'retained', derivedState: 'retained',
    pipelineManifestSha256: manifests.pipelineManifestSha256, sourceManifestSha256: manifests.sourceManifestSha256,
    derivedManifestSha256: manifests.derivedManifestSha256, sourceReceipt, derivedReceipt,
    sourceObjectReceipts: sourceObjects.map((object) => ({ objectId: object.id, objectKind: 'source', byteSize: object.byteSize,
      sha256: object.sha256, generation: binding.generation, manifestSha256: manifests.sourceManifestSha256 })),
    derivedObjectReceipts: [], sourceReceiptSha256: digest(sourceReceipt), derivedReceiptSha256: digest(derivedReceipt) };
  assert.ok(Buffer.byteLength(JSON.stringify(completed)) > 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(completed)) < MAX_COMPLETION_RESPONSE_BYTES);
  assert.equal(validateCompletionReceipt(completed, binding, manifests), completed);
  let persisted = null;
  const client = new SourceIntakeClientV2({ origin: 'https://processing.example', bearerToken: 'test-only',
    environment: 'staging', outbox: { persistSourceIntakeCompletion: (...args) => { persisted = args; return { state: 'stored' }; } },
    fetchImpl: async (url, init) => {
      assert.equal(url, `https://processing.example/ltds/v2/jobs/${providerTaskId}/source/complete`);
      assert.equal(init.method, 'POST');
      return new Response(JSON.stringify(completed), { status: 201, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.deepEqual(await client.complete(binding, manifests, { localJobId: 'local-job', owner: 'worker' }), { state: 'stored' });
  assert.equal(persisted[0], attemptId);
  assert.equal(Object.hasOwn(persisted[1], 'sourceObjectReceipts'), false);
  assert.equal(Object.hasOwn(persisted[1], 'derivedObjectReceipts'), false);
  assert.equal(persisted[1].sourceReceipt.objects.length, 10_000);
});
