'use strict';

// Raw-photo copies intentionally never use adoption: the mounted originals belong
// to the operator and must survive both successful imports and failed retries.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { safeRelativePath } = require('./processingSecurity');
const { jpegMetadata, readHead } = require('./storageManager');
const { parsePhotoExif } = require('./photoExif.mjs');
const { fsyncDirectory, fsyncDirectoryTree } = require('./durableFs');
const { TextDecoder } = require('node:util');
const { parseGcpInterchange, MAX_SOURCE_BYTES } = require('./gcpImport');

const IMAGE = /\.(?:jpe?g|png|tiff?)$/i;
const CSV = /\.csv$/i;
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
function locate(storage, relative, allowRoot = false) {
  if (typeof relative !== 'string' || (!relative && !allowRoot) || (relative && (safeRelativePath(relative) !== relative || relative.includes('\\')))) fail('invalid_import_path');
  if (!storage.roots.dataset_import) fail('import_mount_unavailable');
  const root = fs.realpathSync.native(storage.roots.dataset_import);
  let current = root;
  for (const component of relative ? relative.split('/') : []) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) fail('invalid_import_path');
  }
  if (fs.realpathSync.native(current) !== current) fail('invalid_import_path');
  return current;
}
function browsePhotos(storage, { relativePath = '', offset = 0, limit = 100 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_page');
  const absolute = locate(storage, relativePath, true);
  if (!fs.statSync(absolute).isDirectory()) fail('invalid_import_path');
  const names = [], directory = fs.opendirSync(absolute);
  try { for (let entry; (entry = directory.readSync());) { if (names.length >= 100000) fail('import_directory_too_large'); names.push(entry.name); } }
  finally { directory.closeSync(); }
  const entries = [];
  for (const name of names) {
    if (name.startsWith('.') || /[\u0000-\u001f]/.test(name)) continue;
    const stat = fs.lstatSync(path.join(absolute, name));
    if (stat.isSymbolicLink()) continue;
    const kind = stat.isDirectory() ? 'folder' : stat.isFile() && IMAGE.test(name) ? 'image' : stat.isFile() && CSV.test(name) ? 'csv' : null;
    if (kind) entries.push({ name, relativePath: relativePath ? `${relativePath}/${name}` : name, kind, ...(kind !== 'folder' ? { byteSize: stat.size } : {}) });
  }
  entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return { path: relativePath, parentPath: relativePath ? relativePath.split('/').slice(0, -1).join('/') : null, entries: entries.slice(offset, offset + limit), nextOffset: offset + limit < entries.length ? offset + limit : null };
}
function identity(stat) { return { byteSize: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }; }
function sameIdentity(a, b) { return ['byteSize', 'dev', 'ino', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]); }
function selectPhotos(storage, paths, maxFiles = 20000, { checkSpace = true } = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.length > maxFiles) fail('invalid_raw_selection');
  const files = new Map();
  let visited = 0, byteSize = 0;
  const deadline = Date.now() + 10000;
  function walk(relative, explicit = false, depth = 0) {
    if (++visited > maxFiles * 4 || depth > 64 || Date.now() >= deadline) fail('import_selection_too_large');
    const absolute = locate(storage, relative), stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      const directory = fs.opendirSync(absolute);
      try { for (let entry; (entry = directory.readSync());) {
        if (Date.now() >= deadline) fail('import_selection_too_large');
        if (entry.name.startsWith('.')) continue;
        walk(`${relative}/${entry.name}`, false, depth + 1);
      } } finally { directory.closeSync(); }
    } else if (stat.isFile() && (IMAGE.test(relative) || CSV.test(relative))) {
      if (files.has(relative)) return;
      if (files.size >= maxFiles) fail('import_selection_too_large');
      if (!Number.isSafeInteger(stat.size) || stat.size <= 0) fail('invalid_image_size');
      byteSize += stat.size;
      if (!Number.isSafeInteger(byteSize)) fail('import_selection_too_large');
      files.set(relative, { sourcePath: relative, relativePath: relative, ...identity(stat) });
    } else if (explicit || !stat.isFile()) fail('invalid_raw_image');
  }
  for (const relative of [...new Set(paths)].sort()) walk(relative, true);
  if (![...files.keys()].some(file => IMAGE.test(file))) fail('no_raw_images');
  if (checkSpace) storage.requireSpace('datasets', byteSize);
  const selected = [...files.values()].sort((a, b) => a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0), counts = new Map();
  for (const file of selected) { const base = path.posix.basename(file.sourcePath).toLowerCase(); counts.set(base, (counts.get(base) || 0) + 1); }
  const names = new Set(counts.keys());
  selected.forEach((file, index) => {
    const base = path.posix.basename(file.sourcePath);
    if (counts.get(base.toLowerCase()) < 2) return;
    const extension = path.posix.extname(base), stem = base.slice(0, -extension.length);
    let suffix = 0, name;
    do { name = `${stem}--photo-${index + 1}${suffix ? `-${suffix}` : ''}${extension}`; suffix++; } while (names.has(name.toLowerCase()));
    names.add(name.toLowerCase());
    file.relativePath = file.sourcePath.slice(0, -base.length) + name;
  });
  return { files: selected, byteSize };
}

