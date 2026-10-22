'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashFile, hashFileChunks, hashTree } = require('./storageManager');
const { lodDerivativeSpecs } = require('./lodDerivativePolicy');
const { CUTLINE_PATTERN, validateCutlineFile } = require('./orthophotoCutline');
const { recordImportedSourceUnits } = require('./importSourceUnitEvidence');

const ASSET_RULES = [
  ['tiles', /(^|\/)tileset\.json$/i, '3dtiles'],
  ['ept', /(^|\/)ept\.json$/i, 'ept'],
  ['glb', /(^|\/)(textured_model|model|odm_textured_model_geo)\.glb$/i, 'glb'],
  ['obj', /(^|\/)(odm_textured_model_geo|textured_model|model)\.obj$/i, 'obj'],
  ['ortho', /(^|\/)(odm_)?orthophoto[^/]*\.tiff?$/i, 'tif'],
  ['orthoCutline', CUTLINE_PATTERN, null],
  ['dsm', /(^|\/)dsm[^/]*\.tiff?$/i, 'tif'],
  ['dtm', /(^|\/)dtm[^/]*\.tiff?$/i, 'tif'],
  ['report', /(^|\/)odm_report\/(?:report|odm_report)\.pdf$/i, 'pdf', 'application/pdf'],
  ['shots', /(^|\/)shots\.geojson$/i, 'geojson'],
  ['pointCloud', /(^|\/)(odm_)?georeferenced_model\.(laz|las|ply)$/i, null],
];

function safeName(value, fallback) {
  const name = String(value || '').trim().slice(0, 240);
  return name || fallback;
}

function walkFiles(root, maxFiles = 100000) {
  const files = [];
  const walk = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(absolute, rel);
      else if (entry.isFile()) files.push({ relativePath: rel.replaceAll('\\', '/'), absolutePath: absolute, byteSize: stat.size });
      if (files.length > maxFiles) throw Object.assign(new Error('catalog source contains too many files'), { code: 'too_many_files' });
    }
  };
  walk(root);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function discoverAssets(root) {
  const files = walkFiles(root);
  const fileHashes=new Map();
  for(const file of files){const integrity=await hashFileChunks(file.absolutePath);fileHashes.set(file.relativePath,integrity);file.sha256=integrity.sha256;file.chunks=integrity.chunks;}
  const assets = [];
  for (const [kind, pattern, format, contentType] of ASSET_RULES) {
    const file = files.find((candidate) => pattern.test(candidate.relativePath) && (kind !== 'orthoCutline' || validateCutlineFile(candidate)));
    if (!file) continue;
    const integrity=fileHashes.get(file.relativePath);assets.push({ kind, relativePath: file.relativePath, format: format || path.extname(file.relativePath).slice(1).toLowerCase(), ...(contentType?{contentType}:{}), byteSize: file.byteSize, sha256: integrity.sha256, chunks:integrity.chunks });
  }
  const fingerprint = crypto.createHash('sha256');
  for (const file of files) fingerprint.update(`${file.relativePath}\0${file.byteSize}\0${fileHashes.get(file.relativePath).sha256}\n`);
  return { assets, sourceFingerprint: fingerprint.digest('hex'), files };
}

