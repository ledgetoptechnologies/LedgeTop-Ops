// Classic script: must run before the application's module dependency graph.
// This channel reports progress only. It grants no access and never reports ready.
(() => {
  'use strict';
  if (window.parent === window) return;
  const started = performance.now();
  const phases = new Set(['shell-loaded', 'module-started', 'redeem-started', 'redeem-http',
    'session-applied', 'init-returned', 'ready-sent', 'bootstrap-failed']);
  const statuses = new Set([200, 400, 401, 403, 404, 409, 410, 429, 500, 502, 503, 504]);
  const history = [];
  let binding = null;
  let closed = false;
  function close() {
    closed = true;
    history.length = 0;
    binding = null;
    window.removeEventListener('message', receive);
    clearTimeout(timer);
  }
  function live() {
    if (!closed && performance.now() - started >= 60_000) close();
    return !closed;
  }
  function send(item) {
    try {
      binding.source.postMessage({ version: 1, type: 'ltds-viewer:startup-phase',
        nonce: binding.nonce, ...item }, binding.origin);
    } catch { /* Diagnostics must not interfere with session startup. */ }
  }
  function mark(phase, status) {
    if (!live() || !phases.has(phase) || history.length >= 16) return;
    const item = { phase, sequence: history.length + 1 };
    if (phase === 'redeem-http') item.status = statuses.has(status) ? status : 'other';
    history.push(item);
    if (binding) send(item);
  }
  function receive(event) {
    if (!live() || event.source !== window.parent || binding) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).sort().join(',') !== 'nonce,type,version'
      || data.version !== 1 || data.type !== 'ltds-viewer:startup-probe'
      || typeof data.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(data.nonce)) return;
    try {
      const origin = new URL(event.origin);
      if (origin.protocol !== 'https:' || origin.origin !== event.origin) return;
    } catch { return; }
    binding = { source: event.source, origin: event.origin, nonce: data.nonce };
    for (const item of history) send(item);
  }
  const timer = setTimeout(close, 60_000);
  Object.defineProperty(window, '__ltdsViewerStartupDiagnostics', {
    value: Object.freeze({ mark }), enumerable: false,
  });
  window.addEventListener('message', receive);
  mark('shell-loaded');
})();
