'use strict';

// Inactive experiment for pairing a coherent Viewer source snapshot with the
// bounded Processing frame format. This module is deliberately not mounted by
// an API route and never claims that the caller is authorized to read the data.
const crypto = require('node:crypto');
const path = require('node:path');
const { canonicalBytes } = require('./referenceProtocol');
const { inputInventory } = require('./processingProvenance');

const SOURCE_VERSION = 'ltds-viewer-source-frames-v1';
const SELECTED_VERSION = 'ltds-viewer-selected-frames-v1';
const SOURCE_DOMAIN = Buffer.from('ltds-viewer-source-frame-v1\0', 'ascii');
const SELECTED_DOMAIN = Buffer.from('ltds-viewer-selected-frame-v1\0', 'ascii');
const BINDING_DOMAIN = Buffer.from('ltds-viewer-selected-binding-v1\0', 'ascii');
const GCP_EVIDENCE_VERSION = 'ltds-viewer-gcp-evidence-chunks-v1';
const GCP_EVIDENCE_DOMAIN = Buffer.from('ltds-viewer-gcp-evidence-frame-v1\0', 'ascii');
const GCP_FILE_VERSION = 'ltds-viewer-generated-gcp-file-chunks-v1';
const GCP_FILE_DOMAIN = Buffer.from('ltds-viewer-generated-gcp-file-frame-v1\0', 'ascii');
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_FRAMES = 64;
const MAX_ITEMS_PER_FRAME = 512;
const MAX_ITEMS = 20_000;
const MAX_PREFLIGHT_BYTES = 32 * 1024 * 1024;
const MAX_GCP_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_GCP_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_GCP_EVIDENCE_PAGE_BYTES = 65_535;
const MAX_GCP_EVIDENCE_CHUNK_BYTES = 46_080;
const MAX_GCP_EVIDENCE_PAGES = 512;
const MAX_GCP_EVIDENCE_STREAM_BYTES = 24 * 1024 * 1024;
const MAX_GCP_FILE_STREAM_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_EXPORT_STREAM_BYTES = 72 * 1024 * 1024;
const PHOTO = /\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i;
const CONTROL_OR_UNICODE_CATEGORY_C = /\p{C}/u;

class HeldSourceExport extends Error {
  constructor(code = 'source_export_held') {
    super(code);
    this.name = 'HeldSourceExport';
    this.code = code;
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fileFacts(file) {
  if (!file || typeof file.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(file.id)
    || typeof file.relativePath !== 'string' || !file.relativePath || file.relativePath.length > 4096
    || Buffer.byteLength(file.relativePath, 'utf8') > 4096 || CONTROL_OR_UNICODE_CATEGORY_C.test(file.relativePath)
    || file.relativePath.startsWith('/') || /^[A-Za-z]:/.test(file.relativePath) || file.relativePath.includes('\\')
    || file.relativePath.split('/').some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part, 'utf8') > 255)
    || !Number.isSafeInteger(file.byteSize) || file.byteSize <= 0
    || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
    || !['auto', 'image', 'gcp_source', 'provider_input', 'administrative'].includes(file.processingRole)) {
    throw new HeldSourceExport('unsupported_source_file');
  }

  const extension = path.posix.extname(file.relativePath).toLowerCase();
  const mimeType = String(file.mimeType || file.contentType || '').trim().toLowerCase();
  let kind = 'auxiliary';
  let mediaType = mimeType;
  if (PHOTO.test(file.relativePath)) {
    kind = 'image';
    if (!mediaType) mediaType = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.tif': 'image/tiff', '.tiff': 'image/tiff' })[extension] || '';
    if (!['image/jpeg', 'image/png', 'image/tiff'].includes(mediaType)) throw new HeldSourceExport('unsupported_image_media_type');
  } else if (extension === '.las' || extension === '.laz') {
    kind = 'lidar';
    if (!mediaType) mediaType = extension === '.las' ? 'application/vnd.las' : 'application/vnd.laz';
    if (!['application/vnd.las', 'application/vnd.laz'].includes(mediaType)) throw new HeldSourceExport('unsupported_lidar_media_type');
  } else if (!['application/octet-stream', 'application/json', 'text/plain', 'text/csv'].includes(mediaType)) {
    throw new HeldSourceExport('unsupported_auxiliary_media_type');
  }
  if (mediaType.length > 127 || CONTROL_OR_UNICODE_CATEGORY_C.test(mediaType)) throw new HeldSourceExport('unsupported_media_type');
  return {
    type: 'dataset_file', datasetFileId: file.id, relativePath: file.relativePath,
    byteSize: file.byteSize, sha256: file.sha256, processingRole: file.processingRole,
    mediaType, kind,
  };
}

