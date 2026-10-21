import assert from 'node:assert/strict';
import test from 'node:test';

import { FAILED, LOADED, UNLOADED } from '3d-tiles-renderer/src/core/renderer/constants.js';
import { runTraversal } from '3d-tiles-renderer/src/core/renderer/tiles/traverseFunctions.js';
import { visibleLodTargetSatisfied } from '../lod-policy.mjs';

function makeTile({ name, error, loadingState, depth, children = [] }) {
  const tile = {
    name,
    refine: 'REPLACE',
    geometricError: children.length ? 64 / (depth + 1) : 0,
    parent: null,
    children,
    traversal: {
      lastFrameVisited: 0,
      used: true,
      inFrustum: true,
      isLeaf: false,
      visible: false,
      active: false,
      error,
      distanceFromCamera: 10 + depth,
      allChildrenReady: false,
      allChildrenLoaded: false,
      kicked: false,
      allUsedChildrenProcessed: true,
    },
    internal: {
      depth,
      hasContent: true,
      hasRenderableContent: true,
      hasUnrenderableContent: false,
      loadingState,
      virtualChildCount: 0,
    },
  };
  for (const child of children) child.parent = tile;
  return tile;
}

function makeRenderer(errors) {
  const retained = new Set();
  const queued = new Set();
  return {
    frameCount: 1,
    errorTarget: 32,
    maxDepth: Infinity,
    loadAncestors: true,
    loadSiblings: false,
    loadAncestorSiblings: false,
    displayActiveTiles: false,
    retained,
    queued,
    stats: { used: 0, inFrustum: 0, active: 0, visible: 0 },
    ensureChildrenArePreprocessed() {},
    calculateTileViewErrorWithPlugin(tile, target) {
      target.inView = true;
      target.error = errors.get(tile);
      target.distanceFromCamera = 10 + tile.internal.depth;
    },
    markTileUsed(tile) { retained.add(tile); },
    queueTileForDownload(tile) { queued.add(tile); },
    invokeOnePlugin(callback) {
      callback({
        setTileActive() {},
        setTileVisible() {},
        setEmptyTileVisible() {},
      });
    },
  };
}

function nextFrame(renderer) {
  renderer.frameCount += 1;
  renderer.retained.clear();
  renderer.queued.clear();
  Object.assign(renderer.stats, { used: 0, inFrustum: 0, active: 0, visible: 0 });
}

for (const nestedWrapper of [false, true]) {
  test(`failed replacement retains scoped fallback without ancestor loading${nestedWrapper ? ' through an external wrapper' : ''}`, () => {
    const failed = makeTile({ name: 'failed', error: 0, loadingState: FAILED, depth: nestedWrapper ? 3 : 2 });
    const wrapper = makeTile({ name: 'wrapper', error: 60, loadingState: LOADED, depth: 2, children: [failed] });
    Object.assign(wrapper.internal, { hasRenderableContent: false, hasUnrenderableContent: true });
    const shell = makeTile({ name: 'shell', error: 80, loadingState: LOADED, depth: 1, children: [nestedWrapper ? wrapper : failed] });
    const root = makeTile({ name: 'root', error: 100, loadingState: LOADED, depth: 0, children: [shell] });
    const renderer = makeRenderer(new Map([[root, 100], [shell, 80], [wrapper, 60], [failed, 0]]));
    renderer.loadAncestors = false;
    renderer.lodFallbackTiles = new Set([shell]);
    runTraversal(root, renderer);
    assert.equal(shell.traversal.visible, true, 'FAILED never counts as a visible replacement');
    assert.equal(failed.traversal.visible, false);
    assert.equal(root.traversal.visible, false, 'strict replacement prevents coarse overlap');
    failed.internal.loadingState = LOADED;
    nextFrame(renderer);
    runTraversal(root, renderer);
    assert.equal(shell.traversal.visible, false);
    assert.equal(failed.traversal.visible, true);
  });
}

test('bounded regional preparation holds a loaded owner then promotes strict regional replacement', () => {
  assert.equal(LOADED, 4, 'built traversal patch pins the public LOADED constant');
  const near = makeTile({ name: 'near', error: 0, loadingState: LOADED, depth: 3 });
  const cold = makeTile({ name: 'cold', error: 0, loadingState: UNLOADED, depth: 3 });
  const nearRegion = makeTile({ name: 'near-region', error: 80, loadingState: LOADED, depth: 2, children: [near] });
  const farRegion = makeTile({ name: 'far-region', error: 80, loadingState: LOADED, depth: 2, children: [cold] });
  const owner = makeTile({ name: 'owner', error: 100, loadingState: LOADED, depth: 1, children: [nearRegion, farRegion] });
  const root = makeTile({ name: 'root', error: 200, loadingState: LOADED, depth: 0, children: [owner] });
  const renderer = makeRenderer(new Map([[root, 200], [owner, 100], [nearRegion, 80], [farRegion, 80], [near, 0], [cold, 0]]));
  renderer.loadAncestors = false;
  renderer.lodFallbackTiles = new Set([owner]);
  owner.__ltdsRegionalCoverPreparing = true;
  runTraversal(root, renderer);
  assert.equal(owner.traversal.visible, true);
  assert.equal(near.traversal.visible, false);
  assert.equal(renderer.queued.has(cold), false, 'preparation does not demand fine descendants');
  delete owner.__ltdsRegionalCoverPreparing;
  renderer.lodFallbackTiles.add(nearRegion);
  renderer.lodFallbackTiles.add(farRegion);
  nextFrame(renderer);
  runTraversal(root, renderer);
  assert.equal(near.traversal.visible, true);
  assert.equal(farRegion.traversal.visible, true);
  assert.equal(owner.traversal.visible, false);
  assert.equal(nearRegion.traversal.visible, false);
  assert.equal(cold.traversal.visible, false);
});

