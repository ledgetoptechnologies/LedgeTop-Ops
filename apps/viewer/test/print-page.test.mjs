// The Print map page: its choices, the PDF, and the dialog. Synthetic parcels
// and generic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pixelCanvasFactory } from './helpers/pixel-canvas.mjs';
import { PROPERTY_LINES_NOTE, orthoPrintPolicy } from '../ortho-print-export.mjs';
import { captureMask, printPropertyError } from '../print-property.mjs';
import { dissolveParcelsByOwner } from '../property-lines-owners.mjs';
import { makeTile, lonLatToTileXY, tilesCoverBounds } from '../property-lines.mjs';
import { encodeSheetPdf, sheetFilename } from '../print-pdf.mjs';
import { captureDates, createPrintModel, mountPrintPage, printStatus } from '../print-page.mjs';

// ── PDF ──────────────────────────────────────────────────────────────────

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0x28, 0x29, 0x5c, 0xff, 0xd9]);
const latin = bytes => Buffer.from(bytes).toString('latin1');

test('PDF: one page of the paper’s size with the image edge to edge; every offset is right', () => {
  for (const [widthIn, heightIn, box] of [[11, 8.5, '792 612'], [8.5, 14, '612 1008'], [36, 24, '2592 1728']]) {
    const bytes = encodeSheetPdf({ jpeg: JPEG, pixelWidth: 3300, pixelHeight: 2550, widthIn, heightIn, title: 'Example task' }), text = latin(bytes);
    assert.ok(text.startsWith('%PDF-1.4\n') && text.endsWith('%%EOF\n'));
    assert.ok(text.includes(`/MediaBox [0 0 ${box}]`) && text.includes(`q ${box.split(' ')[0]} 0 0 ${box.split(' ')[1]} 0 0 cm /Map Do Q`));
    assert.equal(text.match(/\/Type \/Page /g).length, 1);
    const start = Number(/startxref\n(\d+)\n/.exec(text)[1]);
    assert.equal(text.slice(start, start + 4), 'xref');
    const rows = text.slice(start).match(/^\d{10} \d{5} [nf] $/gm);
    assert.equal(rows.length, 7);
    rows.slice(1).forEach((row, i) => assert.ok(text.slice(Number(row.slice(0, 10))).startsWith(`${i + 1} 0 obj\n`), `object ${i + 1}`));
    // The image stream is the JPEG itself, and its stated length is true.
    const image = text.indexOf('/Filter /DCTDecode'), at = text.indexOf('stream\n', image) + 7, length = Number(/\/Length (\d+)/.exec(text.slice(image))[1]);
    assert.equal(length, JPEG.length);
    assert.deepEqual(Array.from(bytes.slice(at, at + length)), Array.from(JPEG));
    assert.ok(text.slice(at + length).startsWith('\nendstream'));
    assert.ok(text.includes('/Width 3300 /Height 2550'));
    const content = /<< \/Length (\d+) >>\nstream\n(q [^\n]*)\nendstream/.exec(text);
    assert.equal(content[2].length, Number(content[1]));
  }
});

test('PDF: the title cannot end its string or carry anything else; bad input is refused', () => {
  const nasty = ') >> endobj (’é≈ \n<<';
  const text = latin(encodeSheetPdf({ jpeg: JPEG, pixelWidth: 1, pixelHeight: 1, widthIn: 1, heightIn: 1, title: nasty }));
  const hex = /\/Title <([0-9A-F]+)>/.exec(text)[1];
  assert.equal(hex.slice(0, 4), 'FEFF');
  assert.equal(hex.slice(4).match(/.{4}/g).map(h => String.fromCharCode(parseInt(h, 16))).join(''), nasty);
  assert.ok(!text.includes(nasty));
  assert.doesNotMatch(text, /\/(GPS|Geo|Measure|VP|LGIDict|JavaScript|URI)/, 'no coordinates, scripts or links');
  for (const bad of [{ jpeg: new Uint8Array([1, 2]) }, { jpeg: 'x' }, { widthIn: 0 }, { heightIn: NaN }, { pixelWidth: 1.5 }, { pixelHeight: 0 }])
    assert.throws(() => encodeSheetPdf({ jpeg: JPEG, pixelWidth: 1, pixelHeight: 1, widthIn: 1, heightIn: 1, ...bad }));
  assert.equal(sheetFilename('Example task: north / 2026'), 'Example-task-north-2026.pdf');
  for (const empty of ['', '///', null, '..\\..']) assert.equal(sheetFilename(empty), 'map.pdf');
  assert.ok(sheetFilename('x'.repeat(500)).length <= 64);
});

