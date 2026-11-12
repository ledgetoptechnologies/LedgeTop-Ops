// Bound raster reads across map layers. Cancelling one tile must not abort
// GeoTIFF's shared in-flight range request, which can serve another tile.
export function createRasterTileQueue({ concurrency = 2 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid raster concurrency');
  const pending = [];
  let active = 0;
  const aborted = () => new DOMException('Raster tile no longer needed', 'AbortError');
  function drain() {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      if (job.cancelled) continue;
      job.started = true;
      active++;
      Promise.resolve().then(() => {
        if (job.cancelled) throw aborted();
        return job.task(() => job.cancelled);
      }).then(value => {
        if (job.cancelled) job.reject(aborted());
        else job.resolve(value);
      }, job.reject).finally(() => {
        job.cleanup();
        active--;
        drain();
      });
    }
  }
  return {
    enqueue(task, { signal } = {}) {
      const job = { task, started: false, cancelled: false };
      const promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
      function cancel() {
        if (job.cancelled) return;
        job.cancelled = true;
        if (!job.started) {
          const index = pending.indexOf(job);
          if (index !== -1) pending.splice(index, 1);
          job.cleanup();
          job.reject(aborted());
        }
      }
      job.cleanup = () => signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) cancel();
      else {
        signal?.addEventListener('abort', cancel, { once: true });
        pending.push(job);
        queueMicrotask(drain);
      }
      return { promise, cancel, get cancelled() { return job.cancelled; } };
    },
    snapshot() { return { active, pending: pending.length }; },
  };
}
