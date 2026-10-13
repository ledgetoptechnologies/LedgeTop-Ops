import { describe, expect, it } from "vitest";
import { projectAdoptionReviewFailureMessage } from "../src/client/project-adoption-review-message";

describe("Project adoption review failure messages", () => {
  const blockedReasons = [
    ["configuration", "connection is not configured"],
    ["destination", "destination is already reserved"],
    ["authority", "current Operations authority"],
    ["local_state", "destination is no longer unused"],
    ["directory", "directory identity is missing or changed"],
    ["relationship", "relationship is not valid"],
    ["remote", "evidence could not be validated safely"],
    ["stale_evidence", "inspect the existing destination before creating a new review"],
  ] as const;

  it.each(blockedReasons)("explains the allowlisted blocked reason %s", (reason, expected) => {
    const message = projectAdoptionReviewFailureMessage("blocked", reason);
    expect(message).toContain(expected);
    expect(message).toContain("Reset only after reviewing server state");
    expect(message).toContain("do not submit a replacement request");
  });

  it.each(["internal database detail", "constructor"])("does not expose the unknown blocked reason %s", reason => {
    const message = projectAdoptionReviewFailureMessage("blocked", reason);
    expect(message).toBe("Project adoption review was not completed. Reset only after reviewing server state; do not submit a replacement request.");
    expect(message).not.toContain(reason);
  });

  it("retains the frozen-key reconciliation direction for uncertain outcomes", () => {
    expect(projectAdoptionReviewFailureMessage("uncertain", "database")).toBe(
      "Project adoption review outcome is uncertain. The same frozen request key is retained; retry only after operator review.",
    );
  });
});
