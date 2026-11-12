import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { executeStagingInquirySuccessor } from './staging-inquiry-successor-core.mjs';
import { validateStagingInquiryUploadFence } from './staging-inquiry-window-bindings.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const main = Buffer.from('synthetic-main');
const ledger = Buffer.from('synthetic-ledger');
const expected = { packetSha256: hash('packet'), mainModuleSha256: hash(main), ledgerModuleSha256: hash(ledger),
  metadataTemplateSha256: hash(JSON.stringify({ assets: { jwt: '<fresh-asset-completion-token>' } })) };
function rawFence() {
  const now = new Date(), observedAt = new Date(now.getTime() - 1000).toISOString();
  const bindings = [
    { name: 'CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED', type: 'plain_text', text: 'false' },
    { name: 'CLIENT_DELEGATED_SHARE_SIGNER_ENABLED', type: 'plain_text', text: 'false' },
    ...Array.from({ length: 126 }, (_, i) => ({ name: `VAR_${i}`, type: 'plain_text', text: 'x' })),
    { name: 'OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY', type: 'service', service: 'ledgetop-clients-staging', environment: 'production', entrypoint: 'OperationsPortalNativeRecipientAuthorityIngress' }
  ];
  const sorted = [...bindings].sort((a, b) => a.name.localeCompare(b.name));
  const bindingsSha256 = hash(JSON.stringify(sorted));
  return { accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', workerName: 'ledgetop-ops-staging',
    observedAt, now: now.toISOString(),
    deployment: { id: id(3), versions: [{ version_id: id(1), percentage: 100 }, { version_id: id(2), percentage: 0 }] },
    pinnedZeroPercentVersion: { id: id(2), resources: { bindings } },
    versionList: { complete: true, observedAt: observedAt,
      rows: [{ id: id(2), created_on: new Date(now.getTime() - 10000).toISOString() }, { id: id(1), created_on: new Date(now.getTime() - 20000).toISOString() }] },
    pin: { activeVersionId: id(1), latestVersionId: id(2), deploymentId: id(3), bindingsSha256 } };
}
function harness({ alteredToken = false, metadataDrift = false, receiptLeak = false, intentId = 'asset-0001', invalidProviderResponse = false, unknownPost = false, drift = false, mismatch = false, duplicate = false, noIntents = false, failedAsset = false, candidateNotNewest = false, latestListDrift = false } = {}) {
  const baseline = rawFence(), records = [], prepareTokens = [], postCalls = [];
  let reads = 0;
  const readFence = async () => {
    reads++;
    const value = structuredClone(baseline);
    value.now = '2000-01-01T00:00:00.000Z'; // Core must ignore caller-supplied clock values.
    if (latestListDrift && reads === 1) value.versionList.rows[1].created_on = new Date(Date.now() + 60000).toISOString();
    if (drift && reads === 2) value.deployment.versions[1].percentage = 1;
    return value;
  };
  const token = 'synthetic.completion.token';
  const prepare = (received, tag) => {
    prepareTokens.push(received);
    return { metadata: { assets: { jwt: alteredToken ? 'changed.token' : received }, ...(metadataDrift ? { bindings: [] } : {}) },
      mainModule: { name: 'index.mjs', bytes: main, contentType: 'application/javascript+module' },
      ledgerModule: { name: 'ledger.mjs', bytes: ledger, contentType: 'application/javascript+module' },
      receipt: { packetSHA256: expected.packetSha256, mainModuleSHA256: expected.mainModuleSha256, ledgerModuleSHA256: expected.ledgerModuleSha256, tag, ...(receiptLeak ? { token: received } : {}) } };
  };
  const uploadAssets = async ({ recordIntent, sealOutcome }) => {
    const intent = { id: intentId, phase: 'asset-bucket', payloadSHA256: hash('asset') };
    if (!noIntents) await recordIntent(intent);
    if (duplicate) await recordIntent(intent);
    if (!noIntents) await sealOutcome({ intentId: intent.id, rawResponseBytes: Buffer.from(JSON.stringify({ success: !invalidProviderResponse, result: {} })), responseStatus: 200, acceptedCandidateId: 'asset-candidate' });
    return { completionToken: token, verifiedPacketDigest: expected.packetSha256, sealedIntents: noIntents ? [] : [intent.id],
      outcomes: noIntents ? [] : [{ intentId: intent.id, status: failedAsset ? 'failed' : 'accepted', ok: !failedAsset }] };
  };
  const postVersion = async request => {
    postCalls.push(request);
    if (unknownPost) throw new Error('synthetic transport ambiguity');
    return { httpStatus: 200, rawResponseBytes: Buffer.from(JSON.stringify({ success: true, result: { id: id(9) } })) };
  };
  const readCandidate = async candidateId => {
    const fence = structuredClone(baseline);
    fence.versionList.observedAt = new Date().toISOString();
    if (!candidateNotNewest) fence.versionList.rows.unshift({ id: candidateId,
      created_on: new Date(Date.parse(fence.versionList.rows[0].created_on) + 1000).toISOString() });
    const bindings = fence.pinnedZeroPercentVersion.resources.bindings.filter(row => !['CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED', 'CLIENT_DELEGATED_SHARE_SIGNER_ENABLED'].includes(row.name));
    bindings.push({ name: 'CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED', type: 'plain_text', text: 'true' });
    bindings.push({ name: 'OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED', type: 'plain_text', text: 'true' });
    const pinnedZeroPercentVersion = fence.pinnedZeroPercentVersion;
    const versionList = fence.versionList;
    delete fence.versionList;
    return { fence: { ...fence, pinnedZeroPercentVersion }, versionList,
      candidateVersion: { id: mismatch ? id(8) : candidateId, resources: { bindings } } };
  };
  const execute = () => executeStagingInquirySuccessor({ prepare, packet: { sha256: expected.packetSha256 },
    readFence, uploadAssets, postVersion, readCandidate,
    record: async (name, value) => { records.push({ name, value }); return true; },
    seal: async bytes => ({ verified: true, digest: hash(bytes) }), baselinePin: validateStagingInquiryUploadFence({ ...baseline, latestVersion: baseline.pinnedZeroPercentVersion }),
    expected, attemptId: randomUUID(), tag: 'synthetic-tag' });
  return { execute, records, prepareTokens, postCalls };
}

