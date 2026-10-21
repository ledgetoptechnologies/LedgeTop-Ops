// Centralized, fail-closed server configuration. Application modules consume
// this object instead of reading process.env directly.
'use strict';

const crypto = require('crypto');
const path = require('path');
const { parseTrustedProxyAddresses } = require('./proxyGate');
const { decodeKey } = require('./providerCredentials');
const { parseProviderCidrs } = require('./providerAdmission');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function csv(value) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizedOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return '';
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

const environment = process.env.NODE_ENV || 'development';
const production = environment === 'production';
let sessionSecret = process.env.SESSION_SECRET || '';
let sessionSecretGenerated = false;
if (!sessionSecret && !production) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  sessionSecretGenerated = true;
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const processingRoot = process.env.PROCESSING_ROOT || path.join(dataDir, 'processing');
const publicBaseUrl = normalizedOrigin(process.env.PUBLIC_BASE_URL || '');
let trustedProxyAllowlist;
let trustedProxyAddressesError = null;
try { trustedProxyAllowlist = parseTrustedProxyAddresses(process.env.TRUSTED_PROXY_ADDRESSES || ''); }
catch (error) { trustedProxyAddressesError = error.message; trustedProxyAllowlist = parseTrustedProxyAddresses(''); }
let serviceAuthKeys = null;
let serviceAuthKeysError = null;
if (process.env.SERVICE_AUTH_KEYS_JSON) {
  try {
    const parsed = JSON.parse(process.env.SERVICE_AUTH_KEYS_JSON);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('must be a JSON object');
    serviceAuthKeys = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [String(key), String(value)]));
  } catch (error) {
    serviceAuthKeysError = error.message;
    serviceAuthKeys = {};
  }
}
let processingProviderTokens = {};
let processingProviderTokensError = null;
try { processingProviderTokens = JSON.parse(process.env.PROCESSING_PROVIDER_TOKENS_JSON || '{}'); if(!processingProviderTokens||Array.isArray(processingProviderTokens)||typeof processingProviderTokens!=='object'||Object.values(processingProviderTokens).some((v)=>typeof v!=='string'))throw new Error('must be a JSON object of string values'); }
catch (error) { processingProviderTokens = {}; processingProviderTokensError=error.message; }
const providerCredentialsKeyId = String(process.env.PROVIDER_CREDENTIALS_KEY_ID || 'provider-v1').trim();
let processingProviderAllowedCidrs = [];
let processingProviderAllowedCidrsError = null;
try { processingProviderAllowedCidrs = parseProviderCidrs(process.env.PROCESSING_PROVIDER_ALLOWED_CIDRS || ''); }
catch (error) { processingProviderAllowedCidrsError = error.message; }
let providerCredentialsKeys = {};
let providerCredentialsKeysError = null;
try {
  if (process.env.PROVIDER_CREDENTIALS_KEYS_JSON) {
    const parsed = JSON.parse(process.env.PROVIDER_CREDENTIALS_KEYS_JSON);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
      || Object.values(parsed).some((value) => typeof value !== 'string')) throw new Error('must be a JSON object of string values');
    providerCredentialsKeys = { ...parsed };
  }
  if (process.env.PROVIDER_CREDENTIALS_KEY)
    providerCredentialsKeys[providerCredentialsKeyId] = process.env.PROVIDER_CREDENTIALS_KEY;
} catch (error) {
  providerCredentialsKeys = {};
  providerCredentialsKeysError = error.message;
}
const previousServiceKeyId = String(process.env.SERVICE_AUTH_PREVIOUS_KEY_ID || '').trim();
const previousServiceSecret = process.env.SERVICE_AUTH_PREVIOUS_SECRET || '';
if (!serviceAuthKeys && (previousServiceKeyId || previousServiceSecret)) {
  serviceAuthKeys = {
    [String(process.env.SERVICE_AUTH_KEY_ID || 'ops-v1').trim()]: process.env.SERVICE_AUTH_SECRET || '',
  };
  if (previousServiceKeyId && previousServiceSecret) serviceAuthKeys[previousServiceKeyId] = previousServiceSecret;
}

