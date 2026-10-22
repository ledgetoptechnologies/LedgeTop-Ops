// Only the small storage DTO is refreshed; expanded run panels are untouched.
export function createStorageUsagePoll({ shouldPoll, read, onResult, onError, intervalMs = 2500, maxAttempts = 300, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, controller = null, generation = 0, attempts = 0, failures = 0, exhausted = false;
  function stop() { generation++; if (timer !== null) clearTimer(timer); timer = null; controller?.abort(); controller = null; attempts = 0; failures = 0; exhausted = false; }
  function sync() {
    if (!shouldPoll()) { stop(); return; }
    if (timer !== null || controller || exhausted) return;
    if (attempts >= maxAttempts) { exhausted = true; onError('Storage measurement is still running. Use Refresh to check again.'); return; }
    timer = setTimer(tick, intervalMs);
  }
  async function tick() {
    timer = null;
    if (!shouldPoll()) { stop(); return; }
    const epoch = generation, request = new AbortController(); controller = request; attempts++;
    try { const value = await read(request.signal); if (epoch === generation && shouldPoll()) { failures = 0; onResult(value); } }
    catch (error) { if (epoch === generation && error?.name !== 'AbortError' && ++failures >= 3) { exhausted = true; onError('Storage refresh could not finish. Use Refresh to retry.'); } }
    finally { if (epoch === generation) { controller = null; sync(); } }
  }
  return { sync, stop };
}
