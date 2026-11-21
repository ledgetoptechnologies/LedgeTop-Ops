'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { downloadProviderArchive } = require('./providerArchiveTransport');
const { sanitizeLogMessage } = require('./processingSecurity');
const { stable } = require('../lod-converter-policy.cjs');

const STATUS = Object.freeze({ 10: 'queued_upstream', 20: 'running', 30: 'failed', 40: 'completed', 50: 'cancelled' });
const VIEWER_ACCEPTANCE_ACK = Object.freeze({ version: 1, transport: 'https', pathTemplate: '/task/{taskId}/viewer-acceptance' });
const PRODUCER_BINDING = Object.freeze({ version: 1, transport: 'https', pathTemplate: '/task/{taskId}/producer-binding' });

async function boundedText(response,maxBytes) { const reader=response.body.getReader();const chunks=[];let total=0;try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel('provider response exceeds size limit');throw new Error('provider response exceeds size limit');}chunks.push(value);}}finally{reader.releaseLock();}return Buffer.concat(chunks.map((c)=>Buffer.from(c))).toString('utf8'); }
async function boundedJson(response,maxBytes=1024*1024){if(!String(response.headers.get('content-type')||'').includes('json'))throw new Error('provider returned an unexpected content type');return JSON.parse(await boundedText(response,maxBytes));}

function checkedAction(value, action, uuid=null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(`ODM ${action} returned an invalid response`), {code:'provider_request_failed'});
  if (Object.hasOwn(value,'error') || value.success === false) {
    const detail=typeof value.error==='string'?sanitizeLogMessage(value.error).slice(0,1000):'The provider rejected the request';
    throw Object.assign(new Error(`ODM ${action} failed: ${detail}`), {code:'provider_request_failed'});
  }
  if(uuid && Object.hasOwn(value,'uuid') && value.uuid!==uuid)throw Object.assign(new Error(`ODM ${action} returned a different task UUID`),{code:'provider_request_failed'});
  return value;
}

function optionArray(options) {
  return Object.entries(options || {}).map(([name, value]) => ({ name, value }));
}
function typedDefault(type,value){if(type==='bool'&&typeof value==='string')return value.toLowerCase()==='true';if(type==='int'){const n=Number(value);return Number.isInteger(n)?n:value;}if(type==='float'){const n=Number(value);return Number.isFinite(n)?n:value;}return value;}

function providerCapabilityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function detectProviderType(info) {
  const validInfo = info && typeof info === 'object' && !Array.isArray(info)
    && typeof info.version === 'string' && /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.test(info.version)
    && typeof info.engine === 'string' && info.engine.length > 0 && info.engine.length <= 120
    && typeof info.engineVersion === 'string' && info.engineVersion.length > 0 && info.engineVersion.length <= 120
    && Number.isSafeInteger(info.taskQueueCount) && info.taskQueueCount >= 0
    && Object.hasOwn(info, 'maxImages') && (info.maxImages === null || (Number.isSafeInteger(info.maxImages) && info.maxImages >= 1));
  if (!validInfo) throw providerCapabilityError('provider_probe_unsupported', 'Endpoint does not expose the supported NodeODM capability schema.');

  // ClusterODM's official proxy deliberately reports these three sentinel
  // resource values from /info. Combined with its 1.x API line this is
  // positive proxy evidence, not a guess based only on a version number.
  const clusterSentinel = info.totalMemory === 99999999999
    && info.availableMemory === 99999999999
    && info.cpuCores === 99999999999;
  if (/^1\./.test(info.version) && clusterSentinel) return 'clusterodm';
  if (/^2\./.test(info.version) && !clusterSentinel) return 'nodeodm';
  throw providerCapabilityError('provider_probe_ambiguous', 'The endpoint is NodeODM-compatible, but its engine type cannot be identified safely.');
}

// Only failures observed at the result HTTP boundary may become delivery waits.
// A generic TypeError, invalid ZIP, local disk error, or TLS trust failure is not
// evidence of a transient result transfer. Caller cancellation stays authoritative.
function resultTransferError(error, { signal = null, timeoutSignal = null } = {}) {
  if (signal?.aborted || error?.code === 'lease_lost') return error;
  const timeoutAbort = timeoutSignal?.aborted && (error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
  if (!timeoutAbort && (error?.name === 'AbortError' || error?.code === 'ABORT_ERR')) return error;
  const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
    'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH']);
  const retryableHttp = error?.code === 'provider_request_failed' && [408, 429, 500, 502, 503, 504].includes(error.status);
  let transport = false, current = error; const seen = new Set();
  for (let depth = 0; current && depth < 4 && !seen.has(current); depth++, current = current.cause) {
    seen.add(current);
    if (networkCodes.has(current.code) || current.name === 'TimeoutError') transport = true;
  }
  if (!retryableHttp && !transport && !timeoutAbort) return error;
  return Object.assign(new Error('Provider result transfer is temporarily unavailable; delivery will retry'), { code: 'provider_result_transfer_unavailable' });
}

