'use strict';

// Registers camera positions (ODM odm_report/shots.geojson) and their photo
// links for processing attempts that were ingested before the processing
// ingest registered them. Dry run by default; idempotent when applied.

const fs = require('node:fs');
const { processingCameraPhotoLinks, readShotsDocument } = require('./cameraPhotos');
const { hashFileChunks } = require('./storageManager');

const SOURCE_ANCHORS = [
  /^(.+)\/odm_report\/(?:report|odm_report)\.pdf$/,
  /^(.+)\/odm_orthophoto\/odm_orthophoto\.tif$/,
  /^(.+)\/odm_georeferencing\/odm_georeferenced_model\.(?:laz|ply)$/,
  /^(.+)\/entwine_pointcloud\/ept\.json$/,
];

function sourcePrefix(assets) {
  for (const anchor of SOURCE_ANCHORS) {
    for (const asset of assets) {
      if (asset.root_key !== 'models') continue;
      const match = anchor.exec(asset.relative_path);
      if (match) return match[1];
    }
  }
  return null;
}

async function backfillAttempt(id, { database, processing, repository, storage, apply }) {
  const result = { attemptId: id };
  const attempt = processing.getAttempt(id);
  if (!attempt) return { ...result, status: 'attempt_not_found' };
  if (!attempt.resultModelId || !attempt.resultModelVersionId) return { ...result, status: 'attempt_has_no_result' };
  result.modelVersionId = attempt.resultModelVersionId;
  result.attemptStatus = attempt.status;
  const model = database.prepare('SELECT provider FROM models WHERE id=?').get(attempt.resultModelId);
  if (model?.provider !== 'ltds-processing') return { ...result, status: 'not_a_processing_model' };
  const assets = database.prepare('SELECT kind,root_key,relative_path,byte_size,sha256,published FROM model_assets WHERE version_id=?').all(attempt.resultModelVersionId);
  const prefix = sourcePrefix(assets);
  if (!prefix) return { ...result, status: 'output_location_unknown' };
  const relativePath = `${prefix}/odm_report/shots.geojson`;
  result.shotsRelativePath = relativePath;
  let absolute;
  try { absolute = storage.resolve('models', relativePath, { mustExist: true }); }
  catch { return { ...result, status: 'shots_file_missing' }; }
  const document = readShotsDocument(absolute);
  if (!document) return { ...result, status: 'shots_file_invalid' };
  result.cameraCount = document.features.length;
  const integrity = await hashFileChunks(absolute);
  const byteSize = fs.statSync(absolute).size;
  result.byteSize = byteSize;
  result.sha256 = integrity.sha256;

  const existing = assets.find((asset) => asset.kind === 'shots');
  if (existing && (existing.root_key !== 'models' || existing.relative_path !== relativePath || existing.sha256 !== integrity.sha256))
    return { ...result, status: 'conflicting_shots_asset' };

  const datasetId = attempt.datasetId || processing.getTask(attempt.taskId)?.datasetId;
  const dataset = datasetId ? processing.getDataset(datasetId, true) : null;
  const links = dataset ? processingCameraPhotoLinks(document, {
    datasetRootKey: dataset.rootKey, datasetRelativePath: dataset.relativePath, files: dataset.files,
  }) : [];
  result.photosMatched = links.length;
  const linkedNow = database.prepare('SELECT COUNT(*) AS count FROM model_camera_photos WHERE version_id=?').get(attempt.resultModelVersionId).count;
  result.photosAlreadyLinked = linkedNow;

  if (existing && (linkedNow > 0 || links.length === 0)) return { ...result, status: 'already_present' };
  if (!apply) return { ...result, status: existing ? 'would_link_photos' : 'would_register' };

  if (!existing) processing.addModelAsset({
    versionId: attempt.resultModelVersionId, kind: 'shots', rootKey: 'models', relativePath, format: 'geojson',
    byteSize, attemptId: attempt.id, sha256: integrity.sha256, chunks: integrity.chunks, published: false,
  });
  const linked = links.length ? repository.replaceCameraPhotos(attempt.resultModelVersionId, links, { onlyIfEmpty: true }) : 0;
  return { ...result, status: existing ? 'photos_linked' : 'registered', photosLinked: linked };
}

async function backfillProcessingCameraPositions({ database, processing, repository, storage, attemptIds, apply = false }) {
  const ids = [...new Set((attemptIds || []).map(String))];
  if (!ids.length) throw new TypeError('at least one attempt id is required');
  const results = [];
  for (const id of ids) results.push(await backfillAttempt(id, { database, processing, repository, storage, apply }));
  return results;
}

module.exports = { backfillProcessingCameraPositions, sourcePrefix };
// Exported for the CLI's undo guidance.
module.exports.undoStatements = (versionId) => [
  `DELETE FROM model_camera_photos WHERE version_id='${String(versionId).replace(/'/g, "''")}';`,
  `DELETE FROM model_assets WHERE version_id='${String(versionId).replace(/'/g, "''")}' AND kind='shots';`,
];
