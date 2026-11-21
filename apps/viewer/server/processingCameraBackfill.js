'use strict';

// Registers camera positions (ODM odm_report/shots.geojson) and their photo
// links for processing attempts that were ingested before the processing
// ingest registered them. The manual script (dry run by default) takes explicit
// attempt ids; the worker's repair walks every model that still lacks them.

const fs = require('node:fs');
const { MAX_SHOTS_BYTES, parseShotsDocument, processingCameraPhotoLinks } = require('./cameraPhotos');
const { normalizeCameraPhotoLinks } = require('./repository');
const { hashFileChunks } = require('./storageManager');

const SOURCE_ANCHORS = [
  /^(.+)\/odm_report\/(?:report|odm_report)\.pdf$/,
  /^(.+)\/odm_orthophoto\/odm_orthophoto\.tif$/,
  /^(.+)\/odm_georeferencing\/odm_georeferenced_model\.(?:laz|ply)$/,
  /^(.+)\/entwine_pointcloud\/ept\.json$/,
];

// Outcomes that may change on a later try: storage or the output folder not
// reachable, a read error, or any thrown error (for example a busy database).
const TRANSIENT_STATUSES = new Set(['output_unreachable', 'shots_read_error']);
const isTransient = (status) => TRANSIENT_STATUSES.has(status) || String(status).startsWith('error:');
const errorCode = (error) => String(error?.code || error?.name || 'error').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);

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

function directoryPresent(storage, relativePath) {
  try { return fs.statSync(storage.resolve('models', relativePath, { mustExist: true })).isDirectory(); }
  catch { return false; }
}

// Reads and checks everything for one attempt without writing. Returns the
// result and, when there is something to write, the plan for writeAttempt.
async function prepareAttempt(id, { database, processing, storage }) {
  const result = { attemptId: id };
  const attempt = processing.getAttempt(id);
  if (!attempt) return { result: { ...result, status: 'attempt_not_found' } };
  if (!attempt.resultModelId || !attempt.resultModelVersionId) return { result: { ...result, status: 'attempt_has_no_result' } };
  result.modelVersionId = attempt.resultModelVersionId;
  result.attemptStatus = attempt.status;
  const model = database.prepare('SELECT provider FROM models WHERE id=?').get(attempt.resultModelId);
  if (model?.provider !== 'ltds-processing') return { result: { ...result, status: 'not_a_processing_model' } };
  const assets = database.prepare('SELECT kind,root_key,relative_path,byte_size,sha256,published FROM model_assets WHERE version_id=?').all(attempt.resultModelVersionId);
  const prefix = sourcePrefix(assets);
  if (!prefix) return { result: { ...result, status: 'output_location_unknown' } };
  const relativePath = `${prefix}/odm_report/shots.geojson`;
  result.shotsRelativePath = relativePath;

  let absolute;
  try { absolute = storage.resolve('models', relativePath, { mustExist: true }); }
  catch (error) {
    if (error?.code === 'invalid_storage_location') return { result: { ...result, status: 'output_location_unknown' } };
    // Missing for good only when the model's output folder is there without it.
    return { result: { ...result, status: directoryPresent(storage, prefix) ? 'shots_file_missing' : 'output_unreachable' } };
  }
  let text;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SHOTS_BYTES) return { result: { ...result, status: 'shots_file_invalid' } };
    text = fs.readFileSync(absolute, 'utf8');
  } catch { return { result: { ...result, status: 'shots_read_error' } }; }
  const document = parseShotsDocument(text);
  if (!document) return { result: { ...result, status: 'shots_file_invalid' } };
  result.cameraCount = document.features.length;
  const integrity = await hashFileChunks(absolute);
  const byteSize = fs.statSync(absolute).size;
  result.byteSize = byteSize;
  result.sha256 = integrity.sha256;

  const existing = assets.find((asset) => asset.kind === 'shots');
  if (existing && (existing.root_key !== 'models' || existing.relative_path !== relativePath || existing.sha256 !== integrity.sha256))
    return { result: { ...result, status: 'conflicting_shots_asset' } };

  const datasetId = attempt.datasetId || processing.getTask(attempt.taskId)?.datasetId;
  const dataset = datasetId ? processing.getDataset(datasetId, true) : null;
  const links = dataset ? processingCameraPhotoLinks(document, {
    datasetRootKey: dataset.rootKey, datasetRelativePath: dataset.relativePath, files: dataset.files,
  }) : [];
  result.photosMatched = links.length;
  const linkedNow = database.prepare('SELECT COUNT(*) AS count FROM model_camera_photos WHERE version_id=?').get(attempt.resultModelVersionId).count;
  result.photosAlreadyLinked = linkedNow;

  if (existing && (linkedNow > 0 || links.length === 0)) return { result: { ...result, status: 'already_present' } };
  if (!existing && linkedNow > 0) return { result: { ...result, status: 'conflicting_photo_links' } };
  return {
    result: { ...result, status: existing ? 'would_link_photos' : 'would_register' },
    plan: {
      attemptId: attempt.id, versionId: attempt.resultModelVersionId, existing: Boolean(existing), relativePath, byteSize, integrity,
      links: normalizeCameraPhotoLinks(links),
    },
  };
}

