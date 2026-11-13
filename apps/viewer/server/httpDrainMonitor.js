'use strict';

// Aggregate counts only: never log request URLs, headers, identities or bytes.
function createHttpDrainMonitor({ intervalMs = 15_000, log = console.warn } = {}) {
  let active = 0;
  let timer = null;
  let draining = false;
  function track(_req, res, next) {
    active += 1;
    let settled = false;
    const settle = () => { if (!settled) { settled = true; active -= 1; } };
    res.once('finish', settle);
    res.once('close', settle);
    next();
  }
  function start(server) {
    if (draining) return;
    draining = true;
    const report = () => server.getConnections((error, sockets) => {
      if (!draining) return;
      log(`[shutdown] waiting for HTTP drain: activeRequests=${active} openSockets=${error ? 'unknown' : sockets}`);
    });
    report();
    timer = setInterval(report, intervalMs);
    timer.unref?.();
  }
  function stop() { draining = false; if (timer) clearInterval(timer); timer = null; }
  return { track, start, stop };
}
module.exports = { createHttpDrainMonitor };
