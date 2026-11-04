'use strict';
// Synthetic persistent Processing Queue + actual Viewer SQLite/filesystem ledger.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { signServiceRequest } = require('../server/serviceAuth');

const processing = process.env.LTDS_PROCESSING_REPO;
test('Processing journal and Viewer ledger recover after both processes die following a lost commit', {
  skip: process.platform === 'win32' || !processing, timeout: 60000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-processing-journal-'));
  fs.mkdirSync(path.join(root, 'accepted')); fs.mkdirSync(path.join(root, 'processing'));
  let server, sender;
  t.after(async () => {
    for (const child of [sender, server]) if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await once(child, 'exit');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const keys = crypto.generateKeyPairSync('ed25519');
  const env = { ...process.env, LTDS_PROCESSING_REPO: processing, LTDS_PROCESSING_STATE: path.join(root, 'processing'),
    LTDS_LEDGER_ROOT: root, LTDS_VIEWER_ORIGIN: 'https://viewer.synthetic', SERVICE_AUTH_SKEW_SECONDS: '600',
    LTDS_VIEWER_SERVICE_KEY_ID: 'synthetic-processing-v1',
    LTDS_VIEWER_SERVICE_SECRET: 'synthetic-processing-service-secret-not-a-credential-0001',
    LTDS_VIEWER_RECEIPT_ISSUER_ID: 'viewer-acceptance', LTDS_VIEWER_RECEIPT_KEY_ID: 'viewer-test-2026',
    LTDS_VIEWER_RECEIPT_PRIVATE_KEY_PEM: keys.privateKey.export({type: 'pkcs8', format: 'pem'}),
    LTDS_VIEWER_RECEIPT_PUBLIC_KEY_PEM: keys.publicKey.export({type: 'spki', format: 'pem'}) };
  async function startServer() {
    server = fork(path.join(__dirname, 'fixtures/reference_acceptance_processing_journal_server.js'), [],
      {env, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let error = ''; server.stderr.on('data', chunk => { error += chunk; });
    const message = await Promise.race([once(server, 'message').then(([v]) => v),
      once(server, 'exit').then(([c,s]) => { throw Error(`Viewer ${c}/${s}: ${error}`); })]);
    assert.equal(message.type, 'ready'); return message.port;
  }
  async function run(mode, port, killAfterLine = false) {
    sender = spawn(process.env.LTDS_PYTHON || 'python3',
      [path.join(__dirname, 'fixtures/reference_acceptance_processing_journal.py'), mode],
      {env: {...env, LTDS_VIEWER_LOOPBACK: `http://127.0.0.1:${port}`}, cwd: processing,
       stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    sender.stderr.on('data', chunk => { stderr += chunk; });
    if (killAfterLine) {
      const line = await Promise.race([
        new Promise(resolve => sender.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('\n')) resolve(stdout); })),
        once(sender, 'exit').then(([c,s]) => { throw Error(`Processing ${c}/${s}: ${stderr}`); }),
      ]);
      const parsed = JSON.parse(line.trim()); sender.kill('SIGKILL');
      const [, signal] = await once(sender, 'exit'); assert.equal(signal, 'SIGKILL'); sender = null; return parsed;
    }
    sender.stdout.on('data', chunk => { stdout += chunk; });
    const [code, signal] = await once(sender, 'exit');
    assert.equal(code, 0, `Processing ${mode} ${code}/${signal}: ${stderr}`); sender = null;
    return JSON.parse(stdout.trim());
  }
  async function inspect() { const response = once(server, 'message'); server.send('inspect'); return (await response)[0]; }
  assert.equal((await run('seed', 0)).phase, 'seeded');
  let port = await startServer();
  assert.equal((await run('lose', port, true)).phase, 'lost');
  const before = await inspect();
  assert.deepEqual(before.counts, {accepted: 1, intents: 1, objects: 2});
  assert.ok(before.record?.storage?.viewerReceipt);
  // A previously authenticated request must remain a replay after the
  // Viewer process restarts, while the sender can recover using a fresh nonce.
  const receiptPath = `/api/v1/reference/v1/acceptances/${before.record.acceptance.receiptId}`;
  const signed = signServiceRequest({ secret: env.LTDS_VIEWER_SERVICE_SECRET,
    keyId: env.LTDS_VIEWER_SERVICE_KEY_ID, method: 'GET', path: receiptPath });
  assert.equal((await fetch(`http://127.0.0.1:${port}${receiptPath}`, { headers: signed })).status, 200);
  server.kill('SIGKILL'); assert.equal((await once(server, 'exit'))[1], 'SIGKILL'); server = null;
  port = await startServer(); assert.deepEqual(await inspect(), before);
  const db = new DatabaseSync(path.join(root, 'viewer.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM service_nonces WHERE key_id=? AND nonce=?')
      .get(env.LTDS_VIEWER_SERVICE_KEY_ID, signed['X-LTDS-Nonce']).count, 1,
    'the first authenticated request must leave a durable nonce row');
  } finally { db.close(); }
  assert.ok(Math.abs(Math.floor(Date.now() / 1000) - Number(signed['X-LTDS-Timestamp'])) < 600,
    'the replay must still be inside the explicitly configured authentication window');
  assert.equal((await fetch(`http://127.0.0.1:${port}${receiptPath}`, { headers: signed })).status, 401,
    'the real persistent nonce repository must reject replay across restart');
  const fresh = signServiceRequest({ secret: env.LTDS_VIEWER_SERVICE_SECRET,
    keyId: env.LTDS_VIEWER_SERVICE_KEY_ID, method: 'GET', path: receiptPath });
  assert.equal((await fetch(`http://127.0.0.1:${port}${receiptPath}`, { headers: fresh })).status, 200);
  const recovered = await run('recover', port);
  assert.equal(recovered.phase, 'recovered');
  assert.deepEqual(recovered.viewerReceipt, before.record.storage.viewerReceipt);
  assert.deepEqual(await inspect(), before);
  const metricResponse = once(server, 'message'); server.send('metrics');
  const [metrics] = await metricResponse;
  assert.equal(metrics.type, 'metrics');
  assert.ok(metrics.calls.some(call => call.method === 'GET'));
  assert.equal(metrics.calls.filter(call => call.method !== 'GET').length, 0,
    'recovery must not reupload or recommit already accepted objects');
});
