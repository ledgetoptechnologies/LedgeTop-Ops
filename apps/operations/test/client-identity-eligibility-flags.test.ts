import { describe, expect, it } from "vitest";
import { eligibilityBlockManagementEnabled } from "../src/worker/client-identity-eligibility";

describe("client identity eligibility block management rollout", () => {
  it("remains off until enforcement and management flags are both enabled", () => {
    expect(eligibilityBlockManagementEnabled({})).toBe(false);
    expect(eligibilityBlockManagementEnabled({ CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true" })).toBe(false);
    expect(eligibilityBlockManagementEnabled({ CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true" })).toBe(false);
    expect(eligibilityBlockManagementEnabled({
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true",
    })).toBe(true);
  });
});
