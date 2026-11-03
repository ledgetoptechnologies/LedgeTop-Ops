'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const {
  DOMAIN, PATH, PROTOCOL, PreparedSubmissionClient, PreparedSubmissionOutbox,
  canonicalEnvelope, canonicalizeJcs,
} = require('../server/preparedSubmissionOutbox');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-prepared-outbox-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const project = processing.createProject({ displayName: 'Outbox test' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Source', storageMode: 'managed', rootKey: 'datasets' });
  const digest = crypto.createHash('sha256').update('source').digest('hex');
  processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 6, sha256: digest }], digest);
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Test ODM', endpoint: 'https://odm.invalid', enabled: true });
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Outbox task' });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, capabilityFingerprint: 'capability-test' });
  const job = processing.claimJob('viewer-outbox-test-owner');
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, processing, project, dataset, task, attempt, job, root };
}

function envelope(taskId, attemptId, options = {}) {
  return {
    schemaVersion: 3,
    protocol: PROTOCOL,
    submission: {
      schemaVersion: 1,
      submissionId: attemptId,
      manifest: { id: 'dataset-test', revision: 1, objects: [] },
      pipeline: { odm: { requested: true, options: options.options || {}, optionsFingerprint: 'b'.repeat(64) } },
      capabilityFingerprint: 'a'.repeat(64),
    },
    viewerTaskId: taskId,
    viewerAttemptId: attemptId,
    activationId: options.activationId || crypto.randomUUID(),
  };
}

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function remoteBinding(intent, { jobId = 'processing-job-1', generation = 1, environment = 'staging' } = {}) {
  const body = JSON.parse(intent.envelopeCanonical);
  return {
    jobId, generation, environment,
    phase: 'prepared', manifestSha256: 'c'.repeat(64), pipelineDigest: 'd'.repeat(64), status: 'queued',
    nodeId: null, transferRequest: null, transferGrantAcknowledgement: null, error: null, resultManifestSha256: null,
    submissionId: intent.submissionId, envelopeSha256: intent.envelopeSha256,
    viewerTaskId: body.viewerTaskId, viewerAttemptId: body.viewerAttemptId, activationId: body.activationId,
  };
}

test('JCS canonical bytes use sorted UTF-16 keys and ECMAScript number rendering', () => {
  assert.equal(canonicalizeJcs({ z: -0, a: 1.25, '10': 'x', '2': 'y' }).toString(), '{"10":"x","2":"y","a":1.25,"z":0}');
  assert.equal(canonicalizeJcs({ '\uE000': 1, '\uD83D\uDE00': 2 }).toString(), '{"😀":2,"":1}');
  assert.throws(() => canonicalizeJcs({ value: '\uD800' }), { code: 'prepared_envelope_invalid_unicode' });
  assert.throws(() => canonicalizeJcs({ value: Number.MAX_SAFE_INTEGER + 1 }), { code: 'prepared_envelope_invalid_number' });
  const checked = canonicalEnvelope({ ...envelope('c957e280-108b-48a9-9c51-c6480a5ff567', '9160ed62-e5e6-4319-b213-fce0b3c5602e'), });
  assert.equal(checked.sha256, crypto.createHash('sha256').update(DOMAIN).update(checked.bytes).digest('hex'));
});

test('outbox persists the exact envelope under the current submit lease and rejects changed replay', t => {
  const f = fixture(t), outbox = new PreparedSubmissionOutbox(f.database), body = envelope(f.task.id, f.attempt.id);
  const context = { localJobId: f.job.id, owner: f.job.lease_owner, origin: 'https://processing.example', principalId: 'viewer-staging', environment: 'staging' };
  const first = outbox.persistIntent({ ...context, envelope: body });
  const replay = outbox.persistIntent({ ...context, envelope: body });
  assert.deepEqual(replay, first);
  assert.equal(outbox.getIntent(f.attempt.id).envelopeCanonical, first.envelopeCanonical);
  assert.throws(() => outbox.persistIntent({ ...context,
    envelope: envelope(f.task.id, f.attempt.id, { activationId: crypto.randomUUID() }) }), { code: 'prepared_outbox_conflict' });
  assert.throws(() => outbox.persistIntent({ ...context, origin: 'https://other-processing.example', envelope: body }), { code: 'prepared_outbox_conflict' });
  assert.throws(() => f.database.prepare('DELETE FROM viewer_prepared_submission_outbox WHERE submission_id=?').run(first.submissionId), /prepared submission outbox is retained/);
  assert.throws(() => f.database.prepare('UPDATE viewer_prepared_submission_outbox SET envelope_canonical=? WHERE submission_id=?').run('{}', first.submissionId), /prepared submission envelope is immutable/);
  assert.throws(() => f.database.prepare("UPDATE viewer_prepared_submission_outbox SET state='held' WHERE submission_id=?").run(first.submissionId), /prepared submission outbox state cannot be reset/);
});

