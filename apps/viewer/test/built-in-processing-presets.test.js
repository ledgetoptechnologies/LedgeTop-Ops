'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProcessingApi } = require('../server/processingApi');
const { NodeOdmProvider } = require('../server/nodeOdmProvider');

// User-provided exports, independent of the server seed. Convert numeric text
// exactly once, without expanding any omitted setting into a guessed default.
const requested = [
  ['large-3d', 'Large 3D', [
    ['auto-boundary', true], ['crop', '1'], ['feature-quality', 'medium'],
    ['matcher-neighbors', '12'], ['use-hybrid-bundle-adjustment', true], ['use-exif', true],
    ['pc-sample', '.05'], ['mesh-size', '400000'], ['texturing-keep-unseen-faces', true],
    ['orthophoto-resolution', '2'], ['orthophoto-cutline', true], ['use-3dmesh', true],
    ['max-concurrency', '16'], ['split', '400'], ['split-overlap', '150'],
  ]],
  ['high-res-2d-with-3d', 'High-Res 2D WITH 3D', [
    ['auto-boundary', true], ['crop', '1'], ['use-hybrid-bundle-adjustment', true], ['use-exif', true],
    ['pc-filter', '2'], ['pc-classify', true], ['dsm', true], ['dtm', true],
    ['dem-resolution', '1'], ['orthophoto-resolution', '1'], ['orthophoto-cutline', true],
    ['rerun-from', 'dataset'],
  ]],
  ['high-res-3d', 'High-Res 3D', [
    ['auto-boundary', true], ['crop', '1'], ['feature-quality', 'ultra'], ['min-num-features', '40000'],
    ['matcher-neighbors', '16'], ['use-exif', true], ['pc-filter', '2'], ['pc-classify', true],
    ['mesh-octree-depth', '12'], ['mesh-size', '600000'], ['texturing-keep-unseen-faces', true],
    ['dsm', true], ['dtm', true], ['dem-resolution', '1'], ['orthophoto-resolution', '1'],
    // User approved the engine default for the unsupported depthmap flag.
    ['orthophoto-cutline', true], ['use-3dmesh', true],
  ]],
];
const expectedOptions = entries => Object.fromEntries(entries.map(([name, value]) =>
  [name, typeof value === 'string' && /^\d*\.?\d+$/.test(value) ? Number(value) : value]));
const requiredOutputs = { 'pc-ept': true, gltf: true, '3d-tiles': true };
const floatOptions = new Set(['crop', 'pc-sample', 'pc-filter', 'dem-resolution', 'orthophoto-resolution']);

async function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-built-in-presets-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database), processing = new ProcessingRepository(database);
  const token = 'built-in-preset-test-token-000000000000000';
  processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'ops:presets',
    permissions: ['viewer.processing.write', 'viewer.processing.read'], displayUnits: 'imperial',
    expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const project = processing.createProject({ displayName: 'Preset test' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Photos',
    storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const empty = crypto.createHash('sha256').digest('hex');
  processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 0, sha256: empty }], empty);
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const values = Object.assign({}, ...requested.map(([, , entries]) => expectedOptions(entries)), requiredOutputs);
  const capabilities = { options: Object.entries(values).map(([name, value]) => ({ name,
    type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? floatOptions.has(name) ? 'float' : 'int' : 'enum',
    ...(typeof value === 'string' ? { domain: name === 'feature-quality' ? ['medium', 'high', 'ultra'] : ['dataset'] } : {}),
  })) };
  processing.updateProviderCapabilities(provider.id, { capabilities, fingerprint: 'a'.repeat(64), health: 'healthy' });
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use(createProcessingApi({ repository, processing, storage: {} }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const submit = (presetId, options = {}) => fetch(`${base}/api/v1/task-submissions`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ submissionId: crypto.randomUUID(), projectId: project.id, datasetId: dataset.id,
      taskDisplayName: 'Preset task', providerId: provider.id, presetId, options }),
  });
  return { processing, provider, capabilities, database, submit };
}

test('new built-ins seed existing databases idempotently without altering custom presets', async t => {
  const { processing, database } = await harness(t);
  const custom = processing.createPreset({ displayName: 'Saved settings', options: { dsm: false } });
  const count = processing.listPresets().length;
  database.prepare("DELETE FROM processing_presets WHERE id IN ('large-3d','high-res-2d-with-3d','high-res-3d')").run();
  new ProcessingRepository(database);
  new ProcessingRepository(database);
  assert.equal(processing.listPresets().length, count);
  assert.deepEqual(processing.getPreset(custom.id), custom);
  for (const [id, displayName, entries] of requested) {
    const preset = processing.getPreset(id);
    assert.equal(preset.displayName, displayName);
    assert.equal(preset.builtIn, true);
    assert.equal(preset.enabled, true);
    assert.deepEqual(preset.options, expectedOptions(entries));
  }
});

