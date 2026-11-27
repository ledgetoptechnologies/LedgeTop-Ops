import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { fromArrayBuffer } from 'geotiff';
import { createBlobSink, crc32, exportGrid, ringsExtent, streamOrthoExport, stripRows } from '../ortho-export-stream.mjs';
import { parcelAt, pointInParcel } from '../ortho-export-parcels.mjs';
import { exportFileName } from '../ortho-export-dialog.mjs';

// 300 x 200 m orthophoto at 0.1 m (level 0) and 0.2 m. Red = column, green = row (mod 256);
// alpha 0 in the first 10 columns. Reads are logged to show strips stay bounded.
function ortho() {
  const reads = [];
  const image = (w, h) => ({
    getWidth: () => w, getHeight: () => h,
    async readRasters({ window: [x0, y0, x1, y1] }) {
      reads.push({ w, rows: y1 - y0, cols: x1 - x0 });
      const ww = x1 - x0, wh = y1 - y0, bands = [0, 1, 2, 3].map(() => new Uint8Array(ww * wh));
      for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
        const i = y * ww + x; bands[0][i] = (x0 + x) % 256; bands[1][i] = (y0 + y) % 256; bands[2][i] = 40; bands[3][i] = x0 + x < 10 ? 0 : 255;
      }
      return bands;
    },
  });
  return { reads, ds: { minE: 500000, maxE: 500300, minN: 4700000, maxN: 4700200, nodata: NaN, images: [image(3000, 2000), image(1500, 1000)] } };
}

function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8, width = 0, height = 0; const idat = [];
  while (at < bytes.length) {
    const length = view.getUint32(at), type = String.fromCharCode(...bytes.subarray(at + 4, at + 8)), data = bytes.subarray(at + 8, at + 8 + length);
    assert.equal(view.getUint32(at + 8 + length), (crc32(bytes.subarray(at + 4, at + 8 + length)) ^ 0xffffffff) >>> 0, `${type} CRC`);
    if (type === 'IHDR') { width = view.getUint32(at + 8); height = view.getUint32(at + 12); assert.equal(data[9], 2, 'RGB'); }
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * 3 + 1, rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * stride], 1, 'Sub filter');
    for (let x = 0; x < width * 3; x++) rgb[y * width * 3 + x] = (raw[y * stride + 1 + x] + (x >= 3 ? rgb[y * width * 3 + x - 3] : 0)) & 255;
  }
  return { width, height, rgb };
}

test('native grid: the orthophoto\'s own pixels, snapped to its grid and clamped to it', () => {
  const { ds } = ortho();
  const grid = exportGrid(ds, { minE: 500010.04, maxE: 500100, minN: 4700050, maxN: 4700150.01 });
  assert.equal(grid.native, true);
  assert.deepEqual([grid.x0, grid.y0, grid.width, grid.height], [100, 499, 900, 1001]);
  assert.ok(Math.abs(grid.extent.minE - 500010) < 1e-6 && Math.abs(grid.extent.maxN - 4700150.1) < 1e-6);
  assert.deepEqual(exportGrid(ds, { minE: 499000, maxE: 501000, minN: 4699000, maxN: 4701000 }).width, 3000, 'clamped to the orthophoto');
  assert.equal(exportGrid(ds, { minE: 0, maxE: 1, minN: 0, maxN: 1 }), null);
  assert.equal(exportGrid(ds, { minE: 500000, maxE: 500300, minN: 4700000, maxN: 4700200 }, { longEdge: 720 }).width, 720, 'capped plans resample');
});

