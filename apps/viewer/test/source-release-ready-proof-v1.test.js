'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ReferenceProtocol = require('../server/referenceProtocol');
const { verifiedOutputProof } = require('../server/sourceReleaseReadyProofV1');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const attemptId = '00000000-0000-4000-8000-000000000004';
const modelId = '00000000-0000-4000-8000-000000000010';
const versionId = '00000000-0000-4000-8000-000000000011';
const taskId = '00000000-0000-4000-8000-000000000012';
const outputPath = `${taskId}/${attemptId}/reference-v2-results`;

function fixture({ wrongState = null, missingAsset = null, derivativeStatus = {}, optionalOutput = false,
  changeRegistration = false, treedarManifest = false, tilesRelativePath = null, requestTilesRelativePath = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-source-release-ready-'));
  const assetRoot = path.join(root, outputPath, 'output', 'assets');
  const acceptedRoot = path.join(root, outputPath, 'accepted_objects');
  fs.mkdirSync(assetRoot, { recursive: true });
  fs.mkdirSync(acceptedRoot, { recursive: true });
  const assets = [];
  const filesByAsset = new Map();
  function addFileAsset(kind, relativePath, value) {
    const full = path.join(root, outputPath, 'output', relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, value);
    const asset = { id: `asset-${kind}`, version_id: versionId, kind, root_key: 'models',
      relative_path: `${outputPath}/output/${relativePath}`, storage_mode: 'managed', byte_size: Buffer.byteLength(value),
      sha256: sha(value), manifest_sha256: null, source_attempt_id: attemptId };
    assets.push(asset); filesByAsset.set(asset.id, []); return asset;
  }
  const obj = addFileAsset('obj', 'assets/mesh/model.obj', 'obj-bytes');
  const glb = addFileAsset('glb', 'assets/mesh/model.glb', 'glb-bytes');
  const eptFiles = [
    { relative_path: 'data.bin', byte_size: 8, sha256: sha('ept-data') },
    { relative_path: 'ept.json', byte_size: 8, sha256: sha('ept-json') },
  ];
  fs.mkdirSync(path.join(assetRoot, 'ept'), { recursive: true });
  fs.writeFileSync(path.join(assetRoot, 'ept', 'ept.json'), 'ept-json');
  fs.writeFileSync(path.join(assetRoot, 'ept', 'data.bin'), 'ept-data');
  const ept = { id: 'asset-ept', version_id: versionId, kind: 'ept', root_key: 'models',
    relative_path: `${outputPath}/output/assets/ept/ept.json`, storage_mode: 'managed', byte_size: 8, sha256: sha('ept-json'),
    manifest_sha256: sha(JSON.stringify(eptFiles.map(({ relative_path, byte_size, sha256 }) => ({
      relativePath: relative_path, byteSize: byte_size, sha256,
    })))), source_attempt_id: attemptId };
  assets.push(ept); filesByAsset.set(ept.id, eptFiles);
  const derivativeTilesRoot = `${taskId}/${attemptId}/tiles-ktx2-etc1s-job-mesh_tiles`;
  const tilesRoot = tilesRelativePath || derivativeTilesRoot;
  const tilesFiles = [{ relative_path: 'tileset.json', byte_size: Buffer.byteLength('tileset-json'), sha256: sha('tileset-json') },
    { relative_path: 'tile.b3dm', byte_size: Buffer.byteLength('tile-bytes'), sha256: sha('tile-bytes') }];
  fs.mkdirSync(path.join(root, tilesRoot), { recursive: true });
  fs.writeFileSync(path.join(root, tilesRoot, 'tileset.json'), 'tileset-json');
  fs.writeFileSync(path.join(root, tilesRoot, 'tile.b3dm'), 'tile-bytes');
  const tiles = { id: 'asset-tiles', version_id: versionId, kind: 'tiles', root_key: 'models',
    relative_path: `${tilesRoot}/tileset.json`, storage_mode: 'managed', byte_size: Buffer.byteLength('tileset-json'),
    sha256: sha('tileset-json'), manifest_sha256: sha(JSON.stringify(tilesFiles.map(({ relative_path, byte_size, sha256 }) => ({
      relativePath: relative_path, byteSize: byte_size, sha256,
    })))), source_attempt_id: attemptId };
  assets.push(tiles); filesByAsset.set(tiles.id, tilesFiles);
  if (optionalOutput) addFileAsset('orthophoto', 'assets/optional/ortho.tif', 'optional-ortho');
  if (missingAsset) {
    const index = assets.findIndex((asset) => asset.kind === missingAsset);
    if (index >= 0) { filesByAsset.delete(assets[index].id); assets.splice(index, 1); }
  }

  const manifestBase = { schemaVersion: 1, jobId: 'processing-job', generation: 1, environment: 'staging',
    pipelineDigest: 'a'.repeat(64), engineVersions: { odm: 'test-version' },
    objects: [{ id: 'odm-archive', role: 'odm_archive', byteSize: Buffer.byteLength('archive-bytes'), sha256: sha('archive-bytes') }] };
  const manifest = { ...manifestBase, resultManifestSha256: ReferenceProtocol.resultManifestSha256(manifestBase) };
  if (treedarManifest) {
    const requiredRoles = ['ground_model', 'canopy_height', 'canopy_height_unfiltered', 'crown_labels',
      'crowns', 'tree_table', 'tree_features', 'run_summary', 'report', 'preview', 'area_map_preview', 'engine_manifest'];
    manifest.engineVersions = { odm: 'test-version', treedar: 'test-version' };
    manifest.objects = [...requiredRoles, 'odm_archive'].map((role) => {
      const id = `accepted-${role}`, bytes = Buffer.from(`hash-valid-${role}`);
      fs.writeFileSync(path.join(acceptedRoot, `${id}.bin`), bytes);
      return { id, role, byteSize: bytes.length, sha256: sha(bytes) };
    });
    manifest.schemaVersion = 2;
    manifest.protocol = ReferenceProtocol.TREEDAR_RESULT_PROTOCOL;
    manifest.resultManifestSha256 = ReferenceProtocol.resultManifestSha256(manifest);
  }
  fs.writeFileSync(path.join(acceptedRoot, 'odm-archive.bin'), 'archive-bytes');
  const intent = {
    state: 'accepted', sourceIntakeCanonical: JSON.stringify({ pipeline: { odm: { requested: true }, treedar: { requested: treedarManifest } } }),
    resultManifestCanonical: JSON.stringify(manifest), copyRequestCanonical: '{}', copyAckCanonical: '{}',
    resultManifestSha256: sha(JSON.stringify(manifest)), copyAckSha256: 'b'.repeat(64),
    remoteBinding: { protocol: 'ltds-viewer-source-intake-binding-v2', jobId: 'processing-job', generation: 1,
      environment: 'staging', pipelineDigest: 'a'.repeat(64) },
  };
  let assetReadCount = 0;
  const metadata = { lodProvenance: {
    schemaVersion: 2, geometry: 'bounded-triangle-equivalence', textures: 'byte-identical-material-equivalence',
    sourceSha256: glb.sha256, tilesManifestSha256: tiles.manifest_sha256,
    sourceAsset: path.posix.basename(glb.relative_path), leafGeometricError: 0,
    audit: { algorithm: 'ltds-glb-leaf-equivalence-v2', artifactCount: 2 },
  } };
  const derivativeRows = ['mesh_tiles'].map((type) => ({ id: `job-${type}`, attempt_id: attemptId,
    derivative_type: type, status: derivativeStatus[type] || 'complete',
    request_json: JSON.stringify({ optional: false, ...(requestTilesRelativePath ? { tilesRelativePath: requestTilesRelativePath } : {}) }) }));
  const receipt = { id: 'receipt-event', details_json: JSON.stringify({
    attemptId, manifestSha256: tiles.manifest_sha256, policySha256: null, published: false,
    sourceSha256: glb.sha256, versionId,
  }) };
  let stateReads = 0;
  const state = {
    attempt_id: attemptId, task_id: taskId, attempt_status: 'ready_for_review', result_model_id: modelId,
    result_model_version_id: versionId, model_id: modelId, version_id: versionId, active_attempt_id: attemptId,
    task_status: 'ready_for_review', model_status: 'ready', active_version_id: null, version_status: 'ready',
    version_model_id: modelId, metadata_json: JSON.stringify(metadata), output_id: versionId, output_status: 'ready',
    output_attempt_id: attemptId, output_model_id: modelId, output_root_key: 'models', output_relative_path: outputPath,
  };
  const database = { prepare(sql) { return {
    get: () => {
      stateReads += 1;
      return wrongState ? { ...state, ...wrongState } : state;
    },
    all: (...params) => {
      if (sql.includes('FROM model_assets')) {
        assetReadCount += 1;
        if (changeRegistration && assetReadCount === 2) ept.sha256 = 'c'.repeat(64);
        return assets.map((asset) => ({ ...asset }));
      }
      if (sql.includes('FROM model_asset_files')) return (filesByAsset.get(params[0]) || []).map((file) => ({ ...file }));
      if (sql.includes('FROM derivative_jobs')) return derivativeRows.map((row) => ({ ...row }));
      if (sql.includes('FROM audit_events')) return params[0] === 'job-mesh_tiles' ? [{ ...receipt }] : [];
      throw new Error(`Unexpected query: ${sql}`);
    },
  }; } };
  const storage = { resolve(rootKey, relative) {
    assert.equal(rootKey, 'models');
    const absolute = path.resolve(root, ...relative.split('/'));
    assert.ok(absolute.startsWith(root + path.sep));
    return absolute;
  } };
  const sourceIntake = { outbox: { getIntent(id) { assert.equal(id, attemptId); return { ...intent }; } } };
  return { root, attemptId, database, storage, sourceIntake, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('ready proof accepts engine-provided EPT without a LAS asset or local EPT derivative', async (t) => {
  const f = fixture({ optionalOutput: true }); t.after(f.cleanup);
  const proof = await verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
    sourceIntake: f.sourceIntake, attemptId: f.attemptId });
  assert.equal(proof.kind, 'verified_outputs_ready');
  assert.equal(proof.modelId, modelId);
  assert.equal(proof.modelVersionId, versionId);
  assert.match(proof.outputInventorySha256, /^[a-f0-9]{64}$/);
});

test('ready proof accepts generated tiles only at their exact attempt and derivative owned path', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const proof = await verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
    sourceIntake: f.sourceIntake, attemptId: f.attemptId });
  assert.equal(proof.kind, 'verified_outputs_ready');
});

