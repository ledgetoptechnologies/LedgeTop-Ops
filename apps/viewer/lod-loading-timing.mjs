// Opt-in diagnostics only. Never retains tile objects, URLs, errors, or payloads.
// The pinned renderer finishes reading the body immediately before parseQueue.add;
// this boundary is not an independent Resource Timing measurement.
export function installLodLoadingTiming(tiles, { enabled = false, capacity = 256, now = () => performance.now() } = {}) {
  const limit = Math.max(1, Math.min(2048, Math.floor(Number(capacity) || 256)));
  const records = [];
  const aggregates = Object.create(null);
  const ids = new WeakMap();
  const clocks = new WeakMap();
  const restorers = [];
  let sequence = 0;
  let dropped = 0;
  let disposed = false;
  function record(stage, object, startStage = null) {
    if (!enabled || disposed || !object || (typeof object !== 'object' && typeof object !== 'function')) return;
    try {
      const timeMs = Number(now());
      if (!Number.isFinite(timeMs)) return;
      if (!ids.has(object)) ids.set(object, ++sequence);
      if (!clocks.has(object)) clocks.set(object, Object.create(null));
      const marks = clocks.get(object);
      const durationMs = startStage && Number.isFinite(marks[startStage]) ? Math.max(0, timeMs - marks[startStage]) : null;
      marks[stage] = timeMs;
      const summary = aggregates[stage] ||= { count: 0, durationCount: 0, totalDurationMs: 0, maxDurationMs: 0 };
      summary.count++;
      if (durationMs !== null) {
        summary.durationCount++;
        summary.totalDurationMs += durationMs;
        summary.maxDurationMs = Math.max(summary.maxDurationMs, durationMs);
      }
      if (records.length === limit) { records.shift(); dropped++; }
      records.push({ stage, objectId: ids.get(object), timeMs, ...(durationMs === null ? {} : { durationMs }) });
    } catch { /* Observers must never change renderer outcomes. */ }
  }
  function listen(type, callback) {
    tiles.addEventListener(type, callback);
    restorers.push(() => tiles.removeEventListener(type, callback));
  }
  if (enabled) {
    const queue = tiles.parseQueue;
    if (!queue || typeof queue.add !== 'function' || !(queue.callbacks instanceof Map)) {
      throw new Error('Loading timing requires the supported renderer parse queue.');
    }
    const original = queue.add;
    const ownDescriptor = Object.getOwnPropertyDescriptor(queue, 'add');
    const callbacks = new WeakMap();
    function wrappedAdd(item, callback, ...rest) {
      // A later wrapper can still reference us after disposal. Leave that chain
      // intact, but do not keep wrapping future jobs once observation has ended.
      if (disposed) return original.call(this, item, callback, ...rest);
      record('response-body-ready-at-parse-entry', item);
      record('parse-enqueued', item);
      function wrappedCallback(...args) {
        record('parse-start', item, 'parse-enqueued');
        let result;
        try { result = callback.apply(this, args); }
        catch (error) { record('parse-failed', item, 'parse-start'); throw error; }
        if (result instanceof Promise) {
          result.then(() => record('parse-end', item, 'parse-start'), () => record('parse-failed', item, 'parse-start'));
        } else record('parse-end', item, 'parse-start');
        return result;
      }
      callbacks.set(wrappedCallback, callback);
      return original.call(this, item, wrappedCallback, ...rest);
    }
    queue.add = wrappedAdd;
    restorers.push(() => {
      if (queue.add === wrappedAdd) {
        if (ownDescriptor) Object.defineProperty(queue, 'add', ownDescriptor);
        else delete queue.add;
      }
      // Restore queued callbacks without removing, reprioritizing, or flushing jobs.
      for (const data of queue.callbacks.values()) {
        if (callbacks.has(data.callback)) data.callback = callbacks.get(data.callback);
      }
    });
    try {
      listen('tile-download-start', event => record('download-start', event.tile));
      // load-model means accepted/decoded scene, not GPU upload or first paint.
      // The Three renderer attaches its scene when visibility becomes true.
      listen('load-model', event => record('model-ready', event.tile, 'parse-enqueued'));
      listen('tile-visibility-change', event => {
        if (event.visible) record('tile-visible', event.tile, 'parse-enqueued');
      });
    } catch (error) {
      disposed = true;
      for (const restore of restorers.reverse()) restore();
      throw error;
    }
  }
  return {
    workerObserver(stage, message) {
      const allowed = { enqueue: ['ktx-enqueued'], start: ['ktx-start', 'ktx-enqueued'], end: ['ktx-end', 'ktx-start'], failed: ['ktx-failed', 'ktx-enqueued'] };
      const mapped = Object.hasOwn(allowed, stage) ? allowed[stage] : null;
      if (mapped) record(mapped[0], message, mapped[1]);
    },
    snapshot() {
      return {
        enabled: Boolean(enabled), disposed, units: 'milliseconds', clock: 'performance.now', capacity: limit, dropped,
        responseBodyBoundary: 'parse queue entry after response body read; not independent network timing',
        visibilityDuration: 'parse entry to each visible event, including cached redisplay; not first-paint latency',
        unmeasured: ['GPU upload', 'renderer construction', 'per-tile KTX attribution'],
        records: records.map(value => ({ ...value })),
        aggregates: Object.fromEntries(Object.entries(aggregates).map(([stage, value]) => [stage, { ...value }])),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const restore of restorers.reverse()) restore();
      restorers.length = 0;
    },
  };
}