// ── The model ────────────────────────────────────────────────────────────

// A flat stand-in projection: 1 degree = 100 km around (44.5, -90).
const latLonToUtm = (lat, lon) => [500000 + (lon + 90) * 1e5, 4700000 + (lat - 44.5) * 1e5];
const utmToLatLon = (e, n) => [44.5 + (n - 4700000) / 1e5, -90 + (e - 500000) / 1e5];
const square = (id, owner, x, y, w, h = w) => ({ id, ...(owner ? { owner } : {}), rings: [[[x, y], [x, y + h], [x + w, y + h], [x + w, y], [x, y]].map(([e, n]) => [Math.round((-90 + e / 1e5) * 1e7) / 1e7, Math.round((44.5 + n / 1e5) * 1e7) / 1e7])] });
const PARCELS = [square(1, 'SAMPLE FARMS LLC', 60, 60, 100), square(2, 'Sample Farms LLC', 160, 60, 60, 100), square(3, 'EXAMPLE OWNER', 60, 160, 160, 100), square(4, 'FAR OWNER', 900, 900, 50), square(5, 'EDGE OWNER', 300, 60, 200, 100)];
const [TX, TY] = lonLatToTileXY(-90, 44.5, 14);
const LOADED = new Set([-1, 0, 1].flatMap(dx => [-1, 0, 1].map(dy => makeTile(14, TX + dx, TY + dy).key)));
function ortho() {
  const image = { getWidth: () => 400, getHeight: () => 300, async readRasters({ window: [x0, y0, x1, y1] }) { const n = (x1 - x0) * (y1 - y0); return [90, 120, 60, 255].map(v => new Uint8Array(n).fill(v)); } };
  return { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700300, nodata: NaN, images: [image] };
}
const CAPTURE = captureMask({ alpha: new Uint8Array(400 * 300).fill(255), width: 400, height: 300, extent: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700300 } });
const measure = (text, size) => text.length * size * 0.55;
const ATTRIBUTION = 'Source: Synthetic Parcel Map R1. Credit.';
function modelOf(options = {}) {
  const log = [], merge = options.merge ?? true, parcels = options.parcels ?? PARCELS;
  const deps = {
    ortho: ortho(), orthoGsd: 1, capture: CAPTURE, merge, outlines: dissolveParcelsByOwner(parcels, { merge }), covered: b => tilesCoverBounds(LOADED, b),
    loadParcels: async () => ({ status: 'ok', parcels, loaded: LOADED, failed: false, partial: false }),
    latLonToUtm, utmToLatLon, attribution: ATTRIBUTION, datumNote: '', units: 'imperial', meta: { title: 'Example task', project: 'Example project', captured: 'May 4, 2026', printed: 'November 23, 2026' },
    imageryCredit: 'Imagery: Example.', policy: () => orthoPrintPolicy({ accessAvailable: true, measure: true, download: true }), screen: () => ({ x: 800, y: 600 }), pixelRatio: () => 1, maxPixels: Infinity,
    traceContours: null, colors: () => undefined, createCanvas: pixelCanvasFactory(log), measure, checkpoint: () => {}, ...options,
  };
  const model = createPrintModel(deps);
  model.state.page = 'letter';
  return { model, log, deps };
}
const FARM = [-90 + 100 / 1e5, 44.5 + 100 / 1e5];
const words = log => log.findLast(c => c.texts.length)?.texts.map(t => t.text).join(' ') || '';
const draw = async (m, options = { dpi: 60 }) => { const before = m.log.length, drawn = await m.model.draw(options); return { ...drawn, words: m.log.slice(before).flatMap(c => c.texts.map(t => t.text)).join(' '), canvases: m.log.slice(before) }; };

