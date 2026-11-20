import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from 'node:crypto';
import { reviewedRecipient, manualIdentity, recoveryFetch, sealRecovered, sealRecoveryCheckpoint, finalizeRecoveryEvidence } from './team-retained-recovery-once.mjs';
import { sealProductionProviderResponse, sealProductionStaticRecoveryEvidence } from './production-auto-journal.mjs';
import { canonical, hash } from './production-deploy.mjs';

const recipientFile = JSON.parse(fs.readFileSync(new URL('./team-retained-recovery-recipient.json', import.meta.url)));
const spec = JSON.parse(fs.readFileSync(new URL('./team-retained-recovery-39.json', import.meta.url)));
const source = 'b'.repeat(40), name = 'ops-ui-verify-' + 'a'.repeat(24), bearer = 'n'.repeat(43), apiToken = 'synthetic-token-at-least-twenty';
const identity = () => ({ GITHUB_REPOSITORY: 'ledgetoptechnologies/LedgeTop-Ops', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_SHA: source, APPROVED_SOURCE_COMMIT: source });
const event = () => ({ ref: 'main', inputs: { approved_source_commit: source, acknowledgement: 'recover-exact-active-844a-39-assets-no-release' } });

test('only the exact short-lived reviewed recipient is usable; missing, old and substituted keys hold', () => {
  const now = Date.parse(recipientFile.expiresAt) - 3600000;
  assert.equal(reviewedRecipient(recipientFile, now).keyIdSha256, '2121d813f8c9386df6d2fa99536708a81d9b268fc34d575ceca6ef85c0bfd5e2');
  for (const value of [null, { schemaVersion: 1, status: 'missing-reviewed-recipient' },
    { ...recipientFile, keyIdSha256: 'a7249feb83c26c1a00c800384b8fc036f421a34dc29e68226a14c40ee71327fa' },
    { ...recipientFile, publicKeyPem: 'not a key' }, { ...recipientFile, expiresAt: '2099-01-01T00:00:00.000Z' }])
    assert.throws(() => reviewedRecipient(value, now), /team_retained_recovery_refused/);
  assert.throws(() => reviewedRecipient(recipientFile, Date.parse(recipientFile.expiresAt)), /refused/);
});

test('manual identity binds exact reviewed checkout, dispatch input, main and one immutable attempt', () => {
  assert.equal(manualIdentity(identity(), event(), source, true).workflowRunId, 123);
  for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/staging' }, { GITHUB_RUN_ATTEMPT: '2' },
    { GITHUB_REPOSITORY: 'someone/fork' }, { APPROVED_SOURCE_COMMIT: 'c'.repeat(40) }])
    assert.throws(() => manualIdentity({ ...identity(), ...change }, event(), source, true), /refused/);
  assert.throws(() => manualIdentity(identity(), event(), source, false), /refused/);
  assert.throws(() => manualIdentity(identity(), { ...event(), inputs: { ...event().inputs, approved_source_commit: 'c'.repeat(40) } }, source, true), /refused/);
});

