'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { MeasurementCalculationRepository } = require('./measurementCalculationRepository');
const {MeasurementRepository}=require('./measurementRepository');
const {validateTransectRequest,sameTransectEvidence}=require('./measurementTransectRequest');
const {emitMeasurementTiming,sanitizedMeasurementTiming,readQueueTiming}=require('./measurementTiming');
function authorizationLive(request, repository, processing) {
  const viewer = request.authority?.viewerHash ? repository.getViewerSessionByHash(request.authority.viewerHash) : null, admin = request.authority?.adminHash ? processing.getAdminSessionByHash(request.authority.adminHash) : null;
  const model = viewer && repository.getModel(viewer.modelId), version = viewer && repository.getModelVersion(viewer.modelId, viewer.modelVersionId)?.activeVersion;
  const live=repository.viewerSessionLive(viewer) && version?.status === 'ready' && (viewer.sessionMode === 'review' || (model?.status === 'ready' && model.activeVersion?.id === viewer.modelVersionId)) && viewer.permissions?.measure === true && viewer.permissions?.view === true && viewer.modelId === request.modelId && viewer.modelVersionId === request.modelVersionId && viewer.subject === request.authority?.subject;
  if(!live)return false;
  if(request.authority?.scope==='personal-point-surface')return Boolean(['point-surface-cut-fill','surface-transect'].includes(request.method)&&request.source?.kind==='ept'&&request.requireEncodedVerticalUnits===true&&!request.sourceVerticalUnit&&['ops','client'].includes(viewer.audience)&&viewer.audience===request.authority.audience&&(viewer.audience==='ops'||viewer.permissions.personalMeasurements===true));
  if(request.authority?.scope==='personal-raster')return Boolean(['surface-cut-fill','surface-transect'].includes(request.method)&&['dsm','dtm'].includes(request.source?.kind)&&['ops','client'].includes(viewer.audience)&&viewer.audience===request.authority.audience&&(viewer.audience==='ops'||viewer.permissions.personalMeasurements===true));
  return Boolean(viewer.audience === 'ops' && processing.adminSessionLive(admin) && admin.subject === viewer.subject && admin.permissions?.includes('viewer.processing.write'));
}
async function childCalculation(absolutePath, request, { config, isLive, sourceFiles, forkProcess = fork, onTiming }) {
  const started=performance.now();let timingMessages=0;
  const scratchRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'viewer-measurement-job-'));
  try { return await new Promise((resolve, reject) => {
    const child = forkProcess(path.join(__dirname, 'measurementCalculationChild.js'), [], { execArgv: ['--max-old-space-size=1024'], detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'], env: { ...process.env, UV_THREADPOOL_SIZE: '2', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', MEASUREMENT_POISSON_BIN: config.measurementPoissonBin || process.env.MEASUREMENT_POISSON_BIN || '/opt/poisson/PoissonRecon' } });
    let settled = false;
    const stop = (error, result) => { if (settled) return; settled = true; clearInterval(timer); clearTimeout(deadline); try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill(); } catch {} if (error) reject(Object.assign(new Error(error), { code: error })); else resolve(result); };
    const timer = setInterval(() => {
      if (!isLive()) return stop('measurement_authorization_or_lease_lost');
      // External buffers are outside V8's old-space cap. Linux RSS polling is
      // independent of the child's event loop and catches blocked decoders too.
      if (process.platform === 'linux' && child.pid) {
        try { const rss = Number(fs.readFileSync(`/proc/${child.pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024; if (rss > (config.measurementMemoryMiB || 4096) * 1024 * 1024) stop('measurement_memory_limit'); } catch { /* process exit is handled below */ }
      }
    }, 1000);
    const deadline = setTimeout(() => stop('measurement_timeout'), config.measurementTimeoutMs || 300_000);
    child.on('message', message => {
      if(message?.type==='timing'&&timingMessages++<8){const timing=sanitizedMeasurementTiming(message.timing);if(timing)emitMeasurementTiming(request,timing,onTiming);}
      if (message?.type === 'memory' && message.rss > (config.measurementMemoryMiB || 4096) * 1024 * 1024) stop('measurement_memory_limit');
      if (message?.type === 'result') stop(null, message.result);
      if (message?.type === 'error') stop(message.code);
    });
    child.on('error', () => stop('measurement_worker_unavailable'));
    // Exit can precede delivery of buffered IPC messages. Close follows stream
    // drainage, so a valid final result wins over a successful child exit.
    child.on('close', () => { if (!settled) stop('measurement_worker_interrupted'); });
    const raster = ['dsm', 'dtm'].includes(request.source?.kind);
    const pointGridCacheRoot = config.cacheMount ? path.join(path.resolve(config.cacheMount), 'measurement-point-surfaces-v1') : undefined;
    child.send({ absolutePath, request, maxCells: raster ? (config.measurementRasterMaxCells || 100_000_000) : (config.measurementMaxCells || 2_000_000), memoryMiB: config.measurementMemoryMiB || 4096, sourceFiles, scratchRoot, pointGridCacheRoot }, error => { if (error) stop('measurement_worker_unavailable'); });
  }); } finally { emitMeasurementTiming(request,{phase:'child',totalMs:performance.now()-started},onTiming);const resolved = path.resolve(scratchRoot); if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('viewer-measurement-job-')) await fs.promises.rm(resolved, { recursive: true, force: true }); }
}
async function processOneMeasurementCalculation({ repository, processing, storage, config, runCalculation = childCalculation }, owner) {
  if (config.measurementCalculationsEnabled === false) return false;
  const jobs = new MeasurementCalculationRepository(repository.database), job = jobs.claim(owner);
  if (!job) return require('./ephemeralMeasurementWorker').processOneEphemeralMeasurement({repository,processing,storage,config,runCalculation},owner);
  emitMeasurementTiming(job.request,readQueueTiming(repository.database,'measurement_calculation_jobs',job.id));
  try {
    const request = job.request;
    if (!authorizationLive(request, repository, processing)) throw Object.assign(new Error('authorization lost'), { code: 'measurement_authorization_lost' });
    const parentLive=()=>{if(request.method!=='surface-transect')return true;try{const measurement=new MeasurementRepository(repository.database).get({modelId:request.modelId,modelVersionId:request.modelVersionId,subject:request.authority.subject,audience:request.authority.audience},job.measurementId),version=repository.getModelVersion(request.modelId,request.modelVersionId)?.activeVersion;if(!measurement)return false;const rebuilt=validateTransectRequest({revision:measurement.revision,method:'surface-transect',parentCalculationId:request.parentCalculationId,line:request.line},measurement,version,jobs.parent(job.measurementId,request.parentCalculationId),{allowPointSurface:true});return sameTransectEvidence(request,rebuilt);}catch{return false;}};
    if(!parentLive())throw Object.assign(new Error('parent changed'),{code:'measurement_transect_parent_stale'});
    const asset = repository.getModelVersion(request.modelId, request.modelVersionId)?.activeVersion?.assets.find(a => a.id === request.source.id);
    if (!asset || ['sha256','rootKey','relativePath','byteSize','kind'].some(k => asset[k] !== request.source[k])) throw Object.assign(new Error('source changed'), { code: 'measurement_source_changed' });
    const absolutePath = storage.resolve(asset.rootKey, asset.relativePath, { mustExist: true });
    let sourceFiles;
    if(request.source.kind==='ept'){
      if(asset.manifestSha256!==request.source.manifestSha256)throw Object.assign(new Error('source changed'),{code:'measurement_source_changed'});
      sourceFiles=repository.database.prepare('SELECT relative_path AS relativePath,byte_size AS byteSize,sha256 FROM model_asset_files WHERE asset_id=? ORDER BY relative_path LIMIT 200001').all(asset.id);
      if(sourceFiles.length>200000)throw Object.assign(new Error('source index too large'),{code:'measurement_ept_selection_limit'});
    }
    const result = await runCalculation(absolutePath, request, { config, sourceFiles, isLive: () => authorizationLive(request, repository, processing) && parentLive() && jobs.heartbeat(job, owner) });
    if (!authorizationLive(request, repository, processing)) throw Object.assign(new Error('authorization lost'), { code: 'measurement_authorization_lost' });
    if(!parentLive())throw Object.assign(new Error('parent changed'),{code:'measurement_transect_parent_stale'});
    jobs.finish(job, owner, result);
  } catch (error) { jobs.finish(job, owner, null, /^[a-z][a-z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'measurement_calculation_failed'); }
  return true;
}
module.exports = { authorizationLive, childCalculation, processOneMeasurementCalculation };
