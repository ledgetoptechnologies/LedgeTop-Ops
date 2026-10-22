'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { createApiV1, toViewerConfig } = require('../server/apiV1');
const { openDatabase } = require('../server/database');
const { createProcessingApi } = require('../server/processingApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const {
  CONTROLLED_CONVERTER,
  CONTROLLED_CONVERTER_COMMAND_SHA256,
  CONTROLLED_SURFACE_AUDIT_POLICY_V4,
  OFFICIAL_CONVERTER_BINARY_SHA256,
} = require('../lod-converter-policy.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-receipt-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const repository = new ViewerRepository(database);
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { database, processing, repository };
}

function candidate(c, { includeObj = false } = {}) {
  const project = c.processing.createProject({ displayName: `LOD receipt ${crypto.randomUUID()}` });
  const dataset = c.processing.createDataset({ projectId: project.id, displayName: 'Source', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  c.processing.finalizeDataset(dataset.id, [], 'a'.repeat(64));
  const task = c.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Receipt candidate' });
  const attempt = c.processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id, providerTaskId: 'receipt', createdBy: 'ops:test', staged: false });
  const modelAssets = [{ kind: 'glb', rootKey: 'models', relativePath: 'receipt/model.glb', sha256: 'b'.repeat(64), published: false }];
  if (includeObj) modelAssets.push({ kind: 'obj', rootKey: 'models', relativePath: 'receipt/model.obj', sha256: 'a'.repeat(64), published: false });
  const model = c.repository.upsertModelVersion({
    provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id,
    displayName: task.displayName, status: 'ready',
    assets: modelAssets,
    makeActive: false,
  });
  const versionId = c.database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  c.processing.setAttemptResult(attempt.id, model.id, versionId);
  c.processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: 'receipt', status: 'staged', byteSize: 1, assetCount: modelAssets.length });
  c.database.prepare("UPDATE processing_attempts SET status='derivatives' WHERE id=?").run(attempt.id);
  return { attemptId: attempt.id, modelId: model.id, versionId };
}

function v4Provenance() {
  const direction = { sampleCount: 100, maximumDistance: 0, minimumNormalDot: 1, reversedNormalSampleCount: 0, reversedNormalFraction: 0 };
  return {
    schemaVersion: 4,
    sourceAsset: 'model.glb',
    sourceSha256: 'b'.repeat(64),
    tilesManifestSha256: 'd'.repeat(64),
    geometry: 'controlled-bidirectional-surface-equivalence',
    textures: 'controlled-atlas-material-equivalence',
    leafGeometricError: 0,
    converter: {
      name: CONTROLLED_CONVERTER.name,
      version: CONTROLLED_CONVERTER.version,
      commandSha256: CONTROLLED_CONVERTER_COMMAND_SHA256,
      inputAsset: 'model.obj',
      inputSha256: 'a'.repeat(64),
      binarySha256: OFFICIAL_CONVERTER_BINARY_SHA256[0],
    },
    audit: {
      algorithm: 'ltds-obj2tiles-surface-equivalence-v4',
      policyRevision: CONTROLLED_SURFACE_AUDIT_POLICY_V4.revision,
      policy: { ...CONTROLLED_SURFACE_AUDIT_POLICY_V4 },
      accumulationMethod: CONTROLLED_SURFACE_AUDIT_POLICY_V4.accumulationMethod,
      sourceTriangleCount: 100,
      leafTriangleCount: 100,
      surfaceTolerance: 0.001,
      areaRelativeDelta: 0,
      boundsDelta: 0,
      centroidDelta: 0,
      normalizedSecondMomentDelta: 0,
      numericalAgreement: { maximumRelativeDelta: 0 },
      sourceToLeaves: { ...direction },
      leavesToSource: { ...direction },
      acceptance: 'normal',
      equivalenceSha256: 'e'.repeat(64),
      artifactCount: 2,
    },
  };
}

test('hand-written provenance summary and matching asset digests do not grant server authority', (t) => {
  const c = fixture(t);
  const item = candidate(c);
  c.processing.addModelAsset({
    versionId: item.versionId,
    kind: 'tiles',
    rootKey: 'models',
    relativePath: 'receipt/hand-written/tileset.json',
    format: '3dtiles',
    contentType: 'application/json',
    byteSize: 2,
    attemptId: item.attemptId,
    sha256: 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    manifestFiles: [{ relativePath: 'tileset.json', byteSize: 2, sha256: 'c'.repeat(64) }],
  });
  c.database.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({
    lodProvenance: {
      schemaVersion: 2,
      sourceAsset: 'model.glb',
      sourceSha256: 'b'.repeat(64),
      tilesManifestSha256: 'd'.repeat(64),
      geometry: 'bounded-triangle-equivalence',
      textures: 'byte-identical-material-equivalence',
      leafGeometricError: 0,
      audit: { algorithm: 'ltds-glb-leaf-equivalence-v2', artifactCount: 2 },
    },
  }), item.versionId);
  const config = toViewerConfig(c.repository.getModelVersion(item.modelId, item.versionId));
  assert.ok(config.assets.tiles, 'legacy-compatible assets remain available for browser-side validation');
  assert.equal(config.lodProvenanceVerified, false);
});

