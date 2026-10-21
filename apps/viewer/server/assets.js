// Serves files from the read-only WebODM mount / derivatives mount without
// ever exposing real filesystem paths to the client. The frontend only ever
// sees `/assets/:projectId/:root/<relative path>` URLs.
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const store = require('./store');
const shareStore = require('./shareStore');
const auth = require('./auth');
const {revisionMatches,assetAllowed}=require('./publicSharePolicy');
const { isAdminRequest } = require('./adminAuth');
const { SHARE_COOKIE } = require('./shareApi');
const { VIEWER_COOKIE } = require('./apiV1');
const { config } = require('./config');
const { publicDerivativeKind } = require('./processingSecurity');
const { scopedStorageRootKey } = require('./storageManager');
const { validCameraFilename } = require('./cameraPhotos');
const { productDescriptor, registeredProducts, createDownloadCapabilities } = require('./productDownloads');
let { sourceAuthorizationValidator } = require('./sourceAuthorization');

const router = express.Router();
const productTickets = createDownloadCapabilities();
let canonicalRepository = null;
let processingRepository = null;

function setRepository(repository) {
  canonicalRepository = repository;
}
function setProcessingRepository(repository) {
  processingRepository = repository;
}
function setSourceAuthorizationValidator(validator){sourceAuthorizationValidator=validator;}

