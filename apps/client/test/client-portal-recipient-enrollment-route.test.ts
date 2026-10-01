import { describe, expect, it, vi } from "vitest";
import { consumeClientPortalRecipientEnrollmentRoute, consumeOperationsNativeRecipientEnrollmentRoute }
  from "../src/client/client-portal-recipient-enrollment-route";

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

describe("native Operations recipient route", () => {
  const intentId = "00000000-0000-4000-8000-000000000001", token = "ab".repeat(32);
  const pathname = `/portal/operations-recipient-enrollment/${intentId}`;
  it("scrubs native consent tokens before requests and keeps the protocol route distinct", () => {
    const replaceState = vi.fn(), history = { state: null, replaceState };
    const stagingOrigin = "https://client-staging.ledgetopdroneservices.com";
    expect(consumeClientPortalRecipientEnrollmentRoute({ pathname, search: "", hash: `#${token}` }, history)).toBeNull();
    expect(consumeOperationsNativeRecipientEnrollmentRoute({ origin: stagingOrigin, pathname, search: "", hash: `#${token}` }, history))
      .toEqual({ intentId, opaqueToken: token });
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, "", pathname);
  });
  it("admits only the primary staging portal origin and scrubs foreign-host bearer fragments", () => {
    const historyFor = () => {
      const replaceState = vi.fn();
      return { history: { state: null, replaceState }, replaceState };
    };
    for (const origin of ["https://client-staging.ledgetopdroneservices.com"]) {
      const { history, replaceState } = historyFor();
      expect(consumeOperationsNativeRecipientEnrollmentRoute({ origin, pathname, search: "", hash: `#${token}` }, history))
        .toEqual({ intentId, opaqueToken: token });
      expect(replaceState).toHaveBeenCalledOnce();
    }
    for (const origin of ["https://portal-staging.ledgetoptechnologies.com", "https://project-alpha.ledgetopdroneservices.com", "https://client.ledgetopdroneservices.com",
      "http://client-staging.ledgetopdroneservices.com", "https://client-staging.evil.example"]) {
      const { history, replaceState } = historyFor();
      expect(consumeOperationsNativeRecipientEnrollmentRoute({ origin, pathname, search: "", hash: `#${token}` }, history)).toBeNull();
      expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, "", pathname);
    }
  });
  it("rejects query tokens and does not reinterpret legacy links", () => {
    const replaceState = vi.fn(), history = { state: null, replaceState };
    expect(consumeOperationsNativeRecipientEnrollmentRoute({ origin: "https://client-staging.ledgetopdroneservices.com", pathname, search: `?token=${token}`, hash: `#${token}` }, history))
      .toEqual({ intentId: "", opaqueToken: "" });
    expect(consumeOperationsNativeRecipientEnrollmentRoute({ origin: "https://client-staging.ledgetopdroneservices.com", pathname: `/portal/recipient-enrollment/${intentId}`,
      search: "", hash: `#${token}` }, history)).toBeNull();
  });
});
