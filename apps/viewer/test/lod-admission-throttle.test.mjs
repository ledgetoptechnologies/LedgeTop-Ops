import assert from 'node:assert/strict';
import test from 'node:test';
import { TilesRenderer } from '3d-tiles-renderer';
import { installLodAdmissionThrottle } from '../lod-admission-throttle.mjs';

function fixture() {
  const tiles = {
    frameCount: 7,
    lruCache: { cachedBytes: 980, maxBytesSize: 1000, minBytesSize: 100, itemSet: new Map() },
    __ltdsFocusOwnerState: { owner: null },
    calls: 0, pressureEvents: 0, onPressure: null,
    getBytesUsed(tile) { return tile.bytes; },
    requestTileContents(tile, extra) {
      this.calls += 1;
      assert.equal(extra, 'argument', 'the wrapper preserves original arguments and receiver');
      if (tile.internal.loadingState !== 0) return undefined;
      if (tile.bytes > 0 && this.lruCache.cachedBytes + tile.bytes > this.lruCache.maxBytesSize) {
        this.pressureEvents += 1;
        this.onPressure?.(tile);
        if (this.lruCache.cachedBytes + tile.bytes > this.lruCache.maxBytesSize) return undefined;
      }
      tile.internal.loadingState = 1;
      this.lruCache.cachedBytes += Math.max(0, tile.bytes || 0);
      return tile.result;
    },
  };
  const tile = (bytes = 40) => ({ bytes, internal: { loadingState: 0 }, result: {} });
  const throttle = installLodAdmissionThrottle(tiles);
  const request = value => tiles.requestTileContents(value, 'argument');
  return { tiles, tile, throttle, request };
}

test('5694 known over-budget attempts share one failed recovery per frame without I/O', () => {
  const renderer = new TilesRenderer('https://example.invalid/tileset.json');
  const MiB = 1024 * 1024;
  renderer.frameCount = 10;
  renderer.lruCache.maxBytesSize = 3840 * MiB;
  renderer.lruCache.cachedBytes = 3816 * MiB;
  renderer.getBytesUsed = () => 96 * MiB;
  let pressureEvents = 0, fetches = 0, parses = 0;
  renderer.addEventListener('tile-memory-pressure', () => pressureEvents++);
  renderer.fetchData = () => { fetches++; throw new Error('unexpected download'); };
  renderer.parseTile = () => { parses++; throw new Error('unexpected parse'); };
  const tiles = Array.from({ length: 40 }, (_, index) => ({
    content: { uri: `fine-${index}.b3dm` },
    internal: { loadingState: 0, basePath: 'https://example.invalid' },
    engineData: { scene: null },
  }));
  const throttle = installLodAdmissionThrottle(renderer);
  for (let index = 0; index < 5694; index++) renderer.requestTileContents(tiles[index % tiles.length]);
  assert.equal(pressureEvents, 1);
  assert.equal(fetches, 0);
  assert.equal(parses, 0);
  assert.equal(tiles.every(tile => tile.internal.loadingState === 0), true);
  assert.deepEqual(throttle.snapshot(), {
    enabled: true, requests: 5694, forwardedRequests: 1, suppressedRequests: 5693,
    observedRefusals: 1, lastRefusalFrame: 10, minimumRefusedBytes: 96 * MiB,
  });
  renderer.frameCount += 1;
  renderer.requestTileContents(tiles[0]);
  assert.equal(pressureEvents, 2, 'next-frame eviction opportunities are not delayed by a timer');
  throttle.dispose();
});

test('the first request always gets synchronous recovery and preserves its original result', () => {
  const { tiles, tile, request, throttle } = fixture();
  tiles.onPressure = () => { tiles.lruCache.cachedBytes = 900; };
  const incoming = tile();
  assert.equal(request(incoming), incoming.result);
  assert.equal(incoming.internal.loadingState, 1);
  assert.equal(tiles.pressureEvents, 1);
  assert.equal(throttle.snapshot().observedRefusals, 0);
  throttle.dispose();
});

