export const VIEWER_SESSION_STORAGE_PREFIX = 'ltds-viewer-access-token:';

function viewerSessionKey(key) {
  return typeof key === 'string' && key.startsWith(VIEWER_SESSION_STORAGE_PREFIX)
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(key.slice(VIEWER_SESSION_STORAGE_PREFIX.length));
}

/**
 * One page's Viewer session capabilities. Storage is optional persistence, not
 * authority: all tokens still require the server's normal session checks.
 * Keep this store private to the Viewer module, never on window or in a URL.
 */
export function createViewerSessionCapabilityStore({ storage = () => globalThis.sessionStorage } = {}) {
  // A null entry is an intentional removal. It must win over a stale stored
  // value even if a browser refuses removeItem, or later permits reads again.
  const page = new Map();
  return Object.freeze({
    read(key) {
      if (!viewerSessionKey(key)) return null;
      if (page.has(key)) return page.get(key);
      try {
        const value = storage()?.getItem(key);
        if (typeof value === 'string' && value) {
          page.set(key, value);
          return value;
        }
      } catch { /* The storage getter and methods may both be denied. */ }
      return null;
    },
    write(key, value) {
      if (!viewerSessionKey(key) || typeof value !== 'string' || !value) return;
      // The newest server-issued capability must be usable by this page even
      // when persistence is blocked or out of quota.
      page.set(key, value);
      try { storage()?.setItem(key, value); } catch { /* Page memory remains current. */ }
    },
    clear(key) {
      if (!viewerSessionKey(key)) return;
      page.set(key, null);
      try { storage()?.removeItem(key); } catch { /* Never revive the stored value in this page. */ }
    },
  });
}
