import test from 'node:test';
import assert from 'node:assert/strict';
import { fromArrayBuffer } from 'geotiff';
import { buildContours, contourLevels, CONTOUR_COLORS, METERS_PER_FOOT } from '../contours.mjs';
import { assertOrthoPrintAllowed, canvasWorks, clampExtent, encodePrintGeoTiff, exportOrthoPrint, orthoPrintPolicy, pickOrthoLevel, printLayout, renderOrthoPixels, renderOrthoPrint, supportedPrintSizes } from '../ortho-print-export.mjs';

// Synthetic orthophoto: 400 x 200 m at 0.5 m (level 0) and 1 m (level 1).
// Red encodes the column, green the row; a 4th band is alpha with a hole.
function orthoFixture() {
  const reads = [];
  const makeImage = (w, h) => ({
    getWidth: () => w, getHeight: () => h,
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
    propertyLines: [[[500050, 4700050], [500350, 4700050], [500350, 4700150], [500050, 4700050]]],
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
  assert.ok(ops.some(o => o[0] === 'set' && o[1] === 'strokeStyle' && o[2] === '#FFD60A'), 'property lines drawn');
  const tif = await exportOrthoPrint({
    ortho: ds, extent: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 }, longEdge: 400, format: 'tif', epsg: 32616,
    traceContours, units: 'imperial', createCanvas: fakeCanvasFactory([]), propertyLines: [[[500050, 4700050], [500350, 4700050]]], propertyStyle: { color: '#F97316' },
  });
  assert.equal(tif.filename, 'orthophoto-contours-400px.tif');
  const geo = await (await fromArrayBuffer(await tif.blob.arrayBuffer())).getImage();
  assert.deepEqual(geo.getBoundingBox(), [500000, 4700000, 500400, 4700200]);
  // Index line at 800 ft is 100 m east of the west edge: x = 100 / gsd.
  const moves = ops.filter(o => o[0] === 'moveTo' || o[0] === 'lineTo').map(o => o[1]);
  assert.ok(moves.some(x => Math.abs(x - 100 * 2048 / 400) < 1), 'an 800 ft vertex lands at the right pixel column');
});

test('GeoTIFF export refuses an unverified CRS before reading pixels', async () => {
  const { ds, reads } = orthoFixture();
  await assert.rejects(exportOrthoPrint({ ortho: ds, extent: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 }, format: 'tif', epsg: null, createCanvas: fakeCanvasFactory([]) }), { code: 'print_crs' });
  assert.equal(reads.length, 0);
});
