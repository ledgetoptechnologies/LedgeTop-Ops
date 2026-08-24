import { describe, expect, it } from "vitest";
import { canonicalClientPath, deliverySectionPath, pathDeliverySection, pathOperationsSection, pathPage } from "../src/client/operations-route";

describe("consolidated Operations routes", () => {
  it("maps the canonical authenticated processing review route to Viewer", () => {
    expect(pathPage("/operations/processing")).toBe("viewer");
    expect(pathPage("/operations/processing/anything")).toBe("viewer");
  });

  it.each([
    ["/operations", "operations"],
    ["/operations/projects", "projects"],
    ["/operations/tasks", "tasks"],
  ] as const)("resolves %s to the Operations page and %s section", (pathname, section) => {
    expect(pathPage(pathname)).toBe("operations");
    expect(pathOperationsSection(pathname)).toBe(section);
  });

  it("keeps legacy client-request links compatible with the canonical Client Hub", () => {
    expect(pathPage("/clients")).toBe("clients");
    expect(pathPage("/clients/organizations/organization-a")).toBe("clients");
    expect(pathPage("/clients/standalone/client-a")).toBe("clients");
    expect(pathPage("/clients/requests/request-a")).toBe("clients");
    expect(pathPage("/operations/client-requests")).toBe("clients");
    expect(pathPage("/operations/client-requests/request-a")).toBe("clients");
    expect(pathOperationsSection("/operations/client-requests/request-a")).toBe("client-requests");
    expect(canonicalClientPath("/operations/client-requests")).toBe("/clients");
    expect(canonicalClientPath("/operations/client-requests/request-a")).toBe("/clients/requests/request-a");
  });

  it("nests SOPs under Operations while retaining the legacy alias", () => {
    expect(pathPage("/operations/sops")).toBe("sops");
    expect(pathPage("/sops/general-flight")).toBe("sops");
  });

  it.each([
    ["/delivery", "delivery"],
    ["/delivery/incoming", "incoming"],
    ["/delivery/links", "links"],
    ["/viewer", "models"],
  ] as const)("keeps the selected Data workspace across refresh at %s", (pathname, section) => {
    expect(pathDeliverySection(pathname)).toBe(section);
    expect(deliverySectionPath(section)).toBe(pathname);
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
    ["/configurations", "configurations"],
  ] as const)("keeps %s outside the Operations route group", (pathname, page) => {
    expect(pathPage(pathname)).toBe(page);
  });
});
