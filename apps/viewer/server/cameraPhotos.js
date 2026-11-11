'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_SHOTS_BYTES = 32 * 1024 * 1024;
const MAX_CAMERA_FEATURES = 50_000;
const MAX_CAMERA_PHOTO_ROWS = 50_000;
const CAMERA_RETRY_DELAY_MS = 60 * 60 * 1000;

function cameraPhotoContentType(filename) {
  return /\.jpe?g$/i.test(String(filename || '')) ? 'image/jpeg' : null;
}

function validCameraFilename(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 1024) return null;
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return null;
  const segments = value.split('/');
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return cameraPhotoContentType(value) ? value : null;
}

function cameraPhotoLinksFromDocument(document, files) {
  if (!document || document.type !== 'FeatureCollection' || !Array.isArray(document.features)
    || document.features.length > MAX_CAMERA_FEATURES) return [];

  const photosByKey = new Map();
  const photosByBasename = new Map();
  let photoRows = 0;
  for (const file of files || []) {
    const filename = validCameraFilename(file.relativePath);
    if (!filename) continue;
    photoRows += 1;
    if (photoRows > MAX_CAMERA_PHOTO_ROWS) return [];
    const sha256 = String(file.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0) continue;
    const normalizedFile = { ...file, sha256 };
    if (!photosByKey.has(filename)) photosByKey.set(filename, normalizedFile);
    else photosByKey.set(filename, null);

    const basename = path.posix.basename(filename).toLowerCase();
    if (!photosByBasename.has(basename)) photosByBasename.set(basename, normalizedFile);
    else photosByBasename.set(basename, null);
  }

  const links = [];
  const seen = new Set();
  for (const feature of document.features) {
    const filename = validCameraFilename(feature?.properties?.filename);
    if (!filename || seen.has(filename)) continue;
    seen.add(filename);
    const file = photosByKey.has(filename)
      ? photosByKey.get(filename)
      : photosByBasename.get(path.posix.basename(filename).toLowerCase());
    if (!file) continue;
    links.push({
      filename,
      relativePath: file.relativePath,
      byteSize: file.byteSize,
      sha256: file.sha256,
      contentType: cameraPhotoContentType(filename),
    });
  }
  return links;
}

// WebODM archives often store the same normalized path in both the file
// inventory and shots.geojson. NodeODM may write just the photo basename while
// the retained dataset keeps it in a folder. Fall back only when that basename
// maps to exactly one indexed JPEG; ambiguous names remain unlinked.
function discoverCameraPhotoLinks(root, discovered) {
  const shots = discovered?.assets?.find((asset) => asset.kind === 'shots');
  if (!shots || !Number.isSafeInteger(shots.byteSize) || shots.byteSize > MAX_SHOTS_BYTES) return [];
  let document;
  try {
    const absolute = path.resolve(root, ...String(shots.relativePath).split('/'));
    const resolvedRoot = path.resolve(root);
    if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) return [];
    document = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return [];
  }
  return cameraPhotoLinksFromDocument(document, discovered.files);
}

