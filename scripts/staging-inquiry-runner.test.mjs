import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createStagingInquiryRunner } from './staging-inquiry-runner.mjs';
import { validateStagingInquiryUploadFence } from './staging-inquiry-window-bindings.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const bindings = [
    { name: 'CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED', type: 'plain_text', text: 'false' },
    { name: 'CLIENT_DELEGATED_SHARE_SIGNER_ENABLED', type: 'plain_text', text: 'false' },
    ...Array.from({ length: 126 }, (_, i) => ({ name: `VAR_${i}`, type: 'plain_text', text: 'x' })),
    { name: 'OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY', type: 'service', service: 'ledgetop-clients-staging', environment: 'production', entrypoint: 'OperationsPortalNativeRecipientAuthorityIngress' },
  ];
  const sorted = [...bindings].sort((a, b) => a.name.localeCompare(b.name));
  const pin = { deploymentId: id(3), activeVersionId: id(1), latestVersionId: id(2), bindingsSha256: sha(JSON.stringify(sorted)) };
  const makeFence = () => {
    const now = Date.now(), observedAt = new Date(now - 1000).toISOString();
    return { accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', workerName: 'ledgetop-ops-staging', observedAt,
      deployment: { id: id(3), versions: [{ version_id: id(1), percentage: 100 }, { version_id: id(2), percentage: 0 }] },
      pinnedZeroPercentVersion: { id: id(2), resources: { bindings } }, pin,
      versionList: { complete: true, observedAt, rows: [{ id: id(2), created_on: new Date(now - 10000).toISOString() },
        { id: id(1), created_on: new Date(now - 20000).toISOString() }] } };
  };
  return { bindings, pin, makeFence };
}

test('runner bridges uploader opaque receipts into core custody and stops at inactive candidate', async () => {
  const f = fixture(), asset = Buffer.from('mock asset'), assetSha = sha(asset),
    packetManifest = { environment: 'staging', accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
      workerName: 'ledgetop-ops-staging', purpose: 'synthetic test packet', source: { commit: 'synthetic' },
      union: { totalBytes: asset.length, files: [{ path: '/index.html', size: asset.length, sha256: assetSha, mime: 'text/html' }] } },
    packetBytes = Buffer.from(JSON.stringify(packetManifest)), main = Buffer.from('mock module'), ledger = Buffer.from('mock ledger');
  const expected = { packetSha256: sha(packetBytes), mainModuleSha256: sha(main), ledgerModuleSha256: sha(ledger),
    metadataTemplateSha256: sha(JSON.stringify({ assets: { jwt: '<fresh-asset-completion-token>' } })) };
  const records = [], posts = [], token = 'synthetic.completion.token';
  const provider = {
    readFence: async () => f.makeFence(),
    postVersion: async request => { posts.push(request); return { httpStatus: 200, rawResponseBytes: Buffer.from(JSON.stringify({ success: true, result: { id: id(9) } })) }; },
    readCandidate: async candidateId => {
      const fence = f.makeFence();
      fence.versionList.rows.unshift({ id: candidateId, created_on: new Date(Date.now() + 1000).toISOString() });
      const after = fence.pinnedZeroPercentVersion.resources.bindings.filter(row => !['CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED', 'CLIENT_DELEGATED_SHARE_SIGNER_ENABLED'].includes(row.name));
      after.push({ name: 'CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED', type: 'plain_text', text: 'true' });
      after.push({ name: 'OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED', type: 'plain_text', text: 'true' });
      return { fence, versionList: fence.versionList, candidateVersion: { id: candidateId, resources: { bindings: after } } };
    },
  };
  let preflightCount = 0, uploaderStartedAfterPreflight = false, planCalls = 0;
  const runner = createStagingInquiryRunner({ provider, packet: { sha256: expected.packetSha256 }, packetBytes, packetManifest,
    token, resolvePayload: async () => { preflightCount++; return { bytes: asset, sha256: assetSha, mime: 'text/html' }; },
    uploader: async options => {
      uploaderStartedAfterPreflight = preflightCount === packetManifest.union.files.length;
      assert.deepEqual(await options.resolvePayload(assetSha.slice(0, 32)), { bytes: asset, sha256: assetSha, mime: 'text/html' });
      await options.beforeDispatch();
      const opaqueId = await options.recordIntent({ phase: 'asset-bucket', requestPath: '/mock', hashes: [], payloadSHA256: sha('payload') });
      const rawResponseBytes = Buffer.from(JSON.stringify({ success: true, result: { accepted: true } }));
      const sealId = await options.sealOutcome({ intentId: opaqueId, phase: 'asset-bucket', requestPath: '/mock', responseStatus: 201, rawResponseBytes });
      assert.equal(typeof sealId, 'string');
      return Object.defineProperty({ completionAvailable: true }, 'completionToken', { value: token });
    },
    prepare: received => { planCalls++; assert.notEqual(received, token, 'The planner must never receive the real completion token'); return ({ metadata: { assets: { jwt: received } },
      mainModule: { name: 'index.mjs', contentType: 'application/javascript+module', bytes: main },
      ledgerModule: { name: 'ledger.mjs', contentType: 'application/octet-stream', bytes: ledger },
      receipt: { packetSHA256: expected.packetSha256, mainModuleSHA256: expected.mainModuleSha256, ledgerModuleSHA256: expected.ledgerModuleSha256 } }); },
    record: async (name, value) => { records.push({ name, value }); return true; },
    seal: async bytes => ({ verified: true, digest: sha(bytes) }),
    baselinePin: validateStagingInquiryUploadFence({ ...f.makeFence(), latestVersion: { id: id(2), resources: { bindings: f.bindings } }, now: new Date().toISOString() }),
    expected, attemptId: randomUUID(), tag: 'mock-tag' });
  const result = await runner.run();
  assert.equal(result.status, 'inactive_candidate_bindings_verified');
  assert.equal(result.activation, false);
  assert.equal(planCalls, 1);
  assert.equal(posts.length, 1);
  assert.equal(uploaderStartedAfterPreflight, true);
  assert.ok(records.some(row => row.name === 'asset-000001.outcome.json'));
  assert.ok(records.every(row => !JSON.stringify(row).includes(token)));
});