test('ready proof rejects tiles registered outside the completed derivative path', async (t) => {
  const f = fixture({ tilesRelativePath: `${taskId}/${attemptId}/unrelated/tiles` }); t.after(f.cleanup);
  await assert.rejects(verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
    sourceIntake: f.sourceIntake, attemptId: f.attemptId }),
    (error) => error.code === 'source_release_required_derivative_not_ready');
});

test('ready proof rejects a derivative request whose recorded tiles path disagrees with its job identity', async (t) => {
  const f = fixture({ requestTilesRelativePath: `${taskId}/${attemptId}/unrelated/tiles` }); t.after(f.cleanup);
  await assert.rejects(verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
    sourceIntake: f.sourceIntake, attemptId: f.attemptId }),
    (error) => error.code === 'source_release_required_derivative_not_ready');
});

test('ready proof rejects a non-current attempt or unpublished output inventory', async (t) => {
  const f = fixture({ wrongState: { active_attempt_id: 'old-attempt' } }); t.after(f.cleanup);
  await assert.rejects(verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
    sourceIntake: f.sourceIntake, attemptId: f.attemptId }),
    (error) => error.code === 'source_release_outputs_not_ready');
});

test('ready proof rejects missing required registered outputs even when output status is ready', async (t) => {
  const f = fixture({ missingAsset: 'ept' }); t.after(f.cleanup);
  await assert.rejects(verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
    sourceIntake: f.sourceIntake, attemptId: f.attemptId }),
    (error) => error.code === 'source_release_required_output_missing');
});

