'use strict';

const { MAX_BODY_BYTES, canonicalizeJcs, validateOrigin } = require('./preparedSubmissionOutbox');
const ReferenceProtocol = require('./referenceProtocol');
const { Readable } = require('node:stream');
const {
  MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS,
  MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
} = require('./sourceIntakeLimitsV2');

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_COMPLETION_RESPONSE_BYTES = MAX_SOURCE_INTAKE_V2_METADATA_BYTES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function receiptDigest(value) {
  return require('node:crypto').createHash('sha256').update(canonicalizeJcs(value, {
    maxBytes: MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
    maxNodes: MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  })).digest('hex');
}

function assertClosed(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateCompletionReceipt(response, binding, manifests) {
  const sourceKeys = ['schemaVersion','receiptType','receiptId','storageReceiptId','jobId','attemptId','generation',
    'environment','pipelineManifestSha256','sourceManifestSha256','pipelineDigest','objects','retainedAt','retentionGuarantee'];
  const derivedKeys = ['schemaVersion','receiptType','receiptId','jobId','attemptId','generation','environment',
    'derivedManifestSha256','objects','retainedAt'];
  const sourceObjectKeys = ['id','byteSize','sha256','sourceType','retentionClass','retentionHoldId'];
  const derivedObjectKeys = ['id','name','byteSize','sha256','snapshotAttemptId','snapshotContentSha256',
    'snapshotEvidenceSha256','sourceType','retentionHoldId','retentionClass'];
  const ackKeys = ['objectId','objectKind','byteSize','sha256','generation','manifestSha256'];
  const sourceReceipt = response?.sourceReceipt;
  const derivedReceipt = response?.derivedReceipt;
  if (!response || response.jobId !== binding.jobId || response.attemptId !== binding.attemptId
      || response.providerTaskId !== binding.providerTaskId || response.generation !== binding.generation
      || response.environment !== binding.environment || response.status !== 'queued' || response.phase !== 'queued'
      || response.sourceState !== 'retained' || response.derivedState !== 'retained'
      || response.pipelineManifestSha256 !== manifests.pipelineManifestSha256
      || response.sourceManifestSha256 !== manifests.sourceManifestSha256
      || response.derivedManifestSha256 !== manifests.derivedManifestSha256
      || response.pipelineDigest !== binding.pipelineDigest
      || !assertClosed(sourceReceipt, sourceKeys) || sourceReceipt.schemaVersion !== 2
      || sourceReceipt.receiptType !== 'source_retention' || !UUID.test(sourceReceipt.receiptId || '')
      || !UUID.test(sourceReceipt.storageReceiptId || '') || sourceReceipt.jobId !== binding.jobId
      || sourceReceipt.attemptId !== binding.attemptId || sourceReceipt.generation !== binding.generation
      || sourceReceipt.environment !== binding.environment
      || sourceReceipt.pipelineManifestSha256 !== manifests.pipelineManifestSha256
      || sourceReceipt.sourceManifestSha256 !== manifests.sourceManifestSha256
      || sourceReceipt.pipelineDigest !== binding.pipelineDigest
      || sourceReceipt.retentionGuarantee !== 'until_explicit_source_release_v1'
      || typeof sourceReceipt.retainedAt !== 'string' || !Number.isFinite(Date.parse(sourceReceipt.retainedAt))
      || !Array.isArray(sourceReceipt.objects)
      || !Array.isArray(response.sourceObjectReceipts) || !Array.isArray(response.derivedObjectReceipts)
      || !assertClosed(derivedReceipt, derivedKeys) || derivedReceipt.schemaVersion !== 1
      || derivedReceipt.receiptType !== 'attempt_derived_input' || !UUID.test(derivedReceipt.receiptId || '')
      || derivedReceipt.jobId !== binding.jobId || derivedReceipt.attemptId !== binding.attemptId
      || derivedReceipt.generation !== binding.generation || derivedReceipt.environment !== binding.environment
      || derivedReceipt.derivedManifestSha256 !== manifests.derivedManifestSha256
      || typeof derivedReceipt.retainedAt !== 'string' || !Number.isFinite(Date.parse(derivedReceipt.retainedAt))
      || !Array.isArray(derivedReceipt.objects)
      || response.sourceReceiptSha256 !== receiptDigest(sourceReceipt)
      || response.derivedReceiptSha256 !== receiptDigest(derivedReceipt)
      || !hash(response.sourceReceiptSha256) || !hash(response.derivedReceiptSha256)) fail('source_intake_receipt_binding_mismatch');

  const expectedSourceObjects = manifests.sourceManifest.objects.map((object) => Object.fromEntries(
    sourceObjectKeys.map((key) => [key, object[key]])));
  const expectedDerivedObjects = manifests.derivedManifest.objects.map((object) => Object.fromEntries(
    derivedObjectKeys.map((key) => [key, object[key]])));
  const expectedSourceAcks = manifests.sourceManifest.objects.map((object) => ({ objectId: object.id,
    objectKind: 'source', byteSize: object.byteSize, sha256: object.sha256,
    generation: binding.generation, manifestSha256: manifests.sourceManifestSha256 }));
  const expectedDerivedAcks = manifests.derivedManifest.objects.map((object) => ({ objectId: object.id,
    objectKind: 'derived', byteSize: object.byteSize, sha256: object.sha256,
    generation: binding.generation, manifestSha256: manifests.derivedManifestSha256 }));
  const canonicalOptions = { maxBytes: MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
    maxNodes: MAX_SOURCE_INTAKE_V2_CANONICAL_NODES };
  if (!canonicalizeJcs(sourceReceipt.objects, canonicalOptions).equals(canonicalizeJcs(expectedSourceObjects, canonicalOptions))
      || !canonicalizeJcs(derivedReceipt.objects, canonicalOptions).equals(canonicalizeJcs(expectedDerivedObjects, canonicalOptions))
      || sourceReceipt.objects.some((object) => !assertClosed(object, sourceObjectKeys))
      || derivedReceipt.objects.some((object) => !assertClosed(object, derivedObjectKeys))
      || response.sourceObjectReceipts.some((ack) => !assertClosed(ack, ackKeys))
      || response.derivedObjectReceipts.some((ack) => !assertClosed(ack, ackKeys))
      || !canonicalizeJcs(response.sourceObjectReceipts, canonicalOptions).equals(canonicalizeJcs(expectedSourceAcks, canonicalOptions))
      || !canonicalizeJcs(response.derivedObjectReceipts, canonicalOptions).equals(canonicalizeJcs(expectedDerivedAcks, canonicalOptions)))
    fail('source_intake_receipt_inventory_mismatch');
  return response;
}

async function boundedJson(response, limit = MAX_RESPONSE_BYTES, maxNodes = 100_000) {
  const parse = (bytes) => {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('source_intake_response_invalid'); }
    try { canonicalizeJcs(value, { maxBytes: limit, maxNodes }); }
    catch { fail('source_intake_response_invalid'); }
    return value;
  };
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > limit) fail('source_intake_response_too_large');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) fail('source_intake_response_too_large');
    return parse(bytes);
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => {}); fail('source_intake_response_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock?.(); }
  return parse(Buffer.concat(chunks, total));
}

