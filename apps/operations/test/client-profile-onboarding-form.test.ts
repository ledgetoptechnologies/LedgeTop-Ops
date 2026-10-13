import { describe, expect, it } from "vitest";
import { CLIENT_PROFILE_ONBOARDING_LIMITS, EMPTY_CLIENT_PROFILE_ONBOARDING_VALUES, clientProfileOnboardingFieldMaxLength, clientProfileOnboardingSubmission, organizationNameRequired, valuesForClientProfileType } from "@ltds/ui/client-profile-onboarding";

describe("ClientProfileOnboardingForm contract", () => {
  it("uses native writer limits", () => {
    expect(CLIENT_PROFILE_ONBOARDING_LIMITS).toMatchObject({ contactName: 150, email: 255, phone: 50, organizationName: 150, generalEmail: 255, generalPhone: 50, addressLine1: 255, addressLine2: 255, city: 100, region: { individual: 2, organization: 100 }, postalCode: { individual: 20, organization: 32 }, country: 100 });
  });
  it("clears organization fields when selecting an individual", () => {
    const organization = { ...EMPTY_CLIENT_PROFILE_ONBOARDING_VALUES, profileType: "organization" as const, organizationName: "LedgeTop", generalEmail: "office@example.test", generalPhone: "555-0100" };
    expect(valuesForClientProfileType(organization, "individual")).toMatchObject({ organizationName: "", generalEmail: "", generalPhone: "" });
    expect(clientProfileOnboardingSubmission({ ...organization, profileType: "individual" })).toMatchObject({ organizationName: "", generalEmail: "", generalPhone: "" });
  });
  it("requires an organization name only for organization onboarding", () => {
    expect(organizationNameRequired("organization")).toBe(true);
    expect(organizationNameRequired("individual")).toBe(false);
  });
  it("uses the writer limit for the selected profile type", () => {
    expect(clientProfileOnboardingFieldMaxLength("region", "individual")).toBe(2);
    expect(clientProfileOnboardingFieldMaxLength("region", "organization")).toBe(100);
    expect(clientProfileOnboardingFieldMaxLength("postalCode", "individual")).toBe(20);
    expect(clientProfileOnboardingFieldMaxLength("postalCode", "organization")).toBe(32);
  });
});
