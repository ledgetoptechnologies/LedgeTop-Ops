// Exact main.js wiring: the shipped installPropertyLines, applyViewerSession,
// setSessionAccessState and the session LOD-availability refresh run in a VM
// with the real property-lines controller. A stationary page (no camera, mode,
// tile or raster event) that accepts a new model version for the same model
// must drop the old version's outlines and ask for the new version at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { createUtmProjection } from '../utm-conversion.mjs';
import { modelHorizontalDatum, verifiedUtmGeoref } from '../property-lines.mjs';
import { createPropertyLinesController } from '../property-lines-layer.mjs';

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function extract(signature) {
  const start = source.indexOf(`\n${signature}`);
  assert.ok(start >= 0, signature);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start + 1, end + 3);
}
const SHIPPED = ['function syncMeasurementActionVisibility()', 'function sessionAccessLabel(', 'function setSessionAccessState(',
  'function applyViewerSession(', 'async function refreshLodAvailability()', 'function propertyLinesSceneExtent()',
  'function installPropertyLines()', 'function utmToLatLon(', 'function latLonToUtm(', 'function utmToWorld('].map(extract).join('\n');

const projection = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
const [E0, N0] = projection.latLonToUtm(43.0745, -89.401);
const ring = (dLon) => [[-89.4012 + dLon, 43.0742], [-89.4008 + dLon, 43.0742], [-89.4008 + dLon, 43.0746], [-89.4012 + dLon, 43.0742]];
const V1 = { status: 'ok', parcels: [{ id: 1, rings: [ring(0)] }] };
const V2 = { status: 'ok', parcels: [{ id: 2, rings: [ring(0.0001)] }] };
// The shipped controller debounces parcel requests (350 ms) with real timers.
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 400));
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};
const reply = body => ({ ok: true, status: 200, json: async () => body });

function model(version) {
  return { id: 'model-one', title: 'Model', activeVersion: { id: version },
    georef: { utmZoneLon0Deg: -87, hemisphere: 'N', rtc: { e: E0, n: N0, z: 0 }, bboxCenter: { x: 0, y: 0, z: 0 } } };
}
function session(version, extra = {}) {
  return { sessionId: 'session-id', accessToken: 'token-x', subject: 'person-one', audience: 'client', permissions: { view: true },
    model: model(version), expiresAt: new Date(Date.now() + 600_000).toISOString(), ...extra };
}

function page() {
  const requests = [], offers = [], pending = [], layers = new Set(), panes = {};
  const el = () => ({ hidden: true, textContent: '', dataset: {}, disabled: false, style: {}, classList: { toggle() {} },
    setAttribute() {}, addEventListener() {}, querySelector: () => ({ textContent: '' }) });
  const nodes = {};
  const map = {
    getBounds: () => ({ getWest: () => -89.4015, getSouth: () => 43.0741, getEast: () => -89.4005, getNorth: () => 43.0749 }),
    getPane: name => panes[name], createPane: name => (panes[name] = { style: {} }),
    hasLayer: layer => layers.has(layer), removeLayer: layer => layers.delete(layer),
  };
  const L = { canvas: () => ({}), polyline: (rings, options) => ({ rings, options, addTo() { layers.add(this); return this; } }) };
  const first = session('v1');
  const context = vm.createContext({
    THREE, L, LineSegments2, LineSegmentsGeometry, LineMaterial, createPropertyLinesController, verifiedUtmGeoref, modelHorizontalDatum,
    console: { warn() {} }, setTimeout: () => 0, clearTimeout() {}, setImmediate, Date, JSON, Array, Promise,
    window: {}, location: { href: 'https://viewer.invalid/view' },
    document: { getElementById: id => (nodes[id] ||= el()) },
    fetch: async url => {
      if (url.startsWith('/api/v1/property-lines/parcels')) {
        const version = context.PROJECT.activeVersion.id;
        requests.push(version);
        return new Promise(resolve => pending.push({ version, resolve }));
      }
      offers.push(context.PROJECT.activeVersion.id);
      return reply({ offered: true, source: { name: 'Fixture parcels', release: 'T1', credit: 'C', disclaimer: 'Not a survey.' } });
    },
    VIEW_MODE: 'session', PROJECT: first.model, activeViewerSession: first, propertyLines: null,
    UTM_PROJECTION: projection, RTC: { e: E0, n: N0, z: 0 }, C: { x: 0, y: 0, z: 0 },
    state: { activeMode: 'ortho', cloudMode: 'none', meshSource: 'lod-required' },
    ORTHO_URL: '/ortho.tif', DSM_URL: null, DTM_URL: null,
    geoDatasets: { '/ortho.tif': { minE: E0 - 100, minN: N0 - 80, maxE: E0 + 100, maxN: N0 + 80 } },
    map, scene: null, tilesRenderer: null, pointCloudObject: null, TILES_URL: null, EPT_URL: null,
    sessionCapabilities: { read: () => 'token-x', write() {} }, sessionStorageKey: 'k', SESSION_STORAGE_PREFIX: 'p:',
    sessionAllowedOrigins: [], SHARE_PERMISSIONS: {}, sessionAccessState: 'active', sessionAccessReason: null,
    sessionRenewalBlocked: false, lodAvailabilityTimer: null, lodAvailabilityRefreshInFlight: false,
    dom: { lodStatus: {}, cloudStatus: {} },
    measurementDraftRecovery: { capture() {}, hasPending: () => false }, measurementWorkspace: null, viewerSlice: null,
    viewerProductDownloads: null,
    setDisplayUnits() {}, renderStaffNavigation() {}, renderClientNavigation() {}, applyProjectConfig() {},
    scheduleLodAvailabilityRefresh() {}, stopLodAvailabilityRefresh() {}, scheduleSessionRenewal() {},
    propertyLinesGroundGrid: async () => null, recoverFailedLodTiles() {}, pcApi: () => null, installMeasurementWorkspace() {}, installContours() {}, cancelStaleOrthoPrintExports() {}, applyAvailability: () => [],
    currentViewerSession: async () => session('v1'),
  });
  vm.runInContext(SHIPPED, context);
  const rings = () => [...layers].map(layer => layer.rings);
  return { context, requests, offers, pending, layers, rings };
}

