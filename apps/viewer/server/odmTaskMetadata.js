'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_STATS_BYTES = 8 * 1024 * 1024;
const MAX_PROJ_BYTES = 16 * 1024;
const MAX_ORIGIN_PREFIX_BYTES = 4096;
const MAX_BOUNDS_BYTES = 8 * 1024 * 1024;

function optionalRegularFile(root, relativePath, maxBytes = Number.MAX_SAFE_INTEGER) {
  let current = path.resolve(root);
  for (const part of relativePath.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return null;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return null;
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.size > maxBytes) return null;
  return current;
}

function firstOptionalRegularFile(root, relativePath, maxBytes) {
  return optionalRegularFile(root, relativePath, maxBytes)
    || optionalRegularFile(root, `assets/${relativePath}`, maxBytes);
}

function firstOptionalRegularFileUnbounded(root, relativePath) {
  return optionalRegularFile(root, relativePath)
    || optionalRegularFile(root, `assets/${relativePath}`);
}

function readPrefix(file, maxBytes) {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf8');
  } finally {
    fs.closeSync(handle);
  }
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safePointCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseCrs(projText) {
  const raw = String(projText || '').trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 4096);
  if (!raw) return {};
  const epsg = Number(raw.match(/(?:EPSG[:=]|\+init=epsg:)(\d{3,6})/i)?.[1]) || null;
  let utmZone = Number(raw.match(/(?:^|\s)\+zone=(\d{1,2})(?:\s|$)/)?.[1]) || null;
  let hemisphere = /(?:^|\s)\+south(?:\s|$)/.test(raw) ? 'S' : 'N';
  if (epsg >= 32601 && epsg <= 32660) { utmZone = epsg - 32600; hemisphere = 'N'; }
  if (epsg >= 32701 && epsg <= 32760) { utmZone = epsg - 32700; hemisphere = 'S'; }
  if (utmZone !== null && (utmZone < 1 || utmZone > 60)) utmZone = null;
  const wgs84 = /(?:^|\s)\+(?:datum=WGS84|ellps=WGS84)(?:\s|$)/i.test(raw) || (epsg >= 32601 && epsg <= 32760);
  let crs = epsg ? `EPSG:${epsg}` : null;
  if (!crs && utmZone && /(?:^|\s)\+proj=utm(?:\s|$)/.test(raw)) crs = `${wgs84 ? 'WGS 84 / ' : ''}UTM zone ${utmZone}${hemisphere}`;
  return {
    ...(crs ? { crs } : {}), proj: raw, ...(epsg ? { epsg } : {}),
    ...(utmZone ? { utmZone, hemisphere, utmZoneLon0Deg: utmZone * 6 - 183 } : {}),
  };
}

function parseOdmCoordinateOrigin(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const crs = lines[0].match(/^(?:WGS\s*84\s+)?UTM\s+(?:zone\s+)?(\d{1,2})\s*([NS])$/i);
  if (!crs) return null;
  const utmZone = Number(crs[1]), hemisphere = crs[2].toUpperCase();
  if (!Number.isSafeInteger(utmZone) || utmZone < 1 || utmZone > 60) return null;
  const parts = lines[1].split(/\s+/);
  if (parts.length !== 2 && parts.length !== 3) return null;
  const numbers = parts.map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const [e, n, z = 0] = numbers;
  if (Math.abs(e) > 2_000_000 || Math.abs(n) > 20_000_000 || Math.abs(z) > 1_000_000) return null;
  return { utmZone, hemisphere, utmZoneLon0Deg: utmZone * 6 - 183, rtc: { e, n, z } };
}

function parseBounds(value) {
  if (Array.isArray(value) && value.length === 6) {
    if (!value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) return null;
    const [minx, miny, minz, maxx, maxy, maxz] = value;
    if ([minx, miny, minz, maxx, maxy, maxz].every(Number.isFinite)
      && minx <= maxx && miny <= maxy && minz <= maxz) return { minx, miny, minz, maxx, maxy, maxz };
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = ['minx', 'miny', 'minz', 'maxx', 'maxy', 'maxz'];
  if (!keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))) return null;
  const bounds = Object.fromEntries(keys.map((key) => [key, value[key]]));
  if (Object.values(bounds).every(Number.isFinite)
    && bounds.minx <= bounds.maxx && bounds.miny <= bounds.maxy && bounds.minz <= bounds.maxz) return bounds;
  return null;
}

