// Printing one property: choosing it, its clip, what part was captured, and
// the PNG export. Synthetic parcels and generic owner names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelCanvasFactory } from './helpers/pixel-canvas.mjs';
import { PROPERTY_LINES_NOTE, UNCAPTURED_LABEL, assertOrthoPrintAllowed, exportOrthoPrint, orthoPrintPolicy, printLongEdge, renderOrthoPixels, renderOrthoPrint } from '../ortho-print-export.mjs';
import { childTiles, createParcelTileLoader, lonLatToTileXY, makeTile } from '../property-lines.mjs';
import {
  CLIP_HIDE, CLIP_SHOW, CLIP_UNCAPTURED, PRINT_PROPERTY_MESSAGES, captureMask, coverageNote, linesToUtm, outlineAt, outlineRefusal, outlineToUtm,
  printClip, printPropertyError, propertyCoverage, propertyFrame, readCaptureMask, resolvePrintProperty, shapeMask,
} from '../print-property.mjs';
import { dissolveParcelsByOwner, outlineAreaM2 } from '../property-lines-owners.mjs';

const box = (x, y, w, h = w) => [[x, y], [x, y + h], [x + w, y + h], [x + w, y], [x, y]];

// ── Masks ────────────────────────────────────────────────────────────────

const inRing = (ring, x, y) => { let k = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) k = !k; } return k; };
const toSegment = (x, y, [ax, ay], [bx, by]) => { const l = (bx - ax) ** 2 + (by - ay) ** 2, t = l ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l)) : 0; return Math.hypot(ax + t * (bx - ax) - x, ay + t * (by - ay) - y); };
function bruteDistance(parcels, x, y) {
  if (parcels.some(p => p.rings.reduce((k, r) => k !== inRing(r, x, y), false))) return 0;
  let d = Infinity;
  for (const p of parcels) for (const r of p.rings) for (let i = 1; i < r.length; i++) d = Math.min(d, toSegment(x, y, r[i - 1], r[i]));
  return d;
}
const SHAPES = {
  concave: [{ rings: [[[10, 10], [10, 80], [30, 80], [30, 30], [80, 30], [80, 10], [10, 10]]] }],
  hole: [{ rings: [box(10, 10, 80), box(35, 35, 30)] }],
  parts: [{ rings: [box(5, 5, 20), box(60, 60, 30)] }],
  'shared corner': [{ rings: [box(10, 10, 30)] }, { rings: [box(40, 40, 30)] }],
  sliver: [{ rings: [[[10, 10], [90, 50], [90, 50.6], [10, 10]]] }],
  'off the edge': [{ rings: [box(-30, 60, 60)] }],
};

test('mask: inside, and within the margin, pixel by pixel against plain distance', () => {
  for (const [name, parcels] of Object.entries(SHAPES)) for (const radius of [0, 3.3, 12]) {
    const mask = shapeMask(parcels, { width: 100, height: 100, project: (x, y) => [x, y], radius });
    let wrong = 0;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const d = bruteDistance(parcels, x + 0.5, y + 0.5);
      if (Math.abs(d - radius) < 1e-9 || (radius === 0 && bruteDistance([{ rings: parcels.flatMap(p => p.rings).map(r => r) }], x + 0.5, y + 0.5) < 1e-9 && d > 0)) continue;
      if (mask[y * 100 + x] !== Number(d <= radius)) wrong++;
    }
    assert.equal(wrong, 0, `${name}, margin ${radius}`);
  }
});

// A capture 100 x 60 cells of 2 m, uncaptured west strip, one large hole, one speck.
function captureFixture() {
  const width = 100, height = 60, alpha = new Uint8Array(width * height).fill(255);
  const clear = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) alpha[y * width + x] = 0; };
  clear(0, 0, 12, height); clear(60, 20, 72, 30); clear(40, 40, 42, 42);
  return { alpha, width, height, extent: { minE: 1000, maxE: 1200, minN: 5000, maxN: 5120 } };
}

