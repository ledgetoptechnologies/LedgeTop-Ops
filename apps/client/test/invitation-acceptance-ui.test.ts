import { describe, expect, it, vi } from "vitest";
import { consumeInvitationToken } from "../src/client/invitation-acceptance";

describe("invitation acceptance URL handling", () => {
  it("returns a fragment token and removes it from the existing history entry", () => {
    const replaceState = vi.fn();
    const token = "A".repeat(43);
    expect(consumeInvitationToken({ pathname: "/portal/invitations/accept", search: "?source=email", hash: `#token=${token}` } as Location, { state: { key: 1 }, replaceState } as unknown as History)).toBe(token);
    expect(replaceState).toHaveBeenCalledWith({ key: 1 }, "", "/portal/invitations/accept?source=email");
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(token);
  });

  it("rejects query-only, malformed, and short tokens while still scrubbing the fragment", () => {
    for (const location of [
      { pathname: "/portal/invitations/accept", search: `?token=${"A".repeat(43)}`, hash: "" },
      { pathname: "/portal/invitations/accept", search: "", hash: "#token=short" },
      { pathname: "/portal/invitations/accept", search: "", hash: "#token=%3Cscript%3E" },
    ]) {
      const replaceState = vi.fn();
      expect(consumeInvitationToken(location as Location, { state: null, replaceState } as unknown as History)).toBeNull();
      expect(replaceState).toHaveBeenCalledWith(null, "", `${location.pathname}${location.search}`);
    }
  });
});
