'use strict';

// Pure, deliberately narrow producer contract. Call only with server-owned receipts
// and inventories hashed from one immutable provider response (see contract doc).
const crypto = require('node:crypto');
const path = require('node:path');
const CONTRACT = 'odm-3.5.6-native-gps-metres-v1';
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const empty = value => value === null || value === '';
const unknown = reason => ({ status: 'unknown', reason });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const safePath = value => typeof value === 'string' && value.length <= 2048 && !/[\\\x00-\x1f:]/.test(value) && !value.startsWith('/') && value.split('/').every(x => x && x !== '.' && x !== '..');
const SOURCE_PATHS = new Map([
  ['odm_georeferencing/odm_georeferenced_model.laz', 'pointCloud'],
  ['odm_dem/dsm.tif', 'dsm'], ['odm_dem/dtm.tif', 'dtm'],
]);

function inventory(files) {
  if (!Array.isArray(files) || !files.length || files.length > 100000) return null;
  const found = new Map();
  for (const file of files) {
    if (!object(file) || !safePath(file.relativePath) || !digest(file.sha256) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0) return null;
    const key = file.relativePath.toLowerCase();
    if (found.has(key)) return null;
    found.set(key, file);
  }
  return found;
}
function artifact(input, name, files) {
  const item = input?.[name];
  if (!object(item) || !Buffer.isBuffer(item.bytes) || item.bytes.length > MAX_ARTIFACT_BYTES || !safePath(item.relativePath)) return null;
  const entry = files.get(item.relativePath.toLowerCase());
  if (!entry || entry.relativePath !== item.relativePath || entry.byteSize !== item.bytes.length || hash(item.bytes) !== entry.sha256) return null;
  return { text: item.bytes.toString('utf8'), sha256: entry.sha256 };
}

