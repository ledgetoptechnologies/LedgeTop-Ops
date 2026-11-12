import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { compileProtectedTransferPlan } from './staging-protected-transfer.mjs';
import { createStagingD1ExportCustody } from './staging-d1-export-custody.mjs';

const plan = compileProtectedTransferPlan({ runId: '550e8400-e29b-41d4-a716-446655440000', reviewedInputSha256: 'a'.repeat(64), quietWindowSha256: 'b'.repeat(64), sourceSnapshotSha256: 'c'.repeat(64), operationsMigrationChainSha256: 'd'.repeat(64), portalMigrationChainSha256: 'e'.repeat(64) });
const hash = b => createHash('sha256').update(b).digest('hex');
const APIURL = 'https://api.cloudflare.com/client/v4/accounts/846c924bf17bf4f3dd15c97a4c5d1d51/d1/database/78b34173-b168-4e3d-9832-bb9d245cc6b8/export';
const response = (result, status = 200, url = APIURL, extra = {}) => ({ status, rawResponseBytes: Buffer.from(JSON.stringify({ success: true, errors: [], result })), redirected: false, finalURL: url, ...extra });
async function fixture(queue, { proofOverride, sealerOverride, recordOverride } = {}) {
  const journal = [], requests = [], encrypted = new Map(), key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const record = async e => { journal.push(e); return recordOverride ? recordOverride(e) : true; };
  const sealRawResponse = async ({ rawResponseBytes, destination, context }) => {
    if (sealerOverride) return sealerOverride({ rawResponseBytes, destination, context });
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const aad = Buffer.from(JSON.stringify(context));
    const cipher = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, rawResponseBytes));
    const receiptRef = hash(Buffer.from(`${destination}|${JSON.stringify(context)}`));
    const digest = hash(cipher);
    encrypted.set(receiptRef, { iv, cipher, digest, context });
    return { verified: true, digest, receiptRef };
  };
  const validateProof = async p => {
    if (p.proof !== undefined && p.proof?.recovered !== true) return { verified: false };
    if (proofOverride) return proofOverride(p);
    const stored = encrypted.get(p.receiptRef);
    const context = { schema: 'staging-d1-export-response/v1', actionId: p.actionId, requestSha256: p.requestSha256, responseSha256: p.responseSha256, httpStatus: p.httpStatus, bindingSha256: p.bindingSha256 };
    if (!stored || stored.digest !== p.sealedDigest || JSON.stringify(stored.context) !== JSON.stringify(context) || p.responseSha256 !== hash(p.rawResponseBytes)) return { verified: false };
    const plain = Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv, additionalData: Buffer.from(JSON.stringify(context)) }, key, stored.cipher));
    try {
      return { verified: plain.equals(Buffer.from(p.rawResponseBytes)), actionId: p.actionId, requestSha256: p.requestSha256,
        responseSha256: p.responseSha256, httpStatus: p.httpStatus, sealedDigest: p.sealedDigest,
        receiptRef: p.receiptRef, bindingSha256: p.bindingSha256 };
    } finally { plain.fill(0); }
  };
  const c = createStagingD1ExportCustody({ plan, role: 'operations', downloadOrigin: 'https://downloads.example/',
    transport: async req => { requests.push(req); const value = queue.shift(); if (value instanceof Error) throw value; return typeof value === 'function' ? value(req) : value; },
    sealRawResponse, validateProof, record });
  return { c, journal, requests, encrypted, sealRawResponse };
}
const active = (bm = 'bookmark') => response({ at_bookmark: bm });
const completion = (bm = 'bookmark', url = 'https://downloads.example/private?sig=secret') => response({ at_bookmark: bm, status: 'complete', success: true, type: 'export', result: { signed_url: url, filename: 'private.sql' } });

test('one intent per unique action, identical bookmark, sealed response, private capability and bounded transport', async () => {
  const { c, requests, journal } = await fixture([active('bm-secret'), completion('bm-secret')]);
  assert.equal((await c.start()).status, 'export-polling');
  const done = await c.poll();
  assert.equal(done.status, 'export-capability-sealed');
  assert.equal(JSON.stringify(done).includes('secret'), false);
  assert.equal(JSON.stringify(c.state()).includes('bm-secret'), false);
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].body).current_bookmark, 'bm-secret');
  assert.equal(requests[1].redirect, 'error');
  assert.equal(requests[1].credentials, 'omit');
  assert.equal(requests[1].maxResponseBytes, 1024 * 1024);
  assert.equal(requests[1].cancelOnLimit, true);
  assert.equal(journal.filter(x => x.phase === 'intent').length, 2);
  assert.equal(new Set(journal.filter(x => x.phase === 'intent').map(x => x.actionId)).size, 2);
  assert.equal(journal.some(x => Object.values(x).some(v => String(v).includes('secret') || String(v).includes('bookmark'))), false);
  await assert.rejects(c.start(), /d1_start_refused/);
});

