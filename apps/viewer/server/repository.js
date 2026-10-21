'use strict';

const crypto = require('crypto');
const path = require('node:path');
const { validCameraFilename } = require('./cameraPhotos');

function now() {
  return new Date().toISOString();
}

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function finiteVector(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function sourceAuthorization(row) {
  if (!row || row.source_authorization_type !== 'model_association'
    || typeof row.source_authorization_id !== 'string' || !row.source_authorization_id
    || !Number.isSafeInteger(row.source_authorization_version) || row.source_authorization_version < 1)
    return null;
  return {
    type: 'model_association',
    id: row.source_authorization_id,
    version: row.source_authorization_version,
  };
}

function sourceAuthorizationValues(value) {
  if (value === undefined || value === null) return [null, null, null];
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'id,type,version'
    || value.type !== 'model_association'
    || typeof value.id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value.id)
    || !Number.isSafeInteger(value.version) || value.version < 1)
    throw new TypeError('invalid model association source authorization');
  return [value.type, value.id, value.version];
}

function asModelAsset(asset) {
  return {
    id: asset.id,
    kind: asset.kind,
    rootKey: asset.root_key,
    relativePath: asset.relative_path,
    format: asset.format,
    contentType: asset.content_type,
    byteSize: asset.byte_size,
    sha256: asset.sha256,
    manifestSha256: asset.manifest_sha256,
    storageMode: asset.storage_mode,
    published: Boolean(asset.published),
  };
}