// Search at most two parent directories of each explicitly selected folder or
// image. Never recurse into siblings or leave the configured import root.
function discoverSiblingSurveys(storage, paths, maxFiles = 20000) {
  const selected = selectPhotos(storage, paths, maxFiles, { checkSpace: false });
  if (selected.files.some(file => CSV.test(file.sourcePath))) return [];
  const parents = new Set();
  for (const relative of [...new Set(paths)]) {
    const source = locate(storage, relative), stat = fs.lstatSync(source);
    let parent = stat.isDirectory() ? path.posix.dirname(relative) : path.posix.dirname(path.posix.dirname(relative));
    for (let i = 0; i < 2; i++) { parents.add(parent === '.' ? '' : parent); if (parent === '.') break; parent = path.posix.dirname(parent); }
  }
  const candidates = [], deadline = Date.now() + 10000;
  let visited = 0, csvCount = 0;
  for (const parent of [...parents].sort()) {
    const directory = fs.opendirSync(locate(storage, parent, true));
    try { for (let entry; (entry = directory.readSync());) {
      if (++visited > 10000 || Date.now() >= deadline) fail('survey_discovery_limit');
      if (!CSV.test(entry.name) || entry.name.startsWith('.') || !entry.isFile()) continue;
      if (++csvCount > 64) fail('survey_discovery_limit');
      const relative = parent ? `${parent}/${entry.name}` : entry.name, source = locate(storage, relative), initial = fs.lstatSync(source);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.size <= 0 || initial.size > MAX_SOURCE_BYTES) continue;
      let fd, bytes;
      try {
        fd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        if (!sameIdentity(identity(initial), identity(fs.fstatSync(fd))) || locate(storage, relative) !== source) fail('import_source_changed');
        bytes = Buffer.alloc(initial.size + 1);
        let read = 0, count;
        while (read < bytes.length && (count = fs.readSync(fd, bytes, read, bytes.length - read, read)) > 0) read += count;
        bytes = bytes.subarray(0, read);
        if (bytes.length !== initial.size || !sameIdentity(identity(initial), identity(fs.fstatSync(fd))) || locate(storage, relative) !== source) fail('import_source_changed');
      } finally { if (fd !== undefined) fs.closeSync(fd); }
      try {
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        parseGcpInterchange({ format: 'emlid-all-columns-v1', content });
      } catch (error) {
        if (error instanceof TypeError || ['invalid_gcp_input', 'gcp_input_too_large'].includes(error?.code)) continue;
        throw error;
      }
      candidates.push({ relative, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), identity: identity(initial) });
    } } finally { directory.closeSync(); }
  }
  return candidates;
}
function selectWithSiblingSurvey(storage, paths, survey, maxFiles = 20000) {
  if (survey == null) return selectPhotos(storage, paths, maxFiles);
  if (!survey || typeof survey !== 'object' || Array.isArray(survey) || Object.keys(survey).sort().join(',') !== 'path,sha256' || typeof survey.path !== 'string' || !/^[a-f0-9]{64}$/.test(survey.sha256)) fail('invalid_survey_choice');
  const candidate = discoverSiblingSurveys(storage, paths, maxFiles).find(item => item.relative === survey.path && item.sha256 === survey.sha256);
  if (!candidate) fail('survey_candidate_changed');
  const selected = selectPhotos(storage, [...paths, candidate.relative], maxFiles);
  const file = selected.files.find(item => item.sourcePath === candidate.relative);
  if (!file || !sameIdentity(file, candidate.identity)) fail('import_source_changed');
  file.expectedSha256 = candidate.sha256;
  return selected;
}

