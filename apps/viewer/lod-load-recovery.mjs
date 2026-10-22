const AUTH_STATUSES = new Set([401, 403]);
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

// Capability URLs remain stable when a fresh grant renews the session. An old
// request can still deliver its denial afterward. Retry that response once
// using the already-renewed access, before the renderer records it as FAILED.
// This does not request a grant or retry denials from the current generation.
export function createRenewedTileFetcher(fetchData, getGeneration) {
  return async (url, options) => {
    const generation = getGeneration();
    const response = await fetchData(url, options);
    if (AUTH_STATUSES.has(response?.status) && generation !== getGeneration() && !options?.signal?.aborted) {
      return fetchData(url, options);
    }
    return response;
  };
}

// In pinned 3d-tiles-renderer 0.5.1 FAILED is -1. resetFailedTiles changes
// loadingState but leaves the failed LRU reservation behind; its next add()
// then refuses that same tile forever. Release only failed reservations before
// resetting states, preserving every loaded fallback and in-flight request.
export function releaseFailedTileReservations(renderer) {
  const cache = renderer?.lruCache;
  if (!renderer?.traverse || !cache?.has || !cache?.remove) return 0;
  const failed = [];
  renderer.traverse(tile => {
    if (tile.internal?.loadingState === -1 && cache.has(tile)) failed.push(tile);
  }, null, false);
  for (const tile of failed) cache.remove(tile);
  return failed.length;
}

export function tileLoadFailureStatus(event) {
  for (const candidate of [event?.status, event?.error?.status, event?.error?.response?.status]) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  const message = String(event?.error?.message || event?.message || '');
  const match = message.match(/(?:http(?:\s+status)?|status|error\s+code)\D{0,12}(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

export function classifyTileLoadFailure(event) {
  const status = tileLoadFailureStatus(event);
  if (AUTH_STATUSES.has(status)) return { kind: 'authorization', status };
  if (TRANSIENT_STATUSES.has(status) || status >= 500) return { kind: 'transient', status };
  if (status !== null) return { kind: 'permanent', status };
  const message = String(event?.error?.message || event?.message || '').toLowerCase();
  if (/failed to fetch|network|timed?\s*out|connection|temporar|offline/.test(message)) {
    return { kind: 'transient', status: null };
  }
  return { kind: 'permanent', status: null };
}
