'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations, MIGRATIONS } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { MeasurementSourceUnitEvidence } = require('../server/measurementSourceUnitEvidence');
const { EptConversionReceiptRepository } = require('../server/eptConversionReceiptRepository');
const { EPT_CONVERTER_COMMAND, EPT_CONVERTER_COMMAND_SHA256, unitProofSha256 } = require('../server/eptConversionReceipt');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, { proof = true, claim = true, inputSha256 = 'a'.repeat(64) } = {}) {
  const db = new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);t.after(() => db.close());
  const processing = new ProcessingRepository(db), repository = new ViewerRepository(db);
  const project = processing.createProject({ displayName: 'Receipt project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Receipt source', storageMode: 'managed', rootKey: 'datasets', relativePath: 'source' });
  processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 1, sha256: 'a'.repeat(64) }], 'b'.repeat(64));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Receipt task' });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {} });
  const model = repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: task.displayName, status: 'importing', assets: [], makeActive: false });
  const versionId = db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.setAttemptResult(attempt.id, model.id, versionId);
  processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id,
    relativePath: `${task.id}/${attempt.id}`, status: 'staged', byteSize: 100, assetCount: 1 });
  const inputId = crypto.randomUUID(), inputPath = `${task.id}/${attempt.id}/cloud.laz`;
  db.prepare("INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,byte_size,sha256,created_at) VALUES(?,?,'pointCloud','models',?,100,?,'now')")
    .run(inputId, versionId, inputPath, inputSha256);
  const units = new MeasurementSourceUnitEvidence(db), request = { modelId: model.id, modelVersionId: versionId,
    source: { id: inputId, kind: 'pointCloud', sha256: inputSha256, byteSize: 100 }, coordinateReference: { crs: 'EPSG:32616' } };
  if (proof) units.recordExplicitMetadata(request, { crs: 'EPSG:32616', sha256: inputSha256, byteSize: 100,
    originalUnit: 'us-ft', verticalFactor: 1200 / 3937 });
  const jobId = processing.enqueueDerivative(attempt.id, 'ept', { optional: false });
  processing.persistDerivativeInputSnapshot(jobId, 'ept', [{ role: 'point_cloud_source', rootKey: 'models', relativePath: inputPath, byteSize: 100, sha256: inputSha256 }]);
  db.prepare("UPDATE processing_attempts SET status='derivatives' WHERE id=?").run(attempt.id);
  const owner = 'receipt-worker', job = claim ? processing.claimDerivative(owner) : { id: jobId };
  assert.equal(job.id, jobId);
  const manifestFiles = [{ relativePath: 'ept.json', byteSize: 10, sha256: 'c'.repeat(64) }];
  const outputAsset = { versionId, attemptId: attempt.id, rootKey: 'models', relativePath: `${task.id}/${attempt.id}/ept-${jobId}/ept.json`,
    sha256: 'c'.repeat(64), byteSize: 10, manifestSha256: hash(JSON.stringify(manifestFiles)), manifestFiles };
  const converter = { name: 'entwine', version: 'Entwine 3.1.1', executableSha256: 'd'.repeat(64),
    command: [...EPT_CONVERTER_COMMAND], commandSha256: EPT_CONVERTER_COMMAND_SHA256 };
  const store = new EptConversionReceiptRepository(processing), options = { leaseToken: job.lease_token };
  return { db, processing, store, units, request, project, task, attempt, versionId, inputId, jobId, owner, job, options, outputAsset, converter };
}

function registerOutput(f) {
  const id = crypto.randomUUID(), asset = f.outputAsset;
  f.db.prepare("INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,byte_size,sha256,manifest_sha256,source_attempt_id,created_at) VALUES(?,?,'ept',?,?,?,?,?,?,'now')")
    .run(id, asset.versionId, asset.rootKey, asset.relativePath, asset.byteSize, asset.sha256, asset.manifestSha256, asset.attemptId);
  for (const file of asset.manifestFiles) f.db.prepare('INSERT INTO model_asset_files(asset_id,relative_path,byte_size,sha256) VALUES(?,?,?,?)').run(id, file.relativePath, file.byteSize, file.sha256);
  return { modelId: f.request.modelId, modelVersionId: f.versionId, coordinateReference: { crs: 'EPSG:32616' },
    source: { id, kind: 'ept', sha256: asset.sha256, byteSize: asset.byteSize, manifestSha256: asset.manifestSha256 } };
}

