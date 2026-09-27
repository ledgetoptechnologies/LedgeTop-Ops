import { describe, expect, it } from "vitest";
import { parseClientOnboardingEnrollmentSourceIds } from "../src/worker/client-onboarding-enrollment-selection";

describe("client onboarding enrollment source selection", () => {
  it("preserves explicit native-only selection and canonicalizes configured-source identifiers", () => {
    expect(parseClientOnboardingEnrollmentSourceIds([])).toEqual([]);
    const input = ["project-alpha:secondary", "project-alpha:primary"];
    const selected = parseClientOnboardingEnrollmentSourceIds(input);
    expect(selected).toEqual(["project-alpha:primary", "project-alpha:secondary"]);
    expect(input).toEqual(["project-alpha:secondary", "project-alpha:primary"]);
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it.each([
    null, {}, "project-alpha:primary", ["project-alpha:primary", "project-alpha:primary"],
    ["PROJECT-ALPHA:primary"], ["project-alpha:bad value"], ["project-alpha:"],
    Array.from({ length: 17 }, (_, index) => `project-alpha:source-${index}`),
  ])("rejects non-canonical, duplicate, or unbounded selection %#", value => {
    expect(parseClientOnboardingEnrollmentSourceIds(value)).toBeNull();
  });
});
