import { describe, expect, it } from "vitest";
import { projectAlphaDirectoryReviewSources } from "../src/client/ProjectAlphaDirectoryReconciliationReview";

describe("Project Alpha directory reconciliation source selection", () => {
  it("retains the reviewed production pair without requiring staging configuration", () => {
    expect(projectAlphaDirectoryReviewSources("ops.ledgetopdroneservices.com")).toEqual([
      "project-alpha:primary", "project-alpha:secondary",
    ]);
  });

  it("uses every explicitly enabled staging API-v2 source", () => {
    expect(projectAlphaDirectoryReviewSources("ops-staging.ledgetopdroneservices.com", {
      sources: ["project-alpha:ltds-staging", "project-alpha:ltt-staging"],
      stagingDirectoryOwnerViewGrantEnabled: true,
    })).toEqual(["project-alpha:ltds-staging", "project-alpha:ltt-staging"]);
  });

  it.each([
    undefined,
    { sources: [] },
    { sources: ["project-alpha:ltt-staging", "project-alpha:ltt-staging"] },
    { sources: ["https://example.test"] },
    { sources: ["project-alpha:staging", "private-api-key"] },
  ])("fails closed for an invalid staging source list: %j", sources => {
    expect(() => projectAlphaDirectoryReviewSources("ops-staging.ledgetopdroneservices.com", sources)).toThrow();
  });
});