test('whole captured area: no property named, neighbours’ names off, lines with their note', async () => {
  const m = modelOf();
  assert.equal(m.model.state.area, 'whole');
  const drawn = await draw(m);
  assert.ok(drawn.words.includes(PROPERTY_LINES_NOTE) && drawn.words.includes(ATTRIBUTION) && drawn.words.includes('Imagery: Example.'));
  assert.doesNotMatch(drawn.words, /FARMS|OWNER|captured\b.*%|approximate, \d|Property \d/);
  assert.equal(drawn.coverage, null);
  m.model.state.names = true;
  const named = (await draw(m)).words;
  assert.match(named, /SAMPLE FARMS LLC/);
  assert.match(named, /EXAMPLE OWNER/);
  // No parcel data on the sheet: no note, no source.
  Object.assign(m.model.state, { names: false, lines: false });
  const plain = (await draw(m)).words;
  assert.doesNotMatch(plain, /survey|Synthetic Parcel/);
  assert.ok(plain.includes('Imagery: Example.'));
});

test('my property: chosen by a click, its own name and acreage only, with the margin asked for', async () => {
  const m = modelOf();
  m.model.state.area = 'property';
  const waiting = await draw(m);
  assert.equal(waiting.picking, true);
  assert.equal(printStatus(waiting), 'Click your property.');
  await assert.rejects(m.model.draw({}), { code: 'print_property', reason: 'choose' }, 'no final sheet without a choice');
  // The spot of the preview over the farm gives its ground point back.
  const { layout } = waiting, [e, n] = [500100, 4700100];
  const fx = (layout.frame.x + (e - layout.extent.minE) / layout.metersPerUnit) / layout.width, fy = (layout.frame.y + (layout.extent.maxN - n) / layout.metersPerUnit) / layout.height;
  const point = m.model.pointAt(waiting, fx, fy);
  assert.ok(Math.abs(point[0] - FARM[0]) < 1e-7 && Math.abs(point[1] - FARM[1]) < 1e-7);
  assert.equal(m.model.pointAt(waiting, 0.001, 0.001), null, 'off the map');
  assert.deepEqual((await m.model.toggle(point)).on, true);
  const drawn = await draw(m);
  assert.match(drawn.words, /Property [\d.]+ ac, 2 parcels, approximate/);
  assert.match(drawn.words, /SAMPLE FARMS LLC/);
  assert.doesNotMatch(drawn.words, /EXAMPLE OWNER/);
  assert.ok(drawn.layout.metersPerUnit < waiting.layout.metersPerUnit, 'framed on the property');
  const wider = async ft => { m.model.state.marginFt = ft; return (await draw(m)).layout.metersPerUnit; };
  assert.ok(await wider(100) > await wider(0));
  m.model.state.names = true; m.model.state.marginFt = 25;
  assert.match((await draw(m)).words, /SAMPLE FARMS LLC/);
  // Off again.
  assert.equal((await m.model.toggle(point)).on, false);
  assert.equal((await draw(m)).picking, true);
});

test('my property: the note and source print even with the lines unticked; without a source nothing can be chosen', async () => {
  const m = modelOf();
  await m.model.toggle(FARM);
  Object.assign(m.model.state, { lines: false, names: false });
  const drawn = await draw(m);
  assert.ok(drawn.words.includes(`${PROPERTY_LINES_NOTE} ${ATTRIBUTION}`), drawn.words);
  const none = modelOf({ attribution: '', outlines: [] });
  assert.equal(none.model.canChoose, false);
  await assert.rejects(none.model.toggle(FARM), { reason: 'unavailable' });
  assert.equal(none.model.state.lines, false);
  assert.doesNotMatch((await draw(none)).words, /survey/);
  none.model.state.lines = true;
  await assert.rejects(none.model.draw({ dpi: 60 }), { code: 'print_note' }, 'lines never print without their source');
});

