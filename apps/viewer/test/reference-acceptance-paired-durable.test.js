'use strict';

// Synthetic cross-process test, not a deployed Viewer or NAS qualification.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');

const processing = process.env.LTDS_PROCESSING_REPO;

test('Processing sender recovers a lost commit after the persistent Viewer process is killed', {
  skip: process.platform === 'win32' || !processing,
  timeout: 60000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-durable-viewer-'));
  fs.mkdirSync(path.join(root, 'accepted'));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await once(server, 'exit');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const keys = crypto.generateKeyPairSync('ed25519');
  const env = { ...process.env, LTDS_PROCESSING_REPO: processing, LTDS_LEDGER_ROOT: root,
    LTDS_VIEWER_ORIGIN: 'https://viewer.synthetic', LTDS_VIEWER_SERVICE_KEY_ID: 'synthetic-processing-v1',
    LTDS_VIEWER_SERVICE_SECRET: 'synthetic-processing-service-secret-not-a-credential-0001',
    LTDS_VIEWER_RECEIPT_ISSUER_ID: 'viewer-acceptance', LTDS_VIEWER_RECEIPT_KEY_ID: 'viewer-test-2026',
    LTDS_VIEWER_RECEIPT_PRIVATE_KEY_PEM: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    LTDS_VIEWER_RECEIPT_PUBLIC_KEY_PEM: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  };
  async function startServer() {
    const child = fork(path.join(__dirname, 'fixtures', 'reference_acceptance_durable_server.js'), [],
      { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    server = child;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const message = await Promise.race([
      once(child, 'message').then(([value]) => value),
      once(child, 'exit').then(([code, signal]) => { throw new Error(`server exited ${code}/${signal}: ${stderr}`); }),
    ]);
    assert.equal(message.type, 'ready');
    return message.port;
  }
  async function sender(phase, port) {
    const child = spawn(process.env.LTDS_PYTHON || 'python3',
      [path.join(__dirname, 'fixtures', 'reference_acceptance_durable_sender.py'), phase],
      { env: { ...env, LTDS_VIEWER_LOOPBACK: `http://127.0.0.1:${port}` }, cwd: processing, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0, `sender ${phase} ${code}/${signal}: ${stderr}`);
    return JSON.parse(stdout.trim());
  }
  async function inspect() {
    const response = once(server, 'message');
    server.send('inspect');
    const [result] = await response;
    assert.equal(result.type, 'inspection');
    return result;
  }

  let port = await startServer();
  assert.equal((await sender('lose', port)).phase, 'lost');
  const before = await inspect();
  assert.deepEqual(before.counts, { accepted: 1, intents: 1, objects: 2 });
  assert.ok(before.record?.storage?.viewerReceipt);
  server.kill('SIGKILL');
  const [, signal] = await once(server, 'exit');
  assert.equal(signal, 'SIGKILL');
  server = null;

  port = await startServer();
  const afterRestart = await inspect();
  assert.deepEqual(afterRestart, before);
  const replay = await sender('recover', port);
  assert.equal(replay.phase, 'recovered');
  assert.deepEqual(replay.viewerReceipt, before.record.storage.viewerReceipt);
  assert.deepEqual(await inspect(), before);
});