test('synchronous busy gate prevents duplicate concurrent start while intent await is pending', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const f = await fixture([active()], { recordOverride: async entry => { if (entry.phase === 'intent') await gate; return true; } });
  const first = f.c.start();
  assert.equal(f.c.state().status, 'in-flight');
  await assert.rejects(f.c.start(), /d1_start_refused/);
  release(); await first;
  assert.equal(f.requests.length, 1);
  assert.equal(f.journal.filter(x => x.phase === 'intent').length, 1);
});

test('normal response proof failure prevents custody advance and blocks', async () => {
  const f = await fixture([active()], { proofOverride: async () => ({ verified: false }) });
  await assert.rejects(f.c.start(), /d1_response_custody_unknown/);
  assert.equal(f.c.state().status, 'needs-reconciliation');
  assert.equal(f.journal.some(x => x.phase === 'custodied'), false);
});

test('transport uncertainty reconciles by opaque action id and does not reissue', async () => {
  const f = await fixture([new Error('private provider text')]);
  await assert.rejects(f.c.start(), /d1_outcome_unknown/);
  const actionId = f.journal.find(x => x.phase === 'intent').actionId;
  const rawResponseBytes = active().rawResponseBytes;
  const context = { schema: 'staging-d1-export-response/v1', actionId, requestSha256: f.journal.find(x => x.phase === 'intent').requestSha256, responseSha256: hash(rawResponseBytes), httpStatus: 200, bindingSha256: f.c.binding && hash(Buffer.from(JSON.stringify(f.c.binding))) };
  const sealed = await f.sealRawResponse({ rawResponseBytes: Buffer.from(rawResponseBytes), destination: actionId, context });
  // A failed proof must leave the same request blocked; no caller URL/body is accepted.
  await assert.rejects(f.c.reconcile({ actionId, responseStatus: 200, rawResponseBytes, sealedDigest: sealed.digest, receiptRef: sealed.receiptRef, proof: {} }), /d1_reconcile_refused/);
  assert.equal(f.c.state().status, 'needs-reconciliation');
  assert.equal(f.requests.length, 1);
});

test('receipt bound to a different action or HTTP status cannot reconcile', async () => {
  const f = await fixture([new Error('uncertain')]);
  await assert.rejects(f.c.start(), /d1_outcome_unknown/);
  const actionId = f.journal.find(x => x.phase === 'intent').actionId;
  const rawResponseBytes = active().rawResponseBytes;
  const context = { schema: 'staging-d1-export-response/v1', actionId, requestSha256: f.journal.find(x => x.phase === 'intent').requestSha256, responseSha256: hash(rawResponseBytes), httpStatus: 200, bindingSha256: hash(Buffer.from(JSON.stringify(f.c.binding))) };
  const sealed = await f.sealRawResponse({ rawResponseBytes: Buffer.from(rawResponseBytes), destination: actionId, context });
  await assert.rejects(f.c.reconcile({ actionId: `${actionId}x`, responseStatus: 200, rawResponseBytes, sealedDigest: sealed.digest, receiptRef: sealed.receiptRef, proof: { recovered: true } }), /d1_reconcile_refused/);
  await assert.rejects(f.c.reconcile({ actionId, responseStatus: 202, rawResponseBytes, sealedDigest: sealed.digest, receiptRef: sealed.receiptRef, proof: { recovered: true } }), /d1_reconcile_refused/);
  assert.equal(f.c.state().status, 'needs-reconciliation');
});

test('custody journal failure after provider response blocks and prevents repeat', async () => {
  const f = await fixture([active()], { recordOverride: async e => e.phase !== 'custodied' });
  await assert.rejects(f.c.start(), /d1_response_custody_unknown/);
  assert.equal(f.c.state().status, 'needs-reconciliation');
  assert.equal(f.requests.length, 1);
  await assert.rejects(f.c.start(), /d1_start_refused/);
});

test('valid same-action reconciliation consumes sealed response proof without another transport call', async () => {
  const f = await fixture([new Error('uncertain')]);
  await assert.rejects(f.c.start(), /d1_outcome_unknown/);
  const actionId = f.journal.find(x => x.phase === 'intent').actionId;
  const rawResponseBytes = active().rawResponseBytes;
  const context = { schema: 'staging-d1-export-response/v1', actionId, requestSha256: f.journal.find(x => x.phase === 'intent').requestSha256, responseSha256: hash(rawResponseBytes), httpStatus: 200, bindingSha256: hash(Buffer.from(JSON.stringify(f.c.binding))) };
  const sealed = await f.sealRawResponse({ rawResponseBytes: Buffer.from(rawResponseBytes), destination: actionId, context });
  await f.c.reconcile({ actionId, responseStatus: 200, rawResponseBytes, sealedDigest: sealed.digest, receiptRef: sealed.receiptRef, proof: { recovered: true } });
  assert.equal(f.c.state().status, 'export-polling');
  assert.equal(f.requests.length, 1);
  assert.equal(f.journal.some(x => x.phase === 'reconciled-custody'), true);
});