function readJson(root, relativePath, strictIo = false) {
  const file = firstOptionalRegularFile(root, relativePath, MAX_BOUNDS_BYTES);
  if (!file) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (strictIo) throw error; return null; }
  try { return JSON.parse(text); } catch { return null; }
}

function compatibleCoordinateSystems(projected, origin) {
  if (!projected?.utmZone) return true;
  return projected.utmZone === origin.utmZone && projected.hemisphere === origin.hemisphere;
}

function readOdmTaskMetadata(root, { strictGeorefIo = false } = {}) {
  const result = { processingMetrics: {}, georef: {}, pointCount: null };
  const statsPath = firstOptionalRegularFile(root, 'odm_report/stats.json', MAX_STATS_BYTES);
  if (statsPath) {
    try {
      const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
      const dense = stats?.point_cloud_statistics?.dense === true;
      const denseCount = safePointCount(stats?.point_cloud_statistics?.stats?.statistic?.[0]?.count);
      const sparseCount = safePointCount(stats?.reconstruction_statistics?.reconstructed_points_count);
      result.pointCount = dense && denseCount !== null ? denseCount : sparseCount;
      const averageGsdCm = finiteNonnegative(stats?.odm_processing_statistics?.average_gsd);
      const surveyedAreaM2 = finiteNonnegative(stats?.processing_statistics?.area);
      const startDate = typeof stats?.processing_statistics?.start_date === 'string' ? stats.processing_statistics.start_date.slice(0, 64) : null;
      const endDate = typeof stats?.processing_statistics?.end_date === 'string' ? stats.processing_statistics.end_date.slice(0, 64) : null;
      result.processingMetrics = {
        ...(averageGsdCm !== null ? { averageGsdM: averageGsdCm / 100 } : {}),
        ...(surveyedAreaM2 !== null ? { surveyedAreaM2 } : {}),
        ...(result.pointCount !== null ? { reconstructedPointCount: result.pointCount } : {}),
        ...(startDate ? { processingStartedAt: startDate } : {}),
        ...(endDate ? { processingEndedAt: endDate } : {}),
      };
    } catch {
      // Optional metadata must not block recovery of otherwise valid output.
    }
  }
  const projPath = firstOptionalRegularFile(root, 'odm_georeferencing/proj.txt', MAX_PROJ_BYTES);
  if (projPath) {
    try { result.georef = parseCrs(fs.readFileSync(projPath, 'utf8')); } catch (error) { if (strictGeorefIo) throw error; }
  }
  let origin = null;
  for (const relativePath of ['odm_georeferencing/odm_georeferencing_model_geo.txt', 'odm_georeferencing/coords.txt']) {
    const file = firstOptionalRegularFileUnbounded(root, relativePath);
    if (!file) continue;
    try { origin = parseOdmCoordinateOrigin(readPrefix(file, MAX_ORIGIN_PREFIX_BYTES)); } catch (error) { if (strictGeorefIo) throw error; origin = null; }
    if (origin) break;
  }
  if (origin && compatibleCoordinateSystems(result.georef, origin)) result.georef = { ...result.georef, ...origin };
  const summary = readJson(root, 'odm_georeferencing/odm_georeferenced_model.summary.json', strictGeorefIo);
  const info = readJson(root, 'odm_georeferencing/odm_georeferenced_model.info.json', strictGeorefIo);
  const ept = readJson(root, 'entwine_pointcloud/ept.json', strictGeorefIo);
  const bounds = parseBounds(summary?.summary?.bounds)
    || parseBounds(info?.stats?.bbox?.native?.bbox)
    || parseBounds(info?.stats?.bbox?.native)
    || parseBounds(ept?.boundsConforming);
  if (bounds && result.georef.rtc) {
    result.georef.bboxCenter = {
      x: (bounds.minx + bounds.maxx) / 2 - result.georef.rtc.e,
      y: (bounds.miny + bounds.maxy) / 2 - result.georef.rtc.n,
      z: (bounds.minz + bounds.maxz) / 2 - result.georef.rtc.z,
    };
  }
  return result;
}

module.exports = {
  MAX_BOUNDS_BYTES, MAX_ORIGIN_PREFIX_BYTES, MAX_PROJ_BYTES, MAX_STATS_BYTES,
  parseBounds, parseCrs, parseOdmCoordinateOrigin, readOdmTaskMetadata,
};
