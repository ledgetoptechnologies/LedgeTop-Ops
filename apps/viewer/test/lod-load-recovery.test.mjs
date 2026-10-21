import assert from 'node:assert/strict';
import test from 'node:test';
import { TilesRenderer } from '3d-tiles-renderer';
import { classifyTileLoadFailure, tileLoadFailureStatus, releaseFailedTileReservations, createRenewedTileFetcher } from '../lod-load-recovery.mjs';

test('late old-access denial retries exactly once with already-renewed access and original request options', async () => {
  let generation = 0, deliver;
  const requests = [], options = { signal: new AbortController().signal, credentials: 'same-origin' };
  const fetcher = createRenewedTileFetcher((url, value) => {
    requests.push({ url, options: value });
    return requests.length === 1 ? new Promise(resolve => { deliver = resolve; }) : Promise.resolve({ status: 200 });
  }, () => generation);
  const pending = fetcher('/stable/leaf.glb', options);
  generation = 1;
  deliver({ status: 403 });
  assert.equal((await pending).status, 200);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests, [{ url: '/stable/leaf.glb', options }, { url: '/stable/leaf.glb', options }]);
});

test('current-access and repeated denials are not retried; aborted old requests are not revived', async () => {
  let generation = 0, calls = 0;
  const fetcher = createRenewedTileFetcher(async () => { calls += 1; return { status: 403 }; }, () => generation);
  assert.equal((await fetcher('/stable/leaf.glb')).status, 403);
  assert.equal(calls, 1);
  const late = createRenewedTileFetcher(async () => { calls += 1; generation += 1; return { status: 401 }; }, () => generation);
  assert.equal((await late('/stable/leaf.glb')).status, 401);
  assert.equal(calls, 3, 'a second generation change does not cause an unbounded retry');
  const abort = new AbortController();
  const aborted = createRenewedTileFetcher(async () => { calls += 1; generation += 1; abort.abort(); return { status: 403 }; }, () => generation);
  await aborted('/stable/leaf.glb', { signal: abort.signal });
  assert.equal(calls, 4);
});

test('tile loader status is recovered from upstream error shapes and messages', () => {
  assert.equal(tileLoadFailureStatus({ error: { status: 403 } }), 403);
  assert.equal(tileLoadFailureStatus({ error: { response: { status: 429 } } }), 429);
  assert.equal(tileLoadFailureStatus({ error: new Error('Failed to fetch tile with HTTP status 503') }), 503);
  assert.equal(tileLoadFailureStatus({ error: new Error('decoder rejected bytes') }), null);
});

test('authorization and transient failures recover while permanent content failures fail closed', () => {
  assert.deepEqual(classifyTileLoadFailure({ error: new Error('Request failed with status 403') }), { kind: 'authorization', status: 403 });
  assert.deepEqual(classifyTileLoadFailure({ error: new Error('HTTP 503 Service Unavailable') }), { kind: 'transient', status: 503 });
  assert.deepEqual(classifyTileLoadFailure({ error: new TypeError('Failed to fetch') }), { kind: 'transient', status: null });
  assert.deepEqual(classifyTileLoadFailure({ error: new Error('Unexpected end of B3DM payload') }), { kind: 'permanent', status: null });
  assert.deepEqual(classifyTileLoadFailure({ error: new Error('HTTP status 404') }), { kind: 'permanent', status: 404 });
});

test('failed reservations are removed before retry while resident and in-flight tiles remain cached', () => {
  const renderer = new TilesRenderer();
  const failed = { internal: { loadingState: -1 } }, loaded = { internal: { loadingState: 4 } },
    loading = { internal: { loadingState: 2 } };
  const tiles = [failed, loaded, loading], removed = [];
  renderer.traverse = callback => tiles.forEach(callback);
  for (const tile of tiles) renderer.lruCache.add(tile, value => { value.internal.loadingState = 0; removed.push(value); });
  renderer.stats.failed = 1;
  renderer.resetFailedTiles();
  assert.equal(renderer.lruCache.add(failed, () => {}), false, 'native reset retains the failed cache reservation');
  failed.internal.loadingState = -1;
  renderer.stats.failed = 1;
  assert.equal(releaseFailedTileReservations(renderer), 1);
  renderer.resetFailedTiles();
  assert.equal(renderer.lruCache.add(failed, () => {}), true, 'the recovered tile can be admitted for retry');
  assert.deepEqual(removed, [failed]);
  assert.equal(renderer.lruCache.has(loaded), true);
  assert.equal(renderer.lruCache.has(loading), true);
  assert.equal(renderer.stats.failed, 0);
});
