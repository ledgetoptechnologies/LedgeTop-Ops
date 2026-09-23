import { describe, expect, it } from "vitest";
import * as composer from "../src/worker/native-directory-onboarding-write-composer";

describe("native Directory onboarding composer API", () => {
  it("does not export plan factories, owner capabilities, raw statement accessors, or plan executors", () => {
    expect(Object.keys(composer).sort()).toEqual(["planAndExecuteNativeDirectoryOnboardingWrites"]);
    for (const forbidden of ["nativeDirectoryWritePlanOwner", "nativeDirectoryWritePlan",
      "nativeDirectoryWritePlanStatements", "executeNativeDirectoryWritePlan",
      "executeNativeDirectoryOnboardingWritePlan", "executeNativeDirectoryOnboardingWritePlans"]) {
      expect(composer).not.toHaveProperty(forbidden);
    }
  });
});
