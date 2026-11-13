// Fixture asset handlers may still be active after the visible UI assertions finish. Drain the handlers
// already admitted (including work added while draining) before removing their routes. This does not wait
// for future browser requests after the set becomes empty, or establish the cause of every "Route is already
// handled!" error. In particular, the retained CI trace's late image fulfillment preceded explicit unrouteAll.
// A handler's own rejection still reaches Playwright through the SAME promise the handler returns.
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
