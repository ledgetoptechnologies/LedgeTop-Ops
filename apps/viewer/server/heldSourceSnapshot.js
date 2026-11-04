'use strict';

// Unmounted candidate. Callers must provide a server-owned signer and the
// Processing acceptance receipt before a held source can ever be released.
const crypto = require('node:crypto');
const { canonicalBytes } = require('./referenceProtocol');
const {
  captureHeldSourceExport, HeldSourceExport, SOURCE_DOMAIN, SELECTED_DOMAIN, SOURCE_VERSION, SELECTED_VERSION,
  GCP_EVIDENCE_DOMAIN, GCP_FILE_DOMAIN, GCP_EVIDENCE_VERSION, GCP_FILE_VERSION,
} = require('./viewerPagedSourceExport');

const SNAPSHOT_PROTOCOL = 'ltds-viewer-held-source-snapshot-v1';
const SNAPSHOT_DOMAIN = Buffer.from('ltds-viewer-held-source-snapshot-v1\0', 'ascii');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code) => { throw new HeldSourceExport(code); };

function verifyFrameStream(bytes, pageHashes, domain, expectedVersion) {
  if (!Buffer.isBuffer(bytes) || !Array.isArray(pageHashes) || !pageHashes.length || !bytes.length || bytes.at(-1) !== 0x0a) return false;
  const lines = bytes.subarray(0, -1).toString('utf8').split('\n');
  if (lines.length !== pageHashes.length) return false;
  let recordCount = 0;
  const valid = lines.every((line, index) => {
    try {
      const frame = JSON.parse(line), canonical = canonicalBytes(frame);
      if (!Array.isArray(frame.records) || frame.version !== expectedVersion || frame.index !== index) return false;
      recordCount += frame.records.length;
      return Buffer.compare(Buffer.from(line, 'utf8'), canonical) === 0
        && sha256(Buffer.concat([domain, canonical])) === pageHashes[index];
    } catch { return false; }
  });
  return valid ? recordCount : false;
}

function verifyChunkStream(bytes, pageHashes, pageBytes, domain, expectedVersion, attemptId, contentSha256, evidenceSha256 = null) {
  if (!Buffer.isBuffer(bytes) || !Array.isArray(pageHashes) || !pageHashes.length || !bytes.length || bytes.at(-1) !== 0x0a) return null;
  if (!Array.isArray(pageBytes) || pageBytes.length !== pageHashes.length) return null;
  let lines;
  try { lines = bytes.subarray(0, -1).toString('utf8').split('\n'); } catch { return null; }
  if (lines.length !== pageHashes.length) return null;
  let offset = 0, complete = false;
  const chunks = [];
  for (let index = 0; index < lines.length; index++) {
    try {
      const line = lines[index], frame = JSON.parse(line), canonical = canonicalBytes(frame);
      if (Buffer.compare(Buffer.from(line, 'utf8'), canonical) !== 0
          || canonical.length !== pageBytes[index]
          || frame.version !== expectedVersion || frame.attemptId !== attemptId || frame.index !== index
          || sha256(Buffer.concat([domain, canonical])) !== pageHashes[index]) return null;
      if (frame.complete === true) {
        if (index !== lines.length - 1 || frame.offset !== offset || frame.totalBytes !== offset) return null;
        if (expectedVersion === GCP_EVIDENCE_VERSION) {
          if (frame.evidenceSha256 !== contentSha256 || Object.keys(frame).sort().join(',') !== 'attemptId,complete,evidenceSha256,index,offset,totalBytes,version') return null;
        } else if (frame.fileSha256 !== contentSha256 || frame.evidenceSha256 !== evidenceSha256
            || Object.keys(frame).sort().join(',') !== 'attemptId,complete,evidenceSha256,fileSha256,index,offset,totalBytes,version') return null;
        complete = true;
        continue;
      }
      if (complete || frame.offset !== offset || !Number.isSafeInteger(frame.decodedByteCount) || frame.decodedByteCount < 1
          || typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]+$/.test(frame.data)) return null;
      if (expectedVersion === GCP_EVIDENCE_VERSION) {
        if (frame.evidenceSha256 !== contentSha256
            || Object.keys(frame).sort().join(',') !== 'attemptId,data,decodedByteCount,evidenceSha256,index,offset,version') return null;
      } else if (frame.fileSha256 !== contentSha256 || frame.evidenceSha256 !== evidenceSha256
          || Object.keys(frame).sort().join(',') !== 'attemptId,data,decodedByteCount,evidenceSha256,fileSha256,index,offset,version') return null;
      const decoded = Buffer.from(frame.data, 'base64url');
      if (!decoded.length || decoded.length !== frame.decodedByteCount || decoded.toString('base64url') !== frame.data) return null;
      chunks.push(decoded); offset += decoded.length;
    } catch { return null; }
  }
  if (!complete) return null;
  const content = Buffer.concat(chunks);
  return sha256(content) === contentSha256 ? content : null;
}

