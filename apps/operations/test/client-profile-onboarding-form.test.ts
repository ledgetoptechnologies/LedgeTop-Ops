import { describe, expect, it } from "vitest";
import { CLIENT_PROFILE_ONBOARDING_LIMITS, EMPTY_CLIENT_PROFILE_ONBOARDING_VALUES, clientProfileOnboardingSubmission, organizationNameRequired, valuesForClientProfileType } from "../src/client/ClientProfileOnboardingForm";

describe("ClientProfileOnboardingForm contract", () => {
  it("uses native writer limits", () => {
    expect(CLIENT_PROFILE_ONBOARDING_LIMITS).toMatchObject({ contactName: 150, email: 255, phone: 50, organizationName: 150, generalEmail: 255, generalPhone: 50, addressLine1: 255, addressLine2: 255, city: 100, region: 2, postalCode: 20, country: 100 });
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
});