test('capture: distance inside the edge of the capture, against plain distance; holes are edges, specks are not', () => {
  const f = captureFixture(), capture = captureMask(f);
  const bare = []; // uncaptured cell centres, with a ring of them all round the raster
  for (let y = -1; y <= f.height; y++) for (let x = -1; x <= f.width; x++) {
    const inside = x >= 0 && y >= 0 && x < f.width && y < f.height, speck = x >= 40 && x < 42 && y >= 40 && y < 42;
    if (!inside || (f.alpha[y * f.width + x] === 0 && !speck)) bare.push([1000 + (x + 0.5) * 2, 5120 - (y + 0.5) * 2]);
  }
  for (let y = 0; y < f.height; y += 3) for (let x = 0; x < f.width; x += 3) {
    const e = 1000 + (x + 0.5) * 2, n = 5120 - (y + 0.5) * 2, d = Math.min(...bare.map(([a, b]) => Math.hypot(a - e, b - n)));
    assert.equal(capture.captured(e, n), d > 0, `${x},${y}`);
    assert.ok(Math.abs(capture.inside(e, n) - Math.max(0, d - 1)) < 1e-3, `${x},${y}: ${capture.inside(e, n)} vs ${d - 1}`);
  }
  assert.equal(capture.captured(1081, 5039), true, 'the 4 m speck is filled');
  assert.deepEqual([capture.captured(999, 5050), capture.inside(1300, 5050)], [false, 0], 'nothing past the raster');
});

test('clip: the trim never takes anything inside the property; the margin ring loses the edge; missing ground is marked', () => {
  const capture = captureMask(captureFixture()), extent = { minE: 1000, maxE: 1200, minN: 5000, maxN: 5120 };
  // Reaches into the uncaptured west strip (captured from 1024).
  const parcels = [{ rings: [box(1014, 5050, 40)] }];
  const { mask, uncaptured } = printClip({ width: 200, height: 120, extent, parcels, marginMeters: 8, trimMeters: 8, capture });
  const at = (e, n) => mask[Math.floor(5120 - n) * 200 + Math.floor(e - 1000)];
  assert.equal(at(1025, 5070), CLIP_SHOW, '1 m inside the capture edge, inside the property');
  assert.equal(at(1018, 5070), CLIP_UNCAPTURED);
  assert.equal(at(1008, 5070), CLIP_HIDE, 'margin with no imagery is hidden, not marked');
  assert.equal(at(1026, 5048), CLIP_HIDE, 'margin near the edge of the capture is trimmed');
  assert.equal(at(1045, 5046), CLIP_SHOW, 'margin well inside the capture');
  assert.equal(at(1045, 5040), CLIP_HIDE, 'past the margin');
  assert.equal(uncaptured, 10 * 40);
  for (let e = 1014.5; e < 1054; e++) for (let n = 5050.5; n < 5090; n++) assert.notEqual(at(e, n), CLIP_HIDE, 'nothing inside the property is hidden');
  // Whole capture: trimmed all round, the hole too.
  const whole = printClip({ width: 200, height: 120, extent, trimMeters: 8, capture }).mask;
  const w = (e, n) => whole[Math.floor(5120 - n) * 200 + Math.floor(e - 1000)];
  assert.deepEqual([w(1026, 5060), w(1040, 5060), w(1195, 5060), w(1130, 5080), w(1116, 5080)], [CLIP_HIDE, CLIP_SHOW, CLIP_HIDE, CLIP_HIDE, CLIP_HIDE]);
  assert.ok(!whole.includes(CLIP_UNCAPTURED));
  // No trim: everything captured.
  const all = printClip({ width: 200, height: 120, extent, trimMeters: 0, capture }).mask;
  assert.equal(all[60 * 200 + 25], CLIP_SHOW);
});

test('coverage: the share captured, 100 only when nothing is missing, and a warning near the edge', () => {
  const capture = captureMask(captureFixture());
  const of = (x, y, w, h, trimMeters = 0) => propertyCoverage({ parcels: [{ rings: [box(x, y, w, h)] }], capture, trimMeters });
  assert.deepEqual([of(1014, 5050, 40, 40).percent, of(1040, 5090, 20, 10).percent, of(1002, 5050, 10, 10).percent], [75, 100, 0]);
  assert.equal(of(1023.5, 5050, 100, 10).percent, 99, 'a sliver missing is never 100');
  assert.equal(of(1000, 5050, 24.2, 20).percent, 1, 'a sliver captured is never 0');
  assert.equal(of(1040, 5090, 20, 10, 8).nearEdge, false);
  assert.equal(of(1026, 5050, 40, 10, 8).nearEdge, true);
  assert.equal(of(5000, 5050, 40, 10, 8).percent, 0);
  assert.equal(coverageNote({ percent: 87, nearEdge: true }), '87% of this property was captured. Part of this property is near the edge of the capture and may be distorted.');
  assert.equal(coverageNote({ percent: 100, nearEdge: false }), '');
});

