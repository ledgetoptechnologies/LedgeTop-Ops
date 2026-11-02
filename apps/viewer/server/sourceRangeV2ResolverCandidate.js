'use strict';

// Isolated source authority for the default-off source-range-v2 candidate.
// It resolves object IDs only through the immutable Viewer attempt journal and
// finalized managed dataset metadata. It does not create or mount an HTTP route.
const crypto = require('node:crypto');
const path = require('node:path');
const protocol = require('./referenceProtocol');
const { decodeOptionsWire } = require('./referenceOptions');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

function resolveSourceRangeV2Candidate({ database, storage, job } = {}) {
  if (!database?.prepare || !storage?.resolve || !job || typeof job !== 'object' || Array.isArray(job)) fail('SOURCE_AUTHORITY_UNAVAILABLE');
  if (typeof job.jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.jobId)) fail('SOURCE_BINDING_MISMATCH');

  let row;
  try { row = database.prepare(`
    SELECT j.attempt_id,j.submission_id,j.environment,j.request_json,j.request_sha256,j.input_manifest_sha256,
           j.job_id,j.job_json,j.job_sha256,a.dataset_id,a.status AS attempt_status,
           t.active_attempt_id,t.status AS task_status,t.purged_at AS task_purged_at,
           p.status AS project_status,p.purged_at AS project_purged_at,
           d.status AS dataset_status,d.storage_mode,d.root_key,d.relative_path,d.manifest_sha256 AS dataset_manifest_sha256
      FROM viewer_reference_attempt_journal j
      JOIN viewer_reference_attempt_protocols rp ON rp.attempt_id=j.attempt_id AND rp.protocol='reference-v1'
      JOIN viewer_reference_attempt_genesis g ON g.attempt_id=j.attempt_id AND g.reference_provider_id=rp.reference_provider_id
      JOIN viewer_reference_providers vp ON vp.id=g.reference_provider_id
      JOIN processing_attempts a ON a.id=j.attempt_id AND a.provider_id IS NULL AND a.provider_task_id IS NULL
      JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
      JOIN projects p ON p.id=t.project_id
      JOIN datasets d ON d.id=a.dataset_id AND d.project_id=t.project_id
     WHERE j.job_id=?
       AND a.status IN ('pending','admitted','initializing','uploading','committed','queued_upstream','running','ingesting')
       AND t.status NOT IN ('archived','cancelled') AND t.purged_at IS NULL
       AND p.status='active' AND p.purged_at IS NULL
     LIMIT 2`).all(job.jobId); } catch { fail('SOURCE_AUTHORITY_UNAVAILABLE'); }
  if (!Array.isArray(row) || row.length !== 1) fail('SOURCE_BINDING_MISMATCH');
  const bound = row[0];
  if (typeof bound.request_json !== 'string' || typeof bound.request_sha256 !== 'string'
      || hash(Buffer.from(bound.request_json, 'utf8')) !== bound.request_sha256
      || typeof bound.job_json !== 'string' || typeof bound.job_sha256 !== 'string'
      || hash(Buffer.from(bound.job_json, 'utf8')) !== bound.job_sha256) fail('SOURCE_JOURNAL_CORRUPT');

  let request, storedJob;
  try {
    request = decodeOptionsWire(Buffer.from(bound.request_json, 'utf8'));
    storedJob = decodeOptionsWire(Buffer.from(bound.job_json, 'utf8'));
    protocol.validateManifest(request.manifest);
    protocol.validateManifest(job.submission?.manifest);
  } catch { fail('SOURCE_JOURNAL_CORRUPT'); }
  if (request.submissionId !== bound.submission_id || request.manifest.sha256 !== bound.input_manifest_sha256
      || bound.job_id !== job.jobId || bound.environment !== job.environment
      || bound.input_manifest_sha256 !== job.manifestSha256
      || storedJob.jobId !== job.jobId || storedJob.generation !== job.generation
      || storedJob.environment !== job.environment || storedJob.manifestSha256 !== job.manifestSha256
      || storedJob.pipelineDigest !== job.pipelineDigest
      || job.submission.manifest.sha256 !== request.manifest.sha256) fail('SOURCE_BINDING_MISMATCH');

  const transfer = job.transferRequest;
  if (!transfer || transfer.protocol !== 'source-range-v2' || transfer.generation !== job.generation
      || transfer.manifestSha256 !== request.manifest.sha256 || typeof transfer.sourceVersion !== 'string'
      || !HASH.test(bound.dataset_manifest_sha256 || '') || bound.dataset_status !== 'finalized'
      || bound.storage_mode !== 'managed' || bound.root_key !== 'datasets'
      || typeof bound.relative_path !== 'string' || !bound.relative_path) fail('SOURCE_BINDING_MISMATCH');
  const manifestIds = request.manifest.objects.map(item => item.id);
  if (!Array.isArray(transfer.objectIds) || transfer.objectIds.length !== manifestIds.length
      || new Set(transfer.objectIds).size !== manifestIds.length) fail('SOURCE_BINDING_MISMATCH');
  const transferIds = new Set(transfer.objectIds);
  if (manifestIds.some(id => !transferIds.has(id))) fail('SOURCE_BINDING_MISMATCH');

  // Dataset manifest identity is the immutable source revision. The transfer
  // issuer and this resolver must use this same value when constructing a job.
  const sourceVersion = `dataset:${bound.dataset_id}:${bound.dataset_manifest_sha256}`;
  if (transfer.sourceVersion !== sourceVersion) fail('SOURCE_BINDING_MISMATCH');

  const rows = database.prepare(`
    SELECT id,relative_path,byte_size,sha256 FROM dataset_files
     WHERE dataset_id=? ORDER BY id LIMIT 10001`).all(bound.dataset_id);
  if (!Array.isArray(rows) || rows.length > protocol.LIMITS.objects) fail('SOURCE_BINDING_MISMATCH');
  const files = new Map(rows.map(file => [file.id, file]));
  const objects = [];
  for (const item of request.manifest.objects) {
    if (item.kind === 'auxiliary') {
      const artifact = database.prepare(`
        SELECT a.object_id,a.relative_path,a.sha256,a.byte_size,s.content_text,s.sha256 AS snapshot_sha256
          FROM viewer_reference_gcp_artifacts a
          JOIN processing_attempt_gcp_snapshots s ON s.attempt_id=a.attempt_id
         WHERE a.attempt_id=?`).get(bound.attempt_id);
      if (!artifact || artifact.object_id !== item.id || artifact.sha256 !== item.sha256
          || artifact.byte_size !== item.byteSize || artifact.snapshot_sha256 !== item.sha256
          || typeof artifact.content_text !== 'string'
          || Buffer.byteLength(artifact.content_text, 'utf8') !== item.byteSize
          || hash(Buffer.from(artifact.content_text, 'utf8')) !== item.sha256
          || artifact.relative_path !== `reference-gcp/${bound.submission_id}/gcp_list.txt`) fail('SOURCE_BINDING_MISMATCH');
      const rel = path.posix.join(bound.relative_path, artifact.relative_path);
      objects.push({ id: item.id, path: storage.resolve('datasets', rel, { mustExist: true }), byteSize: item.byteSize, sha256: item.sha256 });
      continue;
    }
    const file = files.get(item.id);
    if (!file || !['image', 'lidar'].includes(item.kind) || file.byte_size !== item.byteSize || file.sha256 !== item.sha256
        || path.posix.basename(file.relative_path) !== item.name) fail('SOURCE_BINDING_MISMATCH');
    const rel = path.posix.join(bound.relative_path, file.relative_path);
    objects.push({ id: item.id, path: storage.resolve('datasets', rel, { mustExist: true }), byteSize: item.byteSize, sha256: item.sha256 });
  }
  if (objects.length !== request.manifest.objects.length
      || JSON.stringify(objects.map(item => item.id)) !== JSON.stringify(request.manifest.objects.map(item => item.id))) fail('SOURCE_BINDING_MISMATCH');
  return {
    jobId: job.jobId, generation: job.generation, environment: job.environment,
    manifestSha256: request.manifest.sha256, sourceVersion, objects,
  };
}

module.exports = { resolveSourceRangeV2Candidate };
