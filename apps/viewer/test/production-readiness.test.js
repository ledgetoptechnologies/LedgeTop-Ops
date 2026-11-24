'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { promisify } = require('node:util');
const test = require('node:test');
const { MIGRATIONS, openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ProviderCredentials } = require('../server/providerCredentials');
const { readRuntimeRevision, REVISION_HEADER, SCHEMA_HEADER } = require('../server/runtimeIdentity');

const repositoryRoot = path.resolve(__dirname, '..');

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitFor(url, child, proxySecret) {
  let lastStatus = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`viewer exited with ${child.exitCode}`);
    try {
      const status = await new Promise((resolve, reject) => {
        const request = require('node:http').get(url, { headers: { Host: 'viewer.example.test', 'X-Viewer-Proxy-Secret': proxySecret } }, (response) => {
          response.resume(); response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
      });
      lastStatus = status;
      if (status >= 200 && status < 300) return;
    } catch { /* listener not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`viewer did not become ready (last HTTP ${lastStatus})`);
}

test('production readiness verifies the live policy and signed catalog without exposing secrets', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-readiness-'));
  const dataDir = path.join(root, 'data');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>Viewer');
  fs.writeFileSync(path.join(distDir, 'admin-login.html'), '<!doctype html>Login');
  const port = await unusedPort();
  const sessionSecret = 'readiness-session-secret-that-is-at-least-32-characters';
  const serviceSecret = 'readiness-service-secret-that-is-at-least-32-characters';
  const proxySecret = 'readiness-proxy-secret-00000000000000000000000';
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    NODE_ENV: 'production',
    PORT: String(port),
    DATA_DIR: dataDir,
    DIST_DIR: distDir,
    PUBLIC_BASE_URL: 'https://viewer.example.test',
    EXPECTED_HOST: 'viewer.example.test',
    ALLOWED_EMBED_ORIGINS: 'https://ops.example.test,https://client.example.test',
    OPS_BASE_URL: 'https://ops.example.test',
    WEBODM_ENABLED: 'false',
    SYNC_ON_STARTUP: 'false',
    EMERGENCY_ADMIN_ENABLED: 'false',
    SESSION_SECRET: sessionSecret,
    SERVICE_AUTH_SECRET: serviceSecret,
    PROXY_SHARED_SECRET: proxySecret,
    VIEWER_READINESS_BASE_URL: `http://127.0.0.1:${port}`,
  };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: repositoryRoot, env, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(`http://127.0.0.1:${port}/api/v1/ready`, child, proxySecret);

  const result = spawnSync(process.execPath, ['scripts/production-readiness.mjs'], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output, {
    ok: true,
    host: 'viewer.example.test',
    // Source-tree runs have no attestation file; an exact runtime image does.
    build: { revision: readRuntimeRevision() || 'unavailable', schemaVersion: MIGRATIONS.at(-1).version },
    webodmMount: '',
    derivativesMount: null,
    models: 0,
    ready: 0,
    pointCloud: 0,
    ept: 0,
    lod: 0,
    verifiedLod: 0,
    fullMesh: 0,
  });
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(`${sessionSecret}|${serviceSecret}`));
  const required = spawnSync(process.execPath, ['scripts/production-readiness.mjs', '--require-models'], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
  });
  assert.notEqual(required.status, 0);
  assert.match(required.stderr, /no ready Viewer models were discovered/);
  const liveWithoutExactModel = spawnSync(process.execPath, ['scripts/production-readiness.mjs', '--live-capability'], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
  });
  assert.notEqual(liveWithoutExactModel.status, 0);
  assert.match(liveWithoutExactModel.stderr, /--live-capability requires an exact --model id or alias/);
});

test('production readiness --require-processing checks a synthetic SQLite store without writing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-processing-readiness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processingRoot = path.join(root, 'processing');
  const storage = ['datasets', 'models', 'cache', 'trash'];
  for (const mount of storage) fs.mkdirSync(path.join(processingRoot, mount), { recursive: true });

  const databasePath = path.join(root, 'viewer.sqlite');
  const providerId = 'readiness-fixture-provider';
  const providerKey = '3c'.repeat(32);
  const providerToken = 'synthetic-provider-credential';
  const database = openDatabase(databasePath);
  const workerAt = new Date().toISOString();
  try {
    const processing = new ProcessingRepository(database);
    const credentials = new ProviderCredentials({ processing, keys: { 'provider-v1': providerKey } });
    const sealed = credentials.seal(providerId, providerToken);
    processing.upsertProvider({
      id: providerId, type: 'nodeodm', displayName: 'Readiness fixture',
      endpoint: 'http://127.0.0.1:1', enabled: true,
      credentialCiphertext: sealed.ciphertext, credentialKeyId: sealed.keyId,
      capabilities: { options: ['pc-ept', '3d-tiles', 'gltf'].map((name) => ({ name })) },
      capabilityFingerprint: 'synthetic-fingerprint',
    });
    processing.recordWorkerHeartbeat('readiness-fixture-worker', { at: workerAt });
    // A writer that accidentally constructs the repository would insert these presets.
    database.exec('DELETE FROM processing_presets; PRAGMA journal_mode=DELETE');
  } finally {
    database.close();
  }

  // Test only the CLI and the local database here. No worker or provider is running.
  const expectedHost = 'viewer.example.test';
  const opsBaseUrl = 'https://ops.example.test';
  const schemaVersion = MIGRATIONS.at(-1).version;
  const revision = readRuntimeRevision() || 'unavailable';
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    if (req.headers.host !== expectedHost) return res.writeHead(421).end();
    if (req.url === '/') return res.writeHead(302, { location: opsBaseUrl + '/' }).end();
    if (req.url === '/api/admin/session') return res.writeHead(404).end();
    if (req.url === '/api/v1/models') return res.end(JSON.stringify({ models: [] }));
    if (req.url !== '/api/v1/health' && req.url !== '/api/v1/ready') return res.writeHead(404).end();
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      [REVISION_HEADER]: revision,
      [SCHEMA_HEADER]: String(schemaVersion),
    }).end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const env = {
    // Do not inherit live application configuration or credentials.
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    NODE_NO_WARNINGS: '1',
    NODE_ENV: 'production',
    DATA_DIR: root,
    DATABASE_PATH: databasePath,
    PROCESSING_ROOT: processingRoot,
    PROCESSING_PLATFORM_ENABLED: 'true',
    PROVIDER_CREDENTIALS_KEY: providerKey,
    STORAGE_RESERVE_BYTES: '1',
    STORAGE_RESERVE_PERCENT: '1',
    EXPECTED_HOST: expectedHost,
    PUBLIC_BASE_URL: 'https://' + expectedHost,
    OPS_BASE_URL: opsBaseUrl,
    ALLOWED_EMBED_ORIGINS: opsBaseUrl,
    WEBODM_ENABLED: 'false',
    EMERGENCY_ADMIN_ENABLED: 'false',
    SESSION_SECRET: 'synthetic-processing-readiness-session-secret',
    SERVICE_AUTH_SECRET: 'synthetic-processing-readiness-service-secret',
    PROXY_SHARED_SECRET: 'synthetic-processing-readiness-proxy-secret',
    VIEWER_READINESS_BASE_URL: 'http://127.0.0.1:' + server.address().port,
  };
  const runReadiness = () => promisify(execFile)(process.execPath,
    ['scripts/production-readiness.mjs', '--require-processing'],
    { cwd: repositoryRoot, env, encoding: 'utf8', timeout: 20_000 });
  const assertUnchanged = (before) => {
    assert.ok(fs.readFileSync(databasePath).equals(before), 'readiness must leave the SQLite file byte-identical');
    for (const suffix of ['-journal', '-wal', '-shm']) assert.equal(fs.existsSync(databasePath + suffix), false);
  };

  const beforeClean = fs.readFileSync(databasePath);
  const clean = await runReadiness();
  assert.equal(clean.stderr, '');
  const output = JSON.parse(clean.stdout);
  assert.equal(output.ok, true);
  assert.deepEqual(output.build, { revision, schemaVersion });
  assert.deepEqual(output.processing.lifecycleCounts, []);
  assert.equal(output.processing.workerAt, workerAt);
  assert.equal(output.processing.enabledProviders, 1);
  assert.deepEqual(Object.keys(output.processing.spaces), storage);
  assert.ok(!clean.stdout.includes(providerToken) && !clean.stdout.includes(providerKey));
  assertUnchanged(beforeClean);

  const writer = new DatabaseSync(databasePath);
  try {
    writer.prepare('INSERT INTO storage_mutations (id, mutation_type, entity_type, entity_id, trash_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('failed-fixture-journal', 'trash', 'dataset', 'fixture-dataset', 'fixture-trash', 'failed', workerAt, workerAt);
  } finally {
    writer.close();
  }
  const requestsBeforeHold = requests;
  const beforeHold = fs.readFileSync(databasePath);
  await assert.rejects(runReadiness, (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /storage lifecycle mutations require operator repair/);
    return true;
  });
  assert.equal(requests, requestsBeforeHold, 'failed journal must stop readiness before HTTP probes');
  assertUnchanged(beforeHold);
});

test('production readiness exercises an exact protected Ops browser capability without leaking credentials', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-capability-readiness-'));
  const dataDir = path.join(root, 'data');
  const distDir = path.join(root, 'dist');
  const assetRoot = path.join(root, 'assets');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(assetRoot, 'tiles'), { recursive: true });
  fs.mkdirSync(path.join(assetRoot, 'ept', 'ept-data'), { recursive: true });
  fs.mkdirSync(path.join(assetRoot, 'ept', 'ept-hierarchy'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>Viewer');
  fs.writeFileSync(path.join(distDir, 'admin-login.html'), '<!doctype html>Login');
  fs.writeFileSync(path.join(assetRoot, 'model.glb'), Buffer.from('abcdefghij'));
  fs.writeFileSync(path.join(assetRoot, 'point-cloud.laz'), Buffer.from('direct-laz-points'));
  fs.writeFileSync(path.join(assetRoot, 'tiles', 'tileset.json'), JSON.stringify({
    asset: { version: '1.1' },
    root: { geometricError: 0, content: { uri: 'root.b3dm' } },
  }));
  fs.writeFileSync(path.join(assetRoot, 'tiles', 'root.b3dm'), Buffer.from('nested-tile-bytes'));
  fs.writeFileSync(path.join(assetRoot, 'ept', 'ept.json'), JSON.stringify({
    dataType: 'laszip', hierarchyType: 'json', hierarchyStep: 5, schema: [],
  }));
  fs.writeFileSync(path.join(assetRoot, 'ept', 'ept-hierarchy', '0-0-0-0.json'), JSON.stringify({ '0-0-0-0': 12 }));
  fs.writeFileSync(path.join(assetRoot, 'ept', 'ept-data', '0-0-0-0.laz'), Buffer.from('nested-ept-points'));
  fs.writeFileSync(path.join(dataDir, 'viewer-projects.json'), JSON.stringify({
    'webodm-4-9': {
      id: 'webodm-4-9',
      webodmProjectId: 4,
      webodmTaskId: 9,
      title: 'Readiness model',
      projectName: 'Readiness project',
      status: 40,
      available: true,
      assetRoots: { derivatives: assetRoot },
      relAssets: {
        glb: { root: 'derivatives', rel: 'model.glb', format: 'glb' },
        tiles: { root: 'derivatives', rel: 'tiles/tileset.json', format: '3dtiles' },
        ept: { root: 'derivatives', rel: 'ept/ept.json', format: 'ept' },
        pointCloud: { root: 'derivatives', rel: 'point-cloud.laz', format: 'laz' },
      },
    },
  }));

  const port = await unusedPort();
  const sessionSecret = 'capability-readiness-session-secret-that-is-at-least-32-characters';
  const serviceSecret = 'capability-readiness-service-secret-that-is-at-least-32-characters';
  const proxySecret = 'capability-proxy-secret-0000000000000000000000';
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    NODE_ENV: 'production',
    PORT: String(port),
    DATA_DIR: dataDir,
    DIST_DIR: distDir,
    PUBLIC_BASE_URL: 'https://viewer.example.test',
    EXPECTED_HOST: 'viewer.example.test',
    ALLOWED_EMBED_ORIGINS: 'https://ops.example.test,https://client.example.test',
    OPS_BASE_URL: 'https://ops.example.test',
    WEBODM_ENABLED: 'false',
    SYNC_ON_STARTUP: 'false',
    EMERGENCY_ADMIN_ENABLED: 'false',
    SESSION_SECRET: sessionSecret,
    SERVICE_AUTH_SECRET: serviceSecret,
    PROXY_SHARED_SECRET: proxySecret,
    VIEWER_READINESS_BASE_URL: `http://127.0.0.1:${port}`,
  };
  const child = spawn(process.execPath, ['server/index.js'], { cwd: repositoryRoot, env, stdio: 'ignore' });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(`http://127.0.0.1:${port}/api/v1/ready`, child, proxySecret);

  const databasePath = path.join(dataDir, 'viewer.sqlite');
  let database = openDatabase(databasePath);
  const modelBefore = database.prepare('SELECT * FROM models').get();
  database.close();

  const result = spawnSync(process.execPath, [
    'scripts/production-readiness.mjs',
    '--model', 'webodm-4-9',
    '--require-ept',
    '--live-capability',
    '--capability-ttl-seconds', '30',
  ], { cwd: repositoryRoot, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.protectedCapability, {
    ok: true,
    audience: 'ops',
    assetKinds: ['glb', 'ept', 'ept-hierarchy', 'ept-node'],
    rangeChecks: 2,
    failClosedChecks: 6,
  });
  assert.equal(output.models, 1);
  assert.equal(output.ept, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(`${sessionSecret}|${serviceSecret}`));

  database = openDatabase(databasePath);
  const modelAfter = database.prepare('SELECT * FROM models').get();
  const grant = database.prepare('SELECT id,redeemed_at FROM session_grants').get();
  const sessionCount = database.prepare('SELECT COUNT(*) AS count FROM viewer_sessions').get().count;
  const shareCount = database.prepare('SELECT COUNT(*) AS count FROM public_shares').get().count;
  database.close();
  assert.deepEqual(modelAfter, modelBefore);
  assert.ok(grant.redeemed_at);
  assert.equal(sessionCount, 1);
  assert.equal(shareCount, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(grant.id));
});
