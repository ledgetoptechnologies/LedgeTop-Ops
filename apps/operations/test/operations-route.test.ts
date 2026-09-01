import { describe, expect, it } from "vitest";
import { canAccessDataPage, canonicalClientPath, deliverySectionPath, operationsLandingPath, pathDeliverySection, pathOperationsSection, pathPage } from "../src/client/operations-route";

describe("consolidated Operations routes", () => {
  it("authorizes the Data page for link auditors without granting access from share mutation permissions", () => {
    expect(canAccessDataPage(["delivery.share.audit"])).toBe(true);
    expect(canAccessDataPage(["delivery.browse"])).toBe(true);
    expect(canAccessDataPage(["viewer.view"])).toBe(false);
    expect(canAccessDataPage(["delivery.share.create", "delivery.share.revoke"])).toBe(false);
  });

  it("maps the canonical authenticated processing review route to Viewer", () => {
    expect(pathPage("/operations/processing")).toBe("viewer");
    expect(pathPage("/operations/processing/anything")).toBe("viewer");
  });

  it.each([
    ["/operations", "operations"],
    ["/operations/projects", "projects"],
    ["/operations/tasks", "tasks"],
    ["/operations/sops", "sops"],
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
    expect(pathOperationsSection("/operations/client-requests/request-a")).toBe("operations");
    expect(canonicalClientPath("/operations/client-requests")).toBe("/clients");
    expect(canonicalClientPath("/operations/client-requests/request-a")).toBe("/clients/requests/request-a");
    expect(pathPage("/operations/feedback/feedback-a")).toBe("clients");
    expect(pathPage("/operations/invitation-requests/request-a")).toBe("clients");
    expect(pathPage("/operations/inbox")).toBe("clients");
    expect(canonicalClientPath("/operations/feedback/feedback-a")).toBe("/clients/feedback/feedback-a");
    expect(canonicalClientPath("/operations/invitation-requests/request-a")).toBe("/clients/invitation-requests/request-a");
    expect(canonicalClientPath("/operations/inbox")).toBe("/clients");
  });

  it("nests SOPs under Operations while retaining the legacy alias", () => {
    expect(pathPage("/operations/sops")).toBe("operations");
    expect(pathPage("/sops/general-flight")).toBe("operations");
    expect(pathOperationsSection("/sops/general-flight")).toBe("sops");
    expect(pathOperationsSection("/sops/general-flight/revisions/rev-a")).toBe("sops");
    expect(operationsLandingPath(["sops.view"])).toBe("/operations/sops");
    expect(operationsLandingPath(["projects.view", "sops.view"])).toBe("/operations/projects");
    expect(operationsLandingPath(["tasks.view", "sops.view"])).toBe("/operations/tasks");
    expect(operationsLandingPath(["operations.view", "sops.view"])).toBe("/operations");
  });

  it("does not mix notification access into the Operations landing", () => {
    expect(operationsLandingPath(["delivery.share.audit"])).toBe("/operations");
    expect(operationsLandingPath(["sops.view", "delivery.share.audit"])).toBe("/operations/sops");
    expect(operationsLandingPath(["tasks.view", "delivery.share.audit"])).toBe("/operations/tasks");
    expect(operationsLandingPath(["projects.view", "delivery.share.audit"])).toBe("/operations/projects");
    expect(operationsLandingPath(["operations.view", "delivery.share.audit"])).toBe("/operations");
    expect(operationsLandingPath([])).toBe("/operations");
  });

  it("keeps Client Hub capabilities out of the Operations landing", () => {
    expect(operationsLandingPath([], false, true)).toBe("/operations");
    expect(operationsLandingPath(["delivery.share.audit"], false, true)).toBe("/operations");
    expect(operationsLandingPath([], true)).toBe("/operations");
    expect(operationsLandingPath(["operations.manage"], false)).toBe("/operations");
    expect(operationsLandingPath(["sops.view"], true)).toBe("/operations/sops");
  });

  it.each([
    ["/delivery", "delivery"],
    ["/delivery/incoming", "incoming"],
    ["/delivery/links", "links"],
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
    ["/viewer", "viewer"],
    ["/notifications", "notifications"],
    ["/operations/notifications", "notifications"],
    ["/configurations", "administration"],
  ] as const)("keeps %s outside the Operations route group", (pathname, page) => {
    expect(pathPage(pathname)).toBe(page);
  });
});
