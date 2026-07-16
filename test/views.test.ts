import { describe, expect, it } from "vitest";
import { renderAdmin } from "../src/views";

const admin = {
  type: "staff" as const,
  id: "test-admin",
  email: "beaukoltz@ledgetopdroneservices.com",
  displayName: "Beau",
  role: "admin" as const,
};

describe("staff workspace", () => {
  it("renders separate staff navigation without a website link", () => {
    const page = renderAdmin(admin);
    expect(page).toContain("Files");
    expect(page).toContain("Delivery Links");
    expect(page).toContain("Team &amp; API");
    expect(page).not.toContain('href="https://ledgetopdroneservices.com"');
  });

  it("contains syntactically valid client-side JavaScript", () => {
    const page = renderAdmin(admin);
    const script = page.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script || "")).not.toThrow();
  });
});
