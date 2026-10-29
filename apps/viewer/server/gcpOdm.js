'use strict';

const path = require('node:path');

function scalar(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw Object.assign(new Error(`invalid ${field} in GCP correspondence`), { code: 'invalid_gcp_correspondence' });
  return Number.isInteger(number) ? String(number) : number.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

function odmGcpList(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const projected = options.projected === true && options.epsgCode === 7541;
  const lines = [projected ? 'EPSG:7541' : 'EPSG:4326'];
  for (const row of rows) {
    const imageName = path.basename(String(row.relativePath || ''));
    if (!imageName || /\s/.test(imageName))
      throw Object.assign(new Error('ODM GCP image basenames cannot contain whitespace'), { code: 'invalid_gcp_image_name' });
    // ODM's documented ordering is geo_x geo_y geo_z im_x im_y image_name.
    // In EPSG:4326, x is longitude and y is latitude.
    lines.push([
      scalar(projected ? row.easting : row.longitude, projected ? 'easting' : 'longitude'), scalar(projected ? row.northing : row.latitude, projected ? 'northing' : 'latitude'), scalar(row.elevationM, 'elevation'),
      scalar(row.pixelX, 'pixel X'), scalar(row.pixelY, 'pixel Y'), imageName,
    ].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { odmGcpList };
