import test from 'node:test';
import assert from 'node:assert/strict';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';
import { buildContours, contourLevels, CONTOUR_COLORS, METERS_PER_FOOT } from '../contours.mjs';
import { clampExtent, encodePrintGeoTiff, exportOrthoPrint, pickOrthoLevel, printLayout, renderOrthoPixels } from '../ortho-print-export.mjs';

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
  const buffer = encodePrintGeoTiff({ rgba, width, height, extent, epsg: 32616, writeArrayBuffer });
  const tiff = await fromArrayBuffer(buffer), image = await tiff.getImage();
  assert.deepEqual([image.getWidth(), image.getHeight(), image.getSamplesPerPixel()], [8, 4, 4]);
  assert.deepEqual(image.getBoundingBox(), [500000, 4700000, 500016, 4700008]);
  assert.equal(image.getGeoKeys().ProjectedCSTypeGeoKey, 32616);
  const bands = await image.readRasters({ interleave: true });
  assert.deepEqual(Array.from(bands.slice(4 * 9, 4 * 9 + 4)), [9, 18, 27, 255]);
  assert.throws(() => encodePrintGeoTiff({ rgba, width, height, extent, epsg: null, writeArrayBuffer }), { code: 'print_crs' });
});

function fakeCanvasFactory(log) {
  return (w, h) => {
    const ops = [];
    const ctx = new Proxy({
      createImageData: (iw, ih) => ({ data: new Uint8ClampedArray(iw * ih * 4), width: iw, height: ih }),
      putImageData(image) { this.image = image; },
      getImageData() { return { data: this.image.data }; },
      measureText: t => ({ width: t.length * 7 }),
    }, {
      get(target, key) { if (key in target) return target[key]; return (...args) => ops.push([key, ...args]); },
      set(target, key, value) { if (key === 'image') target.image = value; else ops.push(['set', key, value]); return true; },
    });
    const canvas = { width: w, height: h, getContext: () => ctx, toBlob: cb => cb(new Blob(['png'], { type: 'image/png' })) };
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
  // Index line at 800 ft is 100 m east of the west edge: x = 100 / gsd.
  const moves = ops.filter(o => o[0] === 'moveTo' || o[0] === 'lineTo').map(o => o[1]);
  assert.ok(moves.some(x => Math.abs(x - 100 * 2048 / 400) < 1), 'an 800 ft vertex lands at the right pixel column');
});

test('GeoTIFF export refuses an unverified CRS before reading pixels', async () => {
  const { ds, reads } = orthoFixture();
  await assert.rejects(exportOrthoPrint({ ortho: ds, extent: { minE: 500000, maxE: 500400, minN: 4700000, maxN: 4700200 }, format: 'tif', epsg: null, writeArrayBuffer, createCanvas: fakeCanvasFactory([]) }), { code: 'print_crs' });
  assert.equal(reads.length, 0);
});
