'use strict';

const express = require('express');
const auth = require('./auth');
const { ProcessingRepository } = require('./processingRepository');
const { MeasurementRepository, COLLECTIONS, problem } = require('./measurementRepository');
const { createMeasurementCalculationApi } = require('./measurementCalculationApi');
const { reconstructionAvailable } = require('./measurementReconstructionSupport');
const { config } = require('./config');
const {createEphemeralMeasurementApi}=require('./ephemeralMeasurementApi');
const {MeasurementSourceUnitEvidence}=require('./measurementSourceUnitEvidence');

function getMeasurementPrincipal(req, repository, { allowTransient = false } = {}) {
  // Deliberately no ambient-cookie fallback: personal mutations need an explicit
  // bearer held by this Viewer tab, and cannot be initiated by cross-site forms.
  const token = String(req.get('authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{16,256})$/i)?.[1];
  if (!token) return null;
  const session = repository.getViewerSessionByHash(auth.hashToken(token));
  if (!session || !repository.viewerSessionLive(session) || session.permissions?.view !== true || session.permissions?.measure !== true
      || !['ops','client'].includes(session.audience) || typeof session.subject !== 'string' || !session.subject.trim() || session.subject.length > 200) return null;
  const model = session.sessionMode === 'review' ? repository.getModelVersion(session.modelId, session.modelVersionId) : repository.getModel(session.modelId);
  if (!model?.activeVersion || model.activeVersion.id !== session.modelVersionId || model.activeVersion.status !== 'ready' || (session.sessionMode !== 'review' && model.status !== 'ready')) return null;
  const personalPersistence = session.audience === 'ops' || session.permissions.personalMeasurements === true;
  if (!personalPersistence && !allowTransient) return null;
  return { modelId: session.modelId, modelVersionId: session.modelVersionId, audience: session.audience, subject: session.subject, session, personalPersistence };
}

function measurementAdmin(req, principal, database) {
  // Viewer model access is not administrative authority. A separately issued,
  // live workspace capability for the same person is mandatory for advanced jobs.
  if (!principal || principal.audience !== 'ops') return null;
  const token = String(req.get('X-Viewer-Admin-Authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{32,128})$/i)?.[1];
  if (!token) return null;
  const processing = new ProcessingRepository(database);
  const session = processing.getAdminSessionByHash(auth.hashToken(token));
  return processing.adminSessionLive(session) && session.subject === principal.subject && session.permissions?.includes('viewer.processing.write') ? session : null;
}

function createMeasurementApi(repository, { preflightRaster, preflightPoint } = {}) {
  const router = express.Router();
  router.use('/temporary',createEphemeralMeasurementApi(repository,{config,preflightRaster,preflightPoint}));
  const measurements = new MeasurementRepository(repository.database);
  const sourceUnits = new MeasurementSourceUnitEvidence(repository.database);
  const principalFor = (req) => getMeasurementPrincipal(req, repository);
  const adminFor = (req, principal) => measurementAdmin(req, principal, repository.database);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const principal = getMeasurementPrincipal(req, repository, { allowTransient: true });
    if (!principal) return res.status(403).json({ error: 'Personal measurements require live signed-in model access and measure permission.', code: 'personal_measurements_unavailable' });
    if (!principal.personalPersistence) {
      if (req.method === 'GET' && ['/', '/capabilities'].includes(req.path)) return res.json({ measurements: [], capabilities: { personalPersistence: false, serverCalculations: false }, notice: 'Measurements are temporary until your portal provides a verified individual identity.' });
      return res.status(403).json({ error: 'Personal persistence requires a verified individual identity.', code: 'personal_measurement_identity_required' });
    }
    req.measurementPrincipal = principal;
    if (!['GET','HEAD'].includes(req.method) && repository.rateLimited(`measurement-write:${principal.audience}:${principal.subject}`, 180, 60_000)) return res.status(429).json({ error: 'measurement_rate_limited', code: 'measurement_rate_limited' });
    next();
  });
  const endpoint = (fn) => (req, res, next) => { try { fn(req, res); } catch (error) { next(error); } };
  router.get('/capabilities', endpoint((req, res) => {
    const authorized = Boolean(adminFor(req, req.measurementPrincipal)) && config.measurementCalculationsEnabled !== false;
    const rasterAuthorized = config.measurementCalculationsEnabled !== false;
    const version = rasterAuthorized ? repository.getModelVersion(req.measurementPrincipal.modelId, req.measurementPrincipal.modelVersionId)?.activeVersion : null;
    const hasMeshCrs = Number(version?.georef?.epsg) > 0 || (Number(version?.georef?.utmZone) >= 1 && Number(version?.georef?.utmZone) <= 60);
    const calculationSources = (version?.assets || []).filter(asset => asset.sha256).flatMap(asset => {
      const methods = ['dsm','dtm'].includes(asset.kind) && /^(tif|tiff|geotiff)$/i.test(asset.format || '') ? ['surface-cut-fill','surface-transect'] : authorized && asset.kind === 'obj' && asset.format === 'obj' && hasMeshCrs ? ['closed-mesh'] : asset.kind === 'ept' && asset.format === 'ept' && asset.manifestSha256 ? ['point-surface-cut-fill','surface-transect'] : [];
      if(authorized&&methods.length&&hasMeshCrs&&['obj','ept'].includes(asset.kind)&&reconstructionAvailable(config))methods.push('reconstructed-estimate');
      const unitEvidence=sourceUnits.summary(req.measurementPrincipal.modelId,version.id,asset);
      return methods.length ? [{ assetId: asset.id, kind: asset.kind, format: asset.format, byteSize: asset.byteSize ?? null, modelVersionId: version.id, sha256: asset.sha256, ...(asset.manifestSha256?{manifestSha256:asset.manifestSha256}:{}), ...(unitEvidence?{unitEvidence}:{}), methods }] : [];
    });
    res.json({ capabilities: { personalPersistence: true, rasterCalculations: rasterAuthorized, pointSurfaceCalculations:rasterAuthorized, transectCalculations:rasterAuthorized, serverCalculations: authorized }, calculationSources, calculationMethods: [...new Set(calculationSources.flatMap(source => source.methods))] });
  }));
  router.get('/', endpoint((req, res) => {
    const collection = req.query.collection;
    if (collection !== undefined && !COLLECTIONS.has(collection)) throw problem('invalid_measurement_collection');
    res.json({ measurements: measurements.list(req.measurementPrincipal, collection), capabilities: { personalPersistence: true, rasterCalculations: config.measurementCalculationsEnabled !== false, transectCalculations:config.measurementCalculationsEnabled!==false, serverCalculations: Boolean(adminFor(req, req.measurementPrincipal)) && config.measurementCalculationsEnabled !== false } });
  }));
  router.post('/', endpoint((req, res) => {
    const result = measurements.create(req.measurementPrincipal, req.body);
    res.status(result.replayed ? 200 : 201).json(result);
  }));
  router.get('/:id', endpoint((req, res) => {
    const measurement = measurements.get(req.measurementPrincipal, req.params.id);
    if (!measurement) throw problem('measurement_not_found', 404);
    res.json({ measurement });
  }));
  router.put('/:id', endpoint((req, res) => res.json({ measurement: measurements.update(req.measurementPrincipal, req.params.id, req.body) })));
  router.delete('/:id', endpoint((req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => key !== 'revision')) throw problem('invalid_measurement_delete');
    measurements.delete(req.measurementPrincipal, req.params.id, req.body.revision);
    res.status(204).end();
  }));
  router.use(createMeasurementCalculationApi({ repository, measurements, getPrincipal: principalFor, admin: adminFor, config, preflightRaster, preflightPoint }));
  router.use((error, _req, res, next) => {
    if (!error.status) return next(error);
    res.status(error.status).json({ error: error.code, code: error.code });
  });
  return router;
}

module.exports = { createMeasurementApi, getMeasurementPrincipal, measurementAdmin };