async function scanWebodm(config, progress = async () => {}) {
  const root = config.webodmMediaMount;
  if (!root || !fs.existsSync(root)) throw Object.assign(new Error('WebODM media mount is unavailable'), { code: 'source_unavailable' });
  const projectsRoot = path.join(root, 'project');
  if (!fs.existsSync(projectsRoot)) return [];
  const jobs = [];
  for (const project of fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const tasksRoot = path.join(projectsRoot, project.name, 'task');
    if (!fs.existsSync(tasksRoot)) continue;
    for (const task of fs.readdirSync(tasksRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const assetsRoot = path.join(tasksRoot, task.name, 'assets');
      if (fs.existsSync(assetsRoot)) jobs.push({ project: project.name, task: task.name, assetsRoot });
    }
  }
  const candidates = [];let totalFiles=0;const maxFiles=config.uploadMaxFiles||100000;
  for (let index = 0; index < jobs.length; index += 1) {
    const item = jobs[index], discovered = await discoverAssets(item.assetsRoot);totalFiles+=discovered.files.length;if(totalFiles>maxFiles)throw Object.assign(new Error('catalog scan contains too many files'),{code:'too_many_files'});
    if (discovered.assets.length) candidates.push({provider:'webodm',externalProjectId:item.project,externalTaskId:item.task,sourceRootKey:'webodm',sourceRelativePath:`project/${item.project}/task/${item.task}/assets`,sourceFingerprint:discovered.sourceFingerprint,suggestedProjectName:`WebODM Project ${item.project}`,suggestedTaskName:`WebODM Task ${item.task}`,assets:discovered.assets});
    await progress((index + 1) / Math.max(1, jobs.length));
  }
  return candidates;
}

async function scanTerra(config, progress = async () => {}) {
  const root = config.terraImportMount;
  if (!root || !fs.existsSync(root)) throw Object.assign(new Error('Terra import mount is unavailable'), { code: 'source_unavailable' });
  const top = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const candidates = [];let totalFiles=0;const maxFiles=config.uploadMaxFiles||100000;
  for (let index = 0; index < top.length; index += 1) {
    const projectRoot = path.join(root, top[index].name), children = fs.readdirSync(projectRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const taskRoots = children.length ? children.map((entry) => ({ name: entry.name, root: path.join(projectRoot, entry.name) })) : [{ name: top[index].name, root: projectRoot }];
    let found = false;
    for (const task of taskRoots) {
      const discovered = await discoverAssets(task.root);totalFiles+=discovered.files.length;if(totalFiles>maxFiles)throw Object.assign(new Error('catalog scan contains too many files'),{code:'too_many_files'});
      if (!discovered.assets.length) continue;
      found = true;
      candidates.push({provider:'terra',externalProjectId:top[index].name,externalTaskId:task.name,sourceRootKey:'terra_import',sourceRelativePath:path.relative(root,task.root).replaceAll('\\','/'),sourceFingerprint:discovered.sourceFingerprint,suggestedProjectName:safeName(top[index].name,'Terra Import'),suggestedTaskName:safeName(task.name,'Terra Model'),assets:discovered.assets});
    }
    if (!found) {
      const discovered = await discoverAssets(projectRoot);totalFiles+=discovered.files.length;if(totalFiles>maxFiles)throw Object.assign(new Error('catalog scan contains too many files'),{code:'too_many_files'});
      if (discovered.assets.length) candidates.push({provider:'terra',externalProjectId:top[index].name,externalTaskId:top[index].name,sourceRootKey:'terra_import',sourceRelativePath:top[index].name,sourceFingerprint:discovered.sourceFingerprint,suggestedProjectName:safeName(top[index].name,'Terra Import'),suggestedTaskName:safeName(top[index].name,'Terra Model'),assets:discovered.assets});
    }
    await progress((index + 1) / Math.max(1, top.length));
  }
  return candidates;
}

async function scanCatalog(provider, config, progress) {
  return provider === 'webodm' ? scanWebodm(config, progress) : scanTerra(config, progress);
}

function manifestHash(files) {
  return crypto.createHash('sha256').update(JSON.stringify(files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })))).digest('hex');
}

