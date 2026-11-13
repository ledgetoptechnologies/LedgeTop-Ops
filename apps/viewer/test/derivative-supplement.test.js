'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inventory, canonicalSupplement, expectedIdentity, createSupplementQualifier } = require('../server/derivativeSupplement');
const { canonicalDerivativeInput } = require('../server/derivativeInputSnapshot');
const { PinnedSupplementDirectory, createPinnedReadCustody } = require('../server/derivativeSupplementFiles');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture() {
  const files = ['obj', 'glb', 'mtl', 'texture'].map((kind, i) => ({ role: `mesh_${kind}`, rootKey: 'models',
    relativePath: `task/attempt.v2/source/model.${kind}`, byteSize: 10, sha256: String(i + 1).repeat(64) }));
  const input = canonicalDerivativeInput('mesh_tiles', files);
  const context = { attempt: { id: 'attempt', provider_id: 'provider', provider_task_id: 'facade' },
    version: { id: 'version' }, output: { relative_path: 'task/attempt.v2' }, input,
    archive: { archiveSha256: 'a'.repeat(64), layoutVersion: 2, archiveFiles: files.map(file => ({
      relativePath: file.relativePath.slice('task/attempt.v2/source/'.length), byteSize: file.byteSize, sha256: file.sha256 })) } };
  const binding = { environment: 'STAGING', providerId: 'provider', providerEndpoint: 'https://processing.example',
    coordinateFrame: { kind: 'local', unit: 'unknown', georeferenced: false } };
  const producer = { schemaVersion: 1, providerEndpoint: binding.providerEndpoint, providerTaskId: 'facade',
    environment: 'STAGING', producerGeneration: 7, nativeTaskId: 'native', archiveSha256: context.archive.archiveSha256 };
  const processing = {
    getProvider: () => ({ id: 'provider', endpoint: binding.providerEndpoint }),
    getAttemptTransferProvenance: () => ({ initialization: { state: 'acknowledged', ambiguous: false,
      attemptId: 'attempt', providerTaskId: 'facade', generation: 1 } }),
    getVerifiedAttemptProducerReceipt: () => ({ receipt: {} }),
  };
  const output = inventory([{ relativePath: 'tileset.json', role: 'render', byteSize: 2, sha256: sha('{}') },
    { relativePath: 'private-proof/mapping.jsonl', role: 'private-proof', byteSize: 2, sha256: sha('{}') }]);
  const supplement = { schemaVersion: 1, identity: expectedIdentity(processing, context, binding, producer),
    converter: { binarySha256: 'b'.repeat(64), buildInfoSha256: 'c'.repeat(64), commandSha256: 'd'.repeat(64), policyRevision: 'candidate-v1' },
    coordinateFrame: binding.coordinateFrame, files: output.files, outputManifestSha256: output.manifestSha256 };
  const parsed = canonicalSupplement(supplement), calls = [];
  const custody = {
    source: {}, output: {}, verifySource: async () => calls.push('source'), verifyOutput: async () => calls.push('output'),
    assertPinned: () => calls.push('pin'), register: () => ({ verified: true }), release: () => calls.push('release'),
  };
  const options = { processing, resolveBinding: async () => binding, resolveProducerBinding: async () => producer,
    confirmProducerIncarnation: async () => true,
    acceptConverter: async () => true, acquireCustody: async () => custody,
    independentlyVerify: async () => ({ schemaVersion: 1, policyRevision: supplement.converter.policyRevision,
      identity: supplement.identity, outputManifestSha256: supplement.outputManifestSha256,
      checks: { geometry: true, sourceUvCoverage: true, atlasPixels: true, finalTextureRelation: true } }) };
  const request = { operation: { id: 'operation', supplement_sha256: parsed.supplementSha256 }, context, supplement,
    assertCurrent: () => calls.push('lease') };
  return { context, binding, producer, processing, supplement, parsed, calls, custody, options, request };
}

test('canonical inventory and supplement identity have stable ordering and distinct producer generation', () => {
  const f = fixture();
  assert.equal(f.supplement.identity.initializationGeneration, 1);
  assert.equal(f.supplement.identity.producerGeneration, 7);
  assert.deepEqual(canonicalSupplement({ ...f.supplement, files: [...f.supplement.files].reverse() }), f.parsed);
});

for (const [name, change, code] of [
  ['caller path', x => { x.path = '/private'; }, 'supplement_invalid_shape'],
  ['caller verified claim', x => { x.verified = true; }, 'supplement_invalid_shape'],
  ['invented CRS', x => { x.coordinateFrame = { kind: 'local', unit: 'metres', georeferenced: false }; }, 'supplement_frame_unsupported'],
  ['missing producer generation', x => { delete x.identity.producerGeneration; }, 'supplement_invalid_shape'],
  ['wrong inventory digest', x => { x.outputManifestSha256 = 'e'.repeat(64); }, 'supplement_inventory_mismatch'],
]) test(`strict envelope rejects ${name}`, () => {
  const f = fixture(), value = structuredClone(f.supplement); change(value);
  assert.throws(() => canonicalSupplement(value), { code });
});

