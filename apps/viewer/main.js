import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { load as loadersGlLoad } from '@loaders.gl/core';
import { LASLoader } from '@loaders.gl/las';
import L from 'leaflet';
import { createMapCameraOverlay } from './map-camera-overlay.mjs';
import { createMeasurementWorkspace } from './measurement-workspace.mjs';
import { createMeasurementDraftRecovery } from './measurement-draft-recovery.mjs';
import { captureMeasurementReportOrtho } from './measurement-report-ortho.mjs';
import { installSidebarResize } from './viewer-sidebar-resize.mjs';
import { projectMeasurementBoundary } from './measurement-projection.mjs';
import { createMeasurementAdminClient } from './measurement-admin-client.mjs';
import { createMeasurementSurfaceClient, measurementAssetBearer } from './measurement-surface-client.mjs';
import { calculateBrowserSurface } from './measurement-browser-surface.mjs';
import { rasterDirectoryValue, rasterDecodedBlockBytes, validateRasterEncodedBlocks } from './raster-source-metadata.mjs';
import { readRasterBandMetadata, resolveRasterVerticalUnits } from './raster-vertical-units.mjs';
import { resolveMeasurementDisplayElevations } from './measurement-display-elevations.mjs';
import { resolveRenderedMeshBoundary, resolveRenderedPointBoundary, renderedPointNodeDescriptor } from './measurement-rendered-surface.mjs';
import { preflightBrowserRasterHeader } from './measurement-raster-header.mjs';
import { mountViewerProductDownloads } from './viewer-product-downloads.mjs';
import 'leaflet/dist/leaflet.css';
import { fromUrl as openGeoTiff, Pool as GeoTiffPool } from 'geotiff';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { installLodKtx2Support } from './lod-ktx2.mjs';
import { installLodLoadingTiming } from './lod-loading-timing.mjs';
import { lodEvaluationOptions, formatJsHeap } from './lod-evaluation-options.mjs';
import { createLodOwnerDiagnostics } from './lod-owner-diagnostics.mjs';
import { createLodRegionalFallbackCoordinator } from './lod-regional-fallback.mjs';
import { installLodAdmissionThrottle } from './lod-admission-throttle.mjs';
import { installLodLoadingBudget } from './lod-loading-budget.mjs';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import {
  advanceLodMemoryPressure,
  configureLodRenderer,
  classifyLodQuality,
  MAX_LOD_DETAIL,
  decideLodStartup,
  inspectLodProvenance,
  inspectLodTileset,
  installLodOverviewRetention,
  lodBootstrapCoverageErrorTarget,
  lodBootstrapRootErrorTarget,
  lodBranchBlockerCut,
  lodFallbackShellMaxBytes,
  lodFallbackShellPlan,
  LOD_FALLBACK_MIN_DETAIL_BYTES,
  LOD_FALLBACK_TARGET_BYTES,
  LOD_PREFETCH_MAX_DEPTH,
  LOD_PREFETCH_MAX_MS,
  lodDebugSnapshot,
  lodDetailRequestPending,
  lodCacheRetentionMinBytes,
  lodQueuesSettled,
  lodViewChangeRequiresRetry,
  refreshLodResolution,
  recoverLodCacheAdmission,
  retainLodOverviewTiles,
  selectLodRecentFrontier,
  resolveLodDetailRequest,
  resolveLodWarmupAdvance,
  detailToErrorTarget,
  visibleLodFrontier,
  visibleLodTargetSatisfied,
} from './lod-policy.mjs';
import { EarthLikeControls, safeTopViewPosition } from './earth-controls.js';
import { pickDirectPointSurface } from './direct-pointcloud-picking.mjs';
import { localizePointPositions, refreshPointGeometryBounds } from './point-cloud-utils.mjs';
import { formatArea, formatElevation, formatLength, formatVolume, formatVolumeDetail, normalizeUnits } from './unit-formatters.mjs';
import { cameraFeatureImageUpBearing, cameraFeatureMapPosition, normalizeCameraFeatureCollection, normalizeCameraPhotoKey } from './camera-runtime.mjs';
import { CAMERA_MARKER_COLORS, CAMERA_MARKER_OPACITY, CAMERA_MARKER_STYLE, DEFAULT_CAMERA_MARKER_SCALE, cameraMarkerGeometryData, cameraMarkerScaleForView, selectCameraMarkerRepresentatives } from './camera-markers.mjs';
import { clampPhotoView, fitPhotoBox, panPhotoView, zoomPhotoView } from './camera-photo-view.mjs';
import { isRgbNoData, maskedRgbBilinear, parseFiniteGdalNoData } from './orthophoto-mask.mjs';
import { integrateElevationVolume } from './map-volume.mjs';
import { createDemUpdateQueue } from './dem-update-queue.mjs';
import { closeZoomDistanceForDiameter } from './viewer-scale.mjs';
import { availableViewerModes, chooseViewerMode, viewerModeFromUrl, viewerModeUrl } from './view-mode.mjs';
import { installLodResourceLifecycle } from './lod-resource-lifecycle.mjs';
import { createUtmProjection } from './utm-conversion.mjs';
import { homeViewForBounds, tilesetWorldBounds } from './viewer-framing.mjs';
import { classifyTileLoadFailure, releaseFailedTileReservations, createRenewedTileFetcher } from './lod-load-recovery.mjs';
import {
  parseLodMemoryMode,
  resolveLodMemoryProfile,
  serializeLodMemoryMode,
} from './lod-memory-profile.mjs';

// BVH-accelerated raycasting (critical for pivot picking on huge meshes)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ────────────────────────────────────────────────
// Per-project config, fetched from this app's own backend (server/api.js)
// at startup via bootstrap(). Nothing below is hardcoded to a specific
// WebODM project any more — see README for the GET /api/models(/:id) shape.
// ────────────────────────────────────────────────
let PROJECT = null;
const LOD_EVALUATION = lodEvaluationOptions(location.search);
let GLB_URL = null, TILES_URL = null, OBJ_URL = null;
let LOD_PROVENANCE = null;
let LOD_PROVENANCE_VERIFIED = false;
let SHOTS_URL = null, PHOTO_BASE = null;
let ORTHO_URL = null, DSM_URL = null, DTM_URL = null;
let EPT_URL = null, POINT_COUNT = null;
// Direct (non-Potree) point cloud fallback — format is 'laz' or 'ply',
// decoded client-side by loadPointCloudDirect() below.
let POINT_CLOUD_URL = null, POINT_CLOUD_FORMAT = null;
// RTC = local-model-origin UTM offset, C = model bbox center (both come from
// coords.txt / an optional imported-derivatives sidecar).
let RTC = { e: 0, n: 0, z: 0 };
let C = { x: 0, y: 0, z: 0 };
let UTM_PROJECTION = createUtmProjection();

const METERS_TO_FT = 3.28084;
let DISPLAY_UNITS = 'imperial';
function setDisplayUnits(value){DISPLAY_UNITS=normalizeUnits(value);const suffix=DISPLAY_UNITS==='metric'?'m':'ft';if(dom.demMinLabel)dom.demMinLabel.textContent=`Min ${suffix}`;if(dom.demMaxLabel)dom.demMaxLabel.textContent=`Max ${suffix}`;if(dom.demLegendUnit)dom.demLegendUnit.textContent=`Elevation (${suffix})`;const volumeUnit=document.getElementById('map-volume-custom-unit');if(volumeUnit)volumeUnit.textContent=suffix;}
function elevationInputMeters(value){return DISPLAY_UNITS==='metric'?value:value/METERS_TO_FT;}

// world (three.js Y-up, model centered at origin) <-> UTM
function worldToUtm(p) {
  return {
    e: p.x + C.x + RTC.e,
    n: -p.z + C.y + RTC.n,
    alt: p.y + C.z + RTC.z
  };
}

function utmToWorld(e, n, alt) {
  return new THREE.Vector3(
    e - RTC.e - C.x,
    alt - RTC.z - C.z,
    -(n - RTC.n - C.y)
  );
}

// ───────────────────────────────────────────────────────────────
// DOM refs
// ───────────────────────────────────────────────────────────────
const dom = {};
['loading-overlay','loading-text','loading-progress','error-panel','error-message',
 'three-container','leaflet-map','cloud-container','fps','mem-display','coords',
 'mode-status','cloud-status','tris-status','lod-status','measure-output','dem-legend',
 'dem-hover','legend-canvas','dem-legend-labels','photo-modal','photo-frame','photo-imgwrap','photo-img','photo-title',
 'photo-meta','photo-close','photo-download','photo-spinner','photo-empty','cam-tooltip','labels-container',
 'error-actions','error-retry','error-lod','loading-cancel',
 'dem-settings','dem-colormap','dem-shading','dem-min','dem-max','dem-min-label','dem-max-label','dem-legend-unit',
 'brand-project','project-switcher','admin-controls','btn-share','btn-logout','btn-measure-float','lod-memory-mode',
 'share-password-overlay','share-password-input','share-password-error','share-password-submit',
 'share-modal','share-modal-close','share-new-password','share-new-expires',
 'share-new-perm-measure','share-new-perm-cameras','share-create-btn','share-create-result',
 'share-links-list'
].forEach(id => { dom[id.replace(/-([a-z])/g, (m,c)=>c.toUpperCase())] = document.getElementById(id); });

// Resolved once at startup from the URL path: 'admin' (internal browsing,
// requires a server-side admin login — see server/index.js), 'view' (full
// toolbar via /view/:token), 'project' (one link with a published-task
// chooser), or 'embed' (minimal chrome via /embed/:token).
const VIEW_MODE = location.pathname.startsWith('/embed/') ? 'embed'
  : location.pathname.startsWith('/view/') ? 'view'
  : location.pathname.startsWith('/project/') ? 'project'
  : location.pathname.startsWith('/session') ? 'session' : 'admin';
const SHARE_TOKEN = VIEW_MODE === 'view' || VIEW_MODE === 'embed' || VIEW_MODE === 'project'
  ? decodeURIComponent(location.pathname.split('/')[2] || '') : null;
const SESSION_PATH_PARTS = location.pathname.split('/');
const ACTIVE_SESSION_ID = VIEW_MODE === 'session' && SESSION_PATH_PARTS[2] === 'active'
  ? decodeURIComponent(SESSION_PATH_PARTS[3] || '') : null;
const SESSION_GRANT = VIEW_MODE === 'session' && !ACTIVE_SESSION_ID
  ? decodeURIComponent(SESSION_PATH_PARTS[2] || '') : null;
const SESSION_STORAGE_PREFIX = 'ltds-viewer-access-token:';
let sessionStorageKey = ACTIVE_SESSION_ID ? `${SESSION_STORAGE_PREFIX}${ACTIVE_SESSION_ID}` : null;
let PROJECT_SHARE_CATALOG = null;
// What the active share link allows; stays fully-open in admin mode.
let SHARE_PERMISSIONS = { measure: true, cameras: true };
let measurementWorkspace = null;
let viewerProductDownloads = null;

const state = {
  activeMode: null,
  meshSource: 'none',       // 'tiles' | 'lod-required' | 'none'
  cloudMode: 'none',        // 'potree' (EPT via iframe) | 'direct' (LAZ/PLY in three.js) | 'none'
  pointCloudLoaded: false, pointCloudLoading: false,
  camerasLoaded: false, camerasLoading: false, camerasVisible: false,
  activeTool: 'none',
  measure: null,           // in-progress measurement
  measurements: [],        // finished measurements
  pcIframeLoaded: false
};

let scene, camera, renderer, labelRenderer, controls, clock;
let glbParent, glbOffset, tilesParent;
let pointCloudParent, pointCloudOffset, pointCloudObject = null;
let lodFailureHandled = false;
let tilesRenderer = null;
let lodKtx2Support = null;
let lodLoadingTiming = null;
let lodRuntimeProfileState = null;
let lodWarmupComplete = false;
let lodBootstrapPhase = 'inactive';
let lodBootstrapRootTarget = 4096;
let lodBootstrapCoverageTarget = 1024;
let lodErrorScale = 1;
let lodPrefetchStartedAt = 0;
let lodPrefetchElapsedMs = null;
let lodPrefetchReadyFrames = 0;
let lodPrefetchExitReason = null;
let lodPrefetchSoftBudgetReported = false;
let lodOverviewTiles = [];
let restoreLodOverviewRetention = null;
let lodStarvationSamples = 0;
let lodPressureClearSamples = 0;
let lodPendingAdmissionTile = null;
let lodPendingAdmissionBytes = 0;
let lodStarvedAtDetail = null;
let lodCacheRecoveryActive = false;
let lodLastSettledDetail = null;
let lodPressureView = null;
let lodDebugSignature = '';
let lodQualitySignature = '';
let lodQualityStableFrames = 0;
let lodLastQualityFrame = -1;
let lodLastQualityUpdateAt = 0;
let lodLastInteractionSequence = 0;
let lodTraceEntries = [];
let lodRecentFrontier = new Map();
let lodBranchBlockers = new Set();
let lodOwnerDebug = null;
let lodRegionalFallback = null;
let lodAdmissionThrottle = null;
let lodLoadingBudget = null;
const LOD_RECENT_FRONTIER_TTL_MS = 2_000;
const LOD_RECENT_FRONTIER_MAX_TILES = 128;
const LOD_RECENT_FRONTIER_MAX_BYTES = 384 * 1024 * 1024;
const LOD_MEMORY_MODE_STORAGE_KEY = 'ltds-viewer:lod-memory-mode';

function readLodMemoryMode() {
  try {
    return parseLodMemoryMode(globalThis.localStorage?.getItem(LOD_MEMORY_MODE_STORAGE_KEY));
  } catch {
    return parseLodMemoryMode(null);
  }
}

function persistLodMemoryMode(mode) {
  const stableMode = serializeLodMemoryMode(mode);
  try {
    globalThis.localStorage?.setItem(LOD_MEMORY_MODE_STORAGE_KEY, stableMode);
  } catch {
    // Storage can be blocked in embedded/private contexts. The selection still
    // applies to the current viewer session.
  }
  return stableMode;
}

// Advanced controls are retained for future developer use, but hidden from the
// current Viewer. Do not silently reuse an old manual memory selection.
let lodMemoryMode = 'auto';
let lodTileRecoveryPending = false;
let lodTileRetryAttempt = 0;
let lodTileRetryTimer = null;
let lodTileLastFailureAt = 0;

function clearLodPendingAdmission() {
  lodPendingAdmissionTile = null;
  lodPendingAdmissionBytes = 0;
}

function syncLodPendingAdmission() {
  if (!tilesRenderer || !lodPendingAdmissionTile || lodPendingAdmissionBytes <= 0) {
    clearLodPendingAdmission();
    return false;
  }
  const cache = tilesRenderer.lruCache;
  const cachedBytes = Math.max(0, Number(cache?.cachedBytes) || 0);
  const hardBytes = Number(cache?.maxBytesSize);
  const traversal = lodPendingAdmissionTile.traversal;
  const stillRequired = traversal?.used === true && traversal?.inFrustum === true;
  const nowFits = Number.isFinite(hardBytes)
    && cachedBytes + lodPendingAdmissionBytes <= hardBytes;
  if (!stillRequired || nowFits) {
    clearLodPendingAdmission();
    return false;
  }
  return true;
}
const CAMERA_MARKER_COMPONENTS = Object.freeze(['body', 'face', 'cue', 'tab']);
let camGroupParent, camMarkerMeshes = [], camFeatures = [];
let raycaster, hoverRaycaster;
let map, orthoLayers = null, demLayers = { dsm: null, dtm: null };
let mapCameraLayer = null;
let mapCameraFeatures = null;
let mapCameraScale = null;
let mapCameraSources = [];
let mapViews = {};            // per-tab map center/zoom retention
let mapMeasure = null;        // active Leaflet distance/area sketch
let mapMeasurements = [];     // completed Leaflet layer groups
// WebODM-style DEM rendering settings (shared by DSM/DTM, like WebODM's layer panel)
const demSettings = {
  cmap: 'viridis',
  shade: 1.0,          // hillshade intensity 0..2
  minFt: null,         // null = auto from data
  maxFt: null,
  steps: 0             // 0 = continuous colormap, >0 = N discrete elevation bands
};
let geoDatasets = {};        // url -> { tiff, images[], ... }
let geoPool = null;
// Share one page-lifetime decoder pool across map tiles and display elevations,
// including sessions opened directly into a 3D view before any map was loaded.
function ensureGeoTiffPool() {
  if (!geoPool) geoPool = new GeoTiffPool(Math.min(4, navigator.hardwareConcurrency || 2));
  return geoPool;
}
let lastFps = performance.now(), frames = 0;
let lodResources = null;
let homeView = null;
let modeEpoch = 0;
let modeAbortController = null;
let mapToolEpoch = 0;
let directPointCloudLoad = null;
let pendingPointCloudView = null;
// Page-local only: map views must not replace the last shared 3D viewpoint.
// Reloading or opening another model starts with its normal home view.
let lastShared3DView = null;
let preserveIncomingModelView = false;
let pcCameraSyncedWindow = null;

const DIAGNOSTIC_CORRELATION_ID = (() => {
  const value = globalThis.crypto?.randomUUID?.();
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
    ? value
    : `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 14)}`;
})();
let VIEWER_BUILD_REVISION = 'unavailable';

const DIAGNOSTIC_EVENTS = new Set([
  'mode_start', 'mode_cancel', 'pointcloud_start', 'pointcloud_stop',
  'pointcloud_ready', 'pointcloud_failure',
]);
const DIAGNOSTIC_REASONS = new Set(['navigation', 'history', 'startup', 'superseded', 'unavailable']);
const DIAGNOSTIC_STAGES = new Set(['startup', 'metadata', 'nodes', 'fetch', 'decode', 'runtime']);
const POINT_CLOUD_FAILURE_CODES = new Set([
  'authorization_required', 'authorization_unavailable',
  'startup_timeout', 'load_timeout', 'node_timeout', 'resource_failed',
  'runtime_unavailable', 'metadata_failed', 'runtime_error', 'not_configured',
]);

// Diagnostics are deliberately finite. The random correlation id is not an
// authorization/session identifier. Never include asset URLs, project titles,
// bearer/session credentials, or exception objects here.
function viewerDiagnostic(event, { mode = null, reason = null, code = null, stage = null } = {}) {
  if (!DIAGNOSTIC_EVENTS.has(event)) return;
  const details = { correlationId: DIAGNOSTIC_CORRELATION_ID, revision: VIEWER_BUILD_REVISION };
  if (['model', 'cloud', 'ortho', 'dsm', 'dtm'].includes(mode)) details.mode = mode;
  if (DIAGNOSTIC_REASONS.has(reason)) details.reason = reason;
  if (POINT_CLOUD_FAILURE_CODES.has(code)) details.code = code;
  if (DIAGNOSTIC_STAGES.has(stage)) details.stage = stage;
  const method = event.endsWith('failure') ? 'warn' : 'info';
  console[method](`[viewer-runtime] ${event}`, details);
}

async function captureViewerBuildRevision() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch('/api/v1/health', { cache: 'no-store', signal: controller.signal });
    const revision = response.headers.get('x-ltds-viewer-revision')?.trim().toLowerCase();
    VIEWER_BUILD_REVISION = /^[0-9a-f]{40}$/.test(revision || '') ? revision : 'unavailable';
  } catch {
    VIEWER_BUILD_REVISION = 'unavailable';
  } finally {
    clearTimeout(timeout);
  }
}

bootstrap();

// ───────────────────────────────────────────────────────────────
// Bootstrap: admin mode picks a project (via ?project= or the first
// available one) from the internal catalog; view/embed mode validates the
// share token in the URL instead. Replaces the old module-load-time
// hardcoded constants.
// ───────────────────────────────────────────────────────────────
async function bootstrap() {
  // Authenticated LTDS sessions are the primary, full Viewer experience. The
  // separate /embed route remains available only for explicit share embeds.
  document.body.classList.add(`${VIEW_MODE === 'session' ? 'view' : VIEW_MODE}-mode`);
  bindSharePasswordForm();
  bindAdminControls();
  await captureViewerBuildRevision();

  if (VIEW_MODE === 'session') return bootstrapSession();
  if (VIEW_MODE === 'project') return bootstrapProjectShare();
  if (VIEW_MODE !== 'admin') return bootstrapShare();

  let models = [];
  try {
    const res = await fetch('/api/models');
    if (res.ok) models = await res.json();
    else if (res.status === 401) { location.reload(); return; }   // session expired -> show login page
  } catch (err) {
    console.error('Failed to reach the viewer API', err);
  }

  populateProjectSwitcher(models);

  if (!models.length) {
    updateLoading('No projects available yet', 'Import or manage a model from the secure Viewer workspace.');
    return;
  }

  const requested = new URLSearchParams(location.search).get('project');
  const targetId = (requested && models.some((m) => m.id === requested)) ? requested : models[0].id;

  try {
    const res = await fetch(`/api/models/${encodeURIComponent(targetId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    PROJECT = await res.json();
  } catch (err) {
    console.error('Failed to load project config', err);
    updateLoading('Could not load this project', String(err.message || err));
    return;
  }

  applyProjectConfig(PROJECT);
  init();
}

async function fetchProjectShareCatalog(initial = null) {
  const tasks = [];
  let page = initial;
  let cursor = null;
  for (let count = 0; count < 100; count += 1) {
    if (!page) {
      const query = cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : '?limit=50';
      const response = await fetch(`/api/project-share/${encodeURIComponent(SHARE_TOKEN)}${query}`);
      if (response.status === 401) {
        const body = await response.json().catch(() => ({}));
        if (body.requiresPassword) return { requiresPassword: true };
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
      page = body;
    }
    tasks.push(...(page.tasks || []));
    cursor = page.nextCursor;
    if (!cursor) return { ...page, tasks };
    page = null;
  }
  throw new Error('This project contains too many task pages to display safely.');
}

async function applyProjectShareCatalog(catalog) {
  PROJECT_SHARE_CATALOG = catalog;
  SHARE_PERMISSIONS = catalog.permissions || { measure: true, cameras: true };
  setDisplayUnits(catalog.displayUnits);
  const options = catalog.tasks.map((task) => ({ id: task.id, title: task.displayName || task.modelTitle || 'Published task' }));
  populateProjectSwitcher(options, { queryKey: 'task' });
  if (!options.length) {
    updateLoading('No published tasks', 'This project link is active, but no task currently has a published model.');
    return;
  }
  const requested = new URLSearchParams(location.search).get('task');
  const taskId = options.some((task) => task.id === requested) ? requested : options[0].id;
  if (dom.projectSwitcher) dom.projectSwitcher.value = taskId;
  const url = new URL(location.href);
  url.searchParams.set('task', taskId);
  history.replaceState(null, '', url.toString());
  const response = await fetch(`/api/project-share/${encodeURIComponent(SHARE_TOKEN)}/tasks/${encodeURIComponent(taskId)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status });
  applyShareResult(body);
}

async function bootstrapProjectShare() {
  if (!SHARE_TOKEN) { updateLoading('Invalid link', 'No project share token was found in this URL.'); return; }
  updateLoading('Loading shared project...', '');
  try {
    const catalog = await fetchProjectShareCatalog();
    if (catalog.requiresPassword) { showSharePasswordPrompt(); return; }
    await applyProjectShareCatalog(catalog);
  } catch (error) {
    updateLoading(error.status === 410 ? 'Link expired' : 'Could not load this project link', String(error.message || error));
  }
}

// ───────────────────────────────────────────────────────────────
// Share (view/embed) bootstrap — validates the token in the URL against
// the backend instead of browsing the internal catalog.
// ───────────────────────────────────────────────────────────────
async function bootstrapShare() {
  if (!SHARE_TOKEN) { updateLoading('Invalid link', 'No share token was found in this URL.'); return; }
  updateLoading('Loading shared model...', '');
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(SHARE_TOKEN)}`);
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}));
      if (body.requiresPassword) { showSharePasswordPrompt(); return; }
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      updateLoading(
        res.status === 410 ? 'Link expired' : 'Link not found',
        body.error || 'This share link is no longer valid.'
      );
      return;
    }
    applyShareResult(await res.json());
  } catch (err) {
    console.error('Failed to load shared model', err);
    updateLoading('Could not load this link', String(err.message || err));
  }
}

function showSharePasswordPrompt() {
  hideLoading();
  if (dom.sharePasswordOverlay) dom.sharePasswordOverlay.style.display = 'flex';
  if (dom.sharePasswordInput) { dom.sharePasswordInput.value = ''; dom.sharePasswordInput.focus(); }
}

function hideSharePasswordPrompt() {
  if (dom.sharePasswordOverlay) dom.sharePasswordOverlay.style.display = 'none';
}

function bindSharePasswordForm() {
  if (!dom.sharePasswordSubmit) return;
  const submit = async () => {
    dom.sharePasswordError.textContent = '';
    dom.sharePasswordSubmit.disabled = true;
    try {
      const endpoint = VIEW_MODE === 'project'
        ? `/api/project-share/${encodeURIComponent(SHARE_TOKEN)}/unlock?limit=50`
        : `/api/share/${encodeURIComponent(SHARE_TOKEN)}/unlock`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: dom.sharePasswordInput.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        dom.sharePasswordError.textContent = res.status === 429
          ? 'Too many attempts — please wait a few minutes.'
          : (body.error || 'Incorrect password.');
        dom.sharePasswordSubmit.disabled = false;
        return;
      }
      hideSharePasswordPrompt();
      if (VIEW_MODE === 'project') await applyProjectShareCatalog(await fetchProjectShareCatalog(body));
      else applyShareResult(body);
    } catch (err) {
      dom.sharePasswordError.textContent = 'Could not reach the server.';
      dom.sharePasswordSubmit.disabled = false;
    }
  };
  dom.sharePasswordSubmit.addEventListener('click', submit);
  dom.sharePasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function applyShareResult(cfg) {
  setDisplayUnits(cfg.displayUnits);
  PROJECT = cfg;
  SHARE_PERMISSIONS = cfg.permissions || { measure: true, cameras: true };
  applyProjectConfig(cfg);
  init();
}

// ───────────────────────────────────────────────────────────────
// Admin-only controls: Share-link management modal + Log out.
// Elements exist in the DOM regardless of mode but are only ever shown
// (via CSS) when VIEW_MODE === 'admin'.
// ───────────────────────────────────────────────────────────────
function bindAdminControls() {
  if (VIEW_MODE !== 'admin') return;
  if (dom.adminControls) dom.adminControls.style.display = 'flex';

  if (dom.btnLogout) {
    dom.btnLogout.addEventListener('click', async () => {
      try { await fetch('/api/admin/logout', { method: 'POST' }); } catch { /* ignore */ }
      location.href = '/';
    });
  }
  if (dom.btnShare) dom.btnShare.addEventListener('click', openShareModal);
  if (dom.shareModalClose) dom.shareModalClose.addEventListener('click', closeShareModal);
  if (dom.shareModal) dom.shareModal.addEventListener('click', (e) => { if (e.target === dom.shareModal) closeShareModal(); });
  if (dom.shareCreateBtn) dom.shareCreateBtn.addEventListener('click', createShareLink);
}

function openShareModal() {
  if (!PROJECT || !dom.shareModal) return;
  dom.shareCreateResult.style.display = 'none';
  dom.shareCreateResult.innerHTML = '';
  dom.shareModal.style.display = 'flex';
  loadShareLinksList();
}

function closeShareModal() {
  if (dom.shareModal) dom.shareModal.style.display = 'none';
}

async function loadShareLinksList() {
  dom.shareLinksList.innerHTML = '<div class="hint">Loading…</div>';
  try {
    const res = await fetch(`/api/models/${encodeURIComponent(PROJECT.id)}/share-links`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const shares = await res.json();
    if (!shares.length) {
      dom.shareLinksList.innerHTML = '<div class="hint">No share links yet for this project.</div>';
      return;
    }
    dom.shareLinksList.innerHTML = shares.map((s) => {
      const bits = [
        s.hasPassword ? 'Password-protected' : 'Public',
        s.expiresAt ? `expires ${new Date(s.expiresAt).toLocaleDateString()}` : 'no expiry',
        `${s.accessCount || 0} view${s.accessCount === 1 ? '' : 's'}`,
      ];
      if (!s.permissions?.measure) bits.push('no measuring');
      if (!s.permissions?.cameras) bits.push('no cameras');
      return `<div class="share-link-row${s.active ? '' : ' revoked'}">
        <div class="meta">
          <span>${bits.join(' · ')}</span>
          <span style="color:var(--brand-muted);">created ${new Date(s.createdAt).toLocaleString()}</span>
        </div>
        ${s.active ? `<button class="revoke-btn" data-share-id="${s.id}">Revoke</button>` : '<span>Revoked</span>'}
      </div>`;
    }).join('');
    dom.shareLinksList.querySelectorAll('.revoke-btn').forEach((btn) => {
      btn.addEventListener('click', () => revokeShareLink(btn.dataset.shareId));
    });
  } catch (err) {
    dom.shareLinksList.innerHTML = '<div class="hint">Could not load share links.</div>';
  }
}

async function revokeShareLink(id) {
  try {
    await fetch(`/api/share-links/${encodeURIComponent(id)}`, { method: 'DELETE' });
    loadShareLinksList();
  } catch (err) {
    console.error('Failed to revoke share link', err);
  }
}

async function createShareLink() {
  dom.shareCreateBtn.disabled = true;
  try {
    const body = {
      password: dom.shareNewPassword.value || undefined,
      expiresDays: dom.shareNewExpires.value ? Number(dom.shareNewExpires.value) : undefined,
      permissions: {
        measure: dom.shareNewPermMeasure.checked,
        cameras: dom.shareNewPermCameras.checked,
      },
    };
    const res = await fetch(`/api/models/${encodeURIComponent(PROJECT.id)}/share-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const share = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(share.error || `HTTP ${res.status}`);

    dom.shareCreateResult.style.display = 'block';
    dom.shareCreateResult.innerHTML = `
      <div>Link created — copy it now, it won't be shown again.</div>
      <div class="url-row"><input readonly value="${share.viewUrl}"> <button class="text-btn" data-copy="${share.viewUrl}">Copy View</button></div>
      <div class="url-row"><input readonly value="${share.embedUrl}"> <button class="text-btn" data-copy="${share.embedUrl}">Copy Embed</button></div>
    `;
    dom.shareCreateResult.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => navigator.clipboard?.writeText(btn.dataset.copy));
    });
    dom.shareNewPassword.value = '';
    dom.shareNewExpires.value = '';
    loadShareLinksList();
  } catch (err) {
    dom.shareCreateResult.style.display = 'block';
    dom.shareCreateResult.textContent = `Failed to create link: ${err.message || err}`;
  } finally {
    dom.shareCreateBtn.disabled = false;
  }
}

function populateProjectSwitcher(models, { queryKey = 'project' } = {}) {
  if (!dom.projectSwitcher) return;
  dom.projectSwitcher.innerHTML = models.map((m) => `<option value="${m.id}">${m.title}</option>`).join('');
  dom.projectSwitcher.style.display = models.length > 1 ? '' : 'none';
  dom.projectSwitcher.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set(queryKey, dom.projectSwitcher.value);
    location.href = url.toString();
  });
}