function snapshotGcp(exported) {
  const hasEvidence = Buffer.isBuffer(exported.gcpEvidenceFrames);
  const hasFile = Buffer.isBuffer(exported.gcpFileFrames);
  if (hasEvidence !== hasFile || Boolean(exported.generatedGcp) !== hasEvidence) fail('snapshot_gcp_extension_incomplete');
  if (!hasEvidence) return null;
  if (exported.gcpEvidenceVersion !== GCP_EVIDENCE_VERSION || exported.gcpFileVersion !== GCP_FILE_VERSION
      || !/^[a-f0-9]{64}$/.test(exported.gcpEvidenceSha256 || '') || !/^[a-f0-9]{64}$/.test(exported.gcpFileSha256 || '')
      || exported.gcpFileEvidenceSha256 !== exported.gcpEvidenceSha256
      || !Number.isSafeInteger(exported.gcpEvidenceByteCount) || exported.gcpEvidenceByteCount < 1
      || !Number.isSafeInteger(exported.gcpFileByteCount) || exported.gcpFileByteCount < 1
      || exported.gcpEvidenceFrames.length > 24 * 1024 * 1024 || exported.gcpFileFrames.length > 24 * 1024 * 1024
      || !Array.isArray(exported.gcpEvidencePageHashes) || !Array.isArray(exported.gcpFilePageHashes)
      || !Array.isArray(exported.gcpEvidencePageBytes) || !Array.isArray(exported.gcpFilePageBytes)
      || exported.gcpEvidencePageHashes.length !== exported.gcpEvidencePageCount
      || exported.gcpFilePageHashes.length !== exported.gcpFilePageCount
      || exported.gcpEvidencePageBytes.length !== exported.gcpEvidencePageCount
      || exported.gcpFilePageBytes.length !== exported.gcpFilePageCount) fail('snapshot_gcp_extension_invalid');
  const evidenceBytes = verifyChunkStream(exported.gcpEvidenceFrames, exported.gcpEvidencePageHashes,
    exported.gcpEvidencePageBytes, GCP_EVIDENCE_DOMAIN, GCP_EVIDENCE_VERSION, exported.attemptId, exported.gcpEvidenceSha256);
  const fileBytes = verifyChunkStream(exported.gcpFileFrames, exported.gcpFilePageHashes,
    exported.gcpFilePageBytes, GCP_FILE_DOMAIN, GCP_FILE_VERSION, exported.attemptId, exported.gcpFileSha256, exported.gcpEvidenceSha256);
  if (!evidenceBytes || !fileBytes || evidenceBytes.length !== exported.gcpEvidenceByteCount
      || fileBytes.length !== exported.gcpFileByteCount || exported.generatedGcp.byteSize !== fileBytes.length
      || exported.generatedGcp.sha256 !== exported.gcpFileSha256 || exported.generatedGcp.attemptId !== exported.attemptId) fail('snapshot_gcp_stream_invalid');
  try { new TextDecoder('utf-8', { fatal: true }).decode(evidenceBytes); new TextDecoder('utf-8', { fatal: true }).decode(fileBytes); }
  catch { fail('snapshot_gcp_utf8_invalid'); }
  return {
    evidenceVersion: exported.gcpEvidenceVersion,
    evidencePageHashes: exported.gcpEvidencePageHashes,
    evidencePageBytes: exported.gcpEvidencePageBytes,
    evidencePageCount: exported.gcpEvidencePageCount,
    evidenceByteCount: exported.gcpEvidenceByteCount,
    evidenceSha256: exported.gcpEvidenceSha256,
    fileVersion: exported.gcpFileVersion,
    filePageHashes: exported.gcpFilePageHashes,
    filePageBytes: exported.gcpFilePageBytes,
    filePageCount: exported.gcpFilePageCount,
    fileByteCount: exported.gcpFileByteCount,
    fileSha256: exported.gcpFileSha256,
    generatedGcp: exported.generatedGcp,
  };
}