test('outbox requires an unexpired matching submit lease and exact local task and attempt identity', t => {
  const f = fixture(t), outbox = new PreparedSubmissionOutbox(f.database);
  const context = { localJobId: f.job.id, origin: 'https://processing.example', principalId: 'viewer-staging', environment: 'staging' };
  assert.throws(() => outbox.persistIntent({ ...context, owner: 'wrong-owner', envelope: envelope(f.task.id, f.attempt.id) }), { code: 'prepared_outbox_lease_lost' });
  assert.throws(() => outbox.persistIntent({ ...context, owner: f.job.lease_owner, envelope: envelope(crypto.randomUUID(), f.attempt.id) }), { code: 'prepared_outbox_lease_lost' });
  f.database.prepare('UPDATE processing_jobs SET lease_expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), f.job.id);
  assert.throws(() => outbox.persistIntent({ ...context, owner: f.job.lease_owner, envelope: envelope(f.task.id, f.attempt.id) }), { code: 'prepared_outbox_lease_lost' });
});

test('uncertain POST is recovered only by authenticated exact GET and preserves stored bytes', async t => {
  const f = fixture(t), outbox = new PreparedSubmissionOutbox(f.database);
  const intent = outbox.persistIntent({ localJobId: f.job.id, owner: f.job.lease_owner, origin: 'https://processing.example', principalId: 'viewer-staging', environment: 'staging', envelope: envelope(f.task.id, f.attempt.id) });
  const calls = [];
  const client = new PreparedSubmissionClient({ origin: 'https://processing.example', bearerToken: 'synthetic-test-bearer-token-0001', principalId: 'viewer-staging', environment: 'staging', outbox,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') throw new Error('connection closed after remote commit');
      assert.equal(url, `https://processing.example${PATH}/${intent.submissionId}`);
      assert.equal(options.headers.Authorization, 'Bearer synthetic-test-bearer-token-0001');
      return responseJson(remoteBinding(intent));
    },
  });
  const accepted = await client.dispatch(intent, { owner: f.job.lease_owner });
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.remoteBinding.jobId, 'processing-job-1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.body, intent.envelopeCanonical);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(outbox.getIntent(f.attempt.id).state, 'accepted');
});

test('authority changes and lease loss after the network read leave the outbox pending', async t => {
  const f = fixture(t), outbox = new PreparedSubmissionOutbox(f.database);
  const intent = outbox.persistIntent({ localJobId: f.job.id, owner: f.job.lease_owner, origin: 'https://processing.example', principalId: 'viewer-staging', environment: 'staging', envelope: envelope(f.task.id, f.attempt.id) });
  const reconfigured = new PreparedSubmissionClient({ origin: 'https://other-processing.example', bearerToken: 'synthetic-test-bearer-token-0001', principalId: 'viewer-staging', environment: 'staging', outbox,
    fetchImpl: async () => { assert.fail('authority mismatch must be rejected before network I/O'); },
  });
  await assert.rejects(reconfigured.dispatch(intent, { owner: f.job.lease_owner }), { code: 'prepared_outbox_authority_changed' });
  const client = new PreparedSubmissionClient({ origin: 'https://processing.example', bearerToken: 'synthetic-test-bearer-token-0001', principalId: 'viewer-staging', environment: 'staging', outbox,
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') return responseJson({}, 201);
      f.database.prepare("UPDATE processing_jobs SET status='pending',lease_owner=NULL,lease_expires_at=NULL WHERE id=?").run(f.job.id);
      return responseJson(remoteBinding(intent));
    },
  });
  await assert.rejects(client.dispatch(intent, { owner: f.job.lease_owner }), { code: 'prepared_outbox_lease_lost' });
  assert.equal(outbox.getIntent(f.attempt.id).state, 'prepared');
});

test('successful POST still requires the authenticated GET binding before acceptance', async t => {
  const f = fixture(t), outbox = new PreparedSubmissionOutbox(f.database);
  const intent = outbox.persistIntent({ localJobId: f.job.id, owner: f.job.lease_owner, origin: 'https://processing.example', principalId: 'viewer-staging', environment: 'staging', envelope: envelope(f.task.id, f.attempt.id) });
  const calls = [];
  const client = new PreparedSubmissionClient({ origin: 'https://processing.example', bearerToken: 'synthetic-test-bearer-token-0001', principalId: 'viewer-staging', environment: 'staging', outbox,
    fetchImpl: async (_url, options) => {
      calls.push(options.method);
      return options.method === 'POST' ? responseJson({}, 201) : responseJson(remoteBinding(intent));
    },
  });
  const accepted = await client.dispatch(intent, { owner: f.job.lease_owner });
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.equal(accepted.remoteBinding.envelopeSha256, intent.envelopeSha256);
  assert.equal((await client.dispatch(intent, { owner: f.job.lease_owner })).state, 'accepted');
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.throws(() => f.database.prepare('UPDATE viewer_prepared_submission_outbox SET remote_binding_json=? WHERE submission_id=?').run('{}', intent.submissionId), /accepted prepared submission binding is immutable/);
});

