'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const now = () => new Date().toISOString();
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const bounded = (value, maximum) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const pathBasename = (value) => typeof value === 'string' ? path.posix.basename(value) : '';

function pointId(setId, externalId) {
  return `gcp_${crypto.createHash('sha256').update(`${setId}\0${externalId}`).digest('hex').slice(0, 32)}`;
}

function haversineMeters(latitude1, longitude1, latitude2, longitude2) {
  const radians = Math.PI / 180;
  const phi1 = latitude1 * radians, phi2 = latitude2 * radians;
  const deltaPhi = (latitude2 - latitude1) * radians;
  const deltaLambda = (longitude2 - longitude1) * radians;
  const a = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class GcpRepository {
  constructor(database) { this.database = database; }

  transaction(fn) {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  set(row) {
    return row && {
      id: row.id, datasetId: row.dataset_id, displayName: row.display_name,
      sourceFormat: row.adapter || row.source_format, sourceFileId: row.source_file_id,
      sourceFilename: row.source_filename, sourceSha256: row.source_sha256,
      crs: row.crs, elevationUnits: row.elevation_units,
      provenance: row.adapter ? { adapter: row.adapter, coordinateSystem: row.coordinate_system,
        verticalDatum: row.vertical_datum, linearUnit: row.linear_unit,
        elevationSource: row.elevation_source, geographicCrossCheck: row.geographic_cross_check } : null,
      pointCount: Number(row.point_count || 0), createdBy: row.created_by,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  point(row) {
    return row && {
      id: row.id, setId: row.set_id, externalId: row.external_id, label: row.label,
      latitude: Number(row.latitude), longitude: Number(row.longitude),
      elevationM: Number(row.elevation_m), description: row.description,
      easting: row.easting == null ? null : Number(row.easting), northing: row.northing == null ? null : Number(row.northing),
      ellipsoidalHeightM: row.ellipsoidal_height_m == null ? null : Number(row.ellipsoidal_height_m),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  correspondence(row) {
    return row && {
      id: row.id, taskId: row.task_id, pointId: row.gcp_point_id,
      imageFileId: row.dataset_file_id, pixelX: Number(row.pixel_x), pixelY: Number(row.pixel_y),
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  dataset(id) { return this.database.prepare('SELECT * FROM datasets WHERE id=?').get(id) || null; }
  task(id) { return this.database.prepare('SELECT * FROM processing_tasks WHERE id=?').get(id) || null; }

  findSourceFile(datasetId, sourceFilename, sha256) {
    const expectedName = pathBasename(sourceFilename).toLocaleLowerCase('en-US');
    if (!expectedName || !/^[a-f0-9]{64}$/.test(String(sha256 || ''))) return null;
    const matches = this.database.prepare('SELECT id,relative_path FROM dataset_files WHERE dataset_id=? AND sha256=? ORDER BY relative_path,id')
      .all(datasetId, sha256).filter((row) => pathBasename(row.relative_path).toLocaleLowerCase('en-US') === expectedName);
    return matches.length === 1 ? matches[0].id : null;
  }

  listSets(datasetId) {
    return this.database.prepare(`SELECT sets.*,provenance.*,COUNT(points.id) point_count FROM gcp_sets sets
      LEFT JOIN gcp_import_provenance provenance ON provenance.set_id=sets.id
      LEFT JOIN gcp_points points ON points.set_id=sets.id WHERE sets.dataset_id=?
      GROUP BY sets.id ORDER BY sets.created_at DESC,sets.id DESC`).all(datasetId).map((row) => this.set(row));
  }

  getSet(id, includePoints = false) {
    const result = this.set(this.database.prepare(`SELECT sets.*,provenance.*,COUNT(points.id) point_count FROM gcp_sets sets
      LEFT JOIN gcp_import_provenance provenance ON provenance.set_id=sets.id
      LEFT JOIN gcp_points points ON points.set_id=sets.id WHERE sets.id=? GROUP BY sets.id`).get(id));
    if (result && includePoints) result.points = this.database.prepare('SELECT * FROM gcp_points WHERE set_id=? ORDER BY external_id,id').all(id).map((row) => this.point(row));
    return result || null;
  }

  getPoint(id) { return this.point(this.database.prepare('SELECT * FROM gcp_points WHERE id=?').get(id)) || null; }

  importSet({ datasetId, displayName, sourceFormat, sourceFileId = null, sourceFilename = null, sourceSha256, sourceContent, crs, elevationUnits, provenance, points, createdBy }) {
    provenance ||= { adapter: sourceFormat, coordinateSystem: crs, verticalDatum: 'unspecified', linearUnit: elevationUnits };
    const dataset = this.dataset(datasetId);
    if (!dataset || dataset.status !== 'finalized')
      throw Object.assign(new Error('dataset is not available for GCP import'), { code: 'dataset_not_available' });
    if (sourceFileId) {
      const source = this.database.prepare('SELECT id,relative_path,sha256 FROM dataset_files WHERE id=? AND dataset_id=?').get(sourceFileId, datasetId);
      if (!source || source.sha256 !== sourceSha256 || (sourceFilename&&pathBasename(source.relative_path).toLocaleLowerCase('en-US')!==pathBasename(sourceFilename).toLocaleLowerCase('en-US')))
        throw Object.assign(new Error('GCP source file does not match this dataset and input'), { code: 'invalid_source_file' });
    }
    const sourceByteSize=Buffer.byteLength(String(sourceContent||''),'utf8');
    if(!sourceContent||sourceByteSize>2*1024*1024)throw Object.assign(new Error('GCP source content is invalid'),{code:'invalid_gcp_input'});
    if(crypto.createHash('sha256').update(sourceContent,'utf8').digest('hex')!==sourceSha256)
      throw Object.assign(new Error('GCP source checksum does not match its content'),{code:'invalid_gcp_input'});
    const id = crypto.randomUUID(), timestamp = now();
    return this.transaction(() => {
      this.database.prepare(`INSERT INTO gcp_sets(id,dataset_id,display_name,source_format,source_file_id,source_filename,
        source_sha256,source_content,source_byte_size,crs,elevation_units,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, datasetId, bounded(displayName, 160), sourceFormat === 'emlid-all-columns-v1' ? 'generic-csv-v1' : sourceFormat, sourceFileId,
          bounded(sourceFilename, 240) || null, sourceSha256,sourceContent,sourceByteSize,crs, elevationUnits, createdBy || null, timestamp, timestamp);
      this.database.prepare(`INSERT INTO gcp_import_provenance(set_id,adapter,coordinate_system,vertical_datum,linear_unit,elevation_source,geographic_cross_check,source_sha256,confirmed_by,confirmed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,provenance.adapter,provenance.coordinateSystem,provenance.verticalDatum,provenance.linearUnit,
          provenance.elevationSource||null,provenance.geographicCrossCheck||null,sourceSha256,createdBy||null,timestamp);
      const insert = this.database.prepare(`INSERT INTO gcp_points(id,set_id,external_id,label,latitude,longitude,elevation_m,
        description,created_at,updated_at,easting,northing,ellipsoidal_height_m) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const point of points)
        insert.run(pointId(id, point.externalId), id, point.externalId, point.label, point.latitude, point.longitude,
          point.elevationM, point.description, timestamp, timestamp, point.easting ?? null, point.northing ?? null, point.ellipsoidalHeightM ?? null);
      return this.getSet(id, true);
    });
  }

  updatePoint(id, patch) {
    const current = this.getPoint(id);
    if (!current) return null;
    const next = {
      label: patch.label === undefined ? current.label : bounded(patch.label, 160),
      latitude: patch.latitude === undefined ? current.latitude : patch.latitude,
      longitude: patch.longitude === undefined ? current.longitude : patch.longitude,
      elevationM: patch.elevationM === undefined ? current.elevationM : patch.elevationM,
      description: patch.description === undefined ? current.description : bounded(patch.description, 2000) || null,
    };
    if (!next.label || !finite(next.latitude) || next.latitude < -90 || next.latitude > 90 ||
      !finite(next.longitude) || next.longitude < -180 || next.longitude > 180 ||
      !finite(next.elevationM) || next.elevationM < -12000 || next.elevationM > 100000)
      throw Object.assign(new Error('invalid GCP point'), { code: 'invalid_gcp_point' });
    this.database.prepare(`UPDATE gcp_points SET label=?,latitude=?,longitude=?,elevation_m=?,description=?,updated_at=? WHERE id=?`)
      .run(next.label, next.latitude, next.longitude, next.elevationM, next.description, now(), id);
    return this.getPoint(id);
  }

  deletePoint(id) { return this.database.prepare('DELETE FROM gcp_points WHERE id=?').run(id).changes === 1; }
  deleteSet(id) { return this.database.prepare('DELETE FROM gcp_sets WHERE id=?').run(id).changes === 1; }

  listRankedImages(datasetId, selectedPointId, limit = 100) {
    const point = selectedPointId ? this.database.prepare(`SELECT points.* FROM gcp_points points JOIN gcp_sets sets ON sets.id=points.set_id
      WHERE points.id=? AND sets.dataset_id=?`).get(selectedPointId, datasetId) : null;
    if (selectedPointId && !point) throw Object.assign(new Error('GCP point is not in this dataset'), { code: 'invalid_gcp_point' });
    const count = Math.max(1, Math.min(200, Number(limit) || 100));
    let rows;
    if (point) {
      const longitudeScale = Math.max(0.01, Math.cos(Number(point.latitude) * Math.PI / 180));
      rows = this.database.prepare(`SELECT files.*,ranking.horizontal_accuracy_m,ranking.footprint_radius_m FROM dataset_files files
        LEFT JOIN gcp_image_ranking_metadata ranking ON ranking.dataset_file_id=files.id
        WHERE files.dataset_id=? AND latitude IS NOT NULL AND longitude IS NOT NULL
        AND COALESCE(mime_type,content_type) LIKE 'image/%' ORDER BY ((latitude-?)*(latitude-?))+(((longitude-?)*?)*((longitude-?)*?)) ASC,files.id ASC LIMIT ?`)
        .all(datasetId, point.latitude, point.latitude, point.longitude, longitudeScale, point.longitude, longitudeScale, count);
    } else {
      rows = this.database.prepare(`SELECT * FROM dataset_files WHERE dataset_id=? AND latitude IS NOT NULL AND longitude IS NOT NULL
        AND COALESCE(mime_type,content_type) LIKE 'image/%' ORDER BY captured_at,relative_path,id LIMIT ?`).all(datasetId, count);
    }
    const images = rows.map((row) => ({
      id: row.id, datasetId: row.dataset_id, relativePath: row.relative_path,
      mimeType: row.mime_type || row.content_type, capturedAt: row.captured_at,
      latitude: Number(row.latitude), longitude: Number(row.longitude),
      altitudeM: row.altitude_m == null ? null : Number(row.altitude_m),
      horizontalAccuracyM: row.horizontal_accuracy_m == null ? null : Number(row.horizontal_accuracy_m),
      footprintRadiusM: row.footprint_radius_m == null ? null : Number(row.footprint_radius_m),
      width: row.width == null ? null : Number(row.width), height: row.height == null ? null : Number(row.height),
      distanceM: point ? haversineMeters(Number(point.latitude), Number(point.longitude), Number(row.latitude), Number(row.longitude)) : null,
    }));
    if (point) images.sort((left, right) => left.distanceM - right.distanceM || left.id.localeCompare(right.id));
    return { images, selectedPoint: point ? this.point(point) : null };
  }

  getDatasetImage(datasetId, fileId) {
    return this.database.prepare(`SELECT files.*,datasets.root_key,datasets.relative_path dataset_relative_path,datasets.storage_mode,datasets.status dataset_status
      FROM dataset_files files JOIN datasets ON datasets.id=files.dataset_id
      WHERE files.dataset_id=? AND files.id=? AND COALESCE(files.mime_type,files.content_type) LIKE 'image/%'`).get(datasetId, fileId) || null;
  }

  listCorrespondences(taskId) {
    return this.database.prepare('SELECT * FROM gcp_image_correspondences WHERE task_id=? ORDER BY created_at,id')
      .all(taskId).map((row) => this.correspondence(row));
  }

  listOdmCorrespondences(taskId) {
    return this.database.prepare(`SELECT points.longitude,points.latitude,points.elevation_m elevationM,
      marks.pixel_x pixelX,marks.pixel_y pixelY,files.relative_path relativePath
      FROM gcp_image_correspondences marks
      JOIN gcp_points points ON points.id=marks.gcp_point_id
      JOIN dataset_files files ON files.id=marks.dataset_file_id
      WHERE marks.task_id=? ORDER BY points.external_id,files.relative_path,marks.id`).all(taskId);
  }

  getCorrespondence(id) { return this.correspondence(this.database.prepare('SELECT * FROM gcp_image_correspondences WHERE id=?').get(id)) || null; }

  validateImageCoordinates(imageFileId, pixelX, pixelY) {
    if (!finite(pixelX) || pixelX < 0 || !finite(pixelY) || pixelY < 0)
      throw Object.assign(new Error('pixel coordinates must be non-negative finite numbers'), { code: 'invalid_pixel_coordinates' });
    const image=this.database.prepare('SELECT COALESCE(mime_type,content_type) mime_type,width,height FROM dataset_files WHERE id=?').get(imageFileId);
    if(!image||!String(image.mime_type||'').startsWith('image/'))
      throw Object.assign(new Error('the correspondence target must be a dataset image'),{code:'invalid_gcp_image'});
    if((image.width!=null&&pixelX>=Number(image.width))||(image.height!=null&&pixelY>=Number(image.height)))
      throw Object.assign(new Error('pixel coordinates are outside the indexed image bounds'),{code:'gcp_pixel_out_of_bounds'});
  }

  createCorrespondence({ taskId, pointId: selectedPointId, imageFileId, pixelX, pixelY, createdBy }) {
    this.validateImageCoordinates(imageFileId,pixelX,pixelY);
    const id = crypto.randomUUID(), timestamp = now();
    try {
      this.database.prepare(`INSERT INTO gcp_image_correspondences(id,task_id,gcp_point_id,dataset_file_id,pixel_x,pixel_y,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, taskId, selectedPointId, imageFileId, pixelX, pixelY, createdBy || null, timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed'))
        throw Object.assign(new Error('this image is already marked for the selected point'), { code: 'correspondence_exists' });
      if (String(error.message).includes('gcp_dataset_mismatch'))
        throw Object.assign(new Error('task, GCP, and image must belong to one dataset'), { code: 'gcp_dataset_mismatch' });
      throw error;
    }
    return this.getCorrespondence(id);
  }

  updateCorrespondence(id, { pixelX, pixelY }) {
    const current=this.database.prepare('SELECT dataset_file_id FROM gcp_image_correspondences WHERE id=?').get(id);
    if(!current)return null;
    this.validateImageCoordinates(current.dataset_file_id,pixelX,pixelY);
    const changed = this.database.prepare('UPDATE gcp_image_correspondences SET pixel_x=?,pixel_y=?,updated_at=? WHERE id=?')
      .run(pixelX, pixelY, now(), id);
    return changed.changes ? this.getCorrespondence(id) : null;
  }

  deleteCorrespondence(id) { return this.database.prepare('DELETE FROM gcp_image_correspondences WHERE id=?').run(id).changes === 1; }
}

module.exports = { GcpRepository, haversineMeters, pointId };
