import assert from 'node:assert/strict';
import test from 'node:test';
import { Group, PerspectiveCamera, Sphere, Vector3 } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { runTraversal } from '3d-tiles-renderer/src/core/renderer/tiles/traverseFunctions.js';
import { LOADED, UNLOADED } from '3d-tiles-renderer/src/core/renderer/constants.js';
import { createLodFocusPriorityPlugin, detailToErrorTarget, lodDistanceDemandTarget } from '../lod-policy.mjs';

const raw = detailToErrorTarget(20);
const config = { enabled: true };
const sample = (distance, extra = {}, options = config) => lodDistanceDemandTarget(raw, { distance, modelRadius: 100, ...extra }, options);

test('distance demand is opt-in, smooth, bounded and model-relative rather than assumed physical units', () => {
  assert.equal(sample(100, {}, null).target, raw);
  assert.equal(sample(100, {}, { enabled: false }).target, raw);
  assert.equal(sample(0).target, raw);
  assert.equal(sample(25).target, raw);
  assert.equal(sample(50).target, 512);
  assert.equal(sample(1e9).target, 512);
  const values = [25, 26, 30, 37.5, 45, 49, 50].map(distance => sample(distance).target);
  assert.deepEqual([...values].sort((a, b) => a - b), values);
  assert.ok(sample(25.001).target - raw < 0.001, 'no quality cliff at near boundary');
  assert.equal(sample(375, { modelRadius: 1000 }).target, sample(37.5).target);
  assert.equal(sample(25).nearRadius, 25);
  assert.equal(sample(30, {}, { enabled: true, nearRadiusRatio: 0.4, farRadiusRatio: 0.8 }).target, raw);
});

test('unknown bounds, a locked cut, startup and maximum-detail override remain conservative', () => {
  for (const metadata of [{ unknown: true }, { modelRadius: 0 }, { distance: Infinity }, { distance: NaN }]) {
    const result = sample(100, metadata);
    assert.equal(result.target, raw);
    assert.equal(result.ready, false);
    assert.equal(result.reason, 'unknown-bounds');
  }
  assert.equal(sample(100, { locked: true }).reason, 'locked-quality-cut');
  assert.equal(lodDistanceDemandTarget(4096, { distance: 100, modelRadius: 100 }, config).target, 4096);
  for (const detail of [2, 13, 16, 20, 23]) {
    const target = detailToErrorTarget(detail);
    assert.equal(lodDistanceDemandTarget(target, { distance: 10, modelRadius: 100 }, config).target, target);
    assert.equal(lodDistanceDemandTarget(target, { distance: 100, modelRadius: 100 }, config).target, 512 * target / raw);
  }
  assert.equal(lodDistanceDemandTarget(2, { distance: 10000, modelRadius: 100 }, config).target, 2);
});