// Writes the shots asset, its photo links and the caller's record in one
// transaction, after checking again under the write lock that nothing has
// been added meanwhile. It never changes an existing asset or link.
function writeAttempt(plan, { database, processing, repository, record = null }) {
  return repository.transaction(() => {
    const hasShots = Boolean(database.prepare("SELECT 1 FROM model_assets WHERE version_id=? AND kind='shots'").get(plan.versionId));
    const hasLinks = Boolean(database.prepare('SELECT 1 FROM model_camera_photos WHERE version_id=? LIMIT 1').get(plan.versionId));
    if (hasShots !== plan.existing) return { status: plan.existing ? 'conflicting_shots_asset' : 'already_present', photosLinked: 0 };
    if (hasLinks) return { status: plan.existing ? 'already_present' : 'conflicting_photo_links', photosLinked: 0 };
    if (!plan.existing) processing.writeModelAssetRows({
      versionId: plan.versionId, kind: 'shots', rootKey: 'models', relativePath: plan.relativePath, format: 'geojson',
      byteSize: plan.byteSize, attemptId: plan.attemptId, sha256: plan.integrity.sha256, chunks: plan.integrity.chunks, published: false,
    });
    const photosLinked = plan.links.length ? repository.writeCameraPhotos(plan.versionId, plan.links, { onlyIfEmpty: true }) : 0;
    const status = plan.existing ? 'photos_linked' : 'registered';
    record?.(status);
    return { status, photosLinked };
  });
}

async function backfillProcessingCameraPositions({ database, processing, repository, storage, attemptIds, apply = false }) {
  const ids = [...new Set((attemptIds || []).map(String))];
  if (!ids.length) throw new TypeError('at least one attempt id is required');
  const results = [];
  for (const id of ids) {
    const { result, plan } = await prepareAttempt(id, { database, processing, storage });
    if (!plan || !apply) { results.push(result); continue; }
    const written = writeAttempt(plan, { database, processing, repository });
    results.push({ ...result, ...written });
  }
  return results;
}

// Repair for processed models ingested before ingest registered camera
// positions. The worker runs it in its maintenance pass, a few models per pass.
// Each model gets its own app_state row (key prefix below) holding its state:
//   registered  rows were added (written in the same transaction as the rows)
//   skipped     a lasting reason, or a temporary one that kept failing
//   retrying    a temporary failure; tried again on later passes
// A model with a row other than retrying is not selected again. A row that is
// not JSON or has no known state is left as it is: that model is skipped and
// logged on every pass, and the others go on. The repair only adds rows: an
// unpublished shots asset and its photo links.
const REPAIR_KEY_PREFIX = 'processing_camera_repair_v1:';
// A temporary failure counts at most once per TRY_INTERVAL_HOURS, and a model
// is skipped only after MAX_TRANSIENT_TRIES counted tries spanning at least
// MIN_RETRY_SPAN_HOURS, so a restart loop or a busy spell cannot use them up.
const MAX_TRANSIENT_TRIES = 5;
const TRY_INTERVAL_HOURS = 1;
const MIN_RETRY_SPAN_HOURS = 6;

// SQLite: a readable record is JSON with a known state. CASE keeps json_extract
// away from text that is not JSON, and a missing state counts as unreadable.
const READABLE = "CASE WHEN json_valid(%v) THEN COALESCE(json_extract(%v,'$.state') IN ('registered','skipped','retrying'),0) ELSE 0 END";
const readable = (column) => READABLE.replaceAll('%v', column);