test('LOD authority is issued only by an exact durable receipt for a completed verified job', (t) => {
  const c = fixture(t);
  const item = candidate(c);
  const owner = 'lod-receipt-worker';
  const jobId = c.processing.enqueueDerivative(item.attemptId, 'lod_audit', { optional: false });
  const job = c.processing.claimDerivative(owner);
  assert.equal(job.id, jobId);

  const provenance = {
    schemaVersion: 2,
    sourceAsset: 'model.glb',
    sourceSha256: 'b'.repeat(64),
    tilesManifestSha256: 'd'.repeat(64),
    geometry: 'bounded-triangle-equivalence',
    textures: 'byte-identical-material-equivalence',
    leafGeometricError: 0,
    audit: { algorithm: 'ltds-glb-leaf-equivalence-v2', artifactCount: 2 },
  };
  const asset = {
    versionId: item.versionId,
    rootKey: 'models',
    relativePath: 'receipt/tiles/tileset.json',
    format: '3dtiles',
    contentType: 'application/json',
    byteSize: 2,
    attemptId: item.attemptId,
    sha256: 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    manifestFiles: [
      { relativePath: 'leaf.b3dm', byteSize: 4, sha256: 'e'.repeat(64) },
      { relativePath: 'tileset.json', byteSize: 2, sha256: 'c'.repeat(64) },
    ],
  };
  const registered = c.processing.registerVerifiedLodAsset(job.id, owner, asset, provenance, { leaseToken: job.lease_token });
  assert.ok(registered);
  c.database.prepare("DELETE FROM audit_events WHERE action='derivative.tiles_verified' AND entity_id=?").run(job.id);
  assert.equal(c.processing.registerVerifiedLodAsset(job.id, owner, asset, provenance, { leaseToken: job.lease_token }), registered, 'idempotent re-verification restores the missing receipt');
  assert.equal(c.database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='derivative.tiles_verified' AND entity_id=?").get(job.id).n, 1);
  assert.equal(c.processing.registerVerifiedLodAsset(job.id, owner, asset, provenance, { leaseToken: job.lease_token }), registered);
  assert.equal(c.database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='derivative.tiles_verified' AND entity_id=?").get(job.id).n, 1, 'a repeated lease does not duplicate its receipt');

  const viewer = () => toViewerConfig(c.repository.getModelVersion(item.modelId, item.versionId));
  assert.equal(viewer().lodProvenanceVerified, false, 'registration alone is not job completion');
  assert.equal(c.processing.completeDerivative(job.id, owner, { verified: true }, job.lease_token), true);
  assert.equal(viewer().lodProvenanceVerified, true);
  const repositoryModel = c.repository.getModelVersion(item.modelId, item.versionId);
  assert.ok(repositoryModel.activeVersion.lodVerifierReceipt);
  assert.equal(JSON.stringify(repositoryModel).includes('lodVerifierReceipt'), false, 'generic repository responses cannot serialize the internal receipt');

  const event = c.database.prepare("SELECT id,details_json FROM audit_events WHERE action='derivative.tiles_verified' AND entity_id=?").get(job.id);
  const currentReceipt = JSON.parse(event.details_json);
  assert.equal(currentReceipt.receiptVersion, 1);

  c.database.prepare('UPDATE audit_events SET details_json=? WHERE id=?').run(JSON.stringify({ ...currentReceipt, provenanceSha256: 'f'.repeat(64) }), event.id);
  assert.equal(viewer().lodProvenanceVerified, false, 'tampered provenance digest');
  c.database.prepare('UPDATE audit_events SET details_json=? WHERE id=?').run(JSON.stringify(currentReceipt), event.id);
  c.database.prepare('UPDATE audit_events SET details_json=? WHERE id=?').run(JSON.stringify({ ...currentReceipt, leaseToken: crypto.randomUUID() }), event.id);
  assert.equal(viewer().lodProvenanceVerified, false, 'a receipt from another lease cannot authorize the completion');
  c.database.prepare('UPDATE audit_events SET details_json=? WHERE id=?').run(JSON.stringify(currentReceipt), event.id);

  c.database.prepare('UPDATE derivative_jobs SET result_json=? WHERE id=?').run(JSON.stringify({ verified: false }), job.id);
  assert.equal(viewer().lodProvenanceVerified, false, 'completed but non-verifying job');
  c.database.prepare('UPDATE derivative_jobs SET result_json=? WHERE id=?').run(JSON.stringify({ verified: true }), job.id);
  assert.equal(viewer().lodProvenanceVerified, true);

  const metadata = JSON.parse(c.database.prepare('SELECT metadata_json FROM model_versions WHERE id=?').get(item.versionId).metadata_json);
  const changedMetadata = { lodProvenance: { ...metadata.lodProvenance, audit: { ...metadata.lodProvenance.audit, artifactCount: 3 } } };
  c.database.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify(changedMetadata), item.versionId);
  assert.equal(viewer().lodProvenanceVerified, false, 'otherwise-valid summary no longer matches its receipt');
  c.database.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), item.versionId);

  const legacyReceipt = {
    attemptId: item.attemptId,
    versionId: item.versionId,
    published: false,
    sourceSha256: provenance.sourceSha256,
    manifestSha256: provenance.tilesManifestSha256,
    policySha256: null,
  };
  c.database.prepare('UPDATE audit_events SET details_json=? WHERE id=?').run(JSON.stringify(legacyReceipt), event.id);
  assert.equal(viewer().lodProvenanceVerified, true, 'exact historical worker receipt remains supported');
  c.database.prepare('UPDATE audit_events SET details_json=? WHERE id=?').run(JSON.stringify({ ...legacyReceipt, untrusted: true }), event.id);
  assert.equal(viewer().lodProvenanceVerified, false, 'arbitrary shape is not accepted as a legacy receipt');
});