function applyProjectConfig(p) {
  setDisplayUnits(p.displayUnits || DISPLAY_UNITS);
  if (VIEW_MODE === 'admin') {
    // Only rewrite the URL / project-switcher selection in admin mode —
    // in view/embed mode the URL is the share link itself (/view/:token or
    // /embed/:token) and must never be replaced with the internal project id.
    const url = new URL(location.href);
    url.searchParams.set('project', p.id);
    history.replaceState(null, '', url.toString());
    if (dom.projectSwitcher) dom.projectSwitcher.value = p.id;
  }

  document.title = `Ledge Top Drone Services — ${p.title}`;
  if (dom.brandProject) dom.brandProject.textContent = `${p.title} — 3D Photogrammetry Viewer`;
  if (dom.loadingText) dom.loadingText.textContent = `Initializing ${p.title} viewer...`;

  GLB_URL = p.assets.glb;
  TILES_URL = p.assets.tiles;
  LOD_PROVENANCE = p.lodProvenance || null;
  LOD_PROVENANCE_VERIFIED = p.lodProvenanceVerified === true;
  OBJ_URL = p.assets.obj;
  SHOTS_URL = p.assets.shots;
  ORTHO_URL = p.assets.ortho;
  DSM_URL = p.assets.dsm;
  DTM_URL = p.assets.dtm;
  EPT_URL = p.assets.ept;
  POINT_CLOUD_URL = p.assets.pointCloud || null;
  POINT_CLOUD_FORMAT = p.assets.pointCloudFormat || null;
  POINT_COUNT = p.pointCount || null;
  PHOTO_BASE = p.assets.cameraPhotos || null;

  RTC = (p.georef && p.georef.rtc) || { e: 0, n: 0, z: 0 };
  C = (p.georef && p.georef.bboxCenter) || { x: 0, y: 0, z: 0 };
  UTM_PROJECTION = createUtmProjection({
    zoneLon0Deg: p.georef?.utmZoneLon0Deg ?? -87,
    hemisphere: p.georef?.hemisphere ?? 'N',
  });

  // Pick the best available mesh/point-cloud source for this project.
  state.meshSource = TILES_URL ? 'tiles' : (GLB_URL || OBJ_URL ? 'lod-required' : 'none');
  state.cloudMode = EPT_URL ? 'potree' : (POINT_CLOUD_URL ? 'direct' : 'none');
}

function init() {
  initThree();
  bindUI();
  installMeasurementWorkspace();
  const available = applyAvailability();
  const requested = viewerModeFromUrl(location.href);
  const initialMode = chooseViewerMode(requested, available);
  if (initialMode) {
    switchMode(initialMode, { historyMode: 'replace', force: true, reason: 'startup' });
  } else if (state.meshSource === 'lod-required') {
    // The original mesh is intentionally download-only. Leave the workspace
    // interactive while its verified streaming derivative is generated.
    hideLoading();
    updateStatus('Streaming LOD unavailable or processing');
  } else {
    updateLoading('No published views available', 'Original source files remain available for authenticated download in Operations.');
  }
  loadCameras();         // prepare camera positions (hidden until toggled); no-op if unavailable
  startLoop();
}

// Hide tabs/buttons for layers this project doesn't have, and make sure the
// mesh-layer buttons reflect state.meshSource before applyMeshLayer() runs.
function applyAvailability() {
  const available = availableViewerModes({
    meshSource: state.meshSource,
    cloudMode: state.cloudMode,
    ortho: Boolean(ORTHO_URL),
    dsm: Boolean(DSM_URL),
    dtm: Boolean(DTM_URL),
  });
  const setVisible = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  };
  setVisible('tab-model', available.includes('model'));
  setVisible('tab-cloud', state.cloudMode !== 'none');
  setVisible('tab-ortho', !!ORTHO_URL);
  setVisible('tab-dsm', !!DSM_URL);
  setVisible('tab-dtm', !!DTM_URL);
  setVisible('layer-cameras', !!SHOTS_URL && SHARE_PERMISSIONS.cameras);
  setVisible('panel-pc', state.cloudMode === 'potree');   // budget/size/EDL sliders only apply to Potree
  // A share link can disable measuring entirely (permissions.measure=false).
  if (dom.btnMeasureFloat) {
    dom.btnMeasureFloat.style.display = (VIEW_MODE === 'embed' && SHARE_PERMISSIONS.measure && state.meshSource === 'tiles') ? 'flex' : 'none';
  }

  const tilesBtn = document.getElementById('layer-tiles');
  tilesBtn.classList.remove('active');
  if (state.meshSource === 'tiles') {
    tilesBtn.style.display = '';
    tilesBtn.textContent = 'Streamed LOD Mesh';
    tilesBtn.dataset.layer = 'tiles';
    tilesBtn.classList.add('active');
  } else if (state.meshSource === 'lod-required') {
    tilesBtn.style.display = '';
    tilesBtn.textContent = 'Streaming LOD unavailable';
    tilesBtn.dataset.layer = 'lod-required';
    tilesBtn.disabled = true;
    tilesBtn.title = 'Streaming tiles are still processing or unavailable. Download the original mesh from Operations if needed.';
    updateStatus('Streaming LOD unavailable or processing');
    // There is no interactive full-mesh fallback to finish this loading state.
    // Keep the workspace usable while the verified background derivative is
    // pending, and let authenticated sessions discover it in place.
    hideLoading();
    scheduleLodAvailabilityRefresh();
  } else {
    tilesBtn.style.display = 'none';
  }
  if (state.meshSource !== 'lod-required') {
    tilesBtn.disabled = false;
    tilesBtn.title = '';
  }

  return available;
}

// ───────────────────────────────────────────────────────────────
// THREE setup
// ───────────────────────────────────────────────────────────────
function initThree() {
  dom.threeContainer.style.display = 'block';
  const rect = dom.threeContainer.getBoundingClientRect();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);
  scene.add(measureRoot);

  camera = new THREE.PerspectiveCamera(60, rect.width / rect.height, 0.05, 60000);
  camera.position.set(0, 260, 320);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  dom.threeContainer.appendChild(renderer.domElement);

  labelRenderer = new CSS2DRenderer({ element: dom.labelsContainer });
  labelRenderer.setSize(rect.width, rect.height);

  clock = new THREE.Clock();
  raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  hoverRaycaster = new THREE.Raycaster();
  hoverRaycaster.firstHitOnly = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 1.35);
  sun.position.set(150, 300, 120);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
  fill.position.set(-120, 180, -150);
  scene.add(fill);

  // GLB frame: rotate Z-up -> Y-up, then center offset
  glbParent = new THREE.Group();
  glbParent.rotation.x = -Math.PI / 2;
  glbOffset = new THREE.Group();
  glbOffset.position.set(-C.x, -C.y, -C.z);
  glbParent.add(glbOffset);
  glbParent.visible = false;
  scene.add(glbParent);

  // 3D Tiles frame: renderer already applied its own up-axis correction;
  // content lands in (x, -z, y). A pi X-rotation + offset aligns with GLB world.
  tilesParent = new THREE.Group();
  tilesParent.rotation.x = Math.PI;
  tilesParent.position.set(-C.x, -C.z, C.y);
  scene.add(tilesParent);

  // Direct (LAZ/PLY) point cloud fallback shares the GLB frame (same WebODM
  // local coordinate system) but is an independent group so it can be
  // shown/hidden without affecting mesh visibility.
  pointCloudParent = new THREE.Group();
  pointCloudParent.rotation.x = -Math.PI / 2;
  pointCloudOffset = new THREE.Group();
  pointCloudOffset.position.set(-C.x, -C.y, -C.z);
  pointCloudParent.add(pointCloudOffset);
  pointCloudParent.visible = false;
  scene.add(pointCloudParent);

  // Cameras share the GLB frame
  camGroupParent = new THREE.Group();
  camGroupParent.rotation.x = -Math.PI / 2;
  const camOffset = new THREE.Group();
  camOffset.name = 'camOffset';
  camOffset.position.set(-C.x, -C.y, -C.z);
  camGroupParent.add(camOffset);
  camGroupParent.visible = false;
  scene.add(camGroupParent);

  controls = new EarthLikeControls(camera, renderer.domElement, {
    surfacePick: pickSurface,
    minPolar: 0.04,
    maxPolar: Math.PI - 0.03,      // full range: orbit under the model like WebODM
    fallbackPlaneY: 18,            // ~avg terrain height in world frame
    minDistance: closeZoomDistanceForDiameter(1000, { cameraNear: camera.near }),
    maxDistance: 6000
  });
  scene.add(controls.pivotIndicator);

  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('dblclick', onDoubleClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);
}

function onResize() {
  const rect = dom.threeContainer.getBoundingClientRect();
  if (rect.width > 0) {
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(rect.width, rect.height);
    labelRenderer.setSize(rect.width, rect.height);
    refreshLodResolution(tilesRenderer, camera, renderer);
  }
  if (map) setTimeout(() => map.invalidateSize(), 80);
  layoutPhotoViewer();
}

// Raycast pick against the active Model or direct point-cloud content.
function pickSurface(ndc) {
  if (state.activeMode === 'cloud' && state.cloudMode === 'direct') {
    if (!pointCloudParent?.visible || !pointCloudObject) return null;
    const viewportHeight = renderer.domElement.clientHeight || renderer.domElement.getBoundingClientRect().height;
    return pickDirectPointSurface({ raycaster, camera, points: pointCloudObject, ndc, viewportHeight });
  }
  raycaster.setFromCamera(ndc, camera);
  const targets = [];
  if (tilesParent.visible && tilesRenderer) targets.push(tilesRenderer.group);
  if (glbParent.visible) targets.push(glbOffset);
  if (!targets.length) return null;
  const hits = raycaster.intersectObjects(targets, true);
  return hits.length ? hits[0].point : null;
}

// ───────────────────────────────────────────────────────────────
// 3D Tiles (default LOD mesh — streams low-res far, full-res close)
// ───────────────────────────────────────────────────────────────
function loadTiles() {
  if (tilesRenderer) return;
  lodBootstrapPhase = 'root';
  lodBootstrapRootTarget = lodBootstrapRootErrorTarget();
  lodBootstrapCoverageTarget = 1024;
  lodErrorScale = 1;
  lodPrefetchStartedAt = 0;
  lodPrefetchElapsedMs = null;
  lodPrefetchReadyFrames = 0;
  lodPrefetchExitReason = null;
  lodPrefetchSoftBudgetReported = false;
  lodOverviewTiles = [];
  lodRecentFrontier = new Map();
  lodBranchBlockers = new Set();
  lodStarvationSamples = 0;
  lodPressureClearSamples = 0;
  clearLodPendingAdmission();
  lodStarvedAtDetail = null;
  lodCacheRecoveryActive = false;
  lodLastSettledDetail = null;
  lodPressureView = null;
  lodTileRecoveryPending = false;
  lodTileRetryAttempt = 0;
  lodTileLastFailureAt = 0;
  if (lodTileRetryTimer) clearTimeout(lodTileRetryTimer);
  lodTileRetryTimer = null;
  updateLoading('Streaming LOD tiles...', '');
  const rendererInstance = new TilesRenderer(TILES_URL);
  if (VIEW_MODE === 'session') {
    rendererInstance.fetchData = createRenewedTileFetcher(
      rendererInstance.fetchData.bind(rendererInstance), () => sessionAccessGeneration,
    );
  }
  rendererInstance.__ltdsDistanceDemand = LOD_EVALUATION.distanceDemand ? { enabled: true } : null;
  const evaluationNote = document.getElementById('lod-evaluation-note');
  if (evaluationNote) evaluationNote.hidden = !LOD_EVALUATION.distanceDemand;
  tilesRenderer = rendererInstance;
  lodResources = installLodResourceLifecycle(rendererInstance);
  lodLoadingTiming?.dispose();
  lodLoadingTiming = LOD_EVALUATION.loadingTiming
    ? installLodLoadingTiming(rendererInstance, { enabled: true, capacity: 256 }) : null;
  lodKtx2Support = installLodKtx2Support(rendererInstance, renderer, {
    workerObserver: lodLoadingTiming?.workerObserver,
  });
  const detailSlider = document.getElementById('lod-detail');
  lodOwnerDebug?.dispose();
  lodOwnerDebug = createLodOwnerDiagnostics(rendererInstance, {
    camera,
    retentionProvider: () => ({ overview: new Set(lodOverviewTiles), recent: lodRecentFrontier }),
  });
  const currentDetail = Number.parseInt(detailSlider?.value, 10);
  if (detailSlider && (!Number.isFinite(currentDetail)
    || currentDetail < Number(detailSlider.min)
    || currentDetail > Number(detailSlider.max))) {
    detailSlider.value = String(MAX_LOD_DETAIL);
  }
  // deviceMemory is a coarse browser capability hint, not system or GPU RAM.
  // Leave it unknown when the browser does not provide it; Auto then uses the
  // safe Balanced profile instead of guessing from user-agent strings.
  const deviceMemoryGiB = navigator.deviceMemory;
  const memoryProfile = resolveLodMemoryProfile({
    mode: lodMemoryMode,
    deviceMemoryGiB,
  });
  lodRuntimeProfileState = configureLodRenderer(rendererInstance, {
    camera,
    renderer,
    detail: detailSlider?.value ?? MAX_LOD_DETAIL,
    deviceMemoryGiB,
    memoryProfile,
    interactionStateProvider: () => controls?.getInteractionState?.() || null,
  });
  lodRuntimeProfileState.peripheralPressureScale = 1;
  lodAdmissionThrottle?.dispose();
  lodAdmissionThrottle = installLodAdmissionThrottle(rendererInstance);
  lodLoadingBudget?.dispose();
  lodLoadingBudget = installLodLoadingBudget(rendererInstance);
  lodRegionalFallback?.dispose();
  lodRegionalFallback = createLodRegionalFallbackCoordinator(rendererInstance);
  if (restoreLodOverviewRetention) restoreLodOverviewRetention();
  restoreLodOverviewRetention = installLodOverviewRetention(
    rendererInstance,
    () => (tilesRenderer === rendererInstance ? retainedLodTiles() : []),
  );
  rendererInstance.errorTarget = lodBootstrapRootTarget;
  rendererInstance.maxDepth = LOD_PREFETCH_MAX_DEPTH;
  state.lodRuntimeProfile = {
    ...lodRuntimeProfileState,
    deviceMemoryGiB,
    starvedAtDetail: null,
    bootstrapPhase: lodBootstrapPhase,
    errorScale: lodErrorScale,
  };
  lodWarmupComplete = false;
  state.lodRootBackdrop = null;
  dom.lodStatus.textContent = 'LOD: loading complete overview';
  emitLodDebugSnapshot('startup', true);
  lodFailureHandled = false;

  rendererInstance.addEventListener('load-root-tileset', (ev) => {
    if (tilesRenderer !== rendererInstance) return;
    const report = inspectLodTileset(ev.tileset);
    const provenance = inspectLodProvenance(LOD_PROVENANCE, GLB_URL || OBJ_URL, {
      serverVerified: LOD_PROVENANCE_VERIFIED,
    });
    state.lodManifestReport = { ...report, provenance };
    const decision = decideLodStartup(report, provenance, Boolean(GLB_URL || OBJ_URL));
    if (decision.action !== 'stream-lod') {
      failLod(decision.reason);
      return;
    }
    if (rendererInstance.root?.internal?.hasRenderableContent) {
      rendererInstance.requestTileContents(rendererInstance.root);
    } else {
      // External/delegating roots have no single renderable overview. Preserve
      // direct camera-driven traversal instead of blocking on a root scene
      // that can never exist. This path bypasses finishLodPrefetch, so it must
      // also release the bootstrap depth cap; leaving it at two permanently
      // prevents a delegated hierarchy from reaching its detailed content.
      lodBootstrapPhase = 'complete';
      lodWarmupComplete = lodRuntimeProfileState.reduced;
      rendererInstance.maxDepth = Infinity;
      rendererInstance.errorTarget = detailToErrorTarget(lodRuntimeProfileState.activeDetail);
      state.lodRuntimeProfile = {
        ...state.lodRuntimeProfile,
        ...lodRuntimeProfileState,
        bootstrapPhase: lodBootstrapPhase,
        errorScale: lodErrorScale,
      };
    }
    if (!report.canConvergeToZeroError) {
      console.warn('LOD root delegates to external tilesets; validate each child manifest.', report);
    }
    const bounds = tilesetWorldBounds(rendererInstance);
    if (bounds && frameBoundsHome(bounds, { apply: !preserveIncomingModelView })) {
      preserveIncomingModelView = false;
    }
    emitLodDebugSnapshot('root-ready', true);
  });
  rendererInstance.addEventListener('load-tileset', (ev) => {
    if (tilesRenderer !== rendererInstance) return;
    const report = inspectLodTileset(ev.tileset);
    if (!report.valid) {
      failLod(`LOD child manifest cannot reach a valid full-detail frontier: ${report.errors[0]}`);
    }
  });
  rendererInstance.addEventListener('tile-memory-pressure', (event) => {
    // The exact-pinned renderer emits this synchronously before it discards a
    // completed foreground parse. Evict one stale, non-active ancestor while
    // the newly parsed tile can still be admitted.
    if (tilesRenderer !== rendererInstance || !lodRuntimeProfileState) return;
    const incomingBytes = Math.max(0, Number(event?.bytesUsed) || 0);
    // Direct synchronous recovery bypasses the scheduleUnload wrapper that
    // normally pins both the bounded REPLACE shell and the recently refined
    // focal frontier. Pin them explicitly before evicting stale detail, or
    // recovery can discard either layer and replace a sharp stable view with a
    // coarse tile (or deadlock trying to reload the missing shell).
    retainLodOverviewTiles(rendererInstance, retainedLodTiles());
    if (recoverLodCacheAdmission(
      rendererInstance.lruCache,
      lodRuntimeProfileState.budget,
      incomingBytes,
    )) {
      lodCacheRecoveryActive = true;
    }
    const cachedBytes = Math.max(0, Number(rendererInstance.lruCache?.cachedBytes) || 0);
    const hardBytes = Number(rendererInstance.lruCache?.maxBytesSize);
    if (incomingBytes > 0 && Number.isFinite(hardBytes)
      && cachedBytes + incomingBytes > hardBytes) {
      // The renderer is about to discard this parsed tile even though the
      // current cache may sit just below its hard cap. Preserve that exact
      // prospective refusal so the idle-pressure coordinator cannot mistake
      // it for ordinary headroom.
      lodPendingAdmissionTile = event?.tile || null;
      lodPendingAdmissionBytes = incomingBytes;
    } else if (lodPendingAdmissionTile === event?.tile) {
      clearLodPendingAdmission();
    }
  });
  rendererInstance.addEventListener('load-model', (ev) => {
    if (tilesRenderer !== rendererInstance) return;
    if (lodPendingAdmissionTile === ev.tile) clearLodPendingAdmission();
    // External tilesets often produce a usable child before their wrapper root.
    // Enter the viewer as soon as any streamed model can be displayed.
    hideLoading();
  });
  rendererInstance.addEventListener('load-error', (ev) => {
    if (tilesRenderer !== rendererInstance) return;
    const failure = classifyTileLoadFailure(ev);
    const failureAt = Date.now();
    if (failureAt - lodTileLastFailureAt > 60_000) lodTileRetryAttempt = 0;
    lodTileLastFailureAt = failureAt;
    console.error('[LTDS LOD] tile load failed; run window.__ltds.lodDiagnostics()', {
      status: failure.status,
      kind: failure.kind,
    });
    emitLodDebugSnapshot('load-error', true);
    if (failure.kind === 'authorization' && VIEW_MODE === 'session') {
      recordSessionAccessFailure('tile', failure.status);
      lodTileRecoveryPending = true;
      // Expired capability URLs fail concurrently. Once one failure has
      // started renewal, every other 401/403 must keep the fallback renderer
      // alive instead of interpreting the coalesced request as a failure.
      if (!sessionRenewalPending) requestSessionRenewal('tile-authorization');
      // Repeated denials may arrive after renewal has been blocked. Report the
      // actual controller state, never a renewal that was not started.
      dom.lodStatus.textContent = sessionAccessLabel()
        || 'LOD: access unavailable — reopen this model from the Viewer workspace';
      // Preserve resident geometry while the access status explains recovery.
      return;
    }
    if (failure.kind === 'transient') {
      lodTileRecoveryPending = true;
      scheduleLodTileRetry(rendererInstance);
      return;
    }
    failLod('A required LOD tile failed to load.');
  });
  tilesParent.add(rendererInstance.group);
}

// Free up to 3 GiB of decoded tile textures/geometry. Needed before a large
// Draco decode: cache + decode together OOM'd the renderer (heap hit 2.7GB).
function disposeTiles() {
  lodLoadingTiming?.dispose();
  lodLoadingTiming = null;
  lodRegionalFallback?.dispose();
  lodRegionalFallback = null;
  lodLoadingBudget?.dispose();
  lodLoadingBudget = null;
  lodAdmissionThrottle?.dispose();
  lodAdmissionThrottle = null;
  lodOwnerDebug?.dispose();
  lodOwnerDebug = null;
  for (const tile of lodBranchBlockers) tile.__ltdsBranchBlocker = false;
  lodBranchBlockers = new Set();
  lodBootstrapPhase = 'inactive';
  lodBootstrapRootTarget = 4096;
  lodBootstrapCoverageTarget = 1024;
  lodErrorScale = 1;
  lodPrefetchStartedAt = 0;
  lodPrefetchElapsedMs = null;
  lodPrefetchReadyFrames = 0;
  lodPrefetchExitReason = null;
  lodPrefetchSoftBudgetReported = false;
  lodOverviewTiles = [];
  lodRecentFrontier = new Map();
  lodStarvationSamples = 0;
  lodPressureClearSamples = 0;
  clearLodPendingAdmission();
  lodStarvedAtDetail = null;
  lodCacheRecoveryActive = false;
  lodLastSettledDetail = null;
  lodPressureView = null;
  lodTileRecoveryPending = false;
  lodTileRetryAttempt = 0;
  lodTileLastFailureAt = 0;
  if (lodTileRetryTimer) clearTimeout(lodTileRetryTimer);
  lodTileRetryTimer = null;
  if (restoreLodOverviewRetention) restoreLodOverviewRetention();
  restoreLodOverviewRetention = null;
  if (!tilesRenderer) {
    lodResources?.dispose();
    lodResources = null;
    lodKtx2Support?.dispose();
    lodKtx2Support = null;
    return;
  }
  tilesParent.remove(tilesRenderer.group);
  try {
    tilesRenderer.dispose();
  } finally {
    lodResources?.dispose();
    lodResources = null;
    lodKtx2Support?.dispose();
    lodKtx2Support = null;
  }
  tilesRenderer = null;
  lodRuntimeProfileState = null;
  lodWarmupComplete = false;
  lodDebugSignature = '';
  lodQualitySignature = '';
  lodQualityStableFrames = 0;
  lodLastQualityFrame = -1;
  lodLastQualityUpdateAt = 0;
  lodLastInteractionSequence = 0;
  lodTraceEntries = [];
  state.lodRuntimeProfile = null;
  state.lodRootBackdrop = null;
}

function scheduleLodTileRetry(rendererInstance) {
  if (tilesRenderer !== rendererInstance || lodTileRetryTimer) return;
  if (lodTileRetryAttempt >= 4) {
    failLod('A required LOD tile repeatedly failed to load.');
    return;
  }
  const delay = [500, 1_500, 4_000, 10_000][lodTileRetryAttempt++];
  dom.lodStatus.textContent = `LOD: retrying tile (${lodTileRetryAttempt}/4)`;
  lodTileRetryTimer = setTimeout(() => {
    lodTileRetryTimer = null;
    if (tilesRenderer !== rendererInstance) return;
    lodTileRecoveryPending = false;
    releaseFailedTileReservations(rendererInstance);
    rendererInstance.resetFailedTiles();
  }, delay);
}

function recoverFailedLodTiles() {
  if (!lodTileRecoveryPending || !tilesRenderer) return;
  lodTileRecoveryPending = false;
  lodTileRetryAttempt = 0;
  if (lodTileRetryTimer) clearTimeout(lodTileRetryTimer);
  lodTileRetryTimer = null;
  releaseFailedTileReservations(tilesRenderer);
  tilesRenderer.resetFailedTiles();
  dom.lodStatus.textContent = 'LOD: access renewed';
}