const config = {
  measurementCalculationsEnabled: bool(process.env.MEASUREMENT_CALCULATIONS_ENABLED, true),
  measurementMaxCells: Math.min(16_000_000, positiveInteger(process.env.MEASUREMENT_MAX_CELLS, 2_000_000)),
  // Native rasters stream bounded windows; point grids retain their own limit.
  measurementRasterMaxCells: Math.min(100_000_000, positiveInteger(process.env.MEASUREMENT_RASTER_MAX_CELLS, 100_000_000)),
  measurementMemoryMiB: Math.min(4096, positiveInteger(process.env.MEASUREMENT_MEMORY_MIB, 4096)),
  measurementTimeoutMs: Math.min(900_000, positiveInteger(process.env.MEASUREMENT_TIMEOUT_MS, 300_000)),
  measurementPoissonBin: process.env.MEASUREMENT_POISSON_BIN || '/opt/poisson/PoissonRecon',
  environment,
  production,
  port: positiveInteger(process.env.PORT, 8080),
  expectedHost: String(process.env.EXPECTED_HOST || '').trim().toLowerCase(),
  publicBaseUrl,
  opsBaseUrl: normalizedOrigin(process.env.OPS_BASE_URL || 'https://ops.ledgetopdroneservices.com'),
  opsAutomationBaseUrl: normalizedOrigin(process.env.OPS_AUTOMATION_BASE_URL || ''),
  allowedEmbedOrigins: csv(process.env.ALLOWED_EMBED_ORIGINS).map(normalizedOrigin).filter(Boolean),
  trustProxyHops: Math.min(positiveInteger(process.env.TRUST_PROXY_HOPS, 1), 5),
  proxySharedSecret: String(process.env.PROXY_SHARED_SECRET || ''),
  trustedProxyAddresses: trustedProxyAllowlist.entries,
  trustedProxyAllowlist,
  trustedProxyAddressesError,

  dataDir,
  databasePath: process.env.DATABASE_PATH || path.join(dataDir, 'viewer.sqlite'),
  distDir: process.env.DIST_DIR || path.join(__dirname, '..', 'dist'),

  sessionSecret,
  sessionSecretGenerated,
  viewerSessionTtlSeconds: Math.min(positiveInteger(process.env.VIEWER_SESSION_TTL_SECONDS, 1800), 3600),
  sessionGrantTtlSeconds: Math.min(positiveInteger(process.env.SESSION_GRANT_TTL_SECONDS, 60), 300),
  adminSessionTtlSeconds: Math.min(positiveInteger(process.env.ADMIN_SESSION_TTL_SECONDS, 1800), 3600),

  serviceAuthKeyId: String(process.env.SERVICE_AUTH_KEY_ID || 'ops-v1').trim(),
  serviceAuthSecret: process.env.SERVICE_AUTH_SECRET || '',
  serviceAuthKeys,
  serviceAuthKeysError,
  previousServiceKeyId,
  previousServiceSecret,
  serviceAuthSkewSeconds: Math.min(positiveInteger(process.env.SERVICE_AUTH_SKEW_SECONDS, 300), 600),

  emergencyAdminEnabled: bool(process.env.EMERGENCY_ADMIN_ENABLED, !production),
  adminPassword: process.env.ADMIN_PASSWORD || '',

  webodmMediaMount: process.env.WEBODM_MEDIA_MOUNT || '',
  derivativesMount: process.env.DERIVATIVES_MOUNT || '',
  terraImportMount: process.env.TERRA_IMPORT_MOUNT || '',

  // When set, authorized files are handed to an internal Nginx location via
  // X-Accel-Redirect. When absent, Express sendFile remains available for
  // local development and tests.
  xAccelRedirectPrefix: String(process.env.X_ACCEL_REDIRECT_PREFIX || '').replace(/\/+$/, ''),

  processingPlatformEnabled: bool(process.env.PROCESSING_PLATFORM_ENABLED, false),
  processingWorkerEnabled: bool(process.env.PROCESSING_WORKER_ENABLED, false),
  processingRoot,
  datasetsMount: process.env.DATASETS_MOUNT || path.join(processingRoot, 'datasets'),
  modelsMount: process.env.MODELS_MOUNT || path.join(processingRoot, 'models'),
  cacheMount: process.env.CACHE_MOUNT || path.join(processingRoot, 'cache'),
  trashMount: process.env.TRASH_MOUNT || path.join(processingRoot, 'trash'),
  datasetImportMount: process.env.DATASET_IMPORT_MOUNT || '',
  uploadChunkBytes: Math.min(positiveInteger(process.env.UPLOAD_CHUNK_BYTES, 16 * 1024 * 1024), 32 * 1024 * 1024),
  uploadMaxFiles: Math.min(positiveInteger(process.env.UPLOAD_MAX_FILES, 20000), 100000),
  uploadMaxManifestBytes: Math.min(positiveInteger(process.env.UPLOAD_MAX_MANIFEST_BYTES, 2 * 1024 * 1024), 5 * 1024 * 1024),
  storageReserveBytes: positiveInteger(process.env.STORAGE_RESERVE_BYTES, 20 * 1024 * 1024 * 1024),
  storageReservePercent: Math.min(positiveInteger(process.env.STORAGE_RESERVE_PERCENT, 10), 50),
  processingLogMaxBytes: Math.min(positiveInteger(process.env.PROCESSING_LOG_MAX_BYTES, 10 * 1024 * 1024), 50 * 1024 * 1024),
  processingLogRetentionDays: Math.min(positiveInteger(process.env.PROCESSING_LOG_RETENTION_DAYS, 30), 365),
  processingProviderTransferTimeoutMs: Math.min(positiveInteger(process.env.PROCESSING_PROVIDER_TRANSFER_TIMEOUT_MS, 6*3600_000), 24*3600_000),
  processingProviderOrigins: csv(process.env.PROCESSING_PROVIDER_ORIGINS),
  processingProviderAllowedCidrs,
  processingProviderAllowedCidrsError,
  processingProviderTokens,
  providerCredentialsKeyId,
  providerCredentialsKeys,
  providerCredentialsKeysError,
  defaultUnits: /^(imperial|metric)$/.test(process.env.DEFAULT_UNITS || '') ? process.env.DEFAULT_UNITS : 'imperial',
  viewerEventUrl: String(process.env.VIEWER_EVENT_URL || '').trim(),
  viewerEventKeyId: String(process.env.VIEWER_EVENT_KEY_ID || 'viewer-v1').trim(),
  viewerEventSecret: process.env.VIEWER_EVENT_SECRET || '',
  viewerEventPreviousKeyId: String(process.env.VIEWER_EVENT_PREVIOUS_KEY_ID || '').trim(),
  viewerEventPreviousSecret: process.env.VIEWER_EVENT_PREVIOUS_SECRET || '',
  clientViewerSharesEnabled: bool(process.env.CLIENT_VIEWER_SHARES_ENABLED, false),
  publishedSessionSourceRevocationEnabled: bool(process.env.PUBLISHED_SESSION_SOURCE_REVOCATION_ENABLED, false),
  entwineBin: process.env.ENTWINE_BIN || 'entwine',
  obj2TilesBin: process.env.OBJ2TILES_BIN || 'obj2tiles',
  localDerivativesEnabled: bool(process.env.LOCAL_DERIVATIVES_ENABLED, false),
  // The production image contains the pinned converter and every generated
  // tileset remains verification-gated. Explicit false is still authoritative.
  meshDerivativesEnabled: bool(process.env.MESH_DERIVATIVES_ENABLED, true),
};

