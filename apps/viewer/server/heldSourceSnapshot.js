'use strict';

// Unmounted candidate. Callers must provide a server-owned signer and the
// Processing acceptance receipt before a held source can ever be released.
const crypto = require('node:crypto');
const { canonicalBytes } = require('./referenceProtocol');
const {
  captureHeldSourceExport, HeldSourceExport, SOURCE_DOMAIN, SELECTED_DOMAIN,
} = require('./viewerPagedSourceExport');

const SNAPSHOT_PROTOCOL = 'ltds-viewer-held-source-snapshot-v1';
const SNAPSHOT_DOMAIN = Buffer.from('ltds-viewer-held-source-snapshot-v1\0', 'ascii');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (code) => { throw new HeldSourceExport(code); };

function verifyFrameStream(bytes, pageHashes, domain) {
  if (!Buffer.isBuffer(bytes) || !Array.isArray(pageHashes) || !pageHashes.length || !bytes.length || bytes.at(-1) !== 0x0a) return false;
  const lines = bytes.subarray(0, -1).toString('utf8').split('\n');
  if (lines.length !== pageHashes.length) return false;
  return lines.every((line, index) => {
    try {
      const frame = JSON.parse(line), canonical = canonicalBytes(frame);
      return Buffer.compare(Buffer.from(line, 'utf8'), canonical) === 0
        && sha256(Buffer.concat([domain, canonical])) === pageHashes[index];
    } catch { return false; }
  });
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
    // The current Processing candidate does not yet verify the distinct GCP
    // evidence and generated-file streams as part of its signed intake.
    if (exported.generatedGcp || exported.gcpEvidenceFrames || exported.gcpFileFrames) fail('snapshot_gcp_extension_unavailable');
    if (!Buffer.isBuffer(exported.sourceFrames) || !Buffer.isBuffer(exported.selectedFrames)) fail('snapshot_frames_unavailable');

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
      sourcePageHashes: exported.sourcePageHashes,
      sourceFrameBytes: exported.sourceFrames.length,
      selectedCount: exported.selectedCount,
      selectedPageHashes: exported.selectedPageHashes,
      selectedFrameBytes: exported.selectedFrames.length,
    };
    const intentBytes = canonicalBytes(intent);
    const signature = Buffer.from(signer.sign(Buffer.concat([SNAPSHOT_DOMAIN, intentBytes])));
    if (!signature.length || signature.length > 1024) fail('snapshot_signature_invalid');
    const intentSha256 = sha256(intentBytes);
    processing.database.prepare(`INSERT INTO viewer_source_snapshots(
      snapshot_id,dataset_id,task_id,attempt_id,dataset_manifest_sha256,input_manifest_sha256,
      intent_json,intent_sha256,issuer_id,key_id,signature,source_frames,selected_frames,
      source_page_hashes_json,selected_page_hashes_json,source_frame_bytes,selected_frame_bytes,
      status,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?,'held',?)`).run(
      snapshotId, exported.datasetId, exported.taskId, exported.attemptId,
      exported.datasetManifestSha256, exported.inputManifestSha256,
      intentBytes.toString('utf8'), intentSha256, signer.issuerId, signer.keyId, signature,
      exported.sourceFrames, exported.selectedFrames,
      JSON.stringify(exported.sourcePageHashes), JSON.stringify(exported.selectedPageHashes),
      exported.sourceFrames.length, exported.selectedFrames.length, createdAt,
    );
    return {
      snapshotId, status: 'held', intent, intentSha256,
      signature: signature.toString('base64url'),
      sourceFrames: exported.sourceFrames, selectedFrames: exported.selectedFrames,
    };
  });
}

function getHeldSourceSnapshot(processing, snapshotId) {
  const row = processing?.database?.prepare('SELECT * FROM viewer_source_snapshots WHERE snapshot_id=?').get(snapshotId);
  if (!row) return null;
  return {
    snapshotId: row.snapshot_id, datasetId: row.dataset_id, taskId: row.task_id, attemptId: row.attempt_id,
    status: row.status, intent: JSON.parse(row.intent_json), intentSha256: row.intent_sha256,
    issuerId: row.issuer_id, keyId: row.key_id, signature: Buffer.from(row.signature),
    sourceFrames: Buffer.from(row.source_frames), selectedFrames: Buffer.from(row.selected_frames),
    sourcePageHashes: JSON.parse(row.source_page_hashes_json), selectedPageHashes: JSON.parse(row.selected_page_hashes_json),
    sourceFrameBytes: row.source_frame_bytes, selectedFrameBytes: row.selected_frame_bytes,
    acceptanceReceiptSha256: row.acceptance_receipt_sha256,
    acceptanceReceipt: row.acceptance_receipt_json ? JSON.parse(row.acceptance_receipt_json) : null,
  };
}

function verifyHeldSourceSnapshot(snapshot, publicKey) {
  if (!snapshot || !publicKey || snapshot.intent.protocol !== SNAPSHOT_PROTOCOL) return false;
  const intentBytes = canonicalBytes(snapshot.intent);
  return sha256(intentBytes) === snapshot.intentSha256
    && crypto.verify(null, Buffer.concat([SNAPSHOT_DOMAIN, intentBytes]), publicKey, snapshot.signature)
    && snapshot.sourceFrames.length === snapshot.sourceFrameBytes
    && snapshot.selectedFrames.length === snapshot.selectedFrameBytes
    && verifyFrameStream(snapshot.sourceFrames, snapshot.sourcePageHashes, SOURCE_DOMAIN)
    && verifyFrameStream(snapshot.selectedFrames, snapshot.selectedPageHashes, SELECTED_DOMAIN);
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
};
