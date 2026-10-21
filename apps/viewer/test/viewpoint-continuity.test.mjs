import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';

// Execute the actual transfer and mode-switch functions with renderer/UI seams.
// No copied state machine: these tests cover the shipped departure/arrival order.
const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const syncSource = source.slice(source.indexOf('function captureMeshView()'), source.indexOf('function bindUI()'));
const switchSource = source.slice(source.indexOf('function switchMode('), source.indexOf('function applyPcPanelState()'));
const cloudShell = fs.readFileSync(new URL('../public/pointcloud.html', import.meta.url), 'utf8');
const nativeReadyStart = cloudShell.indexOf('      if (!window.__pcViewReady)');
const nativeReadySource = cloudShell.slice(nativeReadyStart, cloudShell.indexOf('\n      const cam =', nativeReadyStart));

function harness() {
  const camera = new THREE.PerspectiveCamera();
  const target = new THREE.Vector3();
  const home = [50, 50, 50];
  const elements = new Proxy({}, { get: (o, key) => o[key] ||= { style: {}, classList: { remove() {} } } });
  const ctx = {
    THREE, AbortController, camera, pendingPointCloudView: null, lastShared3DView: null,
    preserveIncomingModelView: false, modeEpoch: 0, mapToolEpoch: 0, modeAbortController: null,
    state: { activeMode: 'model', activeTool: 'none', cloudMode: 'potree', meshSource: 'tiles' },
    tilesRenderer: { root: {} }, timers: [], iframe: null, calls: [],
    controls: { setView(position, lookAt) { camera.position.copy(position); target.copy(lookAt); camera.lookAt(target); } },
    getViewTargetWorld: () => target.clone(),
    worldToUtm: (p) => ({ e: p.x, n: p.y, alt: p.z }),
    utmToWorld: (e, n, alt) => new THREE.Vector3(e, n, alt),
    setTimeout: (fn) => ctx.timers.push(fn),
    availableViewerModes: () => ['model', 'cloud', 'ortho', 'dsm', 'dtm'],
    ORTHO_URL: 'ortho', DSM_URL: 'dsm', DTM_URL: 'dtm', SHOTS_URL: '',
    SHARE_PERMISSIONS: { cameras: true, measure: true },
    rememberMapView() {}, viewerDiagnostic() {}, hideLoading() {}, updateStatus() {}, onResize() {},
    syncCameraLayer() {}, syncMapVolumeAvailability() {},
    measurementWorkspace: { modeChanged() { ctx.calls.push('measurement-mode-change'); } },
    tilesParent: {}, glbParent: {}, pointCloudParent: {}, dom: elements,
    isMapMode: (mode = ctx.state.activeMode) => ['ortho', 'dsm', 'dtm'].includes(mode),
    document: { querySelectorAll: () => [], getElementById: (id) => id === 'pc-iframe' ? ctx.iframe : elements[id] },
    disposeTiles() { ctx.calls.push('dispose-model'); ctx.tilesRenderer = null; },
    stopPointCloudIframe() { ctx.calls.push('stop-cloud'); ctx.iframe = null; },
    stopDirectPointCloud() {}, loadPointCloudDirect() {}, removeMapOverlays() {},
    ensureMap() {}, map: { invalidateSize() {} }, showOrtho() {}, showDEM() {},
    applyMeshLayer() {
      ctx.calls.push('load-model');
      if (!ctx.preserveIncomingModelView) ctx.controls.setView(new THREE.Vector3(...home), new THREE.Vector3());
      ctx.tilesRenderer = { root: {} };
      ctx.preserveIncomingModelView = false;
    },
    showPointCloud() {
      if (ctx.iframe) return;
      const view = { position: new THREE.Vector3(), pivot: new THREE.Vector3(), getPivot() { return this.pivot; } };
      const w = { viewer: { scene: { view } }, __pcViewReady: false };
      w.__setViewUTM = (x, y, z, tx, ty, tz) => {
        view.position.set(x, y, z); view.pivot.set(tx, ty, tz); w.__pcViewReady = true;
      };
      w.__getViewUTM = () => ({ position: view.position.toArray(), target: view.pivot.toArray() });
      ctx.iframe = { contentWindow: w };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(syncSource + '\n' + switchSource, ctx);
  const go = (mode, opts = {}) => ctx.switchMode(mode, { updateHistory: false, ...opts });
  const aim = (p, t) => ctx.controls.setView(new THREE.Vector3(...p), new THREE.Vector3(...t));
  return { ctx, go, aim, target, camera };
}

for (const mapMode of ['ortho', 'dsm', 'dtm']) {
  test(`cloud → ${mapMode} → model preserves the latest cloud viewpoint before teardown`, () => {
    const { ctx, go, aim, camera, target } = harness();
    aim([10, 20, 30], [1, 2, 3]);
    go('cloud');
    assert.deepEqual(ctx.iframe.contentWindow.__getViewUTM().position, [10, 20, 30]);
    ctx.iframe.contentWindow.__setViewUTM(90, 80, 70, 9, 8, 7);
    go(mapMode);
    assert.equal(ctx.iframe, null);
    go('model');
    assert.deepEqual(camera.position.toArray(), [90, 80, 70]);
    assert.deepEqual(target.toArray(), [9, 8, 7]);
  });

  test(`model → ${mapMode} → cloud preserves the mesh snapshot through map navigation`, () => {
    const { ctx, go, aim } = harness();
    aim([12, 34, 56], [2, 3, 4]);
    go(mapMode);
    go('dtm');
    go('cloud');
    assert.deepEqual(ctx.iframe.contentWindow.__getViewUTM().position, [12, 34, 56]);
    assert.deepEqual(ctx.iframe.contentWindow.__getViewUTM().target, [2, 3, 4]);
  });
}

test('cloud-first startup uses its own home, then carries its moved viewpoint to model', () => {
  const { ctx, go, camera, target } = harness();
  go('cloud', { force: true, reason: 'startup' });
  assert.equal(ctx.lastShared3DView, null, 'unseen default mesh camera is not a saved viewpoint');
  assert.equal(ctx.iframe.contentWindow.__pcViewReady, false);
  const w = ctx.iframe.contentWindow, view = w.viewer.scene.view;
  w.viewer.fitToScreen = () => { view.position.set(50, 50, 50); view.pivot.set(0, 0, 0); };
  vm.runInNewContext(nativeReadySource, { window: w, viewer: w.viewer, view, pcControls: { pivot: new THREE.Vector3() } });
  assert.equal(w.__pcViewReady, true, 'actual native cloud framing enables outgoing transfer');
  // User navigation changes native view directly, not the parent transfer API.
  view.position.set(70, 60, 50); view.pivot.set(7, 6, 5);
  go('dsm');
  go('model');
  assert.deepEqual(camera.position.toArray(), [70, 60, 50]);
  assert.deepEqual(target.toArray(), [7, 6, 5]);
});

test('switching away before first mesh/direct-cloud data arrives does not save the generic camera', () => {
  for (const mode of ['model', 'cloud']) {
    const { ctx, go } = harness();
    ctx.tilesRenderer = null;
    ctx.state.activeMode = mode;
    if (mode === 'cloud') ctx.state.cloudMode = 'direct';
    ctx.state.pointCloudLoaded = false;
    go('ortho');
    assert.equal(ctx.lastShared3DView, null);
    go('model');
    assert.deepEqual(ctx.camera.position.toArray(), [50, 50, 50], 'first real model load still fits bounds');
  }
});

test('native metadata arrival preserves an already transferred cloud viewpoint', () => {
  const { ctx, go, aim } = harness();
  aim([12, 23, 34], [1, 2, 3]); go('cloud');
  const w = ctx.iframe.contentWindow, view = w.viewer.scene.view;
  w.viewer.fitToScreen = () => assert.fail('incoming viewpoint must not be replaced');
  vm.runInNewContext(nativeReadySource, { window: w, viewer: w.viewer, view, pcControls: { pivot: new THREE.Vector3() } });
  assert.deepEqual(view.position.toArray(), [12, 23, 34]);
});

test('model → map → model avoids automatic home framing on renderer reload', () => {
  const { go, aim, camera } = harness();
  aim([25, 35, 45], [2, 3, 4]);
  go('ortho'); go('model');
  assert.deepEqual(camera.position.toArray(), [25, 35, 45]);
});

test('old cloud retry cannot overwrite a newer cloud incarnation or a completed transfer', () => {
  const { ctx, go, aim } = harness();
  aim([10, 20, 30], [1, 2, 3]);
  go('cloud');
  const oldView = ctx.lastShared3DView;
  ctx.pendingPointCloudView = oldView;
  delete ctx.iframe.contentWindow.__setViewUTM;
  ctx.pushViewToPointCloud(oldView);
  const retry = ctx.timers.pop();
  go('model'); aim([99, 88, 77], [9, 8, 7]); go('cloud');
  retry();
  assert.deepEqual(ctx.iframe.contentWindow.__getViewUTM().position, [99, 88, 77]);
  ctx.iframe.contentWindow.__setViewUTM(44, 55, 66, 4, 5, 6);
  ctx.pushViewToPointCloud(ctx.lastShared3DView, 0, ctx.modeEpoch);
  assert.deepEqual(ctx.iframe.contentWindow.__getViewUTM().position, [44, 55, 66]);
});

test('invalid or unready cloud state does not erase the last valid viewpoint', () => {
  const { ctx, go, aim, camera } = harness();
  aim([12, 13, 14], [1, 2, 3]); go('cloud');
  ctx.iframe.contentWindow.__getViewUTM = () => ({ position: [NaN, 1, 2], target: [1, 2, 3] });
  go('ortho'); go('model');
  assert.deepEqual(camera.position.toArray(), [12, 13, 14]);
});

test('new page has no persisted viewpoint and deliberate reset becomes the new saved view', () => {
  const a = harness();
  a.aim([40, 50, 60], [4, 5, 6]); a.go('ortho'); a.go('model');
  // Reset View calls controls.setView; the next departure captures that intent.
  a.aim([50, 50, 50], [0, 0, 0]); a.go('cloud');
  assert.deepEqual(a.ctx.iframe.contentWindow.__getViewUTM().position, [50, 50, 50]);
  const b = harness();
  assert.equal(b.ctx.lastShared3DView, null);
});
