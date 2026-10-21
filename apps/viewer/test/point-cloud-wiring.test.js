'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const dockerSource = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const pointCloudShell = fs.readFileSync(path.join(root, 'public', 'pointcloud.html'), 'utf8');

test('LAZ wiring retains Float64 until RTC localization and point-cloud-only init skips mesh load', () => {
  assert.match(mainSource, /las:\s*\{\s*colorDepth:\s*8,\s*fp64:\s*true\s*\}/);
  assert.match(mainSource, /localizePointPositions\(positions, RTC\)[\s\S]*new THREE\.BufferAttribute\(localized\.positions, 3\)/);
  assert.match(mainSource, /refreshPointGeometryBounds\(geometry\)/);
  assert.match(mainSource, /if \(is3D\) \{[\s\S]*?applyMeshLayer\(\);/);
  assert.match(
    mainSource,
    /pointCloudOffset\.add\(pointCloudObject\)[\s\S]*pointCloudParent\.updateMatrixWorld\(true\)[\s\S]*frameObjectHome\(pointCloudObject, \{ apply: !lastShared3DView \}\)/,
  );
  assert.match(mainSource, /new THREE\.PointsMaterial\(\{[\s\S]*size:\s*2,[\s\S]*sizeAttenuation:\s*false/);
});

test('production image copies and asserts the complete Potree release layout', () => {
  assert.match(dockerSource, /SRC_DIR="\$\(dirname "\$\(dirname "\$POTREE_BUILD_DIR"\)"\)"/);
  assert.match(dockerSource, /test -s \/potree\/build\/potree\/potree\.js/);
  assert.match(dockerSource, /test -s \/potree\/libs\/jquery\/jquery-3\.1\.1\.min\.js/);
  assert.match(dockerSource, /test -s \/potree\/libs\/copc\/index\.js/);
  assert.match(dockerSource, /test -s \/potree\/libs\/plasio\/js\/laslaz\.js/);
  assert.match(pointCloudShell, /\/potree\/libs\/jquery\/jquery-3\.1\.1\.min\.js/);
  assert.match(pointCloudShell, /\/potree\/libs\/copc\/index\.js/);
  assert.match(pointCloudShell, /\/potree\/libs\/jstree\/themes\/mixed\/style\.min\.css/);
  assert.doesNotMatch(pointCloudShell, /\/potree\/libs\/jstree\/themes\/style\.min\.css/);
});

test('Potree controls preserve panel state and match mesh navigation feedback', () => {
  const viewerShell = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(mainSource, /message\.type === 'ready'[\s\S]*applyPcPanelState\(\)/);
  for (const call of ['setBudget', 'setSize', 'setSizing', 'setColor', 'setEDL']) {
    assert.match(mainSource, new RegExp(`api\\.${call}\\(`));
  }
  assert.match(pointCloudShell, /activeAttributeName = a/);
  assert.doesNotMatch(pointCloudShell, /PointSizeType\.ADAPTIVE/);
  assert.doesNotMatch(pointCloudShell, /PointSizeType\.ATTENUATED/);
  assert.match(pointCloudShell, /PointSizeType\.FIXED/);
  assert.match(pointCloudShell, /ctx\.strokeStyle = '#EE5007'/);
  assert.match(pointCloudShell, /ctx\.fillStyle = '#ffffff'/);
  assert.match(pointCloudShell, /orbitRadiansForPixels\(dx, h, gainScale\)/);
  assert.match(pointCloudShell, /viewer\.earthControls\?\.pivotIndicator/);
  assert.match(pointCloudShell, /viewer\.setPointBudget\(10_000_000\)/);
  assert.match(pointCloudShell, /LtdsPointCloudPerformance\.createAdaptivePointBudget\(\)/);
  assert.equal(require('../public/pointcloud-performance.js').createAdaptivePointBudget().state.target, 10_000_000);
  assert.match(viewerShell, /id="pc2-budget"[^>]*value="10"/);
  assert.match(viewerShell, /id="pc2-budget-val">10M</);
  assert.match(pointCloudShell, /const forward = new THREE\.Vector3\(\)\s*\.subVectors\(view\.getPivot\(\), view\.position\)\s*\.normalize\(\)\s*\.applyQuaternion\(q\)/);
  assert.match(pointCloudShell, /view\.lookAt\(view\.position\.clone\(\)\.addScaledVector\(forward, lookDistance\)\)/);
  assert.doesNotMatch(pointCloudShell, /view\.lookAt\(pivot\)/);
  assert.match(pointCloudShell, /this\.view\.position\.add\(delta\);\s*this\.pivot\.add\(delta\);/);
  assert.match(pointCloudShell, /this\._touch\.pinchStart\.copy\(cur\)\.add\(delta\)/);
  assert.doesNotMatch(pointCloudShell, /this\.view\.position\.copy\(this\._panStartPos\)/);
  assert.match(pointCloudShell, /this\.pivot\.copy\(this\.view\.getPivot\(\)\)/);
  assert.match(pointCloudShell, /this\._inertia\.yaw = 0;\s*this\._inertia\.pitch = 0;\s*this\._lastMoveTime = 0;/);
});

test('pre-metadata mesh view remains exact when the cloud finishes loading', () => {
  assert.match(pointCloudShell, /window\.__setViewUTM = \(camE, camN, camAlt, tgtE, tgtN, tgtAlt\)/);
  assert.match(pointCloudShell, /window\.__getViewUTM = \(\) =>/);
  assert.match(pointCloudShell, /position: \[view\.position\.x, view\.position\.y, view\.position\.z\]/);
  assert.match(pointCloudShell, /target: \[target\.x, target\.y, target\.z\]/);
  assert.match(pointCloudShell, /if \(!window\.__pcViewReady\) \{\s*viewer\.fitToScreen\(0\.7\)/);
  assert.doesNotMatch(pointCloudShell, /syncedTargetIsRelevant|pendingSyncedTarget/);
  assert.match(pointCloudShell, /viewer\.fitToScreen\(0\.7\)/);
});

test('cloud and map modes cannot display frozen mesh performance counters as live data', () => {
  assert.match(mainSource, /dom\.lodStatus\.hidden = !is3D/);
  assert.match(mainSource, /dom\.trisStatus\.hidden = !is3D/);
  assert.match(mainSource, /state\.activeMode === 'cloud' \? pcApi\(\)\?\.getStatus\?\.\(\)\.fps : null/);
  assert.match(mainSource, /Map renders on demand; no continuous frame-rate counter/);
});

test('sparse cloud navigation keeps narrow picks and repairs stale focal depth', () => {
  assert.match(pointCloudShell, /<script src="\/pointcloud-navigation\.js"><\/script>/);
  assert.match(pointCloudShell, /POINT_PICK_WINDOW,[\s\S]*NAVIGATION_POLICY,[\s\S]*orbitRadiansForPixels,[\s\S]*wheelZoomScale,[\s\S]*worldUnitsPerPixel,[\s\S]*maxPanStep,[\s\S]*canUseOverviewAnchor/);
  assert.match(pointCloudShell, /pointcloud\.pick\(this\.viewer, camera, ray, \{[\s\S]*pickWindowSize: POINT_PICK_WINDOW/);
  assert.match(pointCloudShell, /_depthAnchor\(px\)[\s\S]*camera\.getWorldDirection\(normal\)[\s\S]*setFromNormalAndCoplanarPoint\(normal, pivot\)/);
  assert.match(pointCloudShell, /if \(this\._adoptSurfaceDepth\(hit\)\) return hit/);
  assert.doesNotMatch(pointCloudShell, /isPlausibleAnchorDistance\(camera\.position\.distanceTo\(hit\), referenceDistance\)/,
    'an earlier focal plane is not a rejection limit for a real decoded point');
  assert.match(pointCloudShell, /_cloudBounds\(\)[\s\S]*this\.viewer\.scene\.getBoundingBox\(pointclouds\)/);
  assert.match(pointCloudShell, /paddedBounds = bounds\.clone\(\)\.expandByScalar\([\s\S]*this\._ray\(px\)\.intersectBox\(paddedBounds/);
  assert.match(pointCloudShell, /const fallback = canUseOverviewAnchor\(\{ point: depthAnchor, bounds, referenceDistance, cloudDiameter \}\)\s*\? depthAnchor : boundsHit/);
  assert.match(pointCloudShell, /canUseOverviewAnchor\(\{ point: fallback, bounds, referenceDistance, cloudDiameter \}\)\s*\? fallback\.clone\(\) : null/,
    'the exact returned pivot remains inside the cloud footprint even at sparse oblique edges');
  assert.match(pointCloudShell, /orbitRadiansForPixels\(dx, h, gainScale\)/);
  assert.match(pointCloudShell, /worldUnitsPerPixel\(this\._screenRef, fov, h\)/);
  assert.match(pointCloudShell, /maxPanStep\(this\.view\.position\.distanceTo\(cur\)\)/);
  assert.match(pointCloudShell, /wheelZoomScale\(e\.deltaY\)/);
  assert.doesNotMatch(pointCloudShell, /_anchor\(px\)[\s\S]{0,900}this\._bboxMidZ\(\)/);
});

test('point-cloud orbit accepts only a forward decoded point or bounded overview fallback', () => {
  assert.match(pointCloudShell, /_surfaceAnchor\(px, depthAnchor = this\._depthAnchor\(px\)\)/);
  assert.match(pointCloudShell, /const pivot = this\._surfaceAnchor\(this\._px\(e\)\);\s*if \(!pivot\) \{ this\._mode = 'none'; return; \}/);
  assert.match(pointCloudShell, /this\.pivot\.copy\(pivot\);\s*this\._showPivot\(\);\s*this\._mode = 'orbit'/);
});

test('direct LAZ/PLY orbit picker is wired to the visible Three.js Points object', () => {
  assert.match(mainSource, /import \{ pickDirectPointSurface \} from '\.\/direct-pointcloud-picking\.mjs'/);
  assert.match(mainSource, /state\.activeMode === 'cloud' && state\.cloudMode === 'direct'/);
  assert.match(mainSource, /!pointCloudParent\?\.visible \|\| !pointCloudObject/);
  assert.match(mainSource, /pickDirectPointSurface\(\{ raycaster, camera, points: pointCloudObject, ndc, viewportHeight \}\)/);
});

test('point-cloud distance and height labels use thousandth-inch precision in imperial mode', () => {
  assert.match(pointCloudShell, /<script src="\/pointcloud-measurements\.js"><\/script>/);
  assert.match(pointCloudShell, /installPotreeMeasurementPrecision\(Potree, \{ displayUnits: DISPLAY_UNITS \}\)/);
});

test('camera positions persist across model and point-cloud modes and remain clickable', () => {
  const viewerShell = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const cameraRuntime = fs.readFileSync(path.join(root, 'public', 'pointcloud-cameras.js'), 'utf8');
  assert.match(viewerShell, /id="panel-camera-positions"[\s\S]*id="layer-cameras"[\s\S]*id="cam-size"[^>]*value="0\.5"/);
  assert.doesNotMatch(viewerShell, /yellow spear/i);
  assert.match(pointCloudShell, /<script src="\/pointcloud-cameras\.js"><\/script>/);
  assert.match(pointCloudShell, /const cameraOverlayScene = new THREE\.Scene\(\)/);
  assert.match(pointCloudShell, /createPointCloudCameraLayer\(\{[\s\S]*scene: cameraOverlayScene/);
  assert.doesNotMatch(pointCloudShell, /createPointCloudCameraLayer\(\{[\s\S]*scene: viewer\.scene\.scene/);
  assert.match(pointCloudShell, /addEventListener\('render\.pass\.perspective_overlay',[\s\S]*viewer\.renderer\.render\(cameraOverlayScene, viewer\.scene\.getActiveCamera\(\)\)/);
  assert.match(pointCloudShell, /setCameras\(markers\)[\s\S]*pointCloudCameraLayer\.setMarkers\(markers\)/);
  assert.match(pointCloudShell, /setCameraVisibility\(visible\)[\s\S]*pointCloudCameraLayer\.setVisible\(visible\)/);
  assert.match(pointCloudShell, /viewer\.addEventListener\('update', \(\) => pointCloudCameraLayer\.updateView\(\)\)/);
  assert.match(cameraRuntime, /let drawToSource = \[\]/);
  assert.match(cameraRuntime, /const visibleSources = selectCameraMarkerRepresentatives\(candidates/);
  assert.match(cameraRuntime, /const CAMERA_MARKER_COMPONENTS = Object\.freeze\(\['body', 'face', 'cue', 'tab'\]\)/);
  assert.match(cameraRuntime, /for \(const mesh of componentMeshes\) \{\s*mesh\.count = visibleSources\.length/);
  assert.match(cameraRuntime, /if \(mesh\.instanceColor\) mesh\.instanceColor\.needsUpdate = true/);
  assert.match(cameraRuntime, /new THREE\.MeshBasicMaterial\(\{[^}]*opacity: CAMERA_MARKER_OPACITY\.normal[^}]*side: THREE\.FrontSide[^}]*depthTest: false[^}]*depthWrite: false/);
  assert.match(mainSource, /new THREE\.MeshBasicMaterial\(\{[^}]*opacity: CAMERA_MARKER_OPACITY\.normal[^}]*side: THREE\.FrontSide/);
  assert.match(cameraRuntime, /return drawToSource\[hit\.instanceId\]/);
  assert.match(cameraRuntime, /let hoveredSource = -1/);
  assert.match(cameraRuntime, /function setHovered\(sourceIndex\)/);
  assert.match(cameraRuntime, /const hovered = source === hoveredSource/);
  assert.match(cameraRuntime, /sourceToDraw\[source\][\s\S]*setColorAt\(draw/);
  assert.match(cameraRuntime, /setMarkers, setScale, setVisible, setHovered, updateView, pick, dispose/);
  assert.match(pointCloudShell, /addEventListener\('pointermove',[\s\S]*pointCloudCameraLayer\.pick\(event\.clientX, event\.clientY\)[\s\S]*pointCloudCameraLayer\.setHovered/);
  assert.match(pointCloudShell, /addEventListener\('pointerleave',[\s\S]*pointCloudCameraLayer\.setHovered\(-1\)/);
  assert.match(pointCloudShell, /addEventListener\('pointercancel',[\s\S]*pointCloudCameraLayer\.setHovered\(-1\)/);
  assert.match(pointCloudShell, /type: 'camera-open'[\s\S]*index[\s\S]*correlationId/);
  assert.match(mainSource, /function syncCameraLayer\(\)/);
  assert.match(mainSource, /function refreshCameraMarkerScales\(force = false\)/);
  assert.match(mainSource, /refreshCameraMarkerScales\(\)/);
  assert.match(mainSource, /api\.setCameras\(cameraPayload\)/);
  assert.match(mainSource, /api\.setCameraVisibility\(state\.camerasVisible\)/);
  assert.match(mainSource, /message\.type === 'camera-open'[\s\S]*openPhoto\(message\.index\)/);
  assert.match(mainSource, /getElementById\('panel-camera-positions'\)\.style\.display = \(is3D \|\| isPC \|\| isMapMode\(mode\)\)/);
  assert.match(mainSource, /async function loadCameras\(\) \{\s*if \(state\.camerasLoaded \|\| state\.camerasLoading \|\| !SHOTS_URL \|\| !SHARE_PERMISSIONS\.cameras\) return;/);
  assert.match(mainSource, /const visible = isMapMode\(\) && state\.camerasVisible\s*&& state\.camerasLoaded && SHARE_PERMISSIONS\.cameras/);
  assert.match(mainSource, /function refreshMapCameraLayer\(\)[\s\S]*isMapMode\(\)[\s\S]*createMapCameraOverlay\(L,[\s\S]*onSelect: source => openPhoto\(source\)[\s\S]*mapCameraFeatures === camFeatures && mapCameraScale === cameraMarkerUserScale[\s\S]*cameraFeatureMapPosition[\s\S]*mapCameraLayer\.setData\(records/);
  assert.match(mainSource, /function localCameraRendererActive\(\)[\s\S]*state\.activeMode === 'model'[\s\S]*state\.activeMode === 'cloud' && state\.cloudMode === 'direct'/);
  assert.match(mainSource, /function onPointerUp\(e\) \{\s*if \(measurementWorkspace\?\.isDrawing\(\)\) return;\s*if \(!localCameraRendererActive\(\)\) return;/);
  assert.match(mainSource, /if \(state\.activeTool !== 'none'\) \{\s*if \(state\.activeMode !== 'model'\) return;/);
});

test('two-finger gestures and moved pointers cannot open a point-cloud camera photo', () => {
  assert.match(pointCloudShell, /createCameraClickTracker\(\{ threshold: 5 \}\)/);
  assert.match(pointCloudShell, /pointerdown[\s\S]*cameraClickTracker\.pointerDown\(event\)/);
  assert.match(pointCloudShell, /pointermove[\s\S]*cameraClickTracker\.pointerMove\(event\)/);
  assert.match(pointCloudShell, /pointercancel[\s\S]*cameraClickTracker\.pointerCancel\(event\)/);
});
