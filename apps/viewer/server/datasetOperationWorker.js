'use strict';

const crypto = require('node:crypto');
const { sanitizeLogMessage } = require('./processingSecurity');
const { mapCatalogCandidate, scanCatalog } = require('./catalogImport');
const { importWebodmTask } = require('./webodmTaskImport');
const { cleanupLodRecoveryMaterialization, processLodRecovery } = require('./lodRecovery');
const { processingReadyEvent } = require('./processingReadyEvent');
const { copyTaskPhotos } = require('./taskPhotoImports');

async function reconcileCatalogSourceCleanups(processing,storage,limit=20){let cleaned=0;for(const item of processing.pendingCatalogSourceCleanups(limit)){try{const removed=await storage.removeAdoptedSourceIfMatches(item.rootKey,item.relativePath,{fingerprint:item.sourceFingerprint,byteSize:item.sourceByteSize,cleanupId:item.id,sourceDev:item.sourceDev,sourceIno:item.sourceIno,sourceCtimeNs:item.sourceCtimeNs,sourceMtimeNs:item.sourceMtimeNs});if(!removed)continue;processing.clearCatalogSourceCleanup(item.id);cleaned+=1;}catch(error){if(error?.restoredSourceIdentity)processing.refreshCatalogSourceCleanupIdentity(item.id,item,error.restoredSourceIdentity);/* durable journal retries during maintenance */}}return cleaned;}
function reconcileCatalogAdoptionRecoveries(processing,storage,limit=20){let recovered=0;for(const item of processing.pendingCatalogAdoptionRecoveries(limit)){try{if(!item.datasetId||!processing.getDataset(item.datasetId,true))storage.reconcileAdoptionIntent(item.rootKey,item.relativePath,item.datasetRelative);processing.clearCatalogAdoptionIntent(item.id);recovered+=1;}catch{/* durable intent retries during maintenance */}}return recovered;}

function manifestHash(files) {
  const canonical = files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 }));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function finalizeUpload(operation, { processing, storage }, owner, updateProgress) {
  const upload = processing.getUpload(operation.upload_id);
  if (!upload) throw Object.assign(new Error('upload session is unavailable'), { code: 'upload_unavailable' });
  const existing = processing.getDataset(upload.datasetId, true);
  if (existing?.status === 'finalized') {
    processing.completeUpload(upload.id);
    storage.cleanupUpload(upload.id);
    return { dataset: existing };
  }
  if (!existing || upload.status !== 'finalizing') throw Object.assign(new Error('upload is not finalizing'), { code: 'upload_not_finalizing' });
  storage.requireSpace('datasets', upload.files.reduce((sum, file) => sum + file.byteSize, 0));
  const files = [];
  for (let index = 0; index < upload.files.length; index += 1) {
    const file = upload.files[index];
    const chunks = processing.listChunks(upload.id, file.id);
    const expected = Math.ceil(file.byteSize / upload.chunkSize) || 1;
    if (chunks.length !== expected || chunks.some((chunk, chunkIndex) => chunk.chunk_index !== chunkIndex))
      throw Object.assign(new Error('upload is incomplete'), { code: 'upload_incomplete' });
    files.push(await storage.assembleFile(upload, file, chunks, existing.relativePath));
    await updateProgress(0.05 + 0.9 * (index + 1) / Math.max(1, upload.files.length));
  }
  const dataset = processing.finalizeDataset(existing.id, files, manifestHash(files));
  processing.completeUpload(upload.id);
  storage.cleanupUpload(upload.id);
  return { dataset };
}