// ── Choosing ─────────────────────────────────────────────────────────────

const LAT = 44.5, [TX, TY] = lonLatToTileXY(-90.2, LAT, 14), TILE = makeTile(14, TX, TY), EDGE = TILE.bounds.east;
const ll = (lon, w, owner, id, south = LAT - 0.001, h = 0.002) => ({ id, ...(owner ? { owner } : {}), rings: [box(lon, south, w, h).map(p => p.map(v => Math.round(v * 1e7) / 1e7))] });
const WEST = ll(EDGE - 0.010, 0.006, 'SAMPLE FARMS LLC', 1), MID = ll(EDGE - 0.004, 0.006, 'Sample Farms LLC', 2), EAST = ll(EDGE + 0.002, 0.004, 'EXAMPLE OWNER', 3);
const ALL = [WEST, MID, EAST];
const overlaps = (p, b) => { const r = p.rings[0]; return r[0][0] < b.east && r[2][0] > b.west && r[0][1] < b.north && r[1][1] > b.south; };
// A loader over fixed parcels, as the controller gives it: tiles in, parcels touching them out.
function loaderOver(parcels, { bad = () => null } = {}) {
  const asked = [];
  const load = async bounds => {
    const [x0, y0] = lonLatToTileXY(bounds.west, bounds.north, 14), [x1, y1] = lonLatToTileXY(bounds.east, bounds.south, 14);
    const tiles = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push(makeTile(14, x, y));
    asked.push(tiles.map(t => t.key));
    const loader = createParcelTileLoader({ debounceMs: 0, fetchImpl: async url => {
      const key = new URL(url, 'http://x').searchParams.get('tile'), [z, x, y] = key.split('/').map(Number);
      const state = bad(key);
      if (state === 'busy') return { ok: false, status: 503, json: async () => ({}) };
      if (state === 'many') return { ok: true, status: 200, json: async () => ({ status: 'too_many', parcels: [] }) };
      const found = parcels.filter(p => overlaps(p, makeTile(z, x, y).bounds));
      return { ok: true, status: 200, json: async () => ({ status: found.length ? 'ok' : 'none', parcels: found }) };
    } });
    const r = await loader.load(tiles, { area: bounds, immediate: true });
    return { status: r.status, parcels: r.parcels, loaded: new Set(r.loaded || []), failed: Boolean(r.failed) || r.status === 'unavailable', partial: Boolean(r.partial) };
  };
  return { load, asked };
}
const reason = expected => error => { assert.equal(error.code, 'print_property'); assert.equal(error.reason, expected); assert.equal(error.message, PRINT_PROPERTY_MESSAGES[expected]); return true; };

test('choosing: merged takes the owner’s touching land and loads outward until all of it, and the margin, answered', async () => {
  const { load, asked } = loaderOver(ALL);
  const found = await resolvePrintProperty({ point: [EDGE - 0.008, LAT], merge: true, load });
  assert.deepEqual(found.outline.parcelIds.sort(), [1, 2]);
  assert.ok(asked[0].length === 1 && asked.at(-1).some(k => k === `14/${TX + 1}/${TY}`), 'grew into the next tile');
  assert.ok(found.areaM2 > 0);
  assert.ok(found.outlines.some(o => o.parcelIds.includes(3)), 'neighbours in the margin are known');
  const single = await resolvePrintProperty({ point: [EDGE - 0.008, LAT], merge: false, load: loaderOver(ALL).load });
  assert.deepEqual(single.outline.parcelIds, [1]);
  assert.ok(Math.abs(single.areaM2 / found.areaM2 - 0.5) < 1e-6);
});

