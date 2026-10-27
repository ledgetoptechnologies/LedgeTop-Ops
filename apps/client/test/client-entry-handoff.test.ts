import { afterEach, describe, expect, it, vi } from "vitest";
import * as deliveryRoute from "../src/client/route";

const calls = vi.hoisted(() => ({ createRoot: vi.fn(), parsePortal: vi.fn(), parseViewer: vi.fn(),
  invitation: vi.fn(), onboarding: vi.fn(), recipient: vi.fn(), nativeRecipient: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: calls.createRoot }));
vi.mock("@ltds/ui", () => ({ AppDialogHost: () => null }));
vi.mock("../src/client/portal-route", () => ({ parseClientPortalRoute: calls.parsePortal }));
vi.mock("../src/client/ClientViewerShell", () => ({ parseClientViewerShellRoute: calls.parseViewer }));
vi.mock("../src/client/invitation-acceptance", () => ({ consumeInvitationToken: calls.invitation }));
vi.mock("../src/client/ClientOnboardingRecipientApp", () => ({ ClientOnboardingRecipientApp: () => null }));
vi.mock("../src/client/client-onboarding-recipient-route", () => ({ consumeClientOnboardingRecipientRoute: calls.onboarding }));
vi.mock("../src/client/ClientPortalRecipientEnrollmentApp", () => ({ ClientPortalRecipientEnrollmentApp: () => null }));
vi.mock("../src/client/client-portal-recipient-enrollment-route", () => ({
  consumeClientPortalRecipientEnrollmentRoute: calls.recipient,
  consumeOperationsNativeRecipientEnrollmentRoute: calls.nativeRecipient,
}));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules(); });

describe("actual Client entry handoff", () => {
  it.each([
    ["client.ledgetopdroneservices.com", "/s/public-id", "?folder=ref"],
    ["portal.ledgetopdroneservices.com", "/client-share/public-id", "?folder=ref&file=file_ref-2"],
  ])("navigates %s%s before consuming its fragment or starting the app", async (hostname, pathname, search) => {
    const replace = vi.fn();
    const replaceState = vi.fn();
    const getElementById = vi.fn();
    const consume = vi.spyOn(deliveryRoute, "consumeDeliveryRoute");
    vi.stubGlobal("window", { location: { hostname, pathname, search, hash: "#private-secret", replace },
      history: { state: null, replaceState } });
    vi.stubGlobal("document", { getElementById });

    await import("../src/client/main");

    expect(replace).toHaveBeenCalledExactlyOnceWith(`https://delivery.ledgetop.app${pathname}${search}#private-secret`);
    expect(consume).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(getElementById).not.toHaveBeenCalled();
    for (const operation of Object.values(calls)) expect(operation).not.toHaveBeenCalled();
    consume.mockRestore();
  });
});