function validateSigner(signer) {
  if (!signer || typeof signer.issuerId !== 'string' || !signer.issuerId || signer.issuerId.length > 128
    || typeof signer.keyId !== 'string' || !signer.keyId || signer.keyId.length > 128
    || typeof signer.sign !== 'function') fail('snapshot_signer_unavailable');
  return signer;
}

function createHeldSourceSnapshot(processing, {
  datasetId, taskId, attemptId, snapshotId = crypto.randomUUID(), signer,
  now = () => new Date().toISOString(),
} = {}) {
  if (!processing?.database || typeof snapshotId !== 'string' || !/^[0-9a-f-]{36}$/i.test(snapshotId)) {
    fail('snapshot_request_invalid');
  }
  validateSigner(signer);
  const createdAt = now();
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) fail('snapshot_time_invalid');

  return processing.transaction(() => {
    if (processing.database.prepare('SELECT 1 FROM viewer_source_snapshots WHERE snapshot_id=? OR attempt_id=?').get(snapshotId, attemptId)) {
      fail('snapshot_identity_reused');
    }
    const exported = captureHeldSourceExport(processing, { datasetId, taskId, attemptId, joinTransaction: true });
    if (!Buffer.isBuffer(exported.sourceFrames) || !Buffer.isBuffer(exported.selectedFrames)) fail('snapshot_frames_unavailable');
    const gcp = snapshotGcp(exported);
    const sourceRecords = verifyFrameStream(exported.sourceFrames, exported.sourcePageHashes, SOURCE_DOMAIN, SOURCE_VERSION);
    if (sourceRecords === false) fail('snapshot_source_frames_invalid');
    const records = exported.sourceFrames.subarray(0, -1).toString('utf8').split('\n').flatMap(line => JSON.parse(line).records);
    if (!gcp && records.some(record => record?.type === 'dataset_file' && record.processingRole === 'gcp_source')) {
      fail('snapshot_gcp_evidence_required');
    }

    const intent = {
      protocol: SNAPSHOT_PROTOCOL,
      snapshotId,
      issuerId: signer.issuerId,
      keyId: signer.keyId,
      createdAt,
      datasetId: exported.datasetId,
      datasetManifestSha256: exported.datasetManifestSha256,
      taskId: exported.taskId,
      attemptId: exported.attemptId,
      inputManifestSha256: exported.inputManifestSha256,
      sourceCount: exported.sourceCount,
      datasetFileCount: exported.datasetFileCount,
      sourcePageHashes: exported.sourcePageHashes,
      sourceFrameBytes: exported.sourceFrames.length,
      selectedCount: exported.selectedCount,
      selectedPageHashes: exported.selectedPageHashes,
      selectedFrameBytes: exported.selectedFrames.length,
      gcp,
    };
    const intentBytes = canonicalBytes(intent);
    const signature = Buffer.from(signer.sign(Buffer.concat([SNAPSHOT_DOMAIN, intentBytes])));
    if (!signature.length || signature.length > 1024) fail('snapshot_signature_invalid');
    const intentSha256 = sha256(intentBytes);
    processing.database.prepare(`INSERT INTO viewer_source_snapshots(
      snapshot_id,dataset_id,task_id,attempt_id,dataset_manifest_sha256,input_manifest_sha256,
      intent_json,intent_sha256,issuer_id,key_id,signature,source_frames,selected_frames,
      source_page_hashes_json,selected_page_hashes_json,source_frame_bytes,selected_frame_bytes,
      gcp_evidence_frames,gcp_file_frames,status,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'held',?)`).run(
      snapshotId, exported.datasetId, exported.taskId, exported.attemptId,
      exported.datasetManifestSha256, exported.inputManifestSha256,
      intentBytes.toString('utf8'), intentSha256, signer.issuerId, signer.keyId, signature,
      exported.sourceFrames, exported.selectedFrames,
      JSON.stringify(exported.sourcePageHashes), JSON.stringify(exported.selectedPageHashes),
      exported.sourceFrames.length, exported.selectedFrames.length,
      gcp ? exported.gcpEvidenceFrames : null, gcp ? exported.gcpFileFrames : null, createdAt,
    );
    return getHeldSourceSnapshot(processing, snapshotId);
  });
}