test('v38 durable receipt is committed before asset registration and survives later SQL rollback', t => {
  const f = fixture(t), receipt = f.store.create(f.jobId, f.owner, f, f.options);
  assert.ok(receipt);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM model_assets WHERE kind='ept'").get().n, 0);
  assert.deepEqual(f.store.get(f.jobId), receipt);
  const row = f.db.prepare('SELECT receipt_sha256 FROM derivative_ept_conversion_receipts WHERE job_id=?').get(f.jobId);
  assert.equal(row.receipt_sha256, unitProofSha256(receipt));
  assert.throws(() => f.processing.transaction(() => { assert.ok(f.store.validate(f.jobId, f.owner, f.outputAsset, f.options));throw new Error('simulated post-promotion SQL failure'); }), /simulated/);
  assert.deepEqual(f.store.get(f.jobId), receipt);
  assert.deepEqual(f.store.create(f.jobId, f.owner, f, f.options), receipt, 'exact retry preserves generation and time');
  assert.deepEqual(f.store.persist(f.jobId, f.owner, receipt, { ...f.options, outputAsset: f.outputAsset }), receipt);
  assert.throws(() => f.processing.transaction(() => f.store.create(f.jobId, f.owner, f, f.options)), { code: 'ept_conversion_receipt_requires_independent_commit' });
});

test('missing proof and stale/missing/wrong-owner leases cannot create receipts', t => {
  const missing = fixture(t, { proof: false });
  assert.equal(missing.store.create(missing.jobId, missing.owner, missing, missing.options), null);
  const f = fixture(t);
  for (const [owner, options] of [['wrong', f.options], [f.owner, {}], [f.owner, { leaseToken: 'stale' }]])
    assert.equal(f.store.create(f.jobId, owner, f, options), null);
  f.db.prepare("UPDATE derivative_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.jobId);
  assert.equal(f.store.create(f.jobId, f.owner, f, f.options), null);
  assert.equal(f.store.get(f.jobId), null);
});

test('receipt replays after lease reacquisition without rewriting its generation identity', t => {
  const f = fixture(t), receipt = f.store.create(f.jobId, f.owner, f, f.options);
  f.db.prepare("UPDATE derivative_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.jobId);
  f.db.prepare("UPDATE lod_conversion_lock SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE job_id=?").run(f.jobId);
  const next = f.processing.claimDerivative('resumer');
  assert.notEqual(next.lease_token, receipt.generationLeaseToken);
  assert.equal(f.store.validate(f.jobId, f.owner, f.outputAsset, f.options), null);
  assert.deepEqual(f.store.validate(f.jobId, 'resumer', f.outputAsset, { leaseToken: next.lease_token }), receipt);
  assert.deepEqual(f.store.persist(f.jobId, 'resumer', receipt, { leaseToken: next.lease_token, outputAsset: f.outputAsset }), receipt);
});

test('changed source/proof/output cannot inherit or overwrite a durable receipt', t => {
  const f = fixture(t), receipt = f.store.create(f.jobId, f.owner, f, f.options);
  const changed = { ...f.outputAsset, sha256: 'e'.repeat(64) };
  assert.equal(f.store.validate(f.jobId, f.owner, changed, f.options), null);
  assert.throws(() => f.store.create(f.jobId, f.owner, { ...f, converter: { ...f.converter, executableSha256: 'e'.repeat(64) } }, f.options),
    { code: 'ept_conversion_receipt_conflict' });
  f.db.prepare('UPDATE model_assets SET sha256=? WHERE id=?').run('f'.repeat(64), f.inputId);
  assert.equal(f.store.validate(f.jobId, f.owner, f.outputAsset, f.options), null);
  f.db.prepare('UPDATE model_assets SET sha256=? WHERE id=?').run('a'.repeat(64), f.inputId);
  const proof = f.units.get(f.request);
  proof.recordedAt = 'changed';
  f.db.prepare('UPDATE measurement_source_unit_evidence SET evidence_json=? WHERE asset_id=?').run(JSON.stringify(proof), f.inputId);
  assert.equal(f.store.validate(f.jobId, f.owner, f.outputAsset, f.options), null);
  assert.deepEqual(f.store.get(f.jobId), receipt);
});

test('mismatched job/version and fabricated proof cannot be persisted', t => {
  const f = fixture(t), receipt = f.store.create(f.jobId, f.owner, f, f.options);
  for (const altered of [{ ...receipt, modelVersionId: 'other' }, { ...receipt, jobId: 'other' },
    { ...receipt, inputUnitProof: { ...receipt.inputUnitProof, sha256: 'f'.repeat(64) } }])
    assert.throws(() => f.store.persist(f.jobId, f.owner, altered, { ...f.options, outputAsset: f.outputAsset }), { code: 'ept_conversion_receipt_invalid' });
  f.db.prepare("UPDATE processing_attempts SET status='failed' WHERE id=?").run(f.attempt.id);
  assert.equal(f.store.validate(f.jobId, f.owner, f.outputAsset, f.options), null);
});

test('receipt rows reject update/delete but follow deletion of their owning job', t => {
  const f = fixture(t);f.store.create(f.jobId, f.owner, f, f.options);
  assert.throws(() => f.db.prepare("UPDATE derivative_ept_conversion_receipts SET receipt_json='{}' WHERE job_id=?").run(f.jobId), /immutable/);
  assert.throws(() => f.db.prepare('DELETE FROM derivative_ept_conversion_receipts WHERE job_id=?').run(f.jobId), /immutable/);
  f.db.prepare('DELETE FROM derivative_jobs WHERE id=?').run(f.jobId);
  assert.equal(f.store.get(f.jobId), null);
});

test('v37 databases upgrade to v38 with no fabricated historical receipts', t => {
  const db = new DatabaseSync(':memory:');t.after(() => db.close());
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter(item => item.version <= 37)) {
    db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version, migration.name, 'now');
  }
  applyMigrations(db);applyMigrations(db);
  assert.equal(db.prepare('SELECT MAX(version) n FROM schema_migrations').get().n, 38);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM derivative_ept_conversion_receipts').get().n, 0);
});

