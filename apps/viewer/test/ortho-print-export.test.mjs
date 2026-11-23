import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { buildContours, contourLevels, CONTOUR_COLORS, METERS_PER_FOOT } from '../contours.mjs';
import { BRAND_COLORS } from '../brand-colors.mjs';
import { propertyLinesSourceText } from '../property-lines-layer.mjs';
import { PROPERTY_LINES_NOTE, VIEW_EXPORT_MAX_EDGE, assertOrthoPrintAllowed, canvasWorks, printLongEdge, verifyOrthoCrs, clampExtent, encodePrintGeoTiff, exportOrthoPrint, layoutPropertyNote, orthoPrintPolicy, pickOrthoLevel, printLayout, renderOrthoPixels, renderOrthoPrint, supportedPrintSizes } from '../ortho-print-export.mjs';

const ATTRIBUTION = 'Source: Synthetic Parcel Map R1. Product of the synthetic parcel project.';

// Synthetic orthophoto: 400 x 200 m at 0.5 m (level 0) and 1 m (level 1).
// Red encodes the column, green the row; a 4th band is alpha with a hole.
function orthoFixture() {
  const reads = [];
  const makeImage = (w, h) => ({
    getWidth: () => w, getHeight: () => h,
    getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616 }), getResolution: () => [400 / w, -200 / h, 0], getFileDirectory: () => ({ getValue: () => undefined }),
    async readRasters({ window }) {
      reads.push({ w, window });
      const [x0, y0, x1, y1] = window, ww = x1 - x0, wh = y1 - y0;
      const bands = [0, 1, 2, 3].map(() => new Uint8Array(ww * wh));
      for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
        const i = y * ww + x, sx = (x0 + x) * (800 / w), sy = (y0 + y) * (400 / h);
        bands[0][i] = Math.floor(sx / 4) % 256; bands[1][i] = Math.floor(sy / 2) % 256; bands[2][i] = 90;
        bands[3][i] = sx < 40 ? 0 : 255; // first 20 m are nodata
      }
      return bands;
    },
  });
  return { reads, ds: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200, nodata: NaN, images: [makeImage(800, 400), makeImage(400, 200)] } };
}

test('layout keeps square pixels on the long edge and clamps to the orthophoto', () => {
  assert.deepEqual(printLayout({ minE: 0, maxE: 400, minN: 0, maxN: 200 }, 4096), { width: 4096, height: 2048, gsdE: 400 / 4096, gsdN: 200 / 2048 });
  assert.deepEqual(printLayout({ minE: 0, maxE: 100, minN: 0, maxN: 300 }, 600), { width: 200, height: 600, gsdE: 0.5, gsdN: 0.5 });
  const { ds } = orthoFixture();
  assert.deepEqual(clampExtent({ minE: 499900, maxE: 500100, minN: 4700050, maxN: 4700500 }, ds), { minE: 500000, maxE: 500100, minN: 4700050, maxN: 4700200 });
  assert.equal(clampExtent({ minE: 0, maxE: 1, minN: 0, maxN: 1 }, ds), null);
  assert.equal(pickOrthoLevel(ds, 0.5), 0);
  assert.equal(pickOrthoLevel(ds, 1.2), 1);
});

test('ortho pixels are resampled in bounded strips at the right place; nodata turns white for print', async () => {
  const { ds, reads } = orthoFixture();
  const extent = { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 };
  const { rgba, level } = await renderOrthoPixels({ ds, extent, width: 400, height: 200, background: [255, 255, 255], maxStripPixels: 20_000 });
  assert.equal(level, 1);
  assert.ok(reads.length > 3, 'several strips');
  assert.ok(reads.every(r => (r.window[2] - r.window[0]) * (r.window[3] - r.window[1]) <= 20_000));
  const px = (x, y) => Array.from(rgba.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 4));
  assert.deepEqual(px(5, 5), [255, 255, 255, 255], 'transparent source composited on white');
  const mid = px(200, 100);
  assert.ok(Math.abs(mid[0] - 100) <= 1 && Math.abs(mid[1] - 100) <= 1 && mid[2] === 90 && mid[3] === 255, JSON.stringify(mid));
  const geo = await renderOrthoPixels({ ds, extent, width: 400, height: 200 });
  assert.equal(geo.rgba[(5 * 400 + 5) * 4 + 3], 0, 'GeoTIFF keeps nodata transparent');
});

