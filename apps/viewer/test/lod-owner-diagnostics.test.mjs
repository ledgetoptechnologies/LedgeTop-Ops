import assert from 'node:assert/strict';
import test from 'node:test';
import { EventDispatcher, Group, PerspectiveCamera, Vector3 } from 'three';
import { createLodOwnerDiagnostics } from '../lod-owner-diagnostics.mjs';

function fixture() {
  const tiles = Object.assign(new EventDispatcher(), {
    frameCount: 4, errorTarget: 5.481, group: new Group(),
    visibleTiles: new Set(), activeTiles: new Set(), lodFallbackTiles: new Set(),
    lruCache: { bytesMap: new Map(), usedSet: new Set(), has(tile) { return this.bytesMap.has(tile); } },
  });
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.updateMatrixWorld();
  const root = {
    children: [], geometricError: 10, internal: { depth: 0, loadingState: 4 },
    traversal: { lastFrameVisited: 4, used: true, inFrustum: true, kicked: false, error: 50 },
    content: { uri: 'https://private.invalid/tile?token=DO_NOT_LEAK' },
    engineData: { scene: new Group(), boundingVolume: { getSphere(s) { return s.set(new Vector3(0, 0, -10), 1); } } },
  };
  tiles.root = root;
  tiles.group.add(root.engineData.scene);
  tiles.visibleTiles.add(root);
  tiles.lruCache.bytesMap.set(root, 100);
  tiles.lruCache.usedSet.add(root);
  return { tiles, camera, root };
}

test('owner diagnostics separate visibility transitions from disposal without exposing asset identifiers', () => {
  const { tiles, camera, root } = fixture();
  const debug = createLodOwnerDiagnostics(tiles, { camera, now: () => 10 });
  const first = debug.snapshot();
  tiles.visibleTiles.delete(root);
  root.traversal.kicked = true;
  tiles.dispatchEvent({ type: 'tile-visibility-change', tile: root, visible: false, url: root.content.uri });
  const second = debug.snapshot();
  assert.equal(first.tiles[0].scene, second.tiles[0].scene);
  assert.equal(second.tiles[0].cached, true);
  assert.equal(second.tiles[0].visible, false);
  assert.equal(second.tiles[0].kicked, true);
  assert.deepEqual(second.events.map(e => e.type), ['tile-visibility-change']);
  assert.equal(JSON.stringify(second).includes('DO_NOT_LEAK'), false);
  assert.equal(JSON.stringify(second).includes('private.invalid'), false);
  assert.equal(second.tiles[0].projected.nearDepth, 9);
  assert.equal(second.tiles[0].projected.farDepth, 11);
  tiles.group.remove(root.engineData.scene);
  // Active invisible scenes retain a parent pointer in the pinned renderer.
  root.engineData.scene.parent = tiles.group;
  tiles.activeTiles.add(root);
  assert.equal(debug.snapshot().tiles[0].attached, false);
  assert.equal(debug.snapshot().tiles[0].active, true);
});

test('owner event ring is bounded, copied and detached on disposal', () => {
  const { tiles, root } = fixture();
  const debug = createLodOwnerDiagnostics(tiles, { eventLimit: 2, now: () => 10 });
  for (const type of ['tile-download-start', 'load-model', 'dispose-model']) tiles.dispatchEvent({ type, tile: root });
  assert.deepEqual(debug.trace().map(e => e.type), ['load-model', 'dispose-model']);
  debug.trace()[0].type = 'changed';
  assert.equal(debug.trace()[0].type, 'load-model');
  debug.dispose();
  tiles.dispatchEvent({ type: 'load-model', tile: root });
  assert.deepEqual(debug.trace(), []);
});

test('owner snapshot bounds traversal and reports stale-frame membership honestly', () => {
  const { tiles, root } = fixture();
  const child = { ...root, parent: root, children: [root], traversal: { ...root.traversal, lastFrameVisited: 3 } };
  root.children.push(child);
  tiles.lruCache.bytesMap.set(child, 20);
  const debug = createLodOwnerDiagnostics(tiles);
  const snapshot = debug.snapshot({ maxTiles: 1 });
  assert.equal(snapshot.visited, 2);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.tiles.length, 1);
  const row = debug.snapshot().tiles.find(row => row.parent !== null);
  assert.equal(row.currentFrame, false);
  assert.equal(row.selected, false);
  assert.equal(row.inFrustum, false);
});

test('distance experiment diagnostics expose protection reasons without arbitrary strings or nonfinite values', () => {
  const { tiles, root } = fixture();
  tiles.__ltdsDistanceDemand = { enabled: true };
  root.__ltdsDistanceDemand = {
    enabled: true, ready: true, protected: false, distance: 60, modelRadius: 100,
    nearRadius: 25, farRadius: 50, target: 512, reason: 'far-surface',
  };
  const debug = createLodOwnerDiagnostics(tiles);
  const snapshot = debug.snapshot();
  assert.equal(snapshot.distanceDemandEnabled, true);
  assert.deepEqual(snapshot.tiles[0].distanceDemand, root.__ltdsDistanceDemand);
  root.__ltdsDistanceDemand.reason = 'https://private.invalid/?token=DO_NOT_LEAK';
  root.__ltdsDistanceDemand.distance = Infinity;
  const redacted = debug.snapshot();
  assert.equal(redacted.tiles[0].distanceDemand.reason, null);
  assert.equal(redacted.tiles[0].distanceDemand.distance, null);
  assert.equal(JSON.stringify(redacted).includes('DO_NOT_LEAK'), false);
  debug.dispose();
});