test('derived EPT unit evidence is registered atomically and retains original foot units', t => {
  const f = fixture(t), receipt = f.store.create(f.jobId, f.owner, f, f.options);
  let request, evidence;
  f.processing.transaction(() => {
    request = registerOutput(f);
    evidence = f.units.recordVerifiedEptConversion(request, f.processing, f.jobId, f.owner, f.options);
    assert.equal(evidence.basis, 'server-verified-ept-conversion');
    assert.equal(evidence.verticalUnit, 'us-ft');
    assert.equal(evidence.verticalFactor, 1200 / 3937);
    assert.equal(evidence.conversionProof.receiptSha256, unitProofSha256(receipt));
    assert.equal(evidence.conversionProof.inputProofSha256, receipt.inputUnitProof.sha256);
    assert.equal(f.units.recordVerifiedEptConversion(request, f.processing, f.jobId, f.owner, f.options).id, evidence.id);
  });
  assert.equal(f.units.get(request).id, evidence.id);
  assert.equal(f.units.recordVerifiedEptConversion(request, f.processing, f.jobId, f.owner, f.options), null, 'outside registration transaction refused');
  f.processing.transaction(() => {
    assert.equal(f.units.recordVerifiedEptConversion(request, f.processing, f.jobId, f.owner, { leaseToken: 'stale' }), null);
    assert.equal(f.units.recordVerifiedEptConversion({ ...request, modelId: 'other' }, f.processing, f.jobId, f.owner, f.options), null);
    assert.equal(f.units.recordVerifiedEptConversion({ ...request, coordinateReference: { crs: 'EPSG:32617' } }, f.processing, f.jobId, f.owner, f.options), null);
  });
});

test('registration failure rolls back derived evidence/assets while preserving prepromotion receipt', t => {
  const f = fixture(t), receipt = f.store.create(f.jobId, f.owner, f, f.options);
  let request;
  assert.throws(() => f.processing.transaction(() => {
    request = registerOutput(f);
    assert.ok(f.units.recordVerifiedEptConversion(request, f.processing, f.jobId, f.owner, f.options));
    throw new Error('registration failure');
  }), /registration failure/);
  assert.equal(f.units.get(request), null);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM model_assets WHERE kind='ept'").get().n, 0);
  assert.deepEqual(f.store.get(f.jobId), receipt);
});

