// Serves files from the read-only WebODM mount / derivatives mount without
// ever exposing real filesystem paths to the client. The frontend only ever
// sees `/assets/:projectId/:root/<relative path>` URLs.
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { trackedRouter } = require('./httpRequestLifecycle');
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
const { assetIntegrityCache } = require('./assetIntegrityCache');
const { deliverVerified, openForDelivery } = require('./verifiedDelivery');

const router = trackedRouter();
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

function requestedRange(header,size){const match=/^bytes=(\d*)-(\d*)$/.exec(String(header||''));if(!match)return null;let start=match[1]?Number(match[1]):null,end=match[2]?Number(match[2]):null;if(start===null&&end!==null){start=Math.max(0,size-end);end=size-1;}else{if(start===null)return null;if(end===null||end>=size)end=size-1;}return Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<=end&&start<size?{start,end}:null;}
// Registered chunk hashes are proven per 4 MiB region; positive results are
// remembered per exact file identity (assetIntegrityCache.js). A range must be
// fully covered by registered chunks; a gap in the chunk table fails closed.
async function verifyChunks(filePath,stat,chunks,range,totalSize,options={}){const selected=range?chunks.filter((chunk)=>chunk.byteOffset<=range.end&&chunk.byteOffset+chunk.byteSize-1>=range.start):chunks;if(!selected.length)return false;if(range){let covered=range.start;for(const chunk of [...selected].sort((x,y)=>x.byteOffset-y.byteOffset)){if(chunk.byteOffset>covered)return false;covered=Math.max(covered,chunk.byteOffset+chunk.byteSize);}if(covered<=range.end)return false;}else{let offset=0;for(const chunk of chunks){if(chunk.byteOffset!==offset)return false;offset+=chunk.byteSize;}if(offset!==totalSize)return false;}for(const chunk of selected){if(!await assetIntegrityCache.verifyChunk(filePath,stat,chunk,options))return false;}return true;}
// The registered integrity record for one requested file: whole-file SHA-256
// and, when registered, its 4 MiB chunk hashes. null = no valid record.
function integrityPlan(repository,project,publishedAsset,requested){const integrityRequired=project.provider==='ltds-processing'||Boolean(publishedAsset.sha256)||Boolean(publishedAsset.manifestSha256);if(!integrityRequired)return {required:false};const published=String(publishedAsset.relativePath).replaceAll('\\','/');let expected=null,chunkPath='';if(['ept','tiles'].includes(publishedAsset.kind)){if(!publishedAsset.manifestSha256)return null;const child=path.posix.relative(path.posix.dirname(published),requested);if(!child||child.startsWith('../'))return null;expected=repository.getModelAssetFile(publishedAsset.id,child);chunkPath=child;}else if(requested===published&&publishedAsset.sha256)expected={byteSize:publishedAsset.byteSize,sha256:publishedAsset.sha256};if(!expected)return null;return {required:true,expected,chunks:repository.getModelAssetChunks?.(publishedAsset.id,chunkPath)||[]};}
async function verifyIntegrityPlan(plan,abs,stat,range,options){if(!plan)return false;if(!plan.required)return true;const size=Number(stat.size);if(size!==plan.expected.byteSize)return false;if(plan.chunks.length)return verifyChunks(abs,stat,plan.chunks,range,size,options);return assetIntegrityCache.verifyWholeFile(abs,stat,plan.expected.sha256,options);}
// Regions whose exactly-hashed bytes are sent for [start,end]; null streams
// (no integrity record, or a whole file too large to buffer).
function integrityRegions(plan,size,start,end){if(!plan?.required)return null;if(plan.chunks.length)return plan.chunks.filter((chunk)=>chunk.byteOffset<=end&&chunk.byteOffset+chunk.byteSize-1>=start).sort((a,b)=>a.byteOffset-b.byteOffset).map((chunk)=>({kind:'chunk',offset:chunk.byteOffset,size:chunk.byteSize,sha256:chunk.sha256}));return assetIntegrityCache.canBuffer(size+1)?[{kind:'file',offset:0,size,sha256:plan.expected.sha256,toEof:true}]:null;}
// `opened` = { handle, stat, range, signal } verifies the exact byte range that
// will be served, through the descriptor it will be served from.
async function publishedAssetIntegrityAllows(repository,project,publishedAsset,requested,abs,rangeHeader=null,opened=null){const plan=integrityPlan(repository,project,publishedAsset,requested);if(!plan)return false;if(!plan.required)return true;const stat=opened?opened.stat:await fs.promises.stat(abs,{bigint:true});return verifyIntegrityPlan(plan,abs,stat,opened?opened.range:requestedRange(rangeHeader,Number(stat.size)),{handle:opened?.handle||null,signal:opened?.signal||null});}
// deliverVerified options for one opened managed asset.
function integrityDelivery(repository,project,publishedAsset,requested,abs,opened){const plan=integrityPlan(repository,project,publishedAsset,requested);return {verify:(range,signal)=>verifyIntegrityPlan(plan,abs,opened.stat,range,{handle:opened.handle,signal}),regions:(start,end)=>integrityRegions(plan,Number(opened.stat.size),start,end)};}

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

  // Authorization/revocation is evaluated for every request, and again after
  // the (possibly slow) integrity check, right before any byte is sent.
  // Responses are never stored by browsers or intermediaries, so a URL stops
  // working as soon as its session/share expires or is revoked.
  const shareStillAllows=()=>{if(!share)return true;const current=canonicalRepository.getPublicShare(share.id);return canonicalRepository.publicShareLive(current)&&revisionMatches(current,{shareRevision:share.authorizationRevision})&&assetAllowed(current,publishedAsset?.kind);};
  const requested = String(rel).replaceAll('\\', '/');
  const accelerated = xAccelLocation(abs);
  if (!project.activeVersion || accelerated) {
    // Legacy unmanaged projects carry no integrity metadata. X-Accel-Redirect
    // (only with X_ACCEL_REDIRECT_PREFIX, empty in the shipped compose file)
    // hands the path to the proxy, which reopens it after this check.
    if (project.activeVersion && !await publishedAssetIntegrityAllows(canonicalRepository,project,publishedAsset,requested,abs,req.get('range')))return res.status(404).json({ error: 'asset not found' });
    if (!shareStillAllows()) return res.status(403).json({ error: 'not authorized' });
    res.setHeader('Cache-Control', 'private, no-store');
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
  let opened;
  try { opened = await openForDelivery(abs); } catch { return res.status(404).json({ error: 'asset not found' }); }
  return deliverVerified(req, res, {
    ...opened,
    filePath: abs,
    headers: { 'Cache-Control': 'private, no-store' },
    ...integrityDelivery(canonicalRepository, project, publishedAsset, requested, abs, opened),
    onFailure: () => res.status(404).json({ error: 'asset not found' }),
    beforeSend: () => { if (shareStillAllows()) return true; res.status(403).json({ error: 'not authorized' }); return false; },
    onError: (err) => { if (!res.headersSent) res.status(err.status || 404).json({ error: 'asset not found' }); },
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
    let opened;
    try { opened = await openForDelivery(absolute); } catch { return res.status(404).json({ error: 'photo not found' }); }
    if (Number(opened.stat.size) !== photo.byteSize) { await opened.handle.close(); return res.status(404).json({ error: 'photo not found' }); }
    const headers = { 'Cache-Control': 'private, no-store', 'Content-Type': photo.contentType, 'X-Content-Type-Options': 'nosniff' };
    // Share access is re-checked after the (possibly slow) integrity check.
    const shareStillAllows = async () => { if (!authorization.share) return true; const current = await pathTokenAuthorization(req, req.params.id); if (current?.cameras) return true; res.status(403).json({ error: 'not authorized' }); return false; };
    const accelerated = xAccelLocation(absolute);
    if (accelerated) {
      try { if (!await assetIntegrityCache.verifyWholeFile(absolute, opened.stat, photo.sha256, { handle: opened.handle })) return res.status(404).json({ error: 'photo not found' }); } finally { await opened.handle.close(); }
      if (!await shareStillAllows()) return undefined;
      res.set(headers);
      res.setHeader('X-Accel-Redirect', accelerated);
      return res.end();
    }
    return deliverVerified(req, res, {
      ...opened,
      filePath: absolute,
      headers,
      verify: (_range, signal) => assetIntegrityCache.verifyWholeFile(absolute, opened.stat, photo.sha256, { handle: opened.handle, signal }),
      regions: () => (assetIntegrityCache.canBuffer(photo.byteSize + 1) ? [{ kind: 'file', offset: 0, size: photo.byteSize, sha256: photo.sha256, toEof: true }] : null),
      onFailure: () => res.status(404).json({ error: 'photo not found' }),
      beforeSend: shareStillAllows,
      onError: (error) => { if (!res.headersSent) res.status(error.status || 404).json({ error: 'photo not found' }); },
    });
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
    let opened;try{opened=await openForDelivery(absolute);}catch{return res.sendStatus(404);}
    return deliverVerified(req,res,{...opened,filePath:absolute,
      headers:{'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="${product.fileName}"`},
      ...integrityDelivery(canonicalRepository,model,asset,asset.relativePath,absolute,opened),
      onFailure:()=>res.sendStatus(409),
      // Integrity verification may be slow: honor revocation that happened while it ran.
      beforeSend:async()=>{if(await admitted.revalidate())return true;res.sendStatus(403);return false;},
      onError:(error)=>{if(!res.headersSent)next(error);}});
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
module.exports.integrityDelivery = integrityDelivery;
module.exports.assetIntegrityCache = assetIntegrityCache;
