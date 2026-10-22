(function exposePointCloudAccess(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudAccess = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function pointCloudAccessFactory() {
  'use strict';

  // EPT metadata, hierarchy and LAZ fetches share the same capability root.
  // Hold a denied GET before Potree consumes it, then retry only after the
  // parent confirms a fresh grant was redeemed. Loaded nodes and tools stay live.
  function installPointCloudAccess({ window: win, eptUrl, onRequired, onRestored,
    onUnavailable, timeoutMs = 60_000 }) {
    const originalFetch = win.fetch;
    const base = new URL(eptUrl, win.location.href);
    const directory = new URL('.', base);
    let currentDirectory = directory;
    let pending = null;
    let disposed = false;
    let generation = 0;

    function inScope(input, init) {
      const method = init?.method || input?.method || 'GET';
      if (String(method).toUpperCase() !== 'GET') return false;
      try {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, win.location.href);
        return url.origin === win.location.origin && url.origin === directory.origin
          && url.pathname.startsWith(directory.pathname);
      } catch { return false; }
    }

    function finish(allowed) {
      if (!pending) return;
      const current = pending;
      pending = null;
      win.clearTimeout(current.timer);
      current.resolve(allowed);
      if (allowed) onRestored?.();
      else onUnavailable?.();
    }

    function currentInput(input) {
      if (currentDirectory.href === directory.href) return input;
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, win.location.href);
      url.pathname = currentDirectory.pathname + url.pathname.slice(directory.pathname.length);
      return typeof input === 'string' || input instanceof URL ? url.href : new win.Request(url.href, input);
    }

    function waitForAccess(signal) {
      let current = pending;
      if (!current) {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        pending = current = { promise, resolve, timer: win.setTimeout(() => finish(false), timeoutMs) };
        onRequired?.();
      }
      const promise = current.promise;
      if (!signal) return promise;
      return new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); });
      });
    }

    const wrappedFetch = async function(input, init) {
      const scoped = inScope(input, init);
      const requestGeneration = generation;
      const response = await originalFetch.call(win, scoped ? currentInput(input) : input, init);
      if (disposed || !scoped || ![401, 403].includes(response.status)) return response;
      const signal = init?.signal || input?.signal;
      if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
      // A response sent before redemption may arrive after pending was cleared.
      // Use the confirmed current access once instead of asking for a new grant.
      const allowed = requestGeneration !== generation || await waitForAccess(signal);
      if (!allowed || disposed) return response;
      const retried = await originalFetch.call(win, currentInput(input), init);
      if ([401, 403].includes(retried.status)) onUnavailable?.();
      return retried;
    };
    win.fetch = wrappedFetch;
    return {
      renewed(eptUrl) {
        if (disposed) return;
        if (eptUrl) {
          const updated = new URL(eptUrl, win.location.href);
          if (updated.origin !== win.location.origin) { finish(false); return; }
          currentDirectory = new URL('.', updated);
        }
        generation += 1;
        finish(true);
      },
      unavailable: () => finish(false),
      dispose() {
        disposed = true;
        finish(false);
        if (win.fetch === wrappedFetch) win.fetch = originalFetch;
      },
    };
  }
  return { installPointCloudAccess };
}));