test('unreceipted EPT cannot acquire native evidence and conflicting staff metre decisions fail closed', t => {
  const missing = fixture(t);
  missing.processing.transaction(() => {
    const request = registerOutput(missing);
    assert.equal(missing.units.recordVerifiedEptConversion(request, missing.processing, missing.jobId, missing.owner, missing.options), null);
  });
  const f = fixture(t);f.store.create(f.jobId, f.owner, f, f.options);
  f.processing.transaction(() => {
    const request = registerOutput(f);
    const staff = f.units.recordStaffReview({ ...request, sourceVerticalUnit: 'm' }, 'operator');
    assert.throws(() => f.units.recordVerifiedEptConversion(request, f.processing, f.jobId, f.owner, f.options),
      { code: 'measurement_source_vertical_units_conflict' });
    assert.equal(f.units.get(request).id, staff.id, 'conflicting evidence is not silently overwritten');
  });
  const matching = fixture(t);matching.store.create(matching.jobId, matching.owner, matching, matching.options);
  matching.processing.transaction(() => {
    const request = registerOutput(matching);
    const existing = matching.units.recordExplicitMetadata(request, { ...request.source, crs: 'EPSG:32616', originalUnit: 'us-ft', verticalFactor: 1200 / 3937 });
    assert.equal(matching.units.recordVerifiedEptConversion(request, matching.processing, matching.jobId, matching.owner, matching.options).id, existing.id);
  });
});