function makeFixture(enabled = true) {
  // Real engine preprocessing, perspective SSE, frustum tests, plugin invocation
  // and installed REPLACE traversal; only fetch/scene upload are instrumented.
  const oldWindow = globalThis.window;
  globalThis.window = { location: { href: 'http://localhost/' } };
  const renderer = new TilesRenderer('http://localhost/distance-fixture.json');
  const camera = new PerspectiveCamera(70, 1.5, 0.1, 1000);
  camera.updateMatrixWorld(true);
  const state = { moving: false, lastActivityTime: 0 };
  const plugin = createLodFocusPriorityPlugin(camera, () => state);
  renderer.registerPlugin(plugin);
  renderer.setCamera(camera);
  renderer.setResolution(camera, 1200, 800);
  renderer.errorTarget = raw;
  renderer.loadAncestors = false;
  renderer.loadSiblings = false;
  renderer.__ltdsDistanceDemand = { enabled };
  const node = (name, center, radius, geometricError, children = []) => ({
    name, refine: 'REPLACE', geometricError, boundingVolume: { sphere: [...center, radius] },
    content: { uri: `${name}.glb` }, children,
  });
  const near = [-1, 1].map((side, i) => node(`near-${i}`, [side * 2, 0, -8], 1, 3,
    [node(`near-leaf-${i}`, [side * 2, 0, -8], 0.9, 0)]));
  const denominator = 2 * Math.tan(35 * Math.PI / 180) / 800;
  const background = Array.from({ length: 24 }, (_, i) => {
    // Depth-stacked background, including centered geometry behind the front
    // surfaces. This is intentionally not an x/y coplanar fixture.
    const center = [(i % 6 - 2.5) * 5, (Math.floor(i / 6) - 1.5) * 5, -65 - i];
    const distance = new Vector3(...center).length() - 2;
    return node(`background-${i}`, center, 2, 400 * distance * denominator,
      [node(`background-leaf-${i}`, center, 1, 0)]);
  });
  const root = node('root', [0, 0, -40], 100, 1000, [...near, ...background]);
  const document = { asset: { version: '1.0' }, geometricError: 1000, root };
  renderer.preprocessTileset(document, 'http://localhost/distance-fixture.json');
  if (oldWindow === undefined) delete globalThis.window;
  else globalThis.window = oldWindow;
  renderer.rootTileset = document;
  const all = [];
  const initialize = tile => {
    all.push(tile);
    tile.internal.loadingState = tile.children.length ? LOADED : UNLOADED;
    tile.engineData.scene = new Group();
    for (const child of tile.children) {
      renderer.preprocessNode(child, tile.internal.basePath, tile);
      initialize(child);
    }
  };
  initialize(root);
  const queued = new Set();
  renderer.queueTileForDownload = tile => {
    if (tile.internal.loadingState === UNLOADED) queued.add(tile.name);
  };
  renderer.markTileUsed = () => {};
  const frame = () => {
    queued.clear();
    renderer.frameCount += 1;
    camera.updateMatrixWorld(true);
    renderer.group.updateMatrixWorld(true);
    renderer.prepareForTraversal();
    runTraversal(root, renderer);
    return new Set(queued);
  };
  return { renderer, camera, plugin, state, root, near, background, all, frame };
}

test('real perspective traversal reduces medium demand without sacrificing either near wall', () => {
  const baseline = makeFixture(false);
  const experiment = makeFixture(true);
  const before = baseline.frame();
  const after = experiment.frame();
  assert.equal(before.size, 26, 'raw target requests all terminal children');
  assert.deepEqual([...after].sort(), ['near-leaf-0', 'near-leaf-1']);
  for (const branch of experiment.background) {
    assert.ok(Math.abs(branch.traversal.error - 400) < 1e-9);
    assert.equal(branch.__ltdsPeripheralErrorTarget, 512);
    assert.equal(branch.traversal.visible, true, 'authored coarse parent supplies strict cover');
    assert.equal(branch.children[0].traversal.visible, false);
  }
  for (const branch of experiment.near) assert.equal(branch.__ltdsPeripheralErrorTarget, raw);
  assert.equal(experiment.root.__ltdsPeripheralErrorTarget, raw);
  assert.ok(experiment.all.every(tile => tile.refine === 'REPLACE'));
  baseline.plugin.dispose(); experiment.plugin.dispose();
});

test('motion/cursor do not globally expand demand; small pan stays continuous and repeated poses deterministic', () => {
  const fixture = makeFixture();
  const initial = [...fixture.frame()].sort();
  fixture.state.moving = true;
  fixture.state.lastActivityTime = performance.now();
  fixture.state.ndc = { x: -0.9, y: 0.9 };
  fixture.camera.position.x += 0.02;
  assert.deepEqual([...fixture.frame()].sort(), initial);
  fixture.camera.rotation.y = 0.003;
  assert.deepEqual([...fixture.frame()].sort(), initial);
  fixture.state.moving = false;
  fixture.camera.position.x = 0;
  fixture.camera.rotation.y = 0;
  assert.deepEqual([...fixture.frame()].sort(), initial);
  fixture.renderer.errorTarget = 2;
  assert.equal(fixture.frame().size, 26, 'Detail24 explicitly resumes raw high-quality demand');
  fixture.plugin.dispose();
});

test('camera and nonuniform renderer parent transforms preserve conservative near protection', () => {
  const fixture = makeFixture();
  fixture.frame();
  const parent = new Group();
  parent.position.set(400, -230, 700);
  parent.rotation.set(0.4, 0.2, -0.3);
  parent.scale.set(2, 3, 4);
  parent.add(fixture.renderer.group);
  parent.updateMatrixWorld(true);
  fixture.camera.position.set(0, 0, 0).applyMatrix4(parent.matrixWorld);
  fixture.camera.quaternion.setFromRotationMatrix(parent.matrixWorld.clone().extractRotation(parent.matrixWorld));
  fixture.camera.updateMatrixWorld(true);
  fixture.frame();
  for (const branch of fixture.near) {
    assert.equal(branch.__ltdsPeripheralErrorTarget, raw);
    assert.equal(branch.__ltdsDistanceDemand.modelRadius, 400);
    assert.equal(branch.__ltdsDistanceDemand.nearRadius, 100);
  }
  fixture.plugin.dispose();
});

