import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, createDecipheriv, privateDecrypt, constants, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProductionAutoJournal, readVerifiedProductionAutoPredecessor, sealProductionProviderResponse } from './production-auto-journal.mjs';
import { validateProductionAutoPredecessorProof } from './production-auto-predecessor.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const COMMIT = 'a'.repeat(40), RUNTIME = { profileSha256: '1'.repeat(64), moduleSha256: '2'.repeat(64), ledgerSha256: '3'.repeat(64) };

function github() {
  const refs = new Map(), commits = new Map(), trees = new Map(), blobs = new Map(), requests = [];
  let serial = 1, patchHook = null, nextPatchMode = null;
  trees.set('b'.repeat(40), { tree: [] });
  commits.set(COMMIT, { sha: COMMIT, tree: { sha: 'b'.repeat(40) }, parents: [] });
  commits.set('c'.repeat(40), { sha: 'c'.repeat(40), tree: { sha: 'b'.repeat(40) }, parents: [COMMIT] });
  const id = () => String(serial++).padStart(40, '0');
  const response = (status, value) => new Response(value === null ? '' : JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname.replace('/repos/ledgetoptechnologies/LedgeTop-Ops', ''), method = init.method ?? 'GET';
    requests.push({ method, path: p });
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (p.startsWith('/git/ref/heads/')) {
      const name = p.slice('/git/ref/heads/'.length);
      if (method === 'GET') return refs.has(name) ? response(200, { ref: `refs/heads/${name}`, object: { sha: refs.get(name) } }) : response(404, null);
    }
    if (p.startsWith('/git/refs/heads/') && method === 'PATCH') {
      const name = p.slice('/git/refs/heads/'.length);
      if (patchHook) await patchHook({ name, body });
      const current = refs.get(name), candidate = commits.get(body.sha), mode = nextPatchMode; nextPatchMode = null;
      if (!refs.has(name) || body.force !== false || candidate?.parents?.[0] !== current || mode === 'before-failure') return response(422, {});
      refs.set(name, body.sha);
      if (mode === 'after-failure') return response(500, {});
      return response(200, { object: { sha: body.sha } });
    }
    if (p === '/git/refs' && method === 'POST') { const name = body.ref.replace('refs/heads/', ''); if (refs.has(name)) return response(422, {}); refs.set(name, body.sha); return response(201, { object: { sha: body.sha } }); }
    if (p === '/git/blobs' && method === 'POST') { const bytes = Buffer.from(body.content, 'base64'), blob = id(); blobs.set(blob, bytes); return response(201, { sha: blob }); }
    if (p === '/git/trees' && method === 'POST') { const tree = id(); trees.set(tree, { tree: body.tree }); return response(201, { sha: tree }); }
    if (p === '/git/commits' && method === 'POST') { const commit = id(); commits.set(commit, { sha: commit, tree: { sha: body.tree }, parents: body.parents }); return response(201, { sha: commit }); }
    if (p.startsWith('/git/commits/')) { const c = commits.get(p.split('/').at(-1)); return c ? response(200, c) : response(404, {}); }
    if (p.startsWith('/git/trees/')) { const t = trees.get(p.split('/').at(-1)); return t ? response(200, t) : response(404, {}); }
    if (p.startsWith('/git/blobs/')) { const b = blobs.get(p.split('/').at(-1)); return b ? response(200, { encoding: 'base64', content: b.toString('base64'), size: b.length }) : response(404, {}); }
    return response(500, {});
  };
  return { fetchImpl, refs, commits, trees, blobs, requests,
    setPatchHook: value => { patchHook = value; }, setNextPatchMode: value => { nextPatchMode = value; } };
}

function recipient() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  return { schemaVersion: 1, keyIdSha256: sha(pair.publicKey.export({ type: 'spki', format: 'der' })), publicKeyPem: pem };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function tamperJournalOperation(api, workerName, mutate) {
  const head = api.refs.get(`ltds-production-auto-journal-${workerName}`);
  const commit = api.commits.get(head), tree = api.trees.get(commit.tree.sha);
  const entry = tree.tree.find(row => row.path === 'production-auto-journal.json');
  const original = api.blobs.get(entry.sha);
  const document = JSON.parse(original.toString('utf8'));
  mutate(document.operations.find(row => row.workerName === workerName));
  api.blobs.set(entry.sha, Buffer.from(`${canonical(document)}\n`));
  return () => api.blobs.set(entry.sha, original);
}
function journal(api, dir, changes = {}) {
  return new ProductionAutoJournal({ token: 'x'.repeat(32), workerName: 'ledgetop-clients', sourceCommit: changes.sourceCommit ?? COMMIT,
    ciRunId: changes.ciRunId ?? 100, ciRunAttempt: changes.ciRunAttempt ?? 2,
    workflowRunId: changes.workflowRunId ?? 123, workflowRunAttempt: 1,
    runtime: changes.runtime ?? RUNTIME, recipient: changes.recipient ?? recipient(), responseDirectory: dir,
    fetchImpl: changes.fetchImpl ?? api.fetchImpl, now: () => '2026-10-27T12:00:00.000Z' });
}
const intent = requestId => ({ requestId, method: 'POST', phase: 'activate-candidate', path: '/workers/scripts/ledgetop-clients/deployments',
  workerName: 'ledgetop-clients', automaticRetry: false, versions: [{ version_id: '11111111-1111-4111-8111-111111111111', percentage: 100 }] });