async function adoptImport(operation, { processing, storage }, owner, updateProgress) {
  const payload = JSON.parse(operation.payload_json || '{}');
  const existing = processing.getDataset(operation.dataset_id, true);
  const finishAuthorizationAndSource = () => {
    if (payload.storageMode === 'adopted' && ['dataset_import', 'terra_import'].includes(payload.rootKey)) {
      try {
        const source = storage.resolve(payload.rootKey, payload.relativePath, { mustExist: true });
        storage.removeAdoptedSource(source);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!processing.consumeOperationImportPreview(operation.id, payload.previewId))
      throw Object.assign(new Error('import authorization was lost'), { code: 'preview_claim_lost' });
  };
  if (existing?.status === 'finalized') {
    finishAuthorizationAndSource();
    return { dataset: existing };
  }
  if (!existing || existing.status !== 'finalizing') throw Object.assign(new Error('import dataset is unavailable'), { code: 'dataset_unavailable' });
  const externalReference = payload.storageMode === 'external_reference';
  const adopted = await storage.adoptImport(payload.rootKey, payload.relativePath, existing.relativePath, {
    externalReference,
    expectedFingerprint: payload.treeFingerprint,
    onProgress: updateProgress,
  });
  const files = adopted.scan.files.map((file) => ({
    id: crypto.randomUUID(),
    relativePath: file.relativePath,
    byteSize: file.byteSize,
    sha256: file.sha256,
    metadata: file.metadata || {},
  }));
  const dataset = processing.finalizeDataset(existing.id, files, manifestHash(files));
  finishAuthorizationAndSource();
  return { dataset };
}

function publicImportPreview(preview) {
  const value = preview.destinationSpace;
  return {...preview,destinationSpace:{availableBytes:Number(value.available),totalBytes:Number(value.total),reserveBytes:Number(value.reserve),requiredBytes:Number(value.required),sufficient:Boolean(value.ok)}};
}

async function previewImport(operation, { storage, config }, updateProgress, signal) {
  const payload = JSON.parse(operation.payload_json || '{}');
  const preview = await storage.previewImport(payload.rootKey, payload.relativePath, {
    maxFiles: config?.uploadMaxFiles || 100000,
    signal,
    onProgress: updateProgress,
  });
  return { request: { rootKey: payload.rootKey, relativePath: payload.relativePath }, preview, publicPreview: publicImportPreview(preview) };
}

async function processOneDatasetOperation(deps, owner) {
  const operation = deps.processing.claimDatasetOperation(owner);
  if (!operation) return false;
  let progress = Number(operation.progress) || 0;
  let lostLease = false;
  const controller = new AbortController();
  const heartbeat = () => {
    if (!deps.processing.heartbeatDatasetOperation(operation.id, owner, progress)) { lostLease = true; controller.abort(); }
  };
  const timer = setInterval(heartbeat, 2_000);
  timer.unref?.();
  const updateProgress = async (value) => {
    progress = Math.max(progress, Math.min(0.99, Number(value) || 0));
    heartbeat();
    if (lostLease) throw Object.assign(new Error('dataset operation lease was lost'), { code: 'operation_lease_lost' });
  };
  try {
    let result;
    if (operation.operation_type === 'upload_finalize') result = await finalizeUpload(operation, deps, owner, updateProgress);
    else if (operation.operation_type === 'import_preview') {
      const completed = await previewImport(operation, deps, updateProgress, controller.signal);
      if (lostLease || !deps.processing.completeImportPreviewOperation(operation.id, owner, completed))
        throw Object.assign(new Error('dataset operation lease was lost'), { code: 'operation_lease_lost' });
      return true;
    }
    else if (operation.operation_type === 'import_adopt') result = JSON.parse(operation.payload_json || '{}').rawPhotoCopy
      ? await copyTaskPhotos(operation, deps, updateProgress, controller.signal)
      : await adoptImport(operation, deps, owner, updateProgress);
    else if (operation.operation_type === 'catalog_scan') {
      const payload=JSON.parse(operation.payload_json||'{}'),candidates=await scanCatalog(payload.provider,deps.config,updateProgress);
      result=deps.processing.upsertCatalogScanCandidates({scanId:payload.scanId,provider:payload.provider,generation:payload.generation,candidates});
      deps.processing.classifyCatalogStaleness(payload.provider,payload.generation);
      deps.repository.audit({actorType:'admin',actorId:operation.subject,action:'catalog_import.scan_completed',entityType:'catalog_import_scan',entityId:payload.scanId,details:{provider:payload.provider,candidateCount:candidates.length}});
    }
    else if (operation.operation_type === 'catalog_map') {
      const payload=JSON.parse(operation.payload_json||'{}');
      if(payload.lodRecovery){result=await processLodRecovery(operation,deps,updateProgress,controller.signal);deps.repository.audit({actorType:'admin',actorId:operation.subject,action:'lod_recovery.materialized',entityType:'dataset_operation',entityId:operation.id,details:{sourceVersionId:result.recovery.sourceVersionId,targetVersionId:result.recovery.targetVersionId,recoveryRevision:result.recovery.recoveryRevision}});}
      else if(payload.webodmTaskImport){result=await importWebodmTask(operation,deps,updateProgress,controller.signal);deps.repository.audit({actorType:'admin',actorId:operation.subject,action:'webodm_task_import.completed',entityType:'dataset_operation',entityId:operation.id,details:{projectId:result.project.id,taskId:result.task.id,assetKinds:result.assetKinds}});}
      else{result=await mapCatalogCandidate(operation,deps,updateProgress,controller.signal);deps.repository.audit({actorType:'admin',actorId:operation.subject,action:'catalog_import.mapped',entityType:'catalog_import_candidate',entityId:result.candidate.id,details:{projectId:result.project.id,taskId:result.task.id,modelId:result.model.id}});}
    }
    else throw Object.assign(new Error('dataset operation type is unsupported'), { code: 'unsupported_operation' });
    let completed;
    if(operation.operation_type==='catalog_map'){
      if(!result?.attempt?.id||!Array.isArray(result.requiredDerivatives))throw Object.assign(new Error('catalog import returned an invalid readiness result'),{code:'invalid_import_result'});
      if(result.requiredDerivatives.length){
        if(result.attempt.status!=='ingesting')throw Object.assign(new Error('catalog import entered an unexpected derivative state'),{code:'invalid_import_state'});
        completed=deps.processing.activateImportedDerivativesForOperation(operation.id,owner,result.attempt.id,result.requiredDerivatives,result,result.retainedLeaseToken);
        if(completed&&JSON.parse(operation.payload_json||'{}').lodRecovery)deps.processing.recordProcessingEvent({attemptId:result.attempt.id,operationId:operation.id,eventType:'lod_recovery.awaiting_derivative',phase:'awaiting_derivatives',details:{sourceVersionId:result.recovery.sourceVersionId,targetVersionId:result.recovery.targetVersionId,recoveryRevision:result.recovery.recoveryRevision}});
      }else{
        if(result.attempt.status!=='ingesting')throw Object.assign(new Error('catalog import entered an unexpected readiness state'),{code:'invalid_import_state'});
        completed=deps.processing.completeDatasetOperationWithImportReadiness(operation.id,owner,result,processingReadyEvent(deps.processing,deps.config,result.attempt),result.retainedLeaseToken);
      }
    }else completed=deps.processing.completeDatasetOperation(operation.id,owner,result);
    if (lostLease || !completed)
      throw Object.assign(new Error('dataset operation lease was lost'), { code: 'operation_lease_lost' });
    if(operation.operation_type==='catalog_map'){deps.processing.clearCatalogAdoptionIntent(operation.id);await reconcileCatalogSourceCleanups(deps.processing,deps.storage,1);reconcileCatalogAdoptionRecoveries(deps.processing,deps.storage,1);}
  } catch (error) {
    if(error?.code==='retained_import_busy'&&deps.processing.deferDatasetOperation(operation.id,owner,5_000))return true;
    if(operation.operation_type==='catalog_map'){
      const payload=JSON.parse(operation.payload_json||'{}');
      if(payload.lodRecovery){try{deps.processing.rollbackLodRecoveryProvisional(operation.id,owner);cleanupLodRecoveryMaterialization(operation,deps);}catch{/* the operation remains failed and retryable with the same stable IDs */}}
      else try{deps.processing.rollbackCatalogMapProvisional(operation.id,owner);}catch{/* the operation remains failed and retryable with the same stable IDs */}
    }
    deps.processing.failDatasetOperation(operation.id, owner, error.code || 'dataset_operation_failed', sanitizeLogMessage(error.message));
    if(operation.operation_type==='catalog_map')reconcileCatalogAdoptionRecoveries(deps.processing,deps.storage,1);
  } finally {
    clearInterval(timer);
  }
  return true;
}

module.exports = { manifestHash, processOneDatasetOperation, reconcileCatalogAdoptionRecoveries, reconcileCatalogSourceCleanups };
