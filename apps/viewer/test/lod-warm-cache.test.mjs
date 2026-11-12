import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { LRUCache } from '3d-tiles-renderer';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene } from 'three';
import { WebGLRenderLists } from '../node_modules/three/src/renderers/webgl/WebGLRenderLists.js';
import { installLodOverviewRetention, recoverLodCacheAdmission } from '../lod-policy.mjs';

// Exercise the real pinned LRU without timers, WebGL, large allocations or a
// network. Bytes below are accounting units, not allocated model buffers.
function fixture({ soft = 100, hard = 140, maxItems = 20 } = {}) {
  const frames = new Map();
  let nextFrame = 0;
  const oldRequest = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = fn => { const id = ++nextFrame; frames.set(id, fn); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const cache = new LRUCache();
  Object.assign(cache, { softBytesSize: soft, maxBytesSize: hard, minBytesSize: 10,
    maxSize: maxItems, minSize: 1, unloadPercent: 0.2 });
  const disposed = [];
  const pinned = [];
  const restore = installLodOverviewRetention({ lruCache: cache, markTileUsed: t => cache.markUsed(t) }, () => pinned);
  const add = id => {
    const tile = { id };
    assert.equal(cache.add(tile, () => disposed.push(id)), true);
    cache.setMemoryUsage(tile, 10);
    cache.setLoaded(tile, true);
    return tile;
  };
  return {
    cache, disposed, pinned, add,
    async settle() {
      await Promise.resolve();
      for (let pass = 0; frames.size && pass < 30; pass++) {
        const pending = [...frames.values()]; frames.clear();
        pending.forEach(fn => fn());
        await Promise.resolve();
      }
      assert.equal(frames.size, 0, 'eviction work settles without a live timer');
    },
    close() {
      restore();
      for (const tile of [...cache.itemSet.keys()]) cache.remove(tile);
      frames.clear();
      globalThis.requestAnimationFrame = oldRequest;
      globalThis.cancelAnimationFrame = oldCancel;
    },
  };
}

test('orbit-away and return retain the same loaded tiles below the soft budget', async () => {
  const f = fixture();
  try {
    const tiles = Array.from({ length: 8 }, (_, i) => f.add(i));
    // No recent-frontier pins: this also covers expiration of the two-second
    // pin and changing the focal owner while a slow orbit continues.
    for (const current of [tiles[0], tiles[4], tiles[7], tiles[0]]) {
      f.cache.usedSet.clear(); f.cache.markUsed(current);
      f.cache.scheduleUnload(); await f.settle();
      assert.equal(f.cache.cachedBytes, 80);
      assert.equal(f.cache.has(current), true);
    }
    assert.deepEqual(f.disposed, []);
  } finally { f.close(); }
  assert.equal(f.cache.cachedBytes, 0, 'explicit teardown still releases the whole warm cache');
  assert.equal(f.disposed.length, 8);
});

test('soft pressure evicts unused content and preserves active and overview tiles', async () => {
  const f = fixture();
  try {
    const tiles = Array.from({ length: 12 }, (_, i) => f.add(i));
    f.cache.usedSet.clear(); f.cache.markUsed(tiles[11]); f.pinned.push(tiles[0]);
    f.cache.scheduleUnload(); await f.settle();
    assert.ok(f.disposed.length > 0);
    assert.ok(f.cache.cachedBytes < 100);
    assert.equal(f.cache.has(tiles[0]), true);
    assert.equal(f.cache.has(tiles[11]), true);
    assert.equal(f.cache.maxBytesSize, 140);
  } finally { f.close(); }
});

test('prospective hard-limit recovery bypasses warm retention below the soft budget', async () => {
  const f = fixture();
  try {
    const tiles = Array.from({ length: 8 }, (_, i) => f.add(i));
    f.cache.usedSet.clear(); f.cache.markUsed(tiles[7]);
    assert.equal(recoverLodCacheAdmission(f.cache, f.cache, 80), true);
    await f.settle();
    assert.ok(f.cache.cachedBytes + 80 <= 140);
    assert.ok(f.disposed.length > 0);
    assert.equal(f.cache.has(tiles[7]), true);
    assert.equal(f.cache.maxBytesSize, 140);
  } finally { f.close(); }
});

test('item-count pressure and unknown soft limits retain normal eviction', async () => {
  for (const options of [{ maxItems: 8 }, { soft: undefined }]) {
    const f = fixture(options);
    try {
      if (Object.hasOwn(options, 'soft')) delete f.cache.softBytesSize;
      Array.from({ length: 8 }, (_, i) => f.add(i));
      f.cache.usedSet.clear(); f.cache.scheduleUnload(); await f.settle();
      assert.ok(f.disposed.length > 0);
    } finally { f.close(); }
  }
});

test('mode-exit cleanup drops actual Three render-list and measurement references', () => {
  const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const declaration = source.match(/function releaseThreeRenderReferences\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(declaration, 'exercise the actual mode-exit helper rather than duplicate its implementation');
  const scene = new Scene(), geometry = new BoxGeometry(), material = new MeshBasicMaterial();
  const mesh = new Mesh(geometry, material), renderLists = new WebGLRenderLists();
  const lastFrame = renderLists.get(scene, 0);
  lastFrame.init(); lastFrame.push(mesh, geometry, material, 0, 0, null); lastFrame.finish();
  geometry.dispose(); material.dispose();
  assert.equal(lastFrame.opaque[0].geometry, geometry, 'GPU disposal alone leaves CPU references');
  const context = { renderer: { renderLists }, measurementSurfaceSnapshot: { roots: [{ root: mesh }] }, measurementSurfaceSnapshotAt: 123 };
  vm.runInNewContext(`${declaration}\nreleaseThreeRenderReferences();`, context);
  assert.notEqual(renderLists.get(scene, 0), lastFrame);
  assert.equal(renderLists.get(scene, 0).opaque.length, 0);
  assert.equal(context.measurementSurfaceSnapshot, null);
  assert.equal(context.measurementSurfaceSnapshotAt, 0);
  vm.runInNewContext('releaseThreeRenderReferences();', context);
  assert.equal(context.measurementSurfaceSnapshot, null, 'repeated cleanup is safe');
});
