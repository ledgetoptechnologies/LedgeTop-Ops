import { describe, expect, it } from "vitest";
import { sourceDisplayName } from "../src/client/source-label";

describe("staff source label", () => {
  it("prefers a meaningful server name", () => {
    expect(sourceDisplayName("Project Alpha", "project-alpha:primary")).toBe("Project Alpha");
  });
  it("replaces raw or missing server names with the business display name", () => {
    expect(sourceDisplayName("project-alpha:secondary", "project-alpha:secondary")).toBe("Ledge Top Technologies");
    expect(sourceDisplayName(" project-alpha:primary ", "project-alpha:primary")).toBe("Ledge Top Drone Services");
    expect(sourceDisplayName("project-alpha:staging", "project-alpha:staging")).toBe("Project Alpha (staging)");
    expect(sourceDisplayName(null, "project-alpha:secondary")).toBe("Ledge Top Technologies");
    expect(sourceDisplayName("", undefined)).toBe("Unknown Project Alpha source");
  });
});
