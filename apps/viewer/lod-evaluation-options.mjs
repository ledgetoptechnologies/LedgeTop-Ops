// Pre-production default approved by the owner. The exact per-page value 0
// restores baseline selection; timings remain opt-in. Neither is persisted.
export function lodEvaluationOptions(search = '') {
  const query = new URLSearchParams(search);
  return Object.freeze({
    distanceDemand: query.get('lodDistanceDemand') !== '0',
    loadingTiming: query.get('lodLoadingTiming') === '1',
  });
}

export function formatJsHeap(bytes) {
  return Number.isFinite(bytes) && bytes >= 0
    ? `JS heap: ${Math.round(bytes / 1048576)} MiB`
    : 'JS heap: unavailable';
}
