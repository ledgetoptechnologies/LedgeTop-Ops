'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { GcpRepository } = require('./gcpRepository');
const { parseGcpInterchange, MAX_SOURCE_BYTES } = require('./gcpImport');

// Inspect only finalized, indexed source files. Unsupported or ambiguous CSVs
// stay in the dataset and are not interpreted as ground control.
function discoverDatasetGcp({ processing, storage, datasetId, actorId }) {
  const dataset = processing.getDataset(datasetId, true);
  if (!dataset || dataset.status !== 'finalized') return [];
  const repo = new GcpRepository(processing.database), found = [];
  for (const file of dataset.files) {
    if (!/\.csv$/i.test(file.relativePath) || file.byteSize > MAX_SOURCE_BYTES) continue;
    const previous = repo.listSets(dataset.id).find(set => set.sourceFileId === file.id && set.sourceSha256 === file.sha256);
    if (previous) { found.push(previous); continue; }
    const absolute = storage.resolve(dataset.rootKey, path.posix.join(dataset.relativePath, file.relativePath), { mustExist: true });
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.byteSize) throw Object.assign(new Error('dataset CSV changed'), { code: 'dataset_source_changed' });
    const bytes = fs.readFileSync(absolute);
    if (bytes.length !== file.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw Object.assign(new Error('dataset CSV changed'), { code: 'dataset_source_changed' });
    let content, parsed;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); parsed = parseGcpInterchange({ format: 'emlid-all-columns-v1', content }); }
    catch (error) {
      if (error instanceof TypeError || ['invalid_gcp_input', 'gcp_input_too_large'].includes(error?.code)) continue;
      throw error;
    }
    found.push(repo.importSet({ datasetId: dataset.id, displayName: path.posix.basename(file.relativePath).slice(0, 160),
      sourceFormat: 'emlid-all-columns-v1', sourceFileId: file.id, sourceFilename: path.posix.basename(file.relativePath),
      sourceSha256: parsed.sourceSha256, sourceContent: content, crs: parsed.crs, elevationUnits: parsed.elevationUnits,
      provenance: parsed.provenance, points: parsed.points, createdBy: actorId }));
  }
  return found;
}
module.exports = { discoverDatasetGcp };