function validateReceivingBinding(response, request, { environment }) {
  if (!response || Object.getPrototypeOf(response) !== Object.prototype
      || response.jobId !== request.providerTaskId || response.attemptId !== request.submissionId
      || response.providerTaskId !== request.providerTaskId || !Number.isSafeInteger(response.generation)
      || response.generation < 1 || response.environment !== environment
      || response.manifestSha256 !== request.manifest.sha256
      || response.pipelineManifestSha256 !== request.manifest.sha256
      || response.sourceManifestSha256 !== request.sourceManifest.sha256
      || response.derivedManifestSha256 !== request.derivedManifest.sha256
      || response.pipelineDigest !== request.sourceAttestation.proof.pipelineDigest
      || response.status !== 'queued' || response.phase !== 'source_receiving'
      || response.sourceState !== 'receiving' || response.derivedState !== 'receiving'
      || response.sourceReceipt !== null || response.derivedReceipt !== null
      || response.sourceReceiptSha256 !== null || response.derivedReceiptSha256 !== null) {
    fail('source_intake_binding_mismatch');
  }
  return response;
}

function validatePersistedReceivingBinding(saved, request, { environment }) {
  const binding = saved?.remoteBinding;
  const keys = ['protocol','coordinatorAuthorityId','jobId','attemptId','providerTaskId','generation','environment',
    'manifestSha256','pipelineManifestSha256','sourceManifestSha256','derivedManifestSha256','pipelineDigest','requestSha256'];
  if (saved?.state !== 'accepted' || !assertClosed(binding, keys)
      || binding.protocol !== 'ltds-viewer-source-intake-binding-v2'
      || binding.coordinatorAuthorityId !== saved.coordinatorAuthorityId
      || binding.requestSha256 !== saved.sourceIntakeSha256) fail('source_intake_binding_missing');
  validateReceivingBinding({ ...binding, status: 'queued', phase: 'source_receiving', sourceState: 'receiving',
    derivedState: 'receiving', sourceReceipt: null, derivedReceipt: null,
    sourceReceiptSha256: null, derivedReceiptSha256: null }, request, { environment });
  return binding;
}

