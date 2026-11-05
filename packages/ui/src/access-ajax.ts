import { useSyncExternalStore } from "react";

/**
 * Cloudflare Access redirects an expired or revoked session to its HTML sign-in page, which a fetch can only
 * see as a CORS or redirect failure. Requests carrying this header get a 401 instead:
 * https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#ajax
 */
const ACCESS_AJAX_HEADER = "X-Requested-With";
const ACCESS_AJAX_VALUE = "XMLHttpRequest";

/** Only this site's own API: storage tickets, signed media and third-party services never get the header. */
function isSameOriginApi(url: string, origin: string) {
  try {
    const parsed = new URL(url, origin);
    return parsed.origin === origin && parsed.pathname.startsWith("/api/");
  } catch { return false; }
}

/**
 * Wraps fetch for this site's API calls. A 401 that isn't the app's own JSON came from Access, and it counts as
 * the sign-in ending only after an API call has succeeded on this page: a page that never got in already shows
 * its own recovery screen. A 403 is a membership answer, never an expired sign-in.
 */
export function accessAjaxFetch(fetcher: typeof fetch, origin: string, onSessionEnded: () => void): typeof fetch {
  let signedIn = false;
  return async (input, init) => {
    const request = input instanceof Request ? input : null;
    if (!isSameOriginApi(request ? request.url : String(input), origin)) return fetcher(input, init);
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.set(ACCESS_AJAX_HEADER, ACCESS_AJAX_VALUE);
    const response = await fetcher(input, { ...init, headers });
    if (response.ok) signedIn = true;
    else if (signedIn && response.status === 401 && !response.headers.get("Content-Type")?.includes("json")) onSessionEnded();
    return response;
  };
}

let sessionEnded = false;
const listeners = new Set<() => void>();

/** Call once, before the app renders. */
export function installAccessAjax() {
  globalThis.fetch = accessAjaxFetch(globalThis.fetch.bind(globalThis), location.origin, () => {
    if (sessionEnded) return;
    sessionEnded = true;
    listeners.forEach(listener => listener());
  });
}

export function useAccessSessionEnded() {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => sessionEnded, () => false);
}
