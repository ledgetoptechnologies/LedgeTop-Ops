// Export identity continuity: the shipped exportOrthoPrintFromViewer,
// applyViewerSession, setSessionAccessState and the export fence run in a VM
// with the real export pipeline and the real dialog. An export belongs to the
// viewer (audience and subject), model and version it started for: if the page
// moves to anything else mid-export, even a viewer that may also print, no file
// is saved and no error is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CONTOUR_COLORS } from '../contours.mjs';
import { assertOrthoPrintAllowed, clampExtent, exportOrthoPrint, mountOrthoPrintDialog, orthoPrintPolicy, printLongEdge } from '../ortho-print-export.mjs';

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(signature) {
  const start = source.indexOf(`\n${signature}`);
  assert.ok(start >= 0, signature);
  return source.slice(start + 1, source.indexOf('\n}\n', start) + 3);
}
function region(from, to) {
  const start = source.indexOf(`\n${from}`), end = source.indexOf(`\n${to}`, start);
  assert.ok(start >= 0 && end > start, from);
  return source.slice(start + 1, end + 1);
}
// viewerAccessAvailable, orthoPrintPermissions and the export fence (the in-flight set, identity and cancel hook).
const SHIPPED = [region('function viewerAccessAvailable()', 'function syncMeasurementActionVisibility()'),
  ...['function setSessionAccessState(', 'function applyViewerSession(', 'function printEpsg()',
    'async function exportOrthoPrintFromViewer('].map(extract)].join('\n');

const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function model(version) {
  return { id: 'model-one', title: 'Model', activeVersion: { id: version } };
}
function session({ subject = 'person-one', version = 'v1', permissions = { view: true, measure: true }, expiresIn = 600_000 } = {}) {
  return { sessionId: 'session-id', subject, audience: 'client', permissions, model: model(version),
    expiresAt: new Date(Date.now() + expiresIn).toISOString() };
}

// 400 x 200 m orthophoto in EPSG:32616, one level.
function orthoDataset() {
  const image = {
    getWidth: () => 200, getHeight: () => 100,
    getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616 }), getResolution: () => [2, -2, 0], getFileDirectory: () => ({ getValue: () => undefined }),
    async readRasters({ window: [x0, y0, x1, y1] }) { return [0, 1, 2].map(() => new Uint8Array((x1 - x0) * (y1 - y0)).fill(120)); },
  };
  return { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200, nodata: NaN, images: [image] };
}

function fakeDocument() {
  const downloads = [];
  const node = tag => ({
    tagName: tag, children: [], listeners: {}, value: '', hidden: false, disabled: false, textContent: '',
    append(...kids) {
      for (const kid of kids) { this.children.push(kid); if (tag === 'select' && this.value === '') this.value = kid.value; }
    },
    remove() {}, setAttribute() {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    fire(type) { return Promise.all((this.listeners[type] || []).map(fn => fn())); },
    click() { if (tag === 'a') downloads.push(this.download); return this.fire('click'); },
    querySelector(selector) { const value = /value="([^"]*)"/.exec(selector)[1]; return this.children.find(c => c.value === value); },
    showModal() {}, close() { return this.fire('close'); },
  });
  return { createElement: node, body: node('body'), downloads };
}