function acknowledgedObjects(status, binding, manifests) {
  if (!status || status.jobId !== binding.jobId || status.attemptId !== binding.attemptId
      || status.providerTaskId !== binding.providerTaskId || status.generation !== binding.generation
      || status.environment !== binding.environment || status.manifestSha256 !== manifests.pipelineManifestSha256
      || status.sourceManifestSha256 !== manifests.sourceManifestSha256
      || status.derivedManifestSha256 !== manifests.derivedManifestSha256
      || !Array.isArray(status.sourceObjectReceipts) || !Array.isArray(status.derivedObjectReceipts))
    fail('source_intake_status_binding_mismatch');
  const acknowledged = new Set();
  const verify = (receipts, objects, objectKind, manifestSha256) => {
    const expected = new Map(objects.map((object) => [object.id, object]));
    for (const receipt of receipts) {
      const object = expected.get(receipt?.objectId);
      if (!object || receipt.objectKind !== objectKind || receipt.byteSize !== object.byteSize
          || receipt.sha256 !== object.sha256 || receipt.generation !== binding.generation
          || receipt.manifestSha256 !== manifestSha256 || acknowledged.has(receipt.objectId))
        fail('source_intake_status_receipt_mismatch');
      acknowledged.add(receipt.objectId);
    }
  };
  verify(status.sourceObjectReceipts, manifests.sourceManifest.objects, 'source', manifests.sourceManifestSha256);
  verify(status.derivedObjectReceipts, manifests.derivedManifest.objects, 'derived', manifests.derivedManifestSha256);
  return acknowledged;
}

class SourceIntakeClientV2 {
  constructor({ origin, bearerToken, environment, outbox, fetchImpl = globalThis.fetch, timeoutMs = 30000, transferTimeoutMs = 30 * 60_000 } = {}) {
    if (typeof fetchImpl !== 'function' || !outbox || !['production', 'staging'].includes(environment)
        || typeof bearerToken !== 'string' || !bearerToken.trim()) fail('source_intake_client_invalid');
    this.origin = validateOrigin(origin);
    this.bearerToken = bearerToken;
    this.environment = environment;
    this.outbox = outbox;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.transferTimeoutMs = transferTimeoutMs;
  }

