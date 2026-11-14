'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { GcpSourceOriginals, MAX_GCP_SOURCE_BYTES } = require('./gcpSourceOriginals');

const failure = (code) => Object.assign(new Error(code), { code });
const stamp = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink, s.uid, s.gid].join(':');

function readIndexedOriginal(storage, rootKey, treePath, file) {
  if (!Number.isSafeInteger(Number(file.byte_size)) || Number(file.byte_size) < 0 || Number(file.byte_size) > MAX_GCP_SOURCE_BYTES)
    throw failure('gcp_original_size_invalid');
  const absolute = storage.resolve(rootKey, `${treePath}/${file.relative_path}`);
  const before = fs.lstatSync(absolute, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || fs.realpathSync.native(absolute) !== absolute)
    throw failure('gcp_original_source_changed');
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before) || before.size !== BigInt(file.byte_size))
      throw failure('gcp_original_source_changed');
    const bytes = Buffer.alloc(Number(before.size));
    let at = 0;
    while (at < bytes.length) {
      const read = fs.readSync(fd, bytes, at, bytes.length - at, at);
      if (!read) throw failure('gcp_original_source_changed');
      at += read;
    }
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before) ||
        stamp(fs.lstatSync(absolute, { bigint: true })) !== stamp(before) ||
        crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw failure('gcp_original_source_changed');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function retainDatasetGcpOriginals(processing, storage, mutation) {
  if (mutation.entityType !== 'dataset' || !['trash', 'purge'].includes(mutation.type)) return [];
  const database = processing.database;
  const dataset = database.prepare('SELECT * FROM datasets WHERE id=?').get(mutation.entityId);
  if (!dataset) throw failure('dataset_not_found');
  const files = database.prepare(`SELECT files.id,files.relative_path,files.sha256,files.byte_size FROM dataset_files files
    WHERE files.dataset_id=? AND (lower(files.relative_path) LIKE '%.csv' OR files.processing_role='gcp_source'
      OR files.id IN (SELECT source_file_id FROM gcp_sets WHERE dataset_id=? AND source_file_id IS NOT NULL))
    ORDER BY files.relative_path,files.id`).all(dataset.id, dataset.id);
  const originals = new GcpSourceOriginals(database), saved = [];
  for (const file of files) {
    // An earlier upload/trash/lost-response attempt may already have saved the
    // exact indexed bytes. It remains independent of the set and filesystem.
    const existing = database.prepare(`SELECT id FROM viewer_gcp_source_originals
      WHERE dataset_id=? AND sha256=? AND byte_size=? AND fidelity='original_bytes' ORDER BY retained_at,id LIMIT 1`)
      .get(dataset.id, file.sha256, file.byte_size);
    const retained = existing ? originals.get(existing.id, dataset.id) : null;
    const bytes = retained ? retained.bytes : readIndexedOriginal(storage, mutation.sourceRootKey, mutation.sourceRelativePath, file);
    saved.push(originals.retain({ datasetId: dataset.id, projectId: dataset.project_id,
      sourceFileId: file.id, fileName: path.posix.basename(file.relative_path), bytes,
      fidelity: 'original_bytes', actorId: mutation.actor || null }));
  }
  return saved;
}

module.exports = { readIndexedOriginal, retainDatasetGcpOriginals };
