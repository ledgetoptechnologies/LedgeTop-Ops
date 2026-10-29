import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetBootstrapVerificationEntries, completeAssetInventoryBootstrap, prepareAssetInventoryBootstrap,
  readPinnedAssetInventoryBootstrap } from './production-auto-asset-bootstrap.mjs';
import { mergeAssetLedger } from './production-auto-assets.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const workerName = 'ledgetop-ops', accountId = 'a'.repeat(32), sourceCommit = 'b'.repeat(40);
const activeVersionId = '11111111-1111-4111-8111-111111111111';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = { '/index.html': Buffer.from('old index'), '/assets/old.js': Buffer.from('old asset'),
  '/assets/b0-new.js': Buffer.from('b0 asset') };
const packetFiles = Object.entries(bytes).map(([path, body], index) => ({ path, size: body.length, sha256: hash(body),
  mime: path.endsWith('.html') ? 'text/html' : 'text/javascript',
  provenance: index === 2 ? 'new-candidate-asset' : 'retained-prior-active' }));
const packetManifest = { schemaVersion: 1,
  purpose: 'offline retained frontend asset packet; not a deployment or active-namespace proof',
  application: 'operations', sourceCommit,
  replacement: { onlyPath: '/index.html', oldIndexExcludedFromUpload: true },
  union: { fileCount: packetFiles.length, totalBytes: packetFiles.reduce((sum, row) => sum + row.size, 0), files: packetFiles } };
const packetManifestBytes = Buffer.from(JSON.stringify(packetManifest));
const terminalReceiptBytes = Buffer.from(JSON.stringify({ status: 'existing-staged-candidate-recovered-and-verified',
  candidateVersionId: activeVersionId, candidateActiveProof: { fileCount: packetFiles.length,
    totalBytes: packetFiles.reduce((sum, row) => sum + row.size, 0), packetManifestSHA256: hash(packetManifestBytes),
    byteMimeHashVerified: true, temporaryHelperRemoved: true, temporaryHelperAbsenceVerified: true },
  activationPosts: 1, automaticPruning: false }));
const acceptedReceiptBytes = Buffer.from(JSON.stringify({ schemaVersion: 1,
  status: 'accepted-after-separate-active-verification', worker: workerName, sourceCommit,
  candidateVersionId: activeVersionId, packetManifestSHA256: hash(packetManifestBytes),
  terminalReceiptSHA256: hash(terminalReceiptBytes),
  cutoverAt: '2026-10-27T12:00:00.000Z', earliestPermittedPruningAt: '2026-10-29T12:00:00.000Z',
  files: packetFiles.length, bytes: packetFiles.reduce((sum, row) => sum + row.size, 0),
  minimumRetentionHours: 48, automaticPruning: false,
  postActivationProof: { allBodySizeShaMimeChecksPassed: true, temporaryHelperRemoved: true,
    cleanup: { removed: true, absenceVerified: true } } }));
const bootstrap = () => ({ pin: { schemaVersion: 1, workerName, accountId, activeVersionId,
  packetManifestSHA256: hash(packetManifestBytes), acceptedReceiptSHA256: hash(acceptedReceiptBytes),
  terminalReceiptSHA256: hash(terminalReceiptBytes) }, packetManifestBytes, acceptedReceiptBytes, terminalReceiptBytes });
