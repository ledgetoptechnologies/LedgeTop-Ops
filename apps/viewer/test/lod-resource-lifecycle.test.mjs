import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { TilesRenderer as SourceTilesRenderer } from '../node_modules/3d-tiles-renderer/src/three/renderer/tiles/TilesRenderer.js';
import { estimateBytesUsed } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { installLodResourceLifecycle } from '../lod-resource-lifecycle.mjs';

// Node has no bitmap decoder. Real DataTextures below exercise the renderer's
// texture disposal branch without needing a browser or a network request.
globalThis.ImageBitmap ??= class ImageBitmap {};

function texture() {
  return new THREE.DataTexture(new Uint8Array(16 * 16 * 4), 16, 16);
}

async function parseFixture(RendererClass, material) {
  const renderer = new RendererClass();
  const scene = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  geometry.computeBoundsTree = computeBoundsTree;
  geometry.disposeBoundsTree = disposeBoundsTree;
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  const tile = {
    boundingVolume: { sphere: [0, 0, 0, 1] }, geometricError: 0,
    refine: 'REPLACE', content: { uri: 'fixture.test' }, children: [],
  };
  renderer.preprocessNode(tile, 'http://localhost');
  renderer.registerPlugin({ name: 'fixture-parser', parseToMesh: () => scene });
  await renderer.parseTile(new TextEncoder().encode('test').buffer, tile, 'test',
    'http://localhost/fixture.test', new AbortController().signal);
  renderer.lruCache.add(tile, () => renderer.disposeTile(tile));
  renderer.lruCache.setMemoryUsage(tile, renderer.getBytesUsed(tile));
  return { renderer, tile, scene, mesh, geometry };
}

for (const [variant, RendererClass] of [['bundle', TilesRenderer], ['source', SourceTilesRenderer]]) {
  test(`${variant}: material-array textures count once and real eviction releases all resources`, async () => {
    const shared = texture(), second = texture();
    const a = new THREE.MeshStandardMaterial({ map: shared, alphaMap: shared });
    const b = new THREE.MeshStandardMaterial({ map: second });
    const counts = { a: 0, b: 0, shared: 0, second: 0 };
    for (const [key, resource] of Object.entries({ a, b, shared, second })) {
      resource.addEventListener('dispose', () => counts[key]++);
    }
    const { renderer, tile, geometry } = await parseFixture(RendererClass, [a, b, a]);
    assert.equal(renderer.lruCache.cachedBytes, estimateBytesUsed(geometry) + 2 * 16 * 16 * 4);
    assert.deepEqual(tile.engineData.materials, [a, b]);
    assert.deepEqual(tile.engineData.textures, [shared, second]);
    assert.equal(renderer.lruCache.remove(tile), true);
    assert.deepEqual(counts, { a: 1, b: 1, shared: 1, second: 1 });
    assert.equal(tile.engineData.scene, null);
    assert.equal(renderer.lruCache.has(tile), false);
    assert.equal(renderer.lruCache.cachedBytes, 0);
  });

  test(`${variant}: converted materials own disposal while original PBR textures remain owned`, async () => {
    const map = texture(), normalMap = texture();
    const original = new THREE.MeshStandardMaterial({ map, normalMap });
    let originalDisposals = 0, mapDisposals = 0, normalDisposals = 0;
    original.addEventListener('dispose', () => originalDisposals++);
    map.addEventListener('dispose', () => mapDisposals++);
    normalMap.addEventListener('dispose', () => normalDisposals++);
    const { renderer, tile, scene, mesh, geometry } = await parseFixture(RendererClass, [original]);
    const lifecycle = installLodResourceLifecycle(renderer);
    renderer.dispatchEvent({ type: 'load-model', tile, scene });
    const [replacement] = mesh.material;
    let replacementDisposals = 0;
    replacement.addEventListener('dispose', () => replacementDisposals++);
    assert.equal(replacement.isMeshBasicMaterial, true);
    assert.equal(replacement.map, map);
    assert.deepEqual(tile.engineData.materials, [replacement]);
    assert.equal(lifecycle.snapshot().pendingBvhMeshes, 1);
    lifecycle.drainBVH();
    assert.ok(geometry.boundsTree);
    renderer.lruCache.remove(tile);
    assert.equal(originalDisposals, 1);
    assert.equal(replacementDisposals, 1);
    assert.equal(mapDisposals, 1);
    assert.equal(normalDisposals, 1);
    assert.equal(geometry.boundsTree, null);
    assert.equal(lifecycle.snapshot().pendingBvhMeshes, 0);
    lifecycle.dispose();
  });

  test(`${variant}: evicted tiles leave no queued mesh references or later BVH work`, async () => {
    const { renderer, tile, scene, geometry } = await parseFixture(RendererClass, new THREE.MeshStandardMaterial());
    const lifecycle = installLodResourceLifecycle(renderer);
    let builds = 0;
    geometry.computeBoundsTree = () => { builds++; };
    renderer.dispatchEvent({ type: 'load-model', tile, scene });
    assert.equal(lifecycle.snapshot().pendingBvhMeshes, 1);
    renderer.lruCache.remove(tile);
    assert.equal(lifecycle.snapshot().pendingBvhMeshes, 0);
    lifecycle.drainBVH();
    assert.equal(builds, 0);
    lifecycle.dispose();
    lifecycle.dispose();
  });

  test(`${variant}: renderer teardown clears pending BVH work and unregisters observers`, async () => {
    const { renderer, tile, scene, geometry } = await parseFixture(RendererClass, new THREE.MeshStandardMaterial());
    const lifecycle = installLodResourceLifecycle(renderer);
    let builds = 0;
    geometry.computeBoundsTree = () => { builds++; };
    renderer.dispatchEvent({ type: 'load-model', tile, scene });
    lifecycle.dispose();
    assert.equal(lifecycle.snapshot().pendingBvhMeshes, 0);
    renderer.dispatchEvent({ type: 'load-model', tile, scene });
    lifecycle.drainBVH();
    assert.equal(lifecycle.snapshot().pendingBvhMeshes, 0);
    assert.equal(builds, 0);
    renderer.lruCache.remove(tile);
  });
}