function resultResponse(response, signal, timeoutSignal) {
  if (!response.body) return response;
  const reader = response.body.getReader(); let released = false;
  const release = () => { if (!released) { released = true; reader.releaseLock(); } };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { release(); controller.close(); } else controller.enqueue(value);
      } catch (error) { release(); controller.error(resultTransferError(error, { signal, timeoutSignal })); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

class NodeOdmProvider {
  constructor({ endpoint, token = '', fetchImpl = fetch, archiveDownloadImpl = downloadProviderArchive, timeoutMs = 30000, transferTimeoutMs = 6*3600_000, providerType = null }) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid provider endpoint');
    this.endpoint = url.toString().replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.archiveDownload = archiveDownloadImpl;
    this.timeoutMs = timeoutMs;
    this.transferTimeoutMs = transferTimeoutMs;
    this.providerType = providerType;
  }

  url(route, query = {}) {
    const result = new URL(`${this.endpoint}${route}`);
    if (this.token) result.searchParams.set('token', this.token);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) result.searchParams.set(key, String(value));
    return result;
  }

  async request(route, init = {}, query = {}, { timeoutMs=this.timeoutMs, signal=null, timeoutSignal=null } = {}) {
    const timeout=timeoutSignal||AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([timeout,signal]):timeout;
    const response = await this.fetch(this.url(route, query), { ...init, redirect:'error', signal:combined });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      const error = new Error(`ODM request failed with HTTP ${response.status}`);
      error.code = response.status === 404 ? 'provider_task_not_found' : 'provider_request_failed';
      error.status = response.status; throw error;
    }
    return response;
  }

  async capabilities() {
    const [infoResponse, optionsResponse] = await Promise.all([this.request('/info'), this.request('/options')]);
    if (!String(infoResponse.headers.get('content-type')||'').includes('json') || !String(optionsResponse.headers.get('content-type')||'').includes('json')) throw new Error('provider returned an unexpected content type');
    const info = JSON.parse(await boundedText(infoResponse,1024*1024)); const options = JSON.parse(await boundedText(optionsResponse,4*1024*1024));
    if (!Array.isArray(options)) throw providerCapabilityError('provider_probe_unsupported', 'Endpoint returned an incompatible processing-options response.');
    const detectedType = detectProviderType(info);
    if (this.providerType && detectedType !== this.providerType) throw providerCapabilityError('provider_type_mismatch', 'The detected provider engine no longer matches the configured engine type.');
    const normalizedOptions = options.slice(0,1000).map((item) => {const type=String(item.type||'string');return { name:String(item.name).slice(0,120),type,domain:item.domain??null,help:String(item.help||'').slice(0,4000),value:typedDefault(type,item.value),rawDefault:item.value };});
    const endpoint = new URL(this.endpoint);
    const advertisedAck = info.viewerAcceptanceAck;
    const viewerAcceptanceAck = endpoint.protocol === 'https:' && !endpoint.search && !endpoint.hash
      && advertisedAck && typeof advertisedAck === 'object' && !Array.isArray(advertisedAck)
      && advertisedAck.version === VIEWER_ACCEPTANCE_ACK.version
      && advertisedAck.transport === VIEWER_ACCEPTANCE_ACK.transport
      && advertisedAck.pathTemplate === VIEWER_ACCEPTANCE_ACK.pathTemplate
      ? VIEWER_ACCEPTANCE_ACK : null;
    const capabilities = {
      apiVersion: info.version, engine: info.engine, engineVersion: info.engineVersion,
      maxImages: info.maxImages ?? null, maxParallelTasks: info.maxParallelTasks ?? null,
      taskQueueCount: Number(info.taskQueueCount || 0), totalMemory: info.totalMemory ?? null,
      availableMemory: info.availableMemory ?? null, cpuCores: info.cpuCores ?? null,
      providerType: detectedType, detectionMethod: 'capability-signature', options: normalizedOptions,
      ...(viewerAcceptanceAck?{viewerAcceptanceAck}:{}),
      ...(endpoint.protocol === 'https:' && !endpoint.search && !endpoint.hash
        && info.producerBinding?.version === 1 && info.producerBinding?.transport === 'https'
        && info.producerBinding?.pathTemplate === PRODUCER_BINDING.pathTemplate ? { producerBinding: PRODUCER_BINDING } : {}),
      testedBaseline: detectedType === 'clusterodm' ? '1.5.x' : '2.2.3',
      compatibilityWarning: null,
    };
    const compatibilityContract={apiVersion:capabilities.apiVersion,engine:capabilities.engine,engineVersion:capabilities.engineVersion,maxImages:capabilities.maxImages,maxParallelTasks:capabilities.maxParallelTasks,providerType:capabilities.providerType,...(capabilities.viewerAcceptanceAck?{viewerAcceptanceAck:capabilities.viewerAcceptanceAck}:{}),...(capabilities.producerBinding?{producerBinding:capabilities.producerBinding}:{}),options:capabilities.options};
    return { capabilities, fingerprint: crypto.createHash('sha256').update(JSON.stringify(compatibilityContract)).digest('hex') };
  }

  // Explicit read only. No caller invokes this automatically, and this mapping
  // is neither a signature, historical-incarnation proof nor fresh byte QA.
  async producerBinding(uuid, { environment, signal = null } = {}) {
    const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
      || !uuidPattern.test(uuid) || !['STAGING', 'PRODUCTION'].includes(environment)) {
      throw providerCapabilityError('producer_binding_unavailable', 'A scoped TLS producer binding is required.');
    }
    const response = await this.request(`/task/${uuid}/producer-binding`, {}, {}, { signal });
    let value;
    try { value = await boundedJson(response, 64 * 1024); }
    catch { throw providerCapabilityError('producer_binding_invalid', 'Provider returned an invalid producer binding.'); }
    const expectedKeys = ['schemaVersion','providerTaskId','producerGeneration','environment','jobId',
      'nativeTaskId','nodeId','archiveSha256','archiveEvidence','bindingSha256'].sort();
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')
      || value.schemaVersion !== 1 || value.providerTaskId !== uuid || value.environment !== environment
      || !Number.isSafeInteger(value.producerGeneration) || value.producerGeneration < 1
      || !uuidPattern.test(value.jobId) || !uuidPattern.test(value.nativeTaskId)
      || typeof value.nodeId !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(value.nodeId)
      || !/^[a-f0-9]{64}$/.test(value.archiveSha256 || '') || !/^[a-f0-9]{64}$/.test(value.bindingSha256 || '')
      || value.archiveEvidence !== 'producer-record-not-fresh-byte-verification') {
      throw providerCapabilityError('producer_binding_invalid', 'Provider returned an invalid producer binding.');
    }
    const { bindingSha256, ...body } = value;
    const actual = crypto.createHash('sha256').update('ltds-producer-binding-v1\0').update(stable(body)).digest('hex');
    if (actual !== bindingSha256) throw providerCapabilityError('producer_binding_invalid', 'Producer binding consistency check failed.');
    return value;
  }

  async initialize({ uuid, name, options, outputs }, { signal=null } = {}) {
    const body = new FormData();
    if (name) body.set('name', name);
    body.set('options', JSON.stringify(optionArray(options)));
    if (outputs) body.set('outputs', JSON.stringify(outputs));
    const response = await this.request('/task/new/init', { method:'POST', headers:{ 'set-uuid': uuid }, body }, {}, {signal});
    const result = checkedAction(await boundedJson(response),'initialize',uuid);
    if (!result.uuid || result.uuid !== uuid) throw new Error('provider did not honor the assigned task UUID');
    return result;
  }

  async upload(uuid, files, { signal=null } = {}) {
    const basenames = new Set();
    for (const file of files) { const name=path.basename(file.relativePath||file.absolutePath).toLowerCase(); if(basenames.has(name)) throw Object.assign(new Error('dataset contains duplicate source basenames'),{code:'duplicate_source_basename'}); basenames.add(name); }
    const body = new FormData();
    for (const file of files) {
      const blob = file.buffer == null ? await fs.openAsBlob(file.absolutePath) :
        new Blob([Buffer.from(file.buffer)], { type: 'text/plain' });
      body.append('images', blob, path.basename(file.relativePath || file.absolutePath));
    }
    return checkedAction(await boundedJson(await this.request(`/task/new/upload/${encodeURIComponent(uuid)}`, { method:'POST', body }, {}, {timeoutMs:this.transferTimeoutMs,signal})),'upload');
  }

  async commit(uuid,{signal=null}={}) { return checkedAction(await boundedJson(await this.request(`/task/new/commit/${encodeURIComponent(uuid)}`, { method:'POST' },{}, {signal})),'commit',uuid); }
  async status(uuid,{signal=null}={}) {
    const info = await boundedJson(await this.request(`/task/${encodeURIComponent(uuid)}/info`,{}, {}, {signal}),1024*1024);
    if (typeof info?.error === 'string') {
      const error = new Error('ODM task info request failed');
      error.code = /not found|no task table entry/i.test(info.error) ? 'provider_task_not_found' : 'provider_request_failed';
      throw error;
    }
    if (!info || info.uuid !== uuid || !info.status || !Number.isFinite(Number(info.status.code))) throw new Error('provider returned an incompatible task response');
    return { uuid:info.uuid, status:STATUS[Number(info.status?.code)] || 'unknown', statusCode:Number(info.status?.code),
      progress:Math.max(0,Math.min(1,Number(info.progress||0)/100)), imagesCount:info.imagesCount,
      ...Object.fromEntries(['engine','engineVersion'].filter(key=>typeof info[key]==='string'&&/^[A-Za-z0-9._+ -]{1,120}$/.test(info[key])).map(key=>[key,info[key]])) };
  }
  async output(uuid, fromLine = 0,{signal=null}={}) {
    if(!Number.isSafeInteger(fromLine)||fromLine<0)throw new Error('invalid provider output cursor');
    const value=await boundedJson(await this.request(`/task/${encodeURIComponent(uuid)}/output`, {}, { line:fromLine },{signal}),4*1024*1024);
    if(value&&typeof value==='object'&&!Array.isArray(value))checkedAction(value,'output');
    let lines;
    // NodeODM/NodeODX and ClusterODM return arrays. Preserve blank entries and
    // commas: the cursor counts provider records, not nonempty display lines.
    if(Array.isArray(value)&&value.every(line=>typeof line==='string'))lines=value;
    else if(typeof value==='string'){lines=value?value.split(/\r?\n/):[];if(lines.at(-1)==='')lines.pop();}
    else throw Object.assign(new Error('ODM output returned an invalid response'),{code:'provider_request_failed'});
    const nextLine=fromLine+lines.length;if(!Number.isSafeInteger(nextLine))throw new Error('provider output cursor overflow');
    return{lines,nextLine};
  }
  async cancel(uuid,{signal=null}={}) {
    const body = new URLSearchParams({ uuid });
    return checkedAction(await boundedJson(await this.request('/task/cancel', { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body },{}, {signal})),'cancel');
  }
  async remove(uuid,{signal=null}={}) { const body=new URLSearchParams({uuid});return checkedAction(await boundedJson(await this.request('/task/remove',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body},{},{signal})),'remove'); }
  async downloadAll(uuid,{signal=null}={}) {
    const timeoutSignal = AbortSignal.timeout(this.transferTimeoutMs);
    try {
      const combined = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
      const response = await this.archiveDownload(this.url(`/task/${encodeURIComponent(uuid)}/download/all.zip`), { signal:combined, timeoutMs:this.transferTimeoutMs, headersTimeoutMs:this.timeoutMs });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* best effort */ }
        throw Object.assign(new Error(`ODM request failed with HTTP ${response.status}`), {
          code:response.status === 404 ? 'provider_task_not_found' : 'provider_request_failed', status:response.status,
        });
      }
      return resultResponse(response, signal, timeoutSignal);
    } catch (error) { throw resultTransferError(error, { signal, timeoutSignal }); }
  }

  async postViewerAcceptance(payload,{signal=null}={}) {
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw providerCapabilityError('viewer_acceptance_tls_required', 'Viewer acceptance requires a clean HTTPS provider endpoint.');
    }
    const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
    const exactKeys=['archiveSha256','attemptId','eventId','ingestedAt','providerTaskId','resultModelId','resultModelVersionId'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).sort().join(',')!==exactKeys.join(',')
      || !uuid(payload.providerTaskId)||!uuid(payload.attemptId)||!uuid(payload.resultModelId)||!uuid(payload.resultModelVersionId)
      || payload.eventId!==`viewer-acceptance-${payload.attemptId}`||!/^[a-f0-9]{64}$/.test(payload.archiveSha256||'')
      || typeof payload.ingestedAt!=='string'||Number.isNaN(Date.parse(payload.ingestedAt))) {
      throw providerCapabilityError('viewer_acceptance_payload_invalid', 'Viewer acceptance payload identity is invalid.');
    }
    const route=`/task/${encodeURIComponent(payload.providerTaskId)}/viewer-acceptance`;
    const response=await this.request(route,{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':payload.eventId},body:JSON.stringify(payload)},{},{signal});
    let result;
    try { result=await boundedJson(response,64*1024); }
    catch { throw providerCapabilityError('invalid_ack_response', 'Provider returned an invalid Viewer acceptance response.'); }
    if ((response.status!==200&&response.status!==202)||!result||typeof result!=='object'||Array.isArray(result)
      || result.accepted!==true||result.eventId!==payload.eventId||typeof result.replayed!=='boolean'
      || (response.status===200&&!result.replayed)||(response.status===202&&result.replayed)) {
      throw providerCapabilityError('invalid_ack_response', 'Provider did not confirm the Viewer acceptance event.');
    }
    return result;
  }
}

module.exports = { NodeOdmProvider, STATUS, VIEWER_ACCEPTANCE_ACK, boundedJson, boundedText, optionArray, typedDefault, detectProviderType };
