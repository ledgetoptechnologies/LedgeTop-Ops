'use strict';
const express = require('express');
const auth = require('./auth');
const { MeasurementCalculationRepository } = require('./measurementCalculationRepository');
const { reconstructionAvailable } = require('./measurementReconstructionSupport');
const { StorageManager } = require('./storageManager');
const {validateTransectRequest,sameTransectEvidence}=require('./measurementTransectRequest');
const {MeasurementSourceUnitEvidence}=require('./measurementSourceUnitEvidence');
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };
function validateCalculationRequest(input, measurement, version, {ordinaryPoint=false}={}) {
  if (!input || Array.isArray(input) || Object.keys(input).some(k => !['revision','method','sourceAssetId','reference','sourceVerticalUnit','selection','sourceCoordinateFrame','cellSizeM','classFilter','reconstruction'].includes(k)) || input.revision !== measurement.revision) fail('measurement_calculation_invalid');
  if (measurement.kind !== 'polygon' || measurement.vertices.length > 256) fail('measurement_volume_requires_bounded_polygon');
  if (!['surface-cut-fill','closed-mesh','point-surface-cut-fill','reconstructed-estimate'].includes(input.method)) fail('measurement_method_unavailable', 422);
  const reconstruction=input.method==='reconstructed-estimate',candidate=version?.assets?.find(a=>a.id===input.sourceAssetId);
  const mesh = input.method === 'closed-mesh'||(reconstruction&&candidate?.kind==='obj'), pointSurface = input.method === 'point-surface-cut-fill'||(reconstruction&&candidate?.kind==='ept');
  if(reconstruction&&!mesh&&!pointSurface)fail('measurement_native_source_unavailable',422);
  const asset = version?.assets?.find(a => a.id === input.sourceAssetId && (mesh ? a.kind === 'obj' : pointSurface ? a.kind === 'ept' : ['dsm','dtm'].includes(a.kind)));
  if (!asset || !(mesh ? /^obj$/i : pointSurface ? /^ept$/i : /^(tif|tiff|geotiff)$/i).test(asset.format || '') || !asset.sha256 || (pointSurface && !asset.manifestSha256)) fail('measurement_native_source_unavailable', 422);
  if (!/^EPSG:\d{4,6}$/i.test(measurement.coordinateReference.crs) || measurement.coordinateReference.verticalUnit !== 'm') fail('measurement_source_crs_unavailable', 422);
  const ref = input.reference || { type: 'boundary-triangulated' };
  if (!ref || Object.keys(ref).some(k => !['type','elevationM','offsetM'].includes(k)) || !['boundary-triangulated','fitted-plane','custom','lowest-boundary','highest-boundary','average-boundary'].includes(ref.type) || (ref.offsetM !== undefined && !Number.isFinite(ref.offsetM)) || (ref.elevationM !== undefined && !Number.isFinite(ref.elevationM)) || (ref.type === 'custom' && !Number.isFinite(ref.elevationM))) fail('measurement_reference_invalid');
  if (input.sourceVerticalUnit !== undefined && input.sourceVerticalUnit !== 'm') fail('measurement_vertical_unit_invalid');
  const cellSizeM=ordinaryPoint&&input.cellSizeM===undefined ? 0.1 : input.cellSizeM;
  if(ordinaryPoint&&input.sourceVerticalUnit!==undefined)fail('measurement_source_vertical_units_required',422);
  if(pointSurface&&((!reconstruction&&(!Number.isFinite(cellSizeM)||cellSizeM<.001||cellSizeM>100))||!['all','ground'].includes(input.classFilter||'all')||(!ordinaryPoint&&input.sourceVerticalUnit!=='m')))fail('measurement_point_surface_settings_invalid');
  if(reconstruction){const r=input.reconstruction;if(!r||Array.isArray(r)||Object.keys(r).some(k=>!['depth','normalRadiusM','supportDistanceM','acknowledgeInferredGeometry'].includes(k))||r.acknowledgeInferredGeometry!==true||!Number.isInteger(r.depth)||r.depth<6||r.depth>9||![r.normalRadiusM,r.supportDistanceM].every(v=>Number.isFinite(v)&&v>0&&v<=100))fail('measurement_reconstruction_settings_invalid');}
  let meshFields = {};
  if (mesh||reconstruction) {
    const selection = input.selection, vector = p => Array.isArray(p) && p.length === 3 && p.every(v => Number.isFinite(v) && Math.abs(v) <= 1e9);
    if (!selection || Array.isArray(selection) || Object.keys(selection).some(k => !['seed','minElevationM','maxElevationM'].includes(k)) || !vector(selection.seed) || ![selection.minElevationM,selection.maxElevationM].every(v=>Number.isFinite(v)&&Math.abs(v)<=1e9) || selection.maxElevationM <= selection.minElevationM || (mesh&&!['projected','local-enu'].includes(input.sourceCoordinateFrame))) fail('measurement_mesh_selection_invalid');
    const georef = version.georef || {}, expectedEpsg = Number(georef.epsg) || ((Number(georef.utmZone) >= 1 && Number(georef.utmZone) <= 60) ? (georef.hemisphere === 'S' ? 32700 : 32600) + Number(georef.utmZone) : 0);
    if (Number(measurement.coordinateReference.crs.split(':')[1]) !== expectedEpsg || !expectedEpsg) fail('measurement_source_crs_unavailable', 422);
    const sourceOffset = !mesh||input.sourceCoordinateFrame === 'projected' ? [0,0,0] : [georef.rtc?.e,georef.rtc?.n,georef.rtc?.z];
    if (!vector(sourceOffset)) fail('measurement_mesh_frame_unknown', 422);
    meshFields = { selection, sourceCoordinateFrame: mesh?input.sourceCoordinateFrame:'projected', sourceOffset, ...(reconstruction?{reconstruction:input.reconstruction}:{}) };
  }
  return { schemaVersion: 1, method: input.method, modelId: measurement.modelId, modelVersionId: measurement.modelVersionId,
    collection: measurement.collection, vertices: measurement.vertices, coordinateReference: measurement.coordinateReference, reference: ref,
    source: { id: asset.id, kind: asset.kind, rootKey: asset.rootKey, relativePath: asset.relativePath, sha256: asset.sha256, byteSize: asset.byteSize, ...(pointSurface?{manifestSha256:asset.manifestSha256}:{}) }, sourceVerticalUnit: input.sourceVerticalUnit || null, ...meshFields, ...(pointSurface?{cellSizeM,classFilter:input.classFilter||'all',...(ordinaryPoint?{requireEncodedVerticalUnits:true}:{})}:{}) };
}
function createMeasurementCalculationApi({ repository, measurements, getPrincipal, admin, config = {}, preflightRaster, preflightPoint }) {
  const router = express.Router(), jobs = new MeasurementCalculationRepository(repository.database);
  const sourceUnits = new MeasurementSourceUnitEvidence(repository.database);
  const rasterPreflight = preflightRaster || (async request => {
    const storage = new StorageManager(config);
    const absolutePath = storage.resolve(request.source.rootKey, request.source.relativePath, { mustExist: true });
    const { preflightNativeRaster } = await import('./measurementRasterCalculation.mjs');
    return preflightNativeRaster(absolutePath, request, { maxBlockBytes: Math.min(256, (config.measurementMemoryMiB || 4096) / 8) * 1024 * 1024 });
  });
  const gate = (req) => {
    const principal = getPrincipal(req), authority = principal && admin(req, principal);
    if (!principal) fail('personal_measurements_unavailable', 403);
    if (req.get('X-Viewer-Admin-Authorization') && !authority) fail('measurement_admin_required', 403);
    const measurement = measurements.get(principal, req.params.measurementId);
    if (!measurement) fail('measurement_not_found', 404);
    return { principal, authority, measurement };
  };
  const pointPreflight=preflightPoint||async function(request){
    const storage=new StorageManager(config),absolutePath=storage.resolve(request.source.rootKey,request.source.relativePath,{mustExist:true});
    const {preflightPointSurface}=await import('./measurementPointSurface.mjs');
    return preflightPointSurface(absolutePath,request,{requireEncodedVerticalUnits:request.requireEncodedVerticalUnits===true});
  };
  // Legacy/advanced jobs remain staff-only even when they share an owned polygon.
  const mayReadJob = (job, authority) => Boolean(job && (authority || (['surface-cut-fill','surface-transect'].includes(job.method)&&job.parameters?.sourceKind!=='ept') || (['point-surface-cut-fill','surface-transect'].includes(job.method)&&job.parameters?.requireEncodedVerticalUnits===true)));
  router.post('/:measurementId/calculations', async (req, res, next) => { try {
    const { principal, authority, measurement } = gate(req);
    if (!['surface-cut-fill','point-surface-cut-fill','surface-transect'].includes(req.body?.method) && !authority) fail('measurement_admin_required', 403);
    if (config.measurementCalculationsEnabled === false) fail('measurement_calculations_disabled', 503);
    if(req.body?.method==='reconstructed-estimate'&&!reconstructionAvailable(config))fail('measurement_reconstruction_unavailable',503);
    const version = repository.getModelVersion(principal.modelId, principal.modelVersionId)?.activeVersion;
    const transect=req.body?.method==='surface-transect';
    const request = transect?validateTransectRequest(req.body,measurement,version,jobs.parent(measurement.id,req.body.parentCalculationId),{allowPointSurface:true}):validateCalculationRequest(req.body, measurement, version,{ordinaryPoint:req.body?.method==='point-surface-cut-fill'&&(!authority||req.body.sourceVerticalUnit===undefined)});
    if(!transect){const evidence=sourceUnits.get(request);if(evidence)request.sourceUnitEvidence=evidence;}
    if(!authority&&request.source.kind==='ept'){
      if(request.sourceVerticalUnit)fail('measurement_source_vertical_units_required',422);
      request.requireEncodedVerticalUnits=true;
    }
    if (['surface-cut-fill','point-surface-cut-fill','surface-transect'].includes(request.method)) {
      let preflight;
      try { preflight=await (request.source.kind==='ept'?pointPreflight:rasterPreflight)(request); }
      catch (error) {
        const allowed = /^measurement_(source_|pixel_|rotated_|raster_)/.test(error.code || '');
        fail(allowed ? error.code : 'measurement_source_preflight_unavailable', 422);
      }
      // Awaited I/O may outlive access or an edit. Recheck before enqueuing,
      // retaining worker authorization/hash validation as an independent gate.
      const currentAccess = gate(req), current = currentAccess.measurement;
      if (current.revision !== measurement.revision) fail('measurement_calculation_invalid', 409);
      if(transect){const currentVersion=repository.getModelVersion(principal.modelId,principal.modelVersionId)?.activeVersion,rebuilt=validateTransectRequest(req.body,current,currentVersion,jobs.parent(current.id,req.body.parentCalculationId),{allowPointSurface:true});if(!sameTransectEvidence(request,rebuilt))fail('measurement_transect_parent_stale',409);}
      // Persist only an authenticated staff review after source preflight. An
      // encoded feet source must never acquire a metres assertion as a side effect.
      const verticalFactor=request.source.kind==='ept'?preflight?.vertical?.verticalFactor:preflight?.verticalFactor;
      if(!transect&&currentAccess.authority&&request.sourceVerticalUnit==='m'&&verticalFactor===1){
        request.sourceUnitEvidence=sourceUnits.recordStaffReview(request,currentAccess.principal.subject);
      }
    }
    // Keep only server-side capability hashes for worker revalidation, never raw
    // bearer values. They are omitted from every public job representation.
    request.authority = { viewerHash: auth.hashToken(String(req.get('authorization')).replace(/^Bearer\s+/i, '')), subject: principal.subject, audience: principal.audience, ...(authority ? { adminHash: auth.hashToken(String(req.get('X-Viewer-Admin-Authorization')).replace(/^Bearer\s+/i, '')) } : { scope: request.source.kind==='ept'?'personal-point-surface':'personal-raster' }) };
    res.status(202).json({ calculation: jobs.enqueue(measurement, request) });
  } catch (e) { next(e); } });
  router.get('/:measurementId/calculations/:jobId', (req, res, next) => { try {
    const { measurement, authority } = gate(req), calculation = jobs.get(measurement.id, req.params.jobId);
    if (!mayReadJob(calculation, authority)) fail('measurement_calculation_not_found', 404);
    res.json({ calculation });
  } catch (e) { next(e); } });
  router.get('/:measurementId/calculations', (req, res, next) => { try {
    const { measurement, authority } = gate(req);
    res.json({ calculations: jobs.list(measurement.id).filter(job=>mayReadJob(job,authority)) });
  } catch (e) { next(e); } });
  router.delete('/:measurementId/calculations/:jobId', (req, res, next) => { try {
    const { measurement, authority } = gate(req);
    if (!mayReadJob(jobs.get(measurement.id, req.params.jobId),authority)) fail('measurement_calculation_not_found', 404);
    jobs.cancel(measurement.id, req.params.jobId); res.status(204).end();
  } catch (e) { next(e); } });
  return router;
}
module.exports = { createMeasurementCalculationApi, validateCalculationRequest };