test('streamed PNG is the exact full-resolution orthophoto in bounded strips; nodata turns white', async () => {
  const { ds, reads } = ortho();
  const grid = exportGrid(ds, { minE: 500000, maxE: 500300, minN: 4700000, maxN: 4700200 });
  const fractions = [];
  const png = await streamOrthoExport({ ds, grid, format: 'png', layers: {}, sink: createBlobSink({ type: 'image/png' }),
    createCanvas: fakeCanvas, onProgress: f => fractions.push(f) });
  const { width, height, rgb } = decodePng(new Uint8Array(await png.arrayBuffer()));
  assert.deepEqual([width, height], [3000, 2000]);
  const px = (x, y) => [...rgb.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
  assert.deepEqual(px(1234, 567), [1234 % 256, 567 % 256, 40]);
  assert.deepEqual(px(5, 5), [255, 255, 255], 'nodata is white');
  assert.ok(reads.every(r => r.w === 3000 && r.rows <= stripRows(3000)), 'level 0 only, one strip at a time');
  assert.equal(fractions.at(-1), 1);
});

test('streamed GeoTIFF round-trips: deflate strips, alpha kept, georeferenced in the given EPSG', async () => {
  const { ds } = ortho();
  const grid = exportGrid(ds, { minE: 500000.5, maxE: 500100, minN: 4700120, maxN: 4700200 });
  const blob = await streamOrthoExport({ ds, grid, format: 'tif', epsg: 32616, layers: {}, sink: createBlobSink({ type: 'image/tiff' }), createCanvas: fakeCanvas });
  const tiff = await fromArrayBuffer(await blob.arrayBuffer()), image = await tiff.getImage();
  assert.deepEqual([image.getWidth(), image.getHeight()], [grid.width, grid.height]);
  assert.equal(image.getGeoKeys().ProjectedCSTypeGeoKey, 32616);
  assert.deepEqual(image.getBoundingBox().map(v => +v.toFixed(3)), [500000.5, 4700120, 500100, 4700200]);
  const [r, g, , a] = await image.readRasters({ window: [100, 300, 101, 301] });
  assert.deepEqual([r[0], g[0], a[0]], [(grid.x0 + 100) % 256, (grid.y0 + 300) % 256, 255]);
  const [, , , edge] = await image.readRasters({ window: [2, 0, 3, 1] });
  assert.equal(edge[0], 0, 'nodata stays transparent');
});

test('a sink that refuses a write fails the export instead of hanging, and the file is discarded', async () => {
  const { ds } = ortho();
  for (const format of ['png', 'tif']) {
    let writes = 0, aborted = 0, closed = 0;
    const sink = { async write() { if (++writes === 3) throw new Error('disk full'); }, async writeHeader() {}, async close() { closed++; }, abort() { aborted++; } };
    const outcome = await Promise.race([
      streamOrthoExport({ ds, grid: exportGrid(ds, ds), format, epsg: 32616, layers: {}, sink, createCanvas: fakeCanvas }).then(() => 'finished', e => e.message),
      new Promise(resolve => setTimeout(() => resolve('hung'), 5000).unref()),
    ]);
    assert.equal(outcome, 'disk full', format);
    assert.ok(aborted >= 1 && closed === 0, `${format}: discarded, never committed`);
  }
});

test('the last check runs before the file is committed', async () => {
  const { ds } = ortho();
  let closed = 0;
  const sink = { ...createBlobSink(), async close() { closed++; } };
  await assert.rejects(streamOrthoExport({ ds, grid: exportGrid(ds, { minE: 500000, maxE: 500010, minN: 4700000, maxN: 4700010 }), format: 'png', layers: {}, sink, createCanvas: fakeCanvas,
    beforeClose: () => { throw new DOMException('Export cancelled.', 'AbortError'); } }), { name: 'AbortError' });
  assert.equal(closed, 0);
});

test('GeoTIFF needs a verified CRS', async () => {
  const { ds } = ortho();
  await assert.rejects(streamOrthoExport({ ds, grid: exportGrid(ds, ds), format: 'tif', epsg: null, sink: createBlobSink() }), { code: 'print_crs' });
});

test('parcel picking: even-odd rings (holes excluded), smallest parcel wins, extent of the selection', () => {
  const square = (x0, y0, s) => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s], [x0, y0]];
  const outer = { key: 'a', rings: [square(0, 0, 10), square(4, 4, 2)] }, inner = { key: 'b', rings: [square(1, 1, 2)] };
  assert.equal(pointInParcel(5, 5, outer.rings), false, 'inside the hole');
  assert.equal(pointInParcel(8, 8, outer.rings), true);
  assert.equal(parcelAt([outer, inner], 1.5, 1.5).key, 'b');
  assert.equal(parcelAt([outer, inner], 8, 8).key, 'a');
  assert.equal(parcelAt([outer, inner], 20, 20), null);
  assert.deepEqual(ringsExtent([...outer.rings, square(20, -5, 1)]), { minE: 0, minN: -5, maxE: 21, maxN: 10 });
});

test('file names say what was exported', () => {
  assert.equal(exportFileName({ area: 'full', format: 'png' }), 'orthophoto.png');
  assert.equal(exportFileName({ area: 'parcels', format: 'tif', contours: true }), 'orthophoto-parcels-contours.tif');
  assert.equal(exportFileName({ area: 'view', format: 'png' }), 'orthophoto-view.png');
});

// Minimal 2D canvas: pixels pass through; drawing calls are no-ops.
function fakeCanvas() {
  let data = null;
  const canvas = { width: 0, height: 0 };
  const ctx = new Proxy({
    canvas,
    putImageData(image) { data = image.data; },
    getImageData: () => ({ data }),
    measureText: text => ({ width: text.length * 7 }),
  }, { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true });
  canvas.getContext = () => ctx;
  return canvas;
}
globalThis.ImageData ||= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