test('several properties: total acreage counts shared land once; the list shows which are chosen', async () => {
  const m = modelOf({ merge: false, parcels: [...PARCELS, { ...square(6, 'SAMPLE FARMS LLC', 60, 60, 100) }] });
  const key = owner => m.model.list.find(i => i.owner === owner).key;
  assert.ok(!m.model.list.some(i => i.owner === 'FAR OWNER'), 'not captured, not listed');
  await m.model.toggle([-90 + 100 / 1e5, 44.5 + 100 / 1e5]);
  await m.model.toggle([-90 + 100 / 1e5, 44.5 + 200 / 1e5]);
  assert.equal(m.model.isChosen(key('EXAMPLE OWNER')), true);
  assert.equal(m.model.isChosen(key('EDGE OWNER')), false);
  // 100 x 100 and 160 x 100 in the stand-in projection's parcels.
  const line = /Property ([\d.]+) ac, 2 parcels, approximate/.exec((await draw(m)).words);
  const alone = await (async () => { const o = modelOf({ merge: false }); await o.model.toggle([-90 + 100 / 1e5, 44.5 + 100 / 1e5]); return /Property ([\d.]+) ac, 1 parcel,/.exec((await draw(o)).words); })();
  assert.ok(Math.abs(Number(line[1]) / Number(alone[1]) - 2.6) < 0.15, `${line[1]} vs ${alone[1]}`);
});

test('a property past the capture: whole by default and said so; Crop to imagery reframes; none captured is refused', async () => {
  const m = modelOf();
  await m.model.toggle([-90 + 350 / 1e5, 44.5 + 110 / 1e5]);
  const drawn = await draw(m);
  assert.equal(drawn.coverage.percent, 50);
  assert.match(drawn.words, /· 50% captured/);
  assert.match(drawn.words, /No imagery captured here/);
  assert.ok(drawn.layout.extent.maxE > 500500, 'the whole parcel is framed');
  assert.match(printStatus(drawn), /50% of this property was captured\./);
  m.model.state.crop = true;
  const cropped = await draw(m);
  assert.ok(cropped.layout.metersPerUnit < drawn.layout.metersPerUnit);
  assert.match(cropped.words, /· 50% captured/, 'the gap is never hidden');
  await assert.rejects(modelOf().model.toggle([-90 + 920 / 1e5, 44.5 + 920 / 1e5]), { code: 'print_property', reason: 'uncaptured' });
  const failing = modelOf({ loadParcels: async () => ({ status: 'ok', parcels: PARCELS, loaded: new Set(), failed: true, partial: false }) });
  await assert.rejects(failing.model.toggle(FARM), { reason: 'incomplete' });
  assert.equal(failing.model.chosen.size, 0);
});

test('resolution: without download the imagery stays under the screen cap on every sheet; the policy is read each time', async () => {
  let download = true;
  const sizes = [], factory = pixelCanvasFactory([]);
  const m = modelOf({ orthoGsd: 0.01, policy: () => orthoPrintPolicy({ accessAvailable: true, measure: true, download }), screen: () => ({ x: 300, y: 200 }), createCanvas: (w, h) => { sizes.push([w, h]); return factory(w, h); } });
  await m.model.draw({ dpi: 60 });
  assert.ok(Math.max(...sizes[1]) > 300);
  download = false; sizes.length = 0;
  for (const area of ['whole', 'property']) { m.model.state.area = area; await m.model.draw({ dpi: 60 }); }
  await m.model.toggle(FARM);
  await m.model.draw({ dpi: 60 });
  for (const [w, h] of sizes.filter((_, i) => i % 2 === 1)) assert.ok(Math.max(w, h) <= 300, `${w} x ${h}`);
  assert.equal(sizes.length, 6);
});

