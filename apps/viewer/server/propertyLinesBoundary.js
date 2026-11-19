'use strict';

// Uploaded boundary files: a fallback property-lines source for projects
// outside Wisconsin or where the state data is wrong.
//
// Staff upload one GeoJSON or KML file per processing project. The server
// sniffs and validates it, keeps only Polygon, MultiPolygon and LineString
// geometry plus an optional short plain-text name, and stores one normalized
// GeoJSON file and a small manifest at
//   <models root>/property-lines/<project id>/
// The path is built here from the project id only. The layer serves the
// stored geometry through the same live viewer check as the state layer.
//
// Datum convention (as the state layer, see propertyLines.js): coordinates
// are lon/lat and are kept exactly as supplied, with no datum transformation.
// A file exported in NAD83 lon/lat lines up with a NAD83 model as surveyed.
//
// Not in this version: shapefile (zip) and DXF. Zip input is refused.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BOUNDARY_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxFeatures: 5000,
  maxVertices: 200_000,
  maxNameLength: 80,
  maxDepth: 64,
  maxServedParcels: 800,
  manifestMaxBytes: 64 * 1024,
});

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const SOURCES = new Set(['state', 'upload']);

function fail(code, message) { return Object.assign(new Error(message || code), { code, boundaryValidation: true }); }

// ---------------------------------------------------------------- parsing --

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const decoded = value
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_m, dec) => safeChar(Number(dec)))
    .replace(/&(lt|gt|amp|quot|apos);/g, (_m, n) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" })[n]);
  const text = decoded.replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return text ? Array.from(text).slice(0, BOUNDARY_LIMITS.maxNameLength).join('') : null;
}
function safeChar(code) { return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '; }

function position(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) throw fail('invalid_coordinates', 'Each position needs a longitude and a latitude.');
  const lon = value[0], lat = value[1];
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat))
    throw fail('invalid_coordinates', 'Coordinates must be numbers.');
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90)
    throw fail('coordinates_out_of_range', 'Coordinates must be longitude and latitude in degrees. Projected (grid) coordinates are not supported.');
  return [Math.round(lon * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8];
}

function lineOf(value, counter) {
  if (!Array.isArray(value)) throw fail('invalid_geometry', 'A line must be a list of positions.');
  const out = value.map(position);
  counter.vertices += out.length;
  if (counter.vertices > BOUNDARY_LIMITS.maxVertices) throw fail('too_many_vertices', `The file has more than ${BOUNDARY_LIMITS.maxVertices} vertices.`);
  return out;
}
function ringOf(value, counter) {
  const ring = lineOf(value, counter);
  if (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) { ring.push([...ring[0]]); counter.vertices++; }
  if (ring.length < 4) throw fail('invalid_geometry', 'A polygon ring needs at least three corners.');
  return ring;
}

// Normalized geometry or null for a type we do not keep.
function keepGeometry(geometry, counter) {
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) return null;
  const c = geometry.coordinates;
  if (geometry.type === 'Polygon') {
    if (!Array.isArray(c) || !c.length) throw fail('invalid_geometry', 'A polygon needs at least one ring.');
    return { type: 'Polygon', coordinates: c.map(r => ringOf(r, counter)) };
  }
  if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(c) || !c.length) throw fail('invalid_geometry', 'A multipolygon needs at least one polygon.');
    return { type: 'MultiPolygon', coordinates: c.map(p => {
      if (!Array.isArray(p) || !p.length) throw fail('invalid_geometry', 'A polygon needs at least one ring.');
      return p.map(r => ringOf(r, counter));
    }) };
  }
  if (geometry.type === 'LineString') {
    const line = lineOf(c, counter);
    if (line.length < 2) throw fail('invalid_geometry', 'A line needs at least two positions.');
    return { type: 'LineString', coordinates: line };
  }
  return null;
}

