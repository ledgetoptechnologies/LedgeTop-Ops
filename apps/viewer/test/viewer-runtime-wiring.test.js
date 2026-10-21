'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('viewer 3D mode is streaming-only and keeps original mesh access outside layer UI', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(main, /state\.meshSource = TILES_URL \? 'tiles' : \(GLB_URL \|\| OBJ_URL \? 'lod-required' : 'none'\)/);
  assert.match(main, /Streaming LOD unavailable/);
  assert.match(main, /full-resolution source remains available for authenticated download in Operations/);
  assert.doesNotMatch(main, /function loadGLB|loadGLB\(|function loadObjDirect|loadObjDirect\(/);
  assert.doesNotMatch(main, /GLTFLoader|DRACOLoader|OBJLoader|MTLLoader|fetchAssetArrayBufferByRange/);
  assert.doesNotMatch(main, /data-layer=['"]glb|layer-glb/);
  assert.doesNotMatch(html, /data-layer="glb"|id="layer-glb"|Full-Res Mesh/);
  assert.match(main, /if \(state\.meshSource !== 'tiles'\) return/);
  assert.match(main, /if \(state\.meshSource === 'tiles'\) \{\s*tilesParent\.visible = true;\s*loadTiles\(\)/);
  assert.match(main, /scheduleLodAvailabilityRefresh/);
  assert.match(main, /await currentViewerSession\(\)/);
  assert.match(main, /previousMeshSource === 'lod-required' && state\.meshSource === 'tiles'/);
  assert.match(main, /hideLoading\(\);\s*scheduleLodAvailabilityRefresh\(\);/);
});

test('viewer keeps gap-free REPLACE traversal and stages desktop detail through complete frontiers', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const materials = fs.readFileSync(path.join(__dirname, '..', 'lod-materials.mjs'), 'utf8');
  const resources = fs.readFileSync(path.join(__dirname, '..', 'lod-resource-lifecycle.mjs'), 'utf8');
  const lodPolicy = fs.readFileSync(path.join(__dirname, '..', 'lod-policy.mjs'), 'utf8');
  assert.doesNotMatch(main, /enableTransientRootLodBackdrop|syncTransientRootLodBackdrop|releaseStaleLodDetails|transientRootBackdropEnabled/);
  assert.doesNotMatch(lodPolicy, /root\.refine\s*=\s*['"]ADD['"]/);
  assert.match(lodPolicy, /tilesRenderer\.loadAncestors = false/);
  assert.match(lodPolicy, /tilesRenderer\.loadSiblings = false/);
  assert.match(lodPolicy, /tilesRenderer\.loadAncestorSiblings = false/);
  const rootStart = main.indexOf("rendererInstance.addEventListener('load-root-tileset'");
  const tilesetStart = main.indexOf("rendererInstance.addEventListener('load-tileset'");
  const modelStart = main.indexOf("rendererInstance.addEventListener('load-model'");
  assert.ok(rootStart >= 0 && tilesetStart > rootStart && modelStart > tilesetStart, 'LOD event handlers are present in order');
  const rootHandler = main.slice(rootStart, tilesetStart);
  assert.match(rootHandler, /const decision = decideLodStartup\(/);
  assert.match(main, /LOD_PROVENANCE_VERIFIED = p\.lodProvenanceVerified === true/,
    'the browser consumes the server authority bit only from its viewer configuration');
  assert.match(rootHandler, /serverVerified: LOD_PROVENANCE_VERIFIED/,
    'the exact-asset server verification is forwarded to browser provenance inspection');
  assert.match(rootHandler, /if \(decision\.action !== 'stream-lod'\)\s*\{[\s\S]*?return;\s*\}/);
  assert.doesNotMatch(rootHandler, /root\.refine\s*=/);
  assert.match(rootHandler, /rendererInstance\.root\?\.internal\?\.hasRenderableContent/);
  assert.match(rootHandler, /rendererInstance\.requestTileContents\(rendererInstance\.root\)/);
  assert.match(rootHandler, /const bounds = tilesetWorldBounds/);
  assert.match(rootHandler, /frameBoundsHome\(bounds, \{ apply: !preserveIncomingModelView \}\)/);
  assert.doesNotMatch(rootHandler, /if \(!homeView\)/);
  assert.match(main, /if \(tilesRenderer !== rendererInstance\) return;/);
  assert.match(main, /import \{ homeViewForBounds, tilesetWorldBounds \} from '\.\/viewer-framing\.mjs'/);
  assert.match(main, /import \{ installLodResourceLifecycle \} from '\.\/lod-resource-lifecycle\.mjs'/);
  assert.match(main, /lodResources = installLodResourceLifecycle\(rendererInstance\)/);
  assert.match(materials, /function preserveLodMaterials\(source\)/);
  assert.match(materials, /const originals = Array\.isArray\(source\) \? source : \[source\]/);
  assert.match(materials, /const replacements = originals\.map\(\(material\) => unlitLodMaterial\(material\)\)/);
  assert.match(materials, /map,\s*lightMap: source\?\.lightMap/);
  assert.match(materials, /vertexColors: Boolean\(source\?\.vertexColors\)/);
  assert.match(resources, /object\.material = preserveLodMaterials\(object\.material\)/);
  assert.doesNotMatch(main, /updateLodReplacementFallbacks/);
  assert.match(main, /addEventListener\('load-model',[\s\S]*?hideLoading\(\)/);
  assert.match(main, /function maybeAdvanceLodBootstrap\(\)/);
  assert.match(main, /function lodTargetForDetail\(detail\) \{\s*return detailToErrorTarget\(detail\);\s*\}/);
  assert.match(main, /lodBootstrapRootTarget = lodBootstrapRootErrorTarget\(root\?\.traversal\?\.error\)/);
  assert.match(main, /lodBootstrapCoverageTarget = lodBootstrapCoverageErrorTarget\(/);
  assert.match(main, /if \(lodRuntimeProfileState\.reduced\) \{/);
  assert.match(main, /finishLodPrefetch\('reduced-root'\)/);
  assert.match(main, /root\?\.traversal\?\.visible === true && lodTileSceneAttached\(root\)/);
  assert.match(main, /tilesRenderer\.maxDepth = LOD_PREFETCH_MAX_DEPTH/);
  assert.match(main, /elapsed >= LOD_PREFETCH_MAX_MS/);
  assert.match(main, /lodPrefetchReadyFrames >= 2/);
  assert.doesNotMatch(main, /cameraMoved \? 'camera-input'/,
    'camera input must not promote an incomplete whole-model fallback shell');
  assert.match(main, /captured\.overBudget[\s\S]*?enterLodRootOnly\('shell-over-budget'\)/);
  assert.match(main, /cachePressure[\s\S]*?recoverLodCacheAdmission\(tilesRenderer\.lruCache, lodRuntimeProfileState\.budget\)/,
    'transient startup pressure must recover without latching root-only');
  assert.match(main, /elapsed >= LOD_PREFETCH_MAX_MS[\s\S]*?lodPrefetchExitReason = 'shell-building'/,
    'the startup deadline is an honest telemetry milestone, not unsafe partial promotion');
  assert.match(main, /tilesRenderer\.maxDepth = Infinity/);
  assert.match(main, /lodOverviewTiles = captured\.shell/);
  assert.match(main, /function lodShellBudgetBytes[\s\S]*?lodFallbackShellMaxBytes\(tilesRenderer\?\.lruCache\?\.maxBytesSize/,
    'shell safety limit must be derived from the configured cache budget');
  assert.match(main, /captured\.overSoftBudget && !lodPrefetchSoftBudgetReported[\s\S]*?shell-soft-budget-exceeded/,
    'crossing the preferred shell target must be diagnostic rather than terminal');
  assert.doesNotMatch(main, /lodPrefetchExitReason = 'shell-soft-budget-exceeded'/,
    'a non-terminal soft-budget warning must not overwrite the actual prefetch exit state');
  assert.match(main, /tilesRenderer\.lodFallbackTiles = new Set\(lodOverviewTiles\)/);
  assert.match(main, /function lodTileSceneReady\(tile\)/);
  assert.match(main, /isReady: lodTileSceneReady/,
    'off-frustum decoded shell tiles must count as ready without being rendered');
  assert.match(main, /restoreLodOverviewRetention = installLodOverviewRetention\(/);
  assert.match(main, /if \(restoreLodOverviewRetention\) restoreLodOverviewRetention\(\);\s*restoreLodOverviewRetention = null;/);
  assert.doesNotMatch(main, /rendererInstance\.lruCache\.scheduleUnload =/);
  assert.match(main, /interactionStateProvider: \(\) => controls\?\.getInteractionState\?\.\(\) \|\| null/);
  assert.match(main, /LOD: reduced-memory/);
  assert.doesNotMatch(main, /engineData\.scene\.visible\s*=/);
  assert.match(main, /tilesRenderer\.update\(\);\s*if \(!maybeAdvanceLodBootstrap\(\)\) maybeAdvanceLodWarmup\(\)/);
  assert.match(main, /preserveIncomingModelView = !tilesRenderer\?\.root;\s*controls\.setView\(camW, tgtW\)/);
});

test('orthophoto nodata uses the supported GeoTIFF image API', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /parseFiniteGdalNoData\(image\.getGDALNoData\(\)\)/);
  assert.doesNotMatch(main, /fileDirectory\?\.GDAL_NODATA/);
});

test('map modes expose projected distance and area tools with deeper native-detail zoom', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(main, /function setMapTool\(tool\)/);
  assert.match(main, /function mapDistanceMeters\(points\)/);
  assert.match(main, /function mapAreaSquareMeters\(points\)/);
  assert.match(main, /maxZoom: 28/);
  assert.match(main, /panel-measure'\)\.style\.display = SHARE_PERMISSIONS\.measure/);
  assert.match(main, /async function ensureVolumeDataset/);
  assert.match(main, /await ensureVolumeDataset\(modeAbortController\?\.signal\)/);
  assert.match(main, /This task has no published DSM or DTM/);
  assert.match(main, /The selected DSM\/DTM loads automatically when Volume is chosen/);
  assert.match(main, /integrateElevationVolume/);
  assert.match(html, /Auto \(prefer DSM\)/);
  assert.match(html, /Lowest sampled point/);
  assert.match(html, /Average surface/);
  assert.match(html, /Custom elevation/);
  assert.match(html, /Use Measurements for map distance and area/);
});

test('point-cloud parent accepts health messages only from its same-origin iframe', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /event\.origin !== location\.origin \|\| event\.source !== iframe\.contentWindow/);
  assert.match(main, /message\.source !== 'ltds-pointcloud'/);
  assert.match(main, /message\.type === 'ready' && message\.code === 'points_visible'/);
  assert.match(main, /POINT_CLOUD_FAILURE_CODES\.has\(message\.code\)/);
  assert.match(main, /Cloud: unavailable \(\$\{code\}; ref \$\{DIAGNOSTIC_CORRELATION_ID\.slice\(0, 8\)\}\)/);
  assert.doesNotMatch(main, /cloudStatus\.textContent\s*=\s*message\.(?:code|error|detail)/);
});

test('viewer mode lifecycle cancels stale initializers and persists history', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /viewerModeFromUrl\(location\.href\)/);
  assert.match(main, /history\[historyMode === 'replace' \? 'replaceState' : 'pushState'\]/);
  assert.match(main, /window\.addEventListener\('popstate'/);
  assert.match(main, /modeEpoch \+= 1/);
  assert.match(main, /modeAbortController\?\.abort\(\)/);
  assert.match(main, /modeAbortController = new AbortController\(\)/);
  assert.match(main, /stopPointCloudIframe\('superseded'\)/);
  assert.match(main, /stopDirectPointCloud\('superseded'\)/);
  assert.match(main, /directPointCloudLoad\.controller\.abort\(\)/);
  assert.match(main, /iframe\.src = 'about:blank'/);
  assert.match(main, /disposeTiles\(\)/);
  assert.match(main, /epoch !== modeEpoch \|\| state\.activeMode !== 'ortho'/);
  assert.match(main, /epoch !== modeEpoch \|\| state\.activeMode !== type/);
  assert.match(main, /openGeoTiff\(url, \{ allowFullFile: false, blockSize: 262144, cacheSize: 128 \}, signal\)/);
  assert.match(main, /smallest\.readRasters\(\{ pool: geoPool, signal \}\)/);
  assert.match(main, /im\.readRasters\(\{ pool: geoPool, interleave: false, signal \}\)/);
  assert.match(main, /image\.readRasters\(\{ window: \[x0, y0, x1, y1\], width, height, resampleMethod: 'bilinear', pool: geoPool, signal \}\)/);
  assert.match(main, /setAbortSignal: function \(signal\)/);
  assert.match(main, /err\?\.name === 'AbortError'/);
});

test('mesh and Potree modes exchange one immutable camera snapshot before teardown', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /function captureMeshView\(\) \{[\s\S]*position: camera\.position\.clone\(\),[\s\S]*quaternion: camera\.quaternion\.clone\(\),[\s\S]*target: getViewTargetWorld\(\)/);
  const capture = main.indexOf("if (reason !== 'startup') rememberShared3DView(prevMode)");
  const dispose = main.indexOf('disposeTiles()', capture);
  assert.ok(capture >= 0 && dispose > capture, 'mesh view is captured before streamed tiles are disposed');
  assert.match(main, /setTimeout\(\(\) => pushViewToPointCloud\(snapshot, retries - 1, epoch\), 250\)/);
  assert.match(main, /epoch !== modeEpoch/);
  assert.match(main, /w\.__setViewUTM\(camU\.e, camU\.n, camU\.alt, tgtU\.e, tgtU\.n, tgtU\.alt\)/);
  assert.match(main, /typeof w\.__getViewUTM === 'function' \? w\.__getViewUTM\(\) : null/);
  assert.match(main, /controls\.setView\(camW, tgtW\)/);
});

test('viewer diagnostics are bounded and never include asset URLs or exception details', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /const DIAGNOSTIC_EVENTS = new Set/);
  assert.match(main, /const POINT_CLOUD_FAILURE_CODES = new Set/);
  assert.match(main, /Never include asset URLs, project titles,[\s\S]*bearer\/session credentials, or exception objects/);
  assert.match(main, /correlationId: DIAGNOSTIC_CORRELATION_ID, revision: VIEWER_BUILD_REVISION/);
  assert.match(main, /const DIAGNOSTIC_STAGES = new Set/);
  assert.match(main, /x-ltds-viewer-revision/);
  assert.match(main, /params\.set\('correlation', DIAGNOSTIC_CORRELATION_ID\)/);
  assert.match(main, /params\.set\('revision', VIEWER_BUILD_REVISION\)/);
  assert.match(main, /message\.correlationId !== iframe\.dataset\.correlationId/);
  assert.doesNotMatch(main, /showError\(`Failed to load point cloud from \$\{POINT_CLOUD_URL\}/);
});

test('LOD starts close-responsive, stages explicit high-detail requests, and caps reduced-memory clients honestly', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="lod-detail"[^>]*min="2"[^>]*max="24"[^>]*value="24"/);
  assert.match(html, /id="lod-evaluation-note" hidden[\s\S]*Nearby surfaces retain requested detail; Detail 24 restores raw quality everywhere/);
  assert.match(main, /lodRuntimeProfileState = configureLodRenderer/);
  assert.match(main, /const next = resolveLodDetailRequest\(lodRuntimeProfileState, lodWarmupComplete, e\.target\.value\)/);
  assert.match(main, /lodRuntimeProfileState\.requestedDetail = next\.requestedDetail/);
  assert.match(main, /lodRuntimeProfileState\.activeDetail = next\.activeDetail/);
  assert.match(main, /const quality = classifyLodQuality\(/);
  assert.match(main, /tilesRenderer\.errorTarget = lodTargetForDetail\(next\.activeDetail\)/);
  assert.match(main, /visibleLodTargetSatisfied\(tilesRenderer\.root, tilesRenderer\.errorTarget\)/);
  assert.match(main, /!lodDetailRequestPending\(lodRuntimeProfileState\)\) return false/);
  assert.match(main, /const queuesSettled = lodQueuesSettled\(tilesRenderer\)/);
  assert.match(main, /reduced-memory Detail \$\{lodRuntimeProfileState\.activeDetail\}/);
  assert.match(main, /else if \(quality\.fullDetail\) label = 'full-detail'/);
  assert.match(main, /pendingRequiredTiles > 0 \|\| snapshot\.pendingHierarchyNodes > 0/);
  assert.doesNotMatch(main, /releaseStaleLodDetails|transientRootBackdropEnabled|syncTransientRootLodBackdrop/);
});

test('viewer memory modes persist only a stable key and apply bounded runtime policy', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const policy = fs.readFileSync(path.join(__dirname, '..', 'lod-policy.mjs'), 'utf8');

  assert.match(html, /id="lod-memory-mode"[\s\S]*?<option value="auto">Auto<\/option>[\s\S]*?<option value="balanced">Balanced<\/option>[\s\S]*?<option value="high">High<\/option>/);
  assert.match(main, /deviceMemory is a coarse browser capability hint, not system or GPU RAM/);
  assert.match(main, /LOD_MEMORY_MODE_STORAGE_KEY = 'ltds-viewer:lod-memory-mode'/);
  assert.match(main, /localStorage\?\.setItem\(LOD_MEMORY_MODE_STORAGE_KEY, stableMode\)/);
  assert.doesNotMatch(main, /localStorage\?\.setItem\([^\n]*JSON\.stringify/,
    'runtime byte limits must never become stale persisted configuration');
  assert.match(main, /const deviceMemoryGiB = navigator\.deviceMemory;/);
  assert.doesNotMatch(main, /deviceMemory[\s\S]{0,120}userAgent/,
    'a user-agent guess must not be presented as memory capability');
  assert.match(main, /resolveLodMemoryProfile\(\{\s*mode: lodMemoryMode,\s*deviceMemoryGiB/);
  assert.match(main, /configureLodRenderer\(rendererInstance,[\s\S]*?memoryProfile,/);
  assert.match(main, /currentDetail[\s\S]*?detailSlider\.value = String\(MAX_LOD_DETAIL\)/,
    'invalid detail values may default');
  assert.doesNotMatch(main, /if \(detailSlider\) detailSlider\.value = String\(MAX_LOD_DETAIL\)/,
    'memory-profile reload must preserve the current Detail slider value');
  assert.match(main, /preserveIncomingModelView = true;\s*disposeTiles\(\);\s*loadTiles\(\);/);
  assert.match(main, /recentFrontierBytes/);
  assert.match(main, /shellRetentionBytes/);
  assert.match(main, /softMaxBytes: lodShellRetentionMaxBytes\(\)/,
    'profile shell retention is a preferred soft target');
  const shellBudget = main.slice(
    main.indexOf('function lodShellBudgetBytes'),
    main.indexOf('function updateLodRecentFrontier'),
  );
  assert.doesNotMatch(shellBudget, /hardMaxBytes:.*shellRetention/,
    'the legacy 1.30 GiB shell can still use the dataset-driven 1.5 GiB hard bound');
  assert.match(main, /budget\?\.softBytesSize[\s\S]*?scheduleUnload/,
    'crossing the soft cache boundary schedules stale-content eviction');

  assert.match(policy, /softBytesSize: softBytes/);
  assert.match(policy, /maxBytesSize: hardBytes/);
  assert.match(policy, /resolvedMemoryProfile\?\.downloadConcurrency/);
  assert.match(policy, /resolvedMemoryProfile\?\.parseConcurrency/);
});

test('production installs the exact renderer and applies the scoped ancestor patch in both image stages', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const rendererPatch = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'patch-3d-tiles-renderer.mjs'), 'utf8');
  assert.equal(packageJson.dependencies['3d-tiles-renderer'], '0.5.1');
  assert.equal(packageJson.scripts.postinstall,
    'node scripts/patch-3d-tiles-renderer.mjs && node scripts/install-basis-transcoder.mjs');
  assert.equal(
    [...dockerfile.matchAll(/COPY scripts\/patch-3d-tiles-renderer\.mjs scripts\/install-basis-transcoder\.mjs \.\/scripts\/\s+COPY scripts\/lib \.\/scripts\/lib\s+RUN npm ci/g)].length,
    2,
    'build and runtime installs must receive postinstall scripts and their patch modules before npm ci',
  );
  assert.match(rendererPatch, /lodFallbackTiles\?\.has/,
    'the pinned renderer patch must preserve only captured overview fallbacks without loadAncestors');
});

test('LOD memory pressure preserves camera-driven quality and resets on explicit lifecycle boundaries', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const loadBlock = main.slice(main.indexOf('function loadTiles()'), main.indexOf('function disposeTiles()'));
  const disposeBlock = main.slice(main.indexOf('function disposeTiles()'), main.indexOf('let sessionRenewalTimer'));
  const sliderStart = main.indexOf("document.getElementById('lod-detail').addEventListener('input'");
  const sliderBlock = main.slice(sliderStart, main.indexOf("document.querySelectorAll('#panel-measure", sliderStart));
  const statsBlock = main.slice(main.indexOf('function updateStats()'), main.indexOf('// expose for debugging/verification'));

  assert.match(main, /advanceLodMemoryPressure/);
  assert.match(main, /let lodStarvationSamples = 0;\s*let lodPressureClearSamples = 0;\s*let lodPendingAdmissionTile = null;\s*let lodPendingAdmissionBytes = 0;\s*let lodStarvedAtDetail = null;\s*let lodCacheRecoveryActive = false;\s*let lodLastSettledDetail = null;\s*let lodPressureView = null;/);
  for (const [label, block] of [['load', loadBlock], ['dispose', disposeBlock], ['slider', sliderBlock]]) {
    assert.match(block, /lodStarvationSamples = 0;\s*lodPressureClearSamples = 0;\s*clearLodPendingAdmission\(\);\s*lodStarvedAtDetail = null;\s*lodCacheRecoveryActive = false;/, `${label} must reset memory-pressure state`);
  }
  assert.match(sliderBlock, /if \(Number\.isFinite\(lodLastSettledDetail\)\) \{\s*lodLastSettledDetail = Math\.min\(lodLastSettledDetail, next\.activeDetail\)/);
  assert.match(statsBlock, /advanceLodMemoryPressure\(pressureSnapshot, lodRuntimeProfileState/);
  assert.match(statsBlock, /consecutiveSamples: lodStarvationSamples/);
  assert.match(statsBlock, /clearSamples: lodPressureClearSamples/);
  assert.match(statsBlock, /starvedAtDetail: lodStarvedAtDetail/);
  assert.match(statsBlock, /lastSettledDetail: lodLastSettledDetail/);
  assert.match(statsBlock, /lodStarvationSamples = pressure\.consecutiveSamples/);
  assert.match(statsBlock, /lodPressureClearSamples = pressure\.clearSamples/);
  assert.match(statsBlock, /lodStarvedAtDetail = pressure\.starvedAtDetail/);
  assert.match(statsBlock, /if \(pressure\.recoveryRequired\)/);
  assert.match(statsBlock, /lodCacheRecoveryActive = true/);
  assert.match(statsBlock, /lodCacheRetentionMinBytes\(\s*lodRuntimeProfileState\.budget,\s*true,\s*tilesRenderer\.lruCache/);
  assert.match(statsBlock, /const cacheRecoverySettled = lodCacheRecoveryActive/);
  assert.match(statsBlock, /pressureSnapshot\.pendingRequiredTiles === 0/);
  assert.match(statsBlock, /lodCacheRecoveryActive = false/);
  assert.match(statsBlock, /tilesRenderer\.lruCache\.minBytesSize = lodCacheRetentionMinBytes\(lodRuntimeProfileState\.budget, false\)/);
  assert.match(statsBlock, /tilesRenderer\.__ltdsPeripheralPressureScale = Math\.max/);
  const pressureChangeBlock = statsBlock.slice(
    statsBlock.indexOf('if (pressure.changed)'),
    statsBlock.indexOf('updateLodQualityStatus', statsBlock.indexOf('if (pressure.changed)')),
  );
  assert.doesNotMatch(pressureChangeBlock, /activeDetail\s*=/,
    'cache pressure must not lower the camera-driven global Detail target');
  assert.doesNotMatch(pressureChangeBlock, /tilesRenderer\.errorTarget\s*=/,
    'cache pressure must not inflate the global SSE target');
  assert.match(main, /memory-limited, target Detail \$\{lodRuntimeProfileState\.requestedDetail\}/,
    'memory-limited status must identify the requested target, not claim completed visible quality');
  assert.match(main, /pendingLabel = memoryLimited && pendingCount > 0/,
    'the limited-quality label must include its outstanding replacement work');
  assert.match(main, /function retryLodForChangedView\(\)/);
  assert.match(main, /lodViewChangeRequiresRetry\(lodPressureView, currentView\)/);
  const loadModelStart = loadBlock.indexOf("addEventListener('load-model'");
  const loadModelBlock = loadBlock.slice(loadModelStart, loadBlock.indexOf("addEventListener('load-error'", loadModelStart));
  assert.doesNotMatch(loadModelBlock, /recoverLodCacheAdmission\(/,
    'load-model fires after renderer 0.5.1 has already discarded an unadmitted parse');
  assert.match(loadBlock, /addEventListener\('tile-memory-pressure',[\s\S]*?const incomingBytes = Math\.max\(0, Number\(event\?\.bytesUsed\) \|\| 0\);[\s\S]*?recoverLodCacheAdmission\([\s\S]*?rendererInstance\.lruCache,[\s\S]*?lodRuntimeProfileState\.budget,[\s\S]*?incomingBytes/,
    'pre-discard recovery must run from the exact-pinned synchronous renderer event');
  assert.match(loadBlock, /const incomingBytes = Math\.max\(0, Number\(event\?\.bytesUsed\) \|\| 0\);[\s\S]*?retainLodOverviewTiles\(rendererInstance, retainedLodTiles\(\)\);\s*if \(recoverLodCacheAdmission\(/,
    'synchronous recovery must pin the bounded REPLACE shell and recent focal frontier before evicting stale detail');
  assert.doesNotMatch(loadBlock, /addEventListener\('tile-memory-pressure',[\s\S]*?lodRecentFrontier\.clear\(\)/,
    'ordinary prospective admission must not discard the bounded warm focal frontier');
  assert.match(loadBlock, /cachedBytes \+ incomingBytes > hardBytes[\s\S]*?lodPendingAdmissionTile = event\?\.tile[\s\S]*?lodPendingAdmissionBytes = incomingBytes/,
    'a prospective refusal below current isFull must remain visible to pressure recovery');
  assert.match(loadBlock, /addEventListener\('load-model',[\s\S]*?lodPendingAdmissionTile === ev\.tile[\s\S]*?clearLodPendingAdmission\(\)/,
    'successful later admission clears the exact refused-tile signal');
  assert.match(statsBlock, /prospectiveAdmissionBlocked = syncLodPendingAdmission\(\)[\s\S]*?pendingAdmissionBytes: lodPendingAdmissionBytes/);
  assert.match(main, /if \(lodStarvedAtDetail !== null\) return false;\s*lodLastSettledDetail = lodRuntimeProfileState\.activeDetail/,
    'a memory-limited fallback must never overwrite the last genuinely settled detail');
  assert.match(main, /emitLodDebugSnapshot\('view-change-retry', true\)/);
  assert.doesNotMatch(main, /lodCacheRetentionMinBytes\([^)]*, true\)\s*;\/\/.*zero/i);
});

test('LOD console telemetry is deduplicated sanitized and manually callable', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /lodDebugSnapshot/);
  assert.match(main, /function emitLodDebugSnapshot\(reason = 'status', force = false\)/);
  assert.match(main, /console\.info\('\[LTDS LOD\]', reason, JSON\.stringify\(snapshot\)\)/);
  assert.match(main, /emitLodDebugSnapshot\('status'\)/);
  assert.match(main, /lodDiagnostics: \(\) => emitLodDebugSnapshot\('manual', true\)/);
  assert.match(main, /lodTrace: \(\) => lodTraceEntries\.map\(entry => structuredClone\(entry\)\)/);
  assert.match(main, /tile load failed; run window\.__ltds\.lodDiagnostics\(\)/);
  assert.doesNotMatch(main, /console\.error\('Tiles load error', ev\)/);
});

test('Top View starts just inside the stable polar range instead of at the singular pole', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /import \{ EarthLikeControls, safeTopViewPosition \} from '\.\/earth-controls\.js'/);
  assert.match(main, /function topDownView\(\) \{\s*const target = new THREE\.Vector3\(0, 18, 0\);\s*controls\.setView\(safeTopViewPosition\(target, 542, controls\.minPolar\), target\);\s*\}/);
});
