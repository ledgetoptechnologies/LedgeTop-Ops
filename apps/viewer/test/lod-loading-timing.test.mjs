import test from 'node:test';
import assert from 'node:assert/strict';
import { EventDispatcher } from 'three';
import { PriorityQueue } from '../node_modules/3d-tiles-renderer/src/core/renderer/utilities/PriorityQueue.js';
import { WorkerPool } from 'three/addons/utils/WorkerPool.js';
import { installLodLoadingTiming } from '../lod-loading-timing.mjs';
import { guardKtx2WorkerPool } from '../lod-ktx2.mjs';

function renderer() {
  const tiles = new EventDispatcher();
  tiles.parseQueue = new PriorityQueue();
  tiles.parseQueue.autoUpdate = false;
  return tiles;
}

test('timing is disabled by default and never alters queue methods', () => {
  const tiles = renderer();
  const original = tiles.parseQueue.add;
  const timing = installLodLoadingTiming(tiles);
  assert.equal(tiles.parseQueue.add, original);
  timing.workerObserver('start', { url: 'secret' });
  assert.deepEqual(timing.snapshot().records, []);
  timing.dispose();
});

test('actual queue retains item, callback value, promise identity and scheduling with opt-in timing', async () => {
  const tiles = renderer();
  const queue = tiles.parseQueue;
  const maxJobs = queue.maxJobs;
  const timing = installLodLoadingTiming(tiles, { enabled: true, now: (() => { let t = 0; return () => t += 10; })() });
  const tile = { url: 'https://private/model?token=secret' };
  let resolve;
  const result = new Promise(done => { resolve = done; });
  const promise = queue.add(tile, value => { assert.equal(value, tile); return result; });
  assert.equal(promise, queue.callbacks.get(tile).promise);
  assert.equal(queue.items[0], tile);
  assert.equal(queue.flush(tile), result, 'observing a callback must not wrap its return promise');
  resolve(123);
  assert.equal(await promise, 123);
  await Promise.resolve();
  tiles.dispatchEvent({ type: 'load-model', tile });
  tiles.dispatchEvent({ type: 'tile-visibility-change', tile, visible: false });
  tiles.dispatchEvent({ type: 'tile-visibility-change', tile, visible: true });
  const snapshot = timing.snapshot();
  assert.deepEqual(snapshot.records.map(record => record.stage), ['response-body-ready-at-parse-entry', 'parse-enqueued', 'parse-start', 'parse-end', 'model-ready', 'tile-visible']);
  assert.equal(snapshot.records[2].durationMs, 10);
  assert.equal(snapshot.aggregates['tile-visible'].count, 1);
  assert.equal(queue.maxJobs, maxJobs);
  assert.equal(queue.autoUpdate, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|secret|https|token/);
  timing.dispose();
});

test('synchronous and asynchronous errors propagate unchanged and removed jobs never start', async () => {
  const tiles = renderer();
  const timing = installLodLoadingTiming(tiles, { enabled: true });
  const error = new Error('secret diagnostic content');
  const sync = {};
  const syncPromise = tiles.parseQueue.add(sync, () => { throw error; });
  const syncCheck = assert.rejects(syncPromise, value => value === error);
  tiles.parseQueue.flush(sync);
  await syncCheck;
  const async = {};
  const asyncPromise = tiles.parseQueue.add(async, () => Promise.reject(error));
  const asyncCheck = assert.rejects(asyncPromise, value => value === error);
  tiles.parseQueue.flush(async);
  await asyncCheck;
  const removed = {};
  const removedPromise = tiles.parseQueue.add(removed, () => assert.fail('removed callback ran'));
  const removedCheck = assert.rejects(removedPromise, { name: 'AbortError' });
  tiles.parseQueue.remove(removed);
  await removedCheck;
  assert.equal(timing.snapshot().aggregates['parse-failed'].count, 2);
  assert.equal(timing.snapshot().aggregates['parse-start'].count, 2);
  assert.doesNotMatch(JSON.stringify(timing.snapshot()), /secret diagnostic/);
  timing.dispose();
});

test('ring is bounded; copied snapshots cannot corrupt state; dispose restores queued callbacks', async () => {
  const tiles = renderer();
  const queue = tiles.parseQueue;
  const original = queue.add;
  const timing = installLodLoadingTiming(tiles, { enabled: true, capacity: 4 });
  for (let i = 0; i < 20; i++) tiles.dispatchEvent({ type: 'tile-download-start', tile: {} });
  const item = {};
  const callback = () => 5;
  const promise = queue.add(item, callback);
  const snapshot = timing.snapshot();
  assert.equal(snapshot.records.length, 4);
  assert.equal(snapshot.dropped, 18);
  snapshot.aggregates['download-start'].count = 0;
  snapshot.records[0].stage = 'tampered';
  assert.equal(timing.snapshot().aggregates['download-start'].count, 20);
  assert.notEqual(timing.snapshot().records[0].stage, 'tampered');
  timing.dispose(); timing.dispose();
  assert.equal(queue.add, original);
  assert.equal(Object.hasOwn(queue, 'add'), false);
  assert.equal(queue.callbacks.get(item).callback, callback);
  assert.equal(queue.flush(item), 5);
  assert.equal(await promise, 5);
  tiles.dispatchEvent({ type: 'load-model', tile: {} });
  timing.workerObserver('start', {});
  assert.deepEqual(timing.snapshot().records, snapshot.records.map((value, index) => index === 0 ? { ...value, stage: 'download-start' } : value));
});

