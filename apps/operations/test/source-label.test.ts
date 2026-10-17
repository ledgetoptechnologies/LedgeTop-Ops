import { describe, expect, it } from "vitest";
import { sourceDisplayName } from "../src/client/source-label";

describe("staff source label", () => {
  it("prefers a meaningful custom server name", () => {
    expect(sourceDisplayName("Acme Field Office", "project-alpha:primary")).toBe("Acme Field Office");
    expect(sourceDisplayName("Project Alpha West", "project-alpha:secondary")).toBe("Project Alpha West");
  });
  it("replaces generic Project Alpha placeholders with the business name", () => {
    expect(sourceDisplayName("Project Alpha", "project-alpha:primary")).toBe("Ledge Top Drone Services");
    expect(sourceDisplayName("  project   ALPHA ", "project-alpha:secondary")).toBe("Ledge Top Technologies");
    expect(sourceDisplayName("Project Alpha (primary)", "project-alpha:primary")).toBe("Ledge Top Drone Services");
    expect(sourceDisplayName("Project Alpha (Secondary)", "project-alpha:secondary")).toBe("Ledge Top Technologies");
    expect(sourceDisplayName("Project Alpha", "project-alpha:staging")).toBe("Project Alpha (staging)");
    expect(sourceDisplayName("Project Alpha", null)).toBe("Project Alpha");
  });
  it("replaces raw or missing server names with the business display name", () => {
    expect(sourceDisplayName("project-alpha:secondary", "project-alpha:secondary")).toBe("Ledge Top Technologies");
    expect(sourceDisplayName(" project-alpha:primary ", "project-alpha:primary")).toBe("Ledge Top Drone Services");
    expect(sourceDisplayName("project-alpha:staging", "project-alpha:staging")).toBe("Project Alpha (staging)");
    expect(sourceDisplayName(null, "project-alpha:secondary")).toBe("Ledge Top Technologies");
    expect(sourceDisplayName("", undefined)).toBe("Unknown Project Alpha source");
  });
});
