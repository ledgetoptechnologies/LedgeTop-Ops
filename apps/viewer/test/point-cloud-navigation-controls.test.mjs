import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const navigation = require('../public/pointcloud-navigation.js');
const pointCloudPerformance = require('../public/pointcloud-performance.js');
const shell = fs.readFileSync(new URL('../public/pointcloud.html', import.meta.url), 'utf8');
const start = shell.indexOf('class PCPointerControls {');
const end = shell.indexOf('// Replace Potree\'s EarthControls', start);
assert.ok(start >= 0 && end > start);
// Exercise the shipped controller methods, rather than a second implementation.
const Controls = vm.runInNewContext(`${shell.slice(start, end)}\nPCPointerControls`, {
  THREE, ...navigation, performance, Potree: { measureTimings: false },
  window: { LtdsPointCloudPerformance: pointCloudPerformance },
});

function fixture(position = new THREE.Vector3(0, -200, 150), origin = new THREE.Vector3()) {
  position = position.clone().add(origin);
  const target = origin.clone();
  const direction = target.clone().sub(position).normalize();
  const view = {
    position: position.clone(), radius: position.distanceTo(target),
    getPivot() { return this.position.clone().addScaledVector(direction, this.radius); },
    lookAt(point) { this.radius = point.distanceTo(this.position); direction.copy(point).sub(this.position).normalize(); },
  };
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100000);
  camera.up.set(0, 0, 1);
  const controls = Object.create(Controls.prototype);
  controls.view = view;
  controls.enabled = true;
  controls.pivot = target.clone();
  controls._inertia = { active: false, yaw: 0, pitch: 0 };
  controls._panPlane = new THREE.Plane();
  controls._panStart = new THREE.Vector3();
  controls._showPivot = () => {};
  controls.dom = {
    clientHeight: 1000, clientWidth: 1000,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    setPointerCapture() {}, focus() {},
  };
  controls._cam = () => {
    camera.position.copy(view.position);
    camera.lookAt(view.getPivot());
    camera.updateMatrixWorld(true);
    return camera;
  };
  controls._pointPick = () => null;
  const bounds = new THREE.Box3(new THREE.Vector3(-50, -50, -10).add(origin), new THREE.Vector3(50, 50, 10).add(origin));
  controls._cloudBounds = () => bounds;
  return { controls, view, bounds };
}

function pointer(button, x = 500, y = 500) {
  return { pointerId: 1, pointerType: 'mouse', button, clientX: x, clientY: y, preventDefault() {} };
}

test('cloud orbit cannot cross top-down with large steps and off-centre pivots', () => {
  for (const pivot of [new THREE.Vector3(), new THREE.Vector3(40, 100, 0)]) {
    const { controls, view } = fixture(new THREE.Vector3(0, -5, 100));
    for (let i = 0; i < 10; i++) {
      controls._applyOrbit(pivot, 0, -0.4);
      const forward = view.getPivot().sub(view.position).normalize();
      assert.ok(forward.y > 0, 'cloud view must retain its forward hemisphere');
      assert.ok(Math.asin(-forward.z) <= Math.PI / 2 - 0.03 + 1e-9);
    }
    const before = view.getPivot().sub(view.position).normalize();
    controls._applyOrbit(pivot, 0, -Math.PI * 4);
    assert.ok(view.getPivot().sub(view.position).normalize().distanceTo(before) < 1e-8);
    controls._applyOrbit(pivot, 0, 0.1);
    assert.ok(view.getPivot().sub(view.position).normalize().angleTo(before) > 0.09);
  }
});

test('zoom-out preserves the world focal plane and overview orbit with no decoded point hit', () => {
  const { controls, view } = fixture();
  const originalPivot = view.getPivot();
  const originalRadius = view.radius;
  controls._zoomTowards(originalPivot, 4);
  assert.ok(view.getPivot().distanceTo(originalPivot) < 1e-9, 'dolly must not carry the focal plane away with the camera');
  assert.ok(Math.abs(view.radius - originalRadius * 4) < 1e-9);
  controls._pointerDown(pointer(0));
  assert.equal(controls._mode, 'orbit', 'sparse overview remains orbitable after zoom-out');
  assert.ok(controls.pivot.distanceTo(originalPivot) < 1e-8);
  const before = view.position.clone();
  controls._pointerMove(pointer(0, 520));
  assert.ok(view.position.distanceTo(before) > 1, 'orbit actually moves the camera');
  assert.ok(view.position.toArray().every(Number.isFinite));
});

