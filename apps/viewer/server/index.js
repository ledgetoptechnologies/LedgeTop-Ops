'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const cookie = require('cookie');
const { config, validate } = require('./config');
const apiRouter = require('./api');
const assetsRouter = require('./assets');
const adminAuth = require('./adminAuth');
const shareApi = require('./shareApi');
const { createProjectShareApi } = require('./projectShareApi');
const { openDatabase } = require('./database');
const { ViewerRepository } = require('./repository');
const { migrateLegacyJson } = require('./legacyMigration');
const { createApiV1 } = require('./apiV1');
const { ProcessingRepository } = require('./processingRepository');
const { StorageManager } = require('./storageManager');
const { createProcessingApi } = require('./processingApi');
const { sanitizeLogMessage } = require('./processingSecurity');
const { createProxyGate } = require('./proxyGate');
const { ProviderCredentials } = require('./providerCredentials');
const { runtimeIdentity, setRuntimeIdentityHeaders } = require('./runtimeIdentity');
const { reconcileImportedCameraPhotoLinks } = require('./cameraPhotos');
const { workspaceConnectSources } = require('./workspaceConnectPolicy');

const problems = validate();
if (problems.length) {
  console.error('Invalid server configuration:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
if (config.sessionSecretGenerated) {
  console.warn('[warn] SESSION_SECRET not set — using a random secret for this process. ' +
    'All admin/share sessions will be invalidated on restart. Set SESSION_SECRET for production.');
}

// Create the application-owned data directory before readiness checks or
// metadata/database initialization. Production pre-creates the host bind and
// its managed directory skeleton as UID/GID 568.
try {
  fs.mkdirSync(config.dataDir, { recursive: true });
} catch (error) {
  console.error(`Cannot initialize viewer data directory: ${error.message}`);
  process.exit(1);
}

let database;
let repository;
let processingRepository;
let storageManager;
let providerCredentials;
let buildIdentity;
try {
  database = openDatabase(config.databasePath);
  buildIdentity = runtimeIdentity(database);
  repository = new ViewerRepository(database);
  if (config.processingPlatformEnabled) {
    processingRepository = new ProcessingRepository(database, { logMaxBytes: config.processingLogMaxBytes });
    providerCredentials = new ProviderCredentials({ processing: processingRepository, activeKeyId: config.providerCredentialsKeyId, keys: config.providerCredentialsKeys, legacyTokens: config.processingProviderTokens });
    const migratedProviderCredentials = providerCredentials.migrateLegacy();
    if (migratedProviderCredentials) console.log(`[migration] encrypted ${migratedProviderCredentials} legacy processing provider credential(s)`);
    storageManager = new StorageManager(config);
    storageManager.initialize();
  }
  const migration = migrateLegacyJson(repository, config.dataDir);
  if (!migration.skipped && (migration.models || migration.shares)) {
    console.log('[migration] imported legacy registry:', JSON.stringify(migration));
  }
  shareApi.setRepository(repository);
  assetsRouter.setRepository(repository);
  if (processingRepository) assetsRouter.setProcessingRepository(processingRepository);
} catch (error) {
  console.error(`Cannot initialize viewer database: ${error.message}`);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
// Required so req.secure / req.ip reflect X-Forwarded-* from a reverse proxy
// (nginx/Caddy in front of this container) instead of the proxy's own connection.
app.set('trust proxy', config.trustProxyHops);

const frameAncestors = ["'self'", ...config.allowedEmbedOrigins].join(' ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // Legacy Potree/admin shells still contain fixed inline bootstrap scripts.
    // Third-party script origins remain forbidden.
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://server.arcgisonline.com https://ledgetopdroneservices.com",
    // GLTFLoader decodes embedded B3DM textures through temporary blob URLs.
    // Only the staff workspace may contact its configured Ops authority for
    // silent renewal. Public viewing and other routes keep their prior policy.
    `connect-src ${workspaceConnectSources(req.path, config.opsBaseUrl, config.opsControllerOrigins, !config.production)}`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Session/share capability URLs can appear in nested model requests; never
  // forward them as a Referer to another request or origin.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// The LAN-published port is not an alternate public origin. In production,
// every route (including health/readiness) requires the exact virtual host.
// Optional staged hardening can additionally require the separately managed
// proxy's shared header secret and a matching socket source address/CIDR.
app.use(createProxyGate(config));

app.get('/api/v1/health', (_req, res) => {
  setRuntimeIdentityHeaders(res, buildIdentity);
  res.set('Cache-Control','no-store').json({ ok: true });
});
app.get('/api/v1/ready', (_req, res) => {
  setRuntimeIdentityHeaders(res, buildIdentity);
  res.set('Cache-Control','no-store');
  const missing = [];
  try {
    fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    missing.push('viewer data directory');
  }
  try {
    database.prepare('SELECT 1').get();
  } catch {
    missing.push('viewer database');
  }
  if (config.processingPlatformEnabled) {
    for (const [name, directory] of [['datasets', config.datasetsMount], ['models', config.modelsMount], ['cache', config.cacheMount], ['trash', config.trashMount]]) {
      try { fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK); } catch { missing.push(`${name} storage`); }
    }
  }
  res.status(missing.length ? 503 : 200).json({ ok: missing.length === 0, missing });
});

app.use(express.json({
  // Processing upload manifests are separately validated and capped. Keep the
  // legacy surface small when the processing feature is disabled.
  limit: config.processingPlatformEnabled ? config.uploadMaxManifestBytes : '100kb',
  verify(req, _res, buffer) {
    // HMAC verification must hash the exact octets Ops sent, not a
    // re-serialized JavaScript object.
    req.rawBody = Buffer.from(buffer);
  },
}));
app.use((req, res, next) => {
  req.cookies = cookie.parse(req.headers.cookie || '');
  next();
});

app.use(adminAuth.router);
app.use(shareApi);
if (processingRepository) app.use(createProjectShareApi({ repository, processing: processingRepository }));
app.use(createApiV1(repository));
if (config.processingPlatformEnabled) app.use(createProcessingApi({ repository, processing: processingRepository, storage: storageManager, providerCredentials }));
app.use(apiRouter);
app.use(assetsRouter);

// Prevent direct requests for the legacy standalone shells from bypassing the
// Ops redirect through express.static when local administration is disabled.
app.get(['/index.html', '/admin-login.html'], (_req, res, next) => {
  if (config.emergencyAdminEnabled) return next();
  return res.redirect(302, config.opsBaseUrl);
});

// Built frontend (npx vite build -> dist/). In local dev, Vite's own dev
// server (npm run dev) proxies /api and /assets to this server instead —
// see vite.config.js.
// `index: false` is important here: express.static's default behavior would
// otherwise serve dist/index.html directly for GET '/', bypassing the admin
// login gate in the catch-all route below.
app.use(express.static(config.distDir, { index: false }));

// Viewer management is entered with a one-time Ops-issued admin grant. The
// workspace removes the grant from its URL immediately after redemption.
app.get(['/workspace', '/workspace/*'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(config.distDir, 'workspace.html'), (err) => { if (err) next(err); });
});

// `/view/:token` and `/embed/:token` are public — access control happens
// API-side via the token (see server/shareApi.js). Normal administration lives
// in LTDS Ops, so the standalone password shell is reachable only when the
// explicit emergency switch is enabled.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/assets/') || req.path.startsWith('/session-assets/')) return next();
  const isShareRoute = req.path.startsWith('/view/')
    || req.path.startsWith('/embed/')
    || req.path.startsWith('/project/')
    || req.path === '/session'
    || req.path.startsWith('/session/');
  if (!isShareRoute && !config.emergencyAdminEnabled) {
    return res.redirect(302, config.opsBaseUrl);
  }
  if (!isShareRoute && !adminAuth.isAdminRequest(req)) {
    return res.sendFile(path.join(config.distDir, 'admin-login.html'), (err) => { if (err) next(err); });
  }
  res.sendFile(path.join(config.distDir, 'index.html'), (err) => { if (err) next(err); });
});

