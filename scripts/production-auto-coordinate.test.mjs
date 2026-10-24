import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { coordinateProductionAutoRelease } from './production-auto-coordinate.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const ACCOUNT = NATIVE_STAFF_PRODUCTION_TARGET.accountId, COMMIT = 'b'.repeat(40), CONTROL = 'c'.repeat(64), MODULE = 'd'.repeat(64);
const PARENT = '11111111-1111-4111-8111-111111111111', CANDIDATE = '22222222-2222-4222-8222-222222222222';
const DEPLOY = '33333333-3333-4333-8333-333333333333', ZERO = '44444444-4444-4444-8444-444444444444';
const ACTIVE = '55555555-5555-4555-8555-555555555555';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);
function readiness() { return { schemaVersion: 2, sourceCommit: COMMIT, accountId: ACCOUNT,
  databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId, reviewSha256: '1'.repeat(64), cohortSha256: '2'.repeat(64),
  controlPlaneSha256: '3'.repeat(64), observedAt: new Date().toISOString(), staffCount: 2, generation: 0 }; }
function fixture(workerName = 'ledgetop-ops') {
  const events = [], receipts = [], intents = [];
  const initial = { activeVersionId: PARENT, latestVersionId: PARENT, controlsSHA256: CONTROL,
    deploymentId: DEPLOY, deployedAt: '2026-10-23T00:00:00.000Z', versions: [{ versionId: PARENT, percentage: 100 }] };
  let current = clone(initial), ledger;
  const oldPayloads = new Map([['/index.html', Buffer.from('old index')], ['/assets/old.js', Buffer.from('old js')]]);
  const newPayloads = new Map([['/index.html', Buffer.from('new index')], ['/assets/new.js', Buffer.from('new js')]]);
  const entries = payloads => [...payloads].map(([path, bytes]) => ({ path, size: bytes.length,
    sha256: hash(bytes), mime: path.endsWith('.html') ? 'text/html' : 'application/javascript', providerHash: hash(bytes).slice(0, 32) }))
    .sort((a, b) => a.path < b.path ? -1 : 1);
  const previous = { schemaVersion: 1, workerName, accountId: ACCOUNT, sourceCommit: 'a'.repeat(40),
    parentVersionId: DEPLOY, observedAt: '2026-10-23T00:00:00.000Z', minimumRetentionHours: 48,
    automaticPruning: false, assets: entries(oldPayloads) };
  const adapter = {
    capture: async () => { events.push('capture'); return clone(current); },
    sourceFence: async () => { events.push('source'); return { sourceCommit: COMMIT, mainCommit: COMMIT, clean: true }; },
    ciGate: async () => { events.push('ci'); return { sourceCommit: COMMIT, passed: true }; },
    staffReadiness: async () => { events.push('staff'); return readiness(); },
    build: async () => { events.push('build'); return { sourceCommit: COMMIT, moduleSHA256: MODULE,
      assets: { entries: entries(newPayloads), payloads: newPayloads } }; },
    readLedger: async () => { events.push('ledger'); return clone(previous); },
    readOldAssets: async () => { events.push('old-bytes'); return new Map([...oldPayloads].map(([name, bytes]) => [name, Buffer.from(bytes)])); },
    upload: async input => {
      events.push('upload-enter'); ledger = input.ledger;
      await input.recordIntent({ phase: 'asset-session', hashes: Object.values(input.manifest).map(row => row.hash) });
      events.push('asset-session-post');
      await input.recordIntent({ phase: 'asset-bucket', hashes: Object.values(input.manifest).map(row => row.hash) });
      events.push('asset-bucket-post');
      await input.recordIntent({ phase: 'worker-version-upload', hashes: [] });
      events.push('version-post'); current.latestVersionId = CANDIDATE;
      return { candidateVersionId: CANDIDATE, moduleSHA256: MODULE };
    },
    candidateReadback: async input => { events.push('readback'); return { verified: true,
      candidateVersionId: CANDIDATE, moduleSHA256: MODULE, ledgerSHA256: input.ledgerSHA256, controlsSHA256: CONTROL }; },
    stageZero: async input => { events.push('zero-post'); current = { ...current,
      deploymentId: ZERO, versions: clone(input.versions), deployedAt: '2026-10-23T01:00:00.000Z' }; },
    verifyAssets: async input => { events.push(`verify-${input.stage}`); return { verified: true,
      versionRoutingVerified: true, routingDeploymentId: input.routingDeploymentId,
      versionId: input.versionId, ledgerSHA256: input.ledgerSHA256, files: input.ledger.assets.length,
      bytes: input.ledger.assets.reduce((sum, row) => sum + row.size, 0) }; },
    activate: async input => { events.push('activate-post'); current = { ...current,
      deploymentId: ACTIVE, activeVersionId: CANDIDATE, versions: clone(input.versions), deployedAt: '2026-10-23T02:00:00.000Z' }; },
    readDeployment: async () => { events.push('read-deployment'); return clone(current); },
    recordIntent: async entry => { events.push(`intent-${entry.phase}`); intents.push(clone(entry)); },
    receipt: async entry => { events.push(`receipt-${entry.status}`); receipts.push(clone(entry)); },
  };
  return { adapter, events, receipts, intents, previous, oldPayloads, newPayloads,
    current: () => current, ledger: () => ledger, setState: value => { current = value; },
    run: () => coordinateProductionAutoRelease({ accountId: ACCOUNT, workerName, sourceCommit: COMMIT, adapter }) };
}

