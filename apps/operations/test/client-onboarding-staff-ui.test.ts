import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeRecipientLink, validScopeChoices } from "../src/client/ClientOnboardingStaff";
import { submissionFromLocation } from "../src/client/ClientOnboardingReview";

const read = (name: string) => readFileSync(new URL(`../src/client/${name}`, import.meta.url), "utf8");
const staff = read("ClientOnboardingStaff.tsx"), review = read("ClientOnboardingReview.tsx"), api = read("onboarding-staff-api.ts");
const id = "11111111-1111-4111-8111-111111111111", secret = "d".repeat(64);

describe("client onboarding staff UI security boundary", () => {
  it("never persists or logs the one-time link or secret", () => {
    for (const source of [staff, review, api]) expect(source).not.toMatch(/localStorage|sessionStorage|console\./);
    // The link is held in memory and only handed to the clipboard or a navigation; it is never rendered as text.
    expect(staff).not.toMatch(/\{revealed\.(link|secret)\}/);
    expect(staff).not.toContain("<output");
  });

  it("uses only the bounded staff endpoints with no-store fetches", () => {
    expect(api).toContain('export const endpoint = "/api/client-onboarding/staff"');
    expect(api).toContain('cache: "no-store"');
    expect(staff).toContain("`${endpoint}/session`");
    for (const route of ["create", "reveal"]) expect(staff).toContain(`post(session, "${route}"`);
    for (const route of ["inbox", "review", "enrollment-choices", "activation-status", "approve", "existing-companies",
      "shared-company-choices", "shared-company-plan", "approve-shared-company"]) expect(review).toContain(`post(session, "${route}"`);
    expect(review).not.toContain('"reject"');
  });

  it("accepts only an https onboarding link for exactly the revealed invitation", () => {
    expect(safeRecipientLink(`https://portal.example.test/onboarding/${id}#${secret}`, id)).toBe(`https://portal.example.test/onboarding/${id}#${secret}`);
    for (const value of [`http://portal.example.test/onboarding/${id}#${secret}`, `https://portal.example.test/onboarding/other#${secret}`,
      `https://portal.example.test/onboarding/${id}?next=x#${secret}`, `https://user@portal.example.test/onboarding/${id}#${secret}`,
      `https://portal.example.test/onboarding/${id}#short`, `javascript:alert(1)//onboarding/${id}#${secret}`, null, 7])
      expect(safeRecipientLink(value, id)).toBeNull();
  });

  it("accepts only well-formed named scope choices", () => {
    const area = { businessAreaId: "area:drone", name: "Drone Services", allowAreaWide: true, divisions: [{ divisionId: "division:a", name: "A" }] };
    expect(validScopeChoices({ scopes: [area] })).toEqual([area]);
    expect(validScopeChoices({ scopes: [] })).toEqual([]);
    for (const value of [{}, { scopes: [area, area] }, { scopes: [{ ...area, name: " " }] }, { scopes: [{ ...area, businessAreaId: "../x" }] },
      { scopes: [{ ...area, allowAreaWide: false, divisions: [] }] }, { scopes: [{ ...area, divisions: [{ divisionId: "d", name: "" }] }] }])
      expect(validScopeChoices(value as Record<string, unknown>)).toBeNull();
    expect(staff).toContain('post(session, "scope-choices", {})');
    expect(staff).not.toMatch(/Business area ID|Existing client record/);
  });

  it("opens only an exact submission UUID from an email link", () => {
    expect(submissionFromLocation(`?submission=${id}`)).toBe(id);
    for (const search of ["", "?submission=../../x", "?submission=11111111-1111-1111-1111-111111111111", `?submission=${"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase()}`])
      expect(submissionFromLocation(search)).toBeNull();
  });
});