let sessionRenewalTimer = null;
let sessionAccessExpiryTimer = null;
let sessionRenewalResponseTimer = null;
let activeViewerSession = null;
let sessionAccessGeneration = 0;
let sessionRenewalPending = false;
let sessionRenewalAttempt = null;
let sessionRenewalBackoffIndex = 0;
let sessionRenewalMinimumDelayMs = 1_000;
const SESSION_RENEWAL_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000];
let sessionAllowedOrigins = [];
let sessionAccessState = 'active';
let sessionAccessReason = null;
let lastSessionAccessFailure = null;
let sessionRenewalBlocked = false;
const reviewControllerCandidate = new URLSearchParams(location.hash.replace(/^#/, '')).get('reviewController');
const REVIEW_CONTROLLER_ID = window.parent === window && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reviewControllerCandidate || '')
  ? reviewControllerCandidate : null;
const reviewSessionChannel = REVIEW_CONTROLLER_ID && typeof BroadcastChannel === 'function'
  ? new BroadcastChannel(`ltds-viewer-review:${REVIEW_CONTROLLER_ID}`) : null;
const measurementAdminClient = createMeasurementAdminClient({
  context: () => ({ modelId: PROJECT?.id, modelVersionId: PROJECT?.activeVersion?.id }),
  token: () => VIEW_MODE === 'session' && sessionStorageKey ? sessionStorage.getItem(sessionStorageKey) : null,
  // Administrative requests use only the registered workspace channel, never
  // an arbitrary embedding parent. The privileged bearer stays in workspace.
  send: message => { if (!reviewSessionChannel) return false; reviewSessionChannel.postMessage(message); return true; },
});
let pendingReviewRenewalRequestId = null;
const LOD_AVAILABILITY_REFRESH_MS = 5000;
let lodAvailabilityTimer = null;
let lodAvailabilityRefreshInFlight = false;

async function redeemViewerGrant(grant, { signal } = {}) {
  const accessToken = sessionStorageKey ? sessionStorage.getItem(sessionStorageKey) : null;
  const res = await fetch('/api/v1/sessions/redeem', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ grant }),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

async function currentViewerSession() {
  const accessToken = sessionStorageKey ? sessionStorage.getItem(sessionStorageKey) : null;
  const res = await fetch('/api/v1/sessions/current', {
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

function stopLodAvailabilityRefresh() {
  if (lodAvailabilityTimer) clearTimeout(lodAvailabilityTimer);
  lodAvailabilityTimer = null;
}

function scheduleLodAvailabilityRefresh(delay = LOD_AVAILABILITY_REFRESH_MS) {
  if (VIEW_MODE !== 'session' || state.meshSource !== 'lod-required'
    || lodAvailabilityTimer || lodAvailabilityRefreshInFlight) return;
  lodAvailabilityTimer = setTimeout(refreshLodAvailability, delay);
}

async function refreshLodAvailability() {
  lodAvailabilityTimer = null;
  if (VIEW_MODE !== 'session' || state.meshSource !== 'lod-required'
    || lodAvailabilityRefreshInFlight) return;
  lodAvailabilityRefreshInFlight = true;
  let retry = true;
  try {
    const session = await currentViewerSession();
    if (!PROJECT || session.model.id !== PROJECT.id) return;
    const previousMeshSource = state.meshSource;
    applyViewerSession(session);
    if (previousMeshSource === 'lod-required' && state.meshSource === 'tiles') {
      const available = applyAvailability();
      if (!state.activeMode) {
        const mode = chooseViewerMode(viewerModeFromUrl(location.href), available);
        if (mode) switchMode(mode, { historyMode: 'replace', force: true, reason: 'startup' });
      }
    }
  } catch (error) {
    // Session renewal/revocation has its own controller flow. Availability
    // checks stay quiet and retry while the currently displayed session lives.
    console.warn('LOD availability refresh failed', error?.status || error?.name || 'request_failed');
    retry = error?.status !== 401 && error?.status !== 404;
  } finally {
    lodAvailabilityRefreshInFlight = false;
    if (retry && state.meshSource === 'lod-required') scheduleLodAvailabilityRefresh();
  }
}

function sessionControlWindow() {
  if (window.parent !== window) return window.parent;
  return null;
}

function sessionControllerOrigins() {
  const controller = sessionControlWindow();
  if (!controller) return [];
  return sessionAllowedOrigins;
}

function postToAllowedController(message) {
  if (reviewSessionChannel) {
    try {
      reviewSessionChannel.postMessage(message);
      return true;
    } catch { return false; }
  }
  const controller = sessionControlWindow();
  if (!controller) return false;
  const origins = sessionControllerOrigins();
  for (const origin of origins) controller.postMessage(message, origin);
  return origins.length > 0;
}

function sessionAccessLabel(prefix = 'LOD') {
  if (VIEW_MODE !== 'session' || sessionAccessState === 'active') return null;
  if (sessionAccessState === 'renewing') return `${prefix}: renewing access`;
  if (sessionAccessState === 'retrying') return `${prefix}: retrying access renewal`;
  return `${prefix}: access unavailable — reopen this model from the Viewer workspace`;
}

const measurementDraftRecovery=createMeasurementDraftRecovery();
function setSessionAccessState(next, reason = null) {
  const previous = sessionAccessState;
  if(next==='unavailable')measurementDraftRecovery.capture(reason,activeViewerSession,measurementWorkspace);
  sessionAccessState = next;
  sessionAccessReason = reason;
  if(next==='unavailable')measurementWorkspace?.invalidate?.('Personal measurements are hidden until access is restored.',{notify:false});
  else if(next==='active'&&measurementWorkspace&&(previous==='unavailable'||measurementWorkspace.isInvalidated?.())){
    installMeasurementWorkspace();
  }
  if(next==='active'&&measurementWorkspace&&measurementDraftRecovery.hasPending()){
    const workspace=measurementWorkspace;
    void measurementDraftRecovery.restore(activeViewerSession,workspace).then(restored=>{if(!restored&&workspace===measurementWorkspace&&sessionAccessState==='active')workspace.showRecoveryNotice?.(measurementDraftRecovery.hasPending());});
  }
  const label = sessionAccessLabel();
  if (label && tilesRenderer) dom.lodStatus.textContent = label;
  if (label && state.activeMode === 'cloud') dom.cloudStatus.textContent = sessionAccessLabel('Cloud');
  else if (next === 'active' && previous !== 'active' && state.activeMode === 'cloud') dom.cloudStatus.textContent = 'Cloud: access renewed';
}

function recordSessionAccessFailure(source, status = null) {
  // Bounded, credential-free attribution for failures reported after a mode
  // switch. Do not include asset URLs, model/session IDs, or capabilities.
  lastSessionAccessFailure = {
    source,
    mode: state.activeMode,
    status: status === 401 || status === 403 ? status : null,
    modeEpoch,
    accessGeneration: sessionAccessGeneration,
    expiresInSeconds: activeViewerSession ? Math.round((Date.parse(activeViewerSession.expiresAt) - Date.now()) / 1000) : null,
    renewalPending: sessionRenewalPending,
    renewalBlocked: sessionRenewalBlocked,
  };
}

function sessionDiagnostics() {
  return {
    mode: activeViewerSession?.sessionMode || null,
    access: sessionAccessState,
    reason: sessionAccessReason,
    expiresInSeconds: activeViewerSession ? Math.round((Date.parse(activeViewerSession.expiresAt) - Date.now()) / 1000) : null,
    controller: reviewSessionChannel ? 'isolated' : sessionControlWindow() ? 'embedded' : 'none',
    renewalPending: sessionRenewalPending,
    renewalBlocked: sessionRenewalBlocked,
    tileRecoveryPending: lodTileRecoveryPending,
    lastFailure: lastSessionAccessFailure ? { ...lastSessionAccessFailure } : null,
  };
}

function requestSessionRenewal(reason = 'timer') {
  if (VIEW_MODE !== 'session' || !activeViewerSession || sessionRenewalPending || sessionRenewalBlocked) return false;
  // The controller intentionally refuses early renewals. A denial using current,
  // non-expiring access requires reopening authorization, not a silent timeout.
  if ((reason.endsWith('-authorization') || reason === 'measurements') && Date.parse(activeViewerSession.expiresAt) - Date.now() > 5 * 60 * 1000) {
    sessionRenewalBlocked = true;
    setSessionAccessState('unavailable', 'authorization-required');
    pcApi()?.accessUnavailable?.();
    return false;
  }
  const requestId = reviewSessionChannel ? crypto.randomUUID() : null;
  const sent = postToAllowedController({
    version: 1,
    type: 'ltds-viewer:session-expiring',
    ...(requestId ? { requestId } : {}),
    modelId: activeViewerSession.model.id,
    expiresAt: activeViewerSession.expiresAt,
  });
  if (!sent) {
    retrySessionAccess('controller-unavailable');
    return false;
  }
  setSessionAccessState('renewing');
  const attempt = { requestId, abortController: null };
  sessionRenewalAttempt = attempt;
  pendingReviewRenewalRequestId = requestId;
  sessionRenewalPending = true;
  if (sessionRenewalResponseTimer) clearTimeout(sessionRenewalResponseTimer);
  sessionRenewalResponseTimer = setTimeout(() => {
    if (sessionRenewalAttempt !== attempt) return;
    attempt.abortController?.abort();
    postSessionRenewalFailure(requestId, true);
    clearSessionRenewalPending(attempt);
    sessionRenewalResponseTimer = null;
    retrySessionAccess('controller-timeout');
  }, 30_000);
  return true;
}

function retrySessionAccess(reason) {
  // Controller transport is not an access decision. Keep a still-valid,
  // same-scope capability usable while retrying; expiry has its own timer.
  scheduleSessionRenewalRetry(reason);
  const valid = Date.parse(activeViewerSession?.expiresAt || '') > Date.now();
  setSessionAccessState(valid ? 'retrying' : 'unavailable', reason);
  if (!valid) pcApi()?.accessUnavailable?.();
}

function measurementAccessLost() {
  if (VIEW_MODE === 'session' && !sessionRenewalBlocked) requestSessionRenewal('measurements');
}

function clearSessionRenewalPending(attempt = sessionRenewalAttempt) {
  if (attempt && sessionRenewalAttempt !== attempt) return false;
  if (sessionRenewalResponseTimer) clearTimeout(sessionRenewalResponseTimer);
  sessionRenewalResponseTimer = null;
  sessionRenewalPending = false;
  sessionRenewalAttempt = null;
  pendingReviewRenewalRequestId = null;
  return true;
}

function nextSessionRenewalBackoff() {
  const delay = SESSION_RENEWAL_BACKOFF_MS[Math.min(sessionRenewalBackoffIndex, SESSION_RENEWAL_BACKOFF_MS.length - 1)];
  sessionRenewalBackoffIndex = Math.min(sessionRenewalBackoffIndex + 1, SESSION_RENEWAL_BACKOFF_MS.length - 1);
  sessionRenewalMinimumDelayMs = delay;
  return delay;
}

function scheduleSessionRenewalRetry(reason) {
  if (sessionRenewalTimer) clearTimeout(sessionRenewalTimer);
  const delay = nextSessionRenewalBackoff();
  sessionRenewalTimer = setTimeout(() => requestSessionRenewal(reason), delay);
}

function postSessionRenewalFailure(requestId, retryable, error = '') {
  postToAllowedController({
    version: 1,
    type: 'ltds-viewer:session-renewal-failed',
    ...(requestId ? { requestId } : {}),
    modelId: PROJECT && PROJECT.id,
    retryable,
    ...(!requestId ? { error } : {}),
  });
}

function requestSessionRenewalIfDue(reason) {
  if (!activeViewerSession) return;
  if (Date.parse(activeViewerSession.expiresAt) - Date.now() <= 5 * 60 * 1000) requestSessionRenewal(reason);
}

function scheduleSessionRenewal(session) {
  activeViewerSession = session;
  if (sessionAccessExpiryTimer) clearTimeout(sessionAccessExpiryTimer);
  sessionAccessExpiryTimer = setTimeout(() => {
    if (activeViewerSession !== session) return;
    setSessionAccessState('unavailable', 'session-expired');
    pcApi()?.accessUnavailable?.();
  }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
  if (sessionRenewalTimer) clearTimeout(sessionRenewalTimer);
  const delay = Math.max(sessionRenewalMinimumDelayMs, Date.parse(session.expiresAt) - Date.now() - 5 * 60 * 1000);
  sessionRenewalTimer = setTimeout(() => requestSessionRenewal('timer'), delay);
}

function applyViewerSession(session, { initialize = false } = {}) {
  const previousTilesUrl = TILES_URL;
  setDisplayUnits(session.displayUnits);
  if (session.sessionId) sessionStorageKey = `${SESSION_STORAGE_PREFIX}${session.sessionId}`;
  if (session.accessToken && sessionStorageKey) sessionStorage.setItem(sessionStorageKey, session.accessToken);
  sessionAllowedOrigins = Array.isArray(session.allowedEmbedOrigins) ? session.allowedEmbedOrigins : [];
  SHARE_PERMISSIONS = session.permissions || { measure: true, cameras: true };
  if (initialize) {
    sessionRenewalBackoffIndex = 0;
    sessionRenewalMinimumDelayMs = 1_000;
    PROJECT = session.model;
    applyProjectConfig(PROJECT);
    init();
    postToAllowedController({
      version: 1,
      type: 'ltds-viewer:ready',
      modelId: session.model.id,
      expiresAt: session.expiresAt,
    });
  } else if (PROJECT && session.model.id === PROJECT.id) {
    // Refresh the credential-bearing asset roots without disturbing camera,
    // visibility, measurements, or already-loaded render resources.
    PROJECT = session.model;
    applyProjectConfig(PROJECT);
    if (tilesRenderer && previousTilesUrl && TILES_URL !== previousTilesUrl) {
      preserveIncomingModelView = true;
      disposeTiles();
      loadTiles();
    }
  }
  if (state.meshSource === 'lod-required') scheduleLodAvailabilityRefresh();
  else stopLodAvailabilityRefresh();
  scheduleSessionRenewal(session);
  sessionRenewalBlocked = false;
  setSessionAccessState('active');
  recoverFailedLodTiles();
  pcApi()?.renewAccess?.(EPT_URL);
  viewerProductDownloads?.refresh();
}

async function bootstrapSession() {
  updateLoading('Starting secure viewer session...', '');
  try {
    const session = SESSION_GRANT
      ? await redeemViewerGrant(SESSION_GRANT)
      : await currentViewerSession();
    if (SESSION_GRANT) {
      const activeUrl = new URL(location.href);
      activeUrl.pathname = `/session/active/${encodeURIComponent(session.sessionId)}`;
      history.replaceState(null, '', `${activeUrl.pathname}${activeUrl.search}${activeUrl.hash}`);
    }
    applyViewerSession(session, { initialize: true });
  } catch (error) {
    if (sessionStorageKey) sessionStorage.removeItem(sessionStorageKey);
    updateLoading('Viewer session unavailable', String(error.message || error));
  }
}

async function handleSessionRenewalMessage(data, { reviewChannel = false } = {}) {
  if (reviewChannel && VIEW_MODE === 'session' && reviewSessionChannel
    && data?.version === 1 && data.type === 'ltds-viewer:controller-ready'
    && data.channelId === REVIEW_CONTROLLER_ID && data.modelId === PROJECT?.id
    && Object.keys(data).sort().join('\n') === ['version','type','channelId','modelId'].sort().join('\n')) {
    // A returning workspace may accelerate the next due request, never grant
    // access, interrupt redemption, or undo an authoritative blocked state.
    if (!sessionRenewalBlocked && !sessionRenewalPending) requestSessionRenewalIfDue('controller-ready');
    return;
  }
  if (reviewChannel && VIEW_MODE === 'session' && data?.version === 1
    && data.type === 'ltds-viewer:session-unavailable'
    && pendingReviewRenewalRequestId && data.requestId === pendingReviewRenewalRequestId
    && data.modelId === PROJECT?.id
    && ['authorization-required', 'scope-changed'].includes(data.reason)
    && Object.keys(data).sort().join('\n') === ['version','type','requestId','modelId','reason'].sort().join('\n')) {
    sessionRenewalAttempt?.abortController?.abort();
    clearSessionRenewalPending();
    sessionRenewalBlocked = true;
    if (sessionRenewalTimer) clearTimeout(sessionRenewalTimer);
    setSessionAccessState('unavailable', data.reason);
    pcApi()?.accessUnavailable?.();
    return;
  }
  if (VIEW_MODE !== 'session' || !data || data.version !== 1 || data.type !== 'ltds-viewer:renew-session') return;
  if (reviewChannel && (!pendingReviewRenewalRequestId || data.requestId !== pendingReviewRenewalRequestId
    || Object.keys(data).sort().join('\n') !== ['version','type','requestId','grant'].sort().join('\n'))) return;
  const grant = data.grant;
  if (typeof grant !== 'string' || !/^[0-9a-f-]{36}$/i.test(grant)) return;
  const requestId = reviewChannel ? pendingReviewRenewalRequestId : null;
  const attempt = sessionRenewalAttempt;
  try {
    const abortController = new AbortController();
    if (attempt) attempt.abortController = abortController;
    const session = await redeemViewerGrant(grant, { signal: abortController.signal });
    if (sessionRenewalAttempt !== attempt) return;
    if (!PROJECT || session.model.id !== PROJECT.id) throw new Error('renewal grant is scoped to a different model');
    if(activeViewerSession&&(session.subject!==activeViewerSession.subject||session.audience!==activeViewerSession.audience||session.model.activeVersion?.id!==activeViewerSession.model.activeVersion?.id))throw Object.assign(new Error('renewal identity or model version changed'),{status:403});
    const advanced = Date.parse(session.expiresAt) > Date.parse(activeViewerSession?.expiresAt || '');
    sessionAccessGeneration += 1;
    clearSessionRenewalPending(attempt);
    if (advanced) {
      sessionRenewalBackoffIndex = 0;
      sessionRenewalMinimumDelayMs = 1_000;
    } else {
      nextSessionRenewalBackoff();
    }
    applyViewerSession(session);
    postToAllowedController({
      version: 1,
      type: 'ltds-viewer:session-renewed',
      ...(requestId ? { requestId } : {}),
      modelId: session.model.id,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    if (sessionRenewalAttempt !== attempt) return;
    const status = Number(error?.status);
    const retryable = error?.name === 'AbortError' || !Number.isFinite(status)
      || status === 408 || status === 410 || status === 425 || status === 429 || status >= 500;
    // Keep the still-live capability and credential-bearing loader URLs.
    // The parent can issue another one-time grant and retry in place.
    postSessionRenewalFailure(requestId, retryable, String(error.message || error));
    clearSessionRenewalPending(attempt);
    if (retryable) retrySessionAccess('redemption-failed');
    else {
      sessionRenewalBlocked = true;
      setSessionAccessState('unavailable', 'redemption-failed');
      pcApi()?.accessUnavailable?.();
    }
  }
}

if (reviewSessionChannel) reviewSessionChannel.onmessage = event => {
  if (measurementAdminClient.handleMessage(event.data)) return;
  void handleSessionRenewalMessage(event.data, { reviewChannel: true });
};
window.addEventListener('pagehide', event => {
  // A persisted page resumes with its existing controller channel.
  if (!event.persisted) { measurementAdminClient.dispose(); reviewSessionChannel?.close(); }
});
window.addEventListener('focus', () => requestSessionRenewalIfDue('focus'));
window.addEventListener('pageshow', () => requestSessionRenewalIfDue('pageshow'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestSessionRenewalIfDue('visibility');
});
window.addEventListener('message', event => {
  const controller = sessionControlWindow();
  if (!controller || event.source !== controller || !sessionControllerOrigins().includes(event.origin)) return;
  void handleSessionRenewalMessage(event.data);
});

function failLod(message) {
  if (lodFailureHandled) return;
  lodFailureHandled = true;
  tilesParent.visible = false;
  disposeTiles();
  showError(`${message} The full-resolution source remains available for authenticated download in Operations, but is never decoded interactively.`);
}

function setHomeView() {
  // model spans roughly x -128..128, z -210..210 world; hover SE at 45deg
  const target = new THREE.Vector3(0, 18, 0);
  const dist = 420;
  homeView = {
    position: new THREE.Vector3(target.x, target.y + dist * 0.72, target.z + dist),
    lookAt: target
  };
}

function resetCamera() {
  if (!homeView) setHomeView();
  controls.setView(homeView.position, homeView.lookAt);
}

function topDownView() {
  const target = new THREE.Vector3(0, 18, 0);
  controls.setView(safeTopViewPosition(target, 542, controls.minPolar), target);
}

// Auto-frame the camera on a freshly loaded object whose bounds aren't known
// ahead of time (the server may not have a pre-computed bbox center for
// OBJ-only imported projects).
function frameBoundsHome(bounds, { apply = true } = {}) {
  const view = homeViewForBounds(bounds);
  if (!view) return false;
  controls.minDistance = closeZoomDistanceForDiameter(view.diameter, { cameraNear: camera.near });
  homeView = { position: view.position, lookAt: view.lookAt };
  if (apply) controls.setView(homeView.position, homeView.lookAt);
  return true;
}

function frameObjectHome(object3D, options) {
  object3D.updateWorldMatrix(true, true);
  return frameBoundsHome(new THREE.Box3().setFromObject(object3D), options);
}

// ────────────────────────────────────────────────
// Camera positions (shots.geojson -> instanced frustums)
// ───────────────────────────────────────────────────────────────
function buildCameraMarkerGeometries() {
  const data = cameraMarkerGeometryData();
  const geometry = (positions) => {
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    result.computeVertexNormals();
    return result;
  };
  return Object.fromEntries(CAMERA_MARKER_COMPONENTS.map((component) => [component, geometry(data[component])]));
}

async function loadCameras() {
  if (state.camerasLoaded || state.camerasLoading || !SHOTS_URL || !SHARE_PERMISSIONS.cameras) return;
  state.camerasLoading = true;
  try {
    const res = await fetch(SHOTS_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const geojson = await res.json();
    camFeatures = normalizeCameraFeatureCollection(geojson, { latLonToProjected: latLonToUtm });
    camWorldPos = null;
    if (!camFeatures.length) {
      state.camerasLoaded = true;
      window.__ltdsCams = 0;
      return;
    }

    const geometries = buildCameraMarkerGeometries();
    const material = () => new THREE.MeshBasicMaterial({
      transparent: true, opacity: CAMERA_MARKER_OPACITY.normal, side: THREE.FrontSide, depthWrite: false,
    });
    camMarkerMeshes = CAMERA_MARKER_COMPONENTS.map((component, index) => {
      const mesh = new THREE.InstancedMesh(geometries[component], material(), camFeatures.length);
      mesh.userData.cameraMarkerComponent = component;
      mesh.frustumCulled = false;
      mesh.renderOrder = index;
      return mesh;
    });

    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3();
    camMarkerLocalPositions = new Float64Array(camFeatures.length * 3);
    camMarkerQuaternions = new Float32Array(camFeatures.length * 4);
    camMarkerDepths = new Float64Array(camFeatures.length);
    camSourceToDraw = new Int32Array(camFeatures.length);
    camSourceToDraw.fill(-1);
    camDrawToSource = [];

    camFeatures.forEach((feat, i) => {
      const t = feat.properties.translation;
      const r = feat.properties.rotation;
      const angle = Math.sqrt(r[0]*r[0] + r[1]*r[1] + r[2]*r[2]);
      if (angle > 1e-9) axis.set(-r[0]/angle, -r[1]/angle, -r[2]/angle);
      else axis.set(0, 0, 1);
      q.setFromAxisAngle(axis, angle);
      camMarkerLocalPositions[i * 3] = t[0] - RTC.e;
      camMarkerLocalPositions[i * 3 + 1] = t[1] - RTC.n;
      camMarkerLocalPositions[i * 3 + 2] = t[2] - RTC.z;
      camMarkerQuaternions[i * 4] = q.x;
      camMarkerQuaternions[i * 4 + 1] = q.y;
      camMarkerQuaternions[i * 4 + 2] = q.z;
      camMarkerQuaternions[i * 4 + 3] = q.w;
    });
    for (const mesh of camMarkerMeshes) {
      mesh.setColorAt(0, new THREE.Color(CAMERA_MARKER_COLORS[mesh.userData.cameraMarkerComponent]));
      mesh.count = 0;
    }
    camGroupParent.getObjectByName('camOffset').add(...camMarkerMeshes);
    refreshCameraMarkerScales(true);
    state.camerasLoaded = true;
    window.__ltdsCams = camFeatures.length;
    syncCameraLayer();
  } catch (err) {
    console.error('Camera shots load failed', err);
  } finally {
    state.camerasLoading = false;
  }
}

function mapCameraGlyph(feature) {
  const scale = cameraMarkerScaleForView({ baseScale: cameraMarkerUserScale });
  const size = Math.round(Math.max(20, Math.min(38, 24 * scale / DEFAULT_CAMERA_MARKER_SCALE)));
  return { size, bearing: cameraFeatureImageUpBearing(feature) };
}

function refreshMapCameraLayer() {
  if (!map) return false;
  const visible = isMapMode() && state.camerasVisible
    && state.camerasLoaded && SHARE_PERMISSIONS.cameras && Boolean(SHOTS_URL);
  if (!visible) {
    if (mapCameraLayer && map.hasLayer(mapCameraLayer)) map.removeLayer(mapCameraLayer);
    window.__ltdsMapCamDrawn = 0;
    window.__ltdsMapCamDrawToSource = [];
    return false;
  }
  if (!mapCameraLayer) mapCameraLayer = createMapCameraOverlay(L, {
    onSelect: source => openPhoto(source),
    isInteractive: () => state.activeTool === 'none',
    onFrame: points => {
      window.__ltdsMapCamDrawn = points.length;
      window.__ltdsMapCamDrawToSource = points.map(point => point.source);
      window.__ltdsMapCamPoints = points;
    },
  });
  // One map-only canvas, stable source records, no photo prefetch or per-pin DOM.
  if (mapCameraFeatures === camFeatures && mapCameraScale === cameraMarkerUserScale) {
    mapCameraLayer.addTo(map);
    return true;
  }
  const records = [];
  for (let index = 0; index < camFeatures.length; index += 1) {
    const position = cameraFeatureMapPosition(camFeatures[index], { projectedToLatLon: utmToLatLon });
    if (!position) continue;
    records.push({ source: index, latlng: L.latLng(position[0], position[1]),
      bearing: mapCameraGlyph(camFeatures[index]).bearing,
      label: camFeatures[index].properties?.photoKey?.split('/').at(-1) || `Photo ${index + 1}` });
  }
  mapCameraLayer.setData(records, mapCameraGlyph(camFeatures[0]).size);
  mapCameraLayer.addTo(map);
  mapCameraFeatures = camFeatures;
  mapCameraScale = cameraMarkerUserScale;
  mapCameraSources = records.map(record => record.source);
  return true;
}

let cameraMarkerUserScale = DEFAULT_CAMERA_MARKER_SCALE;
let cameraMarkerScaleSignature = '';
let cameraMarkerScaleUpdatedAt = 0;
let hoveredCam = -1;
let camWorldPos = null;   // Float64Array of source world positions (lazy)
let camMarkerLocalPositions = null, camMarkerQuaternions = null, camMarkerDepths = null;
let camDrawToSource = [], camSourceToDraw = null;

function setCameraScale(value) {
  cameraMarkerUserScale = cameraMarkerScaleForView({ baseScale: value });
  refreshCameraMarkerScales(true);
  refreshMapCameraLayer();
  pcApi()?.setCameraScale?.(cameraMarkerUserScale);
}

function ensureCamWorldPositions() {
  if (camWorldPos || !camMarkerMeshes.length || !camMarkerLocalPositions) return;
  camMarkerMeshes[0].updateMatrixWorld(true);
  const n = camMarkerLocalPositions.length / 3;
  camWorldPos = new Float64Array(n * 3);
  const mw = camMarkerMeshes[0].matrixWorld.elements;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const ix = camMarkerLocalPositions[o], iy = camMarkerLocalPositions[o + 1], iz = camMarkerLocalPositions[o + 2];
    camWorldPos[i*3]   = mw[0]*ix + mw[4]*iy + mw[8]*iz  + mw[12];
    camWorldPos[i*3+1] = mw[1]*ix + mw[5]*iy + mw[9]*iz  + mw[13];
    camWorldPos[i*3+2] = mw[2]*ix + mw[6]*iy + mw[10]*iz + mw[14];
  }
}

function refreshCameraMarkerScales(force = false) {
  if (camMarkerMeshes.length !== CAMERA_MARKER_COMPONENTS.length || !camera || !renderer) return false;
  const now = performance.now();
  if (!force && now - cameraMarkerScaleUpdatedAt < 100) return false;
  const rect = renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  camera.updateMatrixWorld(true);
  ensureCamWorldPositions();
  if (!camWorldPos) return false;

  const signature = [
    camera.position.x, camera.position.y, camera.position.z,
    camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w,
    camera.fov, camera.zoom, rect.width, rect.height, cameraMarkerUserScale,
  ].map((value) => Number(value).toFixed(3)).join(':');
  cameraMarkerScaleUpdatedAt = now;
  if (!force && signature === cameraMarkerScaleSignature) return false;
  cameraMarkerScaleSignature = signature;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const markerScale = new THREE.Vector3();
  const white = new THREE.Color(0xffffff);
  const componentColors = Object.fromEntries(CAMERA_MARKER_COMPONENTS.map((component) => [component, new THREE.Color(CAMERA_MARKER_COLORS[component])]));
  const candidates = [];
  const pm = camera.projectionMatrix.elements;
  const vm = camera.matrixWorldInverse.elements;
  for (let source = 0; source < camFeatures.length; source += 1) {
    const offset = source * 3;
    const wx = camWorldPos[offset], wy = camWorldPos[offset + 1], wz = camWorldPos[offset + 2];
    const vx = vm[0]*wx + vm[4]*wy + vm[8]*wz + vm[12];
    const vy = vm[1]*wx + vm[5]*wy + vm[9]*wz + vm[13];
    const vz = vm[2]*wx + vm[6]*wy + vm[10]*wz + vm[14];
    const depth = -vz;
    camMarkerDepths[source] = depth;
    const cx = pm[0]*vx + pm[4]*vy + pm[8]*vz + pm[12];
    const cy = pm[1]*vx + pm[5]*vy + pm[9]*vz + pm[13];
    const cw = pm[3]*vx + pm[7]*vy + pm[11]*vz + pm[15];
    if (cw <= 0) continue;
    candidates.push({
      index: source,
      x: (cx / cw * 0.5 + 0.5) * rect.width,
      y: (-cy / cw * 0.5 + 0.5) * rect.height,
      depth,
    });
  }
  const visibleSources = selectCameraMarkerRepresentatives(candidates, { width: rect.width, height: rect.height });
  camDrawToSource = visibleSources;
  camSourceToDraw.fill(-1);
  for (let draw = 0; draw < visibleSources.length; draw += 1) {
    const source = visibleSources[draw];
    camSourceToDraw[source] = draw;
    const positionOffset = source * 3;
    const quaternionOffset = source * 4;
    position.fromArray(camMarkerLocalPositions, positionOffset);
    quaternion.fromArray(camMarkerQuaternions, quaternionOffset);
    const scale = cameraMarkerScaleForView({
      baseScale: cameraMarkerUserScale,
      depth: camMarkerDepths[source],
      fovDegrees: camera.fov,
      zoom: camera.zoom,
      viewportHeight: rect.height,
    });
    markerScale.setScalar(scale);
    matrix.compose(position, quaternion, markerScale);
    const hovered = source === hoveredCam;
    for (const mesh of camMarkerMeshes) {
      const color = componentColors[mesh.userData.cameraMarkerComponent];
      mesh.setMatrixAt(draw, matrix);
      mesh.setColorAt(draw, hovered ? color.clone().lerp(white, 0.25) : color);
    }
  }
  for (const mesh of camMarkerMeshes) {
    mesh.count = visibleSources.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  window.__ltdsCamDrawn = visibleSources.length;
  window.__ltdsCamDrawToSource = visibleSources.slice();
  return true;
}

function pickCameraInstance(ndc) {
  if (!state.camerasVisible || camMarkerMeshes.length !== CAMERA_MARKER_COMPONENTS.length) return -1;
  hoverRaycaster.setFromCamera(ndc, camera);
  const hits = hoverRaycaster.intersectObjects(camMarkerMeshes, false);
  if (hits.length) return camDrawToSource[hits[0].instanceId];

  // Fallback: markers can be a few pixels at default size — pick the nearest
  // instance whose projection is within ~12 px of the cursor.
  ensureCamWorldPositions();
  if (!camWorldPos) return -1;
  const rect = renderer.domElement.getBoundingClientRect();
  const pm = camera.projectionMatrix.elements;
  const vm = camera.matrixWorldInverse.elements;
  const thresholdNdcX = (CAMERA_MARKER_STYLE.pickRadius * 2 / rect.width);
  const thresholdNdcY = (CAMERA_MARKER_STYLE.pickRadius * 2 / rect.height);
  let best = -1, bestD = Infinity;
  for (const i of camDrawToSource) {
    const wx = camWorldPos[i*3], wy = camWorldPos[i*3+1], wz = camWorldPos[i*3+2];
    const vx = vm[0]*wx + vm[4]*wy + vm[8]*wz  + vm[12];
    const vy = vm[1]*wx + vm[5]*wy + vm[9]*wz  + vm[13];
    const vz = vm[2]*wx + vm[6]*wy + vm[10]*wz + vm[14];
    const cx = pm[0]*vx + pm[4]*vy + pm[8]*vz  + pm[12];
    const cy = pm[1]*vx + pm[5]*vy + pm[9]*vz  + pm[13];
    const cw = pm[3]*vx + pm[7]*vy + pm[11]*vz + pm[15];
    if (cw <= 0) continue;
    const dx = (cx / cw - ndc.x) / thresholdNdcX;
    const dy = (cy / cw - ndc.y) / thresholdNdcY;
    const d = dx*dx + dy*dy;
    if (d < 1 && d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function highlightCam(idx) {
  if (camMarkerMeshes.length !== CAMERA_MARKER_COMPONENTS.length) return;
  const white = new THREE.Color(0xffffff);
  const setDrawColors = (source, hovered) => {
    const draw = camSourceToDraw?.[source] ?? -1;
    if (draw < 0) return;
    for (const mesh of camMarkerMeshes) {
      const color = new THREE.Color(CAMERA_MARKER_COLORS[mesh.userData.cameraMarkerComponent]);
      mesh.setColorAt(draw, hovered ? color.clone().lerp(white, 0.25) : color);
    }
  };
  if (hoveredCam >= 0 && hoveredCam !== idx) {
    setDrawColors(hoveredCam, false);
  }
  if (idx >= 0) {
    setDrawColors(idx, true);
  }
  for (const mesh of camMarkerMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  hoveredCam = idx;
}

// Camera photo state. The default docked preview never blocks viewer input;
// the expanded inspector owns zoom/pan and keeps the image covering its frame.
const photoView = {
  scale: 1, tx: 0, ty: 0, dragging: false,
  sx: 0, sy: 0, stx: 0, sty: 0, moved: false,
  naturalWidth: 4, naturalHeight: 3, baseWidth: 0, baseHeight: 0, presentation: 'docked',
};

function photoTransformBounds() {
  return {
    baseWidth: photoView.baseWidth,
    baseHeight: photoView.baseHeight,
    viewportWidth: dom.photoImgwrap.clientWidth,
    viewportHeight: dom.photoImgwrap.clientHeight,
  };
}

function applyPhotoTransform() {
  // Paint the source at its zoomed layout size. Scaling a permanently promoted
  // fit-sized layer can magnify its low-resolution compositor raster instead.
  dom.photoImg.style.width = `${photoView.baseWidth * photoView.scale}px`;
  dom.photoImg.style.height = `${photoView.baseHeight * photoView.scale}px`;
  dom.photoImg.style.transform = `translate(${photoView.tx}px, ${photoView.ty}px)`;
  dom.photoImgwrap.classList.toggle('zoomed', photoView.presentation === 'expanded' && photoView.scale > 1);
}

function clampAndApplyPhotoView(next = photoView) {
  Object.assign(photoView, clampPhotoView(next, photoTransformBounds()));
  applyPhotoTransform();
}

function resetPhotoView() {
  photoView.scale = 1; photoView.tx = 0; photoView.ty = 0;
  applyPhotoTransform();
}

function layoutPhotoViewer() {
  if (dom.photoModal.style.display !== 'flex') return;
  const expanded = photoView.presentation === 'expanded';
  const maxWidth = expanded ? window.innerWidth : Math.min(380, window.innerWidth - 48);
  const maxHeight = expanded
    ? window.innerHeight
    : Math.min(420, Math.max(180, window.innerHeight - (window.innerWidth <= 640 ? 180 : 120)));
  const box = fitPhotoBox({
    naturalWidth: photoView.naturalWidth,
    naturalHeight: photoView.naturalHeight,
    maxWidth,
    maxHeight,
  });
  const frameWidth = Math.min(maxWidth, Math.max(expanded ? 280 : 220, box.width));
  photoView.baseWidth = box.width;
  photoView.baseHeight = box.height;
  dom.photoFrame.style.width = expanded ? '' : `${frameWidth + 22}px`;
  dom.photoImgwrap.style.width = `${expanded ? maxWidth : box.width}px`;
  dom.photoImgwrap.style.height = `${expanded ? maxHeight : box.height}px`;
  dom.photoImgwrap.style.alignSelf = 'center';
  clampAndApplyPhotoView();
}

function setPhotoPresentation(value) {
  photoView.presentation = value === 'expanded' ? 'expanded' : 'docked';
  dom.photoModal.classList.toggle('expanded', photoView.presentation === 'expanded');
  dom.photoModal.classList.toggle('docked', photoView.presentation === 'docked');
  dom.photoModal.dataset.presentation = photoView.presentation;
  dom.photoFrame.setAttribute('aria-modal', String(photoView.presentation === 'expanded'));
  dom.photoImgwrap.setAttribute('aria-label', photoView.presentation === 'docked' ? 'Expand camera photo' : 'Camera photo inspector');
  resetPhotoView();
  layoutPhotoViewer();
}

function openPhoto(idx) {
  const feat = camFeatures[idx];
  if (!feat) return;
  const photoKey = normalizeCameraPhotoKey(feat.properties?.photoKey);
  const fn = photoKey ? photoKey.split('/').at(-1) : '';
  const time = feat.properties.capture_time
    ? new Date(feat.properties.capture_time * 1000).toLocaleString()
    : '';
  dom.photoTitle.textContent = fn || 'Camera photo';
  dom.photoTitle.title = dom.photoTitle.textContent;
  dom.photoMeta.textContent = time;
  dom.photoModal.style.display = 'flex';
  dom.photoModal.setAttribute('aria-hidden', 'false');
  photoView.naturalWidth = 4;
  photoView.naturalHeight = 3;
  setPhotoPresentation('docked');
  dom.photoSpinner.style.display = 'none';
  dom.photoEmpty.style.display = 'none';
  dom.photoImg.style.display = 'none';
  dom.photoImg.style.opacity = '0';
  dom.photoImg.onload = null;
  dom.photoImg.onerror = null;
  dom.photoImg.removeAttribute('src');
  dom.photoDownload.style.display = 'none';
  dom.photoDownload.removeAttribute('href');
  if (!PHOTO_BASE || !photoKey) {
    dom.photoEmpty.textContent = 'No photo available';
    dom.photoEmpty.style.display = 'flex';
    layoutPhotoViewer();
    return;
  }
  const url = `${PHOTO_BASE}/${encodeURIComponent(photoKey)}`;
  dom.photoSpinner.style.display = 'block';
  dom.photoImg.style.display = '';
  dom.photoImg.onload = () => {
    photoView.naturalWidth = dom.photoImg.naturalWidth || 4;
    photoView.naturalHeight = dom.photoImg.naturalHeight || 3;
    resetPhotoView();
    layoutPhotoViewer();
    dom.photoSpinner.style.display = 'none';
    dom.photoImg.style.opacity = '1';
    if (SHARE_PERMISSIONS.download || SHARE_PERMISSIONS.cameraPhotoDownload === true) dom.photoDownload.style.display = '';
  };
  dom.photoImg.onerror = () => {
    dom.photoSpinner.style.display = 'none';
    dom.photoImg.style.display = 'none';
    dom.photoEmpty.textContent = 'No photo available';
    dom.photoEmpty.style.display = 'flex';
    layoutPhotoViewer();
  };
  dom.photoImg.src = url;
  dom.photoDownload.href = url;
  dom.photoDownload.download = fn;
}

function closePhoto() {
  dom.photoModal.style.display = 'none';
  dom.photoModal.classList.remove('docked', 'expanded');
  dom.photoModal.setAttribute('aria-hidden', 'true');
  dom.photoImg.removeAttribute('src');
  dom.photoEmpty.style.display = 'none';
  resetPhotoView();
}

function bindPhotoViewer() {
  const wrap = dom.photoImgwrap;

  wrap.addEventListener('wheel', (event) => {
    if (photoView.presentation !== 'expanded') return;
    event.preventDefault();
    const rect = wrap.getBoundingClientRect();
    Object.assign(photoView, zoomPhotoView(photoView, {
      factor: Math.pow(0.9, event.deltaY / 100),
      cursorX: event.clientX - (rect.left + rect.width / 2),
      cursorY: event.clientY - (rect.top + rect.height / 2),
      ...photoTransformBounds(),
    }));
    applyPhotoTransform();
  }, { passive: false });

  wrap.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || photoView.presentation !== 'expanded' || photoView.scale <= 1) return;
    photoView.dragging = true;
    photoView.moved = false;
    photoView.sx = event.clientX; photoView.sy = event.clientY;
    photoView.stx = photoView.tx; photoView.sty = photoView.ty;
    wrap.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  wrap.addEventListener('pointermove', (event) => {
    if (!photoView.dragging) return;
    const dx = event.clientX - photoView.sx;
    const dy = event.clientY - photoView.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) photoView.moved = true;
    Object.assign(photoView, panPhotoView({ scale: photoView.scale, tx: photoView.stx, ty: photoView.sty }, {
      dx, dy, ...photoTransformBounds(),
    }));
    applyPhotoTransform();
  });
  const stopPhotoDrag = () => { photoView.dragging = false; };
  window.addEventListener('pointerup', stopPhotoDrag);
  window.addEventListener('pointercancel', stopPhotoDrag);
  wrap.addEventListener('click', () => {
    if (photoView.presentation === 'docked' && dom.photoImg.style.display !== 'none') setPhotoPresentation('expanded');
  });
  wrap.addEventListener('keydown', (event) => {
    if (photoView.presentation !== 'docked' || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    setPhotoPresentation('expanded');
  });
  wrap.addEventListener('dblclick', (event) => {
    if (photoView.presentation !== 'expanded') return;
    event.preventDefault();
    resetPhotoView();
  });
}

// ───────────────────────────────────────────────────────────────
// Measurements (labels + escape + persistence)
// ───────────────────────────────────────────────────────────────
const measureRoot = new THREE.Group();

function makeLabel(text, cls = 'mlabel') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  const obj = new CSS2DObject(div);
  obj.center.set(0.5, 1.35);
  return obj;
}

function makeMarker(point) {
  const geo = new THREE.SphereGeometry(1, 20, 20);
  const mat = new THREE.MeshBasicMaterial({ color: 0xEE5007, depthTest: false, transparent: true, opacity: 0.95 });
  const mk = new THREE.Mesh(geo, mat);
  mk.position.copy(point);
  mk.userData.isMarker = true;
  mk.renderOrder = 999;
  return mk;
}

function lineMaterial() {
  return new THREE.LineBasicMaterial({ color: 0xF8CB2E, depthTest: false, transparent: true, opacity: 0.95 });
}

function measurementCoordinateReference() {
  const georef=PROJECT?.georef;
  if(!Number.isFinite(georef?.utmZoneLon0Deg)||!['N','S'].includes(georef?.hemisphere))return {crs:'LOCAL:unverified',verticalUnit:'m'};
  const zone = (georef.utmZoneLon0Deg + 183) / 6;
  if(!Number.isInteger(zone)||zone<1||zone>60||UTM_PROJECTION.zoneLon0Deg!==georef.utmZoneLon0Deg||UTM_PROJECTION.hemisphere!==georef.hemisphere)return {crs:'LOCAL:unverified',verticalUnit:'m'};
  return { crs: `EPSG:${(UTM_PROJECTION.hemisphere === 'S' ? 32700 : 32600) + zone}`, verticalUnit: 'm' };
}

function measurementViewContext() {
  if (!state.activeMode) return null;
  if (isMapMode()) {
    if (!map) return null;
    return {
      mode: state.activeMode, element: dom.leafletMap, host: dom.leafletMap,
      viewSignature() { const center=map.getCenter(),size=map.getSize();return [center.lat,center.lng,map.getZoom(),size.x,size.y].join(':'); },
      pick(event) { const p=map.mouseEventToLatLng(event),xy=latLonToUtm(p.lat,p.lng);return [xy[0],xy[1],0]; },
      project(p) { const ll=utmToLatLon(p[0],p[1]),screen=map.latLngToContainerPoint(ll);return [screen.x,screen.y]; },
      focus(vertices) { map.fitBounds(vertices.map(p=>utmToLatLon(p[0],p[1])),{padding:[45,45],maxZoom:22}); },
      async capture() {
        const rect=dom.leafletMap.getBoundingClientRect(),canvas=document.createElement('canvas');canvas.width=rect.width;canvas.height=rect.height;const ctx=canvas.getContext('2d');ctx.fillStyle='#101010';ctx.fillRect(0,0,canvas.width,canvas.height);
        // The same stacked map tiles the user sees; cross-origin restrictions
        // fail visibly instead of silently omitting a basemap from the export.
        const panes=[...dom.leafletMap.querySelectorAll('.leaflet-pane')].filter(p=>!p.querySelector('.leaflet-pane')).sort((a,b)=>(Number(getComputedStyle(a).zIndex)||0)-(Number(getComputedStyle(b).zIndex)||0));
        for(const pane of panes) for(const tile of pane.querySelectorAll('img,canvas')) {
          const r=tile.getBoundingClientRect();if(!r.width||!r.height||r.right<rect.left||r.left>rect.right||r.bottom<rect.top||r.top>rect.bottom)continue;
          let alpha=1,visible=true;
          for(let parent=tile;parent&&parent!==dom.leafletMap;parent=parent.parentElement){const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'){visible=false;break;}const opacity=Number(style.opacity);if(Number.isFinite(opacity))alpha*=opacity;}
          if(!visible||alpha===0)continue;
          ctx.globalAlpha=alpha;ctx.drawImage(tile,r.left-rect.left,r.top-rect.top,r.width,r.height);
        }
        ctx.globalAlpha=1;
        try{canvas.toDataURL();}catch{throw new Error('The basemap prevents browser image export. Use a browser screenshot including your measurements instead.');}
        return canvas;
      },
    };
  }
  const iframe=document.getElementById('pc-iframe');
  const cloud=state.activeMode==='cloud'&&state.cloudMode==='potree';
  const win=cloud?iframe?.contentWindow:null, viewer=win?.viewer;
  const activeCamera=cloud?viewer?.scene?.getActiveCamera():camera;
  const activeRenderer=cloud?viewer?.renderer:renderer;
  if (!activeCamera||!activeRenderer) return null;
  const element=activeRenderer.domElement,host=cloud?dom.cloudContainer:dom.threeContainer;
  // Creating an adapter must not force iframe layout when there is no visible
  // measurement. The overlay supplies one viewport snapshot per actual draw.
  return {
    mode:state.activeMode,element,host,
    getDisplaySurfaceRevision:measurementDisplaySurfaceRevision,
    resolveRenderedDisplayVertices:resolveRenderedMeasurementVertices,
    viewSignature(){return [...activeCamera.matrixWorldInverse.elements,...activeCamera.projectionMatrix.elements,element.width,element.height].join(':');},
    pick(event) {
      if(!cloud){const p=pickSurface(eventNdc(event));if(!p)return null;const u=worldToUtm(p);return [u.e,u.n,u.alt];}
      const rect=element.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;
      const rc=new win.THREE.Raycaster();rc.setFromCamera(new win.THREE.Vector2(x/rect.width*2-1,1-y/rect.height*2),activeCamera);
      let closest=null,distance=Infinity;
      for(const points of viewer.scene.pointclouds){
        if(points.visible===false||!points.visibleNodes?.length)continue;
        const original=points.material;
        try{const hit=points.pick(viewer,activeCamera,rc.ray,{x,y:rect.height-y,pickWindowSize:5,pickClipped:true});if(hit?.position){const d=hit.position.distanceTo(activeCamera.position);if(d<distance){closest=hit.position;distance=d;}}}
        catch { /* A tile can unload between the input event and point pick. */ }
        finally{points.material=original;viewer.renderer.setRenderTarget(null);viewer.renderer.state.reset();viewer.renderer.setScissorTest(false);if(!win.Potree?.measureTimings){win.performance?.clearMarks?.('pick-start');win.performance?.clearMarks?.('pick-end');win.performance?.clearMeasures?.('pick');}}
      }
      return closest?[closest.x,closest.y,closest.z]:null;
    },
    project(p,viewport){
      const position=cloud?new THREE.Vector3(...p):utmToWorld(...p);
      const clip=new THREE.Vector4(position.x,position.y,position.z,1).applyMatrix4(activeCamera.matrixWorldInverse).applyMatrix4(activeCamera.projectionMatrix).toArray();
      return projectMeasurementBoundary([clip],{width:viewport?.width??element.clientWidth,height:viewport?.height??element.clientHeight}).positions[0];
    },
    projectBoundary(vertices,viewport,{closed=false}={}){
      const clip=vertices.map(p=>{
        const position=cloud?new THREE.Vector3(...p):utmToWorld(...p);
        return new THREE.Vector4(position.x,position.y,position.z,1).applyMatrix4(activeCamera.matrixWorldInverse).applyMatrix4(activeCamera.projectionMatrix).toArray();
      });
      return projectMeasurementBoundary(clip,{width:viewport?.width??element.clientWidth,height:viewport?.height??element.clientHeight},{closed});
    },
    focus(vertices){
      const points=vertices.map(p=>cloud?new THREE.Vector3(...p):utmToWorld(...p));
      const box=new THREE.Box3().setFromPoints(points),center=box.getCenter(new THREE.Vector3()),radius=Math.max(box.getSize(new THREE.Vector3()).length()/2,.25);
      const direction=activeCamera.position.clone().sub(center);if(direction.lengthSq()<1e-8)direction.set(1,1,1);direction.normalize();
      const position=center.clone().addScaledVector(direction,radius/Math.sin((activeCamera.fov||60)*Math.PI/360)*1.3);
      if(cloud)win.__setViewUTM(position.x,position.y,position.z,center.x,center.y,center.z);
      else controls.setView(position,center);
    },
    async capture(){
      if(cloud)viewer.render();else renderer.render(scene,camera);
      const canvas=document.createElement('canvas');canvas.width=element.width;canvas.height=element.height;canvas.getContext('2d').drawImage(element,0,0);return canvas;
    },
  };
}

async function calculateSavedMeasurementSurface(record,{signal,reference={type:'boundary-triangulated'},sourceKind='auto',confirmMeters=false}={}) {
  const source=sourceKind==='dsm'?(DSM_URL?{type:'dsm',url:DSM_URL}:null):sourceKind==='dtm'?(DTM_URL?{type:'dtm',url:DTM_URL}:null):requestedVolumeSurface();
  if(!source)throw new Error('No existing DSM/DTM is available. An administrator must prepare a measurement surface; clients cannot start processing jobs.');
  // Calculation opens metadata only. getDataset also computes display stats,
  // which could decode an entire un-overviewed TIFF before region guards.
  await preflightBrowserRasterHeader(source.url,{signal});
  const tiff=await openGeoTiff(source.url,{allowFullFile:false,blockSize:262144,cacheSize:32},signal);
  try{
  const image=await tiff.getImage(0),[minE,minN,maxE,maxN]=image.getBoundingBox();
  const ds={W:image.getWidth(),H:image.getHeight(),minE,minN,maxE,maxN,nodata:parseFiniteGdalNoData(image.getGDALNoData())},px=(maxE-minE)/ds.W,py=(maxN-minN)/ds.H;
  const geo=image.getGeoKeys?.()||{},expectedCrs=Number(record.coordinateReference.crs.replace('EPSG:',''));
  if(!geo.ProjectedCSTypeGeoKey||geo.ProjectedCSTypeGeoKey!==expectedCrs)throw new Error('The source CRS is absent or incompatible with this measurement. An administrator must verify alignment first.');
  const directory=image.getFileDirectory?.()||image.fileDirectory||{},transform=rasterDirectoryValue(directory,'ModelTransformation'),resolution=image.getResolution();
  if(Number(geo.GTRasterTypeGeoKey||1)!==1||(transform&&[1,2,4,6,8,9,12,13,14].some(i=>transform[i]!==0))||!Number.isFinite(resolution[0])||!Number.isFinite(resolution[1])||resolution[0]<=0||resolution[1]>=0)throw new Error('This raster uses an unsupported rotated or point-sample grid. No approximate transform will be substituted.');
  const decodedBlock=rasterDecodedBlockBytes(image);
  if(!Number.isFinite(decodedBlock)||decodedBlock>64*1024*1024)throw new Error('The source raster has oversized decode blocks for browser measurement. Ask an administrator for a calculation.');
  try{await validateRasterEncodedBlocks(image,{maxBlockBytes:64*1024*1024});}
  catch{throw new Error('The source raster has unsupported or oversized encoded blocks for browser measurement. Ask an administrator to verify the source layout.');}
  const {verticalFactor,verticalUnitBasis}=resolveRasterVerticalUnits(image,{bandMetadata:await readRasterBandMetadata(image),confirmMeters});
  const x0=Math.max(0,Math.floor((Math.min(...record.vertices.map(p=>p[0]))-ds.minE)/px));
  const x1=Math.min(ds.W,Math.ceil((Math.max(...record.vertices.map(p=>p[0]))-ds.minE)/px));
  const y0=Math.max(0,Math.floor((ds.maxN-Math.max(...record.vertices.map(p=>p[1])))/py));
  const y1=Math.min(ds.H,Math.ceil((ds.maxN-Math.min(...record.vertices.map(p=>p[1])))/py));
  const width=x1-x0,height=y1-y0;
  if(width<=0||height<=0)throw new Error('The polygon is outside this elevation surface.');
  if(width*height>1_500_000)throw new Error('This region exceeds the safe browser calculation limit at native resolution. Reduce the selection or ask an administrator to calculate it.');
  const rasters=await image.readRasters({window:[x0,y0,x1,y1],samples:[0],pool:geoPool,signal});
  if(signal?.aborted)throw new DOMException('Calculation cancelled','AbortError');
  const vertices=record.vertices.map(p=>{
    if(record.collection==='spatial3d')return p.slice();
    const x=Math.max(0,Math.min(width-1,Math.floor((p[0]-ds.minE)/px)-x0)),y=Math.max(0,Math.min(height-1,Math.floor((ds.maxN-p[1])/py)-y0));
    const elevation=Number(rasters[0][y*width+x]);
    if(p[0]<ds.minE||p[0]>ds.maxE||p[1]<ds.minN||p[1]>ds.maxN||!Number.isFinite(elevation)||elevation===ds.nodata)throw new Error('Boundary elevation is missing. Move the boundary onto valid elevation coverage.');
    return [p[0],p[1],elevation*verticalFactor];
  });
  const values=verticalFactor===1?rasters[0]:Float64Array.from(rasters[0],v=>v*verticalFactor),nodata=Number.isFinite(ds.nodata)?ds.nodata*verticalFactor:NaN;
  const bounds={minE:ds.minE+x0*px,maxE:ds.minE+x1*px,maxN:ds.maxN-y0*py,minN:ds.maxN-y1*py};
  const result=await calculateBrowserSurface({vertices,reference,values,width,height,bounds,nodata,maxCells:1_500_000},{signal});
  return {...result,method:'surface-cut-fill',sourceKind:source.type,sourceResolutionM:[px,py],sourceVerticalUnitBasis:verticalUnitBasis==='administrator-declared'?'user-declared':verticalUnitBasis,modelVersionId:PROJECT?.activeVersion?.id,boundaryVertices:vertices,calculationOrigin:'browser',warnings:[...(result.warnings||[]),...(verticalUnitBasis==='administrator-declared'?['Source elevations were explicitly confirmed as meters; vertical units are not encoded in the raster.']:[])]};
  }finally{await tiff.close();}
}

const measurementSurfaceIds=new WeakMap();let measurementSurfaceNextId=0,measurementSurfaceSnapshot=null,measurementSurfaceSnapshotAt=0;
function measurementSurfaceId(value){if(!value||typeof value!=='object')return 0;if(!measurementSurfaceIds.has(value))measurementSurfaceIds.set(value,++measurementSurfaceNextId);return measurementSurfaceIds.get(value);}
function measurementRenderedSurface(force=false){
  const now=performance.now(),mode=state.activeMode,key=`${PROJECT?.id}:${PROJECT?.activeVersion?.id}:${mode}:${state.cloudMode}`;
  if(!force&&measurementSurfaceSnapshot?.key===key&&now-measurementSurfaceSnapshotAt<250)return measurementSurfaceSnapshot;
  const roots=[],nodes=[],parts=[key];let worldBounds=null;
  if(mode==='model'&&tilesParent?.visible&&tilesRenderer){
    tilesParent.updateWorldMatrix(true,true);worldBounds=tilesetWorldBounds(tilesRenderer);parts.push(measurementSurfaceId(tilesRenderer));
    for(const tile of tilesRenderer.visibleTiles||[]){const root=tile.engineData?.scene;if(root?.visible!==false&&root){roots.push({root,tile});parts.push(`${measurementSurfaceId(root)}:${root.matrixWorld.elements.join(',')}`);}}
  }else if(mode==='cloud'&&state.cloudMode==='potree'){
    const viewer=document.getElementById('pc-iframe')?.contentWindow?.viewer;
    parts.push(measurementSurfaceId(viewer));
    for(const cloud of viewer?.scene?.pointclouds||[]){if(cloud.visible===false)continue;cloud.updateMatrixWorld?.(true);
      for(const node of cloud.visibleNodes||[]){const descriptor=renderedPointNodeDescriptor(node);if(!descriptor)continue;const {geometry,positions,matrixWorld,spacing}=descriptor;
        nodes.push(descriptor);parts.push(`${measurementSurfaceId(geometry)}:${measurementSurfaceId(positions)}:${positions.version||0}:${positions.count}:${matrixWorld.elements.join(',')}:${spacing}`);
      }
    }
  }else if(mode==='cloud'&&state.cloudMode==='direct'&&pointCloudParent?.visible&&pointCloudObject){
    pointCloudObject.updateWorldMatrix(true,false);const geometry=pointCloudObject.geometry,positions=geometry?.attributes?.position;
    if(positions&&geometry.boundingBox){const canonical=new THREE.Matrix4().set(1,0,0,C.x+RTC.e,0,0,-1,C.y+RTC.n,0,1,0,C.z+RTC.z,0,0,0,1),matrixWorld=canonical.multiply(pointCloudObject.matrixWorld),bounds=geometry.boundingBox.clone().applyMatrix4(matrixWorld),size=bounds.getSize(new THREE.Vector3()),spacing=Math.sqrt(Math.max(size.x*size.y,Number.EPSILON)/Math.max(1,positions.count));nodes.push({positions,matrixWorld,bounds,spacing});parts.push(`${measurementSurfaceId(geometry)}:${measurementSurfaceId(positions)}:${positions.version||0}:${positions.count}:${matrixWorld.elements.join(',')}`);}
  }
  measurementSurfaceSnapshot={key,roots,nodes,worldBounds,revision:parts.join('|')};measurementSurfaceSnapshotAt=now;return measurementSurfaceSnapshot;
}
function measurementDisplaySurfaceRevision(){return measurementRenderedSurface().revision;}
async function resolveRenderedMeasurementVertices(record,{signal}={}){
  const surface=measurementRenderedSurface(true),expectedCrs=measurementCoordinateReference().crs;
  const result=state.activeMode==='model'?await resolveRenderedMeshBoundary({record,expectedCrs,roots:surface.roots,worldBounds:surface.worldBounds,toWorld:utmToWorld,fromWorld:worldToUtm,signal,surfaceRevision:surface.revision}):await resolveRenderedPointBoundary({record,expectedCrs,nodes:surface.nodes,signal,surfaceRevision:surface.revision});
  if(surface.key!==`${PROJECT?.id}:${PROJECT?.activeVersion?.id}:${state.activeMode}:${state.cloudMode}`||signal?.aborted)throw new DOMException('Display view changed','AbortError');
  return result;
}
async function resolveMeasurementDisplayVertices(record,{signal}={}){
  const preferred=record.source?.kind;
  const source=preferred==='dtm'&&DTM_URL?{type:'dtm',url:DTM_URL}:DSM_URL?{type:'dsm',url:DSM_URL}:DTM_URL?{type:'dtm',url:DTM_URL}:null;
  if(source)source.reviewedEvidence=PROJECT?.displayElevationEvidence?.[source.type];
  try{return await resolveMeasurementDisplayElevations(record,{modelId:PROJECT?.id,modelVersionId:PROJECT?.activeVersion?.id,expectedCrs:measurementCoordinateReference().crs,source,signal,openTiff:openGeoTiff,preflight:preflightBrowserRasterHeader,pool:ensureGeoTiffPool()});}
  catch(error){if(signal?.aborted||error.name==='AbortError')throw error;return resolveRenderedMeasurementVertices(record,{signal});}
}

function installMeasurementWorkspace() {
  measurementWorkspace?.dispose();
  measurementWorkspace=createMeasurementWorkspace({
    panel:document.getElementById('panel-measure'),context:measurementViewContext,
    reportMetadata:()=>({modelName:PROJECT?.title||PROJECT?.id||'Model'}),
    captureReportOrtho:async({records,signal})=>{if(!ORTHO_URL)return null;const dataset=await getDataset(ORTHO_URL,false,{signal});return captureMeasurementReportOrtho({dataset,records,signal,pool:geoPool,expectedCrs:measurementCoordinateReference().crs});},
    token:()=>VIEW_MODE==='session'&&sessionStorageKey?sessionStorage.getItem(sessionStorageKey):null,
    accessGeneration:()=>sessionAccessGeneration,
    onBeforeAccessLost:()=>{if(VIEW_MODE==='session'&&activeViewerSession&&Date.parse(activeViewerSession.expiresAt)<=Date.now())measurementDraftRecovery.capture('session-expired',activeViewerSession,measurementWorkspace);},
    permitted:()=>SHARE_PERMISSIONS.measure!==false&&sessionAccessState!=='unavailable'&&(VIEW_MODE!=='session'||!activeViewerSession||Date.parse(activeViewerSession.expiresAt)>Date.now()),coordinateReference:measurementCoordinateReference,
    toLonLat:p=>{if(!measurementCoordinateReference().crs.startsWith('EPSG:'))throw new Error('GeoJSON needs verified geographic alignment. Use JSON or DXF with the local coordinate warning.');const [lat,lon]=utmToLatLon(p[0],p[1]);return [lon,lat];},
    toolChanged:tool=>{state.activeTool=tool;document.querySelectorAll('#panel-measure .tool-btn[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));},
    calculateSurface:calculateSavedMeasurementSurface,
    resolveDisplayVertices:resolveMeasurementDisplayVertices,
    adminRequest:reviewSessionChannel ? measurementAdminClient.request : undefined,
    surfaceRequest:createMeasurementSurfaceClient({
      token:()=>VIEW_MODE==='session'&&sessionStorageKey?sessionStorage.getItem(sessionStorageKey):measurementAssetBearer(DSM_URL||DTM_URL||TILES_URL||EPT_URL||ORTHO_URL),
      context:()=>({modelId:PROJECT?.id,modelVersionId:PROJECT?.activeVersion?.id,audience:activeViewerSession?.audience,subject:activeViewerSession?.subject,temporary:VIEW_MODE!=='session'||(activeViewerSession?.audience!=='ops'&&activeViewerSession?.permissions?.personalMeasurements!==true)}),
    }),
    onAccessLost:measurementAccessLost,
  });
  viewerProductDownloads?.destroy();
  let productHost=document.getElementById('panel-products');if(!productHost){productHost=document.createElement('div');productHost.id='panel-products';productHost.className='panel';document.getElementById('sidebar-custom').append(productHost);}
  viewerProductDownloads=mountViewerProductDownloads({host:productHost,reportHost:document.getElementById('model-report-download'),getAssetRoot:()=>TILES_URL||EPT_URL||ORTHO_URL||DSM_URL||DTM_URL||GLB_URL,permitted:()=>SHARE_PERMISSIONS.download===true});
}

function setTool(tool) {
  if (measurementWorkspace) return measurementWorkspace.setTool(tool);
  if (state.activeMode === 'ortho' || state.activeMode === 'dsm' || state.activeMode === 'dtm') {
    return setMapTool(tool);
  }
  if (state.activeMode === 'cloud') {
    // route to the Potree iframe (same buttons drive both viewers)
    const api = pcApi();
    if (api) {
      if (tool === 'clear') { api.clearMeasurements(); tool = 'none'; }
      else api.setTool(tool);
    } else if (tool === 'clear') tool = 'none';
    state.activeTool = tool;
    document.querySelectorAll('#panel-measure .tool-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    dom.measureOutput.innerHTML = tool === 'none' ? ''
      : '<div class="hint">Click points on the cloud. Values appear on the model. Esc or right-click to finish.</div>';
    return;
  }
  if (tool === 'clear') { clearAllMeasurements(); tool = 'none'; }
  if (state.measure) cancelActiveMeasure();
  state.activeTool = tool;
  document.querySelectorAll('#panel-measure .tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  renderer.domElement.classList.toggle('measuring', tool !== 'none');
  if (tool !== 'none') {
    state.measure = {
      tool, points: [], markers: [], group: new THREE.Group(),
      line: null, previewLine: null, previewLabel: null, labels: []
    };
    measureRoot.add(state.measure.group);
    setMeasureHint();
  } else {
    dom.measureOutput.textContent = '';
  }
}

function isMapMode(mode = state.activeMode) {
  return mode === 'ortho' || mode === 'dsm' || mode === 'dtm';
}

async function setMapTool(tool) {
  if (!map) return;
  const requestEpoch = ++mapToolEpoch;
  if (tool === 'clear') {
    cancelMapMeasure();
    mapMeasurements.forEach((layer) => map.removeLayer(layer));
    mapMeasurements = [];
    tool = 'none';
  }
  if (mapMeasure) cancelMapMeasure();
  if (tool === 'volume') {
    state.activeTool = 'none';
    syncMeasureButtons();
    if (!DSM_URL && !DTM_URL) {
      dom.measureOutput.innerHTML = '<b>Volume requires an elevation raster.</b><br><span class="sub">This task has no published DSM or DTM. Orthophoto pixels alone contain no height.</span>';
      return;
    }
    if (!selectedVolumeDataset()) {
      dom.measureOutput.textContent = 'Loading the elevation surface for volume measurement…';
      try {
        await ensureVolumeDataset(modeAbortController?.signal);
      } catch (error) {
        if (error?.name === 'AbortError' || requestEpoch !== mapToolEpoch) return;
        dom.measureOutput.innerHTML = '<b>Could not load the elevation raster.</b><br><span class="sub">Retry Volume or choose another published DSM/DTM surface.</span>';
        return;
      }
      if (requestEpoch !== mapToolEpoch || modeAbortController?.signal.aborted || !isMapMode()) return;
    }
  }
  state.activeTool = tool;
  syncMeasureButtons();
  map.doubleClickZoom[tool === 'none' ? 'enable' : 'disable']();
  dom.leafletMap.classList.toggle('measuring', tool !== 'none');
  if (tool === 'none') { dom.measureOutput.textContent = ''; return; }
  mapMeasure = { tool, points: [], group: L.layerGroup().addTo(map), shape: null, preview: null };
  dom.measureOutput.textContent = tool === 'distance'
    ? 'Click the first point on the map.'
    : 'Click to add points (3 or more). Double-click, Enter, or right-click to finish.';
}

function syncMeasureButtons() {
  document.querySelectorAll('#panel-measure .tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === state.activeTool);
  });
  syncMapVolumeAvailability();
}

function projectedMapPoints(points) {
  return points.map((p) => latLonToUtm(p.lat, p.lng));
}

function mapDistanceMeters(points) {
  const p = projectedMapPoints(points);
  let total = 0;
  for (let i = 1; i < p.length; i++) total += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return total;
}

function mapAreaSquareMeters(points) {
  const p = projectedMapPoints(points);
  let twice = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

function redrawMapMeasure(cursor = null) {
  const m = mapMeasure;
  if (!m) return;
  if (m.shape) m.group.removeLayer(m.shape);
  if (m.preview) m.group.removeLayer(m.preview);
  m.shape = null; m.preview = null;
  if (m.points.length >= 2) {
    m.shape = (m.tool === 'area' || m.tool === 'volume') && m.points.length >= 3
      ? L.polygon(m.points, { color: '#F8CB2E', weight: 3, fillColor: '#EE5007', fillOpacity: 0.2 })
      : L.polyline(m.points, { color: '#F8CB2E', weight: 3 });
    m.shape.addTo(m.group);
  }
  if (cursor && m.points.length) {
    m.preview = L.polyline([m.points[m.points.length - 1], cursor], { color: '#fff', weight: 2, dashArray: '6 6' }).addTo(m.group);
  }
}

function addMapMeasurePoint(latlng) {
  const m = mapMeasure;
  if (!m || m.finishing) return;
  m.points.push(L.latLng(latlng));
  L.circleMarker(latlng, { radius: 5, color: '#F8CB2E', weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(m.group);
  redrawMapMeasure();
  if (m.tool === 'distance') {
    if (m.points.length === 2) finishMapMeasure();
    else dom.measureOutput.textContent = 'Click the second point. Esc or right-click cancels.';
  } else {
    dom.measureOutput.textContent = m.points.length < 3
      ? `${m.points.length} points placed; 3 or more are required.`
      : `${m.points.length} points placed. Double-click, Enter, or right-click to finish.`;
  }
}

async function finishMapMeasure() {
  const m = mapMeasure;
  if (m?.finishing) return;
  if (!m || m.points.length < (m.tool === 'distance' ? 2 : 3)) { cancelMapMeasure(); setMapTool('none'); return; }
  m.finishing = true;
  redrawMapMeasure();
  const value = m.tool === 'distance' ? mapDistanceMeters(m.points) : mapAreaSquareMeters(m.points);
  let text = m.tool === 'distance' ? formatLength(value, DISPLAY_UNITS) : formatArea(value, DISPLAY_UNITS);
  const anchor = m.tool === 'distance'
    ? L.latLng((m.points[0].lat + m.points.at(-1).lat) / 2, (m.points[0].lng + m.points.at(-1).lng) / 2)
    : L.polygon(m.points).getBounds().getCenter();
  if (m.tool === 'volume') {
    dom.measureOutput.textContent = 'Sampling elevation cells inside the polygon…';
    try {
      const result = await calculateMapVolume(m.points);
      text = `Net ${formatVolume(result.netM3, DISPLAY_UNITS)}`;
      dom.measureOutput.innerHTML = `<b>Cut:</b> ${formatVolume(result.cutM3, DISPLAY_UNITS)}<br><b>Fill:</b> ${formatVolume(result.fillM3, DISPLAY_UNITS)}<br><b>Net:</b> ${formatVolume(result.netM3, DISPLAY_UNITS)}<br><span class="sub">Reference ${formatElevation(result.referenceElevation, DISPLAY_UNITS)} · ${result.sampleCount.toLocaleString()} elevation cells</span>`;
    } catch (err) {
      if (err?.name === 'AbortError' || mapMeasure !== m) return;
      console.error('map volume error', err);
      dom.measureOutput.textContent = err?.message || 'Could not calculate volume.';
      m.finishing = false;
      return;
    }
  } else {
    dom.measureOutput.innerHTML = `<b>${m.tool === 'distance' ? 'Distance' : 'Area'}:</b> ${text}`;
  }
  L.tooltip({ permanent: true, direction: 'top', className: 'map-measure-label' }).setLatLng(anchor).setContent(text).addTo(m.group);
  mapMeasurements.push(m.group);
  mapMeasure = null;
  state.activeTool = 'none';
  syncMeasureButtons();
  map.doubleClickZoom.enable();
  dom.leafletMap.classList.remove('measuring');
}

function selectedVolumeDataset() {
  const requested = document.getElementById('map-volume-surface')?.value;
  const dsm = demLayers.dsm?.ds || geoDatasets[DSM_URL] || null;
  const dtm = demLayers.dtm?.ds || geoDatasets[DTM_URL] || null;
  if (requested === 'dsm') return dsm;
  if (requested === 'dtm') return dtm;
  return state.activeMode === 'dsm' ? dsm
    : state.activeMode === 'dtm' ? dtm
    : dsm || dtm;
}

function requestedVolumeSurface() {
  const requested = document.getElementById('map-volume-surface')?.value;
  if (requested === 'dsm' && DSM_URL) return { type: 'dsm', url: DSM_URL };
  if (requested === 'dtm' && DTM_URL) return { type: 'dtm', url: DTM_URL };
  if (state.activeMode === 'dsm' && DSM_URL) return { type: 'dsm', url: DSM_URL };
  if (state.activeMode === 'dtm' && DTM_URL) return { type: 'dtm', url: DTM_URL };
  if (DSM_URL) return { type: 'dsm', url: DSM_URL };
  if (DTM_URL) return { type: 'dtm', url: DTM_URL };
  return null;
}

async function ensureVolumeDataset(signal = modeAbortController?.signal) {
  const loaded = selectedVolumeDataset();
  if (loaded) return loaded;
  const surface = requestedVolumeSurface();
  if (!surface) throw Object.assign(new Error('No elevation raster is published.'), { code: 'elevation_unavailable' });
  const ds = await getDataset(surface.url, true, { signal });
  if (signal?.aborted) throw new DOMException('The elevation load was cancelled.', 'AbortError');
  const select = document.getElementById('map-volume-surface');
  if (select?.value === 'auto') select.value = surface.type;
  syncMapVolumeAvailability();
  return ds;
}

async function calculateMapVolume(latLngPoints) {
  const signal = modeAbortController?.signal;
  const ds = selectedVolumeDataset() || await ensureVolumeDataset(signal);
  const polygon = projectedMapPoints(latLngPoints);
  const minE = Math.max(ds.minE, Math.min(...polygon.map((p) => p[0])));
  const maxE = Math.min(ds.maxE, Math.max(...polygon.map((p) => p[0])));
  const minN = Math.max(ds.minN, Math.min(...polygon.map((p) => p[1])));
  const maxN = Math.min(ds.maxN, Math.max(...polygon.map((p) => p[1])));
  if (!(maxE > minE && maxN > minN)) throw new Error('The polygon is outside the elevation surface.');
  const image = ds.images[0];
  const pxWidth = (ds.maxE - ds.minE) / ds.W;
  const pxHeight = (ds.maxN - ds.minN) / ds.H;
  const x0 = Math.max(0, Math.floor((minE - ds.minE) / pxWidth));
  const x1 = Math.min(ds.W, Math.ceil((maxE - ds.minE) / pxWidth));
  const y0 = Math.max(0, Math.floor((ds.maxN - maxN) / pxHeight));
  const y1 = Math.min(ds.H, Math.ceil((ds.maxN - minN) / pxHeight));
  const sourceW = Math.max(1, x1 - x0), sourceH = Math.max(1, y1 - y0);
  const scale = Math.max(1, Math.ceil(Math.sqrt((sourceW * sourceH) / 1_500_000)));
  const width = Math.max(1, Math.ceil(sourceW / scale));
  const height = Math.max(1, Math.ceil(sourceH / scale));
  const rasters = await image.readRasters({ window: [x0, y0, x1, y1], width, height, resampleMethod: 'bilinear', pool: geoPool, signal });
  const reference = document.getElementById('map-volume-reference')?.value || 'lowest';
  const rawCustom = document.getElementById('map-volume-custom')?.value;
  const customReference = rawCustom === '' ? null : elevationInputMeters(Number(rawCustom));
  return integrateElevationVolume({
    values: rasters[0], width, height,
    bounds: {
      minE: ds.minE + x0 * pxWidth,
      maxE: ds.minE + x1 * pxWidth,
      maxN: ds.maxN - y0 * pxHeight,
      minN: ds.maxN - y1 * pxHeight,
    },
    polygon, nodata: ds.nodata, reference, customReference,
  });
}

function syncMapVolumeAvailability() {
  const options = document.getElementById('map-volume-options');
  if (options) options.style.display = isMapMode() && (state.activeMode === 'ortho' || state.activeTool === 'volume') ? 'block' : 'none';
  const surface = document.getElementById('map-volume-surface');
  if (!surface) return;
  surface.querySelector('option[value="dsm"]').disabled = !DSM_URL;
  surface.querySelector('option[value="dtm"]').disabled = !DTM_URL;
  if (state.activeMode === 'dsm' && demLayers.dsm) surface.value = 'dsm';
  else if (state.activeMode === 'dtm' && demLayers.dtm) surface.value = 'dtm';
  else if (surface.selectedOptions[0]?.disabled) surface.value = demLayers.dsm ? 'dsm' : demLayers.dtm ? 'dtm' : 'auto';
  const volumeButton = document.getElementById('tool-volume');
  if (isMapMode()) {
    volumeButton.disabled = false;
    volumeButton.title = DSM_URL || DTM_URL
      ? 'The selected DSM/DTM loads automatically when Volume is chosen.'
      : 'Volume is unavailable because this task has no DSM or DTM elevation raster.';
  }
}

function cancelMapMeasure() {
  if (mapMeasure && map) map.removeLayer(mapMeasure.group);
  mapMeasure = null;
  if (map) map.doubleClickZoom.enable();
  dom.leafletMap.classList.remove('measuring');
}

function setMeasureHint() {
  const m = state.measure;
  if (!m) return;
  const n = m.points.length;
  if (m.tool === 'distance') {
    dom.measureOutput.textContent = n === 0
      ? 'Click the first point on the model.'
      : 'Click the second point. Esc or right-click cancels.';
  } else {
    dom.measureOutput.textContent = n < 3
      ? `Click to add points (${n} placed, need 3+). Esc/right-click cancels.`
      : `${n} points placed. Double-click, Enter, or right-click to finish.`;
  }
}

function addMeasurePoint(point) {
  const m = state.measure;
  if (!m) return;
  // ignore duplicate clicks (double-click finish fires two pointerups)
  if (m.points.length) {
    const last = m.points[m.points.length - 1];
    if (last.distanceTo(point) < 0.02) return;
  }
  m.points.push(point.clone());
  const mk = makeMarker(point);
  m.group.add(mk);
  m.markers.push(mk);

  if (m.tool === 'distance' && m.points.length === 2) { finishMeasure(); return; }
  redrawActiveMeasure();
  setMeasureHint();
}

function redrawActiveMeasure(cursorPoint = null) {
  const m = state.measure;
  if (!m) return;
  // main polyline
  if (m.line) { m.group.remove(m.line); m.line.geometry.dispose(); }
  m.line = null;
  if (m.points.length >= 2) {
    const pts = m.points.slice();
    if ((m.tool === 'area' || m.tool === 'volume') && pts.length > 2) pts.push(pts[0]);
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    m.line = new THREE.Line(g, lineMaterial());
    m.line.renderOrder = 998;
    m.group.add(m.line);
  }
  // rubber-band preview to the cursor
  if (m.previewLine) { m.group.remove(m.previewLine); m.previewLine.geometry.dispose(); m.previewLine = null; }
  if (m.previewLabel) { m.group.remove(m.previewLabel); m.previewLabel.element.remove(); m.previewLabel = null; }
  if (cursorPoint && m.points.length >= 1) {
    const last = m.points[m.points.length - 1];
    const g = new THREE.BufferGeometry().setFromPoints([last, cursorPoint]);
    m.previewLine = new THREE.Line(g, new THREE.LineDashedMaterial({
      color: 0xffffff, dashSize: 1.2, gapSize: 0.8, depthTest: false, transparent: true, opacity: 0.7
    }));
    m.previewLine.computeLineDistances();
    m.previewLine.renderOrder = 998;
    m.group.add(m.previewLine);
    m.previewLabel = makeLabel(formatLength(last.distanceTo(cursorPoint), DISPLAY_UNITS), 'mlabel preview');
    m.previewLabel.position.copy(new THREE.Vector3().addVectors(last, cursorPoint).multiplyScalar(0.5));
    m.group.add(m.previewLabel);
  }
}

function finishMeasure() {
  const m = state.measure;
  if (!m) return;
  const need = m.tool === 'distance' ? 2 : 3;
  if (m.points.length < need) { cancelActiveMeasure(); setTool('none'); return; }

  if (m.previewLine) { m.group.remove(m.previewLine); m.previewLine.geometry.dispose(); m.previewLine = null; }
  if (m.previewLabel) { m.group.remove(m.previewLabel); m.previewLabel.element.remove(); m.previewLabel = null; }

  if (m.tool === 'distance') {
    const [a, b] = m.points;
    const distanceM = a.distanceTo(b);
    const horizontalM = Math.hypot(a.x - b.x, a.z - b.z);
    const verticalM = Math.abs(a.y - b.y);
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(g, lineMaterial());
    line.renderOrder = 998;
    m.group.add(line);
    const label = makeLabel(formatLength(distanceM, DISPLAY_UNITS));
    label.element.title = `Horizontal ${formatLength(horizontalM, DISPLAY_UNITS)} · Vertical ${formatLength(verticalM, DISPLAY_UNITS)}`;
    label.position.copy(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
    m.group.add(label);
    m.labels.push(label);
    dom.measureOutput.innerHTML =
      `<b>Distance:</b> ${formatLength(distanceM, DISPLAY_UNITS)}<br><span class="sub">Horizontal ${formatLength(horizontalM, DISPLAY_UNITS)} · Vertical ${formatLength(verticalM, DISPLAY_UNITS)}</span>`;
  } else {
    // close the loop
    if (m.line) { m.group.remove(m.line); m.line.geometry.dispose(); m.line = null; }
    const loop = m.points.slice(); loop.push(loop[0]);
    const g = new THREE.BufferGeometry().setFromPoints(loop);
    const line = new THREE.Line(g, lineMaterial());
    line.renderOrder = 998;
    m.group.add(line);

    const fillGeom = triangulateShape(m.points);
    if (fillGeom) {
      const fill = new THREE.Mesh(fillGeom, new THREE.MeshBasicMaterial({
        color: 0xEE5007, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthTest: false
      }));
      fill.renderOrder = 997;
      m.group.add(fill);
    }
    const centroid = m.points.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(m.points.length);
    const areaM2 = polygonArea3D(m.points);

    if (m.tool === 'area') {
      const label = makeLabel(formatArea(areaM2, DISPLAY_UNITS));
      label.position.copy(centroid);
      m.group.add(label);
      m.labels.push(label);
      dom.measureOutput.innerHTML = `<b>Area:</b> ${formatArea(areaM2, DISPLAY_UNITS)}`;
    } else {
      const ys = m.points.map(p => p.y);
      const depthM = Math.max(...ys) - Math.min(...ys);
      const volumeM3 = areaM2 * depthM;
      const label = makeLabel(formatVolume(volumeM3, DISPLAY_UNITS));
      label.position.copy(centroid);
      m.group.add(label);
      m.labels.push(label);
      dom.measureOutput.innerHTML =
        `<b>Volume (prism approx):</b> ${formatVolume(volumeM3, DISPLAY_UNITS)}<br><span class="sub">${formatVolumeDetail(volumeM3, areaM2, depthM, DISPLAY_UNITS)}</span>`;
    }
  }

  state.measurements.push(m.group);
  state.measure = null;
  // auto-disarm: user must pick a tool again for the next measurement
  state.activeTool = 'none';
  document.querySelectorAll('#panel-measure .tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === 'none');
  });
  renderer.domElement.classList.remove('measuring');
}

function cancelActiveMeasure() {
  const m = state.measure;
  if (!m) return;
  measureRoot.remove(m.group);
  disposeGroup(m.group);
  state.measure = null;
  dom.measureOutput.textContent = '';
}

function clearAllMeasurements() {
  cancelActiveMeasure();
  state.measurements.forEach((g) => { measureRoot.remove(g); disposeGroup(g); });
  state.measurements = [];
  dom.measureOutput.textContent = '';
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
    if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
  });
  group.clear();
}

function exitMeasureTool() {
  if (state.measure && state.measure.tool !== 'distance' && state.measure.points.length >= 3) {
    finishMeasure();   // finishMeasure disarms the tool and keeps the readout
  } else {
    cancelActiveMeasure();
    setTool('none');
  }
}

// geometry helpers
function triangulateShape(points) {
  if (points.length < 3) return null;
  const { origin, u, v } = fitPlane(points);
  const shapePts = points.map((p) => {
    const d = new THREE.Vector3().subVectors(p, origin);
    return new THREE.Vector2(d.dot(u), d.dot(v));
  });
  const geom = new THREE.ShapeGeometry(new THREE.Shape(shapePts));
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const p3 = new THREE.Vector3().copy(origin).addScaledVector(u, x).addScaledVector(v, y);
    pos.setXYZ(i, p3.x, p3.y, p3.z);
  }
  geom.computeVertexNormals();
  return geom;
}

function fitPlane(points) {
  const origin = points.reduce((a, b) => a.clone().add(b), new THREE.Vector3()).divideScalar(points.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const d = new THREE.Vector3().subVectors(p, origin);
    xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z;
    yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
  }
  const n = new THREE.Vector3(xy * yz - xz * yy, xz * xy - xx * yz, xx * yy - xy * xy);
  if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
  n.normalize();
  let u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(u.dot(n)) > 0.9) u.set(0, 1, 0);
  u.addScaledVector(n, -u.dot(n)).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { origin, u, v };
}

function polygonArea3D(points) {
  if (points.length < 3) return 0;
  const { origin, u, v } = fitPlane(points);
  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const p0 = points[i], p1 = points[(i + 1) % points.length];
    const d0 = new THREE.Vector3().subVectors(p0, origin);
    const d1 = new THREE.Vector3().subVectors(p1, origin);
    area2 += d0.dot(u) * d1.dot(v) - d1.dot(u) * d0.dot(v);
  }
  return Math.abs(area2) * 0.5;
}

// ───────────────────────────────────────────────────────────────
// Pointer routing (placement, camera clicks, hover)
// ───────────────────────────────────────────────────────────────
function eventNdc(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}

function localCameraRendererActive() {
  return state.activeMode === 'model'
    || (state.activeMode === 'cloud' && state.cloudMode === 'direct');
}

function onPointerUp(e) {
  if (measurementWorkspace?.isDrawing()) return;
  if (!localCameraRendererActive()) return;
  if (!controls.wasClick()) return;

  const ndc = eventNdc(e);
  if (e.button === 2) {
    // right-click: finish or cancel the measurement in progress
    if (state.activeMode === 'model' && state.activeTool !== 'none') { exitMeasureTool(); }
    return;
  }
  if (e.button !== 0) return;

  if (state.activeTool !== 'none') {
    if (state.activeMode !== 'model') return;
    const hit = pickSurface(ndc);
    if (hit) addMeasurePoint(hit);
    return;
  }
  // camera marker click -> photo popup
  const camIdx = pickCameraInstance(ndc);
  if (camIdx >= 0) openPhoto(camIdx);
}

let lastHover = 0;
function onPointerMove(e) {
  if (!localCameraRendererActive()) return;
  const now = performance.now();
  if (now - lastHover < 70) return;
  lastHover = now;
  const ndc = eventNdc(e);

  // measurement rubber band
  if (state.activeMode === 'model' && state.measure && state.measure.points.length >= 1) {
    const hit = pickSurface(ndc);
    if (hit) redrawActiveMeasure(hit);
  }

  // statusbar coordinates under cursor
  const surf = state.activeMode === 'model' && !state.measure ? pickSurface(ndc) : null;
  if (surf) {
    const u = worldToUtm(surf);
    dom.coords.textContent = `E ${u.e.toFixed(1)}  N ${u.n.toFixed(1)}  El ${formatElevation(u.alt, DISPLAY_UNITS)}`;
  }

  // camera hover
  if (state.camerasVisible && state.activeTool === 'none') {
    const idx = pickCameraInstance(ndc);
    highlightCam(idx);
    if (idx >= 0) {
      dom.camTooltip.textContent = camFeatures[idx].properties.filename || 'Camera position';
      dom.camTooltip.style.display = 'block';
      dom.camTooltip.style.left = (e.clientX + 14) + 'px';
      dom.camTooltip.style.top = (e.clientY + 10) + 'px';
      renderer.domElement.style.cursor = 'pointer';
    } else {
      dom.camTooltip.style.display = 'none';
      renderer.domElement.style.cursor = '';
    }
  }
}

function onDoubleClick() {
  if (state.activeTool !== 'none' && state.measure && state.measure.points.length >= 3) {
    finishMeasure();
  }
}

function onKeyDown(e) {
  if (measurementWorkspace?.isDrawing() || e.target?.closest?.('input,textarea,select,[contenteditable=true]')) return;
  if (e.key === 'Escape') {
    if (dom.photoModal.style.display === 'flex') { closePhoto(); return; }
    if (state.activeMode === 'cloud') {
      const api = pcApi(); if (api) api.cancel();
      setTool('none');
      return;
    }
    if (state.activeTool !== 'none') {
      if (isMapMode()) cancelMapMeasure(); else cancelActiveMeasure();
      setTool('none');
    }
  } else if (e.key === 'Enter') {
    if (mapMeasure && mapMeasure.points.length >= 3) finishMapMeasure();
    else if (state.measure && state.measure.points.length >= 3) finishMeasure();
  }
}

// ───────────────────────────────────────────────────────────────
// GeoTIFF streaming (ortho / DSM / DTM) — HTTP range reads
// ───────────────────────────────────────────────────────────────
function ensureMap() {
  if (map) return;
  dom.leafletMap.style.display = 'block';
  map = L.map(dom.leafletMap, { zoomControl: true, attributionControl: true, maxZoom: 28 });
  // Detail tiles must sit ABOVE the overview imageOverlay (overlayPane z=400).
  // Leaflet's default tilePane is z=200, which buried the hi-res tiles and
  // made zooming look like it never sharpened.
  map.createPane('gtiff');
  map.getPane('gtiff').style.zIndex = 450;
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    // Esri permits anonymous CORS. Opt in before loading so visible basemap
    // tiles can be included in measurement PNG/report canvases without taint.
    crossOrigin: 'anonymous', attribution: 'Tiles © Esri', maxZoom: 28, maxNativeZoom: 19
  }).addTo(map);
  map.setView([42.981, -88.628], 15);

  map.on('mousemove', (e) => {
    if (mapMeasure?.points.length) redrawMapMeasure(e.latlng);
    const ds = state.activeMode === 'dsm' ? geoDatasets[DSM_URL]
             : state.activeMode === 'dtm' ? geoDatasets[DTM_URL] : null;
    if (ds) showDemHover(e, ds); else dom.demHover.style.display = 'none';
  });
  map.on('click', (e) => { if (mapMeasure) addMapMeasurePoint(e.latlng); });
  map.on('dblclick', (e) => {
    if (mapMeasure?.points.length >= 3) { L.DomEvent.stop(e); finishMapMeasure(); }
  });
  map.on('contextmenu', (e) => {
    if (!mapMeasure) return;
    L.DomEvent.stop(e);
    if (mapMeasure.points.length >= 3) finishMapMeasure();
    else { cancelMapMeasure(); setMapTool('none'); }
  });
  map.on('moveend zoomend resize', refreshMapCameraLayer);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw new DOMException('The viewer load was cancelled.', 'AbortError');
}

async function getDataset(url, isDem, { signal = null } = {}) {
  throwIfAborted(signal);
  if (geoDatasets[url]) return geoDatasets[url];
  ensureGeoTiffPool();
  const tiff = await openGeoTiff(url, { allowFullFile: false, blockSize: 262144, cacheSize: 128 }, signal);
  throwIfAborted(signal);
  const count = await tiff.getImageCount();
  const images = [];
  for (let i = 0; i < count; i++) {
    throwIfAborted(signal);
    images.push(await tiff.getImage(i));
  }
  const image = images[0];
  const bbox = image.getBoundingBox();
  const [minE, minN, maxE, maxN] = bbox;
  // true lat/lon footprint of the rotated UTM rectangle: warp all 4 corners,
  // lat/lon bounds = min/max over the warped corners (covers the rotation margin)
  const cLL = [utmToLatLon(minE, maxN), utmToLatLon(maxE, maxN),
               utmToLatLon(minE, minN), utmToLatLon(maxE, minN)];
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const c of cLL) {
    if (c[0] < minLat) minLat = c[0]; if (c[0] > maxLat) maxLat = c[0];
    if (c[1] < minLon) minLon = c[1]; if (c[1] > maxLon) maxLon = c[1];
  }
  const ds = {
    tiff, images, isDem,
    W: image.getWidth(), H: image.getHeight(),
    minE, minN, maxE, maxN,
    llCorners: cLL,                                   // NW, NE, SW, SE in lat/lon (warped)
    llBounds: [[minLat, minLon], [maxLat, maxLon]],   // encloses all 4 warped corners
    nodata: parseFiniteGdalNoData(image.getGDALNoData()),
    _ovCache: null                                    // cached overview raster for recolor w/o refetch
  };
  if (isDem) {
    // stats from the smallest overview
    const smallest = images[images.length - 1];
    const raster = await smallest.readRasters({ pool: geoPool, signal });
    let min = Infinity, max = -Infinity;
    const band = raster[0];
    for (let i = 0; i < band.length; i++) {
      const v = band[i];
      if (isFinite(v) && v > -1000 && v < 10000 && v !== ds.nodata) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    ds.min = min; ds.max = max;
  }
  geoDatasets[url] = ds;
  return ds;
}

// Leaflet layer that reads GeoTIFF windows per tile (progressive sharpening)
const GeoTiffGridLayer = L.GridLayer.extend({
  initialize: function (ds, renderFn, options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this.ds = ds;
    this.renderFn = renderFn;
    this.abortSignal = options?.signal || null;
  },
  setAbortSignal: function (signal) {
    this.abortSignal = signal || null;
    return this;
  },
  createTile: function (coords, done) {
    const tile = document.createElement('canvas');
    const size = this.getTileSize();
    tile.width = size.x; tile.height = size.y;
    const ds = this.ds;
    const signal = this.abortSignal;
    if (signal?.aborted) { setTimeout(() => done(null, tile), 0); return tile; }

    // Warp fix: unproject ALL FOUR tile corners (UTM rows are not Mercator rows -
    // grid convergence rotates the raster ~1.11 deg, so NW/SE alone misses the shear)
    const pxs = [coords.x * size.x, (coords.x + 1) * size.x];
    const pys = [coords.y * size.y, (coords.y + 1) * size.y];
    let minE0 = Infinity, maxE0 = -Infinity, minN0 = Infinity, maxN0 = -Infinity;
    for (const px of pxs) for (const py of pys) {
      const ll = this._map.unproject([px, py], coords.z);
      const en = latLonToUtm(ll.lat, ll.lng);
      if (en[0] < minE0) minE0 = en[0]; if (en[0] > maxE0) maxE0 = en[0];
      if (en[1] < minN0) minN0 = en[1]; if (en[1] > maxN0) maxN0 = en[1];
    }

    // native-resolution read window in source pixel space, padded by 2 source px
    // (+1 more for DEM hillshade neighbors)
    const mPerPxX = (ds.maxE - ds.minE) / ds.W, mPerPxY = (ds.maxN - ds.minN) / ds.H;
    const wMinE = Math.max(ds.minE, minE0) - 2 * mPerPxX;
    const wMaxE = Math.min(ds.maxE, maxE0) + 2 * mPerPxX;
    const wMinN = Math.max(ds.minN, minN0) - 2 * mPerPxY;
    const wMaxN = Math.min(ds.maxN, maxN0) + 2 * mPerPxY;
    if (wMaxE <= wMinE || wMaxN <= wMinN) { setTimeout(() => done(null, tile), 0); return tile; }

    // full-res px window; native read resolution (no width/height resample),
    // level chosen so the window is closest to 256px, capped at 640px per axis
    const winWm = wMaxE - wMinE;
    const winWf = winWm / mPerPxX, winHf = (wMaxN - wMinN) / mPerPxY;
    let level = Math.max(0, Math.min(ds.images.length - 1, Math.floor(Math.log2(winWf / size.x))));
    let img = ds.images[level], s = img.getWidth() / ds.W;
    const hsPadM = () => (ds.isDem
      ? Math.max((ds.maxE - ds.minE) / img.getWidth(), (ds.maxN - ds.minN) / img.getHeight()) : 0);
    while (level < ds.images.length - 1) {
      const wpx = (winWm + 2 * hsPadM()) / (mPerPxX / s);
      const hpx = ((wMaxN - wMinN) + 2 * hsPadM()) / ((ds.maxN - ds.minN) / img.getHeight());
      if (Math.max(wpx, hpx) <= 640) break;
      level++; img = ds.images[level]; s = img.getWidth() / ds.W;
    }
    const pad = hsPadM();
    const iw = img.getWidth(), ih = img.getHeight();
    const sy = ih / ds.H;
    const wsx = Math.max(0, Math.floor((wMinE - pad - ds.minE) / mPerPxX * s));
    const wsy = Math.max(0, Math.floor((ds.maxN - (wMaxN + pad)) / mPerPxY * sy));
    const wex = Math.min(iw, Math.ceil((wMaxE + pad - ds.minE) / mPerPxX * s));
    const wey = Math.min(ih, Math.ceil((ds.maxN - (wMinN - pad)) / mPerPxY * sy));
    if (wex - wsx < 1 || wey - wsy < 1) { setTimeout(() => done(null, tile), 0); return tile; }

    img.readRasters({
      window: [wsx, wsy, wex, wey],
      pool: geoPool,
      resampleMethod: ds.isDem ? 'nearest' : 'bilinear',
      interleave: false,
      fillValue: ds.isDem ? (isNaN(ds.nodata) ? -9999 : ds.nodata) : 0,
      signal,
    }).then((raster) => {
      if (signal?.aborted) { done(null, tile); return; }
      const rw = raster.width, rh = raster.height;
      // exact UTM span of the read window (pixel corners in level-m space)
      const mpx = mPerPxX / s, mpy = mPerPxY / sy;
      const winMinE = ds.minE + wsx * mpx;
      const winMaxE = ds.minE + wex * mpx;
      const winMaxN = ds.maxN - wsy * mpy;
      const winMinN = ds.maxN - wey * mpy;
      // per-pixel inverse warp: lat constant per row, lon linear per column
      const lats = new Float64Array(size.y), lons = new Float64Array(size.x);
      const px0 = coords.x * size.x, py0 = coords.y * size.y;
      for (let y = 0; y < size.y; y++)
        lats[y] = this._map.unproject([px0, py0 + y + 0.5], coords.z).lat;
      const llW = this._map.unproject([px0, py0], coords.z);
      const llE = this._map.unproject([px0 + size.x, py0], coords.z);
      for (let x = 0; x < size.x; x++)
        lons[x] = llW.lng + (llE.lng - llW.lng) * (x + 0.5) / size.x;
      const cvs = this.renderFn(raster, rw, rh, ds, { winMinE, winMaxE, winMinN, winMaxN, lats, lons, outW: size.x, outH: size.y });
      const ctx = tile.getContext('2d');
      ctx.imageSmoothingEnabled = !ds.isDem;
      ctx.drawImage(cvs, 0, 0);
      done(null, tile);
    }).catch((err) => { done(err?.name === 'AbortError' ? null : err, tile); });

    return tile;
  }
});

// Per-pixel inverse-warp sampler shared by warped grid tiles and the warped overview.
// raster was read at NATIVE level resolution and covers winMinE..winMaxE x winMinN..winMaxN.
// Every output pixel's lat/lon (precomputed per row/col by the caller) is converted to UTM,
// mapped to a fractional source pixel in the read window, and sampled:
// ortho = bilinear RGBA, DEM = nearest elevation value -> (optionally banded) colormap,
// with hillshade evaluated on the SOURCE grid neighbors (not warped output neighbors).
function warpedSampleGrid(raster, rw, rh, winMinE, winMaxE, winMaxN, winMinN, lats, lons, outW, outH, ds) {
  const invW = rw / ((winMaxE - winMinE) || 1);
  const invH = rh / ((winMaxN - winMinN) || 1);
  const sr = raster[0], sg = raster[1] || raster[0], sb = raster[2] || raster[0];
  const sa = raster.length >= 4 ? raster[3] : null;
  const cvs = document.createElement('canvas');
  cvs.width = outW; cvs.height = outH;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(outW, outH);
  const data = img.data;
  if (!ds.isDem) {
    for (let y = 0; y < outH; y++) {
      const lat = lats[y];
      for (let x = 0; x < outW; x++) {
        const o = (y * outW + x) * 4;
        const en = latLonToUtm(lat, lons[x]);
        const fx = (en[0] - winMinE) * invW - 0.5;
        const fy = (winMaxN - en[1]) * invH - 0.5;
        if (fx < -0.5 || fy < -0.5 || fx > rw - 0.5 || fy > rh - 0.5) { data[o+3] = 0; continue; }
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const cy0 = Math.max(0, Math.min(rh-1, y0)), cy1 = Math.max(0, Math.min(rh-1, y0+1));
        const cx0 = Math.max(0, Math.min(rw-1, x0)), cx1 = Math.max(0, Math.min(rw-1, x0+1));
        const i00 = cy0 * rw + cx0, i01 = cy0 * rw + cx1, i10 = cy1 * rw + cx0, i11 = cy1 * rw + cx1;
        const w00 = (1-tx)*(1-ty), w01 = tx*(1-ty), w10 = (1-tx)*ty, w11 = tx*ty;
        if (sa) {
          data[o]   = sr[i00]*w00 + sr[i01]*w01 + sr[i10]*w10 + sr[i11]*w11;
          data[o+1] = sg[i00]*w00 + sg[i01]*w01 + sg[i10]*w10 + sg[i11]*w11;
          data[o+2] = sb[i00]*w00 + sb[i01]*w01 + sb[i10]*w10 + sb[i11]*w11;
          data[o+3] = sa[i00]*w00 + sa[i01]*w01 + sa[i10]*w10 + sa[i11]*w11;
        } else {
          const sample = maskedRgbBilinear(
            sr, sg, sb,
            [i00, i01, i10, i11],
            [w00, w01, w10, w11],
            ds.nodata,
          );
          data[o] = sample.r; data[o+1] = sample.g; data[o+2] = sample.b; data[o+3] = sample.a;
        }
      }
    }
  } else {
    const band = raster[0];
    const nodata = isNaN(ds.nodata) ? -9999 : ds.nodata;
    const lo = demSettings.minFt != null ? elevationInputMeters(demSettings.minFt) : ds.min;
    const hi = demSettings.maxFt != null ? elevationInputMeters(demSettings.maxFt) : ds.max;
    const range = (hi - lo) || 1;
    const cmap = COLORMAPS[demSettings.cmap] || COLORMAPS.viridis;
    const steps = demSettings.steps | 0;
    const shade = demSettings.shade > 0;
    for (let y = 0; y < outH; y++) {
      const lat = lats[y];
      for (let x = 0; x < outW; x++) {
        const o = (y * outW + x) * 4;
        const en = latLonToUtm(lat, lons[x]);
        const px = Math.floor((en[0] - winMinE) * invW);
        const py = Math.floor((winMaxN - en[1]) * invH);
        if (px < 0 || py < 0 || px >= rw || py >= rh) { data[o+3] = 0; continue; }
        const v = band[py * rw + px];
        const bad = !isFinite(v) || v === nodata || v < -1000;
        if (bad) { data[o+3] = 0; continue; }
        let t = (v - lo) / range;
        if (steps > 0) t = (Math.floor(t * steps) + 0.5) / steps;   // discrete elevation bands
        const rgb = sampleCmap(cmap, t);
        const z = (!shade || px === 0 || py === 0 || px === rw-1 || py === rh-1)
          ? 1 : hillshadeFactor(band, rw, rh, px, py, 1 / invW, 1 / invH, nodata);
        data[o]   = Math.min(255, rgb[0] * z);
        data[o+1] = Math.min(255, rgb[1] * z);
        data[o+2] = Math.min(255, rgb[2] * z);
        data[o+3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return cvs;
}

function renderOrthoTile(raster, w, h, ds, warp) {
  if (warp && warp.lats) return warpedSampleGrid(raster, w, h, warp.winMinE, warp.winMaxE, warp.winMaxN, warp.winMinN, warp.lats, warp.lons, warp.outW, warp.outH, ds);
  // axis-aligned fallback (unwarped source rect, e.g. legacy call sites)
  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(w, h);
  const r = raster[0], g = raster[1] || raster[0], b = raster[2] || raster[0];
  const a = raster.length >= 4 ? raster[3] : null;
  for (let i = 0; i < w * h; i++) {
    img.data[i*4] = r[i]; img.data[i*4+1] = g[i]; img.data[i*4+2] = b[i];
    img.data[i*4+3] = a ? a[i] : (isRgbNoData(r[i], g[i], b[i], ds.nodata) ? 0 : 255);
  }
  ctx.putImageData(img, 0, 0);
  return cvs;
}

function renderDemTile(raster, w, h, ds, warp) {
  if (warp && warp.lats) return warpedSampleGrid(raster, w, h, warp.winMinE, warp.winMaxE, warp.winMaxN, warp.winMinN, warp.lats, warp.lons, warp.outW, warp.outH, ds);
  // axis-aligned fallback (unwarped source rect)
  const band = raster[0];
  const nodata = isNaN(ds.nodata) ? -9999 : ds.nodata;
  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(w, h);
  const lo = demSettings.minFt != null ? elevationInputMeters(demSettings.minFt) : ds.min;
  const hi = demSettings.maxFt != null ? elevationInputMeters(demSettings.maxFt) : ds.max;
  const range = (hi - lo) || 1;
  const cmap = COLORMAPS[demSettings.cmap] || COLORMAPS.viridis;
  const steps = demSettings.steps | 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = band[i];
      const bad = !isFinite(v) || v === nodata || v < -1000;
      if (bad) { img.data[i*4+3] = 0; continue; }
      let t = (v - lo) / range;
      if (steps > 0) t = (Math.floor(t * steps) + 0.5) / steps;
      const rgb = sampleCmap(cmap, t);
      const z = (demSettings.shade <= 0 || x === 0 || y === 0 || x === w-1 || y === h-1)
        ? 1 : hillshadeFactor(band, w, h, x, y,
          (ds.maxE - ds.minE) / w, (ds.maxN - ds.minN) / h, nodata);
      img.data[i*4] = Math.min(255, rgb[0] * z);
      img.data[i*4+1] = Math.min(255, rgb[1] * z);
      img.data[i*4+2] = Math.min(255, rgb[2] * z);
      img.data[i*4+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cvs;
}

// Build a per-pixel WARPED overview canvas covering the true 4-corner lat/lon footprint.
// The raster is UTM-axis-aligned but the site has -1.11 deg grid convergence, so imageOverlay
// can only be pixel-accurate if we pre-warp every pixel into Web-Mercator space here.
// Rows are linear in MERCATOR y (merc(lat) = ln(tan(pi/4 + lat*pi/360))), which is exactly
// how imageOverlay stretches the image; cols are linear in lon.
async function overviewCanvas(ds, renderFn, maxDim = 1400, signal = null) {
  throwIfAborted(signal);
  // source overview selection (+ recolor cache in ds._ovCache so applyDemSettings skips the fetch)
  let idx = ds.images.length - 1;
  for (let i = 0; i < ds.images.length; i++) {
    const im = ds.images[i];
    if (Math.max(im.getWidth(), im.getHeight()) <= maxDim) { idx = i; break; }
  }
  let raster, rw, rh;
  if (ds._ovCache) {
    ({ raster, w: rw, h: rh } = ds._ovCache);
  } else {
    const im = ds.images[idx];
    raster = await im.readRasters({ pool: geoPool, interleave: false, signal });
    throwIfAborted(signal);
    rw = im.getWidth(); rh = im.getHeight();
    ds._ovCache = { raster, w: rw, h: rh };
  }
  // true lat/lon footprint: min/max over the 4 warped UTM corners
  const c = ds.llCorners;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of c) {
    if (p[0] < minLat) minLat = p[0]; if (p[0] > maxLat) maxLat = p[0];
    if (p[1] < minLon) minLon = p[1]; if (p[1] > maxLon) maxLon = p[1];
  }
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const invMerc = (m) => (2 * Math.atan(Math.exp(m)) - Math.PI / 2) * 180 / Math.PI;
  const mTop = merc(maxLat), mBot = merc(minLat);
  // aspect-true target size: width ~ maxDim, height from mercator/lon ratio
  const outW = maxDim;
  const outH = Math.max(16, Math.round(outW * (mTop - mBot) / ((maxLon - minLon) * Math.PI / 180)));
  const lats = new Float64Array(outH), lons = new Float64Array(outW);
  for (let y = 0; y < outH; y++) lats[y] = invMerc(mTop - (mTop - mBot) * (y + 0.5) / outH);
  for (let x = 0; x < outW; x++) lons[x] = minLon + (maxLon - minLon) * (x + 0.5) / outW;
  const winMinE = ds.minE, winMaxE = ds.maxE, winMinN = ds.minN, winMaxN = ds.maxN;
  const canvas = warpedSampleGrid(raster, rw, rh, winMinE, winMaxE, winMaxN, winMinN, lats, lons, outW, outH, ds);
  return { canvas, bounds: [[minLat, minLon], [maxLat, maxLon]] };
}

async function showOrtho(epoch = modeEpoch, signal = modeAbortController?.signal) {
  updateStatus('Mode: Orthophoto');
  try {
    if (!orthoLayers) {
      updateLoading('Opening orthophoto (streaming)...', '');
      const ds = await getDataset(ORTHO_URL, false, { signal });
      if (epoch !== modeEpoch || state.activeMode !== 'ortho') return;
      const ov = await overviewCanvas(ds, renderOrthoTile, 3400, signal);
      if (epoch !== modeEpoch || state.activeMode !== 'ortho') return;
      const overlay = L.imageOverlay(ov.canvas.toDataURL('image/png'), ov.bounds, { opacity: 1 });
      const grid = new GeoTiffGridLayer(ds, renderOrthoTile, {
        tileSize: 256, minZoom: 12, maxZoom: 28, bounds: L.latLngBounds(ds.llBounds), updateWhenZooming: false, keepBuffer: 2, pane: 'gtiff', signal
      });
      orthoLayers = { overlay, grid, ds };
      if (epoch === modeEpoch) hideLoading();
    }
    if (epoch !== modeEpoch || state.activeMode !== 'ortho') return;
    orthoLayers.grid.setAbortSignal(signal);
    orthoLayers.overlay.addTo(map);
    orthoLayers.grid.addTo(map);
    restoreOrFit('ortho', orthoLayers.ds.llBounds);
    applyOrthoOpacity();
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted || epoch !== modeEpoch || state.activeMode !== 'ortho') return;
    console.error('[viewer-runtime] orthophoto initialization failed');
    hideLoading();
    showError('Could not stream the orthophoto GeoTIFF.');
  }
}

async function showDEM(type, epoch = modeEpoch, signal = modeAbortController?.signal) {
  updateStatus(`Mode: ${type.toUpperCase()}`);
  const url = type === 'dsm' ? DSM_URL : DTM_URL;
  try {
    if (!demLayers[type]) {
      updateLoading(`Opening ${type.toUpperCase()} (streaming)...`, '');
      const ds = await getDataset(url, true, { signal });
      if (epoch !== modeEpoch || state.activeMode !== type) return;
      const ov = await overviewCanvas(ds, renderDemTile, 2048, signal);
      if (epoch !== modeEpoch || state.activeMode !== type) return;
      const overlay = L.imageOverlay(ov.canvas.toDataURL('image/png'), ov.bounds, { opacity: 1 });
      const grid = new GeoTiffGridLayer(ds, renderDemTile, {
        tileSize: 256, minZoom: 12, maxZoom: 28, bounds: L.latLngBounds(ds.llBounds), opacity: 1, updateWhenZooming: false, keepBuffer: 2, pane: 'gtiff', signal
      });
      demLayers[type] = { overlay, grid, ds };
      syncMapVolumeAvailability();
      if (epoch === modeEpoch) hideLoading();
    }
    if (epoch !== modeEpoch || state.activeMode !== type) return;
    const dl = demLayers[type];
    dl.grid.setAbortSignal(signal);
    dl.overlay.addTo(map);
    dl.grid.addTo(map);
    restoreOrFit(type, dl.ds.llBounds);
    dom.demLegend.style.display = 'flex';
    applyDemOpacity();
    refreshLegendFor(dl.ds);
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted || epoch !== modeEpoch || state.activeMode !== type) return;
    console.error(`[viewer-runtime] ${type.toUpperCase()} initialization failed`);
    hideLoading();
    showError(`Could not stream the ${type.toUpperCase()} GeoTIFF.`);
  }
}

function restoreOrFit(mode, bounds) {
  if (mapViews[mode]) {
    map.setView(mapViews[mode].center, mapViews[mode].zoom, { animate: false });
  } else {
    map.fitBounds(bounds, { padding: [20, 20] });
  }
}

function rememberMapView(mode) {
  if (map && (mode === 'ortho' || mode === 'dsm' || mode === 'dtm')) {
    mapViews[mode] = { center: map.getCenter(), zoom: map.getZoom() };
  }
}

function refreshLegendFor(ds) {
  const lo = demSettings.minFt != null ? elevationInputMeters(demSettings.minFt) : ds.min;
  const hi = demSettings.maxFt != null ? elevationInputMeters(demSettings.maxFt) : ds.max;
  updateLegend(lo, hi, demSettings.steps | 0);
}

function applyOrthoOpacity() {
  if (!orthoLayers) return;
  const v = parseInt(document.getElementById('ortho-opacity').value, 10) / 100;
  orthoLayers.overlay.setOpacity(v);
  orthoLayers.grid.setOpacity(v);
}

function applyDemOpacity() {
  const v = parseInt(document.getElementById('dem-opacity').value, 10) / 100;
  ['dsm', 'dtm'].forEach((t) => {
    if (demLayers[t]) { demLayers[t].overlay.setOpacity(v); demLayers[t].grid.setOpacity(v); }
  });
}

const demUpdateQueue = createDemUpdateQueue(applyDemSettings, { onError: (error) => {
  if (error?.name !== 'AbortError') showError('Could not update elevation colors. Try Reset to defaults.');
} });

async function applyDemSettings(isCurrent = () => true) {
  const signal = modeAbortController?.signal;
  demSettings.cmap = dom.demColormap.value;
  demSettings.shade = parseFloat(dom.demShading.value);
  const mn = dom.demMin.value.trim(), mx = dom.demMax.value.trim();
  const min = mn === '' ? null : Number(mn), max = mx === '' ? null : Number(mx);
  if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max)) || (min !== null && max !== null && min >= max)) return;
  demSettings.minFt = min;
  demSettings.maxFt = max;
  demSettings.steps = parseInt(document.getElementById('dem-steps').value, 10) || 0;

  for (const t of ['dsm', 'dtm']) {
    const dl = demLayers[t];
    if (!dl) continue;
    const ov = await overviewCanvas(dl.ds, renderDemTile, 2048, signal);   // warped; raster from ds._ovCache
    if (!isCurrent() || signal?.aborted) return;
    dl.overlay.setUrl(ov.canvas.toDataURL('image/png'));
    dl.grid.redraw();
  }
  const active = state.activeMode === 'dtm' ? demLayers.dtm : demLayers.dsm;
  if (active) refreshLegendFor(active.ds);
  applyDemOpacity();
}

function resetDemSettings() {
  dom.demColormap.value = 'viridis';
  dom.demShading.value = '1';
  document.getElementById('dem-shading-val').textContent = '1.0';
  dom.demMin.value = '';
  dom.demMax.value = '';
  document.getElementById('dem-steps').value = '0';
  document.getElementById('dem-opacity').value = '100';
  document.getElementById('dem-opacity-val').textContent = '100%';
  applyDemOpacity();
  demUpdateQueue.request({ immediate: true });
}

function removeMapOverlays() {
  if (!map) return;
  [orthoLayers, demLayers.dsm, demLayers.dtm].forEach((l) => {
    if (l) { map.removeLayer(l.overlay); map.removeLayer(l.grid); }
  });
  if (mapCameraLayer && map.hasLayer(mapCameraLayer)) map.removeLayer(mapCameraLayer);
}

function showDemHover(e, layer) {
  const ds = layer.ds || layer;
  if (!ds.images) return;
  const { lat, lng } = e.latlng;
  const [E, N] = latLonToUtm(lat, lng);
  if (E < ds.minE || E > ds.maxE || N < ds.minN || N > ds.maxN) { dom.demHover.style.display = 'none'; return; }
  const lvl = Math.min(2, ds.images.length - 1);
  const img = ds.images[lvl];
  const s = img.getWidth() / ds.W;
  const px = Math.floor((E - ds.minE) / (ds.maxE - ds.minE) * ds.W * s);
  const py = Math.floor((ds.maxN - N) / (ds.maxN - ds.minN) * ds.H * s);
  const signal = modeAbortController?.signal;
  img.readRasters({ window: [px, py, px + 1, py + 1], pool: geoPool, signal }).then((r) => {
    const v = r[0][0];
    if (isFinite(v) && v > -1000 && v !== ds.nodata) {
      dom.demHover.textContent = `Elevation: ${formatElevation(v, DISPLAY_UNITS)}`;
      dom.demHover.style.display = 'block';
    } else dom.demHover.style.display = 'none';
  }).catch(() => {});
}

// Legend: top = max elevation. Continuous mode (steps=0) draws a smooth gradient with
// 5 evenly-spaced ft labels; banded mode (steps>0) draws solid color blocks and labels
// the band BOUNDARIES (steps+1 labels, thinned to every other when steps > 8) so the
// label count matches the renderer's quantization exactly.
function updateLegend(minM, maxM, steps) {
  const ctx = dom.legendCanvas.getContext('2d');
  const H = dom.legendCanvas.height, W = dom.legendCanvas.width;
  const cmap = COLORMAPS[demSettings.cmap] || COLORMAPS.viridis;
  steps = steps | 0;
  if (steps > 0) {
    const bandH = H / steps;
    for (let b = 0; b < steps; b++) {
      // canvas row order is top=high: band index from top corresponds to high t first
      const t = ((steps - b) - 0.5) / steps;
      const rgb = sampleCmap(cmap, t);
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.fillRect(0, Math.round(b * bandH), W, Math.ceil(bandH));
    }
    const every = steps > 8 ? 2 : 1;
    const spans = [];
    for (let k = steps; k >= 0; k -= 1) {
      const elevation = minM + (maxM - minM) * k / steps;
      spans.push(k % every === 0 || k === 0 ? `<span>${formatElevation(elevation, DISPLAY_UNITS)}</span>` : '<span>&nbsp;</span>');
    }
    dom.demLegendLabels.innerHTML = spans.join('');
  } else {
    for (let y = 0; y < H; y++) {
      const t = 1 - y / H;
      const rgb = sampleCmap(cmap, t);
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.fillRect(0, y, W, 1);
    }
    const ticks = [1, 0.75, 0.5, 0.25, 0].map((u) => minM + (maxM - minM) * u);
    dom.demLegendLabels.innerHTML = ticks.map((elevation) => `<span>${formatElevation(elevation, DISPLAY_UNITS)}</span>`).join('');
  }
}

// UTM <-> WGS84. The active projection carries the imported zone central
// meridian and hemisphere, including southern UTM false northing.
function utmToLatLon(e, n) {
  return UTM_PROJECTION.utmToLatLon(e, n);
}

function latLonToUtm(latDeg, lonDeg) {
  return UTM_PROJECTION.latLonToUtm(latDeg, lonDeg);
}

// WebODM-style colormaps (matplotlib equivalents WebODM offers for DEM layers)
const COLORMAPS = {
  viridis: [
    [0.00,68,1,84],[0.05,72,33,115],[0.10,67,62,133],[0.15,56,88,140],[0.20,45,113,142],
    [0.25,37,137,141],[0.30,33,161,135],[0.40,41,184,127],[0.50,66,206,113],[0.60,97,225,96],
    [0.70,134,238,78],[0.80,172,244,64],[0.90,210,247,62],[1.00,253,231,37]
  ],
  jet: [
    [0.00,0,0,131],[0.125,0,60,170],[0.375,5,255,255],[0.625,255,255,0],
    [0.875,250,0,0],[1.00,128,0,0]
  ],
  terrain: [
    [0.00,51,51,153],[0.15,0,120,255],[0.25,0,204,102],[0.50,255,255,102],
    [0.75,153,102,51],[1.00,255,255,255]
  ],
  gray: [[0.00,0,0,0],[1.00,255,255,255]],
  plasma: [
    [0.00,13,8,135],[0.15,84,2,163],[0.30,139,10,165],[0.45,185,50,137],
    [0.60,219,92,104],[0.75,244,136,73],[0.90,254,188,43],[1.00,240,249,33]
  ],
  rdylgn: [
    [0.00,165,0,38],[0.20,215,48,39],[0.35,253,174,97],[0.50,255,255,191],
    [0.65,166,217,106],[0.80,102,189,99],[1.00,0,104,55]
  ]
};

function sampleCmap(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const A = stops[i-1], B = stops[i];
      const p = (t - A[0]) / ((B[0] - A[0]) || 1);
      return [Math.round(A[1]+(B[1]-A[1])*p), Math.round(A[2]+(B[2]-A[2])*p), Math.round(A[3]+(B[3]-A[3])*p)];
    }
  }
  const L = stops[stops.length - 1];
  return [L[1], L[2], L[3]];
}

function viridis(t) { return sampleCmap(COLORMAPS.viridis, t); }

function hillshadeFactor(values, w, h, x, y, cellX = 1, cellY = 1, nodata = NaN) {
  if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return 1;
  // Elevations and this viewer's UTM raster extents are both metres. Horn's
  // gradient must divide by the ACTUAL source-level cell spacing, not assume
  // metre-wide pixels: that flattens centimetre DSM relief and varies by zoom.
  if (!(cellX > 0) || !Number.isFinite(cellX) || !(cellY > 0) || !Number.isFinite(cellY)) return 1;
  const center = values[y * w + x];
  if (!Number.isFinite(center) || center === nodata || center < -1000) return 1;
  const z = (a, b) => {
    const v = values[b * w + a];
    // Do not turn masked holes into cliffs or poison valid pixels with NaN.
    return Number.isFinite(v) && v !== nodata && v >= -1000 ? v : center;
  };
  const A = z(x-1,y-1), B = z(x,y-1), Cc = z(x+1,y-1);
  const D = z(x-1,y), F = z(x+1,y);
  const G = z(x-1,y+1), Hh = z(x,y+1), J = z(x+1,y+1);
  const dzdx = ((Cc + 2*F + J) - (A + 2*D + G)) / (8 * cellX);
  const dzdy = ((G + 2*Hh + J) - (A + 2*B + Cc)) / (8 * cellY);
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  // Raster rows increase SOUTH; azimuth is clockwise from NORTH. Dot the
  // north-up surface normal with a north-west light, avoiding a mirrored aspect.
  const hs = (Math.sin(alt) + Math.cos(alt) * (-dzdx * Math.sin(az) + dzdy * Math.cos(az)))
    / Math.sqrt(1 + dzdx * dzdx + dzdy * dzdy);
  const k = Math.min(2, Math.max(0, demSettings.shade));
  // k=0 flat color, k=1 default relief, k=2 strong relief
  const base = 1 - 0.45 * k;
  return base + 0.45 * k * Math.max(0, hs);
}

// ────────────────────────────────────────────────
// Direct point cloud fallback (raw georeferenced LAZ/PLY loaded into the
// SAME three.js scene/controls as the mesh tab — used when a project has no
// pre-built Potree EPT dataset yet; see README "Known limitations"). LAZ is
// WebODM's current default point-cloud export and needs loaders.gl's
// LASLoader (three.js has no built-in LAS/LAZ support); PLY uses three's own
// PLYLoader. NOTE: @loaders.gl/las only supports LAS/LAZ up to spec v1.3.
// ────────────────────────────────────────────────
function loadPointCloudDirect() {
  if (state.pointCloudLoaded || state.pointCloudLoading || !POINT_CLOUD_URL) return;
  const attempt = { controller: new AbortController(), request: null, cancelled: false };
  directPointCloudLoad = attempt;
  state.pointCloudLoading = true;
  const isLaz = POINT_CLOUD_FORMAT === 'laz' || /\.la[sz]$/i.test(POINT_CLOUD_URL);
  const label = isLaz ? 'LAZ' : 'PLY';
  updateLoading(`Loading point cloud (${label})...`, '');
  viewerDiagnostic('pointcloud_start', { mode: 'cloud', stage: 'fetch' });

  const onFail = (err) => {
    if (attempt.cancelled || directPointCloudLoad !== attempt || err?.name === 'AbortError') return;
    console.error('[viewer-runtime] direct point-cloud load failed');
    viewerDiagnostic('pointcloud_failure', { mode: 'cloud', code: 'runtime_error', stage: 'decode' });
    state.pointCloudLoading = false;
    directPointCloudLoad = null;
    hideLoading();
    showError(`Failed to load the point cloud. Retry the Point Cloud view or check browser diagnostics with reference ${DIAGNOSTIC_CORRELATION_ID.slice(0, 8)}.`);
  };
  const onGeometryReady = (geometry) => {
    if (attempt.cancelled || directPointCloudLoad !== attempt || state.activeMode !== 'cloud') {
      geometry?.dispose?.();
      return;
    }
    try {
      const sourcePositions = geometry.getAttribute('position')?.array;
      if (!sourcePositions) throw new Error(`${label} file had no POSITION attribute`);
      if (!geometry.userData.pointPositionsLocalized) {
        const localized = localizePointPositions(sourcePositions, RTC);
        geometry.setAttribute('position', new THREE.BufferAttribute(localized.positions, 3));
      }
      // PLYLoader computes its bounds before we replace absolute UTM POSITION
      // with localized coordinates. Recompute the sphere as well: leaving the
      // stale UTM-scale sphere makes Three.js frustum-cull an otherwise valid
      // cloud millions of metres away from the fitted camera.
      refreshPointGeometryBounds(geometry);
      // Keep direct-cloud points visible across survey scales and high-DPI
      // displays. A fixed 0.03-world-unit point became sub-pixel at the fitted
      // overview camera (a successfully loaded cloud looked entirely black).
      // Potree also defaults to fixed screen-space sizing; two pixels is small
      // enough for dense clouds while remaining visibly testable when sparse.
      const mat = new THREE.PointsMaterial({
        size: 2,
        sizeAttenuation: false,
        vertexColors: geometry.hasAttribute('color'),
      });
      pointCloudObject = new THREE.Points(geometry, mat);
      // Keep the offset group as an explicit reference. A production-browser
      // smoke test caught the name lookup returning undefined during the async
      // PLY completion callback, leaving the loading overlay stuck at 100%.
      pointCloudOffset.add(pointCloudObject);
      // Direct clouds do not have Potree's fitToScreen path. Fit the shared
      // camera after the cloud has entered its complete RTC/C/world transform;
      // otherwise the fixed mesh-oriented home view can look at empty space
      // and make a successfully decoded cloud appear as a black canvas.
      pointCloudParent.updateMatrixWorld(true);
      if (state.activeMode === 'cloud' && state.cloudMode === 'direct') {
        frameObjectHome(pointCloudObject, { apply: !lastShared3DView });
      }
      state.pointCloudLoaded = true;
      state.pointCloudLoading = false;
      directPointCloudLoad = null;
      viewerDiagnostic('pointcloud_ready', { mode: 'cloud', stage: 'nodes' });
      hideLoading();
    } catch (err) {
      onFail(err);
    }
  };

  if (isLaz) {
    loadersGlLoad(POINT_CLOUD_URL, LASLoader, {
      // Preserve the absolute UTM values until they have been rebased to the
      // local RTC frame. Decoding straight to Float32 loses fine detail at
      // multi-million-metre northings before the GPU ever sees the points.
      las: { colorDepth: 8, fp64: true },
      fetch: { signal: attempt.controller.signal },
    }).then((data) => {
      if (attempt.cancelled || directPointCloudLoad !== attempt) return;
      const positions = data.attributes.POSITION && data.attributes.POSITION.value;
      if (!positions) throw new Error('LAZ/LAS file had no POSITION attribute');
      const geometry = new THREE.BufferGeometry();
      const localized = localizePointPositions(positions, RTC);
      geometry.setAttribute('position', new THREE.BufferAttribute(localized.positions, 3));
      const colorAttr = data.attributes.COLOR_0 && data.attributes.COLOR_0.value;
      if (colorAttr && colorAttr.length) {
        const pointCount = positions.length / 3;
        const itemSize = colorAttr.length / pointCount;   // 3 (RGB) or 4 (RGBA)
        const colors = new Float32Array(pointCount * 3);
        for (let i = 0; i < pointCount; i++) {
          colors[i * 3] = colorAttr[i * itemSize] / 255;
          colors[i * 3 + 1] = colorAttr[i * itemSize + 1] / 255;
          colors[i * 3 + 2] = colorAttr[i * itemSize + 2] / 255;
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      }
      // Already localized above while the decoder's Float64 precision was
      // still available. Avoid running the heuristic a second time.
      geometry.userData.pointPositionsLocalized = true;
      onGeometryReady(geometry);
    }).catch(onFail);
  } else {
    attempt.request = new PLYLoader().load(POINT_CLOUD_URL, onGeometryReady, (xhr) => {
      if (!attempt.cancelled && directPointCloudLoad === attempt && xhr.total) {
        updateLoading(`Loading point cloud (${label})...`, `${((xhr.loaded / xhr.total) * 100).toFixed(0)}%`);
      }
    }, onFail);
  }
}

function stopDirectPointCloud(reason = 'superseded') {
  const hadRuntime = Boolean(directPointCloudLoad || pointCloudObject);
  if (directPointCloudLoad) {
    directPointCloudLoad.cancelled = true;
    directPointCloudLoad.controller.abort();
    directPointCloudLoad.request?.abort?.();
    directPointCloudLoad = null;
    state.pointCloudLoading = false;
    hideLoading();
  }
  if (pointCloudObject) {
    pointCloudOffset.remove(pointCloudObject);
    pointCloudObject.geometry?.dispose?.();
    const materials = Array.isArray(pointCloudObject.material) ? pointCloudObject.material : [pointCloudObject.material];
    materials.forEach((material) => material?.dispose?.());
    pointCloudObject = null;
    state.pointCloudLoaded = false;
  }
  if (pointCloudParent) pointCloudParent.visible = false;
  if (hadRuntime) viewerDiagnostic('pointcloud_stop', { mode: 'cloud', reason });
}

// ────────────────────────────────────────────────
// Point cloud (Potree in an isolated iframe) — used when this project has a
// pre-built EPT dataset from an imported task. Config is passed via the
// iframe's query string so pointcloud.html has no hardcoded project data.
// ────────────────────────────────────────────────
function showPointCloud() {
  if (!state.pcIframeLoaded) {
    const iframe = document.createElement('iframe');
    iframe.id = 'pc-iframe';
    const params = new URLSearchParams({ ept: EPT_URL || '', title: (PROJECT && PROJECT.title) || '' });
    if (VIEW_MODE === 'session') params.set('renewal', 'session');
    params.set('units', DISPLAY_UNITS);
    params.set('correlation', DIAGNOSTIC_CORRELATION_ID);
    params.set('revision', VIEWER_BUILD_REVISION);
    if (POINT_COUNT) params.set('points', String(POINT_COUNT));
    iframe.src = `/pointcloud.html?${params.toString()}`;
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;background:#050505;';
    dom.cloudContainer.appendChild(iframe);
    state.pcIframeLoaded = true;
    iframe.dataset.correlationId = DIAGNOSTIC_CORRELATION_ID;
    viewerDiagnostic('pointcloud_start', { mode: 'cloud', stage: 'startup' });
  }
  dom.cloudStatus.textContent = sessionAccessLabel('Cloud') || 'Cloud: connecting…';
}

function stopPointCloudIframe(reason = 'superseded') {
  const iframe = document.getElementById('pc-iframe');
  if (!iframe) return;
  try { pcApi()?.cancel?.(); } catch { /* iframe may already be unloading */ }
  iframe.src = 'about:blank';
  iframe.remove();
  state.pcIframeLoaded = false;
  pcCameraSyncedWindow = null;
  dom.cloudStatus.textContent = 'Cloud: idle';
  viewerDiagnostic('pointcloud_stop', { mode: 'cloud', reason });
}

window.addEventListener('message', (event) => {
  const iframe = document.getElementById('pc-iframe');
  if (!iframe || event.origin !== location.origin || event.source !== iframe.contentWindow) return;
  const message = event.data;
  if (!message || message.source !== 'ltds-pointcloud') return;
  if (message.correlationId !== iframe.dataset.correlationId) return;
  if (message.type === 'ready' && message.code === 'points_visible') {
    dom.cloudStatus.textContent = sessionAccessLabel('Cloud')
      || (POINT_COUNT ? `Cloud: ${(POINT_COUNT / 1e6).toFixed(0)}M pts ready` : 'Cloud: ready');
    viewerDiagnostic('pointcloud_ready', { mode: 'cloud', stage: 'nodes' });
    applyPcPanelState();
    if (pendingPointCloudView) pushViewToPointCloud(pendingPointCloudView);
    syncCameraLayer();
  } else if (message.type === 'camera-open') {
    if (!state.camerasVisible || !SHARE_PERMISSIONS.cameras
      || !Number.isSafeInteger(message.index) || message.index < 0 || message.index >= camFeatures.length) return;
    openPhoto(message.index);
  } else if (message.type === 'error') {
    const code = POINT_CLOUD_FAILURE_CODES.has(message.code) ? message.code : 'runtime_error';
    const stage = DIAGNOSTIC_STAGES.has(message.stage) ? message.stage : 'runtime';
    dom.cloudStatus.textContent = `Cloud: unavailable (${code}; ref ${DIAGNOSTIC_CORRELATION_ID.slice(0, 8)})`;
    viewerDiagnostic('pointcloud_failure', { mode: 'cloud', code, stage });
    if (VIEW_MODE === 'session' && code === 'authorization_required') {
      recordSessionAccessFailure('pointcloud');
      if (!sessionRenewalPending && !requestSessionRenewal('pointcloud-authorization')) pcApi()?.accessUnavailable?.();
      dom.cloudStatus.textContent = sessionAccessLabel('Cloud') || 'Cloud: renewing access';
    } else if (VIEW_MODE === 'session' && code === 'authorization_unavailable') {
      dom.cloudStatus.textContent = 'Cloud: access unavailable — reopen this model from the Viewer workspace';
    }
  }
});

// Bridge to the Potree iframe's control API (null until the iframe is ready)
function pcApi() {
  const f = document.getElementById('pc-iframe');
  const w = f && f.contentWindow;
  return (w && w.__pcApi) ? w.__pcApi : null;
}

function syncCameraLayer() {
  if (!camGroupParent) return false;
  const localVisible = state.camerasVisible
    && (state.activeMode === 'model' || (state.activeMode === 'cloud' && state.cloudMode === 'direct'));
  camGroupParent.visible = localVisible;
  if (localVisible) refreshCameraMarkerScales(true);
  const button = document.getElementById('layer-cameras');
  if (button) {
    button.classList.toggle('active', state.camerasVisible);
    button.textContent = state.camerasVisible ? 'Hide' : 'Show';
    button.setAttribute('aria-label', state.camerasVisible ? 'Hide camera positions' : 'Show camera positions');
    button.setAttribute('aria-pressed', String(state.camerasVisible));
  }
  const sizeRow = document.getElementById('cam-size-row');
  if (sizeRow) sizeRow.style.display = state.camerasVisible ? 'flex' : 'none';
  if (state.camerasVisible && !state.camerasLoaded && !state.camerasLoading) {
    loadCameras();
    return false;
  }
  refreshMapCameraLayer();
  if (state.activeMode !== 'cloud' || state.cloudMode !== 'potree') return true;
  const iframe = document.getElementById('pc-iframe');
  const api = pcApi();
  if (!iframe?.contentWindow || !api) return false;
  if (state.camerasLoaded && pcCameraSyncedWindow !== iframe.contentWindow) {
    const cameraPayload = camFeatures.map((feature) => ({
      translation: feature.properties.translation.slice(),
      rotation: feature.properties.rotation.slice(),
    }));
    if (api.setCameras(cameraPayload) !== cameraPayload.length) return false;
    pcCameraSyncedWindow = iframe.contentWindow;
  }
  api.setCameraScale(parseFloat(document.getElementById('cam-size')?.value || String(DEFAULT_CAMERA_MARKER_SCALE)));
  api.setCameraVisibility(state.camerasVisible);
  return true;
}

// Keep color-range intent in the parent: Potree is destroyed when hidden.
// State is scoped to a model, while values are always canonical world metres.
let pcElevationModelId = null;
let pcElevationRange = null;
let pcElevationDomain = null;

function syncPcElevationControls({ keepTypedValues = false } = {}) {
  if (pcElevationModelId !== PROJECT?.id) {
    pcElevationModelId = PROJECT?.id;
    pcElevationRange = null;
    pcElevationDomain = null;
  }
  const wrap = document.getElementById('pc2-elevation-controls');
  if (!wrap) return;
  wrap.hidden = document.getElementById('pc2-color').value !== 'elevation';
  const suffix = DISPLAY_UNITS === 'metric' ? 'm' : 'ft';
  const factor = DISPLAY_UNITS === 'metric' ? 1 : METERS_TO_FT;
  document.getElementById('pc2-elevation-min-label').textContent = `Min ${suffix}`;
  document.getElementById('pc2-elevation-max-label').textContent = `Max ${suffix}`;
  const snapshot = pcApi()?.getElevationState?.();
  const ready = snapshot?.available && snapshot?.range && snapshot?.bounds;
  for (const id of ['min', 'max', 'low', 'high', 'reset']) {
    document.getElementById(`pc2-elevation-${id}`).disabled = !ready;
  }
  if (!ready) {
    document.getElementById('pc2-elevation-status').textContent = 'Waiting for point-cloud elevation bounds.';
    return;
  }
  const range = snapshot.range;
  pcElevationDomain = {
    min: Math.min(snapshot.bounds.min, range.min),
    max: Math.max(snapshot.bounds.max, range.max),
  };
  const displayValue = value => String(Number((value * factor).toFixed(6)));
  if (!keepTypedValues) {
    document.getElementById('pc2-elevation-min').value = displayValue(range.min);
    document.getElementById('pc2-elevation-max').value = displayValue(range.max);
  }
  for (const [id, value] of [['low', range.min], ['high', range.max]]) {
    const slider = document.getElementById(`pc2-elevation-${id}`);
    slider.min = displayValue(pcElevationDomain.min);
    slider.max = displayValue(pcElevationDomain.max);
    slider.step = 'any';
    slider.value = displayValue(value);
    slider.setAttribute('aria-valuetext', `${displayValue(value)} ${suffix}`);
  }
  document.getElementById('pc2-elevation-status').textContent = `${snapshot.automatic ? 'Automatic' : 'Custom'} color range: ${formatElevation(range.min, DISPLAY_UNITS)} to ${formatElevation(range.max, DISPLAY_UNITS)}.`;
}

function applyPcElevationInputs(source) {
  const api = pcApi();
  if (!api?.getElevationState?.()?.available) return;
  const minInput = document.getElementById('pc2-elevation-min');
  const maxInput = document.getElementById('pc2-elevation-max');
  let min = elevationInputMeters(minInput.valueAsNumber);
  let max = elevationInputMeters(maxInput.valueAsNumber);
  if (source === 'low' || source === 'high') {
    const current = api.getElevationState().range;
    min = current.min; max = current.max;
    const slider = document.getElementById(`pc2-elevation-${source}`);
    const value = elevationInputMeters(slider.valueAsNumber);
    const gap = Math.max(0.000001, (pcElevationDomain.max - pcElevationDomain.min) * 0.000001);
    if (source === 'low') min = Math.min(value, max - gap);
    else max = Math.max(value, min + gap);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 0.000001
    || !api.setElevationRange(min, max)) {
    document.getElementById('pc2-elevation-status').textContent = 'Enter a finite minimum below the maximum. The last valid colors remain active.';
    return;
  }
  pcElevationRange = { min, max };
  syncPcElevationControls({ keepTypedValues: source === 'number' });
}

function bindPcPanel() {
  const budget = document.getElementById('pc2-budget');
  budget.addEventListener('input', (e) => {
    const m = parseFloat(e.target.value);
    document.getElementById('pc2-budget-val').textContent = m + 'M';
    const api = pcApi(); if (api) api.setBudget(m);   // API takes MILLIONS (clamped 1-20)
  });
  document.getElementById('pc2-size').addEventListener('input', (e) => {
    document.getElementById('pc2-size-val').textContent = parseFloat(e.target.value).toFixed(1);
    const api = pcApi(); if (api) api.setSize(parseFloat(e.target.value));
  });
  // Fixed sizing is deliberately not a user-selectable mode.
  document.getElementById('pc2-color').addEventListener('change', (e) => {
    const api = pcApi(); if (api) api.setColor(e.target.value);
    syncPcElevationControls();
  });
  for (const id of ['min', 'max']) {
    document.getElementById(`pc2-elevation-${id}`).addEventListener('input', () => applyPcElevationInputs('number'));
  }
  for (const id of ['low', 'high']) {
    document.getElementById(`pc2-elevation-${id}`).addEventListener('input', () => applyPcElevationInputs(id));
  }
  document.getElementById('pc2-elevation-reset').addEventListener('click', () => {
    pcElevationRange = null;
    pcApi()?.resetElevationRange?.();
    syncPcElevationControls();
  });
  document.getElementById('pc2-edl').addEventListener('change', (e) => {
    const api = pcApi(); if (api) api.setEDL(e.target.checked);
  });
  document.getElementById('pc2-reset').addEventListener('click', () => {
    document.getElementById('pc2-budget').value = '10';
    document.getElementById('pc2-budget-val').textContent = '10M';
    document.getElementById('pc2-size').value = '1';
    document.getElementById('pc2-size-val').textContent = '1.0';
    document.getElementById('pc2-color').value = 'rgba';
    document.getElementById('pc2-edl').checked = true;
    pcElevationRange = null;
    pcElevationDomain = null;
    pcApi()?.resetElevationRange?.();
    applyPcPanelState();
  });
  document.getElementById('pc2-fit').addEventListener('click', () => {
    const api = pcApi(); if (api) api.fit();
  });
}

// ───────────────────────────────────────────────────────────────
// View sync between 3D mesh tab and Potree point cloud tab
// (WebODM behavior: switching keeps the exact same camera view)
// ───────────────────────────────────────────────────────────────
function getViewTargetWorld() {
  const hit = pickSurface(new THREE.Vector2(0, 0));   // screen center
  if (hit) return hit;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  if (Math.abs(dir.y) > 1e-4) {
    const t = (18 - camera.position.y) / dir.y;
    if (isFinite(t) && t > 0 && t < 20000) return camera.position.clone().addScaledVector(dir, t);
  }
  return camera.position.clone().addScaledVector(dir, 150);
}

function captureMeshView() {
  camera.updateMatrixWorld(true);
  return {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    target: getViewTargetWorld(),
  };
}

function pushViewToPointCloud(snapshot = pendingPointCloudView, retries = 40, epoch = modeEpoch) {
  if (epoch !== modeEpoch || state.activeMode !== 'cloud' || state.cloudMode !== 'potree') return;
  // A newer transfer (or a completed one) makes old retry callbacks obsolete.
  if (!snapshot || snapshot !== pendingPointCloudView) return;
  const f = document.getElementById('pc-iframe');
  const w = f && f.contentWindow;
  if (!w || typeof w.__setViewUTM !== 'function') {
    if (retries > 0) setTimeout(() => pushViewToPointCloud(snapshot, retries - 1, epoch), 250);
    return;
  }
  const exact = snapshot;
  const camU = worldToUtm(exact.position);
  const tgtU = worldToUtm(exact.target);
  try {
    w.__setViewUTM(camU.e, camU.n, camU.alt, tgtU.e, tgtU.n, tgtU.alt);
    pendingPointCloudView = null;
  } catch (err) { /* iframe busy */ }
}

function pullViewFromPointCloud() {
  const f = document.getElementById('pc-iframe');
  const w = f && f.contentWindow;
  if (!w || !w.viewer || !w.__pcViewReady) return;
  try {
    const exact = typeof w.__getViewUTM === 'function' ? w.__getViewUTM() : null;
    const view = w.viewer.scene.view;
    const p = exact?.position || [view.position.x, view.position.y, view.position.z];
    const pivot = view.getPivot();
    const pv = exact?.target || [pivot.x, pivot.y, pivot.z];
    if (![...p, ...pv].every(Number.isFinite)) return;
    const camW = utmToWorld(p[0], p[1], p[2]);
    const tgtW = utmToWorld(pv[0], pv[1], pv[2]);
    if (camW.distanceTo(tgtW) < 0.01) return;
    preserveIncomingModelView = !tilesRenderer?.root;
    controls.setView(camW, tgtW);
    lastShared3DView = { position: camW.clone(), target: tgtW.clone(), quaternion: camera.quaternion.clone() };
  } catch (err) { /* keep current view */ }
}

function rememberShared3DView(mode) {
  if (mode === 'cloud' && state.cloudMode === 'potree') {
    pullViewFromPointCloud();
  } else if (mode === 'model' || (mode === 'cloud' && state.cloudMode === 'direct')) {
    const initialized = mode === 'model' ? Boolean(tilesRenderer?.root) : state.pointCloudLoaded;
    if (!initialized && !lastShared3DView) return;
    lastShared3DView = captureMeshView();
  }
}

function restoreShared3DView() {
  if (!lastShared3DView) return false;
  preserveIncomingModelView = !tilesRenderer?.root;
  controls.setView(lastShared3DView.position, lastShared3DView.target);
  return true;
}

// ───────────────────────────────────────────────────────────────
// UI
// ───────────────────────────────────────────────────────────────
function bindUI() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchMode(btn.dataset.mode, { reason: 'navigation' });
    });
  });
  window.addEventListener('popstate', () => {
    const available = availableViewerModes({
      meshSource: state.meshSource,
      cloudMode: state.cloudMode,
      ortho: Boolean(ORTHO_URL),
      dsm: Boolean(DSM_URL),
      dtm: Boolean(DTM_URL),
    });
    const mode = chooseViewerMode(viewerModeFromUrl(location.href), available);
    if (mode) switchMode(mode, { updateHistory: false, force: true, reason: 'history' });
  });

  // 3D mode is streaming-only. Original GLB/OBJ sources remain downloadable
  // through authenticated Operations actions and are never decoded here.
  document.getElementById('layer-tiles').addEventListener('click', () => {
    if (state.meshSource !== 'tiles') return;
    document.getElementById('layer-tiles').classList.add('active');
    applyMeshLayer();
  });

  // cameras
  document.getElementById('layer-cameras').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    state.camerasVisible = btn.classList.contains('active');
    syncCameraLayer();
    if (!state.camerasVisible) { dom.camTooltip.style.display = 'none'; renderer.domElement.style.cursor = ''; }
  });
  document.getElementById('cam-size').addEventListener('input', (e) => {
    setCameraScale(parseFloat(e.target.value));
  });

  // Ortho / DEM settings
  document.getElementById('ortho-opacity').addEventListener('input', (e) => {
    document.getElementById('ortho-opacity-val').textContent = e.target.value + '%';
    applyOrthoOpacity();
  });
  document.getElementById('dem-opacity').addEventListener('input', (e) => {
    document.getElementById('dem-opacity-val').textContent = e.target.value + '%';
    applyDemOpacity();
  });
  dom.demShading.addEventListener('input', (e) => {
    document.getElementById('dem-shading-val').textContent = parseFloat(e.target.value).toFixed(1);
    demUpdateQueue.request();
  });
  for (const input of [dom.demColormap, document.getElementById('dem-steps')]) input.addEventListener('change', () => demUpdateQueue.request({ immediate: true }));
  for (const input of [dom.demMin, dom.demMax]) input.addEventListener('input', () => demUpdateQueue.request());
  document.getElementById('dem-reset').addEventListener('click', resetDemSettings);
  bindPcPanel();

  // Viewer memory profile. Only the stable mode key is persisted; byte limits
  // stay release-controlled so policy tuning takes effect automatically.
  if (dom.lodMemoryMode) {
    dom.lodMemoryMode.value = lodMemoryMode;
    dom.lodMemoryMode.addEventListener('change', (event) => {
      const nextMode = persistLodMemoryMode(event.target.value);
      event.target.value = nextMode;
      if (nextMode === lodMemoryMode) return;
      lodMemoryMode = nextMode;
      if (!tilesRenderer) return;
      // Recreate the renderer so queue limits, hard admission, and reduced
      // profile state change atomically. Preserve the user's current view.
      preserveIncomingModelView = true;
      disposeTiles();
      loadTiles();
    });
  }

  // LOD detail slider
  document.getElementById('lod-detail').addEventListener('input', (e) => {
    lodStarvationSamples = 0;
    lodPressureClearSamples = 0;
    clearLodPendingAdmission();
    lodStarvedAtDetail = null;
    lodCacheRecoveryActive = false;
    lodPressureView = null;
    if (!tilesRenderer || !lodRuntimeProfileState) return;
    lodRuntimeProfileState.peripheralPressureScale = 1;
    tilesRenderer.__ltdsPeripheralPressureScale = 1;
    tilesRenderer.lruCache.minBytesSize = lodCacheRetentionMinBytes(lodRuntimeProfileState.budget, false);
    const next = resolveLodDetailRequest(lodRuntimeProfileState, lodWarmupComplete, e.target.value);
    if (lodBootstrapPhase !== 'complete') {
      lodRuntimeProfileState.requestedDetail = next.requestedDetail;
      state.lodRuntimeProfile = {
        ...state.lodRuntimeProfile,
        ...lodRuntimeProfileState,
        bootstrapPhase: lodBootstrapPhase,
        errorScale: lodErrorScale,
        starvedAtDetail: null,
      };
      dom.lodStatus.textContent = lodBootstrapPhase === 'root'
        ? 'LOD: loading complete overview'
        : 'LOD: prefetching nearby coverage';
      emitLodDebugSnapshot('detail-change-during-bootstrap', true);
      return;
    }
    if (Number.isFinite(lodLastSettledDetail)) {
      lodLastSettledDetail = Math.min(lodLastSettledDetail, next.activeDetail);
    }
    lodRuntimeProfileState.requestedDetail = next.requestedDetail;
    lodRuntimeProfileState.activeDetail = next.activeDetail;
    lodWarmupComplete = next.warmupComplete;
    tilesRenderer.errorTarget = lodTargetForDetail(next.activeDetail);
    state.lodRuntimeProfile = { ...state.lodRuntimeProfile, ...lodRuntimeProfileState, starvedAtDetail: null };
    const detailPending = lodDetailRequestPending(lodRuntimeProfileState);
    dom.lodStatus.textContent = lodRuntimeProfileState.reduced
      ? `LOD: reduced-memory (Detail ${next.activeDetail}; ${lodRuntimeProfileState.maximumDetail} max)`
      : detailPending ? `LOD: warming (Detail ${next.activeDetail} → ${next.requestedDetail})` : `LOD: Detail ${next.activeDetail}`;
    emitLodDebugSnapshot('detail-change', true);
  });

  document.querySelectorAll('#panel-measure .tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  document.getElementById('tool-clear').addEventListener('click', () => setTool('clear'));
  document.getElementById('map-volume-reference').addEventListener('change', (e) => {
    document.getElementById('map-volume-custom-row').style.display = e.target.value === 'custom' ? 'flex' : 'none';
  });
  document.getElementById('map-volume-surface').addEventListener('change', syncMapVolumeAvailability);

  document.getElementById('btn-reset').addEventListener('click', resetCamera);
  document.getElementById('btn-top').addEventListener('click', topDownView);
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('btn-reset-float').addEventListener('click', resetCamera);
  document.getElementById('btn-fullscreen-float').addEventListener('click', toggleFullscreen);
  document.getElementById('btn-capture-float').addEventListener('click', () => measurementWorkspace?.captureView());
  document.getElementById('btn-model-report').addEventListener('click', () => measurementWorkspace?.openReport());
  if (dom.btnMeasureFloat) {
    dom.btnMeasureFloat.addEventListener('click', () => {
      setTool(state.activeTool === 'none' ? 'distance' : 'none');
    });
  }
  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  installSidebarResize({sidebar,handle:document.getElementById('sidebar-resize'),onResize});
  if (window.matchMedia('(max-width: 1024px)').matches) {
    sidebar.classList.add('collapsed');
    sidebarToggle.setAttribute('aria-expanded', 'false');
  }
  sidebarToggle.addEventListener('click', () => {
    const collapsed = sidebar.classList.toggle('collapsed');
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    setTimeout(onResize, 300);
  });

  dom.photoClose.addEventListener('click', closePhoto);
  dom.photoModal.addEventListener('click', (e) => { if (e.target === dom.photoModal) closePhoto(); });
  bindPhotoViewer();
}

function applyMeshLayer() {
  tilesParent.visible = false;
  glbParent.visible = false;
  if (state.meshSource === 'tiles') {
    tilesParent.visible = true;
    loadTiles();
  }
}

function switchMode(mode, { historyMode = 'push', updateHistory = true, force = false, reason = 'navigation' } = {}) {
  const available = availableViewerModes({
    meshSource: state.meshSource,
    cloudMode: state.cloudMode,
    ortho: Boolean(ORTHO_URL),
    dsm: Boolean(DSM_URL),
    dtm: Boolean(DTM_URL),
  });
  if (!available.includes(mode)) {
    viewerDiagnostic('mode_cancel', { mode, reason: 'unavailable' });
    return false;
  }
  if (!force && state.activeMode === mode) return true;

  rememberMapView(state.activeMode);   // keep the view of the tab we're leaving
  const prevMode = state.activeMode;
  measurementWorkspace?.modeChanged();
  // disarm any active measure tool in the tab we're leaving (measurements persist)
  if (state.activeTool !== 'none') {
    if (prevMode === 'model') { cancelActiveMeasure(); }
    else if (prevMode === 'cloud') { const api = pcApi(); if (api) api.cancel(); }
    else if (isMapMode(prevMode)) { cancelMapMeasure(); }
    state.activeTool = 'none';
    document.querySelectorAll('#panel-measure .tool-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === 'none');
    });
    dom.measureOutput.innerHTML = '';
    if (renderer) renderer.domElement.classList.remove('measuring');
  }

  // Invalidate every asynchronous initializer before the next mode starts.
  // The epoch protects state, while the controller actively cancels GeoTIFF
  // network reads and decoder work rather than merely ignoring late results.
  modeAbortController?.abort();
  modeAbortController = new AbortController();
  mapToolEpoch += 1;
  modeEpoch += 1;
  const modeSignal = modeAbortController.signal;
  hideLoading();
  if (prevMode && prevMode !== mode) {
    viewerDiagnostic('mode_cancel', { mode: prevMode, reason: 'superseded' });
  }
  // Capture every departure from 3D before disposing either renderer, including
  // detours through ortho/DSM/DTM. Map movement never overwrites this snapshot.
  // Startup's nominal mode has not displayed data yet and is not a viewpoint.
  if (reason !== 'startup') rememberShared3DView(prevMode);
  pendingPointCloudView = null;
  if (prevMode === 'model' && prevMode !== mode) {
    tilesParent.visible = false;
    disposeTiles();
  }
  if (prevMode === 'cloud' && prevMode !== mode) {
    if (state.cloudMode === 'potree') stopPointCloudIframe('superseded');
    else stopDirectPointCloud('superseded');
  }
  if (isMapMode(prevMode) && prevMode !== mode) removeMapOverlays();

  state.activeMode = mode;
  document.querySelectorAll('.tab-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });
  if (updateHistory) {
    const nextUrl = viewerModeUrl(location.href, mode);
    history[historyMode === 'replace' ? 'replaceState' : 'pushState'](null, '', nextUrl);
  }
  viewerDiagnostic('mode_start', { mode, reason });
  const is3D = mode === 'model';
  const isPC = mode === 'cloud';
  const isPotreeCloud = isPC && state.cloudMode === 'potree';
  const isDirectCloud = isPC && state.cloudMode === 'direct';
  const volumeButton = document.getElementById('tool-volume');
  volumeButton.disabled = false;
  volumeButton.title = '';
  dom.threeContainer.style.display = (is3D || isDirectCloud) ? 'block' : 'none';
  dom.labelsContainer.style.display = (is3D || isDirectCloud) ? 'block' : 'none';
  dom.cloudContainer.style.display = isPotreeCloud ? 'block' : 'none';
  // Mesh-only counters must not masquerade as live map/cloud performance.
  dom.lodStatus.hidden = !is3D;
  dom.trisStatus.hidden = !is3D;
  dom.leafletMap.style.display = (!is3D && !isPC) ? 'block' : 'none';
  dom.demLegend.style.display = 'none';
  dom.demHover.style.display = 'none';
  dom.camTooltip.style.display = 'none';

  // sidebar panel visibility per tab
  const isDem = mode === 'dsm' || mode === 'dtm';
  // Keep the advanced mesh controls dormant across every viewer transition.
  // Their DOM/listeners remain available if this product choice is revisited.
  document.getElementById('panel-3d-layers').hidden = true;
  document.getElementById('panel-3d-layers').style.display = 'none';
  document.getElementById('panel-camera-positions').style.display = (is3D || isPC || isMapMode(mode)) && SHOTS_URL && SHARE_PERMISSIONS.cameras ? 'block' : 'none';
  document.getElementById('panel-nav').style.display = (is3D || isPC) ? 'block' : 'none';
  document.getElementById('panel-measure').style.display = SHARE_PERMISSIONS.measure ? 'block' : 'none';
  document.getElementById('panel-camera').style.display = is3D ? 'block' : 'none';
  document.getElementById('panel-pc').style.display = isPotreeCloud ? 'block' : 'none';
  document.getElementById('panel-ortho').style.display = mode === 'ortho' ? 'block' : 'none';
  document.getElementById('panel-dem').style.display = isDem ? 'block' : 'none';
  syncMapVolumeAvailability();

  if (is3D) {
    updateStatus('Mode: 3D Model');
    if (pointCloudParent) pointCloudParent.visible = false;
    restoreShared3DView();
    applyMeshLayer();
    onResize();
  } else if (isPotreeCloud) {
    updateStatus('Mode: Point Cloud');
    showPointCloud();
    pendingPointCloudView = lastShared3DView;
    if (pendingPointCloudView) pushViewToPointCloud(pendingPointCloudView);
  } else if (isDirectCloud) {
    updateStatus('Mode: Point Cloud');
    tilesParent.visible = false;
    glbParent.visible = false;
    restoreShared3DView();
    loadPointCloudDirect();
    pointCloudParent.visible = true;
    onResize();
  } else {
    ensureMap();
    removeMapOverlays();
    map.invalidateSize();
    if (mode === 'ortho') showOrtho(modeEpoch, modeSignal);
    else showDEM(mode, modeEpoch, modeSignal);
  }
  syncCameraLayer();
  return true;
}

function applyPcPanelState() {
  const api = pcApi();
  if (!api) return false;
  api.setBudget(parseFloat(document.getElementById('pc2-budget').value));
  api.setSize(parseFloat(document.getElementById('pc2-size').value));
  api.setSizing('fixed');
  api.setColor(document.getElementById('pc2-color').value);
  if (pcElevationModelId !== PROJECT?.id) {
    pcElevationModelId = PROJECT?.id;
    pcElevationRange = null;
  }
  if (pcElevationRange) api.setElevationRange?.(pcElevationRange.min, pcElevationRange.max);
  syncPcElevationControls();
  api.setEDL(document.getElementById('pc2-edl').checked);
  return true;
}

function updateStatus(t) { dom.modeStatus.textContent = t; }
function updateLoading(t, p, cancellable = false) {
  dom.loadingOverlay.classList.remove('hidden');
  dom.loadingText.textContent = t;
  dom.loadingProgress.textContent = p || '';
  dom.loadingCancel.style.display = cancellable ? '' : 'none';
}
function hideLoading() { dom.loadingOverlay.classList.add('hidden'); dom.loadingCancel.style.display = 'none'; }
let errorHideTimer = null;
function hideError() {
  if (errorHideTimer) clearTimeout(errorHideTimer);
  errorHideTimer = null;
  dom.errorPanel.style.display = 'none';
  dom.errorActions.style.display = 'none';
}
function showError(msg, { persistent = false, retry = null, returnToLod = null } = {}) {
  if (errorHideTimer) clearTimeout(errorHideTimer);
  dom.errorMessage.textContent = msg;
  dom.errorPanel.style.display = 'block';
  dom.errorRetry.style.display = retry ? '' : 'none';
  dom.errorLod.style.display = returnToLod ? '' : 'none';
  dom.errorActions.style.display = retry || returnToLod ? 'flex' : 'none';
  dom.errorRetry.onclick = retry ? () => { hideError(); retry(); } : null;
  dom.errorLod.onclick = returnToLod ? () => { hideError(); returnToLod(); } : null;
  if (!persistent || (!retry && !returnToLod)) errorHideTimer = setTimeout(hideError, 10000);
}
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}

// ───────────────────────────────────────────────────────────────
// Render loop
// ───────────────────────────────────────────────────────────────
let statTimer = 0;
function emitLodDebugSnapshot(reason = 'status', force = false) {
  const prospectiveAdmissionBlocked = syncLodPendingAdmission();
  const runtimeProfile = lodRuntimeProfileState
    ? {
      ...lodRuntimeProfileState,
      starvedAtDetail: lodStarvedAtDetail,
      bootstrapPhase: lodBootstrapPhase,
      bootstrapRootTarget: lodBootstrapRootTarget,
      bootstrapCoverageTarget: lodBootstrapCoverageTarget,
      overviewTileCount: lodOverviewTiles.length,
      prefetchElapsedMs: lodBootstrapPhase === 'prefetch'
        ? performance.now() - lodPrefetchStartedAt
        : lodPrefetchElapsedMs,
      prefetchExitReason: lodPrefetchExitReason,
      fallbackTileCount: lodOverviewTiles.length,
      fallbackBytes: state.lodRuntimeProfile?.fallbackBytes ?? 0,
      prefetchShellBytes: state.lodRuntimeProfile?.prefetchShellBytes ?? null,
      shellOverSoftBudget: state.lodRuntimeProfile?.shellOverSoftBudget === true,
      fallbackSoftBudgetBytes: state.lodRuntimeProfile?.fallbackSoftBudgetBytes ?? null,
      fallbackBudgetBytes: state.lodRuntimeProfile?.fallbackBudgetBytes ?? null,
      fallbackDetailReserveBytes: state.lodRuntimeProfile?.fallbackDetailReserveBytes ?? null,
      focusPriority: controls?.getInteractionState?.() || null,
      prospectiveAdmissionBlocked,
      pendingAdmissionBytes: lodPendingAdmissionBytes,
      errorScale: lodErrorScale,
    }
    : null;
  const snapshot = lodDebugSnapshot(tilesRenderer, runtimeProfile, lodWarmupComplete);
  snapshot.regionalFallback = lodRegionalFallback?.snapshot() ?? null;
  snapshot.admission = lodAdmissionThrottle?.snapshot() ?? null;
  snapshot.loadingBudget = lodLoadingBudget?.snapshot() ?? null;
  const signature = JSON.stringify(snapshot);
  if (!force && signature === lodDebugSignature) return snapshot;
  lodDebugSignature = signature;
  lodTraceEntries.push({ at: Math.round(performance.now()), reason, snapshot });
  if (lodTraceEntries.length > 240) lodTraceEntries.splice(0, lodTraceEntries.length - 240);
  // Serialize the payload so production console capture preserves the useful
  // counters instead of reducing every entry to the word "Object".
  console.info('[LTDS LOD]', reason, JSON.stringify(snapshot));
  return snapshot;
}

function updateLodQualityStatus(now = performance.now(), force = false) {
  if (!tilesRenderer || !lodRuntimeProfileState || !tilesParent.visible) return null;
  const interaction = controls?.getInteractionState?.() || null;
  const queuesActive = !lodQueuesSettled(tilesRenderer);
  const interval = interaction?.activeMotion || queuesActive ? 75 : 250;
  if (!force && now - lodLastQualityUpdateAt < interval) return null;
  lodLastQualityUpdateAt = now;

  const snapshot = emitLodDebugSnapshot('status');
  const frontier = visibleLodFrontier(tilesRenderer.root);
  const targetSatisfied = visibleLodTargetSatisfied(tilesRenderer.root, tilesRenderer.errorTarget);
  const signature = JSON.stringify({
    phase: lodBootstrapPhase,
    requestedDetail: lodRuntimeProfileState.requestedDetail,
    activeDetail: lodRuntimeProfileState.activeDetail,
    visible: snapshot.visible,
    pendingRequiredTiles: snapshot.pendingRequiredTiles,
    pendingHierarchyNodes: snapshot.pendingHierarchyNodes,
    positiveErrorFallbackTiles: snapshot.positiveErrorFallbackTiles,
    queueCounts: snapshot.queueCounts,
    frontier,
    targetSatisfied,
  });
  const activity = Number(interaction?.lastActivityTime) || 0;
  if (signature !== lodQualitySignature || activity !== lodLastInteractionSequence) {
    lodQualitySignature = signature;
    lodLastInteractionSequence = activity;
    lodQualityStableFrames = 0;
    lodLastQualityFrame = Number(tilesRenderer.frameCount) || -1;
  } else if ((Number(tilesRenderer.frameCount) || -1) !== lodLastQualityFrame) {
    lodQualityStableFrames += 1;
    lodLastQualityFrame = Number(tilesRenderer.frameCount) || -1;
  }

  const quality = classifyLodQuality({
    bootstrapPhase: lodBootstrapPhase,
    runtimeProfile: lodRuntimeProfileState,
    snapshot,
    frontier,
    queuesSettled: lodQueuesSettled(tilesRenderer),
    targetSatisfied,
    stableFrames: lodQualityStableFrames,
  });
  const visibleCount = frontier.visibleCount || tilesRenderer.stats?.visible || 0;
  const memoryLimited = (Number(lodRuntimeProfileState.peripheralPressureScale) || 1) > 1
    || (lodStarvedAtDetail !== null
      && lodRuntimeProfileState.activeDetail < lodRuntimeProfileState.requestedDetail);
  let label;
  if (lodBootstrapPhase === 'root') label = 'loading complete overview';
  else if (lodBootstrapPhase === 'prefetch') label = 'building stable overview';
  else if (lodBootstrapPhase === 'root-only') label = 'complete overview (detail shell unavailable)';
  else if (memoryLimited) label = `memory-limited, target Detail ${lodRuntimeProfileState.requestedDetail}`;
  else if (lodRuntimeProfileState.reduced) label = `reduced-memory Detail ${lodRuntimeProfileState.activeDetail}`;
  else if (lodDetailRequestPending(lodRuntimeProfileState)) label = `warming Detail ${lodRuntimeProfileState.activeDetail}`;
  else if (quality.fullDetail) label = 'full-detail';
  else label = queuesActive || snapshot.pendingRequiredTiles > 0 || snapshot.pendingHierarchyNodes > 0
    ? `streaming Detail ${lodRuntimeProfileState.activeDetail}`
    : `Detail ${lodRuntimeProfileState.activeDetail}`;
  const pendingCount = Math.max(0, Number(snapshot.pendingRequiredTiles) || 0);
  const pendingLabel = memoryLimited && pendingCount > 0 ? `, ${pendingCount} pending` : '';
  dom.lodStatus.textContent = sessionAccessLabel()
    || (lodTileRetryTimer ? `LOD: retrying tile (${lodTileRetryAttempt}/4)` : null)
    || `LOD: ${label} (${visibleCount} tile${visibleCount === 1 ? '' : 's'}${pendingLabel})`;
  return { snapshot, frontier, quality };
}

function lodTargetForDetail(detail) {
  return detailToErrorTarget(detail);
}

function lodTileSceneAttached(tile) {
  const scene = tile?.engineData?.scene;
  return Boolean(scene && tilesRenderer?.group?.children?.includes(scene));
}

function lodTileSceneReady(tile) {
  return Boolean(tile?.engineData?.scene);
}

function retainedLodTiles(now = performance.now()) {
  const retained = [...lodOverviewTiles];
  retained.push(...(lodRegionalFallback?.retainedTiles() || []));
  for (const [tile, expiresAt] of lodRecentFrontier) {
    if (expiresAt <= now || !tilesRenderer?.lruCache?.has?.(tile)) {
      lodRecentFrontier.delete(tile);
      continue;
    }
    retained.push(tile);
  }
  return retained;
}

function lodRecentFrontierMaxBytes() {
  const configured = Number(lodRuntimeProfileState?.memoryProfile?.recentFrontierBytes);
  const transitionBudget = Number.isFinite(configured) && configured >= 0
    ? configured
    : LOD_RECENT_FRONTIER_MAX_BYTES;
  // Regional proxy coverage and recent fine cuts share one allowance. Adding
  // regional fallbacks must not silently increase permanently retained bytes.
  return Math.max(0, transitionBudget - (lodRegionalFallback?.snapshot().residentBytes || 0));
}

function updateLodRegionalFallback(now = performance.now()) {
  if (!tilesRenderer || !lodRegionalFallback) return;
  const bases = new Set(lodOverviewTiles);
  let candidate = tilesRenderer.__ltdsFocusOwnerState?.owner || null;
  for (let depth = 0; candidate && !bases.has(candidate) && depth < 256; depth += 1) {
    candidate = candidate.parent;
  }
  const inCurrentView = tile => tile?.traversal?.lastFrameVisited === tilesRenderer.frameCount
    && tile.traversal.used === true && tile.traversal.inFrustum === true;
  if (!bases.has(candidate) || !inCurrentView(candidate)) {
    candidate = lodOverviewTiles.filter(inCurrentView).sort((a, b) => (
      (Number(b.__ltdsFocusOverlap) || 0) - (Number(a.__ltdsFocusOverlap) || 0)
      || (Number(a.traversal.distanceFromCamera) || 0) - (Number(b.traversal.distanceFromCamera) || 0)
    ))[0] || null;
  }
  const configured = Number(lodRuntimeProfileState?.memoryProfile?.recentFrontierBytes);
  lodRegionalFallback.update({
    enabled: lodBootstrapPhase === 'complete' && lodRuntimeProfileState?.reduced !== true,
    baseTiles: lodOverviewTiles,
    candidateOwner: candidate,
    maxBytes: Number.isFinite(configured) ? configured : LOD_RECENT_FRONTIER_MAX_BYTES,
    now,
  });
}

function lodShellRetentionMaxBytes() {
  const configured = Number(lodRuntimeProfileState?.memoryProfile?.shellRetentionBytes);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : LOD_FALLBACK_TARGET_BYTES;
}

function lodShellBudgetBytes(root = tilesRenderer?.root) {
  const rootBytes = Number(tilesRenderer?.lruCache?.bytesMap?.get?.(root)) || 0;
  return lodFallbackShellMaxBytes(tilesRenderer?.lruCache?.maxBytesSize, {
    bootstrapResidentBytes: rootBytes,
  });
}

function updateLodRecentFrontier(now = performance.now()) {
  if (!tilesRenderer || lodBootstrapPhase !== 'complete') return;
  const cache = tilesRenderer.lruCache;
  const fallback = tilesRenderer.lodFallbackTiles;
  for (const tile of tilesRenderer.visibleTiles || []) {
    if (!tile || tile === tilesRenderer.root || fallback?.has?.(tile)) continue;
    if (!cache?.has?.(tile)) continue;
    lodRecentFrontier.delete(tile);
    lodRecentFrontier.set(tile, now + LOD_RECENT_FRONTIER_TTL_MS);
  }
  lodRecentFrontier = selectLodRecentFrontier(
    Array.from(lodRecentFrontier).filter(([tile]) => cache?.has?.(tile)),
    {
      now,
      maxTiles: LOD_RECENT_FRONTIER_MAX_TILES,
      maxBytes: lodRecentFrontierMaxBytes(),
      reservedTiles: new Set([...(fallback || []), ...(lodRegionalFallback?.retainedTiles() || [])]),
      getBytes: tile => Number(cache?.bytesMap?.get?.(tile)) || 0,
    },
  );
}

function updateLodBranchBlockers() {
  for (const tile of lodBranchBlockers) tile.__ltdsBranchBlocker = false;
  lodBranchBlockers.clear();
  if (!tilesRenderer || lodBootstrapPhase !== 'complete') return;
  for (const tile of lodBranchBlockerCut(tilesRenderer.visibleTiles, {
    isReady: lodTileSceneReady,
    focusState: tilesRenderer.__ltdsFocusOwnerState,
  })) {
    tile.__ltdsBranchBlocker = true;
    lodBranchBlockers.add(tile);
  }
}

function captureLodPrefetchShell(root) {
  const bytesMap = tilesRenderer?.lruCache?.bytesMap;
  const maxBytes = lodShellBudgetBytes(root);
  return lodFallbackShellPlan(root, {
    isReady: lodTileSceneReady,
    getBytes: tile => Number(bytesMap?.get?.(tile)) || 0,
    softMaxBytes: lodShellRetentionMaxBytes(),
    maxBytes,
  });
}

function enterLodRootOnly(reason) {
  const root = tilesRenderer?.root;
  lodOverviewTiles = root ? [root] : [];
  tilesRenderer.lodFallbackTiles = new Set(lodOverviewTiles);
  tilesRenderer.loadSiblings = false;
  tilesRenderer.maxDepth = 1;
  tilesRenderer.errorTarget = lodBootstrapRootTarget;
  retainLodOverviewTiles(tilesRenderer, lodOverviewTiles);
  lodPrefetchExitReason = reason;
  lodPrefetchElapsedMs = Math.max(0, performance.now() - lodPrefetchStartedAt);
  lodBootstrapPhase = 'root-only';
  state.lodRuntimeProfile = {
    ...state.lodRuntimeProfile,
    ...lodRuntimeProfileState,
    bootstrapPhase: lodBootstrapPhase,
    prefetchExitReason: reason,
    prefetchElapsedMs: lodPrefetchElapsedMs,
    fallbackTileCount: lodOverviewTiles.length,
    fallbackBytes: Number(tilesRenderer?.lruCache?.bytesMap?.get?.(root)) || 0,
    fallbackSoftBudgetBytes: lodShellRetentionMaxBytes(),
    fallbackBudgetBytes: lodShellBudgetBytes(root),
    fallbackDetailReserveBytes: LOD_FALLBACK_MIN_DETAIL_BYTES,
    errorScale: 1,
  };
  dom.lodStatus.textContent = 'LOD: complete overview (detail shell unavailable)';
  emitLodDebugSnapshot('shell-unavailable', true);
}

function finishLodPrefetch(reason, captured = captureLodPrefetchShell(tilesRenderer?.root)) {
  const root = tilesRenderer?.root;
  if (lodRuntimeProfileState?.reduced) {
    lodOverviewTiles = root ? [root] : [];
  } else if (!captured.complete) {
    return false;
  } else {
    lodOverviewTiles = captured.shell;
  }
  tilesRenderer.lodFallbackTiles = new Set(lodOverviewTiles);
  tilesRenderer.loadSiblings = false;
  retainLodOverviewTiles(tilesRenderer, lodOverviewTiles);
  lodPrefetchExitReason = reason;
  lodPrefetchElapsedMs = Math.max(0, performance.now() - lodPrefetchStartedAt);
  lodBootstrapPhase = 'complete';
  lodWarmupComplete = true;
  lodLastSettledDetail = lodRuntimeProfileState.activeDetail;
  tilesRenderer.maxDepth = Infinity;
  tilesRenderer.errorTarget = lodTargetForDetail(lodRuntimeProfileState.activeDetail);
  state.lodRuntimeProfile = {
    ...state.lodRuntimeProfile,
    ...lodRuntimeProfileState,
    bootstrapPhase: lodBootstrapPhase,
    prefetchExitReason: reason,
    prefetchElapsedMs: lodPrefetchElapsedMs,
    fallbackTileCount: lodOverviewTiles.length,
    fallbackBytes: lodRuntimeProfileState?.reduced
      ? Number(tilesRenderer?.lruCache?.bytesMap?.get?.(root)) || 0
      : captured.bytes,
    fallbackSoftBudgetBytes: lodShellRetentionMaxBytes(),
    fallbackBudgetBytes: lodShellBudgetBytes(root),
    fallbackDetailReserveBytes: LOD_FALLBACK_MIN_DETAIL_BYTES,
    errorScale: 1,
  };
  dom.lodStatus.textContent = lodRuntimeProfileState.reduced
    ? `LOD: reduced-memory Detail ${lodRuntimeProfileState.activeDetail}`
    : `LOD: Detail ${lodRuntimeProfileState.activeDetail}`;
  emitLodDebugSnapshot('prefetch-complete', true);
  tilesRenderer.lruCache?.scheduleUnload?.();
  return true;
}

function maybeAdvanceLodBootstrap() {
  if (!tilesRenderer || !lodRuntimeProfileState
    || !['root', 'prefetch'].includes(lodBootstrapPhase)) return false;
  const root = tilesRenderer.root;
  if (!root) return true;

  if (lodBootstrapPhase === 'root') {
    lodBootstrapRootTarget = lodBootstrapRootErrorTarget(root?.traversal?.error);
    tilesRenderer.errorTarget = lodBootstrapRootTarget;
    const rootReady = root?.traversal?.visible === true && lodTileSceneAttached(root);
    if (!rootReady) return true;
    if (lodRuntimeProfileState.reduced) {
      lodPrefetchStartedAt = performance.now();
      finishLodPrefetch('reduced-root');
      return true;
    }
    lodBootstrapCoverageTarget = lodBootstrapCoverageErrorTarget(
      root?.traversal?.error,
      (root.children || []).map(child => child?.traversal?.error),
    );
    lodBootstrapPhase = 'prefetch';
    lodPrefetchStartedAt = performance.now();
    lodPrefetchReadyFrames = 0;
    lodPrefetchSoftBudgetReported = false;
    tilesRenderer.errorTarget = lodBootstrapCoverageTarget;
    tilesRenderer.maxDepth = LOD_PREFETCH_MAX_DEPTH;
    // With maxDepth bounded to the direct shell, sibling loading requests all
    // spatial shell tiles without descending into the detailed model. The
    // complete shell is required before the whole-model root can be retired.
    tilesRenderer.loadSiblings = true;
    state.lodRuntimeProfile = {
      ...state.lodRuntimeProfile,
      bootstrapPhase: lodBootstrapPhase,
      bootstrapRootTarget: lodBootstrapRootTarget,
      bootstrapCoverageTarget: lodBootstrapCoverageTarget,
      fallbackSoftBudgetBytes: lodShellRetentionMaxBytes(),
      fallbackBudgetBytes: lodShellBudgetBytes(root),
      fallbackDetailReserveBytes: LOD_FALLBACK_MIN_DETAIL_BYTES,
    };
    dom.lodStatus.textContent = 'LOD: prefetching nearby coverage';
    emitLodDebugSnapshot('overview-ready', true);
    return true;
  }

  tilesRenderer.errorTarget = lodBootstrapCoverageTarget;
  tilesRenderer.maxDepth = LOD_PREFETCH_MAX_DEPTH;
  tilesRenderer.loadSiblings = true;
  const captured = captureLodPrefetchShell(root);
  state.lodRuntimeProfile = {
    ...state.lodRuntimeProfile,
    prefetchShellBytes: captured.bytes,
    shellOverSoftBudget: captured.overSoftBudget,
  };
  lodPrefetchReadyFrames = captured.complete ? lodPrefetchReadyFrames + 1 : 0;
  const elapsed = performance.now() - lodPrefetchStartedAt;
  const cachePressure = Boolean(tilesRenderer.lruCache?.isFull?.());
  if (captured.overSoftBudget && !lodPrefetchSoftBudgetReported) {
    lodPrefetchSoftBudgetReported = true;
    emitLodDebugSnapshot('shell-soft-budget-exceeded', true);
  }
  if (captured.unsupported) {
    enterLodRootOnly('unsupported-direct-shell');
  } else if (captured.shell.length === 0) {
    enterLodRootOnly('no-renderable-shell');
  } else if (captured.overBudget) {
    enterLodRootOnly('shell-over-budget');
  } else if (lodPrefetchReadyFrames >= 2) {
    finishLodPrefetch('complete-direct-shell', captured);
  } else if (cachePressure) {
    // Cache-full can be transient while the root and shell coexist. Release
    // stale detail, keep building the shell, and let successful promotion
    // schedule the now-unneeded root for eviction. Never latch root-only for
    // a momentary pressure sample.
    lodRecentFrontier.clear();
    recoverLodCacheAdmission(tilesRenderer.lruCache, lodRuntimeProfileState.budget);
    if (lodPrefetchExitReason !== 'shell-cache-pressure') {
      lodPrefetchExitReason = 'shell-cache-pressure';
      emitLodDebugSnapshot('shell-cache-pressure', true);
    }
  } else if (elapsed >= LOD_PREFETCH_MAX_MS && lodPrefetchExitReason !== 'shell-building') {
    // Three seconds is a telemetry milestone, not a visual-promotion escape
    // hatch. Promoting an incomplete shell would make a later camera angle
    // reactivate the whole-model root and hide all ready detail.
    lodPrefetchExitReason = 'shell-building';
    dom.lodStatus.textContent = `LOD: building stable overview (${captured.ready.length}/${captured.shell.length})`;
    emitLodDebugSnapshot('shell-building', true);
  }
  return true;
}

function maybeAdvanceLodWarmup() {
  if (!tilesRenderer || !lodRuntimeProfileState
    || lodBootstrapPhase !== 'complete'
    || lodRuntimeProfileState.reduced) return false;
  if (!lodQueuesSettled(tilesRenderer)
    || !visibleLodTargetSatisfied(tilesRenderer.root, tilesRenderer.errorTarget)) return false;
  if (lodStarvedAtDetail !== null) return false;
  lodLastSettledDetail = lodRuntimeProfileState.activeDetail;
  if (!lodDetailRequestPending(lodRuntimeProfileState)) return false;
  const advance = resolveLodWarmupAdvance(lodRuntimeProfileState);
  if (!advance) return false;
  Object.assign(lodRuntimeProfileState, advance);
  const targetDetail = advance.activeDetail;
  tilesRenderer.errorTarget = lodTargetForDetail(targetDetail);
  lodWarmupComplete = advance.warmupComplete;
  state.lodRuntimeProfile = { ...state.lodRuntimeProfile, ...lodRuntimeProfileState };
  dom.lodStatus.textContent = `LOD: warming Detail ${targetDetail} → ${advance.requestedDetail}`;
  emitLodDebugSnapshot('refinement-stage', true);
  return true;
}

function captureLodPressureView() {
  if (!camera) return null;
  camera.updateMatrixWorld(true);
  const target = getViewTargetWorld();
  return {
    position: camera.position.toArray(),
    quaternion: camera.quaternion.toArray(),
    focusDistance: target?.distanceTo?.(camera.position) ?? 0,
  };
}

function retryLodForChangedView() {
  if (!tilesRenderer || !lodRuntimeProfileState || lodStarvedAtDetail === null
    || !lodPressureView || lodCacheRecoveryActive) return false;
  const currentView = captureLodPressureView();
  if (!lodViewChangeRequiresRetry(lodPressureView, currentView)) return false;

  lodStarvationSamples = 0;
  lodPressureClearSamples = 0;
  lodStarvedAtDetail = null;
  lodPressureView = null;
  const next = resolveLodDetailRequest(
    lodRuntimeProfileState,
    lodWarmupComplete,
    lodRuntimeProfileState.requestedDetail,
  );
  Object.assign(lodRuntimeProfileState, next);
  lodWarmupComplete = next.warmupComplete;
  tilesRenderer.errorTarget = lodTargetForDetail(next.activeDetail);
  state.lodRuntimeProfile = {
    ...state.lodRuntimeProfile,
    ...lodRuntimeProfileState,
    starvedAtDetail: null,
  };
  dom.lodStatus.textContent = `LOD: retrying Detail ${next.activeDetail} → ${next.requestedDetail}`;
  emitLodDebugSnapshot('view-change-retry', true);
  return true;
}

function startLoop() {
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);

    const renderThree = state.activeMode === 'model' || (state.activeMode === 'cloud' && state.cloudMode === 'direct');
    if (renderThree) {
      controls.update(dt);
      camera.updateMatrixWorld();
      if (camGroupParent?.visible) refreshCameraMarkerScales();
      if (tilesRenderer && tilesParent.visible) {
        tilesRenderer.update();
        if (!maybeAdvanceLodBootstrap()) maybeAdvanceLodWarmup();
        updateLodBranchBlockers();
        updateLodRegionalFallback();
        updateLodRecentFrontier();
        updateLodQualityStatus(performance.now());
      }
      lodResources?.drainBVH();

      // scale measurement markers with camera distance
      measureRoot.traverse((o) => {
        if (o.userData.isMarker) {
          const d = o.position.distanceTo(camera.position);
          o.scale.setScalar(Math.max(1e-7, d * Math.tan(camera.fov * Math.PI / 360) * 8 / renderer.domElement.clientHeight));
        }
      });

      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);

      frames++;
      const now = performance.now();
      if (now - lastFps >= 1000) {
        dom.fps.textContent = frames;
        dom.fps.title = 'Rendered 3D frames per second';
        frames = 0; lastFps = now;
        statTimer++;
        updateStats();
      }
    } else if (performance.now() - lastFps >= 1000) {
      const cloudFps = state.activeMode === 'cloud' ? pcApi()?.getStatus?.().fps : null;
      dom.fps.textContent = Number.isFinite(cloudFps) ? Math.round(cloudFps) : '—';
      dom.fps.title = state.activeMode === 'cloud' ? 'Point-cloud frames per second' : 'Map renders on demand; no continuous frame-rate counter';
      dom.memDisplay.textContent = formatJsHeap(performance.memory?.usedJSHeapSize);
      frames = 0; lastFps = performance.now();
    }
  }
  requestAnimationFrame(loop);
}

