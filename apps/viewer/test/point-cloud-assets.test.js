'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitUntilReady(baseUrl, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`viewer exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/pointcloud.html`);
      if (response.ok) return response;
    } catch {
      // Startup can race the first request.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('viewer did not start');
}

test('Potree shell is public but EPT assets stay authorized and byte-range capable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-point-cloud-'));
  const dataDir = path.join(root, 'data');
  const distDir = path.join(root, 'dist');
  const assetRoot = path.join(root, 'assets');
  const eptDir = path.join(assetRoot, 'ept');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(path.join(eptDir, 'ept-data'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'pointcloud.html'), '<!doctype html><title>LTDS Point Cloud</title>Potree shell');
  fs.writeFileSync(path.join(distDir, 'admin-login.html'), '<!doctype html>Admin login');
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>Viewer');
  fs.writeFileSync(path.join(eptDir, 'ept.json'), JSON.stringify({ schema: [], dataType: 'laszip' }));
  fs.writeFileSync(path.join(eptDir, 'ept-data', '0-0-0-0.laz'), Buffer.from('0123456789'));
  fs.writeFileSync(path.join(dataDir, 'viewer-projects.json'), JSON.stringify({
    'webodm-1-2': {
      id: 'webodm-1-2',
      available: true,
      assetRoots: { derivatives: assetRoot },
      relAssets: { ept: { root: 'derivatives', rel: 'ept/ept.json' } },
    },
  }));

  const port = await unusedPort();
  const adminPassword = 'point-cloud-test-admin-password';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DATA_DIR: dataDir,
      DIST_DIR: distDir,
      WEBODM_ENABLED: 'false',
      SYNC_ON_STARTUP: 'false',
      ADMIN_PASSWORD: adminPassword,
      SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
      SERVICE_AUTH_SECRET: 'test-service-secret-that-is-at-least-32-characters',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const shell = await waitUntilReady(baseUrl, child);
  assert.match(await shell.text(), /Potree shell/);

  const eptUrl = `${baseUrl}/assets/webodm-1-2/derivatives/ept/ept.json`;
  assert.equal((await fetch(eptUrl)).status, 403);
  const authorizedHeaders = { Authorization: `Bearer ${adminPassword}` };
  const metadata = await fetch(eptUrl, { headers: authorizedHeaders });
  assert.equal(metadata.status, 200);
  assert.match(metadata.headers.get('content-type') || '', /json/);

  const createShare = await fetch(`${baseUrl}/api/models/webodm-1-2/share-links`, {
    method: 'POST',
    headers: { ...authorizedHeaders, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(createShare.status, 200);
  const share = await createShare.json();
  const exchange = await fetch(`${baseUrl}/api/share/${encodeURIComponent(share.token)}`);
  assert.equal(exchange.status, 200);
  const shareCookie = (exchange.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.match(shareCookie, /^ltds_share=/);
  assert.equal((await fetch(eptUrl, { headers: { Cookie: shareCookie } })).status, 200);

  const nodeUrl = `${baseUrl}/assets/webodm-1-2/derivatives/ept/ept-data/0-0-0-0.laz`;
  const partial = await fetch(nodeUrl, {
    headers: { ...authorizedHeaders, Range: 'bytes=2-5' },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('accept-ranges'), 'bytes');
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), '2345');

  const head = await fetch(nodeUrl, { method: 'HEAD', headers: authorizedHeaders });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');

  const revoke = await fetch(`${baseUrl}/api/share-links/${encodeURIComponent(share.id)}`, {
    method: 'DELETE',
    headers: authorizedHeaders,
  });
  assert.equal(revoke.status, 200);
  assert.equal((await fetch(eptUrl, { headers: { Cookie: shareCookie } })).status, 403);
});
