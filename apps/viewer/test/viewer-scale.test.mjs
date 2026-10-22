import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { closeZoomDistanceForDiameter } from '../viewer-scale.mjs';

test('close zoom scales across model sizes and stays beyond the near plane', () => {
  assert.equal(closeZoomDistanceForDiameter(10), 0.08);
  assert.equal(closeZoomDistanceForDiameter(1_000), 0.1);
  assert.equal(closeZoomDistanceForDiameter(10_000), 0.25);
  assert.equal(closeZoomDistanceForDiameter(Number.NaN), 0.08);
  assert.equal(closeZoomDistanceForDiameter(10, { cameraNear: 0.1 }), 0.15000000000000002);
});

test('Earth controls clamp close zoom and ignore degenerate or inverted dollies', async () => {
  const noop = () => {};
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ strokeStyle: '', lineWidth: 0, fillStyle: '', beginPath: noop, arc: noop, stroke: noop, fill: noop }) }) };
  globalThis.window = { addEventListener: noop, removeEventListener: noop };
  const { EarthLikeControls } = await import('../earth-controls.js');
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
  camera.position.set(0, 0, 1);
  const dom = {
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
  };
  const controls = new EarthLikeControls(camera, dom, { minDistance: 0.08, surfacePick: () => null });
  const target = new THREE.Vector3(0, 0, 0);
  controls._zoomTowards(target, 0.001);
  assert.ok(Math.abs(camera.position.length() - 0.08) < 1e-9);
  const before = camera.position.clone();
  controls._zoomTowards(camera.position.clone(), 0.5);
  assert.deepEqual(camera.position.toArray(), before.toArray());
  controls._zoomTowards(target, -1);
  assert.deepEqual(camera.position.toArray(), before.toArray());
  controls.dispose();
  delete globalThis.document;
  delete globalThis.window;
});
