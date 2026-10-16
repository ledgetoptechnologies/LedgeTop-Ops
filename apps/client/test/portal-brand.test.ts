import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(new URL(`../src/client/${name}`, import.meta.url), "utf8");

describe("shared portal brand", () => {
  it("shows one generic Ledge Top identity regardless of domain or workspace source", () => {
    const portal = read("ClientPortalApp.tsx");
    expect(portal).toContain('data-portal-division="generic"');
    expect(portal).toContain("<LtMark />");
    expect(portal).not.toMatch(/resolvePortalBrand|from "\.\/portal-brand"|BRAND\.logoUrl/);
    expect(portal).not.toMatch(/Drone Services|Technologies/);
  });

  it("keeps shared portal copy neutral", () => {
    const sharedCopy = ["ClientPortalApp.tsx", "main.tsx"].map(read).join("\n");
    expect(sharedCopy).not.toMatch(/\bLTDS\b|Loading LedgeTop/);
    expect(sharedCopy).toContain("Ledge Top");
  });

  it("presents the account as customer context without claiming a verified person name", () => {
    const portal = read("ClientPortalApp.tsx");
    expect(portal).toContain("<h1>{account!.displayName}</h1>");
    expect(portal).toContain("Welcome to the client portal.");
    expect(portal).not.toContain("Hello, {account!.displayName}");
  });
});
