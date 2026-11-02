'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const protocol = require('../server/referenceProtocol');
const { resolveSourceRangeV2Candidate } = require('../server/sourceRangeV2ResolverCandidate');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const manifestHash = 'a'.repeat(64);

function fixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE viewer_reference_attempt_journal(attempt_id TEXT,submission_id TEXT,environment TEXT,request_json TEXT,request_sha256 TEXT,input_manifest_sha256 TEXT,job_id TEXT,job_json TEXT,job_sha256 TEXT);
    CREATE TABLE viewer_reference_attempt_protocols(attempt_id TEXT,reference_provider_id TEXT,protocol TEXT);
    CREATE TABLE viewer_reference_attempt_genesis(attempt_id TEXT,reference_provider_id TEXT);
    CREATE TABLE viewer_reference_providers(id TEXT);
    CREATE TABLE processing_attempts(id TEXT,task_id TEXT,dataset_id TEXT,provider_id TEXT,provider_task_id TEXT,status TEXT);
    CREATE TABLE processing_tasks(id TEXT,project_id TEXT,dataset_id TEXT,status TEXT,active_attempt_id TEXT,purged_at TEXT);
    CREATE TABLE projects(id TEXT,status TEXT,purged_at TEXT);
    CREATE TABLE datasets(id TEXT,project_id TEXT,status TEXT,storage_mode TEXT,root_key TEXT,relative_path TEXT,manifest_sha256 TEXT);
    CREATE TABLE dataset_files(id TEXT,dataset_id TEXT,relative_path TEXT,byte_size INTEGER,sha256 TEXT);
    CREATE TABLE viewer_reference_gcp_artifacts(attempt_id TEXT,object_id TEXT,relative_path TEXT,sha256 TEXT,byte_size INTEGER);
    CREATE TABLE processing_attempt_gcp_snapshots(attempt_id TEXT,content_text TEXT,sha256 TEXT);
  `);
  const bytes = Buffer.from('photo-bytes');
  const manifest = { id: 'manifest-1', revision: 1, sha256: '0'.repeat(64), totalBytes: bytes.length, objectCount: 1,
    inputCounts: { images: 1, lidarObjects: 0, points: 0 },
    objects: [{ id: 'file-1', name: 'photo.jpg', byteSize: bytes.length, sha256: hash(bytes), kind: 'image', mediaType: 'image/jpeg' }] };
  manifest.sha256 = protocol.manifestSha256(manifest);
  const submissionId = '9e8139b5-9d91-4f86-8a5a-9572a817aa5b';
  const request = { submissionId, manifest };
  const jobFields = { jobId: 'job-1', generation: 2, environment: 'production', manifestSha256: manifest.sha256, pipelineDigest: 'b'.repeat(64) };
  const datasetId = 'dataset-1', datasetManifestSha256 = 'c'.repeat(64), attemptId = 'attempt-1';
  const job = { ...jobFields, submission: { manifest }, transferRequest: { protocol: 'source-range-v2', generation: 2,
    manifestSha256: manifest.sha256, sourceVersion: `dataset:${datasetId}:${datasetManifestSha256}`, objectIds: ['file-1'] } };
  const requestJson = JSON.stringify(request), jobJson = JSON.stringify(jobFields);
  database.prepare('INSERT INTO viewer_reference_attempt_journal VALUES(?,?,?,?,?,?,?,?,?)').run(attemptId, submissionId, 'production', requestJson,
    hash(Buffer.from(requestJson)), manifest.sha256, jobFields.jobId, jobJson, hash(Buffer.from(jobJson)));
  database.prepare('INSERT INTO viewer_reference_attempt_protocols VALUES(?,?,?)').run(attemptId, 'provider-1', 'reference-v1');
  database.prepare('INSERT INTO viewer_reference_attempt_genesis VALUES(?,?)').run(attemptId, 'provider-1');
  database.prepare('INSERT INTO viewer_reference_providers VALUES(?)').run('provider-1');
  database.prepare('INSERT INTO processing_attempts VALUES(?,?,?,?,?,?)').run(attemptId, 'task-1', datasetId, null, null, 'running');
  database.prepare('INSERT INTO processing_tasks VALUES(?,?,?,?,?,?)').run('task-1', 'project-1', datasetId, 'processing', attemptId, null);
  database.prepare('INSERT INTO projects VALUES(?,?,?)').run('project-1', 'active', null);
  database.prepare('INSERT INTO datasets VALUES(?,?,?,?,?,?,?)').run(datasetId, 'project-1', 'finalized', 'managed', 'datasets', 'dataset-1', datasetManifestSha256);
  database.prepare('INSERT INTO dataset_files VALUES(?,?,?,?,?)').run('file-1', datasetId, 'photos/photo.jpg', bytes.length, hash(bytes));
  const storage = { resolve(rootKey, relative, options) { assert.equal(rootKey, 'datasets'); assert.deepEqual(options, { mustExist: true }); return `/managed/${relative}`; } };
  return { database, storage, job, manifest, attemptId, datasetId, datasetManifestSha256, bytes };
}

test('resolves only journal-bound objects from the active finalized managed dataset', t => {
  const f = fixture(); t.after(() => f.database.close());
  const result = resolveSourceRangeV2Candidate({ database: f.database, storage: f.storage, job: f.job });
  assert.equal(result.jobId, f.job.jobId);
  assert.equal(result.generation, f.job.generation);
  assert.equal(result.environment, 'production');
  assert.equal(result.manifestSha256, f.manifest.sha256);
  assert.equal(result.sourceVersion, `dataset:${f.datasetId}:${f.datasetManifestSha256}`);
  assert.deepEqual(result.objects, [{ id: 'file-1', path: '/managed/dataset-1/photos/photo.jpg', byteSize: f.bytes.length, sha256: hash(f.bytes) }]);
});

test('fails closed for a stale worker generation or changed source revision', t => {
  const f = fixture(); t.after(() => f.database.close());
  assert.throws(() => resolveSourceRangeV2Candidate({ database: f.database, storage: f.storage,
    job: { ...f.job, generation: 3 } }), { code: 'SOURCE_BINDING_MISMATCH' });
  f.job.transferRequest.sourceVersion = 'dataset:dataset-1:stale';
  assert.throws(() => resolveSourceRangeV2Candidate({ database: f.database, storage: f.storage, job: f.job }), { code: 'SOURCE_BINDING_MISMATCH' });
});

test('fails closed when the task is no longer current or dataset metadata drifted', t => {
  const f = fixture(); t.after(() => f.database.close());
  f.database.prepare("UPDATE processing_tasks SET active_attempt_id='attempt-other'").run();
  assert.throws(() => resolveSourceRangeV2Candidate({ database: f.database, storage: f.storage, job: f.job }), { code: 'SOURCE_BINDING_MISMATCH' });
});

test('fails closed when any manifest object is not the exact dataset file identity', t => {
  const f = fixture(); t.after(() => f.database.close());
  f.database.prepare("UPDATE dataset_files SET sha256=? WHERE id='file-1'").run('d'.repeat(64));
  assert.throws(() => resolveSourceRangeV2Candidate({ database: f.database, storage: f.storage, job: f.job }), { code: 'SOURCE_BINDING_MISMATCH' });
});
