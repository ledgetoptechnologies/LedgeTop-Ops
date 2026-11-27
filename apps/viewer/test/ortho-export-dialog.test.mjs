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

function dialog({ pixels = 200_000_000, picker: withPicker = true, run, pickParcels, products = null, size = null, geotiff = true, parcels = () => 0, contours = false, settleMs = 0 } = {}) {
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
    defaults: () => ({ areas: { full: true, view: true, parcels: true }, parcelCount: parcels(), contoursAvailable: contours, propertyAvailable: false, geotiffAvailable: geotiff }),
    preview: async () => { log.previews = (log.previews || 0) + 1; return { canvas: document.createElement('canvas'), width: size?.[0] ?? side, height: size?.[1] ?? side }; },
    run: run || (async (options, signal, extra) => { log.runs.push({ options, signal, extra }); return { blob: null, filename: options.filename, committed: Boolean(extra.writable) }; }),
    pickParcels: pickParcels || (() => { log.picks += 1; return new Promise(() => {}); }),
    products, settleMs,
  });
  api.open();
  return { api, log, handle, document };
}

const ready = async () => { await wait(160); await tick(); };
// A real press: the pointer goes down on the control inside the dialog, then the click.
const press = async (node) => { await node.fire("pointerdown"); return node.click(); };

test('Cancel while the save picker is open: no file is created and nothing runs', async () => {
  const t = dialog();
  await ready();
  const { exportButton, cancel, status } = t.api.controls;
  assert.equal(exportButton.disabled, false);
  void press(exportButton);
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
  void press(t.api.controls.exportButton);
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
  void press(exportButton);
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
  void press(exportButton);
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

test('a cancelled export that unwinds late does not reopen Cancel during a newer export\'s commit', async () => {
  const runs = [];
  const t = dialog({ picker: false, pixels: 1_000_000, run: (options, signal, extra) => {
    const d = deferred();
    runs.push({ signal, extra, ...d });
    return d.promise;
  } });
  await ready();
  const { exportButton, cancel, status } = t.api.controls;
  void press(exportButton);
  await tick();
  await cancel.click();                       // A is cancelled but its run is still unwinding
  void press(exportButton);
  await tick();
  assert.equal(runs.length, 2);
  runs[1].extra.writable = {};
  runs[1].extra.onCommit();                    // B starts writing its file
  assert.equal(cancel.disabled, true);
  runs[0].reject(new DOMException('Export cancelled.', 'AbortError'));
  await tick();
  assert.equal(cancel.disabled, true, 'A ending late leaves B\'s commit fenced');
  runs[1].resolve({ blob: null, filename: 'orthophoto.png', committed: true });
  await tick();
  assert.match(status.textContent, /^Saved orthophoto/);
  assert.equal(cancel.disabled, false);
});

test('the stream checks last, right before the file is closed', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../ortho-export-stream.mjs', import.meta.url), 'utf8');
  assert.match(source, /abortIf\(signal\);\s*await beforeClose\?\.\(\);\s*\} catch \(error\) \{ encoder\.abort\(\); sink\.abort\(\); throw error; \}\s*return sink\.close\(\);/);
});

// ---- the Download dialog: products and the orthophoto in one place ----------------

function productsStub(items = [
  { kind: 'ortho', label: 'Orthophoto', format: 'TIF', size: '3.7 GiB' },
  { kind: 'dsm', label: 'Surface model (DSM)', format: 'TIF', size: '2.9 GiB' },
]) {
  const downloads = [];
  return { downloads, available: () => true, list: async () => items, download: async (product) => { downloads.push(product.kind); return { fileName: product.kind }; } };
}
const rows = (t) => t.api.controls.list.children.map(item => item.children[0]);
const rowText = (t) => rows(t).map(node => node.textContent);
const shown = (node) => { for (let n = node; n; n = n.parent) if (n.hidden) return false; return true; };

test('one Download dialog: the products, with the orthophoto offered as TIFF, JPEG or PNG on its own page', async () => {
  const products = productsStub();
  const t = dialog({ pixels: 1_000_000, products });
  await tick();
  const { title, back, format, downloadButton } = t.api.controls;
  assert.equal(title.textContent, 'Download');
  assert.deepEqual(rowText(t), ['OrthophotoTIFF, JPEG or PNG · original 3.7 GiB', 'Surface model (DSM)TIF · 2.9 GiB']);
  assert.equal(shown(downloadButton), false, 'no Download button on the list');
  await press(rows(t)[1]);
  assert.deepEqual(products.downloads, ['dsm'], 'a product row downloads that product');
  await press(rows(t)[0]);
  await ready();
  assert.equal(title.textContent, 'Orthophoto');
  assert.deepEqual(Object.entries(format.inputs).filter(([, input]) => shown(input)).map(([value]) => value), ['tif', 'jpg', 'png']);
  assert.equal(shown(back), true);
  await press(back);
  assert.equal(title.textContent, 'Download');
});