test('contours: traced for the sheet, kept while nothing changes, and only in the legend when drawn', async () => {
  const asked = [];
  const m = modelOf({ traceContours: async (extent, cell) => { asked.push([extent, cell]); return { features: [{ coords: [500060, 4700150, 500390, 4700150], isIndex: true, label: '800ft' }], interval: 2, units: 'imperial' }; } });
  await draw(m);
  assert.equal(asked.length, 0);
  m.model.state.contours = true;
  assert.match((await draw(m)).words, /Contours 2 ft · index every 10 ft/);
  await draw(m);
  assert.equal(asked.length, 1);
  const none = modelOf({ traceContours: async () => ({ features: [], interval: 2, units: 'imperial' }) });
  none.model.state.contours = true;
  assert.doesNotMatch((await draw(none)).words, /Contours/);
});

test('the page belongs to its viewer: a lost checkpoint stops drawing and output, and frees the canvases', async () => {
  for (const stop of [1, 2, 3]) {
    let calls = 0;
    const m = modelOf({ checkpoint: () => { if (++calls >= stop) throw new DOMException('x', 'AbortError'); } });
    await assert.rejects(m.model.draw({ dpi: 60 }), { name: 'AbortError' });
  }
  let live = true;
  const made = [], factory = pixelCanvasFactory([]);
  const m = modelOf({ checkpoint: () => { if (!live) throw new DOMException('x', 'AbortError'); }, createCanvas: (w, h) => { const c = factory(w, h); const blob = c.toBlob; c.toBlob = cb => blob(b => { live = false; cb(b); }); made.push(c); return c; } });
  m.deps.orthoGsd = 5;
  await assert.rejects(m.model.finalJpeg(), { name: 'AbortError' }, 'lost while encoding');
  assert.ok(made.every(c => c.width === 0));
  const late = modelOf({ checkpoint: () => { if (late.gone) throw new DOMException('x', 'AbortError'); }, loadParcels: async () => { late.gone = true; return { status: 'ok', parcels: PARCELS, loaded: LOADED, failed: false, partial: false }; } });
  await assert.rejects(late.model.toggle(FARM), { name: 'AbortError' });
  assert.equal(late.model.chosen.size, 0, 'a choice that arrives too late is not kept');
});

test('Save PDF: the sheet’s JPEG on the sheet’s paper', async () => {
  const m = modelOf();
  await m.model.toggle(FARM);
  const factory = pixelCanvasFactory([]);
  const real = createPrintModel({ ...m.deps, createCanvas: (w, h) => { const c = factory(w, h); c.toBlob = (cb, type, quality) => { assert.deepEqual([type, quality], ['image/jpeg', 0.92]); cb(new Blob([JPEG])); }; return c; } });
  Object.assign(real.state, { page: 'letter', orientation: 'portrait', title: 'Example / task' });
  const pdf = await real.finalPdf();
  assert.equal(pdf.filename, 'Example-task.pdf');
  assert.equal(pdf.blob.type, 'application/pdf');
  const text = latin(new Uint8Array(await pdf.blob.arrayBuffer()));
  assert.ok(text.includes('/MediaBox [0 0 612 792]') && text.includes(latin(JPEG)));
});

test('capture date: from the photos only, one day or a range; unknown is left out', () => {
  const at = (...days) => days.map(d => ({ properties: { capture_time: Date.UTC(2026, 4, d, 18) / 1000 } }));
  assert.equal(captureDates(at(4, 4)), 'May 4, 2026');
  assert.equal(captureDates(at(6, 4)), 'May 4, 2026 to May 6, 2026');
  for (const none of [null, [], [{}], [{ properties: { capture_time: 0 } }], [{ properties: { capture_time: 'x' } }]]) assert.equal(captureDates(none), null);
});

// ── The dialog ───────────────────────────────────────────────────────────