test('runner refuses a bad packet digest before invoking the uploader', async () => {
  const f = fixture(), calls = [];
  const packetManifest = { environment: 'staging', accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', workerName: 'ledgetop-ops-staging', union: { files: [] } };
  assert.throws(() => createStagingInquiryRunner({ provider: { readFence: async () => f.makeFence(), postVersion: async () => {}, readCandidate: async () => {} },
    uploader: async () => { calls.push('uploader'); }, prepare: () => {}, packet: { sha256: sha('different') },
    packetBytes: Buffer.from(JSON.stringify(packetManifest)), packetManifest, token: 'synthetic-token', resolvePayload: async () => ({}),
    record: async () => true, seal: async () => ({}), baselinePin: {}, expected: { packetSha256: sha('expected') },
    attemptId: '00000000-0000-4000-8000-000000000001', tag: 'mock' }), /packet_digest_mismatch/);
  assert.deepEqual(calls, []);
});

test('invalid preflight plan, forged pin, and deployment drift all stop before uploader invocation', async () => {
  for (const mode of ['plan', 'pin', 'deployment']) {
    const f = fixture(), main = Buffer.from('pinned main'), ledger = Buffer.from('pinned ledger');
    const packetManifest = { environment: 'staging', accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
      workerName: 'ledgetop-ops-staging', union: { files: [] } };
    const packetBytes = Buffer.from(JSON.stringify(packetManifest));
    const expected = { packetSha256: sha(packetBytes), mainModuleSha256: sha(main), ledgerModuleSha256: sha(ledger),
      metadataTemplateSha256: sha(JSON.stringify({ assets: { jwt: '<fresh-asset-completion-token>' } })) };
    let reads = 0, uploaderCalls = 0;
    const provider = {
      readFence: async () => {
        const fence = f.makeFence();
        if (++reads === 2 && mode === 'pin') fence.pin.bindingsSha256 = '0'.repeat(64);
        if (reads === 2 && mode === 'deployment') fence.deployment.versions[1].percentage = 100;
        return fence;
      }, postVersion: async () => {}, readCandidate: async () => {},
    };
    const runner = createStagingInquiryRunner({ provider, uploader: async () => { uploaderCalls++; },
      prepare: token => ({ metadata: { assets: { jwt: token }, ...(mode === 'plan' ? { changed: true } : {}) },
        mainModule: { bytes: main }, ledgerModule: { bytes: ledger },
        receipt: { packetSHA256: expected.packetSha256, mainModuleSHA256: expected.mainModuleSha256, ledgerModuleSHA256: expected.ledgerModuleSha256 } }),
      packet: { sha256: expected.packetSha256 }, packetBytes, packetManifest, token: 'synthetic.token',
      resolvePayload: async () => ({}), record: async () => true, seal: async () => ({}), baselinePin: f.pin,
      expected, attemptId: randomUUID(), tag: 'mock' });
    await assert.rejects(runner.run());
    assert.equal(uploaderCalls, 0, `${mode} must not reach the uploader`);
  }
});