function finish(features, dropped, format) {
  if (!features.length) throw fail('no_supported_geometry', 'The file has no polygon or line geometry.');
  let vertexCount = 0, west = 180, south = 90, east = -180, north = -90;
  const visit = (coords) => { if (typeof coords[0] === 'number') { vertexCount++; west = Math.min(west, coords[0]); east = Math.max(east, coords[0]); south = Math.min(south, coords[1]); north = Math.max(north, coords[1]); } else coords.forEach(visit); };
  for (const f of features) visit(f.geometry.coordinates);
  return {
    format,
    geojson: { type: 'FeatureCollection', features },
    featureCount: features.length,
    vertexCount,
    droppedCount: dropped,
    bbox: [west, south, east, north],
  };
}

const ALLOWED_CRS = /^(?:urn:ogc:def:crs:OGC:1\.3:CRS84|urn:ogc:def:crs:EPSG::(?:4326|4269|4258|6318)|EPSG:(?:4326|4269|6318))$/i;

function parseGeoJson(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw fail('invalid_geojson', 'The file is not valid JSON.'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw fail('invalid_geojson', 'The file is not a GeoJSON object.');
  const crsName = doc.crs?.properties?.name;
  if (doc.crs !== undefined && (typeof crsName !== 'string' || !ALLOWED_CRS.test(crsName)))
    throw fail('unsupported_crs', 'Only longitude and latitude in degrees are supported.');
  let items;
  if (doc.type === 'FeatureCollection') items = Array.isArray(doc.features) ? doc.features : null;
  else if (doc.type === 'Feature') items = [doc];
  else if (typeof doc.type === 'string') items = [{ type: 'Feature', geometry: doc, properties: null }];
  if (!items) throw fail('invalid_geojson', 'The file is not a GeoJSON feature collection, feature or geometry.');
  if (items.length > BOUNDARY_LIMITS.maxFeatures) throw fail('too_many_features', `The file has more than ${BOUNDARY_LIMITS.maxFeatures} features.`);
  const counter = { vertices: 0 }, features = [];
  let dropped = 0;
  for (const item of items) {
    if (!item || item.type !== 'Feature') { dropped++; continue; }
    const geometry = keepGeometry(item.geometry, counter);
    if (!geometry) { dropped++; continue; }
    const raw = item.properties && typeof item.properties === 'object' ? (item.properties.name ?? item.properties.Name ?? item.properties.NAME) : null;
    const name = cleanName(raw);
    features.push({ type: 'Feature', properties: name ? { name } : {}, geometry });
  }
  return finish(features, dropped, 'geojson');
}

// A small, linear KML reader. No DTD, entity declarations, external
// references or network: anything starting with "<!" other than a comment or
// CDATA is refused, and nothing in the file (links, styles, NetworkLink) is
// followed. Only Placemark names and Polygon/LineString coordinates are read.
function parseKml(text) {
  const malformed = () => fail('invalid_kml', 'The KML file is not well formed.');
  const stack = [], features = [], counter = { vertices: 0 };
  let i = 0, sawRoot = false, buffer = null, placemark = null, polygon = null, boundary = null, dropped = 0;
  // The element itself is on top of the stack in start() and end().
  const parent = () => stack[stack.length - 2];
  const tuples = (value) => value.trim().split(/\s+/).filter(Boolean).map(tuple => tuple.split(',').map(part => (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(part) ? Number(part) : NaN)));
  const addFeature = (geometry) => {
    if (features.length >= BOUNDARY_LIMITS.maxFeatures) throw fail('too_many_features', `The file has more than ${BOUNDARY_LIMITS.maxFeatures} features.`);
    features.push({ type: 'Feature', properties: {}, geometry, placemark });
  };
  const start = (name) => {
    if (name === 'Placemark') placemark = { name: null };
    else if (name === 'Polygon' && placemark) { polygon = { outer: null, inner: [] }; boundary = null; }
    else if (name === 'outerBoundaryIs' || name === 'innerBoundaryIs') boundary = name;
    else if (name === 'coordinates' && placemark) buffer = [];
    else if (name === 'name' && placemark && parent() === 'Placemark') buffer = [];
    else if (placemark && ['Point', 'Model', 'Track', 'MultiTrack'].includes(name)) dropped++;
  };
  const end = (name) => {
    if (name === 'name' && buffer && placemark && parent() === 'Placemark') { placemark.name = cleanName(buffer.join('')); buffer = null; }
    else if (name === 'coordinates' && buffer) {
      const coords = tuples(buffer.join('')); buffer = null;
      const container = parent();
      if (container === 'LineString') {
        const line = lineOf(coords, counter);
        if (line.length < 2) throw fail('invalid_geometry', 'A line needs at least two positions.');
        addFeature({ type: 'LineString', coordinates: line });
      } else if (container === 'LinearRing' && polygon && boundary) {
        const ring = ringOf(coords, counter);
        if (boundary === 'outerBoundaryIs') polygon.outer = ring; else polygon.inner.push(ring);
      }
    } else if (name === 'outerBoundaryIs' || name === 'innerBoundaryIs') boundary = null;
    else if (name === 'Polygon' && polygon) {
      if (polygon.outer) addFeature({ type: 'Polygon', coordinates: [polygon.outer, ...polygon.inner] });
      polygon = null;
    } else if (name === 'Placemark' && placemark) {
      for (const f of features) if (f.placemark === placemark) { if (placemark.name) f.properties = { name: placemark.name }; delete f.placemark; }
      placemark = null;
    }
  };
  for (;;) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { if (text.slice(i).trim() && !sawRoot) throw malformed(); break; }
    if (buffer) buffer.push(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); if (e < 0) throw malformed(); i = e + 3; continue; }
    if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt + 9); if (e < 0) throw malformed(); if (buffer) buffer.push(text.slice(lt + 9, e)); i = e + 3; continue; }
    if (text.startsWith('<?', lt)) { const e = text.indexOf('?>', lt + 2); if (e < 0) throw malformed(); i = e + 2; continue; }
    if (text.startsWith('<!', lt)) throw fail('kml_dtd_not_allowed', 'KML files with a DOCTYPE or entity declarations are not accepted.');
    const gt = text.indexOf('>', lt + 1);
    if (gt < 0) throw malformed();
    const raw = text.slice(lt + 1, gt), closing = raw.startsWith('/'), selfClosing = !closing && raw.endsWith('/');
    const qname = (closing ? raw.slice(1) : raw).trim().split(/[\s/]/)[0] || '';
    const local = qname.includes(':') ? qname.slice(qname.lastIndexOf(':') + 1) : qname;
    if (!/^[A-Za-z_][\w.-]*$/.test(local)) throw malformed();
    i = gt + 1;
    if (!sawRoot) {
      if (closing || local !== 'kml') throw fail('unsupported_format', 'The file is not GeoJSON or KML.');
      sawRoot = true;
    }
    if (closing) {
      if (stack.at(-1) !== local) throw malformed();
      end(local); stack.pop();
    } else {
      stack.push(local);
      if (stack.length > BOUNDARY_LIMITS.maxDepth) throw malformed();
      start(local);
      if (selfClosing) { end(local); stack.pop(); }
    }
  }
  if (!sawRoot || stack.length) throw malformed();
  for (const f of features) delete f.placemark;
  return finish(features, dropped, 'kml');
}