function frameStream(records, version, domain) {
  if (!Array.isArray(records) || records.length > MAX_ITEMS) throw new HeldSourceExport('source_item_limit');
  const frames = [];
  let totalBytes = 0;
  let current = [];
  let currentRecordBytes = 0;

  const flush = () => {
    if (!current.length) return;
    const index = frames.length;
    const value = { version, index, records: current };
    const raw = canonicalBytes(value);
    if (raw.length > MAX_FRAME_BYTES || index >= MAX_FRAMES) throw new HeldSourceExport('source_frame_limit');
    const line = Buffer.concat([raw, Buffer.from('\n')]);
    totalBytes += line.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new HeldSourceExport('source_stream_limit');
    frames.push({ bytes: line, sha256: sha256(Buffer.concat([domain, raw])) });
    current = [];
    currentRecordBytes = 0;
  };

  for (const record of records) {
    const encoded = canonicalBytes(record);
    if (encoded.length + 2 > MAX_FRAME_BYTES) throw new HeldSourceExport('source_record_limit');
    const nextCount = current.length + 1;
    const nextRecordBytes = currentRecordBytes + encoded.length + (current.length ? 1 : 0);
    // The empty canonical frame contributes fixed fields and the unchanged []
    // delimiters; record bytes and commas are added between those brackets.
    const empty = canonicalBytes({ version, index: frames.length, records: [] }).length;
    const nextFrameBytes = empty + nextRecordBytes;
    if (current.length && (nextCount > MAX_ITEMS_PER_FRAME || nextFrameBytes > MAX_FRAME_BYTES)) flush();
    if (current.length >= MAX_ITEMS_PER_FRAME) flush();
    const freshEmpty = canonicalBytes({ version, index: frames.length, records: [] }).length;
    const addedBytes = encoded.length + (current.length ? 1 : 0);
    if (freshEmpty + currentRecordBytes + addedBytes > MAX_FRAME_BYTES) throw new HeldSourceExport('source_record_limit');
    current.push(record);
    currentRecordBytes += addedBytes;
  }
  flush();
  if (!frames.length) throw new HeldSourceExport('empty_source_stream');
  return { frames, bytes: Buffer.concat(frames.map((frame) => frame.bytes)), pageHashes: frames.map((frame) => frame.sha256), totalBytes };
}

function gcpEvidenceStream(evidenceBytes, attemptId) {
  if (!Buffer.isBuffer(evidenceBytes) || evidenceBytes.length < 1 || evidenceBytes.length > MAX_GCP_EVIDENCE_BYTES
    || typeof attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(attemptId)) {
    throw new HeldSourceExport('gcp_evidence_stream_invalid');
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(evidenceBytes); }
  catch { throw new HeldSourceExport('gcp_evidence_utf8_invalid'); }

  const evidenceSha256 = sha256(evidenceBytes);
  const frames = [];
  let offset = 0;
  let streamBytes = 0;
  const append = (value) => {
    const raw = canonicalBytes(value);
    if (raw.length > MAX_GCP_EVIDENCE_PAGE_BYTES) throw new HeldSourceExport('gcp_evidence_page_limit');
    const line = Buffer.concat([raw, Buffer.from('\n')]);
    streamBytes += line.length;
    if (streamBytes > MAX_GCP_EVIDENCE_STREAM_BYTES || frames.length >= MAX_GCP_EVIDENCE_PAGES) {
      throw new HeldSourceExport('gcp_evidence_stream_limit');
    }
    frames.push({ bytes: line, pageBytes: raw.length, sha256: sha256(Buffer.concat([GCP_EVIDENCE_DOMAIN, raw])) });
  };

  for (let start = 0, index = 0; start < evidenceBytes.length; start += MAX_GCP_EVIDENCE_CHUNK_BYTES, index++) {
    const chunk = evidenceBytes.subarray(start, Math.min(start + MAX_GCP_EVIDENCE_CHUNK_BYTES, evidenceBytes.length));
    append({
      version: GCP_EVIDENCE_VERSION,
      attemptId,
      evidenceSha256,
      index,
      offset,
      decodedByteCount: chunk.length,
      data: chunk.toString('base64url'),
    });
    offset += chunk.length;
  }
  if (offset !== evidenceBytes.length || !frames.length) throw new HeldSourceExport('gcp_evidence_stream_invalid');

  append({
    version: GCP_EVIDENCE_VERSION,
    attemptId,
    evidenceSha256,
    index: frames.length,
    offset,
    totalBytes: evidenceBytes.length,
    complete: true,
  });
  if (frames.length < 2 || frames.length > MAX_GCP_EVIDENCE_PAGES) throw new HeldSourceExport('gcp_evidence_stream_limit');
  return {
    frames,
    bytes: Buffer.concat(frames.map((frame) => frame.bytes)),
    pageHashes: frames.map((frame) => frame.sha256),
    pageBytes: frames.map((frame) => frame.pageBytes),
    pageCount: frames.length,
    byteCount: evidenceBytes.length,
    sha256: evidenceSha256,
    streamBytes,
  };
}