test('each preset submits exact overrides and serializes typed NodeODM options without cross-preset defaults', async t => {
  const { submit } = await harness(t);
  for (const [id, , entries] of requested) {
    const response = await submit(id);
    assert.equal(response.status, 201, await response.clone().text());
    const { attempt } = await response.json();
    const expected = { ...expectedOptions(entries), ...requiredOutputs };
    assert.deepEqual(attempt.options, expected);
    assert.equal(Object.hasOwn(attempt.options, 'pc-quality'), false);
    let received;
    const node = new NodeOdmProvider({ endpoint: 'http://node.test', fetchImpl: async (_url, init) => {
      received = JSON.parse(init.body.get('options'));
      return new Response(JSON.stringify({ uuid: attempt.providerTaskId }), { headers: { 'content-type': 'application/json' } });
    } });
    await node.initialize({ uuid: attempt.providerTaskId, name: id, options: attempt.options });
    assert.deepEqual(Object.fromEntries(received.map(({ name, value }) => [name, value])), expected);
  }
  const overridden = await submit('large-3d', { 'mesh-size': 500000 });
  assert.equal(overridden.status, 201);
  assert.equal((await overridden.json()).attempt.options['mesh-size'], 500000);
});

test('High-Res 3D uses node defaults for depthmap and pc-quality; explicit unsupported overrides still fail', async t => {
  const { processing, provider, capabilities, submit, database } = await harness(t);
  processing.updateProviderCapabilities(provider.id, { capabilities: { ...capabilities,
    options: capabilities.options.filter(option => option.name !== 'depthmap-resolution') },
    fingerprint: 'b'.repeat(64), health: 'healthy' });
  const response = await submit('high-res-3d', { 'depthmap-resolution': 1280 });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_provider_option');
  assert.equal(database.prepare('SELECT COUNT(*) n FROM processing_attempts').get().n, 0);
  assert.equal(Object.hasOwn(processing.getPreset('high-res-3d').options, 'depthmap-resolution'), false);
  const supported = await submit('high-res-3d');
  assert.equal(supported.status, 201);
  const { attempt } = await supported.json();
  assert.equal(Object.hasOwn(attempt.options, 'depthmap-resolution'), false);
  assert.equal(Object.hasOwn(attempt.options, 'pc-quality'), false);
});

test('startup upgrades only the exact old High-Res 3D seed and preserves disabled state, custom copies and attempts', async t => {
  const { processing, database, submit } = await harness(t);
  const current = processing.getPreset('high-res-3d');
  const legacy = { ...current.options, 'depthmap-resolution': 1280 };
  const custom = processing.createPreset({ displayName: current.displayName, options: legacy });
  const response = await submit('high-res-3d');
  assert.equal(response.status, 201);
  const { attempt } = await response.json();
  // Existing history retains the old options exactly, even when its seed updates.
  database.prepare('UPDATE processing_attempts SET options_json=? WHERE id=?').run(JSON.stringify(legacy), attempt.id);
  database.prepare("UPDATE processing_presets SET options_json=?,enabled=0,updated_at='2000-01-01T00:00:00.000Z' WHERE id='high-res-3d'")
    .run(JSON.stringify(Object.fromEntries(Object.entries(legacy).reverse())));
  new ProcessingRepository(database);
  const upgraded = processing.getPreset('high-res-3d');
  assert.deepEqual(upgraded.options, current.options);
  assert.equal(upgraded.enabled, false);
  assert.deepEqual(processing.getPreset(custom.id), custom);
  assert.deepEqual(processing.getAttempt(attempt.id).options, legacy);
  new ProcessingRepository(database);
  assert.deepEqual(processing.getPreset('high-res-3d'), upgraded, 'migration is idempotent');
});

test('startup leaves changed legacy seeds and custom records with the built-in identifier untouched', async t => {
  const { processing, database } = await harness(t);
  const current = processing.getPreset('high-res-3d');
  const legacy = { ...current.options, 'depthmap-resolution': 1280 };
  for (const change of [
    { options: { ...legacy, 'mesh-size': 700000 } },
    { options: { ...legacy, 'depthmap-resolution': '1280' } },
    { options: { ...legacy, additional: true } },
    { builtIn: false }, { name: 'Locally adjusted preset' }, { providerType: 'nodeodm' }, { fingerprint: 'custom-fingerprint' },
  ]) {
    database.prepare("UPDATE processing_presets SET options_json=?,built_in=?,display_name=?,provider_type=?,capability_fingerprint=? WHERE id='high-res-3d'")
      .run(JSON.stringify(change.options || legacy), change.builtIn === false ? 0 : 1, change.name || current.displayName,
        change.providerType || null, change.fingerprint || null);
    const before = processing.getPreset('high-res-3d');
    new ProcessingRepository(database);
    assert.deepEqual(processing.getPreset('high-res-3d'), before);
  }
});
