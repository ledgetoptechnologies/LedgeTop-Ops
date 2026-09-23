import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/client/ClientOnboardingStaff.tsx", import.meta.url), "utf8");

describe("client onboarding staff UI security boundary", () => {
  it("does not persist or log the one-time secret", () => {
    expect(source).not.toMatch(/localStorage|sessionStorage|console\./);
    expect(source).not.toContain("recipientUrl");
  });

  it("uses only the bounded staff endpoints with no-store fetches", () => {
    expect(source).toContain('const endpoint = "/api/client-onboarding/staff"');
    expect(source).toContain('cache: "no-store"');
    expect(source).toContain('`${endpoint}/session`');
    expect(source).toContain('`${endpoint}/create`');
    expect(source).toContain('`${endpoint}/reveal`');
  });
});