const previous = { schemaVersion: 1, workerName, accountId, sourceCommit: 'c'.repeat(40),
  parentVersionId: '22222222-2222-4222-8222-222222222222', observedAt: '2026-10-27T12:00:00.000Z',
  minimumRetentionHours: 48, automaticPruning: false,
  assets: packetFiles.slice(0, 2).map(row => ({ path: row.path, size: row.size, sha256: row.sha256,
    mime: row.mime, providerHash: row.path === '/index.html' ? 'd'.repeat(32) : 'e'.repeat(32) }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
const priorIndex = Buffer.from('older index');
Object.assign(previous.assets.find(row => row.path === '/index.html'), { size: priorIndex.length,
  sha256: hash(priorIndex), providerHash: 'f'.repeat(32) });
const binding = { bootstrap: bootstrap(), previous, activeVersionId, workerName, accountId };

test('production reader serves only exact source-controlled known-version pins', () => {
  assert.equal(readPinnedAssetInventoryBootstrap({ workerName, activeVersionId }), null);
  assert.equal(readPinnedAssetInventoryBootstrap({ workerName: 'ledgetop-clients',
    activeVersionId: '33333333-3333-4333-8333-333333333333' }), null);
  for (const [targetWorker, versionId, manifestHash, receiptHash] of [
    ['ledgetop-ops', '0b1ab5a8-9db0-42ab-b718-8569fae2382e', 'fec34761336801fe672132c07b9d219f0325185de245a28e2713b1b7ebd9e0ae',
      '31e730a6577fe9f6ababf2f42a16fd1fe34ddfe912ea60afeb39f27a32001dfb'],
    ['ledgetop-clients', '1c606164-9a98-495a-87c9-3be251658d00', 'fa42dede3e1befc359f59907603942b0b60e96f04e42c71daf63ed707ca9cb05',
      '300b43e3f152d299e75f351278f75bc122651bf1172c5634135538a9c2d2b0ca'],
  ]) {
    const record = readPinnedAssetInventoryBootstrap({ workerName: targetWorker, activeVersionId: versionId });
    assert.equal(record.pin.packetManifestSHA256, manifestHash);
    assert.equal(record.pin.acceptedReceiptSHA256, receiptHash);
    assert.equal(hash(record.packetManifestBytes), manifestHash);
    assert.equal(hash(record.acceptedReceiptBytes), receiptHash);
  }
  const ops = readPinnedAssetInventoryBootstrap({ workerName, activeVersionId: '0b1ab5a8-9db0-42ab-b718-8569fae2382e' });
  assert.equal(ops.pin.terminalReceiptSHA256, 'eb668d58c8ffab56910b776397aa25d1f4fcd40d3fdf909c498f8cf835fa69e1');
  assert.equal(hash(ops.terminalReceiptBytes), ops.pin.terminalReceiptSHA256);
  assert.throws(() => readPinnedAssetInventoryBootstrap({ workerName: 'ledgetop-clients',
    activeVersionId: '0b1ab5a8-9db0-42ab-b718-8569fae2382e' }), /asset_bootstrap_known_version_worker_mismatch/);
});

test('actual Operations and Client pins validate complete packet rows and replace the stale passive index', () => {
  for (const [workerName, activeVersionId, expectedApplication, expectedFiles, expectedBytes] of [
    ['ledgetop-ops', '0b1ab5a8-9db0-42ab-b718-8569fae2382e', 'operations', 471, 152255343],
    ['ledgetop-clients', '1c606164-9a98-495a-87c9-3be251658d00', 'client', 167, 90534186],
  ]) {
    const bootstrap = readPinnedAssetInventoryBootstrap({ workerName, activeVersionId });
    const staleIndex = Buffer.from(`${workerName} pre-bootstrap index`);
    const previous = { schemaVersion: 1, workerName, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
      sourceCommit: 'c'.repeat(40), parentVersionId: '22222222-2222-4222-8222-222222222222',
      observedAt: '2026-10-27T12:00:00.000Z', minimumRetentionHours: 48, automaticPruning: false,
      assets: [{ path: '/index.html', size: staleIndex.length, sha256: hash(staleIndex), mime: 'text/html', providerHash: 'd'.repeat(32) }] };
    const prepared = prepareAssetInventoryBootstrap({ bootstrap, previous, activeVersionId, workerName,
      accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId });
    assert.equal(prepared.rows.length, expectedFiles);
    assert.equal(prepared.rows.reduce((sum, row) => sum + row.size, 0), expectedBytes);
    const packet = JSON.parse(bootstrap.packetManifestBytes.toString('utf8'));
    assert.equal(packet.application, expectedApplication);
    const index = packet.union.files.find(row => row.path === '/index.html');
    const verificationEntries = assetBootstrapVerificationEntries(previous, prepared);
    assert.equal(verificationEntries.length, expectedFiles);
    assert.equal(verificationEntries.find(row => row.path === '/index.html').sha256, index.sha256);
    assert.deepEqual(verificationEntries.map(row => row.path).sort(), prepared.rows.map(row => row.path).sort());
  }
});

test('bootstrap supplements only after exact receipt/packet binding and full current-version byte proof', () => {
  const prepared = prepareAssetInventoryBootstrap(binding);
  assert.deepEqual(prepared.missing.map(row => row.path), ['/assets/b0-new.js', '/index.html']);
  const verificationEntries = assetBootstrapVerificationEntries(previous, prepared);
  const indexProof = verificationEntries.find(row => row.path === '/index.html');
  assert.equal(indexProof.sha256, hash(bytes['/index.html']), 'the stale index hash is replaced before active-version verification');
  assert.ok(verificationEntries.some(row => row.path === '/assets/b0-new.js'), 'every newly inventoried packet path is verified');
  const completed = completeAssetInventoryBootstrap({ ...binding, verifiedAssets: new Map(Object.entries(bytes)) });
  assert.equal(completed.assets.length, 3);
  assert.equal(completed.assets.find(row => row.path === '/index.html').providerHash, hash(bytes['/index.html']).slice(0, 32));
  assert.equal(completed.assets.find(row => row.path === '/assets/old.js').providerHash, 'e'.repeat(32));
  assert.equal(completed.assets.find(row => row.path === '/assets/b0-new.js').providerHash, hash(bytes['/assets/b0-new.js']).slice(0, 32));

  const nextBytes = new Map(Object.entries(bytes)); nextBytes.set('/index.html', Buffer.from('changed index'));
  const nextEntries = [{ path: '/index.html', size: nextBytes.get('/index.html').length,
    sha256: hash(nextBytes.get('/index.html')), mime: 'text/html', providerHash: hash(nextBytes.get('/index.html')).slice(0, 32) }];
  const next = mergeAssetLedger({ previous: completed, current: { entries: nextEntries, payloads: nextBytes },
    workerName, accountId, sourceCommit: 'f'.repeat(40), parentVersionId: activeVersionId,
    observedAt: '2026-10-28T12:00:00.000Z' });
  assert.ok(next.assets.some(row => row.path === '/assets/b0-new.js'), 'newly discovered active asset survives a frontend change');
  assert.equal(next.assets.find(row => row.path === '/assets/b0-new.js').providerHash,
    hash(bytes['/assets/b0-new.js']).slice(0, 32));
});

test('bootstrap mismatches in active version, packet, receipt, source or worker fail closed', () => {
  for (const mutate of [
    value => { value.activeVersionId = '33333333-3333-4333-8333-333333333333'; },
    value => { value.bootstrap.pin.packetManifestSHA256 = '0'.repeat(64); },
    value => { value.bootstrap.pin.acceptedReceiptSHA256 = '0'.repeat(64); },
    value => { value.bootstrap.packetManifestBytes = Buffer.from(JSON.stringify({ ...packetManifest, sourceCommit: 'f'.repeat(40) })); },
    value => { value.bootstrap.acceptedReceiptBytes = Buffer.from(JSON.stringify({ status: 'held' })); },
    value => { value.workerName = 'ledgetop-clients'; },
  ]) {
    const value = { ...binding, bootstrap: bootstrap() };
    mutate(value);
    assert.throws(() => prepareAssetInventoryBootstrap(value));
  }
});

test('every packet row must be returned and byte verified before any new identifier is emitted', () => {
  for (const verifiedAssets of [new Map(Object.entries(bytes).filter(([path]) => path !== '/assets/b0-new.js')),
    new Map([...Object.entries(bytes), ['/unexpected.js', Buffer.from('extra')]]),
    new Map(Object.entries({ ...bytes, '/assets/b0-new.js': Buffer.from('same-size') }))]) {
    assert.throws(() => completeAssetInventoryBootstrap({ ...binding, verifiedAssets }), /active_bytes_mismatch/);
  }
});