// Content sniffing: the extension and declared type are never trusted.
function parseBoundaryFile(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail('empty_file', 'The file is empty.');
  if (buffer.length > BOUNDARY_LIMITS.maxBytes) throw fail('file_too_large', 'The file is larger than 20 MB.');
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) throw fail('unsupported_format', 'Zip files (KMZ, zipped shapefiles) are not supported yet. Upload GeoJSON or KML.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer); } catch { throw fail('unsupported_format', 'The file is not UTF-8 text.'); }
  if (text.includes('\u0000')) throw fail('unsupported_format', 'The file is not a text file.');
  const lead = text.trimStart()[0];
  if (lead === '{') return parseGeoJson(text);
  if (lead === '<') return parseKml(text);
  throw fail('unsupported_format', 'The file is not GeoJSON or KML.');
}

// ------------------------------------------------------------------ store --

function writeFileDurable(file, content) {
  const fd = fs.openSync(file, 'wx', 0o640);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function fsyncDir(dir) { try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* not supported on every platform */ } }
// Write to a unique temporary name, then rename over the target (atomic on
// one filesystem). Readers see the old file or the new one, never a part.
function replaceFile(dir, name, content) {
  const temporary = path.join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
  try { writeFileDurable(temporary, content); fs.renameSync(temporary, path.join(dir, name)); } finally { fs.rmSync(temporary, { force: true }); }
  fsyncDir(dir);
}

