// Playwright 1.62.1: page.unrouteAll() empties the route list before it waits for active handlers. As soon as
// any one handler then finishes, the page sees no routes left and turns network interception off; the server
// settles every other still-running route itself, so that handler's later route.fulfill() fails with
// "Route is already handled!". Tracking our own handlers lets a test finish them while the route is still
// installed, and only then unroute. Nothing is caught or ignored: a handler's own failure still reaches
// Playwright through the promise the handler returns.
export function routeHandlerDrain() {
  const active = new Set<Promise<unknown>>();
  return {
    /** Wraps a route handler body so the drain can wait for it. */
    track<T>(work: Promise<T>): Promise<T> {
      active.add(work);
      const settle = () => { active.delete(work); };
      work.then(settle, settle);
      return work;
    },
    /** Waits until no tracked handler is running, including ones that start while waiting. */
    async drain(): Promise<void> {
      while (active.size) await Promise.allSettled([...active]);
    },
  };
}