test('the whole orthophoto as TIFF without layers is the original file; anything else is rendered', async () => {
  const products = productsStub();
  const t = dialog({ pixels: 1_000_000, products, contours: true });
  await tick();
  await press(rows(t)[0]);
  await ready();
  const { format, area, contours, dims, downloadButton } = t.api.controls;
  format.value = 'tif'; area.value = 'full'; contours.checked = false;
  await format.inputs.tif.fire('change');
  await ready();
  assert.match(dims.textContent, /^Original GeoTIFF · 3\.7 GiB$/);
  await press(downloadButton);
  await tick();
  assert.deepEqual(products.downloads, ['ortho']);
  assert.equal(t.log.runs.length, 0, 'nothing rendered for the original');
  contours.checked = true;
  await contours.fire('change');
  await ready();
  await press(downloadButton);
  await tick();
  assert.equal(t.log.runs.length, 1);
  assert.equal(t.log.runs[0].options.format, 'tif');
  assert.equal(t.log.runs[0].options.filename, 'orthophoto-contours.tif');
});

test('JPEG is offered up to 65,535 px per side and says so beyond it', async () => {
  const t = dialog({ picker: false, size: [70_000, 400] });
  await ready();
  const { format, downloadButton, status } = t.api.controls;
  format.value = 'jpg';
  await format.inputs.jpg.fire('change');
  await ready();
  assert.equal(downloadButton.disabled, true);
  assert.match(status.textContent, /JPEG holds at most 65,535 px per side/);
  format.value = 'png';
  await format.inputs.png.fire('change');
  await ready();
  assert.equal(downloadButton.disabled, false);
});

test('without products the dialog opens on the orthophoto, and TIFF needs a declared coordinate system', async () => {
  const t = dialog({ pixels: 1_000_000, geotiff: false });
  await ready();
  const { title, back, format } = t.api.controls;
  assert.equal(title.textContent, 'Orthophoto');
  assert.equal(shown(back), false, 'nothing to go back to');
  assert.equal(shown(format.inputs.tif), false);
});

test('regression: picking parcels never starts a download; only a press made in the reopened dialog does', async () => {
  const products = productsStub();
  let count = 0, finishPick;
  const t = dialog({ pixels: 200_000_000, products, parcels: () => count,
    pickParcels: () => new Promise((resolve) => { finishPick = resolve; }) });
  await tick();
  await press(rows(t)[0]);
  await ready();
  const { area, downloadButton } = t.api.controls;
  area.value = 'parcels';
  await area.inputs.parcels.fire('change');
  await tick();
  assert.equal(t.api.dialog.open, false, 'picking on the map');
  count = 2; finishPick(2);
  await tick();
  assert.equal(t.api.dialog.open, true, 'the dialog is back');
  await ready();
  // A click that did not start in the reopened dialog (carried over from the map, or a script).
  await downloadButton.click();
  await ready();
  const nothing = () => [t.log.runs.length, t.log.pickers.length, products.downloads.length];
  assert.deepEqual(nothing(), [0, 0, 0], 'no export, no save picker, no product download');
  // A held key does not answer either.
  const held = await downloadButton.fire('keydown', { key: 'Enter', repeat: true });
  assert.equal(held.defaultPrevented, true);
  // An explicit press does.
  void press(downloadButton);
  await tick();
  assert.equal(t.log.pickers.length, 1, 'the press starts the export');
});

test('regression: the second half of a double click on Done, or a key from before, does nothing in the reopened dialog', async () => {
  let finishPick;
  const t = dialog({ picker: false, pixels: 1_000_000, settleMs: 250, parcels: () => 2, pickParcels: () => new Promise((resolve) => { finishPick = resolve; }) });
  await wait(300); await ready();
  const { area, downloadButton } = t.api.controls;
  area.value = 'parcels';
  await area.inputs.parcels.fire('change');
  await t.api.controls.pickButton.click();
  await tick();
  assert.equal(t.api.dialog.open, false, 'picking on the map');
  finishPick(2);
  await tick();
  assert.equal(t.api.dialog.open, true);
  // Within the settling time: a press carried over from the map, then the key that ended picking.
  await press(downloadButton);
  await downloadButton.fire('keyup', { key: 'Enter' });
  await downloadButton.click();
  await ready();
  assert.equal(t.log.runs.length, 0, 'nothing ran');
  await wait(300);
  // A key going down on Download once settled (keyboard use) is a press.
  await downloadButton.fire('keydown', { key: 'Enter' });
  await downloadButton.click();
  await tick();
  assert.equal(t.log.runs.length, 1, 'a keyboard press starts it');
});

test('regression: a product row needs a press made in the open dialog', async () => {
  const products = productsStub();
  const t = dialog({ pixels: 1_000_000, products });
  await tick();
  await rows(t)[1].click();
  assert.deepEqual(products.downloads, [], 'no download from a click that did not start in the dialog');
  await press(rows(t)[1]);
  assert.deepEqual(products.downloads, ['dsm']);
});