function fakeDocument() {
  const downloads = [];
  const node = tag => {
    const n = { tagName: tag, children: [], listeners: {}, attrs: {}, value: '', hidden: false, disabled: false, textContent: '', open: false, clientWidth: 600,
      append(...kids) { for (const kid of kids) { if (kid && typeof kid === 'object') kid.parent = n; n.children.push(kid); if (tag === 'select' && n.value === '') n.value = kid.value; } },
      replaceChildren(...kids) { n.children = []; n.append(...kids); },
      remove() { if (n.parent) n.parent.children = n.parent.children.filter(c => c !== n); },
      setAttribute(k, v) { n.attrs[k] = v; }, addEventListener(type, fn) { (n.listeners[type] ||= []).push(fn); },
      fire(type, event = {}) { return Promise.all((n.listeners[type] || []).map(fn => fn(event))); },
      click() { if (tag === 'a') downloads.push(n.download); return n.fire('click'); },
      showModal() { n.open = true; }, close() { n.open = false; return n.fire('close'); }, decode: async () => {} };
    return n;
  };
  return { createElement: node, body: node('body'), head: node('head'), downloads };
}
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function dialogOf({ openWith = null, modelOptions = {} } = {}) {
  const doc = fakeDocument(), opener = doc.createElement('button'), log = { prints: 0, printed: [], closed: 0, released: 0, draws: 0, finals: 0, live: true };
  const win = { listeners: {}, devicePixelRatio: 1, addEventListener(type, fn) { win.listeners[type] = fn; }, print() { log.prints++; log.printed.push({ src: ui.controls.paper.children[0]?.src, style: doc.head.children[0]?.textContent }); } };
  const state = { area: 'whole', page: 'letter', orientation: 'landscape', marginFt: 25, trimFt: 25, crop: false, contours: false, lines: true, names: false, title: 'Example task' };
  const chosen = new Set();
  const check = () => { if (!log.live) throw new DOMException('x', 'AbortError'); };
  const model = { state, list: [{ key: 'a', label: 'SAMPLE FARMS LLC ≈ 4.0 ac', point: [1, 2] }, { key: 'b', label: 'EXAMPLE OWNER', point: [3, 4] }], canChoose: true, hasContours: true, checkpoint: check,
    isChosen: key => chosen.has(key), pointAt: (drawn, x, y) => [x, y],
    async toggle(point) { const key = point[0] === 3 ? 'b' : 'a'; if (chosen.has(key)) chosen.delete(key); else chosen.add(key); state.area = 'property'; },
    async draw({ signal }) { log.draws++; check(); if (signal?.aborted) throw new DOMException('x', 'AbortError');
      return { canvas: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) }, release() { log.released++; }, plan: { printDpi: 214, soft: false }, layout: { widthIn: 11 }, coverage: state.area === 'property' && chosen.size ? { percent: 87, nearEdge: false } : null, picking: state.area === 'property' && !chosen.size }; },
    async finalPdf() { log.finals++; check(); return { blob: new Blob(['pdf']), filename: 'Example-task.pdf' }; },
    async finalJpeg() { log.finals++; check(); return { blob: new Blob(['jpg']), widthIn: 11, heightIn: 8.5 }; }, ...modelOptions };
  const ui = mountPrintPage({ documentRef: doc, windowRef: win, openButton: opener, open: openWith || (async () => model), pages: () => ['letter', 'tabloid'], onClose: () => { log.closed++; }, previewDelayMs: 0 });
  return { doc, win, opener, log, model, state, chosen, ui, c: ui.controls, async open() { await opener.fire('click'); await settle(); } };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 5)); await tick(); };
const realSetTimeout = globalThis.setTimeout, create = URL.createObjectURL, revoke = URL.revokeObjectURL;
const urls = { made: 0, revoked: [] };
test.beforeEach(() => {
  urls.made = 0; urls.revoked = [];
  globalThis.setTimeout = (fn, ms, ...args) => { const t = realSetTimeout(fn, ms, ...args); if (ms > 1000) t.unref?.(); return t; };
  URL.createObjectURL = () => `blob:test/${++urls.made}`; URL.revokeObjectURL = url => urls.revoked.push(url);
});
test.afterEach(() => { globalThis.setTimeout = realSetTimeout; URL.createObjectURL = create; URL.revokeObjectURL = revoke; });