async function mapCatalogCandidate(operation, { processing, repository, storage, config }, progress = async () => {}, signal = null) {
  const payload = JSON.parse(operation.payload_json || '{}'), request = payload.request || {}, ids = payload.ids || {};
  const candidate = processing.getCatalogCandidate(payload.candidateId);
  if (!candidate) throw Object.assign(new Error('catalog candidate is unavailable'), { code: 'candidate_unavailable' });
  if(candidate.sourceFingerprint!==payload.sourceFingerprint)throw Object.assign(new Error('catalog source changed after mapping approval'),{code:'catalog_source_changed'});
  const approvedFingerprint=payload.sourceFingerprint;
  if (candidate.mapping && candidate.state === 'mapped') { processing.clearCatalogAdoptionIntent(operation.id);return {project:processing.getProject(candidate.mapping.projectId),task:processing.getTask(candidate.mapping.taskId),attempt:processing.getAttempt(candidate.mapping.attemptId),model:repository.getModelVersion(candidate.mapping.modelId,candidate.mapping.modelVersionId),candidate,requiredDerivatives:lodDerivativeSpecs(candidate.assets,{meshDerivativesEnabled:config.meshDerivativesEnabled,required:true})}; }
  if (candidate.provider === 'webodm' && request.storageMode !== 'external_reference') throw Object.assign(new Error('WebODM media is reference-only'), { code: 'invalid_storage_mode' });

  let project = processing.getProject(request.projectId || ids.projectId);
  if (!project) project = processing.createProject({id:ids.projectId,displayName:request.newProject.displayName,description:request.newProject.description,defaultUnits:request.newProject.defaultUnits||'imperial',createdBy:operation.subject,metadata:{catalogImportProvider:candidate.provider,catalogImportOperationId:operation.id}});
  await progress(0.05);

  let dataset = processing.getDataset(ids.datasetId, true);
  let sourceRootKey = candidate.sourceRootKey, sourceRelativePath = candidate.sourceRelativePath;
  if (!dataset) dataset = processing.createDataset({id:ids.datasetId,projectId:project.id,displayName:`${request.taskDisplayName} source`,sourceType:candidate.provider,storageMode:request.storageMode,rootKey:request.storageMode==='external_reference'?`${sourceRootKey}@${ids.datasetId}`:'datasets',relativePath:request.storageMode==='external_reference'?sourceRelativePath:ids.datasetId,status:'finalizing',createdBy:operation.subject,metadata:{catalogCandidateId:candidate.id,catalogImportOperationId:operation.id,externalProjectId:candidate.externalProjectId,externalTaskId:candidate.externalTaskId,sourceRootKey,sourceRelativePath}});
  if (dataset.status !== 'finalized') {
    let adoptionIntent=payload.adoptionIntent||null;
    if(request.storageMode==='adopted'){
      if(!adoptionIntent){const source=storage.resolve(sourceRootKey,sourceRelativePath,{mustExist:true}),stat=fs.statSync(source,{bigint:true}),scan=storage.scanTree(sourceRootKey,sourceRelativePath);adoptionIntent={rootKey:sourceRootKey,relativePath:sourceRelativePath,datasetRelative:ids.datasetId,sourceFingerprint:approvedFingerprint,sourceByteSize:scan.byteSize,sourceDev:String(stat.dev),sourceIno:String(stat.ino),sourceCtimeNs:String(stat.ctimeNs),sourceMtimeNs:String(stat.mtimeNs)};}
      if(!processing.setCatalogAdoptionIntent(operation.id,operation.lease_owner,adoptionIntent))throw Object.assign(new Error('catalog import lease was lost before adoption was journaled'),{code:'operation_lease_lost'});
    }
    const adopted = await storage.adoptImport(sourceRootKey, sourceRelativePath, ids.datasetId, {externalReference:request.storageMode==='external_reference',expectedFingerprint:approvedFingerprint,onProgress:(value)=>progress(0.05+value*0.5)});
    if(adopted.sourceToRemove&&!processing.setCatalogSourceCleanup(operation.id,operation.lease_owner,adoptionIntent))throw Object.assign(new Error('catalog import lease was lost before source cleanup was journaled'),{code:'operation_lease_lost'});
    const files = adopted.scan.files;
    for (const file of files) if (!file.sha256) file.sha256 = await hashFile(file.absolutePath);
    dataset = processing.finalizeDataset(dataset.id, files.map((file)=>({relativePath:file.relativePath,byteSize:file.byteSize,sha256:file.sha256,metadata:file.metadata||{}})), manifestHash(files));
    sourceRootKey=dataset.rootKey;sourceRelativePath=dataset.relativePath;
  }
  if(request.storageMode!=='external_reference'){sourceRootKey=dataset.rootKey;sourceRelativePath=dataset.relativePath;}
  await progress(0.6);

  let task = processing.getTask(ids.taskId);
  if (!task) task = processing.createTask({id:ids.taskId,projectId:project.id,datasetId:dataset.id,displayName:request.taskDisplayName,createdBy:operation.subject,metadata:{catalogCandidateId:candidate.id,catalogImportOperationId:operation.id,provider:candidate.provider,externalProjectId:candidate.externalProjectId,externalTaskId:candidate.externalTaskId}});
  const attempt = processing.createImportedAttempt({id:ids.attemptId,taskId:task.id,datasetId:dataset.id,providerTaskId:`${candidate.provider}:${candidate.externalProjectId}:${candidate.externalTaskId}`,createdBy:operation.subject,displayName:request.taskDisplayName,metadata:{catalogImport:true},staged:true});
  const assetRootKey=request.storageMode==='external_reference'?(candidate.provider==='webodm'?'webodm':'terra'):'datasets';
  const assetPrefix=sourceRelativePath;
  const originalRoot=request.storageMode==='external_reference'?storage.resolve(candidate.sourceRootKey,candidate.sourceRelativePath,{mustExist:true}):storage.resolve('datasets',dataset.relativePath,{mustExist:true}),assets=[];
  for(const asset of candidate.assets){const relativePath=[assetPrefix,asset.relativePath].filter(Boolean).join('/'),entry={kind:asset.kind,rootKey:assetRootKey,relativePath,format:asset.format,contentType:asset.contentType||null,byteSize:asset.byteSize,sha256:asset.sha256,chunks:asset.chunks||[],storageMode:request.storageMode,published:false,sourceAttemptId:attempt.id};if(['ept','tiles'].includes(asset.kind)){const tree=await hashTree(path.dirname(path.join(originalRoot,...asset.relativePath.split('/'))));entry.manifestSha256=tree.manifestSha256;entry.manifestFiles=tree.files;}assets.push(entry);}
  const registeredAssets=assets.filter((asset)=>asset.kind!=='tiles');
  const model=repository.upsertModelVersion({modelId:ids.modelId,versionId:ids.versionId,provider:candidate.provider,providerModelId:`catalog:${candidate.id}`,providerVersionId:approvedFingerprint,displayName:request.taskDisplayName,status:'importing',metadata:{projectName:project.displayName,taskName:task.displayName,catalogCandidateId:candidate.id,catalogImportOperationId:operation.id},versionMetadata:{catalogImport:true,storageMode:request.storageMode,catalogImportOperationId:operation.id},sourceLocator:{catalogImport:true,projectId:candidate.externalProjectId,taskId:candidate.externalTaskId,sourceRootKey,sourceRelativePath},assets:registeredAssets,makeActive:false});
  await recordImportedSourceUnits(operation, { processing, repository, storage }, model.id, ids.versionId, { signal });
  processing.setAttemptResult(attempt.id,model.id,ids.versionId);
  processing.registerModelOutput({versionId:ids.versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,rootKey:request.storageMode==='external_reference'?`${assetRootKey}@${ids.versionId}`:assetRootKey,relativePath:sourceRelativePath,storageMode:request.storageMode,status:'staged',byteSize:dataset.byteSize,assetCount:registeredAssets.length});
  const lodDerivatives=lodDerivativeSpecs(assets,{meshDerivativesEnabled:config.meshDerivativesEnabled,required:true});
  const currentCandidate=processing.getCatalogCandidate(candidate.id);if(currentCandidate.sourceFingerprint!==approvedFingerprint)throw Object.assign(new Error('catalog source changed while mapping'),{code:'catalog_source_changed'});
  await progress(0.98);
  return {project,task:processing.getTask(task.id),attempt:processing.getAttempt(attempt.id),model:repository.getModelVersion(model.id,ids.versionId),candidate:currentCandidate,requiredDerivatives:lodDerivatives};
}

module.exports = { ASSET_RULES, discoverAssets, mapCatalogCandidate, scanCatalog, scanTerra, scanWebodm, walkFiles };
