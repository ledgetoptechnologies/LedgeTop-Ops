'use strict';

const crypto = require('node:crypto');

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_POINTS = 5000;
const CSV_REQUIRED = ['point_id', 'label', 'latitude', 'longitude', 'elevation_m'];
const EMLID_REQUIRED = ['name', 'easting', 'northing', 'elevation', 'latitude', 'longitude', 'ellipsoidal height', 'cs name'];

function invalid(message, code = 'invalid_gcp_input') {
  return Object.assign(new Error(message), { code });
}

function text(value, maximum, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw invalid(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw invalid(`${field} must be text`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) throw invalid(`${field} is invalid`);
  return normalized || null;
}

function number(value, field, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum)
    throw invalid(`${field} is outside its accepted range`);
  return parsed;
}

function canonicalPoint(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`point ${index + 1} is invalid`);
  const point = {
    externalId: text(value.externalId, 120, `point ${index + 1} point_id`, { required: true }),
    label: text(value.label, 160, `point ${index + 1} label`, { required: true }),
    latitude: number(value.latitude, `point ${index + 1} latitude`, -90, 90),
    longitude: number(value.longitude, `point ${index + 1} longitude`, -180, 180),
    elevationM: number(value.elevationM, `point ${index + 1} elevation_m`, -12000, 100000),
    description: text(value.description, 2000, `point ${index + 1} description`),
  };
  if (value.easting != null) point.easting = number(value.easting, `point ${index + 1} easting`, -100000000, 100000000);
  if (value.northing != null) point.northing = number(value.northing, `point ${index + 1} northing`, -100000000, 100000000);
  if (value.ellipsoidalHeightM != null) point.ellipsoidalHeightM = number(value.ellipsoidalHeightM, `point ${index + 1} ellipsoidal height`, -12000, 100000);
  return point;
}

function normalizedHeaders(row) {
  return row.map((cell) => cell.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, ' '));
}

