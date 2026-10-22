const MiB = 1024 ** 2;
const positive = value => Number.isFinite(value) && value > 0 ? value : 0;

/** Bound whole download -> body -> parse lifetimes, not merely HTTP concurrency.
 * Deferred tiles remain UNLOADED and are selected again by normal traversal.
 * No timer, forced visibility, SSE change, or eviction of a ready tile occurs.
 * Byte reservations are estimates, NOT a hard JS/process/GPU memory guarantee:
 * an unknown body may exceed its reservation. In that case stop admitting more
 * work until it drains; allow a known oversized tile alone to avoid starvation.
 */
export function installLodLoadingBudget(renderer, { maxInFlight, maxReservedBytes } = {}) {
  if (typeof renderer?.requestTileContents !== 'function') throw new TypeError('Loading budget requires requestTileContents');
  const original = renderer.requestTileContents;
  const previousHook = renderer.__ltdsLoadingBudget;
  const pending = new Map();
  let disposed = false;
  let drainFor = null;
  let drainFrame = 0;
  function limits() {
    const slots = Math.max(1, Math.min(8, Math.floor(positive(maxInFlight)
      || positive(renderer.downloadQueue?.maxJobs) + positive(renderer.parseQueue?.maxJobs) || 4)));
    const bytes = positive(maxReservedBytes) || Math.max(128 * MiB,
      Math.min(512 * MiB, positive(renderer.lruCache?.maxBytesSize) / 8 || 256 * MiB));
    return { slots, bytes };
  }
  function totals() {
    let reservedBytes = 0, bodyBytes = 0;
    for (const entry of pending.values()) { reservedBytes += entry.reservedBytes; bodyBytes += entry.bodyBytes; }
    return { reservedBytes, bodyBytes };
  }
  function release(tile, entry) {
    if (pending.get(tile) !== entry) return;
    pending.delete(tile);
    if (!disposed) renderer.dispatchEvent?.({ type: 'needs-update' });
  }
  const hook = {
    bodyReady(tile, content) {
      const entry = pending.get(tile);
      if (!entry) return;
      // Only store a number: never keep the response/body alive for diagnostics.
      entry.bodyBytes = positive(content?.byteLength);
      entry.reservedBytes = Math.max(entry.reservedBytes, entry.bodyBytes);
    },
  };
  function requestTileContents(...args) {
    if (disposed || this !== renderer) return original.apply(this, args);
    const tile = args[0];
    if (pending.has(tile)) return undefined;
    if (tile?.internal?.loadingState !== 0) return original.apply(this, args);
    const frame = Number.isFinite(renderer.frameCount) ? renderer.frameCount : 0;
    const waitingTile = drainFor?.deref();
    if (drainFor && (!waitingTile || waitingTile.internal?.loadingState !== 0 || frame - drainFrame > 2)) drainFor = null;
    if (drainFor && waitingTile !== tile) return undefined;
    if (drainFor) drainFrame = frame;
    const { slots, bytes } = limits();
    const estimate = Math.max(positive(renderer.getBytesUsed?.(tile)), bytes / slots);
    if (pending.size >= slots || (pending.size && totals().reservedBytes + estimate > bytes)) {
      // A large desired tile must not starve behind endless small refills.
      // Keep no strong tile reference; two frames without renewed demand drop
      // the drain barrier after a view change. Ordinary equal-size work streams.
      if (estimate > bytes / slots && !drainFor) {
        drainFor = new WeakRef(tile);
        drainFrame = frame;
      }
      return undefined;
    }
    drainFor = null;
    const entry = { reservedBytes: estimate, bodyBytes: 0 };
    pending.set(tile, entry);
    let result;
    try { result = original.apply(this, args); }
    catch (error) { release(tile, entry); throw error; }
    if (result && typeof result.then === 'function') {
      // Observe both outcomes without changing the original promise semantics.
      result.then(() => release(tile, entry), () => release(tile, entry));
    } else release(tile, entry);
    return result;
  }
  renderer.__ltdsLoadingBudget = hook;
  renderer.requestTileContents = requestTileContents;
  return {
    snapshot() {
      const { slots, bytes } = limits(), { reservedBytes, bodyBytes } = totals();
      return { enabled: !disposed, inFlight: pending.size, maxInFlight: slots,
        reservedMiB: Math.round(reservedBytes / MiB), reservationLimitMiB: Math.round(bytes / MiB),
        responseBodyMiB: Math.round(bodyBytes / MiB),
        drainingForLargeTile: Boolean(drainFor),
        overReservation: reservedBytes > bytes, byteAccounting: 'estimated-loading-reservations-not-total-memory' };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (renderer.requestTileContents === requestTileContents) renderer.requestTileContents = original;
      if (renderer.__ltdsLoadingBudget === hook) {
        if (previousHook === undefined) delete renderer.__ltdsLoadingBudget;
        else renderer.__ltdsLoadingBudget = previousHook;
      }
      pending.clear();
      drainFor = null;
    },
  };
}
