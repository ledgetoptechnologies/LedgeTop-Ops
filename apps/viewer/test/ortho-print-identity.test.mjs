// Export identity continuity: the shipped exportOrthoPrintFromViewer,
// planOrthoExport, applyViewerSession, setSessionAccessState and the export
// fence run in a VM with the real streamed export pipeline. An export belongs
// to the viewer (audience and subject), model and version it started for: if
// the page moves to anything else mid-export, even a viewer that may also
// print, it ends as a cancel and nothing is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { CONTOUR_COLORS } from '../contours.mjs';
import { VIEW_EXPORT_MAX_EDGE, assertOrthoPrintAllowed, clampExtent, orthoPrintPolicy, printLongEdge, verifyOrthoCrs } from '../ortho-print-export.mjs';
import { createBlobSink, createFileSink, exportGrid, ringsExtent, streamOrthoExport } from '../ortho-export-stream.mjs';

globalThis.ImageData ||= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };

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
const line = (prefix) => { const start = source.indexOf(`\n${prefix}`); assert.ok(start >= 0, prefix); return source.slice(start + 1, source.indexOf('\n', start + 1) + 1); };
// viewerAccessAvailable, orthoPrintPermissions and the export fence (the in-flight set, identity and cancel hook).
const SHIPPED = [region('function viewerAccessAvailable()', 'function syncMeasurementActionVisibility()'), line('const policyArea ='),
  ...['function setSessionAccessState(', 'function applyViewerSession(', 'function printEpsg()', 'function planOrthoExport(',
    'function checkOrthoExport(', 'async function orthoExportLayers(', 'async function exportOrthoPrintFromViewer('].map(extract)].join('\n');

const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function model(version) {
  return { id: 'model-one', title: 'Model', activeVersion: { id: version } };
}
function session({ subject = 'person-one', version = 'v1', permissions = { view: true, measure: true }, expiresIn = 600_000 } = {}) {
  return { sessionId: 'session-id', subject, audience: 'client', permissions, model: model(version),
    expiresAt: new Date(Date.now() + expiresIn).toISOString() };
}