function asModel(row, version, assets = [], lodVerifierReceipt = null, lodVerificationAssets = assets) {
  if (!row) return null;
  const activeVersion = version ? {
    id: version.id,
    providerVersionId: version.provider_version_id,
    sourceLocator: parseJson(version.source_locator_json, {}),
    status: version.status,
    metadata: parseJson(version.metadata_json, {}),
    georef: parseJson(version.georef_json, {}),
    pointCount: version.point_count,
    createdAt: version.created_at,
    updatedAt: version.updated_at,
    assets: assets.map(asModelAsset),
  } : null;
  if (activeVersion) {
    // The durable receipt is server-only authority. Keep it accessible to the
    // Viewer serializer without allowing generic repository responses to emit
    // audit-event identifiers or receipt contents.
    Object.defineProperty(activeVersion, 'lodVerifierReceipt', {
      value: lodVerifierReceipt,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(activeVersion, 'lodVerificationAssets', {
      value: lodVerificationAssets === assets ? activeVersion.assets : lodVerificationAssets.map(asModelAsset),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return {
    id: row.id,
    provider: row.provider,
    providerModelId: row.provider_model_id,
    displayName: row.display_name,
    status: row.status,
    activeVersionId: row.active_version_id,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    unregisteredAt: row.unregistered_at,
    activeVersion,
  };
}

class ViewerRepository {
  constructor(database) {
    this.database = database;
  }

  transaction(callback) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getState(key) {
    const row = this.database.prepare('SELECT value FROM app_state WHERE key=?').get(key);
    return row ? row.value : null;
  }

  setState(key, value) {
    this.database.prepare(`INSERT INTO app_state(key,value,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`
    ).run(key, String(value), now());
  }

  lodVerifierReceipt(versionId) {
    const row = this.database.prepare(`SELECT e.id,e.entity_id,e.details_json,e.created_at
      FROM audit_events e
      JOIN derivative_jobs j ON j.id=e.entity_id
      JOIN processing_attempts a ON a.id=j.attempt_id
      WHERE e.action='derivative.tiles_verified'
        AND e.entity_type='derivative_job'
        AND e.actor_type='system'
        AND e.actor_id IS NULL
        AND j.derivative_type IN ('lod_audit','mesh_tiles')
        AND j.status='complete'
        AND j.completed_at IS NOT NULL
        AND json_valid(j.result_json)
        AND json_extract(j.result_json,'$.verified')=1
        AND a.result_model_version_id=?
        AND json_valid(e.details_json)
        AND json_extract(e.details_json,'$.versionId')=?
        AND json_extract(e.details_json,'$.attemptId')=j.attempt_id
        AND (json_type(e.details_json,'$.receiptVersion') IS NULL
          OR json_extract(e.details_json,'$.leaseToken')=j.lease_token)
        AND e.created_at>=j.created_at
        AND e.created_at<=j.completed_at
      ORDER BY e.created_at DESC,e.id DESC LIMIT 1`).get(versionId, versionId);
    if (!row) return null;
    return {
      eventId: row.id,
      derivativeJobId: row.entity_id,
      details: parseJson(row.details_json, null),
      verifiedAt: row.created_at,
    };
  }

  rateLimited(bucket,max,windowMs,{blockMs=windowMs,at=Date.now()}={}){
    const key=crypto.createHash('sha256').update(String(bucket).normalize('NFKC')).digest('hex'),timestamp=new Date(at).toISOString();
    return this.transaction(()=>{const row=this.database.prepare('SELECT * FROM abuse_windows WHERE bucket_key=?').get(key);if(row?.blocked_until&&Date.parse(row.blocked_until)>at)return true;const reset=!row||Date.parse(row.window_started_at)+windowMs<=at;if(reset){this.database.prepare(`INSERT INTO abuse_windows(bucket_key,window_started_at,hit_count,blocked_until,updated_at) VALUES (?,?,1,NULL,?) ON CONFLICT(bucket_key) DO UPDATE SET window_started_at=excluded.window_started_at,hit_count=1,blocked_until=NULL,updated_at=excluded.updated_at`).run(key,timestamp,timestamp);return false;}const hits=Number(row.hit_count)+1,blocked=hits>max?new Date(at+blockMs).toISOString():null;this.database.prepare('UPDATE abuse_windows SET hit_count=?,blocked_until=COALESCE(?,blocked_until),updated_at=? WHERE bucket_key=?').run(hits,blocked,timestamp,key);return Boolean(blocked);});
  }

  pruneAbuseWindows(at=Date.now(),maxAgeMs=7*86400_000){return this.database.prepare('DELETE FROM abuse_windows WHERE updated_at<? AND (blocked_until IS NULL OR blocked_until<?)').run(new Date(at-maxAgeMs).toISOString(),new Date(at).toISOString()).changes;}

  resolveModelId(id) {
    const direct = this.database.prepare('SELECT id FROM models WHERE id=?').get(id);
    if (direct) return direct.id;
    const alias = this.database.prepare('SELECT model_id FROM model_aliases WHERE alias_id=?').get(id);
    return alias ? alias.model_id : null;
  }

  getModel(id) {
    const resolved = this.resolveModelId(id);
    if (!resolved) return null;
    const row = this.database.prepare('SELECT * FROM models WHERE id=?').get(resolved);
    if (!row) return null;
    const version = row.active_version_id
      ? this.database.prepare('SELECT * FROM model_versions WHERE id=? AND model_id=?').get(row.active_version_id, row.id)
      : null;
    const lodVerificationAssets = version
      ? this.database.prepare('SELECT * FROM model_assets WHERE version_id=? ORDER BY kind').all(version.id)
      : [];
    const assets = lodVerificationAssets.filter((asset) => Boolean(asset.published));
    return asModel(row, version, assets, version ? this.lodVerifierReceipt(version.id) : null, lodVerificationAssets);
  }

  listModels({ includeUnregistered = false } = {}) {
    const rows = this.database.prepare(
      `SELECT id FROM models ${includeUnregistered ? '' : "WHERE status<>'unregistered'"} ORDER BY display_name COLLATE NOCASE`,
    ).all();
    return rows.map((row) => this.getModel(row.id)).filter(Boolean);
  }

  getModelVersion(modelId, versionId) {
    const model = this.database.prepare('SELECT * FROM models WHERE id=?').get(modelId);
    const version = this.database.prepare('SELECT * FROM model_versions WHERE id=? AND model_id=?').get(versionId, modelId);
    if (!model || !version) return null;
    const assets = this.database.prepare('SELECT * FROM model_assets WHERE version_id=? ORDER BY kind').all(versionId);
    return asModel(model, version, assets, this.lodVerifierReceipt(version.id));
  }

  listMissingOdmGeorefCandidates(limit = 5, reconciliationRevision = 1) {
    const n = Math.max(1, Math.min(Number(limit) || 5, 20));
    const revision = Math.max(1, Math.min(Number(reconciliationRevision) || 1, 1_000_000));
    const cursor = parseJson(this.getState('odm_georef_backfill_cursor'), null);
    const rows = this.database.prepare(`SELECT
      v.id AS version_id,v.model_id,o.root_key AS output_root_key,o.relative_path AS output_relative_path
      FROM model_versions v
      JOIN models m ON m.id=v.model_id
      JOIN model_outputs o ON o.id=v.id AND o.model_id=v.model_id
      WHERE m.provider='webodm' AND m.status<>'unregistered'
        AND v.status='ready' AND o.status IN ('ready','published') AND v.id>?
        AND COALESCE(json_extract(v.metadata_json,'$.odmGeorefReconciliation.revision'),0)<?
        AND (
          COALESCE(json_type(v.georef_json,'$.rtc.e'),'') NOT IN ('integer','real') OR
          COALESCE(json_type(v.georef_json,'$.rtc.n'),'') NOT IN ('integer','real') OR
          COALESCE(json_type(v.georef_json,'$.rtc.z'),'') NOT IN ('integer','real') OR
          COALESCE(json_type(v.georef_json,'$.bboxCenter.x'),'') NOT IN ('integer','real') OR
          COALESCE(json_type(v.georef_json,'$.bboxCenter.y'),'') NOT IN ('integer','real') OR
          COALESCE(json_type(v.georef_json,'$.bboxCenter.z'),'') NOT IN ('integer','real')
        )
      ORDER BY v.id LIMIT ?`).all(typeof cursor === 'string' ? cursor : '', revision, n);
    return rows.map((row) => ({
      versionId: row.version_id, modelId: row.model_id,
      outputRootKey: row.output_root_key, outputRelativePath: row.output_relative_path,
    }));
  }

  odmGeorefBackfillCursor() {
    const value = parseJson(this.getState('odm_georef_backfill_cursor'), null);
    return typeof value === 'string' && value ? value : null;
  }

  advanceOdmGeorefBackfillCursor(versionId, more) {
    this.setState('odm_georef_backfill_cursor', more && versionId ? JSON.stringify(versionId) : 'null');
  }

  mergeModelVersionGeoref(modelId, versionId, discovered) {
    return this.transaction(() => {
      const row = this.database.prepare('SELECT georef_json FROM model_versions WHERE id=? AND model_id=?').get(versionId, modelId);
      if (!row) return false;
      const current = parseJson(row.georef_json, {}), next = { ...current };
      let changed = false;
      const hadRtc = finiteVector(current.rtc, ['e', 'n', 'z']);
      const discoveredRtc = finiteVector(discovered?.rtc, ['e', 'n', 'z']);
      if (!hadRtc && discoveredRtc) {
        next.rtc = { e: Number(discovered.rtc.e), n: Number(discovered.rtc.n), z: Number(discovered.rtc.z) };
        changed = true;
      }
      const matchingRtc = !hadRtc || (discoveredRtc && ['e', 'n', 'z'].every((key) => Number(current.rtc[key]) === Number(discovered.rtc[key])));
      if (matchingRtc && !finiteVector(current.bboxCenter, ['x', 'y', 'z']) && finiteVector(discovered?.bboxCenter, ['x', 'y', 'z'])) {
        next.bboxCenter = { x: Number(discovered.bboxCenter.x), y: Number(discovered.bboxCenter.y), z: Number(discovered.bboxCenter.z) };
        changed = true;
      }
      for (const key of ['crs', 'proj', 'epsg', 'utmZone', 'hemisphere', 'utmZoneLon0Deg']) {
        if ((current[key] === undefined || current[key] === null || current[key] === '')
          && discovered?.[key] !== undefined && discovered[key] !== null && discovered[key] !== '') {
          next[key] = discovered[key]; changed = true;
        }
      }
      if (!changed) return false;
      return this.database.prepare('UPDATE model_versions SET georef_json=?,updated_at=? WHERE id=? AND model_id=?')
        .run(JSON.stringify(next), now(), versionId, modelId).changes === 1;
    });
  }

  modelVersionHasCompleteGeoref(modelId, versionId) {
    const row = this.database.prepare('SELECT georef_json FROM model_versions WHERE id=? AND model_id=?').get(versionId, modelId);
    const value = parseJson(row?.georef_json, {});
    return finiteVector(value.rtc, ['e', 'n', 'z']) && finiteVector(value.bboxCenter, ['x', 'y', 'z']);
  }

  markModelVersionGeorefReconciliation(modelId, versionId, revision, outcome = 'terminal_no_metadata') {
    const targetRevision = Math.max(1, Math.min(Number(revision) || 1, 1_000_000));
    return this.transaction(() => {
      const row = this.database.prepare('SELECT metadata_json FROM model_versions WHERE id=? AND model_id=?').get(versionId, modelId);
      if (!row) return false;
      const metadata = parseJson(row.metadata_json, {}), current = metadata.odmGeorefReconciliation;
      if (Number(current?.revision) >= targetRevision) return false;
      const next = { ...metadata, odmGeorefReconciliation: { revision: targetRevision, outcome } };
      return this.database.prepare('UPDATE model_versions SET metadata_json=?,updated_at=? WHERE id=? AND model_id=?')
        .run(JSON.stringify(next), now(), versionId, modelId).changes === 1;
    });
  }

  getModelAssetFile(assetId, relativePath) {
    const row = this.database.prepare('SELECT relative_path,byte_size,sha256 FROM model_asset_files WHERE asset_id=? AND relative_path=?').get(assetId, relativePath);
    return row ? { relativePath: row.relative_path, byteSize: row.byte_size, sha256: row.sha256 } : null;
  }
  getModelAssetChunks(assetId,relativePath=''){return this.database.prepare('SELECT chunk_index,byte_offset,byte_size,sha256 FROM model_asset_chunks WHERE asset_id=? AND relative_path=? ORDER BY chunk_index').all(assetId,relativePath).map((row)=>({chunkIndex:row.chunk_index,byteOffset:row.byte_offset,byteSize:row.byte_size,sha256:row.sha256}));}

  getCameraPhoto(versionId, filename) {
    const safe = validCameraFilename(filename);
    if (!safe) return null;
    const row = this.database.prepare('SELECT filename,root_key,relative_path,content_type,byte_size,sha256 FROM model_camera_photos WHERE version_id=? AND filename=?').get(versionId, safe);
    return row ? { filename: row.filename, rootKey: row.root_key, relativePath: row.relative_path, contentType: row.content_type, byteSize: row.byte_size, sha256: row.sha256 } : null;
  }

  listCameraPhotos(versionId) {
    return this.database.prepare('SELECT filename,root_key,relative_path,content_type,byte_size,sha256 FROM model_camera_photos WHERE version_id=? ORDER BY filename').all(versionId).map((row) => ({ filename: row.filename, rootKey: row.root_key, relativePath: row.relative_path, contentType: row.content_type, byteSize: row.byte_size, sha256: row.sha256 }));
  }

  replaceCameraPhotos(versionId, photos, { onlyIfEmpty = false } = {}) {
    const timestamp = now();
    const normalized = (photos || []).map((photo) => {
      const filename = validCameraFilename(photo.filename);
      const rawRelativePath = String(photo.relativePath || '');
      const relativePath = path.posix.normalize(rawRelativePath);
      const rootKey = String(photo.rootKey || '');
      if (!filename || !rootKey || rawRelativePath.includes('\\') || relativePath !== rawRelativePath
        || path.posix.isAbsolute(relativePath) || !relativePath || relativePath === '..' || relativePath.startsWith('../')
        || photo.contentType !== 'image/jpeg' || !Number.isSafeInteger(photo.byteSize) || photo.byteSize < 0
        || typeof photo.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(photo.sha256)) throw new TypeError('invalid camera photo link');
      return { filename, rootKey, relativePath, contentType: photo.contentType, byteSize: photo.byteSize, sha256: photo.sha256 };
    });
    return this.transaction(() => {
      if (!this.database.prepare('SELECT 1 FROM model_versions WHERE id=?').get(versionId)) return 0;
      if (onlyIfEmpty && this.database.prepare('SELECT 1 FROM model_camera_photos WHERE version_id=? LIMIT 1').get(versionId)) return 0;
      this.database.prepare('DELETE FROM model_camera_photos WHERE version_id=?').run(versionId);
      const insert = this.database.prepare(`INSERT INTO model_camera_photos(
        version_id,filename,root_key,relative_path,content_type,byte_size,sha256,created_at
      ) VALUES (?,?,?,?,?,?,?,?)`);
      for (const photo of normalized) insert.run(versionId, photo.filename, photo.rootKey, photo.relativePath, photo.contentType, photo.byteSize, photo.sha256, timestamp);
      return normalized.length;
    });
  }

  publishModelVersion(modelId, versionId, selectedKinds) {
    const allowed = new Set(selectedKinds);
    const timestamp = now();
    return this.transaction(() => {
      const version = this.database.prepare('SELECT id FROM model_versions WHERE id=? AND model_id=?').get(versionId, modelId);
      if (!version) return null;
      const modelRow=this.database.prepare('SELECT provider FROM models WHERE id=?').get(modelId);
      if(modelRow?.provider==='ltds-processing'){for(const kind of allowed){const asset=this.database.prepare('SELECT * FROM model_assets WHERE version_id=? AND kind=?').get(versionId,kind);if(!asset?.sha256)return null;if(['ept','tiles'].includes(kind)&&(!asset.manifest_sha256||!this.database.prepare('SELECT 1 FROM model_asset_files WHERE asset_id=? LIMIT 1').get(asset.id)))return null;}}
      this.database.prepare('UPDATE model_assets SET published=0 WHERE version_id=?').run(versionId);
      const update = this.database.prepare('UPDATE model_assets SET published=1 WHERE version_id=? AND kind=?');
      for (const kind of allowed) update.run(versionId, kind);
      this.database.prepare("UPDATE model_versions SET status='ready',updated_at=? WHERE id=?").run(timestamp, versionId);
      this.database.prepare("UPDATE models SET active_version_id=?,status='ready',updated_at=? WHERE id=?").run(versionId, timestamp, modelId);
      return this.getModel(modelId);
    });
  }

  upsertModelVersion(input) {
    const timestamp = now();
    return this.transaction(() => {
      // Upgrade reconciliation tests and interrupted rolling starts can open a
      // repository against an older schema before the remaining migrations
      // are applied. Existing model writes remain compatible, but camera
      // links must never be silently discarded when their table is absent.
      const cameraPhotoLinksAvailable = Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_camera_photos'").get());
      if ((input.cameraPhotos || []).length && !cameraPhotoLinksAvailable) throw new Error('camera photo link schema is unavailable');
      let model = this.database.prepare(
        'SELECT * FROM models WHERE provider=? AND provider_model_id=?',
      ).get(input.provider, input.providerModelId);
      const modelId = model ? model.id : (input.modelId || crypto.randomUUID());
      if (!model) {
        this.database.prepare(`INSERT INTO models(
          id,provider,provider_model_id,display_name,status,metadata_json,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?)`).run(
          modelId,
          input.provider,
          input.providerModelId,
          input.displayName,
          input.status || 'ready',
          JSON.stringify(input.metadata || {}),
          timestamp,
          timestamp,
        );
      } else {
        this.database.prepare(`UPDATE models SET
          display_name=?,status=CASE WHEN active_version_id IS NOT NULL THEN 'ready' ELSE ? END,metadata_json=?,updated_at=?,unregistered_at=NULL
          WHERE id=?`).run(
          input.displayName,
          input.status || 'ready',
          JSON.stringify(input.metadata || {}),
          timestamp,
          modelId,
        );
      }

      let version = this.database.prepare(
        'SELECT * FROM model_versions WHERE model_id=? AND provider_version_id=?',
      ).get(modelId, input.providerVersionId);
      const versionId = version ? version.id : (input.versionId || crypto.randomUUID());
      if (!version) {
        this.database.prepare(`INSERT INTO model_versions(
          id,model_id,provider_version_id,source_locator_json,status,metadata_json,georef_json,point_count,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          versionId,
          modelId,
          input.providerVersionId,
          JSON.stringify(input.sourceLocator || {}),
          input.status || 'ready',
          JSON.stringify(input.versionMetadata || {}),
          JSON.stringify(input.georef || {}),
          input.pointCount ?? null,
          timestamp,
          timestamp,
        );
      } else {
        this.database.prepare(`UPDATE model_versions SET
          source_locator_json=?,status=?,metadata_json=?,georef_json=?,point_count=?,updated_at=?
          WHERE id=?`).run(
          JSON.stringify(input.sourceLocator || {}),
          input.status || 'ready',
          JSON.stringify(input.versionMetadata || {}),
          JSON.stringify(input.georef || {}),
          input.pointCount ?? null,
          timestamp,
          versionId,
        );
        this.database.prepare('DELETE FROM model_assets WHERE version_id=?').run(versionId);
        if (cameraPhotoLinksAvailable) this.database.prepare('DELETE FROM model_camera_photos WHERE version_id=?').run(versionId);
      }

      const insertAsset = this.database.prepare(`INSERT INTO model_assets(
        id,version_id,kind,root_key,relative_path,format,content_type,byte_size,storage_mode,published,source_attempt_id,sha256,manifest_sha256,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertAssetFile = this.database.prepare('INSERT INTO model_asset_files(asset_id,relative_path,byte_size,sha256) VALUES (?,?,?,?)');
      const insertAssetChunk=this.database.prepare('INSERT INTO model_asset_chunks(asset_id,relative_path,chunk_index,byte_offset,byte_size,sha256) VALUES (?,?,?,?,?,?)');
      for (const asset of input.assets || []) {
        const assetId = crypto.randomUUID();
        insertAsset.run(
          assetId,
          versionId,
          asset.kind,
          asset.rootKey,
          asset.relativePath,
          asset.format || null,
          asset.contentType || null,
          asset.byteSize ?? null,
          asset.storageMode || 'external_reference',
          asset.published === false ? 0 : 1,
          asset.sourceAttemptId || null,
          asset.sha256 || null,
          asset.manifestSha256 || null,
          timestamp,
        );
        for(const chunk of asset.chunks||[])insertAssetChunk.run(assetId,'',chunk.chunkIndex,chunk.byteOffset,chunk.byteSize,chunk.sha256);
        for (const file of asset.manifestFiles || asset.files || []){insertAssetFile.run(assetId,file.relativePath,file.byteSize,file.sha256);for(const chunk of file.chunks||[])insertAssetChunk.run(assetId,file.relativePath,chunk.chunkIndex,chunk.byteOffset,chunk.byteSize,chunk.sha256);}
      }

      const insertCameraPhoto = cameraPhotoLinksAvailable ? this.database.prepare(`INSERT INTO model_camera_photos(
        version_id,filename,root_key,relative_path,content_type,byte_size,sha256,created_at
      ) VALUES (?,?,?,?,?,?,?,?)`) : null;
      for (const photo of input.cameraPhotos || []) {
        const filename = validCameraFilename(photo.filename);
        const rawRelativePath = String(photo.relativePath || '');
        const relativePath = path.posix.normalize(rawRelativePath);
        const rootKey = String(photo.rootKey || '');
        if (!filename || !rootKey || rawRelativePath.includes('\\') || relativePath !== rawRelativePath
          || path.posix.isAbsolute(relativePath) || !relativePath || relativePath === '..' || relativePath.startsWith('../')
          || photo.contentType !== 'image/jpeg' || !Number.isSafeInteger(photo.byteSize) || photo.byteSize < 0
          || typeof photo.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(photo.sha256)) throw new TypeError('invalid camera photo link');
        insertCameraPhoto.run(versionId, filename, rootKey, relativePath, photo.contentType, photo.byteSize, photo.sha256, timestamp);
      }

      if (input.aliasId) {
        this.database.prepare(
          'INSERT INTO model_aliases(alias_id,model_id,created_at) VALUES (?,?,?) ON CONFLICT(alias_id) DO UPDATE SET model_id=excluded.model_id',
        ).run(input.aliasId, modelId, timestamp);
      }
      if (input.makeActive !== false && (input.status || 'ready') === 'ready') {
        this.database.prepare('UPDATE models SET active_version_id=?,status=?,updated_at=? WHERE id=?')
          .run(versionId, 'ready', timestamp, modelId);
      }
      return this.getModel(modelId);
    });
  }

  unregisterModel(id) {
    const modelId = this.resolveModelId(id);
    if (!modelId) return false;
    const timestamp = now();
    const result = this.database.prepare(
      "UPDATE models SET status='unregistered',unregistered_at=?,updated_at=? WHERE id=? AND status<>'unregistered'",
    ).run(timestamp, timestamp, modelId);
    return result.changes === 1;
  }

  createImportJob({ provider, identifier, request, createdBy = null }) {
    const id = crypto.randomUUID();
    const timestamp = now();
    this.database.prepare(`INSERT INTO import_jobs(
      id,provider,identifier,request_json,status,created_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      id, provider, identifier, JSON.stringify(request || {}), 'pending', createdBy, timestamp, timestamp,
    );
    return this.getImportJob(id);
  }

  getImportJob(id) {
    const row = this.database.prepare('SELECT * FROM import_jobs WHERE id=?').get(id);
    return row ? this.importJob(row) : null;
  }

  listImportJobs(limit = 100) {
    return this.database.prepare('SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(Number(limit) || 100, 500))).map((row) => this.importJob(row));
  }

  claimPendingImport() {
    return this.transaction(() => {
      const row = this.database.prepare(
        "SELECT * FROM import_jobs WHERE status='pending' ORDER BY created_at LIMIT 1",
      ).get();
      if (!row) return null;
      const timestamp = now();
      this.database.prepare(`UPDATE import_jobs SET
        status='importing',attempt_count=attempt_count+1,started_at=COALESCE(started_at,?),updated_at=?
        WHERE id=? AND status='pending'`).run(timestamp, timestamp, row.id);
      return this.getImportJob(row.id);
    });
  }

  requeueInterruptedImports() {
    const timestamp = now();
    return this.database.prepare(`UPDATE import_jobs SET
      status='pending',error_code='worker_restarted',error_message='Import was resumed after Viewer restart',updated_at=?
      WHERE status='importing'`
    ).run(timestamp).changes;
  }

  completeImport(id, modelId) {
    const timestamp = now();
    this.database.prepare(`UPDATE import_jobs SET
      status='ready',model_id=?,error_code=NULL,error_message=NULL,completed_at=?,updated_at=? WHERE id=?`
    ).run(modelId, timestamp, timestamp, id);
    return this.getImportJob(id);
  }

  failImport(id, code, message) {
    const timestamp = now();
    this.database.prepare(`UPDATE import_jobs SET
      status='failed',error_code=?,error_message=?,completed_at=?,updated_at=? WHERE id=?`
    ).run(String(code || 'import_failed').slice(0, 80), String(message || 'Import failed').slice(0, 1000), timestamp, timestamp, id);
    return this.getImportJob(id);
  }

  importJob(row) {
    return {
      id: row.id,
      provider: row.provider,
      identifier: row.identifier,
      request: parseJson(row.request_json, {}),
      status: row.status,
      attemptCount: row.attempt_count,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      modelId: row.model_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  createPublicShare(input) {
    const id = input.id || crypto.randomUUID();
    const timestamp = now();
    this.database.prepare(`INSERT INTO public_shares(
      id,model_id,version_policy,model_version_id,public_id_hash,password_hash,permissions_json,label,created_by,
      created_at,updated_at,expires_at,display_units,share_class,source_authorization_id,source_authorization_version,
      source_authorization_subject,source_authorization_expires_at,token_ciphertext
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      input.modelId,
      input.versionPolicy || 'latest',
      input.modelVersionId || null,
      input.publicIdHash,
      input.passwordHash || null,
      JSON.stringify(input.permissions || {}),
      input.label || null,
      input.createdBy || null,
      timestamp,
      timestamp,
      input.expiresAt || null,
      input.displayUnits || null,
      input.shareClass || 'staff',
      input.sourceAuthorization?.id || null,
      input.sourceAuthorization?.version == null ? null : String(input.sourceAuthorization.version),
      input.sourceAuthorization?.subject || null,
      input.sourceAuthorization?.expiresAt || null,
      input.tokenCiphertext || null,
    );
    return this.getPublicShare(id);
  }

  importLegacyPublicShare(input) {
    const timestamp = input.createdAt || now();
    this.database.prepare(`INSERT OR IGNORE INTO public_shares(
      id,model_id,version_policy,model_version_id,public_id_hash,password_hash,permissions_json,label,created_by,
      created_at,updated_at,expires_at,revoked_at,revoke_reason,access_count,last_accessed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.id || crypto.randomUUID(),
      input.modelId,
      input.versionPolicy || 'latest',
      input.modelVersionId || null,
      input.publicIdHash,
      input.passwordHash || null,
      JSON.stringify(input.permissions || {}),
      input.label || null,
      input.createdBy || 'legacy-import',
      timestamp,
      input.updatedAt || timestamp,
      input.expiresAt || null,
      input.revokedAt || null,
      input.revokedAt ? (input.revokeReason || 'legacy-revoked') : null,
      Number.isInteger(input.accessCount) ? input.accessCount : 0,
      input.lastAccessedAt || null,
    );
  }

  publicShare(row) {
    if (!row) return null;
    return {
      id: row.id,
      modelId: row.model_id,
      versionPolicy: row.version_policy,
      modelVersionId: row.model_version_id,
      publicIdHash: row.public_id_hash,
      tokenCiphertext: row.token_ciphertext || null,
      authorizationRevision: row.authorization_revision || 0,
      allowedViews: parseJson(row.allowed_views_json, null),
      hasPassword: Boolean(row.password_hash),
      passwordHash: row.password_hash,
      permissions: parseJson(row.permissions_json, {}),
      label: row.label,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      displayUnits: row.display_units,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      revokeReason: row.revoke_reason,
      accessCount: row.access_count,
      lastAccessedAt: row.last_accessed_at,
      shareClass: row.share_class || 'staff',
      sourceAuthorization: row.share_class==='client'?{type:'client_grant',id:row.source_authorization_id,version:Number(row.source_authorization_version),subject:row.source_authorization_subject,expiresAt:row.source_authorization_expires_at||null}:null,
    };
  }

  getPublicShare(id) {
    return this.publicShare(this.database.prepare('SELECT * FROM public_shares WHERE id=?').get(id));
  }

  updatePublicShare(id,patch) {
    const share=this.getPublicShare(id);if(!share||share.revokedAt)return null;
    const next={...share,...patch};
    this.database.prepare(`UPDATE public_shares SET label=?,password_hash=?,expires_at=?,permissions_json=?,allowed_views_json=?,token_ciphertext=?,authorization_revision=authorization_revision+?,updated_at=? WHERE id=? AND revoked_at IS NULL`).run(next.label,next.passwordHash,next.expiresAt,JSON.stringify(next.permissions),next.allowedViews?JSON.stringify(next.allowedViews):null,next.tokenCiphertext,patch.invalidateAuthorization?1:0,now(),id);
    return this.getPublicShare(id);
  }

  getPublicShareByHash(hash) {
    return this.publicShare(this.database.prepare('SELECT * FROM public_shares WHERE public_id_hash=?').get(hash));
  }

  listPublicShares(modelId) {
    return this.database.prepare('SELECT * FROM public_shares WHERE model_id=? ORDER BY created_at DESC')
      .all(modelId).map((row) => this.publicShare(row));
  }

  revokePublicShare(id, { actorId = null, reason = 'revoked' } = {}) {
    const timestamp = now();
    const result = this.database.prepare(`UPDATE public_shares SET
      revoked_at=COALESCE(revoked_at,?),revoked_by=COALESCE(revoked_by,?),revoke_reason=COALESCE(revoke_reason,?),updated_at=?
      WHERE id=?`).run(timestamp, actorId, String(reason).slice(0, 240), timestamp, id);
    return result.changes === 1 ? this.getPublicShare(id) : null;
  }

  publicShareLive(share, at = Date.now()) {
    if (!share || share.revokedAt) return false;
    return !share.expiresAt || Date.parse(share.expiresAt) > at;
  }

  recordPublicShareAccess(id) {
    const timestamp = now();
    this.database.prepare(`UPDATE public_shares SET
      access_count=access_count+1,last_accessed_at=?,updated_at=? WHERE id=?`
    ).run(timestamp, timestamp, id);
  }

  projectShare(row) {
    if (!row) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      publicIdHash: row.public_id_hash,
      hasPassword: Boolean(row.password_hash),
      passwordHash: row.password_hash,
      permissions: parseJson(row.permissions_json, {}),
      label: row.label,
      versionPolicy: row.version_policy || 'active',
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      displayUnits: row.display_units,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      revokeReason: row.revoke_reason,
      accessCount: Number(row.access_count || 0),
      lastAccessedAt: row.last_accessed_at,
    };
  }

  createProjectShare(input) {
    const id = input.id || crypto.randomUUID();
    const timestamp = now();
    this.database.prepare(`INSERT INTO public_project_shares(
      id,project_id,public_id_hash,password_hash,permissions_json,label,version_policy,created_by,
      created_at,updated_at,expires_at,display_units
    ) VALUES (?,?,?,?,?,?,'active',?,?,?,?,?)`).run(
      id,
      input.projectId,
      input.publicIdHash,
      input.passwordHash || null,
      JSON.stringify(input.permissions || {}),
      input.label || null,
      input.createdBy || null,
      timestamp,
      timestamp,
      input.expiresAt || null,
      input.displayUnits || 'imperial',
    );
    return this.getProjectShare(id);
  }

  getProjectShare(id) {
    return this.projectShare(this.database.prepare('SELECT * FROM public_project_shares WHERE id=?').get(id));
  }

  getProjectShareByHash(hash) {
    return this.projectShare(this.database.prepare('SELECT * FROM public_project_shares WHERE public_id_hash=?').get(hash));
  }

  listProjectShares(projectId) {
    return this.database.prepare('SELECT * FROM public_project_shares WHERE project_id=? ORDER BY created_at DESC')
      .all(projectId).map((row) => this.projectShare(row));
  }

  projectShareLive(share, at = Date.now()) {
    if (!share || share.revokedAt) return false;
    return !share.expiresAt || Date.parse(share.expiresAt) > at;
  }

  revokeProjectShare(id, { actorId = null, reason = 'revoked' } = {}) {
    const timestamp = now();
    const result = this.database.prepare(`UPDATE public_project_shares SET
      revoked_at=COALESCE(revoked_at,?),revoked_by=COALESCE(revoked_by,?),revoke_reason=COALESCE(revoke_reason,?),updated_at=?
      WHERE id=?`).run(timestamp, actorId, String(reason).slice(0, 240), timestamp, id);
    return result.changes === 1 ? this.getProjectShare(id) : null;
  }

  recordProjectShareAccess(id) {
    const timestamp = now();
    this.database.prepare(`UPDATE public_project_shares SET
      access_count=access_count+1,last_accessed_at=?,updated_at=? WHERE id=?`
    ).run(timestamp, timestamp, id);
  }

  createSessionGrant({ modelId, modelVersionId = null, reviewAttemptId = null, sessionMode = 'published', sourceAuthorization: authorization = null, subject, audience, permissions, displayUnits = 'imperial', expiresAt }) {
    this.pruneAuthState();
    const id = crypto.randomUUID();
    const timestamp = now();
    const [sourceType, sourceId, sourceVersion] = sourceAuthorizationValues(authorization);
    if (sessionMode !== 'published' && sourceId !== null)
      throw new TypeError('source authorization is only valid for published sessions');
    const inserted = this.database.prepare(`INSERT INTO session_grants(
      id,model_id,model_version_id,review_attempt_id,session_mode,
      source_authorization_type,source_authorization_id,source_authorization_version,
      subject,audience,permissions_json,display_units,expires_at,created_at
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE ? IS NULL OR NOT EXISTS (
        SELECT 1 FROM revoked_published_session_authorizations
        WHERE source_authorization_type=? AND source_authorization_id=? AND source_authorization_version=?
      )`).run(
      id, modelId, modelVersionId, reviewAttemptId, sessionMode, sourceType, sourceId, sourceVersion,
      subject, audience, JSON.stringify(permissions || {}), displayUnits, expiresAt, timestamp,
      sourceId, sourceType, sourceId, sourceVersion,
    );
    if (inserted.changes !== 1)
      throw Object.assign(new Error('source authorization is revoked'), { code: 'source_authorization_revoked' });
    return { id, modelId, modelVersionId, reviewAttemptId, sessionMode, sourceAuthorization: authorization, subject, audience, permissions, displayUnits, expiresAt, createdAt: timestamp };
  }

  createSessionGrantAudited(input, audit) {
    return this.transaction(() => {
      const grant = this.createSessionGrant(input);
      this.audit({ ...audit, entityId: audit.entityId || input.reviewAttemptId || grant.id });
      return grant;
    });
  }

  redeemSessionGrant(id, at = Date.now()) {
    return this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM session_grants WHERE id=?').get(id);
      if (!row || row.redeemed_at || Date.parse(row.expires_at) <= at) return null;
      if (row.source_authorization_id && this.database.prepare(`SELECT 1
        FROM revoked_published_session_authorizations
        WHERE source_authorization_type=? AND source_authorization_id=? AND source_authorization_version=?`
      ).get(row.source_authorization_type, row.source_authorization_id, row.source_authorization_version)) return null;
      const timestamp = new Date(at).toISOString();
      const updated = this.database.prepare(
        'UPDATE session_grants SET redeemed_at=? WHERE id=? AND redeemed_at IS NULL',
      ).run(timestamp, id);
      if (updated.changes !== 1) return null;
      return {
        id: row.id,
        modelId: row.model_id,
        modelVersionId: row.model_version_id,
        reviewAttemptId: row.review_attempt_id,
        sessionMode: row.session_mode || 'published',
        sourceAuthorization: sourceAuthorization(row),
        subject: row.subject,
        audience: row.audience,
        permissions: parseJson(row.permissions_json, {}),
        displayUnits: row.display_units,
        expiresAt: row.expires_at,
      };
    });
  }

  viewerSession(row) {
    if (!row) return null;
    return {
      id: row.id,
      tokenHash: row.token_hash,
      modelId: row.model_id,
      modelVersionId: row.model_version_id,
      subject: row.subject,
      audience: row.audience,
      sessionMode: row.session_mode || 'published',
      reviewAttemptId: row.review_attempt_id,
      sourceAuthorization: sourceAuthorization(row),
      permissions: parseJson(row.permissions_json, {}),
      displayUnits: row.display_units,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createViewerSession({ tokenHash, modelId, modelVersionId, reviewAttemptId = null, sessionMode = 'published', sourceAuthorization: authorization = null, subject, audience, permissions, displayUnits = 'imperial', expiresAt }) {
    const id = crypto.randomUUID();
    const timestamp = now();
    const [sourceType, sourceId, sourceVersion] = sourceAuthorizationValues(authorization);
    if (sessionMode !== 'published' && sourceId !== null)
      throw new TypeError('source authorization is only valid for published sessions');
    const inserted = this.database.prepare(`INSERT INTO viewer_sessions(
      id,token_hash,model_id,model_version_id,review_attempt_id,session_mode,
      source_authorization_type,source_authorization_id,source_authorization_version,
      subject,audience,permissions_json,display_units,expires_at,created_at,updated_at
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE ? IS NULL OR NOT EXISTS (
        SELECT 1 FROM revoked_published_session_authorizations
        WHERE source_authorization_type=? AND source_authorization_id=? AND source_authorization_version=?
      )`).run(
      id, tokenHash, modelId, modelVersionId, reviewAttemptId, sessionMode, sourceType, sourceId, sourceVersion, subject, audience,
      JSON.stringify(permissions || {}), displayUnits, expiresAt, timestamp, timestamp,
      sourceId, sourceType, sourceId, sourceVersion,
    );
    if (inserted.changes !== 1) return null;
    return this.getViewerSessionByHash(tokenHash);
  }

  getViewerSessionByHash(tokenHash) {
    return this.viewerSession(this.database.prepare('SELECT * FROM viewer_sessions WHERE token_hash=?').get(tokenHash));
  }

  viewerSessionLive(session, at = Date.now()) {
    if (!session || session.revokedAt || Date.parse(session.expiresAt) <= at) return false;
    if (session.sessionMode !== 'review') return true;
    const attempt = this.database.prepare(`SELECT a.status,a.result_model_id,a.result_model_version_id,o.status AS output_status,v.status AS version_status
      FROM processing_attempts a
      JOIN model_outputs o ON o.id=a.result_model_version_id AND o.attempt_id=a.id AND o.model_id=a.result_model_id
      JOIN model_versions v ON v.id=a.result_model_version_id AND v.model_id=a.result_model_id
      WHERE a.id=?`).get(session.reviewAttemptId);
    return Boolean(attempt
      && attempt.status === 'ready_for_review'
      && attempt.output_status === 'ready'
      && attempt.version_status === 'ready'
      && attempt.result_model_id === session.modelId
      && attempt.result_model_version_id === session.modelVersionId);
  }

  revokeReviewSessions({ attemptId, subject, audit = null }) {
    const timestamp = now();
    return this.transaction(() => {
      const grants = this.database.prepare(`DELETE FROM session_grants
        WHERE session_mode='review' AND review_attempt_id=? AND subject=?`).run(attemptId, subject).changes;
      const sessions = this.database.prepare(`UPDATE viewer_sessions SET revoked_at=COALESCE(revoked_at,?),updated_at=?
        WHERE session_mode='review' AND review_attempt_id=? AND subject=? AND revoked_at IS NULL`).run(timestamp, timestamp, attemptId, subject).changes;
      const result = { grants, sessions };
      if (audit) this.audit({ ...audit, entityId: audit.entityId || attemptId, details: { ...(audit.details || {}), revokedGrants: grants, revokedSessions: sessions } });
      return result;
    });
  }

  revokePublishedSessionsBySourceAuthorization({ sourceAuthorization: authorization, audit, idempotency = null }) {
    const [sourceType, sourceId, sourceVersion] = sourceAuthorizationValues(authorization);
    if (sourceId === null) throw new TypeError('source authorization is required');
    const timestamp = now();
    return this.transaction(() => {
      this.database.prepare(`INSERT INTO revoked_published_session_authorizations(
        source_authorization_type,source_authorization_id,source_authorization_version,revoked_at,revoked_by
      ) VALUES (?,?,?,?,?) ON CONFLICT(source_authorization_type,source_authorization_id,source_authorization_version) DO NOTHING`
      ).run(sourceType, sourceId, sourceVersion, timestamp, audit?.actorId || null);
      const grants = this.database.prepare(`DELETE FROM session_grants
        WHERE session_mode='published' AND redeemed_at IS NULL
          AND source_authorization_type=? AND source_authorization_id=? AND source_authorization_version=?`
      ).run(sourceType, sourceId, sourceVersion).changes;
      const sessions = this.database.prepare(`UPDATE viewer_sessions
        SET revoked_at=COALESCE(revoked_at,?),updated_at=?
        WHERE session_mode='published' AND revoked_at IS NULL AND expires_at>?
          AND source_authorization_type=? AND source_authorization_id=? AND source_authorization_version=?`
      ).run(timestamp, timestamp, timestamp, sourceType, sourceId, sourceVersion).changes;
      const result = { sourceAuthorization: authorization, revokedGrants: grants, revokedSessions: sessions };
      this.audit({
        ...audit,
        entityId: sourceId,
        details: {
          sourceAuthorizationType: sourceType,
          sourceAuthorizationVersion: sourceVersion,
          revokedGrants: grants,
          revokedSessions: sessions,
        },
      });
      if (idempotency) {
        // Keep the canonical replay payload in the same commit as the
        // revocation. A lost HTTP response must not strand the caller behind
        // an incomplete idempotency reservation.
        const completed = this.database.prepare(`UPDATE service_idempotency SET
          response_status=200,response_ciphertext=?
          WHERE key_id=? AND idempotency_key=? AND response_status IS NULL`
        ).run(idempotency.encrypt(result), idempotency.keyId, idempotency.idempotencyKey);
        if (completed.changes !== 1) throw new Error('source revocation idempotency reservation is unavailable');
      }
      return result;
    });
  }

  failClosedUnboundPublishedSessions(audit) {
    const timestamp = now();
    return this.transaction(() => {
      const grants = this.database.prepare(`DELETE FROM session_grants
        WHERE session_mode='published' AND redeemed_at IS NULL AND source_authorization_id IS NULL`
      ).run().changes;
      const sessions = this.database.prepare(`UPDATE viewer_sessions
        SET revoked_at=COALESCE(revoked_at,?),updated_at=?
        WHERE session_mode='published' AND revoked_at IS NULL AND expires_at>?
          AND source_authorization_id IS NULL`
      ).run(timestamp, timestamp, timestamp).changes;
      const result = { grants, sessions };
      if (grants || sessions) this.audit({
        ...audit,
        details: { revokedGrants: grants, revokedSessions: sessions },
      });
      return result;
    });
  }

  renewViewerSession(id, { permissions, displayUnits = 'imperial', expiresAt }) {
    const timestamp = now();
    const result = this.database.prepare(`UPDATE viewer_sessions SET
      permissions_json=?,display_units=?,expires_at=?,updated_at=? WHERE id=? AND revoked_at IS NULL`
    ).run(JSON.stringify(permissions || {}), displayUnits, expiresAt, timestamp, id);
    if (result.changes !== 1) return null;
    return this.viewerSession(this.database.prepare('SELECT * FROM viewer_sessions WHERE id=?').get(id));
  }

  revokeViewerSession(id) {
    const timestamp = now();
    const result = this.database.prepare(
      'UPDATE viewer_sessions SET revoked_at=COALESCE(revoked_at,?),updated_at=? WHERE id=?',
    ).run(timestamp, timestamp, id);
    return result.changes === 1;
  }

  pruneAuthState(at = Date.now()) {
    const timestamp = new Date(at).toISOString();
    const grants = this.database.prepare(
      'DELETE FROM session_grants WHERE expires_at<=? OR redeemed_at IS NOT NULL',
    ).run(timestamp).changes;
    const sessions = this.database.prepare(
      'DELETE FROM viewer_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL',
    ).run(timestamp).changes;
    // Nonces normally prune on every signed request. This also bounds them
    // after a long idle period before the next request arrives.
    const nonces = this.database.prepare('DELETE FROM service_nonces WHERE created_at<?')
      .run(new Date(at - 24 * 60 * 60 * 1000).toISOString()).changes;
    const idempotency = this.database.prepare('DELETE FROM service_idempotency WHERE expires_at<=?')
      .run(timestamp).changes;
    return { grants, sessions, nonces, idempotency };
  }

  reserveIdempotency({ keyId, idempotencyKey, method, path, requestHash, expiresAt }) {
    const existing = this.database.prepare(
      'SELECT * FROM service_idempotency WHERE key_id=? AND idempotency_key=?',
    ).get(keyId, idempotencyKey);
    if (existing) return { created: false, record: existing };
    try {
      this.database.prepare(`INSERT INTO service_idempotency(
        key_id,idempotency_key,method,path,request_hash,created_at,expires_at
      ) VALUES (?,?,?,?,?,?,?)`).run(
        keyId, idempotencyKey, method, path, requestHash, now(), expiresAt,
      );
      return { created: true, record: null };
    } catch (error) {
      if (!String(error && error.message).includes('UNIQUE constraint failed')) throw error;
      return {
        created: false,
        record: this.database.prepare(
          'SELECT * FROM service_idempotency WHERE key_id=? AND idempotency_key=?',
        ).get(keyId, idempotencyKey),
      };
    }
  }

  completeIdempotency(keyId, idempotencyKey, status, ciphertext) {
    this.database.prepare(`UPDATE service_idempotency SET
      response_status=?,response_ciphertext=? WHERE key_id=? AND idempotency_key=?`
    ).run(status, ciphertext, keyId, idempotencyKey);
  }

  releaseIdempotency(keyId, idempotencyKey) {
    this.database.prepare(
      'DELETE FROM service_idempotency WHERE key_id=? AND idempotency_key=? AND response_status IS NULL',
    ).run(keyId, idempotencyKey);
  }

  consumeServiceNonce(keyId, nonce, cutoffIso, createdAtIso = now()) {
    return this.transaction(() => {
      this.database.prepare('DELETE FROM service_nonces WHERE created_at<?').run(cutoffIso);
      try {
        this.database.prepare('INSERT INTO service_nonces(key_id,nonce,created_at) VALUES (?,?,?)')
          .run(keyId, nonce, createdAtIso);
        return true;
      } catch (error) {
        if (String(error && error.message).includes('UNIQUE constraint failed')) return false;
        throw error;
      }
    });
  }

  audit({ actorType, actorId = null, action, entityType, entityId = null, details = {} }) {
    const id = crypto.randomUUID();
    this.database.prepare(`INSERT INTO audit_events(
      id,actor_type,actor_id,action,entity_type,entity_id,details_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      id, actorType, actorId, action, entityType, entityId, JSON.stringify(details), now(),
    );
    return id;
  }
}

module.exports = { ViewerRepository, asModel, parseJson };