test('GeoTIFF export is georeferenced in the orthophoto CRS and round-trips RGBA', async () => {
  const width = 8, height = 4, rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([i, 2 * i, 3 * i, 255], i * 4);
  const extent = { minE: 500000, maxE: 500016, minN: 4700000, maxN: 4700008 };
  const buffer = encodePrintGeoTiff({ rgba, width, height, extent, epsg: 32616 });
  const tiff = await fromArrayBuffer(buffer), image = await tiff.getImage();
  assert.deepEqual([image.getWidth(), image.getHeight(), image.getSamplesPerPixel()], [8, 4, 4]);
  assert.deepEqual(image.getBoundingBox(), [500000, 4700000, 500016, 4700008]);
  assert.equal(image.getGeoKeys().ProjectedCSTypeGeoKey, 32616);
  const bands = await image.readRasters({ interleave: true });
  assert.deepEqual(Array.from(bands.slice(4 * 9, 4 * 9 + 4)), [9, 18, 27, 255]);
  assert.deepEqual(image.getResolution(), [2, -2, 0]);
  assert.equal(image.getGeoKeys().GTRasterTypeGeoKey, 1, 'PixelIsArea');
  assert.deepEqual(Array.from(image.getFileDirectory().getValue('ExtraSamples')), [2], 'unassociated alpha');
  assert.throws(() => encodePrintGeoTiff({ rgba, width, height, extent, epsg: null }), { code: 'print_crs' });
});

test('GeoTIFF encoding of a 4096 px print is one buffer copy, not a per-byte loop', async () => {
  const width = 4096, height = 3072, rgba = new Uint8ClampedArray(width * height * 4).fill(200);
  rgba.set([1, 2, 3, 4], (height * width - 1) * 4);
  const started = performance.now();
  const buffer = encodePrintGeoTiff({ rgba, width, height, extent: { minE: 500000, maxE: 500409.6, minN: 4700000, maxN: 4700307.2 }, epsg: 32616 });
  const ms = performance.now() - started;
  assert.ok(ms < 1500, `encode took ${ms.toFixed(0)} ms`);
  assert.ok(buffer.byteLength >= width * height * 4 && buffer.byteLength < width * height * 4 + 1024);
  const image = await (await fromArrayBuffer(buffer)).getImage();
  const last = await image.readRasters({ window: [width - 1, height - 1, width, height], interleave: true });
  assert.deepEqual(Array.from(last), [1, 2, 3, 4]);
});

test('export policy: measure-only viewers get current-view PNG; whole orthophoto and GeoTIFF need download; expired access gets nothing', () => {
  const measureOnly = orthoPrintPolicy({ accessAvailable: true, measure: true, download: false });
  assert.deepEqual(measureOnly, { allowed: true, whole: false, geotiff: false });
  assert.doesNotThrow(() => assertOrthoPrintAllowed(measureOnly, { area: 'view', format: 'png' }));
  assert.throws(() => assertOrthoPrintAllowed(measureOnly, { area: 'full', format: 'png' }), { code: 'print_not_permitted' });
  assert.throws(() => assertOrthoPrintAllowed(measureOnly, { area: 'view', format: 'tif' }), { code: 'print_not_permitted' });
  const full = orthoPrintPolicy({ accessAvailable: true, measure: true, download: true });
  assert.doesNotThrow(() => assertOrthoPrintAllowed(full, { area: 'full', format: 'tif' }));
  const expired = orthoPrintPolicy({ accessAvailable: false, measure: true, download: true });
  assert.deepEqual(expired, { allowed: false, whole: false, geotiff: false });
  assert.throws(() => assertOrthoPrintAllowed(expired, { area: 'view', format: 'png' }), { code: 'print_not_permitted' });
  assert.equal(orthoPrintPolicy({ accessAvailable: true, measure: false, download: true }).allowed, false);
});

test('without download permission a current-view export is capped at the screen size and 2048 px', () => {
  const measureOnly = orthoPrintPolicy({ accessAvailable: true, measure: true, download: false });
  const full = orthoPrintPolicy({ accessAvailable: true, measure: true, download: true });
  assert.equal(VIEW_EXPORT_MAX_EDGE, 2048);
  assert.equal(printLongEdge({ area: 'view', requested: 6144, policy: measureOnly, viewPixels: 3840 }), 2048, 'never above 2048 px');
  assert.equal(printLongEdge({ area: 'view', requested: 6144, policy: measureOnly, viewPixels: 1280 }), 1280, 'never above the screen');
  assert.equal(printLongEdge({ area: 'view', requested: 2048, policy: measureOnly, viewPixels: NaN }), 2048);
  assert.equal(printLongEdge({ area: 'view', requested: 6144, policy: full, viewPixels: 1280 }), 6144, 'download permission keeps the chosen size');
  assert.equal(printLongEdge({ area: 'full', requested: 6144, policy: full, viewPixels: 1280 }), 6144);
});

