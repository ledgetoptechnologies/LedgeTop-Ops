'use strict';

const crypto = require('node:crypto');

// Increment when detection or parsing rules change so earlier outcomes are
// never mistaken for a scan under the new rules.
const SCANNER_VERSION = 1;

function latestScan(database, datasetId, fileId, sha256) {
  return database.prepare(`SELECT * FROM gcp_source_scan_attempts
    WHERE dataset_id=? AND source_file_id=? AND source_sha256=? AND scanner_version=?
    ORDER BY attempt_seq DESC LIMIT 1`).get(datasetId, fileId, sha256, SCANNER_VERSION) || null;
}

// Call while holding the database write transaction. Import creation and its
// successful ledger entry must be committed together by the caller.
function recordScan(database, {datasetId, fileId, sha256, outcome, reasonCode = null, setId = null, pointCount = null, actor = null}) {
  const current = database.prepare('SELECT sha256 FROM dataset_files WHERE id=? AND dataset_id=?').get(fileId, datasetId);
  if (!current || current.sha256 !== sha256)
    throw Object.assign(new Error('GCP source snapshot changed'), {code:'gcp_source_snapshot_mismatch'});
  const latest = latestScan(database, datasetId, fileId, sha256);
  if (latest && latest.outcome === outcome && outcome !== 'failed'
      && (outcome !== 'imported' || latest.gcp_set_id === setId)) return latest;
  const id = crypto.randomUUID(), sequence = (latest?.attempt_seq || 0) + 1;
  database.prepare(`INSERT INTO gcp_source_scan_attempts
    (id,dataset_id,source_file_id,source_sha256,scanner_version,attempt_seq,outcome,reason_code,gcp_set_id,point_count,scanned_at,scanned_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,datasetId,fileId,sha256,SCANNER_VERSION,sequence,outcome,reasonCode,setId,pointCount,new Date().toISOString(),actor);
  return latestScan(database,datasetId,fileId,sha256);
}

module.exports = { SCANNER_VERSION, latestScan, recordScan };
