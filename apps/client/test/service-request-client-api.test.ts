import { describe, expect, it, vi } from "vitest";
import { loadPortalRequestReadiness, loadPortalServiceCatalogPage, type PortalRequest } from "../src/client/portal-api";
import { requestUnavailableReason } from "../src/client/RequestAvailability";

const ready = {
  mode: "catalog", workspaceId: "workspace-a", target: { kind: "project", projectId: "project-a" },
  canStartRequest: true, reason: "ready", root: { canStartRequest: false, reason: "request_not_permitted" },
  projectRequestsSupported: true, refreshedAt: "2026-08-25T12:00:00Z",
};
const page = { services: [], nextCursor: null, complete: true, source: { generation: "generation-a", sequence: 1 } };
const respond = (value: unknown) => vi.fn(async () => value) as PortalRequest;

describe("request readiness client boundary", () => {
  it("passes cancellation through and verifies the exact requested project", async () => {
    const request = respond(ready);
    const controller = new AbortController();
    await expect(loadPortalRequestReadiness("project-a", controller.signal, request)).resolves.toEqual(ready);
    expect(request).toHaveBeenCalledWith("/api/client/request-readiness?projectId=project-a", { signal: controller.signal });
  });

  it.each([
    { target: { kind: "project", projectId: "project-b" } },
    { target: { kind: "root", projectId: null } },
    { canStartRequest: "true" },
    { projectRequestsSupported: "true" },
    { root: null },
    { reason: "unknown" },
    { mode: "unknown" },
    { refreshedAt: "invalid" },
  ])("rejects unverifiable readiness rather than mounting a form: %j", async change => {
    await expect(loadPortalRequestReadiness("project-a", undefined, respond({ ...ready, ...change }))).rejects.toThrow("could not be verified");
  });

  it("never substitutes project authority for a root target", async () => {
    await expect(loadPortalRequestReadiness(null, undefined, respond(ready))).rejects.toThrow("could not be verified");
    const root = { ...ready, target: { kind: "root", projectId: null }, canStartRequest: false, reason: "request_not_permitted" };
    await expect(loadPortalRequestReadiness(null, undefined, respond(root))).resolves.toMatchObject({ canStartRequest: false });
  });

  it.each([
    ["no_services_assigned", "No services are currently assigned"],
    ["service_assignments_unavailable", "Assigned services cannot be verified"],
  ] as const)("accepts and explains the assignment readiness state %s", async (reason, message) => {
    const unavailable = { ...ready, canStartRequest: false, reason };
    await expect(loadPortalRequestReadiness("project-a", undefined, respond(unavailable))).resolves.toMatchObject({ reason });
    expect(requestUnavailableReason(reason)).toContain(message);
    expect(requestUnavailableReason(reason)).toContain("existing requests and saved drafts are unchanged");
  });
});

describe("paged service catalog client boundary", () => {
  it("encodes an opaque continuation and keeps the cancellation signal", async () => {
    const request = respond(page);
    const controller = new AbortController();
    await expect(loadPortalServiceCatalogPage("project a", "cursor+/=", controller.signal, request)).resolves.toEqual(page);
    expect(request).toHaveBeenCalledWith("/api/client/service-catalog/page?projectId=project+a&cursor=cursor%2B%2F%3D", { signal: controller.signal });
  });

  it("keeps an explicit root target on the root catalog path", async () => {
    const request = respond(page);
    await expect(loadPortalServiceCatalogPage(null, null, undefined, request)).resolves.toEqual(page);
    expect(request).toHaveBeenCalledWith("/api/client/service-catalog/page", { signal: undefined });
  });

  it("uses the legacy endpoint only for initial typed catalog-not-ready responses", async () => {
    const controller = new AbortController();
    const request = vi.fn(async (path: string) => {
      if (path === "/api/client/service-catalog/page?projectId=project-a") throw { status: 503, body: { code: "catalog_not_ready" } };
      return { services: [] };
    }) as PortalRequest;
    await expect(loadPortalServiceCatalogPage("project-a", null, controller.signal, request)).resolves.toEqual({
      services: [], nextCursor: null, complete: false, source: null, legacy: true,
    });
    expect(request).toHaveBeenNthCalledWith(1, "/api/client/service-catalog/page?projectId=project-a", { signal: controller.signal });
    expect(request).toHaveBeenNthCalledWith(2, "/api/client/service-catalog?projectId=project-a", { signal: controller.signal });
  });

  it.each([
    { status: 401 }, { status: 403 }, { status: 404 }, { status: 409, body: { code: "catalog_changed" } },
    { status: 503 }, { status: 503, body: { code: "catalog_unavailable" } }, new Error("network failed"),
  ])("does not hide authorization, configuration or transport failure with a fallback: %j", async failure => {
    const request = vi.fn(async () => { throw failure; }) as PortalRequest;
    await expect(loadPortalServiceCatalogPage(null, null, undefined, request)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not mix legacy results into an already-started projected catalog", async () => {
    const failure = { status: 503, body: { code: "catalog_not_ready" } };
    const request = vi.fn(async () => { throw failure; }) as PortalRequest;
    await expect(loadPortalServiceCatalogPage(null, "old-page", undefined, request)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { services: null }, { complete: false }, { complete: true, nextCursor: "more" }, { nextCursor: "" },
    { source: null }, { source: { generation: "g", sequence: -1 } },
  ])("rejects an inconsistent page or completeness claim: %j", async change => {
    await expect(loadPortalServiceCatalogPage(null, null, undefined, respond({ ...page, ...change }))).rejects.toThrow("could not be verified");
  });

  it.each([
    { sourceId: "", generation: "g", sequence: 1, subjectType: "project", subjectPublicId: "p" },
    { sourceId: "s", generation: "", sequence: 1, subjectType: "project", subjectPublicId: "p" },
    { sourceId: "s", generation: "g", sequence: -1, subjectType: "project", subjectPublicId: "p" },
    { sourceId: "s", generation: "g", sequence: 1, subjectType: "folder", subjectPublicId: "p" },
    { sourceId: "s", generation: "g", sequence: 1, subjectType: "project", subjectPublicId: "" },
  ])("rejects unverifiable assignment provenance: %j", async assignment => {
    await expect(loadPortalServiceCatalogPage("project-a", null, undefined, respond({ ...page, assignment }))).rejects.toThrow("could not be verified");
  });
});
