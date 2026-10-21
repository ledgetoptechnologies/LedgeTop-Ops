import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { clampPolarOffset, EarthLikeControls, safeTopViewPosition } from '../earth-controls.js';
import { directPointPickThreshold, pickDirectPointSurface } from '../direct-pointcloud-picking.mjs';

function polar(offset) {
  return Math.acos(THREE.MathUtils.clamp(offset.clone().normalize().dot(new THREE.Vector3(0, 1, 0)), -1, 1));
}

test('orbit clamps the signed view ray at top-down for large and off-centre drags', () => {
  for (const pivot of [new THREE.Vector3(), new THREE.Vector3(40, 0, -100)]) {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 100, 5);
    camera.lookAt(0, 0, 0);
    const controls = Object.create(EarthLikeControls.prototype);
    Object.assign(controls, { camera, minPolar: 0.04, maxPolar: Math.PI - 0.03 });
    for (let i = 0; i < 10; i++) {
      controls._applyOrbit(pivot, 0, -0.4);
      const forward = camera.getWorldDirection(new THREE.Vector3());
      assert.ok(forward.z < 0, 'camera must not flip across the top pole');
      assert.ok(Math.asin(-forward.y) <= Math.PI / 2 - controls.minPolar + 1e-9);
      assert.ok(camera.position.toArray().every(Number.isFinite));
    }
    const clamped = camera.quaternion.clone();
    const clampedPosition = camera.position.clone();
    controls._applyOrbit(pivot, 0, -Math.PI * 4);
    assert.ok(camera.quaternion.angleTo(clamped) < 1e-7, 'huge input cannot wrap around the pole');
    assert.ok(camera.position.distanceTo(clampedPosition) < 1e-8, 'blocked pitch cannot move an off-centre pivot');
    controls._applyOrbit(pivot, 0, 0.1);
    assert.ok(camera.quaternion.angleTo(clamped) > 0.09, 'reverse drag leaves the clamp immediately');
  }
});

test('polar clamp keeps exact top views on a stable finite azimuth just below the singularity', () => {
  const min = 0.04;
  const original = new THREE.Vector3(0, 500, 0);
  const clamped = clampPolarOffset(original, min, Math.PI - 0.04, new THREE.Vector3(0, 0, 1));
  assert.ok(clamped.toArray().every(Number.isFinite));
  assert.ok(Math.abs(clamped.length() - original.length()) < 1e-9);
  assert.ok(Math.abs(polar(clamped) - min) < 1e-9);
  assert.ok(clamped.z > 0, 'fallback azimuth remains deterministic at the pole');
});

test('polar clamp leaves valid offsets unchanged and clamps the lower pole', () => {
  const min = 0.04, max = Math.PI - 0.04;
  const valid = new THREE.Vector3(20, 30, 40);
  assert.deepEqual(clampPolarOffset(valid, min, max).toArray(), valid.toArray());
  const below = clampPolarOffset(new THREE.Vector3(0, -200, 0), min, max, new THREE.Vector3(1, 0, 0));
  assert.ok(Math.abs(polar(below) - max) < 1e-9);
  assert.ok(below.x > 0);
});

