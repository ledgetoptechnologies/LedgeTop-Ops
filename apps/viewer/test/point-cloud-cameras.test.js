'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  CAMERA_MARKER_COLORS,
  CAMERA_MARKER_OPACITY,
  CAMERA_MARKER_STYLE,
  DEFAULT_CAMERA_MARKER_SCALE,
  cameraMarkerGeometryData,
  cameraMarkerLocalFrame,
  cameraMarkerScaleForView,
  selectCameraMarkerRepresentatives,
  createCameraClickTracker,
  canPickCameraHover,
  createPointCloudCameraLayer,
  normalizeCameraMarkers,
} = require('../public/pointcloud-cameras.js');

test('camera hover never raycasts during navigation, inertia, touch, or measurement insertion', () => {
  const idle = { _mode: 'none', _inertia: { active: false }, _touch: { mode: 'none' } };
  const mouse = { buttons: 0, pointerType: 'mouse' };
  assert.equal(canPickCameraHover(mouse, idle, {}), true);
  for (const buttons of [1, 2, 4]) assert.equal(canPickCameraHover({ ...mouse, buttons }, idle, {}), false);
  for (const _mode of ['orbit', 'pan', 'screenpan']) assert.equal(canPickCameraHover(mouse, { ...idle, _mode }, {}), false);
  assert.equal(canPickCameraHover(mouse, { ...idle, _inertia: { active: true } }, {}), false);
  assert.equal(canPickCameraHover({ ...mouse, pointerType: 'touch' }, idle, {}), false);
  assert.equal(canPickCameraHover(mouse, { ...idle, _touch: { mode: 'pinch' } }, {}), false);
  assert.equal(canPickCameraHover(mouse, idle, { m: true }), false);
  assert.equal(canPickCameraHover(mouse, idle, { v: true }), false);
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'pointcloud.html'), 'utf8');
  assert.match(shell, /if \(!window\.LtdsPointCloudCameras\.canPickCameraHover\(event, pcControls, insertionActive\)\)\s*\{\s*pointCloudCameraLayer\.setHovered\(-1\);\s*return;\s*\}\s*const hovered = pointCloudCameraLayer\.pick/);
});

test('8500 hidden cameras do no projection or instance uploads and show refreshes immediately', async () => {
  const THREE = await import('three');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  let cameraReads = 0, rectReads = 0;
  const dom = { getBoundingClientRect: () => { rectReads++; return { left: 0, top: 0, width: 100, height: 100 }; } };
  const layer = createPointCloudCameraLayer({ THREE, scene, dom, getCamera: () => { cameraReads++; return camera; } });
  layer.setMarkers(Array.from({ length: 8500 }, () => ({ translation: [0, 0, -2], rotation: [0, 0, 0] })));
  layer.setScale(0.75);
  for (let frame = 0; frame < 120; frame++) {
    camera.position.x = frame / 1000;
    assert.equal(layer.updateView(frame % 2 === 0), false);
  }
  assert.equal(cameraReads, 0);
  assert.equal(rectReads, 0);
  assert.equal(layer.drawnCount, 0);
  for (const mesh of layer.group.children) assert.equal(mesh.instanceMatrix.version, 0);
  layer.setVisible(true);
  assert.equal(cameraReads, 1);
  assert.equal(rectReads, 1);
  assert.equal(layer.drawnCount, 8500);
  const versions = layer.group.children.map(mesh => mesh.instanceMatrix.version);
  layer.setVisible(false);
  camera.position.x = 50;
  camera.updateMatrixWorld(true);
  assert.equal(layer.updateView(true), false);
  assert.deepEqual(layer.group.children.map(mesh => mesh.instanceMatrix.version), versions);
  layer.setVisible(true);
  assert.equal(cameraReads, 2);
  assert.equal(layer.drawnCount, 0, 'show uses the latest camera instead of the hidden-view draw list');
  layer.dispose();
});

