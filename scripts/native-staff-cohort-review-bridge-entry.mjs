import retainedWorker from "./index.js";
export * from "./index.js";

import { Hono } from "hono";
import {
  NATIVE_STAFF_COHORT_REVIEW_PATH as sourceRoutePath,
  registerNativeStaffCohortReviewRoute,
} from "../apps/operations/src/worker/staff-login-link-routes.ts";
import { createNativeStaffCohortReviewBridge } from "./native-staff-cohort-review-bridge.mjs";

if (sourceRoutePath !== "/api/staff/current-cohort-review") {
  throw new Error("Cohort review route path changed; review the retained-runtime bridge before building");
}

const reviewApp = new Hono();
registerNativeStaffCohortReviewRoute(reviewApp);

export default createNativeStaffCohortReviewBridge(retainedWorker, reviewApp);