test('proved malformed reconciliation is terminal and cannot accept a second outcome', async () => {
  const f = await fixture([new Error('uncertain')]);
  await assert.rejects(f.c.start(), /d1_outcome_unknown/);
  const actionId = f.journal.find(x => x.phase === 'intent').actionId;
  const rawResponseBytes = Buffer.from('{broken');
  const context = { schema: 'staging-d1-export-response/v1', actionId, requestSha256: f.journal.find(x => x.phase === 'intent').requestSha256, responseSha256: hash(rawResponseBytes), httpStatus: 200, bindingSha256: hash(Buffer.from(JSON.stringify(f.c.binding))) };
  const sealed = await f.sealRawResponse({ rawResponseBytes: Buffer.from(rawResponseBytes), destination: actionId, context });
  await assert.rejects(f.c.reconcile({ actionId, responseStatus: 200, rawResponseBytes, sealedDigest: sealed.digest, receiptRef: sealed.receiptRef, proof: { recovered: true } }), /d1_response_refused/);
  assert.equal(f.c.state().status, 'stopped');
  await assert.rejects(f.c.reconcile({ actionId, responseStatus: 200, rawResponseBytes: active().rawResponseBytes, sealedDigest: sealed.digest, receiptRef: sealed.receiptRef, proof: { recovered: true } }), /d1_reconcile_refused/);
});

test('HTTP redirect response body is sealed and proof checked before refusal', async () => {
  const f = await fixture([response({ at_bookmark: 'bm' }, 302)]);
  await assert.rejects(f.c.start(), /d1_http_refused/);
  assert.equal(f.journal.some(x => x.phase === 'custodied' && x.httpStatus === 302), true);
  assert.equal(f.journal.some(x => x.phase === 'refused' && x.httpStatus === 302), true);
  assert.equal(f.requests.length, 1);
});

test('sealer mutation cannot alter bytes parsed by coordinator', async () => {
  const f = await fixture([active()], { sealerOverride: async ({ rawResponseBytes }) => { rawResponseBytes.fill(0); return { verified: true, digest: 'a'.repeat(64), receiptRef: 'b'.repeat(64) }; } });
  await assert.rejects(f.c.start(), /d1_response_custody_unknown/);
});

test('rejects changed bookmark and unreviewed origin capability as terminal sanitized failures', async () => {
  const x = await fixture([active('bm'), active('other')]);
  await x.c.start(); await assert.rejects(x.c.poll(), /d1_bookmark_changed/);
  const y = await fixture([completion('bm', 'https://evil.example/?token=secret')]);
  await assert.rejects(y.c.start(), /d1_download_capability_invalid/);
  assert.equal(JSON.stringify(y.c.state()).includes('secret'), false);
});

test('capacity response is an unknown terminal outcome and cannot be retried', async () => {
  const x = await fixture([{ status: 200, rawResponseBytes: Buffer.alloc(1024 * 1024 + 1), redirected: false, finalURL: APIURL }]);
  await assert.rejects(x.c.start(), /d1_response_capacity_unknown/);
  assert.equal(x.c.state().status, 'needs-reconciliation');
  await assert.rejects(x.c.start(), /d1_start_refused/);
  assert.equal(x.requests.length, 1);
});

test('failed initial intent does not call transport or permit another start', async () => {
  const x = await fixture([active()], { recordOverride: async e => e.phase !== 'intent' });
  await assert.rejects(x.c.start(), /d1_intent_unrecorded/);
  assert.equal(x.requests.length, 0);
  await assert.rejects(x.c.start(), /d1_start_refused/);
});

test('redirect metadata mismatch is rejected and blocks without advancing', async () => {
  const x = await fixture([response({ at_bookmark: 'bm' }, 302, 'https://evil.example/export')]);
  await assert.rejects(x.c.start(), /d1_outcome_unknown/);
  assert.equal(x.c.state().status, 'needs-reconciliation');
});

test('poll limit permits exactly 100 polls and rejects poll 101', async () => {
  const q = [active('bm')];
  for (let i = 0; i < 100; i++) q.push(active('bm'));
  const f = await fixture(q);
  await f.c.start();
  for (let i = 0; i < 100; i++) await f.c.poll();
  await assert.rejects(f.c.poll(), /d1_poll_refused|d1_poll_limit/);
  assert.equal(f.requests.length, 101);
  assert.equal(f.journal.filter(x => x.phase === 'intent').length, 101);
});

