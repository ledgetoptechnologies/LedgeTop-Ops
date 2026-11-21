import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Runs the real loader and direct point-cloud functions from main.js with a stub page and a
// controllable PLY loader, so late network callbacks can be delivered after navigation.
const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const slice = (start, end) => {
  const from = main.indexOf(start), to = main.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `main.js still contains ${start}`);
  return main.slice(from, to);
};
const loadingSource = slice('function updateLoading(', 'let errorHideTimer');
const directSource = slice('function loadPointCloudDirect()', '// Point cloud (Potree in an isolated iframe)');

function element(id, log) {
  const classes = new Set();
  const properties = new Map();
  return {
    id, textContent: '', hidden: false,
    classList: {
      add(name) { if (!classes.has(name)) log.push(`${id}+${name}`); classes.add(name); },
      remove(name) { if (classes.has(name)) log.push(`${id}-${name}`); classes.delete(name); },
      contains: name => classes.has(name),
    },
    style: {
      display: '',
      setProperty(name, value) { properties.set(name, value); },
      removeProperty(name) { properties.delete(name); },
      getPropertyValue: name => properties.get(name) ?? '',
    },
  };
}

function viewer() {
  const log = [];
  const overlay = element('overlay', log), bar = element('loading-bar', log);
  overlay.classList.add('hidden'); bar.hidden = true; log.length = 0;
  const requests = [];
  class PLYLoader { load(url, onLoad, onProgress, onError) { requests.push({ onLoad, onProgress, onError }); } }
  const geometry = () => ({ disposed: false, dispose() { this.disposed = true; }, getAttribute: () => ({ array: new Float32Array(3) }), hasAttribute: () => false, setAttribute() {}, userData: { pointPositionsLocalized: true } });
  const context = {
    state: { pointCloudLoaded: false, pointCloudLoading: false, activeMode: 'cloud', cloudMode: 'direct' },
    dom: { loadingOverlay: overlay, loadingText: element('text', log), loadingProgress: element('progress', log), loadingCancel: element('cancel', log) },
    document: { getElementById: id => (id === 'loading-bar' ? bar : null) },
    POINT_CLOUD_URL: '/assets/cloud.ply', POINT_CLOUD_FORMAT: 'ply', RTC: null, DIAGNOSTIC_CORRELATION_ID: 'diagnostic-ref',
    directPointCloudLoad: null, pointCloudObject: null, lastShared3DView: null, viewerSlice: null,
    pointCloudOffset: { add() {}, remove() {} }, pointCloudParent: { visible: true, updateMatrixWorld() {} },
    THREE: { PointsMaterial: class {}, Points: class { constructor(geometryValue, material) { this.geometry = geometryValue; this.material = material; } }, BufferAttribute: class {}, BufferGeometry: class {} },
    PLYLoader, LASLoader: {}, loadersGlLoad: () => new Promise(() => {}),
    AbortController, console: { error() {} },
    viewerDiagnostic() {}, showError() { throw new Error('no error expected'); },
    localizePointPositions: positions => ({ positions }), refreshPointGeometryBounds() {}, frameObjectHome() {},
  };
  vm.createContext(context);
  vm.runInContext(`${loadingSource}\n${directSource}\nthis.api = { updateLoading, hideLoading, loadPointCloudDirect, stopDirectPointCloud };`, context);
  // The parts of switchMode that matter here, in its order: hide the loader, then stop the cloud.
  const navigateAway = mode => { context.api.hideLoading(); context.api.stopDirectPointCloud('superseded'); context.state.activeMode = mode; };
  const openCloud = () => { context.state.activeMode = 'cloud'; context.api.loadPointCloudDirect(); return requests.at(-1); };
  const progress = (request, percent) => request.onProgress({ loaded: percent, total: 100 });
  const loaderCleared = () => overlay.classList.contains('hidden') && bar.hidden && bar.style.getPropertyValue('--loading-fraction') === '';
  return { context, overlay, bar, log, geometry, navigateAway, openCloud, progress, loaderCleared };
}

test('a late PLY response after navigating away leaves the loader cleared, with no flicker back', async () => {
  const page = viewer();
  const request = page.openCloud();
  page.progress(request, 40);
  assert.equal(page.overlay.classList.contains('hidden'), false, 'loader shows while the cloud loads');
  assert.equal(page.bar.hidden, false);
  assert.equal(page.bar.style.getPropertyValue('--loading-fraction'), '0.4');

  page.navigateAway('model');
  assert.ok(page.loaderCleared(), 'navigation clears the overlay, the bar and its fraction');
  const afterNavigation = page.log.length;

  page.progress(request, 80);
  page.progress(request, 100);
  const late = page.geometry();
  request.onLoad(late);
  request.onError(new Error('late failure'));
  await new Promise(resolve => setTimeout(resolve, 20)); // quiet period after the last late callback

  assert.ok(page.loaderCleared(), 'loader is still cleared after the late transfer completes');
  assert.deepEqual(page.log.slice(afterNavigation), [], 'late callbacks never re-show the loader, even briefly');
  assert.equal(page.context.dom.loadingProgress.textContent, '40%', 'late progress (80%, 100%) is never written');
  assert.equal(late.disposed, true, 'late geometry is released, not added to the scene');
  assert.equal(page.context.state.pointCloudLoading, false);
  assert.equal(page.context.state.pointCloudLoaded, false);
});

test('a late PLY response from an earlier visit does not disturb the current cloud load or its finish', () => {
  const page = viewer();
  const first = page.openCloud();
  page.progress(first, 30);
  page.navigateAway('model');
  const second = page.openCloud();
  page.progress(second, 10);

  page.progress(first, 90);
  assert.equal(page.bar.style.getPropertyValue('--loading-fraction'), '0.1', 'the old transfer cannot move the current bar');
  assert.equal(page.context.dom.loadingProgress.textContent, '10%');
  const stale = page.geometry();
  first.onLoad(stale);
  assert.equal(stale.disposed, true);
  assert.equal(page.overlay.classList.contains('hidden'), false, 'the current load keeps its loader');

  second.onLoad(page.geometry());
  assert.ok(page.loaderCleared(), 'the current load clears the loader when it finishes');
  assert.equal(page.context.state.pointCloudLoaded, true);
  const finished = page.log.length;
  page.progress(first, 100);
  first.onLoad(page.geometry());
  assert.deepEqual(page.log.slice(finished), [], 'nothing re-shows the loader afterwards');
  assert.ok(page.loaderCleared());
});

test('a percentage-free loading message clears a previous bar value', () => {
  const page = viewer();
  page.context.api.updateLoading('Loading point cloud (PLY)...', '55%');
  assert.equal(page.bar.style.getPropertyValue('--loading-fraction'), '0.55');
  page.context.api.updateLoading('Streaming LOD tiles...', '');
  assert.equal(page.bar.hidden, true);
  assert.equal(page.bar.style.getPropertyValue('--loading-fraction'), '');
});