function page({ holdOpen = false, holdTrace = false, holdBlob = false, permissions = undefined, beforeSave = null } = {}) {
  const log = { opens: [], traces: [], blobs: [], canvases: [] };
  const ortho = orthoDataset();
  const hold = (enabled, list, value, extra) => {
    if (!enabled) { list.push({ ...extra }); return Promise.resolve(value); }
    const d = deferred();
    list.push({ ...extra, resolve: () => d.resolve(value) });
    return d.promise;
  };
  const canvas = () => {
    const ctx = new Proxy({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: () => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) }),
      measureText: text => ({ width: text.length * 7 }),
    }, { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true });
    const c = {
      width: 0, height: 0, getContext: () => ctx,
      toBlob(callback) {
        const blob = new Blob(['png'], { type: 'image/png' });
        if (!holdBlob) { log.blobs.push({}); callback(blob); return; }
        log.blobs.push({ resolve: () => callback(blob) });
      },
    };
    log.canvases.push(c);
    return c;
  };
  const first = session({ permissions });
  const map = {
    getBounds: () => ({ getNorthWest: () => ({ lat: 4700180, lng: 500020 }), getNorthEast: () => ({ lat: 4700180, lng: 500380 }),
      getSouthWest: () => ({ lat: 4700020, lng: 500020 }), getSouthEast: () => ({ lat: 4700020, lng: 500380 }) }),
    getSize: () => ({ x: 720, y: 320 }),
  };
  const context = vm.createContext({
    orthoPrintPolicy, assertOrthoPrintAllowed, clampExtent, printLongEdge, exportOrthoPrint,
    AbortController, DOMException, console: { warn() {} },
    VIEW_MODE: 'session', PROJECT: first.model, activeViewerSession: first, SHARE_PERMISSIONS: first.permissions,
    sessionAccessState: 'active', sessionAccessReason: null, sessionRenewalBlocked: false,
    ORTHO_URL: '/ortho.tif', DTM_URL: '/dtm.tif', DISPLAY_UNITS: 'metric', TILES_URL: null,
    map, state: { activeMode: 'ortho', cloudMode: 'none', meshSource: 'none' }, isMapMode: mode => mode === 'ortho',
    latLonToUtm: (lat, lng) => [lng, lat], window: { devicePixelRatio: 1 },
    document: { createElement: canvas },
    // Inert sources: they answer when the test says so, whatever happened meanwhile.
    getDataset: (url, isDem, { signal }) => hold(holdOpen, log.opens, ortho, { url, signal }),
    contourLines: {
      computeForExtent: (extent, cell, { signal }) => hold(holdTrace, log.traces, { features: [], interval: 1, units: 'metric' }, { signal }),
      colors: () => CONTOUR_COLORS.brown,
    },
    propertyLinesForPrint: () => ({ lines: [], color: null }),
    measurementCoordinateReference: () => ({ crs: 'EPSG:32616' }), ensureGeoTiffPool: () => null,
    // applyViewerSession / setSessionAccessState collaborators, inert here.
    setDisplayUnits() {}, sessionStorageKey: 'k', SESSION_STORAGE_PREFIX: 'p:', sessionCapabilities: { write() {} },
    sessionAllowedOrigins: [], renderStaffNavigation() {}, renderClientNavigation() {}, dom: { lodStatus: {}, cloudStatus: {} },
    applyProjectConfig() {}, tilesRenderer: null, scheduleLodAvailabilityRefresh() {}, stopLodAvailabilityRefresh() {},
    scheduleSessionRenewal() {}, propertyLines: null, recoverFailedLodTiles() {}, pcApi: () => null, viewerProductDownloads: null,
    measurementDraftRecovery: { capture() {}, hasPending: () => false }, measurementWorkspace: null, viewerSlice: null,
    syncMeasurementActionVisibility() {}, sessionAccessLabel: () => '',
  });
  vm.runInContext(SHIPPED, context);
  const doc = fakeDocument();
  // `beforeSave` runs after the export resolves and before the dialog creates the download.
  const run = async (options, signal) => { const result = await context.exportOrthoPrintFromViewer(options, signal); beforeSave?.(context); return result; };
  const dialog = mountOrthoPrintDialog({ documentRef: doc, run });
  dialog.controls.contours.checked = true;
  return { context, log, doc, dialog, inFlight: () => vm.runInContext('orthoPrintExports.size', context) };
}

