import { describe, expect, it, vi } from "vitest";
import { consumeClientOnboardingRecipientRoute } from "../src/client/client-onboarding-recipient-route";

describe("client onboarding recipient route", () => {
  it("scrubs a valid fragment immediately and returns it only in memory", () => {
    const replaceState = vi.fn();
    const invitationId = "00000000-0000-4000-8000-000000000001";
    const secret = "ab".repeat(32);
    expect(consumeClientOnboardingRecipientRoute({ pathname: `/onboarding/${invitationId}`, search: "", hash: `#${secret}` },
      { state: null, replaceState } as unknown as History)).toEqual({ invitationId, invitationSecret: secret });
    expect(replaceState).toHaveBeenCalledWith(null, "", `/onboarding/${invitationId}`);
  });
  it("scrubs malformed fragments and exposes no credential", () => {
    const replaceState = vi.fn();
    const route = consumeClientOnboardingRecipientRoute({ pathname: "/onboarding/not-an-id", search: "?x=1", hash: "#bad" },
      { state: null, replaceState } as unknown as History);
    expect(route).toEqual({ invitationId: "", invitationSecret: "" });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/onboarding/not-an-id?x=1");
  });
  it("does not touch unrelated Delivery routes", () => {
    const replaceState = vi.fn();
    expect(consumeClientOnboardingRecipientRoute({ pathname: "/s/existing", search: "", hash: "#secret" },
      { state: null, replaceState } as unknown as History)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