function page({ holdOpen = false, holdTrace = false, holdRead = false, permissions = undefined } = {}) {
  const log = { opens: [], traces: [], reads: [], canvases: [] };
  const hold = (enabled, list, value, extra) => {
    if (!enabled) { list.push({ ...extra }); return Promise.resolve(value); }
    const d = deferred();
    list.push({ ...extra, resolve: () => d.resolve(value) });
    return d.promise;
  };
  // 400 x 200 m orthophoto in EPSG:32616 at 2 m, one level.
  const image = {
    getWidth: () => 200, getHeight: () => 100,
    getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616 }), getResolution: () => [2, -2, 0], getFileDirectory: () => ({ getValue: () => undefined }),
    readRasters({ window: [x0, y0, x1, y1], signal }) {
      return hold(holdRead, log.reads, [0, 1, 2].map(() => new Uint8Array((x1 - x0) * (y1 - y0)).fill(120)), { signal });
    },
  };
  const ortho = { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200, nodata: NaN, images: [image] };
  const canvas = () => {
    const c = { width: 0, height: 0 };
    const ctx = new Proxy({
      canvas: c, measureText: text => ({ width: text.length * 7 }),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }),
    }, { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true });
    c.getContext = () => ctx;
    log.canvases.push(c);
    return c;
  };
  const first = session({ permissions });
  // A 720 x 320 px map showing E 500020–500380, N 4700020–4700180 (lat = N, lng = E here).
  const map = {
    getBounds: () => ({ getNorthWest: () => ({ lat: 4700180, lng: 500020 }), getNorthEast: () => ({ lat: 4700180, lng: 500380 }),
      getSouthWest: () => ({ lat: 4700020, lng: 500020 }), getSouthEast: () => ({ lat: 4700020, lng: 500380 }) }),
    latLngToContainerPoint: ([lat, lng]) => ({ x: (lng - 500020) * 2, y: (4700180 - lat) * 2 }),
  };
  const context = vm.createContext({
    orthoPrintPolicy, assertOrthoPrintAllowed, clampExtent, printLongEdge, verifyOrthoCrs, VIEW_EXPORT_MAX_EDGE,
    exportGrid, ringsExtent, streamOrthoExport, createBlobSink, createFileSink, orthoParcelPicker: null,
    AbortController, DOMException, console: { warn() {} }, reviewSessionChannel: null,
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
    measurementCoordinateReference: () => ({ crs: 'EPSG:32616' }), ensureGeoTiffPool: () => null,
    // applyViewerSession / setSessionAccessState collaborators, inert here.
    setDisplayUnits() {}, sessionStorageKey: 'k', SESSION_STORAGE_PREFIX: 'p:', sessionCapabilities: { write() {} },
    sessionAllowedOrigins: [], renderStaffNavigation() {}, renderClientNavigation() {}, dom: { lodStatus: {}, cloudStatus: {} },
    applyProjectConfig() {}, tilesRenderer: null, scheduleLodAvailabilityRefresh() {}, stopLodAvailabilityRefresh() {},
    scheduleSessionRenewal() {}, propertyLines: null, recoverFailedLodTiles() {}, pcApi: () => null, viewerProductDownloads: null,
    measurementDraftRecovery: { capture() {}, hasPending: () => false }, measurementWorkspace: null, viewerSlice: null,
    syncMeasurementActionVisibility() {}, syncViewerMarks() {}, sessionAccessLabel: () => '',
  });
  vm.runInContext(SHIPPED, context);
  // What the dialog does: run, then save only if the export is still current.
  const dialog = new AbortController();
  const exportNow = async (options = {}) => {
    try {
      const result = await context.exportOrthoPrintFromViewer({ area: 'view', format: 'png', contours: true, property: false, filename: 'orthophoto-view.png', ...options }, dialog.signal);
      return result.stillCurrent() ? result : null;
    } catch (error) { if (error?.name === 'AbortError') return null; throw error; }
  };
  return { context, log, dialog, exportNow, inFlight: () => vm.runInContext('orthoPrintExports.size', context) };
}

async function pngSize(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer);
  assert.deepEqual([...bytes.subarray(1, 4)], [80, 78, 71]);
  return [view.getUint32(16), view.getUint32(20)];
}

function assertNothing(p, saved, message) {
  assert.equal(saved, null, `${message}: nothing saved`);
  assert.equal(p.inFlight(), 0, `${message}: export released`);
  assert.ok(p.log.canvases.every(c => c.width === 0), `${message}: canvases released`);
}

test('happy path: a plain renewal mid-export keeps the export; without download a view stays at its screen size', async () => {
  const p = page({ holdOpen: true });
  const done = p.exportNow();
  await tick();
  assert.equal(p.log.opens.length, 1);
  // Same viewer, model and version with a later expiry: not a context change.
  p.context.applyViewerSession(session({ expiresIn: 900_000 }));
  assert.equal(p.log.opens[0].signal.aborted, false, 'renewal does not cancel');
  p.log.opens[0].resolve();
  const saved = await done;
  assert.equal(p.log.traces.length, 1, 'contours traced');
  assert.deepEqual(await pngSize(saved.blob), [720, 320]);
  assert.equal(p.inFlight(), 0);
});

test('a delayed export is cancelled when another viewer who may also print takes over the page', async () => {
  const p = page({ holdOpen: true });
  const done = p.exportNow();
  await tick();
  assert.equal(p.inFlight(), 1);
  const opening = p.log.opens[0];
  p.context.applyViewerSession(session({ subject: 'person-two' }));
  assert.equal(opening.signal.aborted, true, 'cancelled by the session change itself');
  opening.resolve();
  const saved = await done;
  assert.equal(p.log.traces.length, 0, 'no overlays traced for the old export');
  assert.equal(p.log.reads.length, 0, 'nothing rendered');
  assertNothing(p, saved, 'subject switch while opening the orthophoto');
});