test('success passes the same in-memory completion token, posts strict path, and returns inactive only', async () => {
  const h = harness(), result = await h.execute();
  assert.equal(result.status, 'inactive_candidate_bindings_verified', JSON.stringify(h.records.find(row => row.name === 'readback.outcome.json')));
  assert.equal(result.activationReady, false);
  assert.equal(result.activation, false);
  assert.equal(result.liveAssetAndSourceProof, false);
  assert.deepEqual(h.prepareTokens, ['synthetic.completion.token']);
  assert.equal(h.postCalls[0].path, '/workers/scripts/ledgetop-ops-staging/versions?bindings_inherit=strict');
  assert.ok(h.postCalls[0].body.includes(Buffer.from('synthetic.completion.token')));
  assert.ok(h.postCalls[0].body.includes(main));
  assert.ok(h.postCalls[0].body.includes(ledger));
  assert.ok(h.records.some(row => row.name === 'version-upload.intent.json'));
  assert.ok(h.records.every(row => !JSON.stringify(row).includes('synthetic.completion.token')));
});
test('raw fence accepts latest at zero percent with active at 100 percent', () => {
  const fence = rawFence();
  assert.equal(validateStagingInquiryUploadFence({ ...fence, latestVersion: fence.pinnedZeroPercentVersion }).latestVersionId, id(2));
  fence.deployment.versions[1].percentage = 100;
  assert.throws(() => validateStagingInquiryUploadFence(fence), /version_drift/);
});
test('altered token metadata fails before version POST', async () => {
  const h = harness({ alteredToken: true });
  await assert.rejects(h.execute(), /completion_token_mismatch/);
  assert.equal(h.postCalls.length, 0);
});
test('unreviewed metadata or a token in the receipt is refused before version POST', async () => {
  for (const options of [{ metadataDrift: true }, { receiptLeak: true }]) {
    const h = harness(options);
    await assert.rejects(h.execute(), /metadata_pin_mismatch|receipt_contains_token/);
    assert.equal(h.postCalls.length, 0);
    assert.ok(h.records.every(row => !JSON.stringify(row).includes('synthetic.completion.token')));
  }
});
test('unknown POST outcome is journaled as uncertain and never retried', async () => {
  const h = harness({ unknownPost: true }), result = await h.execute();
  assert.equal(result.status, 'hold_uncertain');
  assert.equal(h.postCalls.length, 1);
  assert.equal(h.records.find(row => row.name === 'version-upload.outcome.json').value.status, 'transport_uncertain_read_only_reconciliation_required');
});
test('duplicate asset intent is refused', async () => {
  const h = harness({ duplicate: true });
  await assert.rejects(h.execute(), /duplicate_asset_intent/);
  assert.equal(h.postCalls.length, 0);
});
test('asset intent IDs cannot escape the journal namespace', async () => {
  for (const intentId of ['', '../escape', 'bad/name', 'bad\\name', '.', 'a'.repeat(97)]) {
    const h = harness({ intentId });
    await assert.rejects(h.execute(), /asset_intent_id_invalid/);
    assert.equal(h.postCalls.length, 0);
    assert.deepEqual(h.records.map(row => row.name), ['active-attempt.claim.json', 'attempt.intent.json']);
  }
});
test('pre-POST baseline drift blocks the upload', async () => {
  const h = harness({ drift: true });
  await assert.rejects(h.execute(), /version_drift|prepost_drift/);
  assert.equal(h.postCalls.length, 0);
});
test('initial list must prove pinned version is newest', async () => {
  const h = harness({ latestListDrift: true });
  await assert.rejects(h.execute(), /latest_list_drift/);
  assert.equal(h.postCalls.length, 0);
});
test('candidate readback mismatch becomes hold and is journaled', async () => {
  const h = harness({ mismatch: true }), result = await h.execute();
  assert.equal(result.status, 'hold_readback_uncertain');
  assert.ok(h.records.some(row => row.name === 'readback.outcome.json'));
  assert.equal(h.postCalls.length, 1);
});
test('empty asset phase and failed asset outcome refuse version POST', async () => {
  for (const options of [{ noIntents: true }, { failedAsset: true }]) {
    const h = harness(options);
    await assert.rejects(h.execute(), /assets_incomplete/);
    assert.equal(h.postCalls.length, 0);
  }
});
test('a failed provider response cannot be laundered by a successful uploader assertion', async () => {
  const h = harness({ invalidProviderResponse: true });
  await assert.rejects(h.execute(), /asset_response_uncertain/);
  assert.equal(h.postCalls.length, 0);
  assert.equal(h.records.find(row => row.name === 'asset-0001.outcome.json').value.uncertain, true);
});
test('candidate must be newest in a fresh version list', async () => {
  const h = harness({ candidateNotNewest: true }), result = await h.execute();
  assert.equal(result.status, 'hold_readback_uncertain');
  assert.equal(h.postCalls.length, 1);
});
