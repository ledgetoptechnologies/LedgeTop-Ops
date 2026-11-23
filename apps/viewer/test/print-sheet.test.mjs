// The printed sheet: pages, layout, scale, credits, labels, resolution and
// pixels. Synthetic parcels and generic names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelCanvasFactory } from './helpers/pixel-canvas.mjs';
import { PROPERTY_LINES_NOTE, UNCAPTURED_LABEL, orthoPrintPolicy } from '../ortho-print-export.mjs';
import { captureMask, printClip } from '../print-property.mjs';
import { dissolveParcelsByOwner, ownerLabelCandidates } from '../property-lines-owners.mjs';
import {
  IOS_MAX_PIXELS, NO_DOWNLOAD_MAX_EDGE, PRINT_PAGES, SOFT_DPI, TEXT_DPI, UNITS_PER_INCH, createSheetMeasure, fitExtent, layoutSheet, pageInches, planSheet,
  renderSheet, sheetLabels, sheetMapCap, supportedPages,
} from '../print-sheet.mjs';

const measure = (text, size) => text.length * size * 0.55;
const EXTENT = { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700300 };
const CREDITS = ['Source: Synthetic Parcel Map R1 (2025 roll). Product of the synthetic parcel project.', 'Imagery: Example.'];
const CONTENT = { title: 'Example task', project: 'Example project', captured: 'May 4, 2026', printed: 'November 23, 2026', acreage: 'Property ≈ 118.4 ac, 3 parcels, approximate', property: true, lineColor: '#ee5007', credits: CREDITS };
const layoutOf = (options = {}) => layoutSheet({ page: 'letter', orientation: 'landscape', extent: EXTENT, measure, ...options, content: { ...CONTENT, ...options.content } });
const texts = layout => layout.items.filter(i => i.kind === 'text').map(i => i.text);
const ALL = Object.keys(PRINT_PAGES).flatMap(page => ['portrait', 'landscape'].map(orientation => ({ page, orientation })));

