'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { GcpRepository } = require('./gcpRepository');
const { detectGcpCsvFormat, parseGcpInterchange, MAX_SOURCE_BYTES } = require('./gcpImport');
const { latestScan, recordScan } = require('./gcpScanLedger');

async function autoImportGcpSources({ processing, storage }, datasetId, createdBy = null, limits = {}) {
  const dataset = processing.getDataset(datasetId, true);
  if (!dataset || dataset.status !== 'finalized' || dataset.storageMode !== 'managed' || dataset.rootKey !== 'datasets')
    return { imported: [], ignored: 0 };

  const gcp = new GcpRepository(processing.database);
  const imported = [];
  let ignored = 0, failed = 0, scanned = 0, scannedBytes = 0, limited = false;
  for (const file of dataset.files || []) {
    if (path.posix.extname(file.relativePath).toLowerCase() !== '.csv') continue;
    if (limits.pendingOnly) {
      const latest=latestScan(processing.database,datasetId,file.id,file.sha256);
      if (latest?.outcome==='ignored') continue;
      if (latest?.outcome==='imported' && processing.database.prepare('SELECT 1 FROM gcp_sets WHERE id=? AND dataset_id=? AND source_file_id=? AND source_sha256=?').get(latest.gcp_set_id,datasetId,file.id,file.sha256)) continue;
    }
    // Oversized files are rejected by size alone after stat; they do not consume
    // the content-reading budget, and are never passed to the parser.
    const scanBytes=file.byteSize>MAX_SOURCE_BYTES?0:file.byteSize;
    if (scanned >= (limits.maxFiles ?? Infinity) || scannedBytes + scanBytes > (limits.maxBytes ?? Infinity)) { limited=true; continue; }
    scanned += 1;
    scannedBytes += Number.isSafeInteger(scanBytes) && scanBytes > 0 ? scanBytes : 0;
    try {
    const ignore = (reasonCode) => {
      processing.transaction(() => recordScan(processing.database, {
        datasetId, fileId:file.id, sha256:file.sha256, outcome:'ignored', reasonCode, actor:createdBy,
      }));
      ignored += 1;
    };
    if (!Number.isSafeInteger(file.byteSize) || file.byteSize < 0)
      throw Object.assign(new Error('GCP source size is invalid'), {code:'gcp_source_snapshot_mismatch'});

    const absolutePath = storage.resolve(dataset.rootKey, path.posix.join(dataset.relativePath, file.relativePath), { mustExist: true });
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size !== file.byteSize) throw Object.assign(new Error('GCP source file changed during automatic import'), { code: 'gcp_source_snapshot_mismatch' });
    if (file.byteSize > MAX_SOURCE_BYTES) {
      ignore('too_large');
      continue;
    }
    if (file.byteSize === 0) {
      const hash = crypto.createHash('sha256');
      let bytesRead = 0;
      for await (const chunk of fs.createReadStream(absolutePath)) { hash.update(chunk); bytesRead += chunk.length; }
      if (bytesRead !== file.byteSize || hash.digest('hex') !== file.sha256)
        throw Object.assign(new Error('GCP source file changed during automatic import'), {code:'gcp_source_snapshot_mismatch'});
      ignore('empty');
      continue;
    }
    const bytes = fs.readFileSync(absolutePath);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw Object.assign(new Error('GCP source file changed during automatic import'), { code: 'gcp_source_snapshot_mismatch' });
    }
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { ignore('not_utf8'); continue; }
    const format = detectGcpCsvFormat(content);
    if (!format) { ignore('unrecognized_format'); continue; }

    let parsed;
    try { parsed = parseGcpInterchange({ format, content }); }
    catch (error) {
      if (['invalid_gcp_input', 'unsupported_gcp_format', 'gcp_input_too_large'].includes(error?.code)) {
        ignore('invalid_rows');
        continue;
      }
      throw error;
    }

    const filename = path.posix.basename(file.relativePath);
    const displayName = filename.replace(/\.csv$/i, '').slice(0, 160) || 'GCP points';
    const previous = processing.database.prepare('SELECT id FROM gcp_sets WHERE dataset_id=? AND source_file_id=? AND source_sha256=? ORDER BY created_at,id LIMIT 1')
      .get(datasetId, file.id, parsed.sourceSha256);
    const set = gcp.importSet({
      datasetId,
      displayName,
      sourceFormat: format,
      sourceFileId: file.id,
      sourceFilename: path.posix.basename(file.relativePath),
      sourceSha256: parsed.sourceSha256,
      sourceContent: content,
      crs: parsed.crs,
      elevationUnits: parsed.elevationUnits,
      provenance: parsed.provenance,
      points: parsed.points,
      createdBy,
      onImported: (result) => recordScan(processing.database, {
        datasetId, fileId: file.id, sha256: file.sha256, outcome: 'imported',
        setId: result.id, pointCount: result.pointCount, actor: createdBy,
      }),
    });
    if (!previous) processing.insertAudit({ actorType: createdBy ? 'admin' : 'system', actorId: createdBy,
      action: 'gcp.set_auto_imported', entityType: 'gcp_set', entityId: set.id,
      details: { datasetId, sourceFileId: file.id, sourceFormat: format, pointCount: set.pointCount } });
    imported.push(set);
    } catch (error) {
      failed += 1;
      // A failed ledger write leaves the source unscanned and therefore gated.
      // Do not prevent the already-finalized dataset from completing its upload.
      try {
        processing.transaction(() => recordScan(processing.database, {
          datasetId, fileId:file.id, sha256:file.sha256, outcome:'failed',
          reasonCode:error.code === 'gcp_source_snapshot_mismatch' ? 'snapshot_mismatch' : 'scan_failed', actor:createdBy,
        }));
      } catch {}
    }
  }
  return { imported, ignored, failed, scanned, limited };
}

module.exports = { autoImportGcpSources };