test('choosing refuses rather than print part of a property', async () => {
  const at = (load, point = [EDGE - 0.008, LAT], merge = true) => resolvePrintProperty({ point, merge, load });
  await assert.rejects(at(loaderOver([{ ...WEST, lines: [WEST.rings[0].slice(0, 3)] }, MID]).load), reason('clipped'));
  await assert.rejects(at(loaderOver([WEST, { ...MID, lines: [MID.rings[0].slice(0, 3)] }]).load), reason('clipped'), 'a clipped member found while growing');
  await assert.rejects(at(loaderOver([{ ...WEST, rings: [WEST.rings[0].slice(0, 4)] }]).load), reason('unclosed'));
  const next = `14/${TX + 1}/${TY}`;
  await assert.rejects(at(loaderOver(ALL, { bad: key => (key === next ? 'busy' : null) }).load), reason('incomplete'));
  await assert.rejects(at(loaderOver(ALL, { bad: key => (key === next || (key.split('/')[0] > 14 && childTiles(makeTile(14, TX + 1, TY)).some(c => key === c.key || childTiles(c).some(d => d.key === key))) ? 'many' : null) }).load), reason('too_many'));
  await assert.rejects(at(loaderOver(ALL, { bad: () => 'busy' }).load), reason('incomplete'));
  await assert.rejects(at(loaderOver(ALL).load, [EDGE - 0.008, LAT + 0.005]), reason('none'));
  await assert.rejects(at(loaderOver([]).load), reason('none'));
  for (const status of ['upload', 'georef', 'unavailable']) await assert.rejects(at(async () => ({ status, parcels: [], loaded: new Set() })), reason(status));
  // Tiles that never answer stop it; it does not loop.
  let calls = 0;
  await assert.rejects(at(async () => { calls++; return { status: 'ok', parcels: ALL, loaded: new Set(), failed: false, partial: false }; }), reason('incomplete'));
  assert.ok(calls <= 8, `${calls} loads`);
});

test('choosing: a closed but unsound shape is refused; valid land that cannot be added up prints without acreage', async () => {
  const [w, s] = [EDGE - 0.010, LAT - 0.001], at = rings => ({ id: 1, owner: 'SAMPLE FARMS LLC', rings: rings.map(r => r.map(([x, y]) => [Math.round((w + x * 1e-5) * 1e7) / 1e7, Math.round((s + y * 1e-5) * 1e7) / 1e7])) });
  const unsound = {
    'bow tie': at([[[0, 0], [200, 200], [200, 0], [0, 200], [0, 0]]]),
    'crossed ring': at([[[0, 0], [250, 200], [200, 0], [0, 150], [0, 0]]]),
    'ring twice': at([box(0, 0, 200), box(0, 0, 200)]),
    'overlapping parts': at([box(0, 0, 200), box(150, 150, 200)]),
    'no area': at([[[0, 0], [200, 0], [100, 0], [0, 0]]]),
  };
  for (const [name, parcel] of Object.entries(unsound)) {
    assert.equal(outlineRefusal({ parcels: [parcel] }), 'unsound', name);
    assert.equal(outlineRefusal({ parcels: [WEST, parcel] }), 'unsound', `${name}, one of several`);
    if (name === 'no area' || name === 'ring twice') continue;   // nothing to click inside
    for (const merge of [true, false]) await assert.rejects(resolvePrintProperty({ point: [w + 190e-5, s + (name === 'bow tie' ? 100e-5 : 30e-5)], merge, load: loaderOver([parcel]).load }), reason('unsound'), name);
  }
  // Sound: plain, holed, multi-part, an island, a hole touching its outer ring.
  for (const parcel of [WEST, at([box(0, 0, 200), box(50, 50, 50)]), at([box(0, 0, 100), box(300, 0, 100)]), at([box(0, 0, 200), box(50, 50, 100), box(70, 70, 20)]), at([box(0, 0, 200), [[0, 0], [100, 50], [50, 100], [0, 0]]])])
    assert.equal(outlineRefusal({ parcels: [parcel] }), null);
  // Open is its own reason.
  assert.equal(outlineRefusal({ parcels: [at([box(0, 0, 200).slice(0, 4)])] }), 'unclosed');
  // Two sound parcels side by side, each too long-edged for their union to be added up: printed, no acreage.
  const teeth = dy => { const top = Array.from({ length: 2600 }, (_, i) => [i * 0.2, dy + (i % 2 ? 0.1 : 150)]); return at([[[0, dy - 10], ...top, [520, dy - 10], [0, dy - 10]]]); };
  const a = teeth(0), b = { ...teeth(0.05), id: 2 };
  assert.deepEqual([outlineRefusal({ parcels: [a] }), outlineRefusal({ parcels: [a, b] })], [null, null]);
  const intricate = { ownerKey: 'SAMPLE FARMS LLC', owner: 'SAMPLE FARMS LLC', parcels: [a, b], parcelIds: [1, 2], lines: [] };
  assert.equal(outlineAreaM2(intricate, { covered: () => true }), null);
  // One parcel too intricate even to check is refused, and said differently.
  const huge = at([[[0, -10], ...Array.from({ length: 9000 }, (_, i) => [i * 0.05, i % 2 ? 0.1 : 150]), [460, -10], [0, -10]]]);
  assert.equal(outlineRefusal({ parcels: [huge] }), 'unverified');
  assert.notEqual(PRINT_PROPERTY_MESSAGES.unverified, PRINT_PROPERTY_MESSAGES.unsound);
});