test('inventory rejects traversal, aliases, unknown roles, overflow and missing private proof', () => {
  const f = fixture(), file = f.supplement.files[0];
  for (const name of ['../secret', 'a/../b', '/root', 'a\\b', 'https://remote', 'a//b']) {
    assert.throws(() => inventory([{ ...file, relativePath: name }]), { code: 'supplement_invalid_path' });
  }
  assert.throws(() => inventory([...f.supplement.files, { ...file, relativePath: file.relativePath.toUpperCase() }]), { code: 'supplement_invalid_inventory' });
  assert.throws(() => inventory([{ ...file, role: 'executable' }]), { code: 'supplement_invalid_inventory' });
  assert.throws(() => inventory([{ ...file, byteSize: Number.MAX_SAFE_INTEGER }]), { code: 'supplement_inventory_limit' });
  assert.throws(() => inventory(f.supplement.files.filter(item => item.role === 'render')), { code: 'supplement_closure_missing' });
});

test('producer endpoint, task, environment, archive and source closure must match server records', () => {
  const f = fixture();
  for (const change of [{ providerEndpoint: 'https://other.example' }, { providerTaskId: 'other' },
    { environment: 'PRODUCTION' }, { archiveSha256: 'e'.repeat(64) }, { producerGeneration: 0 }]) {
    assert.throws(() => expectedIdentity(f.processing, f.context, f.binding, { ...f.producer, ...change }), { code: 'supplement_producer_binding_mismatch' });
  }
  const changed = structuredClone(f.context); changed.archive.archiveFiles[0].sha256 = 'f'.repeat(64);
  assert.throws(() => expectedIdentity(f.processing, changed, f.binding, f.producer), { code: 'supplement_source_changed' });
});

test('absent dependency or rejected converter cannot acquire physical custody', async () => {
  const f = fixture(); let acquired = false;
  await assert.rejects(createSupplementQualifier() (f.request), { code: 'supplement_adapter_unqualified' });
  await assert.rejects(createSupplementQualifier({ ...f.options, acceptConverter: async () => false,
    acquireCustody: async () => { acquired = true; } })(f.request), { code: 'supplement_converter_unqualified' });
  assert.equal(acquired, false);
  await assert.rejects(createSupplementQualifier({ ...f.options, confirmProducerIncarnation: async () => false })(f.request), { code: 'supplement_producer_incarnation_unbound' });
});

for (const name of ['geometry', 'sourceUvCoverage', 'atlasPixels', 'finalTextureRelation']) test(`partial independent ${name} proof rejects and releases pins`, async () => {
  const f = fixture(), base = f.options.independentlyVerify;
  const qualifier = createSupplementQualifier({ ...f.options, independentlyVerify: async () => {
    const value = await base(); value.checks[name] = false; return value;
  } });
  await assert.rejects(qualifier(f.request), { code: 'supplement_independent_proof_incomplete' });
  assert.equal(f.calls.filter(item => item === 'release').length, 1);
});

test('qualified internal callback rehashes before/after and releases retained pins on disposal', async () => {
  const f = fixture(), qualified = await createSupplementQualifier(f.options)(f.request);
  assert.equal(f.calls.filter(item => item === 'source').length, 2);
  assert.equal(f.calls.filter(item => item === 'output').length, 2);
  assert.equal(f.calls.includes('release'), false);
  assert.deepEqual(qualified.register({ assertLease() {} }), { verified: true });
  qualified.dispose();
  qualified.dispose();
  assert.equal(f.calls.filter(item => item === 'release').length, 1);
  assert.throws(() => qualified.register({ assertLease() {} }), { code: 'supplement_custody_released' });
});

for (const phase of ['resolveBinding', 'resolveProducerBinding', 'confirmProducerIncarnation', 'acceptConverter'])
test(`cancellation during ${phase} stops before custody and reaches producer adapters`, async () => {
  const f = fixture(), controller = new AbortController(), reason = new Error('synthetic recovery stopped');
  const reached = [];
  for (const name of ['resolveBinding', 'resolveProducerBinding', 'confirmProducerIncarnation', 'acceptConverter']) {
    const original = f.options[name];
    f.options[name] = async args => {
      reached.push(name);
      if (name !== 'acceptConverter') assert.equal(args.signal, controller.signal);
      const value = await original(args);
      if (name === phase) controller.abort(reason);
      return value;
    };
  }
  f.options.acquireCustody = async () => { assert.fail('cancelled recovery acquired custody'); };
  await assert.rejects(createSupplementQualifier(f.options)({ ...f.request, signal: controller.signal }), error => error === reason);
  assert.equal(reached.at(-1), phase, 'no later producer or converter preflight starts');
  assert.equal(f.calls.includes('source'), false);
});