test('middle-pan and ground-pan retain proportional screen speed after dolly zoom-out', () => {
  for (const button of [1, 2]) {
    const measurements = [];
    for (const scale of [1, 4]) {
      const { controls, view } = fixture();
      controls._zoomTowards(view.getPivot(), scale);
      const before = view.position.clone();
      controls._pointerDown(pointer(button));
      assert.equal(controls._mode, button === 1 ? 'screenpan' : 'pan');
      controls._pointerMove(pointer(button, 520));
      measurements.push(view.position.distanceTo(before));
    }
    assert.ok(measurements[0] > 0);
    assert.ok(Math.abs(measurements[1] / measurements[0] - 4) < 1e-8, `button ${button}: same pixels retain same visual movement at four times distance`);
  }
});

test('off-center wheel dolly preserves heading and focal-plane depth', () => {
  const { controls, view } = fixture();
  const originalPivot = view.getPivot();
  const direction = originalPivot.clone().sub(view.position).normalize();
  const target = controls._depthAnchor({ x: 560, y: 530 });
  controls._zoomTowards(target, 2);
  const nextDirection = view.getPivot().sub(view.position).normalize();
  assert.ok(nextDirection.distanceTo(direction) < 1e-12, 'zoom does not turn or re-center the camera');
  assert.ok(Math.abs(view.getPivot().sub(originalPivot).dot(direction)) < 1e-9, 'off-center zoom keeps the focal plane depth');
  controls._zoomTowards(target, 0.5);
  assert.ok(view.getPivot().distanceTo(originalPivot) < 1e-9, 'reverse dolly restores target');
});

test('projected UTM coordinates retain sparse overview orbit after repeated zoom reversals', () => {
  const { controls, view } = fixture(new THREE.Vector3(0, -200, 150), new THREE.Vector3(367000, 4760000, 220));
  const originalPivot = view.getPivot();
  for (const scale of [4, 0.25, 3, 1 / 3]) {
    controls._zoomTowards(originalPivot, scale);
    assert.ok(view.getPivot().distanceTo(originalPivot) < 1e-7);
    controls._pointerDown(pointer(0));
    assert.equal(controls._mode, 'orbit');
    assert.ok(controls.pivot.distanceTo(originalPivot) < 1e-5, 'UTM ray intersection stays within ten micrometres of the focal point');
  }
});

test('oblique sparse overview returns a bounded ray hit when the focal plane misses the cloud', () => {
  const { controls, bounds } = fixture();
  let sample = null;
  for (let y = 350; y <= 650 && !sample; y += 5) {
    for (let x = 350; x <= 650 && !sample; x += 5) {
      const px = { x, y };
      const depth = controls._depthAnchor(px);
      const padded = bounds.clone().expandByScalar(bounds.getSize(new THREE.Vector3()).length() * navigation.NAVIGATION_POLICY.overviewBoundsPaddingRatio);
      if (controls._ray(px).intersectBox(padded, new THREE.Vector3()) && !padded.containsPoint(depth)) sample = px;
    }
  }
  assert.ok(sample, 'fixture contains an oblique volume hit whose focal-plane point lies outside');
  const anchor = controls._surfaceAnchor(sample);
  assert.ok(anchor, 'a ray through a sparse overview cloud remains orbitable');
  assert.equal(navigation.canUseOverviewAnchor({
    point: anchor, bounds, referenceDistance: controls.view.radius,
    cloudDiameter: bounds.getSize(new THREE.Vector3()).length(),
  }), true, 'the actual returned anchor is bounded');
});

test('close no-hit and empty background still refuse orbit while real close hits work', () => {
  const overview = fixture();
  overview.controls._pointerDown(pointer(0, 0, 0));
  assert.equal(overview.controls._mode, 'none', 'empty background cannot create a fake orbit pivot');
  const close = fixture(new THREE.Vector3(0, -20, 15));
  close.controls._pointerDown(pointer(0));
  assert.equal(close.controls._mode, 'none', 'close inspection still requires a point hit');
  close.controls._pointPick = () => new THREE.Vector3();
  close.controls._pointerDown(pointer(0));
  assert.equal(close.controls._mode, 'orbit');
});

test('repeated wheel approach to a deeper decoded point never loses orbit to the old focal plane', () => {
  const { controls, view, bounds } = fixture();
  const direction = view.getPivot().sub(view.position).normalize();
  const surface = view.getPivot().addScaledVector(direction, 40);
  bounds.expandByPoint(surface);
  controls._pointPick = () => surface.clone();
  for (let step = 0; step < 40; step++) {
    controls._wheel({ ...pointer(0), deltaY: -100 });
    controls._pointerDown(pointer(0));
    assert.equal(controls._mode, 'orbit', `real decoded point stays orbitable at step ${step}`);
  }
  const depth = surface.clone().sub(view.position).dot(direction);
  assert.ok(Math.abs(view.radius - depth) < 1e-7, 'focal depth follows the selected surface');
});