test('orthophoto CRS must match the model and be north-up; mismatches are refused before reading pixels', async () => {
  const image = (keys, transform, resolution = [0.5, -0.5, 0]) => ({ getGeoKeys: () => keys, getResolution: () => resolution, getFileDirectory: () => ({ getValue: name => name === 'ModelTransformation' ? transform : undefined }) });
  assert.doesNotThrow(() => verifyOrthoCrs({ images: [image({ ProjectedCSTypeGeoKey: 32616 })] }, 32616, { requireDeclared: true }));
  assert.throws(() => verifyOrthoCrs({ images: [image({ ProjectedCSTypeGeoKey: 32617 })] }, 32616), { code: 'print_crs', message: /does not match/ });
  assert.throws(() => verifyOrthoCrs({ images: [image({ ProjectedCSTypeGeoKey: 32616 }, [0.5, 0.01, 0, 500000, 0.01, -0.5, 0, 4700000, 0, 0, 0, 0, 0, 0, 0, 1])] }, 32616), { code: 'print_crs', message: /rotated/ });
  assert.throws(() => verifyOrthoCrs({ images: [image({ ProjectedCSTypeGeoKey: 32616 }, [0.5, 0, 0, 500000, 0, 0.5, 0, 4700000, 0, 0, 0, 0, 0, 0, 0, 1])] }, 32616), { code: 'print_crs' }, 'south-up');
  assert.doesNotThrow(() => verifyOrthoCrs({ images: [image({ ProjectedCSTypeGeoKey: 32616 }, [0.5, 0, 0, 500000, 0, -0.5, 0, 4700000, 0, 0, 0, 0, 0, 0, 0, 1])] }, 32616), 'plain north-up transform is allowed');
  assert.throws(() => verifyOrthoCrs({ images: [image({ ProjectedCSTypeGeoKey: 32616 }, undefined, [0.5, 0.5, 0])] }, 32616), { code: 'print_crs' });
  assert.throws(() => verifyOrthoCrs({ images: [image({})] }, 32616, { requireDeclared: true }), { code: 'print_crs', message: /does not declare/ });
  assert.doesNotThrow(() => verifyOrthoCrs({ images: [image({})] }, 32616), 'undeclared is fine for a PNG');
  const { ds, reads } = orthoFixture();
  for (const img of ds.images) img.getGeoKeys = () => ({ ProjectedCSTypeGeoKey: 32617 });
  const extent = { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 };
  await assert.rejects(exportOrthoPrint({ ortho: ds, extent, longEdge: 400, format: 'tif', epsg: 32616, createCanvas: fakeCanvasFactory([]) }), { code: 'print_crs' });
  await assert.rejects(exportOrthoPrint({ ortho: ds, extent, longEdge: 400, format: 'png', epsg: 32616, propertyLines: [[[500050, 4700050], [500060, 4700060]]], propertyAttribution: ATTRIBUTION, createCanvas: fakeCanvasFactory([]) }), { code: 'print_crs' }, 'overlays would misalign');
  assert.equal(reads.length, 0);
});