// The dialog revokes its object URL a minute later; keep that timer from holding the test process open.
const objectUrls = [];
const realSetTimeout = globalThis.setTimeout, realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL;
test.beforeEach(() => {
  objectUrls.length = 0;
  globalThis.setTimeout = (fn, ms, ...args) => { const t = realSetTimeout(fn, ms, ...args); t.unref?.(); return t; };
  URL.createObjectURL = blob => { objectUrls.push(blob); return `blob:test/${objectUrls.length}`; };
  URL.revokeObjectURL = () => {};
});
test.afterEach(() => { globalThis.setTimeout = realSetTimeout; URL.createObjectURL = realCreate; URL.revokeObjectURL = realRevoke; });

function assertNoFile(p, message) {
  assert.deepEqual(p.doc.downloads, [], `${message}: nothing downloaded`);
  assert.equal(objectUrls.length, 0, `${message}: no object URL made`);
  assert.equal(p.dialog.controls.status.textContent, '', `${message}: no error or stale "Rendering" shown`);
  assert.equal(p.dialog.controls.exportButton.disabled, false, `${message}: dialog usable again`);
  assert.equal(p.inFlight(), 0, `${message}: export released`);
}

test('happy path: a plain renewal mid-export keeps the export, and the file is saved', async () => {
  const p = page({ holdOpen: true });
  const done = p.dialog.controls.exportButton.fire('click');
  await tick();
  assert.equal(p.log.opens.length, 1);
  // Same viewer, model and version with a later expiry: not a context change.
  p.context.applyViewerSession(session({ expiresIn: 900_000 }));
  assert.equal(p.log.opens[0].signal.aborted, false, 'renewal does not cancel');
  p.log.opens[0].resolve();
  await done;
  assert.equal(p.log.traces.length, 1, 'contours traced');
  assert.deepEqual(p.doc.downloads, ['orthophoto-720px.png']);
  assert.equal(objectUrls.length, 1);
  assert.match(p.dialog.controls.status.textContent, /limited by your access/);
  assert.equal(p.log.canvases.length, 1);
  assert.equal(p.log.canvases[0].width, 0, 'canvas released after saving');
  assert.equal(p.inFlight(), 0);
});

test('a delayed export is cancelled when another viewer who may also print takes over the page', async () => {
  const p = page({ holdOpen: true });
  const done = p.dialog.controls.exportButton.fire('click');
  await tick();
  assert.equal(p.inFlight(), 1);
  const opening = p.log.opens[0];
  // Same model and version, a different subject with print permission of its own.
  p.context.applyViewerSession(session({ subject: 'person-two' }));
  assert.equal(opening.signal.aborted, true, 'cancelled by the session change itself');
  assert.equal(p.inFlight(), 1, 'still awaiting the orthophoto');
  // The inert source answers after the switch anyway.
  opening.resolve();
  await done;
  assert.equal(p.log.traces.length, 0, 'no overlays traced for the old export');
  assert.equal(p.log.canvases.length, 0, 'nothing rendered');
  assertNoFile(p, 'subject switch while opening the orthophoto');
});

test('a model version change during the contour trace stops the export, even without a session event', async () => {
  const p = page({ holdTrace: true });
  const done = p.dialog.controls.exportButton.fire('click');
  await tick();
  assert.equal(p.log.traces.length, 1);
  // The page's model moves to v2 underneath; printing is still allowed.
  p.context.PROJECT = model('v2');
  p.log.traces[0].resolve();
  await done;
  assert.equal(p.log.canvases.length, 0, 'nothing rendered after the trace');
  assertNoFile(p, 'version change during the trace');
});

test('a subject switch while the file is being encoded releases the canvas and saves nothing', async () => {
  const p = page({ holdBlob: true });
  const done = p.dialog.controls.exportButton.fire('click');
  await tick();
  assert.equal(p.log.blobs.length, 1, 'encoding in progress');
  p.context.applyViewerSession(session({ subject: 'person-two' }));
  p.log.blobs[0].resolve();
  await done;
  assert.equal(p.log.canvases[0].width, 0, 'canvas released');
  assertNoFile(p, 'subject switch during encoding');
});