test('happy path fences every POST, verifies parent100/candidate0 then candidate100 and both byte sets', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.verifiedActive, true); assert.equal(result.files, 3);
  assert.equal(result.cutoverObservedAt, '2026-10-23T02:00:00.000Z');
  assert.equal(result.earliestPermittedPruningAt, '2026-10-25T02:00:00.000Z');
  assert.equal(result.automaticPruning, false); assert.equal(result.allHistoricalAssetsCarried, true);
  assert.deepEqual(f.ledger().assets.map(row => row.path), ['/assets/new.js', '/assets/old.js', '/index.html']);
  for (const [post, phase] of [['asset-session-post', 'asset-session'], ['asset-bucket-post', 'asset-bucket'],
    ['version-post', 'worker-version-upload'], ['zero-post', 'stage-zero'], ['activate-post', 'activate']]) {
    const at = f.events.indexOf(post);
    assert.deepEqual(f.events.slice(at - 5, at), ['source', 'ci', 'staff', 'capture', `intent-${phase}`]);
  }
  assert.ok(f.events.indexOf('readback') < f.events.indexOf('zero-post'));
  assert.ok(f.events.indexOf('zero-post') < f.events.indexOf('verify-zero-percent'));
  assert.ok(f.events.indexOf('verify-zero-percent') < f.events.indexOf('activate-post'));
  assert.ok(f.events.indexOf('activate-post') < f.events.indexOf('verify-active'));
  assert.deepEqual(f.receipts.map(row => row.status), ['started', 'prepared', 'inactive-verified',
    'zero-percent-verified', 'candidate-assets-verified', 'verified']);
  assert.equal(f.intents.length, 5);
});

for (const kind of ['dirty', 'superseded', 'wrong-ci-sha', 'ci-failed', 'split', 'inactive-latest']) {
  test(`initial gate refuses ${kind} before any build or write`, async () => {
    const f = fixture();
    if (kind === 'dirty') f.adapter.sourceFence = async () => ({ sourceCommit: COMMIT, mainCommit: COMMIT, clean: false });
    if (kind === 'superseded') f.adapter.sourceFence = async () => ({ sourceCommit: COMMIT, mainCommit: 'f'.repeat(40), clean: true });
    if (kind === 'wrong-ci-sha') f.adapter.ciGate = async () => ({ sourceCommit: 'f'.repeat(40), passed: true });
    if (kind === 'ci-failed') f.adapter.ciGate = async () => ({ sourceCommit: COMMIT, passed: false });
    if (kind === 'split') f.current().versions = [{ versionId: PARENT, percentage: 90 }, { versionId: CANDIDATE, percentage: 10 }];
    if (kind === 'inactive-latest') f.current().latestVersionId = CANDIDATE;
    await assert.rejects(f.run(), /held/);
    assert.equal(f.intents.length, 0); assert.equal(f.events.includes('build'), false);
  });
}

