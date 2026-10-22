'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { config } = require('./config');
const auth = require('./auth');
const {controllerOriginAllowed}=require('./controllerOrigins');
const { verifyServiceRequest, sha256Hex } = require('./serviceAuth');
const { idempotent } = require('./serviceIdempotency');
const { NodeOdmProvider } = require('./nodeOdmProvider');
const {inspectIngestRecovery,validateIngestRecoveryStorage,ingestRecoveryCandidate}=require('./processingIngestRecovery');
const { providerSubmissionState } = require('./providerSelection.mjs');
const { NO_AUTH_MARKER } = require('./providerAuth');
const { admitProviderEndpoint } = require('./providerAdmission');
const { adminOutputAssetKind, publicDerivativeKind, safeRelativePath, sanitizeLogMessage } = require('./processingSecurity');
const { publishedAssetIntegrityAllows } = require('./assets');
const { applyStorageMutation } = require('./storageLifecycle');
const { trashOutput, trashTaskTree, trashProjectTree, restoreContainerTrash, purgeContainerTrash } = require('./containerLifecycle');
const { mountGcpRoutes } = require('./gcpApi');
const { createClientGrantProxy, LOCAL_PATH: CLIENT_GRANTS_PATH } = require('./clientGrantProxy');
const { browseImportRoot, validateImportSelection } = require('./importBrowser');
const { mountTaskPhotoImports } = require('./taskPhotoImports');
const { viewerEligibleAssets } = require('./lodDerivativePolicy');
const { inspectLodRecoverySource } = require('./lodRecovery');
const { createStorageUsageMonitor } = require('./storageUsage');
const { taskImageInventory } = require('./taskImageInventory');
const { productDescriptor, registeredProducts, createDownloadCapabilities } = require('./productDownloads');

const PERMISSIONS = new Set(['viewer.projects.read','viewer.projects.write','viewer.datasets.read','viewer.datasets.write','viewer.datasets.import','viewer.processing.read','viewer.processing.write','viewer.processing.publish','viewer.providers.read','viewer.providers.write','viewer.storage.purge','viewer.gcp.read','viewer.gcp.write','viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.client_grants.manage']);
function validUnits(value) { return value === 'imperial' || value === 'metric'; }
function error(res,status,code,message=code,details) { return res.status(status).json({error:message,code,...(details?{details}:{})}); }
function pageQuery(req) { const raw=String(req.query.limit||'50');if(!/^\d{1,3}$/.test(raw))return null;const limit=Number(raw);if(limit<1||limit>100)return null;const cursor=req.query.cursor?String(req.query.cursor):null;if(cursor&&!/^[A-Za-z0-9_-]{8,2048}$/.test(cursor))return null;return{limit,cursor}; }
  function uploadView(processing,upload) { return {id:upload.id,datasetId:upload.datasetId,status:upload.status,chunkSize:upload.chunkSize,expiresAt:upload.expiresAt,files:upload.files.map((file)=>{const chunkCount=Math.ceil(file.byteSize/upload.chunkSize)||1,completedChunks=processing.listChunks(upload.id,file.id).map((c)=>c.chunk_index),done=new Set(completedChunks);return{id:file.id,relativePath:file.relativePath,byteSize:file.byteSize,sha256:file.sha256,processingRole:file.processingRole||'auto',chunkCount,completedChunks,missingChunks:Array.from({length:chunkCount},(_,i)=>i).filter((i)=>!done.has(i))};})}; }
function publicStorageSpace(value) { return {availableBytes:Number(value.available),totalBytes:Number(value.total),reserveBytes:Number(value.reserve),requiredBytes:Number(value.required),sufficient:Boolean(value.ok)}; }
function publicImportPreview(preview) { return {...preview,destinationSpace:publicStorageSpace(preview.destinationSpace)}; }
const shareVault=require('./shareTokenVault');
const {VIEW_KINDS}=require('./publicSharePolicy');
function adminShareView(share){return{id:share.id,modelId:share.modelId,label:share.label,permissions:share.permissions,allowedViews:share.allowedViews,linkRecoverable:Boolean(share.tokenCiphertext),hasPassword:share.hasPassword,expiresAt:share.expiresAt,displayUnits:share.displayUnits,createdAt:share.createdAt,revokedAt:share.revokedAt,accessCount:share.accessCount,lastAccessedAt:share.lastAccessedAt};}
function adminProjectShareView(share){return{id:share.id,projectId:share.projectId,label:share.label,permissions:share.permissions,hasPassword:share.hasPassword,expiresAt:share.expiresAt,displayUnits:share.displayUnits,versionPolicy:share.versionPolicy,createdAt:share.createdAt,revokedAt:share.revokedAt,accessCount:share.accessCount,lastAccessedAt:share.lastAccessedAt};}
function workspaceSessionView(session,accessToken){return{...(accessToken?{accessToken}:{}),session:{id:session.id,subject:session.subject,permissions:session.permissions,displayUnits:session.displayUnits,expiresAt:session.expiresAt},units:{default:config.defaultUnits,resolved:session.displayUnits},controllerOrigin:session.controllerOrigin};}
function onlyKeys(value,allowed){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every((key)=>allowed.includes(key));}
function requireIdempotencyKey(req,res,next){const key=req.get('Idempotency-Key');if(!key)return error(res,428,'idempotency_key_required','Idempotency-Key is required');if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key))return error(res,400,'invalid_idempotency_key');next();}
function optionDomain(spec){if(Array.isArray(spec.domain))return spec.domain;if(spec.domain&&typeof spec.domain==='object')return spec.domain;if(typeof spec.domain==='string'){try{return JSON.parse(spec.domain);}catch{return null;}}return null;}
function validateProviderOptions(options,byName){if(!options||Array.isArray(options)||typeof options!=='object'||Object.keys(options).length>200||Buffer.byteLength(JSON.stringify(options))>64*1024)return'invalid_provider_options';for(const[name,value]of Object.entries(options)){const spec=byName.get(name);if(!spec)return'invalid_provider_option';if(spec.type==='bool'&&typeof value!=='boolean')return'invalid_provider_option';if(spec.type==='int'&&!Number.isInteger(value))return'invalid_provider_option';if(spec.type==='float'&&(typeof value!=='number'||!Number.isFinite(value)))return'invalid_provider_option';if(!['bool','int','float'].includes(spec.type)&&(typeof value!=='string'||value.length>4000))return'invalid_provider_option';const domain=optionDomain(spec);if(Array.isArray(domain)&&!domain.includes(value))return'invalid_provider_option';if(domain&&!Array.isArray(domain)&&typeof value==='number'&&((Number.isFinite(domain.min)&&value<domain.min)||(Number.isFinite(domain.max)&&value>domain.max)))return'invalid_provider_option';}return null;}