test('clock errors never change callback result and listener setup failures restore wrappers', async () => {
  const tiles = renderer();
  const timing = installLodLoadingTiming(tiles, { enabled: true, now: () => { throw new Error('clock failed'); } });
  const tile = {};
  const promise = tiles.parseQueue.add(tile, () => 9);
  tiles.parseQueue.flush(tile);
  assert.equal(await promise, 9);
  timing.dispose();
  const original = tiles.parseQueue.add;
  tiles.addEventListener = () => { throw new Error('setup failed'); };
  assert.throws(() => installLodLoadingTiming(tiles, { enabled: true }), /setup failed/);
  assert.equal(tiles.parseQueue.add, original);
});

test('dispose preserves wrappers installed before and after timing without wrapping later callbacks', async () => {
  const tiles = renderer();
  const queue = tiles.parseQueue;
  const original = queue.add;
  let beforeCalls = 0;
  function before(...args) { beforeCalls++; return original.apply(this, args); }
  queue.add = before;
  const timing = installLodLoadingTiming(tiles, { enabled: true });
  const observed = queue.add;
  let afterCalls = 0;
  function after(...args) { afterCalls++; return observed.apply(this, args); }
  queue.add = after;
  timing.dispose();
  assert.equal(queue.add, after);
  const item = {};
  const callback = () => 17;
  const promise = queue.add(item, callback);
  assert.equal(queue.callbacks.get(item).callback, callback);
  queue.flush(item);
  assert.equal(await promise, 17);
  assert.equal(beforeCalls, 1);
  assert.equal(afterCalls, 1);
  assert.deepEqual(timing.snapshot().records, []);
});

class Worker extends EventTarget {
  postMessage(message) { this.message = message; }
  finish() { this.dispatchEvent(new MessageEvent('message', { data: { type: 'transcode', id: this.message.id } })); }
  terminate() {}
}

test('real KTX pool distinguishes queued textures from active worker work and preserves one-worker limit', async () => {
  const timing = installLodLoadingTiming(renderer(), { enabled: true });
  const pool = new WorkerPool(1);
  const worker = new Worker();
  guardKtx2WorkerPool(pool, { timeoutMs: 5_000, workerObserver: timing.workerObserver });
  pool.setWorkerCreator(() => worker);
  const first = pool.postMessage({ type: 'transcode', id: 1 });
  const second = pool.postMessage({ type: 'transcode', id: 2 });
  await Promise.resolve();
  assert.equal(pool.queue.length, 1);
  assert.equal(timing.snapshot().aggregates['ktx-enqueued'].count, 2);
  assert.equal(timing.snapshot().aggregates['ktx-start'].count, 1);
  worker.finish();
  assert.equal(timing.snapshot().aggregates['ktx-start'].count, 2);
  worker.finish();
  assert.deepEqual((await Promise.all([first, second])).map(result => result.data.id), [1, 2]);
  assert.equal(timing.snapshot().aggregates['ktx-end'].count, 2);
  assert.equal(pool.pool, 1);
  pool.dispose(); timing.dispose();
});

test('observer failure does not fail KTX work and worker failure records all affected requests', async () => {
  const pool = new WorkerPool(1);
  const worker = new Worker();
  guardKtx2WorkerPool(pool, { workerObserver: () => { throw new Error('observer'); } });
  pool.setWorkerCreator(() => worker);
  const promise = pool.postMessage({ type: 'transcode', id: 1 });
  await Promise.resolve(); worker.finish();
  assert.equal((await promise).data.id, 1);
  pool.dispose();
  const failedPool = new WorkerPool(1);
  const timing = installLodLoadingTiming(renderer(), { enabled: true });
  guardKtx2WorkerPool(failedPool, { workerObserver: timing.workerObserver });
  const failedWorker = new Worker();
  failedPool.setWorkerCreator(() => failedWorker);
  const result = Promise.allSettled([1, 2].map(id => failedPool.postMessage({ type: 'transcode', id })));
  await Promise.resolve(); failedWorker.dispatchEvent(new Event('error'));
  assert.ok((await result).every(value => value.status === 'rejected'));
  assert.equal(timing.snapshot().aggregates['ktx-failed'].count, 2);
  timing.dispose();
});
