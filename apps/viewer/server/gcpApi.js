'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { GcpRepository } = require('./gcpRepository');
const { parseGcpInterchange, confirmationToken } = require('./gcpImport');
const { hashFile } = require('./storageManager');

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
    if (!onlyKeys(req.body, ['label', 'latitude', 'longitude', 'elevationM', 'description']))
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
      const mode = String(req.query.mode || 'auto');
      if (!['auto', 'radius', 'nearest'].includes(mode)) return error(res, 400, 'invalid_candidate_mode');
      const radiusM = req.query.radiusM == null ? (mode === 'radius' ? 100 : null) : Number(req.query.radiusM);
      if (radiusM != null && (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > 100000)) return error(res, 400, 'invalid_radius');
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
          basis: result.selectedPoint ? 'adaptive_camera_proximity' : 'capture_time', mode: appliedMode,
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
