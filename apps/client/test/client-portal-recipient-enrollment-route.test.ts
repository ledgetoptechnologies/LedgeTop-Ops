import { describe, expect, it, vi } from "vitest";
import { consumeClientPortalRecipientEnrollmentRoute } from "../src/client/client-portal-recipient-enrollment-route";

describe("client portal recipient enrollment route", () => {
  const intentId = "00000000-0000-4000-8000-000000000001";
  const token = "ab".repeat(32);
  it("scrubs a valid fragment immediately and returns the secret only in memory", () => {
    const replaceState = vi.fn();
    expect(consumeClientPortalRecipientEnrollmentRoute({ pathname: `/portal/recipient-enrollment/${intentId}`, search: "", hash: `#${token}` },
      { state: null, replaceState } as unknown as History)).toEqual({ intentId, opaqueToken: token });
    expect(replaceState).toHaveBeenCalledWith(null, "", `/portal/recipient-enrollment/${intentId}`);
  });
  it("scrubs and rejects query credentials and malformed fragments", () => {
    const replaceState = vi.fn();
    expect(consumeClientPortalRecipientEnrollmentRoute({ pathname: `/portal/recipient-enrollment/${intentId}`, search: `?token=${token}`, hash: "#bad" },
      { state: null, replaceState } as unknown as History)).toEqual({ intentId: "", opaqueToken: "" });
    expect(replaceState).toHaveBeenCalledWith(null, "", `/portal/recipient-enrollment/${intentId}`);
  });
  it("does not touch unrelated portal routes", () => {
    const replaceState = vi.fn();
    expect(consumeClientPortalRecipientEnrollmentRoute({ pathname: "/portal/projects", search: "", hash: "#keep" },
      { state: null, replaceState } as unknown as History)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