for (const kind of ['missing-old', 'tampered-old', 'changed-old-url']) {
  test(`retained payload ${kind} fails before upload`, async () => {
    const f = fixture();
    if (kind === 'missing-old') f.adapter.readOldAssets = async () => new Map();
    if (kind === 'tampered-old') f.oldPayloads.set('/assets/old.js', Buffer.from('tamper'));
    if (kind === 'changed-old-url') f.newPayloads.set('/assets/old.js', Buffer.from('replacement'));
    await assert.rejects(f.run(), /held/); assert.equal(f.events.includes('upload-enter'), false); assert.equal(f.intents.length, 0);
  });
}

test('source and control drift immediately before a later bucket prevents that POST', async () => {
  const f = fixture(), source = f.adapter.sourceFence;
  f.adapter.sourceFence = async input => {
    if (f.events.includes('asset-session-post')) return { sourceCommit: COMMIT, mainCommit: 'e'.repeat(40), clean: true };
    return source(input);
  };
  await assert.rejects(f.run(), /held/);
  assert.equal(f.events.includes('asset-session-post'), true); assert.equal(f.events.includes('asset-bucket-post'), false);
  assert.equal(f.events.includes('read-deployment'), true);
});

test('a protected control change after inactive readback blocks zero staging', async () => {
  const f = fixture(), readback = f.adapter.candidateReadback;
  f.adapter.candidateReadback = async input => { const result = await readback(input); f.current().controlsSHA256 = 'f'.repeat(64); return result; };
  await assert.rejects(f.run(), /held/); assert.equal(f.events.includes('zero-post'), false);
});

test('a durable intent failure does not permit its mutation or any retry', async () => {
  const f = fixture(); f.adapter.recordIntent = async () => { throw Error('secret-token'); };
  await assert.rejects(f.run(), error => !String(error).includes('secret-token'));
  assert.equal(f.events.includes('asset-session-post'), false); assert.equal(f.events.includes('read-deployment'), false);
  assert.equal(f.receipts.at(-1).writesAttempted, false);
});

test('unknown version-upload outcome preserves intent and does only one GET reconciliation', async () => {
  const f = fixture();
  f.adapter.upload = async input => { await input.recordIntent({ phase: 'worker-version-upload', hashes: [] });
    f.current().latestVersionId = CANDIDATE; throw Error('raw-private-response'); };
  await assert.rejects(f.run(), error => !String(error).includes('raw-private-response'));
  assert.equal(f.intents.length, 1); assert.equal(f.events.filter(row => row === 'read-deployment').length, 1);
  assert.equal(f.events.includes('zero-post'), false); assert.equal(f.events.includes('activate-post'), false);
  assert.equal(f.receipts.at(-1).reconciliation.latestVersionId, CANDIDATE);
});

test('a fake upload acknowledgement without a durable version intent fails', async () => {
  const f = fixture(); f.adapter.upload = async () => ({ candidateVersionId: CANDIDATE, moduleSHA256: MODULE });
  await assert.rejects(f.run(), /held/); assert.equal(f.events.includes('readback'), false);
});

test('candidate readback mismatch blocks all deployment mutations', async () => {
  const f = fixture(); f.adapter.candidateReadback = async () => ({ verified: false });
  await assert.rejects(f.run(), /held/); assert.equal(f.events.includes('zero-post'), false);
});

test('zero staging must actually retain parent100/candidate0 before testing or activation', async () => {
  const f = fixture(); f.adapter.stageZero = async () => { f.events.push('bad-zero');
    f.current().deploymentId = ZERO; f.current().versions = [{ versionId: CANDIDATE, percentage: 100 }]; f.current().activeVersionId = CANDIDATE; };
  await assert.rejects(f.run(), /held/); assert.equal(f.events.includes('verify-zero-percent'), false);
  assert.equal(f.events.includes('activate-post'), false);
});

