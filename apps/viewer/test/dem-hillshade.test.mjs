import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\nfunction ', start + 1));
}
function runtime() {
  const context = {
    demSettings: { shade: 1, minFt: 0, maxFt: 200, cmap: 'white', steps: 0 },
    COLORMAPS: { white: [[0, 255, 255, 255], [1, 255, 255, 255]] },
    elevationInputMeters: v => v,
    latLonToUtm: (lat, lon) => [lon, lat],
    document: { createElement: () => ({ getContext() { return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: image => { this.pixels = image.data; },
    }; } }) },
  };
  vm.createContext(context);
  vm.runInContext(['hillshadeFactor', 'sampleCmap', 'warpedSampleGrid', 'renderDemTile'].map(extract).join('\n'), context);
  return context;
}
function plane(cellX, cellY, east = 0.6, south = 0.3) {
  return Float64Array.from({ length: 25 }, (_, i) => 100 + (i % 5 - 2) * cellX * east + (Math.floor(i / 5) - 2) * cellY * south);
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('physical slope shading is stable across centimetre pixels, overview levels and rectangular cells', () => {
  const { hillshadeFactor } = runtime();
  const expected = hillshadeFactor(plane(1, 1), 5, 5, 2, 2, 1, 1);
  for (const [dx, dy] of [[0.01, 0.01], [0.04, 0.04], [0.5, 1.3], [4, 8]]) {
    close(hillshadeFactor(plane(dx, dy), 5, 5, 2, 2, dx, dy), expected);
  }
  // The old one-metre assumption suppresses relief at centimetre resolution.
  assert.ok(Math.abs(hillshadeFactor(plane(0.01, 0.01), 5, 5, 2, 2, 1, 1) - expected) > 0.04);
});

test('north-west light illuminates slopes facing north and west, not their opposites', () => {
  const { hillshadeFactor } = runtime();
  const factor = (east, south) => hillshadeFactor(plane(0.1, 0.1, east, south), 5, 5, 2, 2, 0.1, 0.1);
  assert.ok(factor(1, 0) > factor(-1, 0), 'west-facing slope');
  assert.ok(factor(0, 1) > factor(0, -1), 'north-facing slope');
  close(factor(1, 0), factor(0, 1));
});

test('no-data neighbors do not create black cliffs or mutate the source elevation band', () => {
  const { hillshadeFactor } = runtime();
  const flat = new Float64Array(25).fill(100);
  const expected = hillshadeFactor(flat, 5, 5, 2, 2, 0.01, 0.01);
  for (const noData of [-9999, 32767, NaN, Infinity]) {
    const band = flat.slice(); band[6] = noData; band[8] = noData;
    const before = band.slice();
    close(hillshadeFactor(band, 5, 5, 2, 2, 0.01, 0.01, noData), expected);
    assert.deepEqual(band, before);
  }
  assert.equal(hillshadeFactor(flat, 5, 5, 0, 0, 0.01, 0.01), 1);
  assert.equal(hillshadeFactor(flat, 5, 5, 2, 2, 0, NaN), 1);
});

test('shading intensity remains optional and bounded without changing elevation values', () => {
  const context = runtime(), band = plane(0.01, 0.01), before = band.slice();
  context.demSettings.shade = 0;
  assert.equal(context.hillshadeFactor(band, 5, 5, 2, 2, 0.01, 0.01), 1);
  for (const shade of [0.5, 1, 2]) {
    context.demSettings.shade = shade;
    const factor = context.hillshadeFactor(band, 5, 5, 2, 2, 0.01, 0.01);
    assert.ok(factor >= 0.1 && factor <= 1);
  }
  assert.deepEqual(band, before);
});

test('both actual raster renderers pass physical spacing, including overview and cropped detail windows', () => {
  const context = runtime();
  for (const [dx, dy] of [[0.01, 0.02], [1, 2]]) {
    const band = plane(dx, dy), raster = [band];
    const ds = { isDem: true, nodata: -9999, min: 0, max: 200, minE: 0, maxE: 5 * dx, minN: 0, maxN: 5 * dy };
    const expected = Math.round(255 * context.hillshadeFactor(band, 5, 5, 2, 2, dx, dy, -9999));
    const fallback = context.renderDemTile(raster, 5, 5, ds);
    assert.equal(fallback.pixels[12 * 4], expected);
    // A tile window can have a different extent from the complete dataset.
    ds.maxE = 1000; ds.maxN = 2000;
    const warped = context.warpedSampleGrid(raster, 5, 5, 0, 5 * dx, 5 * dy, 0, [2.5 * dy], [2.5 * dx], 1, 1, ds);
    assert.equal(warped.pixels[0], expected);
    assert.equal(warped.pixels[3], 255);
  }
});

test('adjacent padded source windows produce identical relief at a shared source pixel', () => {
  const { hillshadeFactor } = runtime();
  const dx = 0.02, dy = 0.07;
  const whole = Float64Array.from({ length: 81 }, (_, i) => 100 + Math.sin(i % 9 * 0.5) + Math.cos(Math.floor(i / 9) * 0.25));
  const crop = (left, top) => Float64Array.from({ length: 25 }, (_, i) => whole[(top + Math.floor(i / 5)) * 9 + left + i % 5]);
  close(hillshadeFactor(crop(1, 1), 5, 5, 3, 2, dx, dy), hillshadeFactor(crop(3, 1), 5, 5, 1, 2, dx, dy));
});

test('actual tile reader uses each overview axis spacing when overview dimensions round differently', async () => {
  let readWindow, renderedWarp;
  const image = (width, height) => ({
    getWidth: () => width, getHeight: () => height,
    readRasters: async ({ window }) => {
      readWindow = window;
      const raster = [new Float32Array((window[2] - window[0]) * (window[3] - window[1])).fill(100)];
      raster.width = window[2] - window[0]; raster.height = window[3] - window[1];
      return raster;
    },
  });
  const context = {
    L: { GridLayer: { extend: definition => definition } },
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) },
    latLonToUtm: (lat, lon) => [lon, lat], geoPool: null, setTimeout,
  };
  vm.createContext(context);
  const start = source.indexOf('const GeoTiffGridLayer =');
  vm.runInContext(source.slice(start, source.indexOf('\n// Per-pixel inverse-warp sampler', start)) + '\nglobalThis.createTile = GeoTiffGridLayer.createTile;', context);
  const ds = { isDem: true, W: 1000, H: 997, minE: 0, maxE: 1000, minN: 0, maxN: 997, nodata: -9999, images: [image(1000, 997), image(500, 499)] };
  await new Promise((resolve, reject) => context.createTile.call({
    ds, getTileSize: () => ({ x: 256, y: 256 }),
    _map: { unproject: ([x, y]) => ({ lat: 800 - y * 2, lng: 100 + x * 2 }) },
    renderFn: (_raster, _w, _h, _ds, warp) => { renderedWarp = warp; return {}; },
  }, { x: 0, y: 0, z: 0 }, error => error ? reject(error) : resolve()));
  close(renderedWarp.winMinE, readWindow[0] * 2);
  close(renderedWarp.winMaxE, readWindow[2] * 2);
  close(renderedWarp.winMaxN, 997 - readWindow[1] * (997 / 499));
  close(renderedWarp.winMinN, 997 - readWindow[3] * (997 / 499));
});
