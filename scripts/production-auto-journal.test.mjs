import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProductionAutoJournal, sealProductionProviderResponse } from './production-auto-journal.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const COMMIT = 'a'.repeat(40), RUNTIME = { profileSha256: '1'.repeat(64), moduleSha256: '2'.repeat(64), ledgerSha256: '3'.repeat(64) };

function github() {
  const refs = new Map(), commits = new Map(), trees = new Map(), blobs = new Map(); let serial = 1;
  trees.set('b'.repeat(40), { tree: [] });
  commits.set(COMMIT, { sha: COMMIT, tree: { sha: 'b'.repeat(40) }, parents: [] });
  commits.set('c'.repeat(40), { sha: 'c'.repeat(40), tree: { sha: 'b'.repeat(40) }, parents: [COMMIT] });
  const id = () => String(serial++).padStart(40, '0');
  const response = (status, value) => new Response(value === null ? '' : JSON.stringify(value), { status,
    headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname.replace('/repos/ledgetoptechnologies/LedgeTop-Ops', ''), method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (p.startsWith('/git/ref/heads/')) {
      const name = p.slice('/git/ref/heads/'.length);
      if (method === 'GET') return refs.has(name) ? response(200, { ref: `refs/heads/${name}`, object: { sha: refs.get(name) } }) : response(404, null);
    }
    if (p.startsWith('/git/refs/heads/') && method === 'PATCH') { const name = p.slice('/git/refs/heads/'.length); if (!refs.has(name) || body.force !== false) return response(404, {}); refs.set(name, body.sha); return response(200, { object: { sha: body.sha } }); }
    if (p === '/git/refs' && method === 'POST') { const name = body.ref.replace('refs/heads/', ''); if (refs.has(name)) return response(422, {}); refs.set(name, body.sha); return response(201, { object: { sha: body.sha } }); }
    if (p === '/git/blobs' && method === 'POST') { const bytes = Buffer.from(body.content, 'base64'), blob = id(); blobs.set(blob, bytes); return response(201, { sha: blob }); }
    if (p === '/git/trees' && method === 'POST') { const tree = id(); trees.set(tree, { tree: body.tree }); return response(201, { sha: tree }); }
    if (p === '/git/commits' && method === 'POST') { const commit = id(); commits.set(commit, { sha: commit, tree: { sha: body.tree }, parents: body.parents }); return response(201, { sha: commit }); }
    if (p.startsWith('/git/commits/')) { const c = commits.get(p.split('/').at(-1)); return c ? response(200, c) : response(404, {}); }
    if (p.startsWith('/git/trees/')) { const t = trees.get(p.split('/').at(-1)); return t ? response(200, t) : response(404, {}); }
    if (p.startsWith('/git/blobs/')) { const b = blobs.get(p.split('/').at(-1)); return b ? response(200, { encoding: 'base64', content: b.toString('base64'), size: b.length }) : response(404, {}); }
    return response(500, {});
  };
  return { fetchImpl, refs, commits, trees, blobs };
}

function recipient() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  return { schemaVersion: 1, keyIdSha256: sha(pair.publicKey.export({ type: 'spki', format: 'der' })), publicKeyPem: pem };
}
function journal(api, dir, changes = {}) {
  return new ProductionAutoJournal({ token: 'x'.repeat(32), workerName: 'ledgetop-clients', sourceCommit: changes.sourceCommit ?? COMMIT,
    ciRunId: changes.ciRunId ?? 100, ciRunAttempt: changes.ciRunAttempt ?? 2,
    workflowRunId: changes.workflowRunId ?? 123, workflowRunAttempt: 1,
    runtime: changes.runtime ?? RUNTIME, recipient: changes.recipient ?? recipient(), responseDirectory: dir,
    fetchImpl: api.fetchImpl, now: () => '2026-10-27T12:00:00.000Z' });
}
const intent = requestId => ({ requestId, method: 'POST', phase: 'activate-candidate', path: '/workers/scripts/ledgetop-clients/deployments',
  workerName: 'ledgetop-clients', automaticRetry: false, versions: [{ version_id: '11111111-1111-4111-8111-111111111111', percentage: 100 }] });

test('journal CAS persists an intent before a provider call and rejects same-release restart', async () => {
  const api = github(), dir = mkdtempSync(path.join(os.tmpdir(), 'auto-journal-'));
  try {
    const first = journal(api, dir); await first.recordIntent(intent('22222222-2222-4222-8222-222222222222'));
    assert.equal(first.snapshot().operations[0].intents.length, 1);
    assert.equal(api.refs.size, 1);
    const restarted = journal(api, dir);
    await assert.rejects(restarted.recordIntent(intent('33333333-3333-4333-8333-333333333333')));
    assert.equal(first.snapshot().operations[0].intents.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    const phases = ['activate-candidate','temporary-verifier-create','temporary-verifier-enable','temporary-verifier-delete'];
    for (const [index, phase] of phases.entries()) {
      const requestId = `${String(index + 10).padStart(8, '0')}-2222-4222-8222-222222222222`;
      const deletionAbsent = phase === 'temporary-verifier-delete';
      await run.recordIntent({ ...intent(requestId), phase, ...(deletionAbsent ? { method: 'DELETE' } : {}) });
      await run.persistResponse({ requestId, method: deletionAbsent ? 'DELETE' : 'POST', path: '/workers/scripts/ledgetop-clients/deployments',
        status: deletionAbsent ? 404 : 200, rawResponse: deletionAbsent ? Buffer.alloc(0)
          : Buffer.from(JSON.stringify({ success: true, result: { id: `receipt-${index}` }, errors: [] })) });
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
      phase: 'complete', verifiedActive: true, candidateVersionId: '22222222-2222-4222-8222-222222222222',
      deploymentId: '33333333-3333-4333-8333-333333333333', ledgerSHA256: '3'.repeat(64), files: 1,
      minimumRetentionHours: 48, automaticPruning: false,
      allHistoricalAssetsCarried: true, cutoverObservedAt: '2026-10-27T12:00:00.000Z',
      earliestPermittedPruningAt: '2026-10-29T12:00:00.000Z' });
    await run.attachArtifact({ artifactId: 903, artifactDigest: 'f'.repeat(64), runId: 124, runAttempt: 1,
      name: `production-auto-${run.releaseId}`, status: 'success', releaseStatus: 'success' });
    assert.equal(run.snapshot().operations[0].state, 'verified');
    assert.equal(run.snapshot().operations[0].artifact.releaseStepConclusion, 'success');
    assert.equal(run.snapshot().operations[0].responses.at(-1).status, 404);
    assert.equal(run.snapshot().operations[0].responses.at(-1).providerAcknowledged, true);
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