function parseEmlid(source, declarations = {}) {
  const rows = parseCsvRows(source.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw invalid('Emlid CSV must include a header and at least one point');
  const headers = normalizedHeaders(rows[0]);
  if (new Set(headers).size !== headers.length) throw invalid('Emlid CSV headers must be unique');
  for (const required of EMLID_REQUIRED)
    if (!headers.includes(required)) throw invalid(`Emlid CSV is missing exact column ${required}`);
  const records = rows.slice(1).map((cells, index) => {
    if (cells.length !== headers.length) throw invalid(`Emlid CSV row ${index + 2} has the wrong number of columns`);
    return Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
  });
  const coordinateSystems = new Set(records.map((record) => text(record['cs name'], 300, 'CS name', { required: true })));
  if (coordinateSystems.size !== 1) throw invalid('Emlid CSV rows must use one consistent CS name');
  const coordinateSystem = [...coordinateSystems][0];
  const declaredCoordinateSystem = text(declarations.coordinateSystem, 300, 'coordinateSystem');
  if (declaredCoordinateSystem && declaredCoordinateSystem !== coordinateSystem)
    throw invalid('declared coordinateSystem does not match Emlid CS name');
  const ftUsMarkers = (coordinateSystem.match(/\(ftUS\)/gi) || []).length;
  const meterMarkers = (coordinateSystem.match(/\(m\)/g) || []).length;
  if (ftUsMarkers && meterMarkers) throw invalid('Emlid CS name contains ambiguous linear units');
  const inferredUnit = ftUsMarkers >= 2 ? 'ftUS' : meterMarkers >= 2 ? 'm' : null;
  const declaredUnit = declarations.linearUnit == null ? null : String(declarations.linearUnit);
  if (declaredUnit && !['m', 'ftUS'].includes(declaredUnit)) throw invalid('linearUnit must be m or ftUS');
  if (inferredUnit && declaredUnit && inferredUnit !== declaredUnit)
    throw invalid('declared linearUnit does not match Emlid CS name');
  const linearUnit = inferredUnit || declaredUnit;
  if (!linearUnit) throw invalid('Emlid units are not explicit; preview and confirm linearUnit');
  const verticalDatum = text(declarations.verticalDatum, 160, 'verticalDatum') || coordinateSystem;
  const sourceToMeters = linearUnit === 'ftUS' ? 1200 / 3937 : 1;
  const points = validatePoints(records.map((record, index) => {
    const elevationM = number(record.elevation, `row ${index + 2} Elevation`, -40000000, 400000000) * sourceToMeters;
    const ellipsoidalHeightM = number(record['ellipsoidal height'], `row ${index + 2} Ellipsoidal height`, -40000000, 400000000) * sourceToMeters;
    if (Math.abs(ellipsoidalHeightM - elevationM) > 500)
      throw invalid(`Emlid CSV row ${index + 2} vertical cross-check exceeds 500 m`);
    return {
      externalId: record.name, label: record.name,
      easting: number(record.easting, `row ${index + 2} Easting`, -100000000, 100000000) * sourceToMeters,
      northing: number(record.northing, `row ${index + 2} Northing`, -100000000, 100000000) * sourceToMeters,
      elevationM, latitude: record.latitude, longitude: record.longitude,
      ellipsoidalHeightM,
      description: record.description || null,
    };
  }));
  return { points, provenance: { adapter: 'emlid-all-columns-v1', coordinateSystem, verticalDatum, linearUnit, elevationSource: 'Elevation', geographicCrossCheck: 'Latitude/Longitude/Ellipsoidal height' } };
}

function validatePoints(points) {
  if (!Array.isArray(points) || !points.length) throw invalid('at least one GCP is required');
  if (points.length > MAX_POINTS) throw invalid(`GCP input exceeds ${MAX_POINTS} points`, 'gcp_input_too_large');
  const result = points.map(canonicalPoint);
  const ids = new Set();
  for (const point of result) {
    const folded = point.externalId.toLocaleLowerCase('en-US');
    if (ids.has(folded)) throw invalid(`duplicate point_id: ${point.externalId}`);
    ids.add(folded);
  }
  return result;
}

function parseCsvRows(source) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') {
      if (value) throw invalid('quote must begin at the start of a CSV field');
      quoted = true;
    } else if (character === ',') {
      row.push(value); value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, '')); value = '';
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else value += character;
  }
  if (quoted) throw invalid('CSV contains an unterminated quoted field');
  row.push(value.replace(/\r$/, ''));
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseCsv(source) {
  const rows = parseCsvRows(source.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw invalid('CSV must include a header and at least one point');
  const headers = rows[0].map((cell) => cell.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw invalid('CSV headers must be unique');
  for (const required of CSV_REQUIRED)
    if (!headers.includes(required)) throw invalid(`CSV is missing required column ${required}`);
  const allowed = new Set([...CSV_REQUIRED, 'description']);
  if (headers.some((header) => !allowed.has(header)))
    throw invalid('CSV contains unsupported columns; use the documented generic-v1 schema');
  return validatePoints(rows.slice(1).map((cells, index) => {
    if (cells.length !== headers.length) throw invalid(`CSV row ${index + 2} has the wrong number of columns`);
    const record = Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
    return {
      externalId: record.point_id,
      label: record.label,
      latitude: record.latitude,
      longitude: record.longitude,
      elevationM: record.elevation_m,
      description: record.description,
    };
  }));
}

function parseGeoJson(source) {
  let value;
  try { value = JSON.parse(source); }
  catch { throw invalid('GeoJSON is not valid JSON'); }
  if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features))
    throw invalid('GeoJSON must be a FeatureCollection');
  return validatePoints(value.features.map((feature, index) => {
    if (!feature || feature.type !== 'Feature' || feature.geometry?.type !== 'Point' ||
      !Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length < 3)
      throw invalid(`GeoJSON feature ${index + 1} must be a 3D Point`);
    const properties = feature.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties))
      throw invalid(`GeoJSON feature ${index + 1} requires properties`);
    return {
      externalId: properties.point_id,
      label: properties.label,
      longitude: feature.geometry.coordinates[0],
      latitude: feature.geometry.coordinates[1],
      elevationM: feature.geometry.coordinates[2],
      description: properties.description,
    };
  }));
}

function parseGcpInterchange({ format, content, declarations }) {
  if (!['generic-csv-v1', 'generic-geojson-v1', 'emlid-all-columns-v1'].includes(format))
    throw invalid('unsupported GCP format', 'unsupported_gcp_format');
  if (typeof content !== 'string' || !content.trim()) throw invalid('GCP content is required');
  if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES)
    throw invalid('GCP input is too large', 'gcp_input_too_large');
  const emlid = format === 'emlid-all-columns-v1' ? parseEmlid(content, declarations) : null;
  const points = emlid?.points || (format === 'generic-csv-v1' ? parseCsv(content) : parseGeoJson(content));
  return {
    crs: 'EPSG:4326',
    elevationUnits: 'm',
    sourceSha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    points,
    provenance: emlid?.provenance || { adapter: format, coordinateSystem: 'EPSG:4326', verticalDatum: 'declared by source', linearUnit: 'm' },
  };
}

function confirmationToken(parsed) {
  return crypto.createHash('sha256').update(JSON.stringify({ sourceSha256: parsed.sourceSha256, provenance: parsed.provenance, pointCount: parsed.points.length })).digest('hex');
}

module.exports = {
  CSV_REQUIRED,
  MAX_POINTS,
  MAX_SOURCE_BYTES,
  EMLID_REQUIRED,
  parseGcpInterchange,
  confirmationToken,
};