test('smaller byte tiers retry and actual free space always bypasses coalescing', () => {
  const { tiles, tile, request, throttle } = fixture();
  request(tile(40));
  request(tile(30));
  request(tile(35));
  assert.equal(tiles.pressureEvents, 2, 'a failed smaller allocation subsumes larger failures');
  assert.equal(throttle.snapshot().suppressedRequests, 1);
  const fits = tile(20);
  assert.equal(request(fits), fits.result);
  assert.equal(fits.internal.loadingState, 1);
  assert.equal(tiles.pressureEvents, 2);

  tiles.lruCache.cachedBytes = 900;
  const nowFits = tile(40);
  assert.equal(request(nowFits), nowFits.result);
  assert.equal(nowFits.internal.loadingState, 1, 'same-frame released headroom is usable immediately');
  throttle.dispose();
});

test('frame, bytes, budget, floor, and owner-priority changes get a fresh recovery chance', () => {
  const { tiles, tile, request, throttle } = fixture();
  const incoming = tile(100);
  request(incoming);
  const changes = [
    () => { tiles.frameCount += 1; },
    () => { tiles.lruCache.cachedBytes -= 1; },
    () => { tiles.lruCache.maxBytesSize += 1; },
    () => { tiles.lruCache.minBytesSize -= 1; },
    () => { tiles.__ltdsFocusOwnerState.owner = {}; },
    () => { incoming.__ltdsFallbackOwner = {}; },
    () => { incoming.__ltdsOwnerRank = 0; },
    () => { incoming.__ltdsBranchBlocker = true; },
    () => { incoming.parent = { __ltdsFocalOwnerLocked: true }; },
  ];
  for (const change of changes) {
    const before = tiles.pressureEvents;
    request(incoming);
    assert.equal(tiles.pressureEvents, before);
    change();
    request(incoming);
    assert.equal(tiles.pressureEvents, before + 1);
  }
  throttle.dispose();
});

test('the failure footprint is recorded after synchronous recovery changes the floor', () => {
  const { tiles, tile, request, throttle } = fixture();
  tiles.onPressure = () => { tiles.lruCache.minBytesSize = 50; };
  request(tile());
  request(tile());
  assert.equal(tiles.pressureEvents, 1);
  assert.equal(throttle.snapshot().suppressedRequests, 1);
  throttle.dispose();
});

test('unknown bytes, in-flight content, and missing frame metadata pass through unchanged', () => {
  const { tiles, tile, request, throttle } = fixture();
  request(tile());
  const before = tiles.calls;
  for (const bytes of [0, undefined, NaN]) {
    const incoming = tile();
    incoming.bytes = bytes;
    assert.equal(request(incoming), incoming.result);
  }
  for (const loadingState of [1, 2, 3, 4, 5]) {
    const incoming = tile();
    incoming.internal.loadingState = loadingState;
    assert.equal(request(incoming), undefined);
    assert.equal(incoming.internal.loadingState, loadingState);
  }
  assert.equal(tiles.calls, before + 8);
  tiles.frameCount = undefined;
  request(tile());
  request(tile());
  assert.equal(tiles.calls, before + 10, 'unknown frame state cannot permanently suppress work');
  throttle.dispose();
});

test('wrapper leaves post-parse methods/events alone and restores exact method identity on disposal', () => {
  const renderer = {
    frameCount: 1,
    requestTileContents() { return this.value; },
    parseTile() {},
    value: {},
  };
  const original = renderer.requestTileContents;
  const parse = renderer.parseTile;
  const throttle = installLodAdmissionThrottle(renderer);
  assert.equal(renderer.requestTileContents(), renderer.value);
  const snapshot = throttle.snapshot();
  snapshot.requests = -1;
  assert.equal(throttle.snapshot().requests, 1);
  assert.equal(renderer.parseTile, parse);
  throttle.dispose();
  throttle.dispose();
  assert.equal(renderer.requestTileContents, original);
  assert.equal(renderer.parseTile, parse);
  assert.equal(throttle.snapshot().enabled, false);
  assert.equal(throttle.snapshot().lastRefusalFrame, null);
});

test('disposal does not overwrite a later wrapper installed by another owner', () => {
  const { tiles, throttle } = fixture();
  const later = () => {};
  tiles.requestTileContents = later;
  throttle.dispose();
  assert.equal(tiles.requestTileContents, later);
});
