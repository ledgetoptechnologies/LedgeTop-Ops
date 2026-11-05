'use strict';

const crypto = require('node:crypto');
const { canonical, digest, validateReleaseStatus } = require('./sourceReleaseContractV1');

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

function validateOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { fail('source_release_origin_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash) fail('source_release_origin_invalid');
  return parsed.origin;
}

async function boundedJson(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail('source_release_response_too_large');
  const reader = response.body?.getReader?.();
  if (!reader) fail('source_release_response_invalid');
  const chunks = [];
  let total = 0, bytes;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('source_release_response_invalid');
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail('source_release_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
    bytes = Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error?.code?.startsWith('source_release_')) throw error;
    fail('source_release_response_invalid');
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  try {
    const result = JSON.parse(bytes.toString('utf8'));
    if (!result || Object.getPrototypeOf(result) !== Object.prototype) fail('source_release_response_invalid');
    canonical(result, MAX_RESPONSE_BYTES);
    return result;
  } catch (error) {
    if (error?.code?.startsWith('source_release_')) throw error;
    fail('source_release_response_invalid');
  }
}

function validateObservation(value, binding) {
  const fields = ['schemaVersion', 'protocol', 'coordinatorAuthorityId', 'jobId', 'generation', 'observationId',
    'requestSha256', 'nodeId', 'workerId', 'workerInstanceId', 'observedAt', 'ackSha256'];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')
      || value.schemaVersion !== 1 || value.protocol !== 'ltds-worker-acceptance-observed-ack-v1'
      || value.coordinatorAuthorityId !== binding.coordinatorAuthorityId || value.jobId !== binding.jobId
      || value.generation !== binding.generation || !UUID.test(value.observationId || '')
      || !HASH.test(value.requestSha256 || '') || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.nodeId || '')
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.workerId || '')
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.workerInstanceId || '')
      || typeof value.observedAt !== 'string' || !value.observedAt.endsWith('Z') || !HASH.test(value.ackSha256 || ''))
    fail('source_release_observation_binding_mismatch');
  const { ackSha256, ...body } = value;
  if (digest(body) !== ackSha256) fail('source_release_observation_digest_mismatch');
  canonical(value);
  return value;
}

class SourceReleaseClientV1 {
  constructor({ origin, bearerToken, environment, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (typeof fetchImpl !== 'function' || !['production', 'staging'].includes(environment)
        || typeof bearerToken !== 'string' || bearerToken.length < 16 || bearerToken.length > 4096
        || /[^\x21-\x7e]/.test(bearerToken)) fail('source_release_client_invalid');
    this.origin = validateOrigin(origin);
    this.bearerToken = bearerToken;
    this.environment = environment;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method, body, signal } = {}) {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      response = await this.fetch(`${this.origin}${path}`, {
        method, headers: { Authorization: `Bearer ${this.bearerToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}), redirect: 'error', cache: 'no-store', credentials: 'omit', signal: requestSignal,
      });
    } catch { fail('source_release_transport_uncertain'); }
    if (response.redirected || response.url && new URL(response.url).origin !== this.origin) {
      await response.body?.cancel().catch(() => {});
      fail('source_release_redirect_rejected');
    }
    return response;
  }

  async acceptanceObservation(binding, { signal } = {}) {
    if (!binding || !ID.test(binding.jobId || '') || !SLUG.test(binding.coordinatorAuthorityId || '')
        || !Number.isSafeInteger(binding.generation) || binding.generation < 1 || binding.environment !== this.environment)
      fail('source_release_binding_invalid');
    const response = await this.request(`/ltds/v2/jobs/${encodeURIComponent(binding.jobId)}/source/acceptance-observation`, { method: 'GET', signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      fail(response.status === 404 ? 'source_release_observation_pending'
        : response.status >= 500 ? 'source_release_observation_unavailable' : 'source_release_observation_rejected');
    }
    return validateObservation(await boundedJson(response), binding);
  }

  async submit(jobId, canonicalRequest, binding, { signal } = {}) {
    if (!ID.test(jobId || '') || typeof canonicalRequest !== 'string' || !canonicalRequest
        || Buffer.byteLength(canonicalRequest, 'utf8') > MAX_RESPONSE_BYTES) fail('source_release_request_invalid');
    const response = await this.request(`/ltds/v2/jobs/${encodeURIComponent(jobId)}/source/releases`, {
      method: 'POST', body: canonicalRequest, signal,
    });
    if (![200, 201].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (response.status >= 500 || response.status === 408 || response.status === 429)
        fail('source_release_post_uncertain');
      fail('source_release_post_rejected');
    }
    return validateReleaseStatus(await boundedJson(response), binding);
  }

  async status(binding, { signal } = {}) {
    if (!binding || !ID.test(binding.jobId || '') || !UUID.test(binding.coordinatorAuthorityId || '')
        || !UUID.test(binding.releaseId || '') || !Number.isSafeInteger(binding.generation) || binding.generation < 1
        || !HASH.test(binding.authorizationSha256 || '') || binding.environment !== this.environment)
      fail('source_release_binding_invalid');
    const response = await this.request(`/ltds/v2/jobs/${encodeURIComponent(binding.jobId)}/source/releases/${encodeURIComponent(binding.releaseId)}`, { method: 'GET', signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      fail(response.status === 404 ? 'source_release_status_not_found'
        : response.status >= 500 ? 'source_release_status_unavailable' : 'source_release_status_rejected');
    }
    return validateReleaseStatus(await boundedJson(response), binding);
  }
}

module.exports = { MAX_RESPONSE_BYTES, SourceReleaseClientV1, boundedJson, validateObservation };
