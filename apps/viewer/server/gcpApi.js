'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GcpRepository } = require('./gcpRepository');
const { parseGcpInterchange, confirmationToken, detectGcpFormat, MAX_SOURCE_BYTES } = require('./gcpImport');
const { hashFile } = require('./storageManager');
const { DEFAULT_GCP_SEARCH_MODE, DEFAULT_GCP_RADIUS_M, MAX_GCP_RADIUS_M } = require('./gcpSearchPolicy.mjs');

function onlyKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key));
}

function fail(error, res, respond) {
  const code = error?.code || 'invalid_gcp_request';
  const conflict = new Set(['dataset_not_available', 'correspondence_exists', 'gcp_dataset_mismatch']);
  const safeValidationCodes=new Set(['invalid_gcp_input','gcp_input_too_large','unsupported_gcp_format','invalid_source_file',
    'invalid_gcp_point','invalid_pixel_coordinates','invalid_gcp_image','gcp_pixel_out_of_bounds','correspondence_exists','gcp_dataset_mismatch']);
  const message=safeValidationCodes.has(code)?String(error?.message||code).replace(/[\r\n\t]+/g,' ').slice(0,400):code;
  return respond(res, conflict.has(code) ? 409 : 400, code, message);
}

function mountGcpRoutes(router, { repository, processing, storage, authorize, mutate, error }) {
  const gcp = new GcpRepository(processing.database);

  // CSV files uploaded with a dataset that may hold survey points (an Emlid export, for example).
  const csvFiles = (datasetId) => processing.database.prepare(`SELECT files.id,files.relative_path,files.byte_size,files.sha256,
      datasets.root_key,datasets.relative_path dataset_relative_path FROM dataset_files files JOIN datasets ON datasets.id=files.dataset_id
      WHERE files.dataset_id=? AND lower(files.relative_path) LIKE '%.csv' ORDER BY files.relative_path,files.id LIMIT 50`).all(datasetId);
  const readCsv = async (file) => {
    if (Number(file.byte_size) > MAX_SOURCE_BYTES) throw Object.assign(new Error('GCP input is too large'), { code: 'gcp_input_too_large' });
    const absolute = storage.resolve(file.root_key, path.posix.join(file.dataset_relative_path, file.relative_path), { mustExist: true });
    const bytes = await fs.promises.readFile(absolute);
    if (bytes.length !== Number(file.byte_size) || require('node:crypto').createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw Object.assign(new Error('the file changed after upload'), { code: 'gcp_source_changed' });
    return bytes.toString('utf8');
  };
  const importedSetId = (datasetId, fileId) => processing.database.prepare('SELECT id FROM gcp_sets WHERE dataset_id=? AND source_file_id=? ORDER BY created_at LIMIT 1').get(datasetId, fileId)?.id || null;

  router.get('/api/v1/datasets/:datasetId/gcp-sources', authorize('viewer.gcp.read'), async (req, res, next) => {
    if (!gcp.dataset(req.params.datasetId)) return error(res, 404, 'dataset_not_found');
    try {
      const sources = [];
      for (const file of csvFiles(req.params.datasetId)) {
        const source = { fileId: file.id, name: file.relative_path, format: null, pointCount: 0, checkpointCount: 0, coordinateSystem: null,
          linearUnit: null, importable: false, error: null, importedSetId: importedSetId(req.params.datasetId, file.id) };
        try {
          const content = await readCsv(file), format = detectGcpFormat(content);
          source.format = format;
          if (format) {
            const parsed = parseGcpInterchange({ format, content });
            Object.assign(source, { pointCount: parsed.points.length, checkpointCount: parsed.points.filter((point) => point.role === 'checkpoint').length,
              coordinateSystem: parsed.provenance.coordinateSystem, linearUnit: parsed.provenance.linearUnit, importable: true });
          }
        } catch (caught) { source.error = String(caught?.message || caught?.code || 'unreadable').replace(/[\r\n\t]+/g, ' ').slice(0, 200); }
        sources.push(source);
      }
      return res.json({ sources });
    } catch (caught) { return next(caught); }
  });

  // Import a dataset's own uploaded file. Only explicit, unambiguous files: units come from the file, never a guess.
  router.post('/api/v1/datasets/:datasetId/gcp-sets/import-source', authorize('viewer.gcp.write'), mutate, async (req, res, next) => {
    if (!onlyKeys(req.body, ['fileId', 'displayName']) || typeof req.body.fileId !== 'string' || req.body.fileId.length > 128)
      return error(res, 400, 'invalid_gcp_import');
    const file = csvFiles(req.params.datasetId).find((row) => row.id === req.body.fileId);
    if (!file) return error(res, 404, 'gcp_source_not_found');
    try {
      const existing = importedSetId(req.params.datasetId, file.id);
      if (existing) { const set = gcp.getSet(existing, true); return res.status(200).json({ set, points: set.points }); }
      let content;
      try { content = await readCsv(file); }
      catch (caught) { if (caught?.code === 'gcp_source_changed') return error(res, 409, 'gcp_source_changed', 'The file changed after upload.'); throw caught; }
      const format = detectGcpFormat(content);
      if (!format) return error(res, 400, 'unsupported_gcp_format', 'This CSV is not an Emlid export or a GCP CSV.');
      const parsed = parseGcpInterchange({ format, content });
      const displayName = typeof req.body.displayName === 'string' && req.body.displayName.trim() ? req.body.displayName.trim().slice(0, 160) : path.posix.basename(file.relative_path);
      const set = gcp.importSet({ datasetId: req.params.datasetId, displayName, sourceFormat: format, sourceFileId: file.id, sourceFilename: path.posix.basename(file.relative_path),
        sourceSha256: parsed.sourceSha256, sourceContent: content, crs: parsed.crs, elevationUnits: parsed.elevationUnits, provenance: parsed.provenance,
        points: parsed.points, createdBy: req.actorId });
      repository.audit({ actorType: 'admin', actorId: req.actorId, action: 'gcp.set_imported', entityType: 'gcp_set', entityId: set.id,
        details: { datasetId: set.datasetId, sourceFormat: format, pointCount: set.pointCount, sourceFileId: file.id } });
      return res.status(201).json({ set, points: set.points });
    } catch (caught) {
      if (caught?.code && String(caught.code).startsWith('ERR_')) return next(caught);
      return fail(caught, res, error);
    }
  });

  router.get('/api/v1/datasets/:datasetId/gcp-sets', authorize('viewer.gcp.read'), (req, res) => {
    if (!gcp.dataset(req.params.datasetId)) return error(res, 404, 'dataset_not_found');
    res.json({ sets: gcp.listSets(req.params.datasetId) });
  });

  router.post('/api/v1/datasets/:datasetId/gcp-sets/import', authorize('viewer.gcp.write'), mutate, (req, res) => {
    if (!onlyKeys(req.body, ['displayName', 'format', 'fileName', 'content', 'sourceFileId', 'declarations', 'confirmationToken']))
      return error(res, 400, 'invalid_gcp_import');
    if (typeof req.body.displayName !== 'string' || !req.body.displayName.trim() || req.body.displayName.trim().length > 160)
      return error(res, 400, 'invalid_gcp_set_name');
    if (req.body.fileName != null && (typeof req.body.fileName !== 'string' || !req.body.fileName.trim() || req.body.fileName.length > 240))
      return error(res, 400, 'invalid_gcp_filename');
    if (req.body.sourceFileId != null && (typeof req.body.sourceFileId !== 'string' || req.body.sourceFileId.length > 128))
      return error(res, 400, 'invalid_source_file');
    try {
      const parsed = parseGcpInterchange({ format: req.body.format, content: req.body.content, declarations: req.body.declarations });
      if (req.body.format === 'emlid-all-columns-v1' && req.body.confirmationToken !== confirmationToken(parsed))
        return error(res, 409, 'gcp_preview_confirmation_required');
      const sourceFileId = req.body.sourceFileId ||
        gcp.findSourceFile(req.params.datasetId, req.body.fileName, parsed.sourceSha256);
      const set = gcp.importSet({
        datasetId: req.params.datasetId,
        displayName: req.body.displayName.trim(),
        sourceFormat: req.body.format,
        sourceFileId,
        sourceFilename: req.body.fileName?.trim() || null,
        sourceSha256: parsed.sourceSha256,
        sourceContent:req.body.content,
        crs: parsed.crs,
        elevationUnits: parsed.elevationUnits,
        provenance: parsed.provenance,
        points: parsed.points,
        createdBy: req.actorId,
      });
      repository.audit({ actorType: 'admin', actorId: req.actorId, action: 'gcp.set_imported', entityType: 'gcp_set', entityId: set.id,
        details: { datasetId: set.datasetId, sourceFormat: set.sourceFormat, pointCount: set.pointCount } });
      return res.status(201).json({ set, points: set.points });
    } catch (caught) { return fail(caught, res, error); }
  });

  router.post('/api/v1/datasets/:datasetId/gcp-sets/import-preview', authorize('viewer.gcp.write'), (req, res) => {
    if (!onlyKeys(req.body, ['format', 'content', 'declarations']) || !gcp.dataset(req.params.datasetId))
      return error(res, 400, 'invalid_gcp_preview');
    try {
      const parsed = parseGcpInterchange(req.body);
      return res.json({ sourceSha256: parsed.sourceSha256, pointCount: parsed.points.length,
        columns: { id: 'Name', authoritative: ['Easting', 'Northing', 'Elevation'], crossCheck: ['Latitude', 'Longitude', 'Ellipsoidal height'] },
        provenance: parsed.provenance, sample: parsed.points.slice(0, 5), warnings: parsed.points.length < 3 ? ['Fewer than 3 control points were supplied.'] : [],
        confirmationToken: confirmationToken(parsed) });
    } catch (caught) { return fail(caught, res, error); }
  });

  router.get('/api/v1/gcp-sets/:id', authorize('viewer.gcp.read'), (req, res) => {
    const set = gcp.getSet(req.params.id, true);
    return set ? res.json({ set, points: set.points }) : error(res, 404, 'gcp_set_not_found');
  });

  router.delete('/api/v1/gcp-sets/:id', authorize('viewer.gcp.write'), mutate, (req, res) => {
    const current = gcp.getSet(req.params.id);
    if (!current) return error(res, 404, 'gcp_set_not_found');
    gcp.deleteSet(current.id);
    repository.audit({ actorType: 'admin', actorId: req.actorId, action: 'gcp.set_deleted', entityType: 'gcp_set', entityId: current.id,
      details: { datasetId: current.datasetId, pointCount: current.pointCount } });
    return res.status(204).end();
  });

  router.patch('/api/v1/gcp-points/:id', authorize('viewer.gcp.write'), mutate, (req, res) => {
    if (!onlyKeys(req.body, ['label', 'latitude', 'longitude', 'elevationM', 'description', 'role']))
      return error(res, 400, 'invalid_gcp_point');
    try {
      const point = gcp.updatePoint(req.params.id, req.body);
      if (!point) return error(res, 404, 'gcp_point_not_found');
      repository.audit({ actorType: 'admin', actorId: req.actorId, action: 'gcp.point_updated', entityType: 'gcp_point', entityId: point.id });
      return res.json({ point });
    } catch (caught) { return fail(caught, res, error); }
  });

  router.delete('/api/v1/gcp-points/:id', authorize('viewer.gcp.write'), mutate, (req, res) => {
    const current = gcp.getPoint(req.params.id);
    if (!current) return error(res, 404, 'gcp_point_not_found');
    gcp.deletePoint(current.id);
    repository.audit({ actorType: 'admin', actorId: req.actorId, action: 'gcp.point_deleted', entityType: 'gcp_point', entityId: current.id,
      details: { setId: current.setId } });
    return res.status(204).end();
  });

  router.get('/api/v1/datasets/:datasetId/gcp-images', authorize('viewer.gcp.read'), (req, res) => {
    if (!gcp.dataset(req.params.datasetId)) return error(res, 404, 'dataset_not_found');
    const rawLimit = String(req.query.limit || '100');
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200)
      return error(res, 400, 'invalid_limit');
    try {
      const mode = String(req.query.mode || DEFAULT_GCP_SEARCH_MODE);
      if (!['auto', 'radius', 'nearest'].includes(mode)) return error(res, 400, 'invalid_candidate_mode');
      const radiusM = req.query.radiusM == null ? (mode === 'radius' ? DEFAULT_GCP_RADIUS_M : null) : Number(req.query.radiusM);
      if (radiusM != null && (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > MAX_GCP_RADIUS_M)) return error(res, 400, 'invalid_radius');
      const requested = Number(rawLimit), ranked = gcp.listRankedImages(req.params.datasetId, req.query.pointId ? String(req.query.pointId) : null, 200);
      let images = ranked.images;
      let appliedMode = ranked.selectedPoint ? mode : 'capture_time';
      let appliedRadius = radiusM, reason = 'explicit_mode', confidence = 'user_selected';
      if (ranked.selectedPoint && mode === 'auto') {
        const footprints = images.map((image) => image.footprintRadiusM).filter(Number.isFinite).sort((a, b) => a - b);
        if (footprints.length >= 5) {
          appliedRadius = footprints[Math.floor(footprints.length / 2)];
          reason = 'median_camera_footprint_metadata'; confidence = 'metadata_supported';
        } else if (images.length >= 5) {
          const accuracy = Math.max(0, ...images.slice(0, 5).map((image) => image.horizontalAccuracyM || 0));
          appliedRadius = Math.max(10, Math.min(5000, images[4].distanceM * 1.1 + accuracy));
          reason = 'adaptive_camera_spacing'; confidence = 'proximity_only';
        } else {
          appliedMode = 'nearest_fallback'; reason = 'insufficient_ranked_cameras'; confidence = 'low';
        }
      }
      if (ranked.selectedPoint && mode !== 'nearest') {
        const inRadius = appliedRadius == null ? [] : images.filter((image) => image.distanceM <= appliedRadius);
        if (mode === 'radius' || inRadius.length >= 5) images = inRadius;
        else appliedMode = 'nearest_fallback';
      }
      images = images.slice(0, appliedMode === 'nearest_fallback' ? Math.min(requested, 12) : requested);
      const result = { ...ranked, images };
      return res.json({
        ...result,
        ranking: {
          basis: result.selectedPoint ? mode === 'auto' ? 'adaptive_camera_proximity' : 'camera_proximity' : 'capture_time', mode: appliedMode,
          radiusM: appliedRadius, reason, confidence,
          targetCount: 5, warnings: images.length < 3 ? ['Fewer than 3 candidate images were found.'] : [],
          visibilityConfirmed: false,
          notice: result.selectedPoint
            ? 'Nearby camera positions are suggestions only; proximity does not prove that the GCP is visible.'
            : 'Select a GCP to rank images by camera GPS proximity.',
        },
      });
    } catch (caught) { return fail(caught, res, error); }
  });

  router.get('/api/v1/datasets/:datasetId/gcp-images/:fileId/content', authorize('viewer.gcp.read'), async (req, res, next) => {
    const image = gcp.getDatasetImage(req.params.datasetId, req.params.fileId);
    if (!image) return error(res, 404, 'dataset_image_not_found');
    if (!['finalized', 'archived'].includes(image.dataset_status)) return error(res, 409, 'dataset_image_unavailable');
    try {
      const relative = path.posix.join(image.dataset_relative_path, image.relative_path);
      const absolute = storage.resolve(image.root_key, relative, { mustExist: true });
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== image.byte_size)
        return error(res, 409, 'dataset_image_changed');
      if(await hashFile(absolute)!==image.sha256)return error(res,409,'dataset_image_changed');
      const filename = path.posix.basename(image.relative_path).replace(/[\r\n]/g, '_');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', image.mime_type);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.sendFile(absolute, (sendError) => { if (sendError && !res.headersSent) next(sendError); });
    } catch (caught) {
      if (caught?.code === 'ENOENT' || caught?.code === 'invalid_storage_location') return error(res, 409, 'dataset_image_unavailable');
      return next(caught);
    }
  });

  // Checkpoints frozen for an attempt and, once its DSM exists, their vertical residuals.
  router.get('/api/v1/attempts/:id/gcp-checkpoints', authorize('viewer.gcp.read'), async (req, res, next) => {
    const attempt = processing.getAttempt(req.params.id);
    if (!attempt) return error(res, 404, 'attempt_not_found');
    try {
      const frozen = processing.getAttemptGcpCheckpoints(attempt.id);
      if (!frozen) return res.json({ attemptId: attempt.id, checkpoints: [], reportStatus: 'no_checkpoints', report: null });
      const checkpoints = frozen.content.points;
      const dsm = attempt.resultModelVersionId && processing.database.prepare("SELECT root_key,relative_path FROM model_assets WHERE version_id=? AND kind='dsm'").get(attempt.resultModelVersionId);
      if (!dsm) return res.json({ attemptId: attempt.id, checkpoints, reportStatus: attempt.resultModelVersionId ? 'no_dsm' : 'awaiting_output', report: null });
      let dsmPath;
      try { dsmPath = storage.resolve(dsm.root_key, dsm.relative_path, { mustExist: true }); }
      catch { return res.json({ attemptId: attempt.id, checkpoints, reportStatus: 'dsm_unavailable', report: null }); }
      const { checkpointReport } = await import('./gcpCheckpointReport.mjs');
      try {
        const report = await checkpointReport({ checkpoints, dsmPath });
        return res.json({ attemptId: attempt.id, checkpoints, reportStatus: 'ready', report });
      } catch (caught) {
        if (String(caught?.code || '').startsWith('checkpoint_report_')) return res.json({ attemptId: attempt.id, checkpoints, reportStatus: caught.code, report: null });
        throw caught;
      }
    } catch (caught) { return next(caught); }
  });

  router.get('/api/v1/tasks/:taskId/gcp-correspondences', authorize('viewer.gcp.read'), (req, res) => {
    const task = gcp.task(req.params.taskId);
    if (!task) return error(res, 404, 'task_not_found');
    res.json({ taskId: task.id, datasetId: task.dataset_id, correspondences: gcp.listCorrespondences(task.id) });
  });

  router.post('/api/v1/tasks/:taskId/gcp-correspondences', authorize('viewer.gcp.write'), mutate, (req, res) => {
    if (!onlyKeys(req.body, ['pointId', 'imageFileId', 'pixelX', 'pixelY']))
      return error(res, 400, 'invalid_correspondence');
    if (!gcp.task(req.params.taskId)) return error(res, 404, 'task_not_found');
    try {
      const correspondence = gcp.createCorrespondence({
        taskId: req.params.taskId, pointId: req.body.pointId, imageFileId: req.body.imageFileId,
        pixelX: req.body.pixelX, pixelY: req.body.pixelY, createdBy: req.actorId,
      });
      repository.audit({ actorType: 'admin', actorId: req.actorId, action: 'gcp.correspondence_created', entityType: 'gcp_correspondence',
        entityId: correspondence.id, details: { taskId: correspondence.taskId, pointId: correspondence.pointId, imageFileId: correspondence.imageFileId } });
      return res.status(201).json({ correspondence });
    } catch (caught) { return fail(caught, res, error); }
  });

  router.patch('/api/v1/gcp-correspondences/:id', authorize('viewer.gcp.write'), mutate, (req, res) => {
    if (!onlyKeys(req.body, ['pixelX', 'pixelY'])) return error(res, 400, 'invalid_correspondence');
    try {
      const correspondence = gcp.updateCorrespondence(req.params.id, req.body);
      if (!correspondence) return error(res, 404, 'gcp_correspondence_not_found');
      repository.audit({ actorType: 'admin', actorId: req.actorId, action: 'gcp.correspondence_updated', entityType: 'gcp_correspondence', entityId: correspondence.id });
      return res.json({ correspondence });
    } catch (caught) { return fail(caught, res, error); }
  });

  router.delete('/api/v1/gcp-correspondences/:id', authorize('viewer.gcp.write'), mutate, (req, res) => {
    const current = gcp.getCorrespondence(req.params.id);
    if (!current) return error(res, 404, 'gcp_correspondence_not_found');
    gcp.deleteCorrespondence(current.id);
    repository.audit({ actorType: 'admin', actorId: req.actorId, action: 'gcp.correspondence_deleted', entityType: 'gcp_correspondence', entityId: current.id,
      details: { taskId: current.taskId, pointId: current.pointId, imageFileId: current.imageFileId } });
    return res.status(204).end();
  });

  return gcp;
}

module.exports = { mountGcpRoutes };