test('journal CAS persists an intent before a provider call and rejects same-release restart', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    const first = journal(api, dir); await first.recordIntent(intent('22222222-2222-4222-8222-222222222222'));
    assert.equal(first.snapshot().operations[0].intents.length, 1);
    assert.equal(api.refs.size, 1);
    const beforeRestart = api.requests.length;
    const restarted = journal(api, dir);
    await assert.rejects(restarted.recordIntent(intent('33333333-3333-4333-8333-333333333333')));
    const restartRequests = api.requests.slice(beforeRestart);
    assert.equal(restartRequests.length, 4, 'a fresh process fully reloads ref, commit, tree and blob before refusing replay');
    assert(restartRequests.every(row => row.method === 'GET'), 'duplicate release refusal has no write request');
    assert.equal(first.snapshot().operations[0].intents.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('claimed journal reuses its validated committed head and tree while writing every audit commit', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    const run = journal(api, dir);
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: COMMIT, status: 'started',
      phase: 'prepare', parentVersionId: '11111111-1111-4111-8111-111111111111', controlsSHA256: '4'.repeat(64), writesAttempted: false });
    assert.equal(api.requests.length, 6, 'initial claim performs one absent-ref read and five Git-data/ref requests');
    const name = `ops-ui-verify-${'a'.repeat(24)}`, sourceSHA256 = 'b'.repeat(64);
    const createId = '22222222-2222-4222-8222-222222222222';
    const createPath = `/workers/scripts/${name}`;
    const create = { requestId: createId, method: 'PUT', path: createPath, phase: 'temporary-verifier-create', name,
      workerName: 'ledgetop-clients', sourceSHA256, automaticRetry: false };
    let from = api.requests.length;
    await run.recordIntent(create);
    assert.equal(api.requests.length - from, 4, 'claimed intent uses cached commit/tree and still writes blob, tree, commit and CAS ref');
    const success = Buffer.from(JSON.stringify({ success: true, result: { id: name }, errors: [] }));
    from = api.requests.length;
    await run.persistResponse({ requestId: createId, method: 'PUT', path: createPath, status: 200, rawResponse: success });
    assert.equal(api.requests.length - from, 4, 'response gets its own immutable audit commit without reload reads');
    const enableId = '33333333-3333-4333-8333-333333333333';
    from = api.requests.length;
    await run.recordIntent({ requestId: enableId, method: 'POST', path: createPath, phase: 'temporary-verifier-enable', name,
      workerName: 'ledgetop-clients', sourceSHA256, automaticRetry: false });
    assert.equal(api.requests.length - from, 4, 'next intent retains its separate audit commit');
    assert.equal(api.requests.filter(row => row.method === 'PATCH').length, 3);
    assert.equal(run.snapshot().sequence, 4, 'each logical journal event advances the committed document sequence');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('snapshot mutation cannot alter the committed journal cache', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    const run = journal(api, dir);
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: COMMIT, status: 'started',
      phase: 'prepare', parentVersionId: '11111111-1111-4111-8111-111111111111', controlsSHA256: '4'.repeat(64), writesAttempted: false });
    const exposed = run.snapshot(); exposed.operations[0].receipts[0].phase = 'tampered';
    assert.equal(run.snapshot().operations[0].receipts[0].phase, 'prepare');
    await run.recordIntent(intent('22222222-2222-4222-8222-222222222222'));
    assert.equal(run.snapshot().operations[0].receipts[0].phase, 'prepare');
    assert.equal(run.snapshot().operations[0].intents.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('same-instance concurrent journal writers are rejected before a second request', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    let releaseFetch, enteredFetch; const gate = new Promise(resolve => { releaseFetch = resolve; });
    const entered = new Promise(resolve => { enteredFetch = resolve; }); let fetchCalls = 0;
    const fetchImpl = async (url, init) => {
      fetchCalls++;
      if (fetchCalls === 1) { enteredFetch(); await gate; }
      return api.fetchImpl(url, init);
    };
    const run = journal(api, dir, { fetchImpl });
    const first = run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: COMMIT, status: 'started',
      phase: 'prepare', parentVersionId: '11111111-1111-4111-8111-111111111111', controlsSHA256: '4'.repeat(64), writesAttempted: false });
    await entered;
    const before = fetchCalls;
    await assert.rejects(run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: COMMIT, status: 'started',
      phase: 'prepare', parentVersionId: '11111111-1111-4111-8111-111111111111', controlsSHA256: '4'.repeat(64), writesAttempted: false }));
    assert.equal(fetchCalls, before, 'concurrent operation is refused before it starts transport I/O');
    releaseFetch(); await first;
    assert.equal(run.snapshot().operations[0].receipts.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two stale journal snapshots race at non-force CAS and loser never rebases or resends', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    const base = journal(api, dir);
    await base.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: COMMIT, status: 'started',
      phase: 'prepare', parentVersionId: '11111111-1111-4111-8111-111111111111', controlsSHA256: '4'.repeat(64), writesAttempted: false });
    let arrivals = 0, release; const barrier = new Promise(resolve => { release = resolve; });
    api.setPatchHook(async () => { arrivals++; if (arrivals === 2) release(); await barrier; });
    const left = journal(api, dir, { sourceCommit: 'd'.repeat(40), ciRunId: 101, workflowRunId: 201 });
    const right = journal(api, dir, { sourceCommit: 'e'.repeat(40), ciRunId: 102, workflowRunId: 202 });
    const writes = await Promise.allSettled([
      left.recordIntent(intent('22222222-2222-4222-8222-222222222222')),
      right.recordIntent(intent('33333333-3333-4333-8333-333333333333')),
    ]);
    assert.equal(arrivals, 2);
    assert.equal(writes.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(writes.filter(row => row.status === 'rejected').length, 1);
    assert.equal(api.requests.filter(row => row.method === 'PATCH').length, 2, 'one non-force CAS per contender');
    const loser = writes[0].status === 'rejected' ? left : right;
    const beforeRetry = api.requests.length;
    await assert.rejects(loser.recordIntent(intent('44444444-4444-4444-8444-444444444444')));
    assert.equal(api.requests.length, beforeRetry, 'a failed CAS permanently holds this journal instance without rebase');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ambiguous CAS is accepted only when exact ref reads back own commit; mismatch stays held', async () => {
  const successApi = github(), successDir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  const failureApi = github(), failureDir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  const requestId = '22222222-2222-4222-8222-222222222222';
  const body = Buffer.from(JSON.stringify({ success: true, result: { id: 'v1' }, errors: [] }));
  try {
    const success = journal(successApi, successDir); await success.recordIntent(intent(requestId));
    successApi.setNextPatchMode('after-failure');
    await success.persistResponse({ requestId, method: 'POST', path: '/workers/scripts/ledgetop-clients/deployments', status: 200, rawResponse: body });
    assert.equal(success.snapshot().operations[0].responses.length, 1);
    assert.equal(successApi.requests.filter(row => row.method === 'PATCH').length, 1);
    const successPatchIndex = successApi.requests.findIndex(row => row.method === 'PATCH');
    assert.equal(successApi.requests[successPatchIndex + 1]?.path, '/git/ref/heads/ltds-production-auto-journal-ledgetop-clients',
      'ambiguous acknowledged update gets one exact-ref read and no resend');

    const failure = journal(failureApi, failureDir); await failure.recordIntent(intent(requestId));
    failureApi.setNextPatchMode('before-failure');
    await assert.rejects(failure.persistResponse({ requestId, method: 'POST', path: '/workers/scripts/ledgetop-clients/deployments', status: 200, rawResponse: body }));
    assert.equal(failure.snapshot().operations[0].responses.length, 0, 'failed local mutation never contaminates committed cache');
    const beforeRetry = failureApi.requests.length;
    await assert.rejects(failure.persistResponse({ requestId, method: 'POST', path: '/workers/scripts/ledgetop-clients/deployments', status: 200, rawResponse: body }));
    assert.equal(failureApi.requests.length, beforeRetry, 'ambiguous mismatch blocks any later write attempt');
  } finally { rmSync(successDir, { recursive: true, force: true }); rmSync(failureDir, { recursive: true, force: true }); }
});