app.use((error, _req, res, _next) => {
  const safeMessage=sanitizeLogMessage(error.message || 'request failed').slice(0,240);
  console.error('[request-error]', error.code || error.name || 'error', safeMessage);
  if (res.headersSent) return;
  res.status(error.status || 500).json({ error: error.status && error.status < 500 ? safeMessage : 'request failed', code: error.code || 'request_failed' });
});

const server = app.listen(config.port, () => {
  console.log(`LTDS 3D Viewer server listening on :${config.port}`);
  console.log('WebODM migration: mounted task folders and exported ZIP archives');
  if (config.derivativesMount) console.log(`Derivatives mount: ${config.derivativesMount}`);
  if (processingRepository && storageManager) setImmediate(() => {
    try {
      const cameraPhotoMigration = reconcileImportedCameraPhotoLinks({ repository, processing: processingRepository, storage: storageManager });
      if (cameraPhotoMigration.photosLinked) console.log(`[migration] restored ${cameraPhotoMigration.photosLinked} camera photo link(s) across ${cameraPhotoMigration.versionsReconciled} imported model version(s)`);
      if (cameraPhotoMigration.versionsFailed) console.warn(`[migration] camera photo reconciliation deferred ${cameraPhotoMigration.versionsFailed} imported model version(s)`);
    } catch {
      console.warn('[migration] camera photo reconciliation deferred after a bounded maintenance failure');
    }
  });
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop accepting new requests and let in-flight API responses finish before
    // closing the shared SQLite handle. Docker's stop_grace_period is the outer
    // bound if a client never completes.
    server.close((error) => {
      try { database.close(); } catch { /* already closed */ }
      process.exit(error ? 1 : 0);
    });
  });
}