function createBoundaryStore({ baseDir, database }) {
  if (!baseDir) throw new Error('baseDir is required');
  const cache = new Map();

  function dirFor(projectId) {
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw fail('invalid_project', 'invalid project');
    const dir = path.resolve(baseDir, projectId);
    if (path.dirname(dir) !== path.resolve(baseDir)) throw fail('invalid_project', 'invalid project');
    return dir;
  }

  function readManifest(projectId) {
    let dir;
    try { dir = dirFor(projectId); } catch { return null; }
    try {
      const file = path.join(dir, 'manifest.json'), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > BOUNDARY_LIMITS.manifestMaxBytes) return null;
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (m?.schema !== 1 || !SOURCES.has(m.source) || !/^boundary-[a-f0-9]{32}\.geojson$/.test(m.file || '') || !/^[a-f0-9]{64}$/.test(m.sha256 || '')) return null;
      return m;
    } catch { return null; }
  }

  function publicManifest(m) {
    return m && { source: m.source, format: m.format, featureCount: m.featureCount, vertexCount: m.vertexCount, droppedCount: m.droppedCount,
      bytes: m.bytes, bbox: m.bbox, uploadedAt: m.uploadedAt, sha256: m.sha256 };
  }

  function save(projectId, parsed, { bytes, sha256, actorId = null }) {
    const dir = dirFor(projectId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    const body = JSON.stringify(parsed.geojson), fileSha = crypto.createHash('sha256').update(body).digest('hex');
    const file = `boundary-${fileSha.slice(0, 32)}.geojson`;
    replaceFile(dir, file, body);
    const manifest = { schema: 1, source: 'upload', file, sha256: fileSha, sourceSha256: sha256, bytes, format: parsed.format,
      featureCount: parsed.featureCount, vertexCount: parsed.vertexCount, droppedCount: parsed.droppedCount, bbox: parsed.bbox,
      datum: 'as supplied (lon/lat, no transformation)', uploadedAt: new Date().toISOString(), uploadedBy: actorId };
    replaceFile(dir, 'manifest.json', JSON.stringify(manifest));
    prune(dir, file);
    return manifest;
  }

  function prune(dir, keep) {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === 'manifest.json' || entry === keep) continue;
      if (/^boundary-[a-f0-9]{32}\.geojson$/.test(entry) || /^\..+\.tmp$/.test(entry)) fs.rmSync(path.join(dir, entry), { force: true });
    }
  }

  function setSource(projectId, source) {
    if (!SOURCES.has(source)) throw fail('invalid_source', 'Choose state or upload.');
    const m = readManifest(projectId);
    if (!m) { if (source === 'upload') throw fail('no_upload', 'Upload a boundary file first.'); return null; }
    if (m.source === source) return m;
    const next = { ...m, source };
    replaceFile(dirFor(projectId), 'manifest.json', JSON.stringify(next));
    return next;
  }

  // Removing the manifest first switches the project back to state parcels
  // atomically; the files go after.
  function remove(projectId) {
    const dir = dirFor(projectId);
    fs.rmSync(path.join(dir, 'manifest.json'), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    for (const key of cache.keys()) if (key.startsWith(`${projectId}:`)) cache.delete(key);
  }

  function projectForModel(modelId) {
    if (!database || typeof modelId !== 'string') return null;
    try {
      const row = database.prepare(`SELECT p.id FROM model_outputs o JOIN projects p ON p.id=o.project_id
        WHERE o.model_id=? AND p.status='active' AND p.purged_at IS NULL ORDER BY o.created_at DESC LIMIT 1`).get(modelId);
      return row?.id || null;
    } catch { return null; }
  }

  // The active uploaded boundary for a model, or null (use state parcels).
  function activeForModel(modelId) {
    const projectId = projectForModel(modelId);
    const m = projectId && readManifest(projectId);
    if (!m || m.source !== 'upload') return null;
    const key = `${projectId}:${m.sha256}`;
    if (!cache.has(key)) {
      let features;
      try {
        const text = fs.readFileSync(path.join(dirFor(projectId), m.file), 'utf8');
        if (crypto.createHash('sha256').update(text).digest('hex') !== m.sha256) return null;
        features = JSON.parse(text).features.map((f, index) => toParcel(f, index));
      } catch { return null; }
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      cache.set(key, features);
    }
    return { projectId, manifest: m, parcels: cache.get(key) };
  }

  return { dirFor, readManifest, publicManifest, save, setSource, remove, projectForModel, activeForModel };
}