test('overlapping polls and reconciliation cannot race a pending provider call', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture([active(), async () => { await gate; return active(); }]);
  await f.c.start();
  const firstPoll = f.c.poll();
  await assert.rejects(f.c.poll(), /d1_poll_refused/);
  await assert.rejects(f.c.reconcile({}), /d1_reconcile_refused/);
  release();
  assert.equal((await firstPoll).status, 'export-polling');
  assert.equal(f.requests.length, 2);
});

test('completion recovered after lost response contains a fully bound continuation receipt', async () => {
  const f = await fixture([new Error('lost response')]);
  await assert.rejects(f.c.start(), /d1_outcome_unknown/);
  const intent = f.journal.find(x => x.phase === 'intent');
  const rawResponseBytes = completion().rawResponseBytes;
  const context = { schema: 'staging-d1-export-response/v1', actionId: intent.actionId,
    requestSha256: intent.requestSha256, responseSha256: hash(rawResponseBytes), httpStatus: 200,
    bindingSha256: intent.bindingSha256 };
  const sealed = await f.sealRawResponse({ rawResponseBytes, destination: intent.actionId, context });
  const result = await f.c.reconcile({ actionId: intent.actionId, responseStatus: 200, rawResponseBytes,
    sealedDigest: sealed.digest, receiptRef: sealed.receiptRef, proof: { recovered: true } });
  assert.equal(result.status, 'export-capability-sealed');
  for (const field of ['requestSha256', 'responseSha256', 'bindingSha256', 'sealedDigest', 'receiptRef', 'planSha256'])
    assert.match(result.continuationReceipt[field], /^[a-f0-9]{64}$/);
  assert.equal(result.continuationReceipt.httpStatus, 200);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.c.download()).status, 'download-adapter-required');
});

test('optional completion metadata is accepted but an active response cannot conceal a capability', async () => {
  const f = await fixture([response({ at_bookmark: 'bm', status: 'complete', result: {
    signed_url: 'https://downloads.example/private?sig=synthetic' } })]);
  assert.equal((await f.c.start()).status, 'export-capability-sealed');
  const bad = await fixture([response({ at_bookmark: 'bm', result: { signed_url: 'https://downloads.example/private' } })]);
  await assert.rejects(bad.c.start(), /d1_active_response_invalid/);
  assert.equal(bad.c.state().status, 'stopped');
});

test('typed array shadow properties cannot run getters or defeat intrinsic size checks', async () => {
  const bytes = active().rawResponseBytes;
  let accessed = false;
  Object.defineProperty(bytes, 'byteLength', { get() { accessed = true; throw new Error('private'); } });
  const f = await fixture([{ ...active(), rawResponseBytes: bytes }]);
  assert.equal((await f.c.start()).status, 'export-polling');
  assert.equal(accessed, false);
  const shared = new Uint8Array(new SharedArrayBuffer(8));
  const bad = await fixture([{ ...active(), rawResponseBytes: shared }]);
  await assert.rejects(bad.c.start(), /d1_response_capacity_unknown/);
  assert.equal(bad.requests.length, 1);
});

test('sealer and validator copies are cleared on callback failures and text is never reflected', async () => {
  let sealerBytes;
  const f = await fixture([active()], { sealerOverride: async ({ rawResponseBytes }) => {
    sealerBytes = rawResponseBytes; throw new Error('d1_private_capability');
  } });
  await assert.rejects(f.c.start(), /^Error: d1_response_custody_unknown$|^ExportCustodyError: d1_response_custody_unknown$/);
  assert.equal(sealerBytes.every(x => x === 0), true);
  let proofBytes;
  const bad = await fixture([active()], { proofOverride: async p => { proofBytes = p.rawResponseBytes; throw new Error('private url'); } });
  await assert.rejects(bad.c.start(), /d1_response_custody_unknown/);
  assert.equal(proofBytes.every(x => x === 0), true);
});

test('invalid origin inputs fail before invoking a coercion callback or any transport', () => {
  let accessed = false;
  assert.throws(() => createStagingD1ExportCustody({ plan, role: 'operations',
    downloadOrigin: { toString() { accessed = true; throw new Error('private'); } } }), /d1_download_origin_invalid/);
  assert.equal(accessed, false);
});

test('a custodied provider failure returns stopped after the in-flight operation ends', async () => {
  const f = await fixture([response({ at_bookmark: 'bm', status: 'error', success: false,
    error: 'synthetic private provider detail' })]);
  assert.equal((await f.c.start()).status, 'stopped');
  assert.equal(f.c.state().status, 'stopped');
  await assert.rejects(f.c.poll(), /d1_poll_refused/);
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.stringify(f.journal).includes('private'), false);
});