test('choosing: stacked shapes give the smallest; a hole is not the property', () => {
  const big = ll(-90, 0.01, 'A OWNER', 1), small = ll(-89.996, 0.001, 'B OWNER', 2, LAT - 0.0005, 0.001);
  const outlines = dissolveParcelsByOwner([big, small]);
  assert.deepEqual(outlineAt(outlines, [-89.9955, LAT]).parcelIds, [2]);
  assert.deepEqual(outlineAt(outlines, [-89.999, LAT]).parcelIds, [1]);
  const ringed = dissolveParcelsByOwner([{ id: 9, owner: 'A OWNER', rings: [big.rings[0], small.rings[0]] }]);
  assert.equal(outlineAt(ringed, [-89.9955, LAT]), null);
  assert.equal(outlineRefusal(ringed[0]), null);
});

// ── The print ────────────────────────────────────────────────────────────

const ATTRIBUTION = 'Source: Synthetic Parcel Map R1. Credit.';
// 400 x 200 m, 1 m pixels, flat colour; the first 40 m have no imagery.
function ortho() {
  const reads = [];
  const image = { getWidth: () => 400, getHeight: () => 200, getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616 }), getResolution: () => [1, -1, 0], getFileDirectory: () => ({ getValue: () => undefined }),
    async readRasters({ window: [x0, y0, x1, y1] }) {
      reads.push(1);
      const w = x1 - x0, h = y1 - y0, bands = [90, 120, 60, 255].map(v => new Uint8Array(w * h).fill(v));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x0 + x < 40) bands[3][y * w + x] = 0;
      return bands;
    } };
  return { reads, ds: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200, nodata: NaN, images: [image] } };
}
const at = (x, y) => [500000 + x, 4700000 + y];
// 120 m wide, the west 20 m past the capture's own edge at x = 40.
const OWN = [{ rings: [box(20, 60, 120, 80).map(([x, y]) => at(x, y))] }];
const NEIGHBOUR = [[at(140, 60), at(260, 60), at(260, 140), at(140, 140)]];
const ORANGE = [0xee, 0x50, 0x07, 255], GROUND = [90, 120, 60, 255], WHITE = [255, 255, 255, 255];

async function printOwn({ propertyLines = NEIGHBOUR, boundary = OWN[0].rings, margin = 10, trim = 5, contours = null, ...options } = {}) {
  const { ds, reads } = ortho(), log = [], capture = await readCaptureMask(ds);
  const frame = propertyFrame(OWN, margin);
  let clip = null;
  const result = await exportOrthoPrint({ ortho: ds, extent: frame, frame: true, longEdge: 1200, format: 'png', epsg: 32616, propertyLines, boundary, propertyAttribution: ATTRIBUTION,
    createCanvas: pixelCanvasFactory(log), traceContours: contours ? async () => contours : null,
    prepareClip: async ({ width, height, extent }) => (clip = { ...printClip({ width, height, extent, parcels: OWN, marginMeters: margin, trimMeters: trim, capture }), note: 'Note.' }), ...options });
  const gsd = (frame.maxE - frame.minE) / result.width;
  return { result, reads, clip, texts: log[0].texts, pixel: (x, y) => log[0].pixel(Math.round((500000 + x - frame.minE) / gsd), Math.round((frame.maxN - 4700000 - y) / gsd)) };
}