test('point-cloud cameras use the same compact WebODM-style marker as the model', async () => {
  const model = await import('../camera-markers.mjs');
  assert.deepEqual(CAMERA_MARKER_COLORS, model.CAMERA_MARKER_COLORS);
  assert.deepEqual(CAMERA_MARKER_OPACITY, model.CAMERA_MARKER_OPACITY);
  assert.deepEqual(CAMERA_MARKER_STYLE, model.CAMERA_MARKER_STYLE);
  assert.equal(DEFAULT_CAMERA_MARKER_SCALE, model.DEFAULT_CAMERA_MARKER_SCALE);
  assert.deepEqual(cameraMarkerGeometryData(), model.cameraMarkerGeometryData());
  assert.equal(
    cameraMarkerScaleForView({ baseScale: 1, depth: 3, fovDegrees: 60, viewportHeight: 900 }),
    model.cameraMarkerScaleForView({ baseScale: 1, depth: 3, fovDegrees: 60, viewportHeight: 900 }),
  );
  assert.equal(cameraMarkerScaleForView(), 0.5);
  assert.deepEqual(
    selectCameraMarkerRepresentatives([{ index: 3, x: 10, y: 10, depth: 2 }], { width: 100, height: 100 }),
    model.selectCameraMarkerRepresentatives([{ index: 3, x: 10, y: 10, depth: 2 }], { width: 100, height: 100 }),
  );
});

test('point-cloud camera payload accepts only bounded finite poses', () => {
  const valid = { translation: [367000, 4760000, 220], rotation: [0.1, -0.2, 0.3] };
  assert.deepEqual(normalizeCameraMarkers([valid]), [valid]);
  assert.deepEqual(normalizeCameraMarkers([
    valid,
    { translation: [1, 2], rotation: [0, 0, 0] },
    { translation: [1, 2, Infinity], rotation: [0, 0, 0] },
    { translation: [1, 2, 3], rotation: [0, Number.NaN, 0] },
  ]), [valid]);
  assert.deepEqual(normalizeCameraMarkers(new Array(100_001).fill(valid)), [], 'oversized cross-frame payloads fail closed');
});

test('large projected camera positions are rebased before Float32 instance matrices', () => {
  const markers = [
    { translation: [367000.125, 4760000.25, 220.5], rotation: [0, 0, 0] },
    { translation: [367001.375, 4760002.5, 221.25], rotation: [0.1, 0.2, 0.3] },
  ];
  const frame = cameraMarkerLocalFrame(markers);
  assert.deepEqual(frame.origin, markers[0].translation);
  assert.deepEqual(frame.markers.map(marker => marker.translation), [[0, 0, 0], [1.25, 2.25, 0.75]]);
  assert.deepEqual(markers[0].translation, [367000.125, 4760000.25, 220.5], 'input payload remains immutable');
});

test('Potree r124 allocates every shared glyph instance-color buffer before the active draw count becomes zero', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'pointcloud-cameras.js'), 'utf8');
  const allocation = source.indexOf('mesh.setColorAt(0, new THREE.Color(CAMERA_MARKER_COLORS[mesh.userData.cameraMarkerComponent]))');
  const zeroCount = source.indexOf('mesh.count = 0', allocation);
  assert.ok(allocation >= 0, 'all four full-capacity instance-color buffers are initialized through the component loop');
  assert.ok(allocation < zeroCount, 'legacy Three allocates from mesh.count, so colors must precede count=0');
});

test('point-cloud hover follows source indices when viewport culling changes draw slots', async () => {
  const THREE = await import('three');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const dom = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const layer = createPointCloudCameraLayer({ THREE, scene, dom, getCamera: () => camera });
  layer.setMarkers([
    { translation: [0, 0, -2], rotation: [0, 0, 0] },
    { translation: [0.01, 0, -1], rotation: [0, 0, 0] },
    { translation: [0.8, 0, -2], rotation: [0, 0, 0] },
  ]);
  layer.setVisible(true);
  const [body] = layer.group.children;
  assert.equal(layer.group.children.length, 4, 'body, face, amber cue, and orange tab share every marker transform');
  for (const mesh of layer.group.children) {
    assert.equal(mesh.material.depthTest, false, 'Potree overlay markers must not be hidden by point-cloud depth');
    assert.equal(mesh.material.depthWrite, false);
  }
  const normal = body.getColorAt(0, new THREE.Color()).toArray();
  assert.equal(layer.setHovered(1), true);
  assert.equal(body.count, 3, 'all overlapping cameras are drawn');
  const highlighted = body.getColorAt(1, new THREE.Color()).toArray();
  assert.notDeepEqual(highlighted, normal);

  camera.position.set(0, 0, -1.5);
  camera.lookAt(0, 0, -2);
  camera.updateMatrixWorld(true);
  layer.updateView(true);
  const replacement = body.getColorAt(0, new THREE.Color()).toArray();
  replacement.forEach((component, index) => assert.ok(Math.abs(component - normal[index]) < 1e-9));
  assert.equal(layer.setHovered(0), true);
  assert.notDeepEqual(body.getColorAt(0, new THREE.Color()).toArray(), normal);
  layer.dispose();
});