test('pages: inches, pixels at their own dpi, and what iOS and small canvases can draw', () => {
  assert.deepEqual(pageInches('tabloid', 'landscape'), { widthIn: 17, heightIn: 11 });
  assert.deepEqual(pageInches('letter', 'portrait'), { widthIn: 8.5, heightIn: 11 });
  assert.throws(() => pageInches('a4', 'portrait'), RangeError);
  const pixels = Object.fromEntries(Object.entries(PRINT_PAGES).map(([key, p]) => [key, [Math.round(p.longIn * p.dpi), Math.round(p.shortIn * p.dpi)]]));
  assert.deepEqual(pixels, { letter: [3300, 2550], legal: [4060, 2465], tabloid: [4080, 2640], archd: [6120, 4080] });
  for (const key of ['letter', 'legal', 'tabloid']) assert.ok(pixels[key][0] * pixels[key][1] <= IOS_MAX_PIXELS && pixels[key][0] <= 4096, key);
  assert.deepEqual(supportedPages({ navigatorRef: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' }, probe: () => true }), ['letter', 'legal', 'tabloid']);
  assert.deepEqual(supportedPages({ navigatorRef: { userAgent: 'Windows' }, probe: () => true }), ['letter', 'legal', 'tabloid', 'archd']);
  assert.deepEqual(supportedPages({ navigatorRef: { userAgent: 'Windows' }, probe: () => false }), ['letter', 'legal', 'tabloid']);
});

test('layout: every page keeps its parts inside the paper, apart from each other, and mostly map', () => {
  for (const { page, orientation } of ALL) {
    const layout = layoutOf({ page, orientation, content: { contours: { interval: 10, units: 'imperial' }, uncaptured: true } });
    const { width, height, frame } = layout, label = `${page} ${orientation}`;
    const boxes = layout.items.map(i => i.kind === 'text' ? { x0: i.align === 'center' ? i.x - measure(i.text, i.size) / 2 : i.x, x1: i.align === 'center' ? i.x + measure(i.text, i.size) / 2 : i.x + measure(i.text, i.size), y0: i.y - i.size / 2, y1: i.y + i.size / 2 }
      : i.kind === 'mark' ? { x0: i.x, x1: i.x + i.size, y0: i.y, y1: i.y + i.size } : i.kind === 'north' ? { x0: i.x - i.size * 0.36, x1: i.x + i.size * 0.36, y0: i.y, y1: i.y + i.size }
        : { x0: i.x, x1: i.x + i.width, y0: i.y - i.height / 2, y1: i.y + i.height / 2 });
    boxes.forEach((b, i) => {
      assert.ok(b.x0 >= 30 && b.y0 >= 30 && b.x1 <= width - 30 && b.y1 <= height - 30, `${label}: ${JSON.stringify(layout.items[i])} on the paper`);
      assert.ok(b.y1 <= frame.y + 0.01 || b.y0 >= frame.y + frame.height - 0.01, `${label}: ${JSON.stringify(layout.items[i])} off the map`);
    });
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const [a, b] = [boxes[i], boxes[j]];
      assert.ok(a.x1 <= b.x0 + 0.01 || b.x1 <= a.x0 + 0.01 || a.y1 <= b.y0 + 0.01 || b.y1 <= a.y0 + 0.01, `${label}: ${JSON.stringify([layout.items[i], layout.items[j]])}`);
    }
    assert.ok(frame.height * frame.width > width * height * 0.5, `${label}: map is most of the page`);
  }
});

test('layout: the whole requested ground is in the frame, undistorted, and the scale on paper is right', () => {
  for (const { page, orientation } of ALL) for (const extent of [EXTENT, { minE: 0, maxE: 50, minN: 0, maxN: 900 }, { minE: 0, maxE: 3000, minN: 0, maxN: 100 }]) {
    const layout = layoutOf({ page, orientation, extent }), shown = layout.extent;
    assert.ok(shown.minE <= extent.minE + 1e-6 && shown.maxE >= extent.maxE - 1e-6 && shown.minN <= extent.minN + 1e-6 && shown.maxN >= extent.maxN - 1e-6);
    const perE = (shown.maxE - shown.minE) / layout.frame.width, perN = (shown.maxN - shown.minN) / layout.frame.height;
    assert.ok(Math.abs(perE / perN - 1) < 1e-9, 'square');
    const bar = layout.items.find(i => i.kind === 'bar'), feet = Number(texts(layout).find(t => /^[\d,]+ ft$/.test(t)).replace(/[^\d]/g, ''));
    assert.ok(Math.abs(bar.width * perE / 0.3048 - feet) < 1e-6, 'scale bar length');
    assert.equal(Number(layout.scaleText.match(/= about ([\d,.]+) ft/)[1].replace(/,/g, '')), Number((perE * UNITS_PER_INCH / 0.3048).toPrecision(3)));
  }
  assert.match(layoutOf({ units: 'metric' }).scaleText, /^1 cm = about [\d.]+ m at 100% size$/);
  assert.deepEqual(fitExtent({ minE: 0, maxE: 10, minN: 0, maxN: 10 }, 2), { minE: -5, maxE: 15, minN: 0, maxN: 10 });
});

test('layout: header shows what is known and no more; long titles are cut, never spilled', () => {
  assert.ok(texts(layoutOf()).includes('Example project · Captured May 4, 2026 · Printed November 23, 2026'));
  const bare = texts(layoutOf({ content: { project: '', captured: null, acreage: '' } }));
  assert.ok(bare.includes('Printed November 23, 2026'));
  assert.ok(!bare.some(t => /Captured|Property ≈|undefined|null/.test(t)));
  const long = texts(layoutOf({ page: 'letter', orientation: 'portrait', content: { title: 'A very long title '.repeat(20) } }))[0];
  assert.ok(long.endsWith('…') && measure(long, 21) < 740);
  assert.ok(texts(layoutOf()).includes('Grid north'), 'grid north is said');
});

test('layout: the legend lists only what is drawn', () => {
  const rows = content => texts(layoutOf({ content })).filter(t => /^(Contours|Property lines$|No imagery)/.test(t));
  assert.deepEqual(rows({}), ['Property lines']);
  assert.deepEqual(rows({ lineColor: null, property: false }), []);
  assert.deepEqual(rows({ contours: { interval: 2, units: 'imperial' }, uncaptured: true }), ['Contours 2 ft · index every 10 ft', 'Property lines', UNCAPTURED_LABEL]);
});

test('credits: the note and source are whole on every page that shows property lines, or the page is refused', () => {
  const whole = `${PROPERTY_LINES_NOTE} ${CREDITS.join(' ')}`;
  for (const { page, orientation } of ALL) {
    const small = layoutOf({ page, orientation }).items.filter(i => i.kind === 'text' && Math.abs(i.size / layoutOf({ page, orientation }).scale - 8) < 1e-9);
    assert.equal(small.map(i => i.text).join(' '), whole, `${page} ${orientation}`);
  }
  const long = CREDITS[0] + ' More words of credit.'.repeat(30);
  assert.equal(layoutOf({ content: { credits: [long] } }).items.filter(i => i.size === 8).map(i => i.text).join(' '), `${PROPERTY_LINES_NOTE} ${long}`);
  for (const credits of [[], [''], ['  '], ['\u200b'], undefined]) assert.throws(() => layoutOf({ content: { credits } }), { code: 'print_note' });
  assert.throws(() => layoutOf({ content: { credits: ['word '.repeat(6000)] } }), { code: 'print_note' });
  assert.throws(() => layoutOf({ content: { credits: ['x'.repeat(2000)] } }), { code: 'print_note' });
  assert.ok(!texts(layoutOf({ content: { property: false, lineColor: null, credits: ['Imagery: Example.'] } })).join(' ').includes('survey'), 'no note without property lines');
});

test('resolution: never finer than the orthophoto or the viewer’s cap; text stays sharp; soft below 100 dpi', () => {
  for (const { page, orientation } of ALL) {
    const layout = layoutOf({ page, orientation });
    const span = layout.extent.maxE - layout.extent.minE;
    // Fine orthophoto: the page's own dpi.
    const fine = planSheet({ layout, page, orthoGsd: 0.001 });
    assert.equal(Math.round(fine.dpi), PRINT_PAGES[page].dpi);
    assert.deepEqual([fine.map.width, fine.map.height], [fine.frame.width, fine.frame.height]);
    assert.ok(Math.abs(fine.width - layout.widthIn * PRINT_PAGES[page].dpi) <= 1);
    assert.equal(fine.soft, false);
    // Coarse orthophoto: imagery no finer than it, page still at text dpi.
    const coarse = planSheet({ layout, page, orthoGsd: 2 });
    assert.ok(span / coarse.map.width >= 2, `${span / coarse.map.width}`);
    assert.equal(Math.round(coarse.dpi), TEXT_DPI);
    assert.equal(coarse.soft, coarse.printDpi < SOFT_DPI);
    // Without download: the map part never passes the cap, at any dpi.
    for (const mapCap of [700, NO_DOWNLOAD_MAX_EDGE]) for (const dpi of [null, 96]) {
      const capped = planSheet({ layout, page, orthoGsd: 0.001, mapCap, dpi });
      assert.ok(Math.max(capped.map.width, capped.map.height) <= mapCap, `${page} ${mapCap}: ${capped.map.width} x ${capped.map.height}`);
    }
    const ios = planSheet({ layout, page, orthoGsd: 0.001, maxPixels: IOS_MAX_PIXELS });
    assert.ok(ios.width * ios.height <= IOS_MAX_PIXELS);
    const preview = planSheet({ layout, page, orthoGsd: 0.001, dpi: 48 });
    assert.equal(preview.dpi, 48);
    assert.equal(preview.printDpi, fine.printDpi, 'the preview reports what the print reaches');
  }
});

test('cap: unlimited with download; else the screen fitted to the frame, at most 2048', () => {
  const measureOnly = orthoPrintPolicy({ accessAvailable: true, measure: true, download: false }), full = orthoPrintPolicy({ accessAvailable: true, measure: true, download: true });
  const frame = { width: 900, height: 600 };
  assert.equal(sheetMapCap({ policy: full, screen: { x: 800, y: 600 }, frame }), Infinity);
  assert.equal(sheetMapCap({ policy: measureOnly, screen: { x: 800, y: 600 }, frame }), 800);
  assert.equal(sheetMapCap({ policy: measureOnly, screen: { x: 800, y: 600 }, pixelRatio: 2, frame }), 1600);
  assert.equal(sheetMapCap({ policy: measureOnly, screen: { x: 3800, y: 2600 }, frame }), 2048);
  for (const screen of [null, { x: NaN, y: 1 }, { x: 0, y: 0 }]) assert.equal(sheetMapCap({ policy: measureOnly, screen, frame }), 2048);
  assert.equal(sheetMapCap({ policy: null, screen: { x: 800, y: 600 }, frame }), 800, 'no policy is no download');
});

// ── Labels ───────────────────────────────────────────────────────────────

// A flat stand-in projection: 1 degree = 100 km, so a layout in metres is easy.
const flat = (lat, lon) => [500000 + (lon + 90) * 1e5, 4700000 + (lat - 44.5) * 1e5];
const square = (id, owner, x, y, w = 160) => ({ id, owner, rings: [[[x, y], [x, y + w], [x + w, y + w], [x + w, y], [x, y]].map(([e, n]) => [-90 + e / 1e5, 44.5 + n / 1e5])] });

test('labels: the chosen property’s own name and acreage; neighbours only when ticked, and never over it', () => {
  const outlines = dissolveParcelsByOwner([square(1, 'SAMPLE FARMS LLC', 20, 60), square(2, 'EXAMPLE OWNER', 180, 60, 130), square(3, 'OTHER OWNER', 180, 195, 100)], { merge: false });
  const candidates = ownerLabelCandidates(outlines, { acreage: { merged: false } });
  const layout = layoutOf(), own = c => c.text === 'SAMPLE FARMS LLC';
  const run = options => sheetLabels({ candidates, layout, latLonToUtm: flat, measure, own, units: 'imperial', ...options });
  const mine = run({});
  assert.deepEqual(mine.map(l => l.text), ['SAMPLE FARMS LLC']);
  assert.match(mine[0].lines.at(-1), /^≈ [\d.]+ ac$/);
  // In the middle of its own parcel on the sheet.
  const e = layout.extent.minE + mine[0].x * layout.metersPerUnit, n = layout.extent.maxN - mine[0].y * layout.metersPerUnit;
  assert.ok(Math.abs(e - 500100) < 5 && Math.abs(n - 4700140) < 5, `${e}, ${n}`);
  assert.deepEqual(run({ names: true }).map(l => l.text).sort(), ['EXAMPLE OWNER', 'OTHER OWNER', 'SAMPLE FARMS LLC']);
  assert.deepEqual(run({ names: false, own: () => false }), [], 'whole area, nothing chosen, names off');
  assert.deepEqual(run({ names: true, allowed: (x, y, isOwn) => isOwn }).map(l => l.text), ['SAMPLE FARMS LLC'], 'outside the clip');
  // Readable on paper at any page, and the same place at any page.
  for (const { page, orientation } of ALL) {
    const l = layoutOf({ page, orientation }), [label] = sheetLabels({ candidates, layout: l, latLonToUtm: flat, measure, own, units: 'imperial' });
    assert.ok(label && label.fontPx >= 8 * l.scale, `${page} ${orientation}`);
  }
});

// ── Pixels ───────────────────────────────────────────────────────────────

function ortho() {
  const image = { getWidth: () => 400, getHeight: () => 300, async readRasters({ window: [x0, y0, x1, y1] }) {
    const w = x1 - x0, h = y1 - y0, bands = [90, 120, 60, 255].map(v => new Uint8Array(w * h).fill(v));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x0 + x < 40) bands[3][y * w + x] = 0;
    return bands;
  } };
  return { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700300, nodata: NaN, images: [image] };
}
const CAPTURE = (() => { const alpha = new Uint8Array(400 * 300).fill(255); for (let y = 0; y < 300; y++) alpha.fill(0, y * 400, y * 400 + 40); return captureMask({ alpha, width: 400, height: 300, extent: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700300 } }); })();
const OWN = [{ rings: [[[500020, 4700060], [500020, 4700240], [500220, 4700240], [500220, 4700060], [500020, 4700060]]] }];
const clip = ({ width, height, extent }) => printClip({ width, height, extent, parcels: OWN, marginMeters: 10, trimMeters: 5, capture: CAPTURE });
async function draw({ dpi = 96, page = 'letter', orientation = 'landscape', mapCap = Infinity, ...options } = {}) {
  const log = [], layout = layoutOf({ page, orientation }), plan = planSheet({ layout, page, orthoGsd: 1, dpi, mapCap });
  const result = await renderSheet({ layout, plan, ortho: ortho(), lineColor: '#ee5007', propertyLines: [[[500220, 4700060], [500390, 4700060]]], boundary: OWN[0].rings, clip, createCanvas: pixelCanvasFactory(log), ...options });
  const at = (x, y) => log[0].pixel(Math.round(plan.frame.x + (500000 + x - layout.extent.minE) / (layout.extent.maxE - layout.extent.minE) * plan.frame.width), Math.round(plan.frame.y + (layout.extent.maxN - 4700000 - y) / (layout.extent.maxN - layout.extent.minN) * plan.frame.height));
  return { layout, plan, result, log, at };
}
const GROUND = [90, 120, 60, 255], WHITE = [255, 255, 255, 255], ORANGE = [0xee, 0x50, 0x07, 255];

