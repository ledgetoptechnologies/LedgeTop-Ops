import { describe, expect, it } from "vitest";
import { pathOperationsSection, pathPage } from "../src/client/operations-route";

describe("consolidated Operations routes", () => {
  it.each([
    ["/operations", "operations"],
    ["/operations/projects", "projects"],
    ["/operations/tasks", "tasks"],
  ] as const)("resolves %s to the Operations page and %s section", (pathname, section) => {
    expect(pathPage(pathname)).toBe("operations");
    expect(pathOperationsSection(pathname)).toBe(section);
  });

  it.each([
    ["/projects", "projects"],
    ["/tasks", "tasks"],
  ] as const)("keeps legacy %s links inside the Operations group", (pathname, section) => {
    expect(pathPage(pathname)).toBe("operations");
    expect(pathOperationsSection(pathname)).toBe(section);
  });

  it.each([
    ["/", "dashboard"],
    ["/delivery", "delivery"],
    ["/airspace", "airspace"],
  ] as const)("keeps %s outside the Operations route group", (pathname, page) => {
    expect(pathPage(pathname)).toBe(page);
  });
});