function updateStats() {
  dom.memDisplay.textContent = formatJsHeap(performance.memory?.usedJSHeapSize);
  let tris = 0;
  if (tilesParent.visible && tilesRenderer) {
    const countVisible = (obj) => {
      if (!obj.visible) return;
      if (obj.isMesh && obj.geometry) {
        tris += obj.geometry.index ? obj.geometry.index.count / 3 : (obj.geometry.attributes.position?.count || 0) / 3;
      }
      for (const c of obj.children) countVisible(c);
    };
    countVisible(tilesRenderer.group);
    const frontier = visibleLodFrontier(tilesRenderer.root);
    const queuesSettled = lodQueuesSettled(tilesRenderer);
    const prospectiveAdmissionBlocked = syncLodPendingAdmission();
    const pressureSnapshot = lodDebugSnapshot(tilesRenderer, {
      ...lodRuntimeProfileState,
      starvedAtDetail: lodStarvedAtDetail,
      prospectiveAdmissionBlocked,
      pendingAdmissionBytes: lodPendingAdmissionBytes,
    }, lodWarmupComplete);
    const cacheSoftBytes = Number(lodRuntimeProfileState?.budget?.softBytesSize);
    if (Number.isFinite(cacheSoftBytes)
      && Number(tilesRenderer.lruCache?.cachedBytes) > cacheSoftBytes) {
      // Crossing the soft cache asks the LRU to trim stale, unpinned content;
      // prospective parse admission remains available up to the hard cap.
      tilesRenderer.lruCache?.scheduleUnload?.();
    }
    const cacheRecoverySettled = lodCacheRecoveryActive
      && pressureSnapshot.cache.full === false
      && pressureSnapshot.pendingRequiredTiles === 0
      && queuesSettled;
    if (cacheRecoverySettled) {
      lodCacheRecoveryActive = false;
      tilesRenderer.lruCache.minBytesSize = lodCacheRetentionMinBytes(lodRuntimeProfileState.budget, false);
      retryLodForChangedView();
    }
    const pressure = advanceLodMemoryPressure(pressureSnapshot, lodRuntimeProfileState, {
      consecutiveSamples: lodStarvationSamples,
      clearSamples: lodPressureClearSamples,
      starvedAtDetail: lodStarvedAtDetail,
      lastSettledDetail: lodLastSettledDetail,
    });
    lodStarvationSamples = pressure.consecutiveSamples;
    lodPressureClearSamples = pressure.clearSamples;
    lodStarvedAtDetail = pressure.starvedAtDetail;
    if (pressure.recoveryRequired) {
      lodCacheRecoveryActive = true;
      tilesRenderer.lruCache.minBytesSize = lodCacheRetentionMinBytes(
        lodRuntimeProfileState.budget,
        true,
        tilesRenderer.lruCache,
      );
    }
    if (pressure.changed) {
      Object.assign(lodRuntimeProfileState, pressure.profile);
      tilesRenderer.__ltdsPeripheralPressureScale = Math.max(
        1,
        Number(lodRuntimeProfileState.peripheralPressureScale) || 1,
      );
      state.lodRuntimeProfile = {
        ...state.lodRuntimeProfile,
        ...lodRuntimeProfileState,
        starvedAtDetail: lodStarvedAtDetail,
      };
      emitLodDebugSnapshot(
        tilesRenderer.__ltdsPeripheralPressureScale > 1
          ? 'peripheral-memory-pressure'
          : 'peripheral-memory-recovered',
        true,
      );
    }
    updateLodQualityStatus(performance.now(), true);
  } else if (glbParent.visible) {
    glbOffset.traverse((o) => {
      if (o.isMesh && o.geometry) tris += o.geometry.index ? o.geometry.index.count / 3 : (o.geometry.attributes.position?.count || 0) / 3;
    });
    dom.lodStatus.textContent = 'LOD: full-res';
  }
  dom.trisStatus.textContent = 'Tris: ' + (tris > 1e6 ? (tris / 1e6).toFixed(1) + 'M' : Math.round(tris / 1000) + 'K');
}