test('sheet pixels: only the property and its margin, in its place on white paper, with the boundary over the edge', async () => {
  const s = await draw({ contours: { features: [{ coords: [500060, 4700150, 500390, 4700150], isIndex: true, label: '800ft' }], interval: 10, units: 'imperial' } });
  assert.deepEqual(s.at(120, 100), GROUND);
  assert.deepEqual(s.at(226, 100), GROUND, 'margin');
  assert.deepEqual(s.at(236, 100), WHITE, 'past the margin');
  assert.deepEqual(s.at(220, 100), ORANGE);
  assert.notDeepEqual(s.at(120, 150), GROUND, 'contour');
  assert.deepEqual(s.at(300, 150), WHITE, 'contour clipped');
  assert.deepEqual(s.at(300, 60), WHITE, 'neighbour’s line clipped');
  assert.deepEqual([s.log[0].pixel(2, 2), s.log[0].pixel(s.plan.width - 2, s.plan.height - 2)], [WHITE, WHITE], 'paper');
  assert.ok(s.result.uncaptured > 0);
  const hatch = new Set();
  for (let x = 24; x < 37; x += 0.2) hatch.add(s.at(x, 100).join());
  assert.ok(hatch.has('154,154,154,255') && hatch.has(WHITE.join()));
  const words = s.log[0].texts.map(t => t.text).join(' ');
  for (const part of ['Example task', PROPERTY_LINES_NOTE, CREDITS[0], s.layout.scaleText, 'Grid north', 'Property lines']) assert.ok(words.includes(part), part);
  assert.equal(s.log.length, 2, 'the sheet and one image canvas');
});

