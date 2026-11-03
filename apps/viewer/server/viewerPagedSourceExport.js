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
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_FRAMES = 64;
const MAX_ITEMS_PER_FRAME = 512;
const MAX_ITEMS = 20_000;
const PHOTO = /\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i;
const CONTROL = /[\x00-\x1f\x7f]/u;

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
    || typeof file.relativePath !== 'string' || !file.relativePath || CONTROL.test(file.relativePath)
    || file.relativePath.startsWith('/') || file.relativePath.includes('\\')
    || file.relativePath.split('/').some((part) => !part || part === '.' || part === '..')
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
    // The empty canonical frame contributes its fixed fields and [] delimiters.
    const empty = canonicalBytes({ version, index: frames.length, records: [] }).length;
    const nextFrameBytes = empty - 2 + nextRecordBytes;
    if (current.length && (nextCount > MAX_ITEMS_PER_FRAME || nextFrameBytes > MAX_FRAME_BYTES)) flush();
    if (current.length >= MAX_ITEMS_PER_FRAME) flush();
    const freshEmpty = canonicalBytes({ version, index: frames.length, records: [] }).length;
    const addedBytes = encoded.length + (current.length ? 1 : 0);
    if (freshEmpty - 2 + currentRecordBytes + addedBytes > MAX_FRAME_BYTES) throw new HeldSourceExport('source_record_limit');
    current.push(record);
    currentRecordBytes += addedBytes;
  }
  flush();
  if (!frames.length) throw new HeldSourceExport('empty_source_stream');
  return { frames, bytes: Buffer.concat(frames.map((frame) => frame.bytes)), pageHashes: frames.map((frame) => frame.sha256), totalBytes };
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
  const sourceFiles = [...refs.values()].sort((a, b) => a.datasetFileId.localeCompare(b.datasetFileId));
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
    if (!Array.isArray(dataset.files) || dataset.files.length !== dataset.fileCount || dataset.files.length > MAX_ITEMS - 1
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
    const result = {
      state: 'held_authenticated_source_unavailable',
      datasetId: dataset.id, datasetManifestSha256: dataset.manifestSha256,
      taskId: task.id, attemptId: attempt.id, inputManifestSha256: inventory.inputManifestSha256,
      sourceCount: sourceRecords.length, sourcePageHashes: source.pageHashes, sourceFrames: source.bytes,
      selectedCount: selectedRecords.length, selectedPageHashes: selection.pageHashes, selectedFrames: selection.bytes,
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

module.exports = { captureHeldSourceExport, HeldSourceExport, SOURCE_VERSION, SELECTED_VERSION, SOURCE_DOMAIN, SELECTED_DOMAIN, BINDING_DOMAIN };