test('top view starts inside the polar clamp so the first tiny orbit stays proportional', () => {
  const noop = () => {};
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ beginPath: noop, arc: noop, stroke: noop, fill: noop }) }) };
  globalThis.window = { addEventListener: noop, removeEventListener: noop };
  try {
    const target = new THREE.Vector3(0, 18, 0), minPolar = 0.04, radius = 542;
    const position = safeTopViewPosition(target, radius, minPolar);
    const angle = polar(position.clone().sub(target));
    assert.ok(angle > minPolar && angle < minPolar + 0.002);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
    camera.position.copy(position);
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
    const dom = { addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
    const controls = new EarthLikeControls(camera, dom, { minPolar, maxPolar: Math.PI - 0.03 });
    const before = camera.position.clone();
    controls._applyOrbit(target, 0, 0.001);
    assert.ok(camera.position.toArray().every(Number.isFinite));
    assert.ok(camera.position.distanceTo(before) < radius * 0.002, 'first orbit must not catch up from the exact pole');
    controls.dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('left-drag orbit starts only from a real rendered-surface hit', () => {
  const noop = () => {};
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ beginPath: noop, arc: noop, stroke: noop, fill: noop }) }) };
  globalThis.window = { addEventListener: noop, removeEventListener: noop };
  try {
    let hit = null;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
    camera.position.set(0, 10, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const dom = {
      clientHeight: 100,
      addEventListener: noop,
      removeEventListener: noop,
      setPointerCapture: noop,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    };
    const controls = new EarthLikeControls(camera, dom, { surfacePick: () => hit, fallbackPlaneY: 0 });
    const press = { button: 0, pointerType: 'mouse', pointerId: 1, clientX: 50, clientY: 50 };
    controls._pointerDown(press);
    assert.equal(controls._mode, 'none', 'empty background cannot start orbit');
    hit = new THREE.Vector3(1, 2, 3);
    controls._pointerDown(press);
    assert.equal(controls._mode, 'orbit');
    assert.deepEqual(controls._pivot.toArray(), [1, 2, 3]);
    const interaction = controls.getInteractionState();
    assert.deepEqual(interaction.focusNdc, [0, 0]);
    assert.deepEqual(interaction.focusPoint, [1, 2, 3]);
    assert.equal(interaction.activeMotion, true);
    assert.ok(interaction.lastActivityTime > 0);
    assert.ok(Object.isFrozen(interaction));
    controls.dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test('direct Three.js point-cloud picking scales by camera-space depth, not off-axis distance', () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  geometry.computeBoundingSphere();
  const points = new THREE.Points(geometry, new THREE.PointsMaterial());
  points.position.set(100, 0, -10);
  points.updateMatrixWorld(true);
  const threshold = directPointPickThreshold({ camera, points, viewportHeight: 1000 });
  const expected = 2 * 10 * Math.tan(Math.PI / 6) * 11 / 2 / 1000;
  assert.ok(Math.abs(threshold - expected) < 1e-12, 'lateral cloud displacement must not broaden the screen-space pick window');
  camera.zoom = 2;
  assert.ok(Math.abs(directPointPickThreshold({ camera, points, viewportHeight: 1000 }) - expected / 2) < 1e-12, 'camera zoom must narrow the same pixel window');
  camera.zoom = 1;
  points.position.set(0, 0, 10);
  points.updateMatrixWorld(true);
  assert.equal(directPointPickThreshold({ camera, points, viewportHeight: 1000 }), null, 'content behind the camera cannot expand a pick threshold');
  geometry.dispose();
  points.material.dispose();
});

test('direct Three.js point-cloud content arms orbit while its empty background does not', () => {
  const noop = () => {};
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ beginPath: noop, arc: noop, stroke: noop, fill: noop }) }) };
  globalThis.window = { addEventListener: noop, removeEventListener: noop };
  try {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    geometry.computeBoundingSphere();
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false }));
    points.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    const dom = {
      clientHeight: 100,
      addEventListener: noop,
      removeEventListener: noop,
      setPointerCapture: noop,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    };
    const surfacePick = (ndc) => pickDirectPointSurface({ raycaster, camera, points, ndc, viewportHeight: dom.clientHeight });
    const controls = new EarthLikeControls(camera, dom, { surfacePick, fallbackPlaneY: 0 });
    controls._pointerDown({ button: 0, pointerType: 'mouse', pointerId: 1, clientX: 95, clientY: 5 });
    assert.equal(controls._mode, 'none', 'empty direct-cloud background cannot start orbit');
    const before = camera.position.clone();
    controls._pointerDown({ button: 0, pointerType: 'mouse', pointerId: 2, clientX: 50, clientY: 50 });
    assert.equal(controls._mode, 'orbit', 'a rendered direct-cloud point starts orbit');
    controls._pointerMove({ pointerType: 'mouse', pointerId: 2, clientX: 60, clientY: 55 });
    assert.ok(camera.position.distanceTo(before) > 0.1, 'left-drag over direct-cloud content moves the camera');
    controls.dispose();
    geometry.dispose();
    points.material.dispose();
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});
