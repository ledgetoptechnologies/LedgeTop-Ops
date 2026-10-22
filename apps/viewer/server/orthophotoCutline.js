'use strict';
const fs = require('node:fs');

// WebODM's cutline.gpkg product is odm_orthophoto/cutline.gpkg.
// Accept explicitly named GeoJSON exports too, never arbitrary JSON/archives.
const CUTLINE_PATTERN = /(^|\/)odm_orthophoto\/(?:cutline|odm_orthophoto_cutline|orthophoto_cutline)\.(?:gpkg|geojson)$/i;
const CUTLINE_PATHS = ['cutline.gpkg','cutline.geojson','odm_orthophoto_cutline.gpkg','odm_orthophoto_cutline.geojson','orthophoto_cutline.gpkg','orthophoto_cutline.geojson'].map(name => `odm_orthophoto/${name}`);

function validateCutlineFile(file) {
  if (!CUTLINE_PATTERN.test(file.relativePath)) return false;
  const stat = fs.lstatSync(file.absolutePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return false;
  if (/\.gpkg$/i.test(file.relativePath)) {
    const header = Buffer.alloc(100), fd = fs.openSync(file.absolutePath, 'r');
    try {
      return fs.readSync(fd, header, 0, 100, 0) === 100 && header.subarray(0,16).equals(Buffer.from('SQLite format 3\0')) && header.readUInt32BE(68) === 0x47504b47;
    } finally { fs.closeSync(fd); }
  }
  if (stat.size > 8 * 1024 * 1024) return false;
  try {
    const json=JSON.parse(fs.readFileSync(file.absolutePath,'utf8'));
    const ring = points => Array.isArray(points) && points.length >= 4 && points.every(p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite)) && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1];
    const polygon = rings => Array.isArray(rings) && rings.length > 0 && rings.every(ring);
    const geometry = g => g?.type === 'Polygon' ? polygon(g.coordinates) : g?.type === 'MultiPolygon' && Array.isArray(g.coordinates) && g.coordinates.length > 0 && g.coordinates.every(polygon);
    return json.type === 'FeatureCollection' ? Array.isArray(json.features) && json.features.length > 0 && json.features.every(f => f?.type === 'Feature' && geometry(f.geometry)) : json.type === 'Feature' ? geometry(json.geometry) : geometry(json);
  } catch { return false; }
}

module.exports = { CUTLINE_PATTERN, CUTLINE_PATHS, validateCutlineFile };
