'use strict';

// Opt-in reference transport. No provider URL, bearer, or upstream body is put
// in an error. All routes are constructed locally from validated identifiers.
const { createHash } = require('node:crypto');
const p = require('./referenceProtocol');
const {validateReferenceOptions,decodeOptionsWire}=require('./referenceOptions');
const { createEndpointCaFetch } = require('./referenceCaTransport');
class ReferenceProviderError extends Error {
  constructor(code) { super(code); this.name = 'ReferenceProviderError'; this.code = code; }
}
const fail = code => { throw new ReferenceProviderError(code); };
const slug = v => { if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)) fail('INVALID_IDENTIFIER'); return v; };
const hash = v => { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('INVALID_RESPONSE'); };
const integer = v => { if (!Number.isSafeInteger(v) || v < 0 || Object.is(v, -0)) fail('INVALID_RESPONSE'); };
function closed(v, keys) { if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))) fail('INVALID_RESPONSE'); }
function bounded(v, depth = 0) {
  if (depth > 32) fail('METADATA_LIMIT');
  if (Array.isArray(v)) { if (v.length > p.LIMITS.objects) fail('METADATA_LIMIT'); v.forEach(x => bounded(x,depth+1)); }
  else if (v && typeof v === 'object') { if (Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length > p.LIMITS.objects) fail('INVALID_RESPONSE'); for (const [k,x] of Object.entries(v)) { if (['__proto__','prototype','constructor'].includes(k)) fail('INVALID_RESPONSE'); bounded(x,depth+1); } }
}
function safeValidate(fn) { try { return fn(); } catch (e) { if (e instanceof ReferenceProviderError) throw e; if (e instanceof p.ReferenceProtocolError) fail(e.code); fail('INVALID_RESPONSE'); } }
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
function binding(actual, expected, keys) { for (const key of keys) if (!equal(actual[key],expected[key])) fail('BINDING_MISMATCH'); }
function noLocalPaths(v) {
  if (typeof v === 'string' && /^(?:[A-Za-z]:[\\/]|\\\\|\/|(?:file|smb):)/i.test(v)) fail('INVALID_REQUEST');
  if (Array.isArray(v)) v.forEach(noLocalPaths);
  else if (v && typeof v === 'object') Object.values(v).forEach(noLocalPaths);
}
function transferRequest(v) {
  closed(v,['reservationId','generation','expiresAt','manifestSha256','byteBudget','nonce']);
  slug(v.reservationId); slug(v.nonce); integer(v.generation); integer(v.byteBudget); hash(v.manifestSha256);
  if (typeof v.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.expiresAt) || !Number.isFinite(Date.parse(v.expiresAt)) || new Date(v.expiresAt).toISOString() !== v.expiresAt) fail('INVALID_RESPONSE');
  // Expiry blocks using a grant, never reading status for reconciliation.
}
function ack(v, expected) {
  closed(v,['reservationId','generation','manifestSha256','nonce','accepted']); slug(v.reservationId); slug(v.nonce); integer(v.generation); hash(v.manifestSha256);
  if (v.accepted !== true) fail('INVALID_RESPONSE');
  binding(v,expected,['reservationId','generation','manifestSha256','nonce']); return v;
}
class ReferenceProvider {
  #endpoint; #token; #environment; #enabled; #fetch; #jobs = new Map(); #manifests = new Map(); #submissions = new Map();
  constructor({ endpoint, token, environment, enabled = false, fetchImpl, privateCaPem, timeoutMs = 30000, transferTimeoutMs = 300000, maxObjectBytes = p.LIMITS.metadataBytes } = {}) {
    let url; try { url = new URL(endpoint); } catch { fail('INVALID_ENDPOINT'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^https:\/\/[^/?#\s\\]+\/?$/.test(endpoint)) fail('INVALID_ENDPOINT');
    if (!['production','staging'].includes(environment)) fail('INVALID_ENVIRONMENT');
    if (privateCaPem !== undefined && fetchImpl !== undefined) fail('INVALID_CONFIGURATION');
    if (typeof enabled !== 'boolean' || (fetchImpl !== undefined && typeof fetchImpl !== 'function') || typeof token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(token)) fail('INVALID_CONFIGURATION');
    for (const n of [timeoutMs,transferTimeoutMs,maxObjectBytes]) if (!Number.isSafeInteger(n) || n < 1) fail('INVALID_CONFIGURATION');
    if (timeoutMs > 4294967295 || transferTimeoutMs > 4294967295) fail('INVALID_CONFIGURATION');
    let transport = fetchImpl ?? fetch;
    if (privateCaPem !== undefined) {
      try { transport = createEndpointCaFetch({ origin: url.origin, caPem: privateCaPem, timeoutMs: Math.min(Math.max(timeoutMs, transferTimeoutMs), 2147483647) }); }
      catch { fail('INVALID_CONFIGURATION'); }
    }
    this.#endpoint = url.origin; this.#token = token; this.#environment = environment; this.#enabled = enabled; this.#fetch = transport;
    this.timeoutMs = timeoutMs; this.transferTimeoutMs = transferTimeoutMs; this.maxObjectBytes = maxObjectBytes;
  }
  #check() { if (!this.#enabled) fail('PROVIDER_DISABLED'); }
  #environmentCheck(v) { if (v.environment !== this.#environment) fail('BINDING_MISMATCH'); }
  #signal(signal, binary) { return signal ? AbortSignal.any([signal,AbortSignal.timeout(binary ? this.transferTimeoutMs : this.timeoutMs)]) : AbortSignal.timeout(binary ? this.transferTimeoutMs : this.timeoutMs); }
  async #request(route, {method = 'GET', body, signal, binary = false, mediaType = 'application/octet-stream'} = {}) {
    this.#check();
    let encoded;
    if (body !== undefined) { bounded(body); try { encoded = JSON.stringify(body); } catch { fail('INVALID_REQUEST'); } if (Buffer.byteLength(encoded) > p.LIMITS.metadataBytes) fail('METADATA_LIMIT'); }
    const combined = this.#signal(signal,binary);
    // Native fetch retains normal public HTTPS trust. An optional owner-provided
    // private CA is isolated to this exact endpoint; redirects never forward
    // credentials. Neither choice accepts transport options from request DTOs.
    let response;
    try { response = await this.#fetch(this.#endpoint + p.PREFIX + route,{method,headers:{Authorization:'Bearer ' + this.#token,Accept:binary ? mediaType : 'application/json',...(encoded === undefined ? {} : {'Content-Type':'application/json'})},body:encoded,redirect:'error',signal:combined}); }
    catch { fail(method === 'POST' ? 'UNCERTAIN' : combined.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR'); }
    if (response.redirected || !((method === 'POST' && route === '/jobs') ? [200,201] : [200]).includes(response.status)) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      if (response.redirected || response.status >= 300 && response.status < 400) fail('REDIRECT_REJECTED');
      fail(({401:'UNAUTHORIZED',403:'FORBIDDEN',404:'NOT_FOUND',409:'CONFLICT'})[response.status] || (method === 'POST' && response.status >= 500 ? 'UNCERTAIN' : 'HTTP_ERROR'));
    }
    const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (mime !== (binary ? mediaType : 'application/json')) { try { await response.body?.cancel(); } catch {} fail('INVALID_CONTENT_TYPE'); }
    const length = response.headers.get('content-length');
    const limit = binary ? this.maxObjectBytes : p.LIMITS.metadataBytes;
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) { try { await response.body?.cancel(); } catch {} fail('BODY_LIMIT'); }
    return {response,signal:combined,method};
  }
  async *#chunks(transport, limit) {
    const {response,signal,method} = transport;
    if (!response.body || typeof response.body.getReader !== 'function') fail('INVALID_RESPONSE');
    const reader = response.body.getReader(); let total = 0, complete = false;
    const aborted = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort',aborted,{once:true});
    try {
      if (signal.aborted) fail(method === 'POST' ? 'UNCERTAIN' : 'TIMEOUT');
      for (;;) {
        let part; try { part = await reader.read(); } catch { fail(method === 'POST' ? 'UNCERTAIN' : signal.aborted ? 'TIMEOUT' : 'TRANSPORT_ERROR'); }
        if (signal.aborted) fail(method === 'POST' ? 'UNCERTAIN' : 'TIMEOUT');
        if (part.done) { complete = true; break; }
        total += part.value.byteLength; if (total > limit) fail('BODY_LIMIT');
        yield Buffer.from(part.value);
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) !== total) fail(method === 'POST' ? 'UNCERTAIN' : 'INVALID_RESPONSE');
    } finally { signal.removeEventListener('abort',aborted); if (!complete) { try { await reader.cancel(); } catch {} } reader.releaseLock(); }
  }
  async #json(route, options) {
    const transport = await this.#request(route,options), chunks = [];
    for await (const chunk of this.#chunks(transport,p.LIMITS.metadataBytes)) chunks.push(chunk);
    let value; try { const bytes=Buffer.concat(chunks); value = ['/options','/capabilities'].includes(route) ? decodeOptionsWire(bytes) : JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { fail(transport.method === 'POST' ? 'UNCERTAIN' : 'INVALID_RESPONSE'); }
    bounded(value);const reflectsToken=v=>typeof v==='string'?v.includes(this.#token):Array.isArray(v)?v.some(reflectsToken):Boolean(v&&typeof v==='object'&&Object.entries(v).some(([k,x])=>k.includes(this.#token)||reflectsToken(x)));if(reflectsToken(value))fail('INVALID_RESPONSE');return value;
  }
  #job(job, expected = {}) {
    closed(job,['jobId','generation','environment','phase','manifestSha256','pipelineDigest','status','nodeId','transferRequest','transferGrantAcknowledgement','error','resultManifestSha256']);
    slug(job.jobId); integer(job.generation); if (job.generation < 1) fail('INVALID_RESPONSE'); this.#environmentCheck(job); hash(job.manifestSha256); hash(job.pipelineDigest);
    if (!['queued','waiting_capacity','awaiting_transfer','fetching','processing','waiting_for_delivery','awaiting_acceptance','held','completed','cancelled'].includes(job.phase) || !['queued','running','held','succeeded','failed','cancelled'].includes(job.status)) fail('INVALID_RESPONSE');
    if (job.nodeId !== null) slug(job.nodeId);
    if (job.error !== null && (typeof job.error !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(job.error))) fail('INVALID_RESPONSE');
    if (job.resultManifestSha256 !== null) hash(job.resultManifestSha256);
    for (const key of ['jobId','generation','environment','manifestSha256','inputManifestSha256','pipelineDigest','resultManifestSha256']) if (Object.hasOwn(expected,key)) { const actualKey = key === 'inputManifestSha256' ? 'manifestSha256' : key; if (!equal(job[actualKey],expected[key])) fail('BINDING_MISMATCH'); }
    if (job.transferRequest !== null) { transferRequest(job.transferRequest); binding(job.transferRequest,job,['generation','manifestSha256']); }
    if (job.transferGrantAcknowledgement !== null) { if (!job.transferRequest) fail('BINDING_MISMATCH'); ack(job.transferGrantAcknowledgement,job.transferRequest); }
    const previous = this.#jobs.get(job.jobId);
    if (previous) {
      binding(job,previous,['jobId','generation','environment','manifestSha256','pipelineDigest']);
      if (previous.resultManifestSha256 !== null) binding(job,previous,['resultManifestSha256']);
      if (previous.transferRequest !== null) binding(job,previous,['transferRequest']);
    }
    const submission = this.#submissions.get(job.jobId);
    if (submission && job.transferRequest) safeValidate(() => p.validateTransferByteBudget(submission.manifest.totalBytes,job.transferRequest.byteBudget));
    this.#jobs.set(job.jobId,structuredClone(job)); return job;
  }
  #checkExpected(jobId, expected) {
    if (jobId !== null) slug(jobId);
    if (!expected) return;
    const known = jobId === null ? null : this.#jobs.get(jobId), manifest = jobId === null ? null : this.#manifests.get(jobId);
    if (expected.jobId !== undefined) { slug(expected.jobId); if (jobId !== null && expected.jobId !== jobId) fail('BINDING_MISMATCH'); }
    if (expected.environment !== undefined && expected.environment !== this.#environment) fail('BINDING_MISMATCH');
    for (const key of ['pipelineDigest','manifestSha256','inputManifestSha256','resultManifestSha256']) if (Object.hasOwn(expected,key) && !(key === 'resultManifestSha256' && expected[key] === null)) hash(expected[key]);
    if (Object.hasOwn(expected,'generation')) { integer(expected.generation); if (expected.generation < 1) fail('BINDING_MISMATCH'); }
    if (known) for (const key of ['jobId','generation','pipelineDigest','manifestSha256']) if (Object.hasOwn(expected,key)) binding(known,expected,[key]);
    if (known && expected.inputManifestSha256 !== undefined && expected.inputManifestSha256 !== known.manifestSha256) fail('BINDING_MISMATCH');
    if (expected.inputManifestSha256 !== undefined && expected.manifestSha256 !== undefined && expected.inputManifestSha256 !== expected.manifestSha256) fail('BINDING_MISMATCH');
    if (Object.hasOwn(expected,'resultManifestSha256')) {
      if (manifest) binding(manifest,expected,['resultManifestSha256']);
      if (known?.resultManifestSha256 != null) binding(known,expected,['resultManifestSha256']);
    }
  }
  #expected(jobId, expected) {
    this.#checkExpected(jobId,expected);
    slug(jobId); const known = this.#jobs.get(jobId);
    if (!known && !expected) fail('BINDING_REQUIRED');
    const v = {...known,...expected,jobId,environment:this.#environment};
    integer(v.generation); hash(v.pipelineDigest); return v;
  }
  async capabilities({signal} = {}) {
    this.#check(); const value = await this.#json('/capabilities',{signal}); safeValidate(() => p.validateCapabilities(value)); this.#environmentCheck(value); return value;
  }
  // Runtime catalog is metadata only. Capabilities and options must agree;
  // stale/mixed observations fail closed and are never submitted.
  async options({signal} = {}) {
    this.#check(); const capabilities=await this.capabilities({signal});
    const value=await this.#json('/options',{signal});
    safeValidate(()=>validateReferenceOptions(value,capabilities));
    return structuredClone(value);
  }
  // Read-only lost-ACK reconciliation. The public job's opaque pipelineDigest
  // does not prove that original ODM options match a lost first submission.
  // If the original pipeline binding is unknown, the caller MUST confirm the
  // same immutable request via an explicit idempotent POST or an equivalent
  // bound receipt before any execution/grant. Lookup never performs that POST,
  // creates a new submission, rotates a grant, or authorizes execution itself.
  async lookupSubmission(submissionId, expectedBinding, {signal} = {}) {
    this.#check();
    if (typeof submissionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(submissionId)) fail('INVALID_IDENTIFIER');
    this.#checkExpected(expectedBinding?.jobId ?? null,expectedBinding);
    let value;
    try { value = await this.#json('/jobs/by-submission/' + submissionId,{signal}); }
    catch (error) { if (error instanceof ReferenceProviderError && error.code === 'NOT_FOUND') return null; throw error; }
    return this.#job(value,expectedBinding);
  }
  async submit(submission, {signal} = {}) {
    this.#check(); bounded(submission);
    // Snapshot before the first await so caller mutations cannot bypass preflight.
    try { submission = structuredClone(submission); } catch { fail('INVALID_REQUEST'); }
    noLocalPaths(submission);
    const capabilities = await this.capabilities({signal}); safeValidate(() => p.validateSubmission(submission,{capabilities}));
    const job = this.#job(await this.#json('/jobs',{method:'POST',body:submission,signal}),{manifestSha256:submission.manifest.sha256});
    this.#submissions.set(job.jobId,structuredClone(submission)); return job;
  }
  async status(jobId, expectedBinding, {signal} = {}) { this.#check(); this.#checkExpected(jobId,expectedBinding); return this.#job(await this.#json('/jobs/' + jobId,{signal}),{...expectedBinding,jobId}); }
  async results(jobId, expectedBinding, {signal} = {}) {
    this.#check(); const expected = this.#expected(jobId,expectedBinding);
    const manifest = await this.#json('/jobs/' + jobId + '/results',{signal}); safeValidate(() => p.validateResultManifest(manifest,expected));
    if (expected.resultManifestSha256 != null) binding(manifest,expected,['resultManifestSha256']);
    const submission = this.#submissions.get(jobId);
    const engines = submission ? ['odm','treedar'].filter(k => submission.pipeline[k].requested) : expected.requestedEngines;
    if (!Array.isArray(engines) || !engines.length || new Set(engines).size !== engines.length || engines.some(k => !['odm','treedar'].includes(k))) fail('BINDING_REQUIRED');
    if (!equal(Object.keys(manifest.engineVersions).sort(),[...engines].sort())) fail('BINDING_MISMATCH');
    if (engines.includes('odm') && manifest.objects.filter(o => o.role === 'odm_archive' && o.byteSize > 0).length !== 1) fail('BINDING_MISMATCH');
    this.#manifests.set(jobId,structuredClone(manifest)); return manifest;
  }
  async postTransferGrant(jobId, grant, expectedBinding, {signal} = {}) {
    this.#check(); const expected = this.#expected(jobId,expectedBinding), job = this.#jobs.get(jobId);
    if (!job?.transferRequest) fail('BINDING_REQUIRED');
    const submission = this.#submissions.get(jobId);
    const grantBinding = {...job.transferRequest,jobId,generation:expected.generation,environment:this.#environment,objectIds:submission?.manifest.objects.map(o => o.id) ?? expected.objectIds};
    safeValidate(() => p.validateTransferGrant(grant,grantBinding));
    return ack(await this.#json('/jobs/' + jobId + '/transfer-grants',{method:'POST',body:grant,signal}),grant);
  }
  async acceptResult(jobId, receipt, expectedBinding, {signal} = {}) {
    this.#check(); const job = this.#expected(jobId,expectedBinding), manifest = this.#manifests.get(jobId);
    if (!manifest) fail('BINDING_REQUIRED');
    const expected = {...job,inputManifestSha256:job.manifestSha256 ?? job.inputManifestSha256,resultManifestSha256:manifest.resultManifestSha256,objectIds:manifest.objects.map(o => o.id)};
    // Keep the submitted receipt and its confirmation bound across network
    // awaits, even if a caller mutates its original object.
    try { receipt=structuredClone(receipt); } catch { fail('INVALID_REQUEST'); }
    safeValidate(() => p.validateAcceptance(receipt,expected));
    const receiptSha256=p.sha256(p.canonicalBytes(receipt));
    const value = await this.#json('/jobs/' + jobId + '/acceptance',{method:'POST',body:receipt,signal});
    // Older coordinators return only these fields; that form does not confirm
    // a receipt ID or digest and must not be treated as custody evidence.
    const keys=['job','created','fullyAccepted','acceptedObjectIds'];
    if (value && Object.hasOwn(value,'receiptId') && Object.hasOwn(value,'receiptSha256')) {
      closed(value,[...keys,'receiptId','receiptSha256']);
      if (value.receiptId!==receipt.receiptId || value.receiptSha256!==receiptSha256) fail('BINDING_MISMATCH');
    } else closed(value,keys);
    this.#job(value.job,expected);
    if (typeof value.created !== 'boolean' || typeof value.fullyAccepted !== 'boolean' || !Array.isArray(value.acceptedObjectIds) || new Set(value.acceptedObjectIds).size !== value.acceptedObjectIds.length || value.acceptedObjectIds.some(id => !expected.objectIds.includes(id)) || receipt.acceptedObjectIds.some(id => !value.acceptedObjectIds.includes(id)) || value.fullyAccepted !== expected.objectIds.every(id => value.acceptedObjectIds.includes(id)) || value.fullyAccepted !== (value.job.phase === 'completed')) fail('BINDING_MISMATCH');
    return value;
  }
  async downloadObject(jobId, objectId, {expectedBinding, maxBytes = this.maxObjectBytes, signal} = {}) {
    this.#check(); this.#expected(jobId,expectedBinding); slug(objectId);
    // Hold a single sealed snapshot across the network await: another results()
    // call may update the cached manifest while this download is in flight.
    const manifest = this.#manifests.get(jobId);
    const object = manifest?.objects.find(o => o.id === objectId);
    if (!object) fail('BINDING_REQUIRED');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > this.maxObjectBytes || object.byteSize > maxBytes) fail('BODY_LIMIT');
    const transport = await this.#request('/jobs/' + jobId + '/results/' + objectId,{binary:true,signal,mediaType:object.role === 'odm_archive' ? 'application/zip' : 'application/octet-stream'});
    if (transport.response.headers.get('x-result-sha256') !== object.sha256 || transport.response.headers.get('x-result-manifest-sha256') !== manifest.resultManifestSha256) {
      try { await transport.response.body?.cancel(); } catch {}
      fail('BINDING_MISMATCH');
    }
    const declared = transport.response.headers.get('content-length');
    if (declared !== String(object.byteSize)) { try { await transport.response.body?.cancel(); } catch {} fail('BINDING_MISMATCH'); }
    const source = this.#chunks(transport,Math.min(maxBytes,object.byteSize));
    return (async function* () {
      const digest = createHash('sha256'); let bytes = 0;
      for await (const chunk of source) { bytes += chunk.length; digest.update(chunk); yield chunk; }
      if (bytes !== object.byteSize || digest.digest('hex') !== object.sha256) fail('DIGEST_MISMATCH');
    })();
  }
}
module.exports = { ReferenceProvider, ReferenceProviderError };