test('release claim is durable before temporary verifier writes and binds candidate ledger once', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    const runtime = { profileSha256: '1'.repeat(64), moduleSha256: '2'.repeat(64), ledgerSha256: null };
    const run = journal(api, dir, { runtime });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: COMMIT, status: 'started',
      phase: 'prepare', parentVersionId: '11111111-1111-4111-8111-111111111111', controlsSHA256: '4'.repeat(64), writesAttempted: false });
    assert.equal(run.snapshot().operations[0].runtime.ledgerSha256, null);
    const requestId = '22222222-2222-4222-8222-222222222222';
    await run.recordIntent({ ...intent(requestId), phase: 'temporary-verifier-create' });
    await run.persistResponse({ requestId, method: 'POST', path: '/workers/scripts/ledgetop-clients/deployments', status: 200,
      rawResponse: Buffer.from(JSON.stringify({ success: true, result: { id: 'verifier' }, errors: [] })) });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: COMMIT, status: 'prepared',
      phase: 'prepare', ledgerSHA256: '5'.repeat(64), files: 2, minimumRetentionHours: 48, automaticPruning: false });
    assert.equal(run.snapshot().operations[0].runtime.ledgerSha256, '5'.repeat(64));
    await assert.rejects(run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: COMMIT, status: 'prepared',
      phase: 'prepare', ledgerSHA256: '6'.repeat(64), files: 2, minimumRetentionHours: 48, automaticPruning: false }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('response custody is ciphertext-only and durable acknowledgment gates the next intent', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    const run = journal(api, dir), requestId = '22222222-2222-4222-8222-222222222222';
    await run.recordIntent(intent(requestId));
    const raw = Buffer.from(JSON.stringify({ success: true, result: { id: 'private-response-marker' }, errors: [] }));
    await assert.rejects(run.persistResponse({ requestId, method: 'POST', path: '/workers/scripts/wrong/deployments', status: 200, rawResponse: raw }));
    await run.persistResponse({ requestId, method: 'POST', path: '/workers/scripts/ledgetop-clients/deployments', status: 200, rawResponse: raw });
    const stored = run.snapshot().operations[0].responses[0];
    assert.equal(stored.providerAcknowledged, true);
    assert.equal(stored.responseSha256, sha(raw));
    const encrypted = readFileSync(path.join(dir, stored.ciphertextFile));
    assert.equal(encrypted.includes(Buffer.from('private-response-marker')), false);
    assert.equal(JSON.parse(encrypted).context.requestId, requestId);
    await run.recordIntent(intent('33333333-3333-4333-8333-333333333333'));
    assert.equal(run.snapshot().operations[0].intents.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('distinct source release appends and unsuccessful release artifact is durably held', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    const first = journal(api, dir), requestId = '22222222-2222-4222-8222-222222222222';
    await first.recordIntent(intent(requestId));
    const body = Buffer.from(JSON.stringify({ success: true, result: { id: 'v1' }, errors: [] }));
    await first.persistResponse({ requestId, method: 'POST', path: '/workers/scripts/ledgetop-clients/deployments', status: 200, rawResponse: body });
    const newer = journal(api, dir, { sourceCommit: 'c'.repeat(40), ciRunId: 101, workflowRunId: 124 });
    await newer.recordIntent(intent('33333333-3333-4333-8333-333333333333'));
    assert.equal(newer.snapshot().operations.length, 2);
    const completion = journal(api, dir, { sourceCommit: 'c'.repeat(40), ciRunId: 101, workflowRunId: 124 });
    await completion.attachArtifact({ artifactId: 901, artifactDigest: 'd'.repeat(64), runId: 124, runAttempt: 1,
      name: `production-auto-${completion.releaseId}`, status: 'success', releaseStatus: 'failure' });
    assert.equal(completion.snapshot().operations.at(-1).artifact.digestSha256, 'd'.repeat(64));
    assert.equal(completion.snapshot().operations.at(-1).state, 'held');
    assert.equal(completion.snapshot().operations.at(-1).artifact.releaseStepConclusion, 'failure');
    await assert.rejects(readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32), workerName: 'ledgetop-clients',
      releaseKind: 'retained-assets', sourceCommit: 'c'.repeat(40), releaseId: completion.releaseId, ciRunId: 101, ciRunAttempt: 2,
      workflowRunId: 124, workflowRunAttempt: 1, fetchImpl: api.fetchImpl }));
    const duplicate = journal(api, dir, { sourceCommit: 'c'.repeat(40), ciRunId: 101, workflowRunId: 124 });
    await assert.rejects(duplicate.attachArtifact({ artifactId: 902, artifactDigest: 'e'.repeat(64), runId: 124, runAttempt: 1,
      name: `production-auto-${duplicate.releaseId}`, status: 'success', releaseStatus: 'success' }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('artifact completion verifies only after final proof, activation, verifier cleanup, and acknowledged writes', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    const run = journal(api, dir, { sourceCommit: 'c'.repeat(40), ciRunId: 101, workflowRunId: 124 });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: 'c'.repeat(40), status: 'started',
      phase: 'prepare', parentVersionId: '11111111-1111-4111-8111-111111111111', controlsSHA256: '4'.repeat(64), writesAttempted: false });
    const parent = '11111111-1111-4111-8111-111111111111', candidate = '22222222-2222-4222-8222-222222222222';
    const rows = [];
    const add = (phase, options = {}) => rows.push({ phase, ...options });
    const verifier = suffix => {
      const name = `ops-ui-verify-${suffix.repeat(24)}`;
      add('temporary-verifier-create', { name, method: 'PUT', workerName: 'ledgetop-clients', sourceSHA256: 'a'.repeat(64), path: `/workers/scripts/${name}` });
      add('temporary-verifier-enable', { name, path: `/workers/scripts/${name}/subdomain` });
      add('temporary-verifier-delete', { name, method: 'DELETE', path: `/workers/scripts/${name}` });
    };
    verifier('a'); // Active predecessor byte read.
    add('asset-session', { path: '/workers/scripts/ledgetop-clients/assets-upload-session', hashes: ['a'.repeat(32)] });
    add('asset-bucket', { path: '/workers/assets/upload?base64=true', hashes: ['a'.repeat(32)] });
    add('worker-version-upload', { workerName: 'ledgetop-clients', parentVersionId: parent,
      modules: { 'index.js': '2'.repeat(64), 'index.js.map': '4'.repeat(64), '__ops_release_ledger.json': '3'.repeat(64) },
      path: '/workers/scripts/ledgetop-clients/versions' });
    add('stage-zero-percent', { workerName: 'ledgetop-clients', parentVersionId: parent, candidateVersionId: candidate,
      versions: [{ version_id: parent, percentage: 100 }, { version_id: candidate, percentage: 0 }], path: '/workers/scripts/ledgetop-clients/deployments' });
    verifier('b'); // Candidate at zero percent.
    add('activate-candidate', { workerName: 'ledgetop-clients', parentVersionId: parent, candidateVersionId: candidate,
      versions: [{ version_id: candidate, percentage: 100 }], path: '/workers/scripts/ledgetop-clients/deployments' });
    verifier('c'); // Candidate after activation.
    for (const [index, row] of rows.entries()) {
      const requestId = `${String(index + 10).padStart(8, '0')}-2222-4222-8222-222222222222`;
      const method = row.method ?? 'POST', path = row.path;
      await run.recordIntent({ requestId, method, ...row, automaticRetry: false });
      await run.persistResponse({ requestId, method, path, status: 200,
        rawResponse: Buffer.from(JSON.stringify({ success: true, result: { id: `receipt-${index}` }, errors: [] })) });
    }
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: 'c'.repeat(40), status: 'prepared',
      phase: 'prepare', ledgerSHA256: '3'.repeat(64), files: 1, minimumRetentionHours: 48, automaticPruning: false,
      allHistoricalAssetsCarried: true });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: 'c'.repeat(40), status: 'inactive-verified',
      phase: 'candidate-readback', candidateVersionId: '22222222-2222-4222-8222-222222222222', ledgerSHA256: '3'.repeat(64) });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: 'c'.repeat(40), status: 'zero-percent-verified',
      phase: 'stage-zero', candidateVersionId: '22222222-2222-4222-8222-222222222222', deploymentId: '33333333-3333-4333-8333-333333333333' });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: 'c'.repeat(40), status: 'candidate-assets-verified',
      phase: 'candidate-assets', candidateVersionId: '22222222-2222-4222-8222-222222222222', ledgerSHA256: '3'.repeat(64) });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-clients', sourceCommit: 'c'.repeat(40), status: 'verified',
      phase: 'complete', verifiedActive: true, parentVersionId: parent, candidateVersionId: '22222222-2222-4222-8222-222222222222',
      deploymentId: '33333333-3333-4333-8333-333333333333', ledgerSHA256: '3'.repeat(64), files: 1,
      minimumRetentionHours: 48, automaticPruning: false,
      allHistoricalAssetsCarried: true, cutoverObservedAt: '2026-10-27T12:00:00.000Z',
      earliestPermittedPruningAt: '2026-10-29T12:00:00.000Z' });
    await run.attachArtifact({ artifactId: 903, artifactDigest: 'f'.repeat(64), runId: 124, runAttempt: 1,
      name: `production-auto-${run.releaseId}`, status: 'success', releaseStatus: 'success' });
    assert.equal(run.snapshot().operations[0].state, 'verified');
    assert.equal(run.snapshot().operations[0].artifact.releaseStepConclusion, 'success');
    assert.equal(run.snapshot().operations[0].responses.at(-1).status, 200);
    assert.equal(run.snapshot().operations[0].responses.at(-1).providerAcknowledged, true);
    const beforeRead = api.requests.length;
    const proof = await readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32), workerName: 'ledgetop-clients',
      releaseKind: 'retained-assets', sourceCommit: 'c'.repeat(40), releaseId: run.releaseId, ciRunId: 101, ciRunAttempt: 2,
      workflowRunId: 124, workflowRunAttempt: 1, fetchImpl: api.fetchImpl });
    assert.deepEqual(api.requests.slice(beforeRead).map(row => row.method), ['GET','GET','GET','GET']);
    assert.equal(proof.releaseId, run.releaseId);
    assert.equal(proof.runtime.moduleSha256, RUNTIME.moduleSha256);
    assert.equal(proof.artifact.uploadStepConclusion, 'success');
    assert.equal(proof.artifact.releaseStepConclusion, 'success');
    assert.equal(validateProductionAutoPredecessorProof(proof, { workerName: 'ledgetop-clients',
      releaseKind: 'retained-assets', sourceCommit: 'c'.repeat(40), releaseId: run.releaseId,
      ciRunId: 101, ciRunAttempt: 2, workflowRunId: 124, workflowRunAttempt: 1 }), proof,
    'the exact GET-only journal proof must pass the runtime predecessor validator');
    let resumeRead, enteredRead; const readGate = new Promise(resolve => { resumeRead = resolve; });
    const readEntered = new Promise(resolve => { enteredRead = resolve; }); let readCalls = 0;
    const blockingRead = async (url, init) => {
      readCalls++;
      if (readCalls === 1) { enteredRead(); await readGate; }
      return api.fetchImpl(url, init);
    };
    const reader = new ProductionAutoJournal({ token: 'x'.repeat(32), workerName: 'ledgetop-clients', releaseKind: 'retained-assets',
      sourceCommit: 'c'.repeat(40), ciRunId: 101, ciRunAttempt: 2, workflowRunId: 124, workflowRunAttempt: 1,
      recipient: recipient(), responseDirectory: dir, fetchImpl: blockingRead, now: () => '2026-10-27T12:00:00.000Z' });
    const read = reader.readVerifiedPredecessor({ sourceCommit: 'c'.repeat(40), releaseId: run.releaseId,
      releaseKind: 'retained-assets', ciRunId: 101, ciRunAttempt: 2, workflowRunId: 124, workflowRunAttempt: 1 });
    await readEntered;
    const callsBeforeWriter = readCalls, requestsBeforeWriter = api.requests.length;
    await assert.rejects(reader.attachArtifact({ artifactId: 904, artifactDigest: 'e'.repeat(64), runId: 124, runAttempt: 1,
      name: `production-auto-${run.releaseId}`, status: 'success', releaseStatus: 'success' }));
    assert.equal(readCalls, callsBeforeWriter, 'a write may not refresh shared cache while predecessor GETs are in flight');
    assert.equal(api.requests.length, requestsBeforeWriter);
    resumeRead(); assert.equal((await read).releaseId, run.releaseId);
    const tamperedArtifactProof = structuredClone(proof);
    tamperedArtifactProof.artifact.releaseStepConclusion = 'failure';
    assert.throws(() => validateProductionAutoPredecessorProof(tamperedArtifactProof, { workerName: 'ledgetop-clients',
      releaseKind: 'retained-assets', sourceCommit: 'c'.repeat(40), releaseId: run.releaseId,
      ciRunId: 101, ciRunAttempt: 2, workflowRunId: 124, workflowRunAttempt: 1 }));
    assert.equal(proof.finalReceipt.candidateVersionId, '22222222-2222-4222-8222-222222222222');
    assert.equal(proof.finalReceipt.deploymentId, '33333333-3333-4333-8333-333333333333');
    assert.equal(proof.finalReceipt.minimumRetentionHours, 48);
    const rejected = [
      { sourceCommit: 'a'.repeat(40), releaseId: run.releaseId },
      { sourceCommit: 'c'.repeat(40), releaseId: '0'.repeat(64) },
      { sourceCommit: 'c'.repeat(40), releaseId: run.releaseId, workflowRunId: 125 },
      { sourceCommit: 'c'.repeat(40), releaseId: run.releaseId, workflowRunAttempt: 2 },
      { sourceCommit: 'c'.repeat(40), releaseId: run.releaseId, ciRunId: 102 },
      { sourceCommit: 'c'.repeat(40), releaseId: run.releaseId, ciRunAttempt: 3 },
    ];
    for (const mismatch of rejected) await assert.rejects(readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32),
      workerName: 'ledgetop-clients', releaseKind: 'retained-assets', sourceCommit: mismatch.sourceCommit ?? 'c'.repeat(40),
      releaseId: mismatch.releaseId, ciRunId: mismatch.ciRunId ?? 101, ciRunAttempt: mismatch.ciRunAttempt ?? 2,
      workflowRunId: mismatch.workflowRunId ?? 124, workflowRunAttempt: mismatch.workflowRunAttempt ?? 1,
      fetchImpl: api.fetchImpl }));
    assert.ok(api.requests.slice(beforeRead).every(row => row.method === 'GET'));
    for (const tamper of [
      operation => { operation.intents = []; },
      operation => { operation.responses[0].providerAcknowledged = false; },
    ]) {
      const restore = tamperJournalOperation(api, 'ledgetop-clients', tamper);
      try {
        await assert.rejects(readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32), workerName: 'ledgetop-clients',
          releaseKind: 'retained-assets', sourceCommit: 'c'.repeat(40), releaseId: run.releaseId,
          ciRunId: 101, ciRunAttempt: 2, workflowRunId: 124, workflowRunAttempt: 1, fetchImpl: api.fetchImpl }));
      } finally { restore(); }
    }
    for (const phase of ['asset-session','worker-version-upload','stage-zero-percent','activate-candidate']) {
      const restore = tamperJournalOperation(api, 'ledgetop-clients', operation => {
        const removed = operation.intents.find(row => row.phase === phase);
        operation.intents = operation.intents.filter(row => row !== removed);
        operation.intents.forEach((row, index) => { row.sequence = index + 1; });
        operation.responses = operation.responses.filter(row => row.requestId !== removed.requestId);
      });
      try {
        await assert.rejects(readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32), workerName: 'ledgetop-clients',
          releaseKind: 'retained-assets', sourceCommit: 'c'.repeat(40), releaseId: run.releaseId,
          ciRunId: 101, ciRunAttempt: 2, workflowRunId: 124, workflowRunAttempt: 1, fetchImpl: api.fetchImpl }), phase);
      } finally { restore(); }
    }
    const wrongCreateMethod = tamperJournalOperation(api, 'ledgetop-clients', operation => {
      operation.intents.find(row => row.phase === 'temporary-verifier-create').method = 'POST';
    });
    try {
      await assert.rejects(readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32), workerName: 'ledgetop-clients',
        releaseKind: 'retained-assets', sourceCommit: 'c'.repeat(40), releaseId: run.releaseId,
        ciRunId: 101, ciRunAttempt: 2, workflowRunId: 124, workflowRunAttempt: 1, fetchImpl: api.fetchImpl }),
      'temporary verifier creation must retain the provider PUT method');
    } finally { wrongCreateMethod(); }
    const wrongDeleteResponse = tamperJournalOperation(api, 'ledgetop-clients', operation => {
      const deletion = operation.intents.find(row => row.phase === 'temporary-verifier-delete');
      const response = operation.responses.find(row => row.requestId === deletion.requestId);
      response.status = 404;
      response.providerAcknowledged = false;
    });
    try {
      await assert.rejects(readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32), workerName: 'ledgetop-clients',
        releaseKind: 'retained-assets', sourceCommit: 'c'.repeat(40), releaseId: run.releaseId,
        ciRunId: 101, ciRunAttempt: 2, workflowRunId: 124, workflowRunAttempt: 1, fetchImpl: api.fetchImpl }),
      'the separate verifier-absence GET cannot acknowledge a failed DELETE');
    } finally { wrongDeleteResponse(); }
    await assert.rejects(readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32), workerName: 'ledgetop-clients',
      releaseKind: 'backend-sync', sourceCommit: 'c'.repeat(40), releaseId: run.releaseId,
      ciRunId: 101, ciRunAttempt: 2, workflowRunId: 124, workflowRunAttempt: 1, fetchImpl: api.fetchImpl }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('read-only predecessor lookup is rejected before I/O while a local journal write is active', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    let resumeWrite, enteredWrite; const writeGate = new Promise(resolve => { resumeWrite = resolve; });
    const writeEntered = new Promise(resolve => { enteredWrite = resolve; }); let fetchCalls = 0;
    const blockingWrite = async (url, init) => {
      fetchCalls++;
      if (fetchCalls === 1) { enteredWrite(); await writeGate; }
      return api.fetchImpl(url, init);
    };
    const run = journal(api, dir, { fetchImpl: blockingWrite });
    const write = run.recordIntent(intent('22222222-2222-4222-8222-222222222222'));
    await writeEntered;
    const callsBeforeRead = fetchCalls, requestsBeforeRead = api.requests.length;
    await assert.rejects(run.readVerifiedPredecessor({ sourceCommit: COMMIT,
      releaseId: sha(`ledgetop-clients\n${COMMIT}`), releaseKind: 'retained-assets',
      ciRunId: 100, ciRunAttempt: 2, workflowRunId: 123, workflowRunAttempt: 1 }));
    assert.equal(fetchCalls, callsBeforeRead, 'a predecessor read may not race a local CAS write');
    assert.equal(api.requests.length, requestsBeforeRead);
    resumeWrite(); await write;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('seal primitive binds ciphertext to request context and rejects an unpinned recipient', () => {
  const target = recipient(), bytes = Buffer.from('opaque provider body');
  const result = sealProductionProviderResponse(bytes, { releaseId: sha('release'), requestId: '22222222-2222-4222-8222-222222222222',
    method: 'POST', pathSha256: sha('/workers/scripts/ledgetop-clients/deployments'), status: 200 },
  { schemaVersion: 1, keyIdSha256: target.keyIdSha256, publicKeyPem: target.publicKeyPem });
  assert.equal(result.plaintextSha256, sha(bytes));
  assert.equal(result.bytes.includes(bytes), false);
  assert.throws(() => sealProductionProviderResponse(bytes, { releaseId: sha('release'), requestId: '22222222-2222-4222-8222-222222222222',
    method: 'POST', pathSha256: sha('/x'), status: 200 }, { schemaVersion: 1, keyIdSha256: '0'.repeat(64), publicKeyPem: '' }));
});

test('default recipient loader returns the pinned record accepted by journal and seal', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-loader-'));
  try {
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const fixtureRecipient = {
      schemaVersion: 1,
      keyIdSha256: sha(pair.publicKey.export({ type: 'spki', format: 'der' })),
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    };
    const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
    writeFileSync(path.join(directory, 'production-auto-private-recipient.mjs'),
      `export const PRODUCTION_AUTO_JOURNAL_RECIPIENT = Object.freeze(${JSON.stringify(fixtureRecipient)});\n`);
    writeFileSync(path.join(directory, 'production-auto-time.mjs'), readFileSync(path.join(sourceDirectory, 'production-auto-time.mjs')));
    writeFileSync(path.join(directory, 'production-auto-limits.mjs'), readFileSync(path.join(sourceDirectory, 'production-auto-limits.mjs')));
    writeFileSync(path.join(directory, 'production-auto-journal.mjs'), readFileSync(path.join(sourceDirectory, 'production-auto-journal.mjs')));

    const fixtureModule = await import(`${pathToFileURL(path.join(directory, 'production-auto-journal.mjs')).href}?fixture=${randomUUID()}`);
    const loaded = fixtureModule.loadPinnedProductionAutoRecipient();
    assert.deepEqual(loaded, fixtureRecipient);
    assert.deepEqual(Reflect.ownKeys(loaded).sort(), ['keyIdSha256', 'publicKeyPem', 'schemaVersion']);
    assert.equal(Object.getPrototypeOf(loaded), Object.prototype);
    assert.equal(Object.isFrozen(loaded), true);

    const run = new fixtureModule.ProductionAutoJournal({
      token: 'x'.repeat(32), workerName: 'ledgetop-clients', sourceCommit: COMMIT,
      ciRunId: 100, ciRunAttempt: 1, workflowRunId: 123, workflowRunAttempt: 1,
      recipient: loaded, responseDirectory: directory,
    });
    assert.equal(run.snapshot(), null);

    const context = { releaseId: sha('loader-release'), requestId: '22222222-2222-4222-8222-222222222222',
      method: 'POST', pathSha256: sha('/workers/scripts/ledgetop-clients/deployments'), status: 200 };
    const plaintext = Buffer.from('ephemeral default-loader roundtrip');
    const sealed = fixtureModule.sealProductionProviderResponse(plaintext, context, loaded);
    const envelope = JSON.parse(sealed.bytes.toString('utf8'));
    const aad = Buffer.from(canonical({ schemaVersion: 1, algorithm: 'RSA-OAEP-256+A256GCM',
      keyId: fixtureRecipient.keyIdSha256, context }));
    const dataKey = privateDecrypt({ key: pair.privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(envelope.wrappedKey, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const recovered = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    assert.deepEqual(recovered, plaintext);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Ops Sync backend journal has only upload and activation writes, then verifies artifact association', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-sync-journal-'));
  const parent = '11111111-1111-4111-8111-111111111111';
  const candidate = '22222222-2222-4222-8222-222222222222';
  const deployment = '33333333-3333-4333-8333-333333333333';
  const runtime = { profileSha256: '1'.repeat(64), moduleSha256: '2'.repeat(64), ledgerSha256: null };
  const run = new ProductionAutoJournal({ token: 'x'.repeat(32), workerName: 'ledgetop-ops-sync', releaseKind: 'backend-sync',
    sourceCommit: COMMIT, ciRunId: 100, ciRunAttempt: 2, workflowRunId: 123, workflowRunAttempt: 1,
    runtime, recipient: recipient(), responseDirectory: dir, fetchImpl: api.fetchImpl, now: () => '2026-10-27T12:00:00.000Z' });
  const response = async (requestId, path, body) => run.persistResponse({ requestId, method: 'POST', path, status: 200,
    rawResponse: Buffer.from(JSON.stringify({ success: true, result: body, errors: [] })) });
  try {
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-ops-sync', sourceCommit: COMMIT, status: 'started',
      phase: 'sync-prepare', parentVersionId: parent, controlsSHA256: '4'.repeat(64), writesAttempted: false });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-ops-sync', sourceCommit: COMMIT, status: 'prepared',
      phase: 'sync-prepare', parentVersionId: parent, controlsSHA256: '4'.repeat(64), moduleSHA256: runtime.moduleSha256 });
    const uploadId = '44444444-4444-4444-8444-444444444444';
    const uploadPath = '/workers/scripts/ledgetop-ops-sync/versions?bindings_inherit=strict';
    await run.recordIntent({ requestId: uploadId, method: 'POST', path: uploadPath, phase: 'sync-version-upload',
      workerName: 'ledgetop-ops-sync', parentVersionId: parent, modules: { 'index.js': runtime.moduleSha256, 'index.js.map': '5'.repeat(64) },
      hashes: [], automaticRetry: false });
    await response(uploadId, uploadPath, { id: candidate });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-ops-sync', sourceCommit: COMMIT, status: 'inactive-verified',
      phase: 'sync-candidate-readback', parentVersionId: parent, candidateVersionId: candidate,
      controlsSHA256: '4'.repeat(64), moduleSHA256: runtime.moduleSha256 });
    const activationId = '55555555-5555-4555-8555-555555555555';
    const activationPath = '/workers/scripts/ledgetop-ops-sync/deployments';
    await run.recordIntent({ requestId: activationId, method: 'POST', path: activationPath, phase: 'sync-activate-candidate',
      workerName: 'ledgetop-ops-sync', parentVersionId: parent, candidateVersionId: candidate,
      versions: [{ version_id: candidate, percentage: 100 }], hashes: [], automaticRetry: false });
    await response(activationId, activationPath, { id: deployment });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-ops-sync', sourceCommit: COMMIT, status: 'verified',
      phase: 'sync-verify', parentVersionId: parent, candidateVersionId: candidate, deploymentId: deployment,
      controlsSHA256: '4'.repeat(64), moduleSHA256: runtime.moduleSha256, verifiedActive: true, writesAttempted: true });
    await run.attachArtifact({ artifactId: 904, artifactDigest: 'f'.repeat(64), runId: 123, runAttempt: 1,
      name: `production-auto-${run.releaseId}`, status: 'success', releaseStatus: 'success' });
    const operation = run.snapshot().operations[0];
    assert.equal(operation.releaseKind, 'backend-sync');
    assert.deepEqual(operation.intents.map(row => row.phase), ['sync-version-upload','sync-activate-candidate']);
    assert.deepEqual(operation.receipts.map(row => row.status), ['started','prepared','inactive-verified','verified']);
    assert.equal(operation.runtime.ledgerSha256, null);
    assert.equal(operation.state, 'verified');
    const proof = await readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32), workerName: 'ledgetop-ops-sync',
      releaseKind: 'backend-sync', sourceCommit: COMMIT, releaseId: run.releaseId, ciRunId: 100, ciRunAttempt: 2,
      workflowRunId: 123, workflowRunAttempt: 1, fetchImpl: api.fetchImpl });
    assert.equal(proof.finalReceipt.moduleSHA256, runtime.moduleSha256);
    assert.equal(proof.finalReceipt.candidateVersionId, candidate);
    await assert.rejects(readVerifiedProductionAutoPredecessor({ token: 'x'.repeat(32), workerName: 'ledgetop-ops-sync',
      releaseKind: 'retained-assets', sourceCommit: COMMIT, releaseId: run.releaseId, ciRunId: 100, ciRunAttempt: 2,
      workflowRunId: 123, workflowRunAttempt: 1, fetchImpl: api.fetchImpl }));
    const restarted = new ProductionAutoJournal({ token: 'x'.repeat(32), workerName: 'ledgetop-ops-sync', releaseKind: 'backend-sync',
      sourceCommit: COMMIT, ciRunId: 100, ciRunAttempt: 2, workflowRunId: 123, workflowRunAttempt: 1,
      runtime, recipient: recipient(), responseDirectory: dir, fetchImpl: api.fetchImpl });
    await assert.rejects(restarted.recordIntent({ requestId: '66666666-6666-4666-8666-666666666666', method: 'POST',
      path: activationPath, phase: 'sync-activate-candidate', workerName: 'ledgetop-ops-sync', parentVersionId: parent,
      candidateVersionId: candidate, versions: [{ version_id: candidate, percentage: 100 }], hashes: [], automaticRetry: false }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Ops Sync ambiguous upload remains held and same-source retry cannot append another mutation', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-sync-held-'));
  const parent = '11111111-1111-4111-8111-111111111111';
  const runtime = { profileSha256: '1'.repeat(64), moduleSha256: '2'.repeat(64), ledgerSha256: null };
  const create = () => new ProductionAutoJournal({ token: 'x'.repeat(32), workerName: 'ledgetop-ops-sync', releaseKind: 'backend-sync',
    sourceCommit: COMMIT, ciRunId: 100, ciRunAttempt: 2, workflowRunId: 123, workflowRunAttempt: 1,
    runtime, recipient: recipient(), responseDirectory: dir, fetchImpl: api.fetchImpl, now: () => '2026-10-27T12:00:00.000Z' });
  try {
    const run = create();
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-ops-sync', sourceCommit: COMMIT, status: 'started',
      phase: 'sync-prepare', parentVersionId: parent, controlsSHA256: '4'.repeat(64), writesAttempted: false });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-ops-sync', sourceCommit: COMMIT, status: 'prepared',
      phase: 'sync-prepare', parentVersionId: parent, controlsSHA256: '4'.repeat(64), moduleSHA256: runtime.moduleSha256 });
    await run.recordIntent({ requestId: '77777777-7777-4777-8777-777777777777', method: 'POST',
      path: '/workers/scripts/ledgetop-ops-sync/versions?bindings_inherit=strict', phase: 'sync-version-upload',
      workerName: 'ledgetop-ops-sync', parentVersionId: parent,
      modules: { 'index.js': runtime.moduleSha256, 'index.js.map': '5'.repeat(64) }, hashes: [], automaticRetry: false });
    await run.receipt({ schemaVersion: 1, workerName: 'ledgetop-ops-sync', sourceCommit: COMMIT, status: 'held',
      phase: 'sync-upload', parentVersionId: parent, controlsSHA256: '4'.repeat(64), moduleSHA256: runtime.moduleSha256,
      writesAttempted: true, failureCode: 'release_sync_upload_failed', reconciliationCode: 'read_succeeded',
      reconciliation: { readSucceeded: true, activeVersionId: parent, latestVersionId: parent,
        deploymentId: parent, controlsUnchanged: true } });
    const op = run.snapshot().operations[0];
    assert.equal(op.state, 'held'); assert.equal(op.intents.length, 1); assert.equal(op.intents[0].phase, 'sync-version-upload');
    assert.equal(op.receipts.at(-1).failureCode, 'release_sync_upload_failed');
    const restart = create();
    await assert.rejects(restart.recordIntent({ requestId: '88888888-8888-4888-8888-888888888888', method: 'POST',
      path: '/workers/scripts/ledgetop-ops-sync/versions?bindings_inherit=strict', phase: 'sync-version-upload',
      workerName: 'ledgetop-ops-sync', parentVersionId: parent,
      modules: { 'index.js': runtime.moduleSha256, 'index.js.map': '5'.repeat(64) }, hashes: [], automaticRetry: false }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