function resolveOdmSourceUnitProvenance(input = {}) {
  try { return resolve(input); } catch { return unknown('malformed_evidence'); }
}
function resolve(input) {
  const receipt = input.receipt;
  // These fields are trusted integration records, not claims from log.json.
  if (!object(receipt) || receipt.operation !== 'create' || receipt.status !== 'completed' ||
      typeof receipt.providerTaskId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(receipt.providerTaskId) ||
      receipt.providerTaskId !== receipt.completedTaskId || !digest(receipt.archiveSha256) || !digest(receipt.inputManifestSha256)) return unknown('unbound_provider_result');
  const source = input.source;
  const files = inventory(input.archiveFiles), images = inventory(input.inputFiles);
  if (!files || !images || !object(source)) return unknown('invalid_inventory');
  const canonical = input.inputFiles.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 }));
  if (hash(JSON.stringify(canonical)) !== receipt.inputManifestSha256) return unknown('input_manifest_changed');
  const names = new Set();
  for (const image of images.values()) {
    const name = path.posix.basename(image.relativePath);
    if (image.byteSize === 0 || !/\.(jpe?g|tiff?)$/i.test(name) || /_mask\./i.test(name) || names.has(name)) return unknown('non_native_image_inputs');
    names.add(name);
  }
  // ODM auto-discovers these even when executed option values are null.
  if ([...files.keys()].some(name => /(^|\/)(gcp_list(?:_utm)?\.txt|geo\.txt|align\.(las|laz|tif)|alignment_matrix\.json)$/.test(name) || /^submodels\//.test(name))) return unknown('custom_or_split_pipeline');
  const logArtifact = artifact(input, 'log', files), coordsArtifact = artifact(input, 'coords', files), photosArtifact = artifact(input, 'photos', files);
  if (!logArtifact || !coordsArtifact || !photosArtifact || !['log.json', 'assets/log.json'].includes(input.log.relativePath) ||
      input.coords.relativePath !== 'odm_georeferencing/coords.txt' || input.photos.relativePath !== 'images.json') return unknown('missing_native_artifacts');
  for (const name of ['log.json', 'assets/log.json']) {
    if (files.has(name) && files.get(name).sha256 !== logArtifact.sha256) return unknown('ambiguous_producer_logs');
  }
  const log = JSON.parse(logArtifact.text);
  if (!object(log) || log.odmVersion !== '3.5.6' || Object.hasOwn(log, 'engine') || Object.hasOwn(log, 'version')) return unknown('unaudited_engine_version');
  if (log.success !== true || Object.hasOwn(log, 'error') || !Number.isSafeInteger(log.images) || log.images !== images.size ||
      !Number.isFinite(Date.parse(log.startTime)) || !Number.isFinite(Date.parse(log.endTime)) || Date.parse(log.endTime) < Date.parse(log.startTime) ||
      !finite(log.totalTime) || log.totalTime < 0 || !Array.isArray(log.processes) || !log.processes.length ||
      log.processes.some(p => !object(p) || p.exitCode !== 0)) return unknown('incomplete_processing');
  const opts = log.options;
  if (!object(opts) || ['gcp','geo','align','sm_cluster','split_image_groups','rerun','rerun_from'].some(key => !Object.hasOwn(opts, key) || !empty(opts[key])) ||
      opts.rerun_all !== false || opts.end_with !== 'odm_postprocess' || !Number.isSafeInteger(opts.split) || opts.split <= log.images ||
      !finite(opts.gps_z_offset)) return unknown('unsupported_execution_options');
  const stages = log.stages;
  const required = ['dataset', 'opensfm', 'odm_georeferencing', 'odm_postprocess'];
  if (!Array.isArray(stages) || required.some(name => !stages.some(s => s?.name === name)) ||
      stages[0]?.name !== 'dataset' || stages.at(-1)?.name !== 'odm_postprocess') return unknown('incomplete_pipeline');
  // Fail closed for documented cached/no-georef paths, not arbitrary log wording
  // as affirmative proof. Fresh-create receipt is also mandatory.
  for (const stage of stages) {
    if (!Array.isArray(stage.messages)) return unknown('incomplete_pipeline');
    for (const message of stage.messages) {
      if (!object(message) || typeof message.message !== 'string') return unknown('incomplete_pipeline');
      if (/not georeferenced|ungeoreferenced|pseudo.?georeferenc|could not generate coordinates|coordinates file already exist|model geo file already exist|found existing outputs|found image geolocation file|generated coords file from GCP/i.test(message.message)) return unknown('non_native_or_reused_outputs');
    }
  }
  const photos = JSON.parse(photosArtifact.text);
  if (!Array.isArray(photos) || photos.length !== images.size || new Set(photos.map(p => p?.filename)).size !== images.size || photos.some(p =>
    !object(p) || !names.has(p.filename) || !finite(p.latitude) || Math.abs(p.latitude) > 90 || !finite(p.longitude) || Math.abs(p.longitude) > 180 || !finite(p.altitude))) return unknown('missing_native_gps');
  const lines = coordsArtifact.text.trim().split(/\r?\n/), match = /^WGS84 UTM ([1-9]|[1-5][0-9]|60)([NS])$/.exec(lines[0]);
  const numeric = line => line.trim().split(/\s+/).map(Number);
  if (!match || lines.length !== photos.length + 2 || numeric(lines[1]).length !== 2 || numeric(lines[1]).some(n => !Number.isFinite(n)) ||
      lines.slice(2).some(line => numeric(line).length !== 3 || numeric(line).some(n => !Number.isFinite(n)))) return unknown('invalid_native_coordinates');
  // Native extract_utm_coords preserves altitude and image order.
  if (lines.slice(2).some((line, index) => Math.abs(numeric(line)[2] - photos[index].altitude) > 1e-7)) return unknown('native_altitude_mismatch');
  const epsg = (match[2] === 'N' ? 32600 : 32700) + Number(match[1]);
  const entry = files.get(source.relativePath?.toLowerCase());
  if (!entry || entry.relativePath !== source.relativePath || SOURCE_PATHS.get(source.relativePath) !== source.kind ||
      source.sha256 !== entry.sha256 || source.byteSize !== entry.byteSize || source.horizontalEpsg !== epsg) return unknown('source_binding_mismatch');
  if (source.verticalUnit !== null && source.verticalUnit !== 'metre') return unknown('explicit_vertical_unit_conflict');
  if (['dsm','dtm'].includes(source.kind) && (opts[source.kind] !== true || !stages.some(s => s.name === 'odm_dem'))) return unknown('missing_dem_generation');
  return { status: 'resolved', contract: CONTRACT, verticalUnit: 'metre', verticalDatum: 'unknown', engine: 'ODM', engineVersion: '3.5.6',
    sourceSha256: source.sha256, sourceByteSize: source.byteSize, sourceKind: source.kind, horizontalEpsg: epsg,
    archiveSha256: receipt.archiveSha256, inputManifestSha256: receipt.inputManifestSha256,
    logSha256: logArtifact.sha256, coordsSha256: coordsArtifact.sha256, photosSha256: photosArtifact.sha256,
    gpsZOffsetMetres: opts.gps_z_offset };
}
module.exports = { resolveOdmSourceUnitProvenance, MAX_ARTIFACT_BYTES, CONTRACT };