test('dialog: opens with a preview, its dpi and only the pages this browser can draw', async () => {
  const d = dialogOf();
  await d.open();
  assert.equal(d.ui.dialog.open, true);
  assert.deepEqual(d.c.page.children.map(o => o.value), ['letter', 'tabloid']);
  assert.equal(d.c.preview.children.length, 1);
  assert.equal(d.c.status.textContent, 'Prints at 214 dpi.');
  assert.deepEqual([d.c.print.disabled, d.c.save.disabled, d.c.properties.hidden, d.c.title.value], [false, false, true, 'Example task']);
  d.c.page.value = 'tabloid';
  await d.c.page.fire('change');
  assert.equal(d.c.print.disabled, true, 'not while a new preview is on its way');
  await settle();
  assert.deepEqual([d.state.page, d.c.print.disabled, d.log.draws, d.log.released], ['tabloid', false, 2, 1]);
  d.c.title.value = 'Other title';
  await d.c.title.fire('input');
  await settle();
  assert.equal(d.state.title, 'Other title');
});

test('dialog: My property by a click on the preview or the list, by keyboard too', async () => {
  const d = dialogOf();
  await d.open();
  d.c.area.value = 'property';
  await d.c.area.fire('change');
  await settle();
  assert.deepEqual([d.c.print.disabled, d.c.properties.hidden, d.c.status.textContent], [true, false, 'Click your property.']);
  await d.c.preview.fire('click', { clientX: 110, clientY: 70 });
  await settle();
  assert.deepEqual([...d.chosen], ['a'], 'point 0.5, 0.5 of the paper');
  assert.equal(d.c.status.textContent, 'Prints at 214 dpi. 87% of this property was captured.');
  assert.deepEqual([d.c.print.disabled, d.c.properties.children[0].control.checked], [false, true]);
  // Once framed, a stray click on the paper changes nothing.
  await d.c.preview.fire('click', { clientX: 110, clientY: 70 });
  await settle();
  assert.deepEqual([...d.chosen], ['a']);
  assert.equal(d.c.properties.children[1].children[1].textContent, 'EXAMPLE OWNER', 'plain text');
  await d.c.properties.children[1].control.fire('change');
  await settle();
  assert.deepEqual([...d.chosen], ['a', 'b']);
});

test('dialog: a refused choice says why and keeps the rest', async () => {
  const d = dialogOf({ modelOptions: { toggle: async () => { throw printPropertyError('clipped'); } } });
  await d.open();
  await d.c.properties.children[0].control.fire('change');
  await settle();
  assert.equal(d.c.status.textContent, 'This property runs past the area property lines cover here.');
  assert.equal(d.c.properties.children[0].control.checked, false);
  const odd = dialogOf({ modelOptions: { toggle: async () => { throw new TypeError('internal detail'); } } });
  await odd.open();
  await odd.c.properties.children[0].control.fire('change');
  await settle();
  assert.equal(odd.c.status.textContent, 'Could not load the property. Try again.');
});

test('dialog: Save PDF and Print use the sheet; print puts the paper’s own page size and cleans up after', async () => {
  const d = dialogOf();
  await d.open();
  await d.c.save.fire('click');
  assert.deepEqual(d.doc.downloads, ['Example-task.pdf']);
  assert.equal(d.c.status.textContent, 'Saved Example-task.pdf.');
  await d.c.print.fire('click');
  assert.equal(d.log.prints, 1);
  assert.deepEqual(d.log.printed, [{ src: 'blob:test/2', style: '@page { size: 11in 8.5in; margin: 0; }' }]);
  d.win.listeners.afterprint();
  assert.equal(d.c.paper.children.length, 0);
  assert.equal(d.doc.head.children.length, 0);
  assert.deepEqual(urls.revoked, ['blob:test/2']);
});

