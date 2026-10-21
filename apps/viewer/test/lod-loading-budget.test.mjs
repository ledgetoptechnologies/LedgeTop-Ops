import assert from 'node:assert/strict';
import test from 'node:test';
import { TilesRenderer } from '3d-tiles-renderer';
import { installLodLoadingBudget } from '../lod-loading-budget.mjs';

const MiB = 1024 ** 2;
const flush = () => new Promise(resolve => setImmediate(resolve));
function mock(options = {}) {
  const jobs = [], events = [];
  const renderer = {
    downloadQueue: { maxJobs: 8 }, parseQueue: { maxJobs: 2 },
    lruCache: { maxBytesSize: 3840 * MiB },
    getBytesUsed: tile => tile.bytes || 0,
    dispatchEvent: event => events.push(event.type),
    requestTileContents(tile) {
      if (tile.refuse) return undefined;
      if (tile.throw) throw new Error('request failed');
      tile.internal.loadingState = 1;
      return new Promise((resolve, reject) => jobs.push({ tile, resolve, reject }));
    },
  };
  const original = renderer.requestTileContents;
  const budget = installLodLoadingBudget(renderer, options);
  const tile = bytes => ({ bytes, internal: { loadingState: 0 } });
  return { renderer, budget, tile, jobs, events, original };
}

test('full-lifecycle window bounds hundreds of selected requests without changing deferred tiles', async () => {
  const { renderer, budget, tile, jobs, events } = mock();
  const candidates = Array.from({ length: 200 }, () => tile(0));
  candidates.forEach(t => renderer.requestTileContents(t));
  assert.equal(jobs.length, 8);
  assert.equal(budget.snapshot().inFlight, 8);
  assert(candidates.slice(8).every(t => t.internal.loadingState === 0));
  jobs[0].resolve(); await flush();
  assert(events.includes('needs-update'));
  renderer.requestTileContents(candidates[8]);
  assert.equal(jobs.length, 9, 'new work progresses immediately on the next traversal');
  assert.equal(budget.snapshot().inFlight, 8);
  budget.dispose();
});

test('measured body growth closes admission until existing work drains; oversized known tile progresses alone', async () => {
  const { renderer, budget, tile, jobs } = mock({ maxReservedBytes: 64 * MiB, maxInFlight: 4 });
  const first = tile(0);
  renderer.requestTileContents(first);
  renderer.__ltdsLoadingBudget.bodyReady(first, { byteLength: 96 * MiB });
  assert.equal(budget.snapshot().responseBodyMiB, 96);
  assert.equal(budget.snapshot().overReservation, true);
  renderer.requestTileContents(tile(0));
  assert.equal(jobs.length, 1);
  jobs[0].resolve(); await flush();
  renderer.requestTileContents(tile(128 * MiB));
  assert.equal(jobs.length, 2, 'large root/content is not permanently starved');
  budget.dispose();
});

test('refusal, throw, rejection and repeated disposal release reservations', async () => {
  const { renderer, budget, tile, jobs, original } = mock();
  renderer.requestTileContents({ ...tile(), refuse: true });
  assert.throws(() => renderer.requestTileContents({ ...tile(), throw: true }));
  assert.equal(budget.snapshot().inFlight, 0);
  const result = renderer.requestTileContents(tile());
  jobs[0].reject(new Error('decode failed'));
  await assert.rejects(result, /decode failed/); await flush();
  assert.equal(budget.snapshot().inFlight, 0);
  budget.dispose(); budget.dispose();
  assert.equal(renderer.requestTileContents, original);
  assert.equal(renderer.__ltdsLoadingBudget, undefined);
});

test('large desired tiles drain small work without starvation; absent demand expires the barrier', async () => {
  const { renderer, budget, tile, jobs } = mock({ maxInFlight: 4, maxReservedBytes: 64 * MiB });
  renderer.frameCount = 1;
  for (let i = 0; i < 4; i++) renderer.requestTileContents(tile(0));
  const large = tile(128 * MiB);
  for (let i = 0; i < 4; i++) {
    jobs[i].resolve(); await flush();
    renderer.frameCount++;
    renderer.requestTileContents(large);
    renderer.requestTileContents(tile(0));
  }
  assert.equal(jobs.length, 5);
  assert.equal(jobs[4].tile, large, 'small refills must not starve the larger target');
  jobs[4].resolve(); await flush();
  renderer.requestTileContents(tile());
  renderer.requestTileContents(tile(128 * MiB));
  assert.equal(budget.snapshot().drainingForLargeTile, true);
  renderer.frameCount += 3;
  renderer.requestTileContents(tile());
  assert.equal(budget.snapshot().drainingForLargeTile, false, 'obsolete target does not hold admission after a camera change');
  budget.dispose();
});

test('pinned built renderer bounds downloaded buffers and releases after real parse and abort', async () => {
  const renderer = new TilesRenderer('https://example.invalid/tileset.json');
  renderer.downloadQueue.autoUpdate = false;
  renderer.parseQueue.autoUpdate = false;
  renderer.downloadQueue.priorityCallback = null;
  renderer.parseQueue.priorityCallback = null;
  renderer.lruCache.maxBytesSize = 3840 * MiB;
  renderer.lruCache.scheduleUnload = () => {};
  const budget = installLodLoadingBudget(renderer, { maxInFlight: 4 });
  let downloads = 0, parsed = 0;
  renderer.fetchData = async () => { downloads++; return new Response(new Uint8Array(16)); };
  renderer.parseTile = async () => { parsed++; };
  renderer.getBytesUsed = () => 0;
  const candidates = Array.from({ length: 70 }, (_, i) => ({
    content: { uri: `tile-${i}.b3dm` }, internal: { loadingState: 0, basePath: 'https://example.invalid' },
    engineData: { scene: null }, children: [], traversal: { visible: false, active: false },
  }));
  const promises = candidates.map(t => renderer.requestTileContents(t));
  renderer.downloadQueue.tryRunJobs();
  for (let i = 0; i < 10 && renderer.parseQueue.items.length < 4; i++) await flush();
  assert.equal(downloads, 4);
  assert.equal(renderer.parseQueue.items.length, 4, 'the old unbounded body backlog cannot form');
  assert.equal(budget.snapshot().inFlight, 4);
  assert(candidates.slice(4).every(t => t.internal.loadingState === 0));
  renderer.lruCache.remove(candidates[0]);
  await flush();
  assert.equal(budget.snapshot().inFlight, 3, 'aborted queued parsing settles the full-lifecycle slot');
  while (renderer.parseQueue.items.length) { renderer.parseQueue.tryRunJobs(); await flush(); }
  await Promise.all(promises);
  assert.equal(parsed, 3);
  assert.equal(budget.snapshot().inFlight, 0);
  budget.dispose(); renderer.dispose();
});