function generatedGcpFileStream(fileBytes, attemptId, evidenceSha256) {
  if (!Buffer.isBuffer(fileBytes) || fileBytes.length < 1 || fileBytes.length > MAX_GCP_CONTENT_BYTES
    || typeof attemptId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(attemptId)
    || typeof evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceSha256)) {
    throw new HeldSourceExport('gcp_file_stream_invalid');
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(fileBytes); }
  catch { throw new HeldSourceExport('gcp_file_utf8_invalid'); }

  const fileSha256 = sha256(fileBytes);
  const frames = [];
  let offset = 0;
  let streamBytes = 0;
  const append = (value) => {
    const raw = canonicalBytes(value);
    if (raw.length > MAX_GCP_EVIDENCE_PAGE_BYTES) throw new HeldSourceExport('gcp_file_page_limit');
    const line = Buffer.concat([raw, Buffer.from('\n')]);
    streamBytes += line.length;
    if (streamBytes > MAX_GCP_FILE_STREAM_BYTES || frames.length >= MAX_GCP_EVIDENCE_PAGES) {
      throw new HeldSourceExport('gcp_file_stream_limit');
    }
    frames.push({ bytes: line, pageBytes: raw.length, sha256: sha256(Buffer.concat([GCP_FILE_DOMAIN, raw])) });
  };

  for (let start = 0, index = 0; start < fileBytes.length; start += MAX_GCP_EVIDENCE_CHUNK_BYTES, index++) {
    const chunk = fileBytes.subarray(start, Math.min(start + MAX_GCP_EVIDENCE_CHUNK_BYTES, fileBytes.length));
    append({
      version: GCP_FILE_VERSION,
      attemptId,
      evidenceSha256,
      fileSha256,
      index,
      offset,
      decodedByteCount: chunk.length,
      data: chunk.toString('base64url'),
    });
    offset += chunk.length;
  }
  if (offset !== fileBytes.length || !frames.length) throw new HeldSourceExport('gcp_file_stream_invalid');

  append({
    version: GCP_FILE_VERSION,
    attemptId,
    evidenceSha256,
    fileSha256,
    index: frames.length,
    offset,
    totalBytes: fileBytes.length,
    complete: true,
  });
  if (frames.length < 2 || frames.length > MAX_GCP_EVIDENCE_PAGES) throw new HeldSourceExport('gcp_file_stream_limit');
  return {
    frames,
    bytes: Buffer.concat(frames.map((frame) => frame.bytes)),
    pageHashes: frames.map((frame) => frame.sha256),
    pageBytes: frames.map((frame) => frame.pageBytes),
    pageCount: frames.length,
    byteCount: fileBytes.length,
    sha256: fileSha256,
    evidenceSha256,
    streamBytes,
  };
}

