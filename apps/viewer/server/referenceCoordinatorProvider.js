'use strict';

const crypto = require('node:crypto');
const ReferenceProtocol = require('./referenceProtocol');
const { validateOrigin } = require('./preparedSubmissionOutbox');

const HASH = /^[a-f0-9]{64}$/;
const ALLOWED_OPTION_KEYS = new Set(['name', 'type', 'domain', 'help', 'value']);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

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
    if (item.value !== undefined && type === 'bool' && typeof item.value !== 'boolean') fail('reference_provider_options_invalid');
    if (item.value !== undefined && type === 'int' && !Number.isSafeInteger(item.value)) fail('reference_provider_options_invalid');
    if (item.value !== undefined && type === 'float' && (typeof item.value !== 'number' || !Number.isFinite(item.value))) fail('reference_provider_options_invalid');
    if (item.value !== undefined && type === 'string' && (typeof item.value !== 'string' || item.value.length > 4000)) fail('reference_provider_options_invalid');
    if (item.help !== undefined && (typeof item.help !== 'string' || item.help.length > 4000)) fail('reference_provider_options_invalid');
    return { name: item.name, type, domain: item.domain ?? null, help: item.help || '',
      value: item.value, rawDefault: item.value };
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
    if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) fail('reference_provider_redirect_rejected');
    if (!response.ok) { await response.body?.cancel().catch(() => {}); fail('reference_provider_unavailable'); }
    if (!String(response.headers.get('content-type') || '').includes('json')) fail('reference_provider_response_invalid');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > 256 * 1024) fail('reference_provider_response_invalid');
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 256 * 1024) fail('reference_provider_response_invalid');
    try { return JSON.parse(raw); } catch { fail('reference_provider_response_invalid'); }
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
      apiVersion: 'ltds-reference-v1', engine: 'LedgeTop Reference Coordinator', engineVersion: '1',
      maxImages: null, maxParallelTasks: null, taskQueueCount: 0,
      totalMemory: null, availableMemory: null, cpuCores: null, testedBaseline: 'ltds-reference-v1',
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

module.exports = { ReferenceCoordinatorProvider, isConfiguredCoordinatorId, isReferenceCoordinatorProvider, validateOptionsResponse };