test('ready proof rejects pending or failed required mesh derivatives', async (t) => {
  for (const status of ['pending', 'failed']) {
    const f = fixture({ derivativeStatus: { mesh_tiles: status } }); t.after(f.cleanup);
    await assert.rejects(verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
      sourceIntake: f.sourceIntake, attemptId: f.attemptId }),
      (error) => error.code === 'source_release_required_derivative_not_ready');
  }
});

test('ready proof rejects TreeDar profiles until their required roles have typed Viewer readiness', async (t) => {
  const f = fixture({ treedarManifest: true }); t.after(f.cleanup);
  const intent = f.sourceIntake.outbox.getIntent(f.attemptId);
  const manifest = JSON.parse(intent.resultManifestCanonical);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.objects.length, 13);
  for (const object of manifest.objects) {
    const bytes = fs.readFileSync(path.join(f.root, outputPath, 'accepted_objects', `${object.id}.bin`));
    assert.equal(bytes.length, object.byteSize);
    assert.equal(sha(bytes), object.sha256);
  }
  await assert.rejects(verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
    sourceIntake: f.sourceIntake, attemptId: f.attemptId }),
    (error) => error.code === 'source_release_required_output_policy_unknown');
});

test('ready proof rejects physical bytes that no longer match the registered output', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  fs.writeFileSync(path.join(f.root, outputPath, 'output', 'assets', 'mesh', 'model.obj'), 'different');
  await assert.rejects(verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
    sourceIntake: f.sourceIntake, attemptId: f.attemptId }),
    (error) => error.code === 'source_release_output_changed');
});

test('ready proof rechecks required asset registrations after hashing', async (t) => {
  const f = fixture({ changeRegistration: true }); t.after(f.cleanup);
  await assert.rejects(verifiedOutputProof({ processing: { database: f.database }, storage: f.storage,
    sourceIntake: f.sourceIntake, attemptId: f.attemptId }),
    (error) => error.code === 'source_release_output_binding_changed');
});
