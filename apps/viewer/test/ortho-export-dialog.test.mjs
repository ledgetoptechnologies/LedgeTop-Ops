// Export dialog and parcel picker wiring on a small DOM: picking is one
// session at a time and tears down what it set up; an export cancelled
// while the save picker or the file is opening creates nothing; and a
// file that was committed is reported as saved, even if Cancel came late.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiniDocument } from './helpers/mini-dom.mjs';
import { mountOrthoExportDialog } from '../ortho-export-dialog.mjs';
import { createParcelPicker } from '../ortho-export-parcels.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function miniDocument() {
  const { document, window } = createMiniDocument();
  const create = document.createElement;
  document.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'dialog') {
      node.open = false;
      node.showModal = () => { node.open = true; };
      node.close = () => { if (!node.open) return; node.open = false; void node.fire('close'); };
    }
    return node;
  };
  document.createElementNS = (ns, tag) => document.createElement(tag);
  return { document, window };
}

function fakeMap() {
  const handlers = new Set(), classes = new Set();
  return {
    handlers, classes,
    on(type, fn) { if (type === 'click') handlers.add(fn); },
    off(type, fn) { if (type === 'click') handlers.delete(fn); },
    getContainer: () => ({ classList: { add: c => classes.add(c), remove: c => classes.delete(c) } }),
    getPane: () => true, createPane: () => ({ style: {} }),
  };
}

function picker() {
  const { document } = miniDocument();
  const host = document.createElement('div');
  let map = fakeMap();
  const L = { polygon: () => ({ addTo() { return this; }, remove() {} }) };
  const parcels = [{ key: 'a', rings: [[[0, 0], [10, 0], [10, 10], [0, 10]]] }];
  const p = createParcelPicker({ L, getMap: () => map, getParcels: () => parcels, documentRef: document, host });
  return { p, host, document, get map() { return map; }, replaceMap() { const old = map; map = fakeMap(); return old; } };
}

test('parcel picking is single-flight: a second pick joins the first, one bar, one map listener', async () => {
  const t = picker();
  const first = t.p.pick(), second = t.p.pick();
  assert.equal(first, second, 'the same picking session');
  assert.equal(t.host.querySelectorAll('.oe-pick-bar').length, 1, 'one bar');
  assert.equal(t.map.handlers.size, 1, 'one click listener');
  [...t.map.handlers][0]({ latlng: { lng: 5, lat: 5 } });
  t.p.finish();
  assert.equal(await first, 1);
  assert.equal(t.host.querySelectorAll('.oe-pick-bar').length, 0, 'bar removed');
  assert.equal(t.map.handlers.size, 0, 'listener removed');
  assert.equal(t.p.picking, false);
});

test('picking tears down what it set up, even when the map was replaced meanwhile', async () => {
  const t = picker();
  const done = t.p.pick();
  const old = t.replaceMap();
  t.p.finish();
  assert.equal(await done, 0);
  assert.equal(old.handlers.size, 0, 'the click listener left the map it was added to');
  assert.equal(old.classes.has('oe-picking'), false, 'picking cursor removed from that map');
  // A late click from the old session changes nothing.
  const late = t.p.pick();
  const handler = [...t.map.handlers][0];
  t.p.finish();
  await late;
  handler({ latlng: { lng: 5, lat: 5 } });
  assert.equal(t.p.count, 0, 'a finished session no longer selects');
});

function dialog({ pixels = 200_000_000, picker: withPicker = true, run, pickParcels } = {}) {
  const { document, window } = miniDocument();
  const log = { pickers: [], writables: [], runs: [], picks: 0 };
  if (withPicker) {
    window.showSaveFilePicker = () => {
      const d = deferred();
      log.pickers.push(d);
      return d.promise;
    };
  }
  const handle = () => ({
    createWritable: () => {
      const d = deferred();
      const writable = { aborted: false, abort: async () => { writable.aborted = true; } };
      log.writables.push({ ...d, writable });
      return d.promise;
    },
  });
  const side = Math.round(Math.sqrt(pixels));
  const api = mountOrthoExportDialog({
    documentRef: document, windowRef: window,
    defaults: () => ({ areas: { full: true, view: true, parcels: true }, parcelCount: 0, contoursAvailable: false, propertyAvailable: false, geotiffAvailable: true }),
    preview: async () => ({ canvas: document.createElement('canvas'), width: side, height: side }),
    run: run || (async (options, signal, extra) => { log.runs.push({ options, signal, extra }); return { blob: null, filename: options.filename, committed: Boolean(extra.writable) }; }),
    pickParcels: pickParcels || (() => { log.picks += 1; return new Promise(() => {}); }),
  });
  api.open();
  return { api, log, handle, document };
}