test('mismatched remote GET cannot mark the durable outbox accepted', async t => {
  const f = fixture(t), outbox = new PreparedSubmissionOutbox(f.database);
  const intent = outbox.persistIntent({ localJobId: f.job.id, owner: f.job.lease_owner, origin: 'https://processing.example', principalId: 'viewer-staging', environment: 'staging', envelope: envelope(f.task.id, f.attempt.id) });
  const client = new PreparedSubmissionClient({ origin: 'https://processing.example', bearerToken: 'synthetic-test-bearer-token-0001', principalId: 'viewer-staging', environment: 'staging', outbox,
    fetchImpl: async (_url, options) => options.method === 'POST' ? responseJson({}, 201) : responseJson(remoteBinding(intent, { environment: 'production' })),
  });
  await assert.rejects(client.dispatch(intent, { owner: f.job.lease_owner }), { code: 'prepared_submission_binding_mismatch' });
  assert.equal(outbox.getIntent(f.attempt.id).state, 'prepared');
});

test('missing authenticated remote lookup keeps submission pending for exact retry', async t => {
  const f = fixture(t), outbox = new PreparedSubmissionOutbox(f.database);
  const intent = outbox.persistIntent({ localJobId: f.job.id, owner: f.job.lease_owner, origin: 'https://processing.example', principalId: 'viewer-staging', environment: 'staging', envelope: envelope(f.task.id, f.attempt.id) });
  const client = new PreparedSubmissionClient({ origin: 'https://processing.example', bearerToken: 'synthetic-test-bearer-token-0001', principalId: 'viewer-staging', environment: 'staging', outbox,
    fetchImpl: async (_url, options) => options.method === 'POST' ? responseJson({}, 201) : responseJson({ error: 'not_found' }, 404),
  });
  await assert.rejects(client.dispatch(intent, { owner: f.job.lease_owner }), { code: 'prepared_submission_not_found' });
  assert.equal(outbox.getIntent(f.attempt.id).state, 'prepared');
});

test('prepared client rejects non-HTTPS or non-origin configuration', () => {
  const base = { bearerToken: 'synthetic-test-bearer-token-0001', principalId: 'viewer-staging', environment: 'staging', outbox: {} };
  assert.throws(() => new PreparedSubmissionClient({ ...base, origin: 'http://processing.example' }), { code: 'prepared_submission_origin_invalid' });
  assert.throws(() => new PreparedSubmissionClient({ ...base, origin: 'https://processing.example/path' }), { code: 'prepared_submission_origin_invalid' });
  assert.throws(() => canonicalEnvelope({ ...envelope('C957e280-108b-48a9-9c51-c6480a5ff567', '9160ed62-e5e6-4319-b213-fce0b3c5602e') }), { code: 'prepared_envelope_invalid' });
});

test('HTTP requests have a bounded default timeout when no caller signal is supplied', async t => {
  const f = fixture(t), outbox = new PreparedSubmissionOutbox(f.database);
  const intent = outbox.persistIntent({ localJobId: f.job.id, owner: f.job.lease_owner, origin: 'https://processing.example', principalId: 'viewer-staging', environment: 'staging', envelope: envelope(f.task.id, f.attempt.id) });
  let observedAbort = false;
  const methods = [];
  const client = new PreparedSubmissionClient({ origin: 'https://processing.example', bearerToken: 'synthetic-test-bearer-token-0001', principalId: 'viewer-staging', environment: 'staging', timeoutMs: 100, outbox,
    fetchImpl: (_url, options) => { methods.push(options.method); return options.method === 'GET' ? responseJson({ error: 'not_found' }, 404) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(responseJson(remoteBinding(intent))), 1000);
      options.signal.addEventListener('abort', () => { observedAbort = true; clearTimeout(timer); reject(new Error('timed out')); }, { once: true });
    }); },
  });
  await assert.rejects(client.dispatch(intent, { owner: f.job.lease_owner }), { code: 'prepared_submission_transport_uncertain' });
  assert.deepEqual(methods, ['POST', 'GET']);
  assert.equal(observedAbort, true);
  assert.equal(outbox.getIntent(f.attempt.id).state, 'prepared');
});
