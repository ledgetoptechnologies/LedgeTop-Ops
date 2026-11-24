import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildPreviewIntent, ClientOnboardingInvitePreview } from "../src/client/ClientOnboardingInvitePreview";

const technologies = "project-alpha:secondary";
const drone = "project-alpha:primary";
const expiry = "2030-01-02T12:00:00Z";
const now = Date.parse("2030-01-01T12:00:00Z");
const options = {
  [technologies]: { clients: [{ id: "17", label: "Same name" }], organizations: [{ id: "25", label: "Same company" }] },
  [drone]: { clients: [{ id: "17", label: "Same name" }], organizations: [{ id: "25", label: "Same company" }] },
};

describe("new-client invite design preview", () => {
  it("renders Technologies first and disables both delivery actions", () => {
    const html = renderToStaticMarkup(createElement(ClientOnboardingInvitePreview, { options: { [technologies]: options[technologies] } }));
    expect(html).toMatch(/Ledge Top Technologies.*disabled=""[^>]*.*Ledge Top Drone Services/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Generate Link<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Generate and Email<\/button>/);
  });

  it.each([technologies, drone])("preserves a single destination choice for %s", sourceId => {
    expect(buildPreviewIntent(options, { [sourceId]: {} }, "", expiry, now)?.destinations)
      .toEqual([{ sourceId, clientId: null, organizationId: null }]);
  });

  it("keeps equal IDs in the two sources separate and preserves the display order", () => {
    const selection = { clientId: "17", organizationId: "25" };
    expect(buildPreviewIntent(options, { [drone]: selection, [technologies]: selection }, " fake@example.test ", expiry, now)).toEqual({
      destinations: [{ sourceId: technologies, ...selection }, { sourceId: drone, ...selection }],
      knownEmail: "fake@example.test", expiresAt: "2030-01-02T12:00:00.000Z",
    });
  });

  it("rejects a missing choice, unavailable destination, cross-source target, and expired link", () => {
    const limited = { [technologies]: options[technologies], [drone]: { clients: [], organizations: [] } };
    expect(buildPreviewIntent(options, {}, "", expiry, now)).toBeNull();
    expect(buildPreviewIntent({}, { [drone]: {} }, "", expiry, now)).toBeNull();
    expect(buildPreviewIntent(limited, { [drone]: { clientId: "17" } }, "", expiry, now)).toBeNull();
    expect(buildPreviewIntent(limited, { [drone]: { organizationId: "25" } }, "", expiry, now)).toBeNull();
    expect(buildPreviewIntent(options, { [drone]: {} }, "", expiry, Date.parse(expiry))).toBeNull();
  });
});