test('preview and print are the same picture at two sizes', async () => {
  const small = await draw({ dpi: 60 }), big = await draw({ dpi: 120 });
  assert.deepEqual(small.log[0].texts.map(t => t.text), big.log[0].texts.map(t => t.text));
  small.log[0].texts.forEach((t, i) => { const u = big.log[0].texts[i]; assert.ok(Math.abs(t.x * 2 - u.x) < 2 && Math.abs(t.y * 2 - u.y) < 2, t.text); });
  for (const [x, y] of [[120, 100], [226, 100], [236, 100], [60, 200], [390, 290], [5, 5], [215, 235]]) assert.deepEqual(small.at(x, y), big.at(x, y), `${x}, ${y}`);
});

test('without download the imagery on the sheet is no finer than the cap, whatever the page', async () => {
  const sizes = [], factory = pixelCanvasFactory([]);
  const layout = layoutOf({ page: 'tabloid' }), plan = planSheet({ layout, page: 'tabloid', orthoGsd: 0.01, mapCap: 300, dpi: 60 });
  await renderSheet({ layout, plan, ortho: ortho(), clip: null, createCanvas: (w, h) => { sizes.push([w, h]); return factory(w, h); } });
  assert.deepEqual(sizes, [[plan.width, plan.height], [plan.map.width, plan.map.height]]);
  assert.ok(Math.max(...sizes[1]) <= 300);
});

