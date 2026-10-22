'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { readRuntimeRevision } = require('../server/runtimeIdentity');

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
    build: { revision: readRuntimeRevision() || 'unavailable', schemaVersion: 38 },
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
