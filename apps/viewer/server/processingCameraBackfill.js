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
  if (!existing && linkedNow > 0) return { ...result, status: 'conflicting_photo_links' };
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

// Repair for processed models ingested before ingest registered camera
// positions. The worker runs it in its maintenance pass, a few models per pass.
// It walks every ready processed model version without a shots asset once, in
// attempt-id order, and records its progress, the versions it registered and
// the ones it skipped in app_state. It only adds rows (an unpublished shots
// asset and photo links); a model with a conflict or an unusable file is
// skipped and logged, and an error in one model does not stop the others.
const REPAIR_STATE_KEY = 'processing_camera_repair_v1';

function repairState(database) {
  const empty = { cursor: '', done: false, repaired: [], skipped: [] };
  const row = database.prepare('SELECT value FROM app_state WHERE key=?').get(REPAIR_STATE_KEY);
  if (!row) return empty;
  try {
    const value = JSON.parse(row.value);
    return {
      cursor: typeof value.cursor === 'string' ? value.cursor : '',
      done: value.done === true,
      repaired: Array.isArray(value.repaired) ? value.repaired : [],
      skipped: Array.isArray(value.skipped) ? value.skipped : [],
    };
  } catch { return empty; }
}

function saveRepairState(database, state) {
  database.prepare('INSERT INTO app_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run(REPAIR_STATE_KEY, JSON.stringify(state), new Date().toISOString());
}

function repairCandidates(database, cursor, limit) {
  return database.prepare(`SELECT a.id FROM processing_attempts a
    JOIN model_versions v ON v.id=a.result_model_version_id
    JOIN models m ON m.id=v.model_id
    WHERE m.provider='ltds-processing' AND v.status='ready' AND a.status IN ('ready_for_review','published') AND a.id>?
      AND NOT EXISTS (SELECT 1 FROM model_assets x WHERE x.version_id=v.id AND x.kind='shots')
    ORDER BY a.id LIMIT ?`).all(cursor, limit).map((row) => row.id);
}

const errorCode = (error) => String(error?.code || error?.name || 'error').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);

async function reconcileMissingCameraPositions({ database, processing, repository, storage, limit = 10, log = console }) {
  const state = repairState(database);
  if (state.done) return null;
  const batch = Math.max(1, Math.min(Number(limit) || 10, 20));
  const ids = repairCandidates(database, state.cursor, batch + 1);
  const summary = { scanned: 0, registered: 0, skipped: 0, done: false };
  for (const id of ids.slice(0, batch)) {
    let result;
    try { result = await backfillAttempt(id, { database, processing, repository, storage, apply: true }); }
    catch (error) { result = { attemptId: id, status: `error:${errorCode(error)}` }; }
    summary.scanned += 1;
    if (result.status === 'registered') {
      summary.registered += 1;
      state.repaired.push({ attemptId: id, versionId: result.modelVersionId });
      log.log(`Camera positions repair: attempt=${id} registered cameras=${result.cameraCount} photos=${result.photosLinked}`);
    } else {
      summary.skipped += 1;
      state.skipped.push({ attemptId: id, status: result.status });
      log.log(`Camera positions repair: attempt=${id} skipped status=${result.status}`);
    }
    state.cursor = id;
  }
  state.done = ids.length <= batch;
  summary.done = state.done;
  saveRepairState(database, state);
  return summary;
}

function repairUndoStatements(database) {
  return repairState(database).repaired.flatMap(({ versionId }) => module.exports.undoStatements(versionId));
}

module.exports = { backfillProcessingCameraPositions, sourcePrefix, reconcileMissingCameraPositions, repairUndoStatements, REPAIR_STATE_KEY };
// Exported for the CLI's undo guidance.
module.exports.undoStatements = (versionId) => [
  `DELETE FROM model_camera_photos WHERE version_id='${String(versionId).replace(/'/g, "''")}';`,
  `DELETE FROM model_assets WHERE version_id='${String(versionId).replace(/'/g, "''")}' AND kind='shots';`,
];
