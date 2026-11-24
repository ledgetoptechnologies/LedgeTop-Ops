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
import * as printProperty from '../print-property.mjs';
import { dissolveParcelsByOwner, formatParcelArea } from '../property-lines-owners.mjs';
import { tilesCoverBounds } from '../property-lines.mjs';
import { IMAGERY_CREDIT, captureDates } from '../print-page.mjs';
import { IOS_MAX_PIXELS } from '../print-sheet.mjs';
import { assertOrthoPrintAllowed, clampExtent, exportOrthoPrint, isIosLike, mountOrthoPrintDialog, orthoPrintPolicy, printLongEdge, verifyOrthoCrs } from '../ortho-print-export.mjs';

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
  ...['function setSessionAccessState(', 'function applyViewerSession(', 'function printEpsg()', 'async function choosePrintProperty(', 'function propertyClipper(', 'function frameViewPixels(', 'async function openPrintPage(',
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
      getSouthWest: () => ({ lat: 4700020, lng: 500020 }), getSouthEast: () => ({ lat: 4700020, lng: 500380 }),
      contains: ([lat, lng]) => lat >= 4700020 && lat <= 4700180 && lng >= 500020 && lng <= 500380 }),
    getSize: () => ({ x: 720, y: 320 }),
  };
  const context = vm.createContext({
    orthoPrintPolicy, assertOrthoPrintAllowed, clampExtent, printLongEdge, exportOrthoPrint,
    AbortController, DOMException, console: { warn() {} },
    VIEW_MODE: 'session', PROJECT: first.model, activeViewerSession: first, SHARE_PERMISSIONS: first.permissions,
    sessionAccessState: 'active', sessionAccessReason: null, sessionRenewalBlocked: false,
    ORTHO_URL: '/ortho.tif', DTM_URL: '/dtm.tif', DISPLAY_UNITS: 'metric', TILES_URL: null,
    map, state: { activeMode: 'ortho', cloudMode: 'none', meshSource: 'none' }, isMapMode: mode => mode === 'ortho',
    latLonToUtm: (lat, lng) => [lng, lat], utmToLatLon: (e, n) => [n, e], window: { devicePixelRatio: 1 },
    document: { createElement: canvas },
    // Inert sources: they answer when the test says so, whatever happened meanwhile.
    getDataset: (url, isDem, { signal }) => hold(holdOpen, log.opens, ortho, { url, signal }),
    contourLines: {
      computeForExtent: (extent, cell, { signal }) => hold(holdTrace, log.traces, { features: [], interval: 1, units: 'metric' }, { signal }),
      colors: () => CONTOUR_COLORS.brown,
    },
    propertyLinesForPrint: () => ({ lines: [], color: null }),
    ...printProperty, PRINT_METERS_PER_FOOT: printProperty.METERS_PER_FOOT, formatParcelArea,
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

// ── One property ─────────────────────────────────────────────────────────

const IDENTITY = (subject = 'person-one', version = 'v1') => JSON.stringify(['client', subject, 'model-one', version]);
const chosenProperty = (identity = IDENTITY()) => ({ identity, label: 'EXAMPLE OWNER', attribution: 'Source: Synthetic Parcel Map R1.',
  parcels: [{ rings: [[[500100, 4700050], [500100, 4700150], [500300, 4700150], [500300, 4700050], [500100, 4700050]]] }],
  boundary: [[[500100, 4700050], [500300, 4700050]]], neighbours: [] });
const exportProperty = (p, selection = chosenProperty(), options = {}) => {
  const controller = new AbortController();
  return p.context.exportOrthoPrintFromViewer({ area: 'property', size: 2048, format: 'png', contours: false, property: true, selection, ...options }, controller.signal);
};
// Cross-realm: the VM throws its own DOMException-likes; match by name or code.
const rejects = (promise, key, value) => assert.rejects(promise, error => { assert.equal(error[key], value, String(error)); return true; });

test('property: a choice made by another viewer, or for another version, is refused before anything is opened', async () => {
  for (const selection of [null, chosenProperty(IDENTITY('person-two')), chosenProperty(IDENTITY('person-one', 'v0'))]) {
    const p = page();
    await rejects(exportProperty(p, selection), 'code', 'print_property');
    assert.equal(p.log.opens.length, 0);
    assert.equal(p.inFlight(), 0);
  }
  const p = page();
  await rejects(exportProperty(p, chosenProperty(), { format: 'tif' }), 'code', 'print_not_permitted');
});

test('property: without download it is held to the pixels it covers in the current view; with download the chosen size', async () => {
  const p = page();
  const result = await exportProperty(p);
  // The view is 360 x 160 m over 720 x 320 px: 2 px per metre, for the frame as it lies on the screen.
  const frame = printProperty.propertyFrame(chosenProperty().parcels, 25 * 0.3048), expected = Math.round(2 * (frame.maxE - frame.minE));
  assert.ok(Math.abs(result.width - expected) <= 1 && result.width < 720, `${result.width} vs ${expected}`);
  assert.match(result.note, /limited by your access/);
  assert.equal(result.filename, `property-${result.width}px.png`);
  const full = page({ permissions: WITH_DOWNLOAD });
  assert.equal((await exportProperty(full)).width, 2048);
});

// A view that does not hold the property plus its margin.
const viewOf = (minE, maxE, minN, maxN) => ({ getNorthWest: () => ({ lat: maxN, lng: minE }), getNorthEast: () => ({ lat: maxN, lng: maxE }), getSouthWest: () => ({ lat: minN, lng: minE }), getSouthEast: () => ({ lat: minN, lng: maxE }),
  contains: ([lat, lng]) => lat >= minN && lat <= maxN && lng >= minE && lng <= maxE });

test('property: without download it must fit the current view, margin and all; with download it need not', async () => {
  const views = { 'zoomed in': viewOf(500150, 500250, 4700080, 4700120), 'panned away': viewOf(500310, 500390, 4700020, 4700180), 'margin cut off': viewOf(500098, 500302, 4700020, 4700180) };
  for (const [name, view] of Object.entries(views)) {
    const p = page();
    p.context.map.getBounds = () => view;
    await assert.rejects(exportProperty(p), error => { assert.deepEqual([error.code, error.reason, error.message], ['print_property', 'zoom_out', 'Zoom out so the whole property fits in the view.'], name); return true; });
    assert.equal(p.log.canvases.length, 0, `${name}: nothing rendered`);
    assert.equal(p.inFlight(), 0);
    const full = page({ permissions: WITH_DOWNLOAD });
    full.context.map.getBounds = () => view;
    assert.equal((await exportProperty(full)).width, 2048, `${name}: with download`);
  }
  // Zoomed out it fits, and covers fewer pixels: no better than what is on the screen.
  const far = page();
  far.context.map.getBounds = () => viewOf(499960, 500440, 4699993, 4700207);
  const small = await exportProperty(far);
  const frame = printProperty.propertyFrame(chosenProperty().parcels, 25 * 0.3048);
  assert.ok(Math.abs(small.width - Math.round(1.5 * (frame.maxE - frame.minE))) <= 1, `${small.width}`);
  // Not a map view, or no map.
  for (const change of [c => { c.state = { ...c.state, activeMode: 'model' }; }, c => { c.map = null; }]) {
    const p = page();
    change(p.context);
    await assert.rejects(exportProperty(p), { reason: 'zoom_out' });
  }
});

test('property: download lost mid-export ends it unless the result still fits the no-download rule', async () => {
  const run = async (view, size) => {
    const p = page({ permissions: WITH_DOWNLOAD }), reading = deferred();
    if (view) p.context.map.getBounds = () => view;
    p.context.readCaptureMask = async () => { await reading.promise; return { captured: () => true, inside: () => 100 }; };
    const done = exportProperty(p, chosenProperty(), { size });
    done.catch(() => {});
    await tick();
    p.context.applyViewerSession(session({ permissions: WITHOUT_DOWNLOAD }));
    reading.resolve();
    return done;
  };
  await rejects(run(null, 2048), 'name', 'AbortError');
  await rejects(run(viewOf(500150, 500250, 4700080, 4700120), 300), 'name', 'AbortError');
  assert.equal((await run(null, 300)).width, 300, 'small enough and in the view');
});

// The view is checked as it is, at every checkpoint up to the save, never as it was at the start.
const VIEW_CHANGES = {
  'zoomed in': c => { c.map.getBounds = () => viewOf(500150, 500250, 4700080, 4700120); },
  'panned away': c => { c.map.getBounds = () => viewOf(500310, 500670, 4700020, 4700180); },
  'zoomed out past the planned size': c => { c.map.getBounds = () => viewOf(499840, 500560, 4699940, 4700260); },
  'a smaller window': c => { c.map.getSize = () => ({ x: 360, y: 160 }); },
  'another view': c => { c.state = { ...c.state, activeMode: 'model' }; },
};
const loseDownload = c => c.applyViewerSession(session({ permissions: WITHOUT_DOWNLOAD }));

test('property: a view change during a restricted export ends it: while the capture is read, while encoding, and right before saving', async () => {
  for (const [name, change] of Object.entries(VIEW_CHANGES)) {
    const reading = deferred(), clip = page();
    clip.context.readCaptureMask = async () => { await reading.promise; return { captured: () => true, inside: () => 100 }; };
    const first = exportProperty(clip);
    first.catch(() => {});
    await tick();
    change(clip.context);
    reading.resolve();
    await assert.rejects(first, error => { assert.deepEqual([error.code, error.reason, error.message], ['print_property', 'view_changed', 'The map view changed. Export again.'], name); return true; });
    assert.equal(clip.log.canvases.length, 0, `${name}: nothing rendered`);

    const encoding = page({ holdBlob: true });
    const second = exportProperty(encoding);
    second.catch(() => {});
    await tick();
    assert.equal(encoding.log.blobs.length, 1, 'encoding in progress');
    change(encoding.context);
    encoding.log.blobs[0].resolve();
    await assert.rejects(second, { reason: 'view_changed' }, `${name}: while encoding`);
    assert.equal(encoding.log.canvases[0].width, 0, 'canvas released');

    const saving = page();
    const result = await exportProperty(saving);
    assert.equal(result.stillCurrent(), true);
    change(saving.context);
    assert.equal(result.stillCurrent(), false, `${name}: right before saving`);
    for (const p of [clip, encoding, saving]) assert.equal(p.inFlight(), 0);
  }
});

test('property: losing download together with a view change ends it; a view change alone does not stop a downloader', async () => {
  for (const [name, change] of Object.entries(VIEW_CHANGES)) for (const order of [[change, loseDownload], [loseDownload, change]]) {
    // 400 px fits the no-download rule in the first view (438 px), and only there.
    const p = page({ permissions: WITH_DOWNLOAD, holdBlob: true });
    const done = exportProperty(p, chosenProperty(), { size: 400 });
    done.catch(() => {});
    await tick();
    assert.equal(p.log.canvases[0].width, 400);
    for (const step of order) step(p.context);
    p.log.blobs[0].resolve();
    await rejects(done, 'name', 'AbortError');
    const saving = page({ permissions: WITH_DOWNLOAD });
    const result = await exportProperty(saving, chosenProperty(), { size: 400 });
    for (const step of order) step(saving.context);
    assert.equal(result.stillCurrent(), false, `${name}: before saving`);
  }
  for (const [name, change] of Object.entries(VIEW_CHANGES)) {
    const p = page({ permissions: WITH_DOWNLOAD, holdBlob: true });
    const done = exportProperty(p);
    await tick();
    change(p.context);
    p.log.blobs[0].resolve();
    const result = await done;
    assert.deepEqual([result.width, result.stillCurrent()], [2048, true], name);
  }
  // Download lost while the view still holds the property at that size: saved.
  const kept = page({ permissions: WITH_DOWNLOAD, holdBlob: true });
  const done = exportProperty(kept, chosenProperty(), { size: 400 });
  await tick();
  loseDownload(kept.context);
  kept.log.blobs[0].resolve();
  assert.equal((await done).stillCurrent(), true);
  // A pan that keeps it all in view, at the same scale, changes nothing.
  const nudged = page();
  const result = await exportProperty(nudged);
  nudged.context.map.getBounds = () => viewOf(500025, 500385, 4700022, 4700182);
  assert.equal(result.stillCurrent(), true);
});

test('property: a viewer, version or access change while the capture is read ends it with no file', async () => {
  for (const change of [c => c.applyViewerSession(session({ subject: 'person-two' })), c => { c.PROJECT = model('v2'); }, c => c.setSessionAccessState('unavailable', 'session-expired')]) {
    const p = page(), reading = deferred();
    p.context.readCaptureMask = async () => { await reading.promise; return { captured: () => true, inside: () => 100 }; };
    const done = exportProperty(p);
    await tick();
    assert.equal(p.inFlight(), 1);
    change(p.context);
    reading.resolve();
    await rejects(done, 'name', 'AbortError');
    assert.equal(p.log.canvases.length, 0, 'nothing rendered');
    assert.equal(p.inFlight(), 0);
  }
  const none = page();
  none.context.readCaptureMask = async () => ({ captured: () => false, inside: () => 0 });
  await rejects(exportProperty(none), 'code', 'print_property');
  assert.equal(none.log.canvases.length, 0);
});

test('choosing a property belongs to the viewer who chose: a change while picking or loading gives nothing', async () => {
  const ring = [[500100, 4700050], [500100, 4700150], [500300, 4700150], [500300, 4700050], [500100, 4700050]];
  const lines = extra => ({ state: { merge: true }, attribution: () => 'Source: Synthetic Parcel Map R1.', loadPrintParcels: () => null, sync() {}, suspend() {}, resume() {}, ...extra });
  const found = { outline: { owner: 'EXAMPLE OWNER', parcels: [{ rings: [ring] }], lines: [ring] }, outlines: [], areaM2: 20000 };
  const open = (pick, resolve) => {
    const p = page();
    p.context.propertyLines = lines();
    p.context.pickMapPoint = pick; p.context.resolvePrintProperty = resolve;
    return p;
  };
  const p = open(async () => [500200, 4700100], async () => found);
  const selection = await p.context.choosePrintProperty();
  assert.equal(selection.identity, IDENTITY());
  assert.equal(selection.label, 'EXAMPLE OWNER ≈ 2.0 ha');
  assert.deepEqual(selection.parcels[0].rings[0][0], [500100, 4700050]);
  assert.equal(await open(async () => null, async () => found).context.choosePrintProperty(), null, 'nothing picked');
  for (const stage of ['pick', 'load']) {
    const gate = deferred();
    const q = open(async () => { if (stage === 'pick') await gate.promise; return [500200, 4700100]; }, async () => { if (stage === 'load') await gate.promise; return found; });
    const choosing = q.context.choosePrintProperty();
    await tick();
    q.context.applyViewerSession(session({ subject: 'person-two' }));
    gate.resolve();
    await rejects(choosing, 'name', 'AbortError');
  }
  const denied = open(async () => [1, 1], async () => found);
  denied.context.SHARE_PERMISSIONS = { view: true, measure: false };
  await rejects(denied.context.choosePrintProperty(), 'name', 'AbortError');
});

test('dialog: My property needs a choice, shows it, sends it, and drops it when the dialog opens again', async () => {
  const doc = fakeDocument(), runs = [];
  const opener = doc.createElement('button');
  let next = { label: 'EXAMPLE OWNER ≈ 40.0 ac' };
  const { controls } = mountOrthoPrintDialog({ documentRef: doc, openButton: opener, defaults: () => ({ chooseAvailable: true }), chooseProperty: async () => { if (next instanceof Error) throw next; return next; },
    run: async options => { runs.push(options); return { blob: new Blob(['x']), filename: 'x.png' }; } });
  await opener.fire('click');
  controls.area.value = 'property';
  await controls.area.fire('change');
  assert.deepEqual([controls.exportButton.disabled, controls.format.disabled, controls.format.value], [true, true, 'png']);
  await controls.choose.fire('click');
  assert.deepEqual([controls.chosen.textContent, controls.exportButton.disabled], ['EXAMPLE OWNER ≈ 40.0 ac', false]);
  next = null;
  await controls.choose.fire('click');
  assert.equal(controls.chosen.textContent, 'EXAMPLE OWNER ≈ 40.0 ac', 'a cancelled pick keeps the choice');
  await controls.exportButton.fire('click');
  assert.equal(runs[0].selection.label, 'EXAMPLE OWNER ≈ 40.0 ac');
  assert.equal(controls.exportButton.disabled, false);
  next = printProperty.printPropertyError('clipped');
  await controls.choose.fire('click');
  assert.deepEqual([controls.chosen.textContent, controls.exportButton.disabled, controls.status.textContent], ['', true, printProperty.PRINT_PROPERTY_MESSAGES.clipped]);
  next = new TypeError('internal detail');
  await controls.choose.fire('click');
  assert.equal(controls.status.textContent, 'Could not load the property. Try again.');
  await opener.fire('click');
  controls.area.value = 'view';
  await controls.area.fire('change');
  assert.deepEqual([controls.exportButton.disabled, controls.format.disabled], [false, false]);
  await controls.exportButton.fire('click');
  assert.equal('selection' in runs[1], false);
});

// ── The Print map page ───────────────────────────────────────────────────

function printPageOf({ permissions = WITH_DOWNLOAD, holdOpen = false } = {}) {
  const p = page({ holdOpen, permissions });
  const seen = { shut: 0, parcels: [] };
  Object.assign(p.context, {
    isIosLike: () => false, IOS_MAX_PIXELS, IMAGERY_CREDIT, verifyOrthoCrs, tilesCoverBounds, dissolveParcelsByOwner, captureDates, camFeatures: [], utmToLatLon: (e, n) => [n, e],
    createSheetMeasure: () => () => 0, createPrintModel: deps => { seen.deps = deps; return { deps }; }, printPageJob: null,
    printPage: { shut() { seen.shut++; p.context.printPageJob?.end(); } },
    readCaptureMask: async () => ({ captured: () => true, inside: () => 100 }),
    propertyLines: { state: { merge: false }, attribution: () => 'Source: Synthetic Parcel Map R1.', datumNote: () => '', sync() {}, suspend() {}, resume() {},
      loadPrintParcels: async bounds => { seen.parcels.push(bounds); return { status: 'ok', parcels: [{ id: 1, owner: 'EXAMPLE OWNER', rings: [[[0, 0], [0, 1], [1, 1], [0, 0]]] }], loaded: new Set(['14/1/1']), failed: false, partial: false }; } },
  });
  const dataset = p.context.getDataset;
  p.context.getDataset = async (...args) => { const ds = await dataset(...args); ds.llBounds = [[44, -90], [44.1, -89.9]]; return ds; };
  return { p, seen };
}

test('print page: opens for this viewer with the orthophoto’s parcels, and is released when it closes', async () => {
  const { p, seen } = printPageOf();
  await p.context.openPrintPage();
  assert.equal(p.inFlight(), 1);
  assert.deepEqual({ ...seen.parcels[0] }, { west: -90, south: 44, east: -89.9, north: 44.1 });
  assert.equal(seen.deps.outlines.length, 1);
  assert.equal(seen.deps.attribution, 'Source: Synthetic Parcel Map R1.');
  assert.equal(seen.deps.imageryCredit, IMAGERY_CREDIT);
  assert.equal(seen.deps.merge, false);
  assert.equal(seen.deps.orthoGsd, 2);
  assert.deepEqual([seen.deps.meta.title, seen.deps.meta.captured, seen.deps.maxPixels], ['Model', null, Infinity]);
  seen.deps.checkpoint();
  p.context.printPageJob.end();
  assert.equal(p.inFlight(), 0);
  assert.throws(() => seen.deps.checkpoint(), { name: 'AbortError' });
});

test('print page: needs measure permission, an orthophoto and a matching verified position', async () => {
  for (const [change, code] of [[c => { c.SHARE_PERMISSIONS = { view: true, measure: false }; }, 'print_not_permitted'], [c => { c.ORTHO_URL = null; }, 'print_no_ortho'],
    [c => { c.measurementCoordinateReference = () => ({ crs: 'local' }); }, 'print_property'], [c => { c.measurementCoordinateReference = () => ({ crs: 'EPSG:32617' }); }, 'print_crs']]) {
    const { p, seen } = printPageOf();
    change(p.context);
    await rejects(p.context.openPrintPage(), 'code', code);
    assert.equal(seen.deps, undefined);
    assert.equal(p.inFlight(), 0);
  }
});

test('print page: a viewer, version or access change closes it, while opening or later', async () => {
  const changes = [c => c.applyViewerSession(session({ subject: 'person-two', permissions: WITH_DOWNLOAD })), c => c.setSessionAccessState('unavailable', 'session-expired')];
  for (const change of changes) {
    const { p, seen } = printPageOf({ holdOpen: true });
    const opening = p.context.openPrintPage();
    await tick();
    change(p.context);
    assert.equal(p.log.opens[0].signal.aborted, true);
    assert.ok(seen.shut >= 1);
    p.log.opens[0].resolve();
    await rejects(opening, 'name', 'AbortError');
    assert.equal(seen.deps, undefined);
    const later = printPageOf();
    await later.p.context.openPrintPage();
    change(later.p.context);
    assert.equal(later.seen.shut, 1, 'the open page is closed at once');
    assert.equal(later.p.inFlight(), 0);
    assert.throws(() => later.seen.deps.checkpoint(), { name: 'AbortError' });
  }
  // A version change with no session event is caught at the next step.
  const quiet = printPageOf();
  await quiet.p.context.openPrintPage();
  quiet.p.context.PROJECT = model('v2');
  assert.throws(() => quiet.seen.deps.checkpoint(), { name: 'AbortError' });
});

test('print page: losing download closes a page opened with it; a plain renewal keeps it; without download it stays open', async () => {
  const kept = printPageOf();
  await kept.p.context.openPrintPage();
  kept.p.context.applyViewerSession(session({ permissions: WITH_DOWNLOAD, expiresIn: 900_000 }));
  assert.equal(kept.seen.shut, 0);
  kept.seen.deps.checkpoint();
  kept.p.context.applyViewerSession(session({ permissions: WITHOUT_DOWNLOAD }));
  assert.equal(kept.seen.shut, 1);
  const low = printPageOf({ permissions: WITHOUT_DOWNLOAD });
  await low.p.context.openPrintPage();
  low.p.context.applyViewerSession(session({ permissions: WITHOUT_DOWNLOAD, expiresIn: 900_000 }));
  assert.equal(low.seen.shut, 0);
  assert.equal(low.seen.deps.policy().whole, false);
});
