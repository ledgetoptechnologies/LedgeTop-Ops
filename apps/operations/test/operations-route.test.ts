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

  it("keeps client requests at its canonical top-level navigation destination", () => {
    expect(pathPage("/operations/client-requests")).toBe("client-requests");
    expect(pathPage("/operations/client-requests/request-a")).toBe("client-requests");
    expect(pathOperationsSection("/operations/client-requests/request-a")).toBe("client-requests");
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
    ["/jobs/archive", "delivery"],
    ["/airspace", "airspace"],
  ] as const)("keeps %s outside the Operations route group", (pathname, page) => {
    expect(pathPage(pathname)).toBe(page);
  });
});