// Resolve `relPath` under `root`, refusing anything that escapes it.
function safeResolve(root, relPath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${path.sep}${relPath}`);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}

// Authorized if the caller is an admin, OR has a valid share session for
// THIS exact project. The referenced share is looked up live on every
// request (cheap in-memory check) so revoking it takes effect immediately
// instead of waiting out the session cookie's TTL.
async function isAuthorizedForProject(req, projectId) {
  if (isAdminRequest(req)) return true;

  const viewerCookie = req.cookies && req.cookies[VIEWER_COOKIE];
  const viewer = viewerCookie && canonicalRepository
    ? canonicalRepository.getViewerSessionByHash(auth.hashToken(viewerCookie))
    : null;
  if (canonicalRepository?.viewerSessionLive(viewer) && viewer.permissions?.view !== false) {
    const requestedModelId = canonicalRepository.resolveModelId(projectId);
    const model = requestedModelId ? canonicalRepository.getModel(requestedModelId) : null;
    if (requestedModelId
      && requestedModelId === viewer.modelId
      && model?.status === 'ready'
      && model.activeVersionId === viewer.modelVersionId) return true;
  }

  const cookieVal = req.cookies && req.cookies[SHARE_COOKIE];
  const payload = cookieVal ? auth.verify(cookieVal) : null;
  if (!payload) return false;
  if (payload.modelId && canonicalRepository) {
    const requestedModelId = canonicalRepository.resolveModelId(projectId);
    const share = canonicalRepository.getPublicShare(payload.shareId);
    req.publicShare=share;
    return requestedModelId === payload.modelId
      && canonicalRepository.publicShareLive(share)
      && revisionMatches(share,payload)
      && await sourceAuthorizationValidator.allows(share)
      && share.modelId === payload.modelId;
  }
  if (payload.viewerProjectId !== projectId) return false;
  const legacyShare = shareStore.getById(payload.shareId);
  return shareStore.isLive(legacyShare) && legacyShare.viewerProjectId === projectId;
}

function safeExistingFile(root, relPath) {
  const lexical = safeResolve(root, relPath);
  if (!lexical) return null;
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return null; }
  const relative = path.relative(path.resolve(root), lexical);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  let cursor = realRoot;
  try {
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    const real = fs.realpathSync(cursor);
    if (!real.startsWith(`${realRoot}${path.sep}`) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

function canonicalAssetRoot(model, rootKey) {
  const source = model && model.activeVersion && model.activeVersion.sourceLocator || {};
  const legacyRoot = source.legacyAssetRoots && source.legacyAssetRoots[rootKey];
  if (legacyRoot) return legacyRoot;

  // External-reference outputs use a UUID-qualified logical root so lifecycle
  // accounting stays version-scoped. The suffix is metadata only; the bytes
  // remain under the provider's configured read-only mount.
  const scoped = scopedStorageRootKey(rootKey);
  if (scoped === 'webodm') return config.webodmMediaMount;
  if (scoped === 'terra_import') return config.terraImportMount;

  // Managed derivatives can belong to a WebODM/Terra import while being stored
  // in Viewer-owned roots. Authorization remains asset- and version-scoped in
  // publishedAssetMatch, so provider identity must not hide these roots.
  if (rootKey === 'models') return config.modelsMount;
  if (rootKey === 'datasets') return config.datasetsMount;

  if (source.catalogImport && rootKey === 'webodm') return config.webodmMediaMount;
  if (source.catalogImport && rootKey === 'terra') return config.terraImportMount;
  if (model.provider === 'webodm' && source.projectId !== null && source.taskId !== null) {
    if (rootKey === 'webodm') {
      return path.join(config.webodmMediaMount, 'project', String(source.projectId), 'task', String(source.taskId), 'assets');
    }
    if (rootKey === 'derivatives' && config.derivativesMount) {
      return path.join(config.derivativesMount, `${source.projectId}-${source.taskId}`);
    }
  }
  return null;
}

function resolveProject(projectId, rootKey) {
  const project = store.getById(projectId);
  if (project) return { project, rootPath: project.assetRoots && project.assetRoots[rootKey] };
  if (!canonicalRepository) return { project: null, rootPath: null };
  const model = canonicalRepository.getModel(projectId);
  return { project: model, rootPath: canonicalAssetRoot(model, rootKey) };
}

// A scoped Viewer capability is authorization for one published model version,
// not for an entire storage mount. Metadata files for EPT and 3D Tiles are
// roots for their relative child requests; every other asset is a single file.
function publishedAssetMatch(model, rootKey, relPath, { review = false, publicOnly = false } = {}) {
  if (!model?.activeVersion) return false;
  if (review ? model.activeVersion.status !== 'ready' : model.status !== 'ready') return false;
  const requested = String(relPath || '').replaceAll('\\', '/');
  const hierarchical = new Set(['ept', 'tiles']);
  return model.activeVersion.assets.find((asset) => {
    const disallowed = publicOnly
      ? (!asset.published || !publicDerivativeKind(asset.kind))
      : (review ? !publicDerivativeKind(asset.kind) : !asset.published);
    if (disallowed || asset.rootKey !== rootKey) return false;
    const published = String(asset.relativePath || '').replaceAll('\\', '/');
    if (requested === published) return true;
    if (!hierarchical.has(asset.kind)) return false;
    const directory = path.posix.dirname(published);
    return directory !== '.' && requested.startsWith(`${directory}/`);
  });
}
function publishedAssetAllows(model, rootKey, relPath) { return Boolean(publishedAssetMatch(model,rootKey,relPath)); }

function sha256File(filePath) { return new Promise((resolve,reject)=>{const hash=crypto.createHash('sha256'),stream=fs.createReadStream(filePath);stream.on('data',(chunk)=>hash.update(chunk));stream.on('error',reject);stream.on('end',()=>resolve(hash.digest('hex')));}); }
function requestedRange(header,size){const match=/^bytes=(\d*)-(\d*)$/.exec(String(header||''));if(!match)return null;let start=match[1]?Number(match[1]):null,end=match[2]?Number(match[2]):null;if(start===null&&end!==null){start=Math.max(0,size-end);end=size-1;}else{if(start===null)return null;if(end===null||end>=size)end=size-1;}return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<=end&&start<size?{start,end}:null;}
async function verifyChunks(filePath,chunks,range,totalSize){const selected=range?chunks.filter((chunk)=>chunk.byteOffset<=range.end&&chunk.byteOffset+chunk.byteSize-1>=range.start):chunks;if(!selected.length)return false;if(!range){let offset=0;for(const chunk of chunks){if(chunk.byteOffset!==offset)return false;offset+=chunk.byteSize;}if(offset!==totalSize)return false;}const handle=await fs.promises.open(filePath,'r');try{for(const chunk of selected){const buffer=Buffer.allocUnsafe(chunk.byteSize),{bytesRead}=await handle.read(buffer,0,chunk.byteSize,chunk.byteOffset);if(bytesRead!==chunk.byteSize||crypto.createHash('sha256').update(buffer.subarray(0,bytesRead)).digest('hex')!==chunk.sha256)return false;}return true;}finally{await handle.close();}}
async function publishedAssetIntegrityAllows(repository,project,publishedAsset,requested,abs,rangeHeader=null){const integrityRequired=project.provider==='ltds-processing'||Boolean(publishedAsset.sha256)||Boolean(publishedAsset.manifestSha256);if(!integrityRequired)return true;const published=String(publishedAsset.relativePath).replaceAll('\\','/');let expected=null,chunkPath='';if(['ept','tiles'].includes(publishedAsset.kind)){if(!publishedAsset.manifestSha256)return false;const child=path.posix.relative(path.posix.dirname(published),requested);if(!child||child.startsWith('../'))return false;expected=repository.getModelAssetFile(publishedAsset.id,child);chunkPath=child;}else if(requested===published&&publishedAsset.sha256)expected={byteSize:publishedAsset.byteSize,sha256:publishedAsset.sha256};if(!expected)return false;const stat=fs.statSync(abs);if(stat.size!==expected.byteSize)return false;const chunks=repository.getModelAssetChunks?.(publishedAsset.id,chunkPath)||[];if(chunks.length)return verifyChunks(abs,chunks,requestedRange(rangeHeader,stat.size),stat.size);return await sha256File(abs)===expected.sha256;}

async function pathTokenAuthorization(req, projectId) {
  if (!canonicalRepository) return false;
  const requestedModelId = canonicalRepository.resolveModelId(projectId);
  if (!requestedModelId) return false;
  const viewer = canonicalRepository.getViewerSessionByHash(auth.hashToken(req.params.token));
  if (canonicalRepository.viewerSessionLive(viewer)) {
    const review = viewer.sessionMode === 'review';
    const model = review
      ? canonicalRepository.getModelVersion(requestedModelId, viewer.modelVersionId)
      : canonicalRepository.getModel(requestedModelId);
    const allowed = viewer.permissions?.view !== false
      && viewer.modelId === requestedModelId
      && (review
        ? model?.activeVersion?.id === viewer.modelVersionId && model.activeVersion.status === 'ready'
        : model?.status === 'ready' && model.activeVersionId === viewer.modelVersionId);
    return allowed ? { model, review, cameras: viewer.permissions?.cameras !== false, download: viewer.permissions?.download === true } : false;
  }
  const payload = auth.verify(req.params.token);
  if (!payload) return false;
  if (payload.kind === 'share-asset') {
    if (payload.modelId) {
      const share = canonicalRepository.getPublicShare(payload.shareId);
      const model = canonicalRepository.getModel(requestedModelId);
      const allowed = payload.modelId === requestedModelId
        && canonicalRepository.publicShareLive(share)
        && revisionMatches(share,payload)
        && await sourceAuthorizationValidator.allows(share)
        && share.modelId === requestedModelId
        && model?.status === 'ready'
        && (share.versionPolicy !== 'pinned' || share.modelVersionId === model.activeVersionId);
      return allowed ? { model, share, review: false, cameras: share.permissions?.cameras !== false, download: share.permissions?.download === true } : false;
    }
    const share = shareStore.getById(payload.shareId);
    return shareStore.isLive(share) && share.viewerProjectId === projectId ? { model: null, review: false, cameras: share.permissions?.cameras !== false } : false;
  }
  if (payload.kind === 'project-share-asset' && processingRepository) {
    const share = canonicalRepository.getProjectShare(payload.shareId);
    const selected = share && processingRepository.getActivePublishedProjectTask(share.projectId, payload.taskId);
    const model = selected ? canonicalRepository.getModel(selected.modelId) : null;
    const allowed = canonicalRepository.projectShareLive(share)
      && share.projectId === payload.projectId
      && payload.modelId === requestedModelId
      && selected?.modelId === requestedModelId
      && selected.modelVersionId === payload.modelVersionId
      && model?.activeVersion?.id === payload.modelVersionId;
    return allowed ? { model, review: false, publicOnly: true, cameras: share.permissions?.cameras !== false, download: share.permissions?.download === true } : false;
  }
  return false;
}

function xAccelLocation(abs) {
  if (!config.xAccelRedirectPrefix) return null;
  const roots = [
    ['webodm', config.webodmMediaMount],
    ['derivatives', config.derivativesMount],
    ['terra', config.terraImportMount],
    ['datasets', config.datasetsMount],
    ['models', config.modelsMount],
  ];
  for (const [name, root] of roots) {
    if (!root) continue;
    const relative = path.relative(path.resolve(root), abs);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      const encoded = relative.split(path.sep).map(encodeURIComponent).join('/');
      return `${config.xAccelRedirectPrefix}/${name}/${encoded}`;
    }
  }
  return null;
}

async function sendAsset(req, res, authorizedModel = null, { review = false, publicOnly = false, cameras = true, share = req.publicShare } = {}) {
  const resolved = authorizedModel
    ? { project: authorizedModel, rootPath: canonicalAssetRoot(authorizedModel, req.params.root) }
    : resolveProject(req.params.id, req.params.root);
  const { project, rootPath } = resolved;
  if (!project) return res.status(404).json({ error: 'unknown project' });
  if (!rootPath) return res.status(404).json({ error: 'unknown asset root' });

  const rel = req.params[0] || '';
  const publishedAsset = project.activeVersion ? publishedAssetMatch(project, req.params.root, rel, { review, publicOnly }) : null;
  if (project.activeVersion && !publishedAsset) {
    return res.status(404).json({ error: 'asset not found' });
  }
  if (publishedAsset?.kind === 'shots' && !cameras) return res.status(403).json({ error: 'not authorized' });
  if (share && (!publishedAsset || !assetAllowed(share,publishedAsset.kind)))return res.status(403).json({error:'not authorized'});
  const abs = safeExistingFile(rootPath, rel);
  if (!abs) return res.status(404).json({ error: 'asset not found' });
  if (project.activeVersion) {
    const requested=String(rel).replaceAll('\\','/'),published=String(publishedAsset.relativePath).replaceAll('\\','/');
    if (!await publishedAssetIntegrityAllows(canonicalRepository,project,publishedAsset,requested,abs,req.get('range')))return res.status(404).json({ error: 'asset not found' });
  }

  // Authorization/revocation is evaluated for every request. Prevent an
  // intermediary or browser cache from serving a previously authorized URL
  // after its session/share has expired or been revoked.
  if(share){const current=canonicalRepository.getPublicShare(share.id);if(!canonicalRepository.publicShareLive(current)||!revisionMatches(current,{shareRevision:share.authorizationRevision})||!assetAllowed(current,publishedAsset?.kind))return res.status(403).json({error:'not authorized'});}
  res.setHeader('Cache-Control', 'private, no-store');

  const accelerated = xAccelLocation(abs);
  if (accelerated) {
    res.setHeader('X-Accel-Redirect', accelerated);
    return res.end();
  }
  return res.sendFile(abs, (err) => {
    if (err && !res.headersSent) {
      res.status(err.status || 404).json({ error: 'asset not found' });
    }
  });
}

router.get('/assets/:id/:root/*', async (req, res, next) => {
  const capability=req.cookies?.[VIEWER_COOKIE]||req.cookies?.[SHARE_COOKIE];
  if(capability&&canonicalRepository?.rateLimited(`public-asset:${auth.hashToken(capability)}:${req.ip}:${req.params.id}`,6000,5*60_000))return res.status(429).json({error:'too many asset requests'});
  if (!await isAuthorizedForProject(req, req.params.id)) {
    return res.status(403).json({ error: 'not authorized' });
  }
  return sendAsset(req, res).catch(next);
});

// Capability URL used by embedded Viewer sessions and public shares. Keeping
// the scoped browser credential in the asset URL makes iframe delivery work
// even when the browser blocks third-party cookies. Relative 3D Tiles/EPT
// children inherit this path prefix automatically.
router.get('/session-assets/:token/:id/:root/*', async (req, res, next) => {
  if(canonicalRepository?.rateLimited(`capability-asset:${auth.hashToken(req.params.token)}:${req.ip}:${req.params.id}`,6000,5*60_000))return res.status(429).json({error:'too many asset requests'});
  const authorization = await pathTokenAuthorization(req, req.params.id);
  if (!authorization) return res.status(403).json({ error: 'not authorized' });
  return sendAsset(req, res, authorization.model, { review: authorization.review, publicOnly: authorization.publicOnly, cameras: authorization.cameras,share:authorization.share }).catch(next);
});

router.get('/session-camera-photos/:token/:id/:filename', async (req, res, next) => {
  try {
    if(canonicalRepository?.rateLimited(`camera-photo:${auth.hashToken(req.params.token)}:${req.ip}:${req.params.id}`,1200,5*60_000))return res.status(429).json({error:'too many photo requests'});
    const authorization = await pathTokenAuthorization(req, req.params.id);
    if (!authorization || !authorization.cameras) return res.status(403).json({ error: 'not authorized' });
    const filename = validCameraFilename(req.params.filename), model = authorization.model;
    const shots = model?.activeVersion?.assets?.find((asset) => asset.kind === 'shots' && (authorization.review || asset.published));
    if (!filename || !shots) return res.status(404).json({ error: 'photo not found' });
    const photo = canonicalRepository.getCameraPhoto(model.activeVersion.id, filename);
    if (!photo) return res.status(404).json({ error: 'photo not found' });
    const rootPath = canonicalAssetRoot(model, photo.rootKey), absolute = rootPath && safeExistingFile(rootPath, photo.relativePath);
    if (!absolute) return res.status(404).json({ error: 'photo not found' });
    const stat = fs.statSync(absolute);
    if (stat.size !== photo.byteSize || await sha256File(absolute) !== photo.sha256) return res.status(404).json({ error: 'photo not found' });
    if(authorization.share){const current=await pathTokenAuthorization(req,req.params.id);if(!current?.cameras)return res.status(403).json({error:'not authorized'});}
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const accelerated = xAccelLocation(absolute);
    if (accelerated) { res.setHeader('X-Accel-Redirect', accelerated); return res.end(); }
    return res.sendFile(absolute, (error) => { if (error && !res.headersSent) res.status(error.status || 404).json({ error: 'photo not found' }); });
  } catch (error) { return next(error); }
});

router.get('/session-products/:token/:id', async (req,res,next) => {
  try {
    const access=await pathTokenAuthorization(req,req.params.id);
    if(!access?.download)return res.status(403).json({error:'Downloads are not permitted for this model'});
    res.setHeader('Cache-Control','private, no-store');
    const base=`/session-products/${encodeURIComponent(req.params.token)}/${encodeURIComponent(req.params.id)}`;
    res.json({products:registeredProducts(access.model?.activeVersion?.assets.filter(asset=>!access.share||assetAllowed(access.share,asset.kind)),{review:access.review,cameras:access.cameras,modelReport:true})
      .map(product=>({...product,grantUrl:`${base}/${encodeURIComponent(product.kind)}/download-grants`}))});
  }catch(error){next(error);}
});

router.post('/session-products/:token/:id/:kind/download-grants',async(req,res,next)=>{
  try {
    const origin=req.get('origin');
    if(origin&&origin!==new URL(config.publicBaseUrl||`${req.protocol}://${req.get('host')}`).origin)return res.sendStatus(403);
    if(canonicalRepository?.rateLimited(`product-grant:${auth.hashToken(req.params.token)}:${req.ip}`,120,5*60_000))return res.sendStatus(429);
    const access=await pathTokenAuthorization(req,req.params.id);
    if(!access?.download)return res.sendStatus(403);
    const asset=access.model?.activeVersion?.assets.find(candidate=>candidate.kind===req.params.kind);
    if(access.share&&!assetAllowed(access.share,asset?.kind))return res.sendStatus(403);
    const product=productDescriptor(asset,{review:access.review,cameras:access.cameras,modelReport:true});
    if(!product)return res.sendStatus(404);
    // Retain only a minimal authorization request; never retain Express req
    // objects, bodies or sockets for the duration of a capability.
    const original={params:{token:req.params.token}},id=req.params.id,versionId=access.model.activeVersion.id;
    const ticket=productTickets.issue(async()=>{
      const current=await pathTokenAuthorization(original,id);
      if(!current?.download||current.model?.activeVersion?.id!==versionId)return null;
      const registered=current.model.activeVersion.assets.find(candidate=>candidate.id===asset.id&&candidate.sha256===asset.sha256);
      if(current.share&&!assetAllowed(current.share,registered?.kind))return null;
      const descriptor=productDescriptor(registered,{review:current.review,cameras:current.cameras,modelReport:true});
      return descriptor?{model:current.model,asset:registered,product:descriptor}:null;
    });
    res.setHeader('Cache-Control','private, no-store');
    res.status(201).json({url:`/session-product-downloads/${ticket.token}`,expiresAt:ticket.expiresAt,fileName:product.fileName});
  }catch(error){next(error);}
});