const ready = async () => { await wait(160); await tick(); };

test('Cancel while the save picker is open: no file is created and nothing runs', async () => {
  const t = dialog();
  await ready();
  const { exportButton, cancel, status } = t.api.controls;
  assert.equal(exportButton.disabled, false);
  void exportButton.click();
  await tick();
  assert.equal(t.log.pickers.length, 1, 'save picker shown');
  assert.equal(exportButton.disabled, true, 'busy while the picker is open');
  await cancel.click();
  assert.equal(status.textContent, 'Export cancelled.');
  const h = t.handle();
  t.log.pickers[0].resolve(h);
  await tick();
  assert.equal(t.log.writables.length, 0, 'no writable opened after the cancel');
  assert.equal(t.log.runs.length, 0, 'no export ran');
  assert.equal(status.textContent, 'Export cancelled.');
});

test('Close while the file is opening: the writable is discarded and nothing runs', async () => {
  const t = dialog();
  await ready();
  void t.api.controls.exportButton.click();
  await tick();
  t.log.pickers[0].resolve(t.handle());
  await tick();
  assert.equal(t.log.writables.length, 1, 'file opening');
  t.api.dialog.close();
  await tick();
  t.log.writables[0].resolve(t.log.writables[0].writable);
  await tick();
  assert.equal(t.log.writables[0].writable.aborted, true, 'the opened file is discarded');
  assert.equal(t.log.runs.length, 0, 'no export ran');
});

test('a committed file is reported as saved; Cancel is off while it is being committed', async () => {
  const commit = deferred();
  let onCommitSeen = false;
  const t = dialog({ run: async (options, signal, extra) => {
    extra.onCommit();
    onCommitSeen = true;
    await commit.promise;
    return { blob: null, filename: options.filename, committed: true };
  } });
  await ready();
  const { exportButton, cancel, status } = t.api.controls;
  void exportButton.click();
  await tick();
  t.log.pickers[0].resolve(t.handle());
  await tick();
  t.log.writables[0].resolve(t.log.writables[0].writable);
  await tick();
  assert.ok(onCommitSeen);
  assert.equal(cancel.disabled, true, 'nothing left to cancel once the file is being committed');
  await cancel.click();
  commit.resolve();
  await tick();
  assert.match(status.textContent, /^Saved orthophoto/);
  assert.equal(cancel.disabled, false);
});

test('a cancel during the final check is not reported as saved', async () => {
  const t = dialog({ picker: false, pixels: 1_000_000, run: async (options, signal) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError');
    return { blob: null, filename: options.filename };
  } });
  await ready();
  const { exportButton, cancel, status } = t.api.controls;
  void exportButton.click();
  await tick();
  await cancel.click();
  await wait(40);
  assert.equal(status.textContent, 'Export cancelled.');
});

test('parcel picking from the dialog is single-flight and reopens the dialog when it ends', async () => {
  const picks = [];
  const t = dialog({ pixels: 1_000_000, pickParcels: () => { const d = deferred(); picks.push(d); return d.promise; } });
  await ready();
  const { area, pickButton } = t.api.controls;
  for (const [value, input] of Object.entries(area.inputs)) input.checked = value === 'parcels';
  await area.inputs.parcels.fire('change');
  assert.equal(t.api.dialog.open, false, 'the dialog hides while picking');
  await pickButton.click();
  await area.inputs.parcels.fire('change');
  assert.equal(picks.length, 1, 'one picking session');
  picks[0].reject(new Error('map went away'));
  await tick();
  assert.equal(t.api.dialog.open, true, 'reopened after a failed pick');
  await pickButton.click();
  assert.equal(picks.length, 2, 'a new pick can start once the first ended');
  picks[1].resolve(2);
  await tick();
  assert.equal(t.api.dialog.open, true);
});