function assertGcpEvidence(evidence, filesById) {
  if (!evidence || evidence.schemaVersion !== 1 || !Array.isArray(evidence.correspondences)) throw new HeldSourceExport('gcp_evidence_unavailable');
  const refs = new Map();
  for (const mark of evidence.correspondences) {
    const source = filesById.get(mark.sourceGcpDatasetFileId);
    const image = filesById.get(mark.imageDatasetFileId);
    if (!source || source.processingRole !== 'gcp_source' || source.relativePath !== mark.sourceGcpRelativePath
      || source.sha256 !== mark.sourceGcpSha256 || !image || image.relativePath !== mark.imageRelativePath) {
      throw new HeldSourceExport('gcp_correspondence_source_mismatch');
    }
    refs.set(source.id, { datasetFileId: source.id, relativePath: source.relativePath, sha256: source.sha256 });
  }
  if (JSON.stringify([...refs.keys()].sort()) !== JSON.stringify(evidence.snapshot.sourceGcpDatasetFileIds)
    || evidence.snapshot.imageDatasetFileIds.some((id) => !filesById.has(id))) {
    throw new HeldSourceExport('gcp_evidence_file_set_mismatch');
  }
  const sourceFiles = [...refs.values()].sort((a, b) => a.datasetFileId < b.datasetFileId ? -1 : a.datasetFileId > b.datasetFileId ? 1 : 0);
  return {
    type: 'attempt_generated_gcp', attemptId: evidence.snapshot.snapshotId,
    byteSize: evidence.snapshot.byteSize, sha256: evidence.snapshot.sha256,
    // Use the stored JS snapshot's JSON representation; reference-v1 canonicalBytes
    // intentionally accepts integer-only protocol objects, while GCP coordinates
    // contain finite decimal numbers.
    sourceFiles, correspondenceSha256: sha256(Buffer.from(JSON.stringify(evidence.correspondences), 'utf8')),
  };
}