test('REPLACE traversal refines ready branches while a pending branch retains its own parent', () => {
  const detailA1 = makeTile({ name: 'detail-a-1', error: 20, loadingState: LOADED, depth: 2 });
  const detailA2 = makeTile({ name: 'detail-a-2', error: 20, loadingState: LOADED, depth: 2 });
  const detailB1 = makeTile({ name: 'detail-b-1', error: 20, loadingState: LOADED, depth: 2 });
  const detailB2 = makeTile({ name: 'detail-b-2', error: 20, loadingState: FAILED, depth: 2 });
  const branchA = makeTile({
    name: 'branch-a', error: 80, loadingState: LOADED, depth: 1, children: [detailA1, detailA2],
  });
  const branchB = makeTile({
    name: 'branch-b', error: 80, loadingState: LOADED, depth: 1, children: [detailB1, detailB2],
  });
  const root = makeTile({
    name: 'root', error: 100, loadingState: LOADED, depth: 0, children: [branchA, branchB],
  });
  root.traversal.active = true;
  root.traversal.visible = true;
  const errors = new Map([
    [root, 100], [branchA, 80], [branchB, 80],
    [detailA1, 20], [detailA2, 20], [detailB1, 20], [detailB2, 20],
  ]);
  const renderer = makeRenderer(errors);

  runTraversal(root, renderer);

  assert.equal(root.traversal.visible, false, 'loaded immediate branch parents let the root refine without overlap');
  assert.equal(branchA.traversal.visible, false, 'the complete branch parent is replaced by its detail');
  assert.equal(detailA1.traversal.visible, true);
  assert.equal(detailA2.traversal.visible, true);
  assert.equal(branchB.traversal.visible, true, 'only the incomplete branch retains its own parent fallback');
  assert.equal(detailB1.traversal.visible, false, 'a fallback parent kicks even a ready descendant in its branch');
  assert.equal(detailB2.traversal.visible, false, 'a failed renderable child never retires its branch fallback');
  assert.equal(renderer.retained.has(detailA1), true, 'ready replacement content remains cached');
  assert.equal(renderer.retained.has(detailB1), true, 'loaded pending-branch detail is retained until its sibling arrives');
  assert.equal(visibleLodTargetSatisfied(root, renderer.errorTarget), false,
    'warmup waits while the incomplete branch still needs coarse fallback');

  detailB2.internal.loadingState = UNLOADED;
  nextFrame(renderer);
  runTraversal(root, renderer);

  assert.equal(root.traversal.visible, false);
  assert.equal(branchB.traversal.visible, true, 'the branch parent remains while failed detail is retried');
  assert.equal(detailB2.traversal.visible, false);
  assert.equal(renderer.queued.has(detailB2), true, 'the reset branch detail is queued again');
  assert.equal(visibleLodTargetSatisfied(root, renderer.errorTarget), false);

  detailB2.internal.loadingState = LOADED;
  nextFrame(renderer);
  runTraversal(root, renderer);

  assert.equal(root.traversal.visible, false);
  assert.equal(branchB.traversal.visible, false, 'the branch parent retires after its own replacements are ready');
  assert.equal(detailB1.traversal.visible, true);
  assert.equal(detailB2.traversal.visible, true);
  assert.equal(renderer.retained.has(root), true,
    'a just-replaced loaded ancestor remains cached for small camera reversals');
  assert.equal(visibleLodTargetSatisfied(root, renderer.errorTarget), true,
    'the completed replacement frontier allows staged warmup to converge');
});

test('scoped overview fallback survives camera return without enabling all ancestors', () => {
  const detailA = makeTile({ name: 'detail-a', error: 20, loadingState: LOADED, depth: 2 });
  const detailB = makeTile({ name: 'detail-b', error: 20, loadingState: UNLOADED, depth: 2 });
  const overview = makeTile({
    name: 'overview', error: 80, loadingState: LOADED, depth: 1, children: [detailA, detailB],
  });
  const root = makeTile({
    name: 'root', error: 100, loadingState: LOADED, depth: 0, children: [overview],
  });
  const errors = new Map([[root, 100], [overview, 80], [detailA, 20], [detailB, 20]]);
  const renderer = makeRenderer(errors);
  renderer.loadAncestors = false;
  renderer.lodFallbackTiles = new Set([overview]);

  runTraversal(root, renderer);

  assert.equal(root.traversal.visible, false, 'the root is replaced by the selected overview branch');
  assert.equal(overview.traversal.visible, true,
    'the captured overview tile stands in for its incomplete selected descendants after camera return');
  assert.equal(detailA.traversal.visible, false, 'ready detail waits behind its incomplete branch sibling');
  assert.equal(detailB.traversal.visible, false);
  assert.equal(renderer.queued.has(detailB), true, 'the missing descendant continues loading');
  assert.equal(renderer.loadAncestors, false, 'unrelated ancestors remain evictable');
});
