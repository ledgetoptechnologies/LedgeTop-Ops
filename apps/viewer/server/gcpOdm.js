'use strict';

const path = require('node:path');

function scalar(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw Object.assign(new Error(`invalid ${field} in GCP correspondence`), { code: 'invalid_gcp_correspondence' });
  return Number.isInteger(number) ? String(number) : number.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

function odmCoordinateCrs(horizontalCrs, verticalSystem) {
  const vertical = String(verticalSystem || '').replace(/[\s_()-]/g, '').toLowerCase();
  if (/^navd88(?:geoid\d+[a-z]*)?height$/.test(vertical)) {
    if (horizontalCrs === 'EPSG:6318') return 'EPSG:6349';
    throw Object.assign(new Error('NAVD88 GCP elevations require a supported compound horizontal CRS'), { code: 'invalid_gcp_correspondence' });
  }
  if (/^(?:ellipsoidal?|ellipsoid)height$/.test(vertical)) {
    if (horizontalCrs === 'EPSG:6318') return 'EPSG:6319';
    if (horizontalCrs === 'EPSG:4326') return 'EPSG:4979';
  }
  if (/^egm96height$/.test(vertical)) return `${horizontalCrs}+5773`;
  if (/^egm2008height$/.test(vertical)) return `${horizontalCrs}+3855`;
  return horizontalCrs;
}

function odmGcpList(rows, { horizontalCrs = null, verticalSystem = null, heightSource = 'source', requireSupportedTransform = false } = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const crsValues = [...new Set(rows.map((row) => row.horizontalCrs || horizontalCrs || 'EPSG:4326'))];
  if (crsValues.length !== 1 || !['EPSG:4326', 'EPSG:6318'].includes(crsValues[0]))
    throw Object.assign(new Error('GCP correspondences require one supported horizontal CRS'), { code: 'invalid_gcp_correspondence' });
  const verticalValues = [...new Set(rows.map((row) => row.verticalDatum || verticalSystem).filter(Boolean))];
  if (verticalValues.length > 1)
    throw Object.assign(new Error('GCP correspondences require one supported vertical CRS'), { code: 'invalid_gcp_correspondence' });
  if (!['source', 'ellipsoidal'].includes(heightSource))
    throw Object.assign(new Error('unsupported GCP height source'), { code: 'invalid_gcp_height_source' });
  if (heightSource === 'ellipsoidal' && rows.some((row) => row.ellipsoidalHeightM == null
    || (typeof row.ellipsoidalHeightM === 'string' && !row.ellipsoidalHeightM.trim())))
    throw Object.assign(new Error('every GCP must have a retained ellipsoidal height'), { code: 'gcp_ellipsoidal_height_missing' });
  const vertical = String(verticalValues[0] || '').replace(/[\s_()-]/g, '').toLowerCase();
  if (requireSupportedTransform && heightSource === 'source' && /^navd88(?:geoid\d+[a-z]*)?height$/.test(vertical))
    throw Object.assign(new Error('NAVD88 GCP heights require a qualified GEOID grid; choose ellipsoidal height when available'), { code: 'gcp_vertical_transform_unavailable' });
  const outputVerticalSystem = heightSource === 'ellipsoidal' ? 'ellipsoidal height' : verticalValues[0];
  const lines = [odmCoordinateCrs(crsValues[0], outputVerticalSystem)];
  for (const row of rows) {
    const imageName = path.basename(String(row.relativePath || ''));
    if (!imageName || /\s/.test(imageName))
      throw Object.assign(new Error('ODM GCP image basenames cannot contain whitespace'), { code: 'invalid_gcp_image_name' });
    // ODM's documented ordering is geo_x geo_y geo_z im_x im_y image_name.
    // In EPSG:4326, x is longitude and y is latitude.
    lines.push([
      scalar(row.longitude, 'longitude'), scalar(row.latitude, 'latitude'), scalar(heightSource === 'ellipsoidal' ? row.ellipsoidalHeightM : row.elevationM, 'elevation'),
      scalar(row.pixelX, 'pixel X'), scalar(row.pixelY, 'pixel Y'), imageName,
    ].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { odmGcpList, odmCoordinateCrs };