test('print: the property and its margin only; contours and neighbours’ lines share the clip; the boundary is drawn at the edge', async () => {
  const contours = { features: [{ coords: [...at(60, 130), ...at(300, 130)], isIndex: true, label: '800ft' }], interval: 10, units: 'imperial' };
  const p = await printOwn({ contours });
  assert.deepEqual(p.pixel(90, 100), GROUND, 'inside');
  assert.deepEqual(p.pixel(146, 100), GROUND, 'margin');
  assert.deepEqual(p.pixel(151.2, 100), WHITE, 'past the margin');
  assert.deepEqual(p.pixel(140, 100), ORANGE, 'boundary');
  assert.deepEqual(p.pixel(145, 60), ORANGE, 'a neighbour’s line inside the margin');
  assert.deepEqual(p.pixel(151.2, 60), WHITE, 'and not past it');
  assert.notDeepEqual(p.pixel(90, 130), GROUND, 'contour inside');
  assert.deepEqual(p.pixel(151.2, 130), WHITE, 'contour clipped');
  assert.equal(p.result.filename, 'property-contours-1200px.png');
  assert.equal(p.result.note, 'Note.');
  assert.ok(p.clip.mask.length === p.result.width * p.result.height);
});

test('print: ground with no imagery is hatched and named, never left looking like the edge of the property', async () => {
  const p = await printOwn();
  const colours = new Set();
  for (let x = 22; x < 38; x += 0.25) colours.add(p.pixel(x, 101).join());
  assert.deepEqual([...colours].sort(), ['154,154,154,255', '255,255,255,255']);
  assert.deepEqual(p.pixel(20, 100), ORANGE, 'the real boundary, past the imagery');
  assert.ok(p.texts.some(t => t.text === UNCAPTURED_LABEL));
  const inside = await printOwn({ prepareClip: async ({ width, height }) => ({ mask: new Uint8Array(width * height).fill(1), uncaptured: 0 }) });
  assert.ok(!inside.texts.some(t => t.text === UNCAPTURED_LABEL));
  assert.deepEqual(inside.pixel(12, 100), WHITE, 'nothing is invented past the raster');
});

test('print: the "not a survey" note and source are there even with the lines unticked', async () => {
  const p = await printOwn({ propertyLines: [], boundary: null });
  assert.ok(p.texts.map(t => t.text).join(' ').includes(`${PROPERTY_LINES_NOTE} ${ATTRIBUTION}`));
  assert.ok(!p.texts.some(t => t.text === 'Property lines'));
  for (const bad of ['', '  ', null]) await assert.rejects(printOwn({ propertyLines: [], boundary: null, propertyAttribution: bad }), { code: 'print_note' });
});

test('print: refused before any pixels for a GeoTIFF, an unverified position or an uncaptured property', async () => {
  const base = { propertyLines: [], boundary: null, propertyAttribution: ATTRIBUTION, extent: propertyFrame(OWN, 5), frame: true, longEdge: 400, createCanvas: pixelCanvasFactory([]) };
  for (const [options, code] of [[{ format: 'tif', epsg: 32616 }, 'print_not_permitted'], [{ epsg: null }, 'print_crs'], [{ epsg: 32617 }, 'print_crs'],
    [{ epsg: 32616, prepareClip: async () => { throw printPropertyError('uncaptured'); } }, 'print_property']]) {
    const { ds, reads } = ortho();
    await assert.rejects(exportOrthoPrint({ ortho: ds, ...base, prepareClip: async () => ({ mask: null }), ...options }), { code });
    assert.equal(reads.length, 0, JSON.stringify(options));
  }
  // The checkpoint runs between the clip and the pixels.
  const { ds, reads } = ortho();
  await assert.rejects(exportOrthoPrint({ ortho: ds, ...base, epsg: 32616, prepareClip: async ({ width, height }) => ({ mask: new Uint8Array(width * height), uncaptured: 0 }), checkpoint: () => { throw new DOMException('x', 'AbortError'); } }), { name: 'AbortError' });
  assert.equal(reads.length, 0);
});

