import assert from 'node:assert/strict';
import test from 'node:test';
import { TilesRenderer } from '3d-tiles-renderer';
import { TilesRenderer as SourceTilesRenderer } from '../node_modules/3d-tiles-renderer/src/three/renderer/tiles/TilesRenderer.js';
import { installLodResourceLifecycle } from '../lod-resource-lifecycle.mjs';
import { makeB3dm } from './helpers/lod-fixture.mjs';

// Unreferenced BIN bytes make parser-only retention observable without a heap
// benchmark. The rendered triangle owns a separate 36-byte accessor buffer.
function glbWithLargeBin() {
  const bin = Buffer.alloc(1024 * 1024);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => bin.writeFloatLE(value, index * 4));
  const json = {
    asset: { version: '2.0', copyright: 'Retained attribution' },
    extras: { fixtureMetadata: true },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 1] } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: bin.length }],
  };
  const rawJson = Buffer.from(JSON.stringify(json));
  const paddedJson = Buffer.alloc(Math.ceil(rawJson.length / 4) * 4, 0x20);
  rawJson.copy(paddedJson);
  const glb = Buffer.alloc(28 + paddedJson.length + bin.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(paddedJson.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  paddedJson.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + paddedJson.length);
  glb.writeUInt32LE(0x004e4942, 24 + paddedJson.length);
  bin.copy(glb, 28 + paddedJson.length);
  return glb;
}

for (const [variant, RendererClass] of [['bundle', TilesRenderer], ['source', SourceTilesRenderer]]) {
  for (const extension of ['glb', 'b3dm']) {
    test(`${variant}: completed ${extension} drops parser-only buffers while retaining rendering and metadata across reloads`, async () => {
      const renderer = new RendererClass();
      const lifecycle = installLodResourceLifecycle(renderer);
      const glb = glbWithLargeBin();
      const body = extension === 'glb' ? glb : makeB3dm(glb, { BATCH_LENGTH: 0, RTC_CENTER: [4, 5, 6] });
      const tile = {
        boundingVolume: { sphere: [0, 0, 0, 2] }, geometricError: 0,
        refine: 'REPLACE', content: { uri: `fixture.${extension}` }, children: [],
      };
      renderer.preprocessNode(tile, 'http://localhost');
      for (let cycle = 0; cycle < 3; cycle++) {
        await renderer.parseTile(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          tile, extension, `http://localhost/fixture.${extension}`, new AbortController().signal);
        const metadata = tile.engineData.metadata;
        const scene = tile.engineData.scene;
        let mesh;
        scene.traverse(object => { if (object.isMesh) mesh = object; });
        const positionArray = mesh.geometry.attributes.position.array;
        const originalColor = mesh.material.color.clone();
        const transform = scene.matrix.clone();
        const fields = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'parser'));
        assert.equal(metadata.parser.extensions.KHR_binary_glTF.body.byteLength, 1024 * 1024);
        assert.equal(await metadata.parser.cache.get('buffer:0'), metadata.parser.extensions.KHR_binary_glTF.body);
        assert.equal(positionArray.buffer.byteLength, 36);
        assert.equal(renderer.getBytesUsed(tile), 36, 'parser BIN is absent from decoded tile accounting');
        renderer.lruCache.add(tile, () => renderer.disposeTile(tile));
        renderer.lruCache.setMemoryUsage(tile, renderer.getBytesUsed(tile));
        renderer.dispatchEvent({ type: 'load-model', tile, scene });
        assert.equal(Object.hasOwn(metadata, 'parser'), false);
        assert.deepEqual(Object.keys(metadata).sort(), Object.keys(fields).sort());
        for (const [key, value] of Object.entries(fields)) assert.equal(metadata[key], value, `preserve ${key}`);
        assert.equal(metadata.asset.copyright, 'Retained attribution');
        assert.equal(metadata.userData.fixtureMetadata, true);
        assert.equal(mesh.geometry.attributes.position.array, positionArray);
        assert.equal(mesh.material.isMeshBasicMaterial, true);
        assert.ok(mesh.material.color.equals(originalColor));
        assert.ok(scene.matrix.equals(transform));
        if (extension === 'b3dm') {
          assert.equal(scene.featureTable, metadata.featureTable);
          assert.equal(scene.batchTable, metadata.batchTable);
          assert.deepEqual(scene.featureTable.getData('RTC_CENTER'), [4, 5, 6]);
        }
        renderer.setTileActive(tile, true);
        renderer.setTileVisible(tile, true);
        tile.traversal.active = true;
        tile.traversal.visible = true;
        assert.ok(renderer.group.children.includes(scene));
        let disposed = 0;
        mesh.material.addEventListener('dispose', () => disposed++);
        renderer.lruCache.remove(tile);
        assert.equal(disposed, 1);
        assert.equal(tile.engineData.scene, null);
        assert.equal(tile.engineData.metadata, null);
        assert.equal(renderer.group.children.length, 0);
        assert.equal(renderer.activeTiles.size, 0);
        assert.equal(lifecycle.snapshot().pendingBvhMeshes, 0);
      }
      lifecycle.dispose();
    });
  }
}