function captureHeldSourceExport(processing, { datasetId, taskId, attemptId } = {}) {
  const db = processing?.database;
  if (!db || typeof db.exec !== 'function' || db.isTransaction) throw new HeldSourceExport('read_transaction_unavailable');
  db.exec('BEGIN');
  try {
    // Preflight before repository helpers materialize and parse the full row
    // arrays. Both this preflight and the subsequent reads share one SQLite
    // snapshot; an oversized legacy record is held before large allocation.
    const indexed = db.prepare(`SELECT COUNT(*) AS file_count,
      COALESCE(SUM(length(CAST(relative_path AS BLOB)) + length(CAST(metadata_json AS BLOB))
        + length(CAST(COALESCE(content_type,'') AS BLOB)) + length(CAST(COALESCE(mime_type,'') AS BLOB)) + 128),0) AS row_bytes,
      COALESCE(SUM(byte_size),0) AS byte_size FROM dataset_files WHERE dataset_id=?`).get(datasetId);
    if (!indexed || indexed.file_count > MAX_ITEMS - 1 || indexed.row_bytes > MAX_PREFLIGHT_BYTES
      || indexed.byte_size > Number.MAX_SAFE_INTEGER) throw new HeldSourceExport('dataset_preflight_limit');
    const storedGcp = db.prepare(`SELECT length(CAST(evidence_json AS BLOB)) AS evidence_bytes,
      length(CAST(content_text AS BLOB)) AS content_bytes FROM processing_attempt_gcp_snapshots WHERE attempt_id=?`).get(attemptId);
    if (storedGcp && ((storedGcp.evidence_bytes || 0) > MAX_GCP_EVIDENCE_BYTES
      || (storedGcp.content_bytes || 0) > MAX_GCP_CONTENT_BYTES)) throw new HeldSourceExport('gcp_preflight_limit');

    const dataset = processing.getDataset(datasetId, true);
    const task = processing.getTask(taskId);
    const attempt = processing.getAttempt(attemptId);
    const project = task && processing.getProject(task.projectId);
    if (!dataset || dataset.status !== 'finalized' || !task || task.status === 'archived' || task.purgedAt
      || !project || project.status !== 'active' || task.datasetId !== dataset.id || task.activeAttemptId !== attemptId
      || !attempt || attempt.taskId !== task.id || attempt.datasetId !== dataset.id
      || ['failed', 'cancelled', 'published'].includes(attempt.status)) {
      throw new HeldSourceExport('current_attempt_unavailable');
    }
    if (!Array.isArray(dataset.files) || dataset.files.length !== dataset.fileCount || dataset.files.length !== indexed.file_count
      || dataset.files.reduce((sum, file) => sum + file.byteSize, 0) !== dataset.byteSize) {
      throw new HeldSourceExport('dataset_inventory_inconsistent');
    }

    const snapshot = processing.getAttemptProvenance(attempt.id)?.submission;
    if (!snapshot || snapshot.attemptId !== attempt.id || snapshot.datasetId !== dataset.id
      || snapshot.datasetManifestSha256 !== dataset.manifestSha256) {
      throw new HeldSourceExport('attempt_provenance_unavailable');
    }

    const gcpSnapshot = processing.getAttemptGcpSnapshot(attempt.id);
    const gcpEvidence = processing.getAttemptGcpEvidence(attempt.id);
    if (gcpSnapshot && !gcpEvidence) throw new HeldSourceExport('gcp_evidence_unavailable');
    const gcpEvidenceRow = db.prepare('SELECT evidence_json,content_text,sha256 FROM processing_attempt_gcp_snapshots WHERE attempt_id=?').get(attempt.id);
    const gcpEvidenceBytes = gcpEvidenceRow?.evidence_json == null ? null : Buffer.from(gcpEvidenceRow.evidence_json, 'utf8');
    const gcpFileBytes = gcpEvidenceRow?.content_text == null ? null : Buffer.from(gcpEvidenceRow.content_text, 'utf8');
    if (Boolean(gcpEvidence) !== Boolean(gcpEvidenceBytes) || Boolean(gcpSnapshot) !== Boolean(gcpFileBytes)) {
      throw new HeldSourceExport('gcp_evidence_unavailable');
    }
    const inventory = inputInventory(dataset.files, gcpSnapshot);
    if (inventory.sourceFilesSha256 !== snapshot.sourceFilesSha256
      || inventory.inputManifestSha256 !== snapshot.inputManifestSha256
      || JSON.stringify(inventory.inputFiles) !== JSON.stringify(snapshot.inputFiles)
      || snapshot.gcpSnapshotSha256 !== (gcpSnapshot?.sha256 || null)) {
      throw new HeldSourceExport('attempt_input_inventory_changed');
    }

    const sourceRecords = dataset.files.map(fileFacts);
    const filesById = new Map(dataset.files.map((file) => [file.id, file]));
    let generatedGcp = null;
    if (gcpEvidence) generatedGcp = assertGcpEvidence(gcpEvidence, filesById);
    if (generatedGcp) {
      const decodedFile = new TextDecoder('utf-8', { fatal: true }).decode(gcpFileBytes);
      if (decodedFile !== gcpSnapshot.content || gcpEvidenceRow.sha256 !== gcpSnapshot.sha256
        || gcpEvidence.snapshot.sha256 !== gcpSnapshot.sha256
        || gcpEvidence.snapshot.byteSize !== gcpFileBytes.length
        || generatedGcp.sha256 !== gcpSnapshot.sha256 || generatedGcp.byteSize !== gcpFileBytes.length) {
        throw new HeldSourceExport('gcp_file_snapshot_mismatch');
      }
    }
    if (generatedGcp) sourceRecords.push(generatedGcp);
    if (sourceRecords.length > MAX_ITEMS) throw new HeldSourceExport('source_item_limit');

    const byId = new Map(sourceRecords.filter((record) => record.type === 'dataset_file').map((record) => [record.datasetFileId, record]));
    const selected = sourceRecords.filter((record) => record.type === 'dataset_file'
      && !['gcp_source', 'administrative'].includes(record.processingRole)
      && (record.processingRole !== 'auto' || PHOTO.test(record.relativePath)));
    if (generatedGcp) {
      for (let index = selected.length - 1; index >= 0; index--) {
        if (path.posix.basename(selected[index].relativePath).toLowerCase() === 'gcp_list.txt') selected.splice(index, 1);
      }
      selected.push(generatedGcp);
    }
    const orderedSelected = [
      ...selected.filter((record) => PHOTO.test(record.relativePath || 'gcp_list.txt')),
      ...selected.filter((record) => !PHOTO.test(record.relativePath || 'gcp_list.txt')),
    ];
    const orderedInputFiles = orderedSelected.map((record) => record.type === 'dataset_file'
      ? { relativePath: record.relativePath, byteSize: record.byteSize, sha256: record.sha256 }
      : { relativePath: 'gcp_list.txt', byteSize: record.byteSize, sha256: record.sha256 });
    if (JSON.stringify(orderedInputFiles) !== JSON.stringify(inventory.inputFiles)) throw new HeldSourceExport('selected_inventory_mismatch');
    if (orderedSelected.length !== inventory.inputFiles.length || orderedSelected.length > MAX_ITEMS) throw new HeldSourceExport('selected_inventory_mismatch');

    const generatedPageId = `gcp_${attempt.id}`;
    if (generatedGcp && byId.has(generatedPageId)) throw new HeldSourceExport('generated_page_id_collision');
    const selectedRecords = orderedSelected.map((record, ordinal) => record.type === 'dataset_file'
      ? { type: 'dataset_file', ordinal, pageObjectId: record.datasetFileId, datasetFileId: record.datasetFileId }
      : { type: 'attempt_generated_gcp', ordinal, pageObjectId: generatedPageId, attemptId: record.attemptId, mediaType: 'text/plain' });

    const source = frameStream(sourceRecords, SOURCE_VERSION, SOURCE_DOMAIN);
    const selection = frameStream(selectedRecords, SELECTED_VERSION, SELECTED_DOMAIN);
    const evidence = gcpEvidenceBytes ? gcpEvidenceStream(gcpEvidenceBytes, attempt.id) : null;
    const generatedFile = gcpFileBytes ? generatedGcpFileStream(gcpFileBytes, attempt.id, evidence.sha256) : null;
    const totalStreamBytes = source.totalBytes + selection.totalBytes + (evidence?.streamBytes || 0) + (generatedFile?.streamBytes || 0);
    if (totalStreamBytes > MAX_TOTAL_EXPORT_STREAM_BYTES) throw new HeldSourceExport('total_export_stream_limit');
    const result = {
      state: 'held_authenticated_source_unavailable',
      datasetId: dataset.id, datasetManifestSha256: dataset.manifestSha256,
      taskId: task.id, attemptId: attempt.id, inputManifestSha256: inventory.inputManifestSha256,
      sourceCount: dataset.files.length, sourcePageHashes: source.pageHashes, sourceFrames: source.bytes,
      selectedCount: selectedRecords.length, selectedPageHashes: selection.pageHashes, selectedFrames: selection.bytes,
      gcpEvidenceVersion: evidence ? GCP_EVIDENCE_VERSION : null,
      gcpEvidencePageHashes: evidence?.pageHashes || null,
      gcpEvidencePageBytes: evidence?.pageBytes || null,
      gcpEvidencePageCount: evidence?.pageCount ?? null,
      gcpEvidenceByteCount: evidence?.byteCount ?? null,
      gcpEvidenceSha256: evidence?.sha256 || null,
      gcpEvidenceFrames: evidence?.bytes || null,
      gcpFileVersion: generatedFile ? GCP_FILE_VERSION : null,
      gcpFilePageHashes: generatedFile?.pageHashes || null,
      gcpFilePageBytes: generatedFile?.pageBytes || null,
      gcpFilePageCount: generatedFile?.pageCount ?? null,
      gcpFileByteCount: generatedFile?.byteCount ?? null,
      gcpFileSha256: generatedFile?.sha256 || null,
      gcpFileFrames: generatedFile?.bytes || null,
      totalStreamBytes,
      generatedGcp: generatedGcp ? { byteSize: generatedGcp.byteSize, sha256: generatedGcp.sha256,
        correspondenceSha256: generatedGcp.correspondenceSha256, sourceFiles: generatedGcp.sourceFiles } : null,
      authority: null, principal: null, revocationEpoch: null,
      enabled: false,
    };
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (error instanceof HeldSourceExport) throw error;
    throw new HeldSourceExport('source_export_held');
  }
}

module.exports = {
  captureHeldSourceExport, HeldSourceExport, frameStream, gcpEvidenceStream, generatedGcpFileStream,
  MAX_FRAME_BYTES, MAX_GCP_EVIDENCE_BYTES, MAX_GCP_EVIDENCE_CHUNK_BYTES,
  MAX_GCP_CONTENT_BYTES, MAX_TOTAL_EXPORT_STREAM_BYTES,
  GCP_EVIDENCE_VERSION, GCP_EVIDENCE_DOMAIN, GCP_FILE_VERSION, GCP_FILE_DOMAIN, SOURCE_VERSION, SELECTED_VERSION,
  SOURCE_DOMAIN, SELECTED_DOMAIN, BINDING_DOMAIN,
};