test('dialog: access or viewer lost closes it, with nothing saved, printed or left behind', async () => {
  for (const button of ['save', 'print']) {
    const d = dialogOf();
    await d.open();
    d.log.live = false;
    await d.c[button].fire('click');
    await settle();
    assert.deepEqual([d.ui.dialog.open, d.log.closed, d.doc.downloads.length, d.log.prints], [false, 1, 0, 0], button);
    assert.equal(d.c.preview.children.length, 0);
    assert.equal(d.log.released, d.log.draws);
  }
  // Lost after the file was made, right before it is saved or printed.
  for (const [button, key] of [['save', 'finalPdf'], ['print', 'finalJpeg']]) {
    const d = dialogOf();
    await d.open();
    const make = d.model[key];
    d.model[key] = async (...args) => { const out = await make(...args); d.log.live = false; return out; };
    await d.c[button].fire('click');
    await settle();
    assert.deepEqual([d.ui.dialog.open, d.doc.downloads.length, d.log.prints, d.c.paper.children.length], [false, 0, 0, 0], button);
  }
  // Closed from outside (a session change) while a file is being made.
  const d = dialogOf(), gate = deferred();
  await d.open();
  d.model.finalPdf = async () => { await gate.promise; return { blob: new Blob(['x']), filename: 'x.pdf' }; };
  const saving = d.c.save.fire('click');
  await tick();
  d.ui.shut();
  gate.resolve();
  await saving;
  assert.deepEqual([d.doc.downloads.length, d.log.closed, d.c.status.textContent], [0, 1, '']);
});

test('dialog: closing while it opens drops the late answer; it opens again cleanly; errors are said', async () => {
  const gate = deferred();
  let first = true;
  const d = dialogOf();
  const held = dialogOf({ openWith: async () => { if (first) { first = false; await gate.promise; } return d.model; } });
  const opening = held.opener.fire('click');
  await tick();
  assert.equal(held.c.status.textContent, 'Loading…');
  await held.ui.dialog.close();
  gate.resolve();
  await opening;
  await settle();
  assert.deepEqual([held.ui.dialog.open, held.c.preview.children.length, held.log.closed], [false, 0, 1]);
  await held.open();
  assert.deepEqual([held.ui.dialog.open, held.c.preview.children.length], [true, 1]);
  const refused = dialogOf({ openWith: async () => { throw printPropertyError('georef'); } });
  await refused.open();
  assert.equal(refused.c.status.textContent, 'This model has no verified map position.');
  assert.equal(refused.c.print.disabled, true);
  const broken = dialogOf({ openWith: async () => { throw new TypeError('internal'); } });
  await broken.open();
  assert.equal(broken.c.status.textContent, 'Could not open the print page. Try again.');
});

test('dialog: a page that cannot be drawn says so and cannot be printed', async () => {
  const d = dialogOf();
  await d.open();
  d.model.draw = async () => { throw Object.assign(new Error('This page is too small for the map and its credits. Choose a larger page.'), { code: 'print_note' }); };
  d.c.page.value = 'letter';
  await d.c.page.fire('change');
  await settle();
  assert.equal(d.c.status.textContent, 'This page is too small for the map and its credits. Choose a larger page.');
  assert.deepEqual([d.c.print.disabled, d.c.preview.children.length], [true, 0]);
});

test('page wiring: the button sits with Export image; printing shows the paper alone; the page is fenced like an export', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n'), main = readFileSync(new URL('../main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(html, /id="ortho-print-actions"[\s\S]*?id="btn-print-map">Print map</);
  const css = html.slice(html.indexOf('body:has(.print-map-paper img)'), html.indexOf('#print-property-pick { position'));
  assert.match(css, /> :not\(\.print-map\) \{ display: none !important; \}/);
  assert.match(css, /> :not\(\.print-map-paper\) \{ display: none !important; \}/);
  const open = main.slice(main.indexOf('async function openPrintPage()'), main.indexOf('function printEpsg()'));
  assert.match(open, /assertOrthoPrintAllowed\(policy, \{ area: 'view', format: 'png' \}\);/);
  const code = open.split('\n').filter(l => !l.trim().startsWith('//'));
  code.forEach((line, i) => { if (/\bawait /.test(line)) assert.match(code.slice(i + 1, i + 2).join(''), /checkpoint\(\);/, `checked right after: ${line.trim()}`); });
  assert.match(open, /permitted\(\)\) controller\.abort\(\)/);
  assert.match(main, /onClose: \(\) => printPageJob\?\.end\(\)/);
});
