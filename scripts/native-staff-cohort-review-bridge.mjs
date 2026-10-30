/**
 * Runtime-safe delegation boundary for the separately reviewed staff cohort
 * read endpoint. The retained runtime remains the source of every other
 * request and exported handler.
 */
export const NATIVE_STAFF_COHORT_REVIEW_PATH = "/api/staff/current-cohort-review";

/**
 * @typedef {object} RetainedWorker
 * @property {(request: Request, env: unknown, ctx: unknown) => unknown} fetch
 * @property {(...args: unknown[]) => unknown} queue
 * @property {(...args: unknown[]) => unknown} scheduled
 */

/**
 * @param {RetainedWorker} retained
 * @param {{fetch: (request: Request, env: unknown, ctx: unknown) => unknown}} reviewHandler
 */
export function createNativeStaffCohortReviewBridge(retained, reviewHandler) {
  if (!retained || typeof retained.fetch !== "function" || typeof retained.queue !== "function" ||
      typeof retained.scheduled !== "function" || !reviewHandler || typeof reviewHandler.fetch !== "function") {
    throw new TypeError("Retained handler must expose fetch, queue, and scheduled; review handler must expose fetch");
  }

  return Object.freeze({
    fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === NATIVE_STAFF_COHORT_REVIEW_PATH) {
        return Reflect.apply(reviewHandler.fetch, reviewHandler, [request, env, ctx]);
      }
      return Reflect.apply(retained.fetch, retained, [request, env, ctx]);
    },
    queue(...args) {
      return Reflect.apply(retained.queue, retained, args);
    },
    scheduled(...args) {
      return Reflect.apply(retained.scheduled, retained, args);
    },
  });
}
