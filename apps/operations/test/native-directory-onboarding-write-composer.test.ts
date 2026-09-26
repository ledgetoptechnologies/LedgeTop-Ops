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

  it("rejects an organization plan unless it accompanies a distinct new client before database access", async () => {
    const unavailable = (): never => { throw Error("unexpected database access"); };
    const db = { prepare: unavailable, batch: unavailable, exec: unavailable,
      withSession: unavailable, dump: unavailable } as D1Database;
    const actor = { staffId: "staff-one", accessSubject: "access|staff-one", admissionVersion: 1,
      selectedGrantId: "profile-grant", loginEmail: "staff@example.test", profileVersion: 1,
      selectedIdentityGrantId: "identity-grant" };
    const scopes = [{ businessAreaId: "area-one", divisionId: null }];
    const organizationProfile = { operation: "create" as const,
      mutationId: "22222222-2222-4222-8222-222222222222",
      recordId: "33333333-3333-4333-8333-333333333333", expectedLocalVersion: 0 as const,
      kind: "organization" as const, createAdmissionId: "client-onboarding:11111111-1111-4111-8111-111111111111:organization",
      destinations: [], actor, scopes, profile: { name: "Example LLC", generalEmail: "", generalPhone: "",
        addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "", country: "US" } };
    const profile = { operation: "update" as const,
      mutationId: "44444444-4444-4444-8444-444444444444",
      recordId: "55555555-5555-4555-8555-555555555555", expectedLocalVersion: 1,
      kind: "client" as const, destinations: [], actor,
      profile: { name: "Client", email: "client@example.test", phone: "", addressLine1: "",
        addressLine2: "", city: "", state: "TX", postalCode: "", country: "US" },
      relationship: { organizationRecordId: organizationProfile.recordId, expectedRelationshipVersion: 1 } };
    await expect(composer.approveNativeOnlyClientOnboarding(db, {
      decisionId: "11111111-1111-4111-8111-111111111111",
      invitationId: "66666666-6666-4666-8666-666666666666",
      submissionId: "77777777-7777-4777-8777-777777777777", fieldsSha256: "a".repeat(64),
      requestSha256: "b".repeat(64), reason: "invalid existing-client organization plan",
      reviewedFieldsJson: "{}", scopes, verifiedUntil: "2099-01-01T00:00:00.000Z",
      organizationProfile, profile,
      relationship: { mode: "preserve", expectedVersion: 1,
        mutationId: "88888888-8888-4888-8888-888888888888" },
    })).resolves.toEqual({ status: "rejected", reason: "invalid_organization_plan" });

    await expect(composer.approveNativeOnlyClientOnboarding(db, {
      decisionId: "11111111-1111-4111-8111-111111111111",
      invitationId: "66666666-6666-4666-8666-666666666666",
      submissionId: "77777777-7777-4777-8777-777777777777", fieldsSha256: "a".repeat(64),
      requestSha256: "b".repeat(64), reason: "colliding records",
      reviewedFieldsJson: "{}", scopes, verifiedUntil: "2099-01-01T00:00:00.000Z",
      organizationProfile: { ...organizationProfile, recordId: profile.recordId },
      profile: { ...profile, operation: "create", expectedLocalVersion: 0,
        createAdmissionId: "client-onboarding:11111111-1111-4111-8111-111111111111:client",
        scopes,
        profile: { ...profile.profile, clientType: "business" } },
      relationship: { mode: "change", expectedVersion: 0,
        mutationId: "88888888-8888-4888-8888-888888888888" },
    })).resolves.toEqual({ status: "rejected", reason: "invalid_organization_plan" });
  });
});
