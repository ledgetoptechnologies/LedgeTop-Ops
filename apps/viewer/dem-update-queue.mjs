// Debounce edits, serialize expensive raster work and suppress stale results.
export function createDemUpdateQueue(run, { delayMs = 180, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null, running = false, ready = false, revision = 0;
  async function drain() {
    if (running || !ready) return;
    running = true; ready = false;
    const current = revision;
    try { await run(() => current === revision); } catch (error) { if (current === revision) onError(error); }
    finally { running = false; if (ready) void drain(); }
  }
  return {
    request({ immediate = false } = {}) {
      revision++; ready = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (immediate) { ready = true; void drain(); }
      else timer = setTimer(() => { timer = null; ready = true; void drain(); }, delayMs);
    },
    invalidate() { revision++; ready = false; if (timer !== null) clearTimer(timer); timer = null; },
  };
}