function validate() {
  const problems = [];
  if (config.production && !config.publicBaseUrl)
    problems.push('PUBLIC_BASE_URL must be an exact HTTPS origin');
  if (config.production && !config.expectedHost)
    problems.push('EXPECTED_HOST is required in production');
  if (config.proxySharedSecret && !/^[A-Za-z0-9_-]{43,128}$/.test(config.proxySharedSecret))
    problems.push('PROXY_SHARED_SECRET must be a 43-128 character base64url secret when configured');
  if (config.trustedProxyAddressesError)
    problems.push(`TRUSTED_PROXY_ADDRESSES ${config.trustedProxyAddressesError}`);
  if (config.production && !config.opsBaseUrl)
    problems.push('OPS_BASE_URL must be an exact HTTPS origin');
  if (config.production && config.allowedEmbedOrigins.length === 0)
    problems.push('ALLOWED_EMBED_ORIGINS must include the exact Ops/client origin in production');
  if (!config.sessionSecret || config.sessionSecret.length < 32)
    problems.push('SESSION_SECRET must contain at least 32 characters');
  if (config.serviceAuthKeysError) problems.push(`SERVICE_AUTH_KEYS_JSON ${config.serviceAuthKeysError}`);
  if (Boolean(config.previousServiceKeyId) !== Boolean(config.previousServiceSecret))
    problems.push('SERVICE_AUTH_PREVIOUS_KEY_ID and SERVICE_AUTH_PREVIOUS_SECRET must be configured together');
  const configuredKeys = config.serviceAuthKeys || { [config.serviceAuthKeyId]: config.serviceAuthSecret };
  if (!Object.keys(configuredKeys).length)
    problems.push('at least one service authentication key is required');
  for (const [keyId, secret] of Object.entries(configuredKeys)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId))
      problems.push(`service key id ${keyId} is invalid`);
    if (secret.length < 32) problems.push(`service auth secret for ${keyId} must contain at least 32 characters`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.serviceAuthKeyId))
    problems.push('SERVICE_AUTH_KEY_ID must contain only letters, numbers, dot, underscore, or hyphen');
  if (config.emergencyAdminEnabled && config.adminPassword.length < 16)
    problems.push('ADMIN_PASSWORD must contain at least 16 characters when emergency admin access is enabled');
  if (config.processingPlatformEnabled) {
    for (const [name, value] of [['DATASETS_MOUNT', config.datasetsMount], ['MODELS_MOUNT', config.modelsMount], ['CACHE_MOUNT', config.cacheMount], ['TRASH_MOUNT', config.trashMount]]) {
      if (!path.isAbsolute(value)) problems.push(`${name} must be an absolute path`);
    }
    if (config.viewerEventUrl) {
      try { const eventUrl=new URL(config.viewerEventUrl);if(eventUrl.protocol!=='https:'||eventUrl.username||eventUrl.password||eventUrl.search||eventUrl.hash||eventUrl.pathname!=='/api/viewer/events'||eventUrl.origin!==config.opsAutomationBaseUrl)throw new Error(); }
      catch { problems.push('VIEWER_EVENT_URL must be the exact automation HTTPS /api/viewer/events endpoint without credentials, query, or fragment'); }
    }
    if (config.viewerEventUrl && config.viewerEventSecret.length < 32)
      problems.push('VIEWER_EVENT_SECRET must contain at least 32 characters when callbacks are enabled');
    if (processingProviderTokensError) problems.push(`PROCESSING_PROVIDER_TOKENS_JSON ${processingProviderTokensError}`);
    if (providerCredentialsKeysError) problems.push(`PROVIDER_CREDENTIALS_KEYS_JSON ${providerCredentialsKeysError}`);
    if (config.processingProviderAllowedCidrsError)
      problems.push(`PROCESSING_PROVIDER_ALLOWED_CIDRS ${config.processingProviderAllowedCidrsError}`);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.providerCredentialsKeyId))
      problems.push('PROVIDER_CREDENTIALS_KEY_ID must contain only letters, numbers, dot, underscore, or hyphen');
    if (!decodeKey(config.providerCredentialsKeys[config.providerCredentialsKeyId]))
      problems.push('PROVIDER_CREDENTIALS_KEY must be a 32-byte hex, base64, or base64url key when processing is enabled');
    for (const [keyId, key] of Object.entries(config.providerCredentialsKeys)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || !decodeKey(key))
        problems.push(`provider credential key ${keyId} is invalid`);
    }
    for (const origin of config.processingProviderOrigins) {
      try { const u=new URL(origin);if(u.origin!==origin||u.username||u.password||!['http:','https:'].includes(u.protocol))throw new Error(); }
      catch { problems.push(`PROCESSING_PROVIDER_ORIGINS contains invalid exact origin: ${origin}`); }
    }
  }
  if(Boolean(config.viewerEventPreviousKeyId)!==Boolean(config.viewerEventPreviousSecret))problems.push('VIEWER_EVENT_PREVIOUS_KEY_ID and VIEWER_EVENT_PREVIOUS_SECRET must be configured together');
  if(config.viewerEventPreviousSecret&&config.viewerEventPreviousSecret.length<32)problems.push('VIEWER_EVENT_PREVIOUS_SECRET must contain at least 32 characters');
  if(config.clientViewerSharesEnabled){if(config.opsAutomationBaseUrl!=='https://incoming.ledgetopdroneservices.com')problems.push('OPS_AUTOMATION_BASE_URL must be https://incoming.ledgetopdroneservices.com when client Viewer shares are enabled');if(config.viewerEventSecret.length<32)problems.push('VIEWER_EVENT_SECRET must contain at least 32 characters when client Viewer shares are enabled');}
  return problems;
}

module.exports = { bool, config, csv, normalizedOrigin, positiveInteger, validate };
