'use strict';

// Read-only diagnostic for the dormant archive draft. A match is not authority
// to write files or finalize a journal; it is only a comparison of current DB
// state with the parsed source. Callers must use a transaction for any later
// decision and separately establish trusted storage and writer exclusion.
const crypto = require('node:crypto');

function derivedSetMatches(db, row, raw) {
  const set = db.prepare('SELECT * FROM gcp_sets WHERE id=?').get(row.id);
  if (!set || set.dataset_id !== row.dataset_id || set.display_name !== row.display_name ||
      set.created_by !== row.created_by || set.source_file_id !== null ||
      set.source_filename !== row.source_filename || set.source_sha256 !== raw.sha256 ||
      set.source_content !== raw.content || set.source_byte_size !== raw.byteSize ||
      set.source_format !== (row.source_format === 'emlid-all-columns-v1' ? 'generic-csv-v1' : row.source_format) ||
      set.crs !== raw.parsed.crs || set.elevation_units !== raw.parsed.elevationUnits ||
      !set.created_at || set.updated_at !== set.created_at) return false;
  const p = db.prepare('SELECT * FROM gcp_import_provenance WHERE set_id=?').get(row.id);
  const expected = raw.parsed.provenance;
  if (!p || p.adapter !== expected.adapter || p.coordinate_system !== expected.coordinateSystem ||
      p.vertical_datum !== expected.verticalDatum || p.linear_unit !== expected.linearUnit ||
      p.elevation_source !== (expected.elevationSource || null) ||
      p.geographic_cross_check !== (expected.geographicCrossCheck || null) ||
      p.source_sha256 !== raw.sha256 || p.confirmed_by !== row.created_by || p.confirmed_at !== set.created_at) return false;
  if (db.prepare('SELECT 1 FROM gcp_odm_crs_confirmations WHERE set_id=?').get(row.id) ||
      db.prepare('SELECT 1 FROM gcp_image_correspondences c JOIN gcp_points p ON p.id=c.gcp_point_id WHERE p.set_id=? LIMIT 1').get(row.id)) return false;
  const points = db.prepare('SELECT * FROM gcp_points WHERE set_id=?').all(row.id);
  if (points.length !== raw.parsed.points.length) return false;
  const byId = new Map(points.map(point => [point.external_id, point]));
  return raw.parsed.points.every(point => {
    const stored = byId.get(point.externalId);
    const expectedId = `gcp_${crypto.createHash('sha256').update(`${row.id}\0${point.externalId}`).digest('hex').slice(0, 32)}`;
    return stored && stored.id === expectedId && stored.label === point.label &&
      stored.latitude === point.latitude && stored.longitude === point.longitude &&
      stored.elevation_m === point.elevationM && stored.description === point.description &&
      stored.easting === (point.easting ?? null) && stored.northing === (point.northing ?? null) &&
      stored.ellipsoidal_height_m === (point.ellipsoidalHeightM ?? null) &&
      stored.created_at === set.created_at && stored.updated_at === set.created_at;
  });
}

module.exports = { derivedSetMatches };