test('a model version change during the contour trace stops the export, even without a session event', async () => {
  const p = page({ holdTrace: true });
  const done = p.exportNow();
  await tick();
  assert.equal(p.log.traces.length, 1);
  p.context.PROJECT = model('v2');
  p.log.traces[0].resolve();
  const saved = await done;
  assert.equal(p.log.reads.length, 0, 'nothing rendered after the trace');
  assertNothing(p, saved, 'version change during the trace');
});

test('a subject switch while the image is being rendered saves nothing', async () => {
  const p = page({ holdRead: true });
  const done = p.exportNow();
  await tick();
  assert.equal(p.log.reads.length, 1, 'rendering in progress');
  p.context.applyViewerSession(session({ subject: 'person-two' }));
  p.log.reads[0].resolve();
  assertNothing(p, await done, 'subject switch during rendering');
});

test('lost access cancels at once; closing the dialog is its own abort', async () => {
  const expired = page({ holdOpen: true });
  const first = expired.exportNow();
  await tick();
  expired.context.setSessionAccessState('unavailable', 'session-expired');
  assert.equal(expired.log.opens[0].signal.aborted, true);
  expired.log.opens[0].resolve();
  assertNothing(expired, await first, 'access lost');

  const closed = page({ holdOpen: true });
  const second = closed.exportNow();
  await tick();
  closed.dialog.abort();
  assert.equal(closed.log.opens[0].signal.aborted, true, 'Close aborts the export');
  closed.log.opens[0].resolve();
  assertNothing(closed, await second, 'dialog closed');
});

const WITH_DOWNLOAD = { view: true, measure: true, download: true };
const WITHOUT_DOWNLOAD = { view: true, measure: true, download: false };

test('with download the export is full native resolution: whole orthophoto and current view', async () => {
  const whole = page({ permissions: WITH_DOWNLOAD });
  assert.deepEqual(await pngSize((await whole.exportNow({ area: 'full' })).blob), [200, 100]);
  const view = page({ permissions: WITH_DOWNLOAD });
  assert.deepEqual(await pngSize((await view.exportNow()).blob), [180, 80], 'the view at the orthophoto\'s own 2 m pixels');
  const denied = page({ permissions: WITHOUT_DOWNLOAD });
  await assert.rejects(denied.context.exportOrthoPrintFromViewer({ area: 'full', format: 'png' }), { code: 'print_not_permitted' });
});

test('download revoked by a same-subject renewal during rendering: no file, with or without a session event', async () => {
  const p = page({ holdRead: true, permissions: WITH_DOWNLOAD });
  const done = p.exportNow();
  await tick();
  assert.equal(p.log.reads.length, 1, 'rendering in progress');
  p.context.applyViewerSession(session({ permissions: WITHOUT_DOWNLOAD }));
  assert.equal(p.log.reads[0].signal.aborted, true, 'cancelled by the session change itself');
  p.log.reads[0].resolve();
  assertNothing(p, await done, 'download revoked during rendering');

  const q = page({ holdRead: true, permissions: WITH_DOWNLOAD });
  const quiet = q.exportNow();
  await tick();
  q.context.SHARE_PERMISSIONS = WITHOUT_DOWNLOAD;
  q.log.reads[0].resolve();
  assertNothing(q, await quiet, 'download revoked without a session event');
});

test('download revoked after rendering, right before the dialog saves: no file', async () => {
  const p = page({ permissions: WITH_DOWNLOAD });
  const result = await p.context.exportOrthoPrintFromViewer({ area: 'view', format: 'png', filename: 'x.png' }, null);
  assert.ok(result.blob);
  p.context.applyViewerSession(session({ permissions: WITHOUT_DOWNLOAD }));
  assert.equal(result.stillCurrent(), false);
  const kept = page({ permissions: WITH_DOWNLOAD });
  const keptResult = await kept.context.exportOrthoPrintFromViewer({ area: 'view', format: 'png', filename: 'x.png' }, null);
  kept.context.applyViewerSession(session({ permissions: WITH_DOWNLOAD, expiresIn: 900_000 }));
  assert.equal(keptResult.stillCurrent(), true);
});
