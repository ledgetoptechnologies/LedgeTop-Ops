import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { homeViewForBounds, tilesetWorldBounds } from '../viewer-framing.mjs';

test('tileset root bounds include the complete rendered parent transform', () => {
  const tilesParent = new THREE.Group();
  tilesParent.rotation.x = Math.PI;
  tilesParent.position.set(-4, -6, 5);
  const rendererGroup = new THREE.Group();
  tilesParent.add(rendererGroup);

  const local = new THREE.Box3(
    new THREE.Vector3(8, 18, 28),
    new THREE.Vector3(12, 22, 32),
  );
  const renderer = {
    group: rendererGroup,
    getBoundingBox(target) { target.copy(local); return true; },
  };

  const world = tilesetWorldBounds(renderer);
  const center = world.getCenter(new THREE.Vector3());
  const size = world.getSize(new THREE.Vector3());
  assert.deepEqual(center.toArray().map((value) => Math.round(value)), [6, -26, -25]);
  assert.deepEqual(size.toArray().map((value) => Math.round(value)), [4, 4, 4]);
});

test('external-root tilesets frame from manifest bounds without requiring a model scene', () => {
  const group = new THREE.Group();
  group.position.set(25, 50, -10);
  const renderer = {
    group,
    root: { engineData: { scene: null } },
    getBoundingBox(target) {
      target.set(new THREE.Vector3(-5, -10, -15), new THREE.Vector3(5, 10, 15));
      return true;
    },
  };

  const world = tilesetWorldBounds(renderer);
  assert.deepEqual(world.getCenter(new THREE.Vector3()).toArray(), [25, 50, -10]);
  assert.deepEqual(world.getSize(new THREE.Vector3()).toArray(), [10, 20, 30]);
});

test('home view derives its target and distance from actual world bounds', () => {
  const bounds = new THREE.Box3(
    new THREE.Vector3(-40, -20, -60),
    new THREE.Vector3(40, 20, 60),
  );
  const view = homeViewForBounds(bounds);
  const diameter = bounds.getSize(new THREE.Vector3()).length();
  assert.deepEqual(view.lookAt.toArray(), [0, 0, 0]);
  assert.equal(view.diameter, diameter);
  assert.equal(view.distance, diameter * 0.9);
  assert.deepEqual(view.position.toArray(), [0, view.distance * 0.55, view.distance * 0.75]);
});

test('missing or empty tileset bounds fail closed', () => {
  assert.equal(tilesetWorldBounds(null), null);
  assert.equal(tilesetWorldBounds({ group: new THREE.Group(), getBoundingBox: () => false }), null);
});