test('a stale deployment timestamp cannot shorten the required retention window', async () => {
  const f = fixture(), activate = f.adapter.activate;
  f.adapter.activate = async input => { await activate(input); f.current().deployedAt = '2026-10-22T00:00:00.000Z'; };
  await assert.rejects(f.run(), /held/);
  assert.equal(f.events.includes('verify-active'), false); assert.equal(f.receipts.at(-1).status, 'held');
});

test('unverified deployment IDs cannot masquerade as a new stage-zero acknowledgement', async () => {
  const f = fixture(), stage = f.adapter.stageZero;
  f.adapter.stageZero = async input => { await stage(input); f.current().deploymentId = DEPLOY; };
  await assert.rejects(f.run(), /held/); assert.equal(f.events.includes('verify-zero-percent'), false);
});

test('failed zero-percent old/new byte acceptance leaves parent active and never activates', async () => {
  const f = fixture(); f.adapter.verifyAssets = async () => ({ verified: false });
  await assert.rejects(f.run(), /held/); assert.equal(f.current().activeVersionId, PARENT);
  assert.equal(f.events.includes('activate-post'), false);
});

test('zero-percent controls drift during byte acceptance blocks activation', async () => {
  const f = fixture(), verify = f.adapter.verifyAssets;
  f.adapter.verifyAssets = async input => { const result = await verify(input); f.current().controlsSHA256 = 'f'.repeat(64); return result; };
  await assert.rejects(f.run(), /held/); assert.equal(f.events.includes('activate-post'), false);
});

test('ambiguous activation performs no automatic rollback or second activation', async () => {
  const f = fixture(), activate = f.adapter.activate;
  f.adapter.activate = async input => { await activate(input); throw Error('unknown-outcome'); };
  await assert.rejects(f.run(), /held/);
  assert.equal(f.current().activeVersionId, CANDIDATE);
  assert.equal(f.events.filter(row => row === 'activate-post').length, 1);
  assert.equal(f.receipts.at(-1).reconciliation.activeVersionId, CANDIDATE);
  assert.equal(f.receipts.some(row => row.status === 'verified'), false);
});

test('final asset failure holds without rolling back a potentially correct active version', async () => {
  const f = fixture(), verify = f.adapter.verifyAssets;
  f.adapter.verifyAssets = async input => input.stage === 'active' ? { verified: false } : verify(input);
  await assert.rejects(f.run(), /held/); assert.equal(f.current().activeVersionId, CANDIDATE);
  assert.equal(f.intents.length, 5); assert.equal(f.receipts.at(-1).status, 'held');
});

test('a missing final durable receipt is not reported as verified success', async () => {
  const f = fixture(), receipt = f.adapter.receipt;
  f.adapter.receipt = async entry => { if (entry.status === 'verified') throw Error('storage-failed'); return receipt(entry); };
  await assert.rejects(f.run(), /held/); assert.equal(f.current().activeVersionId, CANDIDATE);
  assert.equal(f.receipts.at(-1).status, 'held');
});

test('Ops requires an explicit staff-readiness adapter, while Client is exempt', async () => {
  const ops = fixture(); delete ops.adapter.staffReadiness;
  await assert.rejects(ops.run(), /native-staff/); assert.equal(ops.intents.length, 0);
  const client = fixture('ledgetop-clients'); delete client.adapter.staffReadiness;
  assert.equal((await client.run()).verifiedActive, true); assert.equal(client.events.includes('staff'), false);
});