async function previewPhotos(storage, paths, maxFiles = 20000) {
  const selected = selectPhotos(storage, paths, maxFiles, { checkSpace: false });
  const deadline = Date.now() + 10000, points = [];
  let scannedCount = 0, missingGpsCount = 0;
  // Read at most 2,048 bounded EXIF headers (512 MiB), never full image pixels.
  for (const file of selected.files.filter(file => IMAGE.test(file.sourcePath))) {
    if (scannedCount >= 2048 || Date.now() >= deadline) break;
    const source = locate(storage, file.sourcePath);
    if (!sameIdentity(file, identity(fs.statSync(source)))) fail('import_source_changed');
    let descriptor, gps;
    try {
      descriptor = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (!sameIdentity(file, identity(fs.fstatSync(descriptor))) || locate(storage, file.sourcePath) !== source) fail('import_source_changed');
      const bytes = Buffer.alloc(Math.min(file.byteSize, 256 * 1024));
      const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (!sameIdentity(file, identity(fs.fstatSync(descriptor)))) fail('import_source_changed');
      gps = parsePhotoExif(bytes.subarray(0, length));
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    scannedCount++;
    if (gps) points.push({ ...gps, name: path.posix.basename(file.sourcePath) });
    else missingGpsCount++;
    if (scannedCount % 32 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  const photoCount = selected.files.filter(file => IMAGE.test(file.sourcePath)).length;
  return { photoCount, scannedCount, locatedCount: points.length, missingGpsCount, unscannedCount: photoCount - scannedCount, points, truncated: scannedCount < photoCount };
}

function mountTaskPhotoImports(router, { processing, storage, authorize, mutate, subjectReceipt, config }) {
  router.post('/api/v1/dataset-imports/photo-preview', authorize('viewer.datasets.import'), async (req, res) => {
    try {
      if (Object.keys(req.body || {}).some(key => key !== 'paths')) fail('invalid_raw_selection');
      res.json(await previewPhotos(storage, req.body?.paths, config.uploadMaxFiles || 20000));
    } catch (error) { res.status(400).json({ code: error.code || 'photo_preview_failed', error: 'Photo locations could not be inspected.' }); }
  });
  router.post('/api/v1/dataset-imports/survey-preview', authorize('viewer.datasets.import'), (req, res) => {
    try {
      if (Object.keys(req.body || {}).some(key => key !== 'paths')) fail('invalid_raw_selection');
      const candidates = discoverSiblingSurveys(storage, req.body?.paths, config.uploadMaxFiles || 20000);
      res.json({ candidates: candidates.map(({ relative, sha256 }) => ({ path: relative, sha256 })) });
    } catch (error) { res.status(400).json({ code: error.code || 'survey_preview_failed', error: 'Survey CSV discovery could not be completed. You can skip discovery or select a CSV directly.' }); }
  });
  router.get('/api/v1/dataset-imports/browse', authorize('viewer.datasets.import'), (req, res) => {
    try { res.json(browsePhotos(storage, { relativePath: req.query.path || '', offset: Number(req.query.offset || 0), limit: Number(req.query.limit || 100) })); }
    catch (error) { res.status(error.code === 'import_mount_unavailable' ? 503 : 400).json({ code: error.code || 'import_path_unavailable', error: 'The import folder is unavailable.' }); }
  });
  router.post('/api/v1/dataset-imports/copy', authorize('viewer.datasets.import'), mutate, (req, res) => {
    try {
      const body = req.body || {}, project = processing.getProject(body.projectId);
      if (!project || project.status !== 'active') fail('invalid_project');
      if (Object.keys(body).some(key => !['projectId', 'displayName', 'paths', 'survey'].includes(key)) || typeof body.displayName !== 'string' || !body.displayName.trim() || body.displayName.length > 240) fail('invalid_raw_import');
      const selected = selectWithSiblingSurvey(storage, body.paths, body.survey, config.uploadMaxFiles || 20000);
      const result = processing.transaction(() => {
        const id = crypto.randomUUID(), datasetId = crypto.randomUUID(), timestamp = new Date().toISOString();
        const dataset = processing.createDataset({ id: datasetId, projectId: project.id, displayName: body.displayName.trim(), sourceType: 'server_import', storageMode: 'managed', rootKey: 'datasets', relativePath: datasetId, status: 'finalizing', createdBy: req.actorId, metadata: { rawPhotoCopy: true, originalsPreserved: true } });
        const payload = { rawPhotoCopy: true, request: { projectId: project.id }, files: selected.files, byteSize: selected.byteSize };
        processing.database.prepare("INSERT INTO dataset_operations(id,operation_type,subject,session_id,dataset_id,payload_json,status,available_at,created_at,updated_at) VALUES (?,'import_adopt',?,?,?,?,'queued',?,?,?)").run(id, req.actorId, req.adminPrincipal?.id || null, datasetId, JSON.stringify(payload), timestamp, timestamp, timestamp);
        processing.attachSubjectOperationReceipt(subjectReceipt(req), id);
        processing.insertAudit({ actorId: req.actorId, action: 'dataset_operation.raw_copy_enqueued', entityType: 'dataset_operation', entityId: id, details: { datasetId, fileCount: selected.files.length } });
        return { dataset, operation: processing.getDatasetOperation(id) };
      });
      res.status(202).set('Location', `/api/v1/operations/${result.operation.id}`).set('Retry-After', '2').json(result);
    } catch (error) { const message = error.code === 'multiple_survey_csv_candidates' ? 'Multiple survey CSV files were found. Select the intended CSV in the server browser along with your photos.' : error.code === 'survey_discovery_limit' ? 'Survey CSV search exceeded its limit. Select your survey CSV explicitly along with your photos.' : error.code || 'Raw images could not be selected.'; res.status(error.code === 'dataset_name_conflict' ? 409 : 400).json({ code: error.code || 'raw_import_failed', error: message }); }
  });
}

async function copyTaskPhotos(operation, { processing, storage }, updateProgress, signal) {
  const payload = JSON.parse(operation.payload_json), dataset = processing.getDataset(operation.dataset_id, true);
  if (dataset?.status === 'finalized') { require('./gcpDiscovery').discoverDatasetGcp({ processing, storage, datasetId: dataset.id, actorId: operation.subject }); return { dataset }; }
  if (!dataset || dataset.status !== 'finalizing' || dataset.storageMode !== 'managed') fail('dataset_unavailable');
  storage.requireSpace('datasets', payload.byteSize);
  const files = [];
  for (let index = 0; index < payload.files.length; index++) {
    if (signal?.aborted) fail('operation_lease_lost');
    const file = payload.files[index], source = locate(storage, file.sourcePath);
    const destination = storage.resolve('datasets', `${dataset.relativePath}/${file.relativePath}`), temp = `${destination}.${crypto.randomUUID()}.raw-copy-incomplete`;
    const handle = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      if (locate(storage, file.sourcePath) !== source || !sameIdentity(file, identity(await handle.stat())) || !sameIdentity(file, identity(fs.statSync(source)))) fail('import_source_changed');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const hash = crypto.createHash('sha256');
      const digest = new Transform({ transform(chunk, encoding, done) { hash.update(chunk); done(null, chunk); } });
      await pipeline(handle.createReadStream({ autoClose: false }), digest, fs.createWriteStream(temp, { flags: 'w' }), { signal });
      if (!sameIdentity(file, identity(await handle.stat())) || locate(storage, file.sourcePath) !== source || !sameIdentity(file, identity(fs.statSync(source)))) fail('import_source_changed');
      const copied = fs.statSync(temp), sha256 = hash.digest('hex');
      if (copied.size !== file.byteSize || (file.expectedSha256 && sha256 !== file.expectedSha256)) fail('import_source_changed');
      await updateProgress(0.05 + 0.9 * index / payload.files.length);
      fs.renameSync(temp, destination);
      files.push({ id: crypto.randomUUID(), relativePath: file.relativePath, byteSize: file.byteSize, sha256, processingRole: CSV.test(file.relativePath) ? 'gcp_source' : 'image', metadata: { ...(IMAGE.test(file.relativePath) ? jpegMetadata(readHead(destination)) : {}), sourcePath: file.sourcePath } });
    } finally { await handle.close(); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    await updateProgress(0.05 + 0.9 * (index + 1) / payload.files.length);
  }
  fsyncDirectoryTree(storage.resolve('datasets', dataset.relativePath), { code: 'import_durability_failed' });
  fsyncDirectory(storage.roots.datasets, { code: 'import_durability_failed' });
  await updateProgress(0.99);
  const manifestHash = crypto.createHash('sha256').update(JSON.stringify(files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })))).digest('hex');
  const finalized = processing.finalizeDataset(dataset.id, files, manifestHash);
  require('./gcpDiscovery').discoverDatasetGcp({ processing, storage, datasetId: finalized.id, actorId: operation.subject });
  return { dataset: finalized };
}
module.exports = { browsePhotos, selectPhotos, discoverSiblingSurveys, selectWithSiblingSurvey, previewPhotos, mountTaskPhotoImports, copyTaskPhotos };