test('pixels past the raster are background, not stretched edge pixels', async () => {
  const { ds } = ortho();
  const extent = { minE: 500300, maxE: 500500, minN: 4699900, maxN: 4700100 };
  const print = await renderOrthoPixels({ ds, extent, width: 200, height: 200, background: [255, 255, 255] });
  const clear = await renderOrthoPixels({ ds, extent, width: 200, height: 200 });
  const px = (rgba, x, y) => Array.from(rgba.slice((y * 200 + x) * 4, (y * 200 + x) * 4 + 4));
  assert.deepEqual([px(print.rgba, 50, 50), px(print.rgba, 99, 99), px(print.rgba, 101, 50), px(print.rgba, 50, 101)], [GROUND, GROUND, WHITE, WHITE]);
  assert.deepEqual([px(clear.rgba, 99, 99), px(clear.rgba, 101, 50)], [GROUND, [0, 0, 0, 0]]);
  // Wholly off the raster.
  const off = await renderOrthoPixels({ ds, extent: { minE: 510000, maxE: 510100, minN: 4700000, maxN: 4700100 }, width: 10, height: 10, background: [255, 255, 255] });
  assert.ok(off.rgba.every(v => v === 255));
  // An ordinary export still keeps its extent inside the orthophoto.
  const result = await renderOrthoPrint({ ortho: ds, extent, longEdge: 400, createCanvas: pixelCanvasFactory([]) });
  assert.deepEqual(result.extent, { minE: 500300, maxE: 500400, minN: 4700000, maxN: 4700100 });
});

test('policy: a property is a PNG held to its screen pixels in the view without download permission; the gates are otherwise unchanged', () => {
  const measureOnly = orthoPrintPolicy({ accessAvailable: true, measure: true, download: false }), full = orthoPrintPolicy({ accessAvailable: true, measure: true, download: true });
  assert.doesNotThrow(() => assertOrthoPrintAllowed(measureOnly, { area: 'property', format: 'png' }));
  for (const policy of [measureOnly, full]) assert.throws(() => assertOrthoPrintAllowed(policy, { area: 'property', format: 'tif' }), { code: 'print_not_permitted' });
  assert.throws(() => assertOrthoPrintAllowed(orthoPrintPolicy({ accessAvailable: false, measure: true, download: true }), { area: 'property', format: 'png' }), { code: 'print_not_permitted' });
  assert.throws(() => assertOrthoPrintAllowed(orthoPrintPolicy({ accessAvailable: true, measure: false, download: true }), { area: 'property', format: 'png' }), { code: 'print_not_permitted' });
  for (const area of ['full', 'anything', undefined]) assert.throws(() => assertOrthoPrintAllowed(measureOnly, { area, format: 'png' }), { code: 'print_not_permitted' });
  assert.equal(printLongEdge({ area: 'property', requested: 6144, policy: measureOnly, viewPixels: 1280 }), 1280);
  assert.equal(printLongEdge({ area: 'property', requested: 6144, policy: measureOnly, viewPixels: 9000 }), 2048);
  for (const viewPixels of [NaN, 0, undefined]) assert.equal(printLongEdge({ area: 'property', requested: 6144, policy: measureOnly, viewPixels }), 0, 'not in the view: nothing');
  assert.equal(printLongEdge({ area: 'property', requested: 6144, policy: full, viewPixels: 1280 }), 6144);
});

test('frame and conversion: the whole parcel plus margin, in the model’s metres', () => {
  const frame = propertyFrame(OWN, 7.62);
  assert.ok(frame.minE < 500020 - 7.62 && frame.maxE > 500140 + 7.62 && frame.minN < 4700060 - 7.62 && frame.maxN > 4700140 + 7.62);
  const outline = { parcels: [WEST], lines: WEST.rings };
  const flat = (lat, lon) => [lon * 1000, lat * 1000];
  assert.deepEqual(outlineToUtm(outline, flat)[0].rings[0][0], [WEST.rings[0][0][0] * 1000, WEST.rings[0][0][1] * 1000]);
  assert.equal(linesToUtm([outline, outline], flat).length, 2);
});
