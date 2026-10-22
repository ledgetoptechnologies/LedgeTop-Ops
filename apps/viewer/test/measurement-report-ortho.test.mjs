import test from 'node:test';
import assert from 'node:assert/strict';
import { captureMeasurementReportOrtho } from '../measurement-report-ortho.mjs';

function fixture() {
  const reads = [], paths = [];
  const makeImage = (width, height) => ({
    getWidth: () => width, getHeight: () => height,
    getFileDirectory: () => ({ SamplesPerPixel: 3, BitsPerSample: [8, 8, 8], PhotometricInterpretation: 2 }),
    getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616 }),
    getResolution: () => [1, -1, 0], getBoundingBox: () => [100, 200, 300, 300],
    async readRasters(options) { reads.push({ width, height, options }); return [20, 40, 60].map(value => new Uint8Array(options.width * options.height).fill(value)); },
  });
  const ctx = { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData(image) { this.image = image; }, beginPath() {}, moveTo(...p) { paths.push(p); }, lineTo(...p) { paths.push(p); }, closePath() { paths.push('close'); }, arc() {}, stroke() {} };
  const canvas = { getContext: () => ctx, toDataURL: () => 'data:image/png;base64,fixture' };
  return { reads, paths, ctx, canvas, makeImage, args: { dataset: { images: [makeImage(20000, 10000), makeImage(2000, 1000)], nodata: NaN }, expectedCrs: 'EPSG:32616', maxDimension: 200, createCanvas: () => canvas, records: [{ kind: 'polygon', coordinateReference: { crs: 'EPSG:32616' }, vertices: [[100, 300, 0], [300, 300, 0], [100, 200, 0]] }] } };
}

test('offscreen capture bounds output and source decode and aligns outlines in projected coordinates', async () => {
  const f = fixture(), result = await captureMeasurementReportOrtho(f.args);
  assert.equal(result.dataUrl, 'data:image/png;base64,fixture');
  assert.deepEqual([result.width, result.height], [200, 100]);
  assert.equal(f.reads.length, 1); assert.equal(f.reads[0].width, 2000);
  assert.deepEqual([f.reads[0].options.width, f.reads[0].options.height], [200, 100]);
  assert.deepEqual(f.paths, [[0, 0], [200, 0], [0, 100], 'close']);
  assert.deepEqual(Array.from(f.ctx.image.data.slice(0, 4)), [20, 40, 60, 255]);
  assert.match(result.caption, /grid north up/);
});

test('large native raster without safe overview is not decoded', async () => {
  const f = fixture(); f.args.dataset.images.pop();
  const result = await captureMeasurementReportOrtho(f.args);
  assert.equal(result.dataUrl, null); assert.match(result.warnings[0], /memory limit/); assert.equal(f.reads.length, 0);
});

test('CRS mismatch and rotated raster are omitted before reading pixels', async () => {
  const f = fixture(); f.args.expectedCrs = 'EPSG:32617';
  assert.equal((await captureMeasurementReportOrtho(f.args)).dataUrl, null);
  f.args.expectedCrs = 'EPSG:32616'; f.args.dataset.images[0].getResolution = () => [1, 1, 0];
  assert.match((await captureMeasurementReportOrtho(f.args)).warnings[0], /orientation/);
  assert.equal(f.reads.length, 0);
});

test('unverified measurement outlines are skipped with a warning', async () => {
  const f = fixture(); f.args.records[0].coordinateReference.crs = 'LOCAL:unverified';
  const result = await captureMeasurementReportOrtho(f.args);
  assert.ok(result.dataUrl); assert.deepEqual(f.paths, []); assert.match(result.warnings[0], /1 measurement outline/);
});

test('abort before and during raster read cannot produce a late image', async () => {
  const f = fixture(), controller = new AbortController(); f.args.signal = controller.signal;
  f.args.dataset.images[1].readRasters = async options => { assert.equal(options.signal, controller.signal); controller.abort(); return []; };
  await assert.rejects(captureMeasurementReportOrtho(f.args), { name: 'AbortError' });
  await assert.rejects(captureMeasurementReportOrtho(f.args), { name: 'AbortError' });
});

test('nodata is transparent and failed reads do not expose source details', async () => {
  const f = fixture(); f.args.dataset.nodata = 20;
  f.args.dataset.images[1].readRasters = async options => [0, 1, 2].map(() => new Uint8Array(options.width * options.height).fill(20));
  await captureMeasurementReportOrtho(f.args); assert.equal(f.ctx.image.data[3], 0);
  f.args.dataset.images[1].readRasters = async () => { throw new Error('https://private.example/signed-secret'); };
  const result = await captureMeasurementReportOrtho(f.args);
  assert.equal(result.dataUrl, null); assert.doesNotMatch(result.warnings.join(''), /private|secret/);
});
