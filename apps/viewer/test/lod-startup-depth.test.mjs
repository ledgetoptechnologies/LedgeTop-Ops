import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { LOADED, UNLOADED } from '3d-tiles-renderer/src/core/renderer/constants.js';
import { runTraversal } from '3d-tiles-renderer/src/core/renderer/tiles/traverseFunctions.js';
import { detailToErrorTarget, LOD_PREFETCH_MAX_DEPTH } from '../lod-policy.mjs';

// Execute the actual application listener. Its browser/session dependencies
// are irrelevant to the depth transition and are stubbed, but no startup logic
// is duplicated here. The resulting renderer then uses the installed traversal.
const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const listenerStart = main.indexOf("  rendererInstance.addEventListener('load-root-tileset',");
const listenerEnd = main.indexOf("  rendererInstance.addEventListener('load-tileset',", listenerStart);
assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, 'application root listener is present');
const listenerSource = main.slice(listenerStart, listenerEnd);

function tile(name, depth, children = [], renderable = true) {
  const result = {
    name, parent: null, children, refine: 'REPLACE',
    geometricError: children.length ? 100 / (depth + 1) : 0,
    traversal: { lastFrameVisited: -1 },
    internal: {
      depth, loadingState: renderable ? UNLOADED : LOADED,
      hasContent: renderable, hasRenderableContent: renderable,
      hasUnrenderableContent: false, virtualChildCount: 0,
    },
  };
  for (const child of children) child.parent = result;
  return result;
}

function startup({ renderableRoot = false, reduced = false } = {}) {
  const fine = tile('fine', 3);
  const region = tile('region', 2, [fine]);
  const shell = tile('shell', 1, [region]);
  const root = tile('root', 0, [shell], renderableRoot);
  const requested = new Set();
  const queued = new Set();
  let listener;
  const renderer = {
    root, maxDepth: LOD_PREFETCH_MAX_DEPTH, errorTarget: 4096,
    frameCount: 1, loadAncestors: false, loadSiblings: false,
    displayActiveTiles: false,
    stats: { used: 0, inFrustum: 0, active: 0, visible: 0 },
    addEventListener(name, callback) {
      assert.equal(name, 'load-root-tileset');
      listener = callback;
    },
    requestTileContents(value) { requested.add(value); },
    queueTileForDownload(value) { queued.add(value); },
    markTileUsed() {},
    ensureChildrenArePreprocessed() {},
    calculateTileViewErrorWithPlugin(value, target) {
      target.inView = true;
      target.error = value.children.length ? 100 : 0;
      target.distanceFromCamera = 10;
    },
    invokeOnePlugin(callback) {
      callback({ setTileActive() {}, setTileVisible() {}, setEmptyTileVisible() {} });
    },
  };
  const context = {
    rendererInstance: renderer, tilesRenderer: renderer,
    lodRuntimeProfileState: { activeDetail: reduced ? 13 : 20, reduced },
    lodBootstrapPhase: 'root', lodWarmupComplete: false, lodErrorScale: 1,
    state: {}, LOD_PROVENANCE: {}, LOD_PROVENANCE_VERIFIED: true,
    GLB_URL: '/audit.glb', OBJ_URL: '',
    inspectLodTileset: () => ({ valid: true, canConvergeToZeroError: true }),
    inspectLodProvenance: () => ({ valid: true }),
    decideLodStartup: () => ({ action: 'stream-lod' }),
    failLod: reason => assert.fail(reason),
    detailToErrorTarget,
    tilesetWorldBounds: () => null,
    emitLodDebugSnapshot() {},
  };
  vm.runInNewContext(listenerSource, context);
  listener({ tileset: { root } });
  return { renderer, root, shell, region, fine, requested, queued, context };
}

test('non-renderable root releases bootstrap depth and requests deep camera-selected detail', () => {
  const f = startup();
  assert.equal(f.context.lodBootstrapPhase, 'complete');
  assert.equal(f.renderer.maxDepth, Infinity);
  assert.equal(f.renderer.errorTarget, 5.481);
  assert.equal(f.requested.size, 0, 'no nonexistent root content is requested');
  runTraversal(f.root, f.renderer);
  assert.ok(f.queued.has(f.fine), 'fine content below depth two is requested');
  assert.equal(f.queued.has(f.shell), false, 'bootstrap does not trap selection at the first shell');
});

test('renderable root keeps bounded bootstrap and explicitly requests its overview first', () => {
  const f = startup({ renderableRoot: true });
  assert.equal(f.context.lodBootstrapPhase, 'root');
  assert.equal(f.renderer.maxDepth, LOD_PREFETCH_MAX_DEPTH);
  assert.equal(f.renderer.errorTarget, 4096);
  assert.deepEqual([...f.requested], [f.root]);
});

test('non-renderable reduced-memory root releases depth without bypassing the detail cap', () => {
  const f = startup({ reduced: true });
  assert.equal(f.renderer.maxDepth, Infinity);
  assert.equal(f.renderer.errorTarget, detailToErrorTarget(13));
  assert.equal(f.context.lodRuntimeProfileState.activeDetail, 13);
  assert.equal(f.context.lodWarmupComplete, true);
  assert.equal(f.context.state.lodRuntimeProfile.reduced, true);
});