test('post-verifier output mutation is rejected and releases custody', async () => {
  const f = fixture(); let calls = 0;
  f.custody.verifyOutput = async () => { if (++calls === 2) throw Object.assign(new Error('changed'), { code: 'supplement_file_changed' }); };
  await assert.rejects(createSupplementQualifier(f.options)(f.request), { code: 'supplement_file_changed' });
  assert.equal(f.calls.filter(item => item === 'release').length, 1);
});

test('descriptor pins reject unsafe/unlisted/replaced bytes and complete-tree extras on Linux; other platforms fail closed', async t => {
  if (process.platform !== 'linux') {
    assert.throws(() => new PinnedSupplementDirectory('/not-opened', []), { code: 'supplement_platform_unsupported' }); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-supplement-pins-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'image.png'), 'original');
  const files = [{ relativePath: 'image.png', byteSize: 8, sha256: sha('original') }];
  const pinned = new PinnedSupplementDirectory(root, files); t.after(() => pinned.close());
  pinned.assertComplete(); await pinned.verifyAll();
  await assert.rejects(pinned.withFile('not-listed', () => {}), { code: 'supplement_file_not_listed' });
  fs.writeFileSync(path.join(root, 'extra'), 'x');
  assert.throws(() => pinned.assertComplete(), { code: 'supplement_unlisted_file' }); fs.unlinkSync(path.join(root, 'extra'));
  await assert.rejects(pinned.withFile('image.png', () => {
    fs.renameSync(path.join(root, 'image.png'), path.join(root, 'old.png'));
    fs.writeFileSync(path.join(root, 'image.png'), 'original');
  }), { code: 'supplement_file_changed' });
  fs.unlinkSync(path.join(root, 'image.png')); fs.symlinkSync('/etc/passwd', path.join(root, 'image.png'));
  await assert.rejects(pinned.verifyAll());
  pinned.close(); assert.throws(() => pinned.assertPinned(), { code: 'supplement_pin_closed' });
});

test('physical custody factory requires real fence/registration hooks before opening paths', async () => {
  await assert.rejects(createPinnedReadCustody()({ operation: {}, context: {} }), { code: 'supplement_custody_unqualified' });
});

test('physical custody opens only the server-derived lease slot and releases all owned pins', async t => {
  let releases = 0;
  const operation = { id: '11111111-1111-4111-8111-111111111111', lease_token: 'a'.repeat(48) };
  const context = { input: { files: [{ relativePath: 'model.obj', byteSize: 3, sha256: sha('obj') }] } };
  const files = [{ relativePath: 'tileset.json', byteSize: 2, role: 'render', sha256: sha('{}') }];
  const options = { acquireFence: async () => ({ assertActive() { return true; }, release() { releases++; } }), registerVerified: () => ({ verified: true }) };
  if (process.platform !== 'linux') {
    await assert.rejects(createPinnedReadCustody({ ...options, sourceRoot: '/not-opened', supplementRoot: '/not-opened' })({
      operation, context, inventory: files, totalByteSize: 2, assertCurrent() {} }), { code: 'supplement_platform_unsupported' });
    assert.equal(releases, 1); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-supplement-custody-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'), supplementRoot = path.join(root, 'private');
  fs.mkdirSync(sourceRoot); fs.mkdirSync(path.join(supplementRoot, operation.id, operation.lease_token), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'model.obj'), 'obj');
  fs.writeFileSync(path.join(supplementRoot, operation.id, operation.lease_token, 'tileset.json'), '{}');
  const custody = await createPinnedReadCustody({ ...options, sourceRoot, supplementRoot })({
    operation, context, inventory: files, totalByteSize: 2, assertCurrent() {} });
  t.after(() => custody.release());
  await custody.verifySource(context.input.files); await custody.verifyOutput(files); custody.assertPinned();
  assert.deepEqual(custody.register({ assertLease() {} }), { verified: true });
  custody.release(); custody.release(); assert.equal(releases, 1);
  assert.throws(() => custody.source.assertPinned(), { code: 'supplement_pin_closed' });
  // A symlink in the server-derived parent chain must not redirect the slot.
  fs.rmSync(path.join(supplementRoot, operation.id), { recursive: true });
  fs.symlinkSync(sourceRoot, path.join(supplementRoot, operation.id));
  await assert.rejects(createPinnedReadCustody({ ...options, sourceRoot, supplementRoot })({
    operation, context, inventory: files, totalByteSize: 2, assertCurrent() {} }));
  assert.equal(releases, 2);
});
