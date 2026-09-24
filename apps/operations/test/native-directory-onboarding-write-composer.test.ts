import { describe, expect, it } from "vitest";
import * as composer from "../src/worker/native-directory-onboarding-write-composer";
import * as profileWriter from "../src/worker/native-directory-profile-writer";
import * as relationshipWriter from "../src/worker/native-directory-relationship-writer";

describe("native Directory onboarding composer API", () => {
  it("does not export plan factories, owner capabilities, raw statement accessors, or plan executors", () => {
    expect(Object.keys(composer).sort()).toEqual([
      "approveNativeOnlyClientOnboarding", "planAndExecuteNativeDirectoryOnboardingWrites",
    ]);
    for (const forbidden of ["nativeDirectoryWritePlanOwner", "nativeDirectoryWritePlan",
      "nativeDirectoryWritePlanStatements", "executeNativeDirectoryWritePlan",
      "executeNativeDirectoryOnboardingWritePlan", "executeNativeDirectoryOnboardingWritePlans"]) {
      expect(composer).not.toHaveProperty(forbidden);
    }
  });

  it("does not expose staging callbacks that disclose prepared statements", () => {
    expect(profileWriter).not.toHaveProperty("stageNativeDirectoryProfileWrite");
    expect(relationshipWriter).not.toHaveProperty("stageNativeDirectoryRelationshipWrite");
    expect(composer).not.toHaveProperty("statements");
  });
});