test('transport sends only exact metadata/static reads and newly named helper changes with the correct credential', async () => {
  const calls = [], base = `https://api.cloudflare.com/client/v4/accounts/${spec.accountId}`;
  const fetchImpl = async (url, init) => { calls.push({ url, method: init.method });
    return Response.json({ success: true, result: { subdomain: 'synthetic' } }); };
  const guarded = recoveryFetch({ name, bearer, apiToken, fetchImpl });
  const auth = { Authorization: 'Bearer ' + apiToken };
  const request = (suffix, method = 'GET', headers = auth, body) => guarded(base + suffix, { method, headers, body, redirect: 'error' });
  await request(`/workers/scripts/${spec.workerName}/deployments?per_page=1`);
  const sent = calls.length;
  for (const [suffix, method] of [[`/workers/scripts/${spec.workerName}`, 'DELETE'], [`/workers/scripts/${spec.workerName}/deployments`, 'POST'],
    ['/workers/scripts/ledgetop-ops-sync', 'PUT'], [`/workers/scripts/${name}/secrets`, 'PUT'],
    [`/workers/scripts/${name}/subdomain?unexpected=1`, 'POST'], ['/d1/database/anything/query', 'POST'],
    [`/workers/scripts/${name}/versions/bad`, 'GET']])
    await assert.rejects(request(suffix, method, auth, '{}'), /refused/);
  await assert.rejects(request('/workers/subdomain', 'GET', { Authorization: 'Bearer wrong-token' }), /refused/);
  assert.equal(calls.length, sent, 'denied paths, methods and credentials are refused before dispatch');
  const form = new FormData();
  form.set('metadata', JSON.stringify({ main_module: 'index.js', compatibility_date: '2026-07-22',
    bindings: [{ name: 'SOURCE_ASSETS', type: 'service', service: spec.workerName, environment: 'production' }] }));
  form.set('index.js', new Blob(['synthetic helper']), 'index.js');
  await request(`/workers/scripts/${name}`, 'PUT', auth, form);
  await request(`/workers/scripts/${name}/subdomain`, 'POST', auth, JSON.stringify({ enabled: true, previews_enabled: false }));
  await request('/workers/subdomain');
  await guarded(`https://${name}.synthetic.workers.dev${spec.entries[0].path}`, { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + bearer } });
  const count = calls.length;
  for (const suffix of ['/api/session', '/?anything=1', '/index.html?unexpected=1'])
    await assert.rejects(guarded(`https://${name}.synthetic.workers.dev${suffix}`, { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + bearer } }), /refused/);
  await assert.rejects(guarded(`https://${name}.synthetic.workers.dev${spec.entries[0].path}`, { method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer wrong' } }), /refused/);
  assert.equal(calls.length, count);
});

test('sealing requires independently confirmed cleanup before writing any recovered artifact', () => {
  for (const receipt of [{}, { temporaryWorkerRemoved: true }, { temporaryWorkerRemoved: false, absenceVerified: true }])
    assert.throws(() => sealRecovered({ assets: new Map(), receipt, identity: {}, recipient: {},
      name, journalDirectory: 'must-not-read', outputDirectory: 'must-not-write' }), /refused/);
});

test('the reused envelope contains ciphertext only and authenticates the exact context', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const recipient = { schemaVersion: 1, publicKeyPem, keyIdSha256: hash(keys.publicKey.export({ type: 'spki', format: 'der' })) };
  const context = { releaseId: 'a'.repeat(64), requestId: '00000000-0000-4000-8000-000000000001', method: 'GET', pathSha256: 'b'.repeat(64), status: 200 };
  const secret = Buffer.from('synthetic private source map body');
  assert.throws(() => sealProductionProviderResponse(secret, context, recipient), /production_auto_journal_refused_no_retry/,
    'static recovery does not broaden the existing mutation-response contract');
  assert.throws(() => sealProductionStaticRecoveryEvidence(secret, { ...context, method: 'DELETE' }, recipient), /production_auto_journal_refused_no_retry/);
  const sealed = sealProductionStaticRecoveryEvidence(secret, context, recipient);
  assert.equal(sealed.bytes.includes(secret), false);
  const envelope = JSON.parse(sealed.bytes);
  assert.equal(envelope.algorithm, 'RSA-OAEP-256+A256GCM');
  const key = privateDecrypt({ key: keys.privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.wrappedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAAD(Buffer.from(canonical({ schemaVersion: 1, algorithm: envelope.algorithm, keyId: recipient.keyIdSha256, context })));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  assert.deepEqual(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]), secret);
});

test('public workflow uploads only sealed envelopes and is manual main-only under the installation lock', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/team-retained-recovery-once.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /production-auto-installation-/);
  assert.match(workflow, /sealed_directory }}\/\*\.sealed\.json/);
  assert.doesNotMatch(workflow, /npm ci|wrangler deploy|workflow_run:|pull_request:|^  push:/m);
});


test('encrypted journal checkpoints survive a cleanup hold without a completion marker or plaintext artifact', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-recovery-checkpoint-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalDirectory = path.join(directory, 'journal'), outputDirectory = path.join(directory, 'sealed');
  fs.mkdirSync(journalDirectory); fs.mkdirSync(outputDirectory);
  fs.writeFileSync(path.join(journalDirectory, 'journal.jsonl'), 'synthetic private cleanup intent');
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const recipient = { schemaVersion: 1, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    keyIdSha256: hash(keys.publicKey.export({ type: 'spki', format: 'der' })) };
  const binding = { identity: { sourceCommit: source, workflowRunId: 123, workflowRunAttempt: 1 },
    verifierName: name, nonceHash: hash(bearer), verifierSourceSHA256: 'a'.repeat(64) };
  const pin = sealRecoveryCheckpoint({ binding, recipient, journalDirectory, outputDirectory, stage: 'mutation-intent' });
  assert.deepEqual(fs.readdirSync(outputDirectory), [pin.filename]);
  const bytes = fs.readFileSync(path.join(outputDirectory, pin.filename));
  assert.equal(bytes.length, pin.size); assert.equal(hash(bytes), pin.sha256);
  assert.equal(bytes.includes(Buffer.from('synthetic private cleanup intent')), false);
  assert.equal(bytes.includes(Buffer.from(bearer)), false);
  const envelope = JSON.parse(bytes);
  assert.equal(envelope.context.releaseId, hash(canonical(binding)), 'nonce/source/run identity are cryptographically bound');
  assert.equal(envelope.context.status, null, 'a checkpoint never asserts successful cleanup');
  assert.throws(() => sealRecovered({ assets: new Map(), receipt: { temporaryWorkerRemoved: false, absenceVerified: false },
    binding, recipient, journalDirectory, outputDirectory, partialAssets: [] }), /refused/);
  assert.deepEqual(fs.readdirSync(outputDirectory), [pin.filename], 'cleanup hold retains ciphertext without a completion');
});