function workerFixture(t, { mutateInput = false } = {}) {
  const sourceBytes = Buffer.alloc(100, 65), f = fixture(t, { claim: false, inputSha256: hash(sourceBytes) });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ept-worker-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, f.task.id, f.attempt.id, 'cloud.laz');
  fs.mkdirSync(path.dirname(source), { recursive: true });fs.writeFileSync(source, sourceBytes);
  const countPath = path.join(root, 'build-count'), preload = path.join(root, 'synthetic-converter.cjs');
  // An actual spawned executable is hashed/probed/invoked. A Node preload
  // supplies only the synthetic conversion behavior, on Windows and Linux.
  fs.writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('-i')&&process.argv.includes('-o')){
 const output=process.argv[process.argv.indexOf('-o')+1];
 fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'ept.json'),JSON.stringify({srs:{horizontal:32616},bounds:[0,0,0,1,1,1],dataType:'binary',schema:[]}));
 fs.writeFileSync(${JSON.stringify(countPath)},String(Number(fs.existsSync(${JSON.stringify(countPath)})?fs.readFileSync(${JSON.stringify(countPath)},'utf8'):0)+1));
 ${mutateInput ? "fs.appendFileSync(process.argv[process.argv.indexOf('-i')+1],'changed');" : ''}
 process.exit(0);
}
`);
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  t.after(() => { if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalNodeOptions; });
  const output = path.join(root, f.task.id, f.attempt.id, `ept-${f.jobId}`);
  const storage = { roots: { models: root }, resolve(rootKey, relative) {
    assert.equal(rootKey, 'models');const resolved = path.resolve(root, relative);
    assert.ok(resolved.startsWith(`${root}${path.sep}`));return resolved;
  }, requireDerivativeSpace() { return {}; } };
  const config = { localDerivativesEnabled: true, entwineBin: process.execPath, opsBaseUrl: 'http://localhost' };
  const { processOneDerivative } = require('../server/derivativeWorker');
  return { ...f, root, source, output, countPath, run: owner => processOneDerivative({ processing: f.processing, storage, config }, owner || f.owner),
    builds: () => fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0 };
}

function expireWorkerLease(f) {
  f.db.prepare("UPDATE derivative_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(f.jobId);
  f.db.prepare("UPDATE lod_conversion_lock SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE job_id=?").run(f.jobId);
}

function registeredEptEvidence(f) {
  const asset = f.db.prepare("SELECT * FROM model_assets WHERE version_id=? AND kind='ept'").get(f.versionId);
  return asset && f.units.get({ modelId: f.request.modelId, modelVersionId: f.versionId, coordinateReference: { crs: 'EPSG:32616' },
    source: { id: asset.id, kind: 'ept', sha256: asset.sha256, byteSize: asset.byte_size, manifestSha256: asset.manifest_sha256 } });
}

test('worker fresh conversion commits a receipt and original-unit evidence', async t => {
  const f = workerFixture(t);
  assert.equal(await f.run(), true);
  assert.equal(f.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(f.jobId).status, 'complete');
  assert.equal(f.builds(), 1);
  assert.ok(f.store.get(f.jobId));
  assert.equal(registeredEptEvidence(f).verticalFactor, 1200 / 3937);
  assert.equal(registeredEptEvidence(f).basis, 'server-verified-ept-conversion');
  assert.equal(fs.existsSync(path.join(f.output, 'ept.json')), true);
});

test('worker recovers receipted complete after promotion interruption without rerunning converter', async t => {
  const f = workerFixture(t), original = f.processing.registerVerifiedEptAsset;
  f.processing.registerVerifiedEptAsset = () => { throw Object.assign(new Error('simulated process interruption'), { code: 'lease_lost' }); };
  await f.run();
  const receipt = f.store.get(f.jobId);
  assert.ok(receipt);
  assert.equal(fs.existsSync(`${f.output}.${receipt.generationLeaseToken}.complete`), true);
  assert.equal(fs.existsSync(f.output), false);
  assert.equal(f.builds(), 1);
  f.processing.registerVerifiedEptAsset = original;
  expireWorkerLease(f);
  await f.run('resumed-worker');
  assert.equal(f.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(f.jobId).status, 'complete');
  assert.equal(f.builds(), 1);
  assert.deepEqual(f.store.get(f.jobId), receipt);
  assert.equal(registeredEptEvidence(f).verticalFactor, 1200 / 3937);
});

test('worker unreceipted existing EPT remains display-only despite native proof', async t => {
  const f = workerFixture(t);
  fs.mkdirSync(f.output);fs.writeFileSync(path.join(f.output, 'ept.json'), JSON.stringify({ srs: { horizontal: 32616 } }));
  await f.run();
  assert.equal(f.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(f.jobId).status, 'complete');
  assert.equal(f.builds(), 0);
  assert.equal(f.store.get(f.jobId), null);
  assert.equal(registeredEptEvidence(f), null);
});

test('worker resumes promoted output after the registration transaction rolled back', async t => {
  const f = workerFixture(t), original = f.processing.registerVerifiedEptAsset;
  f.processing.registerVerifiedEptAsset = function(id, owner, asset, options) {
    return original.call(this, id, owner, asset, { ...options, promote() {
      options.promote();
      throw Object.assign(new Error('simulated interruption after filesystem promotion'), { code: 'lease_lost' });
    } });
  };
  await f.run();
  const receipt = f.store.get(f.jobId);
  assert.ok(receipt);
  assert.equal(fs.existsSync(f.output), true);
  assert.equal(registeredEptEvidence(f), undefined);
  f.processing.registerVerifiedEptAsset = original;expireWorkerLease(f);
  await f.run('resumed-worker');
  assert.equal(f.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(f.jobId).status, 'complete');
  assert.equal(f.builds(), 1);
  assert.equal(registeredEptEvidence(f).verticalFactor, 1200 / 3937);
});

test('worker changed conversion input cannot persist a receipt or unit evidence', async t => {
  const f = workerFixture(t, { mutateInput: true });
  await f.run();
  assert.equal(f.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(f.jobId).status, 'failed');
  assert.equal(f.store.get(f.jobId), null);
  assert.equal(registeredEptEvidence(f), undefined);
  assert.equal(fs.existsSync(f.output), false);
});

test('worker refuses substituted output during receipt-bound recovery', async t => {
  const f = workerFixture(t), original = f.processing.registerVerifiedEptAsset;
  f.processing.registerVerifiedEptAsset = () => { throw Object.assign(new Error('simulated process interruption'), { code: 'lease_lost' }); };
  await f.run();
  const receipt = f.store.get(f.jobId);
  const complete = `${f.output}.${receipt.generationLeaseToken}.complete`;
  fs.appendFileSync(path.join(complete, 'ept.json'), ' ');
  f.processing.registerVerifiedEptAsset = original;expireWorkerLease(f);
  await f.run('resumed-worker');
  assert.equal(f.db.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(f.jobId).status, 'failed');
  assert.equal(f.builds(), 1);
  assert.equal(registeredEptEvidence(f), undefined);
  assert.equal(fs.existsSync(f.output), false);
});
