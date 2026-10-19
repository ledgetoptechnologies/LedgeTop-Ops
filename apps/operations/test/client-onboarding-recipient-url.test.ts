import { describe, expect, it } from "vitest";
import { clientOnboardingRecipientUrl } from "../src/worker/client-onboarding-staff-http";

const id = "11111111-1111-4111-8111-111111111111";
const secret = "a".repeat(64);
describe("onboarding recipient link handoff", () => {
  it("keeps the one-time bearer in a fragment on the configured portal origin", () => {
    const result = new URL(clientOnboardingRecipientUrl("https://portal.example.test", id, secret)!);
    expect(result.pathname).toBe(`/onboarding/${id}`);
    expect(result.search).toBe("");
    expect(result.hash).toBe(`#${secret}`);
  });
  it.each([undefined, "http://portal.example.test", "https://portal.example.test/", "https://portal.example.test/path",
    "https://user@portal.example.test", "https://portal.example.test?next=https://evil.test", "https://portal.example.test#token",
    "https://portal.example.test:444"])("rejects a noncanonical origin %s", origin => {
    expect(clientOnboardingRecipientUrl(origin, id, secret)).toBeNull();
  });
  it("rejects malformed invitation identities or secrets", () => {
    expect(clientOnboardingRecipientUrl("https://portal.example.test", "../other", secret)).toBeNull();
    expect(clientOnboardingRecipientUrl("https://portal.example.test", id, `${secret}&extra`)).toBeNull();
  });
});