function getHeldSourceSnapshot(processing, snapshotId) {
  const row = processing?.database?.prepare('SELECT * FROM viewer_source_snapshots WHERE snapshot_id=?').get(snapshotId);
  if (!row) return null;
  return {
    snapshotId: row.snapshot_id, datasetId: row.dataset_id, taskId: row.task_id, attemptId: row.attempt_id,
    datasetManifestSha256: row.dataset_manifest_sha256, inputManifestSha256: row.input_manifest_sha256,
    createdAt: row.created_at,
    status: row.status, intent: JSON.parse(row.intent_json), intentSha256: row.intent_sha256,
    issuerId: row.issuer_id, keyId: row.key_id, signature: Buffer.from(row.signature),
    sourceFrames: Buffer.from(row.source_frames), selectedFrames: Buffer.from(row.selected_frames),
    gcpEvidenceFrames: row.gcp_evidence_frames === null ? null : Buffer.from(row.gcp_evidence_frames),
    gcpFileFrames: row.gcp_file_frames === null ? null : Buffer.from(row.gcp_file_frames),
    sourcePageHashes: JSON.parse(row.source_page_hashes_json), selectedPageHashes: JSON.parse(row.selected_page_hashes_json),
    sourceFrameBytes: row.source_frame_bytes, selectedFrameBytes: row.selected_frame_bytes,
    acceptanceReceiptSha256: row.acceptance_receipt_sha256,
    acceptanceReceipt: row.acceptance_receipt_json ? JSON.parse(row.acceptance_receipt_json) : null,
  };
}