test('a sheet stops and frees its canvases when cancelled, when access changes, or when the browser cannot draw it', async () => {
  const layout = layoutOf(), plan = planSheet({ layout, page: 'letter', orthoGsd: 1, dpi: 48 });
  const made = [], factory = pixelCanvasFactory([]), createCanvas = (w, h) => { const c = factory(w, h); made.push(c); return c; };
  await assert.rejects(renderSheet({ layout, plan, ortho: ortho(), createCanvas, checkpoint: () => { throw new DOMException('x', 'AbortError'); } }), { name: 'AbortError' });
  await assert.rejects(renderSheet({ layout, plan, ortho: ortho(), createCanvas, clip: () => { throw new Error('clip'); } }), /clip/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderSheet({ layout, plan, ortho: ortho(), createCanvas, signal: controller.signal }), { name: 'AbortError' });
  assert.ok(made.length >= 2 && made.every(c => c.width === 0), 'freed');
  await assert.rejects(renderSheet({ layout, plan, ortho: ortho(), createCanvas: () => ({ width: 0, height: 0, getContext: () => null }) }), { code: 'print_too_large' });
  await assert.rejects(renderSheet({ layout, plan, ortho: ortho(), createCanvas: () => { throw new RangeError('big'); } }), { code: 'print_too_large' });
});

test('text is measured the same at any dpi, and the mark matches the published one', async () => {
  const m = createSheetMeasure(pixelCanvasFactory([]));
  assert.equal(m('abcd', 20), 44);
  assert.equal(m('abcd', 20, 700), 44);
  const { readFileSync } = await import('node:fs');
  const svg = readFileSync(new URL('../public/lt-mark.svg', import.meta.url), 'utf8'), code = readFileSync(new URL('../print-sheet.mjs', import.meta.url), 'utf8');
  const paths = [...svg.matchAll(/ d="([^"]+)"/g)].map(match => match[1]);
  assert.equal(paths.length, 3);
  for (const path of paths) assert.ok(code.includes(`'${path}'`), path.slice(0, 30));
  assert.match(svg, /viewBox="238\.5 226 776 776"/);
});