test('model and cloud retain all crowded cameras through pan and depth-order changes', async () => {
  const model = await import('../camera-markers.mjs');
  const cameras = Array.from({ length: 4500 }, (_, index) => ({ index, x: 18, y: 18, depth: 1 + index }));
  for (const pan of [-8, -1, 0, 1, 8]) {
    const moved = cameras.map(candidate => ({ ...candidate, x: candidate.x + pan, depth: 5000 - candidate.depth })).reverse();
    const selected = selectCameraMarkerRepresentatives(moved, { width: 100, height: 100 });
    assert.deepEqual(selected, cameras.map(candidate => candidate.index));
    assert.deepEqual(selected, model.selectCameraMarkerRepresentatives(moved, { width: 100, height: 100 }));
  }
});

test('point-cloud instance transforms stay at capture poses during small pan and orbit', async () => {
  const THREE = await import('three');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.lookAt(0, 0, -2);
  camera.updateMatrixWorld(true);
  const dom = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const layer = createPointCloudCameraLayer({ THREE, scene, dom, getCamera: () => camera });
  layer.setMarkers([
    { translation: [0, 0, -2], rotation: [0, 0, 0] },
    { translation: [0.01, 0, -2], rotation: [0, 0, Math.PI] },
    { translation: [-0.01, 0, -2], rotation: [0, 0, 0] },
  ]);
  layer.setVisible(true);
  const snapshots = layer.group.children.map(mesh => Array.from(mesh.instanceMatrix.array));
  for (const offset of [-0.05, -0.01, 0.01, 0.05]) {
    camera.position.set(offset, 0, 0);
    camera.lookAt(offset / 2, 0, -2);
    camera.updateMatrixWorld(true);
    layer.updateView(true);
    layer.group.children.forEach((mesh, index) => {
      assert.equal(mesh.count, 3);
      assert.deepEqual(Array.from(mesh.instanceMatrix.array), snapshots[index]);
    });
  }
  layer.dispose();
});

test('camera click tracker accepts one tap and rejects drags, pinches, and cancellations', () => {
  const tracker = createCameraClickTracker({ threshold: 5 });
  tracker.pointerDown({ pointerId: 1, button: 0, clientX: 10, clientY: 20 });
  assert.deepEqual(tracker.pointerUp({ pointerId: 1, button: 0, clientX: 12, clientY: 22 }), { x: 12, y: 22 });

  tracker.pointerDown({ pointerId: 2, button: 0, clientX: 10, clientY: 20 });
  tracker.pointerMove({ pointerId: 2, clientX: 16, clientY: 20 });
  assert.equal(tracker.pointerUp({ pointerId: 2, button: 0, clientX: 16, clientY: 20 }), null);

  tracker.pointerDown({ pointerId: 3, button: 0, clientX: 10, clientY: 20 });
  tracker.pointerDown({ pointerId: 4, button: 0, clientX: 30, clientY: 40 });
  assert.equal(tracker.pointerUp({ pointerId: 4, button: 0, clientX: 30, clientY: 40 }), null);
  assert.equal(tracker.pointerUp({ pointerId: 3, button: 0, clientX: 10, clientY: 20 }), null);

  tracker.pointerDown({ pointerId: 5, button: 0, clientX: 10, clientY: 20 });
  tracker.pointerCancel({ pointerId: 5 });
  assert.equal(tracker.pointerUp({ pointerId: 5, button: 0, clientX: 10, clientY: 20 }), null);
});
