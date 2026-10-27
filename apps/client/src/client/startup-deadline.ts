/** How long the first sign-in check may take before the page offers recovery instead of loading forever. */
export const STARTUP_DEADLINE_MS = 20_000;

export class StartupTimeout extends Error {
  constructor() { super("Ledge Top didn't respond in time."); this.name = "StartupTimeout"; }
}

/**
 * Runs one read-only startup check with its own deadline. The read gets a signal that aborts on unmount or at the
 * deadline, and the result settles at the deadline even if the transport ignores that abort; a late answer is dropped.
 * The caller's signal is never aborted here, so its existing "still mounted" checks still let the failure render.
 * Never use this for writes: it neither retries nor knows whether a timed-out request reached the server.
 */
export function withStartupDeadline<T>(read: (signal: AbortSignal) => Promise<T>, outer: AbortSignal, ms = STARTUP_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = new AbortController();
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outer.removeEventListener("abort", unmounted);
      finish();
    };
    const unmounted = () => settle(() => reject(outer.reason));
    const timer = setTimeout(() => {
      const timeout = new StartupTimeout();
      deadline.abort(timeout);
      settle(() => reject(timeout));
    }, ms);
    if (outer.aborted) { unmounted(); return; }
    outer.addEventListener("abort", unmounted, { once: true });
    try {
      read(AbortSignal.any([outer, deadline.signal])).then(value => settle(() => resolve(value)), caught => settle(() => reject(caught)));
    } catch (caught) {
      settle(() => reject(caught));
    }
  });
}
