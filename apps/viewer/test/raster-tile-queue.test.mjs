import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRasterTileQueue } from '../raster-tile-queue.mjs';
import { selectRasterDetailImage } from '../raster-detail.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('limits active reads and skips removed queued tiles without starving later work', async () => {
  const queue = createRasterTileQueue({ concurrency: 2 });
  const blockers = [deferred(), deferred()];
  const a = queue.enqueue(() => blockers[0].promise);
  const b = queue.enqueue(() => blockers[1].promise);
  let obsoleteRuns = 0;
  const obsolete = queue.enqueue(() => obsoleteRuns++);
  const rejected = assert.rejects(obsolete.promise, { name: 'AbortError' });
  const next = queue.enqueue(() => 'current');
  await tick();
  assert.deepEqual(queue.snapshot(), { active: 2, pending: 2 });
  obsolete.cancel();
  blockers[0].resolve('first');
  assert.equal(await next.promise, 'current');
  assert.equal(obsoleteRuns, 0);
  blockers[1].resolve('second');
  await Promise.all([a.promise, b.promise, rejected]);
  await tick();
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0 });
});

test('active cancellation waits for shared work and does not exceed concurrency', async () => {
  const queue = createRasterTileQueue({ concurrency: 1 });
  const block = deferred();
  let cancelledAtCompletion = false;
  const active = queue.enqueue(async isCancelled => {
    await block.promise;
    cancelledAtCompletion = isCancelled();
  });
  const rejected = assert.rejects(active.promise, { name: 'AbortError' });
  const next = queue.enqueue(() => 'next');
  await tick();
  active.cancel();
  assert.deepEqual(queue.snapshot(), { active: 1, pending: 1 });
  block.resolve();
  await rejected;
  assert.equal(await next.promise, 'next');
  assert.equal(cancelledAtCompletion, true);
});

test('mode abort drops pending work and a failed read releases its slot', async () => {
  const queue = createRasterTileQueue({ concurrency: 1 });
  const block = deferred(), controller = new AbortController();
  const first = queue.enqueue(() => block.promise);
  const failure = assert.rejects(first.promise, /read failed/);
  const pending = queue.enqueue(() => assert.fail('stale mode ran'), { signal: controller.signal });
  const cancelled = assert.rejects(pending.promise, { name: 'AbortError' });
  await tick();
  controller.abort();
  block.reject(new Error('read failed'));
  await Promise.all([failure, cancelled]);
  assert.equal(await queue.enqueue(() => 'new mode').promise, 'new mode');
});

test('already aborted and immediately cancelled jobs never start', async () => {
  const queue = createRasterTileQueue();
  const controller = new AbortController();
  controller.abort();
  const aborted = queue.enqueue(() => assert.fail('aborted job ran'), { signal: controller.signal });
  const cancelled = queue.enqueue(() => assert.fail('cancelled job ran'));
  cancelled.cancel();
  await Promise.all([
    assert.rejects(aborted.promise, { name: 'AbortError' }),
    assert.rejects(cancelled.promise, { name: 'AbortError' }),
  ]);
  assert.deepEqual(queue.snapshot(), { active: 0, pending: 0 });
});

test('panning reprioritizes queued reads using the latest view without adding active reads', async () => {
  const queue = createRasterTileQueue({ concurrency: 1 }), block = deferred(), order = [];
  const active = queue.enqueue(() => block.promise);
  await tick();
  let oldDistance = 1, newDistance = 100;
  const oldView = queue.enqueue(() => order.push('old'), { priority: () => oldDistance });
  const newView = queue.enqueue(() => order.push('new'), { priority: () => newDistance });
  oldDistance = 100;
  newDistance = 1;
  assert.deepEqual(queue.snapshot(), { active: 1, pending: 2 });
  block.resolve();
  await Promise.all([active.promise, oldView.promise, newView.promise]);
  assert.deepEqual(order, ['new', 'old']);
});

test('unavailable priority does not prevent queue completion', async () => {
  const queue = createRasterTileQueue({ concurrency: 1 }), order = [];
  const bad = queue.enqueue(() => order.push('unavailable'), { priority: () => { throw Error('layer removed'); } });
  const valid = queue.enqueue(() => order.push('current'), { priority: () => 1 });
  await Promise.all([bad.promise, valid.promise]);
  assert.deepEqual(order, ['current', 'unavailable']);
});

test('real grid drops stale completion when a removed coordinate is requested again', async () => {
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const start = main.indexOf('const GeoTiffGridLayer = L.GridLayer.extend(');
  const end = main.indexOf('// Per-pixel inverse-warp sampler', start);
  const source = main.slice(start, end).replace('const GeoTiffGridLayer =', 'globalThis.Grid =');
  const queue = createRasterTileQueue({ concurrency: 1 }), reads = [];
  const timeouts = [];
  let rendered = 0;
  const context = vm.createContext({
    L: { GridLayer: { prototype: { initialize() {} }, extend: definition => definition } },
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) },
    rasterTileQueue: queue, geoPool: null, setTimeout: callback => timeouts.push(callback),
    selectRasterDetailImage,
    latLonToUtm: (lat, lng) => [lng, lat],
  });
  vm.runInContext(source, context);
  const image = {
    getWidth: () => 1024, getHeight: () => 1024,
    readRasters: () => { const read = deferred(); reads.push(read); return read.promise; },
  };
  const ds = { W: 1024, H: 1024, minE: 0, maxE: 1024, minN: 0, maxN: 1024, images: [image], isDem: false };
  const handlers = {};
  const grid = Object.assign({}, context.Grid, {
    on: (event, handler) => { handlers[event] = handler; },
    getTileSize: () => ({ x: 256, y: 256 }),
    _map: { unproject: ([x, y]) => ({ lng: x, lat: 1024 - y }) },
  });
  grid.initialize(ds, () => { rendered++; return {}; }, {});
  let oldDone = 0, newDone = 0;
  const oldTile = grid.createTile({ x: 0, y: 0, z: 1 }, () => oldDone++);
  await tick();
  handlers.tileunload({ tile: oldTile });
  grid.createTile({ x: 0, y: 0, z: 1 }, () => newDone++);
  reads[0].resolve({ width: 1, height: 1 });
  await tick();
  assert.equal(oldDone, 0);
  assert.equal(rendered, 0);
  assert.equal(reads.length, 2);
  reads[1].resolve({ width: 1, height: 1 });
  await tick();
  assert.equal(newDone, 1);
  assert.equal(rendered, 1);
  assert.equal(oldTile.width, 0);
  assert.equal(oldTile.height, 0);

  // Leaflet also defers empty/out-of-bounds tiles. Those completions must not
  // mark a replacement coordinate ready after removal either.
  let emptyDone = 0;
  const empty = grid.createTile({ x: 100, y: 100, z: 1 }, () => emptyDone++);
  assert.equal(timeouts.length, 1);
  handlers.tileunload({ tile: empty });
  timeouts.shift()();
  assert.equal(emptyDone, 0);
});
