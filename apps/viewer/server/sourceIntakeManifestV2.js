'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const ReferenceProtocol = require('./referenceProtocol');
const { canonicalizeJcs } = require('./preparedSubmissionOutbox');
const { fileFacts } = require('./viewerPagedSourceExport');
const {
  MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS,
  MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
} = require('./sourceIntakeLimitsV2');

const MAX_MANIFEST_BYTES = MAX_SOURCE_INTAKE_V2_METADATA_BYTES;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function canonicalDigest(value) {
  return sha256(canonicalizeJcs(value, {
    maxBytes: MAX_MANIFEST_BYTES,
    maxNodes: MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  }));
}

function withDigest(body) {
  return { ...body, sha256: canonicalDigest(body) };
}

function byAsciiId(a, b) {
  return Buffer.compare(Buffer.from(a.id, 'ascii'), Buffer.from(b.id, 'ascii'));
}

function buildSourceIntakeManifests(processing, { dataset, attempt, snapshot, pipelineManifest } = {}) {
  const database = processing?.database;
  if (!database || !database.isTransaction || !dataset || !attempt || !snapshot
      || dataset.status !== 'finalized' || dataset.storageMode !== 'managed' || dataset.rootKey !== 'datasets'
      || typeof dataset.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(dataset.manifestSha256)
      || !Array.isArray(dataset.files) || !dataset.files.length
      || dataset.files.length > MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS
      || typeof attempt.id !== 'string' || typeof attempt.taskId !== 'string'
      || snapshot.attemptId !== attempt.id || snapshot.datasetId !== dataset.id
      || typeof snapshot.intentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.intentSha256)) {
    fail('source_intake_manifest_binding_invalid');
  }

  let validatedPipeline;
  try { validatedPipeline = ReferenceProtocol.validateManifest(pipelineManifest, { maxBytes: MAX_MANIFEST_BYTES }); }
  catch { fail('source_intake_pipeline_manifest_invalid'); }

  const heldRows = database.prepare(`SELECT dataset_file_id,dataset_id,sha256,byte_size,retention_reason
    FROM retained_dataset_files WHERE dataset_id=?`).all(dataset.id);
  const holds = new Map();
  for (const row of heldRows) {
    if (holds.has(row.dataset_file_id)) fail('source_intake_hold_inventory_invalid');
    holds.set(row.dataset_file_id, row);
  }

  const seen = new Set();
  let totalBytes = 0;
  const sourceObjects = dataset.files.map((file) => {
    let facts;
    try { facts = fileFacts(file); } catch { fail('source_intake_source_file_invalid'); }
    if (seen.has(file.id)) fail('source_intake_source_duplicate');
    seen.add(file.id);
    totalBytes += file.byteSize;
    if (!Number.isSafeInteger(totalBytes)) fail('source_intake_source_size_invalid');

    const hold = holds.get(file.id) || null;
    if (hold && (hold.dataset_id !== dataset.id || hold.sha256 !== file.sha256
        || hold.byte_size !== file.byteSize || typeof hold.retention_reason !== 'string'
        || !hold.retention_reason.trim())) fail('source_intake_hold_mismatch');
    const gcpHeld = hold?.retention_reason === 'gcp_source';
    if (gcpHeld && path.posix.extname(file.relativePath).toLowerCase() !== '.csv')
      fail('source_intake_gcp_hold_not_csv');
    if (file.processingRole === 'gcp_source' && !gcpHeld)
      fail('source_intake_gcp_hold_mismatch');

    return {
      id: file.id,
      name: path.posix.basename(file.relativePath),
      byteSize: file.byteSize,
      sha256: file.sha256,
      sourceType: gcpHeld ? 'gcp_source_csv' : 'raw_input',
      retentionClass: hold ? 'permanent_viewer_hold' : 'release_after_acceptance',
      retentionHoldId: hold ? file.id : null,
      _kind: facts.kind,
      _mediaType: facts.mediaType,
    };
  }).sort(byAsciiId);

  if (holds.size !== [...holds.keys()].filter((id) => seen.has(id)).length)
    fail('source_intake_hold_inventory_mismatch');

  const sourceManifest = withDigest({
    schemaVersion: 1,
    id: dataset.id,
    datasetManifestSha256: dataset.manifestSha256,
    totalBytes,
    objectCount: sourceObjects.length,
    objects: sourceObjects.map(({ _kind, _mediaType, ...object }) => object),
  });

  const gcpRow = database.prepare(`SELECT evidence_json,content_text,sha256
    FROM processing_attempt_gcp_snapshots WHERE attempt_id=?`).get(attempt.id);
  const gcpIntent = snapshot.intent?.gcp || null;
  const generatedGcp = gcpIntent?.generatedGcp || null;
  if (Boolean(gcpRow) !== Boolean(generatedGcp) || (gcpIntent && !gcpRow))
    fail('source_intake_gcp_snapshot_mismatch');

  const derivedObjects = [];
  const derivedBytes = new Map();
  if (gcpRow) {
    if (typeof gcpRow.content_text !== 'string' || typeof gcpRow.evidence_json !== 'string')
      fail('source_intake_gcp_snapshot_incomplete');
    const contentBytes = Buffer.from(gcpRow.content_text, 'utf8');
    const evidenceBytes = Buffer.from(gcpRow.evidence_json, 'utf8');
    const contentSha256 = sha256(contentBytes);
    const evidenceSha256 = sha256(evidenceBytes);
    if (!contentBytes.length || generatedGcp.attemptId !== attempt.id
        || generatedGcp.byteSize !== contentBytes.length || generatedGcp.sha256 !== contentSha256
        || gcpRow.sha256 !== contentSha256 || gcpIntent.fileSha256 !== contentSha256
        || gcpIntent.fileByteCount !== contentBytes.length || gcpIntent.evidenceSha256 !== evidenceSha256
        || gcpIntent.evidenceByteCount !== evidenceBytes.length) fail('source_intake_gcp_snapshot_mismatch');
    const id = `gcp_${attempt.id}`;
    derivedObjects.push({
      id,
      name: 'gcp_list.txt',
      byteSize: contentBytes.length,
      sha256: contentSha256,
      snapshotAttemptId: attempt.id,
      snapshotContentSha256: contentSha256,
      snapshotEvidenceSha256: evidenceSha256,
      sourceType: 'attempt_derived_gcp_list',
      retentionClass: 'release_after_acceptance',
      retentionHoldId: null,
    });
    derivedBytes.set(id, contentBytes);
  }
  derivedObjects.sort(byAsciiId);
  if (derivedObjects.length > MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS)
    fail('source_intake_derived_object_limit');
  if (sourceObjects.some((object) => object.id === `gcp_${attempt.id}`))
    fail('source_intake_derived_id_collision');
  const derivedManifest = withDigest({ schemaVersion: 1, attemptId: attempt.id, objects: derivedObjects });

  const objectById = new Map([
    ...sourceObjects.map((object) => [object.id, object]),
    ...derivedObjects.map((object) => [object.id, object]),
  ]);
  for (const object of validatedPipeline.objects) {
    const source = objectById.get(object.id);
    if (!source || source.name !== object.name || source.byteSize !== object.byteSize || source.sha256 !== object.sha256)
      fail('source_intake_pipeline_subset_invalid');
  }

  return {
    sourceManifest,
    sourceManifestSha256: sourceManifest.sha256,
    derivedManifest,
    derivedManifestSha256: derivedManifest.sha256,
    pipelineManifest: validatedPipeline,
    pipelineManifestSha256: validatedPipeline.sha256,
    sourceSnapshotSha256: snapshot.intentSha256,
    derivedBytes,
  };
}

module.exports = { MAX_MANIFEST_BYTES, buildSourceIntakeManifests, canonicalDigest };