for (const [name, mutate] of Object.entries({
  boolean: () => true,
  dummy: () => ({ ready: true }),
  stale: v => ({ ...v, observedAt: new Date(Date.now() - 60_001).toISOString() }),
  future: v => ({ ...v, observedAt: new Date(Date.now() + 60_000).toISOString() }),
  wrongSource: v => ({ ...v, sourceCommit: 'e'.repeat(40) }),
  wrongAccount: v => ({ ...v, accountId: 'a'.repeat(32) }),
  wrongDatabase: v => ({ ...v, databaseId: PARENT }),
  wrongSchema: v => ({ ...v, schemaVersion: 1 }),
  unpinnedReview: v => ({ ...v, reviewSha256: 'not-pinned' }),
  unpinnedCohort: v => ({ ...v, cohortSha256: null }),
  unpinnedControlPlane: v => ({ ...v, controlPlaneSha256: 'e' }),
  emptyStaff: v => ({ ...v, staffCount: 0 }),
  hugeStaff: v => ({ ...v, staffCount: 1025 }),
  negativeGeneration: v => ({ ...v, generation: -1 }),
  extraFields: v => ({ ...v, permission: true }),
})) test(`invalid staff readiness ${name} prevents any mutation`, async () => {
  const f = fixture(); f.adapter.staffReadiness = async () => mutate(readiness());
  await assert.rejects(f.run(), /held/); assert.equal(f.intents.length, 0);
  assert.equal(f.events.includes('build'), false);
});

for (const key of ['reviewSha256', 'cohortSha256', 'controlPlaneSha256', 'staffCount', 'generation']) {
  test(`staff ${key} drift after initial review prevents the first upload`, async () => {
    const f = fixture(); let calls = 0;
    f.adapter.staffReadiness = async () => {
      const value = readiness();
      if (++calls > 1) value[key] = typeof value[key] === 'number' ? value[key] + 1 : 'f'.repeat(64);
      return value;
    };
    await assert.rejects(f.run(), /held/); assert.equal(calls, 2); assert.equal(f.intents.length, 0);
    assert.equal(f.events.includes('asset-session-post'), false);
  });
}

test('staff readiness is rechecked after final active-byte acceptance', async () => {
  const f = fixture(), verify = f.adapter.verifyAssets, staff = f.adapter.staffReadiness;
  let changed = false;
  f.adapter.verifyAssets = async input => { const value = await verify(input); if (input.stage === 'active') changed = true; return value; };
  f.adapter.staffReadiness = async () => { const value = await staff(); if (changed) value.generation++; return value; };
  await assert.rejects(f.run(), /held/); assert.equal(f.current().activeVersionId, CANDIDATE);
  assert.equal(f.receipts.some(row => row.status === 'verified'), false);
});

for (const kind of ['file', 'count', 'total']) test(`union ${kind} verifier bound holds before asset-session or old-byte reads`, async () => {
  const f = fixture(), build = f.adapter.build;
  f.adapter.build = async input => {
    const value = await build(input), sample = value.assets.entries[0];
    if (kind === 'file') value.assets.entries[0].size = 16 * 1024 * 1024 + 1;
    else value.assets.entries = Array.from({ length: kind === 'count' ? 1025 : 9 }, (_, i) => ({
      ...sample, path: `/assets/bounded-${i}.js`, size: kind === 'count' ? 1 : 16 * 1024 * 1024 }));
    return value;
  };
  await assert.rejects(f.run(), /held/); assert.equal(f.intents.length, 0);
  assert.equal(f.events.includes('old-bytes'), false); assert.equal(f.events.includes('upload-enter'), false);
});

for (const kind of ['missing', 'false', 'wrong-deployment']) test(`unproven candidate routing ${kind} blocks activation`, async () => {
  const f = fixture(), verify = f.adapter.verifyAssets;
  f.adapter.verifyAssets = async input => {
    const value = await verify(input);
    if (kind === 'missing') delete value.versionRoutingVerified;
    if (kind === 'false') value.versionRoutingVerified = false;
    if (kind === 'wrong-deployment') value.routingDeploymentId = DEPLOY;
    return value;
  };
  await assert.rejects(f.run(), /held/); assert.equal(f.events.includes('verify-zero-percent'), true);
  assert.equal(f.events.includes('activate-post'), false);
});