test('lost access cancels at once; closing the dialog is its own abort', async () => {
  const expired = page({ holdOpen: true });
  const first = expired.dialog.controls.exportButton.fire('click');
  await tick();
  expired.context.setSessionAccessState('unavailable', 'session-expired');
  assert.equal(expired.log.opens[0].signal.aborted, true);
  expired.log.opens[0].resolve();
  await first;
  assertNoFile(expired, 'access lost');

  const closed = page({ holdOpen: true });
  const second = closed.dialog.controls.exportButton.fire('click');
  await tick();
  await closed.dialog.dialog.close();
  assert.equal(closed.log.opens[0].signal.aborted, true, 'Close aborts the export');
  closed.log.opens[0].resolve();
  await second;
  assert.deepEqual(closed.doc.downloads, []);
  assert.equal(objectUrls.length, 0);
  assert.equal(closed.inFlight(), 0);
});

// A same-subject renewal that drops download but keeps measure: a current-view
// PNG planned above the no-download cap (here the 720 px screen) must not be saved.
const WITH_DOWNLOAD = { view: true, measure: true, download: true };
const WITHOUT_DOWNLOAD = { view: true, measure: true, download: false };

test('download kept: a 2048 px current-view PNG planned with download is saved', async () => {
  const p = page({ holdBlob: true, permissions: WITH_DOWNLOAD });
  p.dialog.controls.size.value = '2048';
  const done = p.dialog.controls.exportButton.fire('click');
  await tick();
  p.context.applyViewerSession(session({ permissions: WITH_DOWNLOAD, expiresIn: 900_000 }));
  p.log.blobs[0].resolve();
  await done;
  assert.deepEqual(p.doc.downloads, ['orthophoto-2048px.png']);
});

test('download revoked by a same-subject renewal during encoding: no file', async () => {
  const p = page({ holdBlob: true, permissions: WITH_DOWNLOAD });
  p.dialog.controls.size.value = '2048';
  const done = p.dialog.controls.exportButton.fire('click');
  await tick();
  assert.equal(p.log.blobs.length, 1, 'encoding in progress');
  assert.equal(p.log.canvases[0].width, 2048, 'planned above the no-download cap');
  p.context.applyViewerSession(session({ permissions: WITHOUT_DOWNLOAD }));
  assert.equal(p.log.traces[0].signal.aborted, true, 'cancelled by the session change itself');
  assert.equal(p.inFlight(), 1);
  p.log.blobs[0].resolve();
  await done;
  assert.equal(p.log.canvases[0].width, 0, 'canvas released');
  assertNoFile(p, 'download revoked during encoding');

  // The same downgrade with no session event at all is caught after encoding.
  const q = page({ holdBlob: true, permissions: WITH_DOWNLOAD });
  q.dialog.controls.size.value = '2048';
  const quiet = q.dialog.controls.exportButton.fire('click');
  await tick();
  q.context.SHARE_PERMISSIONS = WITHOUT_DOWNLOAD;
  q.log.blobs[0].resolve();
  await quiet;
  assertNoFile(q, 'download revoked without a session event');
});

test('download revoked immediately before the dialog saves: no file', async () => {
  const p = page({ permissions: WITH_DOWNLOAD, beforeSave: context => context.applyViewerSession(session({ permissions: WITHOUT_DOWNLOAD })) });
  p.dialog.controls.size.value = '2048';
  await p.dialog.controls.exportButton.fire('click');
  assert.equal(p.log.blobs.length, 1, 'the file was encoded');
  assertNoFile(p, 'download revoked before save');

  // Control: the same renewal that keeps download saves the file.
  const kept = page({ permissions: WITH_DOWNLOAD, beforeSave: context => context.applyViewerSession(session({ permissions: WITH_DOWNLOAD })) });
  kept.dialog.controls.size.value = '2048';
  await kept.dialog.controls.exportButton.fire('click');
  assert.deepEqual(kept.doc.downloads, ['orthophoto-2048px.png']);
});