for (const inventoryFails of [true, false]) test(`completion and incomplete markers are exclusive (inventory fails: ${inventoryFails})`, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-recovery-finalize-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalDirectory = path.join(directory, 'journal'), outputDirectory = path.join(directory, 'sealed');
  fs.mkdirSync(journalDirectory); fs.mkdirSync(outputDirectory);
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const recipient = { schemaVersion: 1, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    keyIdSha256: hash(keys.publicKey.export({ type: 'spki', format: 'der' })) };
  const binding = { identity: { sourceCommit: source, workflowRunId: 123, workflowRunAttempt: 1 },
    nonceHash: hash(bearer), verifierName: name, verifierSourceSHA256: 'c'.repeat(64) };
  sealRecoveryCheckpoint({ binding, recipient, journalDirectory, outputDirectory, stage: 'initial' });
  const state = { complete: false }, evidence = { receipt: { absenceVerified: true }, partialAssets: ['synthetic'] };
  const finish = () => finalizeRecoveryEvidence({ binding, recipient, journalDirectory, outputDirectory, evidence, state,
    ...(inventoryFails ? { inventory: () => { throw Error('synthetic inventory failure'); } } : {}) });
  try {
    if (inventoryFails) assert.throws(finish, /synthetic inventory failure/);
    else {
      assert.equal(finish().length, 2);
      assert.equal(state.complete, true);
      assert.throws(finish, /refused/, 'completion cannot be recorded twice');
      // A later stdout/summary failure must not add a contradictory incomplete marker.
      assert.throws(() => { throw Error('synthetic post-completion summary failure'); });
    }
  } finally {
    if (!state.complete) sealRecoveryCheckpoint({ binding, recipient, journalDirectory, outputDirectory, stage: 'incomplete' });
  }
  const envelopes = fs.readdirSync(outputDirectory).map(file => JSON.parse(fs.readFileSync(path.join(outputDirectory, file))));
  assert.equal(envelopes.filter(x => x.context.pathSha256 === hash('complete')).length, inventoryFails ? 0 : 1);
  assert.equal(envelopes.filter(x => x.context.pathSha256 === hash('incomplete')).length, inventoryFails ? 1 : 0);
  for (const envelope of envelopes) {
    assert.equal(envelope.context.releaseId, hash(canonical(binding)), 'all stages keep the original recovery binding');
    const key = privateDecrypt({ key: keys.privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.wrappedKey, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(Buffer.from(canonical({ schemaVersion: 1, algorithm: envelope.algorithm, keyId: recipient.keyIdSha256, context: envelope.context })));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]));
    assert.deepEqual(payload.binding, binding);
    if (payload.stage === 'complete') {
      assert.deepEqual(payload.evidence.receipt, evidence.receipt);
      assert.equal(payload.evidence.ciphertextInventory.length, 1);
    }
  }
});


for (const fault of ['after-full-write', 'after-close']) test(`final complete stays outside upload glob on ${fault} failure`, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-recovery-atomic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalDirectory = path.join(directory, 'journal'), outputDirectory = path.join(directory, 'sealed');
  fs.mkdirSync(journalDirectory); fs.mkdirSync(outputDirectory);
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const recipient = { schemaVersion: 1, publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    keyIdSha256: hash(keys.publicKey.export({ type: 'spki', format: 'der' })) };
  const binding = { identity: { sourceCommit: source }, nonceHash: hash(bearer), verifierName: name };
  sealRecoveryCheckpoint({ binding, recipient, journalDirectory, outputDirectory, stage: 'initial' });
  let inject = true;
  const method = fault === 'after-full-write' ? 'writeFileSync' : 'closeSync';
  const original = fs[method];
  t.mock.method(fs, method, (...args) => {
    const result = original(...args);
    if (inject && typeof args[0] === 'number') {
      inject = false;
      assert.equal(fs.readdirSync(outputDirectory).filter(file => file.endsWith('.sealed.json')).length, 1,
        'full completion bytes have not entered the upload glob');
      throw Error('synthetic ' + fault);
    }
    return result;
  });
  const state = { complete: false };
  try {
    assert.throws(() => finalizeRecoveryEvidence({ binding, recipient, journalDirectory, outputDirectory, state,
      evidence: { receipt: { absenceVerified: true } } }), /synthetic/);
    assert.equal(state.complete, false);
  } finally {
    if (!state.complete) sealRecoveryCheckpoint({ binding, recipient, journalDirectory, outputDirectory, stage: 'incomplete' });
  }
  const files = fs.readdirSync(outputDirectory);
  assert.equal(files.some(file => file.endsWith('.pending')), false, 'only the exclusively owned failed temporary was cleaned');
  const envelopes = files.filter(file => file.endsWith('.sealed.json')).map(file => JSON.parse(fs.readFileSync(path.join(outputDirectory, file))));
  assert.equal(envelopes.filter(x => x.context.pathSha256 === hash('complete')).length, 0);
  assert.equal(envelopes.filter(x => x.context.pathSha256 === hash('incomplete')).length, 1);
});