  async request(path, { method, body, headers = {}, signal } = {}) {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await this.fetch(`${this.origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.bearerToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body } : {}),
        redirect: 'error', cache: 'no-store', credentials: 'omit', signal: requestSignal,
      });
      if (response.redirected || response.url && new URL(response.url).origin !== this.origin)
        fail('source_intake_redirect_rejected');
      return response;
    } catch (error) {
      if (error?.code?.startsWith('source_intake_')) throw error;
      fail('source_intake_transport_uncertain');
    }
  }

  async getCapabilities({ signal } = {}) {
    const response = await this.request('/ltds/v2/capabilities', { method: 'GET', signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      fail(response.status >= 500 ? 'source_intake_capabilities_unavailable' : 'source_intake_capabilities_rejected');
    }
    const body = await boundedJson(response, 64 * 1024);
    const { sourceIntake, viewerAcceptance, ...capabilities } = body || {};
    try { ReferenceProtocol.validateCapabilities(capabilities); }
    catch { fail('source_intake_capabilities_invalid'); }
    if (capabilities.environment !== this.environment || !sourceIntake || sourceIntake.enabled !== true
        || !viewerAcceptance || viewerAcceptance.enabled !== true) fail('source_intake_unavailable');
    return { capabilities, sourceIntake, viewerAcceptance };
  }

  async getJob(jobId, { signal } = {}) {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(jobId)) fail('source_intake_job_id_invalid');
    const response = await this.request(`/ltds/v2/jobs/${encodeURIComponent(jobId)}`, { method: 'GET', signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      fail(response.status >= 500 ? 'source_intake_status_unavailable' : 'source_intake_status_rejected');
    }
    return boundedJson(response, MAX_SOURCE_INTAKE_V2_METADATA_BYTES, MAX_SOURCE_INTAKE_V2_CANONICAL_NODES);
  }

  async findBySubmission(submissionId, { signal } = {}) {
    if (!UUID.test(submissionId || '')) fail('source_intake_submission_id_invalid');
    let response;
    try {
      response = await this.request(`/ltds/v2/jobs/by-submission/${encodeURIComponent(submissionId)}`, { method: 'GET', signal });
    } catch {
      fail('source_intake_admission_unknown');
    }
    if (response.status === 404) {
      let body;
      try { body = await boundedJson(response, 64 * 1024); } catch { fail('source_intake_admission_unknown'); }
      if (body.error === 'not_found') return null;
      fail('source_intake_admission_unknown');
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      fail(response.status >= 500 || response.status === 408 || response.status === 429
        ? 'source_intake_admission_unknown' : 'source_intake_admission_lookup_rejected');
    }
    try { return await boundedJson(response, MAX_SOURCE_INTAKE_V2_METADATA_BYTES, MAX_SOURCE_INTAKE_V2_CANONICAL_NODES); }
    catch { fail('source_intake_admission_unknown'); }
  }

  async getLogs(binding, { after = 0, limit = 200, signal } = {}) {
    if (!binding || binding.environment !== this.environment || !UUID.test(binding.attemptId || '')
        || !Number.isSafeInteger(binding.generation) || binding.generation < 1
        || !Number.isSafeInteger(after) || after < 0 || after > 9999999999999
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('source_intake_logs_request_invalid');
    const query = new URLSearchParams({ generation: String(binding.generation), after: String(after), limit: String(limit) });
    const response = await this.request(`/ltds/v1/jobs/${encodeURIComponent(binding.jobId)}/logs?${query}`, { method: 'GET', signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      fail(response.status >= 500 ? 'source_intake_logs_unavailable' : 'source_intake_logs_rejected');
    }
    const result = await boundedJson(response, 256 * 1024);
    if (result.jobId !== binding.jobId || result.attemptId !== binding.attemptId
        || result.generation !== binding.generation || !Array.isArray(result.lines)
        || !Number.isSafeInteger(result.nextCursor) || typeof result.hasMore !== 'boolean')
      fail('source_intake_logs_binding_mismatch');
    return result;
  }

  async getResultManifest(binding, { signal } = {}) {
    if(!binding||binding.environment!==this.environment||!ID.test(binding.jobId||'')
        ||!Number.isSafeInteger(binding.generation)||binding.generation<1||!hash(binding.pipelineDigest))fail('source_intake_result_binding_invalid');
    const response=await this.request(`/ltds/v1/jobs/${encodeURIComponent(binding.jobId)}/results`,{method:'GET',signal});
    if(response.status!==200){await response.body?.cancel().catch(()=>{});fail(response.status>=500?'source_intake_result_manifest_unavailable':'source_intake_result_manifest_rejected');}
    const manifest=await boundedJson(response);
    const ids=Array.isArray(manifest?.objects)?manifest.objects.map(object=>object?.id):null;
    try{ReferenceProtocol.validateStoredResultManifest(manifest,{jobId:binding.jobId,generation:binding.generation,
      environment:this.environment,pipelineDigest:binding.pipelineDigest,resultManifestSha256:manifest?.resultManifestSha256,objectIds:ids});}
    catch{fail('source_intake_result_manifest_invalid');}
    return manifest;
  }

  async openResultObject(binding, manifest, object, { signal } = {}) {
    if(!binding||binding.environment!==this.environment||!ID.test(binding.jobId||'')
        ||!hash(manifest?.resultManifestSha256)||!Array.isArray(manifest?.objects)
        ||!manifest.objects.some(item=>item.id===object?.id&&item.byteSize===object?.byteSize&&item.sha256===object?.sha256))
      fail('source_intake_result_object_binding_invalid');
    const deadline=AbortSignal.timeout(this.transferTimeoutMs),requestSignal=signal?AbortSignal.any([signal,deadline]):deadline;
    let response;
    try{response=await this.fetch(`${this.origin}/ltds/v1/jobs/${encodeURIComponent(binding.jobId)}/results/${encodeURIComponent(object.id)}`,
      {method:'GET',headers:{Authorization:`Bearer ${this.bearerToken}`,'X-Result-Generation':String(binding.generation),
        'X-Result-Sha256':object.sha256,'X-Result-Manifest-Sha256':manifest.resultManifestSha256},redirect:'error',cache:'no-store',credentials:'omit',signal:requestSignal});}
    catch{fail('source_intake_result_transfer_uncertain');}
    if(response.redirected||response.url&&new URL(response.url).origin!==this.origin){await response.body?.cancel().catch(()=>{});fail('source_intake_redirect_rejected');}
    if(response.status!==200){await response.body?.cancel().catch(()=>{});fail(response.status>=500?'source_intake_result_transfer_uncertain':'source_intake_result_transfer_rejected');}
    const declared=Number(response.headers?.get?.('content-length'));
    if(Number.isFinite(declared)&&declared!==object.byteSize){await response.body?.cancel().catch(()=>{});fail('source_intake_result_length_mismatch');}
    const stream=response.body;
    if(!stream)fail('source_intake_result_stream_invalid');
    return stream.getReader?Readable.fromWeb(stream):stream;
  }

  async postAcceptedResultCopy(binding, canonicalRequest, { signal } = {}) {
    if(!binding||binding.environment!==this.environment||!ID.test(binding.jobId||'')||typeof canonicalRequest!=='string'
        ||!canonicalRequest.length||Buffer.byteLength(canonicalRequest)>16*1024*1024)fail('source_intake_copy_request_invalid');
    const response=await this.request(`/ltds/v1/jobs/${encodeURIComponent(binding.jobId)}/acceptance`,
      {method:'POST',body:canonicalRequest,signal});
    if(![200,201].includes(response.status)){
      await response.body?.cancel().catch(()=>{});
      if(response.status>=500||response.status===408||response.status===429)fail('source_intake_copy_post_uncertain');
      fail('source_intake_copy_post_rejected');
    }
    return boundedJson(response,MAX_SOURCE_INTAKE_V2_METADATA_BYTES,MAX_SOURCE_INTAKE_V2_CANONICAL_NODES);
  }

  async createOrReplay(intent, { localJobId, owner, capabilityFingerprint, signal } = {}) {
    const saved = this.outbox.assertCurrentLease({ attemptId: intent?.viewerAttemptId, localJobId, owner });
    if (!saved || !saved.sourceIntakeCanonical || saved.sourceIntakeCanonical !== intent.sourceIntakeCanonical)
      fail('source_intake_outbox_state_invalid');
    const request = JSON.parse(saved.sourceIntakeCanonical);
    if (saved.state === 'accepted') return validatePersistedReceivingBinding(saved, request, { environment: this.environment });
    if (saved.state !== 'prepared') fail('source_intake_outbox_state_invalid');
    const found = await this.findBySubmission(request.submissionId, { signal });
    if (found) {
      const binding = validateReceivingBinding(found, request, { environment: this.environment });
      const accepted = this.outbox.acceptSourceIntakeBinding(intent.viewerAttemptId, binding, {
        environment: this.environment, localJobId, owner,
      });
      return validatePersistedReceivingBinding(accepted, request, { environment: this.environment });
    }
    if (!capabilityFingerprint) {
      const current = await this.getCapabilities({ signal });
      if (current.capabilities.environment !== this.environment
          || current.sourceIntake.maxObjects > ReferenceProtocol.LIMITS.objects)
        fail('source_intake_capabilities_invalid');
      capabilityFingerprint = current.capabilities.capabilityFingerprint;
    }
    const envelope = JSON.parse(saved.envelopeCanonical);
    if (envelope.submission.capabilityFingerprint !== capabilityFingerprint)
      fail('source_intake_capabilities_changed');
    const response = await this.request('/ltds/v2/jobs', { method: 'POST', body: saved.sourceIntakeCanonical, signal });
    if (![200, 201].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 500 || response.status === 408 || response.status === 429) fail('source_intake_post_uncertain');
      fail('source_intake_post_rejected');
    }
    const body = await boundedJson(response);
    const binding = validateReceivingBinding(body, request, { environment: this.environment });
    const accepted = this.outbox.acceptSourceIntakeBinding(intent.viewerAttemptId, binding, {
      environment: this.environment, localJobId, owner,
    });
    return validatePersistedReceivingBinding(accepted, request, { environment: this.environment });
  }

  async uploadObject({ jobId, generation, object, openStream, signal } = {}) {
    if (!object || typeof object.id !== 'string' || !Number.isSafeInteger(object.byteSize) || object.byteSize < 0
        || !/^[a-f0-9]{64}$/.test(object.sha256) || typeof openStream !== 'function'
        || !Number.isSafeInteger(generation) || generation < 1) fail('source_intake_object_invalid');
    const stream = await openStream();
    if (!stream || typeof stream.pipe !== 'function') fail('source_intake_stream_invalid');
    const url = `/ltds/v2/jobs/${encodeURIComponent(jobId)}/source/${encodeURIComponent(object.id)}?generation=${generation}`;
    const deadline = AbortSignal.timeout(this.transferTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      response = await this.fetch(`${this.origin}${url}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.bearerToken}`,
          'Content-Length': String(object.byteSize),
          'Content-SHA256': object.sha256,
          'Content-Type': 'application/octet-stream',
        },
        body: stream, duplex: 'half', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: requestSignal,
      });
    } catch {
      stream.destroy?.();
      fail('source_intake_upload_uncertain');
    }
    if (response.redirected || response.url && new URL(response.url).origin !== this.origin) {
      await response.body?.cancel().catch(() => {});
      fail('source_intake_redirect_rejected');
    }
    await response.body?.cancel().catch(() => {});
    if (![200, 201].includes(response.status)) fail(response.status === 507 ? 'source_intake_capacity_unavailable'
      : response.status >= 500 ? 'source_intake_upload_uncertain' : 'source_intake_upload_rejected');
    return { objectId: object.id, status: response.status };
  }

  async uploadClosure({ binding, manifests, openSourceStream, derivedBytes, localJobId, owner, signal } = {}) {
    if (!binding || binding.environment !== this.environment || typeof openSourceStream !== 'function'
        || !(derivedBytes instanceof Map) || !Array.isArray(manifests?.sourceManifest?.objects)
        || !Array.isArray(manifests?.derivedManifest?.objects)
        || manifests.sourceManifest.objects.length > MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS
        || manifests.derivedManifest.objects.length > MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS)
      fail('source_intake_closure_invalid');
    const allIds = new Set();
    for (const object of manifests.sourceManifest.objects) {
      if (!object || allIds.has(object.id)) fail('source_intake_closure_invalid');
      allIds.add(object.id);
    }
    for (const object of manifests.derivedManifest.objects) {
      if (!object || allIds.has(object.id)) fail('source_intake_closure_invalid');
      allIds.add(object.id);
    }
    // On retry/restart, resume only after the remote ACK list has been
    // checked against the immutable local manifests and this exact generation.
    const status = await this.getJob(binding.jobId, { signal });
    const acknowledged = acknowledgedObjects(status, binding, manifests);
    // Deliberately send one stream at a time: source intake can include many
    // large images, and neither Viewer nor this coordinator needs them buffered.
    for (const object of manifests.sourceManifest.objects) {
      if (acknowledged.has(object.id)) continue;
      await this.uploadObject({ jobId: binding.jobId, generation: binding.generation, object,
        openStream: () => openSourceStream(object), signal });
    }
    for (const object of manifests.derivedManifest.objects) {
      const bytes = derivedBytes.get(object.id);
      if (!Buffer.isBuffer(bytes) || bytes.length !== object.byteSize
          || require('node:crypto').createHash('sha256').update(bytes).digest('hex') !== object.sha256)
        fail('source_intake_derived_bytes_mismatch');
      if (!acknowledged.has(object.id)) await this.uploadObject({ jobId: binding.jobId, generation: binding.generation, object,
        openStream: async () => Readable.from([bytes]), signal });
    }
    if (derivedBytes.size !== manifests.derivedManifest.objects.length) fail('source_intake_derived_inventory_mismatch');
    return this.complete(binding, manifests, { localJobId, owner, signal });
  }

  async complete(binding, manifests, { signal, localJobId, owner } = {}) {
    const body = {
      generation: binding.generation,
      sourceManifestSha256: manifests.sourceManifestSha256,
      derivedManifestSha256: manifests.derivedManifestSha256,
      pipelineManifestSha256: manifests.pipelineManifestSha256,
    };
    const response = await this.request(`/ltds/v2/jobs/${encodeURIComponent(binding.jobId)}/source/complete`, {
      method: 'POST', body: canonicalizeJcs(body, { maxBytes: MAX_BODY_BYTES }).toString('utf8'), signal,
    });
    if (![200, 201].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 500 || response.status === 408 || response.status === 429) fail('source_intake_completion_uncertain');
      fail('source_intake_completion_rejected');
    }
    const verified = validateCompletionReceipt(await boundedJson(response, MAX_COMPLETION_RESPONSE_BYTES,
      MAX_SOURCE_INTAKE_V2_CANONICAL_NODES), binding, manifests);
    if (typeof this.outbox.persistSourceIntakeCompletion !== 'function') fail('source_intake_completion_store_unavailable');
    const compactCompletion = { ...verified };
    delete compactCompletion.sourceObjectReceipts;
    delete compactCompletion.derivedObjectReceipts;
    return this.outbox.persistSourceIntakeCompletion(binding.attemptId, compactCompletion, {
      environment: this.environment, localJobId, owner,
    });
  }
}

module.exports = {
  MAX_COMPLETION_RESPONSE_BYTES,
  MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
  MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS,
  SourceIntakeClientV2,
  acknowledgedObjects,
  validateCompletionReceipt,
  validateReceivingBinding,
};