test('6144 px is offered only where a canvas that large works; never on iOS', () => {
  const probe = ok => (w, h) => ({ width: 0, height: 0, getContext: () => ok ? { fillRect() {}, getImageData: () => ({ data: [255, 0, 0, 255] }) } : null });
  assert.deepEqual(supportedPrintSizes({ navigatorRef: { userAgent: 'Windows' }, createCanvas: probe(true) }), [2048, 4096, 6144]);
  assert.deepEqual(supportedPrintSizes({ navigatorRef: { userAgent: 'Windows' }, createCanvas: probe(false) }), [2048, 4096]);
  assert.deepEqual(supportedPrintSizes({ navigatorRef: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' }, createCanvas: probe(true) }), [2048, 4096]);
  assert.deepEqual(supportedPrintSizes({ navigatorRef: { userAgent: 'Macintosh', maxTouchPoints: 5 }, createCanvas: probe(true) }), [2048, 4096]);
  assert.equal(canvasWorks(() => { throw new RangeError('too big'); }, 6144, 6144), false);
});

test('a canvas the browser cannot back fails with a clear size error before reading pixels', async () => {
  const { ds, reads } = orthoFixture();
  await assert.rejects(renderOrthoPrint({ ortho: ds, extent: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 }, longEdge: 6144,
    createCanvas: () => ({ width: 0, height: 0, getContext: () => null }) }), { code: 'print_too_large', message: /Choose a smaller size/ });
  assert.equal(reads.length, 0);
});

function fakeCanvasFactory(log) {
  return (w, h) => {
    const ops = [];
    const ctx = new Proxy({
      createImageData: (iw, ih) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }),
      putImageData(image) { this.image = image; },
      getImageData(x, y, gw, gh) {
        const data = new Uint8ClampedArray(gw * gh * 4);
        if (!('image' in this)) return { data: data.fill(255) }; // the note rows' own canvas
        for (let r = 0; r < gh; r++) data.set(this.image.data.subarray(((y + r) * w + x) * 4, ((y + r) * w + x + gw) * 4), r * gw * 4);
        return { data };
      },
      measureText: t => ({ width: t.length * 7 }),
    }, {
      get(target, key) { if (key in target) return target[key]; return (...args) => ops.push([key, ...args]); },
      set(target, key, value) { if (key === 'image') target.image = value; else ops.push(['set', key, value]); return true; },
    });
    const canvas = { width: w, height: h, getContext: () => ctx, toBlob: cb => cb(new Blob(['png'], { type: 'image/png' })) };
    log.canvases = (log.canvases || 0) + 1;
    log.push({ canvas, ops, ctx });
    return canvas;
  };
}

test('export traces contours for the print extent and burns lines, ft labels and property lines into the image', async () => {
  const { ds } = orthoFixture();
  const log = [];
  let traced = null;
  // DTM plane rising 1 ft per metre eastward from 700 ft at the west edge.
  const traceContours = async (extent, targetCell) => {
    traced = { extent, targetCell };
    const w = 401, h = 201, values = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = (700 + x) * METERS_PER_FOOT;
    const { levels } = contourLevels(700 * METERS_PER_FOOT, 1100 * METERS_PER_FOOT, 10, 'imperial');
    return { features: buildContours({ values, width: w, height: h, levels, grid: { minE: 499999.5, maxN: 4700200.5, cellE: 1, cellN: 1 } }), interval: 10, units: 'imperial' };
  };
  const result = await exportOrthoPrint({
    ortho: ds, extent: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 }, longEdge: 2048, format: 'png',
    traceContours, colors: CONTOUR_COLORS.brown, units: 'imperial', createCanvas: fakeCanvasFactory(log),
    propertyLines: [[[500050, 4700050], [500350, 4700050], [500350, 4700150], [500050, 4700050]]], propertyAttribution: ATTRIBUTION,
  });
  assert.equal(result.filename, 'orthophoto-contours-2048px.png');
  assert.deepEqual([result.width, result.height], [2048, 1024]);
  assert.ok(Math.abs(traced.targetCell - 2.5 * 400 / 2048) < 1e-9, 'about 2.5 output px per DTM cell');
  assert.ok(result.contours.minor > 0 && result.contours.index > 0 && result.contours.labels > 0, JSON.stringify(result.contours));
  assert.equal(result.propertyLines, 1);
  const { ops } = log[0];
  const texts = ops.filter(o => o[0] === 'fillText').map(o => o[1]);
  assert.ok(texts.includes('750ft') && texts.includes('800ft'), texts.join(','));
  assert.ok(texts.some(t => /Contours 10 ft · index every 50 ft/.test(t)), 'legend states interval and index');
  assert.ok(ops.some(o => o[0] === 'set' && o[1] === 'strokeStyle' && o[2] === CONTOUR_COLORS.brown.index), 'index colour used');
  assert.ok(ops.some(o => o[0] === 'set' && o[1] === 'strokeStyle' && o[2] === BRAND_COLORS.orange), 'property lines drawn, brand orange by default');
  const tif = await exportOrthoPrint({
    ortho: ds, extent: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 }, longEdge: 400, format: 'tif', epsg: 32616,
    traceContours, units: 'imperial', createCanvas: fakeCanvasFactory([]), propertyLines: [[[500050, 4700050], [500350, 4700050]]], propertyStyle: { color: '#F97316' }, propertyAttribution: ATTRIBUTION,
  });
  assert.equal(tif.filename, 'orthophoto-contours-400px.tif');
  const geo = await (await fromArrayBuffer(await tif.blob.arrayBuffer())).getImage();
  // The note's rows lie below the map: the top-left corner and pixel size are the map's.
  assert.deepEqual(geo.getBoundingBox(), [500000, 4700200 - geo.getHeight(), 500400, 4700200]);
  assert.ok(geo.getHeight() > 200);
  // Index line at 800 ft is 100 m east of the west edge: x = 100 / gsd.
  const moves = ops.filter(o => o[0] === 'moveTo' || o[0] === 'lineTo').map(o => o[1]);
  assert.ok(moves.some(x => Math.abs(x - 100 * 2048 / 400) < 1), 'an 800 ft vertex lands at the right pixel column');
});