function verifyHeldSourceSnapshot(snapshot, publicKey) {
  try {
    if (!snapshot || !publicKey || !snapshot.intent || snapshot.intent.protocol !== SNAPSHOT_PROTOCOL) return false;
    const intentBytes = canonicalBytes(snapshot.intent);
    const sourceRecords = verifyFrameStream(snapshot.sourceFrames, snapshot.sourcePageHashes, SOURCE_DOMAIN, SOURCE_VERSION);
    const selectedRecords = verifyFrameStream(snapshot.selectedFrames, snapshot.selectedPageHashes, SELECTED_DOMAIN, SELECTED_VERSION);
    const gcp = snapshot.intent.gcp;
    let gcpValid = gcp == null && snapshot.gcpEvidenceFrames === null && snapshot.gcpFileFrames === null;
    if (gcp && snapshot.gcpEvidenceFrames && snapshot.gcpFileFrames) {
      const evidence = verifyChunkStream(snapshot.gcpEvidenceFrames, gcp.evidencePageHashes, gcp.evidencePageBytes,
        GCP_EVIDENCE_DOMAIN, gcp.evidenceVersion, snapshot.attemptId, gcp.evidenceSha256);
      const file = verifyChunkStream(snapshot.gcpFileFrames, gcp.filePageHashes, gcp.filePageBytes,
        GCP_FILE_DOMAIN, gcp.fileVersion, snapshot.attemptId, gcp.fileSha256, gcp.evidenceSha256);
      gcpValid = Boolean(evidence && file && evidence.length === gcp.evidenceByteCount
        && file.length === gcp.fileByteCount && gcp.generatedGcp?.sha256 === gcp.fileSha256
        && gcp.generatedGcp?.byteSize === file.length);
    }
    return snapshot.snapshotId === snapshot.intent.snapshotId
      && snapshot.issuerId === snapshot.intent.issuerId && snapshot.keyId === snapshot.intent.keyId
      && snapshot.createdAt === snapshot.intent.createdAt
      && snapshot.datasetId === snapshot.intent.datasetId && snapshot.datasetManifestSha256 === snapshot.intent.datasetManifestSha256
      && snapshot.taskId === snapshot.intent.taskId && snapshot.attemptId === snapshot.intent.attemptId
      && snapshot.inputManifestSha256 === snapshot.intent.inputManifestSha256
      && JSON.stringify(snapshot.sourcePageHashes) === JSON.stringify(snapshot.intent.sourcePageHashes)
      && JSON.stringify(snapshot.selectedPageHashes) === JSON.stringify(snapshot.intent.selectedPageHashes)
      && snapshot.sourceFrameBytes === snapshot.intent.sourceFrameBytes
      && snapshot.selectedFrameBytes === snapshot.intent.selectedFrameBytes
      && sourceRecords === snapshot.intent.sourceCount && selectedRecords === snapshot.intent.selectedCount
      && gcpValid
      && sha256(intentBytes) === snapshot.intentSha256
      && crypto.verify(null, Buffer.concat([SNAPSHOT_DOMAIN, intentBytes]), publicKey, snapshot.signature)
      && snapshot.sourceFrames.length === snapshot.sourceFrameBytes
      && snapshot.selectedFrames.length === snapshot.selectedFrameBytes;
  } catch { return false; }
}

function acceptHeldSourceSnapshot(processing, snapshotId, { receipt, verifyAcceptance } = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || typeof verifyAcceptance !== 'function') return null;
  return processing.transaction(() => {
    const snapshot = getHeldSourceSnapshot(processing, snapshotId);
    if (!snapshot || snapshot.status !== 'held' || verifyAcceptance(snapshot, receipt) !== true) return null;
    const receiptBytes = canonicalBytes(receipt), receiptSha256 = sha256(receiptBytes);
    const now = new Date().toISOString();
    const changed = processing.database.prepare(`UPDATE viewer_source_snapshots
      SET status='accepted',acceptance_receipt_sha256=?,acceptance_receipt_json=?,accepted_at=? WHERE snapshot_id=? AND status='held'`)
      .run(receiptSha256, receiptBytes.toString('utf8'), now, snapshotId);
    return changed.changes === 1 ? getHeldSourceSnapshot(processing, snapshotId) : null;
  });
}

function releaseHeldSourceSnapshot(processing, snapshotId, { verifyAcceptance } = {}) {
  if (typeof verifyAcceptance !== 'function') return null;
  return processing.transaction(() => {
    const snapshot = getHeldSourceSnapshot(processing, snapshotId);
    if (!snapshot || snapshot.status !== 'accepted'
      || sha256(canonicalBytes(snapshot.acceptanceReceipt)) !== snapshot.acceptanceReceiptSha256
      || verifyAcceptance(snapshot, snapshot.acceptanceReceipt) !== true) return null;
    const now = new Date().toISOString();
    const changed = processing.database.prepare(`UPDATE viewer_source_snapshots
      SET status='released',released_at=? WHERE snapshot_id=? AND status='accepted' AND acceptance_receipt_sha256=?`)
      .run(now, snapshotId, snapshot.acceptanceReceiptSha256);
    return changed.changes === 1 ? getHeldSourceSnapshot(processing, snapshotId) : null;
  });
}

module.exports = {
  SNAPSHOT_PROTOCOL, SNAPSHOT_DOMAIN, createHeldSourceSnapshot, getHeldSourceSnapshot,
  verifyHeldSourceSnapshot, acceptHeldSourceSnapshot, releaseHeldSourceSnapshot,
  verifyChunkStream,
};
