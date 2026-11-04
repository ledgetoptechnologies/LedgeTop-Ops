'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { GcpRepository } = require('./gcpRepository');
const { detectGcpCsvFormat, parseGcpInterchange, MAX_SOURCE_BYTES } = require('./gcpImport');

async function autoImportGcpSources({ processing, storage }, datasetId, createdBy = null) {
  const dataset = processing.getDataset(datasetId, true);
  if (!dataset || dataset.status !== 'finalized' || dataset.storageMode !== 'managed' || dataset.rootKey !== 'datasets')
    return { imported: [], ignored: 0 };

  const gcp = new GcpRepository(processing.database);
  const imported = [];
  let ignored = 0;
  for (const file of dataset.files || []) {
    if (file.processingRole !== 'gcp_source' || path.posix.extname(file.relativePath).toLowerCase() !== '.csv') continue;
    if (!Number.isSafeInteger(file.byteSize) || file.byteSize < 1 || file.byteSize > MAX_SOURCE_BYTES) {
      ignored += 1;
      continue;
    }

    const absolutePath = storage.resolve(dataset.rootKey, path.posix.join(dataset.relativePath, file.relativePath), { mustExist: true });
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size !== file.byteSize) throw Object.assign(new Error('GCP source file changed during automatic import'), { code: 'gcp_source_snapshot_mismatch' });
    const bytes = fs.readFileSync(absolutePath);
    if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)
        || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw Object.assign(new Error('GCP source file changed during automatic import'), { code: 'gcp_source_snapshot_mismatch' });
    }
    const content = bytes.toString('utf8');
    const format = detectGcpCsvFormat(content);
    if (!format) { ignored += 1; continue; }

    let parsed;
    try { parsed = parseGcpInterchange({ format, content }); }
    catch (error) {
      if (['invalid_gcp_input', 'unsupported_gcp_format', 'gcp_input_too_large'].includes(error?.code)) {
        ignored += 1;
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
    });
    if (!previous) processing.insertAudit({ actorType: createdBy ? 'admin' : 'system', actorId: createdBy,
      action: 'gcp.set_auto_imported', entityType: 'gcp_set', entityId: set.id,
      details: { datasetId, sourceFileId: file.id, sourceFormat: format, pointCount: set.pointCount } });
    imported.push(set);
  }
  return { imported, ignored };
}

module.exports = { autoImportGcpSources };