function toParcel(feature, index) {
  const g = feature.geometry;
  const rings = g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [g.coordinates];
  let west = 180, south = 90, east = -180, north = -90;
  for (const ring of rings) for (const [lon, lat] of ring) { west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat); }
  return { id: index + 1, rings, bbox: [west, south, east, north] };
}

function parcelsInBounds(parcels, b) {
  const hit = parcels.filter(p => p.bbox[0] <= b.east && p.bbox[2] >= b.west && p.bbox[1] <= b.north && p.bbox[3] >= b.south);
  if (hit.length > BOUNDARY_LIMITS.maxServedParcels) return { status: 'too_many', parcels: [] };
  return { status: hit.length ? 'ok' : 'none', parcels: hit.map(({ id, rings }) => ({ id, rings })) };
}

function uploadSourceDescription(manifest, disclaimer) {
  const day = String(manifest.uploadedAt || '').slice(0, 10);
  return {
    id: 'project-upload', kind: 'upload', name: 'Uploaded boundary file', release: /^\d{4}-\d{2}-\d{2}$/.test(day) ? `uploaded ${day}` : 'uploaded',
    credit: 'Supplied by project staff. Not checked against any public record.', disclaimer,
    datumNote: 'Coordinates are drawn exactly as supplied, with no datum shift.', datum: 'as-supplied', region: null,
  };
}

// ----------------------------------------------------------------- routes --

