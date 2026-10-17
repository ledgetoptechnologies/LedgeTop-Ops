import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(new URL(`../src/client/${name}`, import.meta.url), "utf8");

describe("shared portal brand", () => {
  it("shows one generic Ledge Top identity regardless of domain or workspace source", () => {
    const shell = read("PortalShell.tsx");
    expect(shell).toContain('data-portal-division="generic"');
    expect(shell).toContain("<LtMark />");
    for (const name of ["ClientPortalApp.tsx", "OperationsHomeApp.tsx", "PortalBootstrapApp.tsx"]) {
      const source = read(name);
      expect(source, name).toContain('from "./PortalShell"');
      expect(source, name).not.toMatch(/resolvePortalBrand|from "\.\/portal-brand"|BRAND\.logoUrl/);
      expect(source, name).not.toMatch(/Drone Services|Technologies/);
    }
  });

  it("keeps shared portal copy neutral", () => {
    const sharedCopy = ["ClientPortalApp.tsx", "main.tsx", "OperationsHomeApp.tsx", "PortalBootstrapApp.tsx", "PortalShell.tsx"].map(read).join("\n");
    expect(sharedCopy).not.toMatch(/\bLTDS\b|LedgeTop/);
    expect(sharedCopy).toContain("Ledge Top");
  });

  it("presents the account as customer context without claiming a verified person name", () => {
    const portal = read("ClientPortalApp.tsx");
    expect(portal).toContain("<h1>{account!.displayName}</h1>");
    expect(portal).toContain("Welcome to the client portal.");
    expect(portal).not.toContain("Hello, {account!.displayName}");
  });
});
