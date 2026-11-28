'use strict';

const path = require('node:path');

function scalar(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw Object.assign(new Error(`invalid ${field} in GCP correspondence`), { code: 'invalid_gcp_correspondence' });
  return Number.isInteger(number) ? String(number) : number.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

// ODM splits lines on whitespace and keeps everything after the image name as
// the point's name, so a label becomes one whitespace-free token.
function labelToken(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, '_').slice(0, 160);
}

// Header EPSG:4326: x = longitude, y = latitude (the Emlid file's geographic
// coordinates). z = the point's Elevation in metres, i.e. NAVD88 orthometric
// height for an Emlid NAVD88 project. ODM reprojects x/y to a WGS84 UTM zone and
// passes z through untouched (it has no vertical datum handling), so the DSM,
// point cloud and model come out in the same NAVD88 heights the Viewer shows.
// Rows are controls only; checkpoints never reach the solve.
function odmGcpList(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const lines = ['EPSG:4326'];
  for (const row of rows) {
    const imageName = path.basename(String(row.relativePath || ''));
    if (!imageName || /\s/.test(imageName))
      throw Object.assign(new Error('ODM GCP image basenames cannot contain whitespace'), { code: 'invalid_gcp_image_name' });
    // ODM's documented ordering is geo_x geo_y geo_z im_x im_y image_name.
    // In EPSG:4326, x is longitude and y is latitude.
    lines.push([
      scalar(row.longitude, 'longitude'), scalar(row.latitude, 'latitude'), scalar(row.elevationM, 'elevation'),
      scalar(row.pixelX, 'pixel X'), scalar(row.pixelY, 'pixel Y'), imageName,
      ...(labelToken(row.label) ? [labelToken(row.label)] : []),
    ].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { odmGcpList, labelToken };