test('unknown descendant bounds and nearby descendants conservatively protect their ancestor path', () => {
  const fixture = makeFixture();
  const far = fixture.background[0];
  const child = far.children[0];
  child.engineData.boundingVolume = { getSphere: target => target.copy(new Sphere(new Vector3(0, 0, -2), 1)) };
  fixture.plugin.calculateTileViewError(fixture.root);
  fixture.plugin.calculateTileViewError(far);
  assert.equal(far.__ltdsPeripheralErrorTarget, raw, 'near child defeats even a non-enclosing far parent bound');
  fixture.renderer.frameCount += 1;
  delete child.engineData.boundingVolume;
  fixture.plugin.calculateTileViewError(far);
  assert.equal(far.__ltdsPeripheralErrorTarget, raw);
  assert.equal(far.__ltdsDistanceDemand.reason, 'unknown-bounds');
  fixture.plugin.calculateTileViewError(fixture.background[1]);
  assert.equal(fixture.background[1].__ltdsPeripheralErrorTarget, 512, 'unknown branch does not expand unrelated demand');
  fixture.plugin.dispose();
});

test('slender real OBB uses nearest surface rather than its oversized circumsphere, including rigid world transform', () => {
  const fixture = makeFixture();
  const tile = {
    name: 'slender-background', geometricError: 400, refine: 'REPLACE', children: [],
    boundingVolume: { box: [0, 0, -80, 100, 0, 0, 0, 0.5, 0, 0, 0, 0.5] },
    content: { uri: 'slender-background.glb' },
  };
  fixture.root.children.push(tile);
  fixture.renderer.preprocessNode(tile, fixture.root.internal.basePath, fixture.root);
  const sphere = new Sphere();
  tile.engineData.boundingVolume.getSphere(sphere);
  assert.equal(sphere.containsPoint(fixture.camera.position), true, 'circumsphere misleadingly contains camera');
  fixture.plugin.calculateTileViewError(tile);
  assert.equal(tile.__ltdsDistanceDemand.distance, 79.5);
  assert.equal(tile.__ltdsPeripheralErrorTarget, 512);
  fixture.renderer.group.position.set(1000, -200, 300);
  fixture.renderer.group.rotation.set(0.3, 0.8, -0.4);
  fixture.renderer.group.scale.setScalar(2);
  fixture.renderer.group.updateMatrixWorld(true);
  fixture.camera.position.set(0, 0, 0).applyMatrix4(fixture.renderer.group.matrixWorld);
  fixture.camera.updateMatrixWorld(true);
  fixture.renderer.frameCount += 1;
  fixture.plugin.calculateTileViewError(tile);
  assert.ok(Math.abs(tile.__ltdsDistanceDemand.distance - 159) < 1e-9);
  assert.ok(Math.abs(tile.__ltdsDistanceDemand.modelRadius - 200) < 1e-9);
  assert.equal(tile.__ltdsPeripheralErrorTarget, 512);
  fixture.plugin.dispose();
});

test('missing root scale and containing large bounds cannot accidentally relax quality', () => {
  const fixture = makeFixture();
  fixture.frame();
  const tile = fixture.background[0];
  tile.engineData.boundingVolume = { getSphere: sphere => sphere.set(new Vector3(0, 0, -60), 70) };
  fixture.renderer.frameCount += 1;
  fixture.plugin.calculateTileViewError(tile);
  assert.equal(tile.__ltdsDistanceDemand.distance, 0);
  assert.equal(tile.__ltdsPeripheralErrorTarget, raw);
  delete fixture.root.engineData.boundingVolume;
  fixture.renderer.frameCount += 1;
  fixture.plugin.calculateTileViewError(fixture.background[1]);
  assert.equal(fixture.background[1].__ltdsDistanceDemand.ready, false);
  assert.equal(fixture.background[1].__ltdsPeripheralErrorTarget, raw);
  fixture.plugin.dispose();
});
