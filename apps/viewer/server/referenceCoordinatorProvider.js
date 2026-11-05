'use strict';

const crypto = require('node:crypto');
const ReferenceProtocol = require('./referenceProtocol');
const { validateOrigin } = require('./preparedSubmissionOutbox');
const { typedDefault } = require('./nodeOdmProvider');

const HASH = /^[a-f0-9]{64}$/;
const ALLOWED_OPTION_KEYS = new Set(['name', 'type', 'domain', 'help', 'value']);
const MAX_RESPONSE_BYTES = 256 * 1024;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

async function cancelBody(response) { try { await response.body?.cancel(); } catch {} }

async function boundedJson(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await cancelBody(response);
    fail('reference_provider_response_too_large');
  }
  const reader = response.body?.getReader?.();
  if (!reader) { await cancelBody(response); fail('reference_provider_response_invalid'); }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail('reference_provider_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock?.(); }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { fail('reference_provider_response_invalid'); }
}

function isConfiguredCoordinatorId(id, source) {
  return Boolean(source?.providerId && id === source.providerId);
}

function isReferenceCoordinatorProvider(provider, source) {
  return isConfiguredCoordinatorId(provider?.id, source)
    || provider?.capabilities?.detectionMethod === 'pinned-reference-coordinator';
}

function validateOptionsResponse(body, capabilities) {
  if (!body || Object.getPrototypeOf(body) !== Object.prototype
      || body.schemaVersion !== 1 || body.environment !== capabilities.environment
      || body.capabilityFingerprint !== capabilities.capabilityFingerprint
      || !HASH.test(body.optionsFingerprint || '')
      || body.optionsFingerprint !== capabilities.engines.odm.optionsFingerprint
      || !Array.isArray(body.options) || body.options.length > 1000) fail('reference_provider_options_invalid');
  const seen = new Set();
  const options = body.options.map((item) => {
    if (!item || Object.getPrototypeOf(item) !== Object.prototype
        || Object.keys(item).some((key) => !ALLOWED_OPTION_KEYS.has(key))
        || typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(item.name)
        || seen.has(item.name) || !['bool', 'int', 'float', 'string', 'enum'].includes(item.type || 'string'))
      fail('reference_provider_options_invalid');
    seen.add(item.name);
    const type = item.type === 'enum' ? 'string' : item.type || 'string';
    if (item.value !== undefined && type === 'bool'
        && typeof item.value !== 'boolean' && !(typeof item.value === 'string' && /^(true|false)$/i.test(item.value)))
      fail('reference_provider_options_invalid');
    if (item.value !== undefined && type === 'int'
        && !(Number.isSafeInteger(item.value) || (typeof item.value === 'string' && /^-?(0|[1-9]\d*)$/.test(item.value)
          && Number.isSafeInteger(Number(item.value))))) fail('reference_provider_options_invalid');
    if (item.value !== undefined && type === 'float'
        && !(typeof item.value === 'number' && Number.isFinite(item.value)
          || typeof item.value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(item.value)
            && Number.isFinite(Number(item.value)))) fail('reference_provider_options_invalid');
    if (item.value !== undefined && type === 'string' && (typeof item.value !== 'string' || item.value.length > 4000)) fail('reference_provider_options_invalid');
    if (item.value !== undefined && type === 'bool' && typeof item.value === 'string' && item.value.length > 5) fail('reference_provider_options_invalid');
    if (item.value !== undefined && (type === 'int' || type === 'float') && typeof item.value === 'string' && item.value.length > 64) fail('reference_provider_options_invalid');
    if (item.help !== undefined && (typeof item.help !== 'string' || item.help.length > 4000)) fail('reference_provider_options_invalid');
    if (item.domain !== undefined && item.domain !== null
        && !(typeof item.domain === 'string' && item.domain.length <= 4000
          || Array.isArray(item.domain) && item.domain.length <= 1000
            && item.domain.every((value) => typeof value === 'string' && value.length <= 4000)))
      fail('reference_provider_options_invalid');
    return { name: item.name, type, domain: item.domain ?? null, help: item.help || '',
      value: item.value === undefined ? undefined : typedDefault(type, item.value), rawDefault: item.value };
  });
  const names = new Set(options.map((item) => item.name));
  if (['pc-ept', 'gltf', '3d-tiles'].some((name) => !names.has(name))) fail('provider_missing_viewer_outputs');
  return options;
}

class ReferenceCoordinatorProvider {
  constructor({ source, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
    if (!source?.enabled || !['staging', 'production'].includes(source.environment)
        || typeof source.providerId !== 'string' || !source.providerId
        || typeof source.bearerToken !== 'string' || source.bearerToken.length < 32
        || typeof fetchImpl !== 'function') fail('reference_provider_unavailable');
    this.source = source;
    this.origin = validateOrigin(source.origin);
    if (!this.origin.startsWith('https://')) fail('reference_provider_origin_invalid');
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async get(path) {
    let response;
    try {
      response = await this.fetch(`${this.origin}${path}`, {
        method: 'GET', headers: { Authorization: `Bearer ${this.source.bearerToken}`, Accept: 'application/json' },
        redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { fail('reference_provider_transport_uncertain'); }
    if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) {
      await cancelBody(response);
      fail('reference_provider_redirect_rejected');
    }
    if (!response.ok) { await cancelBody(response); fail('reference_provider_unavailable'); }
    if (!String(response.headers.get('content-type') || '').includes('json')) {
      await cancelBody(response);
      fail('reference_provider_response_invalid');
    }
    return boundedJson(response);
  }

  async capabilities() {
    const body = await this.get('/ltds/v2/capabilities');
    const { sourceIntake, viewerAcceptance, ...capabilities } = body || {};
    try { ReferenceProtocol.validateCapabilities(capabilities); } catch { fail('reference_provider_capabilities_invalid'); }
    if (capabilities.environment !== this.source.environment
        || sourceIntake?.enabled !== true || viewerAcceptance?.enabled !== true
        || capabilities.engines.odm.available !== true) fail('reference_provider_environment_mismatch');
    const optionsBody = await this.get('/ltds/v1/options');
    const options = validateOptionsResponse(optionsBody, capabilities);
    const normalized = {
      apiVersion: 'ltds-reference-v1', engine: 'LedgeTop Reference Coordinator', engineVersion: 'unknown',
      maxImages: null, maxParallelTasks: null, taskQueueCount: null,
      totalMemory: null, availableMemory: null, cpuCores: null, testedBaseline: 'unknown',
      providerType: 'nodeodm', detectionMethod: 'pinned-reference-coordinator',
      options, compatibilityWarning: null,
      reference: { environment: capabilities.environment,
        capabilityFingerprint: capabilities.capabilityFingerprint, optionsFingerprint: optionsBody.optionsFingerprint },
    };
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      environment: capabilities.environment, capabilityFingerprint: capabilities.capabilityFingerprint,
      optionsFingerprint: optionsBody.optionsFingerprint, options,
    })).digest('hex');
    return { capabilities: normalized, fingerprint };
  }
}

module.exports = { ReferenceCoordinatorProvider, isConfiguredCoordinatorId, isReferenceCoordinatorProvider, validateOptionsResponse, boundedJson };