test('a newly selected foreground surface replaces stale depth without rotating the camera', () => {
  const { controls, view } = fixture();
  const forward = view.getPivot().sub(view.position).normalize();
  const surface = view.position.clone().addScaledVector(forward, 20);
  controls._pointPick = () => surface.clone();
  controls._pointerDown(pointer(0));
  assert.equal(controls._mode, 'orbit');
  assert.ok(Math.abs(view.radius - 20) < 1e-8, 'deep old pivot cannot control near-surface zoom sensitivity');
  assert.ok(view.getPivot().sub(view.position).normalize().distanceTo(forward) < 1e-9);
  controls._pointPick = () => null;
  const before = view.position.clone();
  controls._wheel({ ...pointer(0), deltaY: -100 });
  assert.ok(Math.abs(before.distanceTo(view.position) - 2) < 1e-8, 'a sparse miss uses the last actual focal depth, not the original overview distance');
});

test('off-axis decoded points rebase projected depth, preserve pose, and recover a collapsed radius', () => {
  for (const origin of [new THREE.Vector3(), new THREE.Vector3(367000, 4760000, 220)]) {
    const { controls, view } = fixture(new THREE.Vector3(0, -200, 150), origin);
    const forward = view.getPivot().sub(view.position).normalize();
    const before = view.position.clone();
    const hit = view.position.clone().addScaledVector(forward, 100).add(new THREE.Vector3(10, 0, 0));
    view.radius = 0.1;
    controls._pointPick = () => hit.clone();
    controls._pointerDown(pointer(0, 590));
    assert.equal(controls._mode, 'orbit');
    assert.ok(Math.abs(view.radius - 100) < 1e-6);
    assert.ok(view.position.distanceTo(before) < 1e-10, 'press never translates the camera');
    assert.ok(view.getPivot().sub(view.position).normalize().distanceTo(forward) < 1e-8, 'press never re-centers the clicked surface');
    controls._pointerMove(pointer(0, 610));
    assert.ok(view.position.distanceTo(before) > 1, 'recovered orbit actually moves');
  }
});

test('invalid or behind-camera decoded hits cannot poison focal depth or camera position', () => {
  const { controls, view } = fixture(new THREE.Vector3(0, -20, 15));
  const forward = view.getPivot().sub(view.position).normalize();
  const before = view.position.clone();
  const radius = view.radius;
  for (const hit of [new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(Infinity, 0, 0),
    before.clone(), before.clone().addScaledVector(forward, -10), before.clone().addScaledVector(forward, 100001)]) {
    controls._pointPick = () => hit;
    controls._pointerDown(pointer(0));
    assert.equal(controls._mode, 'none');
    assert.equal(view.radius, radius);
    assert.deepEqual(view.position.toArray(), before.toArray());
  }
  for (const scale of [NaN, Infinity, -1, 0]) controls._zoomTowards(new THREE.Vector3(), scale);
  controls._zoomTowards(new THREE.Vector3(NaN, 0, 0), 0.9);
  assert.deepEqual(view.position.toArray(), before.toArray());
});

test('decoded picker ignores hidden clouds, invalid points and behind-camera results', () => {
  const { controls, view } = fixture();
  const forward = view.getPivot().sub(view.position).normalize();
  const point = (depth) => view.position.clone().addScaledVector(forward, depth);
  const calls = [];
  const originalMaterial = {}, failedCloud = { material: originalMaterial, pick() { this.material = {}; throw new Error('node disposed during pick'); } };
  let rendererResets = 0;
  controls.viewer = { renderer: { setRenderTarget() { rendererResets++; }, state: { reset() { rendererResets++; } }, setScissorTest() { rendererResets++; } }, scene: { pointclouds: [
    { visible: false, pick() { throw new Error('hidden cloud must not be picked'); } },
    failedCloud,
    { pick() { return { position: point(-1) }; } },
    { pick() { return { position: new THREE.Vector3(NaN, 0, 0) }; } },
    { pick(viewer, camera, ray, options) { calls.push(options); return { position: point(40) }; } },
    { pick() { return { position: point(30) }; } },
  ] } };
  const hit = Controls.prototype._pointPick.call(controls, { x: 500, y: 500 });
  assert.ok(hit.distanceTo(point(30)) < 1e-10, 'nearest valid point wins across visible clouds');
  assert.equal(calls[0].pickWindowSize, 11, 'fix does not widen the pick window to grab background surfaces');
  assert.equal(failedCloud.material, originalMaterial, 'disposed-node failure restores its material and does not prevent later picks');
  assert.equal(rendererResets, 3, 'error cleanup runs once; successful picks do not add redundant renderer resets');
});