function unreadableRepairRecords(database) {
  return database.prepare(`SELECT key FROM app_state WHERE substr(key,1,length(?))=? AND NOT (${readable('value')}) ORDER BY key`)
    .all(REPAIR_KEY_PREFIX, REPAIR_KEY_PREFIX).map((row) => row.key);
}

function repairCandidates(database, limit) {
  return database.prepare(`SELECT a.id FROM processing_attempts a
    JOIN model_versions v ON v.id=a.result_model_version_id
    JOIN models m ON m.id=v.model_id
    LEFT JOIN model_outputs o ON o.id=a.result_model_version_id AND o.attempt_id=a.id
    LEFT JOIN app_state r ON r.key=?||a.id
    WHERE m.provider='ltds-processing' AND v.status='ready' AND a.status IN ('ready_for_review','published')
      AND (o.id IS NULL OR o.status IN ('ready','published'))
      AND NOT EXISTS (SELECT 1 FROM model_assets x WHERE x.version_id=v.id AND x.kind='shots')
      AND (r.key IS NULL OR CASE WHEN ${readable('r.value')} THEN json_extract(r.value,'$.state')='retrying' ELSE 0 END)
    ORDER BY CASE WHEN r.key IS NULL THEN 0 WHEN json_valid(r.value) THEN COALESCE(json_extract(r.value,'$.tries'),0) ELSE 0 END, a.id LIMIT ?`)
    .all(REPAIR_KEY_PREFIX, limit).map((row) => row.id);
}

function storageReachable(storage) {
  for (const key of ['models', 'datasets']) {
    try { if (!fs.readdirSync(storage.roots[key]).length) return false; } catch { return false; }
  }
  return true;
}