router.get('/session-product-downloads/:token',async(req,res,next)=>{
  try {
    const admitted=await productTickets.acquire(req.params.token),selected=admitted?.value;
    if(!selected)return res.status(403).json({error:'Download expired or access revoked. Open Downloads to try again.'});
    const {model,asset,product}=selected,root=canonicalAssetRoot(model,asset.rootKey),absolute=root&&safeExistingFile(root,asset.relativePath);
    if(!absolute)return res.sendStatus(404);
    if(!await publishedAssetIntegrityAllows(canonicalRepository,model,asset,asset.relativePath,absolute,req.get('range')))return res.sendStatus(409);
    if(!await admitted.revalidate())return res.sendStatus(403);
    res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Type','application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${product.fileName}"`);
    return res.sendFile(absolute,{acceptRanges:true},error=>{if(error&&!res.headersSent)next(error);});
  }catch(error){next(error);}
});

module.exports = router;
module.exports.setRepository = setRepository;
module.exports.setProcessingRepository = setProcessingRepository;
module.exports.setSourceAuthorizationValidator = setSourceAuthorizationValidator;
module.exports.safeResolve = safeResolve;
module.exports.safeExistingFile = safeExistingFile;
module.exports.xAccelLocation = xAccelLocation;
module.exports.publishedAssetAllows = publishedAssetAllows;
module.exports.publishedAssetMatch = publishedAssetMatch;
module.exports.publishedAssetIntegrityAllows = publishedAssetIntegrityAllows;