test('a stationary session moving to a new model version drops the old outlines and asks for the new version', async () => {
  const p = page();
  p.context.installPropertyLines();
  await flush();
  assert.deepEqual(p.offers, ['v1']);
  assert.deepEqual(p.requests, ['v1'], 'v1 parcels requested by default');
  const v1Request = p.pending.shift();

  // The shipped session LOD-availability refresh accepts v2 for the same model; nothing else happens on the page.
  p.context.currentViewerSession = async () => session('v2');
  await p.context.refreshLodAvailability();
  await flush();
  assert.equal(p.context.PROJECT.activeVersion.id, 'v2');
  assert.deepEqual(p.offers, ['v1', 'v2'], 'offer asked again for v2 without any interaction');
  assert.deepEqual(p.requests, ['v1', 'v2'], 'v2 parcels requested without any interaction');

  // The v1 answer arrives after the switch and before any interaction: never drawn.
  v1Request.resolve(reply(V1));
  await flush();
  assert.equal(p.layers.size, 0, 'old version outlines not drawn');

  p.pending.shift().resolve(reply(V2));
  await flush();
  assert.equal(p.layers.size, 2);
  assert.deepEqual(p.rings()[0], [V2.parcels[0].rings[0].map(([lon, lat]) => [lat, lon])], 'only v2 outlines');
  assert.equal(p.context.propertyLines.state.status, 'ready');

  // The same context again (a plain renewal) changes nothing and fetches nothing.
  await p.context.refreshLodAvailability();
  p.context.applyViewerSession(session('v2', { expiresAt: new Date(Date.now() + 900_000).toISOString() }));
  await flush();
  assert.deepEqual(p.offers, ['v1', 'v2']);
  assert.deepEqual(p.requests, ['v1', 'v2']);
  assert.equal(p.layers.size, 2, 'lines kept');
});

test('drawn outlines from the old version are cleared at once when the version changes', async () => {
  const p = page();
  p.context.installPropertyLines();
  await flush();
  p.pending.shift().resolve(reply(V1));
  await flush();
  assert.equal(p.layers.size, 2, 'v1 drawn');
  p.context.currentViewerSession = async () => session('v2');
  await p.context.refreshLodAvailability();
  assert.equal(p.layers.size, 0, 'v1 outlines removed as soon as v2 is accepted');
  await flush();
  assert.deepEqual(p.requests, ['v1', 'v2']);
  p.pending.shift().resolve(reply(V2));
  await flush();
  assert.deepEqual(p.rings()[0], [V2.parcels[0].rings[0].map(([lon, lat]) => [lat, lon])]);
});

test('geometry is fenced by the live project/version even before a sync', async () => {
  const p = page();
  p.context.installPropertyLines();
  await flush();
  const v1Request = p.pending.shift();
  // The page's model changes underneath without any session hook.
  p.context.PROJECT = model('v2');
  v1Request.resolve(reply(V1));
  await flush();
  assert.equal(p.layers.size, 0, 'stale v1 geometry not drawn');
  assert.deepEqual(p.offers, ['v1', 'v2'], 'the dropped answer triggers the v2 offer');
  assert.deepEqual(p.requests, ['v1', 'v2']);
});