function reconcileImportedCameraPhotoLinks({ repository, processing, storage, limit = 25, now = () => Date.now() }) {
  const summary = { versionsScanned: 0, versionsReconciled: 0, photosLinked: 0, versionsFailed: 0 };
  if (!repository?.database || !processing?.database || !storage || repository.database !== processing.database) return summary;
  const database = repository.database;
  const nowMs = Number(now());
  const currentIso = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
  const batchLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const candidates = database.prepare(`
    SELECT versions.id AS version_id,
      models.provider AS model_provider,
      outputs.root_key AS output_root_key,
      shots_index.asset_count AS shots_asset_count,
      shots.root_key AS shots_root_key,
      shots.relative_path AS shots_relative_path,
      shots.byte_size AS shots_byte_size,
      shots.sha256 AS shots_sha256,
      outputs.relative_path AS output_relative_path,
      attempts.id AS attempt_id,
      COALESCE(attempts.dataset_id,tasks.dataset_id) AS dataset_id,
      datasets.root_key AS dataset_root_key,
      datasets.relative_path AS dataset_relative_path
    FROM model_versions versions
    JOIN models ON models.id=versions.model_id AND models.provider IN ('webodm','ltds-processing')
    LEFT JOIN (
      SELECT version_id,MIN(id) AS id,COUNT(*) AS asset_count
      FROM model_assets WHERE kind='shots' GROUP BY version_id
    ) shots_index ON shots_index.version_id=versions.id
    LEFT JOIN model_assets shots ON shots.id=shots_index.id
    JOIN model_outputs outputs ON outputs.id=versions.id AND outputs.status<>'trashed'
    JOIN processing_attempts attempts ON attempts.result_model_version_id=versions.id
    JOIN processing_tasks tasks ON tasks.id=attempts.task_id
    JOIN datasets ON datasets.id=COALESCE(attempts.dataset_id,tasks.dataset_id) AND datasets.root_key='datasets'
      AND datasets.status IN ('finalized','archived')
    LEFT JOIN camera_photo_reconciliation_state state ON state.version_id=versions.id
    WHERE NOT EXISTS (SELECT 1 FROM model_camera_photos photos WHERE photos.version_id=versions.id)
      AND (state.version_id IS NULL OR (state.status='retry' AND state.next_attempt_at<=?)
        OR (state.status='terminal' AND state.reason='no_matching_indexed_photos'))
    ORDER BY versions.created_at,versions.id
    LIMIT ?
  `).all(currentIso, batchLimit);
  const terminal = database.prepare(`
    INSERT INTO camera_photo_reconciliation_state(version_id,status,reason,attempt_count,next_attempt_at,updated_at)
    VALUES (?,'terminal',?,1,NULL,?)
    ON CONFLICT(version_id) DO UPDATE SET status='terminal',reason=excluded.reason,next_attempt_at=NULL,updated_at=excluded.updated_at
  `);
  const retry = database.prepare(`
    INSERT INTO camera_photo_reconciliation_state(version_id,status,reason,attempt_count,next_attempt_at,updated_at)
    VALUES (?,'retry',?,1,?,?)
    ON CONFLICT(version_id) DO UPDATE SET status='retry',reason=excluded.reason,
      attempt_count=MIN(camera_photo_reconciliation_state.attempt_count+1,1000000),next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at
  `);
  const clearState = database.prepare('DELETE FROM camera_photo_reconciliation_state WHERE version_id=?');
  const jpegRows = database.prepare(`
    SELECT relative_path,byte_size,sha256
    FROM dataset_files
    WHERE dataset_id=? AND (LOWER(relative_path) LIKE '%.jpg' OR LOWER(relative_path) LIKE '%.jpeg')
    ORDER BY relative_path
    LIMIT ?
  `);
  const markTerminal = (versionId, reason) => terminal.run(versionId, reason, currentIso);

  for (const candidate of candidates) {
    summary.versionsScanned += 1;
    try {
      if (Number(candidate.shots_asset_count || 0) > 1) {
        markTerminal(candidate.version_id, 'duplicate_shots_assets');
        continue;
      }
      let shotsRootKey = candidate.shots_root_key;
      let shotsRelativePath = candidate.shots_relative_path;
      let registerNodeOdmShots = false;
      if (candidate.model_provider === 'webodm') {
        const prefix = `${candidate.dataset_relative_path}/`;
        if (candidate.output_root_key !== 'datasets' || candidate.output_relative_path !== candidate.dataset_relative_path
          || shotsRootKey !== 'datasets' || !shotsRelativePath?.startsWith(prefix)) {
          markTerminal(candidate.version_id, 'invalid_source_relationship');
          continue;
        }
      } else {
        const expectedShotsPath = path.posix.join(candidate.output_relative_path, 'odm_report/shots.geojson');
        if (candidate.output_root_key !== 'models' || candidate.dataset_root_key !== 'datasets') {
          markTerminal(candidate.version_id, 'invalid_source_relationship');
          continue;
        }
        if (!shotsRootKey && !shotsRelativePath) {
          shotsRootKey = 'models';
          shotsRelativePath = expectedShotsPath;
          registerNodeOdmShots = true;
        } else if (shotsRootKey !== 'models' || shotsRelativePath !== expectedShotsPath) {
          markTerminal(candidate.version_id, 'invalid_source_relationship');
          continue;
        }
      }
      const absoluteShots = storage.resolve(shotsRootKey, shotsRelativePath, { mustExist: true });
      const stat = fs.statSync(absoluteShots);
      if (!stat.isFile() || stat.size > MAX_SHOTS_BYTES
        || (!registerNodeOdmShots && (stat.size !== candidate.shots_byte_size
          || typeof candidate.shots_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.shots_sha256)))) {
        markTerminal(candidate.version_id, 'invalid_shots_metadata');
        continue;
      }
      const shotsBody = fs.readFileSync(absoluteShots);
      const shotsSha256 = crypto.createHash('sha256').update(shotsBody).digest('hex');
      if (!registerNodeOdmShots && shotsSha256 !== candidate.shots_sha256) {
        markTerminal(candidate.version_id, 'shots_integrity_mismatch');
        continue;
      }
      let document;
      try { document = JSON.parse(shotsBody.toString('utf8')); }
      catch {
        markTerminal(candidate.version_id, 'invalid_shots_json');
        continue;
      }
      if (!document || document.type !== 'FeatureCollection' || !Array.isArray(document.features)) {
        markTerminal(candidate.version_id, 'invalid_shots_document');
        continue;
      }
      if (document.features.length > MAX_CAMERA_FEATURES) {
        markTerminal(candidate.version_id, 'camera_feature_limit');
        continue;
      }
      if (registerNodeOdmShots) {
        repository.transaction(() => {
          const existing = database.prepare("SELECT root_key,relative_path,content_type,byte_size,sha256 FROM model_assets WHERE version_id=? AND kind='shots'").get(candidate.version_id);
          if (existing) {
            if (existing.root_key !== 'models' || existing.relative_path !== shotsRelativePath
              || existing.content_type !== 'application/geo+json' || existing.byte_size !== shotsBody.length || existing.sha256 !== shotsSha256) {
              throw Object.assign(new Error('registered shots asset changed during reconciliation'), { code: 'shots_asset_conflict' });
            }
            return;
          }
          const published = Number(database.prepare('SELECT COALESCE(MAX(published),0) AS published FROM model_assets WHERE version_id=?').get(candidate.version_id)?.published) || 0;
          database.prepare(`INSERT INTO model_assets(
            id,version_id,kind,root_key,relative_path,format,content_type,byte_size,storage_mode,published,source_attempt_id,sha256,manifest_sha256,created_at
          ) VALUES (?,?,?,?,?,'geojson','application/geo+json',?,'managed',?,?,?,NULL,?)`).run(
            crypto.randomUUID(), candidate.version_id, 'shots', 'models', shotsRelativePath, shotsBody.length,
            published, candidate.attempt_id, shotsSha256, currentIso,
          );
        });
      }
      if (!document.features.some((feature) => validCameraFilename(feature?.properties?.filename))) {
        markTerminal(candidate.version_id, 'no_camera_photo_references');
        continue;
      }
      const files = jpegRows.all(candidate.dataset_id, MAX_CAMERA_PHOTO_ROWS + 1);
      if (files.length > MAX_CAMERA_PHOTO_ROWS) {
        markTerminal(candidate.version_id, 'jpeg_inventory_limit');
        continue;
      }
      const photos = cameraPhotoLinksFromDocument(document, files.map((file) => ({
        relativePath: file.relative_path,
        byteSize: Number(file.byte_size),
        sha256: file.sha256,
      }))).map((photo) => ({
        ...photo,
        rootKey: 'datasets',
        relativePath: path.posix.join(candidate.dataset_relative_path, photo.relativePath),
      }));
      if (!photos.length) {
        markTerminal(candidate.version_id, 'no_matching_indexed_photos_v2');
        continue;
      }
      const missingSourcePhoto = photos.some((photo) => {
        try {
          const absolute = storage.resolve('datasets', photo.relativePath, { mustExist: true });
          const photoStat = fs.statSync(absolute);
          return !photoStat.isFile() || photoStat.size !== photo.byteSize;
        } catch {
          return true;
        }
      });
      if (missingSourcePhoto) {
        summary.versionsFailed += 1;
        const retryAt = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + CAMERA_RETRY_DELAY_MS).toISOString();
        retry.run(candidate.version_id, 'source_photo_unavailable', retryAt, currentIso);
        continue;
      }
      const linked = repository.replaceCameraPhotos(candidate.version_id, photos, { onlyIfEmpty: true });
      if (linked > 0) {
        clearState.run(candidate.version_id);
        summary.versionsReconciled += 1;
        summary.photosLinked += linked;
      }
    } catch {
      summary.versionsFailed += 1;
      const retryAt = new Date((Number.isFinite(nowMs) ? nowMs : Date.now()) + CAMERA_RETRY_DELAY_MS).toISOString();
      retry.run(candidate.version_id, 'source_temporarily_unavailable', retryAt, currentIso);
    }
  }
  return summary;
}

module.exports = {
  MAX_SHOTS_BYTES,
  MAX_CAMERA_FEATURES,
  MAX_CAMERA_PHOTO_ROWS,
  cameraPhotoContentType,
  discoverCameraPhotoLinks,
  reconcileImportedCameraPhotoLinks,
  validCameraFilename,
};
