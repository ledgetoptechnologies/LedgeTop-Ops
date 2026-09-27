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

  it("rejects sparse, accessor-backed, and throwing arrays without invoking an accessor", () => {
    const sparse = new Array<string>(1);
    expect(parseClientOnboardingEnrollmentSourceIds(sparse)).toBeNull();
    const accessor = ["project-alpha:primary"];
    let accessed = false;
    Object.defineProperty(accessor, 0, { get() { accessed = true; return "project-alpha:primary"; } });
    expect(parseClientOnboardingEnrollmentSourceIds(accessor)).toBeNull();
    expect(accessed).toBe(false);
    const throwing = new Proxy(["project-alpha:primary"], {
      getOwnPropertyDescriptor() { throw Error("untrusted trap"); },
    });
    expect(parseClientOnboardingEnrollmentSourceIds(throwing)).toBeNull();
  });
});
