// Pinned 3d-tiles-renderer 0.5.1 uses 0 for UNLOADED. This wrapper only
// coalesces its known-size request admission refusals, never parse completion.
const UNLOADED = 0;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

function priorityState(renderer, tile) {
  let lockedOwner = null;
  let ancestor = tile;
  for (let depth = 0; ancestor && depth < 256; depth += 1) {
    if (ancestor.__ltdsFocalOwnerLocked === true) {
      lockedOwner = ancestor;
      break;
    }
    ancestor = ancestor.parent;
  }
  return [
    renderer.__ltdsFocusOwnerState?.owner ?? null,
    tile.__ltdsFallbackOwner ?? null,
    finite(tile.__ltdsOwnerRank),
    tile.__ltdsBranchBlocker === true,
    tile.__ltdsFocalOwnerPending === true,
    tile.__ltdsFocusPending === true,
    lockedOwner,
  ];
}

function admissionState(renderer, tile) {
  const cache = renderer.lruCache;
  const frame = finite(renderer.frameCount);
  const cachedBytes = finite(cache?.cachedBytes);
  const hardBytes = finite(cache?.maxBytesSize);
  if (frame === null || cachedBytes === null || cachedBytes < 0
    || hardBytes === null || hardBytes <= 0) return null;
  return {
    frame,
    cachedBytes,
    hardBytes,
    footprint: [cache, frame, cachedBytes, hardBytes,
      cache.minBytesSize, cache.maxSize, cache.minSize, cache.itemSet?.size,
      ...priorityState(renderer, tile)],
  };
}

function sameFootprint(left, right) {
  return left?.length === right?.length && left.every((value, index) => Object.is(value, right[index]));
}

/**
 * Give one request a synchronous recovery chance, then share an unsuccessful
 * result with equal/larger requests in the same frame and ownership context.
 * The next frame always retries: changed used/pinned tiles can make eviction
 * possible even when the cache byte count has not changed. No timers, queue
 * mutations, or renderer events are introduced, and actual free space always
 * bypasses coalescing immediately.
 */
export function installLodAdmissionThrottle(renderer) {
  if (typeof renderer?.requestTileContents !== 'function') {
    throw new TypeError('LOD admission throttle requires requestTileContents');
  }
  const original = renderer.requestTileContents;
  const counters = { requests: 0, forwardedRequests: 0, suppressedRequests: 0, observedRefusals: 0 };
  const increment = key => { counters[key] = Math.min(Number.MAX_SAFE_INTEGER, counters[key] + 1); };
  let failed = null;
  let disposed = false;

  function requestTileContents(...args) {
    if (disposed || this !== renderer) return original.apply(this, args);
    increment('requests');
    const tile = args[0];
    const measurable = tile?.internal?.loadingState === UNLOADED
      && typeof renderer.getBytesUsed === 'function';
    const incomingBytes = measurable ? finite(renderer.getBytesUsed(tile)) : null;
    const state = incomingBytes !== null && incomingBytes > 0 ? admissionState(renderer, tile) : null;
    if (state && state.cachedBytes + incomingBytes > state.hardBytes
      && sameFootprint(failed?.footprint, state.footprint)
      && incomingBytes >= failed.minimumIncomingBytes) {
      increment('suppressedRequests');
      return undefined;
    }

    increment('forwardedRequests');
    const result = original.apply(this, args);
    // Real in-flight work, unknown allocations, and admitted content are never
    // throttled. An undefined return plus unchanged UNLOADED state identifies
    // the pinned renderer's synchronous prequeue refusal, not its parse path.
    if (state && result === undefined && tile.internal.loadingState === UNLOADED) {
      const after = admissionState(renderer, tile);
      const required = finite(renderer.getBytesUsed(tile));
      if (after && required !== null && required > 0
        && after.cachedBytes + required > after.hardBytes) {
        increment('observedRefusals');
        failed = {
          ...after,
          minimumIncomingBytes: sameFootprint(failed?.footprint, after.footprint)
            ? Math.min(failed.minimumIncomingBytes, required) : required,
        };
      }
    }
    return result;
  }

  renderer.requestTileContents = requestTileContents;
  return {
    snapshot() {
      return {
        enabled: !disposed,
        ...counters,
        lastRefusalFrame: failed?.frame ?? null,
        minimumRefusedBytes: failed?.minimumIncomingBytes ?? null,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (renderer.requestTileContents === requestTileContents) renderer.requestTileContents = original;
      failed = null;
    },
  };
}