function recordRegistered(database, attemptId, versionId, at) {
  const value = JSON.stringify({ state: 'registered', versionId, at });
  database.prepare('INSERT INTO app_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run(REPAIR_KEY_PREFIX + attemptId, value, at);
}

// A lasting skip replaces only a retrying record: never a registered one
// (another worker may have registered the model meanwhile) or an unreadable one.
function recordSkipped(database, attemptId, status, at) {
  const value = JSON.stringify({ state: 'skipped', status, at });
  database.prepare(`INSERT INTO app_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE CASE WHEN ${readable('app_state.value')} THEN json_extract(app_state.value,'$.state')='retrying' ELSE 0 END`).run(REPAIR_KEY_PREFIX + attemptId, value, at);
}

// Records a temporary failure in one statement, so concurrent workers cannot
// lose a count. A try is counted only when the last counted one is at least
// TRY_INTERVAL_HOURS old; the model is skipped once it has MAX_TRANSIENT_TRIES
// counted tries spanning MIN_RETRY_SPAN_HOURS.
function recordTransient(database, attemptId, status, at) {
  const key = REPAIR_KEY_PREFIX + attemptId;
  database.prepare(`INSERT INTO app_state(key,value,updated_at)
      VALUES ($key,json_object('state','retrying','status',$status,'tries',1,'firstTryAt',$at,'lastTryAt',$at),$at)
    ON CONFLICT(key) DO UPDATE SET value=CASE
      WHEN unixepoch($at)-COALESCE(unixepoch(json_extract(app_state.value,'$.lastTryAt')),0) >= $interval*3600
      THEN json_set(app_state.value,
        '$.tries',COALESCE(json_extract(app_state.value,'$.tries'),0)+1,
        '$.lastTryAt',$at,
        '$.firstTryAt',COALESCE(json_extract(app_state.value,'$.firstTryAt'),$at),
        '$.status',$status,
        '$.state',CASE WHEN COALESCE(json_extract(app_state.value,'$.tries'),0)+1 >= $max
          AND unixepoch($at)-COALESCE(unixepoch(json_extract(app_state.value,'$.firstTryAt')),unixepoch($at)) >= $span*3600
          THEN 'skipped' ELSE 'retrying' END)
      ELSE json_set(app_state.value,'$.status',$status) END,
      updated_at=$at
    WHERE CASE WHEN ${readable('app_state.value')} THEN json_extract(app_state.value,'$.state')='retrying' ELSE 0 END`)
    .run({ key, status, at, interval: TRY_INTERVAL_HOURS, max: MAX_TRANSIENT_TRIES, span: MIN_RETRY_SPAN_HOURS });
  return JSON.parse(database.prepare('SELECT value FROM app_state WHERE key=?').get(key).value);
}

async function reconcileMissingCameraPositions({ database, processing, repository, storage, limit = 10, log = console, now = () => new Date() }) {
  const summary = { scanned: 0, registered: 0, skipped: 0, retrying: 0, unreadable: 0 };
  if (!storageReachable(storage)) return { ...summary, stopped: 'storage_unreachable' };
  for (const key of unreadableRepairRecords(database)) {
    summary.unreadable += 1;
    log.log(`Camera positions repair: attempt=${key.slice(REPAIR_KEY_PREFIX.length)} skipped this pass, unreadable repair record`);
  }
  const batch = Math.max(1, Math.min(Number(limit) || 10, 20));
  for (const id of repairCandidates(database, batch)) {
    summary.scanned += 1;
    const at = now().toISOString();
    let result;
    try {
      const prepared = await prepareAttempt(id, { database, processing, storage });
      result = prepared.result;
      if (prepared.plan) {
        const written = writeAttempt(prepared.plan, {
          database, processing, repository,
          record: (status) => { if (status === 'registered') recordRegistered(database, id, prepared.plan.versionId, at); },
        });
        result = { ...result, ...written };
      }
    } catch (error) { result = { attemptId: id, status: `error:${errorCode(error)}` }; }

    if (result.status === 'registered') {
      summary.registered += 1;
      log.log(`Camera positions repair: attempt=${id} registered cameras=${result.cameraCount} photos=${result.photosLinked}`);
    } else if (result.status === 'already_present') {
      log.log(`Camera positions repair: attempt=${id} already present`);
    } else if (isTransient(result.status)) {
      let record = null;
      try { record = recordTransient(database, id, result.status, at); } catch { /* the next pass tries again */ }
      if (record?.state === 'skipped') {
        summary.skipped += 1;
        log.log(`Camera positions repair: attempt=${id} skipped status=${result.status} after ${record.tries} tries`);
      } else {
        summary.retrying += 1;
        log.log(`Camera positions repair: attempt=${id} will retry status=${result.status} tries=${record?.tries ?? '?'}`);
      }
    } else {
      summary.skipped += 1;
      try { recordSkipped(database, id, result.status, at); } catch { /* the next pass tries again */ }
      log.log(`Camera positions repair: attempt=${id} skipped status=${result.status}`);
    }
  }
  return summary;
}

// Undo for one version. The chunk and file rows of the shots asset are
// deleted explicitly, so the statements do not depend on foreign keys being on
// (PRAGMA foreign_keys has no effect inside a transaction).
const undoStatements = (versionId) => {
  const id = `'${String(versionId).replace(/'/g, "''")}'`;
  const shotsAsset = `(SELECT id FROM model_assets WHERE version_id=${id} AND kind='shots')`;
  return [
    `DELETE FROM model_camera_photos WHERE version_id=${id};`,
    `DELETE FROM model_asset_chunks WHERE asset_id IN ${shotsAsset};`,
    `DELETE FROM model_asset_files WHERE asset_id IN ${shotsAsset};`,
    `DELETE FROM model_assets WHERE version_id=${id} AND kind='shots';`,
  ];
};

// Undo for everything the repair registered.
function repairUndoStatements(database) {
  return database.prepare(`SELECT json_extract(value,'$.versionId') AS versionId FROM app_state
    WHERE substr(key,1,length(?))=? AND CASE WHEN ${readable('value')} THEN json_extract(value,'$.state')='registered' ELSE 0 END ORDER BY key`)
    .all(REPAIR_KEY_PREFIX, REPAIR_KEY_PREFIX).map((row) => row.versionId).filter(Boolean).flatMap(undoStatements);
}

module.exports = {
  backfillProcessingCameraPositions, reconcileMissingCameraPositions, repairUndoStatements, sourcePrefix, undoStatements,
  MAX_TRANSIENT_TRIES, MIN_RETRY_SPAN_HOURS, REPAIR_KEY_PREFIX, TRY_INTERVAL_HOURS,
};