test('GeoTIFF export refuses an unverified CRS before reading pixels', async () => {
  const { ds, reads } = orthoFixture();
  await assert.rejects(exportOrthoPrint({ ortho: ds, extent: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 }, format: 'tif', epsg: null, createCanvas: fakeCanvasFactory([]) }), { code: 'print_crs' });
  assert.equal(reads.length, 0);
});

// A small software canvas: rectangles, strokes and text boxes become real
// pixels, so what covers what can be checked without a browser.
function pixelCanvasFactory(log) {
  return () => {
    let data = null, path = [], state = { fillStyle: '#000000', strokeStyle: '#000000', font: '10px x', lineWidth: 1 };
    const stack = [], texts = [], canvas = { width: 0, height: 0 };
    const colour = style => {
      if (style.startsWith('#')) return [1, 3, 5].map(i => parseInt(style.slice(i, i + 2), 16)).concat(1);
      const [r, g, b, a = 1] = style.match(/[\d.]+/g).map(Number);
      return [r, g, b, a];
    };
    const dot = (x, y, [r, g, b, a]) => {
      if (!data || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
      const i = (y * canvas.width + x) * 4;
      [r, g, b].forEach((v, k) => { data[i + k] = Math.round(v * a + data[i + k] * (1 - a)); });
      data[i + 3] = Math.max(data[i + 3], Math.round(a * 255));
    };
    const ready = () => { data ||= new Uint8ClampedArray(canvas.width * canvas.height * 4); };
    const rect = (x, y, w, h, c) => { ready(); for (let yy = Math.round(y); yy < Math.round(y + h); yy++) for (let xx = Math.round(x); xx < Math.round(x + w); xx++) dot(xx, yy, c); };
    const px = () => Number(/([\d.]+)px/.exec(state.font)[1]);
    const width = text => text.length * px() * 0.55;
    const ctx = {
      save() { stack.push({ ...state }); }, restore() { state = stack.pop(); },
      measureText: text => ({ width: width(text) }),
      putImageData(image) { data = new Uint8ClampedArray(image.data); },
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      getImageData(x, y, w, h) { const out = new Uint8ClampedArray(w * h * 4); for (let r = 0; r < h; r++) out.set(data.subarray(((y + r) * canvas.width + x) * 4, ((y + r) * canvas.width + x + w) * 4), r * w * 4); return { data: out }; },
      fillRect(x, y, w, h) { rect(x, y, w, h, colour(state.fillStyle)); },
      fillText(text, x, y) { texts.push({ text, x, y, px: px(), width: width(text) }); rect(x, y - px() * 0.35, width(text), px() * 0.7, colour(state.fillStyle)); },
      beginPath() { path = []; }, moveTo(x, y) { path.push([x, y, true]); }, lineTo(x, y) { path.push([x, y, false]); }, rect(x, y, w, h) { path.box = [x, y, w, h]; },
      fill() { if (path.box) rect(...path.box, colour(state.fillStyle)); },
      stroke() {
        const half = state.lineWidth / 2, c = colour(state.strokeStyle);
        for (let i = 1; i < path.length; i++) {
          if (path[i][2]) continue;
          const [x0, y0] = path[i - 1], [x1, y1] = path[i], steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
          for (let s = 0; s <= steps; s++) rect(x0 + (x1 - x0) * s / steps - half, y0 + (y1 - y0) * s / steps - half, half * 2, half * 2, c);
        }
      },
    };
    for (const key of ['lineJoin', 'lineCap', 'textBaseline', 'textAlign']) ctx[key] = '';
    for (const key of Object.keys(state)) Object.defineProperty(ctx, key, { get: () => state[key], set: value => { state[key] = value; } });
    canvas.getContext = () => ctx;
    canvas.toBlob = cb => cb(new Blob(['png'], { type: 'image/png' }));
    log.push({ texts, ctx, pixel: (x, y) => { const i = (y * canvas.width + x) * 4; return Array.from(data.slice(i, i + 4)); } });
    return canvas;
  };
}
const FULL = { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 };
// A parcel running along the bottom edge, under where the note goes.
const PARCEL = [[[500050, 4700001], [500350, 4700001], [500350, 4700150], [500050, 4700150], [500050, 4700001]]];
const printWith = async (options = {}) => {
  const log = [], { ds } = orthoFixture();
  const result = await renderOrthoPrint({ ortho: ds, extent: FULL, longEdge: 2048, propertyLines: PARCEL, propertyAttribution: ATTRIBUTION, createCanvas: pixelCanvasFactory(log), ...options });
  return { result, ...log[0] };
};
const joined = texts => texts.map(t => t.text).join(' ');
const NOTE = `${PROPERTY_LINES_NOTE} ${ATTRIBUTION}`;

test('a PNG with property lines carries the "not a survey" note and the source: text and pixels', async () => {
  {
    const { result, texts, pixel } = await printWith();
    const note = texts.filter(t => t.y > result.height - 36);
    assert.equal(joined(note), NOTE);
    for (const line of note) assert.ok(line.x >= 0 && line.x + line.width <= result.width && line.y + line.px / 2 <= result.height, 'whole text inside the image');
    // The band is opaque, edge to edge, with dark text on it; the parcel line under it does not show through.
    const y = Math.round(note[0].y), x = Math.round(note[0].x + note[0].width / 2);
    assert.deepEqual(pixel(x, y), [27, 27, 27, 255], 'text ink');
    const bottom = result.height - 1, lineX = Math.round(200 / 400 * result.width);
    for (const at of [0, lineX, result.width - 1]) assert.deepEqual(pixel(at, bottom), [255, 255, 255, 255], `band at ${at}`);
    // The same lines are there above the band.
    assert.deepEqual(pixel(lineX, Math.round(50 / 200 * result.height)), [0xee, 0x50, 0x07, 255], 'line pixel');
    assert.equal(result.propertyLines, 1);
  }
});

test('the legend names the property lines and stays clear of the note', async () => {
  const { result, texts, pixel } = await printWith();
  const row = texts.find(t => t.text === 'Property lines');
  assert.ok(row, 'legend row');
  // The swatch beside it is the line colour.
  assert.deepEqual(pixel(Math.round(row.x - 20 * 1.28), Math.round(row.y)), [0xee, 0x50, 0x07, 255]);
  const others = texts.filter(t => t.y <= result.height - 36);
  assert.deepEqual(others.map(t => t.text).slice(0, 2), ['Property lines', 'Grid north up']);
  assert.ok(others.some(t => /ft$/.test(t.text)), 'scale bar');
  for (const other of others) assert.ok(other.y + other.px / 2 < result.height - 36, other.text);
  const tif = await printWith({ format: 'tif' });
  assert.equal(joined(tif.texts), '', 'a GeoTIFF still has no legend, and no note over its map pixels');
});

test('no property lines, no note: the rest of the image is unchanged', async () => {
  for (const propertyLines of [null, []]) {
    const { texts, result, pixel } = await printWith({ propertyLines });
    assert.doesNotMatch(joined(texts), /survey|Source|Property lines/);
    assert.notDeepEqual(pixel(result.width - 1, result.height - 1), [255, 255, 255, 255], 'imagery at the bottom edge');
  }
});

test('the note wraps on narrow prints, and an image too small for it is refused rather than printed without it', async () => {
  const narrow = await printWith({ extent: { ...FULL, minE: 500200, maxE: 500230 }, propertyLines: [[[500210, 4700010], [500220, 4700190]]] });
  const scale = 2048 / 1600, start = narrow.texts.findIndex(t => t.text.startsWith('Property lines are'));
  const lines = narrow.texts.slice(start);
  assert.ok(start > 0 && lines.length >= 2, `${lines.length} lines at ${narrow.result.width} px`);
  assert.equal(joined(lines), NOTE);
  for (const line of lines) assert.ok(line.x + line.width <= narrow.result.width && line.px >= 9 && line.y + line.px / 2 <= narrow.result.height, 'legible and inside');
  for (const other of narrow.texts.slice(0, start)) assert.ok(other.y < lines[0].y - 14 * scale, 'legend above the note');
  const { ds, reads } = orthoFixture();
  await assert.rejects(renderOrthoPrint({ ortho: ds, extent: FULL, longEdge: 120, propertyLines: PARCEL, propertyAttribution: ATTRIBUTION, createCanvas: pixelCanvasFactory([]) }), { code: 'print_note' });
  assert.equal(reads.length, 0, 'refused before reading pixels');
  await renderOrthoPrint({ ortho: ds, extent: FULL, longEdge: 120, createCanvas: pixelCanvasFactory([]) });
  // The sizes people print all take the note at legend size, even with a long credit.
  const ctx = pixelCanvasFactory([])().getContext(), credit = Array(4).fill(ATTRIBUTION).join(' ');
  for (const [width, height] of [[2048, 1024], [4096, 4096], [6144, 4608], [1280, 720], [720, 1280], [375, 812]]) {
    const size = Math.max(1, Math.min(4, Math.max(width, height) / 1600));
    const note = layoutPropertyNote(ctx, { width, maxHeight: height * 0.4, scale: size, attribution: credit });
    assert.equal(note.font.split('px')[0], `600 ${12 * size}`, `${width} x ${height}`);
    assert.equal(note.lines.join(' '), `${PROPERTY_LINES_NOTE} ${credit}`);
  }
});

test('export refuses property lines whose source is not known', async () => {
  for (const format of ['png', 'tif']) {
    const { ds, reads } = orthoFixture();
    await assert.rejects(exportOrthoPrint({ ortho: ds, extent: FULL, longEdge: 400, format, epsg: 32616, propertyLines: PARCEL, createCanvas: fakeCanvasFactory([]) }), { code: 'print_note' });
    assert.equal(reads.length, 0);
  }
});

test('blank attribution is no attribution: whitespace and invisible characters do not satisfy the source requirement', async () => {
  for (const blank of ['   ', '\n\t', '\u00a0\u2003', '\u200b\ufeff', ' . ', null, 42]) {
    const { ds, reads } = orthoFixture();
    await assert.rejects(exportOrthoPrint({ ortho: ds, extent: FULL, longEdge: 400, propertyLines: PARCEL, propertyAttribution: blank, createCanvas: pixelCanvasFactory([]) }), { code: 'print_note' }, JSON.stringify(blank));
    assert.equal(reads.length, 0);
  }
  for (const name of ['   ', '\u200b', '', null]) assert.equal(propertyLinesSourceText({ name, release: 'R1' }), '', JSON.stringify(name));
  assert.equal(propertyLinesSourceText({ name: '  Synthetic \n Parcel Map ', release: ' ' }), 'Source: Synthetic Parcel Map.');
  const log = [], { ds } = orthoFixture();
  await exportOrthoPrint({ ortho: ds, extent: FULL, longEdge: 2048, propertyLines: PARCEL, propertyAttribution: `  ${ATTRIBUTION.replace(/ /g, '  ')}\n`, createCanvas: pixelCanvasFactory(log) });
  assert.ok(joined(log[0].texts).endsWith(NOTE));
});

async function readTif(blob) {
  const image = await (await fromArrayBuffer(await blob.arrayBuffer())).getImage();
  const tag = name => image.getFileDirectory().getValue(name);
  return { image, width: image.getWidth(), height: image.getHeight(), rgba: Array.from(await image.readRasters({ interleave: true })),
    tiepoint: Array.from(tag('ModelTiepoint')), scale: Array.from(tag('ModelPixelScale')), geoKeys: Array.from(tag('GeoKeyDirectory')),
    description: tag('ImageDescription') };
}
const exportTif = async (options = {}) => {
  const log = [], { ds } = orthoFixture();
  const out = await exportOrthoPrint({ ortho: ds, extent: FULL, longEdge: 800, format: 'tif', epsg: 32616, propertyLines: PARCEL, propertyAttribution: ATTRIBUTION, createCanvas: pixelCanvasFactory(log), ...options });
  return { log, ...(await readTif(out.blob)) };
};

test('GeoTIFF with property lines: every map pixel and the georeference are untouched; the note is extra rows below and the description tag', async () => {
  // The same picture without any note: what the map pixels must be.
  const { result, pixel } = await printWith({ format: 'tif', longEdge: 800 });
  const out = await exportTif();
  assert.deepEqual([out.width, result.width, result.height], [800, 800, 400]);
  assert.ok(out.height > 400, `${out.height} rows`);
  const map = [];
  for (let y = 0; y < 400; y++) for (let x = 0; x < 800; x++) map.push(...pixel(x, y));
  assert.deepEqual(out.rgba.slice(0, 800 * 400 * 4), map, 'every original row, byte for byte');
  assert.equal(out.rgba[(395 * 800 + 5) * 4 + 3], 0, 'nodata at the bottom of the map is still transparent');
  const lineAt = (Math.round(400 - 1 / 0.5) * 800 + 400) * 4;
  assert.deepEqual(out.rgba.slice(lineAt, lineAt + 3), [0xee, 0x50, 0x07], 'the parcel line along the bottom edge is not covered');
  // The extra rows: opaque white with the text, nothing else.
  const rows = out.rgba.slice(800 * 400 * 4);
  assert.ok(rows.every((v, i) => i % 4 !== 3 || v === 255), 'opaque');
  assert.ok(rows.some((v, i) => i % 4 === 0 && v === 27), 'text ink');
  assert.deepEqual(rows.slice(-4), [255, 255, 255, 255]);
  assert.equal(joined(out.log[1].texts), NOTE);
  assert.equal(out.log[0].texts.length, 0, 'nothing written on the map canvas');
  // Same corner, same pixel size: the map footprint is where it was, and the rows lie below it.
  const plain = await exportTif({ propertyLines: null });
  assert.deepEqual([out.tiepoint, out.scale, out.geoKeys], [plain.tiepoint, plain.scale, plain.geoKeys]);
  assert.deepEqual(out.tiepoint, [0, 0, 0, 500000, 4700200, 0]);
  assert.deepEqual(out.scale.slice(0, 2), [0.5, 0.5]);
  assert.deepEqual(out.image.getBoundingBox(), [500000, 4700200 - out.height * 0.5, 500400, 4700200]);
  assert.equal(String(out.description).replace(/\0+$/, ''), NOTE);
});

test('a plain GeoTIFF is unchanged: no extra rows, no description', async () => {
  const { result, pixel } = await printWith({ format: 'tif', longEdge: 800, propertyLines: null });
  const rgba = new Uint8ClampedArray(800 * 400 * 4);
  for (let y = 0; y < 400; y++) for (let x = 0; x < 800; x++) rgba.set(pixel(x, y), (y * 800 + x) * 4);
  const { ds } = orthoFixture();
  const out = await exportOrthoPrint({ ortho: ds, extent: FULL, longEdge: 800, format: 'tif', epsg: 32616, createCanvas: pixelCanvasFactory([]) });
  const bytes = Buffer.from(await out.blob.arrayBuffer());
  assert.ok(bytes.equals(Buffer.from(encodePrintGeoTiff({ rgba, width: result.width, height: result.height, extent: FULL, epsg: 32616 }))), 'byte for byte');
  const tif = await readTif(out.blob);
  assert.deepEqual([tif.width, tif.height, tif.description], [800, 400, undefined]);
  assert.deepEqual(tif.image.getBoundingBox(), [500000, 4700000, 500400, 4700200]);
});

test('GeoTIFF note: a small map still gets its rows, plain characters go in the tag, and a blocked note canvas stops the export', async () => {
  const small = await exportTif({ longEdge: 120, propertyAttribution: 'Source: State Cartographer’s Parcel Map – R1.' });
  assert.equal(String(small.description).replace(/\0+$/, ''), `${PROPERTY_LINES_NOTE} Source: State Cartographer's Parcel Map - R1.`);
  assert.ok(small.height > 60);
  let made = 0;
  const factory = pixelCanvasFactory([]);
  await assert.rejects(exportTif({ createCanvas: () => (++made === 1 ? factory() : { width: 0, height: 0, getContext: () => null }) }), { code: 'print_too_large' });
});

test('the Viewer prints the same source as its on-screen notice, taken with the lines', () => {
  assert.equal(propertyLinesSourceText({ name: 'Synthetic Parcel Map', release: 'R1' }), 'Source: Synthetic Parcel Map R1.');
  assert.equal(propertyLinesSourceText(null), '');
  const layer = readFileSync(new URL('../property-lines-layer.mjs', import.meta.url), 'utf8'), main = readFileSync(new URL('../main.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(layer.includes('`' + PROPERTY_LINES_NOTE + ' ${propertyLinesSourceText(source)}`'), 'one wording on screen and in print');
  assert.match(main, /function propertyLinesForPrint\(\)[\s\S]*?return \{ lines, color: [^\n]*attribution: propertyLines\.attribution\(\) \};\n\}/);
  assert.match(main, /propertyAttribution: drawnLines\.attribution \|\| ''/);
});