function createProcessingApi({ repository, processing, storage, providerCredentials, providerFetch, clientGrantFetch }) {
  const router=express.Router();
  const productTickets=createDownloadCapabilities();
  const storageUsage=createStorageUsageMonitor({storage,database:processing.database});
  const isActivePublishedOutput=(output)=>output?.status==='published'&&repository.getModel(output.modelId)?.activeVersion?.id===output.id;
  const derivativeConfiguration=(worker)=>{const workerEnabled=typeof worker?.meshDerivatives==='boolean'?worker.meshDerivatives:null,mismatch=Boolean(worker?.live&&workerEnabled!==config.meshDerivativesEnabled);return{meshDerivativesEnabled:config.meshDerivativesEnabled,workerMeshDerivativesEnabled:workerEnabled,mismatch};};
  const publishedViewerAssets=(model)=>{const version=model?.activeVersion;if(!version)return[];const verificationAssets=version.lodVerificationAssets||version.assets,verifiedIds=new Set(viewerEligibleAssets(version.metadata,verificationAssets).map((asset)=>asset.id));return version.assets.filter((asset)=>verifiedIds.has(asset.id)&&asset.published&&publicDerivativeKind(asset.kind));};
  const workspaceOutput=(output)=>{const version=output?.modelId&&output?.id?repository.getModelVersion(output.modelId,output.id)?.activeVersion:null,assets=(version?.assets||[]).filter((asset)=>adminOutputAssetKind(asset.kind)),accessible=['ready','published'].includes(output.status),activePublished=isActivePublishedOutput(output),base=`/api/v1/processing/outputs/${encodeURIComponent(output.id)}`,download=accessible&&(['glb','ortho','dsm','dtm'].map((kind)=>assets.find((asset)=>asset.kind===kind)).find(Boolean)),report=accessible&&assets.find((asset)=>asset.kind==='report'),lod=output?.id?processing.lodDerivativeState(output.id,{meshDerivativesEnabled:config.meshDerivativesEnabled}):{status:'unavailable',canGenerate:false};return{...output,activePublished,lod,companionRepairAction:processing.companionRepairAction(output.id,{meshDerivativesEnabled:config.meshDerivativesEnabled}),downloadProducts:accessible?registeredProducts(version?.assets,{staff:true}).map(product=>({...product,grantUrl:`${base}/products/${encodeURIComponent(product.kind)}/download-grants`})):[],assetKinds:[...new Set(assets.map((asset)=>asset.kind))].sort(),assets:assets.map((asset)=>({kind:asset.kind,byteSize:asset.byteSize??null,contentType:asset.contentType||null,url:accessible?`${base}/assets/${encodeURIComponent(asset.kind)}`:null})),downloadUrl:download?`${base}/assets/${encodeURIComponent(download.kind)}`:null,reportUrl:report?`${base}/assets/report`:null,viewSessionUrl:activePublished?`${base}/view-sessions`:null};};
  const workspaceTask=(task)=>{const activeAttempt=task.activeAttemptId?processing.getAttempt(task.activeAttemptId):null,attempt=activeAttempt?.taskId===task.id?activeAttempt:processing.latestAttempt(task.id),storageSummary=processing.taskStorage(task.id,{limit:1}),outputPage=processing.listModelOutputsPage({taskId:task.id,limit:100}),version=attempt?.resultModelId&&attempt?.resultModelVersionId?repository.getModelVersion(attempt.resultModelId,attempt.resultModelVersionId)?.activeVersion:null,imageInventory=taskImageInventory(processing.database,task.id,version?.id),start=Date.parse(attempt?.startedAt||''),end=Date.parse(attempt?.completedAt||attempt?.updatedAt||''),georef=version?.georef||{},storedMetrics=version?.metadata?.processingMetrics||{},georeferencingCrs=typeof georef.crs==='string'?georef.crs:typeof georef.epsg==='string'||typeof georef.epsg==='number'?`EPSG:${georef.epsg}`:null;return{...task,latestAttempt:attempt,metrics:{averageGsdM:Number.isFinite(storedMetrics.averageGsdM)?storedMetrics.averageGsdM:null,surveyedAreaM2:Number.isFinite(storedMetrics.surveyedAreaM2)?storedMetrics.surveyedAreaM2:null,...imageInventory,reconstructedPointCount:version?.pointCount??storedMetrics.reconstructedPointCount??null,georeferencingCrs,processingDurationMs:Number.isFinite(start)&&Number.isFinite(end)&&end>=start?end-start:null,processingStatus:attempt?.status||task.status,outputCount:outputPage.totalCount,outputAvailable:outputPage.totalCount>0,taskDiskUsageBytes:storageSummary?.task?.totalBytes??null},outputs:outputPage.items.map(workspaceOutput)};};
  const serviceIdempotency=idempotent(repository);
  router.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');if(req.path===CLIENT_GRANTS_PATH&&req.method==='OPTIONS')return res.sendStatus(403);const origin=req.get('origin');if(req.path!==CLIENT_GRANTS_PATH&&controllerOriginAllowed(origin,config.opsControllerOrigins)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Expose-Headers','Location, Retry-After');res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type,Idempotency-Key,X-Upload-Token,X-Chunk-SHA256');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,PUT,DELETE,OPTIONS');}if(req.method==='OPTIONS')return controllerOriginAllowed(origin,config.opsControllerOrigins)?res.sendStatus(204):res.sendStatus(403);next();});

  function service(req) { const checked=verifyServiceRequest({headers:req.headers,method:req.method,path:req.originalUrl,rawBody:req.rawBody||Buffer.alloc(0),repository});if(!checked.ok)return null;req.servicePrincipal={keyId:checked.keyId};return req.servicePrincipal; }
  function presentedAdmin(req) { const token=String(req.get('authorization')||'').match(/^Bearer\s+([A-Za-z0-9_-]{32,128})$/i)?.[1];if(!token)return null;const session=processing.getAdminSessionByHash(auth.hashToken(token));if(!session||session.revokedAt)return null;return{token,session}; }
  function admin(req) { const presented=presentedAdmin(req);if(!presented||!processing.adminSessionLive(presented.session))return null;req.adminPrincipal=presented.session;return presented.session; }
  function authorize(permission,{hmacOnly=false}={}) { return (req,res,next)=>{const principal=hmacOnly?service(req):admin(req);if(!principal)return error(res,401,'authentication_required','authentication required');if(!hmacOnly&&!req.adminPrincipal.permissions.includes(permission))return error(res,403,'permission_denied','permission denied');req.actorId=hmacOnly?req.servicePrincipal.keyId:req.adminPrincipal.subject;next();}; }
  function authorizeAny(permissions) { return (req,res,next)=>{const principal=admin(req);if(!principal)return error(res,401,'authentication_required','authentication required');if(!permissions.some((permission)=>principal.permissions.includes(permission)))return error(res,403,'permission_denied','permission denied');req.actorId=principal.subject;next();}; }
  function authorizeOperationRetry(req,res,next){const principal=admin(req);if(!principal)return error(res,401,'authentication_required','authentication required');const operation=processing.getDatasetOperation(req.params.id,principal.subject),permission=operation?.type==='lod_recovery'?'viewer.processing.write':'viewer.datasets.import';if(!principal.permissions.includes(permission))return error(res,403,'permission_denied','permission denied');req.actorId=principal.subject;next();}
  createClientGrantProxy({ config, authorize, fetchImpl: clientGrantFetch || fetch }).mount(router);
  router.post('/api/v1/projects/:id/public-shares',authorize('viewer.shares.create'),(_req,res)=>error(res,410,'project_public_sharing_disabled','Public links are task-only. Share projects with Operations clients.'));
  function shareReceiptDefinition(req) {
    if (req.method !== 'POST') return null;
    if (/^\/api\/v1\/projects\/[^/]+\/public-shares$/.test(req.path)) return { scope: 'project-public-share', segment: 'project' };
    if (/^\/api\/v1\/processing\/outputs\/[^/]+\/shares$/.test(req.path)) return { scope: 'model-public-share', segment: 'view' };
    return null;
  }
  function shareTokenFromReceipt(definition, receipt) {
    return auth.idempotentShareToken({
      scope: definition.scope,
      sessionId: receipt.session_id || receipt.sessionId,
      idempotencyKey: receipt.idempotency_key || receipt.key,
      requestHash: receipt.request_hash || receipt.requestHash,
    });
  }
  function shareViewUrl(req, definition, receipt) {
    const base=config.publicBaseUrl||`${req.protocol}://${req.get('host')}`;
    return `${base}/${definition.segment}/${shareTokenFromReceipt(definition,receipt)}`;
  }
  function mutate(req,res,next) {
    const key=req.get('Idempotency-Key');
    if(!key)return error(res,428,'idempotency_key_required','Idempotency-Key is required');
    if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key))return error(res,400,'invalid_idempotency_key');
    if(req.servicePrincipal)return serviceIdempotency(req,res,next);
    if(req.path==='/api/v1/task-submissions')return next();
    const rawBody=req.rawBody||Buffer.alloc(0),requestHash=req.path.startsWith('/api/v1/processing/providers')
      ?providerCredentials.idempotencyFingerprint(req.method,req.originalUrl,rawBody)
      :sha256Hex(Buffer.concat([Buffer.from(`${req.method}\n${req.originalUrl}\n`),rawBody]));
    const durableOperation=/^\/api\/v1\/(?:admin\/uploads\/[^/]+\/finalize|dataset-imports\/(?:preview|adopt|copy)|processing\/(?:catalog-imports\/(?:scans|candidates\/[^/]+\/map)|outputs\/[^/]+\/(?:lod-recovery-attempts|companion-repair-attempts)))$/.test(req.path);
    const shareReceipt=shareReceiptDefinition(req);
    const reservation=durableOperation
      ?processing.reserveSubjectOperationReceipt({subject:req.actorId,key,method:req.method,path:req.originalUrl,requestHash})
      :processing.reserveAdminIdempotency({sessionId:req.adminPrincipal.id,key,method:req.method,path:req.originalUrl,requestHash});
    if(!reservation.created){
      const r=reservation.record,storedHash=r.request_sha256||r.request_hash;
      if(r.method!==req.method||r.path!==req.originalUrl||storedHash!==requestHash)return error(res,409,'idempotency_conflict');
      if(durableOperation&&r.operation_id&&r.response_status===null){const operation=processing.getDatasetOperation(r.operation_id,req.actorId);if(operation){const body={operation};res.setHeader('Idempotency-Replayed','true');res.setHeader('Location',`/api/v1/operations/${operation.id}`);res.setHeader('Retry-After','2');processing.completeSubjectOperationReceipt(req.actorId,key,202,body);return res.status(202).json(body);}}
      if(r.response_status!==null){
        res.setHeader('Idempotency-Replayed','true');
        const stored=JSON.parse(r.response_json||'null'),body=shareReceipt&&r.response_status===201
          ?{...stored,viewUrl:shareViewUrl(req,shareReceipt,r)}
          :stored;
        if(r.response_status===202&&body?.operation?.id){res.setHeader('Location',`/api/v1/operations/${body.operation.id}`);res.setHeader('Retry-After','2');}
        return r.response_status===204?res.status(204).end():res.status(r.response_status).json(body);
      }
      return error(res,409,'idempotency_in_progress');
    }
    req.adminIdempotency={sessionId:req.adminPrincipal.id,key,requestHash};
    let finalized=false;
    const finish=(body)=>{
      if(finalized||req.adminIdempotencyCompleted||res.statusCode>=500)return;
      finalized=true;
      if(durableOperation)return processing.completeSubjectOperationReceipt(req.actorId,key,res.statusCode,body);
      const stored=shareReceipt&&res.statusCode===201&&body&&typeof body==='object'
        ?Object.fromEntries(Object.entries(body).filter(([name])=>name!=='viewUrl'))
        :body;
      processing.completeAdminIdempotency(req.adminPrincipal.id,key,res.statusCode,stored);
    };
    const originalJson=res.json.bind(res),originalEnd=res.end.bind(res);
    res.json=(body)=>{finish(body);return originalJson(body);};
    res.end=(...args)=>{finish(null);return originalEnd(...args);};
    next();
  }
  const providerView=(provider)=>providerCredentials?providerCredentials.view(provider):provider;
  const subjectReceipt=(req)=>({subject:req.actorId,key:req.get('Idempotency-Key'),method:req.method,path:req.originalUrl,requestHash:sha256Hex(Buffer.concat([Buffer.from(`${req.method}\n${req.originalUrl}\n`),req.rawBody||Buffer.alloc(0)]))});
  mountTaskPhotoImports(router,{processing,storage,authorize,mutate,subjectReceipt,config});
  const providerAdmission=(endpoint)=>admitProviderEndpoint(endpoint,{exactOrigins:config.processingProviderOrigins,allowedCidrs:config.processingProviderAllowedCidrs});
  const providerCredentialFailure=(res,e)=>error(res,e.code==='provider_in_use'?409:e.code==='invalid_provider_credential'?400:503,e.code||'provider_credential_unavailable');
  const providerProbeFailure=(res,e)=>{
    if(e.code==='provider_credential_unavailable')return providerCredentialFailure(res,e);
    if(e.code==='provider_type_mismatch')return error(res,409,e.code,'The endpoint now reports a different provider engine. Re-add it after verifying the endpoint.');
    if(e.code==='provider_probe_ambiguous')return error(res,422,e.code,'The endpoint is API-compatible, but Viewer cannot safely distinguish NodeODM from ClusterODM.');
    if(e.code==='provider_probe_unsupported')return error(res,422,e.code,'The endpoint does not expose a supported NodeODM or ClusterODM capability response.');
    return error(res,422,'provider_probe_failed','Viewer could not authenticate to or probe the provider endpoint.');
  };
  function validatedPresetInput(body,current=null){
    if(!onlyKeys(body,['displayName','description','providerId','options','enabled']))return{error:'invalid_request'};
    const providerId=body.providerId??current?.providerId;
    const provider=processing.getProvider(providerId);
    if(!provider||!Array.isArray(provider.capabilities?.options)||!provider.capabilityFingerprint)return{error:'provider_capabilities_required'};
    const options=body.options??current?.options??{},invalid=validateProviderOptions(options,new Map(provider.capabilities.options.map((item)=>[item.name,item])));
    if(invalid)return{error:invalid};
    if(body.enabled!==undefined&&typeof body.enabled!=='boolean')return{error:'invalid_enabled'};
    if(body.displayName!==undefined&&(typeof body.displayName!=='string'||!body.displayName.trim()))return{error:'display_name_required'};
    if(body.description!==undefined&&body.description!==null&&typeof body.description!=='string')return{error:'invalid_description'};
    return{value:{displayName:body.displayName,description:body.description,options,enabled:body.enabled,providerType:provider.type,capabilityFingerprint:provider.capabilityFingerprint,providerId:provider.id}};
  }
  function validatedAttemptInput(taskId,body,datasetId=null){
    const p=processing.getProvider(body?.providerId);if(!p||!p.enabled)return{error:'provider_not_enabled',status:409};
    const availability=providerSubmissionState(p);if(!availability.eligible)return{error:availability.reason,status:409};
    if(!Array.isArray(p.capabilities?.options)||!p.capabilityFingerprint)return{error:'provider_capabilities_required',status:409};
    const preset=body?.presetId?processing.getPreset(body.presetId):null;if(body?.presetId&&(!preset||!preset.enabled))return{error:'invalid_preset',status:400};
    if(preset&&((preset.providerType&&preset.providerType!==p.type)||(preset.capabilityFingerprint&&preset.capabilityFingerprint!==p.capabilityFingerprint)))return{error:'stale_preset_capabilities',status:409};
    const userOptions=body?.options||{},required=['pc-ept','gltf','3d-tiles'];if(required.some((name)=>Object.hasOwn(userOptions,name)&&userOptions[name]!==true))return{error:'required_output_cannot_be_disabled',status:400};
    const options={...(preset?.options||{}),...userOptions},byName=new Map(p.capabilities.options.map((o)=>[o.name,o]));if(required.some((name)=>!byName.has(name)))return{error:'provider_missing_viewer_outputs',status:409};for(const name of required)options[name]=true;const invalid=validateProviderOptions(options,byName);if(invalid)return{error:invalid,status:400};
    const task=taskId?processing.getTask(taskId):null,dataset=processing.getDataset(task?.datasetId||datasetId,true);if(taskId&&(!task||!dataset||dataset.projectId!==task.projectId))return{error:'task_dataset_project_mismatch',status:409};const maxImages=Number(p.capabilities.maxImages),photoCount=dataset?.files?.filter((file)=>/\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i.test(file.relativePath)).length||0;if(Number.isSafeInteger(maxImages)&&maxImages>0&&photoCount>maxImages)return{error:'provider_image_limit_exceeded',status:409};
    return{value:{provider:p,preset,options}};
  }

  router.post('/api/v1/admin-grants',authorize('',{hmacOnly:true}),mutate,(req,res)=>{const b=req.body||{};if(!controllerOriginAllowed(b.controllerOrigin,config.opsControllerOrigins))return error(res,400,'invalid_controller_origin');if(b.targetSessionId!==undefined&&(typeof b.targetSessionId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(b.targetSessionId)||b.targetSessionId.length>128))return error(res,400,'invalid_target_session');if(typeof b.subject!=='string'||!b.subject||b.subject.length>200)return error(res,400,'invalid_subject');if(!Array.isArray(b.permissions)||b.permissions.some((p)=>!PERMISSIONS.has(p)))return error(res,400,'invalid_permissions');if(!validUnits(b.displayUnits))return error(res,400,'invalid_units');const authExpiry=Date.parse(b.authorizationExpiresAt||'');if(!Number.isFinite(authExpiry)||authExpiry<=Date.now())return error(res,400,'invalid_authorization_expiry');const authorizationExpiresAt=new Date(authExpiry).toISOString(),expiresAt=new Date(Math.min(authExpiry,Date.now()+config.sessionGrantTtlSeconds*1000)).toISOString();const grant=processing.createAdminGrant({controllerOrigin:b.controllerOrigin,targetSessionId:b.targetSessionId,subject:b.subject,permissions:[...new Set(b.permissions)],displayUnits:b.displayUnits,expiresAt,authorizationExpiresAt});res.status(201).json({grant:grant.token,grantExpiresAt:expiresAt,redeemUrl:`${config.publicBaseUrl||''}/api/v1/admin-sessions/redeem`,sessionTtlSeconds:config.adminSessionTtlSeconds});});

  router.post('/api/v1/admin-sessions/redeem',(req,res)=>{if(repository.rateLimited(`admin-redeem-ip:${req.ip}`,20,5*60_000))return error(res,429,'rate_limited','too many attempts');const authorization=req.get('authorization'),presented=authorization?presentedAdmin(req):null;if(authorization&&!presented)return error(res,401,'authentication_required','authentication required');const token=req.body?.grant;if(typeof token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(token))return error(res,400,'invalid_grant');if(presented&&!controllerOriginAllowed(presented.session.controllerOrigin,config.opsControllerOrigins))return error(res,401,'authentication_required');const grant=processing.redeemAdminGrant(token,Date.now(),{sessionId:presented?.session.id,subject:presented?.session.subject,controllerOrigin:presented?.session.controllerOrigin,allowedControllerOrigins:config.opsControllerOrigins});if(!grant)return error(res,410,'grant_unavailable','grant expired or already redeemed');if(presented&&presented.session.subject!==grant.subject)return error(res,403,'subject_mismatch','renewal grant subject does not match the current session');const expiresAt=new Date(Math.min(Date.parse(grant.authorizationExpiresAt),Date.now()+config.adminSessionTtlSeconds*1000)).toISOString();if(Date.parse(expiresAt)<=Date.now())return error(res,410,'authorization_expired');let accessToken,session;if(presented){accessToken=presented.token;session=processing.renewAdminSession(presented.session.id,{permissions:grant.permissions,displayUnits:grant.displayUnits,expiresAt});}else{accessToken=crypto.randomBytes(32).toString('base64url');session=processing.createAdminSession({controllerOrigin:grant.controllerOrigin,tokenHash:auth.hashToken(accessToken),subject:grant.subject,permissions:grant.permissions,displayUnits:grant.displayUnits,expiresAt});}res.json(workspaceSessionView(session,accessToken));});

  router.get('/api/v1/admin-sessions/current',(req,res)=>{const session=admin(req);if(!session||!controllerOriginAllowed(session.controllerOrigin,config.opsControllerOrigins))return error(res,401,'authentication_required','authentication required');return res.json(workspaceSessionView(session));});

  // Bounded control-plane summary for the Ops Data hub. This endpoint is
  // intentionally aggregate-only: no identifiers, paths, logs, or secrets.
  router.get('/api/v1/overview',authorize('',{hmacOnly:true}),(_req,res)=>{
    const db=processing.database;
    const projectCounts=db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS active FROM projects").get();
    const modelCounts=db.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN active_version_id IS NOT NULL THEN 1 ELSE 0 END),0) AS published FROM models').get();
    const modelBytes=db.prepare("SELECT COALESCE(SUM(byte_size),0) AS bytes FROM model_outputs WHERE status='published'").get();
    const jobCounts=db.prepare("SELECT COALESCE(SUM(CASE WHEN status IN ('admitted','initializing','uploading','committed','queued_upstream') THEN 1 ELSE 0 END),0) AS queued,COALESCE(SUM(CASE WHEN status IN ('running','ingesting','derivatives','cancelling') THEN 1 ELSE 0 END),0) AS running,COALESCE(SUM(CASE WHEN status='ready_for_review' THEN 1 ELSE 0 END),0) AS reviewReady,COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed FROM processing_attempts").get();
    const providerCounts=db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END),0) AS enabled,COALESCE(SUM(CASE WHEN enabled=1 AND (runtime_health='healthy' OR (runtime_health IS NULL AND last_health='healthy')) THEN 1 ELSE 0 END),0) AS healthy FROM processing_providers").get();
    const used=db.prepare("SELECT (SELECT COALESCE(SUM(d.byte_size),0) FROM datasets d WHERE d.status<>'trashed' AND d.storage_mode<>'external_reference' AND NOT EXISTS (SELECT 1 FROM processing_attempts a JOIN model_outputs o ON o.attempt_id=a.id WHERE a.dataset_id=d.id AND o.status<>'trashed' AND o.storage_mode='adopted'))+(SELECT COALESCE(SUM(byte_size),0) FROM model_outputs WHERE status<>'trashed' AND storage_mode<>'external_reference') AS bytes").get();
    const spaces=['datasets','models','cache','trash'].map((key)=>storage.space(key));
    const available=spaces.map((space)=>Number(space.available)).filter(Number.isFinite);
    const worker=processing.workerStatus(),lifecycle=processing.storageMutationSummary(),derivatives=derivativeConfiguration(worker);
    const lifecycleBlocked=lifecycle.some((row)=>row.status==='failed'&&Number(row.count)>0);
    res.json({
      schemaVersion:1,
      generatedAt:new Date().toISOString(),
      projects:{active:Number(projectCounts.active),total:Number(projectCounts.total)},
      models:{published:Number(modelCounts.published),total:Number(modelCounts.total),bytes:Number(modelBytes.bytes)},
      jobs:{queued:Number(jobCounts.queued),running:Number(jobCounts.running),reviewReady:Number(jobCounts.reviewReady),failed:Number(jobCounts.failed)},
      providers:{enabled:Number(providerCounts.enabled),healthy:Number(providerCounts.healthy),total:Number(providerCounts.total)},
      storage:{usedBytes:Number(used.bytes),availableBytes:available.length?Math.min(...available):null},
      platform:{ready:Boolean(worker.live&&!lifecycleBlocked&&!derivatives.mismatch),workerLive:Boolean(worker.live),lifecycleBlocked,configurationMismatch:derivatives.mismatch,meshDerivativesEnabled:derivatives.meshDerivativesEnabled},
    });
  });

  router.get('/api/v1/projects',authorize('viewer.projects.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');const result=processing.listProjectsPage(page);res.json({projects:result.items,nextCursor:result.nextCursor});});
  router.post('/api/v1/projects',authorize('viewer.projects.write'),mutate,(req,res)=>{const b=req.body||{};if(!b.displayName)return error(res,400,'display_name_required');if(b.defaultUnits&&!validUnits(b.defaultUnits))return error(res,400,'invalid_units');const project=processing.auditedMutation({actorId:req.actorId,action:'project.created',entityType:'project'},()=>processing.createProject({...b,createdBy:req.actorId,defaultUnits:b.defaultUnits||config.defaultUnits}));res.status(201).json({project});});
  router.get('/api/v1/projects/:id',authorize('viewer.projects.read'),(req,res)=>{const p=processing.getProject(req.params.id);return p?res.json({project:p}):error(res,404,'project_not_found');});
  router.get('/api/v1/projects/:id/public-shares',authorizeAny(['viewer.shares.read','viewer.shares.revoke']),(req,res)=>{const project=processing.getProject(req.params.id);if(!project)return error(res,404,'project_not_found');return res.json({shares:repository.listProjectShares(project.id).map(adminProjectShareView)});});
  router.delete('/api/v1/project-shares/:id',authorize('viewer.shares.revoke'),mutate,(req,res)=>{const share=repository.getProjectShare(req.params.id);if(!share)return error(res,404,'project_share_not_found');const revoked=repository.transaction(()=>{const updated=repository.revokeProjectShare(share.id,{actorId:req.actorId,reason:'revoked from Viewer workspace'});repository.audit({actorType:'admin',actorId:req.actorId,action:'project_share.revoked',entityType:'project_share',entityId:share.id,details:{projectId:share.projectId}});return updated;});return res.json({share:adminProjectShareView(revoked)});});
  router.patch('/api/v1/projects/:id',authorize('viewer.projects.write'),mutate,(req,res)=>{if(!onlyKeys(req.body,['displayName','description','tags','metadata','defaultUnits']))return error(res,400,'invalid_patch_fields');if(req.body?.defaultUnits&&!validUnits(req.body.defaultUnits))return error(res,400,'invalid_units');try{const p=processing.auditedMutation({actorId:req.actorId,action:'project.updated',entityType:'project',entityId:req.params.id},()=>processing.updateProject(req.params.id,req.body||{}));return p?res.json({project:p}):error(res,404,'project_not_found');}catch(e){return error(res,e.code?.includes('conflict')?409:400,e.code||'invalid_project');}});
  router.post('/api/v1/projects/:id/archive',authorize('viewer.projects.write'),mutate,(req,res)=>{const p=processing.auditedMutation({actorId:req.actorId,action:'project.archived',entityType:'project',entityId:req.params.id},()=>processing.archiveProject(req.params.id));return p?res.json({project:p}):error(res,409,'project_not_archivable');});
  router.delete('/api/v1/projects/:id',authorize('viewer.projects.write'),mutate,(req,res)=>{try{const trash=trashProjectTree(processing,storage,req.params.id,req.actorId);return res.json({trash});}catch(e){return error(res,409,e.code||'project_not_trashable');}});
  router.get('/api/v1/projects/:id/storage',authorize('viewer.datasets.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');const result=processing.projectStorage(req.params.id,page);return result?res.json(result):error(res,404,'project_not_found');});

  router.get('/api/v1/datasets',authorize('viewer.datasets.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');const result=processing.listDatasetsPage({...page,projectId:req.query.projectId||null});res.json({datasets:result.items,nextCursor:result.nextCursor});});
  router.post('/api/v1/datasets',authorize('viewer.datasets.write'),mutate,(req,res)=>{const b=req.body||{},project=processing.getProject(b.projectId);if(!project)return error(res,400,'invalid_project');if(!b.displayName)return error(res,400,'display_name_required');const id=crypto.randomUUID();const dataset=processing.auditedMutation({actorId:req.actorId,action:'dataset.created',entityType:'dataset',entityId:id,details:{projectId:b.projectId}},()=>processing.createDataset({...b,id,createdBy:req.actorId,storageMode:'managed',rootKey:'datasets',relativePath:id,status:'draft',sourceType:'upload'}));res.status(201).json({dataset});});
  router.get('/api/v1/datasets/:id',authorize('viewer.datasets.read'),(req,res)=>{const d=processing.getDataset(req.params.id,true);return d?res.json({dataset:d}):error(res,404,'dataset_not_found');});
  router.patch('/api/v1/datasets/:id',authorize('viewer.datasets.write'),mutate,(req,res)=>{if(!onlyKeys(req.body,['displayName','description','tags','metadata','projectId']))return error(res,400,'invalid_patch_fields');try{const d=processing.auditedMutation({actorId:req.actorId,action:'dataset.updated',entityType:'dataset',entityId:req.params.id},()=>processing.updateDatasetMetadata(req.params.id,req.body||{}));return d?res.json({dataset:d}):error(res,404,'dataset_not_found');}catch(e){return error(res,['dataset_reassociation_blocked','dataset_name_conflict'].includes(e.code)?409:400,e.code||'invalid_dataset');}});
  router.post('/api/v1/datasets/:id/archive',authorize('viewer.datasets.write'),mutate,(req,res)=>{const d=processing.auditedMutation({actorId:req.actorId,action:'dataset.archived',entityType:'dataset',entityId:req.params.id},()=>processing.archiveDataset(req.params.id));return d?res.json({dataset:d}):error(res,409,'dataset_not_archivable');});
  router.delete('/api/v1/datasets/:id',authorize('viewer.storage.purge'),mutate,(req,res)=>{const d=processing.getDataset(req.params.id);if(!d)return error(res,404,'dataset_not_found');if(processing.datasetReferences(d.id)>0||processing.activeDatasetOperations(d.id)>0)return error(res,409,'dataset_in_use');for(const uploadId of processing.cancelDatasetUploads(d.id))storage.cleanupUpload(uploadId);let item;if(d.storageMode==='external_reference'){item=processing.trashDataset(d.id,{trashRelative:'',actor:req.actorId});if(!item)return error(res,409,'dataset_not_trashable');}else{const mutation=processing.beginTrashMutation(d.id,req.actorId);if(!mutation)return error(res,409,'dataset_in_use');applyStorageMutation(processing,storage,mutation);item=processing.getTrash(mutation.trashId);}res.json({trash:item});});
  router.get('/api/v1/storage',authorize('viewer.datasets.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');res.json({storage:Object.fromEntries(['datasets','models','cache','trash'].map((key)=>{try{return[key,storage.space(key)];}catch(e){return[key,{error:e.code||'storage_unavailable'}];}})),usage:storageUsage.read(),trash:processing.listTrashPage(page)});});
  router.get('/api/v1/storage/mutations',authorize('viewer.storage.purge'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');try{const result=processing.listStorageMutationsPage({...page,status:req.query.status||null});res.json({mutations:result.items,nextCursor:result.nextCursor});}catch(e){return error(res,400,e.code||'invalid_status');}});
  router.post('/api/v1/storage/mutations/:id/retry',authorize('viewer.storage.purge'),mutate,(req,res)=>{if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');const mutation=processing.retryStorageMutation(req.params.id,req.actorId);if(!mutation)return error(res,409,'lifecycle_not_retryable');try{const completed=applyStorageMutation(processing,storage,mutation);return res.json({mutation:completed});}catch(e){return error(res,409,e.code||'lifecycle_failed');}});
  router.post('/api/v1/storage/import-cleanups/:id/retry',authorize('viewer.storage.purge'),mutate,(req,res)=>{if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');const cleanup=processing.retryTerminalImportCleanup(req.params.id,req.actorId);return cleanup?res.status(202).set('Retry-After','2').json({cleanup}):error(res,409,'cleanup_not_retryable');});
  router.post('/api/v1/storage/trash/:id/restore',authorize('viewer.storage.purge'),mutate,(req,res)=>{const item=processing.getTrash(req.params.id);if(!item)return error(res,404,'trash_not_found');if(['project','task'].includes(item.entityType)){const restored=restoreContainerTrash(processing,storage,item.id,req.actorId);return restored?res.json({[item.entityType]:restored}):error(res,409,'lifecycle_conflict');}if(item.entityType==='dataset'){const dataset=processing.getDataset(item.entityId);if(!dataset)return error(res,404,'trash_not_found');let restored;if(dataset.storageMode==='external_reference')restored=processing.restoreTrash(item.id,req.actorId);else{const mutation=processing.beginRestoreMutation(item.id,req.actorId);if(!mutation)return error(res,409,'lifecycle_conflict');applyStorageMutation(processing,storage,mutation);restored=processing.getDataset(dataset.id);}return res.json({dataset:restored});}if(item.entityType!=='output')return error(res,404,'trash_not_found');const current=processing.getModelOutput(item.entityId);let output;if(current?.storageMode!=='managed')output=processing.restoreMetadataOutput(item.id,req.actorId);else{const mutation=processing.beginRestoreMutation(item.id,req.actorId);if(mutation){applyStorageMutation(processing,storage,mutation);output=processing.getModelOutput(item.entityId);}}if(!output)return error(res,409,'lifecycle_conflict');return res.json({output});});
  router.delete('/api/v1/storage/trash/:id',authorize('viewer.storage.purge'),mutate,(req,res)=>{const item=processing.getTrash(req.params.id);if(!item||item.permanentlyDeletedAt)return error(res,404,'trash_not_found');if(req.body?.typedId!==item.entityId)return error(res,400,'typed_confirmation_required');if(['project','task'].includes(item.entityType)){if(!purgeContainerTrash(processing,storage,item.id,req.actorId))return error(res,409,'lifecycle_conflict');return res.status(204).end();}const dataset=item.entityType==='dataset'?processing.getDataset(item.entityId):null,output=item.entityType==='output'?processing.getModelOutput(item.entityId):null;if(dataset?.storageMode==='external_reference')processing.markTrashPurged(item.id,req.actorId);else if(output&&output.storageMode!=='managed')processing.purgeMetadataOutput(item.id,req.actorId);else{const mutation=processing.beginPurgeMutation(item.id,req.actorId);if(!mutation)return error(res,409,'lifecycle_conflict');applyStorageMutation(processing,storage,mutation);}res.status(204).end();});
  router.post('/api/v1/datasets/:id/uploads',authorize('viewer.datasets.write'),mutate,(req,res)=>{const d=processing.getDataset(req.params.id);if(!d||d.status!=='draft'||d.storageMode!=='managed')return error(res,409,'dataset_not_uploadable');const files=req.body?.files,roles=new Set(['auto','image','gcp_source','provider_input','administrative']);if(!Array.isArray(files)||!files.length||files.length>config.uploadMaxFiles)return error(res,400,'invalid_manifest');let total=0;const seen=new Set(),ids=new Set(),basenames=new Set();for(const f of files){const rel=safeRelativePath(f.relativePath),base=rel&&rel.split('/').at(-1).toLowerCase();if(!onlyKeys(f,['id','relativePath','byteSize','sha256','contentType','processingRole'])||typeof f.id!=='string'||!/^[A-Za-z0-9._-]{1,80}$/.test(f.id)||ids.has(f.id)||!rel||rel!==f.relativePath||!Number.isSafeInteger(f.byteSize)||f.byteSize<0||!/^[a-f0-9]{64}$/.test(f.sha256)||seen.has(f.relativePath)||basenames.has(base)||(f.contentType!==undefined&&typeof f.contentType!=='string')||(f.processingRole!==undefined&&!roles.has(f.processingRole)))return error(res,400,'invalid_manifest');if(f.processingRole===undefined)f.processingRole='auto';ids.add(f.id);seen.add(f.relativePath);basenames.add(base);total+=f.byteSize;if(!Number.isSafeInteger(total))return error(res,400,'manifest_too_large');}if(Buffer.byteLength(JSON.stringify(files))>config.uploadMaxManifestBytes)return error(res,413,'manifest_too_large');if(storage.sameFilesystem('datasets','cache'))storage.requireSpace('datasets',total*2);else{storage.requireSpace('datasets',total);storage.requireSpace('cache',total);}const expiresAt=new Date(Date.now()+24*3600_000).toISOString(),created=processing.resumeUpload(d.id,req.actorId,files,expiresAt)||processing.createUpload({datasetId:d.id,files,subject:req.actorId,chunkSize:config.uploadChunkBytes,expiresAt});res.status(201).json({upload:uploadView(processing,created.upload),uploadToken:created.token});});

  router.get('/api/v1/admin/uploads/:id',authorize('viewer.datasets.write'),(req,res)=>{const upload=processing.getUpload(req.params.id);if(!upload||Date.parse(upload.expiresAt)<=Date.now())return error(res,410,'upload_unavailable');if(upload.subject!==req.actorId)return error(res,403,'upload_subject_mismatch');if(!processing.verifyUploadToken(upload,req.get('X-Upload-Token')))return error(res,403,'invalid_upload_token');res.json({upload:uploadView(processing,upload)});});

  router.put('/api/v1/admin/uploads/:uploadId/files/:fileId/chunks/:index',authorize('viewer.datasets.write'),express.raw({type:'application/octet-stream',limit:config.uploadChunkBytes}),async(req,res,next)=>{try{const upload=processing.getUpload(req.params.uploadId);if(!upload||upload.status!=='open'||Date.parse(upload.expiresAt)<=Date.now())return error(res,410,'upload_unavailable');if(upload.subject!==req.actorId)return error(res,403,'upload_subject_mismatch');if(!processing.verifyUploadToken(upload,req.get('X-Upload-Token')))return error(res,403,'invalid_upload_token');const spec=upload.files.find((f)=>f.id===req.params.fileId),index=Number(req.params.index),count=spec?Math.ceil(spec.byteSize/upload.chunkSize)||1:0,expected=spec?(index===count-1?spec.byteSize-upload.chunkSize*(count-1):upload.chunkSize):0;if(!spec||!Number.isSafeInteger(index)||index<0||index>=count||!Buffer.isBuffer(req.body)||req.body.length!==expected)return error(res,400,'invalid_chunk');const sha=req.get('X-Chunk-SHA256');if(!/^[a-f0-9]{64}$/.test(sha||''))return error(res,400,'invalid_chunk_checksum');const written=storage.writeChunk(upload.id,spec.id,index,req.body,sha);const chunk=processing.recordChunk({uploadId:upload.id,fileId:spec.id,chunkIndex:index,relativePath:spec.relativePath,...written});res.status(written.replayed||chunk.replayed?200:201).json({chunk});}catch(e){next(e);}});
  router.post('/api/v1/admin/uploads/:id/finalize',authorize('viewer.datasets.write'),mutate,(req,res)=>{const upload=processing.getUpload(req.params.id);if(!upload||!['open','finalizing','complete'].includes(upload.status)||Date.parse(upload.expiresAt)<=Date.now())return error(res,409,'upload_not_open');if(upload.subject!==req.actorId)return error(res,403,'upload_subject_mismatch');if(!processing.verifyUploadToken(upload,req.body?.uploadToken))return error(res,403,'invalid_upload_token');if(upload.status==='open'){for(const file of upload.files){const chunks=processing.listChunks(upload.id,file.id),expected=Math.ceil(file.byteSize/upload.chunkSize)||1;if(chunks.length!==expected||chunks.some((c,i)=>c.chunk_index!==i))return error(res,409,'upload_incomplete');}}const operation=processing.createUploadFinalizeOperation(upload.id,req.actorId,subjectReceipt(req),req.actorId);return operation?res.status(202).set('Location',`/api/v1/operations/${operation.id}`).set('Retry-After','2').json({operation}):error(res,409,'upload_finalizing');});

  router.post('/api/v1/dataset-imports/preview',authorize('viewer.datasets.import'),mutate,(req,res)=>{const rootKey=req.body?.rootKey,relativePath=safeRelativePath(req.body?.relativePath);if(!['dataset_import','terra_import','webodm'].includes(rootKey))return error(res,400,'invalid_import_root');if(!relativePath)return error(res,400,'invalid_import');const operation=processing.createImportPreviewOperation({request:{rootKey,relativePath},subject:req.actorId,sessionId:req.adminPrincipal?.id,receipt:subjectReceipt(req),auditActorId:req.actorId});return res.status(202).set('Location',`/api/v1/operations/${operation.id}`).set('Retry-After','2').json({operation});});
  router.post('/api/v1/dataset-imports/adopt',authorize('viewer.datasets.import'),mutate,(req,res)=>{const sessionId=req.adminPrincipal?.id||null,preview=processing.getImportPreview(req.body?.previewToken,sessionId);if(!preview)return error(res,410,'preview_unavailable');if(preview.createdBy!==req.actorId)return error(res,403,'preview_subject_mismatch');if(!processing.getProject(req.body?.projectId))return error(res,400,'invalid_project');if(!['adopted','external_reference'].includes(req.body?.storageMode)||(preview.request.rootKey==='webodm'&&req.body.storageMode!=='external_reference'))return error(res,400,'invalid_storage_mode');const operation=processing.createImportAdoptOperation({previewToken:req.body.previewToken,sessionId,subject:req.actorId,projectId:req.body.projectId,displayName:req.body.displayName||pathName(preview.request.relativePath),storageMode:req.body.storageMode,receipt:subjectReceipt(req),auditActorId:req.actorId});return operation?res.status(202).set('Location',`/api/v1/operations/${operation.id}`).set('Retry-After','2').json({operation}):error(res,409,'preview_claimed');});

  router.get('/api/v1/operations',authorize('viewer.datasets.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');try{const result=processing.listDatasetOperationsPage({subject:req.actorId,status:req.query.status?String(req.query.status):null,projectId:req.query.projectId?String(req.query.projectId):null,...page});return res.set('Cache-Control','no-store').json({operations:result.items,nextCursor:result.nextCursor});}catch(e){return error(res,400,e.code||'invalid_query');}});
  router.get('/api/v1/operations/:id',authorize('viewer.datasets.read'),(req,res)=>{const operation=processing.getDatasetOperation(req.params.id,req.actorId);return operation?res.set('Cache-Control','no-store').json({operation}):error(res,404,'operation_not_found');});
  router.get('/api/v1/operation-receipts/:key',authorize('viewer.datasets.read'),(req,res)=>{if(!/^[A-Za-z0-9._:-]{8,128}$/.test(req.params.key))return error(res,400,'invalid_operation_key');const receipt=processing.getSubjectOperationReceipt(req.actorId,req.params.key);if(!receipt)return error(res,404,'operation_receipt_not_found');const operation=receipt.operationId?processing.getDatasetOperation(receipt.operationId,req.actorId):null;return res.json({receipt,operation});});
  router.post('/api/v1/operations/:id/cancel',authorize('viewer.datasets.import'),mutate,(req,res)=>{if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');const operation=processing.cancelImportPreviewOperation(req.params.id,req.actorId,req.actorId);return operation?res.set('Cache-Control','no-store').json({operation}):error(res,409,'operation_not_cancellable');});
  router.post('/api/v1/operations/:id/retry',authorizeOperationRetry,mutate,(req,res)=>{if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');const operation=processing.retryDatasetOperation(req.params.id,req.actorId,req.actorId);return operation?res.status(202).set('Location',`/api/v1/operations/${operation.id}`).set('Retry-After','2').json({operation}):error(res,409,'operation_not_retryable');});

  router.get('/api/v1/processing/providers',authorize('viewer.providers.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');const result=processing.listProvidersPage(page);res.json({providers:result.items.map(providerView),nextCursor:result.nextCursor});});
  router.post('/api/v1/processing/providers',authorize('viewer.providers.write'),mutate,async(req,res)=>{const b=req.body||{};if(!onlyKeys(b,['displayName','endpoint','credential']))return error(res,400,'invalid_request');const admitted=providerAdmission(b.endpoint);if(!admitted.ok)return error(res,400,admitted.code);if(typeof b.displayName!=='string'||!b.displayName.trim())return error(res,400,'display_name_required');if(b.credential!==undefined&&(!onlyKeys(b.credential,['token'])||!Object.hasOwn(b.credential,'token')||typeof b.credential.token!=='string'))return error(res,400,'invalid_provider_credential');const id=crypto.randomUUID(),token=b.credential?.token??'';let sealed=null,result;try{if(token)sealed=providerCredentials.seal(id,token);result=await new NodeOdmProvider({endpoint:admitted.origin,token,...(providerFetch?{fetchImpl:providerFetch}:{})}).capabilities();}catch(e){if(e.code==='invalid_provider_credential')return providerCredentialFailure(res,e);return providerProbeFailure(res,e);}const type=result.capabilities.providerType,provider=processing.upsertProvider({id,type,displayName:b.displayName,endpoint:admitted.origin,enabled:false,authEnvKey:sealed?null:NO_AUTH_MARKER,admissionLimit:type==='clusterodm'?4:1,credentialCiphertext:sealed?.ciphertext,credentialKeyId:sealed?.keyId,credentialUpdatedAt:sealed?new Date().toISOString():null,capabilities:result.capabilities,capabilityFingerprint:result.fingerprint,lastHealth:'healthy'},{actorId:req.actorId,action:'provider.created',entityType:'processing_provider',details:{detectedType:type,apiVersion:result.capabilities.apiVersion,engine:result.capabilities.engine,authenticationMode:sealed?'token':'none'}});res.status(201).json({provider:providerView(provider),detection:{providerType:type,apiVersion:result.capabilities.apiVersion,engine:result.capabilities.engine,engineVersion:result.capabilities.engineVersion}});});
  router.patch('/api/v1/processing/providers/:id',authorize('viewer.providers.write'),mutate,(req,res)=>{const current=processing.getProvider(req.params.id);if(!current)return error(res,404,'provider_not_found');if(!onlyKeys(req.body,['displayName','endpoint','enabled','admissionLimit']))return error(res,400,'invalid_patch_fields');if(req.body.enabled!==undefined&&typeof req.body.enabled!=='boolean')return error(res,400,'invalid_provider_enabled');const b={...current,...req.body},admitted=providerAdmission(b.endpoint);if(!admitted.ok)return error(res,400,admitted.code);b.endpoint=admitted.origin;if(typeof b.displayName!=='string'||!b.displayName.trim())return error(res,400,'display_name_required');if(!Number.isSafeInteger(b.admissionLimit)||b.admissionLimit<1||b.admissionLimit>100)return error(res,400,'invalid_admission_limit');const endpointChanged=b.endpoint!==current.endpoint;if(endpointChanged&&current.activeAttempts>0)return error(res,409,'provider_in_use');if(endpointChanged)b.enabled=false;if(b.enabled===true){try{providerCredentials.resolve(current.id);}catch(e){return providerCredentials.configured(current.id)?providerCredentialFailure(res,e):error(res,409,'provider_credential_required');}if(!processing.providerProbeCurrent(current.id))return error(res,409,'provider_probe_required');}try{const provider=processing.updateProviderMetadata(current.id,b,{actorId:req.actorId,action:'provider.updated',entityType:'processing_provider',details:{endpointChanged,enabled:b.enabled}});return res.json({provider:providerView(provider)});}catch(e){if(['provider_in_use','provider_credential_required','provider_probe_required'].includes(e.code))return error(res,409,e.code);throw e;}});
  router.put('/api/v1/processing/providers/:id/credential',authorize('viewer.providers.write'),mutate,(req,res)=>{const current=processing.getProvider(req.params.id);if(!current)return error(res,404,'provider_not_found');if(!onlyKeys(req.body,['token'])||!Object.hasOwn(req.body,'token'))return error(res,400,'invalid_provider_credential');try{const sealed=providerCredentials.seal(current.id,req.body.token),provider=processing.setProviderCredential(current.id,sealed,{actorId:req.actorId,action:current.credential.configured?'provider.credential_rotated':'provider.credential_configured',entityType:'processing_provider'});return res.json({provider:providerView(provider)});}catch(e){return providerCredentialFailure(res,e);}});
  router.delete('/api/v1/processing/providers/:id/credential',authorize('viewer.providers.write'),mutate,(req,res)=>{const current=processing.getProvider(req.params.id);if(!current)return error(res,404,'provider_not_found');try{const provider=processing.clearProviderCredential(current.id,{actorId:req.actorId,action:'provider.credential_cleared',entityType:'processing_provider'});return res.json({provider:providerView(provider)});}catch(e){return providerCredentialFailure(res,e);}});
  const capabilityRefreshes=new Map();
  router.post('/api/v1/processing/providers/:id/capabilities/refresh',authorize('viewer.providers.read'),async(req,res)=>{
    // Read-only callers may refresh observations, never change endpoints,
    // credentials, admission limits, enabled state, or processing jobs.
    if(!onlyKeys(req.body||{},[]))return error(res,400,'invalid_request');
    if(repository.rateLimited(`capability-refresh:${req.actorId}`,30,60_000))return error(res,429,'rate_limited');
    const p=processing.getProvider(req.params.id);if(!p)return error(res,404,'provider_not_found');
    try{
      let pending=capabilityRefreshes.get(p.id);
      if(!pending){
        if(repository.rateLimited(`capability-refresh-provider:${p.id}`,30,60_000))return error(res,429,'rate_limited');
        pending=(async()=>{const credential=providerCredentials.resolveWithRevision(p.id);
          const result=await new NodeOdmProvider({endpoint:p.endpoint,token:credential.token,providerType:p.type,...(providerFetch?{fetchImpl:providerFetch}:{})}).capabilities();
          const updated=processing.updateProviderCapabilities(p.id,{...result,health:'healthy',expectedCredentialRevision:credential.revision,expectedEndpoint:p.endpoint});
          if(!updated)throw Object.assign(new Error('provider_probe_stale'),{code:'provider_probe_stale'});
          return result;
        })();
        capabilityRefreshes.set(p.id,pending);
        pending.finally(()=>{if(capabilityRefreshes.get(p.id)===pending)capabilityRefreshes.delete(p.id);}).catch(()=>{});
      }
      const result=await pending,principal=admin(req);
      if(!principal)return error(res,401,'authentication_required');
      if(!principal.permissions.includes('viewer.providers.read'))return error(res,403,'permission_denied');
      res.set('Cache-Control','no-store');return res.json(result);
    }catch(e){if(e.code==='provider_probe_stale')return error(res,409,e.code);return providerProbeFailure(res,e);}
  });
  router.get('/api/v1/processing/providers/:id/capabilities',authorize('viewer.providers.read'),(req,res)=>{const p=processing.getProvider(req.params.id);return p?res.json({capabilities:p.capabilities,fingerprint:p.capabilityFingerprint,lastHealth:p.lastHealth,lastHealthAt:p.lastHealthAt,runtimeHealth:p.runtimeHealth,runtimeHealthAt:p.runtimeHealthAt,runtimeHealthError:p.runtimeHealthError}):error(res,404,'provider_not_found');});
  router.post('/api/v1/processing/providers/:id/capabilities/probe',authorize('viewer.providers.write'),mutate,async(req,res)=>{try{const p=processing.getProvider(req.params.id);if(!p)return error(res,404,'provider_not_found');const credential=providerCredentials.resolveWithRevision(p.id),result=await new NodeOdmProvider({endpoint:p.endpoint,token:credential.token,providerType:p.type,...(providerFetch?{fetchImpl:providerFetch}:{})}).capabilities(),updated=processing.updateProviderCapabilities(p.id,{...result,health:'healthy',expectedCredentialRevision:credential.revision,expectedEndpoint:p.endpoint},{auditActorId:req.actorId});if(!updated)return error(res,409,'provider_probe_stale');res.json(result);}catch(e){return providerProbeFailure(res,e);}});
  router.get('/api/v1/processing/presets',authorize('viewer.processing.read'),(_q,res)=>res.json({presets:processing.listPresets()}));
  router.post('/api/v1/processing/presets',authorize('viewer.providers.write'),mutate,(req,res)=>{const checked=validatedPresetInput(req.body||{});if(checked.error)return error(res,checked.error==='provider_capabilities_required'?409:400,checked.error);try{const preset=processing.createPreset(checked.value,{actorId:req.actorId,action:'processing_preset.created',entityType:'processing_preset'});return res.status(201).json({preset});}catch(e){return error(res,409,e.code||'preset_not_created');}});
  router.patch('/api/v1/processing/presets/:id',authorize('viewer.providers.write'),mutate,(req,res)=>{const current=processing.getPreset(req.params.id);if(!current)return error(res,404,'preset_not_found');if(current.builtIn)return error(res,409,'built_in_preset');const provider=processing.listProviders().find((item)=>item.type===current.providerType&&item.capabilityFingerprint===current.capabilityFingerprint),checked=validatedPresetInput(req.body||{},{...current,providerId:provider?.id});if(checked.error)return error(res,checked.error==='provider_capabilities_required'?409:400,checked.error);try{const preset=processing.updatePreset(current.id,checked.value,{actorId:req.actorId,action:'processing_preset.updated',entityType:'processing_preset'});return res.json({preset});}catch(e){return error(res,409,e.code||'preset_not_updated');}});
  router.delete('/api/v1/processing/presets/:id',authorize('viewer.providers.write'),mutate,(req,res)=>{const current=processing.getPreset(req.params.id);if(!current)return error(res,404,'preset_not_found');try{if(!processing.deletePreset(current.id,{actorId:req.actorId,action:'processing_preset.deleted',entityType:'processing_preset'}))return error(res,409,'preset_not_deleted');return res.status(204).end();}catch(e){return error(res,409,e.code||'preset_not_deleted');}});
  router.post('/api/v1/processing/catalog-imports/scans',authorize('viewer.datasets.import'),mutate,(req,res)=>{if(!onlyKeys(req.body,['provider'])||!['webodm','terra'].includes(req.body.provider))return error(res,400,'invalid_provider');const operation=processing.createCatalogScanOperation({provider:req.body.provider,subject:req.actorId,sessionId:req.adminPrincipal.id,receipt:subjectReceipt(req),audit:{actorId:req.actorId,action:'catalog_import.scan_queued',entityType:'dataset_operation',details:{provider:req.body.provider}}});return res.status(202).set('Location',`/api/v1/operations/${operation.id}`).set('Retry-After','2').json({operation});});
  // Validate the durable operation's parent before reserving its subject receipt.
  // A rejected request must never strand an idempotency key in the receipt table.
  const serverTaskImportPaths=['/api/v1/processing/server-task-imports','/api/v1/processing/webodm-task-imports'];
  router.get('/api/v1/processing/server-task-imports/browse',authorize('viewer.datasets.import'),(req,res)=>{const rawPath=req.query.path===undefined?'':String(req.query.path),rawLimit=String(req.query.limit||'50');if(!/^\d{1,3}$/.test(rawLimit))return error(res,400,'invalid_page');const limit=Number(rawLimit);if(limit<1||limit>100)return error(res,400,'invalid_page');try{return res.json(browseImportRoot(storage,{relativePath:rawPath,cursor:req.query.cursor?String(req.query.cursor):null,limit}));}catch(e){return error(res,e.code==='import_directory_too_large'?413:e.code==='invalid_cursor'?409:e.code==='import_mount_unavailable'?503:404,e.code||'import_path_unavailable');}});
  router.use(serverTaskImportPaths,authorize('viewer.datasets.import'),(req,res,next)=>req.method==='POST'&&typeof req.body?.projectId==='string'&&!processing.getProject(req.body.projectId)?error(res,400,'invalid_project'):next());
  router.use(serverTaskImportPaths,(req,res,next)=>{if(req.method!=='POST')return next();try{const expectedKind=req.baseUrl.endsWith('/webodm-task-imports')?'zip':'folder',selected=validateImportSelection(storage,String(req.body?.sourceRelativePath||'').trim(),{expectedKind});req.body.sourceRelativePath=selected.relativePath;req.importSourceKind=expectedKind;return next();}catch(e){return error(res,400,e.code||'invalid_import_source');}});
  router.post(serverTaskImportPaths,authorize('viewer.datasets.import'),requireIdempotencyKey,(req,res)=>{const b=req.body||{};if(!onlyKeys(b,['sourceRelativePath','projectId','taskDisplayName','externalTaskId'])||typeof b.sourceRelativePath!=='string'||!b.sourceRelativePath.trim()||typeof b.projectId!=='string'||typeof b.taskDisplayName!=='string'||!b.taskDisplayName.trim()||b.taskDisplayName.length>240||(b.externalTaskId!==undefined&&(typeof b.externalTaskId!=='string'||b.externalTaskId.length>200)))return error(res,400,'invalid_server_task_import');const project=processing.getProject(b.projectId);if(!project||project.status!=='active')return error(res,400,'invalid_project');const key=req.get('Idempotency-Key'),requestHash=sha256Hex(Buffer.concat([Buffer.from(`${req.method}\n${req.originalUrl}\n`),req.rawBody||Buffer.alloc(0)])),receipt={subject:req.actorId,key,method:req.method,path:req.originalUrl,requestHash},reserved=processing.reserveSubjectOperationReceipt(receipt);if(!reserved.created){const row=reserved.record;if(row.method!==req.method||row.path!==req.originalUrl||row.request_sha256!==requestHash)return error(res,409,'idempotency_conflict');const replay=processing.getDatasetOperation(row.operation_id,req.actorId);if(!replay)return error(res,409,'idempotency_in_progress');return res.status(202).set('Idempotency-Replayed','true').set('Location',`/api/v1/operations/${replay.id}`).set('Retry-After','2').json({operation:replay});}const request={sourceRelativePath:b.sourceRelativePath.trim(),sourceKind:req.importSourceKind,projectId:b.projectId,taskDisplayName:b.taskDisplayName.trim(),...(b.externalTaskId?{externalTaskId:b.externalTaskId.trim()}:{})};const operation=processing.createWebodmTaskImportOperation({request,subject:req.actorId,sessionId:req.adminPrincipal?.id||null,receipt,auditActorId:req.actorId});if(!operation)return error(res,400,'invalid_project');const body={operation};processing.completeSubjectOperationReceipt(req.actorId,key,202,body);return res.status(202).set('Location',`/api/v1/operations/${operation.id}`).set('Retry-After','2').json(body);});
  router.get('/api/v1/processing/catalog-imports/candidates',authorize('viewer.datasets.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');try{const result=processing.listCatalogCandidatesPage({provider:req.query.provider?String(req.query.provider):null,state:req.query.state?String(req.query.state):null,...page});return res.json({candidates:result.items,nextCursor:result.nextCursor});}catch(e){return error(res,400,e.code||'invalid_query');}});
  router.post('/api/v1/processing/catalog-imports/candidates/:id/map',authorize('viewer.datasets.import'),mutate,(req,res)=>{const b=req.body||{},candidate=processing.getCatalogCandidate(req.params.id);if(!candidate)return error(res,404,'candidate_not_found');if(!onlyKeys(b,['projectId','newProject','taskDisplayName','storageMode'])||Boolean(b.projectId)===Boolean(b.newProject))return error(res,400,'invalid_project_target');if(typeof b.taskDisplayName!=='string'||!b.taskDisplayName.trim()||b.taskDisplayName.length>240)return error(res,400,'invalid_task_display_name');if(!['external_reference','adopted'].includes(b.storageMode)||(candidate.provider==='webodm'&&b.storageMode!=='external_reference'))return error(res,400,'invalid_storage_mode');if(b.projectId&&!processing.getProject(b.projectId))return error(res,400,'invalid_project');if(b.newProject&&(!onlyKeys(b.newProject,['displayName','description','defaultUnits'])||typeof b.newProject.displayName!=='string'||!b.newProject.displayName.trim()||(b.newProject.defaultUnits!==undefined&&!validUnits(b.newProject.defaultUnits))))return error(res,400,'invalid_new_project');const request={...(b.projectId?{projectId:b.projectId}:{newProject:{displayName:b.newProject.displayName.trim(),...(b.newProject.description!==undefined?{description:b.newProject.description}:{}),...(b.newProject.defaultUnits!==undefined?{defaultUnits:b.newProject.defaultUnits}:{})}}),taskDisplayName:b.taskDisplayName.trim(),storageMode:b.storageMode};const operation=processing.createCatalogMapOperation({candidateId:candidate.id,subject:req.actorId,sessionId:req.adminPrincipal.id,request,receipt:subjectReceipt(req),audit:{actorId:req.actorId,action:'catalog_import.map_queued',entityType:'catalog_import_candidate'}});if(!operation)return error(res,409,'candidate_unavailable');return res.status(202).set('Location',`/api/v1/operations/${operation.id}`).set('Retry-After','2').json({operation});});
  router.get('/api/v1/processing/ready',authorize('viewer.processing.read'),(_req,res)=>{const worker=processing.workerStatus(),lifecycle=processing.storageMutationSummary(),configuration=derivativeConfiguration(worker),blocked=lifecycle.some((row)=>row.status==='failed'&&row.count>0),ok=worker.live&&!blocked&&!configuration.mismatch;res.status(ok?200:503).json({ok,worker,lifecycle,configuration});});
  router.get('/api/v1/processing/derivatives',authorize('viewer.processing.read'),(req,res)=>{const page=processing.listDerivativeJobsPage({limit:req.query.limit,cursor:req.query.cursor});return res.set('Cache-Control','no-store').json({derivatives:page.items,nextCursor:page.nextCursor});});
  router.post('/api/v1/processing/derivatives/:id/retry',authorize('viewer.processing.write'),mutate,(req,res)=>{if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');const derivative=processing.retryOptionalDerivative(req.params.id,req.actorId,{meshDerivativesEnabled:config.meshDerivativesEnabled});return derivative?res.status(202).set('Retry-After','2').json({derivative}):error(res,409,'derivative_not_retryable');});
  router.post('/api/v1/processing/outputs/:id/derivatives/tiles',authorize('viewer.processing.write'),mutate,(req,res)=>{if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');const derivative=processing.requestOptionalLodDerivative(req.params.id,req.actorId,{meshDerivativesEnabled:config.meshDerivativesEnabled});return derivative?res.status(202).set('Retry-After','2').json({derivative}):error(res,409,'lod_derivative_not_eligible');});
  router.post('/api/v1/processing/outputs/:id/lod-recovery-attempts',authorize('viewer.processing.write'),mutate,async(req,res,next)=>{if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');try{const inspected=await inspectLodRecoverySource(req.params.id,{processing,storage,config}),operation=processing.createLodRecoveryOperation({outputId:req.params.id,subject:req.actorId,sessionId:req.adminPrincipal.id,manifest:inspected.publicManifest,receipt:subjectReceipt(req),auditActorId:req.actorId});if(!operation)return error(res,409,'lod_recovery_not_eligible');return res.status(202).set('Location',`/api/v1/operations/${operation.id}`).set('Retry-After','2').json({operation});}catch(e){if(['lod_recovery_source_unavailable','lod_recovery_companion_changed','lod_recovery_kind_conflict','lod_recovery_not_eligible','lod_recovery_source_changed','lod_recovery_retry_required','lod_recovery_retry_exhausted','lod_recovery_in_progress','retained_dependency_missing','retained_dependency_unsafe','retained_dependency_ambiguous','retained_dependency_case_mismatch','retained_product_ambiguous','invalid_retained_source','source_changed'].includes(e.code))return error(res,409,e.code,e.code==='lod_recovery_retry_required'?'Retry the existing failed recovery operation.':e.code==='lod_recovery_retry_exhausted'?'The recovery retry allowance is exhausted and the retained assets may now be deleted.':e.code==='lod_recovery_in_progress'?'Another operator already owns the recovery operation.':'The model source is not eligible for immutable LOD recovery.',e.operationId?{operationId:e.operationId}:undefined);return next(e);}});
  router.post('/api/v1/processing/outputs/:id/companion-repair-attempts',authorize('viewer.processing.write'),mutate,async(req,res,next)=>{
    if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');
    if(!config.meshDerivativesEnabled)return error(res,409,'mesh_derivatives_disabled','Mesh derivative processing is disabled; enable it before repairing companion views.');
    try{
      const inspected=await inspectLodRecoverySource(req.params.id,{processing,storage,config});
      const operation=processing.createLodRecoveryOperation({outputId:req.params.id,subject:req.actorId,sessionId:req.adminPrincipal.id,manifest:inspected.publicManifest,receipt:subjectReceipt(req),auditActorId:req.actorId,companionRepair:true});
      if(!operation)return error(res,409,'lod_companion_repair_not_eligible','The original same-source companions or verified mesh are unavailable, or a newer attempt is active.');
      return res.status(202).set('Location',`/api/v1/operations/${operation.id}`).set('Retry-After','2').json({operation});
    }catch(e){
      if(String(e.code||'').startsWith('lod_recovery_')||String(e.code||'').startsWith('retained_')||['invalid_retained_source','source_changed'].includes(e.code))
        return error(res,409,e.code,'Companion repair could not validate the source. Existing versions have not been changed.',e.operationId?{operationId:e.operationId}:undefined);
      return next(e);
    }
  });
  router.get('/api/v1/diagnostics/runs',authorize('viewer.processing.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');const result=processing.listDiagnosticRunsPage(page);return res.json({runs:result.items,nextCursor:result.nextCursor});});
  router.get('/api/v1/attempts/:id/diagnostics',authorize('viewer.processing.read'),(req,res)=>{const eventLimit=/^\d{1,3}$/.test(String(req.query.eventLimit||'100'))?Number(req.query.eventLimit||100):100,logLimit=/^\d{1,4}$/.test(String(req.query.logLimit||'200'))?Number(req.query.logLimit||200):200,diagnostics=processing.attemptDiagnostics(req.params.id,{eventLimit,logLimit});if(diagnostics)diagnostics.recovery=ingestRecoveryCandidate(processing,req.params.id,storage);return diagnostics?res.json({diagnostics}):error(res,404,'attempt_not_found');});
  router.get('/api/v1/processing/outputs',authorize('viewer.processing.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');try{const result=processing.listModelOutputsPage({...page,projectId:req.query.projectId||null,taskId:req.query.taskId||null,status:req.query.status||null});res.json({outputs:result.items.map(workspaceOutput),nextCursor:result.nextCursor,totalCount:result.totalCount,totalBytes:result.totalBytes});}catch(e){return error(res,400,e.code||'invalid_status');}});
  router.get('/api/v1/processing/outputs/:id/assets/:kind',authorize('viewer.processing.read'),async(req,res,next)=>{try{const output=processing.getModelOutput(req.params.id);if(!output||!['ready','published'].includes(output.status))return error(res,404,'output_asset_not_found');const kind=String(req.params.kind||'');if(!adminOutputAssetKind(kind))return error(res,404,'output_asset_not_found');const modelVersion=repository.getModelVersion(output.modelId,output.id),version=modelVersion?.activeVersion,asset=version?.assets.find((candidate)=>candidate.kind===kind);if(!asset||!safeRelativePath(asset.relativePath)||!asset.sha256)return error(res,404,'output_asset_not_found');if(kind==='report'&&(asset.format!=='pdf'||asset.contentType!=='application/pdf'||!asset.relativePath.toLowerCase().endsWith('.pdf')))return error(res,404,'output_asset_not_found');let absolute;try{absolute=storage.resolve(asset.rootKey,asset.relativePath,{mustExist:true});}catch{return error(res,404,'output_asset_not_found');}const stat=fs.statSync(absolute);if(!stat.isFile()||stat.size!==Number(asset.byteSize)||!await publishedAssetIntegrityAllows(repository,modelVersion,asset,asset.relativePath,absolute,req.get('range')))return error(res,409,'output_asset_changed','output asset failed its integrity check');const extension=path.extname(asset.relativePath).toLowerCase().replace(/[^.a-z0-9]/g,''),filename=`${kind}${extension||''}`;res.setHeader('Content-Type',asset.contentType||({'glb':'model/gltf-binary','ortho':'image/tiff','dsm':'image/tiff','dtm':'image/tiff','report':'application/pdf'}[kind])||'application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);return res.sendFile(absolute,(sendError)=>{if(sendError&&!res.headersSent)next(sendError);});}catch(e){next(e);}});
  router.post('/api/v1/processing/outputs/:id/view-sessions',authorize('viewer.processing.read'),mutate,(req,res)=>{if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');const output=processing.getModelOutput(req.params.id),model=output&&repository.getModel(output.modelId);if(!output||output.status!=='published'||!model?.activeVersion||model.activeVersion.id!==output.id)return error(res,404,'published_output_not_found');const publishedAssets=publishedViewerAssets(model),integrityReady=publishedAssets.length>0&&publishedAssets.every((asset)=>asset.sha256&&(!['ept','tiles'].includes(asset.kind)||(asset.manifestSha256&&repository.getModelAssetFile(asset.id,path.posix.basename(asset.relativePath)))));if(!integrityReady)return error(res,409,'asset_integrity_not_ready');const authorizedUntil=new Date(Math.min(Date.parse(req.adminPrincipal.expiresAt),Date.now()+config.viewerSessionTtlSeconds*1000)).toISOString();if(Date.parse(authorizedUntil)<=Date.now())return error(res,410,'authorization_expired');const grantExpiresAt=new Date(Math.min(Date.parse(authorizedUntil),Date.now()+config.sessionGrantTtlSeconds*1000)).toISOString(),grant=repository.createSessionGrantAudited({modelId:output.modelId,modelVersionId:output.id,sessionMode:'published',subject:req.actorId,audience:'ops',permissions:{view:true,measure:true,cameras:true,download:false,cameraPhotoDownload:true,__authorizedUntil:authorizedUntil,__versionId:output.id},displayUnits:req.adminPrincipal.displayUnits||config.defaultUnits,expiresAt:grantExpiresAt},{actorType:'admin',actorId:req.actorId,action:'processing_published_session.created',entityType:'model_output',entityId:output.id,details:{modelId:output.modelId,modelVersionId:output.id}}),base=config.publicBaseUrl||`${req.protocol}://${req.get('host')}`;return res.status(201).json({grant:grant.id,grantExpiresAt,sessionTtlSeconds:config.viewerSessionTtlSeconds,sessionMode:'published',modelId:output.modelId,modelVersionId:output.id,assetKinds:[...new Set(publishedAssets.map((asset)=>asset.kind))].sort(),redeemUrl:`${base}/api/v1/sessions/redeem`,embedUrl:`${base}/session/${encodeURIComponent(grant.id)}`});});
  router.post('/api/v1/processing/outputs/:id/archive',authorize('viewer.processing.publish'),mutate,(req,res)=>{if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');const output=processing.archiveModelOutput(req.params.id,req.actorId);if(!output)return error(res,409,'output_not_archivable');res.json({output});});
  router.delete('/api/v1/processing/outputs/:id',authorize('viewer.processing.publish'),mutate,(req,res)=>{const current=processing.getModelOutput(req.params.id);if(!current)return error(res,404,'output_not_found');const trash=trashOutput(processing,storage,current.id,req.actorId);if(!trash)return error(res,409,'output_not_trashable');const output=processing.getModelOutput(current.id);res.json({output,trash});});
  function registeredOutputProduct(id,kind) {
    const output=processing.getModelOutput(id);
    if(!output||!['ready','published'].includes(output.status))return null;
    const model=repository.getModelVersion(output.modelId,output.id);
    const asset=model?.activeVersion?.assets.find(candidate=>candidate.kind===kind);
    const product=productDescriptor(asset,{staff:true});
    return product?{model,asset,product}:null;
  }
  router.post('/api/v1/processing/outputs/:id/products/:kind/download-grants',authorize('viewer.processing.read'),(req,res,next)=>{
    try {
      if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');
      const id=req.params.id,kind=req.params.kind,selected=registeredOutputProduct(id,kind);
      if(!selected)return error(res,404,'download_product_not_found');
      const sessionHash=auth.hashToken(presentedAdmin(req).token),assetId=selected.asset.id,sha256=selected.asset.sha256;
      const ticket=productTickets.issue(()=>{
        const session=processing.getAdminSessionByHash(sessionHash);
        if(!processing.adminSessionLive(session)||!session.permissions.includes('viewer.processing.read'))return null;
        const current=registeredOutputProduct(id,kind);
        return current?.asset.id===assetId&&current.asset.sha256===sha256?current:null;
      },Date.parse(req.adminPrincipal.expiresAt));
      res.status(201).json({url:`/api/v1/processing/product-downloads/${ticket.token}`,expiresAt:ticket.expiresAt,fileName:selected.product.fileName});
    }catch(e){next(e);}
  });
  router.get('/api/v1/processing/product-downloads/:token',async(req,res,next)=>{
    try {
      const admitted=await productTickets.acquire(req.params.token),selected=admitted?.value;
      if(!selected)return error(res,403,'download_authorization_expired');
      const {asset,model,product}=selected;
      let absolute;try{absolute=storage.resolve(asset.rootKey,asset.relativePath,{mustExist:true});}catch{return error(res,404,'download_product_not_found');}
      const stat=fs.statSync(absolute);
      if(!stat.isFile()||stat.size!==asset.byteSize||!await publishedAssetIntegrityAllows(repository,model,asset,asset.relativePath,absolute,req.get('range')))return error(res,409,'output_asset_changed');
      // Integrity verification may be slow: honor revocation that happened
      // while it ran, before sending any source bytes.
      if(!await admitted.revalidate())return error(res,403,'download_authorization_expired');
      res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${product.fileName}"`);
      res.sendFile(absolute,{acceptRanges:true},sendError=>{if(sendError&&!res.headersSent)next(sendError);});
    }catch(e){next(e);}
  });
  // Read-only eligibility is shared by the modal and the mutation. Re-evaluate
  // inside the write transaction after password hashing; ready is not public.
  function outputShareState(output) {
    if (!output) return null;
    const active = isActivePublishedOutput(output);
    const attempt = processing.getAttempt(output.attemptId);
    const task = processing.getTask(output.taskId);
    const project = processing.getProject(output.projectId);
    const ready = output.status === 'ready' && attempt?.status === 'ready_for_review'
      && attempt.resultModelId === output.modelId && attempt.resultModelVersionId === output.id
      && attempt.taskId === output.taskId && task?.activeAttemptId === attempt.id
      && task.projectId === output.projectId && task.status !== 'archived' && project?.status === 'active';
    if (!active && !ready) return null;
    const version = repository.getModelVersion(output.modelId, output.id)?.activeVersion;
    const assets = version ? viewerEligibleAssets(version.metadata, version.assets)
      .filter(asset => publicDerivativeKind(asset.kind) && (!active || asset.published)) : [];
    const model = repository.getModel(output.modelId);
    const existingAccessUpdateRequired = !active && (
      Boolean(model?.activeVersionId && model.activeVersionId !== output.id)
      || repository.listPublicShares(output.modelId).some(share => repository.publicShareLive(share))
      || repository.listProjectShares(output.projectId).some(share => repository.projectShareLive(share)));
    return {
      publicationRequired: !active,
      existingAccessUpdateRequired,
      eligibleAssetKinds: [...new Set(assets.map(asset => asset.kind))].sort(),
    };
  }
  router.get('/api/v1/processing/outputs/:id/shares',authorize('viewer.shares.read'),(req,res)=>{
    const output=processing.getModelOutput(req.params.id),state=outputShareState(output);
    if(!state)return error(res,404,'published_output_not_found');
    return res.json({...state,shares:repository.listPublicShares(output.modelId)
      .filter(share=>share.shareClass==='staff').map(adminShareView)});
  });
  router.post('/api/v1/processing/outputs/:id/shares',authorize('viewer.shares.create'),mutate,async(req,res,next)=>{
    try {
      const b=req.body||{};
      if(!onlyKeys(b,['label','password','expiresAt','permissions','displayUnits','publishIfReady','selectedAssetKinds','allowExistingAccessUpdate','allowedViews']))
        return error(res,400,'invalid_share');
      for(const flag of ['publishIfReady','allowExistingAccessUpdate'])
        if(b[flag]!==undefined&&typeof b[flag]!=='boolean')return error(res,400,'invalid_share');
      if(b.selectedAssetKinds!==undefined&&(!Array.isArray(b.selectedAssetKinds)||!b.selectedAssetKinds.length
        ||b.selectedAssetKinds.some(kind=>!publicDerivativeKind(kind))))return error(res,400,'invalid_published_assets');
      if(b.password!==undefined&&b.password!==''&&String(b.password).length<8)return error(res,400,'password_too_short');
      const expiry=b.expiresAt?Date.parse(b.expiresAt):null;
      if(b.expiresAt&&(!Number.isFinite(expiry)||expiry<=Date.now()))return error(res,400,'invalid_expiry');
      const expiresAt=expiry?new Date(expiry).toISOString():null;
      if(b.displayUnits!==undefined&&!validUnits(b.displayUnits))return error(res,400,'invalid_units');
      const permissions=b.permissions||{view:true,measure:true,cameras:true,download:false};
      if(!onlyKeys(permissions,['view','measure','cameras','download'])||permissions.view!==true
        ||Object.values(permissions).some(value=>typeof value!=='boolean'))return error(res,400,'invalid_permissions');
      const initial=outputShareState(processing.getModelOutput(req.params.id));
      if(!initial)return error(res,404,'published_output_not_found');
      const availableViews=Object.keys(VIEW_KINDS).filter(view=>VIEW_KINDS[view].some(kind=>(b.selectedAssetKinds||initial.eligibleAssetKinds).includes(kind)));
      const allowedViews=b.allowedViews===undefined?availableViews:b.allowedViews;
      if(!Array.isArray(allowedViews)||!allowedViews.length||allowedViews.some(view=>!availableViews.includes(view)))return error(res,400,'invalid_allowed_views');
      const reject=(status,code)=>{throw Object.assign(new Error(code),{shareStatus:status,code});};
      const checkConsent=(state)=>{
        if(!state.publicationRequired)return;
        if(!req.adminPrincipal.permissions.includes('viewer.processing.publish'))reject(403,'permission_denied');
        if(b.publishIfReady!==true)reject(409,'publication_confirmation_required');
        if(state.existingAccessUpdateRequired&&b.allowExistingAccessUpdate!==true)
          reject(409,'existing_access_update_confirmation_required');
      };
      checkConsent(initial);
      const token=shareTokenFromReceipt({scope:'model-public-share'},req.adminIdempotency);
      const tokenHash=auth.hashToken(token),passwordHash=b.password?await auth.hashPassword(String(b.password)):null;
      // These repositories must share the connection for the publication, link,
      // audits and durable success receipt to be one atomic operation.
      if(repository.database!==processing.database)throw new Error('sharing requires a shared database');
      const body=processing.transaction(()=>{
        const output=processing.getModelOutput(req.params.id),state=outputShareState(output);
        if(!state)reject(409,'output_changed');
        const principal=processing.getAdminSessionByHash(auth.hashToken(String(req.get('authorization')).replace(/^Bearer\s+/i,'')));
        if(!principal||!processing.adminSessionLive(principal)||principal.revokedAt)reject(401,'authentication_required');
        if(!principal.permissions.includes('viewer.shares.create'))reject(403,'permission_denied');
        req.adminPrincipal=principal;
        checkConsent(state);
        if(expiresAt&&Date.parse(expiresAt)<=Date.now())reject(400,'invalid_expiry');
        if(state.publicationRequired){
          const selected=[...new Set(b.selectedAssetKinds||state.eligibleAssetKinds)];
          if(!selected.length||selected.some(kind=>!state.eligibleAssetKinds.includes(kind)))
            reject(400,'published_asset_unavailable');
          const version=repository.getModelVersion(output.modelId,output.id)?.activeVersion;
          const selectedAssets=(version?.assets||[]).filter(asset=>selected.includes(asset.kind));
          if(selectedAssets.some(asset=>!asset.sha256||(['ept','tiles'].includes(asset.kind)
            &&(!asset.manifestSha256||!repository.getModelAssetFile(asset.id,path.posix.basename(asset.relativePath))))))
            reject(409,'asset_integrity_not_ready');
          if(!processing.publishAttemptInTransaction(output.attemptId,selected,{actorId:req.actorId}))
            reject(409,'asset_integrity_not_ready');
        }
        let share=repository.createPublicShare({
          modelId:output.modelId,versionPolicy:'latest',modelVersionId:null,publicIdHash:tokenHash,
          passwordHash,permissions,label:b.label?String(b.label).slice(0,120):null,createdBy:req.actorId,
          expiresAt,displayUnits:b.displayUnits||req.adminPrincipal.displayUnits,shareClass:'staff',sourceAuthorization:null,
        });
        share=repository.updatePublicShare(share.id,{tokenCiphertext:shareVault.seal(token,tokenHash),allowedViews:[...new Set(allowedViews)]});
        repository.audit({actorType:'admin',actorId:req.actorId,action:'share.created',entityType:'share',
          entityId:share.id,details:{modelId:output.modelId,...(state.publicationRequired?{
            modelVersionId:output.id,publishedForSharing:true,existingAccessUpdateAcknowledged:b.allowExistingAccessUpdate===true,
          }:{})}});
        const result={share:adminShareView(share)};
        // Never persist the capability URL/token. Persist success before COMMIT
        // so a lost response replays the same link without a second publication.
        processing.completeAdminIdempotency(req.adminIdempotency.sessionId,req.adminIdempotency.key,201,result);
        return result;
      });
      req.adminIdempotencyCompleted=true;
      const base=config.publicBaseUrl||`${req.protocol}://${req.get('host')}`;
      return res.status(201).json({...body,viewUrl:`${base}/view/${token}`});
    } catch(e) {
      if(e.shareStatus)return error(res,e.shareStatus,e.code);
      if(e.code==='publish_conflict')return error(res,409,'publish_conflict');
      return next(e);
    }
  });
  router.get('/api/v1/processing/shares/:id/link',authorize('viewer.shares.read'),(req,res)=>{
    const share=repository.getPublicShare(req.params.id);
    if(!share||share.shareClass!=='staff')return error(res,404,'share_not_found');
    if(!repository.publicShareLive(share))return error(res,410,'share_expired_or_revoked');
    let token=share.tokenCiphertext?shareVault.open(share.tokenCiphertext,share.publicIdHash):null;
    if(!token&&!share.tokenCiphertext){
      const receipts=processing.database.prepare(`SELECT * FROM admin_idempotency WHERE method='POST' AND response_status=201 AND json_valid(response_json) AND json_extract(response_json,'$.share.id')=?`).all(share.id);
      for(const receipt of receipts){if(!/^\/api\/v1\/processing\/outputs\/[^/]+\/shares$/.test(receipt.path))continue;const candidate=shareTokenFromReceipt({scope:'model-public-share'},receipt);if(auth.hashToken(candidate)===share.publicIdHash){token=candidate;break;}}
    }
    if(!token)return error(res,409,'share_link_unavailable','The original link cannot be recovered; it has not been changed.');
    // Preserve verified receipt recovery beyond the original admin session's lifetime.
    if(!share.tokenCiphertext)repository.updatePublicShare(share.id,{tokenCiphertext:shareVault.seal(token,share.publicIdHash)});
    repository.audit({actorType:'admin',actorId:req.actorId,action:'share.link_retrieved',entityType:'share',entityId:share.id});
    return res.json({viewUrl:`${config.publicBaseUrl||`${req.protocol}://${req.get('host')}`}/view/${token}`});
  });
  router.patch('/api/v1/processing/shares/:id',authorize('viewer.shares.read'),authorize('viewer.shares.create'),mutate,async(req,res,next)=>{
    try{
      const b=req.body||{},share=repository.getPublicShare(req.params.id);
      if(!share||share.shareClass!=='staff')return error(res,404,'share_not_found');
      if(share.revokedAt)return error(res,409,'share_revoked');
      if(!onlyKeys(b,['label','password','expiresAt','permissions','allowedViews','displayUnits'])||!Object.keys(b).length)return error(res,400,'invalid_share');
      const patch={};
      if(b.label!==undefined){if(b.label!==null&&(typeof b.label!=='string'||b.label.length>120))return error(res,400,'invalid_label');patch.label=b.label||null;}
      if(b.password!==undefined){if(b.password!==null&&(typeof b.password!=='string'||(b.password!==''&&b.password.length<8)||b.password.length>1024))return error(res,400,'invalid_password');patch.passwordHash=b.password?await auth.hashPassword(b.password):null;}
      if(b.expiresAt!==undefined){const expiry=b.expiresAt===null?null:Date.parse(b.expiresAt);if(b.expiresAt!==null&&(!Number.isFinite(expiry)||expiry<=Date.now()))return error(res,400,'invalid_expiry');patch.expiresAt=expiry?new Date(expiry).toISOString():null;}
      if(b.permissions!==undefined){if(!onlyKeys(b.permissions,['view','measure','cameras','download'])||b.permissions.view!==true||Object.values(b.permissions).some(value=>typeof value!=='boolean'))return error(res,400,'invalid_permissions');patch.permissions=b.permissions;}
      if(b.allowedViews!==undefined){const model=repository.getModel(share.modelId),available=Object.keys(VIEW_KINDS).filter(view=>VIEW_KINDS[view].some(kind=>model?.activeVersion?.assets.some(asset=>asset.kind===kind&&asset.published)));if(!Array.isArray(b.allowedViews)||!b.allowedViews.length||b.allowedViews.some(view=>!available.includes(view)))return error(res,400,'invalid_allowed_views');patch.allowedViews=[...new Set(b.allowedViews)];}
      if(b.displayUnits!==undefined){if(!validUnits(b.displayUnits))return error(res,400,'invalid_units');patch.displayUnits=b.displayUnits;}
      // Password hashing yields; recheck the administrative session before committing.
      if(!admin(req))return error(res,401,'authentication_required');
      if(!['viewer.shares.read','viewer.shares.create'].every(p=>req.adminPrincipal.permissions.includes(p)))return error(res,403,'permission_denied');
      const updated=repository.transaction(()=>{const result=repository.updatePublicShare(share.id,{...patch,invalidateAuthorization:true});if(result)repository.audit({actorType:'admin',actorId:req.actorId,action:'share.updated',entityType:'share',entityId:share.id,details:{fields:Object.keys(patch)}});return result;});
      return updated?res.json({share:adminShareView(updated)}):error(res,409,'share_changed');
    }catch(e){next(e);}
  });
  router.delete('/api/v1/processing/shares/:id',authorize('viewer.shares.revoke'),mutate,(req,res)=>{const share=repository.getPublicShare(req.params.id);if(!share||share.shareClass!=='staff')return error(res,404,'share_not_found');const revoked=repository.transaction(()=>{const updated=repository.revokePublicShare(share.id,{actorId:req.actorId,reason:'revoked from Viewer workspace'});repository.audit({actorType:'admin',actorId:req.actorId,action:'share.revoked',entityType:'share',entityId:share.id});return updated;});return res.json({share:adminShareView(revoked)});});
  router.get('/api/v1/tasks',authorize('viewer.processing.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');const result=processing.listTasksPage({...page,projectId:req.query.projectId||null});res.json({tasks:result.items.map(task=>({...task,metrics:taskImageInventory(processing.database,task.id,task.latestAttempt?.resultModelVersionId)})),nextCursor:result.nextCursor});});
  router.post('/api/v1/tasks',authorize('viewer.processing.write'),requireIdempotencyKey,(req,res)=>{const b=req.body||{};if(!onlyKeys(b,['submissionId','projectId','datasetId','displayName'])||typeof b.submissionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.submissionId)||typeof b.projectId!=='string'||typeof b.datasetId!=='string'||typeof b.displayName!=='string'||!b.displayName.trim()||b.displayName.length>240)return error(res,400,'invalid_task_draft');const normalized={submissionId:b.submissionId.toLowerCase(),projectId:b.projectId,datasetId:b.datasetId,displayName:b.displayName.trim()},p=processing.getProject(normalized.projectId),d=processing.getDataset(normalized.datasetId);if(!p||p.status!=='active'||!d||d.status!=='finalized'||d.projectId!==p.id)return error(res,400,'invalid_project_or_dataset');try{const result=processing.createTaskDraft({subject:req.actorId,...normalized,requestHash:sha256Hex(Buffer.from(JSON.stringify(normalized)))});if(result.conflict)return error(res,409,'submission_conflict');return res.status(result.replayed?200:201).json(result);}catch(e){return error(res,409,e.code||'task_not_created');}});
  router.post('/api/v1/task-submissions',authorize('viewer.processing.write'),mutate,(req,res)=>{const b=req.body||{};if(!onlyKeys(b,['submissionId','projectId','datasetId','taskDisplayName','providerId','presetId','options'])||typeof b.submissionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.submissionId)||typeof b.taskDisplayName!=='string'||!b.taskDisplayName.trim()||b.taskDisplayName.length>240)return error(res,400,'invalid_submission');const project=processing.getProject(b.projectId),dataset=processing.getDataset(b.datasetId);if(!project||project.status!=='active'||!dataset||dataset.status!=='finalized'||dataset.projectId!==project.id)return error(res,400,'invalid_project_or_dataset');const checked=validatedAttemptInput(null,b,b.datasetId);if(checked.error)return error(res,checked.status,checked.error);try{const result=processing.createTaskSubmission({subject:req.actorId,submissionId:b.submissionId,requestHash:sha256Hex(req.rawBody||Buffer.from(JSON.stringify(b))),projectId:b.projectId,datasetId:b.datasetId,taskDisplayName:b.taskDisplayName.trim(),providerId:checked.value.provider.id,presetId:checked.value.preset?.id,options:checked.value.options,capabilityFingerprint:checked.value.provider.capabilityFingerprint});if(result.conflict)return error(res,409,'submission_conflict');return res.status(result.replayed?200:201).json(result);}catch(e){return error(res,409,e.code||'submission_not_created');}});
  router.get('/api/v1/tasks/:id',authorize('viewer.processing.read'),(req,res)=>{const t=processing.getTask(req.params.id);return t?res.json({task:workspaceTask(t)}):error(res,404,'task_not_found');});
  router.get('/api/v1/tasks/:id/attempts',authorize('viewer.processing.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');const result=processing.listAttemptsPage(req.params.id,page);return result?res.json({attempts:result.items,nextCursor:result.nextCursor}):error(res,404,'task_not_found');});
  router.get('/api/v1/tasks/:id/storage',authorize('viewer.processing.read'),(req,res)=>{const page=pageQuery(req);if(!page)return error(res,400,'invalid_page');const result=processing.taskStorage(req.params.id,page);return result?res.json(result):error(res,404,'task_not_found');});
  router.patch('/api/v1/tasks/:id',authorize('viewer.processing.write'),mutate,(req,res)=>{if(!onlyKeys(req.body,['displayName','description','metadata']))return error(res,400,'invalid_patch_fields');const task=processing.auditedMutation({actorId:req.actorId,action:'processing_task.updated',entityType:'processing_task',entityId:req.params.id},()=>processing.updateTaskMetadata(req.params.id,req.body));return task?res.json({task}):error(res,404,'task_not_found');});
  router.post('/api/v1/tasks/:id/archive',authorize('viewer.processing.write'),mutate,(req,res)=>{const task=processing.auditedMutation({actorId:req.actorId,action:'processing_task.archived',entityType:'processing_task',entityId:req.params.id},()=>processing.archiveTask(req.params.id));return task?res.json({task}):error(res,409,'task_not_archivable');});
  router.delete('/api/v1/tasks/:id',authorize('viewer.processing.write'),mutate,(req,res)=>{try{const trash=trashTaskTree(processing,storage,req.params.id,req.actorId);return res.json({trash});}catch(e){return error(res,409,e.code||'task_not_trashable');}});
  router.use('/api/v1/tasks/:id/attempts',(req,res,next)=>req.method==='POST'&&!processing.workerStatus().live?error(res,503,'processing_worker_unavailable'):next());
  router.post('/api/v1/tasks/:id/attempts',authorize('viewer.processing.write'),mutate,(req,res)=>{const checked=validatedAttemptInput(req.params.id,req.body||{});if(checked.error)return error(res,checked.status,checked.error);try{const attempt=processing.createAttempt({taskId:req.params.id,providerId:checked.value.provider.id,presetId:checked.value.preset?.id,options:checked.value.options,capabilityFingerprint:checked.value.provider.capabilityFingerprint,createdBy:req.actorId});return res.status(202).json({attempt});}catch(e){return error(res,409,e.code||'attempt_not_created');}});
  router.get('/api/v1/attempts/:id',authorize('viewer.processing.read'),(req,res)=>{const a=processing.getAttempt(req.params.id);return a?res.json({attempt:a,logs:processing.listLogs(a.id,req.query.logLimit)}):error(res,404,'attempt_not_found');});
  router.post('/api/v1/attempts/:id/cancel',authorize('viewer.processing.write'),mutate,async(req,res)=>{const a=processing.getAttempt(req.params.id);if(!a)return error(res,404,'attempt_not_found');const cancelled=processing.cancelAttempt(a.id,req.actorId);if(a.providerTaskId&&['queued_upstream','running'].includes(a.status)){try{const p=processing.getProvider(a.providerId);if(p)await new NodeOdmProvider({endpoint:p.endpoint,token:providerCredentials.resolve(p.id),providerType:p.type,...(providerFetch?{fetchImpl:providerFetch}:{})}).cancel(a.providerTaskId);}catch(e){processing.appendLog(a.id,'warning',`Upstream cancellation could not be confirmed: ${sanitizeLogMessage(e.message)}`);}}res.json({attempt:cancelled});});
  router.post('/api/v1/attempts/:id/recover-ingest',authorize('viewer.processing.write'),mutate,async(req,res,next)=>{
    if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');
    try{
      const context=inspectIngestRecovery(processing,req.params.id);
      validateIngestRecoveryStorage(context,storage);
      const adapter=new NodeOdmProvider({endpoint:context.provider.endpoint,token:providerCredentials.resolve(context.provider.id),providerType:context.provider.type,...(providerFetch?{fetchImpl:providerFetch}:{})});
      let status;try{status=await adapter.status(context.attempt.providerTaskId);}catch{ return error(res,503,'ingest_recovery_provider_unavailable'); }
      const fresh=inspectIngestRecovery(processing,req.params.id);
      if(fresh.fingerprint!==context.fingerprint)return error(res,409,'ingest_recovery_state_changed');
      validateIngestRecoveryStorage(fresh,storage);
      const recovered=processing.recoverIngest(req.params.id,{expectedFingerprint:context.fingerprint,providerStatus:status,sessionId:req.adminPrincipal.id,actor:req.actorId,receipt:{...req.adminIdempotency,path:req.originalUrl}});
      req.adminIdempotencyCompleted=true;
      return res.status(202).set('Retry-After','2').json(recovered);
    }catch(e){
      if(e.code==='attempt_not_found')return error(res,404,e.code);
      if(e.code==='ingest_recovery_authorization_changed')return error(res,403,e.code);
      if(typeof e.code==='string'&&e.code.startsWith('ingest_recovery_'))return error(res,409,e.code);
      if(['provider_unreachable','provider_unavailable','provider_authentication_failed','provider_credential_unavailable','provider_task_not_found','provider_request_failed','provider_tls_failed'].includes(e.code))return error(res,503,'ingest_recovery_provider_unavailable');
      return next(e);
    }
  });
  router.post('/api/v1/attempts/:id/retry',authorize('viewer.processing.write'),mutate,(req,res)=>{const a=processing.retryAttempt(req.params.id,req.actorId);return a?res.status(202).json({attempt:a}):error(res,409,'attempt_not_retryable');});
  router.post('/api/v1/attempts/:id/review-sessions',authorize('viewer.processing.publish'),mutate,(req,res)=>{
    if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');
    const attempt=processing.getAttempt(req.params.id);
    if(!attempt||attempt.status!=='ready_for_review'||!attempt.resultModelId||!attempt.resultModelVersionId)return error(res,409,'attempt_not_reviewable');
    const output=processing.getModelOutput(attempt.resultModelVersionId),candidate=repository.getModelVersion(attempt.resultModelId,attempt.resultModelVersionId);
    if(!output||output.attemptId!==attempt.id||output.modelId!==attempt.resultModelId||output.status!=='ready'||!candidate?.activeVersion)return error(res,409,'review_output_unavailable');
    const reviewAssets=viewerEligibleAssets(candidate.activeVersion.metadata,candidate.activeVersion.assets).filter((asset)=>publicDerivativeKind(asset.kind));
    const integrityReady=reviewAssets.length>0&&reviewAssets.every((asset)=>asset.sha256&&(!['ept','tiles'].includes(asset.kind)||(asset.manifestSha256&&repository.getModelAssetFile(asset.id,path.posix.basename(asset.relativePath)))));
    if(!integrityReady)return error(res,409,'asset_integrity_not_ready');
    const authorizedUntil=new Date(Math.min(Date.parse(req.adminPrincipal.expiresAt),Date.now()+config.viewerSessionTtlSeconds*1000)).toISOString();
    if(Date.parse(authorizedUntil)<=Date.now())return error(res,410,'authorization_expired');
    const grantExpiresAt=new Date(Math.min(Date.parse(authorizedUntil),Date.now()+config.sessionGrantTtlSeconds*1000)).toISOString();
    const grant=repository.createSessionGrantAudited({modelId:attempt.resultModelId,modelVersionId:attempt.resultModelVersionId,reviewAttemptId:attempt.id,sessionMode:'review',subject:req.actorId,audience:'ops',permissions:{view:true,measure:true,cameras:true,download:false,cameraPhotoDownload:true,__authorizedUntil:authorizedUntil,__versionId:attempt.resultModelVersionId},displayUnits:req.adminPrincipal.displayUnits||config.defaultUnits,expiresAt:grantExpiresAt},{actorType:'admin',actorId:req.actorId,action:'processing_review_session.created',entityType:'processing_attempt',entityId:attempt.id,details:{modelId:attempt.resultModelId,modelVersionId:attempt.resultModelVersionId}});
    const base=config.publicBaseUrl||`${req.protocol}://${req.get('host')}`;
    return res.status(201).json({grant:grant.id,grantExpiresAt,sessionTtlSeconds:config.viewerSessionTtlSeconds,sessionMode:'review',attemptId:attempt.id,modelId:attempt.resultModelId,modelVersionId:attempt.resultModelVersionId,assetKinds:[...new Set(reviewAssets.map((asset)=>asset.kind))].sort(),redeemUrl:`${base}/api/v1/sessions/redeem`,embedUrl:`${base}/session/${encodeURIComponent(grant.id)}`});
  });
  router.delete('/api/v1/attempts/:id/review-sessions',authorize('viewer.processing.publish'),mutate,(req,res)=>{
    if(!onlyKeys(req.body,[]))return error(res,400,'invalid_request');
    const attempt=processing.getAttempt(req.params.id);if(!attempt)return error(res,404,'attempt_not_found');
    const revoked=repository.revokeReviewSessions({attemptId:attempt.id,subject:req.actorId,audit:{actorType:'admin',actorId:req.actorId,action:'processing_review_session.revoked',entityType:'processing_attempt',entityId:attempt.id}});
    return res.json({attemptId:attempt.id,revokedGrants:revoked.grants,revokedSessions:revoked.sessions});
  });
  router.post('/api/v1/attempts/:id/publish',authorize('viewer.processing.publish'),mutate,(req,res)=>{const a=processing.getAttempt(req.params.id);if(!a||a.status!=='ready_for_review'||!a.resultModelId||!a.resultModelVersionId)return error(res,409,'attempt_not_reviewable');const selected=req.body?.selectedAssetKinds;if(!Array.isArray(selected)||!selected.length||selected.some((k)=>!publicDerivativeKind(k)))return error(res,400,'invalid_published_assets');const candidate=repository.getModelVersion(a.resultModelId,a.resultModelVersionId),available=new Set(candidate?.activeVersion?viewerEligibleAssets(candidate.activeVersion.metadata,candidate.activeVersion.assets).map((x)=>x.kind):[]);if(selected.some((k)=>!available.has(k)))return error(res,400,'published_asset_unavailable');try{const published=processing.publishAttemptAtomic(a.id,selected,{actorId:req.actorId});if(!published)return error(res,409,'asset_integrity_not_ready');return res.json({task:published.task,model:repository.getModel(published.modelId)});}catch(e){if(e.code==='publish_conflict')return error(res,409,'publish_conflict');throw e;}});
  mountGcpRoutes(router,{repository,processing,storage,authorize,mutate,error});
  return router;
}

function pathName(value){const parts=String(value||'Imported dataset').split('/');return parts[parts.length-1]||'Imported dataset';}
module.exports={PERMISSIONS,createProcessingApi,validUnits,publicStorageSpace,publicImportPreview};