// Staff-only routes on the processing (Ops workspace) router: the same
// Bearer admin session, permission check and Idempotency-Key rule as the
// other workspace writes (for example the GCP import).
function mountBoundaryRoutes(router, { processing, repository, boundaries, authorize, mutate, error }) {
  const activeProject = (id) => { const p = typeof id === 'string' && PROJECT_ID.test(id) ? processing.getProject(id) : null; return p && p.status === 'active' ? p : null; };
  const state = (projectId) => { const m = boundaries.readManifest(projectId); return { source: m?.source || 'state', upload: boundaries.publicManifest(m) }; };
  const audit = (req, action, projectId, details = {}) => repository?.audit?.({ actorType: 'admin', actorId: req.actorId, action, entityType: 'project', entityId: projectId, details });
  const failed = (res, caught) => caught?.boundaryValidation
    ? error(res, caught.code === 'file_too_large' ? 413 : 400, caught.code, String(caught.message).slice(0, 300))
    : error(res, 500, 'boundary_storage_failed');

  router.get('/api/v1/projects/:id/property-lines', authorize('viewer.projects.read'), (req, res) => {
    if (!activeProject(req.params.id)) return error(res, 404, 'project_not_found');
    return res.json(state(req.params.id));
  });

  // Raw bytes, capped while the body streams in: a declared length over the
  // cap is refused before reading, and a stream that passes the cap is
  // answered 413 at once and its connection closed, keeping at most the cap
  // in memory.
  const tooLarge = (req, res) => {
    res.setHeader('Connection', 'close');
    res.once('finish', () => req.socket?.destroy());
    return error(res, 413, 'file_too_large', 'The file is larger than 20 MB.');
  };
  const readBody = (req, res, next) => {
    if (!/^application\/octet-stream\b/i.test(req.get('content-type') || '')) return error(res, 415, 'unsupported_media_type', 'Send the file as application/octet-stream.');
    const declared = req.get('content-length');
    if (declared !== undefined && (!/^\d{1,12}$/.test(declared) || Number(declared) > BOUNDARY_LIMITS.maxBytes)) return tooLarge(req, res);
    const chunks = [];
    let total = 0, done = false;
    const finish = (fn) => { if (done) return; done = true; req.off('data', onData); req.off('end', onEnd); req.off('error', onError); fn(); };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > BOUNDARY_LIMITS.maxBytes) return finish(() => { req.pause(); tooLarge(req, res); });
      chunks.push(chunk);
    };
    const onEnd = () => finish(() => { req.rawBody = Buffer.concat(chunks, total); next(); });
    const onError = () => finish(() => { if (!res.headersSent) error(res, 400, 'invalid_upload'); });
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError);
  };

  router.put('/api/v1/projects/:id/property-lines/boundary', authorize('viewer.projects.write'), (req, res, next) => {
    if (!activeProject(req.params.id)) { res.setHeader('Connection', 'close'); return error(res, 404, 'project_not_found'); }
    return next();
  }, readBody, mutate, (req, res) => {
    let parsed;
    try { parsed = parseBoundaryFile(req.rawBody); } catch (caught) { return failed(res, caught); }
    try {
      const sha256 = crypto.createHash('sha256').update(req.rawBody).digest('hex');
      const manifest = boundaries.save(req.params.id, parsed, { bytes: req.rawBody.length, sha256, actorId: req.actorId });
      audit(req, 'project.property_lines_boundary_uploaded', req.params.id, { format: manifest.format, featureCount: manifest.featureCount, vertexCount: manifest.vertexCount });
      return res.status(201).json(state(req.params.id));
    } catch (caught) { return failed(res, caught); }
  });

  router.patch('/api/v1/projects/:id/property-lines', authorize('viewer.projects.write'), mutate, (req, res) => {
    if (!activeProject(req.params.id)) return error(res, 404, 'project_not_found');
    const body = req.body || {};
    if (Object.keys(body).length !== 1 || !SOURCES.has(body.source)) return error(res, 400, 'invalid_source', 'Choose state or upload.');
    try {
      boundaries.setSource(req.params.id, body.source);
      audit(req, 'project.property_lines_source_changed', req.params.id, { source: body.source });
      return res.json(state(req.params.id));
    } catch (caught) { return caught?.code === 'no_upload' ? error(res, 409, 'no_upload', caught.message) : failed(res, caught); }
  });

  router.delete('/api/v1/projects/:id/property-lines/boundary', authorize('viewer.projects.write'), mutate, (req, res) => {
    if (!activeProject(req.params.id)) return error(res, 404, 'project_not_found');
    try {
      boundaries.remove(req.params.id);
      audit(req, 'project.property_lines_boundary_removed', req.params.id);
      return res.json(state(req.params.id));
    } catch (caught) { return failed(res, caught); }
  });
}

// Project purge (after the 30-day trash) removes the project's boundary
// files. Trashing alone keeps them so a restore brings them back; trashing
// already revokes every viewer session and share for the project's models.
function purgeProjectBoundary(storage, projectId) {
  const root = storage?.roots?.models;
  if (!root || typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return;
  try { fs.rmSync(path.join(root, 'property-lines', projectId), { recursive: true, force: true }); } catch { /* best effort; nothing serves it once the project is purged */ }
}

module.exports = {
  BOUNDARY_LIMITS,
  parseBoundaryFile,
  createBoundaryStore,
  mountBoundaryRoutes,
  parcelsInBounds,
  uploadSourceDescription,
  purgeProjectBoundary,
  cleanName,
};