// expose for debugging/verification
window.__ltds = { scene: () => scene, camera: () => camera, controls: () => controls,
  tiles: () => tilesRenderer, state, worldToUtm, latLonToUtm, utmToLatLon,
  lodDiagnostics: () => emitLodDebugSnapshot('manual', true),
  sessionDiagnostics,
  lodTrace: () => lodTraceEntries.map(entry => structuredClone(entry)),
  lodOwnerDiagnostics: (options) => lodOwnerDebug?.snapshot(options) ?? null,
  lodTileEvents: () => lodOwnerDebug?.trace() ?? [],
  lodEvaluation: () => ({ ...LOD_EVALUATION }),
  lodLoadingTiming: () => lodLoadingTiming?.snapshot() ?? null,
  lodResources: () => lodResources?.snapshot() ?? null,
  cameraWorldPositions: () => camWorldPos ? Array.from(camWorldPos) : [],
  // Georeferencing self-test: latlon -> UTM -> source px -> linear window -> UTM -> latlon roundtrip.
  // Expect maxRoundtripM to be tiny (sub-mm); large values mean the warp mapping drifted.
  warpSelfTest: (mode) => {
    const ds = mode === 'ortho' ? geoDatasets[ORTHO_URL]
             : mode === 'dsm' ? geoDatasets[DSM_URL] : geoDatasets[DTM_URL];
    if (!ds) return { error: `no cached dataset for ${mode}` };
    const cornersLL = ds.llCorners.slice();
    const b = ds.llBounds;
    const pts = [
      [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2],
      [b[0][0] + (b[1][0] - b[0][0]) * 0.2, b[0][1] + (b[1][1] - b[0][1]) * 0.3],
      [b[0][0] + (b[1][0] - b[0][0]) * 0.8, b[0][1] + (b[1][1] - b[0][1]) * 0.2],
      [b[0][0] + (b[1][0] - b[0][0]) * 0.3, b[0][1] + (b[1][1] - b[0][1]) * 0.75],
      [b[0][0] + (b[1][0] - b[0][0]) * 0.7, b[0][1] + (b[1][1] - b[0][1]) * 0.6]
    ];
    let maxRoundtripM = 0;
    for (const [lat, lon] of pts) {
      const en = latLonToUtm(lat, lon);
      const fx = (en[0] - ds.minE) / (ds.maxE - ds.minE) * ds.W;      // fractional source px
      const fy = (ds.maxN - en[1]) / (ds.maxN - ds.minN) * ds.H;
      const ex = ds.minE + fx / ds.W * (ds.maxE - ds.minE);           // linear window mapping back
      const ey = ds.maxN - fy / ds.H * (ds.maxN - ds.minN);
      const ll = utmToLatLon(ex, ey);
      const dLatM = (ll[0] - lat) * 111320;
      const dLonM = (ll[1] - lon) * 111320 * Math.cos(lat * Math.PI / 180);
      const dM = Math.hypot(dLatM, dLonM);
      if (dM > maxRoundtripM) maxRoundtripM = dM;
    }
    return { maxRoundtripM, cornersLL };
  } };