test('published v4 sessions validate with the unpublished OBJ proof without exposing it', async (t) => {
  const c = fixture(t);
  const item = candidate(c, { includeObj: true });
  const owner = 'v4-published-worker';
  c.processing.enqueueDerivative(item.attemptId, 'mesh_tiles', { optional: false });
  const job = c.processing.claimDerivative(owner);
  assert.ok(job);
  const provenance = v4Provenance();
  assert.ok(c.processing.registerVerifiedLodAsset(job.id, owner, {
    versionId: item.versionId,
    rootKey: 'models',
    relativePath: 'receipt/tiles-v4/tileset.json',
    format: '3dtiles',
    contentType: 'application/json',
    byteSize: 2,
    attemptId: item.attemptId,
    sha256: 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
    manifestFiles: [
      { relativePath: 'leaf.b3dm', byteSize: 4, sha256: 'f'.repeat(64) },
      { relativePath: 'tileset.json', byteSize: 2, sha256: 'c'.repeat(64) },
    ],
  }, provenance, { leaseToken: job.lease_token }));
  assert.equal(c.processing.completeDerivative(job.id, owner, { verified: true }, job.lease_token), true);
  c.database.prepare("UPDATE processing_attempts SET status='ready_for_review' WHERE id=?").run(item.attemptId);
  c.database.prepare("UPDATE model_outputs SET status='ready' WHERE id=?").run(item.versionId);
  assert.ok(c.processing.publishAttemptAtomic(item.attemptId, ['glb', 'tiles'], { actorId: 'ops:test' }));

  const publication = c.repository.getModel(item.modelId);
  assert.deepEqual(publication.activeVersion.assets.map((asset) => asset.kind).sort(), ['glb', 'tiles']);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(publication)).activeVersion, 'lodVerificationAssets'), false, 'the private proof asset set is not serializable from the published model');
  const publishedConfig = toViewerConfig(publication);
  assert.ok(publishedConfig.assets.tiles);
  assert.equal(publishedConfig.assets.obj, null);
  assert.equal(publishedConfig.lodProvenanceVerified, true);

  const authorizationExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const adminToken = 'published-v4-output-session-token-000000000';
  c.processing.createAdminSession({
    tokenHash: auth.hashToken(adminToken), subject: 'ops:published-v4', permissions: ['viewer.processing.read'],
    displayUnits: 'imperial', expiresAt: authorizationExpiresAt,
  });
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(createProcessingApi({ repository: c.repository, processing: c.processing, storage: {} }));
  app.use(createApiV1(c.repository));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const issuedResponse = await fetch(`${base}/api/v1/processing/outputs/${item.versionId}/view-sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'published-v4-session-issuance' },
    body: '{}',
  });
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();
  assert.deepEqual(issued.assetKinds, ['glb', 'tiles'], 'session issuance validates and reports the private-proof-backed published tiles');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/sessions/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant: issued.grant }),
  });
  assert.equal(response.status, 200);
  const current = await response.json();
  assert.equal(current.permissions.cameraPhotoDownload, true, 'staff published sessions offer original-photo download');
  assert.equal(current.permissions.download, false, 'general model downloads remain disabled');
  assert.ok(current.model.assets.tiles);
  assert.equal(current.model.assets.obj, null);
  assert.equal(current.model.lodProvenanceVerified, true);

  const tiles = c.database.prepare("SELECT id FROM model_assets WHERE version_id=? AND kind='tiles'").get(item.versionId);
  c.database.prepare("DELETE FROM model_asset_files WHERE asset_id=? AND relative_path='tileset.json'").run(tiles.id);
  const unsafeIssuance = await fetch(`${base}/api/v1/processing/outputs/${item.versionId}/view-sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'published-v4-missing-root-manifest' },
    body: '{}',
  });
  assert.equal(unsafeIssuance.status, 409, 'a published session is not issued when the tileset root left its registered manifest');
  assert.equal((await unsafeIssuance.json()).code, 'asset_integrity_not_ready');
});
